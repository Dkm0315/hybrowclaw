import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { PairingChallenge, SurfaceReply } from "./envelope.js";

export type AsyncMessageRunStatus = "queued" | "running" | "completed" | "failed";

export interface StoredAsyncMessageRun {
  readonly runId: string;
  readonly status: AsyncMessageRunStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
  readonly reply?: SurfaceReply | PairingChallenge;
  readonly partialText?: string;
  readonly reasoningText?: string;
  readonly error?: string;
  readonly fingerprint: string;
  readonly idempotencyScope?: string;
  /** Opaque authenticated caller lane. Required for tenant-safe delegated polling. */
  readonly authorityScope?: string;
  readonly artifactRoots: readonly string[];
}

export interface AsyncMessageRunClaimInput {
  readonly fingerprint: string;
  readonly idempotencyScope?: string;
  readonly authorityScope?: string;
  readonly artifactRoots: readonly string[];
  readonly nowMs?: number;
  readonly leaseMs: number;
}

export interface AsyncMessageRunClaimResult {
  readonly status: "claimed" | "replay" | "conflict";
  readonly record: StoredAsyncMessageRun;
  /** Present only for the worker that created the durable run. */
  readonly ownerToken?: string;
}

export interface AsyncMessageRunStore {
  claim(input: AsyncMessageRunClaimInput): Promise<AsyncMessageRunClaimResult>;
  read(runId: string, nowMs?: number): Promise<StoredAsyncMessageRun | undefined>;
  markRunning(runId: string, ownerToken: string, nowMs: number, leaseMs: number): Promise<boolean>;
  renew(runId: string, ownerToken: string, nowMs: number, leaseMs: number): Promise<boolean>;
  appendPreview(
    runId: string,
    ownerToken: string,
    field: "partialText" | "reasoningText",
    text: string,
    maxChars: number,
    nowMs?: number,
  ): Promise<boolean>;
  complete(runId: string, ownerToken: string, reply: SurfaceReply | PairingChallenge, nowMs?: number): Promise<boolean>;
  fail(runId: string, ownerToken: string, error: string, nowMs?: number): Promise<boolean>;
  /** Roots still referenced by active or retained terminal runs, after expiry reaping. */
  listArtifactRoots(nowMs?: number): Promise<readonly string[]>;
  close?(): void | Promise<void>;
}

