import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

/** Structural mirror of core's RunEvent transport contract (kept name-distinct for barrel exports). */
export interface FrappeRunEvent {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly missionId: string;
  readonly rootRunId: string;
  readonly nodeId?: string;
  readonly attemptId?: string;
  readonly tenantId: string;
  readonly siteId?: string;
  readonly sequence: number;
  readonly type:
    | "mission_started" | "node_started" | "lease_claimed" | "lease_heartbeat"
    | "effect_started" | "effect_committed" | "node_completed" | "node_failed"
    | "pause_requested" | "paused" | "resumed" | "steered"
    | "cancellation_requested" | "cancelling" | "cancelled"
    | "compensation_started" | "compensation_completed" | "compensation_failed"
    | "mission_failed" | "mission_completed";
  readonly at: string;
  readonly actorId: string;
  readonly agentId?: string;
  readonly fencingToken?: number;
  readonly idempotencyKey?: string;
  readonly receiptHash?: string;
  readonly summary: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly evidenceIds?: readonly string[];
}

export interface FrappeRunEventScope {
  readonly tenantId: string;
  readonly siteId?: string;
  readonly userId: string;
}

export interface FrappeRunEventAppendInput {
  readonly scope: FrappeRunEventScope;
  readonly event: FrappeRunEvent;
  readonly nowMs?: number;
}

export interface FrappeRunEventAppendResult {
  readonly status: "appended" | "deduplicated";
  readonly event: FrappeRunEvent;
  readonly cursor?: string;
  readonly retentionPruned: number;
}

export interface FrappeRunEventReplayInput {
  readonly scope: FrappeRunEventScope;
  readonly missionId?: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly nowMs?: number;
  readonly canRead?: FrappeRunEventPermissionFilter;
}

export interface FrappeRunEventReplayPage {
  readonly events: readonly FrappeRunEvent[];
  readonly nextCursor?: string;
  readonly hasMore: boolean;
  /** True when the permission-filter scan ceiling was reached before filling the page. */
  readonly scanLimited: boolean;
}

export type FrappeRunEventPermissionFilter = (
  event: FrappeRunEvent,
  scope: FrappeRunEventScope,
) => boolean | Promise<boolean>;

export type FrappeRunCommandAction = "pause" | "resume" | "cancel" | "steer";

