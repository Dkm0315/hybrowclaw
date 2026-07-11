import { createHash, randomUUID } from "node:crypto";
import { readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentRules } from "./agent-rules.js";
import { defaultHookBus, type HookBus } from "./hooks.js";
import { appendGoalLoopTurn, buildGoalLoopTurn, rememberedMemoryWrite, type GoalLoopMemoryWrite } from "./goal-loop.js";
import { runClaudeCode } from "./claude.js";
import { runCodex } from "./codex.js";
import { clearCodexAppServerConversation, clearCodexAppServerSessions, runCodexAppServer } from "./codex-app-server.js";
import { canReuseHandle, clearConversationSessionHandles, clearSessionHandle, loadSessionHandle, saveSessionHandle } from "./session-handle.js";
import { renderConversation } from "./compactor.js";
import { messagesToTranscript, openSessionStore } from "./sessions.js";

/** Token budget for the provider-direct rendered transcript (bounds runaway multi-turn context). */
const DEFAULT_CONTEXT_BUDGET_TOKENS = 16_000;

const FAST_SIMPLE_QA_RULES = "Answer only the user's request. If unsure, say so. Do not mention internal rules or process.";

/** Split a conversation key ("channel:...:peer") into the session store's (channel, peer). */
function splitConversationKey(key: string): { channel: string; peer: string } {
  const idx = key.lastIndexOf(":");
  return idx === -1 ? { channel: key, peer: "default" } : { channel: key.slice(0, idx), peer: key.slice(idx + 1) };
}

function hashSystemContext(system: string): string {
  return createHash("sha256").update(system).digest("hex");
}
import { applySkillEnvForRun, exportClaudeSkillSnapshot, recordSkillUse, resolveAgentSkillAllowlist, selectSkills } from "./skills.js";
import { addMemory, searchMemoryWithReceipts, type SearchMemoryReceiptResult } from "./memory.js";
import { runPiEmbeddedAgent, type PiAgentRunResult, type PiSessionMode } from "./pi.js";
import { completeChat } from "./provider.js";
import { classifyTask, planRun } from "./router.js";
import { appendEpisode } from "./store.js";
import { synthesizeDeltas } from "./stream.js";
import { endSpan, genAiAttributes, startSpan } from "./telemetry.js";
import { appendTokenRecord, buildTokenRecord, type TokenRecord } from "./tokens.js";
import type {
  ChatMessage,
  ContextObject,
  EpisodeRecord,
  EvidenceRecord,
  MusterConfig,
  MemoryScope,
  ModelRoute,
  RunPlan,
  TaskKind,
} from "./types.js";

export interface RunOptions {
  readonly prompt: string;
  readonly runtime?: string;
  readonly taskKind?: TaskKind;
  readonly sensitive?: boolean;
  readonly provider?: string;
  readonly model?: string;
  readonly thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  readonly sessionMode?: PiSessionMode;
  readonly sessionDir?: string;
  readonly scopes?: MemoryScope[];
  readonly recallLimit?: number;
  readonly cwd?: string;
  /**
   * Execution sandbox for native provider CLIs (codex/claude) — the profile
   * workspace, NOT the muster install root. Falls back to cwd when unset.
   */
  readonly workspaceDir?: string;
  /** CODEX_HOME for the codex runtime (carries the user's subscription auth). */
  readonly codexHome?: string;
  /** Test/advanced override for the claude-code command binary. */
  readonly claudeCommand?: string;
  /** Native provider session handle to resume (codex thread_id / claude session id). */
  readonly sessionId?: string;
  readonly resume?: boolean;
  /** Native CLI session continuity. Disable for faster one-off Codex turns. */
  readonly nativeSession?: boolean;
  /** Keep native app-server transports alive after the turn. Interactive chat uses this; one-shot commands should not. */
  readonly nativeSessionKeepAlive?: boolean;
  /** Native transport preference. "warm" reuses app-server/session transports where supported; "exec" forces one process per turn. */
  readonly nativeTransport?: "auto" | "warm" | "exec";
  /** Long-lived host that owns warm native transports, for targeted shutdown. */
  readonly nativeTransportOwner?: string;
  /**
   * Conversation identity (e.g. the surface conversation id). When set, the
   * native provider session for THIS conversation is resumed across turns via
   * the session-handle store — so a multi-turn chat keeps one provider thread.
   */
  readonly conversationKey?: string;
  /** Token budget for the provider-direct multi-turn transcript. Default 16k. */
  readonly contextBudgetTokens?: number;
  readonly timeoutMs?: number;
  /** Skip memory lookup for latency-sensitive turns. Explicit memory commands should leave this false. */
  readonly skipRecall?: boolean;
  /** Skip ambient skill scoring/injection for latency-sensitive turns. Explicit skill commands still run outside executeRun. */
  readonly skipSkillSelection?: boolean;
  readonly skipMemoryWrite?: boolean;
  readonly skipAgentRules?: boolean;
  /** Hook bus for prompt.build gating; defaults to the process-wide bus. */
  readonly hooks?: HookBus;
  /** Surface label for per-surface token accounting (set by the gateway). */
  readonly surfaceId?: string;
  /** Profile/agent id used for scoped skill visibility. */
  readonly agentId?: string;
  /**
   * Optional streaming hook (packages/core/src/stream.ts). For the pi runtime
   * this receives live assistant deltas from the embedded session; for
   * claude-code/native runtimes the buffered response is chunked into
   * synthetic deltas so the same coalescer/draft pipeline runs everywhere.
   */
  readonly onDelta?: (text: string) => void;
}

