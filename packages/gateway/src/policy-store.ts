import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dataDir } from "@musterhq/core";
import type { GatewayGovernanceAssignment, GatewayGovernanceRateLimit, GatewayGovernanceRateWindow, GatewayGovernanceSubject, GatewayGovernanceSubjectKind } from "./gateway-config.js";
import type { SurfaceMessage } from "./envelope.js";
import type { PairedSender } from "./pairing.js";

const POLICY_STORE_VERSION = 1;
const DEFAULT_DRAFT_TTL_MS = 10 * 60_000;
const WINDOWS = new Set<GatewayGovernanceRateWindow>(["minute", "hour", "day", "month"]);
const SUBJECT_KINDS = new Set<GatewayGovernanceSubjectKind>(["user", "role", "department", "channel", "surface", "tenant", "workspace", "agent"]);

export interface GatewayPolicyActor {
  readonly surfaceId: string;
  readonly senderId: string;
  readonly pairingId: string;
}

export interface GatewayStoredRateLimit extends GatewayGovernanceRateLimit {
  readonly id: string;
  readonly createdAt: string;
  readonly createdBy: GatewayPolicyActor;
}

export interface GatewayPolicyDraftPreview {
  readonly draftId: string;
  readonly token: string;
  readonly policy: GatewayGovernanceRateLimit;
  readonly expiresAt: string;
}

export interface GatewayPolicyStore {
  listPolicies(): Promise<readonly GatewayStoredRateLimit[]>;
  createDraft(input: {
    readonly actor: GatewayPolicyActor;
    readonly policy: GatewayGovernanceRateLimit;
    readonly nowMs?: number;
    readonly ttlMs?: number;
  }): Promise<GatewayPolicyDraftPreview>;
  applyDraft(input: {
    readonly actor: GatewayPolicyActor;
    readonly token: string;
    readonly nowMs?: number;
  }): Promise<GatewayStoredRateLimit>;
}

interface StoredDraft {
  readonly draftId: string;
  readonly tokenHash: string;
  readonly actor: GatewayPolicyActor;
  readonly policy: GatewayGovernanceRateLimit;
  readonly expiresAt: string;
  readonly status: "pending" | "consumed" | "expired";
}

interface PolicyStoreState {
  readonly version: number;
  readonly policies: readonly GatewayStoredRateLimit[];
  readonly drafts: readonly StoredDraft[];
}

export interface GatewayPolicyTarget {
  readonly subject: GatewayGovernanceSubject;
  readonly label: string;
}

export function policyStorePath(cwd = process.cwd()): string {
  return join(dataDir(cwd), "gateway-governance-policies.json");
}

export function createInMemoryGatewayPolicyStore(): GatewayPolicyStore {
  return new JsonGatewayPolicyStore();
}

export function openGatewayPolicyStore(cwd = process.cwd()): GatewayPolicyStore {
  return new JsonGatewayPolicyStore(policyStorePath(cwd));
}

class JsonGatewayPolicyStore implements GatewayPolicyStore {
  readonly #path?: string;
  #state: PolicyStoreState = emptyState();
  #loaded = false;
  #memoryLock: Promise<void> = Promise.resolve();

  constructor(path?: string) {
    this.#path = path;
  }

