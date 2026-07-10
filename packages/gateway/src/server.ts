import { createHmac, timingSafeEqual } from "node:crypto";
import { access, readFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { activeProfile, createStreamEventChannel, estimateTokens, executeRun, extractMediaTags, profileWorkspaceDir, resolveAgentSkillAllowlist, resolveSkillCommand, resumeFlow, runDraftLoop, StreamRun } from "@musterhq/core";
import type { DraftSink, FlowToolRegistry, MusterConfig } from "@musterhq/core";
import { dispatchCommand, parseCommand, resolveCustomCommand } from "./commands.js";
import { conversationSessionId, isPairingChallenge, parseSurfaceMessage } from "./envelope.js";
import type { PairingChallenge, SurfaceArtifact, SurfaceMessage, SurfaceReply } from "./envelope.js";
import { pairingScopes, requestPairing, resolvePairing } from "./pairing.js";
import type { GatewayConfig, GatewayGovernanceAssignment, GatewayGovernanceRateLimit, GatewayGovernanceRateWindow, GatewayGovernanceSubject } from "./gateway-config.js";
import { surfaceReplyToTelegramSend, telegramCallbackQueryId, telegramUpdateToSurfaceMessage } from "./adapters/telegram.js";
import { slackDeliveryId, slackEventToSurfaceMessage, slackSignatureIsValid, surfaceReplyToSlackPost } from "./adapters/slack.js";
import { DISCORD_PONG, discordInteractionToInbound, discordSignatureIsValid, surfaceReplyToDiscordInteractionResponse } from "./adapters/discord.js";
import { surfaceReplyToWhatsAppSend, whatsAppMessageIds, whatsAppVerifyChallenge, whatsAppWebhookToSurfaceMessages } from "./adapters/whatsapp.js";
import { gchatDeliveryId, gchatEventToken, gchatEventToSurfaceMessage, surfaceReplyToGchatResponse } from "./adapters/gchat.js";
import type { GchatRequestVerifier } from "./adapters/gchat.js";
import { surfaceReplyToTeamsActivity, teamsActivityToSurfaceMessage, teamsHmacIsValid } from "./adapters/teams.js";
import { createOutboundQueue, createSlackDraftSink, createTelegramDraftSink } from "./streaming.js";
import type { OutboundQueue } from "./streaming.js";

/**
 * Slice 1 gateway: HTTP-only (node:http, no ws). Surfaces that need streaming
 * receive the buffered reply; long-poll/streaming lands in a later slice.
 */

export interface GatewayServerOptions {
  readonly config: MusterConfig;
  readonly gateway: GatewayConfig;
  readonly cwd?: string;
  /** Tool registry used when resuming gated flow runs. Defaults to `echo`. */
  readonly registry?: FlowToolRegistry;
  /** Outbound HTTP for adapter sends; injectable for tests. */
  readonly fetcher?: typeof fetch;
  readonly log?: (line: string) => void;
  /** Host-provided Google OIDC/JWT verifier. Required when gchat.verification.mode=bearer. */
  readonly gchatVerifier?: GchatRequestVerifier;
}

export interface RunningGateway {
  readonly port: number;
  readonly server: Server;
  close(): Promise<void>;
}

/** Error that carries an HTTP status so adapter handlers can reject with e.g. 401. */
export class GatewayHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "GatewayHttpError";
  }
}

function defaultRegistry(): FlowToolRegistry {
  return { echo: async (args) => args };
}

/** Per-profile workspace dirs already ensured this process — skip the mkdir syscall on the hot path. */
const ensuredWorkspaces = new Set<string>();
async function ensureWorkspaceOnce(dir: string): Promise<void> {
  if (ensuredWorkspaces.has(dir)) return;
  await mkdir(dir, { recursive: true });
  ensuredWorkspaces.add(dir);
}

/** Emit an "adapter is unauthenticated" warning at most once per adapter per process. */
const unauthenticatedWarned = new Set<string>();
function warnUnauthenticatedOnce(adapter: string, log: (line: string) => void): void {
  if (unauthenticatedWarned.has(adapter)) return;
  unauthenticatedWarned.add(adapter);
  log(`WARNING: ${adapter} webhook is UNAUTHENTICATED — no secret configured. Anyone who can reach this endpoint can forge ${adapter} events. Configure it in .muster/gateway.json.`);
}

/** Test-only: reset the once-per-process warning latch so each test observes the first warning. */
export function resetAdapterAuthWarnings(): void {
  unauthenticatedWarned.clear();
}

/**
 * The single governed entry point every surface goes through:
 * pairing check -> scoped run (pairing + user + conversation-session lanes)
 * -> per-surface token accounting. Exported so adapters and tests can call
 * it without HTTP.
 */
const idempotencyCache = new Map<string, { at: number; reply: SurfaceReply | PairingChallenge }>();
const IDEMPOTENCY_TTL_MS = 10 * 60_000;
const deliveryCache = new Map<string, { at: number; result: unknown }>();
const activeConversationRuns = new Map<string, Promise<unknown>>();
const governanceRateCounters = new Map<string, { windowStart: number; runs: number; tokens: number }>();
const TELEGRAM_POLL_OFFSET_FILE = "telegram-poll-offset.json";

/** Duplicate deliveries (webhook retries) with the same key return the cached reply. */
export function idempotencyLookup(key: string | undefined): (SurfaceReply | PairingChallenge) | undefined {
  if (!key) return undefined;
  const hit = idempotencyCache.get(key);
  if (!hit || Date.now() - hit.at > IDEMPOTENCY_TTL_MS) return undefined;
  return hit.reply;
}

export function idempotencyStore(key: string | undefined, reply: SurfaceReply | PairingChallenge): void {
  if (!key) return;
  if (idempotencyCache.size > 1000) {
    const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
    for (const [cachedKey, value] of idempotencyCache) {
      if (value.at < cutoff) idempotencyCache.delete(cachedKey);
    }
  }
  idempotencyCache.set(key, { at: Date.now(), reply });
}

function deliveryLookup(key: string | undefined): unknown | undefined {
  if (!key) return undefined;
  const hit = deliveryCache.get(key);
  if (!hit || Date.now() - hit.at > IDEMPOTENCY_TTL_MS) return undefined;
  return hit.result;
}

function deliveryStore(key: string | undefined, result: unknown): void {
  if (!key) return;
  if (deliveryCache.size > 1000) {
    const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
    for (const [cachedKey, value] of deliveryCache) {
      if (value.at < cutoff) deliveryCache.delete(cachedKey);
    }
  }
  deliveryCache.set(key, { at: Date.now(), result });
}

