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
  alias("request off", "Leave Application", "HR", 0.9),
  alias("attendance", "Attendance", "HR", 0.9),
  alias("clock in", "Employee Checkin", "HR", 0.94),
  alias("clock out", "Employee Checkin", "HR", 0.94),
  alias("regularise", "Attendance Request", "HR", 0.9),
  alias("regularize", "Attendance Request", "HR", 0.9),
  alias("attendance correction", "Attendance Request", "HR", 0.92),
  alias("check in correction", "Attendance Request", "HR", 0.9),
  alias("check out correction", "Attendance Request", "HR", 0.9),
  alias("correct check in", "Attendance Request", "HR", 0.9),
  alias("correct check out", "Attendance Request", "HR", 0.9),
  alias("forgot clock in", "Attendance Request", "HR", 0.94),
  alias("forgot clock out", "Attendance Request", "HR", 0.94),
  alias("missed clock in", "Attendance Request", "HR", 0.92),
  alias("missed clock out", "Attendance Request", "HR", 0.92),
  alias("salary", "Salary Slip", "Payroll", 0.86),
  alias("payslip", "Salary Slip", "Payroll", 0.9),
  alias("earning components", "Salary Slip", "Payroll", 0.82),
  alias("claim", "Expense Claim", "Expense", 0.84),
  alias("reimbursement", "Expense Claim", "Expense", 0.9),
  alias("reimbursed", "Expense Claim", "Expense", 0.9),
  alias("paid back", "Expense Claim", "Expense", 0.88),
  alias("cab claim", "Expense Claim", "Expense", 0.92),
  alias("travel claim", "Expense Claim", "Expense", 0.88),
  alias("ticket", "HD Ticket", "Support", 0.86),
  alias("support issue", "HD Ticket", "Support", 0.88),
  alias("laptop issue", "HD Ticket", "Support", 0.82),
  alias("task", "Task", "Projects", 0.9),
  alias("assigned work", "Task", "Projects", 0.86),
  alias("work item", "Task", "Projects", 0.84),
  alias("open work", "Task", "Projects", 0.8),
  alias("todo", "ToDo", "Workflow", 0.92),
  alias("to do", "ToDo", "Workflow", 0.9),
  alias("to-do", "ToDo", "Workflow", 0.9),
  alias("todo list", "ToDo", "Workflow", 0.94),
  alias("action list", "ToDo", "Workflow", 0.92),
  alias("action item", "ToDo", "Workflow", 0.9),
  alias("personal action", "ToDo", "Workflow", 0.88),
  alias("customer bill", "Sales Invoice", "Accounts", 0.92),
  alias("customer invoice", "Sales Invoice", "Accounts", 0.94),
  alias("supplier bill", "Purchase Invoice", "Accounts", 0.92),
  alias("vendor bill", "Purchase Invoice", "Accounts", 0.92),
  alias("hiring candidate", "Job Applicant", "Recruitment", 0.92),
  alias("job candidate", "Job Applicant", "Recruitment", 0.9),
  alias("learning session", "Training Event", "HR", 0.88),
  alias("training session", "Training Event", "HR", 0.92),
  alias("performance review", "Appraisal", "HR", 0.94),
  alias("my objectives", "Goal", "HR", 0.86),
  alias("shift change", "Shift Request", "HR", 0.92),
  alias("work travel request", "Travel Request", "Expense", 0.94),
  alias("business trip request", "Travel Request", "Expense", 0.92),
  alias("employee advance", "Employee Advance", "Expense", 0.94),
  alias("cash advance", "Employee Advance", "Expense", 0.9),
  alias("onboarding checklist", "Employee Onboarding", "HR", 0.94),
  alias("new joiner onboarding", "Employee Onboarding", "HR", 0.92),
  alias("resignation status", "Employee Separation", "HR", 0.9),
  alias("open role", "Job Opening", "Recruitment", 0.88),
  alias("people considered for open roles", "Job Applicant", "Recruitment", 0.96),
  alias("candidate interview", "Interview", "Recruitment", 0.92),
  alias("offer letter", "Job Offer", "Recruitment", 0.92),
  alias("project work", "Task", "Projects", 0.94),
  alias("time entry", "Timesheet", "Projects", 0.94),
  alias("time log", "Timesheet", "Projects", 0.9),
  alias("support request", "HD Ticket", "Support", 0.94),
  alias("help request", "HD Ticket", "Support", 0.9),
  alias("company equipment", "Asset", "Assets", 0.94),
  alias("equipment transfer", "Asset Movement", "Assets", 0.92),
  alias("customer order", "Sales Order", "Selling", 0.94),
  alias("supplier order", "Purchase Order", "Buying", 0.94),
  alias("vendor order", "Purchase Order", "Buying", 0.94),
  alias("payment received", "Payment Entry", "Accounts", 0.9),
  alias("payment made", "Payment Entry", "Accounts", 0.9),
  alias("journal adjustment", "Journal Entry", "Accounts", 0.9),
  alias("stock movement", "Stock Entry", "Stock", 0.9),
  alias("customer delivery", "Delivery Note", "Stock", 0.9),
  alias("supplier receipt", "Purchase Receipt", "Stock", 0.9),
  alias("potential customer", "Lead", "CRM", 0.9),
  alias("sales deal", "Opportunity", "CRM", 0.9),
  alias("my department", "Employee", "HR", 0.94),
  alias("which department", "Employee", "HR", 0.92),
  alias("who do i report to", "Employee", "HR", 0.96),
  alias("reporting manager", "Employee", "HR", 0.94),
  alias("approval", "Workflow Action", "Workflow", 0.8),
  alias("pending approval", "ToDo", "Workflow", 0.84),
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
  const allowed = new Set((args.allowedDoctypes ?? []).map((value) => value.trim()).filter(Boolean));
  const matchedAliases = aliases
    .filter((item) => aliasMatches(text, item.phrase))
    .filter((item) => !ROUTE_METADATA_DOCTYPES.has(item.canonical))
    .filter((item) => allowed.size === 0 || ["greeting", "help"].includes(item.canonical) || allowed.has(item.canonical));
  const curatedAliases = matchedAliases.filter((item) => item.source === "admin_curated" && item.confidence >= 0.99);
  const candidateAliases = (curatedAliases.length ? curatedAliases : matchedAliases)
    .sort((a, b) => aliasMatchScore(text, b) - aliasMatchScore(text, a) || b.confidence - a.confidence);
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

