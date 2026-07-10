import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import {
  createEnterpriseActionReceipt,
  enterpriseScopeMatches,
  enterpriseSubjectKey,
  normalizeEnterpriseSubjects,
  type EnterpriseActionReceipt,
  type EnterpriseBudgetStore,
  type EnterpriseCounterConsumeInput,
  type EnterpriseCounterBatchResult,
  type EnterpriseCounterReadInput,
  type EnterpriseCounterResult,
  type EnterpriseIdempotencyClaim,
  type EnterpriseIdempotencyClaimInput,
  type EnterpriseIdempotencyCompleteInput,
  type EnterpriseIdempotencyRecord,
  type EnterpriseIdempotencyReleaseInput,
  type EnterpriseIdempotencyRenewInput,
  type EnterpriseIdempotencyStore,
  type EnterpriseRateLimitStore,
  type EnterpriseReceiptMetadataValue,
  type EnterpriseReceiptQuery,
  type EnterpriseReceiptStore,
  type EnterpriseSubject,
} from "./enterprise-governance.js";
import type {
  EnterpriseCacheStatus,
  EnterpriseUsageEvent,
  EnterpriseUsageOutcome,
  EnterpriseUsageQuery,
  EnterpriseUsageStore,
} from "./enterprise-reporting.js";

interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface EnterpriseSqliteStoreOptions {
  readonly filename: string;
  readonly busyTimeoutMs?: number;
}

type CounterKind = "rate_limit" | "budget";

const USAGE_OUTCOMES = new Set<EnterpriseUsageOutcome>(["success", "error", "blocked", "cancelled"]);
const CACHE_STATUSES = new Set<EnterpriseCacheStatus>(["hit", "miss", "bypass"]);
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

class AtomicCounterBatchRejected extends Error {
  constructor(readonly results: readonly EnterpriseCounterResult[]) {
    super("Atomic counter batch rejected.");
  }
}

/**
 * Durable local enterprise control-plane storage.
 *
 * All read-modify-write paths use BEGIN IMMEDIATE so separate processes cannot
 * both admit the same limited request or idempotency claim. Usage persistence
 * writes an explicit allowlist of fields; raw prompts and unknown runtime fields
 * are never serialized.
 */
