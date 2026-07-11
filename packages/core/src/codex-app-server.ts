import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join as pathJoin } from "node:path";

export interface CodexAppServerRunInput {
  readonly prompt: string;
  readonly cwd: string;
  readonly model?: string;
  readonly reasoning?: "none" | "low" | "medium" | "high";
  readonly instructionsFile?: string;
  readonly networkAccess?: boolean;
  readonly env?: Record<string, string>;
  readonly timeoutMs?: number;
  readonly command?: string;
  /** Persisted Codex thread to re-open when no warm process is cached. */
  readonly threadId?: string;
  /** Stable conversation identity. Omit it to disable cross-call process reuse. */
  readonly cacheKey?: string;
  /** Long-lived host that owns the warm process (gateway, RPC server, or TUI). */
  readonly transportOwner?: string;
  readonly keepAlive?: boolean;
  readonly onDelta?: (text: string) => void;
}

export type CodexAppServerCacheState = "hit" | "miss" | "shared-miss" | "disabled";

export interface CodexAppServerTimings {
  readonly startupMs: number;
  readonly queueMs: number;
  readonly threadOpenMs: number;
  readonly requestToFirstDeltaMs?: number;
  readonly cacheState: CodexAppServerCacheState;
  readonly threadOpenState: "cached" | "started" | "resumed";
}

