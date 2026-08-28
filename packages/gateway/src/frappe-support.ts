import { randomUUID } from "node:crypto";
import type { GatewayFrappeSupportConfig } from "./gateway-config.js";
import type { TrustedFrappeContext } from "./frappe-ingress.js";
import type { PairedIdentity } from "./pairing.js";

export const DEFAULT_FRAPPE_SUPPORT_SITE = "https://support.hybrowlabs.com";

export interface FrappeSupportDestination {
  readonly site: string;
  readonly connectionId?: string;
  readonly authMode: "oauth" | "guest";
  readonly doctype: "HD Ticket" | "Issue";
  readonly priority?: string;
  readonly customer?: string;
}

export interface FrappeSupportDraft {
  readonly destination: FrappeSupportDestination;
  readonly subject: string;
  readonly description: string;
  readonly values: Readonly<Record<string, unknown>>;
}

export type GuestFrappeSupportWriteResult =
  | { readonly state: "verified"; readonly name: string; readonly record: Readonly<Record<string, unknown>>; readonly verification: "reread" | "create_response" }
  | { readonly state: "rejected"; readonly reason: string }
  | { readonly state: "uncertain"; readonly reason: string };

export interface FrappeSupportInvestigationEvidence {
  readonly expected?: string;
  readonly observed?: string;
  readonly businessImpact?: string;
  readonly likelyLocations?: readonly string[];
  readonly affectedRecords?: readonly { readonly label: string; readonly doctype: string; readonly name: string }[];
  readonly appVersions?: Readonly<Record<string, string>>;
  readonly reproduction?: readonly string[];
  readonly validation?: readonly string[];
  /** Sanitized, bounded error fingerprints or log excerpts; never raw logs. */
  readonly errorEvidence?: readonly string[];
  readonly evidenceIds?: readonly string[];
}

