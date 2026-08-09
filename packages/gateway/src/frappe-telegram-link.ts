import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const DEFAULT_LINK_TTL_MS = 5 * 60_000;
const MIN_LINK_TTL_MS = 30_000;
const MAX_LINK_TTL_MS = 10 * 60_000;
const DEFAULT_UPDATE_TTL_MS = 24 * 60 * 60_000;
const MAX_TELEGRAM_INTEGER = (1n << 63n) - 1n;
const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,253}$/;

export const FRAPPE_TELEGRAM_LINK_PATH = "/v1/frappe/telegram-links";

export type TelegramChatType = "private" | "group" | "supergroup" | "channel";

export interface FrappeTelegramAuthority {
  readonly site: string;
  readonly user: string;
  readonly tenantId: string;
  readonly botId: string;
  readonly scopes: readonly string[];
  readonly permissionEpoch: string;
}

export interface FrappeTelegramLinkIssue extends FrappeTelegramAuthority {
  readonly allowedChatTypes?: readonly TelegramChatType[];
  readonly ttlMs?: number;
}

export interface FrappeTelegramLinkStart {
  /** The only secret returned by this module. Persist only its hash. */
  readonly token: string;
  readonly linkId: string;
  readonly expiresAt: string;
}

export interface FrappeTelegramRedemption extends FrappeTelegramAuthority {
  readonly token: string;
  readonly telegramUserId: string;
  readonly telegramChatId: string;
  readonly chatType: TelegramChatType;
}

export interface ObservedTelegramRedemption {
  readonly token: string;
  readonly botId: string;
  readonly telegramUserId: string;
  readonly telegramChatId: string;
  readonly chatType: TelegramChatType;
}

export interface FrappeTelegramConfirmation extends FrappeTelegramAuthority {
  readonly linkId: string;
}

export interface FrappeTelegramRevocation {
  readonly linkId: string;
  readonly site: string;
  readonly user: string;
  readonly tenantId: string;
}

export interface FrappeTelegramRebind {
  readonly site: string;
  readonly tenantId: string;
  /** Omit to invalidate every Telegram provider account for this site binding. */
  readonly botId?: string;
}

export interface FrappeTelegramIdentityLink {
  readonly linkId: string;
  readonly site: string;
  readonly user: string;
  readonly tenantId: string;
  readonly botId: string;
  readonly scopes: readonly string[];
  readonly permissionEpoch: string;
  readonly telegramUserId: string;
  readonly telegramChatId: string;
  readonly chatType: TelegramChatType;
  readonly linkedAt: string;
}

export type FrappeTelegramLinkResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: "link_denied"; readonly message: string };

export type FrappeTelegramLinkAuditEvent =
  | { readonly action: "issued"; readonly linkId: string; readonly site: string; readonly user: string; readonly tenantId: string; readonly at: string }
  | { readonly action: "redeemed" | "confirmed" | "revoked"; readonly linkId: string; readonly at: string }
  | { readonly action: "rebind_invalidated"; readonly site: string; readonly tenantId: string; readonly count: number; readonly at: string }
  | { readonly action: "denied"; readonly operation: "redeem" | "confirm" | "revoke" | "resolve"; readonly reason: LinkDenialReason; readonly at: string };

export type LinkDenialReason =
  | "malformed"
  | "unknown"
  | "expired"
  | "replayed"
  | "revoked"
  | "wrong_binding"
  | "permission_changed"
  | "chat_type"
  | "identity_conflict";

type LinkState = "pending" | "awaiting_confirmation" | "active" | "revoked";

export interface StoredFrappeTelegramLink {
  readonly linkId: string;
  readonly tokenHash: string;
  readonly authority: NormalizedFrappeTelegramAuthority;
  readonly allowedChatTypes: readonly TelegramChatType[];
  readonly issuedAt: number;
  readonly expiresAt: number;
  state: LinkState;
  redeemedAt?: number;
  linkedAt?: number;
  revokedAt?: number;
  telegramUserId?: string;
  telegramChatId?: string;
  chatType?: TelegramChatType;
}

