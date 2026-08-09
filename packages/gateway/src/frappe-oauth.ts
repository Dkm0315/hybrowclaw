import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { dataDir } from "@musterhq/core";
import { MAX_FRAPPE_IDENTITY_ROLES, type PairedIdentity } from "./pairing.js";

const VAULT_VERSION = 1;
const VAULT_AAD = Buffer.from("muster-frappe-oauth-v1", "utf8");
const DEFAULT_STATE_TTL_MS = 5 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_IDENTITY_TTL_MS = 60_000;
const SAFE_STATE = /^[A-Za-z0-9_-]{43,128}$/;
const GATEWAY_CALLBACK_PATHS = new Set(["/v1/frappe/oauth/callback", "/frappe2/oauth/callback"]);

export interface FrappeOAuthConnectionConfig {
  readonly id: string;
  /** Mode-0600 JSON containing site, clientId, clientSecret, and redirectUri. */
  readonly credentialFile: string;
  readonly scope?: string;
  readonly stateTtlMs?: number;
  readonly requestTimeoutMs?: number;
  /** Maximum age of cached roles/employee scope before Frappe is queried again. */
  readonly identityTtlMs?: number;
  /** Gateway callbacks are preferred; "frappe" polls a site-hosted callback bridge. */
  readonly callbackMode?: "gateway" | "frappe";
  readonly resultPath?: string;
  readonly identityPath?: string;
}

export interface FrappeOAuthConnectionInspection {
  readonly id: string;
  readonly site: string;
  readonly callbackMode: "gateway" | "frappe";
  readonly redirectUri: string;
  readonly resultPath?: string;
  readonly identityPath?: string;
  readonly identityTtlMs: number;
}

export interface FrappeOAuthActor {
  readonly surfaceId: string;
  readonly senderId: string;
  readonly pairingId: string;
}

export interface FrappeOAuthStart {
  readonly status: "authorization_required";
  readonly connectionId: string;
  readonly authorizationUrl: string;
  readonly expiresAt: string;
}

export type FrappeOAuthCompletion =
  | { readonly status: "pending"; readonly expiresAt: string }
  | { readonly status: "expired" }
  | { readonly status: "connected"; readonly identity: Omit<PairedIdentity, "provider" | "resolvedAt"> };

export interface FrappeOAuthAuthorization {
  readonly connectionId: string;
  readonly site: string;
  readonly header: string;
  readonly identity: Omit<PairedIdentity, "provider" | "resolvedAt">;
  readonly expiresAt?: number;
}

export interface FrappeOAuthCallbackCompletion {
  readonly connectionId: string;
  readonly surfaceId: string;
  readonly senderId: string;
  readonly pairingId: string;
  readonly identity: Omit<PairedIdentity, "provider" | "resolvedAt">;
}

export interface FrappeOAuthCoordinatorOptions {
  readonly connections: readonly FrappeOAuthConnectionConfig[];
  readonly cwd?: string;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface CredentialFile {
  readonly site: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly redirectUri: string;
}

interface PendingGrant {
  readonly actorKey: string;
  readonly connectionId: string;
  readonly surfaceId: string;
  readonly senderId: string;
  readonly pairingId: string;
  readonly state: string;
  readonly verifier: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

interface StoredGrant {
  readonly actorKey: string;
  readonly connectionId: string;
  readonly surfaceId: string;
  readonly senderId: string;
  readonly pairingId: string;
  readonly site: string;
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly tokenType: string;
  readonly scope?: string;
  readonly obtainedAt: number;
  readonly expiresAt?: number;
  readonly identity: Omit<PairedIdentity, "provider" | "resolvedAt">;
  readonly identityResolvedAt?: number;
}

interface OAuthVault {
  readonly version: 1;
  readonly pending: readonly PendingGrant[];
  readonly grants: readonly StoredGrant[];
}

interface EncryptedVault {
  readonly version: 1;
  readonly algorithm: "aes-256-gcm";
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

interface TokenResponse {
  readonly access_token?: unknown;
  readonly refresh_token?: unknown;
  readonly token_type?: unknown;
  readonly expires_in?: unknown;
  readonly scope?: unknown;
}

interface CallbackResult {
  readonly status?: unknown;
  readonly code?: unknown;
  readonly error?: unknown;
}

export class FrappeOAuthCoordinator {
  readonly #connections: Map<string, FrappeOAuthConnectionConfig>;
  readonly #cwd: string;
  readonly #fetcher: typeof fetch;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #vaultPath: string;
  readonly #keyPath: string;

