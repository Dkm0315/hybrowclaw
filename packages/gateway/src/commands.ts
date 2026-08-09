import { invalidateNativeConversation } from "@musterhq/core";
import type { MusterConfig } from "@musterhq/core";
import type { GatewayConfig, GatewayCustomCommand } from "./gateway-config.js";
import type { PairedSender } from "./pairing.js";
import type { SurfaceMessage, SurfaceReply } from "./envelope.js";
import { INTERACTION_COMMANDS, isInteractionCommand, renderInteractionCommand } from "./interaction.js";
import type { GatewayEnterpriseRuntime } from "./enterprise-runtime.js";
import { gatewayGovernanceRateLimits } from "./enterprise-runtime.js";
import type { FrappeOAuthActor, FrappeOAuthCoordinator } from "./frappe-oauth.js";
import { clearTrustedFrappePairingIdentity, upsertTrustedFrappePairing } from "./pairing.js";
import { renderPresentationText } from "./presentation.js";
import type { SurfaceAction, SurfacePresentation } from "./presentation.js";
import {
  gatewayPolicyManagementAllowed,
  permittedGatewayPolicyTargets,
  type GatewayPolicyActor,
  type GatewayPolicyTarget,
} from "./policy-store.js";
import type { GatewayGovernanceAssignment, GatewayGovernanceRateLimit, GatewayGovernanceRateWindow } from "./gateway-config.js";
import { enterpriseWindowBounds as coreEnterpriseWindowBounds } from "@musterhq/core";

/**
 * A leading /command, requiring the name to end at whitespace or string end so
 * that prompts beginning with a path (e.g. "/etc/hosts is missing") are NOT
 * swallowed as commands and pass through to the agent untouched.
 */
const COMMAND_PATTERN = /^\/([a-z][a-z0-9_-]*)(?:[ \t]+([\s\S]*))?$/i;

export interface ParsedCommand {
  readonly name: string;
  readonly args: string;
}

export interface ResolvedCustomCommand {
  readonly commandName: string;
  readonly args: string;
  readonly prompt: string;
}

export function parseCommand(text: string): ParsedCommand | null {
  const match = COMMAND_PATTERN.exec(text.trim());
  if (!match) return null;
  return { name: match[1].toLowerCase(), args: (match[2] ?? "").trim() };
}

function customCommandEntry(parsed: ParsedCommand, gateway: GatewayConfig | undefined): GatewayCustomCommand | undefined {
  const entries = gateway?.commands?.entries;
  if (!entries) return undefined;
  return entries[parsed.name] ?? entries[parsed.name.replace(/_/g, "-")];
}

function surfaceMatches(command: GatewayCustomCommand, surfaceId: string): boolean {
  if (!command.surfaces?.length) return true;
  return command.surfaces.some((surface) => surface === surfaceId || surfaceId.startsWith(`${surface}:`));
}

function renderCustomPrompt(name: string, args: string, entry: GatewayCustomCommand, message: SurfaceMessage): string {
  const body = entry.prompt?.trim()
    ? entry.prompt.replace(/\{\{\s*args\s*\}\}|\{args\}/g, args)
    : `Handle the custom command /${name}.${args ? `\n\nCommand arguments:\n${args}` : ""}`;
  return [
    `Run custom surface command "/${name}".`,
    entry.description ? `Command description: ${entry.description}` : undefined,
    `Surface: ${message.surfaceId}`,
    "",
    "Command instruction:",
    body,
  ].filter((line): line is string => line !== undefined).join("\n");
}

export function resolveCustomCommand(message: SurfaceMessage, gateway: GatewayConfig | undefined): ResolvedCustomCommand | undefined {
  const parsed = parseCommand(message.text);
  if (!parsed || isBuiltinCommand(parsed.name)) return undefined;
  const entry = customCommandEntry(parsed, gateway);
  if (!entry || !surfaceMatches(entry, message.surfaceId)) return undefined;
  return {
    commandName: parsed.name,
    args: parsed.args,
    prompt: renderCustomPrompt(parsed.name, parsed.args, entry, message),
  };
}

/** Builtin commands answered in-gateway with no model call. */
const BUILTINS = [
  "start", "help", "status", "pair", "connect", "new", "reset", "stop", "whoami", "tools", "reports", "tokens", "usage", "limits", "security", "evals", "index", "settings",
  "approvals", "audit", "incidents", "providers", "models", "plugins", "skills", "mcp", "channels", "agents", "artifacts", "sessions", "memory",
] as const;
type BuiltinName = (typeof BUILTINS)[number];

