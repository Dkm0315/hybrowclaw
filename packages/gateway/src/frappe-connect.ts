import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const FRAPPE_SITE_AUTHORIZE_PATH = "/v1/frappe/site-bindings/authorize" as const;
export const FRAPPE_SITE_EXCHANGE_PATH = "/v1/frappe/site-bindings/exchange" as const;
export const FRAPPE_SITE_API_CREDENTIALS_PATH = "/v1/frappe/site-bindings/api-credentials" as const;
export const FRAPPE_SITE_VERIFY_PATH = "/v1/frappe/site-bindings/verify" as const;
export const FRAPPE_SITE_BOOTSTRAP_CLIENT_ID = "frappe-site-bootstrap" as const;

const CODE_TTL_MS = 5 * 60_000;
const VERIFY_TTL_MS = 5 * 60_000;
const API_NONCE_TTL_MS = 15 * 60_000;
const SAFE_OPAQUE = /^[A-Za-z0-9._~-]{16,512}$/;
const SAFE_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export interface FrappeSiteBindingSecrets {
  readonly accessToken: string;
  readonly hmacSecret: string;
  readonly webhookSecret: string;
}

export interface FrappeSiteBindingRecord {
  readonly bindingId: string;
  readonly tenantId: string;
  readonly siteOrigin: string;
  readonly siteUuid: string;
  readonly trustFingerprint: string;
  readonly gatewayChallenge: string;
  readonly siteChallenge: string;
  readonly verified: boolean;
  readonly createdAt: number;
  readonly secrets: FrappeSiteBindingSecrets;
}

export interface FrappeSiteBindingCoordinatorOptions {
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  /** Encrypted durable registry; both values are required together. */
  readonly storePath?: string;
  readonly encryptionSecret?: string;
}

interface PendingCode {
  readonly hash: string;
  readonly siteOrigin: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  consumed: boolean;
}

/** Strict, single-use reciprocal trust registry for Frappe-site bootstrap. */
export class FrappeSiteBindingCoordinator {
  readonly #fetcher: typeof fetch;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #storePath?: string;
  readonly #encryptionKey?: Buffer;
  readonly #codes = new Map<string, PendingCode>();
  readonly #bindings = new Map<string, FrappeSiteBindingRecord>();
  readonly #apiNonces = new Map<string, number>();
  readonly #states = new Map<string, number>();

  constructor(options: FrappeSiteBindingCoordinatorOptions = {}) {
    this.#fetcher = options.fetcher ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 10_000, 30_000));
    if (Boolean(options.storePath) !== Boolean(options.encryptionSecret)) throw new Error("Frappe site binding durable storage requires both storePath and encryptionSecret.");
    this.#storePath = options.storePath;
    this.#encryptionKey = options.encryptionSecret ? createHash("sha256").update(`muster-frappe-site-bindings-v1\0${options.encryptionSecret}`).digest() : undefined;
    this.#load();
  }