  async listPolicies(): Promise<readonly GatewayStoredRateLimit[]> {
    if (!this.#path) return [...this.#state.policies];
    return (await loadState(this.#path)).policies;
  }

  async createDraft(input: {
    readonly actor: GatewayPolicyActor;
    readonly policy: GatewayGovernanceRateLimit;
    readonly nowMs?: number;
    readonly ttlMs?: number;
  }): Promise<GatewayPolicyDraftPreview> {
    const actor = validateActor(input.actor);
    const policy = validatePolicy(input.policy);
    const nowMs = input.nowMs ?? Date.now();
    const ttlMs = input.ttlMs ?? DEFAULT_DRAFT_TTL_MS;
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Policy draft time is invalid.");
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 60 * 60_000) throw new Error("Policy draft expiry is invalid.");
    const token = `muster_limit_${randomBytes(18).toString("base64url")}`;
    const draft: StoredDraft = {
      draftId: `draft_${randomUUID()}`,
      tokenHash: hashToken(token),
      actor,
      policy,
      expiresAt: new Date(nowMs + ttlMs).toISOString(),
      status: "pending",
    };
    await this.withWriteLock(async () => {
      const state = await this.readState();
      await this.writeState({ ...state, drafts: [...state.drafts.filter((item) => item.status === "pending" && Date.parse(item.expiresAt) > nowMs), draft] });
    });
    return { draftId: draft.draftId, token, policy, expiresAt: draft.expiresAt };
  }

  async applyDraft(input: {
    readonly actor: GatewayPolicyActor;
    readonly token: string;
    readonly nowMs?: number;
  }): Promise<GatewayStoredRateLimit> {
    const actor = validateActor(input.actor);
    const token = input.token.trim();
    const nowMs = input.nowMs ?? Date.now();
    if (!token || token.length > 200) throw new Error("Policy apply token is invalid or expired.");
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Policy apply time is invalid.");
    return this.withWriteLock(async () => {
      const state = await this.readState();
      const tokenHash = hashToken(token);
      const draft = state.drafts.find((item) => safeTokenHashEquals(item.tokenHash, tokenHash));
      if (!draft || draft.status !== "pending" || Date.parse(draft.expiresAt) <= nowMs || !sameActor(draft.actor, actor)) {
        const nextDrafts = draft && draft.status === "pending" && Date.parse(draft.expiresAt) <= nowMs
          ? state.drafts.map((item) => item === draft ? { ...item, status: "expired" as const } : item)
          : state.drafts;
        if (nextDrafts !== state.drafts) await this.writeState({ ...state, drafts: nextDrafts });
        throw new Error("Policy apply token is invalid, expired, or not bound to this sender.");
      }
      const now = new Date(nowMs).toISOString();
      const policy: GatewayStoredRateLimit = {
        ...draft.policy,
        id: `dynamic_${randomUUID()}`,
        createdAt: now,
        createdBy: draft.actor,
      };
      await this.writeState({
        ...state,
        policies: [...state.policies, policy],
        drafts: state.drafts.map((item) => item === draft ? { ...item, status: "consumed" as const } : item),
      });
      return policy;
    });
  }

  private async readState(): Promise<PolicyStoreState> {
    if (!this.#path) {
      this.#loaded = true;
      return this.#state;
    }
    return loadState(this.#path);
  }

  private async writeState(state: PolicyStoreState): Promise<void> {
    if (!this.#path) {
      this.#state = state;
      this.#loaded = true;
      return;
    }
    await saveState(this.#path, state);
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.#path) {
      const previous = this.#memoryLock;
      let release!: () => void;
      this.#memoryLock = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try { return await operation(); } finally { release(); }
    }
    return withFileLock(`${this.#path}.lock`, operation);
  }
}

export function permittedGatewayPolicyTargets(input: {
  readonly message: SurfaceMessage;
  readonly paired: PairedSender;
  readonly assignment?: GatewayGovernanceAssignment;
  readonly agentId: string;
}): readonly GatewayPolicyTarget[] {
  const identity = input.paired.identity?.provider === "frappe" ? input.paired.identity : undefined;
  const targets: GatewayPolicyTarget[] = [];
  const add = (kind: GatewayGovernanceSubjectKind, id: string | undefined, label: string): void => {
    const value = id?.trim();
    if (!value || !SUBJECT_KINDS.has(kind)) return;
    if (targets.some((target) => target.subject.kind === kind && target.subject.id === value)) return;
    targets.push({ subject: { kind, id: value }, label });
  };
  const selfName = identity?.employeeName?.trim() || identity?.userName?.trim() || "My account";
  add("user", identity?.user, selfName);
  add("user", identity?.employee, selfName);
  add("user", input.assignment?.userId, input.assignment?.userId === identity?.user ? selfName : humanPolicyIdentifier(input.assignment?.userId, "Assigned account"));
  add("user", input.message.senderId, "This chat account");
  add("user", input.paired.pairingId, "This paired account");
  for (const id of input.assignment?.managedUserIds ?? []) add("user", id, humanPolicyIdentifier(id, "Managed account"));
  for (const id of [...(identity?.roles ?? []), ...(input.assignment?.roles ?? [])]) add("role", id, `People with ${humanPolicyIdentifier(id, "this access")} access`);
  for (const id of [...(identity?.department ? [identity.department] : []), ...(input.assignment?.departmentIds ?? []), ...(input.assignment?.managedDepartmentIds ?? [])]) {
    const department = id === identity?.department && identity.departmentName
      ? identity.departmentName
      : humanPolicyIdentifier(id, "Managed team");
    add("department", id, `${department} team`);
  }
  add("tenant", identity?.site, "Everyone on this connected site");
  add("tenant", input.assignment?.tenantId, "Everyone in this organization");
  add("workspace", input.assignment?.workspaceId, "This workspace");
  add("channel", `${input.message.surfaceId}:${input.message.conversationId}`, "This conversation");
  add("surface", input.message.surfaceId, `All ${humanPolicyIdentifier(input.message.surfaceId.split(":", 1)[0], "channel")} conversations`);
  add("agent", input.agentId, "This assistant");
  return targets;
}

function humanPolicyIdentifier(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  const candidate = normalized.includes("@") ? normalized.split("@", 1)[0] : normalized;
  const words = candidate.replace(/[_./:-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!words || /^\d+$/.test(words)) return fallback;
  return words.split(" ").map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(" ");
}

export function gatewayPolicyManagementAllowed(assignment: GatewayGovernanceAssignment | undefined, roles: readonly string[]): boolean {
  const normalizedRoles = roles.map((role) => role.trim().toLowerCase());
  const roleAllowed = normalizedRoles.some((role) => role.includes("manager") || role.includes("hrbp") || role === "hr user" || role === "hr manager" || role === "administrator" || role === "admin");
  const capabilities = assignment?.capabilities;
  const capabilityAllowed = capabilities === undefined || capabilities.includes("*") || capabilities.includes("governance");
  return roleAllowed && capabilityAllowed;
}

function validateActor(actor: GatewayPolicyActor): GatewayPolicyActor {
  for (const [name, value] of Object.entries(actor)) {
    if (typeof value !== "string" || !value.trim() || value.length > 512) throw new Error(`Policy actor ${name} is invalid.`);
  }
  return { surfaceId: actor.surfaceId.trim(), senderId: actor.senderId.trim(), pairingId: actor.pairingId.trim() };
}

function validatePolicy(policy: GatewayGovernanceRateLimit): GatewayGovernanceRateLimit {
  const kind = policy.subject?.kind;
  const id = policy.subject?.id?.trim();
  if (!kind || !SUBJECT_KINDS.has(kind) || !id || id.length > 512) throw new Error("Policy target is invalid.");
  if (!WINDOWS.has(policy.window)) throw new Error("Policy window is invalid.");
  const maxRuns = positiveLimit(policy.maxRuns);
  const maxTokens = positiveLimit(policy.maxTokens);
  if (maxRuns === undefined && maxTokens === undefined) throw new Error("Policy must include a positive request or token limit.");
  return {
    subject: { kind, id },
    window: policy.window,
    ...(maxRuns === undefined ? {} : { maxRuns }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  };
}

function positiveLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Policy amounts must be positive safe integers.");
  return value;
}

function emptyState(): PolicyStoreState {
  return { version: POLICY_STORE_VERSION, policies: [], drafts: [] };
}

async function loadState(path: string): Promise<PolicyStoreState> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw error;
  }
  const parsed = JSON.parse(raw) as Partial<PolicyStoreState>;
  if (parsed.version !== POLICY_STORE_VERSION || !Array.isArray(parsed.policies) || !Array.isArray(parsed.drafts)) {
    throw new Error("Gateway policy store is invalid; refusing to load policies.");
  }
  return {
    version: POLICY_STORE_VERSION,
    policies: parsed.policies.map((policy) => validateStoredPolicy(policy)),
    drafts: parsed.drafts.map((draft) => validateStoredDraft(draft)),
  };
}

async function saveState(path: string, state: PolicyStoreState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700).catch(() => undefined);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => undefined);
}