export interface CodexAppServerRunResult {
  readonly status: "completed" | "failed";
  readonly finalMessage: string;
  readonly threadId?: string;
  readonly durationMs: number;
  readonly firstDeltaMs?: number;
  readonly timings?: CodexAppServerTimings;
  readonly errorMessage?: string;
  readonly tokenUsage?: {
    readonly inputTokens?: number;
    readonly cachedInputTokens?: number;
    readonly outputTokens?: number;
  };
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface CachedSession {
  readonly client: CodexAppServerClient;
  readonly threadId: string;
  readonly cacheKey: string;
  readonly conversationKey?: string;
  readonly transportOwner?: string;
  readonly cwd: string;
  readonly model?: string;
  readonly scopeKey: string;
  readonly createdAt: number;
  lastUsedAt: number;
  pendingRuns: number;
  queue: Promise<void>;
}

interface CreatedSession {
  readonly session: CachedSession;
  readonly startupMs: number;
  readonly threadOpenMs: number;
  readonly threadOpenState: "started" | "resumed";
}

interface SessionLease extends CreatedSession {
  readonly cacheState: CodexAppServerCacheState;
}

interface SessionCreation {
  readonly conversationKey?: string;
  readonly transportOwner?: string;
  readonly requestedThreadId?: string;
  waiters: number;
  client?: CodexAppServerClient;
  promise: Promise<CreatedSession>;
}

interface ClientMetadata {
  readonly conversationKey?: string;
  readonly transportOwner?: string;
  session?: CachedSession;
}

const SESSION_CACHE = new Map<string, CachedSession>();
const SESSION_CREATIONS = new Map<string, SessionCreation>();
const ACTIVE_CLIENTS = new Map<CodexAppServerClient, ClientMetadata>();
const DEFAULT_SESSION_CACHE_SIZE = 8;
const DEFAULT_SESSION_IDLE_MS = 30 * 60_000;

export function clearCodexAppServerSessions(transportOwner?: string): void {
  for (const [key, session] of SESSION_CACHE) {
    if (transportOwner === undefined || session.transportOwner === transportOwner) SESSION_CACHE.delete(key);
  }
  for (const [key, creation] of SESSION_CREATIONS) {
    if (transportOwner === undefined || creation.transportOwner === transportOwner) SESSION_CREATIONS.delete(key);
  }
  for (const [client, metadata] of ACTIVE_CLIENTS) {
    if (transportOwner === undefined || metadata.transportOwner === transportOwner) client.close();
  }
}

/** Drop only one conversation's warm process; other chats keep their cache state. */
export function clearCodexAppServerConversation(conversationKey: string, transportOwner?: string): void {
  for (const [key, session] of SESSION_CACHE) {
    if (session.conversationKey !== conversationKey || (transportOwner !== undefined && session.transportOwner !== transportOwner)) continue;
    SESSION_CACHE.delete(key);
  }
  for (const [key, creation] of SESSION_CREATIONS) {
    if (creation.conversationKey !== conversationKey || (transportOwner !== undefined && creation.transportOwner !== transportOwner)) continue;
    SESSION_CREATIONS.delete(key);
    creation.client?.close();
  }
  for (const [client, metadata] of ACTIVE_CLIENTS) {
    if (metadata.conversationKey !== conversationKey || (transportOwner !== undefined && metadata.transportOwner !== transportOwner)) continue;
    if (!metadata.session || metadata.session.pendingRuns === 0) client.close();
  }
}

export async function runCodexAppServer(input: CodexAppServerRunInput): Promise<CodexAppServerRunResult> {
  if (!input.prompt.trim()) throw new Error("Codex prompt is required.");
  const started = Date.now();
  const keepAlive = (input.keepAlive ?? true) && input.cacheKey !== undefined;
  const instructionsHash = await hashInstructionsFile(input.instructionsFile);
  const command = resolveCodexCommand(input.command);
  const conversationIdentity = input.cacheKey ?? `anonymous:${randomUUID()}`;
  const scopeKey = appServerScopeKey(input, command, conversationIdentity);
  const key = `${scopeKey}\0instructions:${instructionsHash}`;
  let lease: SessionLease;
  try {
    lease = await acquireSession({ input, command, key, scopeKey, keepAlive });
  } catch (error) {
    return {
      status: "failed",
      finalMessage: "",
      durationMs: Date.now() - started,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }

  let queueMs = 0;
  return await runExclusive(lease.session, async (measuredQueueMs) => {
    queueMs = measuredQueueMs;
    let firstDeltaAt: number | undefined;
    const turn = await lease.session.client.runTurn({
      threadId: lease.session.threadId,
      prompt: input.prompt,
      timeoutMs: input.timeoutMs ?? 180_000,
      onDelta: (text) => {
        firstDeltaAt ??= Date.now();
        input.onDelta?.(text);
      },
    });
    const requestToFirstDeltaMs = firstDeltaAt === undefined ? undefined : firstDeltaAt - started;
    const result = {
      status: turn.errorMessage ? "failed" : "completed",
      finalMessage: turn.finalMessage,
      threadId: lease.session.threadId,
      durationMs: Date.now() - started,
      firstDeltaMs: turn.firstDeltaMs,
      timings: appServerTimings(lease, queueMs, requestToFirstDeltaMs),
      errorMessage: turn.errorMessage,
      tokenUsage: turn.tokenUsage,
    } as const;
    if (SESSION_CACHE.get(key) === lease.session) pruneSessionCache(Date.now(), key);
    return result;
  }).catch((error: unknown) => {
      lease.session.client.close();
      if (SESSION_CACHE.get(key) === lease.session) SESSION_CACHE.delete(key);
      return {
        status: "failed",
        finalMessage: "",
        threadId: lease.session.threadId,
        durationMs: Date.now() - started,
        timings: appServerTimings(lease, queueMs),
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    });
}

function appServerTimings(lease: SessionLease, queueMs: number, requestToFirstDeltaMs?: number): CodexAppServerTimings {
  return {
    startupMs: lease.startupMs,
    queueMs,
    threadOpenMs: lease.threadOpenMs,
    requestToFirstDeltaMs,
    cacheState: lease.cacheState,
    threadOpenState: lease.cacheState === "hit" ? "cached" : lease.threadOpenState,
  };
}

async function acquireSession(input: {
  readonly input: CodexAppServerRunInput;
  readonly command: string;
  readonly key: string;
  readonly scopeKey: string;
  readonly keepAlive: boolean;
}): Promise<SessionLease> {
  const { key, scopeKey, keepAlive } = input;
  pruneSessionCache(Date.now(), key);
  const cached = keepAlive ? SESSION_CACHE.get(key) : undefined;
  if (cached?.client.isAlive() && (!input.input.threadId || cached.threadId === input.input.threadId)) {
    cached.pendingRuns += 1;
    cached.lastUsedAt = Date.now();
    SESSION_CACHE.delete(key);
    SESSION_CACHE.set(key, cached);
    return { session: cached, startupMs: 0, threadOpenMs: 0, threadOpenState: "started", cacheState: "hit" };
  }
  if (cached) invalidateCachedSession(key, cached);
  if (keepAlive) closeSupersededSessions(scopeKey, key);

  const existing = keepAlive ? SESSION_CREATIONS.get(key) : undefined;
  if (existing) {
    if (existing.requestedThreadId !== input.input.threadId) {
      await existing.promise.catch(() => undefined);
      return acquireSession(input);
    }
    existing.waiters += 1;
    const created = await existing.promise;
    return { ...created, cacheState: "shared-miss" };
  }

  const creation = {
    conversationKey: input.input.cacheKey,
    transportOwner: input.input.transportOwner,
    requestedThreadId: input.input.threadId,
    waiters: 1,
  } as SessionCreation;
  creation.promise = createSession(input, creation).finally(() => {
    if (SESSION_CREATIONS.get(key) === creation) SESSION_CREATIONS.delete(key);
  });
  if (keepAlive) SESSION_CREATIONS.set(key, creation);
  const created = await creation.promise;
  return { ...created, cacheState: keepAlive ? "miss" : "disabled" };
}

async function createSession(
  input: {
    readonly input: CodexAppServerRunInput;
    readonly command: string;
    readonly key: string;
    readonly scopeKey: string;
    readonly keepAlive: boolean;
  },
  creation: SessionCreation,
): Promise<CreatedSession> {
  const startupStartedAt = Date.now();
  const client = new CodexAppServerClient({
    command: input.command,
    cwd: input.input.cwd,
    model: input.input.model,
    reasoning: input.input.reasoning,
    instructionsFile: input.input.instructionsFile,
    networkAccess: input.input.networkAccess,
    env: input.input.env,
    onClose: () => ACTIVE_CLIENTS.delete(client),
  });
  creation.client = client;
  const metadata: ClientMetadata = { conversationKey: input.input.cacheKey, transportOwner: input.input.transportOwner };
  ACTIVE_CLIENTS.set(client, metadata);
  try {
    await client.initialize();
    const startupMs = Date.now() - startupStartedAt;
    const threadOpenStartedAt = Date.now();
    const threadId = input.input.threadId
      ? await client.resumeThread(input.input.threadId, input.input.cwd)
      : await client.startThread(input.input.cwd);
    const threadOpenMs = Date.now() - threadOpenStartedAt;
    const now = Date.now();
    const session: CachedSession = {
      client,
      threadId,
      cacheKey: input.key,
      conversationKey: input.input.cacheKey,
      transportOwner: input.input.transportOwner,
      cwd: input.input.cwd,
      model: input.input.model,
      scopeKey: input.scopeKey,
      createdAt: now,
      lastUsedAt: now,
      pendingRuns: creation.waiters,
      queue: Promise.resolve(),
    };
    metadata.session = session;
    if (input.keepAlive && makeSessionCacheRoom(input.key)) SESSION_CACHE.set(input.key, session);
    return { session, startupMs, threadOpenMs, threadOpenState: input.input.threadId ? "resumed" : "started" };
  } catch (error) {
    client.close();
    throw error;
  }
}

async function runExclusive<T>(session: CachedSession, task: (queueMs: number) => Promise<T>): Promise<T> {
  const queuedAt = Date.now();
  const previous = session.queue.catch(() => {});
  let release!: () => void;
  session.queue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await task(Date.now() - queuedAt);
  } finally {
    session.pendingRuns -= 1;
    session.lastUsedAt = Date.now();
    release();
    if (session.pendingRuns === 0 && SESSION_CACHE.get(session.cacheKey) !== session) session.client.close();
  }
}

function positiveIntegerEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function appServerScopeKey(input: CodexAppServerRunInput, command: string, conversationIdentity: string): string {
  const env = [...Object.entries(input.env ?? {})].sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256").update(JSON.stringify({
    conversation: conversationIdentity,
    transportOwner: input.transportOwner ?? "",
    cwd: input.cwd,
    model: input.model ?? "",
    reasoning: input.reasoning ?? "",
    command,
    networkAccess: input.networkAccess === true,
    env,
  })).digest("hex");
}

