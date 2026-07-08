export type FrappeAnswerPath = "deterministic" | "indexed_data" | "live_frappe" | "provider_tiny_context";
export type FrappeOperationalIntent =
  | "greeting"
  | "help"
  | "status"
  | "record_lookup"
  | "record_create"
  | "record_update"
  | "workflow_action"
  | "report"
  | "office_artifact"
  | "permission_explanation"
  | "troubleshooting"
  | "unknown";

export interface FrappeReadModelPlan {
  readonly site: string;
  readonly goal: "sub_3s_permission_backed_operational_answers";
  readonly latencyBudgetMs: {
    readonly deterministic: number;
    readonly indexedData: number;
    readonly liveFrappe: number;
    readonly providerTinyContext: number;
  };
  readonly stores: readonly FrappeReadModelStore[];
  readonly cron: readonly FrappeIndexJob[];
  readonly deltaEvents: readonly string[];
  readonly postgres: {
    readonly ddl: readonly string[];
    readonly indexes: readonly string[];
  };
  readonly serialization: readonly string[];
  readonly safetyInvariants: readonly string[];
}

export interface FrappeReadModelStore {
  readonly id: string;
  readonly purpose: string;
  readonly examples: readonly string[];
  readonly maxStalenessMs: number;
}

export interface FrappeIndexJob {
  readonly id: string;
  readonly cadence: string;
  readonly target: string;
  readonly reason: string;
  readonly maxRuntimeMs: number;
}

export interface FrappeSemanticAlias {
  readonly phrase: string;
  readonly canonical: string;
  readonly module: string;
  readonly confidence: number;
  readonly source: "erpnext_prior" | "site_usage" | "admin_curated" | "field_label" | "report_name";
}

export interface FrappeCanonicalEnvelope<TPayload = unknown> {
  readonly schemaVersion: 1;
  readonly site: string;
  readonly scope: {
    readonly user?: string;
    readonly rolesHash?: string;
    readonly permissionHash?: string;
    readonly company?: string;
    readonly department?: string;
    readonly channel?: string;
  };
  readonly payloadType: string;
  readonly payload: TPayload;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly source: "frappe_api" | "frappe_event" | "cron_index" | "admin_seed" | "usage_pattern";
  readonly redactionState: "none" | "redacted" | "restricted";
}

export interface FrappeFastRouteInput {
  readonly prompt: string;
  readonly site?: string;
  readonly user?: string;
  readonly roles?: readonly string[];
  readonly department?: string;
  readonly channel?: string;
  readonly installedApps?: readonly string[];
  readonly heavyLifterApps?: readonly string[];
  readonly hasFreshIndex?: boolean;
  readonly hasLiveCredentials?: boolean;
  readonly allowedDoctypes?: readonly string[];
  readonly aliases?: readonly FrappeSemanticAlias[];
}

export interface FrappeFastRouteDecision {
  readonly intent: FrappeOperationalIntent;
  readonly answerPath: FrappeAnswerPath;
  readonly targetLatencyMs: number;
  readonly invokeProvider: boolean;
  readonly showProgress: boolean;
  readonly candidateDoctypes: readonly string[];
  readonly requiredChecks: readonly string[];
  readonly minimalContext: Record<string, unknown>;
  readonly reason: string;
}

const DEFAULT_SITE = "configured-frappe-site";
const THREE_SECONDS_MS = 3000;

export const FRAPPE_LATENCY_BUDGETS = {
  deterministic: 250,
  indexedData: 800,
  liveFrappe: 2500,
  providerTinyContext: THREE_SECONDS_MS,
} as const;