const ROUTE_METADATA_DOCTYPES = new Set([
  "DocField", "DocPerm", "DocShare", "DocType", "Custom DocPerm", "Custom Field",
  "Has Role", "Module Def", "Property Setter", "Role", "User Permission",
]);

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
  if (/\b(pdf|ppt|pptx|excel|xlsx|docx|document|deck|workbook|report file)\b/.test(text)) return "office_artifact";
  if (/\b(report|dashboard|summary|analytics|variance|trend)\b/.test(text)) return "report";
  // Deployment-curated API phrases describe read contracts. Words such as
  // "apply" in "jobs I can apply for" must not turn those reads into writes.
  if (aliases.some((item) => item.source === "admin_curated" && item.confidence >= 0.99)) return "record_lookup";
  if (requestsReadOnlyReview(text) && aliases.length) return "record_lookup";
  if (aliases.length && USER_INITIATED_PREPARATION.test(text)) return "record_create";
  if (aliases.length && /\b(?:which|what)\b[^.!?]*\b(?:can i|am i allowed|may i)\b|\b(?:can i|am i allowed|may i)\b[^.!?]*\b(?:see|view|review|read|access)\b/.test(text)) return "record_lookup";
  if (/\b(?:did i|have i|has my|were there|was there|what is on|what s on|where (?:does|do|did)|show|list|see|view|find|check|latest|recent|pending|open|count|how many)\b/.test(text)) return "record_lookup";
  if (/\b(create|raise|apply|submit|file|draft|add|put in)\b/.test(text)) return "record_create";
  if (/\b(update|change|cancel|revoke|approve|reject|close|assign)\b/.test(text)) return /\b(approve|reject)\b/.test(text) ? "workflow_action" : "record_update";
  if (/\b(can i|allowed|permission|access|not visible|denied)\b/.test(text)) return "permission_explanation";
  if (/\b(why|failed|error|blocked|not working|cannot|can't|wont|won't)\b/.test(text)) return "troubleshooting";
  if (/\b(show|list|get|find|check|track|latest|pending|open|count)\b/.test(text)
    || /\b(?:how many|what do i have|what is on my|what's on my|which of my)\b/.test(text)) return "record_lookup";
  if (/\b(status|connected|health|ready)\b/.test(text)) return "status";
  if (aliases.length) return "record_lookup";
  if (/\b(help|what can you do|commands|guide)\b/.test(text)) return "help";
  return "unknown";
}

// normalizeText strips apostrophes, so "don't" arrives here as "don t". Every
// negator form below is written in its post-normalization shape so an explicit
// refusal of a mutation can never fall through to a write route.
const READ_ONLY_NEGATORS = "(?:do not|do n t|don t|dont|does not|does n t|doesn t|will not|won t|can not|cannot|can t|should not|shouldn t|never|without|no need to)";
const READ_ONLY_MUTATION_VERBS = "(?:create|creating|raise|raising|apply|applying|submit|submitting|file|filing|draft|drafting|add|adding|update|updating|change|changing|cancel|cancel(?:l)?ing|revoke|revoking|approve|approving|reject|rejecting|close|closing|assign|assigning|save|saving|delete|deleting|remove|removing)";
const READ_ONLY_NEGATED_MUTATION = new RegExp(`\\b${READ_ONLY_NEGATORS}\\b[^.!?]{0,80}\\b${READ_ONLY_MUTATION_VERBS}\\b`);
const READ_ONLY_WITHOUT_MUTATION = /\bwithout\s+(?:creating|submitting|saving|applying|approving|rejecting|updating|changing|filing|deleting|assigning)\b/;
const READ_ONLY_NOTHING_CHANGES = /\bnothing\s+(?:should|must|is\s+to\s+be)\s+(?:be\s+)?(?:created|submitted|saved|changed)\b/;

// "Plan to apply leave", "help me file a claim": the user is preparing a real
// transaction. This must stay a create/update route so the guided flow gathers
// mandatory fields and previews. The flow itself never auto-writes — the actual
// mutation is separately approval-gated — so honoring "do not create anything"
// here means "prepare and preview only", not "silently write".
const MUTATION_PREPARATION = /\b(?:plan to|plan for|help me(?: to)?\s+(?:create|raise|apply|submit|file|draft|add|update|change|cancel|approve|reject|assign|book|request)|prepare (?:to|a|an|my|the)|get ready to|walk me through (?:creating|raising|applying|submitting|filing|drafting|updating)|steps to (?:create|raise|apply|submit|file|draft|update)|set up (?:a|an|my)|draft (?:a|an|my))\b/;

// A matched site alias supplies the business object. This only establishes
// that the user wants to begin a guided transaction, independent of app names.
const USER_INITIATED_PREPARATION = /\b(?:(?:i\s+)?(?:need|want|would like|d like)\s+to|help me(?: to)?|please)\s+(?:request|apply|claim|correct|regulari[sz]e|book|raise|file|submit|create|start|prepare|get\s+(?:reimbursed|paid\s+back))\b/;

// Pure explanation / how-does-it-work requests want understanding, not a write.
const EXPLANATORY_REQUEST = /\b(?:explain|tell me|walk me through|what is|what s|how do i|how does|how to)\b[^.!?]*\b(?:process|works?|steps|requirements|flow|policy|apply|application|request)\b/;
const EXPLANATORY_MARKERS = /\b(?:information only|info only|read[- ]?only|for information|just information|do not act|no action|reference only)\b/;
const EXPLANATORY_INSPECT = /\b(?:explain|review|inspect|preview)\s+(?:only|the\s+(?:checks|requirements|workflow|process))\b/;

// The user refuses the mutation and explicitly redirects to reading data.
const READ_REDIRECT = /\b(?:show|list|see|view|display|find|get|check|tell me|give me)\b[^.!?]*\b(?:instead|current|pending|open|my|status|list)\b/;

function requestsReadOnlyReview(text: string): boolean {
  // A concrete preparation of a mutation stays a write route (guided, preview-first).
  if (MUTATION_PREPARATION.test(text) || USER_INITIATED_PREPARATION.test(text)) return false;
  if (EXPLANATORY_REQUEST.test(text) || EXPLANATORY_MARKERS.test(text) || EXPLANATORY_INSPECT.test(text)) return true;
  if (READ_ONLY_NEGATED_MUTATION.test(text) && (READ_REDIRECT.test(text) || !MUTATION_PREPARATION.test(text))) return true;
  if (READ_ONLY_WITHOUT_MUTATION.test(text)) return true;
  if (READ_ONLY_NOTHING_CHANGES.test(text)) return true;
  return false;
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
  if (text === normalizedPhrase || text.includes(normalizedPhrase)) return true;

  const textTerms = new Set(normalizeSearchTerms(text));
  const meaningfulPhraseTerms = normalizeSearchTerms(normalizedPhrase).filter((part) => part.length > 2);
  return meaningfulPhraseTerms.length > 0 && meaningfulPhraseTerms.every((part) => textTerms.has(part));
}

function aliasMatchScore(text: string, item: FrappeSemanticAlias): number {
  const phrase = normalizeText(item.phrase);
  const words = phrase.split(/\s+/).filter(Boolean);
  const textTerms = new Set(normalizeSearchTerms(text));
  const phraseTerms = normalizeSearchTerms(phrase);
  const sourceWeight = item.source === "admin_curated" ? 32
    : item.source === "erpnext_prior" ? 26
      : item.source === "report_name" ? 20
        : item.source === "field_label" ? 16
          : 12;
  const contiguous = text.includes(phrase) ? 24 : 0;
  const completePhrase = phraseTerms.length > 1 && phraseTerms.every((term) => textTerms.has(term))
    ? phraseTerms.length * 28
    : 0;
  return item.confidence * 100 + sourceWeight + contiguous + completePhrase + Math.min(words.length, 4) * 18;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[/-]+/g, " ").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

function normalizeSearchTerms(value: string): string[] {
  return normalizeText(value).split(/\s+/).filter(Boolean).map((term) => {
    const workplaceAlias: Readonly<Record<string, string>> = {
      chhutti: "leave",
      chhuttiya: "leave",
      chhuttiyan: "leave",
      chuti: "leave",
      chutti: "leave",
      chuttiya: "leave",
      chuttiyan: "leave",
      hazri: "attendance",
      kaam: "work",
      tanakhwa: "salary",
      tankhwa: "salary",
    };
    if (workplaceAlias[term]) return workplaceAlias[term];
    if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
    if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
    if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
    return term;
  });
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