const ARTIFACT_REQUEST_RE = /\b(artifact|attach|attachment|document|docx|word|pdf|pptx?|presentation|slides?|xlsx?|excel|spreadsheet|workbook|report|brief|deck)\b/i;
const MEMORY_REQUEST_RE = /\b(remember when|recall|look up memory|search memory|from memory|chat history|previous conversation|earlier conversation|last time|we discussed|named chat|previous session|context from before|what did (we|i) (discuss|say|decide)|my preference)\b/i;
const ARTIFACT_REF_RE = /(?:^|[\s`"'(])((?:\.\/)?artifacts\/[^\s`"')]+?\.(?:pdf|docx|xlsx|pptx|md|txt|csv|json|zip))/gi;
const ATTACHABLE_ARTIFACT_EXTENSIONS = new Set([".pdf", ".docx", ".xlsx", ".pptx", ".md", ".txt", ".csv", ".json", ".zip"]);

function maybeAddChannelArtifactInstructions(text: string): string {
  if (!ARTIFACT_REQUEST_RE.test(text) || /\bMEDIA\s*:/i.test(text)) return text;
  return [
    text,
    "",
    "Muster channel artifact delivery rules:",
    "- First satisfy the user's actual document/content request. Do not make this delivery checklist the artifact content.",
    "- If you create a file, create it under ./artifacts/ in the current workspace unless the user asks otherwise.",
    "- Prefer the installed `muster artifacts create` command for docx, xlsx, pptx, or pdf when it fits the request; otherwise create a reasonable local file directly.",
    "- End the final response with one `MEDIA:<path-or-url>` line for each generated file so Slack, Telegram, and other channels can attach it.",
    "- Keep the visible reply short and do not claim an attachment unless the MEDIA path exists.",
  ].join("\n");
}

function shouldRecallForChannel(text: string): boolean {
  return MEMORY_REQUEST_RE.test(text);
}

function channelProgressText(text: string, surface: "slack" | "telegram", elapsedMs = 0): string {
  const steps = [
    "Checking the request",
    shouldRecallForChannel(text) ? "Looking up scoped memory" : undefined,
    ARTIFACT_REQUEST_RE.test(text) ? "Preparing artifact route" : undefined,
    "Running the provider",
    ARTIFACT_REQUEST_RE.test(text) ? "Will verify and attach generated files" : undefined,
  ].filter(Boolean);
  const chevron = surface === "slack" ? "▾" : "▾";
  const elapsed = elapsedMs > 0 ? ` · ${Math.max(1, Math.round(elapsedMs / 1000))}s` : "";
  return [
    `${chevron} Processing${elapsed}`,
    ...steps.map((step, index) => `${index + 1}. ${step}`),
  ].join("\n");
}

function artifactMime(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".pdf":
      return "application/pdf";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".md":
      return "text/markdown";
    case ".txt":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

async function readableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveSurfaceArtifactRef(ref: string, workspaceDir: string, cwd: string): Promise<SurfaceArtifact> {
  if (isHttpArtifact(ref)) return { name: basename(new URL(ref).pathname) || ref, mime: "application/octet-stream", path: ref };
  const candidates = isAbsolute(ref)
    ? [ref]
    : [
        resolve(workspaceDir, ref),
        resolve(cwd, ref),
        resolve(process.cwd(), ref),
      ];
  const selected = (await Promise.all(candidates.map(async (candidate) => await readableFile(candidate) ? candidate : undefined)))
    .find((candidate): candidate is string => Boolean(candidate));
  const path = selected ?? (isAbsolute(ref) ? ref : resolve(workspaceDir, ref));
  return { name: basename(path), mime: artifactMime(path), path };
}

function extractArtifactPathRefs(text: string): string[] {
  const refs: string[] = [];
  for (const match of text.matchAll(ARTIFACT_REF_RE)) {
    const ref = match[1]?.replace(/[.,;:]+$/, "");
    if (ref) refs.push(ref);
  }
  return [...new Set(refs)];
}

async function discoverFreshArtifactRefs(workspaceDir: string, sinceMs: number, depth = 4): Promise<string[]> {
  const artifactRoot = resolve(workspaceDir, "artifacts");
  const refs: Array<{ ref: string; mtimeMs: number }> = [];
  async function walk(dir: string, remainingDepth: number): Promise<void> {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (remainingDepth > 0) await walk(path, remainingDepth - 1);
        continue;
      }
      if (!entry.isFile() || !ATTACHABLE_ARTIFACT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      const info = await stat(path).catch(() => undefined);
      if (!info?.isFile() || info.mtimeMs < sinceMs - 5_000) continue;
      refs.push({ ref: relative(workspaceDir, path), mtimeMs: info.mtimeMs });
    }
  }
  await walk(artifactRoot, depth);
  return refs
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 10)
    .map((item) => item.ref);
}

async function resolveChannelArtifacts(text: string, extractedRefs: string[], workspaceDir: string, cwd: string, startedAt: number, artifactRequested: boolean): Promise<SurfaceArtifact[]> {
  const refs = [...extractedRefs, ...extractArtifactPathRefs(text)];
  if (!refs.length && artifactRequested) refs.push(...await discoverFreshArtifactRefs(workspaceDir, startedAt));
  return Promise.all([...new Set(refs)].map((ref) => resolveSurfaceArtifactRef(ref, workspaceDir, cwd)));
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bxox[baprs]-[A-Za-z0-9-]+/i, "Slack token"],
  [/\bxapp-[A-Za-z0-9-]+/i, "Slack app token"],
  [/\b(?:sk|sk-proj)-[A-Za-z0-9_-]{16,}/i, "API key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/i, "secret assignment"],
];

function gatewayGovernancePreflight(message: SurfaceMessage, paired: { readonly pairingId: string }, gateway: Pick<GatewayConfig, "governance"> | undefined): SurfaceReply | undefined {
  const governance = gateway?.governance;
  if (!governance?.enabled) return undefined;
  const assignment = governanceAssignment(gateway, message);
  const validation = governance.requestValidation;
  const maxChars = validation?.maxChars ?? 16_000;
  if (message.text.length > maxChars) {
    return governanceBlock(`Request rejected by validation: message is ${message.text.length} characters, limit is ${maxChars}.`);
  }
  if (validation?.blockSecrets ?? true) {
    for (const [pattern, label] of SECRET_PATTERNS) {
      if (pattern.test(message.text)) return governanceBlock(`Request rejected by validation: possible ${label} detected. Remove secrets and use configured credentials instead.`);
    }
  }
  for (const patternSource of validation?.blockedPatterns ?? []) {
    const pattern = safeRegex(patternSource);
    if (pattern?.test(message.text)) return governanceBlock(`Request rejected by validation: matched blocked policy pattern.`);
  }
  if (assignment.allowedSurfaces?.length && !assignment.allowedSurfaces.includes(message.surfaceId)) {
    return governanceBlock(`Request blocked by RBAC: this user is not allowed to use surface ${message.surfaceId}.`);
  }
  const channelId = governanceChannelId(message);
  if (assignment.allowedChannels?.length && !assignment.allowedChannels.includes(channelId) && !assignment.allowedChannels.includes(message.conversationId)) {
    return governanceBlock(`Request blocked by RBAC: this user is not allowed to use channel ${channelId}.`);
  }
  const estimatedTokens = estimateTokens(message.text) + Math.max(0, Math.floor(governance.estimatedOutputTokens ?? 800));
  const rateBlock = gatewayRateLimitBlock({
    limits: governance.rateLimits ?? [],
    message,
    assignment,
    pairingId: paired.pairingId,
    estimatedTokens,
  });
  if (rateBlock) return governanceBlock(rateBlock);
  return undefined;
}

function governanceAssignment(gateway: Pick<GatewayConfig, "governance"> | undefined, message: SurfaceMessage): GatewayGovernanceAssignment {
  const assignments = gateway?.governance?.assignments ?? {};
  return assignments[`${message.surfaceId}:${message.senderId}`]
    ?? assignments[message.senderId]
    ?? assignments.default
    ?? {};
}

function governanceChannelId(message: SurfaceMessage): string {
  return `${message.surfaceId}:${message.conversationId}`;
}

function safeRegex(source: string): RegExp | undefined {
  try {
    return new RegExp(source, "i");
  } catch {
    return undefined;
  }
}

function gatewayRateLimitBlock(input: {
  readonly limits: readonly GatewayGovernanceRateLimit[];
  readonly message: SurfaceMessage;
  readonly assignment: GatewayGovernanceAssignment;
  readonly pairingId: string;
  readonly estimatedTokens: number;
}): string | undefined {
  const now = Date.now();
  for (const limit of input.limits) {
    if (!governanceSubjectMatches(limit.subject, input.message, input.assignment, input.pairingId)) continue;
    const key = `${limit.subject.kind}:${limit.subject.id}:${limit.window}`;
    const windowMs = rateWindowMs(limit.window);
    const existing = governanceRateCounters.get(key);
    const counter = existing && now - existing.windowStart < windowMs
      ? existing
      : { windowStart: now, runs: 0, tokens: 0 };
    const projectedRuns = counter.runs + 1;
    const projectedTokens = counter.tokens + input.estimatedTokens;
    if (limit.maxRuns !== undefined && projectedRuns > limit.maxRuns) {
      return `Rate limit exceeded for ${limit.subject.kind}:${limit.subject.id}: ${projectedRuns}/${limit.maxRuns} runs in the current ${limit.window}.`;
    }
    if (limit.maxTokens !== undefined && projectedTokens > limit.maxTokens) {
      return `Rate limit exceeded for ${limit.subject.kind}:${limit.subject.id}: estimated ${projectedTokens}/${limit.maxTokens} tokens in the current ${limit.window}.`;
    }
    governanceRateCounters.set(key, { windowStart: counter.windowStart, runs: projectedRuns, tokens: projectedTokens });
  }
  return undefined;
}

function governanceSubjectMatches(subject: GatewayGovernanceSubject, message: SurfaceMessage, assignment: GatewayGovernanceAssignment, pairingId: string): boolean {
  if (subject.kind === "user") return subject.id === (assignment.userId ?? message.senderId) || subject.id === pairingId || subject.id === message.senderId;
  if (subject.kind === "role") return (assignment.roles ?? []).includes(subject.id);
  if (subject.kind === "channel") return subject.id === governanceChannelId(message) || subject.id === message.conversationId;
  if (subject.kind === "surface") return subject.id === message.surfaceId;
  if (subject.kind === "tenant") return subject.id === assignment.tenantId;
  if (subject.kind === "workspace") return subject.id === assignment.workspaceId;
  return false;
}

function rateWindowMs(window: GatewayGovernanceRateWindow): number {
  switch (window) {
    case "minute":
      return 60_000;
    case "hour":
      return 60 * 60_000;
    case "day":
      return 24 * 60 * 60_000;
    case "month":
      return 30 * 24 * 60 * 60_000;
  }
}

function governanceBlock(text: string): SurfaceReply {
  return {
    text: [
      text,
      "No provider call was made.",
    ].join("\n"),
  };
}

export async function handleSurfaceMessage(
  message: SurfaceMessage,
  options: Pick<GatewayServerOptions, "config" | "cwd"> & {
    readonly gateway?: GatewayConfig;
    /** Tool registry used for skill commands that dispatch directly to tools. */
    readonly registry?: FlowToolRegistry;
    /**
     * Channel draft sink. When provided AND message.stream === "draft", the
     * reply is streamed as a live-edited draft through the core draft loop;
     * the returned SurfaceReply still carries the final text so callers can
     * log it, but it has already been delivered by the sink.
     */
    readonly sink?: DraftSink;
  },
): Promise<SurfaceReply | PairingChallenge> {
  const cwd = options.cwd ?? process.cwd();
  const paired = await resolvePairing(message.surfaceId, message.senderId, cwd);
  if (!paired) {
    const pending = await requestPairing(message.surfaceId, message.senderId, cwd);
    return { status: "pairing_required", code: pending.code };
  }
  const profile = activeProfile(cwd);
  // muster builtin slash-commands and tool-dispatch skills are answered here
  // with NO model call; prompt-dispatch skills rewrite the prompt, and unknown
  // commands fall through to the native provider CLI.
  const sessionKey = conversationSessionId(message);
  const command = await dispatchCommand(message, { config: options.config, profile, paired, gateway: options.gateway, cwd, conversationKey: sessionKey });
  if (command) return command;
  const governanceReply = gatewayGovernancePreflight(message, paired, options.gateway);
  if (governanceReply) return governanceReply;
  const customCommand = resolveCustomCommand(message, options.gateway);
  const parsedCommand = parseCommand(message.text);
  let runText = customCommand?.prompt ?? maybeAddChannelArtifactInstructions(message.text);
  if (parsedCommand && !customCommand) {
    const skillCommand = await resolveSkillCommand(parsedCommand.name, parsedCommand.args, cwd, {
      skillAllowlist: resolveAgentSkillAllowlist(options.config, profile),
      discovery: options.config.skills?.load,
    });
    if (skillCommand?.dispatch === "tool") {
      const tool = options.registry?.[skillCommand.tool];
      if (!tool) return { text: `Skill command /${parsedCommand.name} is unavailable: tool "${skillCommand.tool}" is not registered.` };
      const output = await tool(skillCommand.args);
      return { text: typeof output === "string" ? output : JSON.stringify(output, null, 2) };
    }
    if (skillCommand?.dispatch === "prompt") {
      runText = skillCommand.prompt;
    }
  }
  // Native provider CLIs (codex/claude) execute in the PROFILE WORKSPACE, never
  // the muster install root — closes the cwd-escape and isolates per profile.
  const workspaceDir = profileWorkspaceDir(cwd, profile);
  await ensureWorkspaceOnce(workspaceDir);
  const startedAt = Date.now();
  const streaming = options.sink !== undefined && message.stream === "draft";
  const channel = streaming ? createStreamEventChannel() : undefined;
  const streamRun = channel ? new StreamRun({ onEvent: channel.push }) : undefined;
  const draftLoop = streaming && channel && options.sink
    ? runDraftLoop(channel.events, options.sink)
    : undefined;
  try {
    const outcome = await executeRun(options.config, {
      prompt: runText,
      cwd,
      workspaceDir,
      skipRecall: !shouldRecallForChannel(message.text),
      conversationKey: sessionKey,
      agentId: profile,
      ...(process.env.MUSTER_CODEX_HOME ? { codexHome: process.env.MUSTER_CODEX_HOME } : {}),
      surfaceId: message.surfaceId,
      scopes: [
        ...pairingScopes(paired),
        { kind: "session", id: sessionKey },
      ],
      onDelta: streamRun ? (text) => {
        if (streamRun.state === "streaming") streamRun.pushDelta(text);
      } : undefined,
    });
    if (outcome.episode.outcome?.kind !== "completed") {
      throw new Error(outcome.episode.outcome?.detail ?? "Run failed");
    }
    const extracted = extractMediaTags(outcome.episode.responseText);
    // finalize() is the only emitter of the final event (OpenClaw #33492).
    streamRun?.finalize(extracted.text);
    const artifacts = await resolveChannelArtifacts(
      outcome.episode.responseText,
      extracted.media.map((item) => item.ref),
      workspaceDir,
      cwd,
      startedAt,
      ARTIFACT_REQUEST_RE.test(message.text),
    );
    return {
      text: extracted.text,
      ...(artifacts.length
        ? { artifacts }
        : {}),
    };
  } finally {
    channel?.close();
    if (draftLoop) await draftLoop;
  }
}

async function readBody(request: IncomingMessage, limitBytes = 1_000_000): Promise<string> {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > limitBytes) throw new Error("Request body too large.");
  }
  return body;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function bearerTokenMatches(request: IncomingMessage, expected: string): boolean {
  const header = request.headers.authorization ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  return headerEquals(presented, expected);
}

