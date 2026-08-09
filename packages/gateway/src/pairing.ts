import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dataDir } from "@musterhq/core";
import type { MemoryScope } from "@musterhq/core";

export const MAX_FRAPPE_IDENTITY_ROLES = 512;

/**
 * Pairing lane (docs/SURFACE_GATEWAY_SPEC.md): a surface sender is anonymous
 * until an operator approves it with `muster pairing approve <code>`. Until
 * then every message answers with a pairing challenge; after approval the
 * sender resolves to a pairingId and scoped-memory lanes.
 */

export interface PendingPairing {
  readonly code: string;
  readonly surfaceId: string;
  readonly senderId: string;
  readonly requestedAt: string;
}

export interface PairedSender {
  readonly pairingId: string;
  readonly surfaceId: string;
  readonly senderId: string;
  readonly approvedAt: string;
  readonly identity?: PairedIdentity;
}

export interface PairedIdentity {
  readonly provider: "frappe";
  readonly site: string;
  readonly user: string;
  readonly userName?: string;
  readonly employee?: string;
  readonly employeeName?: string;
  readonly employeeStatus?: string;
  readonly reportsTo?: string;
  readonly reportsToName?: string;
  readonly roles: readonly string[];
  readonly department?: string;
  readonly departmentName?: string;
  readonly company?: string;
  readonly displayNamesResolvedAt?: string;
  readonly permissionHash?: string;
  readonly rolesHash?: string;
  readonly authMode?: "oauth_bearer" | "api_token" | "admin_login" | "operator_asserted" | "frappe_session" | "workspace_delegation";
  /** Non-secret proof reference for a Frappe-confirmed Telegram channel link. */
  readonly telegramLink?: {
    readonly linkId: string;
    readonly tenantId: string;
    readonly botId: string;
    readonly scopes: readonly string[];
  };
  readonly resolvedAt: string;
}

export interface PairingStore {
  readonly pending: PendingPairing[];
  readonly paired: PairedSender[];
}

export function pairingsPath(cwd = process.cwd()): string {
  return join(dataDir(cwd), "pairings.json");
}

export async function loadPairings(cwd = process.cwd()): Promise<PairingStore> {
  try {
    const raw = await readFile(pairingsPath(cwd), "utf8");
    const parsed = JSON.parse(raw) as Partial<PairingStore>;
    return { pending: parsed.pending ?? [], paired: parsed.paired ?? [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { pending: [], paired: [] };
    throw error;
  }
}

async function savePairings(store: PairingStore, cwd: string): Promise<void> {
  const path = pairingsPath(cwd);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700).catch(() => undefined);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => undefined);
}

async function withPairingLock<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
  const path = `${pairingsPath(cwd)}.lock`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 5_000;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  while (!handle) {
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stale = await stat(path).then((value) => Date.now() - value.mtimeMs > 30_000).catch(() => false);
      if (stale) {
        await unlink(path).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Pairing store is busy; retry the operation.");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
  }
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
  }
}

function senderKey(surfaceId: string, senderId: string): string {
  return `${surfaceId}:${senderId}`;
}

function newPairingCode(): string {
  // 8 chars from an unambiguous alphabet; typed by an operator, so keep it short.
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  let code = "";
  for (const byte of bytes) code += alphabet[byte % alphabet.length];
  return code;
}

/** Resolve a sender that has already been approved, if any. */
export async function resolvePairing(surfaceId: string, senderId: string, cwd = process.cwd()): Promise<PairedSender | undefined> {
  const store = await loadPairings(cwd);
  return store.paired.find((entry) => entry.surfaceId === surfaceId && entry.senderId === senderId);
}

/**
 * Ensure a pending pairing exists for an unpaired sender and return its code.
 * Idempotent: repeated messages from the same sender reuse the same code.
 */
