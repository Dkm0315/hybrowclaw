import type { GatewayConfig, GatewayGovernanceAssignment, GatewayGovernanceRateLimit } from "./gateway-config.js";
import type { PairedIdentity, PairedSender } from "./pairing.js";
import type { SurfaceMessage, SurfaceReply } from "./envelope.js";
import {
  aggregateEnterpriseUsage,
  enterpriseWindowBounds,
  type EnterpriseActionReceipt,
  type EnterpriseSubject,
  type EnterpriseUsageEvent,
  type MusterConfig,
} from "@musterhq/core";
import { commandPage, paginateRows, renderPresentationText } from "./presentation.js";
import { gatewayEnterpriseSubjects, usageEventsForSubjects, type GatewayEnterpriseRuntime } from "./enterprise-runtime.js";
import type {
  PresentationAudience,
  PresentationFilter,
  PresentationKpi,
  PresentationPagination,
  PresentationTrend,
  SurfaceAction,
  SurfacePresentation,
  SurfaceWorkStatus,
} from "./presentation.js";

export type InteractionCommandName =
  | "help"
  | "start"
  | "status"
  | "whoami"
  | "tools"
  | "reports"
  | "tokens"
  | "usage"
  | "limits"
  | "security"
  | "evals"
  | "index"
  | "settings"
  | "approvals"
  | "audit"
  | "incidents"
  | "providers"
  | "models"
  | "plugins"
  | "skills"
  | "mcp"
  | "channels"
  | "agents"
  | "artifacts"
  | "sessions"
  | "memory";

interface InteractionContext {
  readonly command: InteractionCommandName;
  readonly args: string;
  readonly config: MusterConfig;
  readonly profile: string;
  readonly runtime: string;
  readonly model: string;
  readonly paired: PairedSender;
  readonly message: SurfaceMessage;
  readonly gateway?: GatewayConfig;
  readonly enterprise?: GatewayEnterpriseRuntime;
}

interface InteractionAction {
  readonly label: string;
  readonly detail?: string;
  readonly command?: string;
  readonly style?: "default" | "primary" | "danger";
  readonly kind?: SurfaceAction["kind"];
}

interface InteractionTable {
  readonly id?: string;
  readonly title?: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly pagination?: PresentationPagination;
}

interface InteractionCard {
  readonly kind?: SurfacePresentation["kind"];
  readonly title: string;
  readonly lead: string;
  readonly audience?: PresentationAudience;
  readonly body?: readonly string[];
  readonly table?: InteractionTable;
  readonly tables?: readonly InteractionTable[];
  readonly kpis?: readonly PresentationKpi[];
  readonly trends?: readonly PresentationTrend[];
  readonly filters?: readonly PresentationFilter[];
  readonly drilldowns?: readonly InteractionAction[];
  readonly work?: SurfaceWorkStatus;
  readonly privacy?: SurfacePresentation["privacy"];
  readonly next?: readonly InteractionAction[];
  readonly note?: string;
}

export interface InteractionCommandDescriptor {
  readonly name: InteractionCommandName;
  readonly summary: string;
  readonly capability?: string;
  readonly minimumRole?: "manager" | "system";
}

export const INTERACTION_COMMANDS: readonly InteractionCommandDescriptor[] = [
  { name: "start", summary: "Open the role-aware home view" },
  { name: "status", summary: "Connection, runtime, and session" },
  { name: "whoami", summary: "Resolved user and employee identity" },
  { name: "tools", summary: "Tools available to this identity" },
  { name: "reports", summary: "Reports, filters, exports, and drill-downs" },
  { name: "tokens", summary: "Token ledger and usage controls", capability: "tokens" },
  { name: "usage", summary: "Personal or team usage", capability: "tokens" },
  { name: "limits", summary: "Rate and token limits", capability: "governance" },
  { name: "security", summary: "Permissions and safety controls", capability: "governance" },
  { name: "evals", summary: "Eval gates and quality checks", capability: "evals" },
  { name: "index", summary: "Index freshness and controls", capability: "index" },
  { name: "settings", summary: "Response and workflow preferences" },
  { name: "approvals", summary: "Pending and recent approvals", capability: "approvals" },
  { name: "audit", summary: "Governance events and exports", capability: "audit", minimumRole: "manager" },
  { name: "incidents", summary: "Failures, denials, and response actions", capability: "incidents", minimumRole: "manager" },
  { name: "providers", summary: "Configured provider routes", capability: "providers" },
  { name: "models", summary: "Configured models and routing", capability: "providers" },
  { name: "plugins", summary: "Configured plugins", capability: "plugins" },
  { name: "skills", summary: "Configured skills", capability: "skills" },
  { name: "mcp", summary: "Configured MCP servers", capability: "mcp" },
  { name: "channels", summary: "Configured operator channels", capability: "channels" },
  { name: "agents", summary: "Configured agent profiles", capability: "agents" },
  { name: "artifacts", summary: "Artifact creation and delivery", capability: "artifacts" },
  { name: "sessions", summary: "Conversation continuity and reset" },
  { name: "memory", summary: "Scoped memory controls", capability: "memory" },
  { name: "help", summary: "Show commands available to this identity" },
];

const CONTEXT_COMMANDS = INTERACTION_COMMANDS.map((descriptor) => descriptor.name);

export function isInteractionCommand(name: string): name is InteractionCommandName {
  return (CONTEXT_COMMANDS as readonly string[]).includes(name);
}

export async function renderInteractionCommand(ctx: InteractionContext): Promise<SurfaceReply> {
  const descriptor = INTERACTION_COMMANDS.find((candidate) => candidate.name === ctx.command);
  const card = descriptor && !descriptorVisible(descriptor, ctx)
    ? restrictedCard(descriptor)
    : await cardForCommand(ctx);
  const presentation = presentationForCard(card);
  return { text: renderPresentationText(presentation), presentation };
}

function descriptorVisible(descriptor: InteractionCommandDescriptor, ctx: InteractionContext): boolean {
  if (descriptor.name === "help") return true;
  const identity = ctx.paired.identity?.provider === "frappe" ? ctx.paired.identity : undefined;
  const assignment = governanceAssignment(ctx.gateway, ctx.message, ctx.paired);
  const tier = roleTier(identity, assignment?.roles);
  if (descriptor.minimumRole === "system" && !tier.system) return false;
  if (descriptor.minimumRole === "manager" && !tier.manager && !tier.hrbp && !tier.system) return false;
  const capabilities = assignment?.capabilities;
  if (capabilities !== undefined && descriptor.capability && !capabilities.includes("*") && !capabilities.includes(descriptor.capability)) return false;
  return true;
}

function restrictedCard(descriptor: InteractionCommandDescriptor): InteractionCard {
  return {
    kind: "status",
    title: "Command unavailable",
    lead: `/${descriptor.name} is not visible for this identity or capability assignment.`,
    table: {
      id: "access",
      columns: ["Requirement", "Value"],
      rows: compactRows([
        ["Role", descriptor.minimumRole],
        ["Capability", descriptor.capability],
      ]),
    },
    next: [
      { label: "/whoami", detail: "Check the resolved identity" },
      { label: "/help", detail: "Show commands available now" },
    ],
  };
}

function presentationForCard(card: InteractionCard): SurfacePresentation {
  const tables = [...(card.table ? [card.table] : []), ...(card.tables ?? [])].map((table, index) => ({
    id: table.id ?? `table-${index + 1}`,
    ...(table.title ? { title: table.title } : {}),
    columns: table.columns,
    rows: table.rows,
    ...(table.pagination ? { pagination: table.pagination } : {}),
  }));
  const actions = (card.next ?? []).map(normalizeInteractionAction).filter((action): action is SurfaceAction => action !== undefined);
  const drilldowns = (card.drilldowns ?? []).map(normalizeInteractionAction).filter((action): action is SurfaceAction => action !== undefined);
  const notice = compact([...(card.body ?? []), card.note]).join("\n");
  return {
    kind: card.kind ?? (tables.length ? "report" : "status"),
    title: card.title,
    summary: card.lead,
    ...(card.audience ? { audience: card.audience } : {}),
    ...(card.kpis?.length ? { kpis: card.kpis } : {}),
    ...(card.trends?.length ? { trends: card.trends } : {}),
    ...(tables.length ? { tables } : {}),
    ...(card.filters?.length ? { filters: card.filters } : {}),
    ...(drilldowns.length ? { drilldowns } : {}),
    ...(actions.length ? { actions } : {}),
    ...(card.work ? { work: card.work } : {}),
    ...(notice ? { notice } : {}),
    ...(card.privacy ? { privacy: card.privacy } : {}),
  };
}

