import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { access, readFile, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { activeProfile, createArtifactWorkspace, createEnterpriseActionReceipt, createStreamEventChannel, dataDir, estimateTokens, executeRun, extractMediaTags, getFlowRun, persistArtifact, profileWorkspaceDir, resolveAgentSkillAllowlist, resolveSkillCommand, resumeFlow, runDraftLoop, StreamRun, updateArtifactDelivery } from "@musterhq/core";
import type { ArtifactDeliveryReceipt, ArtifactResult, ArtifactWorkspace } from "@musterhq/core";
import type { DraftSink, FlowToolRegistry, MusterConfig } from "@musterhq/core";
import { dispatchCommand, gatewayAgentCatalog, gatewayCommandCatalog, parseCommand, resolveCustomCommand } from "./commands.js";
import { conversationSessionId, isPairingChallenge, parseSurfaceMessage } from "./envelope.js";
import type { PairingChallenge, SurfaceArtifact, SurfaceMessage, SurfaceReply } from "./envelope.js";
import { pairingScopes, requestPairing, resolvePairing } from "./pairing.js";
import type { PairedSender } from "./pairing.js";
import { googleChatAudienceIsValid, type GatewayConfig, type GatewayGovernanceAssignment } from "./gateway-config.js";
import {
  classifyGatewayRequest,
  enforceGatewayRateLimits,
  openSqliteGatewayEnterpriseRuntime,
  recordGatewayUsage,
  resolveGatewayGovernanceAssignment,
  type GatewayEnterpriseRuntime,
} from "./enterprise-runtime.js";
import { surfaceReplyToTelegramSend, telegramCallbackQueryId, telegramUpdateToSurfaceMessage } from "./adapters/telegram.js";
import { slackDeliveryId, slackEventToSurfaceMessage, slackSignatureIsValid, surfaceReplyToSlackPost } from "./adapters/slack.js";
import { DISCORD_PONG, discordInteractionToInbound, discordSignatureIsValid, surfaceReplyToDiscordInteractionResponse } from "./adapters/discord.js";
import { surfaceReplyToWhatsAppSend, whatsAppMessageIds, whatsAppVerifyChallenge, whatsAppWebhookToSurfaceMessages } from "./adapters/whatsapp.js";
import { gchatDeliveryId, gchatEventToken, gchatEventToSurfaceMessage, surfaceReplyToGchatResponse } from "./adapters/gchat.js";
import type { GchatRequestVerifier } from "./adapters/gchat.js";
import { createGoogleChatRequestVerifier } from "./google-chat-verifier.js";
import { surfaceReplyToTeamsActivity, teamsActivityToSurfaceMessage, teamsHmacIsValid } from "./adapters/teams.js";
import { createOutboundQueue, createSlackDraftSink, createTelegramDraftSink } from "./streaming.js";
import type { OutboundQueue } from "./streaming.js";
import {
  createGatewayIngressFingerprint,
  createGatewaySafeResultRef,
  DurableGatewayIngress,
  type GatewayIngressIdentity,
  type GatewayIngressOwnership,
} from "./durable-ingress.js";
import { createApprovalActionCodec, pendingApprovalFromRaw, verifiedApprovalFromRaw, type ApprovalActionBinding, type ApprovalActionCodec, type ApprovalActionRenderContext, type ApprovalDecision } from "./presentation.js";
import { SqliteApprovalActionStore } from "./approval-store.js";
import {
  DurableGatewayIngressSpool,
  spoolOwnerIsDeadOnThisHost,
  type GatewayAsyncAdapterId,
  type GatewayIngressSpoolEntry,
  type GatewayPreparedDelivery,
} from "./ingress-spool.js";

/** HTTP gateway plus channel-specific polling/socket workers. */

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
  /** Injectable distributed enterprise stores. Defaults to a durable local SQLite runtime. */
  readonly enterprise?: GatewayEnterpriseRuntime;
  /** Durable pre-execution ingress claims. Derived from enterprise.idempotencyStore by default. */
  readonly ingress?: DurableGatewayIngress;
  /** Local write-ahead payload spool for adapters acknowledged before provider work. */
  readonly ingressSpool?: DurableGatewayIngressSpool;
  readonly approvalActions?: ApprovalActionCodec;
  readonly approvalStore?: SqliteApprovalActionStore;
}