export interface GatewayCommandCatalogEntry {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly surfaces: readonly string[];
  readonly requires_write: boolean;
  readonly source: "muster_builtin" | "muster_custom";
  readonly capability?: string;
  readonly minimum_role?: "manager" | "system";
}

const CONTROL_COMMANDS: Readonly<Record<string, string>> = {
  pair: "Pair this channel sender with its Frappe identity",
  new: "Start a fresh provider thread without clearing memory",
  reset: "Reset provider session handles for this conversation",
  stop: "Stop or inspect the active conversational run",
};

/** Stable provider-free command catalog shared by every channel and app. */
export function gatewayCommandCatalog(gateway?: GatewayConfig): readonly GatewayCommandCatalogEntry[] {
  const commands = new Map<string, GatewayCommandCatalogEntry>();
  for (const descriptor of INTERACTION_COMMANDS) {
    commands.set(descriptor.name, {
      name: descriptor.name,
      label: commandLabel(descriptor.name),
      description: descriptor.summary,
      surfaces: ["*"],
      requires_write: false,
      source: "muster_builtin",
      ...(descriptor.capability ? { capability: descriptor.capability } : {}),
      ...(descriptor.minimumRole ? { minimum_role: descriptor.minimumRole } : {}),
    });
  }
  for (const [name, description] of Object.entries(CONTROL_COMMANDS)) {
    commands.set(name, {
      name,
      label: commandLabel(name),
      description,
      surfaces: ["*"],
      requires_write: false,
      source: "muster_builtin",
    });
  }
  for (const [name, entry] of Object.entries(gateway?.commands?.entries ?? {})) {
    const normalized = name.trim().toLowerCase().replace(/^\//, "").replaceAll("_", "-");
    if (!normalized || commands.has(normalized)) continue;
    commands.set(normalized, {
      name: normalized,
      label: commandLabel(normalized),
      description: entry.description?.trim() || "Configured Muster command",
      surfaces: entry.surfaces?.length ? [...entry.surfaces] : ["*"],
      requires_write: false,
      source: "muster_custom",
    });
  }
  return Object.freeze([...commands.values()].sort((left, right) => left.label.localeCompare(right.label)));
}

export function gatewayAgentCatalog(config: MusterConfig): Readonly<Record<string, { readonly label: string; readonly description: string; readonly source: "muster_runtime" }>> {
  return Object.freeze(Object.fromEntries(
    Object.values(config.runtimes ?? {})
      .filter((runtime) => runtime.enabled)
      .map((runtime) => [runtime.id, {
        label: commandLabel(runtime.id),
        // Catalog descriptions are user-facing. Provider topology remains in
        // authenticated administration and audit surfaces, not command menus.
        description: "Configured Muster agent",
        source: "muster_runtime" as const,
      }]),
  ));
}

function commandLabel(name: string): string {
  return name.split(/[-_]/g).filter(Boolean).map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(" ");
}

export function isBuiltinCommand(name: string): name is BuiltinName {
  return (BUILTINS as readonly string[]).includes(name);
}

export interface CommandContext {
  readonly config: MusterConfig;
  readonly profile: string;
  readonly paired: PairedSender;
  readonly gateway?: GatewayConfig;
  readonly cwd?: string;
  readonly conversationKey: string;
  /** Legacy pre-user-isolation lane, cleared on reset/new during migration. */
  readonly legacyConversationKey?: string;
  readonly enterprise?: GatewayEnterpriseRuntime;
  readonly frappeOAuth?: FrappeOAuthCoordinator;
}

/** A representative model for the active runtime, for /status and /start. */
function activeModel(config: MusterConfig, runtime: string): string {
  const rt = config.runtimes?.[runtime];
  const routeModel = rt?.routes ? Object.values(rt.routes)[0]?.model : undefined;
  const provider = rt?.provider ? config.providers?.[rt.provider] : undefined;
  return routeModel ?? provider?.defaultModel ?? "(unset)";
}

/**
 * Surface-level slash-command dispatch. Builtins (/start /pair /status
 * /help) are answered here directly — they never reach the model. ANY other
 * /command returns null so the caller can resolve per-surface custom commands,
 * user-invocable skills, then fall through to the native provider CLI.
 */
export async function dispatchCommand(message: SurfaceMessage, ctx: CommandContext): Promise<SurfaceReply | null> {
  const parsed = parseCommand(message.text);
  if (!parsed || !isBuiltinCommand(parsed.name)) return null;
  const runtime = ctx.config.routing?.defaultRuntime ?? "native";
  const model = activeModel(ctx.config, runtime);
  if (parsed.name === "pair" || parsed.name === "connect") return await dispatchFrappePair(parsed.args, message, ctx);
  if (parsed.name === "limits" && /^(?:set|apply)\b/i.test(parsed.args)) return await dispatchPolicyCommand(parsed.args, message, ctx);
  if (isInteractionCommand(parsed.name)) {
    return await renderInteractionCommand({
      command: parsed.name,
      args: parsed.args,
      config: ctx.config,
      profile: ctx.profile,
      runtime,
      model,
      paired: ctx.paired,
      message,
      gateway: ctx.gateway,
      enterprise: ctx.enterprise,
      cwd: ctx.cwd,
    });
  }
  switch (parsed.name) {
    case "new": {
      const removed = await clearCommandSessionHandles(ctx);
      return {
        text: `Started a fresh thread for this chat. Cleared ${removed} provider session handle${removed === 1 ? "" : "s"}.`,
      };
    }
    case "reset": {
      const removed = await clearCommandSessionHandles(ctx);
      return {
        text: `Reset this chat's provider session handles (${removed} cleared). Pairing, memory, and run history were left intact.`,
      };
    }
    case "stop":
      return {
        text: "No active gateway command is running for this chat. Streaming replies stop automatically if the channel reports a terminal delivery error.",
      };
  }
  return null;
}

async function dispatchPolicyCommand(args: string, message: SurfaceMessage, ctx: CommandContext): Promise<SurfaceReply> {
  const [action, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const assignment = resolveCommandAssignment(ctx, message);
  const identity = ctx.paired.identity?.provider === "frappe" ? ctx.paired.identity : undefined;
  const roles = [...(identity?.roles ?? []), ...(assignment.roles ?? [])];
  const actor: GatewayPolicyActor = {
    surfaceId: message.surfaceId,
    senderId: message.senderId,
    pairingId: ctx.paired.pairingId,
  };
  if (!ctx.enterprise) return policyReply("Limit change unavailable", "An enterprise runtime is required before a policy can be drafted or applied.");
  if (ctx.gateway?.governance?.enabled !== true) return policyReply("Limit change unavailable", "Governance enforcement is disabled for this deployment; no policy was changed.");
  if (!gatewayPolicyManagementAllowed(assignment, roles)) {
    return policyReply("Limit change unavailable", "This identity is not authorized to configure governance limits.");
  }
  if (action?.toLowerCase() === "apply") {
    if (rest.length !== 1 || !rest[0]) return policyReply("Limit apply rejected", "Use the exact apply token from a current limit preview.");
    try {
      const applied = await ctx.enterprise.policyStore.applyDraft({ actor, token: rest[0] });
      return policyPresentation({
        kind: "status",
        title: "Limit applied",
        summary: `The ${humanPolicyTarget(applied.subject.kind, applied.subject.id, ctx, assignment, message)} limit is now active for each ${humanPolicyWindow(applied.window)} period.`,
        tables: [{
          id: "applied-policy",
          title: "Enforced policy",
          columns: ["Scope", "Window", "Requests", "Tokens"],
          rows: [[humanPolicyTarget(applied.subject.kind, applied.subject.id, ctx, assignment, message), humanPolicyWindow(applied.window), formatLimit(applied.maxRuns), formatLimit(applied.maxTokens)]],
        }],
        actions: [{ id: "limits", label: "Review limits", command: "/limits", style: "primary" }],
        privacy: { rawPromptsIncluded: false, note: "Policy metadata and counters only; request text remains hidden." },
      });
    } catch {
      return policyReply("Limit apply rejected", "This apply token is invalid, expired, replayed, or bound to a different sender. Create a new preview.");
    }
  }
  if (action?.toLowerCase() !== "set") return policyReply("Limit change rejected", "Open /limits and choose Configure a limit. I will guide you through who it applies to, what to control, the time period, the amount, and a final preview.");
  const values = parsePolicyArguments(rest);
  if (!values || Object.keys(values).some((key) => !["scope", "window", "requests", "tokens", "metric", "amount", "t", "m", "w", "a", "p"].includes(key))) {
    return policyReply("Limit preview rejected", "I could not understand that limit. Open /limits and use the guided setup so every choice can be checked before it is applied.");
  }
  const targets = permittedGatewayPolicyTargets({ message, paired: ctx.paired, assignment, agentId: ctx.profile });
  const target = selectPolicyTargetFromValues(values, targets, ctx, message, assignment);
  if (!target) {
    if (values.scope !== undefined || values.t !== undefined) {
      return policyReply("Limit preview rejected", "That person, team, or workspace is not inside the scope this identity is allowed to manage.");
    }
    return policyTargetStep(targets, values);
  }
  const explicitAmounts = values.requests !== undefined || values.tokens !== undefined;
  const metric = parsePolicyMetric(values.metric ?? values.m);
  if (!explicitAmounts && !metric) return policyMetricStep(target, values, targets);
  const window = parseRateWindow(values.window ?? expandPolicyWindow(values.w));
  if (!window) return policyWindowStep(target, metric, values, targets);
  const amountValues = {
    ...values,
    ...(metric ? { metric } : {}),
    ...((values.amount ?? values.a) === undefined ? {} : { amount: values.amount ?? values.a }),
  };
  const amounts = parsePolicyAmounts(amountValues);
  if (!amounts) {
    if (explicitAmounts || values.amount !== undefined || values.a !== undefined) {
      return policyReply("Limit preview rejected", "Choose a positive whole number for the allowance.");
    }
    return policyAmountStep(target, metric!, window, values, targets);
  }
  const policy: GatewayGovernanceRateLimit = { subject: target.subject, window, ...amounts };
  try {
    const draft = await ctx.enterprise.policyStore.createDraft({ actor, policy });
    return await renderPolicyPreview(ctx, message, assignment, actor, target, draft);
  } catch {
    return policyReply("Limit preview rejected", "The requested policy could not be validated or stored.");
  }
}

async function renderPolicyPreview(
  ctx: CommandContext,
  message: SurfaceMessage,
  assignment: GatewayGovernanceAssignment,
  _actor: GatewayPolicyActor,
  target: GatewayPolicyTarget,
  draft: Awaited<ReturnType<GatewayEnterpriseRuntime["policyStore"]["createDraft"]>>,
): Promise<SurfaceReply> {
  const nowMs = Date.now();
  const bounds = coreEnterpriseWindowBounds(draft.policy.window, nowMs);
  const base = `${draft.policy.subject.kind}:${draft.policy.subject.id}:${bounds.key}`;
  const used = await ctx.enterprise!.rateLimitStore.readRateLimit({ key: `gateway:${base}:runs`, windowStartMs: bounds.startMs, nowMs });
  const usedTokens = await ctx.enterprise!.rateLimitStore.readRateLimit({ key: `gateway:${base}:tokens`, windowStartMs: bounds.startMs, nowMs });
  const existing = (await gatewayGovernanceRateLimits(ctx.gateway, ctx.enterprise)).filter((limit) => limit.subject.kind === target.subject.kind && limit.subject.id === target.subject.id && limit.window === draft.policy.window);
  const existingRequests = existing.flatMap((limit) => limit.maxRuns === undefined ? [] : [limit.maxRuns]);
  const existingTokens = existing.flatMap((limit) => limit.maxTokens === undefined ? [] : [limit.maxTokens]);
  const effectiveRequests = [draft.policy.maxRuns, ...existingRequests].filter((value): value is number => value !== undefined);
  const effectiveTokens = [draft.policy.maxTokens, ...existingTokens].filter((value): value is number => value !== undefined);
  return policyPresentation({
    kind: "form",
    title: "Review this limit",
    summary: `Nothing has changed yet. Check the impact for ${target.label}, then apply it only if it matches what you intended.`,
    tables: [{
      id: "policy-preview",
      title: "What will change",
      columns: ["Applies to", "Resets", "Requests used", "Request limit", "Tokens used", "Token limit"],
      rows: [[
        target.label,
        humanPolicyWindow(draft.policy.window),
        `${used}`,
        formatLimit(draft.policy.maxRuns),
        `${usedTokens}`,
        formatLimit(draft.policy.maxTokens),
      ]],
    }],
    notice: [
      `After approval, the effective request limit will be ${effectiveRequests.length ? Math.min(...effectiveRequests) : "unlimited"}.`,
      `The effective token limit will be ${effectiveTokens.length ? Math.min(...effectiveTokens) : "unlimited"}.`,
      `This preview expires ${humanExpiry(draft.expiresAt)}. Nothing is enforced until you choose Apply.`,
    ].join("\n"),
    actions: [{ id: "apply", label: "Apply this preview", command: `/limits apply ${draft.token}`, style: "primary", kind: "confirm" }, { id: "limits", label: "Cancel", command: "/limits" }],
    privacy: { rawPromptsIncluded: false, note: "Preview includes only policy metadata and gateway counters; raw prompts remain hidden." },
  });
}

function resolveCommandAssignment(ctx: CommandContext, message: SurfaceMessage): GatewayGovernanceAssignment {
  const assignments = ctx.gateway?.governance?.assignments ?? {};
  return assignments[`${message.surfaceId}:${message.senderId}`] ?? assignments[message.senderId] ?? assignments[ctx.paired.pairingId] ?? assignments.default ?? {};
}

function parsePolicyArguments(tokens: readonly string[]): Record<string, string> | undefined {
  const values: Record<string, string> = {};
  for (const token of tokens) {
    const separator = token.indexOf("=");
    if (separator <= 0) return undefined;
    const key = token.slice(0, separator).toLowerCase();
    const raw = token.slice(separator + 1);
    if (!raw || values[key] !== undefined) return undefined;
    try { values[key] = decodeURIComponent(raw); } catch { return undefined; }
  }
  return values;
}

function selectPolicyTarget(
  requested: string | undefined,
  targets: readonly GatewayPolicyTarget[],
  ctx: CommandContext,
  message: SurfaceMessage,
  assignment: GatewayGovernanceAssignment,
): GatewayPolicyTarget | undefined {
  if (!requested) return undefined;
  const normalized = requested.trim();
  if (normalized === "user:self") {
    const identity = ctx.paired.identity?.provider === "frappe" ? ctx.paired.identity : undefined;
    const self = identity?.user ?? assignment.userId ?? message.senderId;
    return targets.find((target) => target.subject.kind === "user" && target.subject.id === self);
  }
  const separator = normalized.indexOf(":");
  if (separator <= 0) return undefined;
  const kind = normalized.slice(0, separator);
  const id = normalized.slice(separator + 1);
  return targets.find((target) => target.subject.kind === kind && target.subject.id === id);
}

function selectPolicyTargetFromValues(
  values: Readonly<Record<string, string>>,
  targets: readonly GatewayPolicyTarget[],
  ctx: CommandContext,
  message: SurfaceMessage,
  assignment: GatewayGovernanceAssignment,
): GatewayPolicyTarget | undefined {
  if (values.scope !== undefined) return selectPolicyTarget(values.scope, targets, ctx, message, assignment);
  if (values.t === undefined || !/^\d+$/.test(values.t)) return undefined;
  const index = Number(values.t);
  return Number.isSafeInteger(index) ? targets[index] : undefined;
}

function policyTargetStep(targets: readonly GatewayPolicyTarget[], values: Readonly<Record<string, string>>): SurfaceReply {
  if (!targets.length) return policyReply("No manageable scope found", "This identity does not currently have a proven person, team, channel, or site scope where it can configure limits.");
  const requestedPage = positiveAmount(values.p) ?? 1;
  const pageSize = targets.length <= 3 ? 3 : 2;
  const pages = Math.max(1, Math.ceil(targets.length / pageSize));
  const page = Math.min(requestedPage, pages);
  const offset = (page - 1) * pageSize;
  const actions: SurfaceAction[] = targets.slice(offset, offset + pageSize).map((target, localIndex) => ({
    id: `limit-target-${offset + localIndex}`,
    label: target.label,
    command: `/limits set t=${offset + localIndex}`,
    kind: "drilldown",
  }));
  if (pages > 1) {
    actions.push({
      id: "limit-target-more",
      label: page === pages ? "Start from the first choices" : "Show more choices",
      command: `/limits set p=${page === pages ? 1 : page + 1}`,
      kind: "page",
    });
  }
  return policyPresentation({
    kind: "menu",
    title: "Who should this apply to?",
    summary: "Choose a person, team, or work area you are allowed to manage. Anything outside your verified access stays hidden.",
    actions,
    privacy: { rawPromptsIncluded: false, note: "Choices come only from the identity and reporting scope already proven for this chat." },
  });
}

function policyMetricStep(
  target: GatewayPolicyTarget,
  _values: Readonly<Record<string, string>>,
  targets: readonly GatewayPolicyTarget[],
): SurfaceReply {
  const targetIndex = targets.indexOf(target);
  return policyPresentation({
    kind: "menu",
    title: "What should be controlled?",
    summary: `For ${target.label}, choose whether to control how often the assistant can be used or how many model tokens it can consume.`,
    actions: [
      { id: "limit-metric-requests", label: "Number of requests", command: `/limits set t=${targetIndex} m=r`, kind: "drilldown" },
      { id: "limit-metric-tokens", label: "Token allowance", command: `/limits set t=${targetIndex} m=t`, kind: "drilldown" },
      { id: "limit-metric-back", label: "Choose someone else", command: "/limits set", kind: "page" },
    ],
  });
}

function policyWindowStep(
  target: GatewayPolicyTarget,
  metric: "requests" | "tokens" | undefined,
  values: Readonly<Record<string, string>>,
  targets: readonly GatewayPolicyTarget[],
): SurfaceReply {
  if (!metric) return policyReply("Choose a time period", "Open /limits and use the guided setup so the allowance and reset period stay together.");
  const targetIndex = targets.indexOf(target);
  const metricKey = metric === "requests" ? "r" : "t";
  const alternate = values.p === "2";
  const actions: SurfaceAction[] = alternate
    ? [
        { id: "limit-window-hour", label: "Every hour", command: `/limits set t=${targetIndex} m=${metricKey} w=h`, kind: "drilldown" },
        { id: "limit-window-minute", label: "Every minute", command: `/limits set t=${targetIndex} m=${metricKey} w=i`, kind: "drilldown" },
        { id: "limit-window-common", label: "Show common periods", command: `/limits set t=${targetIndex} m=${metricKey}`, kind: "page" },
      ]
    : [
        { id: "limit-window-day", label: "Every day", command: `/limits set t=${targetIndex} m=${metricKey} w=d`, kind: "drilldown" },
        { id: "limit-window-month", label: "Every month", command: `/limits set t=${targetIndex} m=${metricKey} w=o`, kind: "drilldown" },
        { id: "limit-window-more", label: "Other time periods", command: `/limits set t=${targetIndex} m=${metricKey} p=2`, kind: "page" },
      ];
  return policyPresentation({
    kind: "menu",
    title: "When should the allowance reset?",
    summary: `${target.label} will get a fresh ${metric === "requests" ? "request" : "token"} allowance at the start of each chosen period.`,
    actions,
  });
}

function policyAmountStep(
  target: GatewayPolicyTarget,
  metric: "requests" | "tokens",
  window: GatewayGovernanceRateWindow,
  values: Readonly<Record<string, string>>,
  targets: readonly GatewayPolicyTarget[],
): SurfaceReply {
  const targetIndex = targets.indexOf(target);
  const metricKey = metric === "requests" ? "r" : "t";
  const windowKey = compactPolicyWindow(window);
  const alternate = values.p === "2";
  const presets = metric === "requests"
    ? alternate ? [500, 1_000] : [25, 100]
    : alternate ? [1_000_000, 5_000_000] : [50_000, 250_000];
  const actions: SurfaceAction[] = presets.map((amount) => ({
    id: `limit-amount-${amount}`,
    label: formatPolicyAmount(amount, metric),
    command: `/limits set t=${targetIndex} m=${metricKey} w=${windowKey} a=${amount}`,
    kind: "drilldown",
  }));
  actions.push({
    id: "limit-amount-more",
    label: alternate ? "Show smaller allowances" : "Show larger allowances",
    command: `/limits set t=${targetIndex} m=${metricKey} w=${windowKey} p=${alternate ? 1 : 2}`,
    kind: "page",
  });
  return policyPresentation({
    kind: "menu",
    title: "Choose the allowance",
    summary: `${target.label} will receive this many ${metric === "requests" ? "requests" : "tokens"} every ${humanPolicyWindow(window)}. You will review the impact before anything changes.`,
    actions,
  });
}

function parsePolicyMetric(value: string | undefined): "requests" | "tokens" | undefined {
  if (value === "requests" || value === "r") return "requests";
  if (value === "tokens" || value === "t") return "tokens";
  return undefined;
}

function expandPolicyWindow(value: string | undefined): string | undefined {
  if (value === "i") return "minute";
  if (value === "h") return "hour";
  if (value === "d") return "day";
  if (value === "o") return "month";
  return value;
}

function compactPolicyWindow(value: GatewayGovernanceRateWindow): string {
  if (value === "minute") return "i";
  if (value === "hour") return "h";
  if (value === "day") return "d";
  return "o";
}

function humanPolicyWindow(value: GatewayGovernanceRateWindow): string {
  return value;
}

function formatPolicyAmount(value: number, metric: "requests" | "tokens"): string {
  return `${value.toLocaleString("en-US")} ${metric}`;
}

function humanExpiry(value: string): string {
  const remainingMs = Date.parse(value) - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return "shortly";
  const minutes = Math.max(1, Math.round(remainingMs / 60_000));
  return `in about ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function humanPolicyTarget(
  kind: string,
  id: string,
  ctx: CommandContext,
  assignment: GatewayGovernanceAssignment,
  message: SurfaceMessage,
): string {
  const matched = permittedGatewayPolicyTargets({ message, paired: ctx.paired, assignment, agentId: ctx.profile })
    .find((target) => target.subject.kind === kind && target.subject.id === id);
  return matched?.label ?? `${kind} scope`;
}

function parseRateWindow(value: string | undefined): GatewayGovernanceRateWindow | undefined {
  return value === "minute" || value === "hour" || value === "day" || value === "month" ? value : undefined;
}

function parsePolicyAmounts(values: Readonly<Record<string, string>>): Pick<GatewayGovernanceRateLimit, "maxRuns" | "maxTokens"> | undefined {
  const requests = positiveAmount(values.requests);
  const tokens = positiveAmount(values.tokens);
  if (values.metric !== undefined || values.amount !== undefined) {
    if (requests !== undefined || tokens !== undefined || !values.metric || values.amount === undefined) return undefined;
    const amount = positiveAmount(values.amount);
    if (amount === undefined) return undefined;
    if (values.metric === "requests") return { maxRuns: amount };
    if (values.metric === "tokens") return { maxTokens: amount };
    return undefined;
  }
  if (requests === undefined && tokens === undefined) return undefined;
  return { ...(requests === undefined ? {} : { maxRuns: requests }), ...(tokens === undefined ? {} : { maxTokens: tokens }) };
}

function positiveAmount(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : undefined;
}

function formatPolicySubject(kind: string, id: string): string {
  return `${kind}:${id}`;
}

function formatLimit(value: number | undefined): string {
  return value === undefined ? "Uncapped" : String(value);
}

function policyReply(title: string, summary: string): SurfaceReply {
  return policyPresentation({ kind: "status", title, summary, privacy: { rawPromptsIncluded: false, note: "Policy metadata only; raw prompts remain hidden." } });
}

function policyPresentation(presentation: SurfacePresentation): SurfaceReply {
  return { text: renderPresentationText(presentation), presentation };
}

async function dispatchFrappePair(args: string, message: SurfaceMessage, ctx: CommandContext): Promise<SurfaceReply> {
  const coordinator = ctx.frappeOAuth;
  if (!coordinator || coordinator.connectionIds().length === 0) {
    return presentationReply({
      kind: "status",
      title: "Frappe connection unavailable",
      summary: "This Muster deployment has no Frappe OAuth connection configured.",
      notice: "Ask an operator to configure a Frappe OAuth connection before employee data can be used.",
    });
  }

  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const requestedAction = tokens[0]?.toLowerCase();
  const action = ["start", "status", "disconnect", "restart"].includes(requestedAction ?? "")
    ? tokens.shift()!.toLowerCase()
    : "start";
  const requestedConnection = tokens.shift();
  if (tokens.length) return connectionUsage(coordinator.connectionIds());
  const connectionId = selectFrappeConnection(requestedConnection, coordinator, ctx.gateway);
  if (!connectionId) return connectionUsage(coordinator.connectionIds());
  const actor: FrappeOAuthActor = {
    surfaceId: message.surfaceId,
    senderId: message.senderId,
    pairingId: ctx.paired.pairingId,
  };

  if (action === "disconnect") {
    try {
      const removedGrant = await coordinator.disconnect(connectionId, actor);
      const removedIdentity = await clearTrustedFrappePairingIdentity(message.surfaceId, message.senderId, ctx.cwd);
      return presentationReply({
        kind: "status",
        title: "Frappe disconnected",
        summary: removedGrant || removedIdentity
          ? `Connection ${connectionId} and its bound Frappe identity were removed from this channel sender.`
          : `Connection ${connectionId} was not connected for this channel sender.`,
        actions: [{ id: "pair", label: "Pair again", command: `/pair start ${connectionId}` }],
      });
    } catch {
      return presentationReply({
        kind: "status",
        title: "Frappe disconnect failed",
        summary: `Connection ${connectionId} could not be fully removed.`,
        actions: [{ id: "disconnect", label: "Retry disconnect", command: `/pair disconnect ${connectionId}` }],
      });
    }
  }

  if (action === "restart") {
    try {
      await coordinator.disconnect(connectionId, actor);
      await clearTrustedFrappePairingIdentity(message.surfaceId, message.senderId, ctx.cwd);
    } catch {
      return presentationReply({
        kind: "status",
        title: "Frappe restart failed",
        summary: `Connection ${connectionId} could not be reset for a new authorization.`,
        actions: [{ id: "restart", label: "Retry", command: `/pair restart ${connectionId}` }],
      });
    }
    return startFrappePairing(connectionId, actor, ctx);
  }

  try {
    const completion = await coordinator.complete(connectionId, actor);
    if (completion.status === "connected") {
      const paired = await upsertTrustedFrappePairing(message.surfaceId, message.senderId, completion.identity, ctx.cwd);
      return connectedReply(connectionId, paired.identity);
    }
    if (completion.status === "pending") return pendingReply(connectionId, completion.expiresAt);
    if (action === "status") return expiredReply(connectionId);
  } catch {
    return failedReply(connectionId);
  }

  return startFrappePairing(connectionId, actor, ctx);
}

async function startFrappePairing(
  connectionId: string,
  actor: FrappeOAuthActor,
  ctx: CommandContext,
): Promise<SurfaceReply> {
  try {
    const started = await ctx.frappeOAuth!.start(connectionId, actor);
    return presentationReply({
      kind: "form",
      title: "Connect Frappe",
      summary: `Connection ${connectionId} needs one Frappe authorization for this channel sender.`,
      notice: [
        "Open this private authorization link, sign in, and approve once:",
        started.authorizationUrl,
        `Expires: ${started.expiresAt}`,
        `Then run /pair status ${connectionId}.`,
      ].join("\n"),
      actions: [
        { id: "finish", label: "Finish connection", command: `/pair status ${connectionId}` },
        { id: "restart", label: "Start over", command: `/pair restart ${connectionId}` },
      ],
    });
  } catch {
    return failedReply(connectionId);
  }
}

function pendingReply(connectionId: string, expiresAt: string): SurfaceReply {
  return presentationReply({
    kind: "status",
    title: "Frappe authorization pending",
    summary: `Connection ${connectionId} is waiting for Frappe consent.`,
    notice: `Expires: ${expiresAt}. After approving in Frappe, run /pair status ${connectionId}.`,
    actions: [
      { id: "finish", label: "Finish connection", command: `/pair status ${connectionId}` },
      { id: "restart", label: "Start over", command: `/pair restart ${connectionId}` },
    ],
  });
}

function expiredReply(connectionId: string): SurfaceReply {
  return presentationReply({
    kind: "status",
    title: "Frappe authorization expired",
    summary: `Connection ${connectionId} is not connected; no Frappe identity was bound.`,
    actions: [{ id: "restart", label: "Start a new authorization", command: `/pair restart ${connectionId}` }],
  });
}

function failedReply(connectionId: string): SurfaceReply {
  return presentationReply({
    kind: "status",
    title: "Frappe authorization failed",
    summary: `Connection ${connectionId} could not be completed; no Frappe identity was bound.`,
    actions: [{ id: "restart", label: "Try again", command: `/pair restart ${connectionId}` }],
  });
}

function selectFrappeConnection(
  requested: string | undefined,
  coordinator: FrappeOAuthCoordinator,
  gateway: GatewayConfig | undefined,
): string | undefined {
  const ids = coordinator.connectionIds();
  if (requested) return ids.includes(requested) ? requested : undefined;
  const preferred = gateway?.frappe?.oauth?.defaultConnection;
  if (preferred && ids.includes(preferred)) return preferred;
  return ids.length === 1 ? ids[0] : undefined;
}

function connectedReply(connectionId: string, identity: PairedSender["identity"]): SurfaceReply {
  if (!identity || identity.provider !== "frappe") {
    return failedReply(connectionId);
  }
  return presentationReply({
    kind: "status",
    title: "Frappe connected",
    summary: `Connection ${connectionId} is authorized for this channel sender.`,
    tables: [{
      id: "identity",
      title: "Confirmed Frappe identity",
      columns: ["Field", "Confirmed value"],
      rows: [
        ["Site", identity.site],
        ["Frappe User", identity.user],
        ["Employee", identity.employeeName
          ? `${identity.employeeName}${identity.employee ? ` (${identity.employee})` : ""}`
          : identity.employee ?? "not linked"],
        ["Employee status", identity.employeeStatus ?? "not linked"],
      ],
    }],
    actions: [
      { id: "whoami", label: "Verify identity", command: "/whoami" },
      { id: "disconnect", label: "Disconnect", command: `/pair disconnect ${connectionId}`, style: "danger" },
    ],
  });
}

function connectionUsage(ids: readonly string[] = []): SurfaceReply {
  return presentationReply({
    kind: "status",
    title: "Pair Frappe",
    summary: "Choose one configured Frappe connection.",
    notice: ids.length
      ? `Connections: ${ids.join(", ")}. Use /pair start <connection-id>.`
      : "No matching Frappe connection was found.",
  });
}

function presentationReply(presentation: SurfacePresentation): SurfaceReply {
  return { text: renderPresentationText(presentation), presentation };
}

async function clearCommandSessionHandles(ctx: CommandContext): Promise<number> {
  const keys = [...new Set([ctx.conversationKey, ctx.legacyConversationKey].filter((key): key is string => Boolean(key)))];
  let removed = 0;
  for (const key of keys) removed += await invalidateNativeConversation(key, ctx.cwd);
  return removed;
}