function normalizeInteractionAction(action: InteractionAction, index: number): SurfaceAction | undefined {
  const command = action.command ?? (action.label.startsWith("/") ? action.label.split(/\s+/, 1)[0] : undefined);
  if (!command) return undefined;
  return {
    id: `action-${index + 1}-${command.slice(1).replace(/[^a-z0-9]+/gi, "-")}`,
    label: action.label,
    command,
    ...(action.detail ? { detail: action.detail } : {}),
    ...(action.style ? { style: action.style } : {}),
    ...(action.kind ? { kind: action.kind } : {}),
  };
}

async function cardForCommand(ctx: InteractionContext): Promise<InteractionCard> {
  const identity = ctx.paired.identity?.provider === "frappe" ? ctx.paired.identity : undefined;
  switch (ctx.command) {
    case "start":
      return startCard(ctx, identity);
    case "status":
      return statusCard(ctx, identity);
    case "whoami":
      return whoamiCard(ctx, identity);
    case "tools":
      return toolsCard(ctx, identity);
    case "reports":
      return reportsCard(ctx, identity);
    case "tokens":
    case "usage":
      return usageCard(ctx, identity);
    case "limits":
      return limitsCard(ctx, identity);
    case "security":
      return securityCard(ctx, identity);
    case "evals":
      return evalsCard(ctx, identity);
    case "index":
      return indexCard(identity);
    case "settings":
      return settingsCard(ctx, identity);
    case "approvals":
      return governanceQueueCard(ctx, "Approvals", "Review pending and recent approval decisions for the scopes you are allowed to see.", identity, "/approvals");
    case "audit":
      return governanceQueueCard(ctx, "Audit", "Inspect governed actions, denials, configuration changes, and exports without exposing raw prompts by default.", identity, "/audit");
    case "incidents":
      return governanceQueueCard(ctx, "Incidents", "Inspect failed runs, policy denials, delivery failures, and recovery actions.", identity, "/incidents");
    case "providers":
      return providersCard(ctx);
    case "models":
      return modelsCard(ctx);
    case "plugins":
      return configuredEntriesCard("Plugins", ctx.config.plugins?.entries, "/plugins", "plugin policy");
    case "skills":
      return configuredEntriesCard("Skills", ctx.config.skills?.entries, "/skills", "skill runtime");
    case "mcp":
      return configuredEntriesCard("MCP servers", ctx.config.tools?.mcp?.servers, "/mcp", "MCP server");
    case "channels":
      return channelsCard(ctx);
    case "agents":
      return agentsCard(ctx);
    case "artifacts":
      return artifactsCard(ctx);
    case "sessions":
      return sessionsCard(ctx);
    case "memory":
      return memoryCard(ctx, identity);
    case "help":
      return helpCard(ctx, identity);
  }
}

function startCard(ctx: InteractionContext, identity: PairedIdentity | undefined): InteractionCard {
  if (!identity) {
    return {
      title: "Ready",
      lead: `You are connected on profile "${ctx.profile}". I can help with normal agent work from here.`,
      body: [`Runtime: ${ctx.runtime}`, `Model: ${ctx.model}`, "Frappe is not connected for this sender yet, so ERPNext/Frappe tools are hidden."],
      next: [
        { label: "/tools", detail: "Show tools available right now" },
        { label: "/status", detail: "Check connection and runtime" },
        { label: "Ask normally", detail: "Send the work you want done" },
      ],
    };
  }
  return {
    title: "Ready",
    lead: `You are connected as ${identity.employeeName ?? identity.user}. I will only show tools allowed for this Frappe identity.`,
    body: compact([
      `Site: ${identity.site}`,
      `Employee: ${identity.employee ?? "not linked"}`,
      identity.department ? `Department: ${identity.department}` : undefined,
      `Runtime: ${ctx.runtime}`,
      `Model: ${ctx.model}`,
    ]),
    next: [
      { label: "/tools", detail: "Show role-aware tools" },
      { label: "/reports", detail: "Show reports you can request" },
      { label: "/tokens", detail: "Show token and usage controls" },
    ],
  };
}

function statusCard(ctx: InteractionContext, identity: PairedIdentity | undefined): InteractionCard {
  return {
    title: "Status",
    lead: identity
      ? "This chat is paired and Frappe-aware. Commands and tools are filtered by your resolved Frappe user, employee, and roles."
      : "This chat is paired, but no Frappe identity is attached yet.",
    table: {
      columns: ["Area", "Value"],
      rows: [
        ["Profile", ctx.profile],
        ["Runtime", ctx.runtime],
        ["Model", ctx.model],
        ["Surface", ctx.message.surfaceId],
        ["Pairing", ctx.paired.pairingId],
        ["Frappe site", identity?.site ?? "not connected"],
        ["Frappe user", identity?.user ?? "not connected"],
      ],
    },
    next: [
      { label: "/whoami", detail: "Show resolved user and employee identity" },
      { label: "/tools", detail: "Show available tools" },
      { label: "/security", detail: "Show safety controls" },
    ],
  };
}

function whoamiCard(_ctx: InteractionContext, identity: PairedIdentity | undefined): InteractionCard {
  if (!identity) {
    return {
      title: "Identity",
      lead: "I do not have a Frappe identity for this sender yet.",
      body: ["You can still use general agent features. Frappe records, reports, approvals, and employee-aware tools stay hidden until identity is connected."],
      next: [
        { label: "/status", detail: "Check current pairing" },
        { label: "/tools", detail: "Show non-Frappe tools" },
      ],
    };
  }
  return {
    title: "Identity",
    lead: "This is the identity I will use for permissions, reporting hierarchy, and tool visibility.",
    table: {
      columns: ["Field", "Value"],
      rows: compactRows([
        ["Frappe User", identity.user],
        ["Employee", identity.employee ?? "not linked"],
        ["Employee Name", identity.employeeName],
        ["Department", identity.department],
        ["Company", identity.company],
        ["Roles", identity.roles.length ? identity.roles.join(", ") : "none resolved"],
        ["Auth", identity.authMode ?? "not recorded"],
      ]),
    },
    next: [
      { label: "/tools", detail: "See tools available to this identity" },
      { label: "/reports", detail: "See report options for this role" },
    ],
  };
}

function toolsCard(ctx: InteractionContext, identity: PairedIdentity | undefined): InteractionCard {
  const assignment = governanceAssignment(ctx.gateway, ctx.message, ctx.paired);
  const tools = visibleTools(identity, assignment?.roles);
  return {
    title: "Tools",
    lead: identity
      ? "These are the tools available for your current Frappe identity and channel."
      : "These are the tools available before a Frappe site is connected.",
    table: {
      columns: ["No", "Tool", "What it can do"],
      rows: tools.map((tool, index) => [String(index + 1), tool.label, tool.detail]),
    },
    next: [
      { label: "Reply with a number", detail: "Open that tool's next step" },
      { label: "/reports", detail: "Show report-oriented tools" },
      { label: "/settings", detail: "Tune answer style where allowed" },
    ],
  };
}

