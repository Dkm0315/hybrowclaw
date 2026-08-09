import {
  frappeCacheKey,
  type FrappeCacheIdentity,
  type FrappeCacheInvalidation,
  type FrappeCachedValue,
  type FrappeIndexEvent,
  type FrappeIndexEventReceipt,
  type FrappePermissionEpoch,
  type FrappeReadModelStore,
  type FrappeResolvedRead,
} from "./enterprise.js";

const DEFAULT_IDENTITY_TTL_MS = 30_000;
const DEFAULT_QUERY_TTL_MS = 30_000;
const DEFAULT_MAX_QUERY_TTL_MS = 300_000;
const DEFAULT_MAX_STALE_MS = 60_000;
const DEFAULT_MAX_CONCURRENCY = 8;
const DEFAULT_MAX_QUEUE = 128;
const MAX_IDENTITY_TTL_MS = 300_000;
const MAX_QUERY_TTL_MS = 3_600_000;
const MAX_STALE_MS = 300_000;
const MAX_CONCURRENCY = 64;
const MAX_QUEUE = 4_096;
const MAX_QUERY_SIGNATURE_CHARS = 32_768;
const MAX_OBJECT_REFS = 500;
const CACHE_PRUNE_INTERVAL_MS = 60_000;

export type FrappeReadServiceErrorKind =
  | "authentication_failed"
  | "identity_mismatch"
  | "invalidated"
  | "overloaded"
  | "permission_denied"
  | "service_closed"
  | "unavailable";

export class FrappeReadServiceError extends Error {
  readonly kind: FrappeReadServiceErrorKind;

  constructor(kind: FrappeReadServiceErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FrappeReadServiceError";
    this.kind = kind;
  }
}

export interface FrappeCredentialBoundRead<T> {
  /** Site and principal returned by the same credential used for this live read. */
  readonly site: string;
  readonly principal: string;
  readonly value: T;
  readonly objectRefs?: readonly string[];
}

export interface FrappeReadServiceRequest<T> {
  /** Host-verified identity expected for this request. */
  readonly site: string;
  readonly principal: string;
  readonly querySignature: string;
  /** Must resolve permission state using the same user credential as `live`. */
  readonly resolveIdentity: () => Promise<FrappePermissionEpoch>;
  /** Must return the credential's live site and principal with the value. */
  readonly live: (identity: FrappeCacheIdentity) => Promise<FrappeCredentialBoundRead<T>>;
  readonly ttlMs?: number;
  readonly fallback?: {
    readonly mode: "stale_if_unavailable";
    readonly maxStaleMs?: number;
  };
}

export interface FrappeReadServiceInvalidation extends FrappeCacheInvalidation {
  readonly permissionChanged?: boolean;
}

export interface FrappeReadServiceInvalidationReceipt {
  readonly invalidatedCacheEntries: number;
  readonly invalidatedPermissionIdentities: number;
}

export interface FrappeReadServiceOptions {
  readonly store: FrappeReadModelStore;
  readonly identityTtlMs?: number;
  readonly queryTtlMs?: number;
  readonly maxQueryTtlMs?: number;
  readonly maxStaleMs?: number;
  readonly maxConcurrency?: number;
  readonly maxQueue?: number;
  readonly now?: () => number;
}

/**
 * Long-lived coordinator around the durable read model. Callers remain
 * responsible for supplying per-user Frappe credentials and authoritative
 * permission-epoch hydration; credentials are never retained here.
 */
export class FrappeReadService {
  readonly #store: FrappeReadModelStore;
  readonly #identityTtlMs: number;
  readonly #queryTtlMs: number;
  readonly #maxQueryTtlMs: number;
  readonly #maxStaleMs: number;
  readonly #now: () => number;
  readonly #gate: BoundedAsyncGate;
  readonly #identityFlights = new Map<string, Promise<FrappeCacheIdentity>>();
  readonly #queryFlights = new Map<string, Promise<FrappeResolvedRead<unknown>>>();
  readonly #siteInvalidationVersions = new Map<string, number>();
  readonly #lastPrunedAt = new Map<string, number>();
  #closed = false;