function closeCachedSession(key: string, session: CachedSession): void {
  if (session.pendingRuns > 0) return;
  SESSION_CACHE.delete(key);
  session.client.close();
}

function invalidateCachedSession(key: string, session: CachedSession): void {
  SESSION_CACHE.delete(key);
  if (session.pendingRuns === 0) session.client.close();
}

function closeSupersededSessions(scopeKey: string, protectedKey: string): void {
  for (const [key, session] of SESSION_CACHE) {
    if (key !== protectedKey && session.scopeKey === scopeKey) invalidateCachedSession(key, session);
  }
}

function makeSessionCacheRoom(protectedKey: string): boolean {
  const maxSize = positiveIntegerEnv("MUSTER_NATIVE_SESSION_CACHE_SIZE", DEFAULT_SESSION_CACHE_SIZE, 1, 64);
  for (const [key, session] of [...SESSION_CACHE.entries()].sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)) {
    if (SESSION_CACHE.size < maxSize) break;
    if (key === protectedKey) continue;
    closeCachedSession(key, session);
  }
  return SESSION_CACHE.size < maxSize;
}

function pruneSessionCache(now: number, protectedKey: string): void {
  const idleMs = positiveIntegerEnv("MUSTER_NATIVE_SESSION_IDLE_MS", DEFAULT_SESSION_IDLE_MS, 1_000, 24 * 60 * 60_000);
  for (const [key, session] of SESSION_CACHE) {
    if (key === protectedKey) continue;
    if (!session.client.isAlive()) invalidateCachedSession(key, session);
    else if (now - session.lastUsedAt >= idleMs) closeCachedSession(key, session);
  }
  makeSessionCacheRoom(protectedKey);
}