async function reportsCard(ctx: InteractionContext, identity: PairedIdentity | undefined): Promise<InteractionCard> {
  const assignment = governanceAssignment(ctx.gateway, ctx.message, ctx.paired);
  const role = roleTier(identity, assignment?.roles);
  const audience: PresentationAudience = role.system ? "admin" : role.manager || role.hrbp ? "manager" : "self";
  const selectedArea = argumentValue(ctx.args, "area");
  const reportArgs = argumentsWithout(ctx.args, ["area", "page"]);
  if (selectedArea === "personal-usage") {
    return usageCard({ ...ctx, args: setArgument(reportArgs, "scope", "self") }, identity);
  }
  if (selectedArea === "artifacts") return artifactsCard(ctx);
  if (selectedArea === "team-usage" && (role.manager || role.hrbp || role.system)) {
    return usageCard({ ...ctx, args: setArgument(reportArgs, "scope", "team") }, identity);
  }
  if (selectedArea === "audit" && (role.manager || role.hrbp || role.system)) {
    return governanceQueueCard({ ...ctx, args: reportArgs }, "Audit", "Governed actions and outcomes for the authorized scope.", identity, "/audit");
  }
  if (selectedArea === "incidents" && (role.manager || role.hrbp || role.system)) {
    return governanceQueueCard({ ...ctx, args: reportArgs }, "Incidents", "Failures, policy denials, and recovery actions for the authorized scope.", identity, "/incidents");
  }
  if (selectedArea === "system-governance" && role.system) {
    return usageCard({ ...ctx, args: setArgument(reportArgs, "scope", "team") }, identity);
  }

  const areas = [
    { label: "Personal usage", value: "personal-usage", detail: "Requests, tokens, latency, and cache" },
    { label: "Artifacts", value: "artifacts", detail: "Generated files and delivery capability" },
    ...((role.manager || role.hrbp || role.system) ? [
      { label: "Team usage", value: "team-usage", detail: "Explicit reporting hierarchy only" },
      { label: "Audit", value: "audit", detail: "Governed actions and outcomes" },
      { label: "Incidents", value: "incidents", detail: "Failures, denials, and recovery" },
    ] : []),
    ...(role.system ? [{ label: "System governance", value: "system-governance", detail: "Tenant-authorized usage and controls" }] : []),
  ];
  const rows = areas.map((area, index) => [String(index + 1), area.label, area.detail]);
  return {
    kind: "report",
    title: "Reports",
    lead: "Choose a report area or open a drill-down. Every option runs against the scope this identity is allowed to see.",
    audience,
    table: { columns: ["No", "Report area", "Includes"], rows },
    filters: compact([
      commandFilter(ctx, "/reports", "area", "Report area", areas.map(({ label, value }) => ({ label, value }))),
      commandFilter(ctx, "/reports", "period", "Period", periodOptions()),
    ]),
    drilldowns: areas.slice(0, 5).map((area) => ({
      label: area.label,
      detail: area.detail,
      command: `/reports area=${encodeURIComponent(area.value)}`,
      kind: "drilldown" as const,
    })),
    next: [
      { label: "Refresh", detail: "Refresh authorized report data", command: "/reports", style: "primary" },
      { label: "/tokens", detail: "View usage and token reports" },
      { label: "/artifacts", detail: "Review export delivery" },
    ],
    privacy: { rawPromptsIncluded: false, note: "Manager reports omit raw prompts unless a separately audited incident workflow authorizes them." },
  };
}

async function usageCard(ctx: InteractionContext, identity: PairedIdentity | undefined): Promise<InteractionCard> {
  const assignment = governanceAssignment(ctx.gateway, ctx.message, ctx.paired);
  const role = roleTier(identity, assignment?.roles);
  const limitSnapshots = await readRateLimitSnapshots(ctx, assignment, identity, role, "current");
  const audience: PresentationAudience = role.system ? "admin" : role.manager || role.hrbp ? "manager" : "self";
  const requestedScope = argumentValue(ctx.args, "scope") ?? "self";
  const querySubjects = usageQuerySubjects(ctx, assignment, requestedScope);
  const querySubjectAny = usageQueryAnySubjects(assignment, requestedScope);
  const events = ctx.enterprise && (requestedScope === "self" || querySubjects.length > 0)
    ? await ctx.enterprise.usageStore.queryUsage({
      from: periodStart(argumentValue(ctx.args, "period")),
      subjects: querySubjects,
      subjectAny: querySubjectAny,
    })
    : [];
  const scopedEvents = filterUsageEvents(events, ctx, assignment, requestedScope);
  const visibleEvents = filterUsageDimensions(scopedEvents, ctx.args);
  const aggregation = aggregateEnterpriseUsage(visibleEvents, ["request_category", "provider", "outcome"]);
  const page = commandPage(ctx.args);
  const rows = aggregation.groups.map((group) => [
    group.dimensions.request_category ?? "uncategorized",
    group.dimensions.provider ?? "none",
    group.dimensions.outcome ?? "unknown",
    String(group.metrics.runs),
    String(group.metrics.totalTokens),
    formatDuration(group.metrics.p95LatencyMs),
  ]);
  const paged = paginateRows(rows, page, 8);
  const scopeDenied = requestedScope !== "self" && visibleEvents.length === 0 && !reportingScopeConfigured(assignment, role, identity);
  return {
    kind: "report",
    title: "Usage",
    lead: scopeDenied
      ? "Team usage is not available until an explicit reporting hierarchy or tenant reporting scope is assigned. Manager titles alone do not expose other users."
      : ctx.enterprise
        ? `Live gateway usage for the authorized ${requestedScope === "self" ? "personal" : "reporting"} scope.`
        : "Usage reporting needs an enterprise ledger runtime; no synthetic totals are shown.",
    audience,
    kpis: [
      { label: "Runs", value: String(aggregation.totals.runs) },
      { label: "Tokens", value: String(aggregation.totals.totalTokens) },
      { label: "p50", value: formatDuration(aggregation.totals.p50LatencyMs) },
      { label: "p95", value: formatDuration(aggregation.totals.p95LatencyMs) },
      { label: "p99", value: formatDuration(aggregation.totals.p99LatencyMs) },
      { label: "Cache hit", value: `${aggregation.totals.cacheHitRate}%` },
    ],
    tables: [
      {
        id: "usage",
        title: "Observed usage",
        columns: ["Category", "Provider", "Outcome", "Runs", "Tokens", "p95"],
        rows: paged.rows.length ? paged.rows : [["No observed runs", "—", "—", "0", "0", "0ms"]],
        pagination: paged.pagination,
      },
      {
        id: "usage-limits",
        title: "Configured limits",
        columns: ["Scope", "Window", "Requests", "Tokens", "Resets"],
        rows: limitSnapshots.length
          ? limitSnapshots.map(rateLimitSnapshotRow)
          : [["Current identity", "—", "No enforced cap", "No enforced cap", "—"]],
      },
    ],
    trends: [{
      id: "latency-percentiles",
      label: "Latency",
      unit: "ms",
      points: [
        { label: "p50", value: aggregation.totals.p50LatencyMs },
        { label: "p95", value: aggregation.totals.p95LatencyMs },
        { label: "p99", value: aggregation.totals.p99LatencyMs },
      ],
    }],
    filters: compact([
      commandFilter(ctx, "/usage", "period", "Period", periodOptions()),
      ...(audience === "self" ? [] : [commandFilter(ctx, "/usage", "scope", "Scope", [
        { label: "My usage", value: "self" },
        { label: "Authorized team", value: "team" },
      ])]),
      commandFilter(ctx, "/usage", "provider", "Provider", configuredProviderOptions(ctx, scopedEvents)),
      commandFilter(ctx, "/usage", "channel", "Channel", observedSubjectOptions(scopedEvents, "channel", (value) => {
        const surface = value.split(":", 1)[0];
        return { label: humanizeValue(surface), value: surface };
      })),
      commandFilter(ctx, "/usage", "outcome", "Outcome", observedValueOptions(scopedEvents.map((event) => event.outcome))),
      ...(audience === "self" ? [] : [commandFilter(
        { ...ctx, args: setArgument(ctx.args, "scope", "team") },
        "/usage",
        "user",
        "User",
        authorizedUserOptions(identity, assignment),
      )]),
    ]),
    drilldowns: [
      { label: "Limits", command: "/limits", kind: "drilldown" },
      { label: "Security", command: "/security", kind: "drilldown" },
    ],
    next: [
      { label: "Refresh personal usage", detail: "Requests, tokens, latency, cache, and artifacts", command: "/usage scope=self", style: "primary" },
      ...(audience === "self" ? [] : [{ label: "Team usage", detail: "Explicitly assigned reporting hierarchy", command: "/usage scope=team", kind: "drilldown" as const }]),
      { label: "/limits", detail: "Review rate and token limits" },
    ],
    privacy: { rawPromptsIncluded: false, note: "Manager views expose categories, consumption, latency, and outcomes—not raw prompt text." },
  };
}