  constructor(options: FrappeReadServiceOptions) {
    this.#store = options.store;
    this.#identityTtlMs = boundedPositiveInteger(options.identityTtlMs ?? DEFAULT_IDENTITY_TTL_MS, "identityTtlMs", MAX_IDENTITY_TTL_MS);
    this.#queryTtlMs = boundedPositiveInteger(options.queryTtlMs ?? DEFAULT_QUERY_TTL_MS, "queryTtlMs", MAX_QUERY_TTL_MS);
    this.#maxQueryTtlMs = boundedPositiveInteger(options.maxQueryTtlMs ?? DEFAULT_MAX_QUERY_TTL_MS, "maxQueryTtlMs", MAX_QUERY_TTL_MS);
    if (this.#queryTtlMs > this.#maxQueryTtlMs) throw new Error("Frappe queryTtlMs cannot exceed maxQueryTtlMs.");
    this.#maxStaleMs = boundedNonNegativeInteger(options.maxStaleMs ?? DEFAULT_MAX_STALE_MS, "maxStaleMs", MAX_STALE_MS);
    this.#now = options.now ?? Date.now;
    this.#gate = new BoundedAsyncGate(
      boundedPositiveInteger(options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY, "maxConcurrency", MAX_CONCURRENCY),
      boundedNonNegativeInteger(options.maxQueue ?? DEFAULT_MAX_QUEUE, "maxQueue", MAX_QUEUE),
    );
  }

  async read<T>(request: FrappeReadServiceRequest<T>): Promise<FrappeResolvedRead<T>> {
    this.#assertOpen();
    const site = normalizeSite(request.site);
    const principal = normalizePrincipal(request.principal);
    const querySignature = normalizeQuerySignature(request.querySignature);
    if (!querySignature) throw new Error("Frappe read querySignature is required.");
    this.#maybePrune(site);
    const identity = await this.#resolveIdentity(site, principal, request.resolveIdentity);
    const nowMs = this.#now();
    const cached = this.#store.getCache<T>(identity, querySignature);
    if (cached && isFresh(cached.validUntil, nowMs)) return resolved(cached, nowMs, "cache", "hit");

    const flightKey = frappeCacheKey(identity, querySignature);
    const existing = this.#queryFlights.get(flightKey) as Promise<FrappeResolvedRead<T>> | undefined;
    if (existing) return existing;
    const version = this.#siteVersion(site);
    const flight = this.#refresh(request, identity, querySignature, cached, version)
      .finally(() => {
        if (this.#queryFlights.get(flightKey) === flight) this.#queryFlights.delete(flightKey);
      });
    this.#queryFlights.set(flightKey, flight as Promise<FrappeResolvedRead<unknown>>);
    return flight;
  }

  invalidate(input: FrappeReadServiceInvalidation): FrappeReadServiceInvalidationReceipt {
    this.#assertOpen();
    const normalized: FrappeCacheInvalidation = {
      site: normalizeSite(input.site),
      ...(input.principal ? { principal: normalizePrincipal(input.principal) } : {}),
      ...(input.permissionEpoch ? { permissionEpoch: input.permissionEpoch } : {}),
      ...(input.objectRefs?.length ? { objectRefs: input.objectRefs } : {}),
      ...(input.querySignatures?.length ? { querySignatures: input.querySignatures } : {}),
    };
    this.#bumpSiteVersion(normalized.site);
    const invalidatedCacheEntries = this.#store.invalidateCache(normalized);
    const invalidatedPermissionIdentities = input.permissionChanged
      ? this.#store.invalidatePermissionEpochs(normalized.site, normalized.principal)
      : 0;
    return { invalidatedCacheEntries, invalidatedPermissionIdentities };
  }

  applyEvent(event: FrappeIndexEvent): FrappeIndexEventReceipt {
    this.#assertOpen();
    this.#bumpSiteVersion(normalizeSite(event.site));
    return this.#store.applyEvent(event);
  }

  /** Stops new work and rejects queued work. The caller retains store ownership. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#gate.close();
  }

  async #resolveIdentity(
    site: string,
    principal: string,
    loader: () => Promise<FrappePermissionEpoch>,
  ): Promise<FrappeCacheIdentity> {
    const stored = this.#store.getPermissionEpochState(site, principal);
    if (stored && isFresh(stored.validUntil, this.#now())) return this.#cacheIdentity(stored);

    const key = `${site}\0${principal}`;
    const existing = this.#identityFlights.get(key);
    if (existing) return existing;
    const version = this.#siteVersion(site);
    const flight = this.#gate.run(async () => {
      const current = this.#store.getPermissionEpochState(site, principal);
      if (current && isFresh(current.validUntil, this.#now())) return this.#cacheIdentity(current);
      const epoch = await loader();
      validatePermissionEpoch(epoch, site, principal);
      if (this.#siteVersion(site) !== version) throw invalidatedError(site);
      if (current && current.epoch !== epoch.epoch) {
        this.#store.invalidateCache({ site, principal });
        this.#bumpSiteVersion(site);
      }
      const observedAtMs = this.#now();
      this.#store.putPermissionEpoch(
        epoch,
        new Date(observedAtMs).toISOString(),
        new Date(observedAtMs + this.#identityTtlMs).toISOString(),
      );
      return this.#cacheIdentity(epoch);
    }).finally(() => {
      if (this.#identityFlights.get(key) === flight) this.#identityFlights.delete(key);
    });
    this.#identityFlights.set(key, flight);
    return flight;
  }

  async #refresh<T>(
    request: FrappeReadServiceRequest<T>,
    identity: FrappeCacheIdentity,
    querySignature: string,
    stale: FrappeCachedValue<T> | undefined,
    invalidationVersion: number,
  ): Promise<FrappeResolvedRead<T>> {
    return this.#gate.run(async () => {
      const nowMs = this.#now();
      const current = this.#store.getCache<T>(identity, querySignature);
      if (current && isFresh(current.validUntil, nowMs)) return resolved(current, nowMs, "cache", "hit");
      const fallbackCandidate = current ?? stale;
      let live: FrappeCredentialBoundRead<T>;
      try {
        live = await request.live(identity);
      } catch (error) {
        const failedAtMs = this.#now();
        if (this.#siteVersion(identity.site) !== invalidationVersion) throw invalidatedError(identity.site);
        if (canServeStale(error, fallbackCandidate, request.fallback, failedAtMs, this.#maxStaleMs)) {
          return resolved(fallbackCandidate!, failedAtMs, "cache", "stale", "stale_if_unavailable");
        }
        throw error;
      }
      assertCredentialBoundRead(live, identity);
      if (this.#siteVersion(identity.site) !== invalidationVersion) throw invalidatedError(identity.site);
      const observedAtMs = this.#now();
      const ttlMs = Math.min(
        request.ttlMs === undefined ? this.#queryTtlMs : positiveInteger(request.ttlMs, "read ttlMs"),
        this.#maxQueryTtlMs,
      );
      if ((live.objectRefs?.length ?? 0) > MAX_OBJECT_REFS) {
        throw new Error(`Frappe live read returned more than ${MAX_OBJECT_REFS} object references.`);
      }
      const entry: FrappeCachedValue<T> = {
        cacheKey: frappeCacheKey(identity, querySignature),
        identity,
        querySignature,
        value: live.value,
        observedAt: new Date(observedAtMs).toISOString(),
        validUntil: new Date(observedAtMs + ttlMs).toISOString(),
        source: "live_frappe",
        objectRefs: [...new Set((live.objectRefs ?? []).map((value) => value.trim()).filter(Boolean))].sort(),
      };
      this.#store.putCache(entry);
      const persisted = this.#store.getCache<T>(identity, querySignature) ?? entry;
      return resolved(persisted, observedAtMs, "live_frappe", fallbackCandidate ? "stale" : "miss");
    });
  }

  #cacheIdentity(epoch: Pick<FrappePermissionEpoch, "site" | "principal" | "epoch">): FrappeCacheIdentity {
    const revision = this.#store.getRevision(epoch.site);
    return {
      site: normalizeSite(epoch.site),
      principal: normalizePrincipal(epoch.principal),
      permissionEpoch: epoch.epoch,
      schemaRevision: revision?.schemaRevision ?? "live",
      dataRevision: revision?.dataRevision ?? "live",
    };
  }

  #siteVersion(site: string): number {
    return this.#siteInvalidationVersions.get(site) ?? 0;
  }

  #bumpSiteVersion(site: string): void {
    this.#siteInvalidationVersions.set(site, this.#siteVersion(site) + 1);
  }

  #maybePrune(site: string): void {
    const nowMs = this.#now();
    const lastPrunedAt = this.#lastPrunedAt.get(site);
    if (lastPrunedAt !== undefined && nowMs >= lastPrunedAt && nowMs - lastPrunedAt < CACHE_PRUNE_INTERVAL_MS) return;
    this.#store.pruneCache(new Date(nowMs - this.#maxStaleMs).toISOString(), site);
    this.#lastPrunedAt.set(site, nowMs);
  }

  #assertOpen(): void {
    if (this.#closed) throw new FrappeReadServiceError("service_closed", "Frappe read service is closed.");
  }
}

export interface FrappeEffectiveDocField {
  readonly fieldname: string;
  readonly label: string;
  readonly fieldtype?: string;
  readonly options?: string;
  readonly defaultValue?: string | number | boolean;
  readonly fetchFrom?: string;
  readonly mandatoryDependsOn?: string;
  readonly reqd: boolean;
  readonly hidden: boolean;
  readonly readOnly: boolean;
  readonly permlevel: number;
  readonly inListView: boolean;
  readonly inStandardFilter: boolean;
  readonly searchIndex: boolean;
}

export interface FrappeEffectiveDocTypeMetadata {
  readonly doctype: string;
  readonly fields: readonly FrappeEffectiveDocField[];
  readonly permissions: readonly Readonly<Record<string, unknown>>[];
}

export interface FrappeEffectiveRequiredField {
  readonly fieldname: string;
  readonly label: string;
  readonly reason: string;
  readonly options?: readonly string[];
}

/** Hydrates only Frappe's already-effective getdoctype response. */
export function hydrateFrappeEffectiveDocTypeMetadata(payload: unknown, expectedDoctype: string): FrappeEffectiveDocTypeMetadata {
  const expected = expectedDoctype.trim();
  if (!expected) throw new Error("Frappe effective metadata requires a DocType.");
  const root = recordValue(payload);
  const message = recordValue(root?.message);
  const data = recordValue(root?.data);
  const documents = [
    ...(Array.isArray(root?.docs) ? root.docs : []),
    ...(Array.isArray(message?.docs) ? message.docs : []),
    ...(message?.name && Array.isArray(message.fields) ? [message] : []),
    ...(data?.name && Array.isArray(data.fields) ? [data] : []),
  ].flatMap((value): Array<Record<string, unknown>> => {
    const record = recordValue(value);
    return record ? [record] : [];
  });
  const meta = documents.find((document) => stringValue(document.name) === expected)
    ?? documents.find((document) => Array.isArray(document.fields));
  if (!meta) throw new Error(`Frappe returned no effective metadata for ${expected}.`);
  const actual = stringValue(meta.name);
  if (actual !== expected) throw new Error(`Frappe returned effective metadata for ${actual || "another DocType"}, not ${expected}.`);
  const fields = (Array.isArray(meta.fields) ? meta.fields : []).flatMap((value): FrappeEffectiveDocField[] => {
    const field = recordValue(value);
    const fieldname = stringValue(field?.fieldname);
    if (!field || !fieldname) return [];
    const defaultValue = primitiveValue(field.default);
    return [{
      fieldname,
      label: stringValue(field.label) || humanizeField(fieldname),
      ...(stringValue(field.fieldtype) ? { fieldtype: stringValue(field.fieldtype) } : {}),
      ...(stringValue(field.options) ? { options: stringValue(field.options) } : {}),
      ...(defaultValue !== undefined ? { defaultValue } : {}),
      ...(stringValue(field.fetch_from) ? { fetchFrom: stringValue(field.fetch_from) } : {}),
      ...(stringValue(field.mandatory_depends_on) ? { mandatoryDependsOn: stringValue(field.mandatory_depends_on) } : {}),
      reqd: booleanLike(field.reqd),
      hidden: booleanLike(field.hidden),
      readOnly: booleanLike(field.read_only),
      permlevel: finiteInteger(field.permlevel),
      inListView: booleanLike(field.in_list_view),
      inStandardFilter: booleanLike(field.in_standard_filter),
      searchIndex: booleanLike(field.search_index),
    }];
  });
  const permissions = (Array.isArray(meta.permissions) ? meta.permissions : []).flatMap((value): Array<Readonly<Record<string, unknown>>> => {
    const permission = recordValue(value);
    return permission ? [{ ...permission }] : [];
  });
  return { doctype: actual, fields, permissions };
}

export function requiredFieldsFromEffectiveMetadata(
  metadata: FrappeEffectiveDocTypeMetadata,
  values: Readonly<Record<string, unknown>> = {},
): FrappeEffectiveRequiredField[] {
  const nonInputFieldTypes = new Set(["Button", "Column Break", "Fold", "Geolocation", "Heading", "HTML", "Image", "Section Break", "Tab Break"]);
  return metadata.fields.flatMap((field): FrappeEffectiveRequiredField[] => {
    const conditionallyRequired = field.mandatoryDependsOn
      ? evaluateMandatoryDependency(field.mandatoryDependsOn, values)
      : false;
    if ((!field.reqd && !conditionallyRequired) || field.hidden || field.readOnly || nonInputFieldTypes.has(field.fieldtype ?? "")) return [];
    const options = field.fieldtype === "Select" && field.options
      ? field.options.split("\n").map((value) => value.trim()).filter(Boolean)
      : [];
    const hasEffectiveDefault = field.defaultValue !== undefined
      && (typeof field.defaultValue !== "string" || field.defaultValue.trim().length > 0);
    if (hasEffectiveDefault || field.fetchFrom || options.length === 1) return [];
    return [{
      fieldname: field.fieldname,
      label: field.label,
      reason: conditionallyRequired && !field.reqd
        ? `${field.label} is required for the details selected in this request.`
        : `${field.label} is required before this request can be saved for the current user.`,
      ...(options.length ? { options } : {}),
    }];
  });
}

/** Evaluate the bounded declarative subset Frappe uses for ordinary mandatory_depends_on rules. */
function evaluateMandatoryDependency(expression: string, values: Readonly<Record<string, unknown>>): boolean {
  const source = unwrapExpression(expression.trim().replace(/^eval:\s*/, "").trim());
  const functionCalls = [...source.matchAll(/\b([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g)].map((match) => match[1]);
  if (functionCalls.some((name) => name !== "in_list")) return false;
  const disjunction = splitTopLevelExpression(source, "||");
  if (disjunction.length > 1) return disjunction.some((part) => evaluateMandatoryDependency(part, values));
  const conjunction = splitTopLevelExpression(source, "&&");
  if (conjunction.length > 1) return conjunction.every((part) => evaluateMandatoryDependency(part, values));

  const membership = /^(!)?in_list\(\s*(\[[\s\S]*\])\s*,\s*doc\.([A-Za-z0-9_]+)\s*\)$/.exec(source);
  if (membership) {
    const allowed = parseBoundedLiteralArray(membership[2]);
    if (!allowed) return false;
    const included = allowed.some((value) => String(value ?? "") === String(values[membership[3]] ?? ""));
    return membership[1] ? !included : included;
  }

  const comparison = /^doc\.([A-Za-z0-9_]+)\s*(===|==|!==|!=)\s*(?:(["'])(.*?)\3|(true|false|null|-?\d+(?:\.\d+)?))$/.exec(source);
  if (comparison) {
    const actual = values[comparison[1]];
    const expected = comparison[3]
      ? comparison[4]
      : comparison[5] === "true"
        ? true
        : comparison[5] === "false"
          ? false
          : comparison[5] === "null"
            ? null
            : Number(comparison[5]);
    const equal = typeof expected === "number"
      ? Number(actual) === expected
      : actual === expected || String(actual ?? "") === String(expected ?? "");
    return comparison[2] === "==" || comparison[2] === "===" ? equal : !equal;
  }
  const boolean = /^(!)?doc\.([A-Za-z0-9_]+)$/.exec(source);
  if (boolean) {
    const truthy = Boolean(values[boolean[2]]);
    return boolean[1] ? !truthy : truthy;
  }
  const direct = /^([A-Za-z0-9_]+)$/.exec(source);
  return direct ? Boolean(values[direct[1]]) : false;
}

function unwrapExpression(value: string): string {
  let current = value.trim();
  while (current.startsWith("(") && current.endsWith(")") && enclosesWholeExpression(current)) {
    current = current.slice(1, -1).trim();
  }
  return current;
}

function enclosesWholeExpression(value: string): boolean {
  let depth = 0;
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote && value[index - 1] !== "\\") quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (depth === 0 && index < value.length - 1) return false;
  }
  return depth === 0;
}

function splitTopLevelExpression(value: string, operator: "&&" | "||"): string[] {
  const parts: string[] = [];
  let start = 0;
  let parentheses = 0;
  let brackets = 0;
  let quote = "";
  for (let index = 0; index < value.length - 1; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote && value[index - 1] !== "\\") quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (parentheses === 0 && brackets === 0 && value.slice(index, index + 2) === operator) {
      parts.push(value.slice(start, index).trim());
      start = index + 2;
      index += 1;
    }
  }
  if (!parts.length) return [value];
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function parseBoundedLiteralArray(source: string): readonly unknown[] | undefined {
  if (source.length > 1_000) return undefined;
  try {
    const parsed = JSON.parse(source) as unknown;
    if (!Array.isArray(parsed) || parsed.length > 100) return undefined;
    return parsed.every((value) => value === null || ["string", "number", "boolean"].includes(typeof value)) ? parsed : undefined;
  } catch {
    const singleQuoted = source.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_match, value: string) => JSON.stringify(value.replace(/\\'/g, "'")));
    try {
      const parsed = JSON.parse(singleQuoted) as unknown;
      if (!Array.isArray(parsed) || parsed.length > 100) return undefined;
      return parsed.every((value) => value === null || ["string", "number", "boolean"].includes(typeof value)) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
}

class BoundedAsyncGate {
  readonly #maxConcurrency: number;
  readonly #maxQueue: number;
  readonly #queue: Array<{
    readonly start: () => void;
    readonly reject: (error: Error) => void;
  }> = [];
  #active = 0;
  #closed = false;

  constructor(maxConcurrency: number, maxQueue: number) {
    this.#maxConcurrency = maxConcurrency;
    this.#maxQueue = maxQueue;
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new FrappeReadServiceError("service_closed", "Frappe read service is closed."));
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.#active += 1;
        void work().then(resolve, reject).finally(() => {
          this.#active -= 1;
          this.#drain();
        });
      };
      if (this.#active < this.#maxConcurrency) {
        start();
        return;
      }
      if (this.#queue.length >= this.#maxQueue) {
        reject(new FrappeReadServiceError("overloaded", "Frappe read service concurrency queue is full."));
        return;
      }
      this.#queue.push({ start, reject });
    });
  }

  close(): void {
    this.#closed = true;
    const error = new FrappeReadServiceError("service_closed", "Frappe read service is closed.");
    for (const queued of this.#queue.splice(0)) queued.reject(error);
  }

  #drain(): void {
    if (this.#closed || this.#active >= this.#maxConcurrency) return;
    this.#queue.shift()?.start();
  }
}

function validatePermissionEpoch(epoch: FrappePermissionEpoch, site: string, principal: string): void {
  if (normalizeSite(epoch.site) !== site || normalizePrincipal(epoch.principal) !== principal) {
    throw new FrappeReadServiceError("identity_mismatch", "Frappe permission identity does not match the host-verified site and principal.");
  }
  if (!epoch.epoch.trim() || epoch.epoch.length > 512) {
    throw new FrappeReadServiceError("authentication_failed", "Frappe permission identity returned an invalid epoch.");
  }
  for (const value of Object.values(epoch.components)) {
    if (typeof value !== "string" || !value.trim() || value.length > 512) {
      throw new FrappeReadServiceError("authentication_failed", "Frappe permission identity returned incomplete components.");
    }
  }
}

function assertCredentialBoundRead<T>(read: FrappeCredentialBoundRead<T>, identity: FrappeCacheIdentity): void {
  if (normalizeSite(read.site) !== identity.site || normalizePrincipal(read.principal) !== identity.principal) {
    throw new FrappeReadServiceError(
      "identity_mismatch",
      "Frappe live read credential does not match the permission-scoped cache identity.",
    );
  }
}

function canServeStale<T>(
  error: unknown,
  cached: FrappeCachedValue<T> | undefined,
  fallback: FrappeReadServiceRequest<T>["fallback"],
  nowMs: number,
  serviceMaxStaleMs: number,
): boolean {
  if (!(error instanceof FrappeReadServiceError) || error.kind !== "unavailable") return false;
  if (!cached || fallback?.mode !== "stale_if_unavailable" || serviceMaxStaleMs === 0) return false;
  const validUntilMs = Date.parse(cached.validUntil);
  if (!Number.isFinite(validUntilMs) || validUntilMs >= nowMs) return false;
  const requested = fallback.maxStaleMs === undefined
    ? serviceMaxStaleMs
    : Math.min(nonNegativeInteger(fallback.maxStaleMs, "fallback maxStaleMs"), serviceMaxStaleMs);
  return nowMs - validUntilMs <= requested;
}

function resolved<T>(
  entry: FrappeCachedValue<T>,
  servedAtMs: number,
  route: "cache" | "live_frappe",
  cacheState: "hit" | "miss" | "stale",
  fallback?: "stale_if_unavailable",
): FrappeResolvedRead<T> {
  const temporarilyStale = fallback === "stale_if_unavailable";
  return {
    value: entry.value,
    receipt: {
      route,
      cacheState,
      cacheKey: entry.cacheKey,
      site: entry.identity.site,
      principal: entry.identity.principal,
      permissionEpoch: entry.identity.permissionEpoch,
      schemaRevision: entry.identity.schemaRevision,
      dataRevision: entry.identity.dataRevision,
      observedAt: entry.observedAt,
      servedAt: new Date(servedAtMs).toISOString(),
      validUntil: entry.validUntil,
      objectRefs: entry.objectRefs,
      ...(fallback ? { fallback } : {}),
    },
    presentation: {
      message: temporarilyStale
        ? "Frappe is temporarily unavailable, so I used recently expired data from your current permission scope."
        : route === "cache"
          ? "I used current Frappe data available to you."
          : "I refreshed this from Frappe before answering.",
      status: temporarilyStale ? "temporarily_stale" : route === "cache" ? "current" : "refreshed",
      updatedAt: entry.observedAt,
    },
  };
}

function invalidatedError(site: string): FrappeReadServiceError {
  return new FrappeReadServiceError("invalidated", `Frappe read for ${site} was invalidated while live hydration was in flight; retry with current permission state.`);
}

function isFresh(validUntil: string, nowMs: number): boolean {
  const validUntilMs = Date.parse(validUntil);
  return Number.isFinite(validUntilMs) && validUntilMs > nowMs;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Frappe ${label} must be a positive safe integer.`);
  return value;
}

function boundedPositiveInteger(value: number, label: string, max: number): number {
  const normalized = positiveInteger(value, label);
  if (normalized > max) throw new Error(`Frappe ${label} must not exceed ${max}.`);
  return normalized;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Frappe ${label} must be a non-negative safe integer.`);
  return value;
}

function boundedNonNegativeInteger(value: number, label: string, max: number): number {
  const normalized = nonNegativeInteger(value, label);
  if (normalized > max) throw new Error(`Frappe ${label} must not exceed ${max}.`);
  return normalized;
}

function normalizeSite(value: string): string {
  const normalized = value.trim().replace(/\/$/, "").toLowerCase();
  if (!normalized) throw new Error("Frappe read site is required.");
  if (normalized.length > 2_048) throw new Error("Frappe read site is too long.");
  return normalized;
}

function normalizePrincipal(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) throw new Error("Frappe read principal is required.");
  if (normalized.length > 254) throw new Error("Frappe read principal is too long.");
  return normalized;
}

function normalizeQuerySignature(value: string): string {
  const normalized = value.toLowerCase().replace(/[^\p{L}\p{N}\s_.:/-]/gu, " ").replace(/\s+/g, " ").trim();
  if (normalized.length > MAX_QUERY_SIGNATURE_CHARS) throw new Error(`Frappe read querySignature exceeds ${MAX_QUERY_SIGNATURE_CHARS} characters.`);
  return normalized;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function primitiveValue(value: unknown): string | number | boolean | undefined {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;
}

function booleanLike(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function finiteInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function humanizeField(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
