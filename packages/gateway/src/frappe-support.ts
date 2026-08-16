import type { GatewayFrappeSupportConfig } from "./gateway-config.js";
import type { TrustedFrappeContext } from "./frappe-ingress.js";
import type { PairedIdentity } from "./pairing.js";

export const DEFAULT_FRAPPE_SUPPORT_SITE = "https://support.hybrowlabs.com";

export interface FrappeSupportDestination {
  readonly site: string;
  readonly connectionId?: string;
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
const NEGATED_REPORT_ISSUE_RE = /\b(?:do\s+not|don't|dont|no\s+need\s+to|without)\b.{0,28}\b(?:send|report|raise|create|open|log|escalate)\b.{0,36}\bsupport\b/i;
const SECRET_RE = /\b(access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|api[_ -]?key|authorization|cookie|password)\b\s*[:=]\s*[^\s,;]+/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;

export function isFrappeIssueReportRequest(prompt: string): boolean {
  return !NEGATED_REPORT_ISSUE_RE.test(prompt) && REPORT_ISSUE_RE.test(prompt);
}

export function resolveFrappeSupportDestination(config?: GatewayFrappeSupportConfig): FrappeSupportDestination {
  const site = normalizedHttpsOrigin(config?.site ?? DEFAULT_FRAPPE_SUPPORT_SITE);
  const connectionId = cleanOptional(config?.connectionId, 80);
  const priority = cleanOptional(config?.priority, 80);
  const customer = cleanOptional(config?.customer, 140);
  return Object.freeze({
    site,
    ...(connectionId ? { connectionId } : {}),
    doctype: config?.doctype ?? "HD Ticket",
    ...(priority ? { priority } : {}),
    ...(customer ? { customer } : {}),
  });
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
  const source = context?.pageName?.trim() || context?.docname?.trim() || context?.doctype?.trim() || "Frappe workspace";
  const request = issueText(input.prompt);
  const subject = bounded(`Issue from ${source}: ${request || "investigation requested"}`, 140);
  const reporter = input.identity.userName?.trim() || input.identity.employeeName?.trim() || input.identity.user;
  const sourceLink = trustedRecordLink(input.identity.site, context);
  const investigation = normalizeInvestigation(input.investigation, input.identity.site);
  const sections = [
    ["Reported by", reporter],
    ["Source site", normalizedHttpsOrigin(input.identity.site)],
    ["Current context", source],
    ["Request", request || "Investigate the issue visible in the current context."],
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
  return bounded((value ?? "").replace(BEARER_RE, "Bearer [redacted]").replace(SECRET_RE, "$1=[redacted]").trim(), 12_000);
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

function normalizedHttpsOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Frappe support site must be a canonical HTTPS origin.");
  }
  return url.origin;
}