async function limitsCard(ctx: InteractionContext, identity: PairedIdentity | undefined): Promise<InteractionCard> {
  const assignment = governanceAssignment(ctx.gateway, ctx.message, ctx.paired);
  const role = roleTier(identity, assignment?.roles);
  const visibility = role.manager || role.hrbp || role.system ? "authorized" : "current";
  const snapshots = await readRateLimitSnapshots(ctx, assignment, identity, role, visibility);
  const requestRemaining = snapshots
    .filter((snapshot) => snapshot.maxRuns !== undefined && snapshot.usedRuns !== undefined)
    .map((snapshot) => Math.max(0, snapshot.maxRuns! - snapshot.usedRuns!));
  const tokenRemaining = snapshots
    .filter((snapshot) => snapshot.maxTokens !== undefined && snapshot.usedTokens !== undefined)
    .map((snapshot) => Math.max(0, snapshot.maxTokens! - snapshot.usedTokens!));
  const subjectOptions = observedValueOptions(snapshots.map((snapshot) => snapshot.subjectKind));
  const windowOptions = observedValueOptions(snapshots.map((snapshot) => snapshot.window));
  return {
    kind: "report",
    title: "Limits",
    lead: snapshots.length
      ? "These are the enforced limits visible to this identity, read from the same atomic counters used before provider calls."
      : "No explicit request or token limit is configured for this identity. Muster is recording usage, but the gateway is not enforcing a cap here.",
    audience: role.system ? "admin" : role.manager || role.hrbp ? "manager" : "self",
    kpis: [
      { label: "Policies", value: String(snapshots.length) },
      { label: "Request balance", value: requestRemaining.length ? String(Math.min(...requestRemaining)) : "Uncapped", detail: "lowest visible remaining allowance" },
      { label: "Token balance", value: tokenRemaining.length ? String(Math.min(...tokenRemaining)) : "Uncapped", detail: "lowest visible remaining allowance" },
      { label: "Counter store", value: ctx.enterprise?.backend ?? "Unavailable", tone: ctx.enterprise ? "positive" : "warning" },
    ],
    table: {
      id: "limits",
      columns: ["Scope", "Window", "Requests", "Tokens", "Resets"],
      rows: snapshots.length
        ? snapshots.map(rateLimitSnapshotRow)
        : [["Current identity", "—", "No enforced cap", "No enforced cap", "—"]],
    },
    filters: compact([
      commandFilter(ctx, "/limits", "subject", "Scope type", subjectOptions),
      commandFilter(ctx, "/limits", "window", "Window", windowOptions),
    ]),
    next: [
      { label: "Refresh", detail: "Read counters again", command: commandWithArguments("/limits", ctx.args), style: "primary" },
      { label: "/usage", detail: "Compare allowance with observed token usage" },
      { label: "/security", detail: "Review related safety policy" },
    ],
    note: "Provider billing credits are separate from gateway token allowances and are shown only when a provider exposes a verifiable billing API.",
  };
}

function securityCard(ctx: InteractionContext, identity: PairedIdentity | undefined): InteractionCard {
  const assignment = governanceAssignment(ctx.gateway, ctx.message, ctx.paired);
  const role = roleTier(identity, assignment?.roles);
  const governance = ctx.gateway?.governance;
  const validation = governance?.requestValidation;
  return {
    title: "Security",
    lead: governance?.enabled
      ? "These are the controls currently enforced before a provider call."
      : "Pairing and Frappe permissions are active, but enterprise gateway governance is not enabled for this deployment.",
    table: {
      columns: ["Control", "State"],
      rows: [
        ["Pairing", "required before agent runs"],
        ["Frappe RBAC", identity ? "enabled for this sender" : "not connected"],
        ["Employee mapping", identity?.employee ? "linked" : "not linked"],
        ["Request validation", governance?.enabled ? `enabled · max ${validation?.maxChars ?? 16_000} characters` : "not enabled"],
        ["Secret detection", governance?.enabled && (validation?.blockSecrets ?? true) ? "blocking enabled" : "not enforced"],
        ["Rate policies", String(governance?.rateLimits?.length ?? 0)],
        ["Channel allowlist", assignment?.allowedChannels?.length ? `${assignment.allowedChannels.length} allowed` : "no explicit restriction"],
        ["Write actions", "preview + approval gate when a mutating workflow declares one"],
        ["Admin controls", role.system ? "available" : "hidden unless role allows"],
      ],
    },
    next: [
      { label: "/whoami", detail: "Verify identity and roles" },
      { label: "/limits", detail: "Review rate and token limits" },
      { label: "/evals", detail: "Review eval gates" },
    ],
  };
}

function evalsCard(ctx: InteractionContext, identity: PairedIdentity | undefined): InteractionCard {
  const assignment = governanceAssignment(ctx.gateway, ctx.message, ctx.paired);
  const role = roleTier(identity, assignment?.roles);
  return {
    title: "Evals",
    lead: role.manager || role.hrbp || role.system
      ? "Eval gates should be used before promoting a department assistant, response profile, or write workflow."
      : "Eval results are visible when your role allows managing or reviewing assistant behavior.",
    table: {
      columns: ["Area", "Purpose"],
      rows: [
        ["Frappe permissions", "Prove a user cannot see records outside scope"],
        ["CRUD workflows", "Check mandatory fields, previews, and approvals"],
        ["Reports", "Check filters, totals, and export behavior"],
        ["Security", "Check denied requests and leakage handling"],
      ],
    },
    next: [
      { label: "Run eval", detail: "Available when eval runner is configured" },
      { label: "View failures", detail: "Show workflows needing attention" },
      { label: "/settings", detail: "Tune response behavior after evals pass" },
    ],
  };
}

function indexCard(identity: PairedIdentity | undefined): InteractionCard {
  return {
    title: "Index",
    lead: identity
      ? "Frappe answers should use fast read models and only ask Frappe live when the cached/indexed view is not enough."
      : "Frappe indexing becomes available after a site identity is connected.",
    table: {
      columns: ["Job", "Purpose"],
      rows: [
        ["Hot sync", "Small recent changes and common CRUD/report data"],
        ["Metadata sync", "DocTypes, Custom Fields, Property Setters, workflows"],
        ["Permission sync", "Roles, employees, reporting hierarchy, shares"],
        ["Deep sync", "Attachments, policies, SOPs, large documents"],
      ],
    },
    next: [
      { label: "Check freshness", detail: "Show index lag when configured" },
      { label: "Reindex a topic", detail: "Choose module, DocType, or department" },
      { label: "/reports", detail: "Use indexed reports" },
    ],
  };
}

function settingsCard(ctx: InteractionContext, identity: PairedIdentity | undefined): InteractionCard {
  const assignment = governanceAssignment(ctx.gateway, ctx.message, ctx.paired);
  const role = roleTier(identity, assignment?.roles);
  return {
    title: "Settings",
    lead: role.manager || role.hrbp || role.system
      ? "You can tune how answers are shaped for your scope. I will preview the effect before applying changes."
      : "You can tune your own answer style where allowed. Department-wide settings require an authorized role.",
    table: {
      columns: ["Setting", "Options"],
      rows: [
        ["Response style", "Concise, table-first, manager summary, audit-heavy"],
        ["Default format", "Direct answer, table, report pack, artifact"],
        ["Follow-ups", "Ask missing fields, show filters, suggest exports"],
        ["Safety level", "Strict, balanced, read-only, approval-required"],
      ],
    },
    next: [
      { label: "Change my style", detail: "Applies only to this identity" },
      { label: "Change team style", detail: "Requires manager/HRBP/system role" },
      { label: "Preview change", detail: "Show sample before saving" },
    ],
  };
}