const REPORT_ISSUE_RE = /(?:^\s*\/report-issue\b|\b(?:report|raise|log|escalate)\b.{0,60}\b(?:this|it|issue|problem|mismatch|failure)\b.{0,40}\b(?:to\s+)?support\b|\b(?:send|escalate)\b.{0,36}\b(?:this|it|issue|problem|mismatch|failure)\b.{0,24}\b(?:to\s+)?support\b|\b(?:check\s+(?:and\s+)?)?send\s+(?:this\s+|it\s+)?to\s+support\b)/i;
const EXPLICIT_SUPPORT_TICKET_RE = /(?:\b(?:migration|customi[sz]ation|failure|error|issue|mismatch|evidence)\b.{0,80}\b(?:create|open|raise|prepare|draft)\b.{0,36}\b(?:support\s+)?ticket\b|\b(?:create|open|raise|prepare|draft)\b.{0,36}\b(?:support\s+)?ticket\b.{0,80}\b(?:migration|customi[sz]ation|failure|error|issue|mismatch|evidence)\b)/i;
const NEGATED_REPORT_ISSUE_RE = /\b(?:do\s+not|don't|dont|no\s+need\s+to|without)\b.{0,28}\b(?:send|report|raise|create|open|log|escalate)\b.{0,36}\bsupport\b/i;
const SECRET_ASSIGNMENT_RE = /(^|[\s{,;\[])["']?(access[_ -]?token|refresh[_ -]?token|csrf[_ -]?token|client[_ -]?secret|api[_ -]?key|authorization|cookie2?|password|(?:[a-z0-9]+[_ -]+)+(?:token|key|secret|password|authorization|cookie)|(?:token|key|secret|password|authorization|cookie)(?:[_ -]+[a-z0-9]+)+)["']?\s*[:=]/i;
const TOKEN_ASSIGNMENT_RE = /(^|[\s{,;\[])(?:(?:["']token["']\s*:)|(?:token\s*=)|(?:token\s*:\s*(?=["']|[A-Za-z0-9._~+\/-]+(?:[,;}\]]|$))))/i;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\b/g;
const SENSITIVE_QUERY_RE = /([?&#](?:access_token|refresh_token|client_secret|api_key|token|key|signature|sig|code)=)[^&#\s]+/gi;
const URL_USERINFO_RE = /\bhttps?:\/\/[^\s\/@:]+:[^\s\/@]+@/gi;
const SET_COOKIE_RE = /\bset-cookie2?\s*:/i;
const UNTRUSTED_URL_RE = /(?:\bhttps?:\/\/|\/\/|\bwww\.)[^\s<>()]+/gi;
const UNTRUSTED_EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

export function isFrappeIssueReportRequest(prompt: string): boolean {
  return !NEGATED_REPORT_ISSUE_RE.test(prompt) && (REPORT_ISSUE_RE.test(prompt) || EXPLICIT_SUPPORT_TICKET_RE.test(prompt));
}

export function resolveFrappeSupportDestination(config?: GatewayFrappeSupportConfig): FrappeSupportDestination {
  const site = normalizedHttpsOrigin(config?.site ?? DEFAULT_FRAPPE_SUPPORT_SITE);
  const connectionId = cleanOptional(config?.connectionId, 80);
  const priority = cleanOptional(config?.priority, 80);
  const customer = cleanOptional(config?.customer, 140);
  const authMode = config?.authMode ?? "oauth";
  const doctype = config?.doctype ?? "HD Ticket";
  if (authMode !== "oauth" && authMode !== "guest") throw new Error("Frappe support authentication mode is unsupported.");
  if (doctype !== "HD Ticket" && doctype !== "Issue") throw new Error("Frappe support ticket type is unsupported.");
  if (authMode === "guest" && connectionId) throw new Error("Guest Frappe support intake cannot use an OAuth connection id.");
  if (authMode === "guest" && (!config?.site || !config.doctype)) {
    throw new Error("Guest Frappe support intake requires an explicit site and ticket type.");
  }
  return Object.freeze({
    site,
    ...(connectionId ? { connectionId } : {}),
    authMode,
    doctype,
    ...(priority ? { priority } : {}),
    ...(customer ? { customer } : {}),
  });
}

/**
 * Submit one already-reviewed ticket to an explicitly configured public
 * Frappe intake. This function never retries a POST. Callers must persist an
 * execution claim before invoking it and reconcile uncertain outcomes by the
 * embedded request reference.
 */
export async function createGuestFrappeSupportTicket(input: {
  readonly destination: FrappeSupportDestination;
  readonly values: Readonly<Record<string, unknown>>;
  readonly fetcher?: typeof fetch;
}): Promise<GuestFrappeSupportWriteResult> {
  assertGuestDestination(input.destination);
  const fetcher = input.fetcher ?? fetch;
  const url = resourceUrl(input.destination);
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(input.values),
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    return { state: "uncertain", reason: "The public Helpdesk endpoint did not confirm whether the ticket was created." };
  }
  const payload = await responseJson(response);
  if (!response.ok) {
    if (response.status >= 400 && response.status < 500 && ![408, 409, 425, 429].includes(response.status)) {
      return { state: "rejected", reason: "The public Helpdesk endpoint rejected the reviewed ticket as invalid or incomplete." };
    }
    return { state: "uncertain", reason: "The public Helpdesk endpoint returned an uncertain result." };
  }
  const created = record(payload?.data);
  const name = cleanRecordName(created?.name);
  if (!name) return { state: "uncertain", reason: "Helpdesk accepted the request but did not return a verifiable ticket reference." };
  const reread = await readGuestFrappeSupportTicket(input.destination, name, fetcher);
  if (reread.state === "verified") {
    return approvedValuesMatch(input.values, reread.record)
      ? { state: "verified", name, record: reread.record, verification: "reread" }
      : { state: "uncertain", reason: "The created ticket does not match the reviewed evidence." };
  }
  if (approvedValuesMatch(input.values, created)) {
    return { state: "verified", name, record: created!, verification: "create_response" };
  }
  return { state: "uncertain", reason: "Helpdesk returned a ticket reference, but its approved fields could not be verified." };
}

/** Look up a prior uncertain public submission without issuing another POST. */
export async function reconcileGuestFrappeSupportTicket(input: {
  readonly destination: FrappeSupportDestination;
  readonly values: Readonly<Record<string, unknown>>;
  readonly fetcher?: typeof fetch;
}): Promise<GuestFrappeSupportWriteResult> {
  assertGuestDestination(input.destination);
  const reference = requestReference(input.values);
  if (!reference) return { state: "rejected", reason: "The reviewed ticket has no reconciliation reference." };
  const fetcher = input.fetcher ?? fetch;
  const url = resourceUrl(input.destination);
  url.searchParams.set("fields", JSON.stringify(["name", "doctype", ...Object.keys(input.values)]));
  url.searchParams.set("filters", JSON.stringify([[input.destination.doctype, "description", "like", `%${reference}%`]]));
  url.searchParams.set("limit_page_length", "2");
  let response: Response;
  try {
    response = await fetcher(url, { method: "GET", headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(8_000) });
  } catch {
    return { state: "uncertain", reason: "Helpdesk reconciliation is temporarily unavailable." };
  }
  if (!response.ok) return { state: "uncertain", reason: "Helpdesk does not currently permit public ticket reconciliation." };
  const payload = await responseJson(response);
  const rows = Array.isArray(payload?.data) ? payload.data.map(record).filter((value): value is Record<string, unknown> => Boolean(value)) : [];
  if (rows.length !== 1) return { state: "uncertain", reason: rows.length ? "More than one matching ticket was returned; no ticket was selected." : "No uniquely matching ticket has appeared yet." };
  const name = cleanRecordName(rows[0].name);
  if (!name || !approvedValuesMatch(input.values, rows[0])) return { state: "uncertain", reason: "The matching ticket does not verify against the reviewed evidence." };
  return { state: "verified", name, record: rows[0], verification: "reread" };
}

export function createFrappeSupportDraft(input: {
  readonly prompt: string;
  readonly identity: PairedIdentity;
  readonly context?: TrustedFrappeContext;
  readonly config?: GatewayFrappeSupportConfig;
  readonly investigation?: FrappeSupportInvestigationEvidence;
}): FrappeSupportDraft {
  const destination = resolveFrappeSupportDestination(input.config);
  const context = input.context;
  const source = sanitize(context?.pageName?.trim() || context?.docname?.trim() || context?.doctype?.trim()) || "Frappe workspace";
  const request = issueText(input.prompt);
  const subject = bounded(`Issue from ${source}: ${request || "investigation requested"}`, 140).replace(/[\r\n]+/g, " ");
  const reporter = sanitize(input.identity.userName?.trim() || input.identity.employeeName?.trim() || input.identity.user);
  const requestReference = `MUSTER-${randomUUID()}`;
  const sourceLink = trustedRecordLink(input.identity.site, context);
  const investigation = normalizeInvestigation(input.investigation, input.identity.site);
  const sections = [
    ["Reported by", reporter],
    ["Source site", normalizedHttpsOrigin(input.identity.site)],
    ["Current context", source],
    ["Request", request || "Investigate the issue visible in the current context."],
    ["Request reference", requestReference],
    ["Permission-filtered evidence", sanitize(context?.summary) || "No record summary was supplied by the source site."],
    ["Affected record", sourceLink],
    ["Expected state", investigation.expected],
    ["Observed state", investigation.observed],
    ["Business impact", investigation.businessImpact],
    ["Affected records", investigation.affectedRecords],
    ["Likely customization locations", investigation.likelyLocations],
    ["Application and schema versions", investigation.appVersions],
    ["Sanitized error evidence", investigation.errorEvidence],
    ["Reproduction", investigation.reproduction],
    ["Validation results", investigation.validation],
    ["Evidence references", investigation.evidenceIds],
    ["Expected next step", "Reproduce within the reporter's permitted context, identify the broken customization or workflow boundary, and record expected versus observed behavior."],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));
  const description = sections.map(([label, value]) => `### ${label}\n${value}`).join("\n\n");
  const values: Record<string, unknown> = { subject, description };
  if (destination.priority) values.priority = destination.priority;
  if (destination.customer) values.customer = destination.customer;
  return Object.freeze({ destination, subject, description, values: Object.freeze(values) });
}

function normalizeInvestigation(evidence: FrappeSupportInvestigationEvidence | undefined, site: string): Record<string, string | undefined> {
  if (!evidence) return {};
  const affectedRecords = evidence.affectedRecords?.slice(0, 100).map((record) => {
    const label = sanitize(record.label);
    const doctype = sanitize(record.doctype);
    const name = sanitize(record.name);
    if (!label || !doctype || !name) return undefined;
    const route = doctype.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return `- ${label}: ${normalizedHttpsOrigin(site)}/app/${route}/${encodeURIComponent(name)}`;
  }).filter((value): value is string => Boolean(value)).join("\n");
  const versions = Object.entries(evidence.appVersions ?? {}).slice(0, 100).map(([app, version]) => `- ${sanitize(app)}: ${sanitize(version)}`).join("\n");
  return {
    expected: sanitize(evidence.expected),
    observed: sanitize(evidence.observed),
    businessImpact: sanitize(evidence.businessImpact),
    likelyLocations: bulletList(evidence.likelyLocations),
    affectedRecords,
    appVersions: versions,
    errorEvidence: bulletList(evidence.errorEvidence),
    reproduction: numberedList(evidence.reproduction),
    validation: bulletList(evidence.validation),
    evidenceIds: bulletList(evidence.evidenceIds?.filter((id) => /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(id))),
  };
}

function bulletList(values: readonly string[] | undefined): string | undefined {
  const items = values?.slice(0, 100).map(sanitize).filter(Boolean) ?? [];
  return items.length ? items.map((value) => `- ${value}`).join("\n") : undefined;
}

function numberedList(values: readonly string[] | undefined): string | undefined {
  const items = values?.slice(0, 100).map(sanitize).filter(Boolean) ?? [];
  return items.length ? items.map((value, index) => `${index + 1}. ${value}`).join("\n") : undefined;
}

function issueText(prompt: string): string {
  const withoutCommand = prompt.replace(/^\s*\/report-issue\s*/i, "").trim();
  if (!withoutCommand || /^(?:this|it|the issue|this issue)[.!?]*$/i.test(withoutCommand)) return "";
  return bounded(sanitize(withoutCommand), 500);
}

function trustedRecordLink(site: string, context?: TrustedFrappeContext): string | undefined {
  if (!context?.doctype || !context.docname) return undefined;
  const route = context.doctype.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${normalizedHttpsOrigin(site)}/app/${route}/${encodeURIComponent(context.docname)}`;
}

function sanitize(value: string | undefined): string {
  return bounded(escapeUntrustedMarkdown(redactSecretBearingLines(value ?? "")
    .replace(URL_USERINFO_RE, "https://[redacted]@")
    .replace(BEARER_RE, "Bearer [redacted]")
    .replace(SENSITIVE_QUERY_RE, "$1[redacted]")
    .replace(JWT_RE, "[redacted-token]")
    .replace(/\]\(([^)\r\n]*)\)/g, (link, target: string) => unsafeMarkdownTarget(target) ? "]([removed-link])" : link)
    .replace(/^(\s{0,3}\[(?:\\.|[^\]\r\n])+\]:\s*)(?:<([^>\r\n]*)>|(\S+))/gm, (definition, prefix: string, angled: string | undefined, plain: string | undefined) => {
      const target = angled ?? plain ?? "";
      return unsafeMarkdownTarget(target) ? `${prefix}[removed-link]` : definition;
    })
    .replace(/<[^>]*>/g, "[removed-markup]")
    .replace(UNTRUSTED_URL_RE, "[external-link-removed]")
    .replace(UNTRUSTED_EMAIL_RE, "[email-removed]")
    .trim()), 12_000);
}

function redactSecretBearingLines(value: string): string {
  let redactContinuation: "single" | "block" | undefined;
  return value.split(/\r?\n/).map((line) => {
    if (redactContinuation) {
      if (!line.trim()) return line;
      if (redactContinuation === "single" || /^\s+/.test(line)) {
        if (redactContinuation === "single") redactContinuation = undefined;
        return `${line.match(/^\s*/)?.[0] ?? ""}[redacted]`;
      }
      redactContinuation = undefined;
    }
    const setCookie = SET_COOKIE_RE.exec(line);
    if (setCookie?.index !== undefined) return `${line.slice(0, setCookie.index)}Set-Cookie: [redacted]`;
    const secretMatch = SECRET_ASSIGNMENT_RE.exec(line);
    const match = secretMatch ?? TOKEN_ASSIGNMENT_RE.exec(line);
    if (!match || match.index === undefined) return line;
    const prefix = match[1] ?? "";
    const key = match[2] ?? "token";
    const assignment = match[0];
    const suffix = line.slice(match.index + assignment.length).trim();
    const delimiter = assignment.trimEnd().at(-1);
    const looksLikeProse = !secretMatch && delimiter === ":"
      && suffix.length > 0
      && !/^["'|>]/.test(suffix)
      && /\s/.test(suffix);
    if (looksLikeProse) return line;
    if (delimiter === ":" && !suffix) redactContinuation = "single";
    else if (delimiter === ":" && /^[|>][+-]?\s*(?:#.*)?$/.test(suffix)) redactContinuation = "block";
    return `${line.slice(0, match.index)}${prefix}${key}=[redacted]`;
  }).join("\n");
}

function escapeUntrustedMarkdown(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/([`*_[\]{}()#+!|>])/g, "\\$1");
}

function unsafeMarkdownTarget(target: string): boolean {
  const decoded = target
    .replace(/\\(.)/g, "$1")
    .replace(/&#(?:x([0-9a-f]+)|(\d+));?/gi, (_entity, hex: string | undefined, decimal: string | undefined) => {
      const codePoint = Number.parseInt(hex ?? decimal ?? "", hex ? 16 : 10);
      return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : "";
    })
    .replace(/&#(?:0*58|x0*3a);?/gi, ":")
    .replace(/&colon;?/gi, ":")
    .replace(/&(tab|newline);?/gi, "")
    .replace(/[\u0000-\u0020]+/g, "")
    .toLowerCase();
  return decoded.startsWith("javascript:") || decoded.startsWith("data:");
}

function cleanOptional(value: string | undefined, max: number): string | undefined {
  const clean = value?.trim();
  if (!clean) return undefined;
  if (clean.length > max || /[\r\n\0]/.test(clean)) throw new Error("Frappe support configuration contains an invalid value.");
  return clean;
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function assertGuestDestination(destination: FrappeSupportDestination): void {
  if (destination.authMode !== "guest") throw new Error("Public Helpdesk intake was not explicitly configured.");
  normalizedHttpsOrigin(destination.site);
  if (!destination.doctype) throw new Error("Public Helpdesk intake requires an explicit ticket type.");
}

function resourceUrl(destination: FrappeSupportDestination, name?: string): URL {
  const path = `/api/resource/${encodeURIComponent(destination.doctype)}${name ? `/${encodeURIComponent(name)}` : ""}`;
  return new URL(path, destination.site);
}

async function readGuestFrappeSupportTicket(
  destination: FrappeSupportDestination,
  name: string,
  fetcher: typeof fetch,
): Promise<{ readonly state: "verified"; readonly record: Readonly<Record<string, unknown>> } | { readonly state: "unavailable" }> {
  let response: Response;
  try {
    response = await fetcher(resourceUrl(destination, name), {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    return { state: "unavailable" };
  }
  if (!response.ok) return { state: "unavailable" };
  const payload = await responseJson(response);
  const value = record(payload?.data);
  return value ? { state: "verified", record: value } : { state: "unavailable" };
}

async function responseJson(response: Response): Promise<Record<string, unknown> | undefined> {
  return record(await response.json().catch(() => undefined));
}

function requestReference(values: Readonly<Record<string, unknown>>): string | undefined {
  const description = typeof values.description === "string" ? values.description : "";
  return description.match(/\bMUSTER-[0-9a-f-]{36}\b/i)?.[0];
}

function cleanRecordName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim();
  return clean && clean.length <= 240 && !/[\r\n\0]/.test(clean) ? clean : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function approvedValuesMatch(expected: Readonly<Record<string, unknown>>, actual: Readonly<Record<string, unknown>> | undefined): boolean {
  if (!actual) return false;
  return Object.entries(expected).every(([key, value]) => canonicalJson(value) === canonicalJson(actual[key]));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = record(value);
  if (object) return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function normalizedHttpsOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Frappe support site must be a canonical HTTPS origin.");
  }
  return url.origin;
}
