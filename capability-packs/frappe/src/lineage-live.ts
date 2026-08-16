import { createHash } from "node:crypto";
import type { FrappeGraphValue } from "./customization-graph.js";
import type {
  FrappeLineageDocument,
  FrappeLineageFieldMap,
  FrappeLineageManifest,
  FrappeLineageStage,
} from "./lineage.js";

export interface FrappeLineageLiveContext {
  readonly fetch: typeof globalThis.fetch;
  readonly siteUrl: string;
  readonly auth: {
    readonly authorization?: string;
    readonly cookie?: string;
  };
}

export interface LoadLiveFrappeLineageEvidenceInput {
  readonly context: FrappeLineageLiveContext;
  readonly manifest: FrappeLineageManifest;
  readonly rootStage: string;
  readonly rootName: string;
  readonly principal: string;
  readonly permissionEpoch: string;
  readonly maxRecords?: number;
}

interface LiveRecord {
  readonly stage: FrappeLineageStage;
  readonly name: string;
  readonly readable: boolean;
  readonly raw: Readonly<Record<string, unknown>>;
  readonly responseRevision: string;
}

interface FrappeResponse {
  readonly response: Response;
  readonly body: unknown;
}

const DEFAULT_MAX_RECORDS = 500;
const HARD_MAX_RECORDS = 10_000;
const LIST_PAGE_SIZE = 100;

/**
 * Loads lineage evidence directly from an authenticated Frappe site. The
 * caller supplies only the reviewed manifest and root identity; document
 * payloads always come from permission-filtered Frappe responses.
 */
export async function loadLiveFrappeLineageEvidence(
  input: LoadLiveFrappeLineageEvidenceInput,
): Promise<readonly FrappeLineageDocument[]> {
  const manifest = reviewManifest(input.manifest);
  const context = reviewContext(input.context);
  const principal = requiredText(input.principal, "Authenticated principal");
  const permissionEpoch = requiredText(input.permissionEpoch, "Permission epoch");
  const rootName = requiredText(input.rootName, "Root document name");
  const maxRecords = boundedRecordCap(input.maxRecords);
  const stages = new Map(manifest.stages.map((stage) => [stage.id, stage]));
  const rootStage = stages.get(input.rootStage);
  if (!rootStage) throw new Error(`Unknown lineage root stage: ${input.rootStage}.`);

  await verifyPrincipal(context, principal);

  const records = new Map<string, LiveRecord>();
  const queue: LiveRecord[] = [];
  const root = await fetchRecord(context, rootStage, rootName, false);
  addRecord(records, queue, root, maxRecords);

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const source = queue[cursor]!;
    if (!source.readable) continue;
    for (const relationship of manifest.relationships.filter((candidate) => candidate.from === source.stage.id)) {
      const targetStage = stages.get(relationship.to)!;
      const query = identityQuery(source.raw, relationship.identity);
      if (!query.filters.length) {
        throw new Error(`Lineage relationship ${relationship.id} has no scalar top-level identity available for a permission-filtered query.`);
      }
      const remaining = maxRecords - records.size;
      if (remaining < 1) throw new Error(`Live lineage evidence exceeded its ${maxRecords}-record cap.`);
      const targets = await queryTargets(context, targetStage, query, Math.min(remaining, LIST_PAGE_SIZE));
      for (const target of targets) addRecord(records, queue, target, maxRecords);
    }
  }

  const observedAt = new Date().toISOString();
  const ordered = [...records.values()].sort((left, right) => left.stage.id.localeCompare(right.stage.id) || left.name.localeCompare(right.name));
  const schemaRevision = hash(ordered.map((record) => ({ stage: record.stage.id, shape: shapeOf(record.raw) })));
  const dataRevision = hash(ordered.map((record) => ({
    stage: record.stage.id,
    name: record.name,
    readable: record.readable,
    modified: stringValue(record.raw.modified),
    responseRevision: record.responseRevision,
  })));
  const paths = requiredPathsByStage(manifest);

  return Object.freeze(ordered.map((record): FrappeLineageDocument => {
    const values = record.readable ? projectValues(record.raw, paths.get(record.stage.id) ?? new Set(["name"])) : unreadableValues(record.raw);
    const modified = stringValue(record.raw.modified);
    const lifecycle = lifecycleOf(record.raw);
    return deepFreeze({
      stage: record.stage.id,
      name: record.name,
      values,
      route: routeFor(record.stage, record.name),
      readable: record.readable,
      ...(lifecycle ? { lifecycle } : {}),
      ...(modified && !Number.isNaN(Date.parse(modified)) ? { modified } : {}),
      provenance: {
        site: context.siteUrl,
        principal,
        permissionEpoch,
        schemaRevision,
        dataRevision,
        observedAt,
        evidenceId: `frappe-live:${hash({ stage: record.stage.id, name: record.name, readable: record.readable, responseRevision: record.responseRevision }).slice(0, 32)}`,
      },
    });
  }));
}