  constructor(options: FrappeOAuthCoordinatorOptions) {
    this.#connections = new Map(options.connections.map((connection) => [validateConnectionId(connection.id), connection]));
    if (this.#connections.size !== options.connections.length) throw new Error("Frappe OAuth connection ids must be unique.");
    this.#cwd = options.cwd ?? process.cwd();
    this.#fetcher = options.fetcher ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
    this.#vaultPath = join(dataDir(this.#cwd), "frappe-oauth.v1.enc.json");
    this.#keyPath = join(dataDir(this.#cwd), "secrets", "frappe-oauth.v1.key");
  }

  connectionIds(): readonly string[] {
    return [...this.#connections.keys()];
  }

  async start(connectionId: string, actor: FrappeOAuthActor): Promise<FrappeOAuthStart> {
    const config = this.#connection(connectionId);
    const credential = await readCredential(config, this.#cwd);
    const currentTime = this.#now();
    const ttlMs = bounded(config.stateTtlMs, DEFAULT_STATE_TTL_MS, 60_000, 10 * 60_000);
    const pending: PendingGrant = {
      actorKey: actorKey(connectionId, actor),
      connectionId,
      surfaceId: required(actor.surfaceId, "surfaceId", 180),
      senderId: required(actor.senderId, "senderId", 254),
      pairingId: required(actor.pairingId, "pairingId", 180),
      state: randomBytes(32).toString("base64url"),
      verifier: randomBytes(64).toString("base64url"),
      createdAt: currentTime,
      expiresAt: currentTime + ttlMs,
    };
    const challenge = createHash("sha256").update(pending.verifier).digest("base64url");
    const authorizationUrl = new URL("/api/method/frappe.integrations.oauth2.authorize", credential.site);
    authorizationUrl.search = new URLSearchParams({
      client_id: credential.clientId,
      scope: config.scope?.trim() || "all openid",
      response_type: "code",
      redirect_uri: credential.redirectUri,
      state: pending.state,
      code_challenge_method: "S256",
      code_challenge: challenge,
    }).toString();
    await this.#updateVault((vault) => ({
      ...vault,
      pending: [...vault.pending.filter((item) => item.actorKey !== pending.actorKey && item.expiresAt > currentTime), pending],
      grants: vault.grants,
    }));
    return {
      status: "authorization_required",
      connectionId,
      authorizationUrl: authorizationUrl.toString(),
      expiresAt: new Date(pending.expiresAt).toISOString(),
    };
  }

