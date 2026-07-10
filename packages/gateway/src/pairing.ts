import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dataDir } from "@musterhq/core";
import type { MemoryScope } from "@musterhq/core";

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
  readonly employee?: string;
  readonly employeeName?: string;
  readonly roles: readonly string[];
  readonly department?: string;
  readonly company?: string;
  readonly permissionHash?: string;
  readonly rolesHash?: string;
  readonly authMode?: "oauth_bearer" | "api_token" | "admin_login" | "operator_asserted";
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
 * Memory lanes a paired sender may read/write: the pairing lane
 * (`pairing:<surfaceId>:<senderId>`, per the spec) and the resolved Muster
 * identity lane (`user:<pairingId>`). A surface gets NOTHING beyond these
 * plus the per-conversation session lane added by the server.
 */
export function pairingScopes(paired: PairedSender): MemoryScope[] {
  return [
    { kind: "pairing", id: senderKey(paired.surfaceId, paired.senderId) },
    { kind: "user", id: paired.pairingId },
    ...(paired.identity?.provider === "frappe" ? frappeIdentityScopes(paired.identity) : []),
  ];
}

function frappeIdentityScopes(identity: PairedIdentity): MemoryScope[] {
  return [
    { kind: "tenant", id: identity.site },
    { kind: "user", id: `frappe:${identity.user}` },
    ...(identity.employee ? [{ kind: "user" as const, id: `frappe-employee:${identity.employee}` }] : []),
    ...identity.roles.map((role) => ({ kind: "role" as const, id: `frappe:${identity.site}:${role}` })),
  ];
}