/** Constant-time string compare for header secrets (returns false on undefined/length mismatch). */
function headerEquals(presented: string | undefined, expected: string): boolean {
  const left = Buffer.from(presented ?? "");
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

interface AdapterContext {
  readonly config: MusterConfig;
  readonly gateway: GatewayConfig;
  readonly cwd: string;
  readonly fetcher: typeof fetch;
  readonly log: (line: string) => void;
  /** Inbound request headers (lowercased), for adapters that verify signatures. */
  readonly headers: Record<string, string | string[] | undefined>;
  /** Shared per-chat outbound queue (retry_after backoff) for draft streaming. */
  readonly queue: OutboundQueue;
  readonly registry?: FlowToolRegistry;
  readonly gchatVerifier?: GchatRequestVerifier;
}

function conversationLane(message: Pick<SurfaceMessage, "surfaceId" | "conversationId">): string {
  return `${message.surfaceId}:${message.conversationId}`;
}

async function withConversationLane<T>(
  message: SurfaceMessage,
  context: AdapterContext,
  busyMode: "queue" | "reject",
  task: () => Promise<T>,
): Promise<T | SurfaceReply> {
  const key = conversationLane(message);
  const active = activeConversationRuns.get(key);
  if (active && busyMode === "reject") {
    return {
      text: "I’m still working on the previous request in this chat. Send /status to check the connection, or wait for the current run to finish before sending the next instruction.",
    };
  }
  const run = (async () => {
    if (active && busyMode === "queue") await active.catch(() => undefined);
    return task();
  })();
  activeConversationRuns.set(key, run.finally(() => {
    if (activeConversationRuns.get(key) === run) activeConversationRuns.delete(key);
  }));
  try {
    return await run;
  } catch (error) {
    context.log(`channel run failed for ${key}: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

function startTelegramTyping(options: {
  readonly botToken: string;
  readonly chatId: string;
  readonly fetcher: typeof fetch;
  readonly log: (line: string) => void;
  readonly apiBase?: string;
}): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const apiBase = options.apiBase ?? "https://api.telegram.org";
  const tick = (): void => {
    if (stopped) return;
    void options.fetcher(`${apiBase}/bot${options.botToken}/sendChatAction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: options.chatId, action: "typing" }),
    }).then((response) => {
      if (!response.ok) options.log(`telegram sendChatAction failed: HTTP ${response.status}`);
    }).catch((error) => options.log(`telegram sendChatAction failed: ${error instanceof Error ? error.message : String(error)}`));
    timer = setTimeout(tick, 2500);
  };
  tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

async function sendTelegramPayload(botToken: string, payload: unknown, context: AdapterContext, method = "sendMessage"): Promise<unknown> {
  const response = await context.fetcher(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok && body.ok === undefined) body.ok = false;
  if (!response.ok || body.ok === false) context.log(`telegram ${method} failed: HTTP ${response.status}${typeof body.description === "string" ? ` ${body.description}` : ""}`);
  return body;
}

function isHttpArtifact(ref: string): boolean {
  return /^https?:\/\//i.test(ref);
}

function artifactCaption(artifact: SurfaceArtifact): string {
  return artifact.name || basename(artifact.path);
}