const ERP_PRIOR_ALIASES: readonly FrappeSemanticAlias[] = [
  alias("hi", "greeting", "General", 0.99),
  alias("hello", "greeting", "General", 0.99),
  alias("help", "help", "General", 0.95),
  alias("what can you do", "help", "General", 0.92),
  alias("leave", "Leave Application", "HR", 0.86),
  alias("holiday", "Leave Application", "HR", 0.82),
  alias("time off", "Leave Application", "HR", 0.82),
  alias("attendance", "Attendance", "HR", 0.9),
  alias("clock in", "Employee Checkin", "HR", 0.94),
  alias("clock out", "Employee Checkin", "HR", 0.94),
  alias("regularise", "Attendance Request", "HR", 0.9),
  alias("regularize", "Attendance Request", "HR", 0.9),
  alias("salary", "Salary Slip", "Payroll", 0.86),
  alias("payslip", "Salary Slip", "Payroll", 0.9),
  alias("earning components", "Salary Slip", "Payroll", 0.82),
  alias("claim", "Expense Claim", "Expense", 0.84),
  alias("reimbursement", "Expense Claim", "Expense", 0.9),
  alias("cab claim", "Expense Claim", "Expense", 0.92),
  alias("travel claim", "Expense Claim", "Expense", 0.88),
  alias("ticket", "HD Ticket", "Support", 0.86),
  alias("support issue", "HD Ticket", "Support", 0.88),
  alias("laptop issue", "HD Ticket", "Support", 0.82),
  alias("approval", "Workflow Action", "Workflow", 0.8),
  alias("pending action", "ToDo", "Workflow", 0.78),
  alias("announcement", "Notice", "HR", 0.72),
  alias("resign", "Employee Separation", "HR", 0.72),
  alias("internal job", "Job Opening", "Recruiting", 0.75),
  alias("nextai", "NextAI", "AI", 0.9),
  alias("chatnext", "ChatNext", "AI", 0.86),
  alias("ai assistant", "installed_ai_app", "AI", 0.78),
  alias("custom app", "installed_custom_app", "Custom", 0.74),
];

export function frappeReadModelPlan(args: Record<string, unknown> = {}): FrappeReadModelPlan {
  const site = stringArg(args, "site") ?? stringArg(args, "siteUrl") ?? DEFAULT_SITE;
  return {
    site,
    goal: "sub_3s_permission_backed_operational_answers",
    latencyBudgetMs: FRAPPE_LATENCY_BUDGETS,
    stores: [
      {
        id: "structure_index",
        purpose: "Frappe metadata, customizations, workflows, reports, print formats, app topology, hooks, methods, and routes.",
        examples: ["DocType", "DocField", "Custom Field", "Property Setter", "Workflow", "Report", "Print Format", "installed apps", "hooks.py", "whitelisted methods"],
        maxStalenessMs: 60_000,
      },
      {
        id: "permission_index",
        purpose: "Role, user permission, field permlevel, workflow action, and sharing boundaries.",
        examples: ["Role Permission Manager", "Has Role", "User Permission", "DocShare", "Workflow transitions"],
        maxStalenessMs: 30_000,
      },
      {
        id: "operational_data_index",
        purpose: "Bounded summaries and queryable facts for hot business records, never a global raw-record cache.",
        examples: ["own pending approvals", "own leave records", "team attendance counts", "open helpdesk tickets"],
        maxStalenessMs: 30_000,
      },
      {
        id: "semantic_business_index",
        purpose: "Department vocabulary, custom app vocabulary, aliases, usage patterns, and site-specific terms learned from metadata and safe usage.",
        examples: ["cab claim -> Expense Claim", "holiday -> Leave Application", "salary -> Salary Slip", "ask nextai -> installed NextAI surface"],
        maxStalenessMs: 300_000,
      },
    ],
    cron: [
      {
        id: "frappe_permission_hot_sync",
        cadence: "*/1 * * * *",
        target: "roles, user permissions, doc shares, workflow action permissions",
        reason: "Permission changes must invalidate cached visibility before any answer uses old scope.",
        maxRuntimeMs: 20_000,
      },
      {
        id: "frappe_structure_delta_sync",
        cadence: "*/1 * * * *",
        target: "custom fields, property setters, workflows, reports, print formats, installed apps, hooks, routes, whitelisted methods",
        reason: "Frappe sites change through customization; metadata must stay current for accurate CRUD and reports.",
        maxRuntimeMs: 25_000,
      },
      {
        id: "frappe_operational_hot_sync",
        cadence: "*/2 * * * *",
        target: "hot records for paired users and departments: pending tasks, approvals, tickets, leave, attendance, expense",
        reason: "Common ERP questions need data, not only schema, but the data must be permission-segmented.",
        maxRuntimeMs: 35_000,
      },
      {
        id: "frappe_semantic_usage_sync",
        cadence: "*/5 * * * *",
        target: "aliases from field labels, report names, workflow names, user phrases, and admin-curated vocabulary",
        reason: "Non-technical users ask in department language, not DocType names.",
        maxRuntimeMs: 30_000,
      },
      {
        id: "frappe_full_site_induction",
        cadence: "0 2 * * *",
        target: "full site read model, leakage evals, p95 latency report, and stale index repair",
        reason: "Nightly full rebuild catches drift from custom apps, patches, imports, and permissions.",
        maxRuntimeMs: 600_000,
      },
    ],
    deltaEvents: [
      "DocType.on_update",
      "Custom Field.on_update",
      "Property Setter.on_update",
      "Workflow.on_update",
      "Report.on_update",
      "Print Format.on_update",
      "Role.on_update",
      "Has Role.on_update",
      "User Permission.on_update",
      "DocShare.on_update",
      "Installed Application change",
      "hooks.py / whitelisted method manifest change",
      "custom page route change",
      "any indexed business DocType.on_update",
    ],
    postgres: frappePostgresDdl(site),
    serialization: [
      "No raw Frappe Document objects in the read model.",
      "Datetime values serialize to ISO strings.",
      "Decimal and currency values serialize as strings plus optional numeric shadow fields.",
      "Child tables serialize as bounded row arrays with parent/parentfield/idx preserved.",
      "All rows carry site, user/role/permission hashes, source, observedAt, validUntil, and redaction state.",
      "Permission hash changes force cache miss before answer generation.",
    ],
    safetyInvariants: [
      "Every candidate record is filtered by current Frappe permission before answer or artifact generation.",
      "Global cache may store query plans and metadata, not private raw business answers.",
      "Provider calls receive tiny context packets, never whole ERP histories.",
      "Writes always run as the paired Frappe user and pass live permission preflight.",
      "Progress/thinking UI is suppressed for the first 1200ms and never shown for deterministic fast-path answers.",
    ],
  };
}