export interface NormalizedFrappeTelegramAuthority {
  readonly site: string;
  readonly user: string;
  readonly tenantId: string;
  readonly botId: string;
  readonly scopes: readonly string[];
  readonly permissionEpoch: string;
}

export interface TelegramIdentityObservation {
  readonly telegramUserId: string;
  readonly telegramChatId: string;
  readonly chatType: TelegramChatType;
}

export type AtomicRedemption =
  | { readonly ok: true; readonly record: StoredFrappeTelegramLink }
  | { readonly ok: false; readonly reason: LinkDenialReason };

/**
 * Storage contract for clustered deployments. `redeem` and `confirm` MUST use
 * one transaction or compare-and-swap; checking and updating in separate
 * operations would make a one-time token replayable under concurrency.
 */
export interface FrappeTelegramLinkStore {
  insert(record: StoredFrappeTelegramLink): void;
  redeem(tokenHash: string, authority: NormalizedFrappeTelegramAuthority, observation: TelegramIdentityObservation, now: number): AtomicRedemption;
  redeemObserved(tokenHash: string, botId: string, observation: TelegramIdentityObservation, now: number): AtomicRedemption;
  confirm(linkId: string, authority: NormalizedFrappeTelegramAuthority, now: number): AtomicRedemption;
  revoke(request: FrappeTelegramRevocation, now: number): AtomicRedemption;
  resolve(linkId: string, authority: NormalizedFrappeTelegramAuthority, now: number): AtomicRedemption;
  invalidateForRebind(binding: { readonly site: string; readonly tenantId: string; readonly botId?: string }, now: number): number;
  close?(): void;
}

/** Single-process reference store. Its mutations are synchronous, hence atomic in Node's event loop. */
export class InMemoryFrappeTelegramLinkStore implements FrappeTelegramLinkStore {
  readonly #byId = new Map<string, StoredFrappeTelegramLink>();
  readonly #idByTokenHash = new Map<string, string>();

