import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { dataDir } from "./store.js";

/**
 * A native provider session handle (codex thread_id, claude session id, …) kept
 * per conversation so multi-turn chats RESUME the provider's own session instead
 * of cold-starting every turn. Keyed by (backendId, conversationKey). Reusable
 * across backends so the future provider-agnostic runtime shares one store.
 */
export interface SessionHandleRecord {
  readonly conversationKey: string;
  readonly backendId: string;
  readonly handle: string;
  /** The execution workspace the handle was minted under — reuse only if unchanged. */
  readonly cwd: string;
  /** The model the handle was minted under — reuse only if unchanged. */
  readonly model: string;
  /**
   * Hash of injected system context (memory, skills, rules) used when the
   * native handle was minted. A changed hash means the provider session may
   * carry stale instructions and must not be resumed.
   */
  readonly contextHash?: string;
  /** First turn persisted for this provider thread. Used to rotate stale native context. */
  readonly createdAt?: string;
  /** Completed turns carried by this provider thread. Missing on legacy records. */
  readonly turnCount?: number;
  readonly updatedAt: string;
}

export interface SessionReuseBudget {
  readonly maxAgeMs?: number;
  readonly maxTurns?: number;
  readonly nowMs?: number;
}

export function sessionHandlesPath(cwd = process.cwd()): string {
  return join(dataDir(cwd), "session-handles.json");
}

type Store = Record<string, SessionHandleRecord>;
const recordKey = (backendId: string, conversationKey: string): string => `${backendId}:${conversationKey}`;
const STORE_TAILS = new Map<string, Promise<void>>();

async function withStoreLock<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
  const path = sessionHandlesPath(cwd);
  const previous = STORE_TAILS.get(path)?.catch(() => undefined) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => { release = resolve; });
  STORE_TAILS.set(path, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (STORE_TAILS.get(path) === tail) STORE_TAILS.delete(path);
  }
}

async function load(cwd: string): Promise<Store> {
  try {
    const parsed = JSON.parse(await readFile(sessionHandlesPath(cwd), "utf8")) as Store;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function persist(store: Store, cwd: string): Promise<void> {
  const path = sessionHandlesPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  // Atomic write: unique temp then rename (mirrors acpx's file-session-store),
  // so a crash mid-write can never corrupt the handle map.
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

export async function loadSessionHandle(conversationKey: string, backendId: string, cwd = process.cwd()): Promise<SessionHandleRecord | undefined> {
  return withStoreLock(cwd, async () => (await load(cwd))[recordKey(backendId, conversationKey)]);
}

export async function saveSessionHandle(record: SessionHandleRecord, cwd = process.cwd()): Promise<void> {
  await withStoreLock(cwd, async () => {
    const store = await load(cwd);
    store[recordKey(record.backendId, record.conversationKey)] = record;
    await persist(store, cwd);
  });
}

export async function clearSessionHandle(conversationKey: string, backendId: string, cwd = process.cwd()): Promise<void> {
  await withStoreLock(cwd, async () => {
    const store = await load(cwd);
    const key = recordKey(backendId, conversationKey);
    if (!(key in store)) return;
    delete store[key];
    await persist(store, cwd);
  });
}

export async function clearConversationSessionHandles(
  conversationKey: string,
  cwd = process.cwd(),
  backendIds?: readonly string[],
): Promise<number> {
  return withStoreLock(cwd, async () => {
    const store = await load(cwd);
    const allowedBackends = backendIds ? new Set(backendIds) : undefined;
    let removed = 0;
    for (const [key, record] of Object.entries(store)) {
      if (record.conversationKey === conversationKey && (!allowedBackends || allowedBackends.has(record.backendId))) {
        delete store[key];
        removed += 1;
      }
    }
    if (removed > 0) await persist(store, cwd);
    return removed;
  });
}

/**
 * A stored handle is safe to resume ONLY when the stable config it was minted
 * under is unchanged: workspace cwd, model, and injected system context. Without
 * the context hash, a changed memory/skill/rule snapshot can resume a native
 * provider session that still carries the old instruction state.
 */
export function canReuseHandle(
  record: SessionHandleRecord | undefined,
  cwd: string,
  model: string,
  contextHash?: string,
  budget?: SessionReuseBudget,
): record is SessionHandleRecord {
  const compatible = Boolean(record)
    && record!.cwd === cwd
    && record!.model === model
    && (contextHash === undefined || record!.contextHash === contextHash);
  if (!compatible || !record || !budget) return compatible;
  if (budget.maxTurns !== undefined) {
    if (!Number.isSafeInteger(record.turnCount) || record.turnCount! < 0 || record.turnCount! >= budget.maxTurns) return false;
  }
  if (budget.maxAgeMs !== undefined) {
    const createdAt = record.createdAt ? Date.parse(record.createdAt) : Number.NaN;
    const now = budget.nowMs ?? Date.now();
    if (!Number.isFinite(createdAt) || now - createdAt >= budget.maxAgeMs) return false;
  }
  return true;
}