async function governanceQueueCard(
  ctx: InteractionContext,
  title: "Approvals" | "Audit" | "Incidents",
  lead: string,
  identity: PairedIdentity | undefined,
  command: string,
): Promise<InteractionCard> {
  const assignment = governanceAssignment(ctx.gateway, ctx.message, ctx.paired);
  const role = roleTier(identity, assignment?.roles);
  const audience: PresentationAudience = role.system ? "admin" : role.manager || role.hrbp ? "manager" : "self";
  const receiptScope = receiptQueryScope(ctx, assignment, role);
  const allReceipts = ctx.enterprise && receiptScope.subjects.length && (role.system && assignment?.canViewTenantUsage || receiptScope.subjectAny.length)
    ? await ctx.enterprise.receiptStore.listReceipts({
      from: periodStart(argumentValue(ctx.args, "period")),
      subjects: receiptScope.subjects,
      subjectAny: receiptScope.subjectAny,
    })
    : [];
  const visible = filterReceipts(allReceipts, ctx, assignment, role);
  const categoryMatches = visible.filter((receipt) => title === "Audit"
    || (title === "Incidents" ? receipt.outcome === "blocked" || receipt.outcome === "failed" : /approval/i.test(receipt.action)));
  const matching = filterReceiptDimensions(categoryMatches, ctx.args);
  const page = commandPage(ctx.args);
  const rows = matching.slice().reverse().map((receipt) => [
    receipt.occurredAt,
    receipt.action,
    receipt.outcome,
    receipt.policyIds.join(", ") || "—",
  ]);
  const paged = paginateRows(rows, page, 8);
  return {
    kind: "report",
    title,
    lead,
    audience,
    kpis: [
      { label: "Events", value: String(matching.length) },
      { label: "Visible scope", value: audience === "self" ? "Personal" : audience === "manager" ? "Explicit hierarchy" : "Authorized system scope" },
      { label: "Raw prompts", value: "Hidden", detail: "request fingerprints only" },
      { label: "Data source", value: ctx.enterprise?.backend ?? "Not connected", detail: "no sample values" },
    ],
    table: {
      id: title.toLowerCase(),
      columns: ["Time", "Action", "Outcome", "Policy"],
      rows: paged.rows.length ? paged.rows : [["No matching events", "—", "—", "—"]],
      pagination: paged.pagination,
    },
    filters: compact([
      commandFilter(ctx, command, "period", "Period", periodOptions()),
      commandFilter(ctx, command, "status", "Status", observedValueOptions(categoryMatches.map((receipt) => receipt.outcome))),
      ...(audience === "self" ? [] : [commandFilter(
        ctx,
        command,
        "scope",
        "Department or user",
        authorizedReportingScopeOptions(identity, assignment),
      )]),
    ]),
    next: [
      { label: "Refresh", detail: "Query the connected ledger", command, style: "primary" },
      { label: "/reports", detail: "Open report workflows" },
      { label: "/security", detail: "Review visibility rules" },
    ],
    privacy: { rawPromptsIncluded: false, note: "Manager views show categories and outcomes, not raw prompts." },
  };
}

function filterUsageEvents(
  events: readonly EnterpriseUsageEvent[],
  ctx: InteractionContext,
  assignment: GatewayGovernanceAssignment | undefined,
  requestedScope: string,
): readonly EnterpriseUsageEvent[] {
  const role = roleTier(ctx.paired.identity?.provider === "frappe" ? ctx.paired.identity : undefined, assignment?.roles);
  const boundary = reportingBoundary(ctx, assignment);
  if (requestedScope === "self") {
    const user = gatewayEnterpriseSubjects(ctx.message, ctx.paired, assignment).find((subject) => subject.kind === "user");
    const fallback = gatewayEnterpriseSubjects(ctx.message, ctx.paired, assignment).find((subject) => subject.kind === "channel");
    const scope = [user, boundary ?? fallback].filter((subject): subject is EnterpriseSubject => Boolean(subject));
    return user ? usageEventsForSubjects(events, scope) : [];
  }
  if (role.system && assignment?.canViewTenantUsage) {
    return boundary ? usageEventsForSubjects(events, [boundary]) : [];
  }
  if (!boundary) return [];
  const managedUsers = new Set(assignment?.managedUserIds ?? []);
  const managedDepartments = new Set(assignment?.managedDepartmentIds ?? []);
  if (!managedUsers.size && !managedDepartments.size) return [];
  return events.filter((event) => enterpriseEventHasSubject(event.subjects, boundary)
    && event.subjects.some((subject) =>
      (subject.kind === "user" && managedUsers.has(subject.id))
        || (subject.kind === "department" && managedDepartments.has(subject.id))));
}

function filterUsageDimensions(events: readonly EnterpriseUsageEvent[], args: string): readonly EnterpriseUsageEvent[] {
  const provider = argumentValue(args, "provider");
  const channel = argumentValue(args, "channel");
  const outcome = argumentValue(args, "outcome");
  const user = argumentValue(args, "user");
  return events.filter((event) => {
    if (outcome && event.outcome !== outcome) return false;
    if (provider && !event.subjects.some((subject) => subject.kind === "provider" && subject.id === provider)) return false;
    if (user && !event.subjects.some((subject) => subject.kind === "user" && subject.id === user)) return false;
    if (channel && !event.subjects.some((subject) => subject.kind === "channel" && (
      subject.id === channel || subject.id.startsWith(`${channel}:`)
    ))) return false;
    return true;
  });
}

function filterReceiptDimensions(receipts: readonly EnterpriseActionReceipt[], args: string): readonly EnterpriseActionReceipt[] {
  const status = argumentValue(args, "status");
  const scope = argumentValue(args, "scope");
  const [scopeKind, ...scopeIdParts] = (scope ?? "").split(":");
  const scopeId = scopeIdParts.join(":");
  return receipts.filter((receipt) => {
    if (status && receipt.outcome !== status) return false;
    if (scopeId && ![...receipt.actor, ...receipt.target].some((subject) => subject.kind === scopeKind && subject.id === scopeId)) return false;
    return true;
  });
}

function usageQuerySubjects(
  ctx: InteractionContext,
  assignment: GatewayGovernanceAssignment | undefined,
  requestedScope: string,
): readonly EnterpriseSubject[] {
  const subjects = gatewayEnterpriseSubjects(ctx.message, ctx.paired, assignment);
  const boundary = reportingBoundary(ctx, assignment);
  if (requestedScope !== "self") return boundary ? [boundary] : [];
  const user = subjects.find((subject) => subject.kind === "user");
  const fallback = subjects.find((subject) => subject.kind === "channel");
  return [user, boundary ?? fallback].filter((subject): subject is EnterpriseSubject => Boolean(subject));
}

function usageQueryAnySubjects(
  assignment: GatewayGovernanceAssignment | undefined,
  requestedScope: string,
): readonly EnterpriseSubject[] {
  if (requestedScope === "self" || assignment?.canViewTenantUsage) return [];
  return [
    ...(assignment?.managedUserIds ?? []).map((id) => ({ kind: "user" as const, id })),
    ...(assignment?.managedDepartmentIds ?? []).map((id) => ({ kind: "department" as const, id })),
  ];
}

function filterReceipts(
  receipts: readonly EnterpriseActionReceipt[],
  ctx: InteractionContext,
  assignment: GatewayGovernanceAssignment | undefined,
  role: ReturnType<typeof roleTier>,
): readonly EnterpriseActionReceipt[] {
  const self = gatewayEnterpriseSubjects(ctx.message, ctx.paired, assignment).find((subject) => subject.kind === "user")?.id;
  const boundary = reportingBoundary(ctx, assignment);
  if (role.system && assignment?.canViewTenantUsage) {
    return boundary ? receipts.filter((receipt) => enterpriseEventHasSubject([...receipt.actor, ...receipt.target], boundary)) : [];
  }
  const users = new Set([...(self ? [self] : []), ...(assignment?.managedUserIds ?? [])]);
  const departments = new Set(assignment?.managedDepartmentIds ?? []);
  const fallback = gatewayEnterpriseSubjects(ctx.message, ctx.paired, assignment).find((subject) => subject.kind === "channel");
  const scope = boundary ?? fallback;
  return scope ? receipts.filter((receipt) => {
    const subjects = [...receipt.actor, ...receipt.target];
    return enterpriseEventHasSubject(subjects, scope) && subjects.some((subject) =>
      (subject.kind === "user" && users.has(subject.id))
        || (subject.kind === "department" && departments.has(subject.id)));
  }) : [];
}