export interface RunningGateway {
  readonly port: number;
  readonly server: Server;
  /** Wait until accepted background webhook work has finished. */
  waitForIdle(): Promise<void>;
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

function maybeAddChannelArtifactInstructions(text: string): string {
  if (!ARTIFACT_REQUEST_RE.test(text) || /\bMEDIA\s*:/i.test(text)) return text;
  return [
    text,
    "",
    "Muster channel artifact delivery rules:",
    "- First satisfy the user's actual document/content request. Do not make this delivery checklist the artifact content.",
    "- If you create a file, create it under ./artifacts/ in the current workspace unless the user asks otherwise.",
    "- Prefer the installed `muster artifacts create` command for docx, xlsx, pptx, or pdf when it fits the request; otherwise create a reasonable local file directly.",
    "- End the final response with one `MEDIA:<local-path>` line for each generated file so Slack, Telegram, and other channels can verify and attach it. Remote URLs require a separately authenticated artifact host.",
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

async function resolveSurfaceArtifactRef(ref: string, workspaceDir: string): Promise<SurfaceArtifact | undefined> {
  if (isHttpArtifact(ref)) return undefined;
  const workspaceRoot = await realpath(workspaceDir).catch(() => resolve(workspaceDir));
  const candidate = isAbsolute(ref) ? resolve(ref) : resolve(workspaceRoot, ref);
  if (!insideDirectory(workspaceRoot, candidate)) return undefined;
  const canonical = await realpath(candidate).catch(() => undefined);
  if (!canonical || !insideDirectory(workspaceRoot, canonical) || !await readableFile(canonical)) return undefined;
  return { name: basename(canonical), mime: artifactMime(canonical), path: canonical };
}

function insideDirectory(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function extractArtifactPathRefs(text: string): string[] {
  const refs: string[] = [];
  for (const match of text.matchAll(ARTIFACT_REF_RE)) {
    const ref = match[1]?.replace(/[.,;:]+$/, "");
    if (ref) refs.push(ref);
  }
  return [...new Set(refs)];
}

interface ChannelArtifactScope {
  readonly tenantId: string;
  readonly runId: string;
  readonly sourceChannel: string;
  readonly sourcePrompt: string;
  readonly providerId?: string;
  readonly model?: string;
  readonly tokenLedgerId?: string;
}

interface PersistedChannelArtifact {
  readonly workspace: ArtifactWorkspace;
  readonly artifactId: string;
}

const persistedChannelArtifacts = new WeakMap<SurfaceArtifact, PersistedChannelArtifact>();

async function markChannelArtifactDelivery(
  artifact: SurfaceArtifact,
  delivery: Partial<ArtifactDeliveryReceipt>,
): Promise<void> {
  const persisted = persistedChannelArtifacts.get(artifact);
  if (!persisted) return;
  await updateArtifactDelivery(persisted.workspace, persisted.artifactId, delivery);
}

async function resolveChannelArtifacts(
  text: string,
  extractedRefs: string[],
  workspaceDir: string,
  cwd: string,
  scope: ChannelArtifactScope,
): Promise<SurfaceArtifact[]> {
  const refs = [...extractedRefs, ...extractArtifactPathRefs(text)];
  const declared = (await Promise.all([...new Set(refs)].map((ref) => resolveSurfaceArtifactRef(ref, workspaceDir))))
    .filter((artifact): artifact is SurfaceArtifact => Boolean(artifact));
  const supported = declared.filter((artifact) =>
    !isHttpArtifact(artifact.path) && /\.(?:docx|xlsx|pptx|pdf)$/i.test(artifact.name)
  );
  if (!supported.length) return declared;
  const artifactWorkspace = await createArtifactWorkspace({
    rootDir: join(dataDir(cwd), "artifacts"),
    tenantId: scope.tenantId,
    runId: scope.runId,
  });
  const hardened = new Map<string, SurfaceArtifact>();
  const blocked = new Set<string>();
  for (const [index, artifact] of supported.entries()) {
    const bytes = await readFile(artifact.path);
    const format = extname(artifact.name).slice(1).toLowerCase() as ArtifactResult["format"];
    const result: ArtifactResult = {
      filename: artifact.name,
      mimeType: artifact.mime,
      format,
      bytes: bytes.length,
      base64: bytes.toString("base64"),
    };
    const persisted = await persistArtifact({
      workspace: artifactWorkspace,
      artifact: result,
      artifactId: `channel-${index + 1}-${createHash("sha256").update(artifact.name).update(bytes).digest("hex").slice(0, 12)}`,
      title: artifact.name.replace(/\.[^.]+$/, ""),
      sourceChannel: scope.sourceChannel,
      sourcePrompt: scope.sourcePrompt,
      providerId: scope.providerId,
      model: scope.model,
      providerRunId: scope.runId,
      tokenLedgerId: scope.tokenLedgerId,
      generationMode: "provider",
      delivery: { state: "local-only", channel: scope.sourceChannel, reason: "Awaiting verified channel upload." },
    });
    if (persisted.entry.verification.status !== "passed") {
      blocked.add(artifact.path);
      continue;
    }
    const hardenedArtifact = { ...artifact, path: persisted.declaration.localPath! };
    persistedChannelArtifacts.set(hardenedArtifact, { workspace: artifactWorkspace, artifactId: persisted.entry.artifactId });
    hardened.set(artifact.path, hardenedArtifact);
  }
  return declared.flatMap((artifact) => blocked.has(artifact.path) ? [] : [hardened.get(artifact.path) ?? artifact]);
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bxox[baprs]-[A-Za-z0-9-]+/i, "Slack token"],
  [/\bxapp-[A-Za-z0-9-]+/i, "Slack app token"],
  [/\b(?:sk|sk-proj)-[A-Za-z0-9_-]{16,}/i, "API key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/i, "secret assignment"],
];

interface GatewayPreflight {
  readonly reply?: SurfaceReply;
  readonly policyIds: readonly string[];
}

async function gatewayGovernancePreflight(
  message: SurfaceMessage,
  paired: PairedSender,
  assignment: GatewayGovernanceAssignment,
  gateway: Pick<GatewayConfig, "governance"> | undefined,
  enterprise: GatewayEnterpriseRuntime | undefined,
): Promise<GatewayPreflight> {
  const governance = gateway?.governance;
  if (!governance?.enabled) return { policyIds: [] };
  const validation = governance.requestValidation;
  const maxChars = validation?.maxChars ?? 16_000;
  if (message.text.length > maxChars) {
    return { reply: governanceBlock(`Request rejected by validation: message is ${message.text.length} characters, limit is ${maxChars}.`), policyIds: [] };
  }
  if (validation?.blockSecrets ?? true) {
    for (const [pattern, label] of SECRET_PATTERNS) {
      if (pattern.test(message.text)) return { reply: governanceBlock(`Request rejected by validation: possible ${label} detected. Remove secrets and use configured credentials instead.`), policyIds: [] };
    }
  }
  for (const patternSource of validation?.blockedPatterns ?? []) {
    const pattern = safeRegex(patternSource);
    if (pattern?.test(message.text)) return { reply: governanceBlock("Request rejected by validation: matched blocked policy pattern."), policyIds: [] };
  }
  if (assignment.allowedSurfaces?.length && !assignment.allowedSurfaces.includes(message.surfaceId)) {
    return { reply: governanceBlock(`Request blocked by RBAC: this user is not allowed to use surface ${message.surfaceId}.`), policyIds: [] };
  }
  const channelId = governanceChannelId(message);
  if (assignment.allowedChannels?.length && !assignment.allowedChannels.includes(channelId) && !assignment.allowedChannels.includes(message.conversationId)) {
    return { reply: governanceBlock(`Request blocked by RBAC: this user is not allowed to use channel ${channelId}.`), policyIds: [] };
  }
  if (!enterprise) {
    return { reply: governanceBlock("Enterprise governance is enabled but no atomic runtime store is available."), policyIds: [] };
  }
  const estimatedTokens = estimateTokens(message.text) + Math.max(0, Math.floor(governance.estimatedOutputTokens ?? 800));
  const rate = await enforceGatewayRateLimits({
    runtime: enterprise,
    gateway: { governance },
    message,
    paired,
    assignment,
    estimatedTokens,
  });
  return { ...(rate.blocked ? { reply: governanceBlock(rate.blocked) } : {}), policyIds: rate.policyIds };
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

function governanceBlock(text: string): SurfaceReply {
  return {
    text: [
      text,
      "No provider call was made.",
    ].join("\n"),
  };
}

async function executeVerifiedApproval(
  binding: ApprovalActionBinding,
  decision: ApprovalDecision,
  input: {
    readonly config: MusterConfig;
    readonly cwd: string;
    readonly registry?: FlowToolRegistry;
    readonly store?: SqliteApprovalActionStore;
    readonly enterprise?: GatewayEnterpriseRuntime;
    readonly executionOwner?: string;
    readonly executionClaimed?: boolean;
  },
): Promise<SurfaceReply> {
  const executionOwner = input.executionOwner ?? randomUUID();
  if (input.store && !input.executionClaimed && !input.store.claimExecution(binding.id, executionOwner, Date.now(), 15 * 60_000)) {
    return { text: "This approval is already being applied by another gateway worker." };
  }
  try {
    const paired = await resolvePairing(binding.surfaceId, binding.actorId, input.cwd);
    if (!paired) throw new Error("The approving sender is no longer paired.");
    const state = await getFlowRun(binding.runId, input.cwd);
    const gate = state.pendingGate;
    if (state.status !== "awaiting_approval" || !gate || gate.stepId !== binding.gateId) {
      throw new Error("The approval gate is no longer current.");
    }
    if (approvalRevision(binding.runId, binding.gateId, gate.show) !== binding.revision) {
      throw new Error("The approval content changed after this control was issued.");
    }
    const result = await resumeFlow(binding.runId, {
      approve: decision === "approve",
      config: input.config,
      registry: input.registry ?? defaultRegistry(),
      cwd: input.cwd,
    });
    input.store?.markExecution(binding.id, "completed", `${decision}:${result.status}`, executionOwner);
    const auditWarning = await recordApprovalReceipt(input.enterprise, binding, decision, "completed");
    return {
      text: `${decision === "approve"
        ? `Approval accepted. Run ${result.runId} is ${result.status}.`
        : `Approval rejected. Run ${result.runId} is ${result.status}.`}${auditWarning ? `\nAudit warning: ${auditWarning}` : ""}`,
      ...(result.status === "awaiting_approval" && result.gateId ? {
        approvalRequest: { runId: result.runId, gateId: result.gateId, show: result.show, options: ["approve", "reject"] as const },
      } : {}),
    };
  } catch (error) {
    input.store?.markExecution(binding.id, "failed", error instanceof Error ? error.message : String(error), executionOwner);
    const auditWarning = await recordApprovalReceipt(input.enterprise, binding, decision, "failed");
    return { text: `Approval could not be applied: ${error instanceof Error ? error.message : String(error)}${auditWarning ? `\nAudit warning: ${auditWarning}` : ""}` };
  }
}

async function recordApprovalReceipt(
  enterprise: GatewayEnterpriseRuntime | undefined,
  binding: ApprovalActionBinding,
  decision: ApprovalDecision,
  outcome: "completed" | "failed",
): Promise<string | undefined> {
  if (!enterprise) return undefined;
  try {
    const actor = [
      { kind: "channel" as const, id: `${binding.surfaceId}:${binding.conversationId}` },
      { kind: "user" as const, id: binding.actorId },
    ];
    await enterprise.receiptStore.appendReceipt(createEnterpriseActionReceipt({
      actor,
      target: actor,
      action: `approval.${decision}`,
      outcome,
      policyIds: [`gate:${binding.gateId}`],
      requestFingerprint: createHash("sha256").update(JSON.stringify([binding.runId, binding.gateId, binding.revision])).digest("hex"),
      metadata: { run_id: binding.runId, gate_id: binding.gateId, approval_id: binding.id },
    }));
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function approvalRevision(runId: string, gateId: string, show: unknown): string {
  return createHash("sha256").update(JSON.stringify([runId, gateId, show])).digest("hex");
}

async function recoverPendingApprovals(options: GatewayServerOptions, store: SqliteApprovalActionStore): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  for (;;) {
    const owner = `recovery:${process.pid}:${randomUUID()}`;
    const pendingBatch = store.claimPending(owner, Date.now(), 15 * 60_000, 100);
    if (!pendingBatch.length) return;
    for (const pending of pendingBatch) {
      const reply = await executeVerifiedApproval(pending.binding, pending.decision, {
        config: options.config,
        cwd,
        registry: options.registry,
        store,
        enterprise: options.enterprise,
        executionOwner: pending.executionOwner ?? owner,
        executionClaimed: true,
      });
      options.log?.(`approval recovery id=${pending.binding.id} result=${reply.text}`);
    }
  }
}

export async function handleSurfaceMessage(
  message: SurfaceMessage,
  options: Pick<GatewayServerOptions, "config" | "cwd"> & {
    readonly gateway?: GatewayConfig;
    readonly enterprise?: GatewayEnterpriseRuntime;
    readonly approvalStore?: SqliteApprovalActionStore;
    readonly approvalActions?: ApprovalActionCodec;
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
  const assignment = resolveGatewayGovernanceAssignment(options.gateway, message, paired.pairingId);
  const pendingApproval = pendingApprovalFromRaw(message.raw);
  if (pendingApproval) {
    if (!options.approvalActions) return { text: "Approval could not be verified: approval controls are unavailable." };
    const parsed = options.approvalActions.parse(pendingApproval.value, pendingApproval.attempt);
    if (!parsed.ok) return { text: `Approval could not be verified: ${parsed.reason.replaceAll("_", " ")}.` };
    return executeVerifiedApproval(parsed.binding, parsed.decision, {
      config: options.config,
      cwd,
      registry: options.registry,
      store: options.approvalStore,
      enterprise: options.enterprise,
    });
  }
  const verifiedApproval = verifiedApprovalFromRaw(message.raw);
  if (verifiedApproval) {
    return executeVerifiedApproval(verifiedApproval.binding, verifiedApproval.decision, {
      config: options.config,
      cwd,
      registry: options.registry,
      store: options.approvalStore,
      enterprise: options.enterprise,
    });
  }
  const command = await dispatchCommand(message, {
    config: options.config,
    profile,
    paired,
    gateway: options.gateway,
    enterprise: options.enterprise,
    cwd,
    conversationKey: sessionKey,
    legacyConversationKey: `${message.surfaceId}:${message.conversationId}`,
  });
  if (command) return command;
  const preflight = await gatewayGovernancePreflight(message, paired, assignment, options.gateway, options.enterprise);
  if (preflight.reply) {
    if (options.enterprise) {
      await recordGatewayUsage(options.enterprise, {
        message,
        paired,
        assignment,
        outcome: "blocked",
        latencyMs: 0,
        inputTokens: estimateTokens(message.text),
        action: "gateway.run",
        policyIds: preflight.policyIds,
      });
    }
    return preflight.reply;
  }
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
    const artifactRequested = ARTIFACT_REQUEST_RE.test(message.text);
    const artifacts = await resolveChannelArtifacts(
      outcome.episode.responseText,
      extracted.media.map((item) => item.ref),
      workspaceDir,
      cwd,
      {
        tenantId: assignment.tenantId ?? (paired.identity?.provider === "frappe" ? paired.identity.site : paired.pairingId),
        runId: outcome.tokens.runId,
        sourceChannel: message.surfaceId,
        sourcePrompt: message.text,
        providerId: outcome.tokens.provider,
        model: outcome.tokens.model,
        tokenLedgerId: outcome.tokens.runId,
      },
    );
    const finalText = artifactRequested && !artifacts.length
      ? `${extracted.text}\n\nArtifact delivery failed: the provider did not declare a verifiable file path for this run.`
      : extracted.text;
    // finalize() is the only emitter of the final event (OpenClaw #33492).
    streamRun?.finalize(finalText);
    if (options.enterprise) {
      await recordGatewayUsage(options.enterprise, {
        message,
        paired,
        assignment,
        outcome: "success",
        latencyMs: outcome.timings?.totalMs ?? Date.now() - startedAt,
        tokens: outcome.tokens,
        requestCategory: classifyGatewayRequest(message.text),
        action: "gateway.run",
        policyIds: preflight.policyIds,
      });
    }
    return {
      text: finalText,
      ...(artifacts.length
        ? { artifacts }
        : {}),
    };
  } catch (error) {
    if (options.enterprise) {
      await recordGatewayUsage(options.enterprise, {
        message,
        paired,
        assignment,
        outcome: "error",
        latencyMs: Date.now() - startedAt,
        inputTokens: estimateTokens(message.text),
        requestCategory: classifyGatewayRequest(message.text),
        action: "gateway.run",
        policyIds: preflight.policyIds,
      });
    }
    throw error;
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
  readonly enterprise?: GatewayEnterpriseRuntime;
  readonly approvalActions?: ApprovalActionCodec;
  readonly approvalStore?: SqliteApprovalActionStore;
  /** The HTTP route already verified the platform signature against the raw body. */
  readonly platformVerified?: boolean;
  /** Durable execution/delivery checkpoints for adapters acknowledged before work completes. */
  readonly durableDelivery?: DurableAdapterDeliveryHooks;
}

interface DurableAdapterDeliveryHooks {
  checkpoint(preparedDeliveries: readonly GatewayPreparedDelivery[]): Promise<void>;
  begin(): Promise<void>;
  delivered(): Promise<void>;
}

function approvalRenderContext(
  reply: SurfaceReply | PairingChallenge,
  message: SurfaceMessage | undefined,
  context: AdapterContext,
): ApprovalActionRenderContext | undefined {
  if (!message || isPairingChallenge(reply) || !reply.approvalRequest || !context.approvalActions) return undefined;
  const ttlSeconds = Math.min(3600, Math.max(60, context.gateway.approvals?.ttlSeconds ?? 600));
  return {
    codec: context.approvalActions,
    actorId: message.senderId,
    surfaceId: message.surfaceId,
    conversationId: message.conversationId,
    runId: reply.approvalRequest.runId,
    gateId: reply.approvalRequest.gateId,
    revision: approvalRevision(reply.approvalRequest.runId, reply.approvalRequest.gateId, reply.approvalRequest.show),
    expiresAt: Date.now() + ttlSeconds * 1000,
  };
}

function conversationLane(message: Pick<SurfaceMessage, "surfaceId" | "conversationId" | "senderId">): string {
  return conversationSessionId(message);
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
  activeConversationRuns.set(key, run);
  const clearLane = () => {
    if (activeConversationRuns.get(key) === run) activeConversationRuns.delete(key);
  };
  void run.then(clearLane, clearLane);
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
    const body = await response.json().catch(() => ({})) as { ok?: boolean; description?: string; result?: { message_id?: number } };
    if (!response.ok || body.ok !== true || typeof body.result?.message_id !== "number") {
      throw new Error(`HTTP ${response.status}${body.description ? ` ${body.description}` : ""}; Telegram did not return an accepted message id`);
    }
    await markChannelArtifactDelivery(artifact, {
      state: "uploaded",
      channel: "telegram",
      target: chatId,
      providerMessageId: String(body.result.message_id),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    context.log(`telegram artifact delivery failed for ${artifact.path}: ${detail}`);
    await markChannelArtifactDelivery(artifact, { state: "failed", channel: "telegram", target: chatId, reason: detail })
      .catch((receiptError) => context.log(`telegram artifact receipt failed: ${receiptError instanceof Error ? receiptError.message : String(receiptError)}`));
    await sendTelegramPayload(botToken, {
      chat_id: chatId,
      text: `I created ${artifactCaption(artifact)}, but this gateway could not attach it. Check the artifact delivery receipt and retry.`,
    }, context);
  }
}

async function deliverTelegramReply(botToken: string, reply: SurfaceReply | PairingChallenge, chatId: string, context: AdapterContext, source?: SurfaceMessage): Promise<void> {
  const delivered = await sendTelegramPayload(botToken, surfaceReplyToTelegramSend(reply, chatId, { approvalAction: approvalRenderContext(reply, source, context) }), context);
  if (!channelApiSucceeded(delivered)) throw new DefinitivePlatformDeliveryError("Telegram did not acknowledge the final reply.");
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
  return typeof result === "object" && result !== null && (result as { ok?: unknown }).ok === true;
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
  const failed = async (detail: string): Promise<{ ok: false; detail: string }> => {
    await markChannelArtifactDelivery(artifact, { state: "failed", channel: "slack", target: channel, reason: detail })
      .catch((error) => context.log(`slack artifact receipt failed: ${error instanceof Error ? error.message : String(error)}`));
    return { ok: false, detail };
  };
  let bytes: Buffer;
  try {
    bytes = await readFile(artifact.path);
  } catch (error) {
    return failed(`• ${artifactCaption(artifact)} could not be read from its scoped artifact workspace: ${error instanceof Error ? error.message : String(error)}`);
  }
  const filename = artifactCaption(artifact);
  const uploadUrlResponse = await sendSlackFormPayload(botToken, {
    filename,
    length: String(bytes.byteLength),
  }, context, "files.getUploadURLExternal");
  if (uploadUrlResponse.ok === false || typeof uploadUrlResponse.upload_url !== "string" || typeof uploadUrlResponse.file_id !== "string") {
    return failed(slackUploadFailureMessage(typeof uploadUrlResponse.error === "string" ? uploadUrlResponse.error : undefined, artifact));
  }
  const uploadBody = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const uploadResponse = await context.fetcher(uploadUrlResponse.upload_url, {
    method: "POST",
    headers: { "content-type": artifact.mime || "application/octet-stream" },
    body: uploadBody,
  });
  if (!uploadResponse.ok) {
    return failed(`Slack upload failed for ${filename}: HTTP ${uploadResponse.status}.`);
  }
  const completeResponse = await sendSlackFormPayload(botToken, {
    channel_id: channel,
    initial_comment: `Artifact from this run: ${filename}`,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    files: JSON.stringify([{ id: uploadUrlResponse.file_id, title: filename }]),
  }, context, "files.completeUploadExternal");
  if (completeResponse.ok !== true) {
    return failed(slackUploadFailureMessage(typeof completeResponse.error === "string" ? completeResponse.error : undefined, artifact));
  }
  try {
    await markChannelArtifactDelivery(artifact, {
      state: "uploaded",
      channel: "slack",
      target: channel,
      providerMessageId: uploadUrlResponse.file_id,
    });
  } catch (error) {
    context.log(`Slack uploaded ${filename}, but its delivery receipt could not be persisted: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: true };
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

async function deliverSlackReply(botToken: string, reply: SurfaceReply | PairingChallenge, channel: string, threadTs: string | undefined, context: AdapterContext, source?: SurfaceMessage): Promise<void> {
  const delivered = await sendSlackPayload(botToken, surfaceReplyToSlackPost(reply, channel, threadTs, { approvalAction: approvalRenderContext(reply, source, context) }), context);
  if (!channelApiSucceeded(delivered)) throw new DefinitivePlatformDeliveryError("Slack did not acknowledge the final reply.");
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
  if (secretToken && !context.platformVerified) {
    const presented = context.headers["x-telegram-bot-api-secret-token"];
    if (!headerEquals(typeof presented === "string" ? presented : undefined, secretToken)) {
      throw new GatewayHttpError(401, "Telegram secret token mismatch.");
    }
  } else if (!secretToken) {
    warnUnauthenticatedOnce("telegram", context.log);
  }
  const payload = JSON.parse(body);
  const callbackQueryId = telegramCallbackQueryId(payload);
  if (callbackQueryId) await sendTelegramPayload(botToken, { callback_query_id: callbackQueryId }, context, "answerCallbackQuery");
  const deliveryKey = adapterDeliveryKey("telegram", body);
  const cached = deliveryLookup(deliveryKey);
  if (cached !== undefined) return cached;
  const mapped = telegramUpdateToSurfaceMessage(payload, { approvalActions: context.approvalActions });
  if (!mapped) return { ok: true, ignored: "not a text message update" };
  if (context.gateway.telegram?.stream === "draft") {
    const message: SurfaceMessage = { ...mapped, stream: "draft" };
    const channelSink = createTelegramDraftSink({
      botToken,
      chatId: message.conversationId,
      fetcher: context.fetcher,
      queue: context.queue,
    });
    let durableDraftDelivered = false;
    const sink: DraftSink = context.durableDelivery ? {
      ...channelSink,
      finalize: async (text) => {
        await context.durableDelivery?.checkpoint([{ message, reply: { text } }]);
        await context.durableDelivery?.begin();
        await channelSink.finalize(text);
        await context.durableDelivery?.delivered();
        durableDraftDelivered = true;
      },
    } : channelSink;
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
    if (!isPairingChallenge(reply) && durableDraftDelivered) {
      for (const artifact of reply.artifacts ?? []) await sendTelegramArtifact(botToken, artifact, message.conversationId, context);
      const result = { ok: true, streamed: true };
      deliveryStore(deliveryKey, result);
      return result;
    }
    if (context.durableDelivery && !durableDraftDelivered) {
      await context.durableDelivery.checkpoint([{ message, reply }]);
      await context.durableDelivery.begin();
    }
    await deliverTelegramReply(botToken, reply, message.conversationId, context, message);
    if (context.durableDelivery && !durableDraftDelivered) await context.durableDelivery.delivered();
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
  let durableDeliveryBegan = false;
  try {
    progress = await startTelegramProgress(botToken, message, context);
    reply = await withConversationLane(message, context, context.gateway.telegram?.busy ?? "queue", () => handleSurfaceMessage(message, context));
    if (context.durableDelivery) await context.durableDelivery.checkpoint([{ message, reply }]);
    if (context.durableDelivery && !isPairingChallenge(reply) && !reply.approvalRequest) {
      await context.durableDelivery.begin();
      durableDeliveryBegan = true;
    }
    progressFinal = await progress.stop(!isPairingChallenge(reply) && !reply.approvalRequest ? reply.text : undefined);
  } catch (error) {
    await progress.stop("! Failed");
    throw error;
  } finally {
    stopTyping();
  }
  if (context.durableDelivery && !durableDeliveryBegan) await context.durableDelivery.begin();
  if (isPairingChallenge(reply) || reply.approvalRequest || progressFinal !== "updated") {
    await deliverTelegramReply(botToken, reply, message.conversationId, context, message);
  } else {
    await deliverTelegramArtifactsOnly(botToken, reply, message.conversationId, context);
  }
  if (context.durableDelivery) await context.durableDelivery.delivered();
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
  readonly enterprise?: GatewayEnterpriseRuntime;
  readonly ingress?: DurableGatewayIngress;
  readonly ingressSpool?: DurableGatewayIngressSpool;
  readonly approvalActions?: ApprovalActionCodec;
  readonly approvalStore?: SqliteApprovalActionStore;
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
  const ownsApprovalStore = options.approvalStore === undefined;
  const approvalStore = options.approvalStore ?? new SqliteApprovalActionStore(join(dataDir(cwd), "enterprise-control-plane.db"));
  const approvalActions = options.approvalActions ?? createApprovalActionCodec({
    secret: createHash("sha256").update(`muster-approval:${options.gateway.token}`).digest(),
    store: approvalStore,
  });
  const ownsEnterpriseRuntime = options.enterprise === undefined;
  const enterprise = options.enterprise ?? openSqliteGatewayEnterpriseRuntime(cwd);
  const ingress = options.ingress ?? new DurableGatewayIngress(enterprise.idempotencyStore, { defaultLeaseMs: 15 * 60_000 });
  const ingressSpool = options.ingressSpool ?? new DurableGatewayIngressSpool(
    join(dataDir(cwd), "gateway-ingress-spool"),
    createHash("sha256").update(`muster-ingress-spool:${options.gateway.token}`).digest(),
  );
  const queue = createOutboundQueue();
  await recoverIngressSpool({
    ...options,
    cwd,
    enterprise,
    ingress,
    ingressSpool,
    approvalActions,
    approvalStore,
  }, queue, ingressSpool);
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
      if (updateId > 0 && updateId < persistedOffset) {
        offset = Math.max(offset, persistedOffset);
        continue;
      }
      const body = JSON.stringify(update);
      const deliveryId = adapterDeliveryKey("telegram", body);
      if (!deliveryId) {
        log("telegram update has no durable update id; it was not acknowledged");
        break;
      }
      const identity: GatewayIngressIdentity = {
        scope: "adapter:telegram",
        deliveryId,
        fingerprint: createGatewayIngressFingerprint(["telegram", deliveryId, body]),
      };
      try {
        const claim = await ingress.claim(identity);
        if (claim.status === "conflict") {
          log(`telegram update ${updateId} conflicts with a prior durable fingerprint; quarantining by offset`);
        } else if (claim.status === "replay" || claim.status === "in-flight") {
          await acknowledgeTelegramReplay(body, effectiveAdapterContext({ ...options, enterprise, approvalActions, approvalStore }, {}, queue, cwd, true));
        } else {
          if (!claim.claimToken) throw new Error("Telegram ingress claim did not return its generation token.");
          const ownership: GatewayIngressOwnership = { ...identity, claimToken: claim.claimToken };
          await ingress.transition({ ...ownership, to: "running" });
          try {
            await ingressSpool.put({ adapterId: "telegram", ownership, body });
          } catch (error) {
            await ingress.fail(ownership).catch(() => undefined);
            throw error;
          }
          if (updateId > 0 && updateId + 1 > persistedOffset) {
            persistedOffset = updateId + 1;
            await saveTelegramPollOffset(cwd, persistedOffset);
            offset = persistedOffset;
          }
          const context = effectiveAdapterContext({ ...options, enterprise, approvalActions, approvalStore }, {}, queue, cwd, true);
          await runAcceptedDurableAdapter({
            adapterId: "telegram",
            body,
            ownership,
            leaseExpiresAt: claim.leaseExpiresAt,
            ingress,
            spool: ingressSpool,
            context,
          });
        }
        if (updateId > 0 && updateId + 1 > persistedOffset) {
          persistedOffset = updateId + 1;
          await saveTelegramPollOffset(cwd, persistedOffset);
          offset = persistedOffset;
        }
      } catch (error) {
        log(`telegram update handling failed: ${error instanceof Error ? error.message : String(error)}`);
        offset = persistedOffset;
        break;
      }
    }
  }
  if (ownsApprovalStore) approvalStore.close();
  if (ownsEnterpriseRuntime) await enterprise.close?.();
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
  if (signingSecret && !context.platformVerified) {
    const signature = context.headers["x-slack-signature"];
    const timestamp = context.headers["x-slack-request-timestamp"];
    const valid = slackSignatureIsValid(
      typeof timestamp === "string" ? timestamp : undefined,
      body,
      typeof signature === "string" ? signature : undefined,
      signingSecret,
    );
    if (!valid) throw new GatewayHttpError(401, "Slack signature verification failed.");
  } else if (!signingSecret) {
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
  const inbound = slackEventToSurfaceMessage(payload, { approvalActions: context.approvalActions });
  if (inbound.kind === "url_verification") return { challenge: inbound.challenge };
  if (inbound.kind === "ignored") return { ok: true, ignored: inbound.reason };
  if (context.gateway.slack?.stream === "draft") {
    const message: SurfaceMessage = { ...inbound.message, stream: "draft" };
    const channelSink = createSlackDraftSink({
      botToken,
      channel: message.conversationId,
      threadTs: message.replyTo,
      fetcher: context.fetcher,
      queue: context.queue,
    });
    let durableDraftDelivered = false;
    const sink: DraftSink = context.durableDelivery ? {
      ...channelSink,
      finalize: async (text) => {
        await context.durableDelivery?.checkpoint([{ message, reply: { text } }]);
        await context.durableDelivery?.begin();
        await channelSink.finalize(text);
        await context.durableDelivery?.delivered();
        durableDraftDelivered = true;
      },
    } : channelSink;
    const progress = await startSlackProgress(botToken, message, context);
    let reply: SurfaceReply | PairingChallenge;
    try {
      reply = await withConversationLane(message, context, context.gateway.slack?.busy ?? "queue", () => handleSurfaceMessage(message, { ...context, sink }));
      await progress.stop(isPairingChallenge(reply) ? undefined : "✓ Done");
    } catch (error) {
      await progress.stop("! Failed");
      throw error;
    }
    if (!isPairingChallenge(reply) && durableDraftDelivered) {
      await deliverSlackArtifacts(botToken, reply, message.conversationId, message.replyTo, context);
      const result = { ok: true, streamed: true };
      deliveryStore(deliveryKey, result);
      return result;
    }
    if (context.durableDelivery && !durableDraftDelivered) {
      await context.durableDelivery.checkpoint([{ message, reply }]);
      await context.durableDelivery.begin();
    }
    await deliverSlackReply(botToken, reply, message.conversationId, message.replyTo, context, message);
    if (context.durableDelivery && !durableDraftDelivered) await context.durableDelivery.delivered();
    return { ok: true };
  }
  const progress = await startSlackProgress(botToken, inbound.message, context);
  let reply: SurfaceReply | PairingChallenge;
  let progressFinal: "updated" | "none" = "none";
  let durableDeliveryBegan = false;
  try {
    reply = await withConversationLane(inbound.message, context, context.gateway.slack?.busy ?? "queue", () => handleSurfaceMessage(inbound.message, context));
    if (context.durableDelivery) await context.durableDelivery.checkpoint([{ message: inbound.message, reply }]);
    if (context.durableDelivery && !isPairingChallenge(reply) && !reply.approvalRequest) {
      await context.durableDelivery.begin();
      durableDeliveryBegan = true;
    }
    progressFinal = await progress.stop(!isPairingChallenge(reply) && !reply.approvalRequest ? reply.text : undefined);
  } catch (error) {
    await progress.stop("! Failed");
    throw error;
  }
  if (context.durableDelivery && !durableDeliveryBegan) await context.durableDelivery.begin();
  if (isPairingChallenge(reply) || reply.approvalRequest || progressFinal !== "updated") {
    await deliverSlackReply(botToken, reply, inbound.message.conversationId, inbound.message.replyTo, context, inbound.message);
  } else {
    await deliverSlackArtifacts(botToken, reply, inbound.message.conversationId, inbound.message.replyTo, context);
  }
  if (context.durableDelivery) await context.durableDelivery.delivered();
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
  readonly enterprise?: GatewayEnterpriseRuntime;
  readonly ingress?: DurableGatewayIngress;
  readonly ingressSpool?: DurableGatewayIngressSpool;
  readonly approvalActions?: ApprovalActionCodec;
  readonly approvalStore?: SqliteApprovalActionStore;
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
  const ownsApprovalStore = options.approvalStore === undefined;
  const approvalStore = options.approvalStore ?? new SqliteApprovalActionStore(join(dataDir(cwd), "enterprise-control-plane.db"));
  const approvalActions = options.approvalActions ?? createApprovalActionCodec({
    secret: createHash("sha256").update(`muster-approval:${options.gateway.token}`).digest(),
    store: approvalStore,
  });
  const ownsEnterpriseRuntime = options.enterprise === undefined;
  const enterprise = options.enterprise ?? openSqliteGatewayEnterpriseRuntime(cwd);
  const ingress = options.ingress ?? new DurableGatewayIngress(enterprise.idempotencyStore, { defaultLeaseMs: 15 * 60_000 });
  const ingressSpool = options.ingressSpool ?? new DurableGatewayIngressSpool(
    join(dataDir(cwd), "gateway-ingress-spool"),
    createHash("sha256").update(`muster-ingress-spool:${options.gateway.token}`).digest(),
  );
  const reconnectDelayMs = options.reconnectDelayMs ?? 2000;
  const maxConnections = options.maxConnections ?? Number.POSITIVE_INFINITY;
  const queue = createOutboundQueue();
  await recoverIngressSpool({
    ...options,
    cwd,
    enterprise,
    ingress,
    ingressSpool,
    approvalActions,
    approvalStore,
  }, queue, ingressSpool);
  const activePayloads = new Set<Promise<void>>();
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
        if (envelope.type !== "events_api") {
          if (envelope.envelope_id) socket?.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
          return;
        }
        if (!envelope.envelope_id) {
          log("slack socket-mode events_api envelope has no envelope_id; it was not acknowledged");
          return;
        }
        const task = (async () => {
          const body = JSON.stringify(envelope.payload);
          const deliveryId = `slack-socket:${envelope.envelope_id}`;
          const identity: GatewayIngressIdentity = {
            scope: "adapter:slack",
            deliveryId,
            fingerprint: createGatewayIngressFingerprint(["slack", deliveryId, body]),
          };
          const claim = await ingress.claim(identity);
          if (claim.status === "conflict") {
            log(`slack socket-mode ${deliveryId} conflicts with a prior durable fingerprint`);
            socket?.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
            return;
          }
          if (claim.status === "replay" || claim.status === "in-flight") {
            socket?.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
            return;
          }
          if (!claim.claimToken) throw new Error("Slack ingress claim did not return its generation token.");
          const ownership: GatewayIngressOwnership = { ...identity, claimToken: claim.claimToken };
          await ingress.transition({ ...ownership, to: "running" });
          try {
            await ingressSpool.put({ adapterId: "slack", ownership, body });
          } catch (error) {
            await ingress.fail(ownership).catch(() => undefined);
            throw error;
          }
          socket?.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
          const context = effectiveAdapterContext({ ...options, enterprise, approvalActions, approvalStore }, {}, queue, cwd, true);
          await runAcceptedDurableAdapter({
            adapterId: "slack",
            body,
            ownership,
            leaseExpiresAt: claim.leaseExpiresAt,
            ingress,
            spool: ingressSpool,
            context,
          });
        })().catch((error) => {
          log(`slack socket-mode payload failed: ${error instanceof Error ? error.message : String(error)}`);
        });
        trackBackgroundTask(activePayloads, task);
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
  await waitForBackgroundTasks(activePayloads);
  if (ownsApprovalStore) approvalStore.close();
  if (ownsEnterpriseRuntime) await enterprise.close?.();
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
  if (publicKey && !context.platformVerified) {
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
  const inbound = discordInteractionToInbound(JSON.parse(body), { approvalActions: context.approvalActions });
  if (inbound.kind === "pong") return DISCORD_PONG;
  if (inbound.kind === "ignored") return { ok: true, ignored: inbound.reason };
  const reply = await handleSurfaceMessage(inbound.message, context);
  const result = surfaceReplyToDiscordInteractionResponse(reply, { approvalAction: approvalRenderContext(reply, inbound.message, context) });
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
  if (whatsapp.appSecret && !context.platformVerified) {
    const signature = context.headers["x-hub-signature-256"];
    if (!whatsAppSignatureIsValid(body, typeof signature === "string" ? signature : undefined, whatsapp.appSecret)) {
      throw new GatewayHttpError(401, "WhatsApp signature verification failed.");
    }
  }
  const deliveryKey = adapterDeliveryKey("whatsapp", body);
  const cached = deliveryLookup(deliveryKey);
  if (cached !== undefined) return cached;
  const messages = whatsAppWebhookToSurfaceMessages(JSON.parse(body), { approvalActions: context.approvalActions });
  if (messages.length === 0) return { ok: true, ignored: "no text messages in notification" };
  let hasPairingChallenge = false;
  const prepared: GatewayPreparedDelivery[] = [];
  for (const message of messages) {
    const reply = await handleSurfaceMessage(message, context);
    if (isPairingChallenge(reply)) hasPairingChallenge = true;
    prepared.push({ message, reply });
  }
  if (context.durableDelivery) {
    await context.durableDelivery.checkpoint(prepared);
    await context.durableDelivery.begin();
  }
  for (const { message, reply } of prepared) {
    const payload = surfaceReplyToWhatsAppSend(reply, message.conversationId, { approvalAction: approvalRenderContext(reply, message, context) });
    const version = whatsapp.apiVersion ?? "v19.0";
    const response = await context.fetcher(`https://graph.facebook.com/${version}/${whatsapp.phoneNumberId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${whatsapp.accessToken}` },
      body: JSON.stringify(payload),
    });
    const responseBody = await response.json().catch(() => ({})) as { error?: { message?: string } };
    if (!response.ok || responseBody.error) {
      throw new DefinitivePlatformDeliveryError(`WhatsApp did not acknowledge the final reply: HTTP ${response.status}${responseBody.error?.message ? ` ${responseBody.error.message}` : ""}`);
    }
  }
  if (context.durableDelivery) await context.durableDelivery.delivered();
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
  if (modern?.mode === "bearer" && !context.platformVerified) {
    if (!context.gchatVerifier) throw new GatewayHttpError(401, "Google Chat bearer verification is configured but no verifier is available.");
    const authorization = context.headers.authorization;
    const valid = await context.gchatVerifier.verify({
      authorization: typeof authorization === "string" ? authorization : undefined,
      rawBody: body,
      payload,
      audience: modern.audience,
    });
    if (!valid) throw new GatewayHttpError(401, "Google Chat bearer verification failed.");
  } else if (!context.platformVerified) {
    const expectedToken = context.gateway.gchat.verificationToken;
    if (expectedToken && gchatEventToken(payload) !== expectedToken) {
      throw new GatewayHttpError(401, "Google Chat verification token mismatch.");
    }
  }
  const eventId = gchatDeliveryId(payload);
  const deliveryKey = eventId ? `gchat:${eventId}` : undefined;
  const cached = deliveryLookup(deliveryKey);
  if (cached !== undefined) return cached;
  const inbound = gchatEventToSurfaceMessage(payload, { commands: context.gateway.gchat.commands, approvalActions: context.approvalActions });
  if (inbound.kind === "ignored") return { ok: true, ignored: inbound.reason };
  const reply = await handleSurfaceMessage(inbound.message, context);
  const result = surfaceReplyToGchatResponse(reply, inbound.message.replyTo, { approvalAction: approvalRenderContext(reply, inbound.message, context) });
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
  if (secret && !context.platformVerified) {
    const header = context.headers.authorization;
    if (!teamsHmacIsValid(body, typeof header === "string" ? header : undefined, secret)) {
      throw new GatewayHttpError(401, "Teams HMAC signature mismatch.");
    }
  }
  const deliveryKey = adapterDeliveryKey("teams", body);
  const cached = deliveryLookup(deliveryKey);
  if (cached !== undefined) return cached;
  const inbound = teamsActivityToSurfaceMessage(JSON.parse(body), { approvalActions: context.approvalActions });
  if (inbound.kind === "ignored") return { ok: true, ignored: inbound.reason };
  const reply = await handleSurfaceMessage(inbound.message, context);
  const result = surfaceReplyToTeamsActivity(reply, { approvalAction: approvalRenderContext(reply, inbound.message, context) });
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
    payload = adapterId === "slack" ? parseSlackWebhookBody(body) : JSON.parse(body);
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

function adapterInFlightAcknowledgement(adapterId: string): unknown {
  if (adapterId === "discord") return { type: 5 };
  if (adapterId === "gchat") return { text: "This request is already processing." };
  if (adapterId === "teams") return { type: "message", text: "This request is already processing." };
  return { ok: true, accepted: true };
}

function adapterReplayAcknowledgement(adapterId: string): unknown {
  if (adapterId === "discord") return { type: 5 };
  if (adapterId === "gchat") return { text: "This request was already handled." };
  if (adapterId === "teams") return { type: "message", text: "This request was already handled." };
  return { ok: true, replayed: true };
}

function effectiveAdapterContext(
  options: GatewayServerOptions,
  headers: AdapterContext["headers"],
  queue: OutboundQueue,
  cwd: string,
  platformVerified = false,
  durableDelivery?: DurableAdapterDeliveryHooks,
): AdapterContext {
  return {
    config: options.config,
    gateway: options.gateway,
    cwd,
    fetcher: options.fetcher ?? fetch,
    log: options.log ?? (() => {}),
    headers,
    queue,
    registry: options.registry,
    gchatVerifier: options.gchatVerifier,
    enterprise: options.enterprise,
    approvalActions: options.approvalActions,
    approvalStore: options.approvalStore,
    platformVerified,
    durableDelivery,
  };
}

async function acknowledgeTelegramReplay(body: string, context: AdapterContext): Promise<void> {
  const callbackQueryId = telegramCallbackQueryId(JSON.parse(body));
  const botToken = context.gateway.telegram?.botToken;
  if (callbackQueryId && botToken) {
    await sendTelegramPayload(botToken, { callback_query_id: callbackQueryId }, context, "answerCallbackQuery");
  }
}

async function verifyAdapterPlatformRequest(
  adapterId: string,
  body: string,
  headers: AdapterContext["headers"],
  options: GatewayServerOptions,
): Promise<void> {
  if (adapterId === "telegram" && options.gateway.telegram?.secretToken) {
    const presented = headers["x-telegram-bot-api-secret-token"];
    if (!headerEquals(typeof presented === "string" ? presented : undefined, options.gateway.telegram.secretToken)) {
      throw new GatewayHttpError(401, "Telegram secret token mismatch.");
    }
  }
  if (adapterId === "slack" && options.gateway.slack?.signingSecret) {
    const signature = headers["x-slack-signature"];
    const timestamp = headers["x-slack-request-timestamp"];
    if (!slackSignatureIsValid(
      typeof timestamp === "string" ? timestamp : undefined,
      body,
      typeof signature === "string" ? signature : undefined,
      options.gateway.slack.signingSecret,
    )) throw new GatewayHttpError(401, "Slack signature verification failed.");
  }
  if (adapterId === "discord" && options.gateway.discord?.publicKey) {
    const signature = headers["x-signature-ed25519"];
    const timestamp = headers["x-signature-timestamp"];
    if (!discordSignatureIsValid(body, typeof signature === "string" ? signature : undefined, typeof timestamp === "string" ? timestamp : undefined, options.gateway.discord.publicKey)) {
      throw new GatewayHttpError(401, "Discord ed25519 signature verification failed.");
    }
  }
  if (adapterId === "whatsapp" && options.gateway.whatsapp?.appSecret) {
    const signature = headers["x-hub-signature-256"];
    if (!whatsAppSignatureIsValid(body, typeof signature === "string" ? signature : undefined, options.gateway.whatsapp.appSecret)) {
      throw new GatewayHttpError(401, "WhatsApp signature verification failed.");
    }
  }
  if (adapterId === "teams" && options.gateway.teams?.hmacSecret) {
    const authorization = headers.authorization;
    if (!teamsHmacIsValid(body, typeof authorization === "string" ? authorization : undefined, options.gateway.teams.hmacSecret)) {
      throw new GatewayHttpError(401, "Teams HMAC signature mismatch.");
    }
  }
  if (adapterId === "gchat" && options.gateway.gchat) {
    const payload = JSON.parse(body);
    if (options.gateway.gchat.verification?.mode === "bearer") {
      const verifier = options.gchatVerifier;
      const authorization = headers.authorization;
      if (!verifier || !await verifier.verify({
        authorization: typeof authorization === "string" ? authorization : undefined,
        rawBody: body,
        payload,
        audience: options.gateway.gchat.verification.audience,
      })) throw new GatewayHttpError(401, "Google Chat bearer verification failed.");
    } else if (options.gateway.gchat.verificationToken && gchatEventToken(payload) !== options.gateway.gchat.verificationToken) {
      throw new GatewayHttpError(401, "Google Chat verification token mismatch.");
    }
  }
}

function adapterRunsAfterAcknowledgement(adapterId: string, body: string, ingress: GatewayIngressIdentity | undefined): boolean {
  if (!ingress || !["telegram", "slack", "whatsapp"].includes(adapterId)) return false;
  if (adapterId === "slack") {
    const payload = parseSlackWebhookBody(body) as { type?: unknown };
    if (payload?.type === "url_verification") return false;
  }
  return true;
}

function isAsyncAdapterId(adapterId: string): adapterId is GatewayAsyncAdapterId {
  return adapterId === "telegram" || adapterId === "slack" || adapterId === "whatsapp";
}

class PostDeliveryPersistenceError extends Error {
  constructor(readonly cause: unknown) {
    super(`Platform delivery completed, but durable completion is pending: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "PostDeliveryPersistenceError";
  }
}

class DefinitivePlatformDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DefinitivePlatformDeliveryError";
  }
}

async function advanceAdapterIngressToDelivering(
  ingress: DurableGatewayIngress,
  ownership: GatewayIngressOwnership,
): Promise<void> {
  for (let guard = 0; guard < 8; guard += 1) {
    const lifecycle = await ingress.readLifecycle(ownership);
    if (!lifecycle) throw new Error("Gateway ingress lifecycle disappeared before delivery.");
    if (lifecycle.state === "delivering") return;
    if (lifecycle.state === "delivered" || lifecycle.state === "unknown") {
      throw new Error(`Gateway ingress is already terminal as ${lifecycle.state}.`);
    }
    const to = lifecycle.state === "accepted"
      ? "running"
      : lifecycle.state === "running"
        ? "generated"
        : lifecycle.state === "generated"
          ? "delivering"
          : lifecycle.lastOperationalState === "generated" || lifecycle.lastOperationalState === "delivering"
            ? "delivering"
            : "running";
    await ingress.transition({ ...ownership, to });
  }
  throw new Error("Gateway ingress could not advance to delivering state.");
}

async function advanceAdapterIngressToGenerated(
  ingress: DurableGatewayIngress,
  ownership: GatewayIngressOwnership,
): Promise<void> {
  for (let guard = 0; guard < 6; guard += 1) {
    const lifecycle = await ingress.readLifecycle(ownership);
    if (!lifecycle) throw new Error("Gateway ingress lifecycle disappeared before execution checkpointing.");
    if (lifecycle.state === "generated") return;
    if (lifecycle.state === "delivering" || lifecycle.state === "delivered" || lifecycle.state === "unknown") {
      throw new Error(`Gateway ingress cannot checkpoint generated output from ${lifecycle.state}.`);
    }
    const to = lifecycle.state === "accepted" || lifecycle.state === "failed" ? "running" : "generated";
    await ingress.transition({ ...ownership, to });
  }
  throw new Error("Gateway ingress could not advance to generated state.");
}

async function notifyBackgroundFailure(adapterId: string, body: string, context: AdapterContext): Promise<void> {
  const text = "This request failed before completion. Nothing is being claimed as complete; retry it or use /status to inspect the connection.";
  if (adapterId === "telegram" && context.gateway.telegram?.botToken) {
    const message = telegramUpdateToSurfaceMessage(JSON.parse(body), { approvalActions: context.approvalActions });
    if (message) await sendTelegramPayload(context.gateway.telegram.botToken, { chat_id: message.conversationId, text }, context);
    return;
  }
  if (adapterId === "slack" && context.gateway.slack?.botToken) {
    const inbound = slackEventToSurfaceMessage(parseSlackWebhookBody(body), { approvalActions: context.approvalActions });
    if (inbound.kind === "message") {
      await sendSlackPayload(context.gateway.slack.botToken, {
        channel: inbound.message.conversationId,
        thread_ts: inbound.message.replyTo,
        text,
      }, context);
    }
    return;
  }
  if (adapterId === "whatsapp" && context.gateway.whatsapp?.accessToken && context.gateway.whatsapp.phoneNumberId) {
    const message = whatsAppWebhookToSurfaceMessages(JSON.parse(body))[0];
    if (!message) return;
    const version = context.gateway.whatsapp.apiVersion ?? "v19.0";
    await context.fetcher(`https://graph.facebook.com/${version}/${context.gateway.whatsapp.phoneNumberId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${context.gateway.whatsapp.accessToken}` },
      body: JSON.stringify(surfaceReplyToWhatsAppSend({ text }, message.conversationId)),
    });
  }
}

async function completeAdapterIngress(
  ingress: DurableGatewayIngress,
  ownership: GatewayIngressOwnership,
  finalState: "delivered" | "unknown" = "delivered",
): Promise<void> {
  for (let guard = 0; guard < 8; guard += 1) {
    const lifecycle = await ingress.readLifecycle(ownership);
    if (!lifecycle) throw new Error("Gateway ingress lifecycle disappeared before completion.");
    if (lifecycle.state === finalState) break;
    if (lifecycle.state === "delivered" || lifecycle.state === "unknown") {
      throw new Error(`Gateway ingress is already terminal as ${lifecycle.state}, not ${finalState}.`);
    }
    const to = lifecycle.state === "delivering" ? finalState : undefined;
    if (!to) {
      await advanceAdapterIngressToDelivering(ingress, ownership);
      continue;
    }
    await ingress.transition({ ...ownership, to });
  }
  const terminal = await ingress.readLifecycle(ownership);
  if (terminal?.state !== finalState) throw new Error(`Gateway ingress did not reach terminal ${finalState} state.`);
  await ingress.complete({
    ...ownership,
    resultRef: createGatewaySafeResultRef("delivery", ownership.fingerprint.slice("sha256:".length, "sha256:".length + 32)),
  });
}

interface DurableAdapterDeliveryController {
  readonly hooks: DurableAdapterDeliveryHooks;
  readonly attempted: () => boolean;
  readonly delivered: () => boolean;
  finishWithoutDelivery(): Promise<void>;
  rejectDelivery(): Promise<void>;
  markUnknown(): Promise<void>;
}

function createDurableAdapterDeliveryController(
  ingress: DurableGatewayIngress,
  spool: DurableGatewayIngressSpool,
  ownership: GatewayIngressOwnership,
): DurableAdapterDeliveryController {
  let checkpointed = false;
  let attempted = false;
  let delivered = false;
  return {
    hooks: {
      checkpoint: async (preparedDeliveries) => {
        await spool.markExecutionCompleted(ownership, preparedDeliveries);
        checkpointed = true;
        await advanceAdapterIngressToGenerated(ingress, ownership);
      },
      begin: async () => {
        if (!checkpointed) throw new Error("Durable adapter delivery began before execution was checkpointed.");
        await spool.markSendAttempted(ownership);
        attempted = true;
        await ingress.transition({ ...ownership, to: "delivering" });
      },
      delivered: async () => {
        if (!attempted) throw new Error("Durable adapter delivery completed before its send attempt was recorded.");
        await spool.markPlatformDelivered(ownership);
        delivered = true;
        await ingress.transition({ ...ownership, to: "delivered" });
      },
    },
    attempted: () => attempted,
    delivered: () => delivered,
    finishWithoutDelivery: async () => {
      if (checkpointed || attempted) return;
      await spool.markPlatformDelivered(ownership);
      delivered = true;
      await completeAdapterIngress(ingress, ownership, "delivered");
    },
    rejectDelivery: async () => {
      await spool.markDeliveryRejected(ownership);
      attempted = false;
      await ingress.fail(ownership);
    },
    markUnknown: async () => {
      await spool.markUnknownAfterSend(ownership);
      await completeAdapterIngress(ingress, ownership, "unknown");
    },
  };
}

async function withIngressLease<T>(
  ingress: DurableGatewayIngress,
  ownership: GatewayIngressOwnership,
  initialLeaseExpiresAt: string,
  work: () => Promise<T>,
): Promise<T> {
  let stopped = false;
  let renewalFailure: unknown;
  const remaining = Math.max(300, Date.parse(initialLeaseExpiresAt) - Date.now());
  const intervalMs = Math.max(100, Math.min(60_000, Math.floor(remaining / 3)));
  let timer: NodeJS.Timeout | undefined;
  const renew = async (): Promise<void> => {
    if (stopped) return;
    try {
      await ingress.renew(ownership);
    } catch (error) {
      renewalFailure = error;
      return;
    }
    if (!stopped) {
      timer = setTimeout(() => { void renew(); }, intervalMs);
      timer.unref?.();
    }
  };
  timer = setTimeout(() => { void renew(); }, intervalMs);
  timer.unref?.();
  try {
    const result = await work();
    if (renewalFailure) throw new Error(`Gateway ingress lease renewal failed: ${renewalFailure instanceof Error ? renewalFailure.message : String(renewalFailure)}`);
    return result;
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
  }
}

async function runAcceptedDurableAdapter(input: {
  readonly adapterId: GatewayAsyncAdapterId;
  readonly body: string;
  readonly ownership: GatewayIngressOwnership;
  readonly leaseExpiresAt: string;
  readonly ingress: DurableGatewayIngress;
  readonly spool: DurableGatewayIngressSpool;
  readonly context: AdapterContext;
}): Promise<unknown> {
  const handler = adapterRoutes[input.adapterId];
  if (!handler) throw new Error(`No adapter handler is registered for ${input.adapterId}.`);
  const controller = createDurableAdapterDeliveryController(input.ingress, input.spool, input.ownership);
  const context = { ...input.context, durableDelivery: controller.hooks };
  return withIngressLease(input.ingress, input.ownership, input.leaseExpiresAt, async () => {
    try {
      const result = await handler(input.body, context);
      await controller.finishWithoutDelivery();
      await completeAdapterIngress(input.ingress, input.ownership, "delivered");
      await input.spool.remove(input.ownership);
      return result;
    } catch (error) {
      if (error instanceof DefinitivePlatformDeliveryError && controller.attempted() && !controller.delivered()) {
        await controller.rejectDelivery();
        throw error;
      }
      if (controller.attempted() && !controller.delivered()) {
        await controller.markUnknown();
        throw new PostDeliveryPersistenceError(error);
      }
      if (controller.delivered()) throw new PostDeliveryPersistenceError(error);
      await input.ingress.fail(input.ownership).catch(() => undefined);
      throw error;
    }
  });
}

async function resumeClaimedDurableAdapter(input: {
  readonly entry: GatewayIngressSpoolEntry;
  readonly ownership: GatewayIngressOwnership;
  readonly leaseExpiresAt: string;
  readonly ingress: DurableGatewayIngress;
  readonly spool: DurableGatewayIngressSpool;
  readonly context: AdapterContext;
}): Promise<void> {
  if (input.entry.state === "accepted") {
    await runAcceptedDurableAdapter({
      adapterId: input.entry.adapterId,
      body: input.entry.body,
      ownership: input.ownership,
      leaseExpiresAt: input.leaseExpiresAt,
      ingress: input.ingress,
      spool: input.spool,
      context: input.context,
    });
    return;
  }
  await withIngressLease(input.ingress, input.ownership, input.leaseExpiresAt, async () => {
    if (input.entry.state === "platform-delivered") {
      await completeAdapterIngress(input.ingress, input.ownership, "delivered");
      await input.spool.remove(input.ownership);
      return;
    }
    if (input.entry.state === "send-attempted" || input.entry.state === "unknown-after-send") {
      if (input.entry.state === "send-attempted") await input.spool.markUnknownAfterSend(input.ownership);
      await completeAdapterIngress(input.ingress, input.ownership, "unknown");
      return;
    }
    await advanceAdapterIngressToDelivering(input.ingress, input.ownership);
    await input.spool.markSendAttempted(input.ownership);
    try {
      await deliverPreparedAdapter(input.entry.adapterId, input.entry.preparedDeliveries, input.context);
      await input.spool.markPlatformDelivered(input.ownership);
      await completeAdapterIngress(input.ingress, input.ownership, "delivered");
      await input.spool.remove(input.ownership);
    } catch (error) {
      if (error instanceof DefinitivePlatformDeliveryError) {
        await input.spool.markDeliveryRejected(input.ownership);
        await input.ingress.fail(input.ownership);
        throw error;
      }
      await input.spool.markUnknownAfterSend(input.ownership);
      await completeAdapterIngress(input.ingress, input.ownership, "unknown");
      throw new PostDeliveryPersistenceError(error);
    }
  });
}

function trackBackgroundTask(tasks: Set<Promise<void>>, work: Promise<void>): void {
  tasks.add(work);
  void work.then(
    () => tasks.delete(work),
    () => tasks.delete(work),
  );
}

async function waitForBackgroundTasks(tasks: ReadonlySet<Promise<void>>, timeoutMs?: number): Promise<void> {
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  while (tasks.size) {
    if (deadline === undefined) {
      await Promise.allSettled([...tasks]);
      continue;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Gateway background drain exceeded ${timeoutMs}ms with ${tasks.size} task(s) still active.`);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...tasks]),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Gateway background drain exceeded ${timeoutMs}ms.`)), remaining); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

async function deliverPreparedAdapter(
  adapterId: GatewayAsyncAdapterId,
  preparedDeliveries: readonly GatewayPreparedDelivery[],
  context: AdapterContext,
): Promise<void> {
  if (adapterId === "telegram") {
    const botToken = context.gateway.telegram?.botToken;
    if (!botToken) throw new Error("Telegram bot token is unavailable during durable delivery recovery.");
    for (const { message, reply } of preparedDeliveries) {
      await deliverTelegramReply(botToken, reply, message.conversationId, context, message);
    }
    return;
  }
  if (adapterId === "slack") {
    const botToken = context.gateway.slack?.botToken;
    if (!botToken) throw new Error("Slack bot token is unavailable during durable delivery recovery.");
    for (const { message, reply } of preparedDeliveries) {
      await deliverSlackReply(botToken, reply, message.conversationId, message.replyTo, context, message);
    }
    return;
  }
  const whatsapp = context.gateway.whatsapp;
  if (!whatsapp?.accessToken || !whatsapp.phoneNumberId) {
    throw new Error("WhatsApp credentials are unavailable during durable delivery recovery.");
  }
  for (const { message, reply } of preparedDeliveries) {
    const version = whatsapp.apiVersion ?? "v19.0";
    const response = await context.fetcher(`https://graph.facebook.com/${version}/${whatsapp.phoneNumberId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${whatsapp.accessToken}` },
      body: JSON.stringify(surfaceReplyToWhatsAppSend(reply, message.conversationId, {
        approvalAction: approvalRenderContext(reply, message, context),
      })),
    });
    const responseBody = await response.json().catch(() => ({})) as { error?: { message?: string } };
    if (!response.ok || responseBody.error) {
      throw new DefinitivePlatformDeliveryError(`WhatsApp did not acknowledge the recovered reply: HTTP ${response.status}${responseBody.error?.message ? ` ${responseBody.error.message}` : ""}`);
    }
  }
}

async function recoverIngressSpool(
  options: GatewayServerOptions,
  queue: OutboundQueue,
  spool: DurableGatewayIngressSpool,
): Promise<void> {
  const ingress = options.ingress;
  if (!ingress) return;
  const log = options.log ?? (() => {});
  const cwd = options.cwd ?? process.cwd();
  const snapshot = await spool.snapshot();
  if (snapshot.rejectedFiles) log(`gateway ingress spool quarantined ${snapshot.rejectedFiles} invalid file(s)`);
  for (const originalEntry of snapshot.entries) {
    try {
      if (originalEntry.state === "unknown-after-send") {
        log(`gateway ingress spool ${originalEntry.adapterId} is unknown-after-send; preserved for operator reconciliation`);
        continue;
      }
      const handler = adapterRoutes[originalEntry.adapterId];
      if (!handler) {
        log(`gateway ingress spool has no handler for ${originalEntry.adapterId}; preserving payload`);
        continue;
      }
      let entry = originalEntry;
      let claim = await ingress.claim(entry.ownership);
      if (claim.status === "replay") {
        if (entry.state === "platform-delivered") await spool.remove(entry.ownership);
        else log(`gateway ingress spool ${entry.adapterId} replay retained because delivery evidence is ${entry.state}`);
        continue;
      }
      if (claim.status === "conflict") {
        log(`gateway ingress spool ${entry.adapterId} conflicts with durable ingress; preserving payload for inspection`);
        continue;
      }
      let ownership = entry.ownership;
      let leaseExpiresAt = claim.leaseExpiresAt;
      if (claim.status === "claimed") {
        if (!claim.claimToken) throw new Error("Gateway ingress claim did not return its generation token.");
        ownership = { ...entry.ownership, claimToken: claim.claimToken };
        if (ownership.claimToken !== entry.ownership.claimToken) entry = await spool.reassignOwnership(entry.ownership, ownership);
      } else if (claim.status === "in-flight") {
        if (!spoolOwnerIsDeadOnThisHost(entry)) {
          log(`gateway ingress spool ${entry.adapterId} remains owned by a live or remote process; recovery deferred`);
          continue;
        }
        if (entry.state === "platform-delivered" || entry.state === "send-attempted") {
          ownership = entry.ownership;
        } else {
          await ingress.fail(entry.ownership).catch(() => undefined);
          claim = await ingress.claim(entry.ownership);
          if (claim.status !== "claimed" || !claim.claimToken) {
            log(`gateway ingress spool ${entry.adapterId} could not reclaim its dead owner state (${claim.status})`);
            continue;
          }
          leaseExpiresAt = claim.leaseExpiresAt;
          ownership = { ...entry.ownership, claimToken: claim.claimToken };
          entry = await spool.reassignOwnership(entry.ownership, ownership);
        }
      }

      await withIngressLease(ingress, ownership, leaseExpiresAt, async () => {
        if (entry.state === "platform-delivered") {
          await completeAdapterIngress(ingress, ownership, "delivered");
          await spool.remove(ownership);
          log(`gateway ingress spool finalized previously delivered ${entry.adapterId} payload`);
          return;
        }
        if (entry.state === "send-attempted") {
          await spool.markUnknownAfterSend(ownership);
          await completeAdapterIngress(ingress, ownership, "unknown");
          log(`gateway ingress spool marked ${entry.adapterId} unknown-after-send; no duplicate delivery was attempted`);
          return;
        }
        const context = effectiveAdapterContext(options, {}, queue, cwd, true);
        if (entry.state === "execution-completed") {
          await advanceAdapterIngressToDelivering(ingress, ownership);
          await spool.markSendAttempted(ownership);
          try {
            await deliverPreparedAdapter(entry.adapterId, entry.preparedDeliveries, context);
            await spool.markPlatformDelivered(ownership);
            await completeAdapterIngress(ingress, ownership, "delivered");
            await spool.remove(ownership);
            log(`gateway ingress spool delivered checkpointed ${entry.adapterId} result without rerunning the provider`);
          } catch (error) {
            if (error instanceof DefinitivePlatformDeliveryError) {
              await spool.markDeliveryRejected(ownership);
              await ingress.fail(ownership);
              throw error;
            }
            await spool.markUnknownAfterSend(ownership);
            await completeAdapterIngress(ingress, ownership, "unknown");
            throw new PostDeliveryPersistenceError(error);
          }
          return;
        }

        const controller = createDurableAdapterDeliveryController(ingress, spool, ownership);
        const durableContext = { ...context, durableDelivery: controller.hooks };
        try {
          await handler(entry.body, durableContext);
          await controller.finishWithoutDelivery();
          await completeAdapterIngress(ingress, ownership, "delivered");
          await spool.remove(ownership);
          log(`gateway ingress spool recovered ${entry.adapterId} payload`);
        } catch (error) {
          if (error instanceof DefinitivePlatformDeliveryError && controller.attempted() && !controller.delivered()) {
            await controller.rejectDelivery();
            throw error;
          }
          if (controller.attempted() && !controller.delivered()) {
            await controller.markUnknown();
            throw new PostDeliveryPersistenceError(error);
          }
          await ingress.fail(ownership).catch(() => undefined);
          await notifyBackgroundFailure(entry.adapterId, entry.body, durableContext).catch((deliveryError) => {
            log(`gateway ingress spool failure notice failed: ${deliveryError instanceof Error ? deliveryError.message : String(deliveryError)}`);
          });
          throw error;
        }
      });
    } catch (error) {
      log(`gateway ingress spool ${originalEntry.adapterId} recovery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  options: GatewayServerOptions,
  queue: OutboundQueue,
  backgroundTasks: Set<Promise<void>>,
): Promise<void> {
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
    await verifyAdapterPlatformRequest(adapterId, body, request.headers, options);
    const deliveryId = adapterDeliveryKey(adapterId, body);
    const ingressIdentity = deliveryId && options.ingress ? {
      scope: `adapter:${adapterId}`,
      deliveryId,
      fingerprint: createGatewayIngressFingerprint([adapterId, deliveryId, body]),
    } : undefined;
    let ingressOwnership: GatewayIngressOwnership | undefined;
    let ingressLeaseExpiresAt: string | undefined;
    let existingSpoolEntry: GatewayIngressSpoolEntry | undefined;
    if (ingressIdentity && options.ingress) {
      const claim = await options.ingress.claim(ingressIdentity);
      if (claim.status === "conflict") {
        sendJson(response, 409, { error: "Conflicting delivery fingerprint." });
        return;
      }
      if (claim.status === "in-flight") {
        if (adapterId === "telegram") await acknowledgeTelegramReplay(body, effectiveAdapterContext(options, request.headers, queue, cwd));
        sendJson(response, 200, adapterInFlightAcknowledgement(adapterId));
        return;
      }
      if (claim.status === "replay") {
        if (adapterId === "telegram") await acknowledgeTelegramReplay(body, effectiveAdapterContext(options, request.headers, queue, cwd));
        sendJson(response, 200, deliveryLookup(deliveryId) ?? adapterReplayAcknowledgement(adapterId));
        return;
      }
      if (!claim.claimToken) throw new Error("Gateway ingress claim did not return its generation token.");
      ingressOwnership = { ...ingressIdentity, claimToken: claim.claimToken };
      ingressLeaseExpiresAt = claim.leaseExpiresAt;
      if (isAsyncAdapterId(adapterId) && options.ingressSpool) {
        const existing = await options.ingressSpool.find(ingressIdentity);
        if (existing) existingSpoolEntry = await options.ingressSpool.reassignOwnership(existing.ownership, ingressOwnership);
      }
      if (!existingSpoolEntry) await options.ingress.transition({ ...ingressOwnership, to: "running" });
    }
    const runAfterAcknowledgement = adapterRunsAfterAcknowledgement(adapterId, body, ingressIdentity);
    let spooled = false;
    let controller: DurableAdapterDeliveryController | undefined;
    if (runAfterAcknowledgement && ingressOwnership && options.ingress && options.ingressSpool && isAsyncAdapterId(adapterId) && !existingSpoolEntry) {
      try {
        await options.ingressSpool.put({ adapterId, ownership: ingressOwnership, body });
        spooled = true;
        controller = createDurableAdapterDeliveryController(options.ingress, options.ingressSpool, ingressOwnership);
      } catch (error) {
        await options.ingress.fail(ingressOwnership).catch(() => undefined);
        throw error;
      }
    }
    const context = effectiveAdapterContext(
      options,
      request.headers,
      queue,
      cwd,
      adapterHasPlatformAuth(adapterId, options.gateway),
      controller?.hooks,
    );
    const processAdapter = async (): Promise<unknown> => {
      if (existingSpoolEntry && ingressOwnership && ingressLeaseExpiresAt && options.ingress && options.ingressSpool) {
        await resumeClaimedDurableAdapter({
          entry: existingSpoolEntry,
          ownership: ingressOwnership,
          leaseExpiresAt: ingressLeaseExpiresAt,
          ingress: options.ingress,
          spool: options.ingressSpool,
          context,
        });
        return { ok: true, resumed: true };
      }
      const work = async (): Promise<unknown> => {
        try {
          const result = await handler(body, context);
          if (controller) await controller.finishWithoutDelivery();
          if (ingressOwnership && options.ingress) await completeAdapterIngress(options.ingress, ingressOwnership, "delivered");
          if (spooled && ingressOwnership && options.ingressSpool) await options.ingressSpool.remove(ingressOwnership);
          return result;
        } catch (error) {
          if (error instanceof DefinitivePlatformDeliveryError && controller?.attempted() && !controller.delivered()) {
            await controller.rejectDelivery();
            throw error;
          }
          if (controller?.attempted() && !controller.delivered()) {
            await controller.markUnknown();
            throw new PostDeliveryPersistenceError(error);
          }
          if (controller?.delivered()) throw new PostDeliveryPersistenceError(error);
          if (ingressOwnership && options.ingress) await options.ingress.fail(ingressOwnership).catch(() => undefined);
          throw error;
        }
      };
      return ingressOwnership && ingressLeaseExpiresAt && options.ingress
        ? withIngressLease(options.ingress, ingressOwnership, ingressLeaseExpiresAt, work)
        : work();
    };
    if (runAfterAcknowledgement) {
      sendJson(response, 200, { ok: true, accepted: true });
      const task = processAdapter().then(() => undefined).catch(async (error) => {
        context.log(`background ${adapterId} delivery failed: ${error instanceof Error ? error.message : String(error)}`);
        if (error instanceof PostDeliveryPersistenceError) return;
        await notifyBackgroundFailure(adapterId, body, context).catch((deliveryError) => {
          context.log(`background ${adapterId} failure notice failed: ${deliveryError instanceof Error ? deliveryError.message : String(deliveryError)}`);
        });
      });
      trackBackgroundTask(backgroundTasks, task);
      return;
    }
    const result = await processAdapter();
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
    const reply = await handleSurfaceMessage(message, { config: options.config, gateway: options.gateway, enterprise: options.enterprise, approvalStore: options.approvalStore, cwd, registry: options.registry });
    sendJson(response, 200, reply);
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/catalog") {
    sendJson(response, 200, {
      commands: gatewayCommandCatalog(options.gateway),
      personas: gatewayAgentCatalog(options.config),
      source: "muster_native_http",
    });
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
      return Boolean(gateway.gchat?.verificationToken || googleChatAudienceIsValid(gateway.gchat?.verification?.audience));
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
  const startupErrors = gatewayStartupErrors(options.gateway);
  if (startupErrors.length) throw new Error(`Gateway production security check failed: ${startupErrors.join("; ")}`);
  const cwd = options.cwd ?? process.cwd();
  const ownsEnterpriseRuntime = options.enterprise === undefined;
  const enterprise = options.enterprise ?? openSqliteGatewayEnterpriseRuntime(cwd);
  const gchatVerifier = options.gchatVerifier
    ?? (options.gateway.gchat?.verification?.mode === "bearer"
      ? createGoogleChatRequestVerifier({ fetcher: options.fetcher })
      : undefined);
  const ingress = options.ingress ?? new DurableGatewayIngress(enterprise.idempotencyStore, { defaultLeaseMs: 15 * 60_000 });
  const ingressSpool = options.ingressSpool ?? new DurableGatewayIngressSpool(
    join(dataDir(cwd), "gateway-ingress-spool"),
    createHash("sha256").update(`muster-ingress-spool:${options.gateway.token}`).digest(),
  );
  const ownsApprovalStore = options.approvalStore === undefined;
  const approvalStore = options.approvalStore ?? new SqliteApprovalActionStore(join(dataDir(cwd), "enterprise-control-plane.db"));
  const approvalActions = options.approvalActions ?? createApprovalActionCodec({
    secret: createHash("sha256").update(`muster-approval:${options.gateway.token}`).digest(),
    store: approvalStore,
  });
  const effectiveOptions: GatewayServerOptions = { ...options, enterprise, gchatVerifier, ingress, ingressSpool, approvalStore, approvalActions };
  // One outbound queue per gateway: chat keys share retry_after backoff state.
  const queue = createOutboundQueue();
  const backgroundTasks = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    route(request, response, effectiveOptions, queue, backgroundTasks).catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      const status = error instanceof GatewayHttpError ? error.status : 500;
      log(`error ${request.method} ${request.url}: ${detail}`);
      if (!response.headersSent) sendJson(response, status, { error: detail });
      else response.end();
    });
  });
  return new Promise((resolvePromise, rejectPromise) => {
    let started = false;
    let cleaned = false;
    const cleanupOwnedResources = async (): Promise<void> => {
      if (cleaned) return;
      cleaned = true;
      if (server.listening) {
        await new Promise<void>((done) => server.close(() => done()));
      }
      if (ownsApprovalStore) approvalStore.close();
      if (ownsEnterpriseRuntime) await enterprise.close?.();
    };
    const failStartup = (error: unknown): void => {
      if (started) return;
      void cleanupOwnedResources().then(
        () => rejectPromise(error),
        (cleanupError) => rejectPromise(new AggregateError([error, cleanupError], "Gateway startup and cleanup failed")),
      );
    };
    server.once("error", failStartup);
    recoverPendingApprovals(effectiveOptions, approvalStore)
      .then(() => recoverIngressSpool(effectiveOptions, queue, ingressSpool))
      .then(() => server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const boundPort = typeof address === "object" && address ? address.port : port;
      started = true;
      log(`muster gateway listening on http://127.0.0.1:${boundPort}`);
      log(`enterprise ledger backend=${enterprise.backend}${enterprise.backend === "sqlite" ? " (durable local; inject an external store for multi-host deployment)" : ""}`);
      resolvePromise({
        port: boundPort,
        server,
        waitForIdle: () => waitForBackgroundTasks(backgroundTasks),
        close: async () => {
          await new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done())));
          try {
            await waitForBackgroundTasks(backgroundTasks, 30_000);
          } finally {
            await cleanupOwnedResources();
          }
        },
      });
    })).catch(failStartup);
  });
}