  async complete(connectionId: string, actor: FrappeOAuthActor): Promise<FrappeOAuthCompletion> {
    const config = this.#connection(connectionId);
    const key = actorKey(connectionId, actor);
    const initial = await this.#readVault();
    const connected = initial.grants.find((item) => item.actorKey === key);
    if (connected) return { status: "connected", identity: (await this.#activeAuthorization(connected)).identity };
    const pending = initial.pending.find((item) => item.actorKey === key);
    if (!pending) return { status: "expired" };
    if (pending.expiresAt <= this.#now()) {
      await this.#updateVault((vault) => ({ ...vault, pending: vault.pending.filter((item) => item.actorKey !== key) }));
      return { status: "expired" };
    }
    if ((config.callbackMode ?? "gateway") === "gateway") {
      return { status: "pending", expiresAt: new Date(pending.expiresAt).toISOString() };
    }
    const credential = await readCredential(config, this.#cwd);
    const result = await this.#consumeCallback(config, credential, pending.state);
    if (result.status === "pending") return { status: "pending", expiresAt: new Date(pending.expiresAt).toISOString() };
    if (result.status !== "ready" || typeof result.code !== "string" || !result.code) {
      throw new Error(`Frappe authorization failed${typeof result.error === "string" && result.error ? `: ${boundedError(result.error)}` : "."}`);
    }
    const token = await this.#exchangeCode(config, credential, result.code, pending.verifier);
    const identity = await this.#resolveIdentity(config, credential, token.accessToken);
    const grant: StoredGrant = {
      actorKey: key,
      connectionId,
      surfaceId: actor.surfaceId,
      senderId: actor.senderId,
      pairingId: actor.pairingId,
      site: credential.site,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      tokenType: token.tokenType,
      scope: token.scope,
      obtainedAt: this.#now(),
      expiresAt: token.expiresAt,
      identity,
      identityResolvedAt: this.#now(),
    };
    await this.#updateVault((vault) => {
      const stillPending = vault.pending.some((item) => item.actorKey === key && item.state === pending.state);
      const alreadyConnected = vault.grants.find((item) => item.actorKey === key);
      if (!stillPending && !alreadyConnected) throw new Error("Frappe OAuth state was revoked before token persistence.");
      return {
        ...vault,
        pending: vault.pending.filter((item) => item.actorKey !== key),
        grants: [...vault.grants.filter((item) => item.actorKey !== key), alreadyConnected ?? grant],
      };
    });
    return { status: "connected", identity };
  }

  async completeCallback(requestUrl: string): Promise<FrappeOAuthCallbackCompletion> {
    const parsed = new URL(requestUrl, "https://muster.invalid");
    const state = parsed.searchParams.get("state") ?? "";
    const code = parsed.searchParams.get("code") ?? "";
    const oauthError = parsed.searchParams.get("error") ?? "";
    if (!SAFE_STATE.test(state)) throw new Error("Frappe OAuth callback state is invalid.");

    const initial = await this.#readVault();
    const pending = initial.pending.find((item) => item.state === state);
    if (!pending || pending.expiresAt <= this.#now()) throw new Error("Frappe OAuth state is unknown or expired.");
    if (oauthError) {
      await this.#updateVault((vault) => ({ ...vault, pending: vault.pending.filter((item) => item.state !== state) }));
      throw new Error(`Frappe authorization was denied: ${boundedError(oauthError)}`);
    }
    if (!code) throw new Error("Frappe OAuth callback is missing an authorization code.");

    try {
      const config = this.#connection(pending.connectionId);
      if ((config.callbackMode ?? "gateway") !== "gateway") throw new Error("This Frappe connection does not accept gateway callbacks.");
      const credential = await readCredential(config, this.#cwd);
      const expectedRedirect = new URL(credential.redirectUri);
      // IncomingMessage.url is normally a relative request target. Resolve it
      // against the configured public callback so gateway callbacks work
      // behind a reverse proxy or tunnel. Absolute URLs still retain their
      // own origin and are rejected below when they do not match.
      const callbackUrl = new URL(requestUrl, expectedRedirect);
      if (
        callbackUrl.origin !== expectedRedirect.origin
        || callbackUrl.pathname !== expectedRedirect.pathname
        || callbackUrl.hash
      ) throw new Error("Frappe OAuth callback does not match the configured redirect URI.");
      const token = await this.#exchangeCode(config, credential, code, pending.verifier);
      const identity = await this.#resolveIdentity(config, credential, token.accessToken);
      const grant: StoredGrant = {
        actorKey: pending.actorKey,
        connectionId: pending.connectionId,
        surfaceId: pending.surfaceId,
        senderId: pending.senderId,
        pairingId: pending.pairingId,
        site: credential.site,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        tokenType: token.tokenType,
        scope: token.scope,
        obtainedAt: this.#now(),
        expiresAt: token.expiresAt,
        identity,
        identityResolvedAt: this.#now(),
      };
      await this.#updateVault((vault) => {
        if (!vault.pending.some((item) => item.state === state && item.actorKey === pending.actorKey)) {
          throw new Error("Frappe OAuth state was already consumed or revoked.");
        }
        return {
          ...vault,
          pending: vault.pending.filter((item) => item.state !== state),
          grants: [...vault.grants.filter((item) => item.actorKey !== pending.actorKey), grant],
        };
      });
      return {
        connectionId: pending.connectionId,
        surfaceId: pending.surfaceId,
        senderId: pending.senderId,
        pairingId: pending.pairingId,
        identity,
      };
    } catch (error) {
      // Exchange/profile failures are terminal for this one-time consent. Do
      // not leave a link that can appear pending after a failed reconnect.
      await this.#updateVault((vault) => ({
        ...vault,
        pending: vault.pending.filter((item) => item.state !== state),
      })).catch(() => undefined);
      throw error;
    }
  }