export interface FrappeRunCommandRequest {
  readonly schemaVersion: 1;
  readonly commandId: string;
  readonly action: FrappeRunCommandAction;
  readonly missionId: string;
  readonly rootRunId: string;
  readonly tenantId: string;
  readonly siteId?: string;
  readonly userId: string;
  readonly issuedAt: string;
  readonly idempotencyKey: string;
  readonly csrfToken: string;
  readonly expectedCursor?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

/** A command safe to persist or dispatch. The CSRF credential is deliberately absent. */
export interface AcceptedFrappeRunCommand extends Omit<FrappeRunCommandRequest, "csrfToken" | "payload"> {
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly fingerprint: string;
}

export interface FrappeRunCommandPreconditions {
  readonly method: string;
  readonly authenticatedScope: FrappeRunEventScope;
  readonly expectedCsrfToken: string;
  readonly nowMs?: number;
  readonly maxClockSkewMs?: number;
  readonly maxPayloadBytes?: number;
}

export interface FrappeRunCommandClaimResult {
  readonly status: "claimed" | "replay" | "conflict";
  readonly command: AcceptedFrappeRunCommand;
}

export interface FrappeRunEventStore {
  append(input: FrappeRunEventAppendInput): Promise<FrappeRunEventAppendResult>;
  replay(input: FrappeRunEventReplayInput): Promise<FrappeRunEventReplayPage>;
  claimCommand(request: FrappeRunCommandRequest, preconditions: FrappeRunCommandPreconditions): Promise<FrappeRunCommandClaimResult>;
  close?(): void | Promise<void>;
}

export type FrappeRunEventErrorCode =
  | "invalid_request"
  | "forbidden"
  | "conflict"
  | "cursor_expired"
  | "permission_filter_failed";

export class FrappeRunEventError extends Error {
  constructor(readonly code: FrappeRunEventErrorCode, message: string) {
    super(message);
    this.name = "FrappeRunEventError";
  }
}

interface SqliteStatement {
  run(...params: unknown[]): { changes?: number | bigint; lastInsertRowid?: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface EventRow {
  ordinal: unknown;
  event_json: unknown;
}

interface DedupeRow {
  scope_key: unknown;
  fingerprint: unknown;
}

interface CommandRow {
  fingerprint: unknown;
  command_json: unknown;
}

interface CursorBody {
  readonly v: 1;
  readonly after: number;
  readonly scope: string;
}

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_DEDUPE_RETENTION_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_MAX_EVENTS = 100_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;
const DEFAULT_MAX_PAGE_SIZE = 100;
const DEFAULT_MAX_SCAN_EVENTS = 1_000;
const SECRET_KEY = /(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|private[_-]?key|chain[_-]?of[_-]?thought|reasoning)/i;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const SECRET_ASSIGNMENT = /\b(password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)\s*[:=]\s*([^\s,;]+)/gi;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@\/-]{0,255}$/;
const EVENT_TYPES = new Set<FrappeRunEvent["type"]>([
  "mission_started", "node_started", "lease_claimed", "lease_heartbeat",
  "effect_started", "effect_committed", "node_completed", "node_failed",
  "pause_requested", "paused", "resumed", "steered",
  "cancellation_requested", "cancelling", "cancelled", "compensation_started",
  "compensation_completed", "compensation_failed", "mission_failed", "mission_completed",
]);

export const FRAPPE_RUN_EVENTS_PATH = "/v1/integrations/frappe/run-events";

/**
 * Durable, local-host event transport for Frappe projections.
 *
 * SQLite transactions serialize writers sharing a database. Clustered gateways
 * can implement the same append/replay contract on their control-plane store.
 */
export class SqliteFrappeRunEventStore implements FrappeRunEventStore {
  readonly #db: SqliteDatabase;
  readonly #retentionMs: number;
  readonly #dedupeRetentionMs: number;
  readonly #maxEvents: number;
  readonly #maxPayloadBytes: number;
  readonly #maxPageSize: number;
  readonly #maxScanEvents: number;
  #closed = false;

  constructor(
    filename: string,
    options: {
      readonly retentionMs?: number;
      readonly dedupeRetentionMs?: number;
      readonly maxEvents?: number;
      readonly maxPayloadBytes?: number;
      readonly maxPageSize?: number;
      readonly maxScanEvents?: number;
      readonly busyTimeoutMs?: number;
    } = {},
  ) {
    if (!filename.trim()) invalid("Run event store filename must be non-empty.");
    this.#retentionMs = boundedInteger(options.retentionMs ?? DEFAULT_RETENTION_MS, 1_000, 365 * 24 * 60 * 60_000, "retentionMs");
    this.#dedupeRetentionMs = boundedInteger(options.dedupeRetentionMs ?? DEFAULT_DEDUPE_RETENTION_MS, this.#retentionMs, 2 * 365 * 24 * 60 * 60_000, "dedupeRetentionMs");
    this.#maxEvents = boundedInteger(options.maxEvents ?? DEFAULT_MAX_EVENTS, 10, 10_000_000, "maxEvents");
    this.#maxPayloadBytes = boundedInteger(options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES, 256, 1024 * 1024, "maxPayloadBytes");
    this.#maxPageSize = boundedInteger(options.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE, 1, 1_000, "maxPageSize");
    this.#maxScanEvents = boundedInteger(options.maxScanEvents ?? DEFAULT_MAX_SCAN_EVENTS, this.#maxPageSize, 100_000, "maxScanEvents");
    const busyTimeoutMs = boundedInteger(options.busyTimeoutMs ?? 5_000, 0, 60_000, "busyTimeoutMs");
    if (filename !== ":memory:" && !filename.startsWith("file:")) mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string) => SqliteDatabase };
    this.#db = new DatabaseSync(filename);
    if (filename !== ":memory:" && !filename.startsWith("file:")) chmodSync(filename, 0o600);
    this.#db.exec(`
      PRAGMA busy_timeout = ${busyTimeoutMs};
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;