async function verifyPrincipal(context: FrappeLineageLiveContext, expected: string): Promise<void> {
  const result = await request(context, "/api/method/frappe.auth.get_logged_user");
  if (!result.response.ok) throw httpError("Frappe identity verification failed", result);
  const principal = recordValue(result.body)?.message;
  if (typeof principal !== "string" || principal.trim().toLowerCase() !== expected.toLowerCase()) {
    throw new Error("The authenticated Frappe session does not match the requested lineage principal.");
  }
}

async function fetchRecord(
  context: FrappeLineageLiveContext,
  stage: FrappeLineageStage,
  name: string,
  allowUnreadable: boolean,
  seed: Readonly<Record<string, unknown>> = {},
): Promise<LiveRecord> {
  const path = `/api/resource/${encodeURIComponent(stage.doctype)}/${encodeURIComponent(name)}`;
  const result = await request(context, path);
  if (result.response.status === 403 && allowUnreadable) return unreadableRecord(stage, name, seed, result.response);
  if (!result.response.ok) throw httpError(`Frappe could not read ${stage.doctype} ${name}`, result);
  const raw = recordValue(result.body)?.data;
  if (!isRecord(raw)) throw new Error(`Frappe returned malformed data for ${stage.doctype} ${name}.`);
  const resolvedName = stringValue(raw.name);
  if (!resolvedName) throw new Error(`Frappe returned a ${stage.doctype} record without a name.`);
  return { stage, name: resolvedName, readable: true, raw, responseRevision: responseRevision(result.response, raw) };
}

async function queryTargets(
  context: FrappeLineageLiveContext,
  stage: FrappeLineageStage,
  query: { readonly filters: readonly [string, "=", string | number | boolean][]; readonly seed: Readonly<Record<string, unknown>> },
  limit: number,
): Promise<readonly LiveRecord[]> {
  const targets: LiveRecord[] = [];
  let offset = 0;
  while (true) {
    // Ask for one extra row on the final bounded page so truncation becomes an
    // explicit cap failure instead of incomplete evidence.
    const remaining = limit - targets.length;
    const pageLength = remaining === 0 ? 1 : Math.min(LIST_PAGE_SIZE, remaining + (remaining < LIST_PAGE_SIZE ? 1 : 0));
    const url = new URL(`/api/resource/${encodeURIComponent(stage.doctype)}`, `${context.siteUrl}/`);
    url.searchParams.set("fields", JSON.stringify(["name", "modified", "docstatus", ...Object.keys(query.seed)]));
    url.searchParams.set("filters", JSON.stringify(query.filters));
    url.searchParams.set("limit_start", String(offset));
    url.searchParams.set("limit_page_length", String(pageLength));
    url.searchParams.set("order_by", "modified desc,name asc");
    const result = await request(context, `${url.pathname}${url.search}`);
    if (result.response.status === 403) {
      return [unreadableRecord(stage, deniedName(stage, query.filters), query.seed, result.response)];
    }
    if (!result.response.ok) throw httpError(`Frappe could not query ${stage.doctype}`, result);
    const data = recordValue(result.body)?.data;
    if (!Array.isArray(data)) throw new Error(`Frappe returned a malformed ${stage.doctype} query response.`);
    if (data.length > remaining) throw new Error(`Live lineage evidence exceeded its bounded record cap while querying ${stage.doctype}.`);
    for (const row of data) {
      if (!isRecord(row) || !stringValue(row.name)) throw new Error(`Frappe returned a ${stage.doctype} query row without a name.`);
      targets.push(await fetchRecord(context, stage, stringValue(row.name)!, true, { ...query.seed, ...row }));
    }
    if (data.length < pageLength) break;
    offset += data.length;
  }
  return targets;
}