  insert(record: StoredFrappeTelegramLink): void {
    if (this.#byId.has(record.linkId) || this.#idByTokenHash.has(record.tokenHash)) throw new Error("Telegram link identifier collision.");
    this.#byId.set(record.linkId, record);
    this.#idByTokenHash.set(record.tokenHash, record.linkId);
  }

  redeem(tokenHash: string, authority: NormalizedFrappeTelegramAuthority, observation: TelegramIdentityObservation, now: number): AtomicRedemption {
    const id = this.#idByTokenHash.get(tokenHash);
    const record = id ? this.#byId.get(id) : undefined;
    if (!record) return denied("unknown");
    if (record.state === "revoked") return denied("revoked");
    if (record.state !== "pending") return denied("replayed");
    if (record.expiresAt <= now) {
      record.state = "revoked";
      record.revokedAt = now;
      return denied("expired");
    }
    if (!sameBindingExceptEpoch(record.authority, authority)) return denied("wrong_binding");
    if (record.authority.permissionEpoch !== authority.permissionEpoch) return denied("permission_changed");
    if (!record.allowedChatTypes.includes(observation.chatType)) return denied("chat_type");

    // This state transition occurs before control returns to the caller.
    record.state = "awaiting_confirmation";
    record.redeemedAt = now;
    record.telegramUserId = observation.telegramUserId;
    record.telegramChatId = observation.telegramChatId;
    record.chatType = observation.chatType;
    return { ok: true, record };
  }

  redeemObserved(tokenHash: string, botId: string, observation: TelegramIdentityObservation, now: number): AtomicRedemption {
    const id = this.#idByTokenHash.get(tokenHash);
    const record = id ? this.#byId.get(id) : undefined;
    if (!record) return denied("unknown");
    if (record.authority.botId !== botId) return denied("wrong_binding");
    return this.#consumeObserved(record, observation, now);
  }

  confirm(linkId: string, authority: NormalizedFrappeTelegramAuthority, now: number): AtomicRedemption {
    const record = this.#byId.get(linkId);
    if (!record) return denied("unknown");
    if (record.state === "revoked") return denied("revoked");
    if (record.state !== "awaiting_confirmation") return denied("replayed");
    if (record.expiresAt <= now) {
      record.state = "revoked";
      record.revokedAt = now;
      return denied("expired");
    }
    if (!sameBindingExceptEpoch(record.authority, authority)) return denied("wrong_binding");
    if (record.authority.permissionEpoch !== authority.permissionEpoch) return denied("permission_changed");
    if (this.#hasIdentityConflict(record)) return denied("identity_conflict");
    record.state = "active";
    record.linkedAt = now;
    return { ok: true, record };
  }

  revoke(request: FrappeTelegramRevocation, now: number): AtomicRedemption {
    const record = this.#byId.get(request.linkId);
    if (!record) return denied("unknown");
    if (record.state === "revoked") return denied("revoked");
    if (record.authority.site !== request.site || record.authority.user !== request.user || record.authority.tenantId !== request.tenantId) {
      return denied("wrong_binding");
    }
    record.state = "revoked";
    record.revokedAt = now;
    return { ok: true, record };
  }

  resolve(linkId: string, authority: NormalizedFrappeTelegramAuthority, now: number): AtomicRedemption {
    const record = this.#byId.get(linkId);
    if (!record) return denied("unknown");
    if (record.state === "revoked") return denied("revoked");
    if (record.state !== "active") return denied("unknown");
    if (!sameBindingExceptEpoch(record.authority, authority)) return denied("wrong_binding");
    if (record.authority.permissionEpoch !== authority.permissionEpoch) {
      record.state = "revoked";
      record.revokedAt = now;
      return denied("permission_changed");
    }
    return { ok: true, record };
  }

  invalidateForRebind(binding: { readonly site: string; readonly tenantId: string; readonly botId?: string }, now: number): number {
    let count = 0;
    for (const record of this.#byId.values()) {
      if (record.state === "revoked" || record.authority.site !== binding.site || record.authority.tenantId !== binding.tenantId) continue;
      if (binding.botId !== undefined && record.authority.botId !== binding.botId) continue;
      record.state = "revoked";
      record.revokedAt = now;
      count += 1;
    }
    return count;
  }

  #hasIdentityConflict(candidate: StoredFrappeTelegramLink): boolean {
    return [...this.#byId.values()].some((record) => {
      if (record.linkId === candidate.linkId || record.state !== "active") return false;
      if (record.authority.tenantId !== candidate.authority.tenantId || record.authority.botId !== candidate.authority.botId) return false;
      const sameTelegramIdentity = record.telegramUserId === candidate.telegramUserId;
      const sameFrappeIdentity = record.authority.site === candidate.authority.site && record.authority.user === candidate.authority.user;
      return sameTelegramIdentity || sameFrappeIdentity;
    });
  }

  #consumeObserved(record: StoredFrappeTelegramLink, observation: TelegramIdentityObservation, now: number): AtomicRedemption {
    if (record.state === "revoked") return denied("revoked");
    if (record.state !== "pending") return denied("replayed");
    if (record.expiresAt <= now) {
      record.state = "revoked";
      record.revokedAt = now;
      return denied("expired");
    }
    if (!record.allowedChatTypes.includes(observation.chatType)) return denied("chat_type");
    record.state = "awaiting_confirmation";
    record.redeemedAt = now;
    record.telegramUserId = observation.telegramUserId;
    record.telegramChatId = observation.telegramChatId;
    record.chatType = observation.chatType;
    return { ok: true, record };
  }
}

export interface TelegramUpdateDedupeStore {
  /** Atomically returns true only for the first unexpired bot/update tuple. */
  claim(botId: string, updateId: string, now: number, ttlMs: number): boolean;
  close?(): void;
}

export class InMemoryTelegramUpdateDedupeStore implements TelegramUpdateDedupeStore {
  readonly #expires = new Map<string, number>();