  async authorization(connectionId: string, actor: FrappeOAuthActor): Promise<FrappeOAuthAuthorization | undefined> {
    const key = actorKey(connectionId, actor);
    let grant = (await this.#readVault()).grants.find((item) => item.actorKey === key);
    if (!grant) return undefined;
    return this.#activeAuthorization(grant);
  }

  /**
   * Resolve the exact stored grant for a paired channel actor. The expected
   * site prevents a sender with grants for multiple customers from silently
   * using the wrong tenant. Ambiguity fails closed.
   */
  async authorizationForActor(actor: FrappeOAuthActor, expectedSite?: string): Promise<FrappeOAuthAuthorization | undefined> {
    const site = expectedSite ? normalizedOrigin(expectedSite) : undefined;
    const matches = (await this.#readVault()).grants.filter((grant) =>
      grant.surfaceId === required(actor.surfaceId, "surfaceId", 180)
      && grant.senderId === required(actor.senderId, "senderId", 254)
      && grant.pairingId === required(actor.pairingId, "pairingId", 180)
      && (!site || normalizedOrigin(grant.site) === site));
    if (matches.length > 1) throw new Error("Multiple Frappe OAuth grants match this channel identity; select a connection explicitly.");
    return matches[0] ? this.#activeAuthorization(matches[0]) : undefined;
  }

  /**
   * Return at most one metadata-capable grant per site for the host's
   * background schema indexer. This never grants record access to another
   * actor: the resulting index contains metadata only, while every live read
   * and write still resolves the exact channel actor through
   * authorizationForActor().
   */
  async metadataAuthorizations(): Promise<readonly FrappeOAuthAuthorization[]> {
    const grants = (await this.#readVault()).grants;
    const bySite = new Map<string, StoredGrant[]>();
    for (const grant of grants) {
      const site = normalizedOrigin(grant.site);
      bySite.set(site, [...(bySite.get(site) ?? []), grant]);
    }
    const results: FrappeOAuthAuthorization[] = [];
    for (const candidates of bySite.values()) {
      const ordered = [...candidates].sort((left, right) =>
        metadataGrantScore(right) - metadataGrantScore(left)
        || right.obtainedAt - left.obtainedAt
        || left.actorKey.localeCompare(right.actorKey));
      for (const candidate of ordered) {
        try {
          results.push(await this.#activeAuthorization(candidate));
          break;
        } catch {
          // A stale user's grant must not stop metadata refresh for another
          // valid grant on the same site.
        }
      }
    }
    return results.sort((left, right) => left.site.localeCompare(right.site));
  }

  async disconnect(connectionId: string, actor: FrappeOAuthActor): Promise<boolean> {
    const key = actorKey(connectionId, actor);
    let removed = false;
    await this.#updateVault((vault) => {
      removed = vault.pending.some((item) => item.actorKey === key) || vault.grants.some((item) => item.actorKey === key);
      return {
        ...vault,
        pending: vault.pending.filter((item) => item.actorKey !== key),
        grants: vault.grants.filter((item) => item.actorKey !== key),
      };
    });
    return removed;
  }

  async #activeAuthorization(input: StoredGrant): Promise<FrappeOAuthAuthorization> {
    const config = this.#connection(input.connectionId);
    let grant = input.expiresAt !== undefined && input.expiresAt <= this.#now() + 30_000
      ? await this.#refresh(input.connectionId, input)
      : input;
    const currentTime = this.#now();
    const identityTtlMs = bounded(config.identityTtlMs, DEFAULT_IDENTITY_TTL_MS, 5_000, 5 * 60_000);
    if (grant.identityResolvedAt === undefined || currentTime - grant.identityResolvedAt >= identityTtlMs) {
      const credential = await readCredential(config, this.#cwd);
      const identity = await this.#resolveIdentity(config, credential, grant.accessToken);
      grant = { ...grant, identity, identityResolvedAt: currentTime };
      const refreshedIdentity = grant;
      await this.#updateVault((vault) => ({
        ...vault,
        grants: vault.grants.map((item) => item.actorKey === refreshedIdentity.actorKey ? refreshedIdentity : item),
      }));
    }
    if (!grant.identity.displayNamesResolvedAt) {
      const identity = await this.#resolveDisplayNames(grant.identity, grant.accessToken);
      grant = { ...grant, identity };
      const enriched = grant;
      await this.#updateVault((vault) => ({
        ...vault,
        grants: vault.grants.map((item) => item.actorKey === enriched.actorKey ? enriched : item),
      }));
    }
    return {
      connectionId: grant.connectionId,
      site: grant.site,
      header: `${grant.tokenType} ${grant.accessToken}`,
      identity: grant.identity,
      expiresAt: grant.expiresAt,
    };
  }

  async #consumeCallback(config: FrappeOAuthConnectionConfig, credential: CredentialFile, state: string): Promise<CallbackResult> {
    const path = validFrappeMethodPath(
      config.resultPath ?? "/api/method/nextai.muster_oauth.consume_oauth_result",
      "resultPath",
    );
    const payload = await requestJson(this.#fetcher, new URL(path, credential.site), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ state }),
    }, bounded(config.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 1_000, 15_000));
    return object(payload.message ?? payload) as CallbackResult;
  }

  async #exchangeCode(
    config: FrappeOAuthConnectionConfig,
    credential: CredentialFile,
    code: string,
    verifier: string,
  ): Promise<{ accessToken: string; refreshToken?: string; tokenType: string; scope?: string; expiresAt?: number }> {
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: credential.redirectUri,
      client_id: credential.clientId,
      scope: config.scope?.trim() || "all openid",
      code_verifier: verifier,
      ...(credential.clientSecret ? { client_secret: credential.clientSecret } : {}),
    });
    const payload = await requestJson(this.#fetcher, new URL("/api/method/frappe.integrations.oauth2.get_token", credential.site), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: params.toString(),
    }, bounded(config.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 1_000, 15_000));
    const token = payload as TokenResponse;
    const accessToken = typeof token.access_token === "string" ? token.access_token.trim() : "";
    if (!accessToken) throw new Error("Frappe did not return an OAuth access token.");
    const expiresIn = finiteNumber(token.expires_in);
    return {
      accessToken,
      refreshToken: optionalString(token.refresh_token),
      tokenType: optionalString(token.token_type) ?? "Bearer",
      scope: optionalString(token.scope),
      expiresAt: expiresIn === undefined ? undefined : this.#now() + Math.max(0, expiresIn * 1000),
    };
  }

  async #resolveIdentity(
    config: FrappeOAuthConnectionConfig,
    credential: CredentialFile,
    accessToken: string,
  ): Promise<Omit<PairedIdentity, "provider" | "resolvedAt">> {
    if (!config.identityPath) return await this.#resolveStandardIdentity(config, credential, accessToken);
    const identityPath = validFrappeMethodPath(config.identityPath, "identityPath");
    const payload = await requestJson(this.#fetcher, new URL(identityPath, credential.site), {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    }, bounded(config.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 1_000, 15_000));
    const identity = object(payload.message ?? payload);
    const site = normalizedOrigin(required(identity.site, "identity.site", 500));
    if (site !== credential.site) throw new Error("Frappe OAuth identity site does not match the configured site.");
    const roles = stringArray(identity.roles, "identity.roles", MAX_FRAPPE_IDENTITY_ROLES, 140);
    if (!roles.length) throw new Error("Frappe OAuth identity returned no roles.");
    return await this.#resolveDisplayNames({
      site,
      user: required(identity.user, "identity.user", 254),
      roles,
      authMode: "oauth_bearer",
      ...optionalIdentity(identity, "userName"),
      ...optionalIdentity(identity, "employee"),
      ...optionalIdentity(identity, "employeeName"),
      ...optionalIdentity(identity, "employeeStatus"),
      ...optionalIdentity(identity, "reportsTo"),
      ...optionalIdentity(identity, "reportsToName"),
      ...optionalIdentity(identity, "department"),
      ...optionalIdentity(identity, "departmentName"),
      ...optionalIdentity(identity, "company"),
      ...optionalIdentity(identity, "permissionHash"),
      ...optionalIdentity(identity, "rolesHash"),
    }, accessToken);
  }

  async #resolveStandardIdentity(
    config: FrappeOAuthConnectionConfig,
    credential: CredentialFile,
    accessToken: string,
  ): Promise<Omit<PairedIdentity, "provider" | "resolvedAt">> {
    const timeout = bounded(config.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 1_000, 15_000);
    const profile = await requestJson(this.#fetcher, new URL("/api/method/frappe.integrations.oauth2.openid_profile", credential.site), {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    }, timeout);
    const issuer = optionalString(profile.iss);
    if (issuer && !matchesConfiguredIssuer(issuer, credential.site)) {
      throw new Error("Frappe OAuth profile issuer does not match the configured site.");
    }
    const user = optionalString(profile.email) ?? optionalString(profile.sub);
    if (!user) throw new Error("Frappe OAuth profile did not return a user email.");
    const roles = stringArray(profile.roles, "profile.roles", MAX_FRAPPE_IDENTITY_ROLES, 140);
    if (!roles.length) throw new Error("Frappe OAuth profile returned no roles.");

    const employeeUrl = new URL("/api/resource/Employee", credential.site);
    employeeUrl.search = new URLSearchParams({
      fields: JSON.stringify(["name", "employee_name", "department", "company", "status", "reports_to"]),
      filters: JSON.stringify([["user_id", "=", user]]),
      limit_page_length: "2",
    }).toString();
    const employeePayload = await requestJson(this.#fetcher, employeeUrl, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    }, timeout);
    const rows = Array.isArray(employeePayload.data) ? employeePayload.data.map(object) : [];
    if (rows.length > 1) throw new Error("Multiple Employee records map to this Frappe user. Pairing is blocked until the duplicate mapping is corrected.");
    const employee = rows[0];
    const rolesHash = createHash("sha256").update(roles.join("\0")).digest("hex");
    const permissionHash = createHash("sha256").update(JSON.stringify({ site: credential.site, user, rolesHash, employee })).digest("hex");
    return await this.#resolveDisplayNames({
      site: credential.site,
      user,
      ...optionalIdentity(profile, "userName", "name"),
      roles,
      authMode: "oauth_bearer",
      ...(employee ? optionalIdentity(employee, "employeeName", "employee_name") : {}),
      ...(employee ? optionalIdentity(employee, "employee", "name") : {}),
      ...(employee ? optionalIdentity(employee, "employeeStatus", "status") : {}),
      ...(employee ? optionalIdentity(employee, "reportsTo", "reports_to") : {}),
      ...(employee ? optionalIdentity(employee, "department") : {}),
      ...(employee ? optionalIdentity(employee, "company") : {}),
      rolesHash,
      permissionHash,
    }, accessToken);
  }

  async #resolveDisplayNames(
    identity: Omit<PairedIdentity, "provider" | "resolvedAt">,
    accessToken: string,
  ): Promise<Omit<PairedIdentity, "provider" | "resolvedAt">> {
    const timeout = 2_500;
    const [departmentName, reportsToName] = await Promise.all([
      identity.departmentName ?? resolveFrappeLinkLabel(
        this.#fetcher,
        identity.site,
        accessToken,
        "Department",
        identity.department,
        ["department_name", "name"],
        timeout,
      ),
      identity.reportsToName ?? resolveFrappeLinkLabel(
        this.#fetcher,
        identity.site,
        accessToken,
        "Employee",
        identity.reportsTo,
        ["employee_name", "name"],
        timeout,
      ),
    ]);
    return {
      ...identity,
      ...(departmentName ? { departmentName } : {}),
      ...(reportsToName ? { reportsToName } : {}),
      displayNamesResolvedAt: new Date(this.#now()).toISOString(),
    };
  }

  async #refresh(connectionId: string, current: StoredGrant): Promise<StoredGrant> {
    if (!current.refreshToken) throw new Error("Frappe OAuth access expired and no refresh token is available. Run /connect again.");
    const config = this.#connection(connectionId);
    const credential = await readCredential(config, this.#cwd);
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      client_id: credential.clientId,
      ...(credential.clientSecret ? { client_secret: credential.clientSecret } : {}),
    });
    const payload = await requestJson(this.#fetcher, new URL("/api/method/frappe.integrations.oauth2.get_token", credential.site), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: params.toString(),
    }, bounded(config.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 1_000, 15_000));
    const token = payload as TokenResponse;
    const accessToken = optionalString(token.access_token);
    if (!accessToken) throw new Error("Frappe OAuth refresh did not return an access token. Run /connect again.");
    const expiresIn = finiteNumber(token.expires_in);
    const identity = await this.#resolveIdentity(config, credential, accessToken);
    const updated: StoredGrant = {
      ...current,
      accessToken,
      refreshToken: optionalString(token.refresh_token) ?? current.refreshToken,
      tokenType: optionalString(token.token_type) ?? current.tokenType,
      scope: optionalString(token.scope) ?? current.scope,
      obtainedAt: this.#now(),
      expiresAt: expiresIn === undefined ? undefined : this.#now() + Math.max(0, expiresIn * 1000),
      identity,
      identityResolvedAt: this.#now(),
    };
    await this.#updateVault((vault) => ({
      ...vault,
      grants: vault.grants.map((item) => item.actorKey === current.actorKey ? updated : item),
    }));
    return updated;
  }

  #connection(id: string): FrappeOAuthConnectionConfig {
    const connection = this.#connections.get(validateConnectionId(id));
    if (!connection) throw new Error(`Frappe OAuth connection "${id}" is not configured.`);
    return connection;
  }

  async #readVault(): Promise<OAuthVault> {
    const key = await loadOrCreateKey(this.#keyPath);
    try {
      const envelope = JSON.parse(await readFile(this.#vaultPath, "utf8")) as EncryptedVault;
      if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm") throw new Error("Unsupported Frappe OAuth vault format.");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"));
      decipher.setAAD(VAULT_AAD);
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
      return validateVault(JSON.parse(plaintext));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyVault();
      throw error;
    }
  }

  async #writeVault(vault: OAuthVault): Promise<void> {
    const key = await loadOrCreateKey(this.#keyPath);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(VAULT_AAD);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(vault), "utf8"), cipher.final()]);
    const envelope: EncryptedVault = {
      version: VAULT_VERSION,
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    };
    await mkdir(dirname(this.#vaultPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.#vaultPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
    await rename(temporary, this.#vaultPath);
    await chmod(this.#vaultPath, 0o600);
  }

  async #updateVault(update: (vault: OAuthVault) => OAuthVault): Promise<void> {
    const lockPath = `${this.#vaultPath}.lock`;
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
    const deadline = this.#now() + 5_000;
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    while (!lock) {
      try {
        lock = await open(lockPath, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const info = await stat(lockPath).catch(() => undefined);
        if (info && this.#now() - info.mtimeMs > 30_000) await rm(lockPath, { force: true });
        if (this.#now() >= deadline) throw new Error("Timed out waiting for the Frappe OAuth vault lock.");
        await this.#sleep(25);
      }
    }
    try {
      const now = this.#now();
      const current = await this.#readVault();
      const pruned: OAuthVault = { ...current, pending: current.pending.filter((item) => item.expiresAt > now) };
      await this.#writeVault(validateVault(update(pruned)));
    } finally {
      await lock.close().catch(() => undefined);
      await rm(lockPath, { force: true });
    }
  }
}

function metadataGrantScore(grant: StoredGrant): number {
  const roles = new Set(grant.identity.roles);
  return (roles.has("System Manager") ? 10_000 : 0)
    + (roles.has("Administrator") ? 5_000 : 0)
    + Math.min(roles.size, 1_000);
}

export async function inspectFrappeOAuthConnection(
  config: FrappeOAuthConnectionConfig,
  cwd = process.cwd(),
): Promise<FrappeOAuthConnectionInspection> {
  const id = validateConnectionId(config.id);
  const callbackMode = validCallbackMode(config.callbackMode);
  const credential = await readCredential(config, cwd);
  return {
    id,
    site: credential.site,
    callbackMode,
    redirectUri: credential.redirectUri,
    ...(callbackMode === "frappe" ? {
      resultPath: validFrappeMethodPath(
        config.resultPath ?? "/api/method/nextai.muster_oauth.consume_oauth_result",
        "resultPath",
      ),
    } : {}),
    ...(config.identityPath ? { identityPath: validFrappeMethodPath(config.identityPath, "identityPath") } : {}),
    identityTtlMs: bounded(config.identityTtlMs, DEFAULT_IDENTITY_TTL_MS, 5_000, 5 * 60_000),
  };
}

async function readCredential(config: FrappeOAuthConnectionConfig, cwd: string): Promise<CredentialFile> {
  const path = isAbsolute(config.credentialFile) ? config.credentialFile : resolve(cwd, config.credentialFile);
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`Frappe OAuth credential is not a file: ${path}`);
  if ((info.mode & 0o077) !== 0) throw new Error(`Frappe OAuth credential must not be group/world accessible: ${path}`);
  const value = object(JSON.parse(await readFile(path, "utf8")));
  const site = normalizedOrigin(required(value.site, "credential.site", 500));
  const redirectUri = validRedirect(
    required(value.redirectUri, "credential.redirectUri", 1_000),
    site,
    validCallbackMode(config.callbackMode),
  );
  return {
    site,
    clientId: required(value.clientId, "credential.clientId", 254),
    clientSecret: optionalString(value.clientSecret),
    redirectUri,
  };
}

async function loadOrCreateKey(path: string): Promise<Buffer> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const info = await stat(path);
    if ((info.mode & 0o077) !== 0) throw new Error(`Frappe OAuth vault key must not be group/world accessible: ${path}`);
    const key = Buffer.from((await readFile(path, "utf8")).trim(), "base64url");
    if (key.byteLength !== 32) throw new Error("Frappe OAuth vault key is invalid.");
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const key = randomBytes(32);
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(`${key.toString("base64url")}\n`, "utf8");
    } finally {
      await handle.close();
    }
    await chmod(path, 0o600);
    return key;
  }
}

async function requestJson(fetcher: typeof fetch, url: URL, init: RequestInit, timeoutMs: number): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetcher(url, { ...init, signal: controller.signal });
    const raw = await response.text();
    let payload: Record<string, unknown> = {};
    try {
      payload = raw ? object(JSON.parse(raw)) : {};
    } catch {
      throw new Error(`Frappe returned an unreadable response (HTTP ${response.status}).`);
    }
    if (!response.ok) throw new Error(`Frappe OAuth request failed (HTTP ${response.status}): ${boundedError(frappeError(payload))}`);
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveFrappeLinkLabel(
  fetcher: typeof fetch,
  site: string,
  accessToken: string,
  doctype: string,
  docname: string | undefined,
  preferredFields: readonly string[],
  timeoutMs: number,
): Promise<string | undefined> {
  if (!docname?.trim()) return undefined;
  const url = new URL("/api/method/frappe.client.get_value", site);
  url.search = new URLSearchParams({
    doctype,
    fieldname: JSON.stringify(preferredFields),
    filters: JSON.stringify({ name: docname.trim() }),
  }).toString();
  try {
    const payload = await requestJson(fetcher, url, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    }, timeoutMs);
    const value = object(payload.message ?? {});
    for (const field of preferredFields) {
      const label = optionalString(value[field]);
      if (label) return label;
    }
  } catch {
    // Display-name enrichment is permission-safe and best effort. The stable
    // link id remains available for execution if this user cannot read a title.
  }
  return undefined;
}