export function frappeFastRoute(args: FrappeFastRouteInput): FrappeFastRouteDecision {
  const prompt = args.prompt.trim();
  const text = normalizeText(prompt);
  const aliases = [...(args.aliases ?? []), ...ERP_PRIOR_ALIASES];
  const candidateAliases = aliases
    .filter((item) => aliasMatches(text, item.phrase))
    .sort((a, b) => b.confidence - a.confidence);
  const candidateDoctypes = unique(candidateAliases.map((item) => item.canonical).filter((value) => !["greeting", "help"].includes(value)));
  const intent = classifyOperationalIntent(text, candidateAliases);
  const hasFreshIndex = args.hasFreshIndex !== false;
  const hasLiveCredentials = args.hasLiveCredentials === true;
  const needsWrite = intent === "record_create" || intent === "record_update" || intent === "workflow_action";
  const answerPath: FrappeAnswerPath =
    intent === "greeting" || intent === "help" || intent === "status"
      ? "deterministic"
      : needsWrite
        ? (hasLiveCredentials ? "live_frappe" : "provider_tiny_context")
        : hasFreshIndex && candidateDoctypes.length
          ? "indexed_data"
          : hasLiveCredentials
            ? "live_frappe"
            : "provider_tiny_context";
  const targetLatencyMs = answerPath === "deterministic"
    ? FRAPPE_LATENCY_BUDGETS.deterministic
    : answerPath === "indexed_data"
      ? FRAPPE_LATENCY_BUDGETS.indexedData
      : answerPath === "live_frappe"
        ? FRAPPE_LATENCY_BUDGETS.liveFrappe
        : FRAPPE_LATENCY_BUDGETS.providerTinyContext;
  return {
    intent,
    answerPath,
    targetLatencyMs,
    invokeProvider: answerPath === "provider_tiny_context",
    showProgress: false,
    candidateDoctypes,
    requiredChecks: requiredChecksFor(intent, answerPath),
    minimalContext: {
      prompt,
      site: args.site,
      user: args.user,
      department: args.department,
      channel: args.channel,
      roles: args.roles ?? [],
      installedApps: args.installedApps ?? [],
      heavyLifterApps: args.heavyLifterApps ?? [],
      candidateDoctypes,
      matchedAliases: candidateAliases.slice(0, 5),
      maxAnswerMs: THREE_SECONDS_MS,
    },
    reason: routeReason(intent, answerPath, candidateDoctypes),
  };
}