function telegramPollOffsetPath(cwd: string): string {
  return join(cwd, ".muster", TELEGRAM_POLL_OFFSET_FILE);
}

async function loadTelegramPollOffset(cwd: string): Promise<number> {
  try {
    const parsed = JSON.parse(await readFile(telegramPollOffsetPath(cwd), "utf8")) as { nextOffset?: unknown };
    return typeof parsed.nextOffset === "number" && Number.isFinite(parsed.nextOffset) && parsed.nextOffset > 0
      ? Math.floor(parsed.nextOffset)
      : 0;
  } catch {
    return 0;
  }
}

async function saveTelegramPollOffset(cwd: string, nextOffset: number): Promise<void> {
  if (!Number.isFinite(nextOffset) || nextOffset <= 0) return;
  await mkdir(join(cwd, ".muster"), { recursive: true, mode: 0o700 });
  await writeFile(telegramPollOffsetPath(cwd), `${JSON.stringify({ nextOffset: Math.floor(nextOffset), updatedAt: new Date().toISOString() }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function sendTelegramArtifact(botToken: string, artifact: SurfaceArtifact, chatId: string, context: AdapterContext): Promise<void> {
  if (isHttpArtifact(artifact.path)) {
    await sendTelegramPayload(botToken, { chat_id: chatId, text: `Artifact: ${artifactCaption(artifact)}\n${artifact.path}` }, context);
    return;
  }
  try {
    const bytes = await readFile(artifact.path);
    const form = new FormData();
    form.set("chat_id", chatId);
    form.set("caption", artifactCaption(artifact));
    form.set("document", new Blob([bytes], { type: artifact.mime || "application/octet-stream" }), artifactCaption(artifact));
    const response = await context.fetcher(`https://api.telegram.org/bot${botToken}/sendDocument`, { method: "POST", body: form });
    if (!response.ok) context.log(`telegram sendDocument failed for ${artifact.path}: HTTP ${response.status}`);
  } catch (error) {
    context.log(`telegram artifact delivery failed for ${artifact.path}: ${error instanceof Error ? error.message : String(error)}`);
    await sendTelegramPayload(botToken, {
      chat_id: chatId,
      text: `I created an artifact, but this gateway could not attach it from the local path:\n${artifact.path}`,
    }, context);
  }
}

async function deliverTelegramReply(botToken: string, reply: SurfaceReply | PairingChallenge, chatId: string, context: AdapterContext): Promise<void> {
  await sendTelegramPayload(botToken, surfaceReplyToTelegramSend(reply, chatId), context);
  if (!isPairingChallenge(reply)) {
    for (const artifact of reply.artifacts ?? []) await sendTelegramArtifact(botToken, artifact, chatId, context);
  }
}

async function deliverTelegramArtifactsOnly(botToken: string, reply: SurfaceReply, chatId: string, context: AdapterContext): Promise<void> {
  for (const artifact of reply.artifacts ?? []) await sendTelegramArtifact(botToken, artifact, chatId, context);
}

interface ChannelProgressHandle {
  stop(finalText?: string): Promise<"updated" | "none">;
}

function noopProgress(): ChannelProgressHandle {
  return { stop: async () => "none" };
}

function channelApiSucceeded(result: unknown): boolean {
  return typeof result !== "object" || result === null || (result as { ok?: unknown }).ok !== false;
}

async function startTelegramProgress(botToken: string, message: SurfaceMessage, context: AdapterContext): Promise<ChannelProgressHandle> {
  if (context.gateway.telegram?.thinking !== "progress") return noopProgress();
  const startedAt = Date.now();
  const response = await sendTelegramPayload(botToken, {
    chat_id: message.conversationId,
    text: channelProgressText(message.text, "telegram"),
  }, context);
  const messageId = typeof response === "object" && response
    ? (response as { result?: { message_id?: unknown } }).result?.message_id
    : undefined;
  if (typeof messageId !== "number") return noopProgress();
  let stopped = false;
  const tick = (): void => {
    if (stopped) return;
    void sendTelegramPayload(botToken, {
      chat_id: message.conversationId,
      message_id: messageId,
      text: channelProgressText(message.text, "telegram", Date.now() - startedAt),
    }, context, "editMessageText");
    timer = setTimeout(tick, 3000);
  };
  let timer = setTimeout(tick, 3000);
  return {
    stop: async (finalText?: string) => {
      stopped = true;
      clearTimeout(timer);
      if (finalText) {
        const result = await sendTelegramPayload(botToken, {
          chat_id: message.conversationId,
          message_id: messageId,
          text: finalText,
        }, context, "editMessageText");
        return channelApiSucceeded(result) ? "updated" : "none";
      }
      return "none";
    },
  };
}

async function sendSlackPayload(botToken: string, payload: unknown, context: AdapterContext, method = "chat.postMessage"): Promise<unknown> {
  const response = await context.fetcher(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${botToken}` },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
  if (!response.ok && body.ok === undefined) body.ok = false;
  if (!response.ok || body.ok === false) context.log(`slack ${method} failed: HTTP ${response.status}${body.error ? ` ${body.error}` : ""}`);
  return body;
}

async function sendSlackFormPayload(botToken: string, fields: Record<string, string>, context: AdapterContext, method: string): Promise<Record<string, unknown>> {
  const response = await context.fetcher(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Bearer ${botToken}`,
    },
    body: new URLSearchParams(fields).toString(),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown> & { ok?: boolean; error?: string };
  if (!response.ok || body.ok === false) context.log(`slack ${method} failed: HTTP ${response.status}${body.error ? ` ${body.error}` : ""}`);
  return body;
}

function slackUploadFailureMessage(error: string | undefined, artifact: SurfaceArtifact): string {
  if (error === "missing_scope") {
    return `Slack could not attach ${artifactCaption(artifact)} because the Muster Slack app is missing the files:write scope. Add files:write, reinstall the Slack app, then retry.`;
  }
  return `Slack could not attach ${artifactCaption(artifact)}${error ? ` (${error})` : ""}.`;
}