function validateVault(value: unknown): OAuthVault {
  const root = object(value);
  if (root.version !== 1 || !Array.isArray(root.pending) || !Array.isArray(root.grants)) {
    throw new Error("Frappe OAuth vault is malformed.");
  }
  return root as unknown as OAuthVault;
}

function emptyVault(): OAuthVault {
  return { version: VAULT_VERSION, pending: [], grants: [] };
}

function actorKey(connectionId: string, actor: FrappeOAuthActor): string {
  return createHash("sha256")
    .update([validateConnectionId(connectionId), required(actor.surfaceId, "surfaceId", 180), required(actor.senderId, "senderId", 254), required(actor.pairingId, "pairingId", 180)].join("\0"))
    .digest("hex");
}

function validateConnectionId(value: string): string {
  const normalized = value.trim();
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(normalized)) throw new Error("Frappe OAuth connection id is invalid.");
  return normalized;
}

function normalizedOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname))) {
    throw new Error("Frappe OAuth site must use HTTPS (HTTP is allowed only for localhost). ");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("Frappe OAuth site URL must not contain credentials, query, or fragment.");
  url.pathname = "";
  return url.toString().replace(/\/$/, "");
}

function matchesConfiguredIssuer(value: string, configuredSite: string): boolean {
  let issuer: URL;
  let site: URL;
  try {
    issuer = new URL(value);
    site = new URL(configuredSite);
  } catch {
    return false;
  }
  if (issuer.username || issuer.password || issuer.search || issuer.hash || !["", "/"].includes(issuer.pathname)) return false;
  if (issuer.hostname.toLowerCase() !== site.hostname.toLowerCase()) return false;
  if (issuer.protocol === site.protocol) return issuer.port === site.port;

  // Frappe's get_server_url() can report http behind an HTTPS-terminating proxy.
  return site.protocol === "https:" && issuer.protocol === "http:" && !site.port && !issuer.port;
}

