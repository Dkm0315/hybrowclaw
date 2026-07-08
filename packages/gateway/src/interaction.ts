import type { GatewayConfig, GatewayGovernanceAssignment, GatewayGovernanceRateLimit } from "./gateway-config.js";
import type { PairedIdentity, PairedSender } from "./pairing.js";
import type { SurfaceMessage, SurfaceReply } from "./envelope.js";

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
  | "settings";

interface InteractionContext {
  readonly command: InteractionCommandName;
  readonly profile: string;
  readonly runtime: string;
  readonly model: string;
  readonly paired: PairedSender;
  readonly message: SurfaceMessage;
  readonly gateway?: GatewayConfig;
}

interface InteractionAction {
  readonly label: string;
  readonly detail?: string;
}

interface InteractionTable {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

interface InteractionCard {
  readonly title: string;
  readonly lead: string;
  readonly body?: readonly string[];
  readonly table?: InteractionTable;
  readonly next?: readonly InteractionAction[];
  readonly note?: string;
}

const CONTEXT_COMMANDS: readonly InteractionCommandName[] = [
  "start",
  "status",
  "whoami",
  "tools",
  "reports",
  "tokens",
  "usage",
  "limits",
  "security",
  "evals",
  "index",
  "settings",
  "help",
];

export function isInteractionCommand(name: string): name is InteractionCommandName {
  return (CONTEXT_COMMANDS as readonly string[]).includes(name);
}

export function renderInteractionCommand(ctx: InteractionContext): SurfaceReply {
  return { text: renderCard(cardForCommand(ctx)) };
}

function cardForCommand(ctx: InteractionContext): InteractionCard {
  const identity = ctx.paired.identity?.provider === "frappe" ? ctx.paired.identity : undefined;
  switch (ctx.command) {
    case "start":
      return startCard(ctx, identity);
    case "status":
      return statusCard(ctx, identity);
    case "whoami":
      return whoamiCard(ctx, identity);
    case "tools":
      return toolsCard(identity);
    case "reports":
      return reportsCard(identity);
    case "tokens":
    case "usage":
      return usageCard(ctx, identity);
    case "limits":
      return limitsCard(ctx, identity);
    case "security":
      return securityCard(identity);
    case "evals":
      return evalsCard(identity);
    case "index":
      return indexCard(identity);
    case "settings":
      return settingsCard(identity);
    case "help":
      return helpCard(identity);
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

function toolsCard(identity: PairedIdentity | undefined): InteractionCard {
  const tools = visibleTools(identity);
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

function reportsCard(identity: PairedIdentity | undefined): InteractionCard {
  const role = roleTier(identity);
  const rows: string[][] = [
    ["1", "Personal usage", "Your requests, artifacts, and token use"],
    ["2", "My documents", "Records and documents you recently worked on"],
  ];
  if (role.manager || role.hrbp || role.system) rows.push(["3", "Team reports", "Team usage, approvals, exceptions, and pending work"]);
  if (role.hrbp || role.system) rows.push(["4", "HR reports", "Leave, attendance, employee lifecycle, and policy reports"]);
  if (role.system) rows.push(["5", "System governance", "Token spend, rate limits, denied requests, provider usage"]);
  return {
    title: "Reports",
    lead: "Choose the report area. I will ask follow-up questions only when the report needs a date range, department, employee, or export format.",
    table: { columns: ["No", "Report area", "Includes"], rows },
    next: [
      { label: "Filter options", detail: "Date range, department, employee, status, owner, company, branch" },
      { label: "Output options", detail: "Table, summary, Excel, PDF, or open linked Frappe records" },
      { label: "/tokens", detail: "View usage and token reports" },
    ],
  };
}

function usageCard(ctx: InteractionContext, identity: PairedIdentity | undefined): InteractionCard {
  const assignment = governanceAssignment(ctx.gateway, ctx.message, ctx.paired);
  const limits = visibleRateLimits(ctx.gateway, assignment, identity);
  return {
    title: "Usage",
    lead: "I can show token and usage controls for this scope. Detailed ledgers depend on the gateway token ledger being enabled for this deployment.",
    table: {
      columns: ["Scope", "Limit"],
      rows: limits.length ? limits : [["Current sender", "No explicit rate limit configured"]],
    },
    next: [
      { label: "Show personal usage", detail: "Requests, estimated tokens, artifacts" },
      { label: "Show team usage", detail: "Available to managers/HRBP/system roles" },
      { label: "Set a limit", detail: "Available only where policy allows" },
    ],
  };
}

function limitsCard(ctx: InteractionContext, identity: PairedIdentity | undefined): InteractionCard {
  const role = roleTier(identity);
  if (!role.manager && !role.hrbp && !role.system) {
    return {
      title: "Limits",
      lead: "You can view your own usage limits from here. Changing limits requires a manager, HRBP, or system role.",
      next: [
        { label: "/tokens", detail: "Show your current usage scope" },
        { label: "/whoami", detail: "Check the role I resolved" },
      ],
    };
  }
  return {
    title: "Limits",
    lead: "To change a limit, choose the scope first. I will show the impact before applying anything.",
    table: {
      columns: ["No", "Scope", "Examples"],
      rows: [
        ["1", "User", "One employee or channel user"],
        ["2", "Department", "HR, Sales, Operations"],
        ["3", "Role", "Employee, HRBP, Manager"],
        ["4", "Channel", "One Slack/GChat/Telegram space"],
        ["5", "Agent", "Report generator, Frappe operator, office tools"],
      ],
    },
    next: [
      { label: "Preview impact", detail: "Show who will be affected before saving" },
      { label: "Require approval", detail: "Add approval after a token/request threshold" },
      { label: "/security", detail: "Review related safety policy" },
    ],
  };
}

function securityCard(identity: PairedIdentity | undefined): InteractionCard {
  const role = roleTier(identity);
  return {
    title: "Security",
    lead: "Security controls are based on pairing, channel scope, Frappe permissions, and write approval gates.",
    table: {
      columns: ["Control", "State"],
      rows: [
        ["Pairing", "required before agent runs"],
        ["Frappe RBAC", identity ? "enabled for this sender" : "not connected"],
        ["Employee mapping", identity?.employee ? "linked" : "not linked"],
        ["Write actions", "preview + approval required"],
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

function evalsCard(identity: PairedIdentity | undefined): InteractionCard {
  const role = roleTier(identity);
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

function settingsCard(identity: PairedIdentity | undefined): InteractionCard {
  const role = roleTier(identity);
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

function helpCard(identity: PairedIdentity | undefined): InteractionCard {
  const rows = CONTEXT_COMMANDS
    .filter((name) => name !== "start")
    .map((name, index) => [String(index + 1), `/${name}`, helpText(name, identity)]);
  return {
    title: "Commands",
    lead: "Use these generic commands. I will adapt them to the connected site, your role, and this channel.",
    table: { columns: ["No", "Command", "Use"], rows },
    next: [
      { label: "Reply with a command", detail: "For example: /tools or /reports" },
      { label: "Ask normally", detail: "For example: apply leave for 9th" },
    ],
  };
}

function helpText(name: InteractionCommandName, identity: PairedIdentity | undefined): string {
  switch (name) {
    case "help": return "Show commands";
    case "status": return "Connection and runtime";
    case "whoami": return "Resolved user/employee identity";
    case "tools": return "Tools available to you";
    case "reports": return "Reports and exports";
    case "tokens":
    case "usage": return "Token and request usage";
    case "limits": return "Rate and token limits";
    case "security": return "Permissions and safety controls";
    case "evals": return "Eval gates and quality checks";
    case "index": return identity ? "Frappe index controls" : "Frappe indexing setup";
    case "settings": return "Response style and behavior";
    case "start": return "Start";
  }
}

function visibleTools(identity: PairedIdentity | undefined): Array<{ label: string; detail: string }> {
  const base = [
    { label: "Ask the agent", detail: "Normal task, code, research, or document prompt" },
    { label: "Create artifacts", detail: "PDF, DOCX, PPTX, Excel where office tools are enabled" },
  ];
  if (!identity) return base;
  const role = roleTier(identity);
  const tools = [
    { label: "Frappe lookup", detail: "Find records you can read" },
    { label: "Frappe create/update", detail: "Guided forms with mandatory fields, preview, and approval" },
    { label: "Open documents", detail: "Return Frappe links for records used or changed" },
    ...base,
  ];
  if (role.manager || role.hrbp || role.system) tools.push({ label: "Team reports", detail: "Tables, filters, exports, and drilldowns for allowed people" });
  if (role.hrbp || role.system) tools.push({ label: "HRBP tools", detail: "Employee lifecycle, leave, attendance, hierarchy-aware reports" });
  if (role.system) tools.push({ label: "System controls", detail: "Limits, security policy, evals, index controls" });
  return tools;
}

function roleTier(identity: PairedIdentity | undefined): { employee: boolean; manager: boolean; hrbp: boolean; system: boolean } {
  const roles = new Set((identity?.roles ?? []).map((role) => role.toLowerCase()));
  return {
    employee: !!identity,
    manager: [...roles].some((role) => role.includes("manager") || role.includes("reports manager")),
    hrbp: [...roles].some((role) => role.includes("hr") || role.includes("people")),
    system: roles.has("system manager") || roles.has("administrator") || roles.has("admin"),
  };
}

function governanceAssignment(gateway: GatewayConfig | undefined, message: SurfaceMessage, paired: PairedSender): GatewayGovernanceAssignment | undefined {
  const assignments = gateway?.governance?.assignments;
  if (!assignments) return undefined;
  return assignments[`${message.surfaceId}:${message.senderId}`] ?? assignments[message.senderId] ?? assignments[paired.pairingId] ?? assignments.default;
}

function visibleRateLimits(
  gateway: GatewayConfig | undefined,
  assignment: GatewayGovernanceAssignment | undefined,
  identity: PairedIdentity | undefined,
): string[][] {
  const limits = gateway?.governance?.rateLimits ?? [];
  const rows: string[][] = [];
  for (const limit of limits) {
    if (!limitMatches(limit, assignment, identity)) continue;
    const caps = compact([
      limit.maxRuns === undefined ? undefined : `${limit.maxRuns} requests/${limit.window}`,
      limit.maxTokens === undefined ? undefined : `${limit.maxTokens} tokens/${limit.window}`,
    ]).join(", ");
    rows.push([`${limit.subject.kind}:${limit.subject.id}`, caps || `configured per ${limit.window}`]);
  }
  return rows;
}

function limitMatches(limit: GatewayGovernanceRateLimit, assignment: GatewayGovernanceAssignment | undefined, identity: PairedIdentity | undefined): boolean {
  if (limit.subject.kind === "role") return !!assignment?.roles?.includes(limit.subject.id) || !!identity?.roles.includes(limit.subject.id);
  if (limit.subject.kind === "tenant") return assignment?.tenantId === limit.subject.id || identity?.site === limit.subject.id;
  if (limit.subject.kind === "user") return assignment?.userId === limit.subject.id || identity?.user === limit.subject.id || identity?.employee === limit.subject.id;
  return true;
}

function renderCard(card: InteractionCard): string {
  return compact([
    card.title,
    "",
    card.lead,
    ...(card.body?.length ? ["", ...card.body] : []),
    card.table ? `\n${renderTable(card.table)}` : undefined,
    card.next?.length ? `\nWhat can be done next:\n${card.next.map((action, index) => `${index + 1}. ${action.label}${action.detail ? ` — ${action.detail}` : ""}`).join("\n")}` : undefined,
    card.note ? `\n${card.note}` : undefined,
  ]).join("\n");
}

function renderTable(table: InteractionTable): string {
  const widths = table.columns.map((column, index) => Math.min(36, Math.max(
    displayLength(column),
    ...table.rows.map((row) => displayLength(row[index] ?? "")),
  )));
  const border = (left: string, mid: string, right: string) => `${left}${widths.map((width) => "─".repeat(width + 2)).join(mid)}${right}`;
  const row = (cells: readonly string[]) => `│${widths.map((width, index) => ` ${truncate(cells[index] ?? "", width).padEnd(width)} `).join("│")}│`;
  return [
    border("┌", "┬", "┐"),
    row(table.columns),
    border("├", "┼", "┤"),
    ...table.rows.map(row),
    border("└", "┴", "┘"),
  ].join("\n");
}

function truncate(value: string, width: number): string {
  return displayLength(value) <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`;
}

function displayLength(value: string): number {
  return value.length;
}

function compact<T>(items: readonly (T | undefined | false | null)[]): T[] {
  return items.filter((item): item is T => item !== undefined && item !== false && item !== null);
}

function compactRows(rows: readonly (readonly (string | undefined)[])[]): string[][] {
  return rows.filter((row) => row[1] !== undefined).map((row) => [row[0] ?? "", row[1] ?? ""]);
}