async function uploadSlackArtifact(botToken: string, artifact: SurfaceArtifact, channel: string, threadTs: string | undefined, context: AdapterContext): Promise<{ ok: true } | { ok: false; detail: string }> {
  if (isHttpArtifact(artifact.path)) return { ok: false, detail: `• ${artifactCaption(artifact)}: ${artifact.path}` };
  let bytes: Buffer;
  try {
    bytes = await readFile(artifact.path);
  } catch (error) {
    return { ok: false, detail: `• ${artifactCaption(artifact)} created locally at ${artifact.path} but could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
  const filename = artifactCaption(artifact);
  const uploadUrlResponse = await sendSlackFormPayload(botToken, {
    filename,
    length: String(bytes.byteLength),
  }, context, "files.getUploadURLExternal");
  if (uploadUrlResponse.ok === false || typeof uploadUrlResponse.upload_url !== "string" || typeof uploadUrlResponse.file_id !== "string") {
    return { ok: false, detail: slackUploadFailureMessage(typeof uploadUrlResponse.error === "string" ? uploadUrlResponse.error : undefined, artifact) };
  }
  const uploadBody = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const uploadResponse = await context.fetcher(uploadUrlResponse.upload_url, {
    method: "POST",
    headers: { "content-type": artifact.mime || "application/octet-stream" },
    body: uploadBody,
  });
  if (!uploadResponse.ok) {
    return { ok: false, detail: `Slack upload failed for ${filename}: HTTP ${uploadResponse.status}.` };
  }
  const completeResponse = await sendSlackFormPayload(botToken, {
    channel_id: channel,
    initial_comment: `Artifact from this run: ${filename}`,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    files: JSON.stringify([{ id: uploadUrlResponse.file_id, title: filename }]),
  }, context, "files.completeUploadExternal");
  if (completeResponse.ok === false) {
    return { ok: false, detail: slackUploadFailureMessage(typeof completeResponse.error === "string" ? completeResponse.error : undefined, artifact) };
  }
  return { ok: true };
}

async function deliverSlackArtifacts(botToken: string, reply: SurfaceReply, channel: string, threadTs: string | undefined, context: AdapterContext): Promise<void> {
  const artifacts = reply.artifacts ?? [];
  if (!artifacts.length) return;
  const failures: string[] = [];
  for (const artifact of artifacts) {
    const result = await uploadSlackArtifact(botToken, artifact, channel, threadTs, context);
    if (!result.ok) failures.push(result.detail);
  }
  if (!failures.length) return;
  await sendSlackPayload(botToken, {
    channel,
    thread_ts: threadTs,
    text: [
      "Some artifacts could not be attached directly:",
      ...failures,
      "",
      "If this is a Slack scope issue, add files:write to the app, reinstall it in the workspace, and retry.",
    ].join("\n"),
  }, context);
}

async function deliverSlackReply(botToken: string, reply: SurfaceReply | PairingChallenge, channel: string, threadTs: string | undefined, context: AdapterContext): Promise<void> {
  await sendSlackPayload(botToken, surfaceReplyToSlackPost(reply, channel, threadTs), context);
  if (!isPairingChallenge(reply)) await deliverSlackArtifacts(botToken, reply, channel, threadTs, context);
}

async function startSlackProgress(botToken: string, message: SurfaceMessage, context: AdapterContext): Promise<ChannelProgressHandle> {
  if (context.gateway.slack?.status !== "message" && context.gateway.slack?.thinking !== "progress") return noopProgress();
  const startedAt = Date.now();
  const text = context.gateway.slack?.thinking === "progress"
    ? channelProgressText(message.text, "slack")
    : "Processing this.";
  const response = await sendSlackPayload(botToken, {
    channel: message.conversationId,
    thread_ts: message.replyTo,
    text,
  }, context);
  const ts = typeof response === "object" && response ? (response as { ts?: unknown }).ts : undefined;
  if (typeof ts !== "string") return noopProgress();
  let stopped = false;
  const tick = (): void => {
    if (stopped) return;
    const nextText = context.gateway.slack?.thinking === "progress"
      ? channelProgressText(message.text, "slack", Date.now() - startedAt)
      : `Processing this · ${Math.max(1, Math.round((Date.now() - startedAt) / 1000))}s`;
    void sendSlackPayload(botToken, {
      channel: message.conversationId,
      ts,
      text: nextText,
    }, context, "chat.update");
    timer = setTimeout(tick, 3000);
  };
  let timer = setTimeout(tick, 3000);
  return {
    stop: async (finalText?: string) => {
      stopped = true;
      clearTimeout(timer);
      if (finalText) {
        const result = await sendSlackPayload(botToken, {
          channel: message.conversationId,
          ts,
          text: finalText,
        }, context, "chat.update");
        return channelApiSucceeded(result) ? "updated" : "none";
      }
      return "none";
    },
  };
}

/**
 * Telegram webhook: update JSON in, sendMessage out. The adapter module is a
 * pure mapper; only this thin handler touches the network. Processing is
 * synchronous (reply is sent before the webhook is acked) — Telegram retries
 * on timeout, which is acceptable for slice 1. When telegram.secretToken is
 * configured, the X-Telegram-Bot-Api-Secret-Token header must match it
 * (constant-time) or the webhook is rejected with 401; otherwise we warn once
 * that the Telegram webhook is unauthenticated.
 */
async function handleTelegramWebhook(body: string, context: AdapterContext): Promise<unknown> {
  const botToken = context.gateway.telegram?.botToken;
  if (!botToken) throw new Error("Telegram adapter not configured. Add telegram.botToken to .muster/gateway.json.");
  const secretToken = context.gateway.telegram?.secretToken;
  if (secretToken) {
    const presented = context.headers["x-telegram-bot-api-secret-token"];
    if (!headerEquals(typeof presented === "string" ? presented : undefined, secretToken)) {
      throw new GatewayHttpError(401, "Telegram secret token mismatch.");
    }
  } else {
    warnUnauthenticatedOnce("telegram", context.log);
  }
  const payload = JSON.parse(body);
  const callbackQueryId = telegramCallbackQueryId(payload);
  if (callbackQueryId) await sendTelegramPayload(botToken, { callback_query_id: callbackQueryId }, context, "answerCallbackQuery");
  const deliveryKey = adapterDeliveryKey("telegram", body);
  const cached = deliveryLookup(deliveryKey);
  if (cached !== undefined) return cached;
  const mapped = telegramUpdateToSurfaceMessage(payload);
  if (!mapped) return { ok: true, ignored: "not a text message update" };
  if (context.gateway.telegram?.stream === "draft") {
    const message: SurfaceMessage = { ...mapped, stream: "draft" };
    const sink = createTelegramDraftSink({
      botToken,
      chatId: message.conversationId,
      fetcher: context.fetcher,
      queue: context.queue,
    });
    const stopTyping = context.gateway.telegram?.status === "typing"
      ? startTelegramTyping({ botToken, chatId: message.conversationId, fetcher: context.fetcher, log: context.log })
      : () => undefined;
    let reply: SurfaceReply | PairingChallenge;
    let progress = noopProgress();
    try {
      progress = await startTelegramProgress(botToken, message, context);
      reply = await withConversationLane(message, context, context.gateway.telegram?.busy ?? "queue", () => handleSurfaceMessage(message, { ...context, sink }));
      await progress.stop(isPairingChallenge(reply) ? undefined : "✓ Done");
    } catch (error) {
      await progress.stop("! Failed");
      throw error;
    } finally {
      stopTyping();
    }
    // A streamed reply was already delivered draft-by-draft by the sink;
    // pairing challenges fall through to the normal buffered send below.
    if (!isPairingChallenge(reply)) {
      for (const artifact of reply.artifacts ?? []) await sendTelegramArtifact(botToken, artifact, message.conversationId, context);
      const result = { ok: true, streamed: true };
      deliveryStore(deliveryKey, result);
      return result;
    }
    await deliverTelegramReply(botToken, reply, message.conversationId, context);
    const result = { ok: true };
    deliveryStore(deliveryKey, result);
    return result;
  }
  const message = mapped;
  const stopTyping = context.gateway.telegram?.status === "typing"
    ? startTelegramTyping({ botToken, chatId: message.conversationId, fetcher: context.fetcher, log: context.log })
    : () => undefined;
  let reply: SurfaceReply | PairingChallenge;
  let progress = noopProgress();
  let progressFinal: "updated" | "none" = "none";
  try {
    progress = await startTelegramProgress(botToken, message, context);
    reply = await withConversationLane(message, context, context.gateway.telegram?.busy ?? "queue", () => handleSurfaceMessage(message, context));
    progressFinal = await progress.stop(!isPairingChallenge(reply) && !reply.approvalRequest ? reply.text : undefined);
  } catch (error) {
    await progress.stop("! Failed");
    throw error;
  } finally {
    stopTyping();
  }
  if (isPairingChallenge(reply) || reply.approvalRequest || progressFinal !== "updated") {
    await deliverTelegramReply(botToken, reply, message.conversationId, context);
  } else {
    await deliverTelegramArtifactsOnly(botToken, reply, message.conversationId, context);
  }
  const result = { ok: true };
  deliveryStore(deliveryKey, result);
  return result;
}

export interface TelegramPollOptions {
  readonly config: MusterConfig;
  readonly gateway: GatewayConfig;
  readonly cwd?: string;
  readonly fetcher?: typeof fetch;
  readonly registry?: FlowToolRegistry;
  readonly log?: (line: string) => void;
  /** Abort to stop the loop. */
  readonly signal?: AbortSignal;
  /** Long-poll timeout in seconds (Telegram holds the request open). Default 25. */
  readonly pollTimeoutSec?: number;
  /** Bound the number of getUpdates iterations (mainly for tests). Default unbounded. */
  readonly maxIterations?: number;
}

function pollDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/**
 * Long-poll Telegram getUpdates and feed each text update through the SAME
 * governed handleSurfaceMessage path as the webhook (pairing, scoped run,
 * per-surface accounting). No public URL / webhook needed — telegram only
 * allows getUpdates when no webhook is set, so we deleteWebhook first.
 */
export async function pollTelegram(options: TelegramPollOptions): Promise<void> {
  const botToken = options.gateway.telegram?.botToken;
  if (!botToken) throw new Error("Telegram adapter not configured. Add telegram.botToken to .muster/gateway.json.");
  const fetcher = options.fetcher ?? fetch;
  const log = options.log ?? ((line: string) => console.log(line));
  const cwd = options.cwd ?? process.cwd();
  const timeout = options.pollTimeoutSec ?? 25;
  const base = `https://api.telegram.org/bot${botToken}`;
  // getUpdates is rejected while a webhook is set; clear it first (best-effort).
  try { await fetcher(`${base}/deleteWebhook`, { method: "POST" }); } catch { /* best-effort */ }
  log("telegram long-poll started");
  let persistedOffset = await loadTelegramPollOffset(cwd);
  let offset = persistedOffset;
  let iterations = 0;
  const max = options.maxIterations ?? Number.POSITIVE_INFINITY;
  while (!options.signal?.aborted && iterations < max) {
    iterations += 1;
    let updates: Array<Record<string, unknown>>;
    try {
      const res = await fetcher(`${base}/getUpdates?offset=${offset}&timeout=${timeout}`, { signal: options.signal });
      if (!res.ok) { log(`telegram getUpdates HTTP ${res.status}`); await pollDelay(2000, options.signal); continue; }
      const data = (await res.json()) as { result?: Array<Record<string, unknown>> };
      updates = data.result ?? [];
    } catch (error) {
      if (options.signal?.aborted) break;
      log(`telegram getUpdates error: ${error instanceof Error ? error.message : String(error)}`);
      await pollDelay(2000, options.signal);
      continue;
    }
    for (const update of updates) {
      const updateId = typeof update.update_id === "number" ? update.update_id : 0;
      offset = Math.max(offset, updateId + 1);
      if (updateId > 0 && updateId < persistedOffset) continue;
      const message = telegramUpdateToSurfaceMessage(update);
      if (!message) {
        if (updateId > 0 && updateId + 1 > persistedOffset) {
          persistedOffset = updateId + 1;
          await saveTelegramPollOffset(cwd, persistedOffset);
        }
        continue;
      }
      try {
        const context: AdapterContext = { config: options.config, gateway: options.gateway, cwd, registry: options.registry, fetcher, log, headers: {}, queue: createOutboundQueue() };
        const stopTyping = options.gateway.telegram?.status === "typing"
          ? startTelegramTyping({ botToken, chatId: message.conversationId, fetcher, log })
          : () => undefined;
        let reply: SurfaceReply | PairingChallenge;
        let progress = noopProgress();
        try {
          progress = await startTelegramProgress(botToken, message, context);
          reply = await withConversationLane(message, context, options.gateway.telegram?.busy ?? "queue", () => handleSurfaceMessage(message, { config: options.config, gateway: options.gateway, cwd, registry: options.registry }));
          await progress.stop(isPairingChallenge(reply) ? undefined : "✓ Done");
        } catch (error) {
          await progress.stop("! Failed");
          throw error;
        } finally {
          stopTyping();
        }
        await deliverTelegramReply(botToken, reply, message.conversationId, context);
        if (updateId > 0 && updateId + 1 > persistedOffset) {
          persistedOffset = updateId + 1;
          await saveTelegramPollOffset(cwd, persistedOffset);
        }
      } catch (error) {
        log(`telegram update handling failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  log("telegram long-poll stopped");
}

/**
 * Slack Events API webhook: handles url_verification challenges, ignores bot
 * echoes, and posts replies via chat.postMessage (approval requests render as
 * Block Kit buttons). Synchronous processing; see slice-1 caveat above. When
 * slack.signingSecret is configured the X-Slack-Signature / -Request-Timestamp
 * headers are verified against the RAW body (before any JSON parsing) and a
 * mismatch (or a >5-min-old timestamp) is rejected with 401. If no signing
 * secret is configured we warn once that Slack is unauthenticated.
 */
async function handleSlackWebhook(body: string, context: AdapterContext): Promise<unknown> {
  const botToken = context.gateway.slack?.botToken;
  if (!botToken) throw new Error("Slack adapter not configured. Add slack.botToken to .muster/gateway.json.");
  const signingSecret = context.gateway.slack?.signingSecret;
  if (signingSecret) {
    const signature = context.headers["x-slack-signature"];
    const timestamp = context.headers["x-slack-request-timestamp"];
    const valid = slackSignatureIsValid(
      typeof timestamp === "string" ? timestamp : undefined,
      body,
      typeof signature === "string" ? signature : undefined,
      signingSecret,
    );
    if (!valid) throw new GatewayHttpError(401, "Slack signature verification failed.");
  } else {
    warnUnauthenticatedOnce("slack", context.log);
  }
  const payload = parseSlackWebhookBody(body);
  const deliveryId = slackDeliveryId(payload);
  const deliveryKey = deliveryId ? `slack:${deliveryId}` : undefined;
  const cached = deliveryLookup(deliveryKey);
  if (cached !== undefined) return cached;
  return handleSlackPayload(payload, context, botToken, deliveryKey);
}

function parseSlackWebhookBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    const fields = Object.fromEntries(new URLSearchParams(body));
    if (typeof fields.payload === "string") return JSON.parse(fields.payload);
    return fields;
  }
}

async function handleSlackPayload(payload: unknown, context: AdapterContext, botToken: string, deliveryKey?: string): Promise<unknown> {
  const inbound = slackEventToSurfaceMessage(payload);
  if (inbound.kind === "url_verification") return { challenge: inbound.challenge };
  if (inbound.kind === "ignored") return { ok: true, ignored: inbound.reason };
  if (context.gateway.slack?.stream === "draft") {
    const message: SurfaceMessage = { ...inbound.message, stream: "draft" };
    const sink = createSlackDraftSink({
      botToken,
      channel: message.conversationId,
      threadTs: message.replyTo,
      fetcher: context.fetcher,
      queue: context.queue,
    });
    const progress = await startSlackProgress(botToken, message, context);
    let reply: SurfaceReply | PairingChallenge;
    try {
      reply = await withConversationLane(message, context, context.gateway.slack?.busy ?? "queue", () => handleSurfaceMessage(message, { ...context, sink }));
      await progress.stop(isPairingChallenge(reply) ? undefined : "✓ Done");
    } catch (error) {
      await progress.stop("! Failed");
      throw error;
    }
    if (!isPairingChallenge(reply)) {
      await deliverSlackArtifacts(botToken, reply, message.conversationId, message.replyTo, context);
      const result = { ok: true, streamed: true };
      deliveryStore(deliveryKey, result);
      return result;
    }
    await deliverSlackReply(botToken, reply, message.conversationId, message.replyTo, context);
    return { ok: true };
  }
  const progress = await startSlackProgress(botToken, inbound.message, context);
  let reply: SurfaceReply | PairingChallenge;
  let progressFinal: "updated" | "none" = "none";
  try {
    reply = await withConversationLane(inbound.message, context, context.gateway.slack?.busy ?? "queue", () => handleSurfaceMessage(inbound.message, context));
    progressFinal = await progress.stop(!isPairingChallenge(reply) && !reply.approvalRequest ? reply.text : undefined);
  } catch (error) {
    await progress.stop("! Failed");
    throw error;
  }
  if (isPairingChallenge(reply) || reply.approvalRequest || progressFinal !== "updated") {
    await deliverSlackReply(botToken, reply, inbound.message.conversationId, inbound.message.replyTo, context);
  } else {
    await deliverSlackArtifacts(botToken, reply, inbound.message.conversationId, inbound.message.replyTo, context);
  }
  const result = { ok: true };
  deliveryStore(deliveryKey, result);
  return result;
}

interface SlackSocketOptions {
  readonly config: MusterConfig;
  readonly gateway: GatewayConfig;
  readonly cwd?: string;
  readonly fetcher?: typeof fetch;
  readonly registry?: FlowToolRegistry;
  readonly log?: (line: string) => void;
  readonly signal?: AbortSignal;
  readonly reconnectDelayMs?: number;
  readonly maxConnections?: number;
  readonly webSocketFactory?: (url: string) => SlackSocketLike;
}

interface SlackSocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

interface SlackSocketEnvelope {
  readonly envelope_id?: string;
  readonly type?: string;
  readonly payload?: unknown;
}

function makeSlackSocket(url: string): SlackSocketLike {
  const Constructor = globalThis.WebSocket as unknown as (new (socketUrl: string) => SlackSocketLike) | undefined;
  if (!Constructor) throw new Error("Slack Socket Mode requires Node's global WebSocket support.");
  return new Constructor(url);
}

function socketReady(socket: SlackSocketLike, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    socket.onopen = () => resolvePromise();
    socket.onerror = (event) => reject(new Error(`Slack socket open failed: ${String(event)}`));
    signal?.addEventListener("abort", () => reject(new Error("Slack socket open aborted")), { once: true });
  });
}

function socketClosed(socket: SlackSocketLike, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise) => {
    const close = (): void => resolvePromise();
    socket.onclose = close;
    socket.onerror = close;
    signal?.addEventListener("abort", () => {
      try { socket.close(); } catch { /* ignore close races */ }
      resolvePromise();
    }, { once: true });
  });
}

function parseSlackSocketEnvelope(data: unknown): SlackSocketEnvelope | undefined {
  const text = typeof data === "string" ? data : data instanceof Buffer ? data.toString("utf8") : undefined;
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as SlackSocketEnvelope;
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function openSlackSocketUrl(appToken: string, fetcher: typeof fetch): Promise<string> {
  const response = await fetcher("https://slack.com/api/apps.connections.open", {
    method: "POST",
    headers: { authorization: `Bearer ${appToken}`, "content-type": "application/x-www-form-urlencoded" },
    body: "",
  });
  const body = await response.json().catch(() => ({})) as { ok?: boolean; url?: string; error?: string };
  if (!response.ok || body.ok === false || !body.url) {
    throw new Error(`Slack Socket Mode connection failed${body.error ? `: ${body.error}` : `: HTTP ${response.status}`}`);
  }
  return body.url;
}

/** Slack Socket Mode loop. It avoids public HTTPS URLs and uses the same governed Slack payload path as Events API. */
export async function pollSlackSocket(options: SlackSocketOptions): Promise<void> {
  const botToken = options.gateway.slack?.botToken;
  const appToken = options.gateway.slack?.appToken;
  if (!botToken) throw new Error("Slack adapter not configured. Add slack.botToken to .muster/gateway.json.");
  if (!appToken) throw new Error("Slack Socket Mode app token missing. Run: muster channels ready slack --app-token-env SLACK_APP_TOKEN");
  const fetcher = options.fetcher ?? fetch;
  const log = options.log ?? ((line: string) => console.log(line));
  const cwd = options.cwd ?? process.cwd();
  const reconnectDelayMs = options.reconnectDelayMs ?? 2000;
  const maxConnections = options.maxConnections ?? Number.POSITIVE_INFINITY;
  const queue = createOutboundQueue();
  let connections = 0;
  while (!options.signal?.aborted && connections < maxConnections) {
    connections += 1;
    let socket: SlackSocketLike | undefined;
    try {
      const url = await openSlackSocketUrl(appToken, fetcher);
      socket = (options.webSocketFactory ?? makeSlackSocket)(url);
      await socketReady(socket, options.signal);
      log("slack socket-mode connected");
      socket.onmessage = (event) => {
        const envelope = parseSlackSocketEnvelope(event.data);
        if (!envelope) {
          log("slack socket-mode ignored malformed envelope");
          return;
        }
        if (envelope.envelope_id) socket?.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
        if (envelope.type !== "events_api") return;
        void handleSlackPayload(envelope.payload, {
          config: options.config,
          gateway: options.gateway,
          cwd,
          fetcher,
          registry: options.registry,
          log,
          headers: {},
          queue,
        }, botToken, envelope.envelope_id ? `slack-socket:${envelope.envelope_id}` : adapterDeliveryKey("slack", JSON.stringify(envelope.payload))).catch((error) => {
          log(`slack socket-mode payload failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      };
      await socketClosed(socket, options.signal);
      if (!options.signal?.aborted) log("slack socket-mode disconnected; reconnecting");
    } catch (error) {
      if (options.signal?.aborted) break;
      log(`slack socket-mode error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      try { socket?.close(); } catch { /* ignore close races */ }
    }
    if (!options.signal?.aborted && connections < maxConnections) await pollDelay(reconnectDelayMs, options.signal);
  }
  log("slack socket-mode stopped");
}

/**
 * Discord interactions webhook: PING (type 1) is answered with PONG (type 1)
 * for endpoint verification; slash commands run through the governed entry
 * point and the reply goes back synchronously as the interaction response
 * (approvals render as button components). When discord.publicKey is
 * configured, the X-Signature-Ed25519/X-Signature-Timestamp headers are
 * verified against the RAW body (before any JSON parsing) and a mismatch is
 * rejected with 401, as Discord's endpoint validation requires.
 */
async function handleDiscordWebhook(body: string, context: AdapterContext): Promise<unknown> {
  if (!context.gateway.discord?.botToken) {
    throw new Error("Discord adapter not configured. Add discord.botToken to .muster/gateway.json.");
  }
  const publicKey = context.gateway.discord.publicKey;
  if (publicKey) {
    const signature = context.headers["x-signature-ed25519"];
    const timestamp = context.headers["x-signature-timestamp"];
    const valid = discordSignatureIsValid(
      body,
      typeof signature === "string" ? signature : undefined,
      typeof timestamp === "string" ? timestamp : undefined,
      publicKey,
    );
    if (!valid) throw new GatewayHttpError(401, "Discord ed25519 signature verification failed.");
  }
  const deliveryKey = adapterDeliveryKey("discord", body);
  const cached = deliveryLookup(deliveryKey);
  if (cached !== undefined) return cached;
  const inbound = discordInteractionToInbound(JSON.parse(body));
  if (inbound.kind === "pong") return DISCORD_PONG;
  if (inbound.kind === "ignored") return { ok: true, ignored: inbound.reason };
  const reply = await handleSurfaceMessage(inbound.message, context);
  const result = surfaceReplyToDiscordInteractionResponse(reply);
  if (!isPairingChallenge(reply)) deliveryStore(deliveryKey, result);
  return result;
}

/**
 * WhatsApp Cloud API webhook: notification batches in (entry[].changes[]),
 * outbound replies via POST graph.facebook.com/<ver>/<phoneNumberId>/messages.
 * The GET hub.challenge verification handshake is handled separately in route().
 */
async function handleWhatsAppWebhook(body: string, context: AdapterContext): Promise<unknown> {
  const whatsapp = context.gateway.whatsapp;
  if (!whatsapp?.accessToken || !whatsapp.phoneNumberId) {
    throw new Error("WhatsApp adapter not configured. Add whatsapp.{accessToken,verifyToken,phoneNumberId} to .muster/gateway.json.");
  }
  if (whatsapp.appSecret) {
    const signature = context.headers["x-hub-signature-256"];
    if (!whatsAppSignatureIsValid(body, typeof signature === "string" ? signature : undefined, whatsapp.appSecret)) {
      throw new GatewayHttpError(401, "WhatsApp signature verification failed.");
    }
  }
  const deliveryKey = adapterDeliveryKey("whatsapp", body);
  const cached = deliveryLookup(deliveryKey);
  if (cached !== undefined) return cached;
  const messages = whatsAppWebhookToSurfaceMessages(JSON.parse(body));
  if (messages.length === 0) return { ok: true, ignored: "no text messages in notification" };
  let hasPairingChallenge = false;
  for (const message of messages) {
    const reply = await handleSurfaceMessage(message, context);
    if (isPairingChallenge(reply)) hasPairingChallenge = true;
    const payload = surfaceReplyToWhatsAppSend(reply, message.conversationId);
    const version = whatsapp.apiVersion ?? "v19.0";
    const response = await context.fetcher(`https://graph.facebook.com/${version}/${whatsapp.phoneNumberId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${whatsapp.accessToken}` },
      body: JSON.stringify(payload),
    });
    if (!response.ok) context.log(`whatsapp send failed: HTTP ${response.status}`);
  }
  const result = { ok: true };
  if (!hasPairingChallenge) deliveryStore(deliveryKey, result);
  return result;
}

/**
 * Google Chat webhook: MESSAGE events run through the governed entry point;
 * the reply is returned synchronously (Chat renders the response body), with
 * cardsV2 buttons for approvals. If gchat.verificationToken is configured the
 * legacy event token is checked.
 */
async function handleGchatWebhook(body: string, context: AdapterContext): Promise<unknown> {
  if (!context.gateway.gchat) {
    throw new Error("Google Chat adapter not configured. Add a gchat section to .muster/gateway.json.");
  }
  const payload = JSON.parse(body);
  const modern = context.gateway.gchat.verification;
  if (modern?.mode === "bearer") {
    if (!context.gchatVerifier) throw new GatewayHttpError(401, "Google Chat bearer verification is configured but no verifier is available.");
    const authorization = context.headers.authorization;
    const valid = await context.gchatVerifier.verify({
      authorization: typeof authorization === "string" ? authorization : undefined,
      rawBody: body,
      payload,
      audience: modern.audience,
    });
    if (!valid) throw new GatewayHttpError(401, "Google Chat bearer verification failed.");
  } else {
    const expectedToken = context.gateway.gchat.verificationToken;
    if (expectedToken && gchatEventToken(payload) !== expectedToken) {
      throw new GatewayHttpError(401, "Google Chat verification token mismatch.");
    }
  }
  const eventId = gchatDeliveryId(payload);
  const deliveryKey = eventId ? `gchat:${eventId}` : undefined;
  const cached = deliveryLookup(deliveryKey);
  if (cached !== undefined) return cached;
  const inbound = gchatEventToSurfaceMessage(payload, { commands: context.gateway.gchat.commands });
  if (inbound.kind === "ignored") return { ok: true, ignored: inbound.reason };
  const reply = await handleSurfaceMessage(inbound.message, context);
  const result = surfaceReplyToGchatResponse(reply, inbound.message.replyTo);
  if (!isPairingChallenge(reply)) deliveryStore(deliveryKey, result);
  return result;
}

/**
 * Teams outgoing webhook: message activities run through the governed entry
 * point; the reply is returned synchronously (text, or an Adaptive Card for
 * approvals). If teams.hmacSecret is configured the Authorization HMAC is
 * validated against the raw body.
 */
async function handleTeamsWebhook(body: string, context: AdapterContext): Promise<unknown> {
  if (!context.gateway.teams) {
    throw new Error("Teams adapter not configured. Add a teams section to .muster/gateway.json.");
  }
  const secret = context.gateway.teams.hmacSecret;
  if (secret) {
    const header = context.headers.authorization;
    if (!teamsHmacIsValid(body, typeof header === "string" ? header : undefined, secret)) {
      throw new GatewayHttpError(401, "Teams HMAC signature mismatch.");
    }
  }
  const deliveryKey = adapterDeliveryKey("teams", body);
  const cached = deliveryLookup(deliveryKey);
  if (cached !== undefined) return cached;
  const inbound = teamsActivityToSurfaceMessage(JSON.parse(body));
  if (inbound.kind === "ignored") return { ok: true, ignored: inbound.reason };
  const reply = await handleSurfaceMessage(inbound.message, context);
  const result = surfaceReplyToTeamsActivity(reply);
  if (!isPairingChallenge(reply)) deliveryStore(deliveryKey, result);
  return result;
}

type AdapterHandler = (body: string, context: AdapterContext) => Promise<unknown>;

const adapterRoutes: Record<string, AdapterHandler> = {
  telegram: handleTelegramWebhook,
  slack: handleSlackWebhook,
  discord: handleDiscordWebhook,
  whatsapp: handleWhatsAppWebhook,
  gchat: handleGchatWebhook,
  teams: handleTeamsWebhook,
};

function adapterDeliveryKey(adapterId: string, body: string): string | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (adapterId === "telegram") {
    const updateId = typeof payload === "object" && payload !== null ? (payload as { update_id?: unknown }).update_id : undefined;
    return typeof updateId === "number" ? `telegram:${updateId}` : undefined;
  }
  if (adapterId === "slack") {
    const id = slackDeliveryId(payload);
    return id ? `slack:${id}` : undefined;
  }
  if (adapterId === "discord") {
    const id = typeof payload === "object" && payload !== null ? (payload as { id?: unknown }).id : undefined;
    return typeof id === "string" && id ? `discord:${id}` : undefined;
  }
  if (adapterId === "whatsapp") {
    const ids = whatsAppMessageIds(payload);
    return ids.length ? `whatsapp:${ids.join(",")}` : undefined;
  }
  if (adapterId === "gchat") {
    const message = typeof payload === "object" && payload !== null ? (payload as { message?: { name?: unknown } }).message : undefined;
    return typeof message?.name === "string" && message.name ? `gchat:${message.name}` : undefined;
  }
  if (adapterId === "teams") {
    const id = typeof payload === "object" && payload !== null ? (payload as { id?: unknown }).id : undefined;
    return typeof id === "string" && id ? `teams:${id}` : undefined;
  }
  return undefined;
}

async function route(request: IncomingMessage, response: ServerResponse, options: GatewayServerOptions, queue: OutboundQueue): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const url = new URL(request.url ?? "/", "http://gateway.local");

  if (request.method === "GET" && url.pathname === "/v1/health") {
    sendJson(response, 200, { ok: true, service: "muster-gateway" });
    return;
  }

  // WhatsApp Cloud API GET verification handshake (hub.challenge echo).
  if (request.method === "GET" && url.pathname === "/v1/adapters/whatsapp") {
    const verifyToken = options.gateway.whatsapp?.verifyToken;
    if (!verifyToken) {
      sendJson(response, 500, { error: "WhatsApp adapter not configured. Add whatsapp.verifyToken to .muster/gateway.json." });
      return;
    }
    const challenge = whatsAppVerifyChallenge({
      mode: url.searchParams.get("hub.mode") ?? undefined,
      verifyToken: url.searchParams.get("hub.verify_token") ?? undefined,
      challenge: url.searchParams.get("hub.challenge") ?? undefined,
    }, verifyToken);
    if (challenge === undefined) {
      sendJson(response, 403, { error: "WhatsApp verification failed: mode or verify token mismatch." });
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(challenge);
    return;
  }

  const adapterMatch = url.pathname.match(/^\/v1\/adapters\/([a-z0-9-]+)$/);
  if (request.method === "POST" && adapterMatch) {
    const adapterId = adapterMatch[1];
    const handler = adapterRoutes[adapterId];
    if (!handler) {
      sendJson(response, 404, { error: `Unknown adapter: ${adapterId}` });
      return;
    }
    if (!adapterHasPlatformAuth(adapterId, options.gateway) && !bearerTokenMatches(request, options.gateway.token)) {
      sendJson(response, 401, { error: `Unauthorized ${adapterId} adapter webhook. Configure platform signature verification or send Authorization: Bearer <gateway token>.` });
      return;
    }
    const body = await readBody(request);
    const result = await handler(body, {
      config: options.config,
      gateway: options.gateway,
      cwd,
      fetcher: options.fetcher ?? fetch,
      log: options.log ?? (() => {}),
      headers: request.headers,
      queue,
      registry: options.registry,
      gchatVerifier: options.gchatVerifier,
    });
    sendJson(response, 200, result ?? { ok: true });
    return;
  }

  // Everything below requires the gateway bearer token.
  if (!bearerTokenMatches(request, options.gateway.token)) {
    sendJson(response, 401, { error: "Unauthorized. Send Authorization: Bearer <gateway token>." });
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/messages") {
    const body = await readBody(request);
    let message: SurfaceMessage;
    try {
      message = parseSurfaceMessage(JSON.parse(body));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const reply = await handleSurfaceMessage(message, { config: options.config, gateway: options.gateway, cwd, registry: options.registry });
    sendJson(response, 200, reply);
    return;
  }

  const flowMatch = url.pathname.match(/^\/v1\/flows\/([A-Za-z0-9_-]+)\/(approve|reject)$/);
  if (request.method === "POST" && flowMatch) {
    const [, runId, action] = flowMatch;
    const result = await resumeFlow(runId, {
      approve: action === "approve",
      config: options.config,
      registry: options.registry ?? defaultRegistry(),
      cwd,
    });
    sendJson(response, 200, {
      runId: result.runId,
      flowId: result.flowId,
      status: result.status,
      gateId: result.gateId,
      show: result.show,
      error: result.error,
    });
    return;
  }

  sendJson(response, 404, { error: `No route: ${request.method} ${url.pathname}` });
}

function adapterHasPlatformAuth(adapterId: string, gateway: GatewayConfig): boolean {
  switch (adapterId) {
    case "telegram":
      return Boolean(gateway.telegram?.secretToken);
    case "slack":
      return Boolean(gateway.slack?.signingSecret);
    case "discord":
      return Boolean(gateway.discord?.publicKey);
    case "gchat":
      return Boolean(gateway.gchat?.verificationToken || gateway.gchat?.verification?.mode === "bearer");
    case "teams":
      return Boolean(gateway.teams?.hmacSecret);
    case "whatsapp":
      return Boolean(gateway.whatsapp?.appSecret);
    default:
      return false;
  }
}

function whatsAppSignatureIsValid(body: string, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", appSecret).update(body).digest("hex")}`;
  return headerEquals(header, expected);
}

export function startGatewayServer(options: GatewayServerOptions, port = 0): Promise<RunningGateway> {
  const log = options.log ?? (() => {});
  // One outbound queue per gateway: chat keys share retry_after backoff state.
  const queue = createOutboundQueue();
  const server = createServer((request, response) => {
    route(request, response, options, queue).catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      const status = error instanceof GatewayHttpError ? error.status : 500;
      log(`error ${request.method} ${request.url}: ${detail}`);
      if (!response.headersSent) sendJson(response, status, { error: detail });
      else response.end();
    });
  });
  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const boundPort = typeof address === "object" && address ? address.port : port;
      log(`muster gateway listening on http://127.0.0.1:${boundPort}`);
      resolvePromise({
        port: boundPort,
        server,
        close: () => new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done()))),
      });
    });
  });
}