export async function requestPairing(surfaceId: string, senderId: string, cwd = process.cwd()): Promise<PendingPairing> {
  return withPairingLock(cwd, async () => {
    const store = await loadPairings(cwd);
    const paired = store.paired.find((entry) => entry.surfaceId === surfaceId && entry.senderId === senderId);
    if (paired) throw new Error("This sender is already paired.");
    const existing = store.pending.find((entry) => entry.surfaceId === surfaceId && entry.senderId === senderId);
    if (existing) return existing;
    const pending: PendingPairing = {
      code: newPairingCode(),
      surfaceId,
      senderId,
      requestedAt: new Date().toISOString(),
    };
    await savePairings({ pending: [...store.pending, pending], paired: store.paired }, cwd);
    return pending;
  });
}

/** Operator approval: move a pending pairing to paired and mint a pairingId. */
export async function approvePairing(code: string, cwd = process.cwd(), identity?: Omit<PairedIdentity, "resolvedAt"> & { readonly resolvedAt?: string }): Promise<PairedSender> {
  return withPairingLock(cwd, async () => {
    const store = await loadPairings(cwd);
    const pending = store.pending.find((entry) => entry.code === code.trim().toUpperCase());
    if (!pending) {
      throw new Error(`No pending pairing with code ${code}. List pending pairings with: muster pairing list`);
    }
    const existing = store.paired.find((entry) => entry.surfaceId === pending.surfaceId && entry.senderId === pending.senderId);
    if (existing) return existing;
    const paired: PairedSender = {
      pairingId: `pair_${randomUUID().slice(0, 8)}`,
      surfaceId: pending.surfaceId,
      senderId: pending.senderId,
      approvedAt: new Date().toISOString(),
      ...(identity ? { identity: { ...identity, roles: [...identity.roles].sort(), resolvedAt: identity.resolvedAt ?? new Date().toISOString() } } : {}),
    };
    await savePairings({
      pending: store.pending.filter((entry) => entry.code !== pending.code),
      paired: [...store.paired, paired],
    }, cwd);
    return paired;
  });
}

/**
 * Bind an identity asserted by a trusted Frappe integration endpoint.
 *
 * This deliberately has no public CLI equivalent: callers must already hold
 * the gateway bearer token and must have resolved the identity inside Frappe.
 * An existing sender cannot be silently rebound to a different site or user.
 */
export async function upsertTrustedFrappePairing(
  surfaceId: string,
  senderId: string,
  identity: Omit<PairedIdentity, "provider" | "resolvedAt" | "permissionHash" | "rolesHash"> & {
    readonly resolvedAt?: string;
    readonly permissionHash?: string;
    readonly rolesHash?: string;
  },
  cwd = process.cwd(),
): Promise<PairedSender> {
  if (!surfaceId.trim() || !senderId.trim()) throw new Error("Trusted Frappe pairing requires a surface and sender.");
  const site = normalizeTrustedSite(identity.site);
  const user = identity.user.trim();
  if (!user || user.length > 254) throw new Error("Trusted Frappe pairing requires a valid user.");
  const roles = [...new Set(identity.roles.map((role) => role.trim()).filter(Boolean))].sort();
  if (roles.length > MAX_FRAPPE_IDENTITY_ROLES || roles.some((role) => role.length > 140)) {
    throw new Error("Trusted Frappe pairing roles are invalid.");
  }
  const rolesHash = identity.rolesHash ?? digest(roles.join("\0"));
  const permissionHash = identity.permissionHash ?? digest([site, user, identity.employee ?? "", rolesHash].join("\0"));
  const resolvedIdentity: PairedIdentity = {
    provider: "frappe",
    ...identity,
    site,
    user,
    roles,
    rolesHash,
    permissionHash,
    resolvedAt: identity.resolvedAt ?? new Date().toISOString(),
  };

  return withPairingLock(cwd, async () => {
    const store = await loadPairings(cwd);
    const existing = store.paired.find((entry) => entry.surfaceId === surfaceId && entry.senderId === senderId);
    if (existing?.identity?.provider === "frappe"
      && (existing.identity.site !== site || existing.identity.user !== user)) {
      throw new Error("Trusted Frappe sender is already bound to a different Frappe identity.");
    }
    const paired: PairedSender = existing
      ? { ...existing, identity: resolvedIdentity }
      : {
          pairingId: `pair_${randomUUID().slice(0, 8)}`,
          surfaceId,
          senderId,
          approvedAt: new Date().toISOString(),
          identity: resolvedIdentity,
        };
    await savePairings({
      pending: store.pending.filter((entry) => entry.surfaceId !== surfaceId || entry.senderId !== senderId),
      paired: existing
        ? store.paired.map((entry) => entry === existing ? paired : entry)
        : [...store.paired, paired],
    }, cwd);
    return paired;
  });
}