function validRedirect(value: string, site: string, callbackMode: "gateway" | "frappe"): string {
  const redirect = new URL(value);
  if (redirect.protocol !== "https:" && !(redirect.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(redirect.hostname))) {
    throw new Error("Frappe OAuth redirect must use HTTPS (HTTP is allowed only for localhost). ");
  }
  if (redirect.username || redirect.password || redirect.hash || redirect.search) throw new Error("Frappe OAuth redirect is invalid.");
  if (redirect.pathname === "/") throw new Error("Frappe OAuth redirect must use a dedicated callback path.");
  if (callbackMode === "gateway" && !GATEWAY_CALLBACK_PATHS.has(redirect.pathname)) {
    throw new Error(`Frappe OAuth gateway redirect path must be ${[...GATEWAY_CALLBACK_PATHS].join(" or ")}.`);
  }
  if (callbackMode === "frappe") {
    if (redirect.origin !== site) throw new Error("Frappe-hosted OAuth redirect must use the configured Frappe site origin.");
    validFrappeMethodPath(redirect.pathname, "credential.redirectUri");
  }
  return redirect.toString();
}

function validCallbackMode(value: FrappeOAuthConnectionConfig["callbackMode"]): "gateway" | "frappe" {
  const mode = value ?? "gateway";
  if (mode !== "gateway" && mode !== "frappe") throw new Error('Frappe OAuth callbackMode must be "gateway" or "frappe".');
  return mode;
}