function identityQuery(
  source: Readonly<Record<string, unknown>>,
  mappings: readonly FrappeLineageFieldMap[],
): { readonly filters: readonly [string, "=", string | number | boolean][]; readonly seed: Readonly<Record<string, unknown>> } {
  const filters: Array<[string, "=", string | number | boolean]> = [];
  const seed: Record<string, unknown> = {};
  for (const mapping of mappings) {
    if (!topLevelField(mapping.to)) continue;
    const value = pathValue(source, mapping.from);
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
    if (typeof value === "string" && !value.trim()) continue;
    filters.push([mapping.to, "=", value]);
    seed[mapping.to] = value;
  }
  return { filters, seed };
}

function addRecord(records: Map<string, LiveRecord>, queue: LiveRecord[], record: LiveRecord, maxRecords: number): void {
  const key = `${record.stage.id}\0${record.name}`;
  const prior = records.get(key);
  if (prior) {
    if (!prior.readable && record.readable) records.set(key, record);
    return;
  }
  if (records.size >= maxRecords) throw new Error(`Live lineage evidence exceeded its ${maxRecords}-record cap.`);
  records.set(key, record);
  queue.push(record);
}

function unreadableRecord(stage: FrappeLineageStage, name: string, seed: Readonly<Record<string, unknown>>, response: Response): LiveRecord {
  return {
    stage,
    name,
    readable: false,
    raw: Object.freeze({ name, ...seed }),
    responseRevision: responseRevision(response, seed),
  };
}

function unreadableValues(raw: Readonly<Record<string, unknown>>): Readonly<Record<string, FrappeGraphValue>> {
  const values: Record<string, FrappeGraphValue> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") values[key] = value;
  }
  return deepFreeze(values);
}

function requiredPathsByStage(manifest: FrappeLineageManifest): Map<string, Set<string>> {
  const result = new Map(manifest.stages.map((stage) => [stage.id, new Set(["name", "modified", "docstatus", "disabled", "status"])]));
  for (const relationship of manifest.relationships) {
    for (const mapping of [...relationship.identity, ...relationship.revision, ...relationship.content]) {
      result.get(relationship.from)!.add(mapping.from);
      result.get(relationship.to)!.add(mapping.to);
    }
  }
  return result;
}

function projectValues(raw: Readonly<Record<string, unknown>>, paths: ReadonlySet<string>): Readonly<Record<string, FrappeGraphValue>> {
  const result: Record<string, FrappeGraphValue> = {};
  for (const path of paths) {
    const top = path.split(".")[0]!.replace(/\[\]$/, "");
    const value = graphValue(raw[top]);
    if (value !== undefined) result[top] = value;
  }
  return deepFreeze(result);
}

function graphValue(value: unknown): FrappeGraphValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.flatMap((item) => {
    const normalized = graphValue(item);
    return normalized === undefined ? [] : [normalized];
  });
  if (isRecord(value)) {
    const row: Record<string, FrappeGraphValue> = {};
    for (const [key, child] of Object.entries(value)) {
      const normalized = graphValue(child);
      if (normalized !== undefined) row[key] = normalized;
    }
    return row;
  }
  return undefined;
}

function pathValue(record: Readonly<Record<string, unknown>>, path: string): unknown {
  let value: unknown = record;
  for (const segment of path.split(".")) {
    if (segment.endsWith("[]")) return undefined;
    if (!isRecord(value)) return undefined;
    value = value[segment];
  }
  return value;
}

function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return [value.length ? shapeOf(value[0]) : "empty"];
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, shapeOf(value[key])]));
  if (value === null) return "null";
  return typeof value;
}

function lifecycleOf(raw: Readonly<Record<string, unknown>>): FrappeLineageDocument["lifecycle"] | undefined {
  if (raw.docstatus === 2 || normalizedStatus(raw.status) === "cancelled") return "cancelled";
  if (raw.disabled === 1 || raw.disabled === true || ["superseded", "obsolete"].includes(normalizedStatus(raw.status))) return "superseded";
  if (raw.docstatus === 0 || normalizedStatus(raw.status) === "draft") return "draft";
  return "active";
}