export class EnterpriseSqliteStore implements
  EnterpriseRateLimitStore,
  EnterpriseBudgetStore,
  EnterpriseIdempotencyStore,
  EnterpriseReceiptStore,
  EnterpriseUsageStore {
  readonly #db: SqliteDatabase;
  #closed = false;

  constructor(options: EnterpriseSqliteStoreOptions | string) {
    const normalized = typeof options === "string" ? { filename: options } : options;
    const filename = normalized.filename.trim();
    if (!filename) throw new Error("Enterprise SQLite filename must be non-empty.");
    const busyTimeoutMs = normalized.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
      throw new Error("Enterprise SQLite busyTimeoutMs must be a non-negative safe integer.");
    }
    if (filename !== ":memory:" && !filename.startsWith("file:")) {
      mkdirSync(dirname(filename), { recursive: true });
    }

    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (path: string) => SqliteDatabase;
    };
    this.#db = new DatabaseSync(filename);
    this.#db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = ${busyTimeoutMs};
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA temp_store = MEMORY;

      CREATE TABLE IF NOT EXISTS enterprise_counters (
        kind TEXT NOT NULL CHECK (kind IN ('rate_limit', 'budget')),
        counter_key TEXT NOT NULL,
        window_start_ms REAL NOT NULL,
        window_end_ms REAL NOT NULL,
        value REAL NOT NULL CHECK (value >= 0),
        PRIMARY KEY (kind, counter_key, window_start_ms)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_enterprise_counters_expiry
        ON enterprise_counters(kind, window_end_ms);

      CREATE TABLE IF NOT EXISTS enterprise_idempotency (
        namespace TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        claim_token TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
        claimed_at_ms REAL NOT NULL,
        expires_at_ms REAL NOT NULL,
        result_ref TEXT,
        PRIMARY KEY (namespace, idempotency_key)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_enterprise_idempotency_expiry
        ON enterprise_idempotency(expires_at_ms);

      CREATE TABLE IF NOT EXISTS enterprise_receipts (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        receipt_id TEXT NOT NULL UNIQUE,
        occurred_at TEXT NOT NULL,
        integrity_hash TEXT NOT NULL,
        receipt_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_enterprise_receipts_time
        ON enterprise_receipts(occurred_at, receipt_id);

      CREATE TABLE IF NOT EXISTS enterprise_receipt_subjects (
        receipt_id TEXT NOT NULL REFERENCES enterprise_receipts(receipt_id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        PRIMARY KEY (receipt_id, kind, subject_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_enterprise_receipt_subject_scope
        ON enterprise_receipt_subjects(kind, subject_id, receipt_id);

      CREATE TABLE IF NOT EXISTS enterprise_usage (
        event_id TEXT PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        occurred_at_ms REAL NOT NULL,
        subjects_json TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('success', 'error', 'blocked', 'cancelled')),
        latency_ms REAL NOT NULL CHECK (latency_ms >= 0),
        input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
        output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
        cached_input_tokens INTEGER NOT NULL CHECK (cached_input_tokens >= 0),
        cost_microusd INTEGER NOT NULL CHECK (cost_microusd >= 0),
        cache_status TEXT NOT NULL CHECK (cache_status IN ('hit', 'miss', 'bypass')),
        tool TEXT,
        request_category TEXT,
        fingerprint TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_enterprise_usage_time
        ON enterprise_usage(occurred_at_ms, event_id);

      CREATE TABLE IF NOT EXISTS enterprise_usage_subjects (
        event_id TEXT NOT NULL REFERENCES enterprise_usage(event_id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        PRIMARY KEY (event_id, kind, subject_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_enterprise_usage_subject_scope
        ON enterprise_usage_subjects(kind, subject_id, event_id);
    `);
    const idempotencyColumns = this.#db.prepare("PRAGMA table_info(enterprise_idempotency)").all() as Array<{ name?: unknown }>;
    if (!idempotencyColumns.some((column) => String(column.name) === "claim_token")) {
      this.#db.exec("ALTER TABLE enterprise_idempotency ADD COLUMN claim_token TEXT NOT NULL DEFAULT '';");
    }
    const unindexedReceipts = this.#db.prepare(`
      SELECT r.receipt_id, r.integrity_hash, r.receipt_json FROM enterprise_receipts r
      WHERE NOT EXISTS (SELECT 1 FROM enterprise_receipt_subjects s WHERE s.receipt_id = r.receipt_id)
    `).all() as Record<string, unknown>[];
    if (unindexedReceipts.length) {
      this.#transaction(() => {
        const insert = this.#db.prepare("INSERT OR IGNORE INTO enterprise_receipt_subjects (receipt_id, kind, subject_id) VALUES (?, ?, ?)");
        for (const row of unindexedReceipts) {
          const receipt = receiptFromRow(row);
          for (const subject of normalizeEnterpriseSubjects([...receipt.actor, ...receipt.target])) {
            insert.run(receipt.receiptId, subject.kind, subject.id);
          }
        }
      });
    }
  }

  async consumeRateLimit(input: EnterpriseCounterConsumeInput): Promise<EnterpriseCounterResult> {
    return this.#consumeCounter("rate_limit", input);
  }

  async consumeRateLimitsAtomically(inputs: readonly EnterpriseCounterConsumeInput[]): Promise<EnterpriseCounterBatchResult> {
    if (!inputs.length) return Object.freeze({ accepted: true, results: Object.freeze([]) });
    inputs.forEach(validateCounterInput);
    this.#ensureOpen();
    try {
      const results = this.#transaction(() => {
        const decisions: EnterpriseCounterResult[] = [];
        for (const input of inputs) {
          const decision = this.#consumeCounterInTransaction("rate_limit", input);
          decisions.push(decision);
          if (!decision.accepted) throw new AtomicCounterBatchRejected(decisions);
        }
        return decisions;
      });
      return Object.freeze({ accepted: true, results: Object.freeze(results) });
    } catch (error) {
      if (error instanceof AtomicCounterBatchRejected) {
        return Object.freeze({ accepted: false, results: Object.freeze(error.results) });
      }
      throw error;
    }
  }

  async readRateLimit(input: EnterpriseCounterReadInput): Promise<number> {
    return this.#readCounter("rate_limit", input);
  }

  async consumeBudget(input: EnterpriseCounterConsumeInput): Promise<EnterpriseCounterResult> {
    return this.#consumeCounter("budget", input);
  }

  async readBudget(input: EnterpriseCounterReadInput): Promise<number> {
    return this.#readCounter("budget", input);
  }

  async claimIdempotency(input: EnterpriseIdempotencyClaimInput): Promise<EnterpriseIdempotencyClaim> {
    validateIdempotencyClaim(input);
    this.#ensureOpen();
    return this.#transaction(() => {
      this.#db.prepare("DELETE FROM enterprise_idempotency WHERE expires_at_ms <= ?").run(input.nowMs);
      const existing = this.#db.prepare(`
        SELECT namespace, idempotency_key, fingerprint, claim_token, state, claimed_at_ms, expires_at_ms, result_ref
        FROM enterprise_idempotency WHERE namespace = ? AND idempotency_key = ?
      `).get(input.namespace, input.key) as Record<string, unknown> | undefined;
      if (existing) {
        const record = idempotencyRecordFromRow(existing);
        return deepFreeze({
          status: record.fingerprint === input.fingerprint ? "replay" : "conflict",
          record,
        });
      }

      const expiresAtMs = input.nowMs + input.ttlMs;
      const claimToken = randomUUID();
      assertDateTimestamp(expiresAtMs, "Idempotency expiry");
      this.#db.prepare(`
        INSERT INTO enterprise_idempotency
          (namespace, idempotency_key, fingerprint, claim_token, state, claimed_at_ms, expires_at_ms, result_ref)
        VALUES (?, ?, ?, ?, 'pending', ?, ?, NULL)
      `).run(input.namespace, input.key, input.fingerprint, claimToken, input.nowMs, expiresAtMs);
      return deepFreeze({
        status: "claimed",
        record: idempotencyRecordFromValues(input.namespace, input.key, input.fingerprint, claimToken, "pending", input.nowMs, expiresAtMs),
      });
    });
  }

  async renewIdempotency(input: EnterpriseIdempotencyRenewInput): Promise<EnterpriseIdempotencyRecord> {
    validateIdempotencyOwnership(input, "renewal");
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) throw new Error("Idempotency renewal ttlMs must be positive.");
    this.#ensureOpen();
    const outcome = this.#transaction((): { record?: EnterpriseIdempotencyRecord; error?: string } => {
      const row = this.#db.prepare(`
        SELECT namespace, idempotency_key, fingerprint, claim_token, state, claimed_at_ms, expires_at_ms, result_ref
        FROM enterprise_idempotency WHERE namespace = ? AND idempotency_key = ?
      `).get(input.namespace, input.key) as Record<string, unknown> | undefined;
      if (!row || Number(row.expires_at_ms) <= input.nowMs || String(row.state) !== "pending") {
        if (row && Number(row.expires_at_ms) <= input.nowMs) {
          this.#db.prepare("DELETE FROM enterprise_idempotency WHERE namespace = ? AND idempotency_key = ? AND expires_at_ms <= ?")
            .run(input.namespace, input.key, input.nowMs);
        }
        return { error: "Idempotency claim is missing, expired, or already completed." };
      }
      const ownershipError = idempotencyOwnershipError(row, input);
      if (ownershipError) return { error: ownershipError };
      const expiresAtMs = Math.max(Number(row.expires_at_ms), input.nowMs + input.ttlMs);
      const updated = this.#db.prepare(`
        UPDATE enterprise_idempotency SET expires_at_ms = ?
        WHERE namespace = ? AND idempotency_key = ? AND fingerprint = ? AND claim_token = ? AND state = 'pending'
      `).run(expiresAtMs, input.namespace, input.key, input.fingerprint, input.claimToken) as { changes?: number | bigint };
      if (Number(updated.changes ?? 0) !== 1) return { error: "Idempotency claim generation conflict." };
      return {
        record: idempotencyRecordFromValues(
          String(row.namespace), String(row.idempotency_key), String(row.fingerprint), String(row.claim_token),
          "pending", Number(row.claimed_at_ms), expiresAtMs,
        ),
      };
    });
    if (outcome.error) throw new Error(outcome.error);
    return outcome.record as EnterpriseIdempotencyRecord;
  }

  async completeIdempotency(input: EnterpriseIdempotencyCompleteInput): Promise<EnterpriseIdempotencyRecord> {
    validateIdempotencyOwnership(input, "completion");
    validateNonEmpty(input.resultRef, "Idempotency resultRef");
    if (input.ttlMs !== undefined && (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0)) {
      throw new Error("Idempotency completion ttlMs must be positive.");
    }
    this.#ensureOpen();

    const outcome = this.#transaction((): { record?: EnterpriseIdempotencyRecord; error?: string } => {
      const row = this.#db.prepare(`
        SELECT namespace, idempotency_key, fingerprint, claim_token, state, claimed_at_ms, expires_at_ms, result_ref
        FROM enterprise_idempotency WHERE namespace = ? AND idempotency_key = ?
      `).get(input.namespace, input.key) as Record<string, unknown> | undefined;
      if (!row) return { error: "Idempotency claim is missing or expired." };
      if (Number(row.expires_at_ms) <= input.nowMs) {
        this.#db.prepare("DELETE FROM enterprise_idempotency WHERE namespace = ? AND idempotency_key = ?")
          .run(input.namespace, input.key);
        return { error: "Idempotency claim is missing or expired." };
      }
      const ownershipError = idempotencyOwnershipError(row, input);
      if (ownershipError) return { error: ownershipError };
      if (String(row.state) === "completed" && String(row.result_ref) !== input.resultRef) {
        return { error: "Idempotency claim was already completed with another result." };
      }
      const expiresAtMs = input.ttlMs === undefined
        ? Number(row.expires_at_ms)
        : Math.max(Number(row.expires_at_ms), input.nowMs + input.ttlMs);
      if (String(row.state) !== "completed" || expiresAtMs !== Number(row.expires_at_ms)) {
        this.#db.prepare(`
          UPDATE enterprise_idempotency SET state = 'completed', result_ref = ?, expires_at_ms = ?
          WHERE namespace = ? AND idempotency_key = ? AND fingerprint = ? AND claim_token = ?
        `).run(input.resultRef, expiresAtMs, input.namespace, input.key, input.fingerprint, input.claimToken);
      }
      return {
        record: idempotencyRecordFromValues(
          String(row.namespace),
          String(row.idempotency_key),
          String(row.fingerprint),
          String(row.claim_token),
          "completed",
          Number(row.claimed_at_ms),
          expiresAtMs,
          input.resultRef,
        ),
      };
    });
    if (outcome.error) throw new Error(outcome.error);
    return outcome.record as EnterpriseIdempotencyRecord;
  }

  async releaseIdempotency(input: EnterpriseIdempotencyReleaseInput): Promise<boolean> {
    validateIdempotencyOwnership(input, "release");
    this.#ensureOpen();
    return this.#transaction(() => {
      const result = this.#db.prepare(`
        DELETE FROM enterprise_idempotency
        WHERE namespace = ? AND idempotency_key = ? AND fingerprint = ? AND claim_token = ?
          AND state = 'pending' AND expires_at_ms > ?
      `).run(input.namespace, input.key, input.fingerprint, input.claimToken, input.nowMs) as { changes?: number | bigint };
      return Number(result.changes ?? 0) === 1;
    });
  }

  async readIdempotency(namespace: string, key: string, nowMs: number): Promise<EnterpriseIdempotencyRecord | undefined> {
    validateNonEmpty(namespace, "Idempotency namespace");
    validateNonEmpty(key, "Idempotency key");
    assertDateTimestamp(nowMs, "Idempotency read time");
    this.#ensureOpen();
    const row = this.#db.prepare(`
      SELECT namespace, idempotency_key, fingerprint, claim_token, state, claimed_at_ms, expires_at_ms, result_ref
      FROM enterprise_idempotency WHERE namespace = ? AND idempotency_key = ?
    `).get(namespace, key) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    if (Number(row.expires_at_ms) <= nowMs) {
      this.#db.prepare(`
        DELETE FROM enterprise_idempotency
        WHERE namespace = ? AND idempotency_key = ? AND expires_at_ms <= ?
      `).run(namespace, key, nowMs);
      return undefined;
    }
    return idempotencyRecordFromRow(row);
  }

  async appendReceipt(receipt: EnterpriseActionReceipt): Promise<void> {
    const canonical = canonicalReceipt(receipt);
    if (canonical.integrityHash !== receipt.integrityHash) {
      throw new Error(`Receipt ${receipt.receiptId} failed its integrity check.`);
    }
    this.#ensureOpen();
    this.#transaction(() => {
      const existing = this.#db.prepare(`
        SELECT integrity_hash FROM enterprise_receipts WHERE receipt_id = ?
      `).get(canonical.receiptId) as Record<string, unknown> | undefined;
      if (existing) {
        if (String(existing.integrity_hash) !== canonical.integrityHash) {
          throw new Error(`Receipt ${canonical.receiptId} already exists with different content.`);
        }
      } else {
        this.#db.prepare(`
          INSERT INTO enterprise_receipts (receipt_id, occurred_at, integrity_hash, receipt_json)
          VALUES (?, ?, ?, ?)
        `).run(canonical.receiptId, canonical.occurredAt, canonical.integrityHash, JSON.stringify(canonical));
      }
      const insertSubject = this.#db.prepare("INSERT OR IGNORE INTO enterprise_receipt_subjects (receipt_id, kind, subject_id) VALUES (?, ?, ?)");
      for (const subject of normalizeEnterpriseSubjects([...canonical.actor, ...canonical.target])) {
        insertSubject.run(canonical.receiptId, subject.kind, subject.id);
      }
    });
  }

  async readReceipt(receiptId: string): Promise<EnterpriseActionReceipt | undefined> {
    validateNonEmpty(receiptId, "Receipt id");
    this.#ensureOpen();
    const row = this.#db.prepare(`
      SELECT receipt_id, integrity_hash, receipt_json FROM enterprise_receipts WHERE receipt_id = ?
    `).get(receiptId) as Record<string, unknown> | undefined;
    return row ? receiptFromRow(row) : undefined;
  }

  async listReceipts(query: EnterpriseReceiptQuery = {}): Promise<readonly EnterpriseActionReceipt[]> {
    const validated = validateReceiptQuery(query);
    this.#ensureOpen();
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (validated.from) { conditions.push("r.occurred_at >= ?"); params.push(validated.from); }
    if (validated.to) { conditions.push("r.occurred_at < ?"); params.push(validated.to); }
    for (const subject of validated.subjects) {
      conditions.push(`EXISTS (
        SELECT 1 FROM enterprise_receipt_subjects scoped
        WHERE scoped.receipt_id = r.receipt_id AND scoped.kind = ? AND scoped.subject_id = ?
      )`);
      params.push(subject.kind, subject.id);
    }
    if (validated.subjectAny.length) {
      conditions.push(`EXISTS (
        SELECT 1 FROM enterprise_receipt_subjects any_scope
        WHERE any_scope.receipt_id = r.receipt_id
          AND (any_scope.kind || ':' || any_scope.subject_id) IN (SELECT value FROM json_each(?))
      )`);
      params.push(JSON.stringify(validated.subjectAny.map(enterpriseSubjectKey)));
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = query.limit === undefined
      ? `SELECT r.receipt_id, r.integrity_hash, r.receipt_json FROM enterprise_receipts r ${where} ORDER BY r.sequence ASC`
      : `SELECT * FROM (
          SELECT r.sequence, r.receipt_id, r.integrity_hash, r.receipt_json FROM enterprise_receipts r ${where}
          ORDER BY r.sequence DESC LIMIT ?
        ) ORDER BY sequence ASC`;
    if (query.limit !== undefined) params.push(query.limit);
    const receipts = (this.#db.prepare(sql).all(...params) as Record<string, unknown>[]).map(receiptFromRow);
    for (const receipt of receipts) {
      const subjects = [...receipt.actor, ...receipt.target];
      if (validated.subjects.length && !enterpriseScopeMatches(subjects, validated.subjects)) throw new Error(`Receipt ${receipt.receiptId} failed its persisted scope index check.`);
      if (validated.subjectAny.length && !validated.subjectAny.some((subject) => subjects.some((candidate) => candidate.kind === subject.kind && candidate.id === subject.id))) {
        throw new Error(`Receipt ${receipt.receiptId} failed its persisted any-scope index check.`);
      }
    }
    return Object.freeze(receipts);
  }

  async appendUsage(event: EnterpriseUsageEvent): Promise<void> {
    const normalized = normalizeUsageEvent(event);
    const fingerprint = usageFingerprint(normalized);
    this.#ensureOpen();
    this.#transaction(() => {
      const existing = this.#db.prepare("SELECT fingerprint FROM enterprise_usage WHERE event_id = ?")
        .get(normalized.eventId) as Record<string, unknown> | undefined;
      if (existing) {
        if (String(existing.fingerprint) !== fingerprint) {
          throw new Error(`Usage event ${normalized.eventId} already exists with different content.`);
        }
        return;
      }
      this.#db.prepare(`
        INSERT INTO enterprise_usage (
          event_id, occurred_at, occurred_at_ms, subjects_json, outcome, latency_ms,
          input_tokens, output_tokens, cached_input_tokens, cost_microusd,
          cache_status, tool, request_category, fingerprint
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalized.eventId,
        normalized.occurredAt,
        Date.parse(normalized.occurredAt),
        JSON.stringify(normalized.subjects),
        normalized.outcome,
        normalized.latencyMs,
        normalized.inputTokens,
        normalized.outputTokens,
        normalized.cachedInputTokens,
        normalized.costMicrousd,
        normalized.cacheStatus,
        normalized.tool ?? null,
        normalized.requestCategory ?? null,
        fingerprint,
      );
      const insertSubject = this.#db.prepare(`
        INSERT INTO enterprise_usage_subjects (event_id, kind, subject_id) VALUES (?, ?, ?)
      `);
      for (const subject of normalized.subjects) {
        insertSubject.run(normalized.eventId, subject.kind, subject.id);
      }
    });
  }

  async queryUsage(query: EnterpriseUsageQuery = {}): Promise<readonly EnterpriseUsageEvent[]> {
    const validated = validateUsageQuery(query);
    this.#ensureOpen();
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (validated.fromMs !== undefined) {
      conditions.push("e.occurred_at_ms >= ?");
      params.push(validated.fromMs);
    }
    if (validated.toMs !== undefined) {
      conditions.push("e.occurred_at_ms < ?");
      params.push(validated.toMs);
    }
    for (const subject of validated.subjects) {
      conditions.push(`EXISTS (
        SELECT 1 FROM enterprise_usage_subjects scoped
        WHERE scoped.event_id = e.event_id AND scoped.kind = ? AND scoped.subject_id = ?
      )`);
      params.push(subject.kind, subject.id);
    }
    if (validated.subjectAny.length) {
      conditions.push(`EXISTS (
        SELECT 1 FROM enterprise_usage_subjects any_scope
        WHERE any_scope.event_id = e.event_id
          AND (any_scope.kind || ':' || any_scope.subject_id) IN (SELECT value FROM json_each(?))
      )`);
      params.push(JSON.stringify(validated.subjectAny.map(enterpriseSubjectKey)));
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const columns = `
      e.event_id, e.occurred_at, e.subjects_json, e.outcome, e.latency_ms,
      e.input_tokens, e.output_tokens, e.cached_input_tokens, e.cost_microusd,
      e.cache_status, e.tool, e.request_category, e.fingerprint, e.occurred_at_ms
    `;
    let sql: string;
    if (query.limit !== undefined) {
      sql = `
        SELECT * FROM (
          SELECT ${columns} FROM enterprise_usage e ${where}
          ORDER BY e.occurred_at_ms DESC, e.event_id DESC LIMIT ?
        ) ORDER BY occurred_at_ms ASC, event_id ASC
      `;
      params.push(query.limit);
    } else {
      sql = `SELECT ${columns} FROM enterprise_usage e ${where}
        ORDER BY e.occurred_at_ms ASC, e.event_id ASC`;
    }
    const rows = this.#db.prepare(sql).all(...params) as Record<string, unknown>[];
    const events = rows.map(usageEventFromRow);
    for (const event of events) {
      if (validated.subjects.length && !enterpriseScopeMatches(event.subjects, validated.subjects)) {
        throw new Error(`Usage event ${event.eventId} failed its persisted scope-index integrity check.`);
      }
      if (validated.subjectAny.length && !validated.subjectAny.some((subject) =>
        event.subjects.some((candidate) => candidate.kind === subject.kind && candidate.id === subject.id))) {
        throw new Error(`Usage event ${event.eventId} failed its persisted any-scope index integrity check.`);
      }
    }
    return Object.freeze(events);
  }

  close(): void {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }

  #consumeCounter(kind: CounterKind, input: EnterpriseCounterConsumeInput): EnterpriseCounterResult {
    validateCounterInput(input);
    this.#ensureOpen();
    return this.#transaction(() => this.#consumeCounterInTransaction(kind, input));
  }

  #consumeCounterInTransaction(kind: CounterKind, input: EnterpriseCounterConsumeInput): EnterpriseCounterResult {
    this.#db.prepare("DELETE FROM enterprise_counters WHERE kind = ? AND window_end_ms <= ?")
      .run(kind, input.windowStartMs);
    const row = this.#db.prepare(`
      SELECT window_end_ms, value FROM enterprise_counters
      WHERE kind = ? AND counter_key = ? AND window_start_ms = ?
    `).get(kind, input.key, input.windowStartMs) as Record<string, unknown> | undefined;
    const usedBefore = row && Number(row.window_end_ms) === input.windowEndMs ? Number(row.value) : 0;
    const projected = usedBefore + input.amount;
    if (!Number.isFinite(projected) || projected < 0) throw new Error("Counter value exceeds the supported numeric range.");
    const accepted = projected <= input.limit;
    const usedAfter = accepted || input.commitOnExceed ? projected : usedBefore;
    if (usedAfter > 0) {
      this.#db.prepare(`
        INSERT INTO enterprise_counters (kind, counter_key, window_start_ms, window_end_ms, value)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(kind, counter_key, window_start_ms) DO UPDATE SET
          window_end_ms = excluded.window_end_ms,
          value = excluded.value
      `).run(kind, input.key, input.windowStartMs, input.windowEndMs, usedAfter);
    } else if (row) {
      this.#db.prepare(`
        DELETE FROM enterprise_counters WHERE kind = ? AND counter_key = ? AND window_start_ms = ?
      `).run(kind, input.key, input.windowStartMs);
    }
    return deepFreeze({
      accepted,
      usedBefore,
      usedAfter,
      remaining: Math.max(0, input.limit - usedAfter),
      limit: input.limit,
      resetAt: new Date(input.windowEndMs).toISOString(),
    });
  }

  #readCounter(kind: CounterKind, input: EnterpriseCounterReadInput): number {
    validateNonEmpty(input.key, "Counter key");
    assertDateTimestamp(input.windowStartMs, "Counter window start");
    assertDateTimestamp(input.nowMs, "Counter read time");
    this.#ensureOpen();
    const row = this.#db.prepare(`
      SELECT window_end_ms, value FROM enterprise_counters
      WHERE kind = ? AND counter_key = ? AND window_start_ms = ?
    `).get(kind, input.key, input.windowStartMs) as Record<string, unknown> | undefined;
    if (!row) return 0;
    if (Number(row.window_end_ms) <= input.nowMs) {
      this.#db.prepare(`
        DELETE FROM enterprise_counters
        WHERE kind = ? AND counter_key = ? AND window_start_ms = ? AND window_end_ms <= ?
      `).run(kind, input.key, input.windowStartMs, input.nowMs);
      return 0;
    }
    return Number(row.value);
  }

  #transaction<T>(work: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE;");
    let active = true;
    try {
      const result = work();
      this.#db.exec("COMMIT;");
      active = false;
      return result;
    } catch (error) {
      if (active) {
        try {
          this.#db.exec("ROLLBACK;");
        } catch {
          // Preserve the original failure; the connection will surface later corruption.
        }
      }
      throw error;
    }
  }

  #ensureOpen(): void {
    if (this.#closed) throw new Error("Enterprise SQLite store is closed.");
  }
}

function validateCounterInput(input: EnterpriseCounterConsumeInput): void {
  validateNonEmpty(input.key, "Counter key");
  assertDateTimestamp(input.windowStartMs, "Counter window start");
  assertDateTimestamp(input.windowEndMs, "Counter window end");
  if (input.windowEndMs <= input.windowStartMs) throw new Error("Counter window end must follow its start.");
  validateFiniteNonNegative(input.amount, "Counter amount");
  validateFiniteNonNegative(input.limit, "Counter limit");
  if (input.limit === 0) throw new Error("Counter limit must be positive.");
}

function validateIdempotencyClaim(input: EnterpriseIdempotencyClaimInput): void {
  validateNonEmpty(input.namespace, "Idempotency namespace");
  validateNonEmpty(input.key, "Idempotency key");
  validateNonEmpty(input.fingerprint, "Idempotency fingerprint");
  assertDateTimestamp(input.nowMs, "Idempotency claim time");
  if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) throw new Error("Idempotency ttlMs must be positive.");
}

function validateIdempotencyOwnership(
  input: EnterpriseIdempotencyCompleteInput | EnterpriseIdempotencyReleaseInput | EnterpriseIdempotencyRenewInput,
  operation: string,
): void {
  validateNonEmpty(input.namespace, "Idempotency namespace");
  validateNonEmpty(input.key, "Idempotency key");
  validateNonEmpty(input.fingerprint, "Idempotency fingerprint");
  validateNonEmpty(input.claimToken, "Idempotency claimToken");
  assertDateTimestamp(input.nowMs, `Idempotency ${operation} time`);
}

function idempotencyOwnershipError(
  row: Record<string, unknown>,
  input: EnterpriseIdempotencyCompleteInput | EnterpriseIdempotencyReleaseInput | EnterpriseIdempotencyRenewInput,
): string | undefined {
  if (String(row.fingerprint) !== input.fingerprint) return "Idempotency fingerprint conflict.";
  if (String(row.claim_token) !== input.claimToken) return "Idempotency claim generation conflict.";
  return undefined;
}

function idempotencyRecordFromRow(row: Record<string, unknown>): EnterpriseIdempotencyRecord {
  return idempotencyRecordFromValues(
    String(row.namespace),
    String(row.idempotency_key),
    String(row.fingerprint),
    String(row.claim_token),
    String(row.state) as EnterpriseIdempotencyRecord["state"],
    Number(row.claimed_at_ms),
    Number(row.expires_at_ms),
    row.result_ref === null || row.result_ref === undefined ? undefined : String(row.result_ref),
  );
}

function idempotencyRecordFromValues(
  namespace: string,
  key: string,
  fingerprint: string,
  claimToken: string,
  state: EnterpriseIdempotencyRecord["state"],
  claimedAtMs: number,
  expiresAtMs: number,
  resultRef?: string,
): EnterpriseIdempotencyRecord {
  return deepFreeze({
    namespace,
    key,
    fingerprint,
    claimToken,
    state,
    claimedAt: new Date(claimedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    ...(resultRef ? { resultRef } : {}),
  });
}

function canonicalReceipt(receipt: EnterpriseActionReceipt): EnterpriseActionReceipt {
  return createEnterpriseActionReceipt({
    receiptId: receipt.receiptId,
    occurredAt: receipt.occurredAt,
    actor: receipt.actor,
    target: receipt.target,
    action: receipt.action,
    outcome: receipt.outcome,
    policyIds: receipt.policyIds,
    requestFingerprint: receipt.requestFingerprint,
    metadata: receipt.metadata,
    previousReceiptHash: receipt.previousReceiptHash,
  });
}

function receiptFromRow(row: Record<string, unknown>): EnterpriseActionReceipt {
  let parsed: EnterpriseActionReceipt;
  try {
    parsed = JSON.parse(String(row.receipt_json)) as EnterpriseActionReceipt;
  } catch {
    throw new Error(`Receipt ${String(row.receipt_id)} contains invalid persisted JSON.`);
  }
  const canonical = createEnterpriseActionReceipt({
    receiptId: parsed.receiptId,
    occurredAt: parsed.occurredAt,
    actor: parsed.actor,
    target: parsed.target,
    action: parsed.action,
    outcome: parsed.outcome,
    policyIds: parsed.policyIds,
    requestFingerprint: parsed.requestFingerprint,
    metadata: parsed.metadata as Readonly<Record<string, EnterpriseReceiptMetadataValue>>,
    previousReceiptHash: parsed.previousReceiptHash,
  });
  if (
    canonical.receiptId !== String(row.receipt_id)
    || canonical.integrityHash !== String(row.integrity_hash)
    || canonical.integrityHash !== parsed.integrityHash
  ) {
    throw new Error(`Receipt ${String(row.receipt_id)} failed its persisted integrity check.`);
  }
  return canonical;
}

function normalizeUsageEvent(event: EnterpriseUsageEvent): EnterpriseUsageEvent {
  const eventId = event.eventId.trim();
  if (!eventId) throw new Error("Usage event id must be non-empty.");
  const occurredAtMs = Date.parse(event.occurredAt);
  if (!Number.isFinite(occurredAtMs)) throw new Error(`Usage event ${event.eventId} has an invalid occurredAt.`);
  if (!USAGE_OUTCOMES.has(event.outcome)) throw new Error(`Usage event ${event.eventId} has an invalid outcome.`);
  if (!CACHE_STATUSES.has(event.cacheStatus)) throw new Error(`Usage event ${event.eventId} has an invalid cacheStatus.`);
  validateFiniteNonNegative(event.latencyMs, "latencyMs");
  validateCount(event.inputTokens, "inputTokens");
  validateCount(event.outputTokens, "outputTokens");
  validateCount(event.cachedInputTokens, "cachedInputTokens");
  validateCount(event.costMicrousd, "costMicrousd");
  if (event.cachedInputTokens > event.inputTokens) throw new Error("cachedInputTokens cannot exceed inputTokens.");
  if (!event.subjects.length) throw new Error(`Usage event ${event.eventId} requires subjects.`);
  const tool = event.tool?.trim();
  const requestCategory = event.requestCategory?.trim();
  return deepFreeze({
    eventId,
    occurredAt: new Date(occurredAtMs).toISOString(),
    subjects: normalizeEnterpriseSubjects(event.subjects),
    outcome: event.outcome,
    latencyMs: event.latencyMs,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cachedInputTokens: event.cachedInputTokens,
    costMicrousd: event.costMicrousd,
    cacheStatus: event.cacheStatus,
    ...(tool ? { tool } : {}),
    ...(requestCategory ? { requestCategory } : {}),
  });
}

function usageFingerprint(event: EnterpriseUsageEvent): string {
  return createHash("sha256").update(JSON.stringify({
    ...event,
    subjects: [...event.subjects].map(enterpriseSubjectKey).sort(),
  })).digest("hex");
}

function usageEventFromRow(row: Record<string, unknown>): EnterpriseUsageEvent {
  let subjects: readonly EnterpriseSubject[];
  try {
    subjects = JSON.parse(String(row.subjects_json)) as EnterpriseSubject[];
  } catch {
    throw new Error(`Usage event ${String(row.event_id)} contains invalid persisted subjects.`);
  }
  const normalized = normalizeUsageEvent({
    eventId: String(row.event_id),
    occurredAt: String(row.occurred_at),
    subjects,
    outcome: String(row.outcome) as EnterpriseUsageOutcome,
    latencyMs: Number(row.latency_ms),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    cachedInputTokens: Number(row.cached_input_tokens),
    costMicrousd: Number(row.cost_microusd),
    cacheStatus: String(row.cache_status) as EnterpriseCacheStatus,
    ...(row.tool === null || row.tool === undefined ? {} : { tool: String(row.tool) }),
    ...(row.request_category === null || row.request_category === undefined
      ? {}
      : { requestCategory: String(row.request_category) }),
  });
  if (usageFingerprint(normalized) !== String(row.fingerprint)) {
    throw new Error(`Usage event ${normalized.eventId} failed its persisted integrity check.`);
  }
  return normalized;
}

function validateUsageQuery(query: EnterpriseUsageQuery): {
  readonly fromMs?: number;
  readonly toMs?: number;
  readonly subjects: readonly EnterpriseSubject[];
  readonly subjectAny: readonly EnterpriseSubject[];
} {
  const fromMs = parseOptionalTimestamp(query.from, "Usage query from");
  const toMs = parseOptionalTimestamp(query.to, "Usage query to");
  if (fromMs !== undefined && toMs !== undefined && fromMs >= toMs) {
    throw new Error("Usage query to must be after from.");
  }
  if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit <= 0)) {
    throw new Error("Usage query limit must be a positive safe integer.");
  }
  return {
    ...(fromMs === undefined ? {} : { fromMs }),
    ...(toMs === undefined ? {} : { toMs }),
    subjects: query.subjects ? normalizeEnterpriseSubjects(query.subjects) : Object.freeze([]),
    subjectAny: query.subjectAny ? normalizeEnterpriseSubjects(query.subjectAny) : Object.freeze([]),
  };
}

function validateReceiptQuery(query: EnterpriseReceiptQuery): {
  readonly from?: string;
  readonly to?: string;
  readonly subjects: readonly EnterpriseSubject[];
  readonly subjectAny: readonly EnterpriseSubject[];
} {
  const fromMs = parseOptionalTimestamp(query.from, "Receipt query from");
  const toMs = parseOptionalTimestamp(query.to, "Receipt query to");
  if (fromMs !== undefined && toMs !== undefined && fromMs >= toMs) throw new Error("Receipt query to must be after from.");
  if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit <= 0)) throw new Error("Receipt query limit must be positive.");
  return {
    ...(query.from === undefined ? {} : { from: new Date(fromMs as number).toISOString() }),
    ...(query.to === undefined ? {} : { to: new Date(toMs as number).toISOString() }),
    subjects: query.subjects ? normalizeEnterpriseSubjects(query.subjects) : Object.freeze([]),
    subjectAny: query.subjectAny ? normalizeEnterpriseSubjects(query.subjectAny) : Object.freeze([]),
  };
}

function parseOptionalTimestamp(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be an ISO timestamp.`);
  return parsed;
}

function validateNonEmpty(value: string | undefined, label: string): asserts value is string {
  if (!value?.trim()) throw new Error(`${label} must be non-empty.`);
}

function assertDateTimestamp(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative finite timestamp.`);
  new Date(value).toISOString();
}

function validateFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be finite and non-negative.`);
}

function validateCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer.`);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return value;
}