export function gatewayStartupErrors(gateway: GatewayConfig): readonly string[] {
  if (gateway.security?.deployment !== "production") return [];
  const errors: string[] = [];
  if (gateway.token.length < 32) errors.push("gateway bearer token must contain at least 32 characters");
  if (gateway.telegram?.botToken && !gateway.telegram.secretToken) errors.push("Telegram secretToken is required");
  if (gateway.slack?.botToken) {
    const mode = gateway.slack.mode ?? (gateway.slack.appToken ? "socket" : "http");
    if (mode === "socket" && !gateway.slack.appToken) errors.push("Slack Socket Mode appToken is required");
    if (mode === "http" && !gateway.slack.signingSecret) errors.push("Slack HTTP signingSecret is required");
  }
  if (gateway.discord?.botToken && !gateway.discord.publicKey) errors.push("Discord publicKey is required");
  if (gateway.whatsapp && (!gateway.whatsapp.appSecret || !gateway.whatsapp.verifyToken)) errors.push("WhatsApp appSecret and verifyToken are required");
  if (gateway.gchat) {
    const modern = gateway.gchat.verification?.mode === "bearer" && googleChatAudienceIsValid(gateway.gchat.verification.audience);
    const allowedLegacy = gateway.security.allowLegacyGchatToken && Boolean(gateway.gchat.verificationToken);
    if (!modern && !allowedLegacy) errors.push("Google Chat signed bearer verification requires a Cloud project number or the exact HTTPS /v1/adapters/gchat audience URL");
  }
  if (gateway.teams && !gateway.teams.hmacSecret) errors.push("Teams request verification is required");
  const ttl = gateway.approvals?.ttlSeconds;
  if (ttl !== undefined && (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 3600)) errors.push("approval ttlSeconds must be between 60 and 3600");
  return errors;
}