function receiptQueryScope(
  ctx: InteractionContext,
  assignment: GatewayGovernanceAssignment | undefined,
  role: ReturnType<typeof roleTier>,
): { readonly subjects: readonly EnterpriseSubject[]; readonly subjectAny: readonly EnterpriseSubject[] } {
  const self = gatewayEnterpriseSubjects(ctx.message, ctx.paired, assignment).find((subject) => subject.kind === "user");
  const boundary = reportingBoundary(ctx, assignment);
  const fallback = gatewayEnterpriseSubjects(ctx.message, ctx.paired, assignment).find((subject) => subject.kind === "channel");
  const required = boundary ?? fallback;
  if (!required) return { subjects: [], subjectAny: [] };
  if (role.system && assignment?.canViewTenantUsage) return { subjects: [required], subjectAny: [] };
  return {
    subjects: [required],
    subjectAny: [
      ...(self ? [self] : []),
      ...(assignment?.managedUserIds ?? []).map((id) => ({ kind: "user" as const, id })),
      ...(assignment?.managedDepartmentIds ?? []).map((id) => ({ kind: "department" as const, id })),
    ],
  };
}

function reportingBoundary(
  ctx: InteractionContext,
  assignment: GatewayGovernanceAssignment | undefined,
): EnterpriseSubject | undefined {
  if (assignment?.tenantId) return { kind: "tenant", id: assignment.tenantId };
  if (ctx.paired.identity?.provider === "frappe") return { kind: "site", id: ctx.paired.identity.site };
  if (assignment?.workspaceId) return { kind: "workspace", id: assignment.workspaceId };
  return undefined;
}

function enterpriseEventHasSubject(
  subjects: readonly EnterpriseSubject[],
  expected: EnterpriseSubject,
): boolean {
  return subjects.some((subject) => subject.kind === expected.kind && subject.id === expected.id);
}

function reportingScopeConfigured(
  assignment: GatewayGovernanceAssignment | undefined,
  role: ReturnType<typeof roleTier>,
  identity: PairedIdentity | undefined,
): boolean {
  const boundary = assignment?.tenantId || identity?.site || assignment?.workspaceId;
  return Boolean(boundary && ((role.system && assignment?.canViewTenantUsage)
    || assignment?.managedUserIds?.length
    || assignment?.managedDepartmentIds?.length));
}

function periodOptions(): Array<{ label: string; value: string }> {
  return [
    { label: "Today", value: "today" },
    { label: "7 days", value: "7d" },
    { label: "30 days", value: "30d" },
  ];
}

function commandFilter(
  ctx: InteractionContext,
  command: string,
  id: string,
  label: string,
  options: readonly { readonly label: string; readonly value: string }[],
): PresentationFilter | undefined {
  const unique = new Map<string, string>();
  for (const option of options) {
    const value = String(option.value ?? "").trim();
    if (value && !unique.has(value)) unique.set(value, String(option.label || value));
  }
  if (!unique.size) return undefined;
  const selected = argumentValue(ctx.args, id);
  return {
    id,
    label,
    ...(selected ? { selected: encodeURIComponent(selected) } : {}),
    options: [...unique].map(([value, optionLabel]) => ({ label: optionLabel, value: encodeURIComponent(value) })),
    action: {
      id: `filter-${command.slice(1)}-${id}`,
      label: `Apply ${label.toLowerCase()}`,
      command: commandWithFilter(ctx.args, command, id),
      kind: "filter",
    },
  };
}

function commandWithFilter(args: string, command: string, key: string): string {
  const rest = argumentsWithout(args, [key, "page"]);
  return [command, rest, `${key}={value}`].filter(Boolean).join(" ");
}

function commandWithArguments(command: string, args: string): string {
  return [command, args.trim()].filter(Boolean).join(" ");
}

function argumentsWithout(args: string, keys: readonly string[]): string {
  const blocked = new Set(keys);
  return args.split(/\s+/).filter((token) => {
    const separator = token.indexOf("=");
    return token && (separator <= 0 || !blocked.has(token.slice(0, separator)));
  }).join(" ");
}

function setArgument(args: string, key: string, value: string): string {
  const rest = argumentsWithout(args, [key]);
  return [rest, `${key}=${encodeURIComponent(value)}`].filter(Boolean).join(" ");
}

function observedValueOptions(values: readonly (string | undefined)[]): Array<{ label: string; value: string }> {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right))
    .map((value) => ({ label: humanizeValue(value), value }));
}

function observedSubjectOptions(
  events: readonly EnterpriseUsageEvent[],
  kind: EnterpriseSubject["kind"],
  transform: (value: string) => { readonly label: string; readonly value: string },
): Array<{ label: string; value: string }> {
  const options = new Map<string, string>();
  for (const event of events) {
    for (const subject of event.subjects) {
      if (subject.kind !== kind) continue;
      const option = transform(subject.id);
      if (option.value && !options.has(option.value)) options.set(option.value, option.label);
    }
  }
  return [...options].map(([value, label]) => ({ label, value }));
}

function configuredProviderOptions(ctx: InteractionContext, events: readonly EnterpriseUsageEvent[]): Array<{ label: string; value: string }> {
  const values = new Set(Object.keys(ctx.config.providers));
  for (const event of events) {
    for (const subject of event.subjects) if (subject.kind === "provider") values.add(subject.id);
  }
  return [...values].sort().map((value) => ({ label: value, value }));
}

function authorizedUserOptions(
  identity: PairedIdentity | undefined,
  assignment: GatewayGovernanceAssignment | undefined,
): Array<{ label: string; value: string }> {
  const self = assignment?.userId ?? identity?.user ?? identity?.employee;
  return [
    ...(self ? [{ label: identity?.employeeName ? `${identity.employeeName} (me)` : `${self} (me)`, value: self }] : []),
    ...(assignment?.managedUserIds ?? []).filter((value) => value !== self).map((value) => ({ label: value, value })),
  ];
}

function authorizedReportingScopeOptions(
  identity: PairedIdentity | undefined,
  assignment: GatewayGovernanceAssignment | undefined,
): Array<{ label: string; value: string }> {
  return [
    ...authorizedUserOptions(identity, assignment).map((option) => ({ label: option.label, value: `user:${option.value}` })),
    ...(assignment?.managedDepartmentIds ?? []).map((value) => ({ label: `Department: ${value}`, value: `department:${value}` })),
  ];
}

