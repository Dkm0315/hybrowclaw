import type { SurfaceReply } from "./envelope.js";
import type { GatewayFrappeAssistantConfig } from "./gateway-config.js";
import type { FrappeOAuthAuthorization } from "./frappe-oauth.js";
import type { PairedIdentity } from "./pairing.js";
import { renderPresentationText, type SurfacePresentation } from "./presentation.js";
import type { FlowToolRegistry, TaskKind } from "@musterhq/core";
import type { FrappeInteractionOperation, PendingFrappeField } from "./frappe-interaction-store.js";

const GREETING_RE = /^(?:hi|hello|hey|yo|namaste|good\s+(?:morning|afternoon|evening))[\s!.?]*$/i;
const HELP_RE = /^(?:what\s+can\s+you\s+do(?:\s+for\s+me)?|how\s+can\s+you\s+help(?:\s+me)?|help\s+me|capabilities)[\s!.?]*$/i;
const SELF_DEPARTMENT_RE = /^(?:(?:which|what)\s+department\s+(?:am\s+i\s+in|do\s+i\s+belong\s+to|is\s+mine)|what(?:'s|\s+is)\s+my\s+department|my\s+department)[\s!.?]*$/i;
const SELF_COMPANY_RE = /^(?:(?:which|what)\s+company\s+(?:am\s+i\s+in|do\s+i\s+belong\s+to|is\s+mine)|what(?:'s|\s+is)\s+my\s+company|my\s+company)[\s!.?]*$/i;
const SELF_MANAGER_RE = /^(?:who\s+(?:is\s+my\s+(?:manager|reporting\s+manager)|do\s+i\s+report\s+to)|what(?:'s|\s+is)\s+my\s+reporting\s+manager|my\s+(?:manager|reporting\s+manager))[\s!.?]*$/i;
const SELF_EMPLOYEE_RE = /^(?:what(?:'s|\s+is)\s+my\s+employee\s+(?:id|number|status)|my\s+employee\s+(?:id|number|status))[\s!.?]*$/i;
const EXPLICIT_SCOPE_OVERREACH_RE = /(?:\b(?:outside|beyond|not\s+in)\s+(?:my\s+)?(?:reporting\s+(?:line|hierarchy)|team|department|assigned\s+scope|permitted\s+scope)\b|\b(?:ignore|bypass|override)\s+(?:all\s+)?(?:access\s+)?permissions?\b|\b(?:all|every)\s+(?:employee|staff|user|worker|person|people)s?\b[^.!?]{0,80}\b(?:salary|payroll|bank|account|personal|private|confidential)\b|\b(?:salary|payroll|bank|account|personal|private|confidential)\b[^.!?]{0,80}\b(?:all|every)\s+(?:employee|staff|user|worker|person|people)s?\b)/i;
const FRAPPE_FAST_ROUTE_TOOL = "frappe-federated-bridge__frappe_fast_route";
const FRAPPE_LIVE_READ_TOOL = "frappe-federated-bridge__frappe_semantic_data_resolve_lite";
const FRAPPE_INTERACTION_PLAN_TOOL = "frappe-federated-bridge__frappe_chat_interaction_plan";
const LIVE_CONTEXT_TIMEOUT_MS = 2_500;
const MAX_CONTEXT_CHARS = 24_000;
const EXPLICIT_ARTIFACT_RE = /(?:\b(?:create|draft|export|generate|make|prepare|produce|send)\b.{0,48}\b(?:docx|pdf|pptx|xlsx|document|presentation|slides?|spreadsheet|workbook)\b|\b(?:docx|pdf|pptx|xlsx)\b)/i;
const FRAPPE_BUSINESS_INTENTS = new Set([
  "record_lookup",
  "record_create",
  "record_update",
  "workflow_action",
  "report",
  "office_artifact",
  "permission_explanation",
  "troubleshooting",
]);

interface FastRouteResult {
  readonly intent?: string;
  readonly answerPath?: string;
  readonly candidateDoctypes?: readonly string[];
  readonly requiredChecks?: readonly string[];
  readonly reason?: string;
  readonly error?: string;
}

interface LiveReadResult {
  readonly doctype?: string;
  readonly rows?: readonly unknown[];
  readonly count?: number;
  readonly total?: number;
  readonly scope?: Readonly<Record<string, unknown>>;
  readonly status?: number;
  readonly excType?: string;
  readonly kind?: string;
  readonly error?: string;
  readonly view?: {
    readonly title?: string;
    readonly summary?: string;
    readonly emptyTitle?: string;
    readonly emptySummary?: string;
    readonly columns?: readonly { readonly field?: string; readonly label?: string }[];
  };
}

interface InteractionPlanResult {
  readonly kind?: string;
  readonly title?: string;
  readonly message?: string;
  readonly reason?: string;
  readonly operation?: string;
  readonly doctype?: string;
  readonly requiredFields?: readonly {
    readonly fieldname?: string;
    readonly label?: string;
    readonly reason?: string;
    readonly options?: readonly string[];
  }[];
  readonly next?: readonly { readonly label?: string; readonly detail?: string }[];
  readonly checks?: readonly { readonly label?: string; readonly reason?: string; readonly state?: string }[];
  readonly permission?: { readonly allowed?: boolean; readonly reason?: string };
  readonly mutationAllowed?: boolean;
  readonly table?: { readonly columns?: readonly string[]; readonly rows?: readonly string[][] };
  readonly error?: string;
}

export interface FrappePermissionContextResult {
  readonly prompt?: string;
  readonly context?: string;
  readonly intent?: string;
  readonly candidateDoctypes: readonly string[];
  readonly elapsedMs: number;
  readonly source: "none" | "route" | "live_frappe";
  readonly evidenceState: FrappeEvidenceState;
  readonly evidence?: readonly Record<string, unknown>[];
  readonly directReply?: boolean;
  readonly interaction?: Readonly<Record<string, unknown>>;
  readonly interactionReview?: boolean;
  readonly pendingInteraction?: {
    readonly doctype: string;
    readonly operation: FrappeInteractionOperation;
    readonly values: Readonly<Record<string, unknown>>;
    readonly requiredFields: readonly PendingFrappeField[];
  };
}

export type FrappeEvidenceState =
  | "not_requested"
  | "route_only"
  | "verified_empty"
  | "verified_matches"
  | "partial"
  | "permission_denied"
  | "unavailable";

/** Keep business intents on the cheapest capable route without weakening their tools. */
export function frappeTaskKindForIntent(intent: string | undefined, prompt: string): TaskKind | undefined {
  if (EXPLICIT_ARTIFACT_RE.test(prompt)) return "artifact";
  if (intent === "office_artifact") return "artifact";
  if (intent === "record_create" || intent === "record_update" || intent === "workflow_action") return "workflow";
  if (intent === "record_lookup" || intent === "report" || intent === "permission_explanation" || intent === "troubleshooting") return "simple_qa";
  return undefined;
}

/** Whether this turn must use Muster's OAuth/RBAC-bound Frappe data lane. */
export function isFrappeBusinessIntent(intent: string | undefined): boolean {
  return typeof intent === "string" && FRAPPE_BUSINESS_INTENTS.has(intent);
}

/**
 * Resolve evidence-only outcomes without paying for a provider turn. This is
 * deliberately generic: internal record types stay in the host packet, while
 * the user gets a truthful business answer that works for any Frappe app.
 */
export function frappeEvidenceQuickReply(result: FrappePermissionContextResult): SurfaceReply | undefined {
  const emptyView = result.evidence
    ?.map((item) => recordObject(item.view))
    .find((view) => view && (displayValue(view.emptyTitle) || displayValue(view.emptySummary)));
  const presentation: SurfacePresentation | undefined = result.pendingInteraction && result.interaction
    ? guidedInteractionPresentation(result.pendingInteraction, result.interaction)
    : result.interactionReview && result.interaction
    ? interactionReviewPresentation(result.interaction)
    : result.evidenceState === "verified_matches" && result.directReply
    ? liveEvidencePresentation(result)
    : result.evidenceState === "verified_empty"
    ? {
        kind: "status",
        title: displayValue(emptyView?.emptyTitle) ?? "Nothing found",
        summary: displayValue(emptyView?.emptySummary) ?? "There is nothing matching this request in the information available to you.",
      }
    : result.evidenceState === "permission_denied"
      ? {
          kind: "status",
          title: "This information is restricted",
          summary: "I checked your current access, and it does not include the information requested.",
          actions: [{ id: "identity", label: "Review my access", command: "/whoami" }],
        }
      : result.evidenceState === "unavailable"
        ? {
            kind: "status",
            title: "Could not verify this just now",
            summary: "The connected business system did not return a complete result, so I cannot give you a reliable answer yet.",
          }
        : undefined;
  return presentation ? { text: renderPresentationText(presentation), presentation } : undefined;
}

function guidedInteractionPresentation(
  pending: NonNullable<FrappePermissionContextResult["pendingInteraction"]>,
  interaction: Readonly<Record<string, unknown>>,
): SurfacePresentation {
  const next = pending.requiredFields[0];
  if (next) {
    const optionText = next.options?.length ? ` Choose one: ${next.options.join(", ")}.` : "";
    return {
      kind: "form",
      title: "A little more information is needed",
      summary: `What should the ${humanizeField(next.label).toLowerCase()} be?${optionText}${next.reason ? ` ${next.reason}` : ""}`,
      actions: [{ id: "cancel", label: "Cancel this request", command: "/cancel" }],
    };
  }
  const rows = Object.entries(pending.values)
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim())
    .map(([field, value]) => [humanizeField(field), String(value)]);
  return {
    kind: "form",
    title: "Review your request",
    summary: "I have the required information. Review it before anything is saved.",
    ...(rows.length ? { tables: [{ id: "request-preview", columns: ["Field", "Value"], rows }] } : {}),
    actions: [
      { id: "accept", label: "Accept & create", command: "/accept", style: "primary", kind: "confirm" },
      { id: "cancel", label: "Cancel this request", command: "/cancel" },
    ],
  };
}

function interactionReviewPresentation(interaction: Readonly<Record<string, unknown>>): SurfacePresentation {
  const required = Array.isArray(interaction.requiredDetails)
    ? interaction.requiredDetails.flatMap((value): Array<Record<string, unknown>> => {
        const record = recordObject(value);
        return record ? [record] : [];
      }).slice(0, 8)
    : [];
  const checks = Array.isArray(interaction.checks)
    ? interaction.checks.flatMap((value): Array<Record<string, unknown>> => {
        const record = recordObject(value);
        return record ? [record] : [];
      }).slice(0, 8)
    : [];
  const rows = [
    ...required.map((item) => [
      displayValue(item.label) ?? "Required detail",
      displayValue(item.reason) ?? "Required by the current form or workflow.",
    ]),
    ...checks.map((item) => [
      displayValue(item.label) ?? "Workflow check",
      [displayValue(item.reason), displayValue(item.state)].filter(Boolean).join(" · ") || "Checked against the current workflow.",
    ]),
  ];
  const summary = displayValue(interaction.message)
    ?? displayValue(interaction.reason)
    ?? (rows.length
      ? "I checked the current form and workflow requirements before preparing anything."
      : "I checked the current workflow, but it did not declare any additional required details for this step.");
  return {
    kind: "form",
    title: displayValue(interaction.title) ?? "Before anything is prepared",
    summary,
    audience: "self",
    ...(rows.length ? { tables: [{ id: "workflow-requirements", columns: ["Detail", "Why it is needed"], rows }] } : {}),
  };
}

const INTERNAL_ROW_FIELDS = new Set([
  "doctype", "docstatus", "idx", "owner", "creation", "modified_by", "parent", "parentfield", "parenttype",
  "reference_type", "reference_name", "permission_hash", "roles_hash",
]);
const PRIMARY_ROW_FIELDS = ["title", "subject", "employee_name", "task_name", "description", "name"];

function liveEvidencePresentation(result: FrappePermissionContextResult): SurfacePresentation | undefined {
  const completed = (result.evidence ?? []).filter((item) => item.status === "permission_filtered");
  if (!completed.length) return undefined;
  const exactTotal = completed.reduce((sum, item) => sum + (typeof item.total === "number" ? item.total : 0), 0);
  const exact = completed.every((item) => typeof item.total === "number");
  const visibleCount = completed.reduce((sum, item) => sum + (typeof item.count === "number" ? item.count : 0), 0);
  const count = exact ? exactTotal : visibleCount;
  const view = completed.map((item) => recordObject(item.view)).find(Boolean);
  const configuredColumns = Array.isArray(view?.columns) ? view.columns.flatMap((column) => {
    const item = recordObject(column);
    const field = item ? displayValue(item.field) : undefined;
    const label = item ? displayValue(item.label) : undefined;
    return field && label ? [{ field, label }] : [];
  }).slice(0, 5) : [];
  const configuredRows = configuredColumns.length ? completed.flatMap((item) => {
    return (Array.isArray(item.rows) ? item.rows : []).flatMap((row) => {
      const record = recordObject(row);
      return record ? [[...configuredColumns.map((column) => displayValue(record[column.field]) ?? "—")]] : [];
    });
  }).slice(0, 8) : [];
  const fallbackRows = completed.flatMap((item) => {
    const links = Array.isArray(item.recordLinks) ? item.recordLinks.filter((link): link is string => typeof link === "string") : [];
    return (Array.isArray(item.rows) ? item.rows : []).flatMap((row, index) => {
      const record = recordObject(row);
      if (!record) return [];
      const primaryKey = PRIMARY_ROW_FIELDS.find((key) => displayValue(record[key])) ?? Object.keys(record).find((key) => !INTERNAL_ROW_FIELDS.has(key) && displayValue(record[key]));
      const primary = primaryKey ? displayValue(record[primaryKey]) : undefined;
      if (!primary) return [];
      const details = Object.entries(record)
        .filter(([key, value]) => key !== primaryKey && !INTERNAL_ROW_FIELDS.has(key) && displayValue(value))
        .slice(0, 4)
        .map(([key, value]) => `${humanizeField(key)}: ${displayValue(value)}`);
      if (links[index]) details.push(`Open: ${links[index]}`);
      return [[primary, details.join(" · ")]];
    });
  }).slice(0, 8);
  const rows = configuredRows.length ? configuredRows : fallbackRows;
  const columns = configuredRows.length ? configuredColumns.map((column) => column.label) : ["Item", "Details"];
  return {
    kind: "report",
    title: displayValue(view?.title) ?? "Current results",
    summary: displayValue(view?.summary) ?? (exact
      ? `I found ${count} matching ${count === 1 ? "item" : "items"} in the information available to you.`
      : `I found ${count} matching ${count === 1 ? "item" : "items"} in the current result.`),
    audience: "self",
    ...(rows.length ? {
      tables: [{
        id: "live-results",
        columns,
        rows,
        ...(exact ? { pagination: { page: 1, pageSize: rows.length, totalRows: count } } : {}),
      }],
    } : {}),
  };
}

function recordObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function displayValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const compact = value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return compact ? compact.slice(0, 180) : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function humanizeField(value: string): string {
  return value.replace(/^custom_/, "").replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function canReplyDirectlyFromLiveRows(prompt: string, intent: string | undefined): boolean {
  if (intent !== "record_lookup") return false;
  if (/\b(?:why|explain|analyse|analyze|compare|summari[sz]e|trend|forecast|recommend|root cause|relationship|across)\b/i.test(prompt)) return false;
  return /\b(?:show|list|get|find|check|latest|recent|pending|open|count|how many|what|which|who|where|did i|have i|can i see)\b/i.test(prompt);
}

/** Fast, token-free answers for universal assistant orientation prompts. */
export function frappeChannelQuickReply(
  text: string,
  identity: PairedIdentity,
  assistant: GatewayFrappeAssistantConfig | undefined,
  liveAuthorization: boolean,
): SurfaceReply | undefined {
  const request = text.trim();
  const selfProfile = selfProfileReply(request, identity, assistant, liveAuthorization);
  if (selfProfile) return selfProfile;
  if (!GREETING_RE.test(request) && !HELP_RE.test(request)) return undefined;
  const name = assistant?.name?.trim() || "Work assistant";
  const organization = assistant?.organization?.trim();
  const experience = organization || name;
  const greeting = identity.employeeName?.trim() ? `Hi ${identity.employeeName.trim().split(/\s+/, 1)[0]}.` : "Hi.";
  const connectedNotice = liveAuthorization
    ? `You are connected to ${experience} with the access already assigned to you.`
    : `Connect your ${experience} account before asking me to read or change live information.`;
  const presentation: SurfacePresentation = HELP_RE.test(request)
    ? {
        kind: "menu",
        title: name,
        summary: `Ask naturally. I can find what needs attention, help complete permitted work, prepare reports or files, and show exactly what changed.`,
        notice: [
          `For example: “What needs my attention today?”, “Help me update this request”, or “Prepare a weekly summary I can share.”`,
          connectedNotice,
        ].join("\n"),
        actions: [
          { id: "reports", label: "Explore reports", command: "/reports" },
          { id: "identity", label: "Check my access", command: "/whoami" },
          { id: "security", label: "Review safeguards", command: "/security" },
        ],
      }
    : {
        kind: "status",
        title: name,
        summary: `${greeting} What would you like to get done in ${experience}?`,
        notice: connectedNotice,
        actions: [
          { id: "agents", label: "See a few examples", command: "/agents" },
          { id: "identity", label: "Check my access", command: "/whoami" },
        ],
      };
  return { text: renderPresentationText(presentation), presentation };
}

function selfProfileReply(
  request: string,
  identity: PairedIdentity,
  assistant: GatewayFrappeAssistantConfig | undefined,
  liveAuthorization: boolean,
): SurfaceReply | undefined {
  const requested = request
    .split(/\s*,\s*(?:and\s+)?|\s+and\s+/i)
    .map((part) => part.trim())
    .flatMap((part): Array<{ label: string; value: string | undefined }> => {
      if (SELF_DEPARTMENT_RE.test(part) || /\b(?:which|what)\s+(?:team|unit|function)\b|\bteam\s+am\s+i\s+(?:in|part of)\b/i.test(part)) {
        return [{ label: "Department", value: identity.departmentName ?? identity.department }];
      }
      if (SELF_COMPANY_RE.test(part)) return [{ label: "Company", value: identity.company }];
      if (SELF_MANAGER_RE.test(part)) return [{ label: "Reports to", value: identity.reportsToName ?? identity.reportsTo }];
      if (SELF_EMPLOYEE_RE.test(part)) {
        return [part.toLowerCase().includes("status")
          ? { label: "Employee status", value: identity.employeeStatus }
          : { label: "Employee ID", value: identity.employee }];
      }
      return [];
    });
  if (!requested.length) return undefined;

  const organization = assistant?.organization?.trim();
  const available = requested.filter((item) => item.value?.trim());
  const missing = requested.filter((item) => !item.value?.trim());
  const presentation: SurfacePresentation = available.length
    ? {
        kind: "status",
        title: organization ? `Your ${organization} profile` : "Your profile",
        summary: available.map((item) => `${item.label}: ${item.value!.trim()}`).join("\n"),
        notice: [
          liveAuthorization
            ? "Verified from the work account connected to this chat."
            : "Shown from the last verified sign-in. Reconnect before relying on recently changed details.",
          ...(missing.length ? [`Not available in the connected profile: ${missing.map((item) => item.label.toLowerCase()).join(", ")}.`] : []),
        ].join("\n"),
        actions: [{ id: "identity", label: "View my access", command: "/whoami" }],
      }
    : {
        kind: "status",
        title: organization ? `Your ${organization} profile` : "Your profile",
        summary: `I could not find ${requested.map((item) => item.label.toLowerCase()).join(" or ")} in the account connected to this chat.`,
        notice: liveAuthorization
          ? "If it was changed recently, reconnect your account and try again."
          : "Reconnect your account to refresh these details.",
        actions: [{ id: "pair", label: "Reconnect account", command: "/pair" }],
      };
  return { text: renderPresentationText(presentation), presentation };
}

/**
 * Build a bounded context packet through the paired user's OAuth grant. The
 * access token stays inside the host call and is never serialized into the
 * returned provider context.
 */
export async function frappePermissionContextForTurn(input: {
  readonly prompt: string;
  readonly surfaceId: string;
  readonly identity: PairedIdentity;
  readonly authorization: FrappeOAuthAuthorization;
  readonly registry?: FlowToolRegistry;
  readonly continuation?: {
    readonly doctype: string;
    readonly operation: FrappeInteractionOperation;
    readonly values: Readonly<Record<string, unknown>>;
  };
}): Promise<FrappePermissionContextResult> {
  const startedAt = Date.now();
  const routeTool = input.registry?.[FRAPPE_FAST_ROUTE_TOOL];
  if (!routeTool && !input.continuation) return { prompt: input.prompt, candidateDoctypes: [], elapsedMs: 0, source: "none", evidenceState: "not_requested" };
  const route = input.continuation ? {
    intent: input.continuation.operation === "create" ? "record_create" : input.continuation.operation === "update" ? "record_update" : "workflow_action",
    answerPath: "live_frappe",
    candidateDoctypes: [input.continuation.doctype],
    requiredChecks: ["live_permission_preflight", "preview_before_write"],
    reason: "Continue the pending permission-scoped interaction.",
  } : await boundedToolCall<FastRouteResult>(() => routeTool!({
    prompt: input.prompt,
    site: input.authorization.site,
    user: input.identity.user,
    roles: input.identity.roles,
    department: input.identity.department,
    channel: input.surfaceId,
    hasLiveCredentials: true,
  }));
  if (!route || route.error) return { prompt: input.prompt, candidateDoctypes: [], elapsedMs: Date.now() - startedAt, source: "none", evidenceState: "not_requested" };
  const candidates = uniqueStrings(route.candidateDoctypes).slice(0, 3);
  const routePacket = {
    intent: route.intent ?? "unknown",
    answerPath: route.answerPath ?? "provider_tiny_context",
    candidateDoctypes: candidates,
    requiredChecks: uniqueStrings(route.requiredChecks),
    reason: typeof route.reason === "string" ? route.reason : undefined,
  };
  if (EXPLICIT_SCOPE_OVERREACH_RE.test(input.prompt)) {
    return {
      prompt: input.prompt,
      context: boundedContext({
        route: routePacket,
        evidence: [],
        authority: "the connected user's current business-system permissions",
        instruction: "The request explicitly asks for records beyond the caller's authorized reporting scope. Do not query, infer, summarize, or reveal those records.",
      }),
      intent: "permission_explanation",
      candidateDoctypes: candidates,
      elapsedMs: Date.now() - startedAt,
      source: "route",
      evidenceState: "permission_denied",
      directReply: true,
    };
  }
  const token = tokenFromAuthorizationHeader(input.authorization.header);
  const interactionTool = (input.registry?.[FRAPPE_INTERACTION_PLAN_TOOL] as ((args: Record<string, unknown>) => Promise<unknown>) | undefined);
  const plannedOperation = interactionOperation(route.intent, input.prompt, input.continuation?.operation);
  const baseInteractionValues: Record<string, unknown> = {
    ...(input.continuation?.values ?? {}),
    ...(input.identity.employee ? { employee: input.identity.employee } : {}),
    ...(input.identity.employeeName ? { employee_name: input.identity.employeeName } : {}),
    ...(input.identity.company ? { company: input.identity.company } : {}),
  };
  const rawInteraction = token && interactionTool && shouldHydrateInteraction(route.intent, input.prompt)
      ? await boundedToolCall<InteractionPlanResult>(() => interactionTool({
          prompt: input.prompt,
          siteUrl: input.authorization.site,
          apiToken: token,
          user: input.identity.user,
          mode: interactionMode(route.intent, input.prompt),
          ...(input.continuation?.doctype ?? candidates[0] ? { doctype: input.continuation?.doctype ?? candidates[0] } : {}),
          ...(plannedOperation ? { operation: plannedOperation } : {}),
          values: baseInteractionValues,
      }))
    : undefined;
  const inferredInteractionValues: Record<string, unknown> = rawInteraction && !rawInteraction.error
    ? inferInteractionValues(input.prompt, rawInteraction, baseInteractionValues)
    : baseInteractionValues;
  const interaction = rawInteraction && !rawInteraction.error
    ? {
        ...rawInteraction,
        requiredFields: rawInteraction.requiredFields?.filter((field) => !field.fieldname || inferredInteractionValues[field.fieldname] === undefined),
      }
    : rawInteraction;
  const safeInteraction = interaction && !interaction.error ? safeInteractionPlan(interaction) : undefined;
  const pendingInteraction = interaction && !interaction.error
    ? pendingInteractionPlan(interaction, inferredInteractionValues)
    : undefined;
  const interactionReview = Boolean(safeInteraction && requestsReadOnlyReview(input.prompt));
  const readTool = input.registry?.[FRAPPE_LIVE_READ_TOOL];
  if (!readTool || !shouldPrefetchLive(route.intent) || candidates.length === 0) {
    return {
      prompt: input.prompt,
      context: boundedContext({
        route: routePacket,
        ...(safeInteraction ? { interaction: safeInteraction } : {}),
        evidence: [],
        note: interaction && !interaction.error
          ? "The interaction plan reflects the connected site's current mandatory fields and workflow rules. Ask in business language and one step at a time."
          : "No live record payload was prefetched for this intent.",
      }),
      intent: route.intent,
      candidateDoctypes: candidates,
      elapsedMs: Date.now() - startedAt,
      source: "route",
      evidenceState: "route_only",
      ...(safeInteraction ? { interaction: safeInteraction } : {}),
      ...(pendingInteraction ? { pendingInteraction } : {}),
      ...(interactionReview ? { interactionReview: true } : {}),
    };
  }

  if (!token) return { prompt: input.prompt, candidateDoctypes: candidates, elapsedMs: Date.now() - startedAt, source: "route", evidenceState: "route_only" };
  const directReplyRequested = canReplyDirectlyFromLiveRows(input.prompt, route.intent);
  const liveCandidates = liveReadCandidates(candidates, input.prompt, directReplyRequested);
  const evidence = await Promise.all(liveCandidates.map(async (doctype): Promise<Record<string, unknown>> => {
    const scope = readScopeForPrompt(input.prompt, input.identity, route.intent);
    const read = await boundedToolCallResult<LiveReadResult>(() => readTool({
      siteUrl: input.authorization.site,
      apiToken: token,
      user: input.identity.user,
      doctype,
      prompt: input.prompt,
      scope,
      includeTotal: /\b(?:how many|count)\b/i.test(input.prompt),
      limit: 12,
    }));
    if (read.state === "timeout") {
      return { doctype, status: "timeout" };
    }
    if (read.state === "error") return { doctype, status: "unavailable" };
    const result = read.value;
    if (!result || typeof result !== "object") return { doctype, status: "unavailable" };
    if (result.error) {
      return { doctype, status: liveReadFailureStatus(result), reason: boundedReason(result.error) };
    }
    return {
      doctype: result.doctype ?? doctype,
      status: "permission_filtered",
      count: typeof result.count === "number" ? result.count : Array.isArray(result.rows) ? result.rows.length : 0,
      ...(typeof result.total === "number" ? { total: result.total, countIsExact: true } : {}),
      ...(result.scope ? { scope: result.scope } : {}),
      ...(result.view ? { view: result.view } : {}),
      rows: Array.isArray(result.rows) ? result.rows : [],
      recordLinks: recordLinks(input.authorization.site, result.doctype ?? doctype, result.rows),
    };
  }));
  const evidenceState = summarizeEvidenceState(evidence);
  const directReply = directReplyRequested || route.intent === "record_lookup" && evidence.some((item) => {
    const scope = recordObject(item.scope);
    return Boolean(item.view && scope && displayValue(scope.api));
  });
  return {
    prompt: input.prompt,
    context: boundedContext({
      route: routePacket,
      ...(safeInteraction ? { interaction: safeInteraction } : {}),
      evidence,
      authority: "live Frappe API using this channel sender's OAuth principal",
      instruction: "Use only this evidence for live values. A successful zero-row result means no match was found inside this user's permitted scope. A timeout, denial, or unavailable result is unknown rather than empty. Speak in human business language and never expose internal record-type names, fields, routes, tools, protocols, or failure jargon.",
    }),
    intent: route.intent,
    candidateDoctypes: candidates,
    elapsedMs: Date.now() - startedAt,
    source: "live_frappe",
    evidenceState,
    evidence,
    directReply,
    ...(safeInteraction ? { interaction: safeInteraction } : {}),
    ...(pendingInteraction ? { pendingInteraction } : {}),
    ...(interactionReview ? { interactionReview: true } : {}),
  };
}

function inferInteractionValues(
  prompt: string,
  plan: InteractionPlanResult,
  current: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const values = { ...current };
  const topic = /\b(?:about|regarding)\s+(.+?)(?:[.!?]+)?$/i.exec(prompt)?.[1]?.trim();
  if (!topic || topic.length < 3 || topic.length > 240) return values;
  for (const field of plan.requiredFields ?? []) {
    const fieldname = field.fieldname?.trim();
    if (!fieldname || values[fieldname] !== undefined) continue;
    const key = fieldname.toLowerCase();
    if (key === "subject" || key === "title" || key === "description" || key === "details") {
      values[fieldname] = topic;
    }
  }
  return values;
}

function pendingInteractionPlan(
  plan: InteractionPlanResult,
  values: Readonly<Record<string, unknown>>,
): FrappePermissionContextResult["pendingInteraction"] {
  if (!plan.doctype || !isInteractionOperation(plan.operation)) return undefined;
  const requiredFields = (plan.requiredFields ?? []).flatMap((field): PendingFrappeField[] => {
    if (!field.fieldname?.trim() || !field.label?.trim()) return [];
    return [{
      fieldname: field.fieldname,
      label: field.label,
      ...(field.reason ? { reason: field.reason } : {}),
      ...(field.options?.length ? { options: field.options.slice(0, 20) } : {}),
    }];
  }).slice(0, 32);
  return { doctype: plan.doctype, operation: plan.operation, values: { ...values }, requiredFields };
}

function isInteractionOperation(value: string | undefined): value is FrappeInteractionOperation {
  return value === "create" || value === "update" || value === "submit" || value === "approve" || value === "reject";
}

function summarizeEvidenceState(evidence: readonly Record<string, unknown>[]): FrappeEvidenceState {
  if (!evidence.length) return "route_only";
  const completed = evidence.filter((item) => item.status === "permission_filtered");
  const failed = evidence.filter((item) => item.status !== "permission_filtered");
  if (completed.length) {
    const matches = completed.some((item) => {
      const count = typeof item.total === "number" ? item.total : item.count;
      return typeof count === "number" && count > 0;
    });
    if (failed.length) return "partial";
    return matches ? "verified_matches" : "verified_empty";
  }
  if (evidence.every((item) => item.status === "permission_denied")) return "permission_denied";
  return "unavailable";
}

function shouldHydrateInteraction(intent: string | undefined, prompt: string): boolean {
  return intent === "record_create"
    || intent === "record_update"
    || intent === "workflow_action"
    || (intent === "record_lookup" && /\b(?:workflow|requirements?|mandatory|before\s+(?:preparing|creating|submitting)|how\s+would\s+you\s+help|review\s+my)\b/i.test(prompt));
}

function safeInteractionPlan(plan: InteractionPlanResult): Record<string, unknown> {
  return {
    kind: plan.kind,
    title: plan.title,
    message: plan.message,
    reason: plan.reason,
    operation: plan.operation,
    requiredDetails: plan.requiredFields?.slice(0, 12).map((field) => ({
      label: field.label,
      reason: field.reason,
      options: field.options?.slice(0, 20),
    })),
    next: plan.next?.slice(0, 5),
    checks: plan.checks?.slice(0, 12).map((check) => ({
      label: check.label,
      reason: check.reason,
      state: check.state,
    })),
    permission: plan.permission,
    mutationAllowed: plan.mutationAllowed,
  };
}

function shouldPrefetchLive(intent: string | undefined): boolean {
  return intent === "record_lookup" || intent === "report" || intent === "permission_explanation";
}

function readScopeForPrompt(prompt: string, identity: PairedIdentity, intent?: string): Record<string, unknown> {
  if (/\b(?:my team|my department|direct reports?|reporting to me|people i manage|my juniors?)\b/i.test(prompt)) {
    return { mode: "team", authority: "frappe_permissions" };
  }
  if (intent === "record_lookup" || /\b(?:my|mine|for me|assigned to me|owned by me|i have|have i|did i|am i|can i see|could i see)\b/i.test(prompt)) {
    return {
      mode: "self",
      user: identity.user,
      ...(identity.employee ? { employee: identity.employee } : {}),
    };
  }
  return { mode: "none", authority: "frappe_permissions" };
}

function requestsReadOnlyReview(prompt: string): boolean {
  return /\b(?:do not|don't|dont|never)\b[^.!?]{0,80}\b(?:create|submit|save|apply|approve|reject|update|change)\b/i.test(prompt)
    || /\bwithout\s+(?:creating|submitting|saving|applying|approving|rejecting|updating|changing)\b/i.test(prompt);
}

function interactionMode(intent: string | undefined, prompt: string): "inspect" | "act" {
  if (intent === "record_create" || intent === "record_update" || intent === "workflow_action") return "act";
  return requestsReadOnlyReview(prompt) ? "inspect" : "act";
}

function interactionOperation(
  intent: string | undefined,
  prompt: string,
  continuation?: FrappeInteractionOperation,
): FrappeInteractionOperation | undefined {
  if (continuation) return continuation;
  if (intent === "record_create") return "create";
  if (intent === "record_update") return "update";
  if (intent === "workflow_action") {
    if (/\breject\b/i.test(prompt)) return "reject";
    if (/\bapprove\b/i.test(prompt)) return "approve";
  }
  return undefined;
}

function liveReadCandidates(candidates: readonly string[], prompt: string, directReply: boolean): string[] {
  if (!directReply) return candidates.slice(0, 2);
  const normalizedPrompt = lexicalWords(prompt);
  const explicitlyNamed = candidates.filter((candidate) => {
    const words = lexicalWords(candidate);
    return words.length > 0 && words.every((word) => normalizedPrompt.includes(word));
  });
  // Preserve intentionally multi-domain requests (for example, tasks and
  // todos). A single-domain answer must not absorb semantically related rows.
  return explicitlyNamed.length > 1 ? explicitlyNamed.slice(0, 2) : candidates.slice(0, 1);
}

function lexicalWords(value: string): string[] {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/)
    .filter(Boolean)
    .map((word) => word.endsWith("ies") ? `${word.slice(0, -3)}y` : word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word);
}

function liveReadFailureStatus(result: Pick<LiveReadResult, "error" | "status" | "excType" | "kind">): "permission_denied" | "unavailable" {
  return result.kind === "permission_denied"
    || result.status === 403
    || /permission\s*error/i.test(result.excType ?? "")
    || /\b(?:permission|not permitted|not allowed|access denied|forbidden|403)\b/i.test(result.error ?? "")
    ? "permission_denied"
    : "unavailable";
}

function tokenFromAuthorizationHeader(header: string): string | undefined {
  const match = /^(?:Bearer|token)\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

async function boundedToolCall<T>(call: () => Promise<unknown>): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      call() as Promise<T>,
      new Promise<undefined>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(undefined), LIVE_CONTEXT_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type BoundedToolCallResult<T> =
  | { readonly state: "ok"; readonly value: T }
  | { readonly state: "timeout" }
  | { readonly state: "error" };

async function boundedToolCallResult<T>(call: () => Promise<unknown>): Promise<BoundedToolCallResult<T>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      (call() as Promise<T>).then((value): BoundedToolCallResult<T> => ({ state: "ok", value }))
        .catch((): BoundedToolCallResult<T> => ({ state: "error" })),
      new Promise<BoundedToolCallResult<T>>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout({ state: "timeout" }), LIVE_CONTEXT_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function uniqueStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()))]
    : [];
}

function boundedReason(value: string): string {
  const sanitized = value.replace(/https?:\/\/[^\s]+/gi, "the connected Frappe site").replace(/\s+/g, " ").trim();
  return sanitized.slice(0, 300);
}

function boundedContext(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized.length <= MAX_CONTEXT_CHARS ? serialized : `${serialized.slice(0, MAX_CONTEXT_CHARS - 16)}\"truncated\":true}`;
}

function recordLinks(site: string, doctype: string, rows: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(rows)) return [];
  const route = doctype.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return rows.flatMap((row) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) return [];
    const name = (row as Record<string, unknown>).name;
    return typeof name === "string" && name ? [`${site.replace(/\/$/, "")}/app/${route}/${encodeURIComponent(name)}`] : [];
  });
}
