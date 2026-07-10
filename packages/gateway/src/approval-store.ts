import { createHmac } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type {
  ApprovalActionBinding,
  ApprovalActionConsumeResult,
  ApprovalActionStore,
  ApprovalDecision,
} from "./presentation.js";

interface SqliteStatement {
  run(...params: unknown[]): { readonly changes?: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface PendingApprovalExecution {
  readonly binding: ApprovalActionBinding;
  readonly decision: ApprovalDecision;
  readonly consumedAt: number;
  readonly executionOwner?: string;
}

/** Durable one-shot approval store with a recoverable execution outbox. */
export class SqliteApprovalActionStore implements ApprovalActionStore {
  readonly #db: SqliteDatabase;
  #closed = false;

  constructor(filename: string) {
    if (!filename.trim()) throw new Error("Approval SQLite filename must be non-empty.");
    mkdirSync(dirname(filename), { recursive: true });
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string) => SqliteDatabase };
    this.#db = new DatabaseSync(filename);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS gateway_approval_actions (
        id TEXT PRIMARY KEY,
        binding_json TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        consumed_at INTEGER,
        decision TEXT,
        execution_state TEXT NOT NULL DEFAULT 'available',
        execution_detail TEXT,
        execution_owner TEXT,
        execution_lease_until INTEGER,
        CHECK (decision IS NULL OR decision IN ('approve', 'reject')),
        CHECK (execution_state IN ('available', 'pending', 'completed', 'failed'))
      );
      CREATE INDEX IF NOT EXISTS idx_gateway_approval_pending
        ON gateway_approval_actions(execution_state, consumed_at);
    `);
    const columns = this.#db.prepare("PRAGMA table_info(gateway_approval_actions)").all() as Array<{ name?: unknown }>;
    if (!columns.some((column) => String(column.name) === "execution_owner")) {
      this.#db.exec("ALTER TABLE gateway_approval_actions ADD COLUMN execution_owner TEXT;");
    }
    if (!columns.some((column) => String(column.name) === "execution_lease_until")) {
      this.#db.exec("ALTER TABLE gateway_approval_actions ADD COLUMN execution_lease_until INTEGER;");
    }
  }

  create(binding: ApprovalActionBinding): boolean {
    this.#assertOpen();
    const result = this.#db.prepare(`
      INSERT OR IGNORE INTO gateway_approval_actions (id, binding_json, fingerprint)
      VALUES (?, ?, ?)
    `).run(binding.id, JSON.stringify(binding), approvalFingerprint(binding));
    return Number(result.changes ?? 0) === 1;
  }

  read(id: string): ApprovalActionBinding | undefined {
    this.#assertOpen();
    const row = this.#db.prepare("SELECT binding_json FROM gateway_approval_actions WHERE id = ?").get(id) as { binding_json?: unknown } | undefined;
    return typeof row?.binding_json === "string" ? parseBinding(row.binding_json) : undefined;
  }

  consume(id: string, expectedFingerprint: string, decision: ApprovalDecision, consumedAt: number): ApprovalActionConsumeResult {
    this.#assertOpen();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db.prepare("SELECT fingerprint, consumed_at FROM gateway_approval_actions WHERE id = ?").get(id) as {
        fingerprint?: unknown;
        consumed_at?: unknown;
      } | undefined;
      if (!row) {
        this.#db.exec("ROLLBACK");
        return "missing";
      }
      if (row.fingerprint !== expectedFingerprint) {
        this.#db.exec("ROLLBACK");
        return "conflict";
      }
      if (row.consumed_at !== null && row.consumed_at !== undefined) {
        this.#db.exec("ROLLBACK");
        return "replay";
      }
      this.#db.prepare(`
        UPDATE gateway_approval_actions
        SET consumed_at = ?, decision = ?, execution_state = 'pending', execution_detail = NULL,
            execution_owner = NULL, execution_lease_until = NULL
        WHERE id = ? AND consumed_at IS NULL
      `).run(consumedAt, decision, id);
      this.#db.exec("COMMIT");
      return "consumed";
    } catch (error) {
      try { this.#db.exec("ROLLBACK"); } catch { /* keep original error */ }
      throw error;
    }
  }

  claimPending(executionOwner: string, nowMs: number, leaseMs: number, limit = 100): readonly PendingApprovalExecution[] {
    this.#assertOpen();
    if (!executionOwner.trim()) throw new Error("Approval execution owner must be non-empty.");
    if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error("Approval execution lease is invalid.");
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.#db.prepare(`
        SELECT id, binding_json, decision, consumed_at FROM gateway_approval_actions
        WHERE execution_state = 'pending'
          AND (execution_owner IS NULL OR execution_lease_until <= ?)
        ORDER BY consumed_at ASC LIMIT ?
      `).all(nowMs, limit) as Array<{ id?: unknown; binding_json?: unknown; decision?: unknown; consumed_at?: unknown }>;
      const claimed: PendingApprovalExecution[] = [];
      for (const row of rows) {
        if (typeof row.id !== "string" || typeof row.binding_json !== "string" || (row.decision !== "approve" && row.decision !== "reject") || !Number.isFinite(Number(row.consumed_at))) continue;
        const updated = this.#db.prepare(`
          UPDATE gateway_approval_actions SET execution_owner = ?, execution_lease_until = ?
          WHERE id = ? AND execution_state = 'pending'
            AND (execution_owner IS NULL OR execution_lease_until <= ?)
        `).run(executionOwner, nowMs + leaseMs, row.id, nowMs);
        if (Number(updated.changes ?? 0) === 1) {
          claimed.push({ binding: parseBinding(row.binding_json), decision: row.decision, consumedAt: Number(row.consumed_at), executionOwner });
        }
      }
      this.#db.exec("COMMIT");
      return claimed;
    } catch (error) {
      try { this.#db.exec("ROLLBACK"); } catch { /* keep original error */ }
      throw error;
    }
  }

  claimExecution(id: string, executionOwner: string, nowMs: number, leaseMs: number): boolean {
    this.#assertOpen();
    if (!id || !executionOwner) return false;
    const result = this.#db.prepare(`
      UPDATE gateway_approval_actions SET execution_owner = ?, execution_lease_until = ?
      WHERE id = ? AND execution_state = 'pending'
        AND (execution_owner IS NULL OR execution_lease_until <= ? OR execution_owner = ?)
    `).run(executionOwner, nowMs + leaseMs, id, nowMs, executionOwner);
    return Number(result.changes ?? 0) === 1;
  }

  /** Inspection only. Execution recovery must use claimPending(). */
  listPending(limit = 100): readonly PendingApprovalExecution[] {
    this.#assertOpen();
    const rows = this.#db.prepare(`
      SELECT binding_json, decision, consumed_at, execution_owner FROM gateway_approval_actions
      WHERE execution_state = 'pending' ORDER BY consumed_at ASC LIMIT ?
    `).all(limit) as Array<{ binding_json?: unknown; decision?: unknown; consumed_at?: unknown; execution_owner?: unknown }>;
    return rows.flatMap((row) => {
      if (typeof row.binding_json !== "string" || (row.decision !== "approve" && row.decision !== "reject") || !Number.isFinite(Number(row.consumed_at))) return [];
      return [{
        binding: parseBinding(row.binding_json),
        decision: row.decision,
        consumedAt: Number(row.consumed_at),
        ...(typeof row.execution_owner === "string" ? { executionOwner: row.execution_owner } : {}),
      }];
    });
  }

  markExecution(id: string, state: "completed" | "failed", detail?: string, executionOwner?: string): void {
    this.#assertOpen();
    const safeDetail = detail?.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500);
    this.#db.prepare(`
      UPDATE gateway_approval_actions SET execution_state = ?, execution_detail = ?
      WHERE id = ? AND execution_state = 'pending'
        AND (? IS NULL OR execution_owner = ?)
    `).run(state, safeDetail ?? null, id, executionOwner ?? null, executionOwner ?? null);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Approval SQLite store is closed.");
  }
}

function approvalFingerprint(binding: ApprovalActionBinding): string {
  const canonical = JSON.stringify([
    "ma1",
    binding.id,
    binding.actorId,
    binding.surfaceId,
    binding.conversationId,
    binding.runId,
    binding.gateId,
    binding.revision,
    binding.issuedAt,
    binding.expiresAt,
  ]);
  return createHmac("sha256", "muster-approval-store-fingerprint-v1").update(canonical).digest("base64url");
}

function parseBinding(value: string): ApprovalActionBinding {
  const binding = JSON.parse(value) as ApprovalActionBinding;
  if (!binding || typeof binding.id !== "string" || typeof binding.actorId !== "string" || typeof binding.runId !== "string" || typeof binding.gateId !== "string") {
    throw new Error("Stored approval binding is invalid.");
  }
  return Object.freeze(binding);
}