export interface RunOutcome {
  readonly plan: RunPlan;
  readonly episode: EpisodeRecord;
  readonly tokens: TokenRecord;
  readonly recalled: ContextObject[];
  readonly recallReceipt?: SearchMemoryReceiptResult;
  readonly timings?: RunTimingBreakdown;
  readonly fallbackUsed?: string;
  readonly piResult?: PiAgentRunResult;
  /** Native codex session handle to persist for resuming the next turn. */
  readonly codexThreadId?: string;
}

export interface RunTimingBreakdown {
  readonly totalMs: number;
  readonly planningMs: number;
  readonly recallMs: number;
  readonly agentRulesMs?: number;
  readonly skillSelectionMs?: number;
  readonly promptBuildMs: number;
  readonly hookMs?: number;
  readonly providerMs: number;
  readonly firstTokenMs?: number;
  readonly providerTransport?: string;
  readonly providerAttemptCount?: number;
  readonly providerStartupMs?: number;
  readonly providerQueueMs?: number;
  readonly providerThreadOpenMs?: number;
  readonly providerRequestToFirstDeltaMs?: number;
  readonly providerCacheState?: string;
  readonly providerThreadOpenState?: string;
  readonly fallbackMs?: number;
  readonly backendFallbackMs?: number;
  readonly memoryWriteMs?: number;
  readonly persistMs: number;
}

/** Provider-neutral lifecycle boundary used by long-lived gateway/RPC hosts. */
export function closeWarmProviderTransports(transportOwner?: string): void {
  clearCodexAppServerSessions(transportOwner);
}

/** Clear persisted and in-memory native continuity for one conversation only. */
export async function invalidateNativeConversation(conversationKey: string, cwd = process.cwd()): Promise<number> {
  clearCodexAppServerConversation(conversationKey);
  return clearConversationSessionHandles(conversationKey, cwd);
}

interface LocalFastAnswer {
  readonly responseText: string;
  readonly label: string;
  readonly detail: string;
}

function defaultScopes(): MemoryScope[] {
  const user = process.env.USER || process.env.USERNAME || "local";
  return [{ kind: "user", id: user }];
}