interface SqliteStatement {
  run(...params: unknown[]): { changes?: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface RunRow {
  run_id: unknown;
  idempotency_scope: unknown;
  fingerprint: unknown;
  status: unknown;
  created_at_ms: unknown;
  updated_at_ms: unknown;
  version: unknown;
  reply_json: unknown;
  partial_text: unknown;
  reasoning_text: unknown;
  error: unknown;
  artifact_roots_json: unknown;
  authority_scope: unknown;
}

const DEFAULT_TERMINAL_TTL_MS = 60 * 60_000;
const DEFAULT_LIMIT = 1_000;
const INTERRUPTED_ERROR = "Provider outcome is unknown after the gateway worker lease expired; automatic replay was blocked.";

/**
 * Durable async-message state for the local gateway host.
 *
 * SQLite `BEGIN IMMEDIATE` makes idempotency claims atomic across gateway
 * processes that share this data directory. Multi-host deployments can inject
 * an AsyncMessageRunStore backed by their shared control-plane database.
 */
export class SqliteAsyncMessageRunStore implements AsyncMessageRunStore {
  readonly #db: SqliteDatabase;
  readonly #terminalTtlMs: number;
  readonly #limit: number;
  #closed = false;

  constructor(
    filename: string,
    options: { readonly terminalTtlMs?: number; readonly limit?: number; readonly busyTimeoutMs?: number } = {},
  ) {
    if (!filename.trim()) throw new Error("Async message store filename must be non-empty.");
    this.#terminalTtlMs = boundedInteger(options.terminalTtlMs ?? DEFAULT_TERMINAL_TTL_MS, 60_000, 30 * 24 * 60 * 60_000, "terminalTtlMs");
    this.#limit = boundedInteger(options.limit ?? DEFAULT_LIMIT, 10, 100_000, "limit");
    const busyTimeoutMs = boundedInteger(options.busyTimeoutMs ?? 5_000, 0, 60_000, "busyTimeoutMs");
    if (filename !== ":memory:" && !filename.startsWith("file:")) {
      mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    }
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (path: string) => SqliteDatabase;
    };
    this.#db = new DatabaseSync(filename);
    if (filename !== ":memory:" && !filename.startsWith("file:")) chmodSync(filename, 0o600);
    this.#db.exec(`
      PRAGMA busy_timeout = ${busyTimeoutMs};
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;

      CREATE TABLE IF NOT EXISTS gateway_message_runs (
        run_id TEXT PRIMARY KEY,
        idempotency_scope TEXT UNIQUE,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        reply_json TEXT,
        partial_text TEXT,
        reasoning_text TEXT,
        error TEXT,
        artifact_roots_json TEXT NOT NULL,
        authority_scope TEXT,
        owner_token TEXT,
        lease_expires_at_ms INTEGER
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_gateway_message_runs_status
        ON gateway_message_runs(status, updated_at_ms);
      CREATE INDEX IF NOT EXISTS idx_gateway_message_runs_lease
        ON gateway_message_runs(status, lease_expires_at_ms);
    `);
    // Upgrade durable stores created before delegated Frappe polling existed.
    const authorityColumn = this.#db.prepare(
      "SELECT name FROM pragma_table_info('gateway_message_runs') WHERE name = 'authority_scope'",
    ).get();
    if (!authorityColumn) this.#db.exec("ALTER TABLE gateway_message_runs ADD COLUMN authority_scope TEXT");
  }

  async claim(input: AsyncMessageRunClaimInput): Promise<AsyncMessageRunClaimResult> {
    validateClaim(input);
    const nowMs = input.nowMs ?? Date.now();
    return this.#transaction(() => {
      this.#reap(nowMs);
      if (input.idempotencyScope) {
        const existing = this.#selectByScope(input.idempotencyScope);
        if (existing) {
          return Object.freeze({
            status: existing.fingerprint === input.fingerprint
              && existing.authorityScope === input.authorityScope
              ? "replay" as const
              : "conflict" as const,
            record: existing,
          });
        }
      }
      this.#enforceLimit();
      const runId = `msg_${randomUUID()}`;
      const ownerToken = randomUUID();
      this.#db.prepare(`
        INSERT INTO gateway_message_runs
          (run_id, idempotency_scope, fingerprint, status, created_at_ms, updated_at_ms, version,
           artifact_roots_json, authority_scope, owner_token, lease_expires_at_ms)
        VALUES (?, ?, ?, 'queued', ?, ?, 1, ?, ?, ?, ?)
      `).run(
        runId,
        input.idempotencyScope ?? null,
        input.fingerprint,
        nowMs,
        nowMs,
        JSON.stringify(input.artifactRoots),
        input.authorityScope ?? null,
        ownerToken,
        nowMs + input.leaseMs,
      );
      return Object.freeze({
        status: "claimed" as const,
        record: this.#select(runId) as StoredAsyncMessageRun,
        ownerToken,
      });
    });
  }

  async read(runId: string, nowMs = Date.now()): Promise<StoredAsyncMessageRun | undefined> {
    validateRunId(runId);
    return this.#transaction(() => {
      this.#reap(nowMs);
      return this.#select(runId);
    });
  }

  async markRunning(runId: string, ownerToken: string, nowMs: number, leaseMs: number): Promise<boolean> {
    validateOwnership(runId, ownerToken, nowMs, leaseMs);
    return this.#transaction(() => {
      this.#reap(nowMs);
      return changed(this.#db.prepare(`
        UPDATE gateway_message_runs
        SET status = 'running', updated_at_ms = ?, version = version + 1, lease_expires_at_ms = ?
        WHERE run_id = ? AND owner_token = ? AND status = 'queued' AND lease_expires_at_ms > ?
      `).run(nowMs, nowMs + leaseMs, runId, ownerToken, nowMs));
    });
  }

  async renew(runId: string, ownerToken: string, nowMs: number, leaseMs: number): Promise<boolean> {
    validateOwnership(runId, ownerToken, nowMs, leaseMs);
    return this.#transaction(() => changed(this.#db.prepare(`
      UPDATE gateway_message_runs
      SET lease_expires_at_ms = MAX(lease_expires_at_ms, ?)
      WHERE run_id = ? AND owner_token = ? AND status IN ('queued', 'running') AND lease_expires_at_ms > ?
    `).run(nowMs + leaseMs, runId, ownerToken, nowMs)));
  }

  async appendPreview(
    runId: string,
    ownerToken: string,
    field: "partialText" | "reasoningText",
    text: string,
    maxChars: number,
    nowMs = Date.now(),
  ): Promise<boolean> {
    validateRunId(runId);
    if (!ownerToken) throw new Error("Async message run owner token is required.");
    if (!text) return true;
    const column = field === "partialText" ? "partial_text" : "reasoning_text";
    const bounded = boundedInteger(maxChars, 1, 1_000_000, "maxChars");
    return this.#transaction(() => changed(this.#db.prepare(`
      UPDATE gateway_message_runs
      SET ${column} = substr(COALESCE(${column}, '') || ?, 1, ?),
          updated_at_ms = ?, version = version + 1
      WHERE run_id = ? AND owner_token = ? AND status = 'running'
    `).run(text, bounded, nowMs, runId, ownerToken)));
  }

  async complete(
    runId: string,
    ownerToken: string,
    reply: SurfaceReply | PairingChallenge,
    nowMs = Date.now(),
  ): Promise<boolean> {
    validateRunId(runId);
    if (!ownerToken) throw new Error("Async message run owner token is required.");
    return this.#transaction(() => changed(this.#db.prepare(`
      UPDATE gateway_message_runs
      SET status = 'completed', reply_json = ?, error = NULL, updated_at_ms = ?,
          version = version + 1, owner_token = NULL, lease_expires_at_ms = NULL
      WHERE run_id = ? AND owner_token = ? AND status = 'running'
    `).run(JSON.stringify(reply), nowMs, runId, ownerToken)));
  }

  async fail(runId: string, ownerToken: string, error: string, nowMs = Date.now()): Promise<boolean> {
    validateRunId(runId);
    if (!ownerToken) throw new Error("Async message run owner token is required.");
    return this.#transaction(() => changed(this.#db.prepare(`
      UPDATE gateway_message_runs
      SET status = 'failed', error = ?, updated_at_ms = ?, version = version + 1,
          owner_token = NULL, lease_expires_at_ms = NULL
      WHERE run_id = ? AND owner_token = ? AND status IN ('queued', 'running')
    `).run(error.slice(0, 4_000), nowMs, runId, ownerToken)));
  }

  async listArtifactRoots(nowMs = Date.now()): Promise<readonly string[]> {
    return this.#transaction(() => {
      this.#reap(nowMs);
      const rows = this.#db.prepare("SELECT artifact_roots_json FROM gateway_message_runs").all() as Array<{ artifact_roots_json?: unknown }>;
      return Object.freeze([...rows.flatMap((row) => parseStringArray(row.artifact_roots_json, "artifact roots"))]);
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #select(runId: string): StoredAsyncMessageRun | undefined {
    const row = this.#db.prepare(`
      SELECT run_id, idempotency_scope, fingerprint, status, created_at_ms, updated_at_ms, version,
             reply_json, partial_text, reasoning_text, error, artifact_roots_json, authority_scope
      FROM gateway_message_runs WHERE run_id = ?
    `).get(runId) as RunRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  #selectByScope(scope: string): StoredAsyncMessageRun | undefined {
    const row = this.#db.prepare(`
      SELECT run_id, idempotency_scope, fingerprint, status, created_at_ms, updated_at_ms, version,
             reply_json, partial_text, reasoning_text, error, artifact_roots_json, authority_scope
      FROM gateway_message_runs WHERE idempotency_scope = ?
    `).get(scope) as RunRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  #reap(nowMs: number): void {
    this.#db.prepare(`
      UPDATE gateway_message_runs
      SET status = 'failed', error = ?, updated_at_ms = ?, version = version + 1,
          owner_token = NULL, lease_expires_at_ms = NULL
      WHERE status IN ('queued', 'running') AND lease_expires_at_ms <= ?
    `).run(INTERRUPTED_ERROR, nowMs, nowMs);
    this.#db.prepare(`
      DELETE FROM gateway_message_runs
      WHERE status IN ('completed', 'failed') AND updated_at_ms <= ?
    `).run(nowMs - this.#terminalTtlMs);
  }

  #enforceLimit(): void {
    const count = Number((this.#db.prepare("SELECT COUNT(*) AS count FROM gateway_message_runs").get() as { count?: unknown } | undefined)?.count ?? 0);
    if (count < this.#limit) return;
    const removable = count - this.#limit + 1;
    this.#db.prepare(`
      DELETE FROM gateway_message_runs WHERE run_id IN (
        SELECT run_id FROM gateway_message_runs
        WHERE status IN ('completed', 'failed') ORDER BY updated_at_ms ASC LIMIT ?
      )
    `).run(removable);
    const remaining = Number((this.#db.prepare("SELECT COUNT(*) AS count FROM gateway_message_runs").get() as { count?: unknown } | undefined)?.count ?? 0);
    if (remaining >= this.#limit) throw new Error("Async message run capacity is full; wait for active runs to finish.");
  }

  #transaction<T>(operation: () => T): T {
    if (this.#closed) throw new Error("Async message store is closed.");
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
}

function rowToRecord(row: RunRow): StoredAsyncMessageRun {
  const status = String(row.status) as AsyncMessageRunStatus;
  if (!(["queued", "running", "completed", "failed"] as string[]).includes(status)) throw new Error("Stored async message status is invalid.");
  const artifactRoots = parseStringArray(row.artifact_roots_json, "artifact roots");
  const reply = row.reply_json === null || row.reply_json === undefined
    ? undefined
    : JSON.parse(String(row.reply_json)) as SurfaceReply | PairingChallenge;
  return Object.freeze({
    runId: String(row.run_id),
    status,
    createdAt: new Date(Number(row.created_at_ms)).toISOString(),
    updatedAt: new Date(Number(row.updated_at_ms)).toISOString(),
    version: Number(row.version),
    ...(reply ? { reply } : {}),
    ...(row.partial_text ? { partialText: String(row.partial_text) } : {}),
    ...(row.reasoning_text ? { reasoningText: String(row.reasoning_text) } : {}),
    ...(row.error ? { error: String(row.error) } : {}),
    fingerprint: String(row.fingerprint),
    ...(row.idempotency_scope ? { idempotencyScope: String(row.idempotency_scope) } : {}),
    ...(row.authority_scope ? { authorityScope: String(row.authority_scope) } : {}),
    artifactRoots,
  });
}

function parseStringArray(value: unknown, label: string): readonly string[] {
  const parsed = JSON.parse(String(value));
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new Error(`Stored async message ${label} are invalid.`);
  return Object.freeze([...parsed]);
}

function validateClaim(input: AsyncMessageRunClaimInput): void {
  if (!input.fingerprint || input.fingerprint.length > 256) throw new Error("Async message fingerprint is invalid.");
  if (input.idempotencyScope !== undefined && (!input.idempotencyScope || input.idempotencyScope.length > 256)) {
    throw new Error("Async message idempotency scope is invalid.");
  }
  if (input.authorityScope !== undefined && (!input.authorityScope || input.authorityScope.length > 256)) {
    throw new Error("Async message authority scope is invalid.");
  }
  if (!Array.isArray(input.artifactRoots) || input.artifactRoots.some((root) => typeof root !== "string" || !root)) {
    throw new Error("Async message artifact roots are invalid.");
  }
  boundedInteger(input.leaseMs, 1_000, 15 * 60_000, "leaseMs");
  if (input.nowMs !== undefined && (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0)) throw new Error("Async message claim time is invalid.");
}

function validateOwnership(runId: string, ownerToken: string, nowMs: number, leaseMs: number): void {
  validateRunId(runId);
  if (!ownerToken) throw new Error("Async message run owner token is required.");
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Async message ownership time is invalid.");
  boundedInteger(leaseMs, 1_000, 15 * 60_000, "leaseMs");
}

function validateRunId(runId: string): void {
  if (!/^msg_[A-Za-z0-9-]+$/.test(runId)) throw new Error("Async message run id is invalid.");
}

function changed(result: { changes?: number | bigint }): boolean {
  return Number(result.changes ?? 0) === 1;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}