  authorize(url: URL): string {
    if (url.searchParams.get("response_type") !== "code") throw new FrappeSiteBindingError(400, "response_type must be code.");
    if (url.searchParams.get("client_id") !== FRAPPE_SITE_BOOTSTRAP_CLIENT_ID) throw new FrappeSiteBindingError(400, "client_id is invalid.");
    if (url.searchParams.get("code_challenge_method") !== "S256") throw new FrappeSiteBindingError(400, "PKCE S256 is required.");
    const siteOrigin = strictHttpsOrigin(requiredParam(url, "site_origin"), "site_origin");
    const redirectUri = exactSiteCallback(requiredParam(url, "redirect_uri"), siteOrigin);
    const state = boundedOpaque(requiredParam(url, "state"), "state", 4_096);
    const challenge = boundedOpaque(requiredParam(url, "code_challenge"), "code_challenge", 128);
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new FrappeSiteBindingError(400, "code_challenge is invalid.");
    this.#prune();
    const stateKey = hash(`${siteOrigin}\0${state}`);
    if (this.#states.has(stateKey)) throw new FrappeSiteBindingError(409, "OAuth state was already used.");
    this.#states.set(stateKey, this.#now() + CODE_TTL_MS);
    const code = randomBytes(32).toString("base64url");
    const now = this.#now();
    this.#codes.set(hash(code), { hash: hash(code), siteOrigin, redirectUri, challenge, createdAt: now, expiresAt: now + CODE_TTL_MS, consumed: false });
    this.#persist();
    const callback = new URL(redirectUri);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", state);
    return callback.toString();
  }

  async exchange(payload: unknown): Promise<Record<string, string>> {
    const value = object(payload);
    if (value.grant_type !== "authorization_code") throw new FrappeSiteBindingError(400, "grant_type is invalid.");
    const code = boundedOpaque(value.code, "code", 2_048);
    const key = hash(code);
    const pending = this.#codes.get(key);
    if (!pending || pending.consumed || pending.expiresAt <= this.#now()) throw new FrappeSiteBindingError(400, "Authorization code is invalid, expired, or already used.");
    // Consume before validating the rest so a guessed or intercepted code gets one attempt.
    pending.consumed = true;
    this.#persist();
    const verifier = boundedOpaque(value.code_verifier, "code_verifier", 512);
    if (!constantEqual(createHash("sha256").update(verifier).digest("base64url"), pending.challenge)) throw new FrappeSiteBindingError(400, "PKCE verification failed.");
    const siteOrigin = strictHttpsOrigin(required(value.site_origin, "site_origin", 500), "site_origin");
    const redirectUri = exactSiteCallback(required(value.redirect_uri, "redirect_uri", 1_000), siteOrigin);
    if (siteOrigin !== pending.siteOrigin || redirectUri !== pending.redirectUri) throw new FrappeSiteBindingError(409, "Authorization site or redirect mismatch.");
    return this.#issue(value, siteOrigin);
  }

  async exchangeApiCredentials(payload: unknown): Promise<Record<string, string>> {
    const value = object(payload);
    if (value.grant_type !== "api_credentials") throw new FrappeSiteBindingError(400, "grant_type is invalid.");
    const siteOrigin = strictHttpsOrigin(required(value.site_origin, "site_origin", 500), "site_origin");
    const apiKey = required(value.api_key, "api_key", 1_024);
    const apiSecret = required(value.api_secret, "api_secret", 4_096);
    const nonce = boundedOpaque(value.nonce, "nonce", 256);
    const nonceKey = hash(`${siteOrigin}\0${nonce}`);
    this.#prune();
    if (this.#apiNonces.has(nonceKey)) throw new FrappeSiteBindingError(409, "API credential nonce was already used.");
    this.#apiNonces.set(nonceKey, this.#now() + API_NONCE_TTL_MS);
    this.#persist();
    await this.#validateApiCredentials(siteOrigin, apiKey, apiSecret);
    return this.#issue(value, siteOrigin);
  }

  verify(accessToken: string, payload: unknown): Record<string, string | boolean> {
    const binding = this.authorization(accessToken, true);
    const value = object(payload);
    const echoes = {
      siteChallenge: required(value.site_challenge, "site_challenge", 256),
      gatewayChallenge: required(value.gateway_challenge, "gateway_challenge", 256),
      tenantId: required(value.tenant_id, "tenant_id", 256),
      bindingId: required(value.binding_id, "binding_id", 256),
      siteUuid: validUuid(value.site_uuid),
      siteOrigin: strictHttpsOrigin(required(value.site_origin, "site_origin", 500), "site_origin"),
    };
    if (
      !constantEqual(echoes.siteChallenge, binding.siteChallenge)
      || !constantEqual(echoes.gatewayChallenge, binding.gatewayChallenge)
      || !constantEqual(echoes.tenantId, binding.tenantId)
      || !constantEqual(echoes.bindingId, binding.bindingId)
      || !constantEqual(echoes.siteUuid, binding.siteUuid)
      || !constantEqual(echoes.siteOrigin, binding.siteOrigin)
      || this.#now() - binding.createdAt > VERIFY_TTL_MS
    ) throw new FrappeSiteBindingError(403, "Reciprocal binding verification failed.");
    const verified: FrappeSiteBindingRecord = { ...binding, verified: true };
    this.#bindings.set(binding.bindingId, verified);
    this.#persist();
    return {
      verified: true,
      site_challenge: verified.siteChallenge,
      gateway_challenge: verified.gatewayChallenge,
      tenant_id: verified.tenantId,
      binding_id: verified.bindingId,
      trust_fingerprint: verified.trustFingerprint,
    };
  }

  authorization(accessToken: string, includePending = false): FrappeSiteBindingRecord {
    const matches = [...this.#bindings.values()].filter((binding) => constantEqual(binding.secrets.accessToken, accessToken));
    if (matches.length !== 1 || (!includePending && !matches[0]!.verified)) throw new FrappeSiteBindingError(401, "Frappe site binding bearer is invalid.");
    return matches[0]!;
  }

  verifiedBindings(): readonly Omit<FrappeSiteBindingRecord, "secrets" | "siteChallenge" | "gatewayChallenge">[] {
    this.#prune();
    return [...this.#bindings.values()]
      .filter((binding) => binding.verified)
      .map(({ secrets: _secrets, siteChallenge: _siteChallenge, gatewayChallenge: _gatewayChallenge, ...binding }) => binding)
      .sort((left, right) => left.siteOrigin.localeCompare(right.siteOrigin));
  }

  /** Internal-only lookup used by the fixed Frappe callback transport. */
  verifiedBinding(input: { readonly tenantId: string; readonly siteUuid: string; readonly siteOrigin: string }): FrappeSiteBindingRecord | undefined {
    this.#prune();
    const matches = [...this.#bindings.values()].filter((binding) =>
      binding.verified
      && constantEqual(binding.tenantId, input.tenantId)
      && constantEqual(binding.siteUuid, input.siteUuid)
      && constantEqual(binding.siteOrigin, strictHttpsOrigin(input.siteOrigin, "site_origin")),
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  #issue(value: Record<string, unknown>, siteOrigin: string): Record<string, string> {
    const siteUuid = validUuid(value.site_uuid);
    const siteChallenge = boundedOpaque(value.site_challenge, "site_challenge", 256);
    const existing = [...this.#bindings.values()].find((binding) => binding.siteUuid === siteUuid);
    if (existing && existing.siteOrigin !== siteOrigin) throw new FrappeSiteBindingError(409, "site_uuid is already registered to a different origin.");
    const bindingId = existing?.bindingId ?? `binding-${randomBytes(16).toString("hex")}`;
    const tenantId = existing?.tenantId ?? `tenant-${createHash("sha256").update(siteUuid).digest("hex").slice(0, 24)}`;
    const accessToken = randomBytes(32).toString("base64url");
    const hmacSecret = randomBytes(32).toString("base64url");
    const webhookSecret = randomBytes(32).toString("base64url");
    const gatewayChallenge = randomBytes(32).toString("base64url");
    const trustFingerprint = `sha256:${createHash("sha256").update([bindingId, tenantId, siteUuid, siteOrigin, siteChallenge, gatewayChallenge].join("\0")).digest("hex")}`;
    const binding: FrappeSiteBindingRecord = {
      bindingId, tenantId, siteOrigin, siteUuid, trustFingerprint, gatewayChallenge, siteChallenge,
      verified: false, createdAt: this.#now(), secrets: { accessToken, hmacSecret, webhookSecret },
    };
    this.#bindings.set(bindingId, binding);
    this.#persist();
    return {
      access_token: accessToken,
      hmac_secret: hmacSecret,
      webhook_secret: webhookSecret,
      tenant_id: tenantId,
      binding_id: bindingId,
      gateway_challenge: gatewayChallenge,
      trust_fingerprint: trustFingerprint,
    };
  }

  async #validateApiCredentials(siteOrigin: string, apiKey: string, apiSecret: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    timer.unref?.();
    try {
      const response = await this.#fetcher(new URL("/api/method/frappe.auth.get_logged_user", siteOrigin), {
        method: "GET",
        headers: { authorization: `token ${apiKey}:${apiSecret}`, accept: "application/json" },
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) throw new FrappeSiteBindingError(502, "Frappe credential validation refused a redirect.");
      if (!response.ok) throw new FrappeSiteBindingError(403, "Frappe API credentials were rejected.");
      const raw = await response.text();
      if (Buffer.byteLength(raw) > 64_000) throw new FrappeSiteBindingError(502, "Frappe credential validation response was too large.");
      let decoded: unknown;
      try { decoded = JSON.parse(raw); } catch { throw new FrappeSiteBindingError(502, "Frappe credential validation returned invalid JSON."); }
      const payload = object(decoded);
      const user = typeof payload.message === "string" ? payload.message.trim() : "";
      if (!user || user === "Guest") throw new FrappeSiteBindingError(403, "Frappe API credentials did not resolve an authenticated user.");
    } finally { clearTimeout(timer); }
  }

  #prune(): void {
    const now = this.#now();
    let changed = false;
    for (const [key, code] of this.#codes) if (code.expiresAt <= now || code.consumed) { this.#codes.delete(key); changed = true; }
    for (const [key, binding] of this.#bindings) if (!binding.verified && now - binding.createdAt > VERIFY_TTL_MS) { this.#bindings.delete(key); changed = true; }
    for (const [key, expiresAt] of this.#apiNonces) if (expiresAt <= now) { this.#apiNonces.delete(key); changed = true; }
    for (const [key, expiresAt] of this.#states) if (expiresAt <= now) { this.#states.delete(key); changed = true; }
    if (changed) this.#persist();
  }

  #load(): void {
    if (!this.#storePath || !this.#encryptionKey) return;
    let envelope: { v: number; iv: string; tag: string; ciphertext: string };
    try { envelope = JSON.parse(readFileSync(this.#storePath, "utf8")) as typeof envelope; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (envelope.v !== 1) throw new Error("Unsupported Frappe site binding registry version.");
    const decipher = createDecipheriv("aes-256-gcm", this.#encryptionKey, Buffer.from(envelope.iv, "base64url"));
    decipher.setAAD(Buffer.from("muster-frappe-site-bindings-v1"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const decoded = JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final(),
    ]).toString("utf8")) as { codes?: PendingCode[]; bindings?: FrappeSiteBindingRecord[]; apiNonces?: Array<[string, number]>; states?: Array<[string, number]> };
    for (const code of decoded.codes ?? []) this.#codes.set(code.hash, code);
    for (const binding of decoded.bindings ?? []) this.#bindings.set(binding.bindingId, binding);
    for (const [key, expiresAt] of decoded.apiNonces ?? []) this.#apiNonces.set(key, expiresAt);
    for (const [key, expiresAt] of decoded.states ?? []) this.#states.set(key, expiresAt);
    this.#prune();
  }

  #persist(): void {
    if (!this.#storePath || !this.#encryptionKey) return;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#encryptionKey, iv);
    cipher.setAAD(Buffer.from("muster-frappe-site-bindings-v1"));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ codes: [...this.#codes.values()], bindings: [...this.#bindings.values()], apiNonces: [...this.#apiNonces.entries()], states: [...this.#states.entries()] })), cipher.final()]);
    const envelope = { v: 1, iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") };
    mkdirSync(dirname(this.#storePath), { recursive: true, mode: 0o700 });
    chmodSync(dirname(this.#storePath), 0o700);
    const temporary = `${this.#storePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
    renameSync(temporary, this.#storePath);
    chmodSync(this.#storePath, 0o600);
  }
}

export class FrappeSiteBindingError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = "FrappeSiteBindingError"; }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FrappeSiteBindingError(400, "Request body must be a JSON object.");
  return value as Record<string, unknown>;
}
function required(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new FrappeSiteBindingError(400, `${field} is invalid.`);
  return value.trim();
}
function requiredParam(url: URL, field: string): string { return required(url.searchParams.get(field), field, 4_096); }
function boundedOpaque(value: unknown, field: string, maximum: number): string {
  const text = required(value, field, maximum);
  if (!SAFE_OPAQUE.test(text)) throw new FrappeSiteBindingError(400, `${field} is invalid.`);
  return text;
}
function strictHttpsOrigin(value: string, field: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new FrappeSiteBindingError(400, `${field} must be an exact HTTPS origin.`); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) throw new FrappeSiteBindingError(400, `${field} must be an exact HTTPS origin.`);
  return url.origin;
}
function exactSiteCallback(value: string, siteOrigin: string): string {
  const callback = new URL(value);
  if (callback.origin !== siteOrigin || callback.pathname !== "/muster-connect" || callback.search || callback.hash) throw new FrappeSiteBindingError(400, "redirect_uri must be the exact Frappe /muster-connect callback.");
  return callback.toString();
}
function validUuid(value: unknown): string {
  const uuid = required(value, "site_uuid", 64).toLowerCase();
  if (!SAFE_UUID.test(uuid)) throw new FrappeSiteBindingError(400, "site_uuid is invalid.");
  return uuid;
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function constantEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