/** Remove only the Frappe identity; the channel pairing remains approved. */
export async function clearTrustedFrappePairingIdentity(
  surfaceId: string,
  senderId: string,
  cwd = process.cwd(),
): Promise<boolean> {
  return withPairingLock(cwd, async () => {
    const store = await loadPairings(cwd);
    const existing = store.paired.find((entry) => entry.surfaceId === surfaceId && entry.senderId === senderId);
    if (!existing?.identity || existing.identity.provider !== "frappe") return false;
    const cleared: PairedSender = {
      pairingId: existing.pairingId,
      surfaceId: existing.surfaceId,
      senderId: existing.senderId,
      approvedAt: existing.approvedAt,
    };
    await savePairings({
      pending: store.pending,
      paired: store.paired.map((entry) => entry === existing ? cleared : entry),
    }, cwd);
    return true;
  });
}

/** Immediately clear every channel identity invalidated by an administrator-authorized site/provider rebind. */
export async function clearTrustedFrappeTelegramBindings(
  site: string,
  tenantId: string,
  botId: string | undefined,
  cwd = process.cwd(),
): Promise<number> {
  const normalizedSite = normalizeTrustedSite(site);
  return withPairingLock(cwd, async () => {
    const store = await loadPairings(cwd);
    let cleared = 0;
    const paired = store.paired.map((entry): PairedSender => {
      const identity = entry.identity;
      const link = identity?.provider === "frappe" ? identity.telegramLink : undefined;
      if (!identity || identity.site !== normalizedSite || !link || link.tenantId !== tenantId || (botId !== undefined && link.botId !== botId)) return entry;
      cleared += 1;
      return { pairingId: entry.pairingId, surfaceId: entry.surfaceId, senderId: entry.senderId, approvedAt: entry.approvedAt };
    });
    if (cleared) await savePairings({ pending: store.pending, paired }, cwd);
    return cleared;
  });
}

/**
 * Memory lanes a paired sender may read/write. Frappe identities carry one
 * permission-epoch scope instead of one scope per role; large customized
 * sites can legitimately assign hundreds of roles to a user.
 */
export function pairingScopes(paired: PairedSender): MemoryScope[] {
  return [
    { kind: "pairing", id: senderKey(paired.surfaceId, paired.senderId) },
    { kind: "user", id: paired.pairingId },
    ...(paired.identity?.provider === "frappe" ? frappeIdentityScopes(paired.identity) : []),
  ];
}

function frappeIdentityScopes(identity: PairedIdentity): MemoryScope[] {
  const permissionEpoch = identity.permissionHash
    ?? digest([identity.site, identity.user, identity.employee ?? "", identity.rolesHash ?? digest(identity.roles.join("\0"))].join("\0"));
  return [
    { kind: "tenant", id: identity.site },
    { kind: "user", id: `frappe:${identity.user}` },
    ...(identity.employee ? [{ kind: "user" as const, id: `frappe-employee:${identity.employee}` }] : []),
    { kind: "persona", id: `frappe-permissions:${digest(`${identity.site}\0${permissionEpoch}`)}` },
  ];
}

function normalizeTrustedSite(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Trusted Frappe pairing site must be an absolute URL.");
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname))) {
    throw new Error("Trusted Frappe pairing site must use HTTPS (HTTP is allowed only for localhost). ");
  }
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