export function canonicalFrappeEnvelope<TPayload>(
  input: Omit<FrappeCanonicalEnvelope<TPayload>, "schemaVersion" | "observedAt" | "validUntil"> & { readonly observedAt?: string; readonly ttlMs?: number },
): FrappeCanonicalEnvelope<TPayload> {
  const observedAt = input.observedAt ?? new Date().toISOString();
  const ttlMs = input.ttlMs ?? 30_000;
  return {
    schemaVersion: 1,
    site: input.site,
    scope: input.scope,
    payloadType: input.payloadType,
    payload: normalizePayload(input.payload),
    observedAt,
    validUntil: new Date(Date.parse(observedAt) + ttlMs).toISOString(),
    source: input.source,
    redactionState: input.redactionState,
  };
}

function frappePostgresDdl(site: string): FrappeReadModelPlan["postgres"] {
  const escapedSite = site.replace(/'/g, "''");
  return {
    ddl: [
      "create schema if not exists muster_frappe;",
      `comment on schema muster_frappe is 'Permission-backed Frappe read model for ${escapedSite}';`,
      `create table if not exists muster_frappe.site_index (
  site text not null,
  index_kind text not null,
  object_id text not null,
  module text,
  doctype text,
  fieldname text,
  label text,
  payload jsonb not null,
  search_text text not null default '',
  observed_at timestamptz not null,
  valid_until timestamptz not null,
  primary key (site, index_kind, object_id)
);`,
      `create table if not exists muster_frappe.permission_snapshot (
  site text not null,
  subject_kind text not null,
  subject_id text not null,
  permission_hash text not null,
  roles_hash text not null,
  payload jsonb not null,
  observed_at timestamptz not null,
  valid_until timestamptz not null,
  primary key (site, subject_kind, subject_id)
);`,
      `create table if not exists muster_frappe.operational_fact (
  site text not null,
  doctype text not null,
  docname text not null,
  owner_user text,
  company text,
  department text,
  permission_hash text not null,
  visibility_scope jsonb not null,
  summary text not null,
  payload jsonb not null,
  search_vector tsvector generated always as (to_tsvector('simple', coalesce(summary, ''))) stored,
  observed_at timestamptz not null,
  valid_until timestamptz not null,
  primary key (site, doctype, docname, permission_hash)
);`,
      `create table if not exists muster_frappe.semantic_alias (
  site text not null,
  phrase text not null,
  canonical text not null,
  module text,
  confidence double precision not null,
  source text not null,
  observed_at timestamptz not null,
  primary key (site, phrase, canonical)
);`,
      `create table if not exists muster_frappe.query_plan_cache (
  site text not null,
  scope_hash text not null,
  query_signature text not null,
  intent text not null,
  candidate_doctypes text[] not null,
  plan jsonb not null,
  hit_count bigint not null default 0,
  p95_ms integer,
  observed_at timestamptz not null,
  valid_until timestamptz not null,
  primary key (site, scope_hash, query_signature)
);`,
    ],
    indexes: [
      "create index if not exists site_index_lookup_idx on muster_frappe.site_index (site, index_kind, doctype);",
      "create index if not exists site_index_search_idx on muster_frappe.site_index using gin (to_tsvector('simple', search_text));",
      "create index if not exists permission_snapshot_hash_idx on muster_frappe.permission_snapshot (site, permission_hash, roles_hash);",
      "create index if not exists operational_fact_scope_idx on muster_frappe.operational_fact (site, owner_user, department, doctype, valid_until);",
      "create index if not exists operational_fact_search_idx on muster_frappe.operational_fact using gin (search_vector);",
      "create index if not exists semantic_alias_phrase_idx on muster_frappe.semantic_alias using gin (to_tsvector('simple', phrase || ' ' || canonical || ' ' || coalesce(module, '')));",
      "create index if not exists query_plan_cache_latency_idx on muster_frappe.query_plan_cache (site, intent, p95_ms, valid_until);",
    ],
  };
}

function classifyOperationalIntent(text: string, aliases: readonly FrappeSemanticAlias[]): FrappeOperationalIntent {
  if (/^(hi|hello|hey|yo|namaste|good\s+(morning|evening|afternoon))[\s!.]*$/.test(text)) return "greeting";
  if (/\b(help|what can you do|commands|guide)\b/.test(text)) return "help";
  if (/\b(status|connected|health|ready)\b/.test(text)) return "status";
  if (/\b(pdf|ppt|pptx|excel|xlsx|docx|document|deck|workbook|report file)\b/.test(text)) return "office_artifact";
  if (/\b(report|dashboard|summary|analytics|variance|trend)\b/.test(text)) return "report";
  if (/\b(create|raise|apply|submit|file|draft|add|put in)\b/.test(text)) return "record_create";
  if (/\b(update|change|cancel|revoke|approve|reject|close|assign)\b/.test(text)) return /\b(approve|reject)\b/.test(text) ? "workflow_action" : "record_update";
  if (/\b(can i|allowed|permission|access|not visible|denied)\b/.test(text)) return "permission_explanation";
  if (/\b(why|failed|error|blocked|not working|cannot|can't|wont|won't)\b/.test(text)) return "troubleshooting";
  if (/\b(show|list|get|find|check|track|latest|pending|open)\b/.test(text)) return "record_lookup";
  if (aliases.length) return "record_lookup";
  return "unknown";
}

function requiredChecksFor(intent: FrappeOperationalIntent, path: FrappeAnswerPath): string[] {
  const checks = ["permission_hash_fresh", "roles_hash_fresh"];
  if (path === "indexed_data") checks.push("index_valid_until_not_expired", "record_visibility_filter");
  if (path === "live_frappe") checks.push("live_frappe_permission_preflight", "bounded_result_limit");
  if (path === "provider_tiny_context") checks.push("tiny_context_only", "provider_timeout_3s", "fallback_to_indexed_explanation");
  if (["record_create", "record_update", "workflow_action"].includes(intent)) checks.push("write_preflight", "required_fields_check", "approval_or_user_confirmation");
  if (intent === "office_artifact" || intent === "report") checks.push("dataset_permission_filter", "artifact_size_cap", "office_structure_validation");
  return checks;
}

function routeReason(intent: FrappeOperationalIntent, path: FrappeAnswerPath, doctypes: readonly string[]): string {
  if (path === "deterministic") return `${intent} can answer without retrieval or provider tokens.`;
  if (path === "indexed_data") return `Matched ${doctypes.join(", ")} in the Frappe read model; answer should use indexed, permission-filtered context.`;
  if (path === "live_frappe") return `${intent} needs fresh Frappe data or mutation preflight; keep result bounded and permission-scoped.`;
  return `${intent} needs reasoning; send only the minimal context packet and enforce a 3s provider budget.`;
}

function alias(phrase: string, canonical: string, module: string, confidence: number): FrappeSemanticAlias {
  return { phrase, canonical, module, confidence, source: "erpnext_prior" };
}

function aliasMatches(text: string, phrase: string): boolean {
  const normalizedPhrase = normalizeText(phrase);
  return text === normalizedPhrase || text.includes(normalizedPhrase) || normalizedPhrase.split(/\s+/).every((part) => part.length > 2 && text.includes(part));
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}\s/-]/gu, " ").replace(/\s+/g, " ").trim();
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizePayload<TPayload>(payload: TPayload): TPayload {
  return JSON.parse(JSON.stringify(payload, (_key, value) => {
    if (typeof value === "bigint") return value.toString();
    if (value instanceof Date) return value.toISOString();
    return value;
  })) as TPayload;
}