async function withFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
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
      if (stale) { await unlink(path).catch(() => undefined); continue; }
      if (Date.now() >= deadline) throw new Error("Gateway policy store is busy; retry the operation.");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try { return await operation(); } finally { await handle.close().catch(() => undefined); await unlink(path).catch(() => undefined); }
}

function validateStoredPolicy(value: unknown): GatewayStoredRateLimit {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.createdAt !== "string" || !isRecord(value.createdBy)) throw new Error("Gateway policy store contains an invalid policy.");
  if (!value.id.trim() || !Number.isFinite(Date.parse(value.createdAt))) throw new Error("Gateway policy store contains an invalid policy timestamp.");
  const policy = validatePolicy(value as GatewayGovernanceRateLimit);
  return { ...policy, id: value.id, createdAt: value.createdAt, createdBy: validateActor(value.createdBy as GatewayPolicyActor) };
}

function validateStoredDraft(value: unknown): StoredDraft {
  if (!isRecord(value) || typeof value.draftId !== "string" || typeof value.tokenHash !== "string" || typeof value.expiresAt !== "string" || !isRecord(value.actor) || !isRecord(value.policy)) throw new Error("Gateway policy store contains an invalid draft.");
  if (!value.draftId.trim() || !/^[a-f0-9]{64}$/.test(value.tokenHash) || !Number.isFinite(Date.parse(value.expiresAt))) throw new Error("Gateway policy store contains an invalid draft binding.");
  const status = value.status;
  if (status !== "pending" && status !== "consumed" && status !== "expired") throw new Error("Gateway policy store contains an invalid draft status.");
  return {
    draftId: value.draftId,
    tokenHash: value.tokenHash,
    actor: validateActor(value.actor as GatewayPolicyActor),
    policy: validatePolicy(value.policy as GatewayGovernanceRateLimit),
    expiresAt: value.expiresAt,
    status,
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameActor(left: GatewayPolicyActor, right: GatewayPolicyActor): boolean {
  return left.surfaceId === right.surfaceId && left.senderId === right.senderId && left.pairingId === right.pairingId;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeTokenHashEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && leftBytes.length > 0 && timingSafeEqual(leftBytes, rightBytes);
}