function validFrappeMethodPath(value: string, field: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) {
    throw new Error(`Frappe OAuth ${field} must be a same-site /api/method/... path.`);
  }
  const parsed = new URL(value, "https://muster.invalid");
  if (
    parsed.origin !== "https://muster.invalid"
    || parsed.search
    || parsed.hash
    || !parsed.pathname.startsWith("/api/method/")
  ) {
    throw new Error(`Frappe OAuth ${field} must be a same-site /api/method/... path.`);
  }
  return parsed.pathname;
}

function required(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Frappe OAuth ${field} is required.`);
  const normalized = value.trim();
  if (normalized.length > max) throw new Error(`Frappe OAuth ${field} exceeds ${max} characters.`);
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.trunc(value as number))) : fallback;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Frappe OAuth response must be an object.");
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, field: string, maxItems: number, maxChars: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`Frappe OAuth ${field} is invalid.`);
  return [...new Set(value.map((item, index) => required(item, `${field}[${index}]`, maxChars)))].sort();
}

function optionalIdentity(
  value: Record<string, unknown>,
  key: "userName" | "employee" | "employeeName" | "employeeStatus" | "reportsTo" | "reportsToName" | "department" | "departmentName" | "company" | "permissionHash" | "rolesHash",
  sourceKey: string = key,
): Record<string, string> {
  const field = optionalString(value[sourceKey]);
  return field ? { [key]: field } : {};
}

function frappeError(payload: Record<string, unknown>): string {
  return optionalString(payload.message)
    ?? optionalString(payload.exception)
    ?? optionalString(payload.exc_type)
    ?? "Frappe rejected the request.";
}

function boundedError(value: string): string {
  return value.replace(/[A-Za-z0-9_-]{30,}/g, "[redacted]").slice(0, 500);
}