function routeFor(stage: FrappeLineageStage, name: string): string {
  const base = stage.route?.replace(/\/$/, "") ?? `/app/${stage.doctype.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  return `${base}/${encodeURIComponent(name)}`;
}

async function request(context: FrappeLineageLiveContext, path: string): Promise<FrappeResponse> {
  const url = new URL(path, `${context.siteUrl}/`);
  if (url.origin !== new URL(context.siteUrl).origin) throw new Error("Frappe lineage request escaped the authenticated site origin.");
  const response = await context.fetch(url, { method: "GET", headers: authHeaders(context.auth), redirect: "error" });
  let body: unknown;
  try { body = await response.json(); } catch { body = undefined; }
  return { response, body };
}

function authHeaders(auth: FrappeLineageLiveContext["auth"]): Headers {
  const authorization = auth.authorization?.trim();
  const cookie = auth.cookie?.trim();
  if (Boolean(authorization) === Boolean(cookie)) throw new Error("Frappe lineage loading requires exactly one authorization or cookie credential.");
  return new Headers(authorization ? { Authorization: authorization } : { Cookie: cookie! });
}

function reviewContext(context: FrappeLineageLiveContext): FrappeLineageLiveContext {
  if (typeof context.fetch !== "function") throw new Error("Frappe lineage loading requires an injected fetch implementation.");
  const url = new URL(context.siteUrl);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") throw new Error("Frappe lineage loading requires HTTPS outside localhost.");
  authHeaders(context.auth);
  return Object.freeze({ ...context, siteUrl: url.origin });
}

function reviewManifest(manifest: FrappeLineageManifest): FrappeLineageManifest {
  if (manifest.schemaVersion !== 1 || !safeId(manifest.id) || !manifest.stages.length || !manifest.relationships.length) throw new Error("A reviewed lineage manifest is required.");
  const stages = new Set<string>();
  for (const stage of manifest.stages) {
    if (!safeId(stage.id) || !requiredText(stage.label, "Stage label") || !requiredText(stage.doctype, "Stage DocType") || stages.has(stage.id)) throw new Error("Lineage manifest contains an invalid or duplicate stage.");
    stages.add(stage.id);
  }
  const relationships = new Set<string>();
  for (const relationship of manifest.relationships) {
    if (!safeId(relationship.id) || relationships.has(relationship.id) || !stages.has(relationship.from) || !stages.has(relationship.to) || !relationship.identity.length) throw new Error("Lineage manifest contains an invalid relationship.");
    relationships.add(relationship.id);
  }
  return manifest;
}

function httpError(prefix: string, result: FrappeResponse): Error {
  const body = recordValue(result.body);
  const message = [body?.message, body?.exception, body?.exc_type].find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return new Error(`${prefix}: HTTP ${result.response.status}${message ? ` ${message}` : ""}.`);
}

function responseRevision(response: Response, body: unknown): string {
  return hash({ etag: response.headers.get("etag") ?? "", modified: response.headers.get("last-modified") ?? "", body });
}

function deniedName(stage: FrappeLineageStage, filters: readonly [string, "=", string | number | boolean][]): string {
  return `unreadable-${stage.id}-${hash(filters).slice(0, 16)}`;
}

function boundedRecordCap(value: number | undefined): number {
  const cap = value ?? DEFAULT_MAX_RECORDS;
  if (!Number.isInteger(cap) || cap < 1 || cap > HARD_MAX_RECORDS) throw new Error(`Lineage record cap must be between 1 and ${HARD_MAX_RECORDS}.`);
  return cap;
}

function topLevelField(path: string): boolean { return /^[A-Za-z_][A-Za-z0-9_]*$/.test(path); }
function normalizedStatus(value: unknown): string { return typeof value === "string" ? value.trim().toLowerCase() : ""; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function recordValue(value: unknown): Record<string, unknown> | undefined { return isRecord(value) ? value : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function requiredText(value: string, label: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`); return value.trim(); }
function safeId(value: string): boolean { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(value); }
function hash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function canonical(value: unknown): string { if (value === undefined) return "undefined"; if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; const row = value as Record<string, unknown>; return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`; }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }
