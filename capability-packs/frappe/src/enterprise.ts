import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export const FRAPPE_INDEX_KINDS = [
  "app",
  "module",
  "doctype",
  "field",
  "custom_field",
  "property_setter",
  "workflow",
  "report",
  "print_format",
  "client_script",
  "server_script",
  "funnel",
  "flow_config",
  "dynamic_assignment",
  "permission_rule",
  "workspace",
  "notification",
] as const;

export type FrappeIndexKind = (typeof FRAPPE_INDEX_KINDS)[number];
export type FrappeIndexSource = "rest_poll" | "frappe_event" | "admin_seed";

export interface FrappeIndexRecord {
  readonly site: string;
  readonly kind: FrappeIndexKind;
  readonly objectId: string;
  readonly doctype?: string;
  readonly module?: string;
  readonly parentId?: string;
  readonly label?: string;
  readonly searchText: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly revision: string;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly source: FrappeIndexSource;
}

export interface FrappeEnterpriseSnapshot {
  readonly site: string;
  readonly observedAt: string;
  readonly validUntil?: string;
  readonly schemaRevision?: string;
  readonly dataRevision?: string;
  readonly apps?: readonly unknown[];
  readonly modules?: readonly unknown[];
  readonly doctypes?: readonly unknown[];
  readonly customFields?: readonly unknown[];
  readonly propertySetters?: readonly unknown[];
  readonly workflows?: readonly unknown[];
  readonly reports?: readonly unknown[];
  readonly printFormats?: readonly unknown[];
  readonly clientScripts?: readonly unknown[];
  readonly serverScripts?: readonly unknown[];
  readonly funnels?: readonly unknown[];
  readonly flowConfigs?: readonly unknown[];
  readonly dynamicAssignments?: readonly unknown[];
  readonly permissionRules?: readonly unknown[];
  readonly workspaces?: readonly unknown[];
  readonly notifications?: readonly unknown[];
}

export interface FrappeSiteRevision {
  readonly site: string;
  readonly schemaRevision: string;
  readonly dataRevision: string;
  readonly observedAt: string;
}

export interface FrappePermissionEpochInput {
  readonly site: string;
  readonly principal: string;
  readonly roles?: readonly unknown[];
  readonly userPermissions?: readonly unknown[];
  readonly shares?: readonly unknown[];
  readonly permlevels?: readonly unknown[];
  readonly workflowInputs?: readonly unknown[];
  readonly hierarchyInputs?: readonly unknown[];
}

export interface FrappePermissionEpoch {
  readonly site: string;
  readonly principal: string;
  readonly epoch: string;
  readonly components: {
    readonly roles: string;
    readonly userPermissions: string;
    readonly shares: string;
    readonly permlevels: string;
    readonly workflows: string;
    readonly hierarchy: string;
  };
}

export interface FrappePermissionEpochState extends FrappePermissionEpoch {
  readonly observedAt: string;
  readonly validUntil: string;
}

export interface FrappeCacheIdentity {
  readonly site: string;
  readonly principal: string;
  readonly permissionEpoch: string;
  readonly schemaRevision: string;
  readonly dataRevision: string;
}

export interface FrappeCachedValue<T = unknown> {
  readonly cacheKey: string;
  readonly identity: FrappeCacheIdentity;
  readonly querySignature: string;
  readonly value: T;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly source: "indexed_data" | "live_frappe";
  readonly objectRefs: readonly string[];
}

export interface FrappeProvenanceReceipt {
  readonly route: "cache" | "live_frappe";
  readonly cacheState: "hit" | "miss" | "stale";
  readonly cacheKey: string;
  readonly site: string;
  readonly principal: string;
  readonly permissionEpoch: string;
  readonly schemaRevision: string;
  readonly dataRevision: string;
  readonly observedAt: string;
  readonly servedAt: string;
  readonly validUntil: string;
  readonly objectRefs: readonly string[];
  readonly fallback?: "stale_if_unavailable";
}

export interface FrappeHumaneFreshness {
  readonly message: string;
  readonly status: "current" | "refreshed" | "temporarily_stale";
  readonly updatedAt: string;
}

export interface FrappeResolvedRead<T> {
  readonly value: T;
  /** Internal evidence for audit/telemetry. Do not render this object directly to end users. */
  readonly receipt: FrappeProvenanceReceipt;
  /** Deliberately excludes hashes, cache keys, and internal object identifiers. */
  readonly presentation: FrappeHumaneFreshness;
}

export interface FrappeHierarchyConfig {
  readonly sourceDoctype: string;
  readonly recordIdField: string;
  readonly principalField: string;
  readonly managerRecordField: string;
  readonly activeField?: string;
  readonly activeValues?: readonly string[];
  readonly maxDepth?: number;
}

export interface FrappeHierarchyScope {
  readonly sourceDoctype: string;
  readonly principal: string;
  readonly selfRecordIds: readonly string[];
  readonly directReportPrincipals: readonly string[];
  readonly descendantPrincipals: readonly string[];
  readonly descendantRecordIds: readonly string[];
  readonly depthByRecordId: Readonly<Record<string, number>>;
  readonly evidence: readonly string[];
}

export interface FrappeCustomerProfile {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly displayName: string;
  readonly site: {
    readonly urlFromEnv: string;
    readonly auth: "oauth2" | "api_token";
  };
  readonly hierarchy: FrappeHierarchyConfig;
  readonly indexing: {
    readonly coreKinds: readonly FrappeIndexKind[];
    readonly additionalDoctypes?: readonly string[];
    readonly pollIntervalSeconds: number;
    readonly eventIngest?: boolean;
  };
  readonly cache: {
    readonly metadataTtlSeconds: number;
    readonly operationalTtlSeconds: number;
  };
  readonly aliases?: readonly { readonly phrase: string; readonly doctype: string; readonly source: "profile_data" }[];
  readonly writePolicy: {
    readonly requirePermissionPreflight: true;
    readonly requireBoundApproval: true;
    readonly approvalTtlSeconds: number;
  };
}

export interface FrappeIndexEvent {
  readonly eventId: string;
  readonly site: string;
  readonly operation: "upsert" | "delete" | "permission_changed" | "schema_changed" | "data_changed";
  readonly kind?: FrappeIndexKind;
  readonly objectId?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly revision: string;
  readonly observedAt: string;
  readonly validUntil?: string;
  readonly principal?: string;
  readonly permissionEpoch?: string;
  readonly objectRefs?: readonly string[];
  readonly querySignatures?: readonly string[];
}

export interface FrappeIndexEventReceipt {
  readonly eventId: string;
  readonly applied: boolean;
  readonly duplicate: boolean;
  readonly invalidatedCacheEntries: number;
}

export interface FrappeCacheInvalidation {
  readonly site: string;
  readonly principal?: string;
  readonly permissionEpoch?: string;
  readonly objectRefs?: readonly string[];
  readonly querySignatures?: readonly string[];
}

export interface FrappeReadModelStore {
  readonly backend: "sqlite" | "postgres";
  replaceSnapshot(snapshot: FrappeEnterpriseSnapshot): FrappeSiteRevision;
  upsertIndex(records: readonly FrappeIndexRecord[]): void;
  deleteIndex(site: string, kind: FrappeIndexKind, objectId: string): void;
  searchIndex(site: string, query?: string, kinds?: readonly FrappeIndexKind[], limit?: number): FrappeIndexRecord[];
  putPermissionEpoch(epoch: FrappePermissionEpoch, observedAt?: string, validUntil?: string): void;
  getPermissionEpoch(site: string, principal: string): FrappePermissionEpoch | undefined;
  getPermissionEpochState(site: string, principal: string): FrappePermissionEpochState | undefined;
  invalidatePermissionEpoch(site: string, principal: string): number;
  invalidatePermissionEpochs(site: string, principal?: string): number;
  getRevision(site: string): FrappeSiteRevision | undefined;
  setRevision(revision: FrappeSiteRevision): void;
  putCache<T>(entry: FrappeCachedValue<T>): void;
  getCache<T>(identity: FrappeCacheIdentity, querySignature: string): FrappeCachedValue<T> | undefined;
  invalidateCache(input: FrappeCacheInvalidation): number;
  invalidateSiteCache(site: string): number;
  pruneCache(expiredBefore: string, site?: string): number;
  applyEvent(event: FrappeIndexEvent): FrappeIndexEventReceipt;
  consumeApproval(proposalId: string, signature: string, consumedAt?: string): boolean;
  close(): void;
}

interface SqliteStatement {
  run(...values: unknown[]): { changes?: number | bigint };
  get(...values: unknown[]): unknown;
  all(...values: unknown[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface IndexRow {
  site: string;
  kind: FrappeIndexKind;
  object_id: string;
  doctype: string | null;
  module: string | null;
  parent_id: string | null;
  label: string | null;
  search_text: string;
  payload_json: string;
  revision: string;
  observed_at: string;
  valid_until: string;
  source: FrappeIndexSource;
}

interface CacheRow {
  cache_key: string;
  site: string;
  principal: string;
  permission_epoch: string;
  schema_revision: string;
  data_revision: string;
  query_signature: string;
  value_json: string;
  observed_at: string;
  valid_until: string;
  source: "indexed_data" | "live_frappe";
  object_refs_json: string;
}

export class SqliteFrappeReadModel implements FrappeReadModelStore {
  readonly backend = "sqlite" as const;
  readonly path: string;
  readonly #db: SqliteDatabase;

  constructor(path: string) {
    this.path = path;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (dbPath: string) => SqliteDatabase };
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS frappe_site_revision (
        site TEXT PRIMARY KEY,
        schema_revision TEXT NOT NULL,
        data_revision TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS frappe_index_object (
        site TEXT NOT NULL,
        kind TEXT NOT NULL,
        object_id TEXT NOT NULL,
        doctype TEXT,
        module TEXT,
        parent_id TEXT,
        label TEXT,
        search_text TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        revision TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        valid_until TEXT NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY (site, kind, object_id)
      );
      CREATE INDEX IF NOT EXISTS frappe_index_search_idx ON frappe_index_object(site, kind, doctype, module);
      CREATE INDEX IF NOT EXISTS frappe_index_validity_idx ON frappe_index_object(site, valid_until);
      CREATE TABLE IF NOT EXISTS frappe_permission_epoch (
        site TEXT NOT NULL,
        principal TEXT NOT NULL,
        epoch TEXT NOT NULL,
        components_json TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        valid_until TEXT NOT NULL,
        PRIMARY KEY (site, principal)
      );
      CREATE TABLE IF NOT EXISTS frappe_response_cache (
        cache_key TEXT PRIMARY KEY,
        site TEXT NOT NULL,
        principal TEXT NOT NULL,
        permission_epoch TEXT NOT NULL,
        schema_revision TEXT NOT NULL,
        data_revision TEXT NOT NULL,
        query_signature TEXT NOT NULL,
        value_json TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        valid_until TEXT NOT NULL,
        source TEXT NOT NULL,
        object_refs_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS frappe_cache_scope_idx ON frappe_response_cache(site, principal, permission_epoch, schema_revision, data_revision, query_signature);
      CREATE INDEX IF NOT EXISTS frappe_cache_validity_idx ON frappe_response_cache(site, valid_until);
      CREATE TABLE IF NOT EXISTS frappe_event_receipt (
        event_id TEXT PRIMARY KEY,
        site TEXT NOT NULL,
        revision TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS frappe_approval_consumption (
        proposal_id TEXT PRIMARY KEY,
        signature TEXT NOT NULL,
        consumed_at TEXT NOT NULL
      );
    `);
    const permissionColumns = this.#db.prepare("PRAGMA table_info(frappe_permission_epoch)").all() as Array<{ name?: string }>;
    if (!permissionColumns.some((column) => column.name === "valid_until")) {
      this.#db.exec("ALTER TABLE frappe_permission_epoch ADD COLUMN valid_until TEXT");
      this.#db.exec("UPDATE frappe_permission_epoch SET valid_until = observed_at WHERE valid_until IS NULL");
    }
  }

  replaceSnapshot(snapshot: FrappeEnterpriseSnapshot): FrappeSiteRevision {
    const records = buildFrappeIndexRecords(snapshot);
    const revision = snapshotRevision(snapshot, records);
    const previous = this.getRevision(revision.site);
    const changed = !previous
      || previous.schemaRevision !== revision.schemaRevision
      || previous.dataRevision !== revision.dataRevision;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("DELETE FROM frappe_index_object WHERE site = ?").run(snapshot.site);
      this.upsertIndex(records);
      this.setRevision(revision);
      if (changed) this.invalidateSiteCache(snapshot.site);
      this.#db.exec("COMMIT");
      return revision;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  upsertIndex(records: readonly FrappeIndexRecord[]): void {
    const statement = this.#db.prepare(`
      INSERT INTO frappe_index_object (
        site, kind, object_id, doctype, module, parent_id, label, search_text,
        payload_json, revision, observed_at, valid_until, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(site, kind, object_id) DO UPDATE SET
        doctype = excluded.doctype,
        module = excluded.module,
        parent_id = excluded.parent_id,
        label = excluded.label,
        search_text = excluded.search_text,
        payload_json = excluded.payload_json,
        revision = excluded.revision,
        observed_at = excluded.observed_at,
        valid_until = excluded.valid_until,
        source = excluded.source
    `);
    for (const record of records) {
      statement.run(
        record.site,
        record.kind,
        record.objectId,
        record.doctype ?? null,
        record.module ?? null,
        record.parentId ?? null,
        record.label ?? null,
        record.searchText,
        stableJson(record.payload),
        record.revision,
        record.observedAt,
        record.validUntil,
        record.source,
      );
    }
  }

  deleteIndex(site: string, kind: FrappeIndexKind, objectId: string): void {
    this.#db.prepare("DELETE FROM frappe_index_object WHERE site = ? AND kind = ? AND object_id = ?").run(site, kind, objectId);
  }

  searchIndex(site: string, query = "", kinds: readonly FrappeIndexKind[] = [], limit = 50): FrappeIndexRecord[] {
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const terms = normalizeSearch(query);
    const clauses = ["site = ?"];
    const values: unknown[] = [site];
    if (kinds.length) {
      clauses.push(`kind IN (${kinds.map(() => "?").join(",")})`);
      values.push(...kinds);
    }
    for (const term of terms) {
      clauses.push("search_text LIKE ? ESCAPE '\\'");
      values.push(`%${escapeLike(term)}%`);
    }
    values.push(boundedLimit);
    const rows = this.#db.prepare(`
      SELECT site, kind, object_id, doctype, module, parent_id, label, search_text,
             payload_json, revision, observed_at, valid_until, source
      FROM frappe_index_object
      WHERE ${clauses.join(" AND ")}
      ORDER BY kind, object_id
      LIMIT ?
    `).all(...values) as IndexRow[];
    return rows.map(indexRow);
  }

  putPermissionEpoch(epoch: FrappePermissionEpoch, observedAt = new Date().toISOString(), validUntil = observedAt): void {
    assertIsoTimestamp(observedAt, "Frappe permission epoch observedAt");
    assertIsoTimestamp(validUntil, "Frappe permission epoch validUntil");
    this.#db.prepare(`
      INSERT INTO frappe_permission_epoch(site, principal, epoch, components_json, observed_at, valid_until)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(site, principal) DO UPDATE SET
        epoch = excluded.epoch,
        components_json = excluded.components_json,
        observed_at = excluded.observed_at,
        valid_until = excluded.valid_until
    `).run(normalizeSite(epoch.site), normalizePrincipal(epoch.principal), epoch.epoch, stableJson(epoch.components), observedAt, validUntil);
  }

  getPermissionEpoch(site: string, principal: string): FrappePermissionEpoch | undefined {
    const row = this.#db.prepare("SELECT epoch, components_json FROM frappe_permission_epoch WHERE site = ? AND principal = ?")
      .get(normalizeSite(site), normalizePrincipal(principal)) as { epoch: string; components_json: string } | undefined;
    if (!row) return undefined;
    return { site: normalizeSite(site), principal: normalizePrincipal(principal), epoch: row.epoch, components: JSON.parse(row.components_json) as FrappePermissionEpoch["components"] };
  }

  getPermissionEpochState(site: string, principal: string): FrappePermissionEpochState | undefined {
    const normalizedSite = normalizeSite(site);
    const normalizedPrincipal = normalizePrincipal(principal);
    const row = this.#db.prepare(`
      SELECT epoch, components_json, observed_at, valid_until
      FROM frappe_permission_epoch
      WHERE site = ? AND principal = ?
    `).get(normalizedSite, normalizedPrincipal) as { epoch: string; components_json: string; observed_at: string; valid_until: string | null } | undefined;
    if (!row) return undefined;
    return {
      site: normalizedSite,
      principal: normalizedPrincipal,
      epoch: row.epoch,
      components: JSON.parse(row.components_json) as FrappePermissionEpoch["components"],
      observedAt: row.observed_at,
      validUntil: row.valid_until ?? row.observed_at,
    };
  }

  invalidatePermissionEpoch(site: string, principal: string): number {
    return this.invalidatePermissionEpochs(site, principal);
  }

  invalidatePermissionEpochs(site: string, principal?: string): number {
    const result = principal
      ? this.#db.prepare("DELETE FROM frappe_permission_epoch WHERE site = ? AND principal = ?")
          .run(normalizeSite(site), normalizePrincipal(principal))
      : this.#db.prepare("DELETE FROM frappe_permission_epoch WHERE site = ?").run(normalizeSite(site));
    return Number(result.changes ?? 0);
  }

  getRevision(site: string): FrappeSiteRevision | undefined {
    const row = this.#db.prepare("SELECT schema_revision, data_revision, observed_at FROM frappe_site_revision WHERE site = ?")
      .get(site) as { schema_revision: string; data_revision: string; observed_at: string } | undefined;
    return row ? { site, schemaRevision: row.schema_revision, dataRevision: row.data_revision, observedAt: row.observed_at } : undefined;
  }

  setRevision(revision: FrappeSiteRevision): void {
    this.#db.prepare(`
      INSERT INTO frappe_site_revision(site, schema_revision, data_revision, observed_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(site) DO UPDATE SET
        schema_revision = excluded.schema_revision,
        data_revision = excluded.data_revision,
        observed_at = excluded.observed_at
    `).run(revision.site, revision.schemaRevision, revision.dataRevision, revision.observedAt);
  }

  putCache<T>(entry: FrappeCachedValue<T>): void {
    const expectedKey = frappeCacheKey(entry.identity, entry.querySignature);
    if (entry.cacheKey !== expectedKey) throw new Error("Frappe cache entry key does not match its permission and revision scope.");
    assertIsoTimestamp(entry.observedAt, "Frappe cache observedAt");
    assertIsoTimestamp(entry.validUntil, "Frappe cache validUntil");
    this.#db.prepare(`
      INSERT INTO frappe_response_cache(
        cache_key, site, principal, permission_epoch, schema_revision, data_revision,
        query_signature, value_json, observed_at, valid_until, source, object_refs_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        value_json = excluded.value_json,
        observed_at = excluded.observed_at,
        valid_until = excluded.valid_until,
        source = excluded.source,
        object_refs_json = excluded.object_refs_json
    `).run(
      entry.cacheKey,
      normalizeSite(entry.identity.site),
      normalizePrincipal(entry.identity.principal),
      entry.identity.permissionEpoch,
      entry.identity.schemaRevision,
      entry.identity.dataRevision,
      normalizeQuerySignature(entry.querySignature),
      stableJson(entry.value),
      entry.observedAt,
      entry.validUntil,
      entry.source,
      stableJson([...new Set(entry.objectRefs.map(normalizeObjectRef).filter(Boolean))].sort()),
    );
  }

  getCache<T>(identity: FrappeCacheIdentity, querySignature: string): FrappeCachedValue<T> | undefined {
    const cacheKey = frappeCacheKey(identity, querySignature);
    const normalizedSite = normalizeSite(identity.site);
    const normalizedPrincipal = normalizePrincipal(identity.principal);
    const row = this.#db.prepare(`
      SELECT cache_key, site, principal, permission_epoch, schema_revision, data_revision,
             query_signature, value_json, observed_at, valid_until, source, object_refs_json
      FROM frappe_response_cache
      WHERE cache_key = ? AND site = ? AND principal = ? AND permission_epoch = ?
        AND schema_revision = ? AND data_revision = ? AND query_signature = ?
    `).get(
      cacheKey,
      normalizedSite,
      normalizedPrincipal,
      identity.permissionEpoch,
      identity.schemaRevision,
      identity.dataRevision,
      normalizeQuerySignature(querySignature),
    ) as CacheRow | undefined;
    if (!row) return undefined;
    return {
      cacheKey: row.cache_key,
      identity: {
        site: row.site,
        principal: row.principal,
        permissionEpoch: row.permission_epoch,
        schemaRevision: row.schema_revision,
        dataRevision: row.data_revision,
      },
      querySignature: row.query_signature,
      value: JSON.parse(row.value_json) as T,
      observedAt: row.observed_at,
      validUntil: row.valid_until,
      source: row.source,
      objectRefs: JSON.parse(row.object_refs_json) as string[],
    };
  }

  invalidateCache(input: FrappeCacheInvalidation): number {
    const clauses = ["site = ?"];
    const values: unknown[] = [normalizeSite(input.site)];
    if (input.principal) {
      clauses.push("principal = ?");
      values.push(normalizePrincipal(input.principal));
    }
    if (input.permissionEpoch) {
      clauses.push("permission_epoch = ?");
      values.push(input.permissionEpoch);
    }
    const querySignatures = boundedInvalidationSelectors(input.querySignatures, normalizeQuerySignature, "query signatures");
    if (querySignatures.length) {
      clauses.push(`query_signature IN (${querySignatures.map(() => "?").join(",")})`);
      values.push(...querySignatures);
    }
    const objectRefs = boundedInvalidationSelectors(input.objectRefs, normalizeObjectRef, "object references");
    if (objectRefs.length) {
      clauses.push(`EXISTS (
        SELECT 1 FROM json_each(frappe_response_cache.object_refs_json) AS cache_ref
        WHERE cache_ref.value IN (${objectRefs.map(() => "?").join(",")})
      )`);
      values.push(...objectRefs);
    }
    const result = this.#db.prepare(`DELETE FROM frappe_response_cache WHERE ${clauses.join(" AND ")}`).run(...values);
    return Number(result.changes ?? 0);
  }

  invalidateSiteCache(site: string): number {
    return this.invalidateCache({ site });
  }

  pruneCache(expiredBefore: string, site?: string): number {
    assertIsoTimestamp(expiredBefore, "Frappe cache prune cutoff");
    const result = site
      ? this.#db.prepare("DELETE FROM frappe_response_cache WHERE site = ? AND valid_until <= ?")
          .run(normalizeSite(site), expiredBefore)
      : this.#db.prepare("DELETE FROM frappe_response_cache WHERE valid_until <= ?").run(expiredBefore);
    return Number(result.changes ?? 0);
  }

  applyEvent(event: FrappeIndexEvent): FrappeIndexEventReceipt {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#db.prepare("SELECT event_id FROM frappe_event_receipt WHERE event_id = ?").get(event.eventId);
      if (existing) {
        this.#db.exec("ROLLBACK");
        return { eventId: event.eventId, applied: false, duplicate: true, invalidatedCacheEntries: 0 };
      }
      let invalidatedCacheEntries = 0;
      if (event.operation === "upsert") {
        if (!event.kind || !event.objectId || !event.payload) throw new Error("Frappe upsert events require kind, objectId, and payload.");
        this.upsertIndex([indexRecordFromEvent(event)]);
      } else if (event.operation === "delete") {
        if (!event.kind || !event.objectId) throw new Error("Frappe delete events require kind and objectId.");
        this.deleteIndex(event.site, event.kind, event.objectId);
      }
      const targeted = Boolean(event.principal || event.permissionEpoch || event.objectRefs?.length || event.querySignatures?.length);
      invalidatedCacheEntries = targeted
        ? this.invalidateCache({
            site: event.site,
            ...(event.principal ? { principal: event.principal } : {}),
            ...(event.permissionEpoch ? { permissionEpoch: event.permissionEpoch } : {}),
            ...(event.objectRefs?.length ? { objectRefs: event.objectRefs } : {}),
            ...(event.querySignatures?.length ? { querySignatures: event.querySignatures } : {}),
          })
        : this.invalidateSiteCache(event.site);
      if (event.operation === "permission_changed") {
        this.invalidatePermissionEpochs(event.site, event.principal);
      }
      const current = this.getRevision(event.site) ?? { site: event.site, schemaRevision: "unindexed", dataRevision: "unindexed", observedAt: event.observedAt };
      this.setRevision({
        site: event.site,
        schemaRevision: ["upsert", "delete", "schema_changed", "permission_changed"].includes(event.operation) ? event.revision : current.schemaRevision,
        dataRevision: event.operation === "data_changed" ? event.revision : current.dataRevision,
        observedAt: event.observedAt,
      });
      this.#db.prepare("INSERT INTO frappe_event_receipt(event_id, site, revision, observed_at) VALUES (?, ?, ?, ?)")
        .run(event.eventId, event.site, event.revision, event.observedAt);
      this.#db.exec("COMMIT");
      return { eventId: event.eventId, applied: true, duplicate: false, invalidatedCacheEntries };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  consumeApproval(proposalId: string, signature: string, consumedAt = new Date().toISOString()): boolean {
    const result = this.#db.prepare(`
      INSERT OR IGNORE INTO frappe_approval_consumption(proposal_id, signature, consumed_at)
      VALUES (?, ?, ?)
    `).run(proposalId, signature, consumedAt);
    return Number(result.changes ?? 0) === 1;
  }

  close(): void {
    this.#db.close();
  }
}

export interface FrappeLiveRead<T> {
  readonly value: T;
  readonly objectRefs?: readonly string[];
  readonly observedAt?: string;
}

export async function resolveFrappeRead<T>(input: {
  readonly store: FrappeReadModelStore;
  readonly identity: FrappeCacheIdentity;
  readonly querySignature: string;
  readonly ttlMs: number;
  readonly now?: string;
  readonly live: () => Promise<FrappeLiveRead<T>>;
}): Promise<FrappeResolvedRead<T>> {
  const now = input.now ?? new Date().toISOString();
  const cached = input.store.getCache<T>(input.identity, input.querySignature);
  if (cached && Date.parse(cached.validUntil) > Date.parse(now)) {
    return resolvedRead(cached, now, "cache", "hit");
  }
  const live = await input.live();
  const observedAt = live.observedAt ?? now;
  const entry: FrappeCachedValue<T> = {
    cacheKey: frappeCacheKey(input.identity, input.querySignature),
    identity: input.identity,
    querySignature: normalizeQuerySignature(input.querySignature),
    value: canonicalValue(live.value),
    observedAt,
    validUntil: new Date(Date.parse(observedAt) + Math.max(1, input.ttlMs)).toISOString(),
    source: "live_frappe",
    objectRefs: [...new Set(live.objectRefs ?? [])].sort(),
  };
  input.store.putCache(entry);
  return resolvedRead(entry, now, "live_frappe", cached ? "stale" : "miss");
}

export function computeFrappePermissionEpoch(input: FrappePermissionEpochInput): FrappePermissionEpoch {
  const site = normalizeSite(input.site);
  const principal = normalizePrincipal(input.principal);
  const components = {
    roles: hashPermissionCollection(input.roles ?? []),
    userPermissions: hashPermissionCollection(input.userPermissions ?? []),
    shares: hashPermissionCollection(input.shares ?? []),
    permlevels: hashPermissionCollection(input.permlevels ?? []),
    workflows: hashPermissionCollection(input.workflowInputs ?? []),
    hierarchy: hashPermissionCollection(input.hierarchyInputs ?? []),
  };
  return { site, principal, components, epoch: hashCanonical({ site, principal, components }) };
}

export function frappeCacheKey(identity: FrappeCacheIdentity, querySignature: string): string {
  return `frappe:${hashCanonical({
    site: normalizeSite(identity.site),
    principal: normalizePrincipal(identity.principal),
    permissionEpoch: identity.permissionEpoch,
    schemaRevision: identity.schemaRevision,
    dataRevision: identity.dataRevision,
    querySignature: normalizeQuerySignature(querySignature),
  })}`;
}

export function deriveFrappeHierarchyScope(
  principal: string,
  config: FrappeHierarchyConfig,
  rows: readonly Readonly<Record<string, unknown>>[],
): FrappeHierarchyScope {
  const normalizedPrincipal = normalizePrincipal(principal);
  const activeValues = new Set((config.activeValues ?? []).map((value) => value.trim().toLowerCase()));
  const filtered = rows.filter((row) => {
    if (!config.activeField || !activeValues.size) return true;
    return activeValues.has(stringValue(row[config.activeField]).toLowerCase());
  });
  const byId = new Map<string, Readonly<Record<string, unknown>>>();
  const children = new Map<string, string[]>();
  for (const row of filtered) {
    const recordId = stringValue(row[config.recordIdField]);
    if (!recordId) continue;
    byId.set(recordId, row);
    const managerId = stringValue(row[config.managerRecordField]);
    if (managerId) children.set(managerId, [...(children.get(managerId) ?? []), recordId]);
  }
  const selfRecordIds = [...byId.entries()]
    .filter(([, row]) => normalizePrincipal(stringValue(row[config.principalField])) === normalizedPrincipal)
    .map(([recordId]) => recordId)
    .sort();
  const maxDepth = Math.max(1, Math.min(config.maxDepth ?? 32, 128));
  const queue = selfRecordIds.flatMap((recordId) => (children.get(recordId) ?? []).map((child) => ({ recordId: child, depth: 1 })));
  const visited = new Set(selfRecordIds);
  const depthByRecordId: Record<string, number> = {};
  const directReportPrincipals = new Set<string>();
  const descendantPrincipals = new Set<string>();
  while (queue.length) {
    const item = queue.shift()!;
    if (visited.has(item.recordId) || item.depth > maxDepth) continue;
    visited.add(item.recordId);
    depthByRecordId[item.recordId] = item.depth;
    const row = byId.get(item.recordId);
    const childPrincipal = row ? normalizePrincipal(stringValue(row[config.principalField])) : "";
    if (childPrincipal) {
      descendantPrincipals.add(childPrincipal);
      if (item.depth === 1) directReportPrincipals.add(childPrincipal);
    }
    for (const child of children.get(item.recordId) ?? []) queue.push({ recordId: child, depth: item.depth + 1 });
  }
  return {
    sourceDoctype: config.sourceDoctype,
    principal: normalizedPrincipal,
    selfRecordIds,
    directReportPrincipals: [...directReportPrincipals].sort(),
    descendantPrincipals: [...descendantPrincipals].sort(),
    descendantRecordIds: Object.keys(depthByRecordId).sort(),
    depthByRecordId,
    evidence: [
      `hierarchy_source:${config.sourceDoctype}`,
      `principal_field:${config.principalField}`,
      `manager_record_field:${config.managerRecordField}`,
      `matched_self_records:${selfRecordIds.length}`,
      `descendants:${Object.keys(depthByRecordId).length}`,
    ],
  };
}

export function buildFrappeIndexRecords(snapshot: FrappeEnterpriseSnapshot): FrappeIndexRecord[] {
  const validUntil = snapshot.validUntil ?? new Date(Date.parse(snapshot.observedAt) + 300_000).toISOString();
  const buckets: Array<[FrappeIndexKind, readonly unknown[] | undefined]> = [
    ["app", snapshot.apps],
    ["module", snapshot.modules],
    ["doctype", snapshot.doctypes],
    ["custom_field", snapshot.customFields],
    ["property_setter", snapshot.propertySetters],
    ["workflow", snapshot.workflows],
    ["report", snapshot.reports],
    ["print_format", snapshot.printFormats],
    ["client_script", snapshot.clientScripts],
    ["server_script", snapshot.serverScripts],
    ["funnel", snapshot.funnels],
    ["flow_config", snapshot.flowConfigs],
    ["dynamic_assignment", snapshot.dynamicAssignments],
    ["permission_rule", snapshot.permissionRules],
    ["workspace", snapshot.workspaces],
    ["notification", snapshot.notifications],
  ];
  const records: FrappeIndexRecord[] = [];
  for (const [kind, values] of buckets) {
    for (const [index, raw] of (values ?? []).entries()) {
      const original = objectValue(raw) ?? { value: raw };
      const payload = sanitizeIndexedPayload(original);
      const objectId = indexObjectId(kind, original, index);
      const doctype = indexedDoctype(kind, original);
      const module = optionalString(original.module);
      const label = optionalString(original.label) ?? optionalString(original.title) ?? optionalString(original.name);
      records.push({
        site: normalizeSite(snapshot.site),
        kind,
        objectId,
        ...(doctype ? { doctype } : {}),
        ...(module ? { module } : {}),
        ...(label ? { label } : {}),
        searchText: searchablePayload(payload),
        payload: canonicalValue(payload),
        revision: objectRevision(original, snapshot.schemaRevision),
        observedAt: snapshot.observedAt,
        validUntil,
        source: "rest_poll",
      });
      if (kind === "doctype") {
        const fields = Array.isArray(original.fields) ? original.fields : [];
        for (const [fieldIndex, fieldRaw] of fields.entries()) {
          const originalField = objectValue(fieldRaw);
          if (!originalField) continue;
          const field = sanitizeIndexedPayload(originalField);
          const fieldname = optionalString(originalField.fieldname) ?? optionalString(originalField.name) ?? `field-${fieldIndex}`;
          records.push({
            site: normalizeSite(snapshot.site),
            kind: "field",
            objectId: `${objectId}:${fieldname}`,
            doctype: objectId,
            module,
            parentId: objectId,
            label: optionalString(field.label) ?? fieldname,
            searchText: searchablePayload({ ...field, doctype: objectId }),
            payload: canonicalValue(field),
            revision: objectRevision(originalField, snapshot.schemaRevision),
            observedAt: snapshot.observedAt,
            validUntil,
            source: "rest_poll",
          });
        }
      }
    }
  }
  return records.sort((left, right) => `${left.kind}:${left.objectId}`.localeCompare(`${right.kind}:${right.objectId}`));
}

export const FRAPPE_ZERO_APP_RESOURCE_SPECS = [
  resourceSpec("modules", "module", "Module Def", false, ["name", "module_name", "app_name", "custom", "modified"]),
  resourceSpec("doctypes", "doctype", "DocType", false, ["name", "module", "custom", "istable", "is_submittable", "autoname", "title_field", "search_fields", "modified"]),
  resourceSpec("customFields", "custom_field", "Custom Field", false, ["name", "dt", "fieldname", "label", "fieldtype", "options", "reqd", "mandatory_depends_on", "depends_on", "read_only_depends_on", "permlevel", "in_list_view", "in_standard_filter", "modified"]),
  resourceSpec("propertySetters", "property_setter", "Property Setter", false, ["name", "doc_type", "field_name", "property", "value", "property_type", "modified"]),
  resourceSpec("workflows", "workflow", "Workflow", false, ["name", "document_type", "is_active", "workflow_state_field", "override_status", "modified"]),
  resourceSpec("reports", "report", "Report", false, ["name", "ref_doctype", "report_type", "module", "is_standard", "disabled", "modified"]),
  resourceSpec("printFormats", "print_format", "Print Format", false, ["name", "doc_type", "module", "standard", "disabled", "print_format_type", "modified"]),
  // Never poll script bodies into the shared read model. Runtime execution remains in Frappe.
  resourceSpec("clientScripts", "client_script", "Client Script", true, ["name", "dt", "view", "enabled", "modified"]),
  resourceSpec("serverScripts", "server_script", "Server Script", true, ["name", "reference_doctype", "script_type", "event_frequency", "disabled", "modified"]),
  resourceSpec("funnels", "funnel", "Funnel", true, ["name", "title", "module", "modified"]),
  resourceSpec("flowConfigs", "flow_config", "Flow Config", true, ["name", "flow_title", "flow_status", "trigger_type", "triggering_event", "module_transaction", "modified"]),
  resourceSpec("dynamicAssignments", "dynamic_assignment", "Assignment Rule", false, ["name", "document_type", "rule", "disabled", "priority", "modified"]),
  resourceSpec("dynamicAssignments", "dynamic_assignment", "Dynamic User Assignment", true, ["name", "title", "document_type", "disabled", "modified"]),
  resourceSpec("permissionRules", "permission_rule", "Custom DocPerm", false, ["name", "parent", "role", "permlevel", "if_owner", "select", "read", "write", "create", "delete", "submit", "cancel", "amend", "report", "export", "import", "print", "email", "share", "modified"]),
  resourceSpec("workspaces", "workspace", "Workspace", false, ["name", "title", "label", "module", "public", "for_user", "is_hidden", "parent_page", "modified"]),
  resourceSpec("notifications", "notification", "Notification", false, ["name", "document_type", "enabled", "event", "channel", "send_system_notification", "modified"]),
] as const;

export interface FrappePollResourceSpec {
  readonly snapshotKey: Exclude<keyof FrappeEnterpriseSnapshot, "site" | "observedAt" | "validUntil" | "schemaRevision" | "dataRevision" | "apps">;
  readonly kind: FrappeIndexKind;
  readonly doctype: string;
  readonly optional: boolean;
  readonly fields?: readonly string[];
}

export interface FrappeOAuthTokenProvider {
  getAccessToken(): Promise<{ readonly accessToken: string; readonly expiresAt?: string }>;
}

export async function pollFrappeEnterpriseSnapshot(input: {
  readonly site: string;
  readonly fetch: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly modifiedAfter?: string;
  readonly authorization?: string;
  readonly oauth?: FrappeOAuthTokenProvider;
  readonly pageSize?: number;
  readonly hydrateDoctypes?: boolean | "priority" | readonly string[];
  readonly priorityDoctypes?: readonly string[];
  readonly maxHydratedDoctypes?: number;
  readonly resources?: readonly FrappePollResourceSpec[];
  readonly observedAt?: string;
}): Promise<{ readonly snapshot: FrappeEnterpriseSnapshot; readonly warnings: readonly string[]; readonly requests: number }> {
  if (!input.authorization && !input.oauth) throw new Error("Frappe polling requires API-token authorization or an OAuth token provider.");
  const site = normalizeSite(input.site);
  const observedAt = input.observedAt ?? new Date().toISOString();
  const pageSize = Math.max(1, Math.min(input.pageSize ?? 100, 500));
  const warnings: string[] = [];
  let requests = 0;
  const authHeader = async (): Promise<string> => input.authorization ?? `Bearer ${(await input.oauth!.getAccessToken()).accessToken}`;
  const requestJson = async (path: string): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; status: number; detail: string }> => {
    requests += 1;
    const response = await input.fetch(`${site}${path}`, {
      headers: { Authorization: await authHeader(), Accept: "application/json" },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const text = await response.text();
    let parsed: unknown;
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = undefined; }
    if (!response.ok) return { ok: false, status: response.status, detail: frappePollError(parsed, text) };
    return { ok: true, body: objectValue(parsed) ?? {} };
  };
  const appsResponse = input.modifiedAfter
    ? undefined
    : await requestJson("/api/method/frappe.utils.change_log.get_versions");
  const apps = appsResponse?.ok ? versionRows(appsResponse.body.message) : [];
  if (appsResponse && !appsResponse.ok) warnings.push(`apps:${appsResponse.status}:${appsResponse.detail}`);
  const snapshotRows: Partial<Record<FrappePollResourceSpec["snapshotKey"], unknown[]>> = {};
  for (const spec of input.resources ?? FRAPPE_ZERO_APP_RESOURCE_SPECS) {
    const rows: unknown[] = [];
    let fields = [...(spec.fields ?? ["*"])];
    for (let start = 0; ; start += pageSize) {
      let result: Awaited<ReturnType<typeof requestJson>> | undefined;
      for (let attempt = 0; attempt <= fields.length; attempt += 1) {
        const query = new URLSearchParams({ fields: JSON.stringify(fields), limit_start: String(start), limit_page_length: String(pageSize), order_by: "modified asc" });
        if (input.modifiedAfter) query.set("filters", JSON.stringify([["modified", ">", input.modifiedAfter]]));
        result = await requestJson(`/api/resource/${encodeURIComponent(spec.doctype)}?${query.toString()}`);
        if (result.ok) break;
        const rejected = rejectedPollField(result.status, result.detail, fields);
        if (!rejected) break;
        fields = fields.filter((field) => field !== rejected);
        warnings.push(`${spec.doctype}:field_unavailable:${rejected}`);
        if (!fields.length) break;
      }
      if (!result) throw new Error(`Frappe poll produced no result for ${spec.doctype}.`);
      if (!result.ok) {
        if (!spec.optional) warnings.push(`${spec.doctype}:${result.status}:${result.detail}`);
        else warnings.push(`${spec.doctype}:optional_unavailable:${result.status}`);
        break;
      }
      const page = Array.isArray(result.body.data) ? result.body.data : [];
      rows.push(...page);
      if (page.length < pageSize) break;
    }
    snapshotRows[spec.snapshotKey] = [...(snapshotRows[spec.snapshotKey] ?? []), ...rows];
  }
  if (input.hydrateDoctypes !== false) {
    const doctypes = snapshotRows.doctypes ?? [];
    const selected = selectedHydrationDoctypes(input, snapshotRows, doctypes);
    const hydrated: unknown[] = [];
    for (const raw of doctypes) {
      const summary = objectValue(raw);
      const name = summary ? optionalString(summary.name) : undefined;
      if (!name) continue;
      if (!selected.has(name)) {
        hydrated.push(summary);
        continue;
      }
      const detail = await requestJson(`/api/resource/DocType/${encodeURIComponent(name)}`);
      if (detail.ok && objectValue(detail.body.data)) hydrated.push(detail.body.data);
      else {
        hydrated.push(summary);
        if (!detail.ok) warnings.push(`DocType/${name}:${detail.status}:${detail.detail}`);
      }
    }
    snapshotRows.doctypes = hydrated;
  }
  const snapshot: FrappeEnterpriseSnapshot = {
    site,
    observedAt,
    validUntil: new Date(Date.parse(observedAt) + 300_000).toISOString(),
    apps,
    modules: snapshotRows.modules ?? [],
    doctypes: snapshotRows.doctypes ?? [],
    customFields: snapshotRows.customFields ?? [],
    propertySetters: snapshotRows.propertySetters ?? [],
    workflows: snapshotRows.workflows ?? [],
    reports: snapshotRows.reports ?? [],
    printFormats: snapshotRows.printFormats ?? [],
    clientScripts: snapshotRows.clientScripts ?? [],
    serverScripts: snapshotRows.serverScripts ?? [],
    funnels: snapshotRows.funnels ?? [],
    flowConfigs: snapshotRows.flowConfigs ?? [],
    dynamicAssignments: snapshotRows.dynamicAssignments ?? [],
    permissionRules: snapshotRows.permissionRules ?? [],
    workspaces: snapshotRows.workspaces ?? [],
    notifications: snapshotRows.notifications ?? [],
  };
  const records = buildFrappeIndexRecords(snapshot);
  const revision = snapshotRevision(snapshot, records);
  return { snapshot: { ...snapshot, schemaRevision: revision.schemaRevision, dataRevision: revision.dataRevision }, warnings, requests };
}

export interface FrappeApprovalProposal {
  readonly proposalId: string;
  readonly mutationHash: string;
  readonly site: string;
  readonly principal: string;
  readonly operation: "create" | "update" | "delete" | "submit" | "cancel" | "apply_workflow";
  readonly doctype: string;
  readonly docname?: string;
  readonly fields: readonly string[];
  readonly permissionEpoch: string;
  readonly schemaRevision: string;
  readonly dataRevision: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
  readonly humanSummary: string;
  readonly bindingRequirements: readonly string[];
}

export interface FrappeApprovalReceipt {
  readonly proposal: FrappeApprovalProposal;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly signature: string;
}

export function createFrappeApprovalProposal(input: {
  readonly site: string;
  readonly principal: string;
  readonly operation: "create" | "update" | "delete" | "submit" | "cancel" | "apply_workflow";
  readonly doctype: string;
  readonly docname?: string;
  readonly doc: Readonly<Record<string, unknown>>;
  readonly permissionEpoch: string;
  readonly schemaRevision: string;
  readonly dataRevision: string;
  readonly issuedAt?: string;
  readonly ttlMs?: number;
  readonly nonce: string;
}): FrappeApprovalProposal {
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  const mutationHash = hashCanonical({
    site: normalizeSite(input.site),
    principal: normalizePrincipal(input.principal),
    operation: input.operation,
    doctype: input.doctype,
    docname: input.docname ?? null,
    doc: input.doc,
  });
  const base = {
    mutationHash,
    site: normalizeSite(input.site),
    principal: normalizePrincipal(input.principal),
    operation: input.operation,
    doctype: input.doctype.trim(),
    ...(input.docname ? { docname: input.docname.trim() } : {}),
    fields: Object.keys(input.doc).sort(),
    permissionEpoch: input.permissionEpoch,
    schemaRevision: input.schemaRevision,
    dataRevision: input.dataRevision,
    issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + Math.max(1, input.ttlMs ?? 300_000)).toISOString(),
    nonce: input.nonce,
  };
  return {
    proposalId: `frappe-approval:${hashCanonical(base)}`,
    ...base,
    humanSummary: `${({ create: "Create", update: "Update", delete: "Delete", submit: "Submit", cancel: "Cancel", apply_workflow: "Apply workflow" } as const)[input.operation]} ${input.doctype}${input.docname ? ` ${input.docname}` : ""}${input.operation === "create" || input.operation === "update" ? ` with ${base.fields.length} field${base.fields.length === 1 ? "" : "s"}` : ""}.`,
    bindingRequirements: [
      "The approving actor must be authenticated separately from the model request.",
      "The receipt is valid only for this principal, mutation hash, permission epoch, and schema/data revision.",
      "The receipt must be consumed atomically once before the write executes.",
      "Frappe permission and mandatory-field validation must run again immediately before execution.",
    ],
  };
}

export function signFrappeApproval(
  proposal: FrappeApprovalProposal,
  approvedBy: string,
  signingKey: string,
  approvedAt = new Date().toISOString(),
): FrappeApprovalReceipt {
  if (!signingKey) throw new Error("A non-empty approval signing key is required.");
  const unsigned = { proposal, approvedBy: normalizePrincipal(approvedBy), approvedAt };
  return { ...unsigned, signature: createHmac("sha256", signingKey).update(stableJson(unsigned)).digest("hex") };
}

export function verifyFrappeApproval(input: {
  readonly receipt: FrappeApprovalReceipt;
  readonly expected: FrappeApprovalProposal;
  readonly signingKey: string;
  readonly now?: string;
}): { readonly valid: boolean; readonly reason: string } {
  if (!input.signingKey) return { valid: false, reason: "approval signing key is not configured" };
  const now = Date.parse(input.now ?? new Date().toISOString());
  const issuedAt = Date.parse(input.receipt.proposal.issuedAt);
  const approvedAt = Date.parse(input.receipt.approvedAt);
  const expiresAt = Date.parse(input.receipt.proposal.expiresAt);
  if (![now, issuedAt, approvedAt, expiresAt].every(Number.isFinite)) return { valid: false, reason: "approval receipt contains an invalid timestamp" };
  if (expiresAt <= now) return { valid: false, reason: "approval receipt has expired" };
  if (approvedAt < issuedAt || approvedAt > expiresAt || approvedAt > now + 30_000) return { valid: false, reason: "approval time is outside the proposal validity window" };
  if (stableJson(input.receipt.proposal) !== stableJson(input.expected)) return { valid: false, reason: "approval receipt is bound to a different mutation or revision" };
  const unsigned = { proposal: input.receipt.proposal, approvedBy: normalizePrincipal(input.receipt.approvedBy), approvedAt: input.receipt.approvedAt };
  const expectedSignature = createHmac("sha256", input.signingKey).update(stableJson(unsigned)).digest("hex");
  if (!safeHexEqual(expectedSignature, input.receipt.signature)) return { valid: false, reason: "approval signature is invalid" };
  return { valid: true, reason: "approval is bound to the exact mutation and current revision inputs" };
}

export function validateFrappeCustomerProfile(value: unknown): { readonly valid: true; readonly profile: FrappeCustomerProfile } | { readonly valid: false; readonly errors: readonly string[] } {
  const profile = objectValue(value);
  const errors: string[] = [];
  if (!profile) return { valid: false, errors: ["profile must be an object"] };
  if (profile.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (!optionalString(profile.id)) errors.push("id is required");
  if (!optionalString(profile.displayName)) errors.push("displayName is required");
  const site = objectValue(profile.site);
  if (!site || !optionalString(site.urlFromEnv)) errors.push("site.urlFromEnv is required");
  if (!site || !["oauth2", "api_token"].includes(stringValue(site.auth))) errors.push("site.auth must be oauth2 or api_token");
  const hierarchy = objectValue(profile.hierarchy);
  for (const key of ["sourceDoctype", "recordIdField", "principalField", "managerRecordField"]) {
    if (!hierarchy || !optionalString(hierarchy[key])) errors.push(`hierarchy.${key} is required`);
  }
  const indexing = objectValue(profile.indexing);
  if (!indexing || !Array.isArray(indexing.coreKinds) || !indexing.coreKinds.every((kind) => FRAPPE_INDEX_KINDS.includes(kind as FrappeIndexKind))) errors.push("indexing.coreKinds contains an unsupported kind");
  if (!indexing || !positiveNumber(indexing.pollIntervalSeconds)) errors.push("indexing.pollIntervalSeconds must be positive");
  const cache = objectValue(profile.cache);
  if (!cache || !positiveNumber(cache.metadataTtlSeconds) || !positiveNumber(cache.operationalTtlSeconds)) errors.push("cache TTL values must be positive");
  const writePolicy = objectValue(profile.writePolicy);
  if (!writePolicy || writePolicy.requirePermissionPreflight !== true || writePolicy.requireBoundApproval !== true || !positiveNumber(writePolicy.approvalTtlSeconds)) errors.push("writePolicy must require preflight, bound approval, and a positive TTL");
  return errors.length ? { valid: false, errors } : { valid: true, profile: value as FrappeCustomerProfile };
}

export const FRAPPE_POSTGRES_DEPLOYMENT_CONTRACT = {
  schemaVersion: 1,
  backend: "postgres" as const,
  schema: "muster_frappe",
  consistency: {
    permissionEpoch: "synchronous invalidation before serving cached data",
    schemaRevision: "monotonic per site",
    dataRevision: "monotonic per indexed dataset",
    approvalConsumption: "single transaction INSERT ... ON CONFLICT DO NOTHING",
  },
  requiredOperations: [
    "replaceSnapshot",
    "upsertIndex",
    "deleteIndex",
    "searchIndex",
    "putPermissionEpoch",
    "getPermissionEpoch",
    "getPermissionEpochState",
    "invalidatePermissionEpoch",
    "invalidatePermissionEpochs",
    "putCache",
    "getCache",
    "invalidateCache",
    "invalidateSiteCache",
    "pruneCache",
    "applyEvent",
    "consumeApproval",
  ],
  requiredIndexes: [
    "site + kind + object_id unique",
    "site + principal + permission_epoch + schema_revision + data_revision + query_signature",
    "site + valid_until",
    "event_id unique",
    "proposal_id unique",
  ],
  safety: [
    "Partition or row-scope every query by site.",
    "Never query cache without principal and permission epoch.",
    "Apply event idempotency and revision update in one transaction.",
    "Consume approval before mutation and never make a consumed approval reusable.",
    "Keep OAuth and API tokens outside read-model rows and logs.",
  ],
} as const;

function snapshotRevision(snapshot: FrappeEnterpriseSnapshot, records: readonly FrappeIndexRecord[]): FrappeSiteRevision {
  const schemaRevision = snapshot.schemaRevision ?? hashCanonical(records.map((record) => ({ kind: record.kind, objectId: record.objectId, payload: record.payload })));
  return {
    site: normalizeSite(snapshot.site),
    schemaRevision,
    dataRevision: snapshot.dataRevision ?? "metadata-only",
    observedAt: snapshot.observedAt,
  };
}

function resolvedRead<T>(entry: FrappeCachedValue<T>, servedAt: string, route: FrappeProvenanceReceipt["route"], cacheState: FrappeProvenanceReceipt["cacheState"]): FrappeResolvedRead<T> {
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
      servedAt,
      validUntil: entry.validUntil,
      objectRefs: entry.objectRefs,
    },
    presentation: {
      message: route === "cache" ? "I used current Frappe data available to you." : "I refreshed this from Frappe before answering.",
      status: route === "cache" ? "current" : "refreshed",
      updatedAt: entry.observedAt,
    },
  };
}

function indexRecordFromEvent(event: FrappeIndexEvent): FrappeIndexRecord {
  const payload = sanitizeIndexedPayload(event.payload ?? {});
  return {
    site: normalizeSite(event.site),
    kind: event.kind!,
    objectId: event.objectId!,
    ...(indexedDoctype(event.kind!, payload) ? { doctype: indexedDoctype(event.kind!, payload) } : {}),
    ...(optionalString(payload.module) ? { module: optionalString(payload.module) } : {}),
    ...(optionalString(payload.label) || optionalString(payload.name) ? { label: optionalString(payload.label) ?? optionalString(payload.name) } : {}),
    searchText: searchablePayload(payload),
    payload,
    revision: event.revision,
    observedAt: event.observedAt,
    validUntil: event.validUntil ?? new Date(Date.parse(event.observedAt) + 300_000).toISOString(),
    source: "frappe_event",
  };
}

function indexRow(row: IndexRow): FrappeIndexRecord {
  return {
    site: row.site,
    kind: row.kind,
    objectId: row.object_id,
    ...(row.doctype ? { doctype: row.doctype } : {}),
    ...(row.module ? { module: row.module } : {}),
    ...(row.parent_id ? { parentId: row.parent_id } : {}),
    ...(row.label ? { label: row.label } : {}),
    searchText: row.search_text,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    revision: row.revision,
    observedAt: row.observed_at,
    validUntil: row.valid_until,
    source: row.source,
  };
}

function indexObjectId(kind: FrappeIndexKind, payload: Readonly<Record<string, unknown>>, index: number): string {
  const doctype = indexedDoctype(kind, payload);
  const fieldname = optionalString(payload.fieldname) ?? optionalString(payload.field_name);
  const name = optionalString(payload.name) ?? optionalString(payload.id) ?? optionalString(payload.route);
  if ((kind === "custom_field" || kind === "property_setter") && doctype && fieldname) return `${doctype}:${fieldname}:${name ?? index}`;
  return name ?? (doctype && fieldname ? `${doctype}:${fieldname}` : `${kind}:${hashCanonical(payload).slice(0, 20)}:${index}`);
}

function indexedDoctype(kind: FrappeIndexKind, payload: Readonly<Record<string, unknown>>): string | undefined {
  if (kind === "doctype") return optionalString(payload.name);
  return optionalString(payload.dt)
    ?? optionalString(payload.doc_type)
    ?? optionalString(payload.document_type)
    ?? optionalString(payload.ref_doctype)
    ?? optionalString(payload.reference_doctype)
    ?? optionalString(payload.doctype_name);
}

function objectRevision(payload: Readonly<Record<string, unknown>>, fallback?: string): string {
  return optionalString(payload.modified) ?? optionalString(payload.revision) ?? fallback ?? hashCanonical(payload);
}

function searchablePayload(payload: Readonly<Record<string, unknown>>): string {
  const values: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (values.join(" ").length >= 16_000 || depth > 5 || value === null || value === undefined) return;
    if (["string", "number", "boolean"].includes(typeof value)) {
      values.push(String(value));
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 200)) visit(item, depth + 1);
      return;
    }
    const object = objectValue(value);
    if (object) for (const [key, item] of Object.entries(object).sort(([left], [right]) => left.localeCompare(right))) {
      values.push(key);
      visit(item, depth + 1);
    }
  };
  visit(payload, 0);
  return values.join(" ").replace(/\s+/g, " ").trim().slice(0, 16_000);
}

function sanitizeIndexedPayload(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const sanitize = (item: unknown, key = "", depth = 0): unknown => {
    if (depth > 10) return "[TRUNCATED]";
    if (/secret|token|password|passwd|authorization|cookie|api[_-]?key|private[_-]?key/i.test(key)) return "[REDACTED]";
    if (typeof item === "string") return redactSecretText(item);
    if (Array.isArray(item)) return item.slice(0, 2_000).map((child) => sanitize(child, key, depth + 1));
    const object = objectValue(item);
    if (!object) return item;
    return Object.fromEntries(Object.entries(object).map(([childKey, child]) => [childKey, sanitize(child, childKey, depth + 1)]));
  };
  return sanitize(value) as Record<string, unknown>;
}

function redactSecretText(value: string): string {
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/g, "[REDACTED JWT]")
    .replace(/\b(api[_-]?key|api[_-]?secret|token|secret|password|passwd)\s*[:=]\s*(["']?)[^\s,"';]+\2/gi, "$1=[REDACTED]");
}

function normalizeQuerySignature(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}\s_.:/-]/gu, " ").replace(/\s+/g, " ").trim();
}

function normalizeObjectRef(value: string): string {
  return value.trim();
}

function boundedInvalidationSelectors(
  values: readonly string[] | undefined,
  normalize: (value: string) => string,
  label: string,
): string[] {
  if (!values) return [];
  if (values.length > 100) throw new Error(`Frappe cache invalidation accepts at most 100 ${label}.`);
  return [...new Set(values.map(normalize).filter(Boolean))];
}

function normalizeSearch(value: string): string[] {
  return [...new Set(normalizeQuerySignature(value).split(" ").filter((term) => term.length > 1))].slice(0, 12);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function normalizeSite(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Frappe site is required.");
  return trimmed.replace(/\/$/, "").toLowerCase();
}

function normalizePrincipal(value: string): string {
  return value.trim().toLowerCase();
}

function assertIsoTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp.`);
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function hashPermissionCollection(value: readonly unknown[]): string {
  const normalized = value.map((item) => canonicalValue(item)).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return hashCanonical(normalized);
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalValue(item)) as T;
  }
  if (value && typeof value === "object") {
    const sorted = Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]));
    return sorted as T;
  }
  return value;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringValue(value: unknown): string {
  return optionalString(value) ?? (typeof value === "number" || typeof value === "boolean" ? String(value) : "");
}

function positiveNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function safeHexEqual(expected: string, actual: string): boolean {
  if (!/^[0-9a-f]+$/i.test(actual) || expected.length !== actual.length) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}

function selectedHydrationDoctypes(
  input: {
    readonly hydrateDoctypes?: boolean | "priority" | readonly string[];
    readonly priorityDoctypes?: readonly string[];
    readonly maxHydratedDoctypes?: number;
  },
  rows: Partial<Record<FrappePollResourceSpec["snapshotKey"], unknown[]>>,
  doctypes: readonly unknown[],
): ReadonlySet<string> {
  if (Array.isArray(input.hydrateDoctypes)) {
    return new Set(input.hydrateDoctypes.map((value) => value.trim()).filter(Boolean));
  }
  if (input.hydrateDoctypes !== "priority") {
    return new Set(doctypes.flatMap((raw) => optionalString(objectValue(raw)?.name) ?? []));
  }

  const available = new Set(doctypes.flatMap((raw) => optionalString(objectValue(raw)?.name) ?? []));
  const doctypeRows = doctypes.flatMap((raw): Array<{ name: string; module: string; isTable: boolean }> => {
    const row = objectValue(raw);
    const name = optionalString(row?.name);
    if (!name) return [];
    const tableValue = row?.istable;
    return [{ name, module: optionalString(row?.module) ?? "Unassigned", isTable: tableValue === true || tableValue === 1 || tableValue === "1" }];
  });
  const score = new Map<string, number>();
  const add = (value: unknown, weight: number): void => {
    const name = optionalString(value);
    if (!name || !available.has(name)) return;
    score.set(name, (score.get(name) ?? 0) + weight);
  };
  for (const name of input.priorityDoctypes ?? []) add(name, 10_000);
  for (const raw of rows.customFields ?? []) add(objectValue(raw)?.dt, 8);
  for (const raw of rows.propertySetters ?? []) add(objectValue(raw)?.doc_type, 10);
  for (const raw of rows.permissionRules ?? []) add(objectValue(raw)?.parent, 4);
  for (const raw of rows.workflows ?? []) add(objectValue(raw)?.document_type, 20);
  for (const raw of rows.reports ?? []) add(objectValue(raw)?.ref_doctype, 2);
  for (const raw of rows.dynamicAssignments ?? []) add(objectValue(raw)?.document_type, 12);
  for (const raw of rows.notifications ?? []) add(objectValue(raw)?.document_type, 6);
  for (const row of doctypeRows) add(row.name, row.isTable ? 1 : 3);
  const limit = Math.max(1, Math.min(input.maxHydratedDoctypes ?? 64, 256));
  const ranked = [...score.entries()]
    .sort(([leftName, left], [rightName, right]) => right - left || leftName.localeCompare(rightName));
  const selected: string[] = [];
  const take = (name: string): void => {
    if (selected.length < limit && !selected.includes(name)) selected.push(name);
  };
  for (const name of input.priorityDoctypes ?? []) if (available.has(name)) take(name);
  const byModule = new Map<string, Array<[string, number]>>();
  for (const row of doctypeRows.filter((item) => !item.isTable)) {
    byModule.set(row.module, [...(byModule.get(row.module) ?? []), [row.name, score.get(row.name) ?? 0]]);
  }
  for (const candidates of [...byModule.values()].sort((left, right) => (right[0]?.[1] ?? 0) - (left[0]?.[1] ?? 0))) {
    candidates.sort(([leftName, left], [rightName, right]) => right - left || leftName.localeCompare(rightName));
    if (candidates[0]) take(candidates[0][0]);
  }
  for (const [name] of ranked) take(name);
  return new Set(selected);
}

function resourceSpec(
  snapshotKey: FrappePollResourceSpec["snapshotKey"],
  kind: FrappeIndexKind,
  doctype: string,
  optional: boolean,
  fields?: readonly string[],
): FrappePollResourceSpec {
  return { snapshotKey, kind, doctype, optional, ...(fields ? { fields } : {}) };
}

function versionRows(value: unknown): Array<Record<string, unknown>> {
  const versions = objectValue(value);
  if (!versions) return [];
  return Object.entries(versions).map(([name, raw]) => {
    const detail = objectValue(raw);
    return { name, version: detail ? optionalString(detail.version) : optionalString(raw), ...(detail ?? {}) };
  });
}

function frappePollError(value: unknown, text: string): string {
  const body = objectValue(value);
  return optionalString(body?.exception) ?? optionalString(body?.message) ?? (text.slice(0, 200) || "unknown Frappe error");
}

function rejectedPollField(status: number, detail: string, fields: readonly string[]): string | undefined {
  if (status !== 417 || fields.length <= 1) return undefined;
  const match = /Field not permitted in query:\s*([A-Za-z0-9_]+)/i.exec(detail);
  return match?.[1] && fields.includes(match[1]) ? match[1] : undefined;
}