async function maybeAnswerLocalWorkspacePrompt(prompt: string, cwd: string): Promise<LocalFastAnswer | undefined> {
  const normalized = prompt.toLowerCase().replace(/\s+/g, " ").trim();
  const asksForListing = /\b(list|show|what(?:'s| is)?|which)\b/.test(normalized)
    && /\b(files?|directories|folders?|present|contents?)\b/.test(normalized);
  const currentFolderOnly = /\b(current|this|working|personal)\s+(folder|directory)\b/.test(normalized)
    || /\b(folder|directory)\s+(i am in|i'm in|we are in|we're in)\b/.test(normalized);
  const targetedPath = /(?:^|\s)(?:\.{1,2}\/|~\/|\/|[a-z0-9_.-]+\/[a-z0-9_.\/-]*)/.test(normalized);
  const fileTarget = /\b[a-z0-9_-]+\.[a-z0-9]{1,8}\b/.test(normalized);
  const needsProvider = /\b(explain|summari[sz]e|analy[sz]e|why|compare|find|search|grep|read|open|modify|change|changed|status|diff|delete|install|content of|contents of)\b/.test(normalized);
  if (!asksForListing || !currentFolderOnly || targetedPath || fileTarget || needsProvider) return undefined;

  const includeHidden = /\b(hidden|dotfiles?|all files)\b/.test(normalized);
  const entries = (await readdir(cwd, { withFileTypes: true }))
    .filter((entry) => includeHidden || !entry.name.startsWith("."))
    .sort((left, right) => left.name.localeCompare(right.name));
  const visible = entries.slice(0, 200).map((entry) => `\`${entry.name}${entry.isDirectory() ? "/" : ""}\``);
  const suffix = entries.length > visible.length ? `\n\n...and ${entries.length - visible.length} more entries.` : "";
  const responseText = visible.length
    ? `Current folder contains:\n\n${visible.map((entry) => `- ${entry}`).join("\n")}${suffix}`
    : "Current folder is empty.";
  return {
    responseText,
    label: "local_workspace_listing",
    detail: `listed=${Math.min(entries.length, visible.length)} total=${entries.length} include_hidden=${includeHidden}`,
  };
}

export async function recallMemory(prompt: string, scopes: MemoryScope[], limit: number, cwd: string): Promise<ContextObject[]> {
  return (await recallMemoryWithReceipt(prompt, scopes, limit, cwd)).receipts.map((receipt) => receipt.memory);
}

export async function recallMemoryWithReceipt(prompt: string, scopes: MemoryScope[], limit: number, cwd: string): Promise<SearchMemoryReceiptResult> {
  return searchMemoryWithReceipts({
    query: prompt,
    scopes,
    includeGlobal: true,
    limit,
    candidateLimit: Math.max(limit * 20, 50),
    match: "any",
  }, cwd);
}

export function buildRecalledBlock(recalled: readonly ContextObject[]): string {
  if (!recalled.length) return "";
  const lines = recalled.map((object) => `- [${object.kind}] ${object.summary}`);
  return `Recalled context (scoped memory, provenance-tracked; verify before relying on it):\n${lines.join("\n")}`;
}

function planForManagedRuntime(runtimeId: "pi" | "claude-code" | "codex", options: RunOptions): RunPlan {
  const defaults = runtimeId === "pi"
    ? { provider: "pi-default", model: "pi-default" }
    : runtimeId === "codex"
      ? { provider: "codex", model: "gpt-5.5" }
      : { provider: "anthropic", model: "sonnet" };
  return {
    runId: `run_${randomUUID()}`,
    taskKind: classifyTask(options.prompt, options.taskKind),
    runtimeId,
    route: {
      provider: options.provider ?? defaults.provider,
      model: options.model ?? defaults.model,
    },
    sensitive: options.sensitive ?? false,
    createdAt: new Date().toISOString(),
  };
}

interface AttemptResult {
  readonly responseText: string;
  readonly status: "completed" | "failed";
  readonly errorMessage?: string;
  readonly route: ModelRoute;
  readonly piResult?: PiAgentRunResult;
  readonly codexThreadId?: string;
  readonly sessionMode?: string;
  readonly sessionId?: string;
  readonly firstTokenMs?: number;
  readonly providerTransport?: string;
  readonly providerStartupMs?: number;
  readonly providerQueueMs?: number;
  readonly providerThreadOpenMs?: number;
  readonly providerRequestToFirstDeltaMs?: number;
  readonly providerCacheState?: string;
  readonly providerThreadOpenState?: string;
  readonly backendFallbackMs?: number;
  readonly tokenUsage?: {
    readonly inputTokens?: number;
    readonly cachedInputTokens?: number;
    readonly outputTokens?: number;
  };
}

function normalizeNativeTransport(value: string | undefined): "auto" | "warm" | "exec" {
  if (value === "exec") return "exec";
  if (value === "warm" || value === "app-server") return "warm";
  return "auto";
}

interface PromptParts {
  /** Preamble + user prompt concatenated (pi/native send this — behaviour unchanged). */
  readonly combined: string;
  /** Just the user's prompt (claude-code sends this as the user message). */
  readonly user: string;
  /** Operating rules / recalled context (claude-code sends this as the system prompt). */
  readonly system: string;
  /** Stable instructions used for native session identity; volatile recall/skills must not bust warm sessions. */
  readonly stableSystem: string;
  /** Per-run Claude Code plugin dirs, currently used for temporary skill snapshots. */
  readonly claudePluginDirs?: readonly string[];
}

function emptyRecallReceipt(query: string, scopes: readonly MemoryScope[], limit: number): SearchMemoryReceiptResult {
  return {
    query,
    scopes: [...scopes],
    includeGlobal: false,
    backend: "sqlite-fts5",
    requestedLimit: Math.max(1, Math.floor(limit)),
    candidateCount: 0,
    receipts: [],
    fallbackUsed: false,
  };
}

/**
 * A provider CLI backend: turns a route + prompt parts into an attempt result.
 * Each native-CLI runtime is ONE entry in CLI_BACKENDS below; attemptRoute
 * dispatches through the registry and never special-cases a provider, so adding
 * gemini/cursor/copilot is a single backend + registry line (acpx's adapter
 * registry idea, kept in-repo with no runtime install). Native CLIs own their
 * own sessions/compaction, so they bypass the provider-direct render path.
 */
type CliBackendRunner = (route: ModelRoute, prompts: PromptParts, options: RunOptions) => Promise<AttemptResult>;

const runClaudeCodeBackend: CliBackendRunner = async (route, prompts, options) => {
  const stateCwd = options.cwd ?? process.cwd();
  const claudeCwd = options.cwd ?? process.cwd();
  // Resume THIS conversation's claude session when the stable config (cwd+model)
  // is unchanged; otherwise pin a FRESH muster-generated id so the next turn can
  // resume it. Explicit options.sessionId (e.g. CLI) takes precedence; no
  // conversationKey means the original stateless behaviour.
  const stored = options.conversationKey && !options.sessionId
    ? await loadSessionHandle(options.conversationKey, "claude", stateCwd)
    : undefined;
  const contextHash = hashSystemContext(prompts.stableSystem);
  const reuse = canReuseHandle(stored, claudeCwd, route.model, contextHash);
  const sessionId = options.conversationKey
    ? (reuse ? stored.handle : (options.sessionId ?? randomUUID()))
    : options.sessionId;
  const claudeResult = await runClaudeCode({
    prompt: prompts.user,
    systemPrompt: prompts.system || undefined,
    cwd: claudeCwd,
    model: route.model,
    timeoutMs: options.timeoutMs,
    command: options.claudeCommand,
    sessionId,
    resume: reuse ? true : options.resume,
    pluginDirs: prompts.claudePluginDirs,
  });
  // Persist the session for next turn on success; drop a broken one on failure.
  if (options.conversationKey && sessionId) {
    if (claudeResult.status === "completed") {
      await saveSessionHandle({
        conversationKey: options.conversationKey,
        backendId: "claude",
        handle: sessionId,
        cwd: claudeCwd,
        model: route.model,
        contextHash,
        updatedAt: new Date().toISOString(),
      }, stateCwd);
    } else {
      await clearSessionHandle(options.conversationKey, "claude", stateCwd);
    }
  }
  const responseText = claudeResult.stdout.trim();
  if (options.onDelta && claudeResult.status === "completed") {
    for (const chunk of synthesizeDeltas(responseText)) options.onDelta(chunk);
  }
  return {
    responseText,
    status: claudeResult.status,
    errorMessage: claudeResult.status === "failed" ? (claudeResult.errorMessage || claudeResult.stderr.trim() || "claude command failed") : undefined,
      route,
      sessionMode: sessionId ? (reuse ? "continue" : "create") : undefined,
      sessionId,
    };
};

const runCodexBackend: CliBackendRunner = async (route, prompts, options) => {
  const workspaceDir = options.workspaceDir ?? options.cwd ?? process.cwd();
  const stateCwd = options.cwd ?? process.cwd();
  // muster memory/rules go to a SYSTEM-level instructions file, never the user
  // turn — so the provider's own AGENTS.md still stacks natively and rule 6 (no
  // preamble narration) holds.
  let instructionsFile: string | undefined;
  if (prompts.system.trim()) {
    instructionsFile = join(tmpdir(), `muster-codex-inject-${randomUUID()}.md`);
    await writeFile(instructionsFile, prompts.system, "utf8");
  }
  // Resume THIS conversation's native codex thread when the stable config
  // (workspace + model) is unchanged; otherwise mint a fresh one. Explicit
  // options.sessionId/resume (e.g. CLI) still take precedence.
  const useNativeSession = options.nativeSession !== false;
  const stored = useNativeSession && options.conversationKey && !options.sessionId
    ? await loadSessionHandle(options.conversationKey, "codex", stateCwd)
    : undefined;
  const contextHash = hashSystemContext(prompts.stableSystem);
  const reuse = canReuseHandle(stored, workspaceDir, route.model, contextHash);
  try {
    const codexEnv = options.codexHome ? { CODEX_HOME: options.codexHome } : undefined;
    const nativeTransport = normalizeNativeTransport(options.nativeTransport ?? process.env.MUSTER_NATIVE_TRANSPORT ?? process.env.MUSTER_CODEX_TRANSPORT);
    const useAppServer = useNativeSession
      && nativeTransport !== "exec"
      && (process.stdin.isTTY || nativeTransport === "warm");
    const codexResult = useAppServer
      ? await runCodexAppServer({
          prompt: prompts.user,
          cwd: workspaceDir,
          model: route.model,
          reasoning: route.reasoning,
          instructionsFile,
          networkAccess: true,
          env: codexEnv,
          timeoutMs: options.timeoutMs,
          threadId: reuse ? stored.handle : (options.resume ? options.sessionId : undefined),
          keepAlive: options.nativeSessionKeepAlive ?? true,
          cacheKey: options.conversationKey,
          transportOwner: options.nativeTransportOwner,
          onDelta: options.onDelta,
        })
      : await runCodex({
          prompt: prompts.user,
          cwd: workspaceDir,
          model: route.model,
          reasoning: route.reasoning,
          instructionsFile,
          networkAccess: true,
          sessionId: reuse ? stored.handle : options.sessionId,
          resume: reuse ? true : options.resume,
          ephemeral: !useNativeSession,
          ignoreRules: options.surfaceId === "cli-chat",
          env: codexEnv,
          timeoutMs: options.timeoutMs,
        });
    const backendFallbackStartedAt = Date.now();
    const finalCodexResult = useAppServer && codexResult.status === "failed"
      ? await runCodex({
          prompt: prompts.user,
          cwd: workspaceDir,
          model: route.model,
          reasoning: route.reasoning,
          instructionsFile,
          networkAccess: true,
          sessionId: reuse ? stored.handle : options.sessionId,
          resume: reuse ? true : options.resume,
          ephemeral: false,
          ignoreRules: options.surfaceId === "cli-chat",
          env: codexEnv,
          timeoutMs: options.timeoutMs,
        })
      : codexResult;
    const backendFallbackMs = useAppServer && codexResult.status === "failed" ? Date.now() - backendFallbackStartedAt : 0;
    const appServerTimings = useAppServer && "timings" in codexResult ? codexResult.timings : undefined;
    // Persist the thread for next turn on success; drop a broken thread on
    // failure so it is never resumed into a dead end.
    if (useNativeSession && options.conversationKey) {
      if (finalCodexResult.status === "completed" && finalCodexResult.threadId) {
        await saveSessionHandle({
          conversationKey: options.conversationKey,
          backendId: "codex",
          handle: finalCodexResult.threadId,
          cwd: workspaceDir,
          model: route.model,
          contextHash,
          updatedAt: new Date().toISOString(),
        }, stateCwd);
      } else if (finalCodexResult.status === "failed") {
        await clearSessionHandle(options.conversationKey, "codex", stateCwd);
      }
    }
    const responseText = finalCodexResult.finalMessage.trim();
    if ((!useAppServer || codexResult.status === "failed") && options.onDelta && finalCodexResult.status === "completed" && responseText) {
      for (const chunk of synthesizeDeltas(responseText)) options.onDelta(chunk);
    }
    return {
      responseText,
      status: finalCodexResult.status,
      errorMessage: finalCodexResult.status === "failed" ? (finalCodexResult.errorMessage || "codex run failed") : undefined,
      route,
      codexThreadId: finalCodexResult.threadId,
      sessionMode: useNativeSession && finalCodexResult.threadId ? (reuse ? "continue" : "create") : undefined,
      sessionId: finalCodexResult.threadId,
      firstTokenMs: "firstDeltaMs" in finalCodexResult ? finalCodexResult.firstDeltaMs : undefined,
      providerTransport: useAppServer
        ? (codexResult.status === "failed" ? "warm-fallback-exec" : "warm")
        : "exec",
      providerStartupMs: appServerTimings?.startupMs,
      providerQueueMs: appServerTimings?.queueMs,
      providerThreadOpenMs: appServerTimings?.threadOpenMs,
      providerRequestToFirstDeltaMs: appServerTimings?.requestToFirstDeltaMs,
      providerCacheState: appServerTimings?.cacheState,
      providerThreadOpenState: appServerTimings?.threadOpenState,
      backendFallbackMs,
      tokenUsage: "tokenUsage" in finalCodexResult ? finalCodexResult.tokenUsage : undefined,
    };
  } finally {
    if (instructionsFile) await rm(instructionsFile, { force: true }).catch(() => {});
  }
};

/** The provider-agnostic backend registry — add a CLI provider with one entry. */
const CLI_BACKENDS: Record<string, CliBackendRunner> = {
  "claude-code": runClaudeCodeBackend,
  codex: runCodexBackend,
};

export function listCliBackends(): string[] {
  return Object.keys(CLI_BACKENDS);
}

async function attemptRoute(
  config: MusterConfig,
  plan: RunPlan,
  route: ModelRoute,
  prompts: PromptParts,
  options: RunOptions,
): Promise<AttemptResult> {
  const backend = CLI_BACKENDS[plan.runtimeId];
  if (backend) return backend(route, prompts, options);
  if (plan.runtimeId === "pi") {
    const piResult = await runPiEmbeddedAgent({
      prompt: prompts.combined,
      cwd: options.cwd,
      provider: route.provider === "pi-default" ? undefined : route.provider,
      model: route.model === "pi-default" ? undefined : route.model,
      thinking: options.thinking,
      sessionMode: options.sessionMode,
      sessionDir: options.sessionDir,
      timeoutMs: options.timeoutMs,
      onDelta: options.onDelta,
    });
    return {
      responseText: piResult.stdout.trim(),
      status: piResult.status,
      errorMessage: piResult.errorMessage,
      route,
      piResult,
      sessionMode: piResult.sessionMode,
      sessionId: piResult.sessionId,
      providerTransport: "pi",
    };
  }
  const provider = config.providers[route.provider];
  if (!provider) {
    return { responseText: "", status: "failed", errorMessage: `Provider not configured: ${route.provider}`, route };
  }
  if (provider.kind === "codex-cli") {
    return runCodexBackend({ ...route, model: route.model || provider.defaultModel }, prompts, options);
  }
  // Multi-turn, budgeted context for the provider-direct (API) path only: load
  // this conversation's prior turns, render them to fit the budget (stub old
  // tool results, compact if needed), and persist the new turn for next time.
  // Gated on conversationKey, so single-shot runs (CLI, no conversation) keep
  // the original flat-message behaviour. Native CLI runtimes own their own
  // sessions and never reach this branch.
  const runCwd = options.cwd ?? process.cwd();
  const store = options.conversationKey ? openSessionStore(runCwd) : undefined;
  try {
    let messages: ChatMessage[] = [
      ...(prompts.system.trim() ? [{ role: "system" as const, content: prompts.system }] : []),
      { role: "user", content: prompts.user },
    ];
    let sessionId: string | undefined;
    if (store && options.conversationKey) {
      const { channel, peer } = splitConversationKey(options.conversationKey);
      sessionId = store.findOrCreateSession({ channel, peer }).id;
      const prior = messagesToTranscript(store.loadActiveMessages(sessionId));
      const rendered = await renderConversation({
        system: prompts.system || undefined,
        prior,
        userPrompt: prompts.user,
        budgetTokens: options.contextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS,
      });
      messages = rendered.map((message) => ({ role: message.role === "tool" ? "user" : message.role, content: message.content }));
    }
    const text = await completeChat({ provider, route, messages });
    if (options.onDelta && text) {
      for (const chunk of synthesizeDeltas(text)) options.onDelta(chunk);
    }
    if (store && sessionId && text) {
      store.appendMessage(sessionId, "user", prompts.user);
      store.appendMessage(sessionId, "assistant", text);
    }
    return { responseText: text, status: text ? "completed" : "failed", errorMessage: text ? undefined : "Empty response", route, providerTransport: "http" };
  } catch (error) {
    return { responseText: "", status: "failed", errorMessage: error instanceof Error ? error.message : String(error), route };
  } finally {
    store?.close();
  }
}

export async function executeRun(config: MusterConfig, options: RunOptions): Promise<RunOutcome> {
  const runStartedAt = Date.now();
  const cwd = options.cwd ?? process.cwd();
  const planningStartedAt = Date.now();
  const plan = options.runtime === "pi" || options.runtime === "claude-code" || options.runtime === "claude" || options.runtime === "codex"
    ? planForManagedRuntime(options.runtime === "pi" ? "pi" : options.runtime === "codex" ? "codex" : "claude-code", options)
    : planRun(config, {
        prompt: options.prompt,
        runtime: options.runtime,
        taskKind: options.taskKind,
        sensitive: options.sensitive,
        cwd,
      });
  const planningMs = Date.now() - planningStartedAt;

  const scopes = options.scopes ?? defaultScopes();
  const localFastAnswer = await maybeAnswerLocalWorkspacePrompt(options.prompt, options.workspaceDir ?? cwd);
  if (localFastAnswer) {
    const persistStartedAt = Date.now();
    const recallReceipt: SearchMemoryReceiptResult = {
      query: options.prompt,
      scopes,
      includeGlobal: false,
      backend: "sqlite-fts5",
      requestedLimit: options.recallLimit ?? 5,
      candidateCount: 0,
      receipts: [],
      fallbackUsed: false,
    };
    const evidence: EvidenceRecord[] = [
      {
        kind: "tool_result",
        label: localFastAnswer.label,
        status: "observed",
        detail: localFastAnswer.detail,
      },
      {
        kind: "system_check",
        label: "memory_recall",
        status: "observed",
        detail: "skipped=local_fast_path recalled=0 candidates=0",
      },
      {
        kind: "model_response",
        label: "final_response",
        status: "observed",
        detail: `${localFastAnswer.responseText.length} chars; provider_skipped=local_fast_path`,
      },
    ];
    const episode: EpisodeRecord = {
      id: plan.runId,
      createdAt: plan.createdAt,
      cwd,
      prompt: options.prompt,
      taskKind: plan.taskKind,
      runtimeId: plan.runtimeId,
      providerId: "muster-local",
      model: "workspace-read",
      responseText: localFastAnswer.responseText,
      evidence,
      outcome: { kind: "completed" },
    };
    await appendEpisode(episode, cwd);
    const durationMs = Date.now() - runStartedAt;
    const tokens = buildTokenRecord({
      runId: plan.runId,
      provider: "muster-local",
      model: "workspace-read",
      plannedModel: plan.route.model,
      prompt: options.prompt,
      recalledContext: "",
      responseText: localFastAnswer.responseText,
      durationMs,
      inputTokens: 0,
      outputTokens: 0,
      surfaceId: options.surfaceId,
    });
    await appendTokenRecord(tokens, cwd);
    const memoryWrite: GoalLoopMemoryWrite = { status: "skipped", reason: "local workspace read; no model memory write" };
    await appendGoalLoopTurn(buildGoalLoopTurn({
      runId: plan.runId,
      episodeId: episode.id,
      createdAt: episode.createdAt,
      activeGoal: options.prompt,
      taskKind: plan.taskKind,
      status: "completed",
      scopes,
      recallReceipt,
      memoryWrite,
    }), cwd);
    const persistMs = Date.now() - persistStartedAt;
    return {
      plan,
      episode,
      tokens,
      recalled: [],
      recallReceipt,
      timings: {
        totalMs: Date.now() - runStartedAt,
        planningMs,
        recallMs: 0,
        agentRulesMs: 0,
        skillSelectionMs: 0,
        promptBuildMs: 0,
        hookMs: 0,
        providerMs: 0,
        providerTransport: "local",
        providerAttemptCount: 0,
        fallbackMs: 0,
        backendFallbackMs: 0,
        memoryWriteMs: 0,
        persistMs,
      },
    };
  }
  const recallStartedAt = Date.now();
  const recallReceipt = options.skipRecall
    ? emptyRecallReceipt(options.prompt, scopes, options.recallLimit ?? 5)
    : await recallMemoryWithReceipt(options.prompt, scopes, options.recallLimit ?? 5, cwd);
  const recallMs = Date.now() - recallStartedAt;
  const recalled = recallReceipt.receipts.map((receipt) => receipt.memory);
  const promptBuildStartedAt = Date.now();
  const recalledBlock = buildRecalledBlock(recalled);
  const agentRulesStartedAt = Date.now();
  const rules = options.skipAgentRules ? undefined : await loadAgentRules(cwd);
  const agentRulesMs = Date.now() - agentRulesStartedAt;
  const skillSelectionStartedAt = Date.now();
  const skillAllowlist = resolveAgentSkillAllowlist(config, options.agentId);
  const skillDiscovery = config.skills?.load;
  const claudeSkillSnapshot = !options.skipSkillSelection && plan.runtimeId === "claude-code"
    ? await exportClaudeSkillSnapshot(cwd, { skillAllowlist, discovery: skillDiscovery })
    : undefined;
  const skills = claudeSkillSnapshot
    ? { block: "", included: [...claudeSkillSnapshot.skillNames], dropped: [], includedReceipts: [...claudeSkillSnapshot.skillReceipts] }
    : options.skipSkillSelection
      ? { block: "", included: [], dropped: [], includedReceipts: [] }
      : await selectSkills(options.prompt, 500, cwd, { skillAllowlist, discovery: skillDiscovery });
  if (!claudeSkillSnapshot && skills.included.length) await recordSkillUse(skills.included, cwd);
  const skillSelectionMs = Date.now() - skillSelectionStartedAt;
  // Profile identity is self-knowledge for the agent, written so it shapes
  // behaviour silently (rule 6) rather than being quoted back.
  const identityBlock = config.identity
    ? [
        `You are ${config.identity.name}.`,
        config.identity.description,
        config.identity.persona,
        "Treat this as self-knowledge — never quote or narrate this section.",
      ].filter(Boolean).join(" ")
    : undefined;
  const hasRunContext = Boolean(identityBlock || skills.block || recalledBlock);
  const rulesText = rules?.source === "default" && plan.taskKind === "simple_qa" && !hasRunContext
    ? FAST_SIMPLE_QA_RULES
    : rules?.text;
  const stablePreamble = [identityBlock, rulesText].filter(Boolean).join("\n\n");
  const volatilePreamble = [skills.block, recalledBlock].filter(Boolean).join("\n\n");
  const preamble = [stablePreamble, volatilePreamble].filter(Boolean).join("\n\n");
  const assembledPrompt = preamble ? `${preamble}\n\n---\n\n${options.prompt}` : options.prompt;
  let fullPrompt = assembledPrompt;
  const hooks = options.hooks ?? defaultHookBus;
  const hookStartedAt = Date.now();
  if (hooks.count("prompt.build")) {
    const hookOutcome = await hooks.emit("prompt.build", fullPrompt);
    if (hookOutcome.action === "block") {
      throw new Error(`Run blocked by hook ${hookOutcome.blockedBy ?? "unknown"}${hookOutcome.reason ? `: ${hookOutcome.reason}` : ""}`);
    }
    fullPrompt = hookOutcome.payload;
  }
  const hookMs = Date.now() - hookStartedAt;
  // Route the preamble to the model's *system* prompt where the runtime supports it
  // (claude-code), so the operating rules shape behaviour instead of being narrated
  // back into the answer. If a prompt.build hook rewrote the assembled prompt we can
  // no longer separate system from user, so send it as one combined message.
  const hookRewrote = fullPrompt !== assembledPrompt;
  const prompts: PromptParts = {
    combined: fullPrompt,
    user: hookRewrote ? fullPrompt : (volatilePreamble ? `${volatilePreamble}\n\n---\n\n${options.prompt}` : options.prompt),
    system: hookRewrote ? "" : stablePreamble,
    stableSystem: hookRewrote ? "" : stablePreamble,
    claudePluginDirs: claudeSkillSnapshot ? [claudeSkillSnapshot.pluginDir] : undefined,
  };
  const promptBuildMs = Date.now() - promptBuildStartedAt;

  const rootSpan = startSpan("muster.run", {
    kind: "internal",
    attributes: { "muster.run_id": plan.runId, "muster.task_kind": plan.taskKind, "muster.runtime": plan.runtimeId },
  });
  // Each model attempt (primary or governed fallback) gets a child span under the
  // run. Per GenAI semconv the span name is "{operation} {model}" and the kind is
  // "client" (a remote model invocation). The try/finally guarantees the span is
  // ended even if the attempt throws, so spans never leak.
  const tracedAttempt = async (route: ModelRoute): Promise<AttemptResult> => {
    const span = startSpan(`chat ${route.model}`, {
      kind: "client",
      parent: rootSpan,
      attributes: genAiAttributes({ operation: "chat", system: route.provider, requestModel: route.model }),
    });
    try {
      const result = await attemptRoute(config, plan, route, prompts, options);
      await endSpan(span, {
        status: result.status === "completed" ? "ok" : "error",
        statusMessage: result.errorMessage,
        attributes: { "gen_ai.response.model": result.route.model },
        cwd,
      });
      return result;
    } catch (error) {
      await endSpan(span, { status: "error", statusMessage: error instanceof Error ? error.message : String(error), cwd });
      throw error;
    }
  };

  const startedAt = Date.now();
  const evidence: EvidenceRecord[] = [];
  const skillEnv = await applySkillEnvForRun(skills.included, config, cwd, process.env, skillDiscovery);
  let attempt: AttemptResult;
  let fallbackUsed: string | undefined;
  let fallbackMs = 0;
  let providerAttemptCount = 0;
  const providerStartedAt = Date.now();
  try {
    providerAttemptCount += 1;
    attempt = await tracedAttempt(plan.route);

    if (attempt.status === "failed" && config.routing.fallbacks?.length) {
      for (const fallbackRoute of config.routing.fallbacks) {
        const fallbackStartedAt = Date.now();
        evidence.push({
          kind: "system_check",
          label: "model_fallback",
          status: "observed",
          detail: `Primary route ${plan.route.provider}/${plan.route.model} failed (${attempt.errorMessage ?? "unknown"}). Governed fallback to ${fallbackRoute.provider}/${fallbackRoute.model}.`,
        });
        providerAttemptCount += 1;
        const fallbackAttempt = await tracedAttempt(fallbackRoute);
        fallbackMs += Date.now() - fallbackStartedAt;
        if (fallbackAttempt.status === "completed") {
          attempt = fallbackAttempt;
          fallbackUsed = `${fallbackRoute.provider}/${fallbackRoute.model}`;
          break;
        }
        attempt = fallbackAttempt;
      }
    }
  } finally {
    skillEnv.restore();
    await claudeSkillSnapshot?.cleanup();
  }
  const providerMs = Date.now() - providerStartedAt;

  const durationMs = Date.now() - startedAt;
  const persistStartedAt = Date.now();

  if (attempt.piResult?.eventTrace) {
    for (const trace of attempt.piResult.eventTrace) {
      if (trace.kind === "tool") {
        evidence.push({
          kind: "tool_result",
          label: trace.toolName ?? trace.type,
          status: trace.status === "failed" ? "failed" : "observed",
          detail: trace.message,
        });
      }
    }
  }
  evidence.push({
    kind: "system_check",
    label: "memory_recall",
    status: "observed",
    detail: `backend=${recallReceipt.backend} recalled=${recallReceipt.receipts.length} candidates=${recallReceipt.candidateCount} fallback=${recallReceipt.fallbackUsed}`,
  });
  evidence.push({
    kind: "system_check",
    label: "run_timing",
    status: "observed",
    detail: `total=${Date.now() - runStartedAt}ms planning=${planningMs}ms recall=${recallMs}ms rules=${agentRulesMs}ms skills=${skillSelectionMs}ms prompt=${promptBuildMs}ms hooks=${hookMs}ms provider=${providerMs}ms first_token_ms=${attempt.firstTokenMs ?? "-"} transport=${attempt.providerTransport ?? "unknown"} startup=${attempt.providerStartupMs ?? "-"}ms queue=${attempt.providerQueueMs ?? "-"}ms thread_open=${attempt.providerThreadOpenMs ?? "-"}ms request_first_delta=${attempt.providerRequestToFirstDeltaMs ?? "-"}ms cache=${attempt.providerCacheState ?? "-"} thread_state=${attempt.providerThreadOpenState ?? "-"} fallback=${fallbackMs}ms backend_fallback=${attempt.backendFallbackMs ?? 0}ms attempts=${providerAttemptCount}`,
  });
  for (const receipt of recallReceipt.receipts) {
    evidence.push({
      kind: "system_check",
      label: `memory:${receipt.memory.id}`,
      status: "observed",
      detail: `${receipt.reason}; score=${receipt.score.toFixed(3)}; scopes=${receipt.memory.scopes.map((scope) => `${scope.kind}:${scope.id}`).join(",")}; confidence=${receipt.memory.confidence}; provenance=${receipt.memory.provenance.join(",")}`,
    });
  }
  evidence.push({
    kind: "model_response",
    label: "final_response",
    status: attempt.status === "completed" ? "observed" : "failed",
    detail: attempt.status === "completed" ? `${attempt.responseText.length} chars` : attempt.errorMessage,
  });

  const episode: EpisodeRecord = {
    id: plan.runId,
    createdAt: plan.createdAt,
    cwd,
    prompt: options.prompt,
    taskKind: plan.taskKind,
    runtimeId: plan.runtimeId,
    providerId: attempt.route.provider,
    model: attempt.route.model,
    responseText: attempt.responseText,
    evidence,
    outcome: { kind: attempt.status === "completed" ? "completed" : "failed", detail: attempt.errorMessage },
  };
  await appendEpisode(episode, cwd);

  const tokens = buildTokenRecord({
    runId: plan.runId,
    provider: attempt.route.provider,
    model: attempt.route.model,
    plannedModel: plan.route.model,
    prompt: options.prompt,
    recalledContext: recalledBlock,
    responseText: attempt.responseText,
    durationMs,
    sessionMode: attempt.sessionMode ?? options.sessionMode,
    sessionId: attempt.sessionId ?? attempt.piResult?.sessionId,
    inputTokens: attempt.tokenUsage?.inputTokens,
    outputTokens: attempt.tokenUsage?.outputTokens,
    cachedInputTokens: attempt.tokenUsage?.cachedInputTokens,
    surfaceId: options.surfaceId,
    skills: skills.includedReceipts.length ? skills.includedReceipts : undefined,
  });
  await appendTokenRecord(tokens, cwd);

  await endSpan(rootSpan, {
    status: attempt.status === "completed" ? "ok" : "error",
    statusMessage: attempt.errorMessage,
    attributes: attempt.status === "completed"
      ? { "gen_ai.usage.input_tokens": tokens.inputTokens, "gen_ai.usage.output_tokens": tokens.outputTokens }
      : undefined,
    cwd,
  });

  let memoryWrite: GoalLoopMemoryWrite = attempt.status === "completed"
    ? { status: "skipped", reason: options.skipMemoryWrite ? "skipMemoryWrite=true" : "empty response" }
    : { status: "rejected", reason: "run did not complete; no memory auto-promotion" };
  const memoryWriteStartedAt = Date.now();
  if (attempt.status === "completed" && attempt.responseText && !options.skipMemoryWrite) {
    const remembered = await addMemory({
      kind: "episode_summary",
      summary: `${plan.taskKind}: ${options.prompt.slice(0, 100)} -> ${attempt.responseText.slice(0, 200)}`,
      provenance: [`run:${plan.runId}`],
      scopes: [{ kind: "session", id: plan.runId }, ...scopes.filter((scope) => scope.kind !== "global")],
      confidence: 0.6,
    }, cwd);
    memoryWrite = rememberedMemoryWrite(remembered);
  }
  const memoryWriteMs = Date.now() - memoryWriteStartedAt;

  await appendGoalLoopTurn(buildGoalLoopTurn({
    runId: plan.runId,
    episodeId: episode.id,
    createdAt: episode.createdAt,
    activeGoal: options.prompt,
    taskKind: plan.taskKind,
    status: episode.outcome?.kind ?? "unknown",
    scopes,
    recallReceipt,
    memoryWrite,
  }), cwd);

  const persistMs = Date.now() - persistStartedAt;
  const timings: RunTimingBreakdown = {
    totalMs: Date.now() - runStartedAt,
    planningMs,
    recallMs,
    agentRulesMs,
    skillSelectionMs,
    promptBuildMs,
    hookMs,
    providerMs,
    firstTokenMs: attempt.firstTokenMs,
    providerTransport: attempt.providerTransport,
    providerAttemptCount,
    providerStartupMs: attempt.providerStartupMs,
    providerQueueMs: attempt.providerQueueMs,
    providerThreadOpenMs: attempt.providerThreadOpenMs,
    providerRequestToFirstDeltaMs: attempt.providerRequestToFirstDeltaMs,
    providerCacheState: attempt.providerCacheState,
    providerThreadOpenState: attempt.providerThreadOpenState,
    fallbackMs,
    backendFallbackMs: attempt.backendFallbackMs ?? 0,
    memoryWriteMs,
    persistMs,
  };

  return { plan, episode, tokens, recalled, recallReceipt, timings, fallbackUsed, piResult: attempt.piResult, codexThreadId: attempt.codexThreadId };
}