function humanizeValue(value: string): string {
  return value.replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function argumentValue(args: string, key: string): string | undefined {
  for (const token of args.split(/\s+/)) {
    const separator = token.indexOf("=");
    if (separator > 0 && token.slice(0, separator) === key) {
      try {
        return decodeURIComponent(token.slice(separator + 1));
      } catch {
        return token.slice(separator + 1);
      }
    }
  }
  return undefined;
}

function periodStart(period: string | undefined): string | undefined {
  const duration = period === "today" ? 24 * 60 * 60_000 : period === "7d" ? 7 * 24 * 60 * 60_000 : period === "30d" ? 30 * 24 * 60 * 60_000 : undefined;
  return duration ? new Date(Date.now() - duration).toISOString() : undefined;
}

function formatDuration(milliseconds: number): string {
  return milliseconds >= 1000 ? `${Math.round(milliseconds / 100) / 10}s` : `${milliseconds}ms`;
}

function providersCard(ctx: InteractionContext): InteractionCard {
  const rows = Object.values(ctx.config.providers).map((provider) => [provider.id, provider.kind, provider.defaultModel]);
  return {
    kind: "menu",
    title: "Providers",
    lead: "These provider routes are configured for this Muster deployment. Secrets are never rendered here.",
    table: { id: "providers", columns: ["Provider", "Kind", "Default model"], rows: rows.length ? rows : [["None", "—", "—"]] },
    next: [
      { label: "/models", detail: "Inspect configured model routes" },
      { label: "/settings", detail: "Review selection preferences" },
    ],
  };
}

function modelsCard(ctx: InteractionContext): InteractionCard {
  const rows: string[][] = [];
  for (const runtime of Object.values(ctx.config.runtimes)) {
    const provider = ctx.config.providers[runtime.provider];
    rows.push([runtime.id, "default", provider?.defaultModel ?? "unset", runtime.enabled ? "enabled" : "disabled"]);
    for (const [task, route] of Object.entries(runtime.routes ?? {})) {
      if (route) rows.push([runtime.id, task, route.model, runtime.enabled ? "enabled" : "disabled"]);
    }
  }
  return {
    kind: "menu",
    title: "Models",
    lead: "Model choices are read from configured runtimes and routes; this view does not guess provider catalog names.",
    table: { id: "models", columns: ["Runtime", "Route", "Model", "State"], rows: rows.length ? rows : [["None", "—", "—", "—"]] },
    next: [
      { label: "/providers", detail: "Inspect provider routes" },
      { label: "/settings", detail: "Review answer and routing preferences" },
    ],
  };
}

function configuredEntriesCard(
  title: string,
  entries: Readonly<Record<string, unknown>> | undefined,
  command: string,
  noun: string,
): InteractionCard {
  const rows = Object.entries(entries ?? {}).map(([id, value]) => {
    const enabled = typeof value === "object" && value !== null && "enabled" in value
      ? (value as { enabled?: unknown }).enabled !== false
      : true;
    return [id, enabled ? "enabled" : "disabled"];
  });
  return {
    kind: "menu",
    title,
    lead: rows.length ? `Configured ${noun} entries for this deployment.` : `No ${noun} entries are configured in this deployment.`,
    table: { id: command.slice(1), columns: ["Name", "State"], rows: rows.length ? rows : [["None configured", "—"]] },
    next: [
      { label: "Refresh", detail: "Read the current configuration", command, style: "primary" },
      { label: "/tools", detail: "Return to available tools" },
    ],
  };
}

function channelsCard(ctx: InteractionContext): InteractionCard {
  const channels: Array<[string, boolean, string]> = [
    ["Telegram", Boolean(ctx.gateway?.telegram), "inline keyboard + text/document delivery"],
    ["Slack", Boolean(ctx.gateway?.slack), "Block Kit + file delivery"],
    ["Google Chat", Boolean(ctx.gateway?.gchat), "cards + command/action events"],
    ["Discord", Boolean(ctx.gateway?.discord), "components + text"],
    ["WhatsApp", Boolean(ctx.gateway?.whatsapp), "interactive buttons + text fallback"],
    ["Teams", Boolean(ctx.gateway?.teams), "Adaptive Cards + text"],
  ];
  return {
    kind: "status",
    title: "Channels",
    lead: "Channel state reflects this gateway configuration, not a simulated catalog.",
    table: { id: "channels", columns: ["Channel", "Configured", "Interaction"], rows: channels.map(([name, enabled, mode]) => [name, enabled ? "yes" : "no", mode]) },
    next: [
      { label: "/status", detail: "Check this conversation" },
      { label: "/security", detail: "Review channel verification" },
    ],
  };
}

function agentsCard(ctx: InteractionContext): InteractionCard {
  const rows = (ctx.config.agents?.list ?? []).map((agent) => [agent.id, agent.skills?.join(", ") || "inherited defaults"]);
  return {
    kind: "menu",
    title: "Agents",
    lead: rows.length ? "Configured agent profiles and their declared skill sets." : "No named agent profiles are configured; the active profile uses deployment defaults.",
    table: { id: "agents", columns: ["Agent", "Skills"], rows: rows.length ? rows : [[ctx.profile, "deployment defaults"]] },
    next: [
      { label: "/skills", detail: "Inspect configured skills" },
      { label: "/tools", detail: "Inspect available tools" },
    ],
  };
}

function artifactsCard(ctx: InteractionContext): InteractionCard {
  const surface = ctx.message.surfaceId.split(":", 1)[0];
  const native = surface === "slack" || surface === "telegram";
  return {
    kind: "status",
    title: "Artifacts",
    lead: "Artifact creation is provider/tool-driven; the gateway verifies declared local files before delivery.",
    kpis: [
      { label: "Current channel", value: surface },
      { label: "Native attachment", value: native ? "Supported" : "Text/link fallback", tone: native ? "positive" : "warning" },
    ],
    table: {
      id: "artifact-formats",
      columns: ["Format", "Delivery contract"],
      rows: [
        ["DOCX", "verified file or explicit delivery failure"],
        ["PDF", "verified file or explicit delivery failure"],
        ["PPTX", "verified file or explicit delivery failure"],
        ["XLSX", "verified file or explicit delivery failure"],
      ],
    },
    next: [
      { label: "/tools", detail: "Check artifact-capable tools" },
      { label: "/reports", detail: "Create an export through a report workflow" },
    ],
  };
}

function sessionsCard(ctx: InteractionContext): InteractionCard {
  return {
    kind: "status",
    title: "Sessions",
    lead: "This channel conversation keeps one provider-session lane until you start fresh or reset it.",
    table: {
      id: "session",
      columns: ["Field", "Value"],
      rows: [
        ["Conversation", `${ctx.message.surfaceId}:${ctx.message.conversationId}`],
        ["Profile", ctx.profile],
        ["Continuity", "enabled for this conversation lane"],
      ],
    },
    next: [
      { label: "/new", detail: "Start fresh and clear provider handles", command: "/new", style: "primary" },
      { label: "/reset", detail: "Reset provider handles", command: "/reset", style: "danger" },
      { label: "/memory", detail: "Review scoped memory behavior" },
    ],
  };
}

function memoryCard(ctx: InteractionContext, identity: PairedIdentity | undefined): InteractionCard {
  return {
    kind: "status",
    title: "Memory",
    lead: "Memory is scoped to this pairing and conversation. Channel runs recall it only when the request asks for prior context.",
    table: {
      id: "memory-scopes",
      columns: ["Scope", "State"],
      rows: [
        ["Pairing", ctx.paired.pairingId],
        ["Conversation", `${ctx.message.surfaceId}:${ctx.message.conversationId}`],
        ["Frappe user", identity?.user ?? "not connected"],
        ["Tenant", identity?.site ?? "not connected"],
      ],
    },
    next: [
      { label: "/sessions", detail: "Review conversation continuity" },
      { label: "/security", detail: "Review scope boundaries" },
    ],
  };
}

function helpCard(ctx: InteractionContext, _identity: PairedIdentity | undefined): InteractionCard {
  const allRows = INTERACTION_COMMANDS
    .filter((descriptor) => descriptor.name !== "start" && descriptorVisible(descriptor, ctx))
    .map((descriptor, index) => [String(index + 1), `/${descriptor.name}`, descriptor.summary]);
  const page = paginateRows(allRows, commandPage(ctx.args), 10);
  const pageCount = Math.max(1, Math.ceil(page.pagination.totalRows / page.pagination.pageSize));
  return {
    kind: "menu",
    title: "Commands",
    lead: "Use these generic commands. I will adapt them to the connected site, your role, and this channel.",
    table: { id: "commands", columns: ["No", "Command", "Use"], rows: page.rows, pagination: page.pagination },
    next: compact([
      page.pagination.page > 1 ? { label: "Previous", detail: "Previous command page", command: `/help page=${page.pagination.page - 1}`, kind: "page" as const } : undefined,
      page.pagination.page < pageCount ? { label: "Next", detail: "Next command page", command: `/help page=${page.pagination.page + 1}`, kind: "page" as const } : undefined,
      { label: "/tools", detail: "Show tools available now" },
      { label: "/reports", detail: "Open report workflows" },
    ]),
  };
}

function visibleTools(identity: PairedIdentity | undefined, assignedRoles: readonly string[] = []): Array<{ label: string; detail: string }> {
  const base = [
    { label: "Ask the agent", detail: "Normal task, code, research, or document prompt" },
    { label: "Create artifacts", detail: "PDF, DOCX, PPTX, Excel where office tools are enabled" },
  ];
  const role = roleTier(identity, assignedRoles);
  const tools = identity ? [
    { label: "Frappe lookup", detail: "Find records you can read" },
    { label: "Frappe create/update", detail: "Guided forms with mandatory fields, preview, and approval" },
    { label: "Open documents", detail: "Return Frappe links for records used or changed" },
    ...base,
  ] : [...base];
  if (role.manager || role.hrbp || role.system) tools.push({ label: "Team reports", detail: "Tables, filters, exports, and drilldowns for allowed people" });
  if (role.hrbp || role.system) tools.push({ label: "HRBP tools", detail: "Employee lifecycle, leave, attendance, hierarchy-aware reports" });
  if (role.system) tools.push({ label: "System controls", detail: "Limits, security policy, evals, index controls" });
  return tools;
}

function roleTier(identity: PairedIdentity | undefined, assignedRoles: readonly string[] = []): { employee: boolean; manager: boolean; hrbp: boolean; system: boolean } {
  const roles = new Set([...(identity?.roles ?? []), ...assignedRoles].map((role) => role.trim().toLowerCase()));
  return {
    employee: !!identity || roles.size > 0,
    manager: [...roles].some((role) => role.includes("manager") || role.includes("reports manager")),
    hrbp: [...roles].some((role) => role === "hr user" || role === "hr manager" || role.includes("hrbp") || role.includes("human resources") || role.includes("people")),
    system: roles.has("system manager") || roles.has("administrator") || roles.has("admin"),
  };
}

function governanceAssignment(gateway: GatewayConfig | undefined, message: SurfaceMessage, paired: PairedSender): GatewayGovernanceAssignment | undefined {
  const assignments = gateway?.governance?.assignments;
  if (!assignments) return undefined;
  return assignments[`${message.surfaceId}:${message.senderId}`] ?? assignments[message.senderId] ?? assignments[paired.pairingId] ?? assignments.default;
}

interface RateLimitSnapshot {
  readonly subjectKind: GatewayGovernanceRateLimit["subject"]["kind"];
  readonly subjectId: string;
  readonly window: GatewayGovernanceRateLimit["window"];
  readonly maxRuns?: number;
  readonly usedRuns?: number;
  readonly maxTokens?: number;
  readonly usedTokens?: number;
  readonly resetAt: string;
}

async function readRateLimitSnapshots(
  ctx: InteractionContext,
  assignment: GatewayGovernanceAssignment | undefined,
  identity: PairedIdentity | undefined,
  role: ReturnType<typeof roleTier>,
  visibility: "current" | "authorized",
): Promise<RateLimitSnapshot[]> {
  const subjectFilter = argumentValue(ctx.args, "subject");
  const windowFilter = argumentValue(ctx.args, "window");
  const limits = (ctx.gateway?.governance?.rateLimits ?? []).filter((limit) => {
    if (subjectFilter && limit.subject.kind !== subjectFilter) return false;
    if (windowFilter && limit.window !== windowFilter) return false;
    if (limitMatchesCurrentContext(limit, ctx, assignment, identity)) return true;
    return visibility === "authorized" && limitVisibleToManager(limit, assignment, identity, role);
  });
  const nowMs = Date.now();
  return Promise.all(limits.map(async (limit) => {
    const bounds = enterpriseWindowBounds(limit.window, nowMs);
    const base = `${limit.subject.kind}:${limit.subject.id}:${bounds.key}`;
    const readCounter = async (metric: "runs" | "tokens", configured: number | undefined): Promise<number | undefined> => {
      if (configured === undefined || !ctx.enterprise) return undefined;
      try {
        return await ctx.enterprise.rateLimitStore.readRateLimit({
          key: `gateway:${base}:${metric}`,
          windowStartMs: bounds.startMs,
          nowMs,
        });
      } catch {
        return undefined;
      }
    };
    const [usedRuns, usedTokens] = await Promise.all([
      readCounter("runs", limit.maxRuns),
      readCounter("tokens", limit.maxTokens),
    ]);
    return {
      subjectKind: limit.subject.kind,
      subjectId: limit.subject.id,
      window: limit.window,
      ...(limit.maxRuns === undefined ? {} : { maxRuns: limit.maxRuns, usedRuns }),
      ...(limit.maxTokens === undefined ? {} : { maxTokens: limit.maxTokens, usedTokens }),
      resetAt: new Date(bounds.endMs).toISOString(),
    };
  }));
}

function limitMatchesCurrentContext(
  limit: GatewayGovernanceRateLimit,
  ctx: InteractionContext,
  assignment: GatewayGovernanceAssignment | undefined,
  identity: PairedIdentity | undefined,
): boolean {
  const subject = limit.subject;
  if (subject.kind === "role") {
    const roles = [...(assignment?.roles ?? []), ...(identity?.roles ?? [])].map((value) => value.toLowerCase());
    return roles.includes(subject.id.toLowerCase());
  }
  if (subject.kind === "department") return [...(assignment?.departmentIds ?? []), identity?.department].filter(Boolean).includes(subject.id);
  if (subject.kind === "tenant") return assignment?.tenantId === subject.id || identity?.site === subject.id;
  if (subject.kind === "user") {
    return [assignment?.userId, identity?.user, identity?.employee, ctx.message.senderId, ctx.paired.pairingId].includes(subject.id);
  }
  if (subject.kind === "channel") return subject.id === `${ctx.message.surfaceId}:${ctx.message.conversationId}` || subject.id === ctx.message.conversationId;
  if (subject.kind === "surface") return subject.id === ctx.message.surfaceId;
  if (subject.kind === "workspace") return assignment?.workspaceId === subject.id;
  if (subject.kind === "agent") return ctx.profile === subject.id;
  return false;
}

function limitVisibleToManager(
  limit: GatewayGovernanceRateLimit,
  assignment: GatewayGovernanceAssignment | undefined,
  identity: PairedIdentity | undefined,
  role: ReturnType<typeof roleTier>,
): boolean {
  if (role.system) return true;
  if (!role.manager && !role.hrbp) return false;
  const subject = limit.subject;
  if (subject.kind === "user") return assignment?.managedUserIds?.includes(subject.id) ?? false;
  if (subject.kind === "department") return assignment?.managedDepartmentIds?.includes(subject.id) ?? false;
  if (subject.kind === "role") return [...(assignment?.roles ?? []), ...(identity?.roles ?? [])].includes(subject.id);
  if (subject.kind === "tenant") return assignment?.tenantId === subject.id || identity?.site === subject.id;
  if (subject.kind === "workspace") return assignment?.workspaceId === subject.id;
  if (subject.kind === "channel") return assignment?.allowedChannels?.includes(subject.id) ?? false;
  if (subject.kind === "surface") return assignment?.allowedSurfaces?.includes(subject.id) ?? false;
  if (subject.kind === "agent") return assignment?.capabilities?.some((capability) => ["*", "agents", "governance"].includes(capability)) ?? false;
  return false;
}

function rateLimitSnapshotRow(snapshot: RateLimitSnapshot): string[] {
  return [
    `${snapshot.subjectKind}:${snapshot.subjectId}`,
    snapshot.window,
    formatCounterAllowance(snapshot.usedRuns, snapshot.maxRuns),
    formatCounterAllowance(snapshot.usedTokens, snapshot.maxTokens),
    formatResetTime(snapshot.resetAt),
  ];
}

function formatCounterAllowance(used: number | undefined, limit: number | undefined): string {
  if (limit === undefined) return "Not limited";
  if (used === undefined) return `Counter unavailable / ${limit}`;
  return `${used} / ${limit} (${Math.max(0, limit - used)} left)`;
}

function formatResetTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().replace("T", " ").slice(0, 16) + "Z";
}

function compact<T>(items: readonly (T | undefined | false | null)[]): T[] {
  return items.filter((item): item is T => item !== undefined && item !== false && item !== null);
}

function compactRows(rows: readonly (readonly (string | undefined)[])[]): string[][] {
  return rows.filter((row) => row[1] !== undefined).map((row) => [row[0] ?? "", row[1] ?? ""]);
}
