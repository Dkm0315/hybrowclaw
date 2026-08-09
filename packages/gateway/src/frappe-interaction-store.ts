import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

export type FrappeInteractionOperation = "create" | "update" | "submit" | "approve" | "reject";

export interface PendingFrappeField {
  readonly fieldname: string;
  readonly label: string;
  readonly reason?: string;
  readonly options?: readonly string[];
}

export interface PendingFrappeInteraction {
  readonly key: string;
  readonly site: string;
  readonly principal: string;
  readonly surfaceId: string;
  readonly conversationId: string;
  readonly senderId: string;
  readonly doctype: string;
  readonly operation: FrappeInteractionOperation;
  readonly values: Readonly<Record<string, unknown>>;
  readonly requiredFields: readonly PendingFrappeField[];
  readonly phase: "collecting" | "review";
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly expiresAtMs: number;
}

export interface FrappeInteractionStore {
  read(key: string, nowMs?: number): PendingFrappeInteraction | undefined;
  put(interaction: PendingFrappeInteraction): void;
  clear(key: string): void;
  close?(): void;
}

interface SqliteStatement {
  run(...params: unknown[]): { readonly changes?: number | bigint };
  get(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export class InMemoryFrappeInteractionStore implements FrappeInteractionStore {
  readonly #records = new Map<string, PendingFrappeInteraction>();

  read(key: string, nowMs = Date.now()): PendingFrappeInteraction | undefined {
    const record = this.#records.get(key);
    if (!record) return undefined;
    if (record.expiresAtMs <= nowMs) {
      this.#records.delete(key);
      return undefined;
    }
    return structuredClone(record);
  }

  put(interaction: PendingFrappeInteraction): void {
    validateInteraction(interaction);
    this.#records.set(interaction.key, structuredClone(interaction));
  }

  clear(key: string): void {
    this.#records.delete(key);
  }
}

/** Durable local workflow state. Multi-host deployments can inject a shared implementation. */
export class SqliteFrappeInteractionStore implements FrappeInteractionStore {
  readonly #db: SqliteDatabase;
  #closed = false;

  constructor(filename: string) {
    if (!filename.trim()) throw new Error("Frappe interaction SQLite filename must be non-empty.");
    if (filename !== ":memory:" && !filename.startsWith("file:")) mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string) => SqliteDatabase };
    this.#db = new DatabaseSync(filename);
    if (filename !== ":memory:" && !filename.startsWith("file:")) chmodSync(filename, 0o600);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS gateway_frappe_interactions (
        interaction_key TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_gateway_frappe_interactions_expiry
        ON gateway_frappe_interactions(expires_at_ms);
    `);
  }

  read(key: string, nowMs = Date.now()): PendingFrappeInteraction | undefined {
    this.#assertOpen();
    this.#db.prepare("DELETE FROM gateway_frappe_interactions WHERE expires_at_ms <= ?").run(nowMs);
    const row = this.#db.prepare("SELECT payload_json FROM gateway_frappe_interactions WHERE interaction_key = ?").get(key) as { payload_json?: unknown } | undefined;
    if (typeof row?.payload_json !== "string") return undefined;
    return parseInteraction(row.payload_json);
  }

  put(interaction: PendingFrappeInteraction): void {
    this.#assertOpen();
    validateInteraction(interaction);
    this.#db.prepare(`
      INSERT INTO gateway_frappe_interactions (interaction_key, payload_json, updated_at_ms, expires_at_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(interaction_key) DO UPDATE SET
        payload_json = excluded.payload_json,
        updated_at_ms = excluded.updated_at_ms,
        expires_at_ms = excluded.expires_at_ms
    `).run(interaction.key, JSON.stringify(interaction), interaction.updatedAtMs, interaction.expiresAtMs);
  }

  clear(key: string): void {
    this.#assertOpen();
    this.#db.prepare("DELETE FROM gateway_frappe_interactions WHERE interaction_key = ?").run(key);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Frappe interaction store is closed.");
  }
}

function parseInteraction(value: string): PendingFrappeInteraction {
  const parsed = JSON.parse(value) as PendingFrappeInteraction;
  validateInteraction(parsed);
  return parsed;
}

function validateInteraction(value: PendingFrappeInteraction): void {
  for (const field of ["key", "site", "principal", "surfaceId", "conversationId", "senderId", "doctype", "operation", "phase"] as const) {
    if (typeof value[field] !== "string" || !value[field].trim()) throw new Error(`Pending Frappe interaction requires ${field}.`);
  }
  if (!Number.isSafeInteger(value.createdAtMs) || !Number.isSafeInteger(value.updatedAtMs) || !Number.isSafeInteger(value.expiresAtMs)) {
    throw new Error("Pending Frappe interaction timestamps are invalid.");
  }
  if (value.expiresAtMs <= value.updatedAtMs) throw new Error("Pending Frappe interaction expiry must be in the future.");
  if (!Array.isArray(value.requiredFields) || value.requiredFields.length > 64) throw new Error("Pending Frappe interaction fields are invalid.");
  for (const field of value.requiredFields) {
    if (!field.fieldname?.trim() || !field.label?.trim()) throw new Error("Pending Frappe fields require fieldname and label.");
  }
}