      CREATE TABLE IF NOT EXISTS frappe_run_events (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        site_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        mission_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        event_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        UNIQUE(scope_key, event_id),
        UNIQUE(scope_key, mission_id, sequence)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_frappe_run_events_replay
        ON frappe_run_events(scope_key, mission_id, ordinal);
      CREATE INDEX IF NOT EXISTS idx_frappe_run_events_retention
        ON frappe_run_events(created_at_ms, ordinal);

      CREATE TABLE IF NOT EXISTS frappe_run_event_dedupe (
        scope_key TEXT NOT NULL,
        event_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        PRIMARY KEY(scope_key, event_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_frappe_run_event_dedupe_expiry
        ON frappe_run_event_dedupe(expires_at_ms);

      CREATE TABLE IF NOT EXISTS frappe_run_commands (
        idempotency_scope TEXT PRIMARY KEY,
        command_scope TEXT NOT NULL,
        command_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        command_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        UNIQUE(command_scope, command_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_frappe_run_commands_expiry
        ON frappe_run_commands(expires_at_ms);
    `);
  }

  async append(input: FrappeRunEventAppendInput): Promise<FrappeRunEventAppendResult> {
    this.#assertOpen();
    const scope = validateFrappeRunEventScope(input.scope);
    const nowMs = validTime(input.nowMs ?? Date.now(), "append time");
    const event = sanitizeRunEvent(input.event, this.#maxPayloadBytes);
    assertEventScope(scope, event);
    const scopeKey = scopeStorageKey(scope);
    const fingerprint = sha256(stableJson(event));

    return this.#transaction(() => {
      this.#pruneExpired(nowMs);
      const duplicate = this.#db.prepare("SELECT scope_key, fingerprint FROM frappe_run_event_dedupe WHERE scope_key = ? AND event_id = ?").get(scopeKey, event.id) as DedupeRow | undefined;
      if (duplicate) {
        if (String(duplicate.fingerprint) !== fingerprint) {
          throw new FrappeRunEventError("conflict", "Run event id was already used with different authority or content.");
        }
        const live = this.#db.prepare("SELECT ordinal FROM frappe_run_events WHERE scope_key = ? AND event_id = ?").get(scopeKey, event.id) as { ordinal?: unknown } | undefined;
        return Object.freeze({
          status: "deduplicated" as const,
          event,
          ...(live?.ordinal ? { cursor: encodeCursor(Number(live.ordinal), cursorScope(scope, event.missionId)) } : {}),
          retentionPruned: 0,
        });
      }

      const sequenceConflict = this.#db.prepare(
        "SELECT event_id FROM frappe_run_events WHERE scope_key = ? AND mission_id = ? AND sequence = ?",
      ).get(scopeKey, event.missionId, event.sequence) as { event_id?: unknown } | undefined;
      if (sequenceConflict) throw new FrappeRunEventError("conflict", "Run event sequence was already committed by another event.");

      const inserted = this.#db.prepare(`
        INSERT INTO frappe_run_events
          (event_id, scope_key, tenant_id, site_id, user_id, mission_id, sequence, fingerprint, event_json, created_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(event.id, scopeKey, scope.tenantId, scope.siteId ?? "", scope.userId, event.missionId, event.sequence, fingerprint, stableJson(event), nowMs);
      this.#db.prepare(`
        INSERT INTO frappe_run_event_dedupe (event_id, scope_key, fingerprint, expires_at_ms)
        VALUES (?, ?, ?, ?)
      `).run(event.id, scopeKey, fingerprint, nowMs + this.#dedupeRetentionMs);
      const ordinal = Number(inserted.lastInsertRowid);
      const retentionPruned = this.#enforceCapacity();
      return Object.freeze({
        status: "appended" as const,
        event,
        cursor: encodeCursor(ordinal, cursorScope(scope, event.missionId)),
        retentionPruned,
      });
    });
  }

  async replay(input: FrappeRunEventReplayInput): Promise<FrappeRunEventReplayPage> {
    this.#assertOpen();
    const scope = validateFrappeRunEventScope(input.scope);
    const nowMs = validTime(input.nowMs ?? Date.now(), "replay time");
    const missionId = input.missionId === undefined ? undefined : validIdentifier(input.missionId, "mission id");
    const limit = boundedInteger(input.limit ?? this.#maxPageSize, 1, this.#maxPageSize, "limit");
    const scopeKey = scopeStorageKey(scope);
    const cursorBinding = cursorScope(scope, missionId);
    const after = input.cursor ? decodeCursor(input.cursor, cursorBinding) : 0;
    this.#transaction(() => this.#pruneExpired(nowMs));
    if (input.cursor) this.#assertCursorRetained(scopeKey, missionId, after);

    const accepted: Array<{ readonly event: FrappeRunEvent; readonly ordinal: number }> = [];
    let scanned = 0;
    let scanCursor = after;
    while (accepted.length < limit + 1 && scanned < this.#maxScanEvents) {
      const batchSize = Math.min(Math.max(limit * 2, 25), this.#maxScanEvents - scanned);
      const rows = this.#selectRows(scopeKey, missionId, scanCursor, batchSize);
      if (rows.length === 0) break;
      for (const row of rows) {
        scanCursor = Number(row.ordinal);
        scanned += 1;
        const event = parseStoredEvent(row.event_json);
        let allowed = true;
        if (input.canRead) {
          try {
            allowed = await input.canRead(event, scope);
          } catch {
            throw new FrappeRunEventError("permission_filter_failed", "Run event permission check failed closed.");
          }
        }
        if (allowed) accepted.push({ event, ordinal: scanCursor });
        if (accepted.length >= limit + 1 || scanned >= this.#maxScanEvents) break;
      }
      if (rows.length < batchSize) break;
    }
    const authorizedMore = accepted.length > limit;
    const returned = accepted.slice(0, limit);
    // At the scan ceiling, conservatively offer continuation regardless of raw
    // row existence. This prevents hasMore from becoming a hidden-event oracle.
    const scanLimited = !authorizedMore && scanned >= this.#maxScanEvents;
    const cursorOrdinal = authorizedMore ? returned[returned.length - 1]?.ordinal ?? after : scanCursor;
    return Object.freeze({
      events: Object.freeze(returned.map((item) => item.event)),
      ...(cursorOrdinal > after ? { nextCursor: encodeCursor(cursorOrdinal, cursorBinding) } : {}),
      hasMore: authorizedMore || scanLimited,
      scanLimited,
    });
  }

  async claimCommand(
    request: FrappeRunCommandRequest,
    preconditions: FrappeRunCommandPreconditions,
  ): Promise<FrappeRunCommandClaimResult> {
    this.#assertOpen();
    // Normalize and authenticate the complete command before touching the
    // replay ledger. Exact retained claims may outlive the request freshness
    // window, but never the CSRF, authority, schema, cursor, or payload checks.
    const command = normalizeFrappeRunCommand(request, preconditions);
    const nowMs = validTime(preconditions.nowMs ?? Date.now(), "command time");
    const maxClockSkewMs = commandClockSkew(preconditions);
    const scope = commandScope(command);
    const authorityScope = commandAuthorityScope(command);
    return this.#transaction(() => {
      this.#pruneExpired(nowMs);
      const existing = this.#db.prepare(
        "SELECT fingerprint, command_json FROM frappe_run_commands WHERE idempotency_scope = ?",
      ).get(scope) as CommandRow | undefined;
      if (existing) {
        const stored = parseStoredCommand(existing.command_json);
        return Object.freeze({
          status: String(existing.fingerprint) === command.fingerprint ? "replay" as const : "conflict" as const,
          command: stored,
        });
      }
      const commandIdClaim = this.#db.prepare(
        "SELECT fingerprint, command_json FROM frappe_run_commands WHERE command_scope = ? AND command_id = ?",
      ).get(authorityScope, command.commandId) as CommandRow | undefined;
      if (commandIdClaim) {
        const stored = parseStoredCommand(commandIdClaim.command_json);
        return Object.freeze({
          status: String(commandIdClaim.fingerprint) === command.fingerprint ? "replay" as const : "conflict" as const,
          command: stored,
        });
      }
      assertFrappeRunCommandFresh(command, nowMs, maxClockSkewMs);
      this.#db.prepare(`
        INSERT INTO frappe_run_commands (idempotency_scope, command_scope, command_id, fingerprint, command_json, created_at_ms, expires_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(scope, authorityScope, command.commandId, command.fingerprint, stableJson(command), nowMs, nowMs + this.#dedupeRetentionMs);
      return Object.freeze({ status: "claimed" as const, command });
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #selectRows(scopeKey: string, missionId: string | undefined, after: number, limit: number): EventRow[] {
    const sql = missionId
      ? "SELECT ordinal, event_json FROM frappe_run_events WHERE scope_key = ? AND mission_id = ? AND ordinal > ? ORDER BY ordinal ASC LIMIT ?"
      : "SELECT ordinal, event_json FROM frappe_run_events WHERE scope_key = ? AND ordinal > ? ORDER BY ordinal ASC LIMIT ?";
    return (missionId
      ? this.#db.prepare(sql).all(scopeKey, missionId, after, limit)
      : this.#db.prepare(sql).all(scopeKey, after, limit)) as EventRow[];
  }

  #assertCursorRetained(scopeKey: string, missionId: string | undefined, after: number): void {
    const sql = missionId
      ? "SELECT MIN(ordinal) AS floor FROM frappe_run_events WHERE scope_key = ? AND mission_id = ?"
      : "SELECT MIN(ordinal) AS floor FROM frappe_run_events WHERE scope_key = ?";
    const row = (missionId ? this.#db.prepare(sql).get(scopeKey, missionId) : this.#db.prepare(sql).get(scopeKey)) as { floor?: unknown } | undefined;
    const floor = row?.floor === null || row?.floor === undefined ? undefined : Number(row.floor);
    if (floor !== undefined && after < floor - 1) {
      throw new FrappeRunEventError("cursor_expired", "Run event cursor is older than the retained event window.");
    }
  }

  #pruneExpired(nowMs: number): void {
    this.#db.prepare("DELETE FROM frappe_run_events WHERE created_at_ms < ?").run(nowMs - this.#retentionMs);
    this.#db.prepare("DELETE FROM frappe_run_event_dedupe WHERE expires_at_ms <= ?").run(nowMs);
    this.#db.prepare("DELETE FROM frappe_run_commands WHERE expires_at_ms <= ?").run(nowMs);
  }

  #enforceCapacity(): number {
    const count = Number((this.#db.prepare("SELECT COUNT(*) AS count FROM frappe_run_events").get() as { count?: unknown } | undefined)?.count ?? 0);
    const excess = Math.max(0, count - this.#maxEvents);
    if (excess > 0) {
      this.#db.prepare(`
        DELETE FROM frappe_run_events WHERE ordinal IN (
          SELECT ordinal FROM frappe_run_events ORDER BY ordinal ASC LIMIT ?
        )
      `).run(excess);
    }
    return excess;
  }

  #transaction<T>(operation: () => T): T {
    this.#assertOpen();
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

  #assertOpen(): void {
    if (this.#closed) invalid("Run event store is closed.");
  }
}

/** Validate transport preconditions and return a safe, deterministic dispatch envelope. */
export function validateFrappeRunCommand(
  request: FrappeRunCommandRequest,
  preconditions: FrappeRunCommandPreconditions,
): AcceptedFrappeRunCommand {
  const command = normalizeFrappeRunCommand(request, preconditions);
  assertFrappeRunCommandFresh(
    command,
    validTime(preconditions.nowMs ?? Date.now(), "command time"),
    commandClockSkew(preconditions),
  );
  return command;
}

/** Validate all replay-invariant transport, authority, and envelope facts. */
function normalizeFrappeRunCommand(
  request: FrappeRunCommandRequest,
  preconditions: FrappeRunCommandPreconditions,
): AcceptedFrappeRunCommand {
  if (preconditions.method.toUpperCase() !== "POST") throw new FrappeRunEventError("forbidden", "Run control commands require POST.");
  const authenticatedScope = validateFrappeRunEventScope(preconditions.authenticatedScope);
  if (!safeEqual(request.csrfToken, preconditions.expectedCsrfToken)) throw new FrappeRunEventError("forbidden", "Run control CSRF validation failed.");
  if (request.schemaVersion !== 1) invalid("Unsupported run command schema version.");
  const commandId = validIdentifier(request.commandId, "command id");
  const missionId = validIdentifier(request.missionId, "mission id");
  const rootRunId = validIdentifier(request.rootRunId, "root run id");
  const tenantId = validIdentifier(request.tenantId, "tenant id");
  const siteId = request.siteId === undefined ? undefined : validIdentifier(request.siteId, "site id");
  const userId = validIdentifier(request.userId, "user id");
  const idempotencyKey = validIdentifier(request.idempotencyKey, "idempotency key");
  if (tenantId !== authenticatedScope.tenantId || siteId !== authenticatedScope.siteId || userId !== authenticatedScope.userId) {
    throw new FrappeRunEventError("forbidden", "Run command authority does not match the authenticated scope.");
  }
  if (!(request.action === "pause" || request.action === "resume" || request.action === "cancel" || request.action === "steer")) invalid("Run command action is invalid.");
  const issuedAtMs = Date.parse(request.issuedAt);
  if (Number.isNaN(issuedAtMs)) invalid("Run command issue time is invalid.");
  if (request.expectedCursor !== undefined) decodeCursor(request.expectedCursor, cursorScope(authenticatedScope, missionId));
  if (request.action !== "steer" && request.payload !== undefined) invalid("Only steer commands may carry a payload.");
  if (request.action === "steer" && (typeof request.payload?.instruction !== "string" || !request.payload.instruction.trim())) {
    invalid("Steer commands require a non-empty instruction.");
  }
  const payload = request.payload === undefined
    ? undefined
    : sanitizeRecord(request.payload, preconditions.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES);
  const unsigned = Object.freeze({
    schemaVersion: 1 as const,
    commandId,
    action: request.action,
    missionId,
    rootRunId,
    tenantId,
    ...(siteId ? { siteId } : {}),
    userId,
    issuedAt: new Date(issuedAtMs).toISOString(),
    idempotencyKey,
    ...(request.expectedCursor ? { expectedCursor: request.expectedCursor } : {}),
    ...(payload ? { payload } : {}),
  });
  return Object.freeze({ ...unsigned, fingerprint: sha256(stableJson(unsigned)) });
}

function commandClockSkew(preconditions: FrappeRunCommandPreconditions): number {
  return boundedInteger(preconditions.maxClockSkewMs ?? 5 * 60_000, 1_000, 60 * 60_000, "maxClockSkewMs");
}

function assertFrappeRunCommandFresh(
  command: AcceptedFrappeRunCommand,
  nowMs: number,
  maxClockSkewMs: number,
): void {
  const issuedAtMs = Date.parse(command.issuedAt);
  if (Number.isNaN(issuedAtMs) || Math.abs(nowMs - issuedAtMs) > maxClockSkewMs) {
    throw new FrappeRunEventError("forbidden", "Run command is expired or issued too far in the future.");
  }
}

export function sanitizeRunEvent(event: FrappeRunEvent, maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES): FrappeRunEvent {
  if (event.schemaVersion !== 1) invalid("Unsupported run event schema version.");
  validIdentifier(event.id, "event id");
  validIdentifier(event.missionId, "mission id");
  validIdentifier(event.rootRunId, "root run id");
  validIdentifier(event.tenantId, "tenant id");
  if (event.siteId !== undefined) validIdentifier(event.siteId, "site id");
  validIdentifier(event.actorId, "actor id");
  if (event.nodeId !== undefined) validIdentifier(event.nodeId, "node id");
  if (event.attemptId !== undefined) validIdentifier(event.attemptId, "attempt id");
  if (event.agentId !== undefined) validIdentifier(event.agentId, "agent id");
  if (!EVENT_TYPES.has(event.type)) invalid("Run event type is invalid.");
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) invalid("Run event sequence is invalid.");
  if (event.fencingToken !== undefined && (!Number.isSafeInteger(event.fencingToken) || event.fencingToken < 0)) invalid("Run event fencing token is invalid.");
  if (event.idempotencyKey !== undefined) validIdentifier(event.idempotencyKey, "idempotency key");
  if (event.receiptHash !== undefined && (typeof event.receiptHash !== "string" || !event.receiptHash || event.receiptHash.length > 512)) invalid("Run event receipt hash is invalid.");
  if (Number.isNaN(Date.parse(event.at))) invalid("Run event timestamp is invalid.");
  if (typeof event.summary !== "string" || !event.summary.trim() || event.summary.length > 4_000) invalid("Run event summary is invalid.");
  if (event.evidenceIds?.some((id) => !IDENTIFIER.test(id))) invalid("Run event evidence id is invalid.");
  const payload = event.payload === undefined ? undefined : sanitizeRecord(event.payload, maxPayloadBytes);
  const sanitized = {
    ...event,
    at: new Date(Date.parse(event.at)).toISOString(),
    summary: redactString(event.summary),
    ...(payload ? { payload } : {}),
  };
  const bytes = Buffer.byteLength(stableJson(sanitized), "utf8");
  if (bytes > maxPayloadBytes) invalid(`Sanitized run event exceeds the ${maxPayloadBytes}-byte payload limit.`);
  return deepFreeze(sanitized) as FrappeRunEvent;
}

function sanitizeRecord(value: Readonly<Record<string, unknown>>, maxBytes: number): Readonly<Record<string, unknown>> {
  boundedInteger(maxBytes, 256, 1024 * 1024, "maxPayloadBytes");
  const sanitized = sanitizeValue(value, new Set(), 0) as Record<string, unknown>;
  if (Buffer.byteLength(stableJson(sanitized), "utf8") > maxBytes) invalid(`Sanitized payload exceeds the ${maxBytes}-byte limit.`);
  return deepFreeze(sanitized);
}

function sanitizeValue(value: unknown, seen: Set<object>, depth: number): unknown {
  if (depth > 20) invalid("Payload nesting is too deep.");
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid("Payload contains a non-finite number.");
    return value;
  }
  if (typeof value === "boolean" || value === null) return value;
  if (value === undefined) return undefined;
  if (typeof value !== "object") invalid("Payload contains an unsupported value.");
  if (seen.has(value)) invalid("Payload contains a cycle.");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, seen, depth + 1));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid("Payload must contain plain JSON objects only.");
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 1_000) invalid("Payload contains too many fields.");
    const safeEntries = entries
      .filter(([key]) => !SECRET_KEY.test(key))
      .map(([key, item]) => [key, sanitizeValue(item, seen, depth + 1)] as const);
    const redactedFields = entries.filter(([key]) => SECRET_KEY.test(key)).map(([key]) => key);
    if (redactedFields.length > 0) safeEntries.push(["_musterRedactedFields", redactedFields]);
    return Object.fromEntries(safeEntries);
  } finally {
    seen.delete(value);
  }
}

function redactString(value: string): string {
  return value.replace(BEARER_VALUE, "Bearer [redacted]").replace(SECRET_ASSIGNMENT, "$1=[redacted]");
}

export function validateFrappeRunEventScope(scope: FrappeRunEventScope): FrappeRunEventScope {
  const tenantId = validIdentifier(scope.tenantId, "tenant id");
  const siteId = scope.siteId === undefined ? undefined : validIdentifier(scope.siteId, "site id");
  const userId = validIdentifier(scope.userId, "user id");
  return Object.freeze({ tenantId, ...(siteId ? { siteId } : {}), userId });
}

function assertEventScope(scope: FrappeRunEventScope, event: FrappeRunEvent): void {
  if (event.tenantId !== scope.tenantId || event.siteId !== scope.siteId) {
    throw new FrappeRunEventError("forbidden", "Run event authority does not match the append scope.");
  }
}

function scopeStorageKey(scope: FrappeRunEventScope): string {
  return sha256(stableJson([scope.tenantId, scope.siteId ?? "", scope.userId]));
}

function cursorScope(scope: FrappeRunEventScope, missionId?: string): string {
  return sha256(stableJson([scope.tenantId, scope.siteId ?? "", scope.userId, missionId ?? "*"]));
}

function encodeCursor(after: number, scope: string): string {
  const body: CursorBody = { v: 1, after, scope };
  return Buffer.from(stableJson(body), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, expectedScope: string): number {
  if (!cursor || cursor.length > 2_048) invalid("Run event cursor is invalid.");
  try {
    const body = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<CursorBody>;
    if (body.v !== 1 || !Number.isSafeInteger(body.after) || (body.after ?? -1) < 0 || body.scope !== expectedScope) {
      throw new Error("invalid");
    }
    return body.after!;
  } catch {
    throw new FrappeRunEventError("forbidden", "Run event cursor is invalid for this authority scope.");
  }
}

function commandScope(command: AcceptedFrappeRunCommand): string {
  return sha256(stableJson([command.tenantId, command.siteId ?? "", command.userId, command.missionId, command.idempotencyKey]));
}

function commandAuthorityScope(command: AcceptedFrappeRunCommand): string {
  return sha256(stableJson([command.tenantId, command.siteId ?? "", command.userId]));
}

function parseStoredEvent(value: unknown): FrappeRunEvent {
  try {
    return deepFreeze(JSON.parse(String(value))) as FrappeRunEvent;
  } catch {
    throw new FrappeRunEventError("invalid_request", "Stored run event is corrupt.");
  }
}

function parseStoredCommand(value: unknown): AcceptedFrappeRunCommand {
  try {
    return deepFreeze(JSON.parse(String(value))) as AcceptedFrappeRunCommand;
  } catch {
    throw new FrappeRunEventError("invalid_request", "Stored run command is corrupt.");
  }
}

function safeEqual(left: string, right: string): boolean {
  if (!left || !right) return false;
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function validIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) invalid(`Run ${label} is invalid.`);
  return value;
}

function validTime(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) invalid(`Run ${label} is invalid.`);
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(`${label} must be an integer from ${minimum} to ${maximum}.`);
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, sortJson(item)]));
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  }
  return value;
}

function invalid(message: string): never {
  throw new FrappeRunEventError("invalid_request", message);
}

/** Useful to endpoint adaptors that need a collision-resistant command id. */
export function newFrappeRunCommandId(): string {
  return `cmd_${randomUUID()}`;
}

/** Bind a Frappe-session CSRF token and authority lane to the server-held gateway secret. */
export function createFrappeRunCsrfProof(
  secret: string,
  csrfToken: string,
  scope: FrappeRunEventScope,
): string {
  if (!secret || !csrfToken) invalid("Frappe run CSRF proof inputs are invalid.");
  const authority = validateFrappeRunEventScope(scope);
  return createHmac("sha256", secret)
    .update(stableJson([csrfToken, authority.tenantId, authority.siteId ?? "", authority.userId]))
    .digest("hex");
}

export function frappeRunCsrfProofMatches(
  presented: string | undefined,
  secret: string,
  csrfToken: string,
  scope: FrappeRunEventScope,
): boolean {
  if (!presented) return false;
  try {
    return safeEqual(presented, createFrappeRunCsrfProof(secret, csrfToken, scope));
  } catch {
    return false;
  }
}