async function hashInstructionsFile(path: string | undefined): Promise<string> {
  if (!path) return "";
  const content = await readFile(path, "utf8").catch(() => "");
  return createHash("sha256").update(content).digest("hex");
}

class CodexAppServerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly onClose?: () => void;
  private nextId = 1;
  private stdoutBuffer = "";
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notifications: Record<string, unknown>[] = [];
  private readonly waiters: Array<(message: Record<string, unknown>) => void> = [];
  private readonly stderrLines: string[] = [];
  private closed = false;

  constructor(input: {
    readonly command: string;
    readonly cwd: string;
    readonly model?: string;
    readonly reasoning?: "none" | "low" | "medium" | "high";
    readonly instructionsFile?: string;
    readonly networkAccess?: boolean;
    readonly env?: Record<string, string>;
    readonly onClose?: () => void;
  }) {
    this.onClose = input.onClose;
    const args = ["app-server", "--stdio"];
    if (input.model) args.push("-c", `model=${JSON.stringify(input.model)}`);
    if (input.reasoning) args.push("-c", `model_reasoning_effort=${JSON.stringify(input.reasoning === "none" ? "low" : input.reasoning)}`);
    if (input.networkAccess) args.push("-c", "sandbox_workspace_write.network_access=true");
    if (input.instructionsFile) args.push("-c", `experimental_instructions_file=${JSON.stringify(input.instructionsFile)}`);
    this.child = spawn(input.command, args, {
      cwd: input.cwd,
      env: { ...process.env, ...(input.env ?? {}), RUST_LOG: process.env.RUST_LOG ?? "warn" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.readStdout(chunk.toString("utf8")));
    this.child.stderr.on("data", (chunk: Buffer) => this.readStderr(chunk.toString("utf8")));
    this.child.on("error", (error) => {
      this.finishClose(new Error(this.formatError(`codex app-server failed to start: ${error.message}`)));
    });
    this.child.on("exit", () => {
      this.finishClose(new Error(this.formatError("codex app-server exited")));
    });
  }

  isAlive(): boolean {
    return !this.closed && this.child.exitCode === null && !this.child.killed;
  }

  close(): void {
    if (this.closed) return;
    this.finishClose(new Error(this.formatError("codex app-server closed")));
    this.child.kill();
    this.child.stdin.destroy();
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "muster", title: "Muster", version: "0.1" },
      capabilities: { experimentalApi: true },
    }, 10_000);
    this.notify("initialized");
  }

  async startThread(cwd: string): Promise<string> {
    const result = await this.request("thread/start", { cwd }, 15_000);
    const thread = asRecord(result.thread);
    const threadId = stringValue(thread.id) ?? stringValue(thread.sessionId) ?? stringValue(result.sessionId) ?? stringValue(result.threadId);
    if (!threadId) throw new Error("codex app-server thread/start returned no thread id");
    return threadId;
  }

  async resumeThread(threadId: string, cwd: string): Promise<string> {
    const result = await this.request("thread/resume", { threadId, cwd, excludeTurns: true }, 30_000);
    const thread = asRecord(result.thread);
    const resumedId = stringValue(thread.id) ?? stringValue(thread.sessionId) ?? stringValue(result.sessionId) ?? stringValue(result.threadId);
    if (!resumedId) throw new Error("codex app-server thread/resume returned no thread id");
    if (resumedId !== threadId) throw new Error(`codex app-server resumed unexpected thread ${resumedId}; expected ${threadId}`);
    return resumedId;
  }

  async runTurn(input: {
    readonly threadId: string;
    readonly prompt: string;
    readonly timeoutMs: number;
    readonly onDelta?: (text: string) => void;
  }): Promise<{
    readonly finalMessage: string;
    readonly firstDeltaMs?: number;
    readonly errorMessage?: string;
    readonly tokenUsage?: CodexAppServerRunResult["tokenUsage"];
  }> {
    const started = Date.now();
    const turnStart = await this.request("turn/start", {
      threadId: input.threadId,
      input: [{ type: "text", text: input.prompt }],
    }, 15_000);
    const turnId = stringValue(asRecord(turnStart.turn).id);
    let finalMessage = "";
    let firstDeltaMs: number | undefined;
    let tokenUsage: CodexAppServerRunResult["tokenUsage"] | undefined;

    while (Date.now() - started < input.timeoutMs) {
      if (!this.isAlive()) throw new Error(this.formatError("codex app-server exited during turn"));
      const message = await this.takeNotification(250);
      if (!message) continue;
      const method = stringValue(message.method) ?? "";
      const params = asRecord(message.params);
      if (method.endsWith("/request")) {
        this.respond(message.id, { decision: "decline", action: "decline", content: null, _meta: null });
        continue;
      }
      if (method === "item/agentMessage/delta") {
        const delta = stringValue(params.delta) ?? "";
        if (delta) {
          firstDeltaMs ??= Date.now() - started;
          input.onDelta?.(delta);
        }
        continue;
      }
      if (method === "item/completed") {
        const item = asRecord(params.item);
        if (item.type === "agentMessage") {
          finalMessage = stringValue(item.text) ?? finalMessage;
        }
        continue;
      }
      if (method === "thread/tokenUsage/updated") {
        const last = asRecord(asRecord(params.tokenUsage).last);
        tokenUsage = {
          inputTokens: numberValue(last.inputTokens),
          cachedInputTokens: numberValue(last.cachedInputTokens),
          outputTokens: numberValue(last.outputTokens),
        };
        continue;
      }
      if (method === "turn/completed") {
        const turn = asRecord(params.turn);
        const error = asRecord(turn.error);
        const status = stringValue(turn.status);
        if (status && status !== "completed" && status !== "interrupted") {
          return { finalMessage, firstDeltaMs, errorMessage: stringValue(error.message) ?? `codex turn ended with status ${status}`, tokenUsage };
        }
        if (turnId && stringValue(turn.id) && stringValue(turn.id) !== turnId) continue;
        return { finalMessage, firstDeltaMs, tokenUsage };
      }
    }
    throw new Error(this.formatError(`codex app-server turn timed out after ${input.timeoutMs}ms`));
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    if (!this.isAlive()) return Promise.reject(new Error(this.formatError("codex app-server is not running")));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(this.formatError(`codex app-server method ${method} timed out`)));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  private notify(method: string, params: Record<string, unknown> = {}): void {
    this.write({ method, params });
  }

  private respond(id: unknown, result: Record<string, unknown>): void {
    if (typeof id === "number" || typeof id === "string") this.write({ id, result });
  }

  private write(message: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private readStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split(/\n/);
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const id = numberValue(message.id);
      if (id !== undefined && this.pending.has(id)) {
        const pending = this.pending.get(id)!;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        const error = asRecord(message.error);
        if (Object.keys(error).length) {
          pending.reject(new Error(stringValue(error.message) ?? `codex app-server ${pending.method} failed`));
        } else {
          pending.resolve(asRecord(message.result));
        }
        continue;
      }
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.notifications.push(message);
    }
  }

  private readStderr(chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim()) this.stderrLines.push(line.trim());
    }
    this.stderrLines.splice(0, Math.max(0, this.stderrLines.length - 80));
  }

  private takeNotification(timeoutMs: number): Promise<Record<string, unknown> | undefined> {
    const existing = this.notifications.shift();
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve(undefined);
      }, timeoutMs);
      const waiter = (message: Record<string, unknown>) => {
        clearTimeout(timer);
        resolve(message);
      };
      this.waiters.push(waiter);
    });
  }

  private formatError(message: string): string {
    const tail = this.stderrLines.slice(-12).join("\n");
    return tail ? `${message}\ncodex stderr:\n${tail}` : message;
  }

  private finishClose(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.onClose?.();
  }
}

function resolveCodexCommand(command?: string): string {
  if (command) return command;
  if (process.env.MUSTER_CODEX_COMMAND) return process.env.MUSTER_CODEX_COMMAND;
  const appBundle = "/Applications/Codex.app/Contents/Resources/codex";
  if (existsSync(appBundle)) return appBundle;
  const home = process.env.HOME;
  if (home) {
    const candidates = [
      pathJoin(home, ".nvm/versions/node/v24.17.0/bin/codex"),
      pathJoin(home, ".nvm/versions/node/v22.22.3/bin/codex"),
      pathJoin(home, ".nvm/versions/node/v22.15.1/bin/codex"),
      pathJoin(home, ".nvm/versions/node/v20.19.5/bin/codex"),
      pathJoin(home, ".local/bin/codex"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return "codex";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