  claim(botId: string, updateId: string, now: number, ttlMs: number): boolean {
    for (const [key, expiry] of this.#expires) if (expiry <= now) this.#expires.delete(key);
    const key = `${botId}:${updateId}`;
    if ((this.#expires.get(key) ?? 0) > now) return false;
    this.#expires.set(key, now + ttlMs);
    return true;
  }
}

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

/** Durable, cross-process local store. Every state transition uses BEGIN IMMEDIATE. */
export class SqliteFrappeTelegramLinkStore implements FrappeTelegramLinkStore, TelegramUpdateDedupeStore {
  readonly #db: SqliteDatabase;
  #closed = false;

  constructor(filename: string) {
    if (!filename.trim()) throw new Error("Frappe Telegram link SQLite filename must be non-empty.");
    if (filename !== ":memory:" && !filename.startsWith("file:")) mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string) => SqliteDatabase };
    this.#db = new DatabaseSync(filename);
    if (filename !== ":memory:" && !filename.startsWith("file:")) chmodSync(filename, 0o600);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS gateway_frappe_telegram_links (
        link_id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_gateway_frappe_telegram_link_state
        ON gateway_frappe_telegram_links(state, expires_at_ms);
      CREATE TABLE IF NOT EXISTS gateway_telegram_update_dedupe (
        bot_id TEXT NOT NULL,
        update_id TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        PRIMARY KEY(bot_id, update_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_gateway_telegram_update_expiry
        ON gateway_telegram_update_dedupe(expires_at_ms);
    `);
  }

  insert(record: StoredFrappeTelegramLink): void {
    this.#assertOpen();
    this.#db.prepare(`
      INSERT INTO gateway_frappe_telegram_links(link_id, token_hash, payload_json, state, expires_at_ms)
      VALUES (?, ?, ?, ?, ?)
    `).run(record.linkId, record.tokenHash, JSON.stringify(record), record.state, record.expiresAt);
  }

  redeem(tokenHash: string, authority: NormalizedFrappeTelegramAuthority, observation: TelegramIdentityObservation, now: number): AtomicRedemption {
    return this.#transaction(() => {
      const record = this.#byToken(tokenHash);
      if (!record) return denied("unknown");
      if (!sameBindingExceptEpoch(record.authority, authority)) return denied("wrong_binding");
      if (record.authority.permissionEpoch !== authority.permissionEpoch) return denied("permission_changed");
      return this.#consume(record, observation, now);
    });
  }

  redeemObserved(tokenHash: string, botId: string, observation: TelegramIdentityObservation, now: number): AtomicRedemption {
    return this.#transaction(() => {
      const record = this.#byToken(tokenHash);
      if (!record) return denied("unknown");
      if (record.authority.botId !== botId) return denied("wrong_binding");
      return this.#consume(record, observation, now);
    });
  }

  confirm(linkId: string, authority: NormalizedFrappeTelegramAuthority, now: number): AtomicRedemption {
    return this.#transaction(() => {
      const record = this.#byId(linkId);
      if (!record) return denied("unknown");
      if (record.state === "revoked") return denied("revoked");
      if (record.state !== "awaiting_confirmation") return denied("replayed");
      if (record.expiresAt <= now) return this.#revokeAs(record, now, "expired");
      if (!sameBindingExceptEpoch(record.authority, authority)) return denied("wrong_binding");
      if (record.authority.permissionEpoch !== authority.permissionEpoch) return denied("permission_changed");
      const conflict = this.#active().some((active) => active.linkId !== record.linkId
        && active.authority.tenantId === record.authority.tenantId
        && active.authority.botId === record.authority.botId
        && (active.telegramUserId === record.telegramUserId
          || (active.authority.site === record.authority.site && active.authority.user === record.authority.user)));
      if (conflict) return denied("identity_conflict");
      record.state = "active";
      record.linkedAt = now;
      this.#save(record);
      return { ok: true, record };
    });
  }

  revoke(request: FrappeTelegramRevocation, now: number): AtomicRedemption {
    return this.#transaction(() => {
      const record = this.#byId(request.linkId);
      if (!record) return denied("unknown");
      if (record.state === "revoked") return denied("revoked");
      if (record.authority.site !== request.site || record.authority.user !== request.user || record.authority.tenantId !== request.tenantId) return denied("wrong_binding");
      record.state = "revoked";
      record.revokedAt = now;
      this.#save(record);
      return { ok: true, record };
    });
  }

  resolve(linkId: string, authority: NormalizedFrappeTelegramAuthority, now: number): AtomicRedemption {
    return this.#transaction(() => {
      const record = this.#byId(linkId);
      if (!record || record.state !== "active") return denied(record?.state === "revoked" ? "revoked" : "unknown");
      if (!sameBindingExceptEpoch(record.authority, authority)) return denied("wrong_binding");
      if (record.authority.permissionEpoch !== authority.permissionEpoch) return this.#revokeAs(record, now, "permission_changed");
      return { ok: true, record };
    });
  }

  invalidateForRebind(binding: { readonly site: string; readonly tenantId: string; readonly botId?: string }, now: number): number {
    return this.#transaction(() => {
      const records = (this.#db.prepare("SELECT payload_json FROM gateway_frappe_telegram_links WHERE state <> 'revoked'").all() as Array<{ payload_json?: unknown }>)
        .map((row) => typeof row.payload_json === "string" ? parseStoredLink(row.payload_json) : undefined)
        .filter((record): record is StoredFrappeTelegramLink => Boolean(record))
        .filter((record) => record.authority.site === binding.site && record.authority.tenantId === binding.tenantId
          && (binding.botId === undefined || record.authority.botId === binding.botId));
      for (const record of records) {
        record.state = "revoked";
        record.revokedAt = now;
        this.#save(record);
      }
      return records.length;
    });
  }

  claim(botId: string, updateId: string, now: number, ttlMs: number): boolean {
    return this.#transaction(() => {
      this.#db.prepare("DELETE FROM gateway_telegram_update_dedupe WHERE expires_at_ms <= ?").run(now);
      const result = this.#db.prepare(`
        INSERT OR IGNORE INTO gateway_telegram_update_dedupe(bot_id, update_id, expires_at_ms)
        VALUES (?, ?, ?)
      `).run(botId, updateId, now + ttlMs);
      return Number(result.changes ?? 0) === 1;
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #consume(record: StoredFrappeTelegramLink, observation: TelegramIdentityObservation, now: number): AtomicRedemption {
    if (record.state === "revoked") return denied("revoked");
    if (record.state !== "pending") return denied("replayed");
    if (record.expiresAt <= now) return this.#revokeAs(record, now, "expired");
    if (!record.allowedChatTypes.includes(observation.chatType)) return denied("chat_type");
    record.state = "awaiting_confirmation";
    record.redeemedAt = now;
    record.telegramUserId = observation.telegramUserId;
    record.telegramChatId = observation.telegramChatId;
    record.chatType = observation.chatType;
    this.#save(record);
    return { ok: true, record };
  }

  #revokeAs(record: StoredFrappeTelegramLink, now: number, reason: LinkDenialReason): AtomicRedemption {
    record.state = "revoked";
    record.revokedAt = now;
    this.#save(record);
    return denied(reason);
  }

  #byId(linkId: string): StoredFrappeTelegramLink | undefined {
    const row = this.#db.prepare("SELECT payload_json FROM gateway_frappe_telegram_links WHERE link_id = ?").get(linkId) as { payload_json?: unknown } | undefined;
    return typeof row?.payload_json === "string" ? parseStoredLink(row.payload_json) : undefined;
  }

  #byToken(tokenHash: string): StoredFrappeTelegramLink | undefined {
    const row = this.#db.prepare("SELECT payload_json FROM gateway_frappe_telegram_links WHERE token_hash = ?").get(tokenHash) as { payload_json?: unknown } | undefined;
    return typeof row?.payload_json === "string" ? parseStoredLink(row.payload_json) : undefined;
  }

  #active(): StoredFrappeTelegramLink[] {
    return (this.#db.prepare("SELECT payload_json FROM gateway_frappe_telegram_links WHERE state = 'active'").all() as Array<{ payload_json?: unknown }>)
      .map((row) => typeof row.payload_json === "string" ? parseStoredLink(row.payload_json) : undefined)
      .filter((record): record is StoredFrappeTelegramLink => Boolean(record));
  }

  #save(record: StoredFrappeTelegramLink): void {
    this.#db.prepare(`
      UPDATE gateway_frappe_telegram_links
      SET payload_json = ?, state = ?, expires_at_ms = ?
      WHERE link_id = ?
    `).run(JSON.stringify(record), record.state, record.expiresAt, record.linkId);
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
    if (this.#closed) throw new Error("Frappe Telegram link store is closed.");
  }
}

export interface FrappeTelegramLinkCoordinatorOptions {
  readonly store?: FrappeTelegramLinkStore;
  readonly updateDedupe?: TelegramUpdateDedupeStore;
  readonly now?: () => number;
  readonly audit?: (event: FrappeTelegramLinkAuditEvent) => void;
}

export class FrappeTelegramLinkCoordinator {
  readonly #store: FrappeTelegramLinkStore;
  readonly #updateDedupe: TelegramUpdateDedupeStore;
  readonly #now: () => number;
  readonly #audit?: (event: FrappeTelegramLinkAuditEvent) => void;

  constructor(options: FrappeTelegramLinkCoordinatorOptions = {}) {
    this.#store = options.store ?? new InMemoryFrappeTelegramLinkStore();
    this.#updateDedupe = options.updateDedupe ?? new InMemoryTelegramUpdateDedupeStore();
    this.#now = options.now ?? Date.now;
    this.#audit = options.audit;
  }

  issue(input: FrappeTelegramLinkIssue): FrappeTelegramLinkStart {
    const authority = normalizeAuthority(input);
    const allowedChatTypes = normalizeChatTypes(input.allowedChatTypes);
    const now = this.#now();
    const ttlMs = boundedTtl(input.ttlMs);
    const token = randomBytes(32).toString("base64url");
    const record: StoredFrappeTelegramLink = {
      linkId: randomUUID(),
      tokenHash: hashToken(token),
      authority,
      allowedChatTypes,
      issuedAt: now,
      expiresAt: now + ttlMs,
      state: "pending",
    };
    this.#store.insert(record);
    this.#audit?.({ action: "issued", linkId: record.linkId, site: authority.site, user: authority.user, tenantId: authority.tenantId, at: iso(now) });
    return { token, linkId: record.linkId, expiresAt: iso(record.expiresAt) };
  }

  redeem(input: FrappeTelegramRedemption): FrappeTelegramLinkResult<{ readonly linkId: string; readonly identity: { readonly telegramUserId: string; readonly telegramChatId: string; readonly chatType: TelegramChatType } }> {
    let authority: NormalizedFrappeTelegramAuthority;
    let observation: TelegramIdentityObservation;
    try {
      if (!OPAQUE_TOKEN.test(input.token)) return this.#deny("redeem", "malformed");
      authority = normalizeAuthority(input);
      observation = {
        telegramUserId: telegramInteger(input.telegramUserId, false),
        telegramChatId: telegramInteger(input.telegramChatId, true),
        chatType: chatType(input.chatType),
      };
    } catch {
      return this.#deny("redeem", "malformed");
    }
    const result = this.#store.redeem(hashToken(input.token), authority, observation, this.#now());
    if (!result.ok) return this.#deny("redeem", result.reason);
    this.#audit?.({ action: "redeemed", linkId: result.record.linkId, at: iso(this.#now()) });
    return {
      ok: true,
      value: { linkId: result.record.linkId, identity: observation },
    };
  }

  /** Redeem from Telegram-observed facts only; Frappe authority stays server-side in the hashed-token record. */
  redeemFromTelegram(input: ObservedTelegramRedemption): FrappeTelegramLinkResult<{ readonly linkId: string; readonly identity: TelegramIdentityObservation }> {
    let botId: string;
    let observation: TelegramIdentityObservation;
    try {
      if (!OPAQUE_TOKEN.test(input.token)) return this.#deny("redeem", "malformed");
      botId = telegramInteger(input.botId, false);
      observation = {
        telegramUserId: telegramInteger(input.telegramUserId, false),
        telegramChatId: telegramInteger(input.telegramChatId, true),
        chatType: chatType(input.chatType),
      };
    } catch {
      return this.#deny("redeem", "malformed");
    }
    const result = this.#store.redeemObserved(hashToken(input.token), botId, observation, this.#now());
    if (!result.ok) return this.#deny("redeem", result.reason);
    this.#audit?.({ action: "redeemed", linkId: result.record.linkId, at: iso(this.#now()) });
    return { ok: true, value: { linkId: result.record.linkId, identity: observation } };
  }

  confirm(input: FrappeTelegramConfirmation): FrappeTelegramLinkResult<FrappeTelegramIdentityLink> {
    let authority: NormalizedFrappeTelegramAuthority;
    try {
      authority = normalizeAuthority(input);
      requiredId(input.linkId, "linkId");
    } catch {
      return this.#deny("confirm", "malformed");
    }
    const result = this.#store.confirm(input.linkId, authority, this.#now());
    if (!result.ok) return this.#deny("confirm", result.reason);
    const value = publicLink(result.record);
    this.#audit?.({ action: "confirmed", linkId: result.record.linkId, at: value.linkedAt });
    return { ok: true, value };
  }

  revoke(input: FrappeTelegramRevocation): FrappeTelegramLinkResult<{ readonly linkId: string; readonly revokedAt: string }> {
    let request: FrappeTelegramRevocation;
    try {
      request = {
        linkId: requiredId(input.linkId, "linkId"),
        site: siteOrigin(input.site),
        user: requiredId(input.user, "user").toLowerCase(),
        tenantId: requiredId(input.tenantId, "tenantId"),
      };
    } catch {
      return this.#deny("revoke", "malformed");
    }
    const now = this.#now();
    const result = this.#store.revoke(request, now);
    if (!result.ok) return this.#deny("revoke", result.reason);
    this.#audit?.({ action: "revoked", linkId: result.record.linkId, at: iso(now) });
    return { ok: true, value: { linkId: result.record.linkId, revokedAt: iso(now) } };
  }

  resolveActive(linkId: string, authorityInput: FrappeTelegramAuthority): FrappeTelegramLinkResult<FrappeTelegramIdentityLink> {
    let authority: NormalizedFrappeTelegramAuthority;
    try {
      requiredId(linkId, "linkId");
      authority = normalizeAuthority(authorityInput);
    } catch {
      return this.#deny("resolve", "malformed");
    }
    const result = this.#store.resolve(linkId, authority, this.#now());
    if (!result.ok) return this.#deny("resolve", result.reason);
    return { ok: true, value: publicLink(result.record) };
  }

  invalidateForRebind(input: FrappeTelegramRebind): number {
    const binding = {
      site: siteOrigin(input.site),
      tenantId: requiredId(input.tenantId, "tenantId"),
      ...(input.botId === undefined ? {} : { botId: telegramInteger(input.botId, false) }),
    };
    const now = this.#now();
    const count = this.#store.invalidateForRebind(binding, now);
    this.#audit?.({ action: "rebind_invalidated", site: binding.site, tenantId: binding.tenantId, count, at: iso(now) });
    return count;
  }

  claimTelegramUpdate(botId: string, updateId: string, ttlMs = DEFAULT_UPDATE_TTL_MS): boolean {
    let normalizedBot: string;
    let normalizedUpdate: string;
    try {
      normalizedBot = telegramInteger(botId, false);
      normalizedUpdate = telegramInteger(updateId, false, true);
      if (!Number.isFinite(ttlMs)) return false;
    } catch {
      return false;
    }
    const boundedUpdateTtl = Math.max(60_000, Math.min(7 * 24 * 60 * 60_000, Math.trunc(ttlMs)));
    return this.#updateDedupe.claim(normalizedBot, normalizedUpdate, this.#now(), boundedUpdateTtl);
  }

  close(): void {
    this.#store.close?.();
    if ((this.#updateDedupe as object) !== (this.#store as object)) this.#updateDedupe.close?.();
  }

  #deny<T>(operation: "redeem" | "confirm" | "revoke" | "resolve", reason: LinkDenialReason): FrappeTelegramLinkResult<T> {
    this.#audit?.({ action: "denied", operation, reason, at: iso(this.#now()) });
    return LINK_DENIED;
  }
}

const LINK_DENIED = Object.freeze({
  ok: false as const,
  code: "link_denied" as const,
  message: "This Telegram identity link is unavailable. Start a new link from Frappe.",
});

function normalizeAuthority(input: FrappeTelegramAuthority): NormalizedFrappeTelegramAuthority {
  const scopes = [...new Set(input.scopes.map((scope) => requiredId(scope, "scope")))].sort();
  if (!scopes.length || scopes.length > 64) throw new Error("scopes are invalid");
  return {
    site: siteOrigin(input.site),
    user: requiredId(input.user, "user").toLowerCase(),
    tenantId: requiredId(input.tenantId, "tenantId"),
    botId: telegramInteger(input.botId, false),
    scopes,
    permissionEpoch: requiredId(input.permissionEpoch, "permissionEpoch"),
  };
}

function sameBindingExceptEpoch(left: NormalizedFrappeTelegramAuthority, right: NormalizedFrappeTelegramAuthority): boolean {
  return left.site === right.site
    && left.user === right.user
    && left.tenantId === right.tenantId
    && left.botId === right.botId
    && left.scopes.length === right.scopes.length
    && left.scopes.every((scope, index) => scope === right.scopes[index]);
}

function publicLink(record: StoredFrappeTelegramLink): FrappeTelegramIdentityLink {
  if (!record.telegramUserId || !record.telegramChatId || !record.chatType || !record.linkedAt) throw new Error("Active Telegram identity link is incomplete.");
  return {
    linkId: record.linkId,
    ...record.authority,
    telegramUserId: record.telegramUserId,
    telegramChatId: record.telegramChatId,
    chatType: record.chatType,
    linkedAt: iso(record.linkedAt),
  };
}

function normalizeChatTypes(values: readonly TelegramChatType[] | undefined): readonly TelegramChatType[] {
  const result = [...new Set((values ?? ["private"]).map(chatType))].sort();
  if (!result.length) throw new Error("allowedChatTypes cannot be empty");
  return result;
}

function chatType(value: TelegramChatType): TelegramChatType {
  if (value !== "private" && value !== "group" && value !== "supergroup" && value !== "channel") throw new Error("chatType is invalid");
  return value;
}

function telegramInteger(value: string, signed: boolean, allowZero = false): string {
  if (typeof value !== "string" || !(signed ? /^-?[0-9]{1,20}$/ : /^[0-9]{1,19}$/).test(value)) throw new Error("Telegram identifier is invalid");
  const parsed = BigInt(value);
  if ((!allowZero && parsed === 0n) || parsed > MAX_TELEGRAM_INTEGER || parsed < -MAX_TELEGRAM_INTEGER) throw new Error("Telegram identifier is out of range");
  return parsed.toString();
}

function requiredId(value: string, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} is required`);
  const normalized = value.trim();
  if (!SAFE_ID.test(normalized)) throw new Error(`${name} is invalid`);
  return normalized;
}

function siteOrigin(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== "/" && parsed.pathname !== "")) {
    throw new Error("site must be an HTTPS origin");
  }
  return parsed.origin;
}

function boundedTtl(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LINK_TTL_MS;
  if (!Number.isFinite(value)) throw new Error("ttlMs is invalid");
  return Math.max(MIN_LINK_TTL_MS, Math.min(MAX_LINK_TTL_MS, Math.trunc(value)));
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

function denied(reason: LinkDenialReason): AtomicRedemption {
  return { ok: false, reason };
}

function parseStoredLink(value: string): StoredFrappeTelegramLink {
  const record = JSON.parse(value) as StoredFrappeTelegramLink;
  if (!record || typeof record !== "object" || typeof record.linkId !== "string" || typeof record.tokenHash !== "string"
    || !record.authority || !Array.isArray(record.allowedChatTypes) || !Number.isSafeInteger(record.issuedAt)
    || !Number.isSafeInteger(record.expiresAt) || !["pending", "awaiting_confirmation", "active", "revoked"].includes(record.state)) {
    throw new Error("Stored Frappe Telegram identity link is invalid.");
  }
  return record;
}

export function openSqliteFrappeTelegramLinkCoordinator(
  filename: string,
  options: Pick<FrappeTelegramLinkCoordinatorOptions, "now" | "audit"> = {},
): FrappeTelegramLinkCoordinator {
  const store = new SqliteFrappeTelegramLinkStore(filename);
  return new FrappeTelegramLinkCoordinator({ ...options, store, updateDedupe: store });
}
