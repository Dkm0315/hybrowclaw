/**
 * Scoped runtime v1 — the durable, scope-owned "computer" that belongs beside
 * Muster's scoped memory.
 *
 * Muster has resolved WHAT an agent may remember per scope since `memory.ts`
 * landed: 8 scope kinds (`types.ts` MemoryScopeKind), visibility enforced by
 * `isVisibleInScopes`. It has never resolved WHERE that agent's work lives,
 * WHICH environment variables reach it, or WHICH tools it may call. Every run
 * has shared one ambient process cwd and one ambient `process.env`. Sibling
 * systems (QM) pair each person/room scope with a durable computer — files,
 * env, permissions — so a scope's work survives restarts and cannot bleed into
 * a neighbour's. This module is that missing sibling: scope in, durable runtime
 * descriptor out.
 *
 * ═══ THIS IS A SEAM, NOT A SANDBOX ═══
 *
 * v1 resolves a scope set to a DESCRIPTOR — a deterministic directory, an env
 * allowlist, a deny-by-default tool policy, declared limits — and persists a
 * manifest so the binding survives restarts and can be audited. It never
 * spawns, wraps, or confines anything.
 *
 * EXPLICITLY OUT OF SCOPE for v1; do NOT read these guarantees into it:
 * container/jail/VM execution, seccomp/landlock/AppArmor confinement, real
 * cgroup or filesystem-quota enforcement, and network filtering. `limits`,
 * `envAllowlist`, and `toolPolicy` are DECLARATIONS that an executor must
 * enforce at spawn time; nothing in this file enforces them. A caller that
 * spawns a child with full ambient `process.env` after reading a descriptor
 * gets exactly zero protection from this module. `resolveRuntimeEnv` and
 * `effectiveToolAuthority` exist so that enforcement is one honest call away —
 * use them, or the policy is decorative.
 *
 * ═══ FOUR INVARIANTS ═══
 *
 * 1. DETERMINISTIC PATHS. The same scope set always resolves to the same
 *    absolute `workDir`, in this process and in one started a month later. No
 *    randomness, no timestamps, no counters in the path. That is what makes the
 *    directory DURABLE rather than a scratch dir with extra steps.
 *
 * 2. ONE OWNER, EXPLICIT PRECEDENCE. A scope set is a chain, most specific
 *    first; the most specific scope OWNS the directory, and every policy field
 *    is resolved independently by "most specific declaration wins"
 *    (`SCOPE_SPECIFICITY_ORDER`). Duplicate kinds in one set are rejected — an
 *    authority boundary with two candidate owners fails closed instead of
 *    picking one.
 *
 * 3. CONTAINMENT. A scope id is untrusted input. `scopedRuntimeSlug` reduces it
 *    to `[A-Za-z0-9._-]` and appends a sha256 prefix of the RAW id, so
 *    `"../../etc"` cannot escape the runtimes root and two distinct ids can
 *    never collide onto one directory after sanitising. A containment assertion
 *    backs the slug up rather than trusting it.
 *
 * 4. FAIL CLOSED ON REUSE. `ensureRuntime` verifies the on-disk manifest names
 *    the same scope chain before touching the directory. A mismatch throws and
 *    mutates nothing — same spirit as memory's `isVisibleInScopes`: authority is
 *    proven, never assumed. Corrupt manifests are an error, not a silent
 *    re-init (a silent re-init is indistinguishable from data loss).
 *
 * `auditRuntime` is the deliberate exception to invariant 4: it REPORTS damage
 * instead of throwing, because you cannot inspect a broken runtime with a
 * function that refuses to look at broken runtimes.
 */

import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { intersectCapabilities } from "./agent-graph.js";
import { formatMemoryScope } from "./memory.js";
import { dataDir } from "./store.js";
import type { MemoryScope, MemoryScopeKind } from "./types.js";

/* ---------- errors: fail closed, WorkspaceObserverError idiom ---------- */

export type ScopedRuntimeErrorCode =
  | "no_scope"
  | "invalid_scope_kind"
  | "invalid_scope_id"
  | "duplicate_scope_kind"
  | "duplicate_grant"
  | "invalid_env_name"
  | "invalid_tool_id"
  | "invalid_limit"
  | "path_escape"
  | "descriptor_mismatch"
  | "scope_mismatch"
  | "manifest_integrity"
  | "manifest_unwritable";

export class ScopedRuntimeError extends Error {
  readonly code: ScopedRuntimeErrorCode;
  readonly detail?: string;
  constructor(code: ScopedRuntimeErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "ScopedRuntimeError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/* ---------- specificity ---------- */

/**
 * Precedence rank, 0 = most specific. Declared as an exhaustive
 * `Record<MemoryScopeKind, number>` on purpose: adding a 9th scope kind to
 * `types.ts` breaks this build until someone decides where it ranks, rather
 * than silently defaulting to "least specific".
 *
 * The contract chain — session > user > workspace > tenant > global — is
 * preserved exactly, as a subsequence. The three kinds it does not name are
 * slotted by how narrowly each identifies a principal: a `pairing` is one user
 * with one agent (narrower than that user alone), a `persona` is a single agent
 * identity, a `role` is a class of principals (broader than any individual,
 * narrower than the workspace they act in).
 */
const SCOPE_SPECIFICITY: Readonly<Record<MemoryScopeKind, number>> = {
  session: 0,
  pairing: 1,
  user: 2,
  persona: 3,
  role: 4,
  workspace: 5,
  tenant: 6,
  global: 7,
};

/** Scope kinds ordered most specific first. */
export const SCOPE_SPECIFICITY_ORDER: readonly MemoryScopeKind[] = (
  Object.keys(SCOPE_SPECIFICITY) as MemoryScopeKind[]
).sort((left, right) => SCOPE_SPECIFICITY[left] - SCOPE_SPECIFICITY[right]);

/** 0 = most specific. Throws for unknown kinds so precedence is never guessed. */
export function scopeSpecificityRank(kind: MemoryScopeKind): number {
  const rank = SCOPE_SPECIFICITY[kind];
  if (rank === undefined) throw new ScopedRuntimeError("invalid_scope_kind", `Unknown memory scope kind: ${String(kind)}`);
  return rank;
}

/* ---------- policy contracts ---------- */

export type ScopedRuntimeNetworkAccess = "none" | "allowlist" | "unrestricted";

const NETWORK_ACCESS_VALUES: readonly ScopedRuntimeNetworkAccess[] = ["none", "allowlist", "unrestricted"];

export interface ScopedRuntimeLimits {
  /** Advisory ceiling on concurrent child processes. Undefined = undeclared, not unlimited-by-policy. */
  readonly maxProcesses?: number;
  /** Advisory ceiling on `workDir` bytes, in MiB. `auditRuntime` measures against it. */
  readonly maxDiskMb?: number;
  readonly networkAccess: ScopedRuntimeNetworkAccess;
}

/** Deny-by-default: no network until a scope grants it. */
export const DEFAULT_SCOPED_RUNTIME_LIMITS: ScopedRuntimeLimits = { networkAccess: "none" };

/**
 * One scope's declaration. Every field is optional; an omitted field defers to
 * the next scope in the chain. A DECLARED field wins outright for that field —
 * see `resolveScopedRuntime` for why this is override and not union.
 */
export interface ScopedRuntimeGrant {
  readonly scope: MemoryScope;
  readonly envAllowlist?: readonly string[];
  readonly toolPolicy?: readonly string[];
  readonly limits?: Partial<ScopedRuntimeLimits>;
}

export interface ScopedRuntimeConfig {
  /** Workspace whose profile data dir roots every runtime. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Explicit runtimes root; wins over `cwd`. For tests and relocated state dirs. */
  readonly rootDir?: string;
  readonly grants?: readonly ScopedRuntimeGrant[];
}

export interface ScopedRuntimeDescriptor {
  readonly schemaVersion: 1;
  /** The most specific scope in the set. It owns `workDir`. */
  readonly owner: MemoryScope;
  /** The full normalized chain, most specific first. */
  readonly scopes: readonly MemoryScope[];
  readonly root: string;
  readonly workDir: string;
  readonly manifestPath: string;
  /** Sorted, deduped env var NAMES this runtime may see. Empty = nothing. */
  readonly envAllowlist: readonly string[];
  /** Sorted, deduped tool ids this runtime may call. Empty = nothing. No wildcards. */
  readonly toolPolicy: readonly string[];
  readonly limits: ScopedRuntimeLimits;
  /** `sha256:…` over the resolved authority (env + tools + limits) only. */
  readonly policyDigest: string;
}

export interface ScopedRuntimeManifest {
  readonly schemaVersion: 1;
  readonly owner: MemoryScope;
  readonly scopes: readonly MemoryScope[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly policyDigest: string;
  /** `sha256:…` over every other field, canonically serialized. Tamper check. */
  readonly digest: string;
}

export const SCOPED_RUNTIME_MANIFEST_FILE = "runtime-manifest.json";

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Same shape as agent-graph's node/graph ids — tool ids cross the same trust boundary. */
const TOOL_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.:-]*$/;
const MAX_SLUG_VISIBLE_CHARS = 48;
const SLUG_DIGEST_CHARS = 16;

/* ---------- paths ---------- */

/** Always absolute — a relative root would make the containment assertion meaningless. */
export function scopedRuntimesRoot(config: ScopedRuntimeConfig = {}): string {
  return resolve(config.rootDir ?? join(dataDir(config.cwd ?? process.cwd()), "runtimes"));
}

/**
 * Reduce an untrusted scope id to a single safe path segment.
 *
 * The sanitised prefix exists only so humans can read `ls`; the sha256 prefix of
 * the RAW id is what carries identity. That split matters: sanitising alone
 * would map `"a/b"` and `"a:b"` — and `"../../etc"` and `"etc"` — onto the same
 * directory, silently merging two scopes' durable state. The digest makes such
 * a collision cryptographically improbable while keeping the result
 * deterministic across processes and machines.
 */
export function scopedRuntimeSlug(scopeId: string): string {
  const digest = sha256Hex(scopeId).slice(0, SLUG_DIGEST_CHARS);
  const visible = scopeId
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .slice(0, MAX_SLUG_VISIBLE_CHARS)
    .replace(/^[.\-]+/, "")
    .replace(/[.\-]+$/, "");
  return visible ? `${visible}-${digest}` : digest;
}

/** Deterministic directory for the owning scope. Never escapes the runtimes root. */
export function scopedRuntimeWorkDir(owner: MemoryScope, config: ScopedRuntimeConfig = {}): string {
  const normalized = normalizeScope(owner);
  const root = scopedRuntimesRoot(config);
  const workDir = resolve(root, normalized.kind, scopedRuntimeSlug(normalized.id));
  assertContained(root, workDir);
  return workDir;
}

function assertContained(root: string, candidate: string): void {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!candidate.startsWith(prefix)) {
    throw new ScopedRuntimeError(
      "path_escape",
      "Resolved runtime directory escapes the runtimes root.",
      `${candidate} is not under ${root}`,
    );
  }
}

/* ---------- resolve ---------- */

/**
 * Map a scope set to a durable runtime descriptor. Pure: no I/O, no mkdir.
 * Call `ensureRuntime` to materialize it.
 *
 * PRECEDENCE — `SCOPE_SPECIFICITY_ORDER`, most specific first
 * (session > pairing > user > persona > role > workspace > tenant > global):
 *
 *  • `workDir` is owned by the single most specific scope present. Ancestry
 *    changes policy, never the path — so a durable directory keeps its identity
 *    when a broader scope is added to or removed from the run.
 *  • `envAllowlist`, `toolPolicy`, `limits.maxProcesses`, `limits.maxDiskMb`,
 *    and `limits.networkAccess` are resolved INDEPENDENTLY, each by the most
 *    specific scope that DECLARES it. A session may narrow tools while
 *    inheriting the tenant's env allowlist.
 *  • Resolution is OVERRIDE, NOT UNION. A session `toolPolicy: ["fs.read"]`
 *    REPLACES the tenant's list; it does not add to it. Union would let any
 *    broader scope silently widen a narrow one — the exact failure mode
 *    deny-by-default exists to prevent. To grant a superset, restate it.
 *  • Nothing declared anywhere = deny: empty env allowlist, empty tool policy,
 *    `networkAccess: "none"`, undeclared numeric limits.
 *
 * Fails closed on: an empty scope set, an unknown scope kind, a blank scope id,
 * two scopes of one kind (ambiguous owner), two grants for one scope, or any
 * malformed grant value — including in a grant that loses precedence, because a
 * typo in a losing grant is still a broken config.
 */
export function resolveScopedRuntime(
  scopes: readonly MemoryScope[],
  config: ScopedRuntimeConfig = {},
): ScopedRuntimeDescriptor {
  const chain = normalizeScopeChain(scopes);
  const owner = chain[0]!;
  const grants = indexGrants(config.grants ?? []);
  const applicable = chain.map((scope) => grants.get(formatMemoryScope(scope))).filter(isDefined);

  const envAllowlist = normalizeEnvAllowlist(firstDeclared(applicable, (grant) => grant.envAllowlist) ?? []);
  const toolPolicy = normalizeToolPolicy(firstDeclared(applicable, (grant) => grant.toolPolicy) ?? []);
  const limits: ScopedRuntimeLimits = {
    maxProcesses: firstDeclared(applicable, (grant) => grant.limits?.maxProcesses),
    maxDiskMb: firstDeclared(applicable, (grant) => grant.limits?.maxDiskMb),
    networkAccess:
      firstDeclared(applicable, (grant) => grant.limits?.networkAccess) ?? DEFAULT_SCOPED_RUNTIME_LIMITS.networkAccess,
  };

  const root = scopedRuntimesRoot(config);
  const workDir = resolve(root, owner.kind, scopedRuntimeSlug(owner.id));
  assertContained(root, workDir);

  return {
    schemaVersion: 1,
    owner,
    scopes: chain,
    root,
    workDir,
    manifestPath: join(workDir, SCOPED_RUNTIME_MANIFEST_FILE),
    envAllowlist,
    toolPolicy,
    limits,
    policyDigest: `sha256:${sha256Hex(canonicalJson({ envAllowlist, toolPolicy, limits }))}`,
  };
}

function firstDeclared<T>(grants: readonly ScopedRuntimeGrant[], pick: (grant: ScopedRuntimeGrant) => T | undefined): T | undefined {
  for (const grant of grants) {
    const value = pick(grant);
    if (value !== undefined) return value;
  }
  return undefined;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function indexGrants(grants: readonly ScopedRuntimeGrant[]): Map<string, ScopedRuntimeGrant> {
  const byScope = new Map<string, ScopedRuntimeGrant>();
  for (const grant of grants) {
    const scope = normalizeScope(grant.scope);
    const key = formatMemoryScope(scope);
    if (byScope.has(key)) {
      throw new ScopedRuntimeError("duplicate_grant", `Scope ${key} declares more than one runtime grant.`);
    }
    if (grant.envAllowlist !== undefined) normalizeEnvAllowlist(grant.envAllowlist);
    if (grant.toolPolicy !== undefined) normalizeToolPolicy(grant.toolPolicy);
    validateGrantLimits(grant.limits, key);
    byScope.set(key, { ...grant, scope });
  }
  return byScope;
}

function normalizeScopeChain(scopes: readonly MemoryScope[]): MemoryScope[] {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new ScopedRuntimeError("no_scope", "A scoped runtime requires at least one memory scope.");
  }
  const byKind = new Map<MemoryScopeKind, MemoryScope>();
  for (const raw of scopes) {
    const scope = normalizeScope(raw);
    const existing = byKind.get(scope.kind);
    if (existing && existing.id !== scope.id) {
      throw new ScopedRuntimeError(
        "duplicate_scope_kind",
        `Scope set declares two "${scope.kind}" scopes (${existing.id}, ${scope.id}); ownership would be ambiguous.`,
      );
    }
    byKind.set(scope.kind, scope);
  }
  return [...byKind.values()].sort((left, right) => scopeSpecificityRank(left.kind) - scopeSpecificityRank(right.kind));
}

/** Mirrors memory.ts scope normalization so one logical scope means one thing in both subsystems. */
function normalizeScope(scope: MemoryScope): MemoryScope {
  const kind = scope?.kind as MemoryScopeKind;
  if (typeof kind !== "string" || SCOPE_SPECIFICITY[kind] === undefined) {
    throw new ScopedRuntimeError("invalid_scope_kind", `Invalid memory scope kind: ${String(scope?.kind)}`);
  }
  const trimmed = typeof scope.id === "string" ? scope.id.trim() : "";
  if (!trimmed) throw new ScopedRuntimeError("invalid_scope_id", `Memory scope ${kind} requires an id.`);
  return { kind, id: kind === "global" ? "global" : trimmed };
}

function normalizeEnvAllowlist(names: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const name of names) {
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!ENV_NAME_PATTERN.test(trimmed)) {
      throw new ScopedRuntimeError("invalid_env_name", `Invalid environment variable name in allowlist: ${JSON.stringify(name)}`);
    }
    normalized.add(trimmed);
  }
  return [...normalized].sort();
}

function normalizeToolPolicy(toolIds: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const toolId of toolIds) {
    const trimmed = typeof toolId === "string" ? toolId.trim() : "";
    if (!TOOL_ID_PATTERN.test(trimmed)) {
      throw new ScopedRuntimeError(
        "invalid_tool_id",
        `Invalid tool id in policy: ${JSON.stringify(toolId)}. Tool policies list explicit ids; there is no wildcard.`,
      );
    }
    normalized.add(trimmed);
  }
  return [...normalized].sort();
}

function validateGrantLimits(limits: Partial<ScopedRuntimeLimits> | undefined, scopeKey: string): void {
  if (limits === undefined) return;
  for (const field of ["maxProcesses", "maxDiskMb"] as const) {
    const value = limits[field];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value <= 0) {
      throw new ScopedRuntimeError("invalid_limit", `Scope ${scopeKey} declares ${field}=${String(value)}; expected a positive integer.`);
    }
  }
  if (limits.networkAccess !== undefined && !NETWORK_ACCESS_VALUES.includes(limits.networkAccess)) {
    throw new ScopedRuntimeError(
      "invalid_limit",
      `Scope ${scopeKey} declares networkAccess=${JSON.stringify(limits.networkAccess)}; expected one of ${NETWORK_ACCESS_VALUES.join(", ")}.`,
    );
  }
}

/* ---------- authority helpers (the seam an executor must actually use) ---------- */

/**
 * Deny-by-default tool authority, delegated to agent-graph's
 * `intersectCapabilities`: EVERY term must grant a tool id for it to survive,
 * and an `undefined` term collapses the result to empty. Pass the descriptor
 * plus any narrower terms (a node's requested capabilities, a session cap).
 */
export function effectiveToolAuthority(
  descriptor: ScopedRuntimeDescriptor,
  ...authorityTerms: readonly (ReadonlySet<string> | readonly string[] | undefined)[]
): ReadonlySet<string> {
  return intersectCapabilities(descriptor.toolPolicy, ...authorityTerms);
}

export function isToolAllowed(descriptor: ScopedRuntimeDescriptor, toolId: string): boolean {
  return descriptor.toolPolicy.includes(toolId);
}

/**
 * Project an ambient environment down to the descriptor's allowlist. Names that
 * are allowlisted but absent from the source are simply absent from the result;
 * nothing is invented. This is the ONLY supported way to build a child env from
 * a descriptor — spreading `process.env` defeats the entire module.
 */
export function resolveRuntimeEnv(
  descriptor: ScopedRuntimeDescriptor,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of descriptor.envAllowlist) {
    const value = source[name];
    if (typeof value === "string") env[name] = value;
  }
  return env;
}

/* ---------- ensure ---------- */

export type EnsureScopedRuntimeState = "created" | "reused" | "rebound";

export interface EnsureScopedRuntimeResult {
  readonly descriptor: ScopedRuntimeDescriptor;
  /**
   * `created` — no manifest existed; one was written.
   * `reused`  — manifest matched scope chain and policy digest byte for byte.
   * `rebound` — same scope chain, different policy digest: config changed, so
   *             the manifest was rewritten with `createdAt` preserved.
   */
  readonly state: EnsureScopedRuntimeState;
  readonly manifest: ScopedRuntimeManifest;
}

export interface EnsureScopedRuntimeOptions {
  /** Injectable clock for deterministic tests. */
  readonly now?: () => string;
}

/**
 * Materialize the descriptor: 0o700 directory plus an atomically written
 * manifest.
 *
 * Order is load-bearing. The manifest is READ AND VERIFIED BEFORE anything is
 * created or chmod'd, so a scope-mismatched reuse leaves the foreign directory
 * byte-identical — a failed authority check must not be detectable as a
 * side effect on someone else's runtime.
 */
export async function ensureRuntime(
  descriptor: ScopedRuntimeDescriptor,
  options: EnsureScopedRuntimeOptions = {},
): Promise<EnsureScopedRuntimeResult> {
  assertDescriptorPaths(descriptor);
  const now = options.now ?? (() => new Date().toISOString());

  const load = await loadManifest(descriptor.manifestPath);
  if (load.status === "corrupt") {
    throw new ScopedRuntimeError(
      "manifest_integrity",
      `Runtime manifest at ${descriptor.manifestPath} is unreadable; refusing to reuse or overwrite it.`,
      load.detail,
    );
  }
  if (load.status === "ok" && !sameScopeChain(load.manifest.scopes, descriptor.scopes)) {
    throw new ScopedRuntimeError(
      "scope_mismatch",
      `Runtime at ${descriptor.workDir} belongs to ${describeChain(load.manifest.scopes)}; refusing to reuse it for ${describeChain(descriptor.scopes)}.`,
    );
  }

  await mkdir(descriptor.workDir, { recursive: true, mode: 0o700 });
  await chmod(descriptor.workDir, 0o700).catch(() => undefined);

  if (load.status === "ok" && load.manifest.policyDigest === descriptor.policyDigest) {
    return { descriptor, state: "reused", manifest: load.manifest };
  }

  const timestamp = now();
  const manifest = signManifest({
    schemaVersion: 1,
    owner: descriptor.owner,
    scopes: descriptor.scopes,
    createdAt: load.status === "ok" ? load.manifest.createdAt : timestamp,
    updatedAt: timestamp,
    policyDigest: descriptor.policyDigest,
  });
  await writeManifestAtomic(descriptor.manifestPath, manifest);
  return { descriptor, state: load.status === "ok" ? "rebound" : "created", manifest };
}

function assertDescriptorPaths(descriptor: ScopedRuntimeDescriptor): void {
  assertContained(descriptor.root, descriptor.workDir);
  const expected = resolve(descriptor.root, descriptor.owner.kind, scopedRuntimeSlug(descriptor.owner.id));
  if (descriptor.workDir !== expected || descriptor.manifestPath !== join(descriptor.workDir, SCOPED_RUNTIME_MANIFEST_FILE)) {
    throw new ScopedRuntimeError(
      "descriptor_mismatch",
      "Descriptor paths do not match its owning scope; it was hand-edited after resolveScopedRuntime.",
      `expected ${expected}, got ${descriptor.workDir}`,
    );
  }
}

function sameScopeChain(left: readonly MemoryScope[], right: readonly MemoryScope[]): boolean {
  return left.length === right.length && left.every((scope, index) => formatMemoryScope(scope) === formatMemoryScope(right[index]!));
}

function describeChain(scopes: readonly MemoryScope[]): string {
  return scopes.map(formatMemoryScope).join(" > ");
}

function signManifest(manifest: Omit<ScopedRuntimeManifest, "digest">): ScopedRuntimeManifest {
  return { ...manifest, digest: `sha256:${sha256Hex(canonicalJson(manifest))}` };
}

/**
 * Write-temp-then-rename, so a reader never observes a half-written manifest and
 * a crash mid-write leaves the previous manifest intact. `randomUUID` (not
 * pid+time, which collides under `Promise.all` inside one process) keeps
 * concurrent writers off each other's temp file.
 */
async function writeManifestAtomic(path: string, manifest: ScopedRuntimeManifest): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temp, 0o600).catch(() => undefined);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw new ScopedRuntimeError("manifest_unwritable", `Failed to write runtime manifest at ${path}.`, errorDetail(error));
  }
  await chmod(path, 0o600).catch(() => undefined);
}

type ManifestLoad =
  | { readonly status: "missing" }
  | { readonly status: "corrupt"; readonly detail: string }
  | { readonly status: "ok"; readonly manifest: ScopedRuntimeManifest };

async function loadManifest(path: string): Promise<ManifestLoad> {
  const raw = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
    throw error;
  });
  if (raw === undefined) return { status: "missing" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { status: "corrupt", detail: `invalid JSON: ${errorDetail(error)}` };
  }
  if (!isRecord(parsed)) return { status: "corrupt", detail: "manifest is not an object" };
  if (parsed.schemaVersion !== 1) return { status: "corrupt", detail: `unsupported schemaVersion ${String(parsed.schemaVersion)}` };
  if (typeof parsed.digest !== "string") return { status: "corrupt", detail: "missing digest" };
  if (typeof parsed.createdAt !== "string" || typeof parsed.updatedAt !== "string") {
    return { status: "corrupt", detail: "missing createdAt/updatedAt" };
  }
  if (typeof parsed.policyDigest !== "string") return { status: "corrupt", detail: "missing policyDigest" };
  const owner = readScope(parsed.owner);
  const scopes = Array.isArray(parsed.scopes) ? parsed.scopes.map(readScope) : undefined;
  if (!owner || !scopes || scopes.some((scope) => scope === undefined)) {
    return { status: "corrupt", detail: "missing or malformed scope chain" };
  }

  const { digest, ...signed } = parsed as unknown as ScopedRuntimeManifest;
  const expected = `sha256:${sha256Hex(canonicalJson(signed))}`;
  if (digest !== expected) return { status: "corrupt", detail: `digest mismatch (expected ${expected}, found ${digest})` };
  return { status: "ok", manifest: parsed as unknown as ScopedRuntimeManifest };
}

function readScope(value: unknown): MemoryScope | undefined {
  if (!isRecord(value) || typeof value.kind !== "string" || typeof value.id !== "string") return undefined;
  if (SCOPE_SPECIFICITY[value.kind as MemoryScopeKind] === undefined) return undefined;
  return { kind: value.kind as MemoryScopeKind, id: value.id };
}

/* ---------- audit ---------- */

export type ScopedRuntimeManifestState = "ok" | "missing" | "corrupt" | "scope_mismatch" | "policy_drift";

export type ScopedRuntimeOrphanReason = "no_manifest" | "corrupt_manifest" | "path_scope_mismatch" | "unknown_scope_kind";

export interface ScopedRuntimeOrphan {
  readonly path: string;
  readonly reason: ScopedRuntimeOrphanReason;
  readonly detail?: string;
}

export interface ScopedRuntimeIssue {
  readonly code: string;
  readonly message: string;
}

export interface ScopedRuntimeAudit {
  readonly workDir: string;
  readonly owner: MemoryScope;
  readonly exists: boolean;
  readonly manifestState: ScopedRuntimeManifestState;
  readonly manifest?: ScopedRuntimeManifest;
  readonly diskBytes: number;
  readonly fileCount: number;
  readonly symlinkCount: number;
  readonly diskLimitBytes?: number;
  readonly overDiskLimit: boolean;
  /** `workDir` permission bits, octal (e.g. "700"). Absent when the dir is missing. */
  readonly modeOctal?: string;
  /** Leftover `*.tmp` manifests — evidence of a crashed atomic write. */
  readonly temporaryFiles: readonly string[];
  /** Root-level hygiene: runtime dirs that no longer describe themselves. */
  readonly orphans: readonly ScopedRuntimeOrphan[];
  readonly issues: readonly ScopedRuntimeIssue[];
  /** True only when THIS runtime is safe to reuse. Orphans elsewhere do not flip it. */
  readonly healthy: boolean;
}

export interface AuditScopedRuntimeOptions {
  /** Scan the whole runtimes root for self-inconsistent directories. Default true. */
  readonly includeOrphans?: boolean;
}

/**
 * Inspect a runtime without mutating or trusting it. Unlike `ensureRuntime`,
 * this NEVER throws on damage — a tampered manifest is the thing you are trying
 * to see, so it is reported as `manifestState` plus an issue.
 */
export async function auditRuntime(
  descriptor: ScopedRuntimeDescriptor,
  options: AuditScopedRuntimeOptions = {},
): Promise<ScopedRuntimeAudit> {
  const issues: ScopedRuntimeIssue[] = [];
  const stats = await lstat(descriptor.workDir).catch(() => undefined);
  const exists = stats?.isDirectory() ?? false;
  if (!exists) issues.push({ code: "missing_directory", message: `Runtime directory ${descriptor.workDir} does not exist.` });

  const modeOctal = exists ? (stats!.mode & 0o777).toString(8).padStart(3, "0") : undefined;
  if (exists && (stats!.mode & 0o077) !== 0) {
    issues.push({ code: "permissive_mode", message: `Runtime directory mode is 0${modeOctal}; expected no group/other access.` });
  }

  const load = await loadManifest(descriptor.manifestPath).catch(
    (error: unknown): ManifestLoad => ({ status: "corrupt", detail: errorDetail(error) }),
  );
  let manifestState: ScopedRuntimeManifestState;
  if (load.status === "missing") {
    manifestState = "missing";
    issues.push({ code: "manifest_missing", message: `No ${SCOPED_RUNTIME_MANIFEST_FILE} in ${descriptor.workDir}.` });
  } else if (load.status === "corrupt") {
    manifestState = "corrupt";
    issues.push({ code: "manifest_corrupt", message: `Runtime manifest failed integrity check: ${load.detail}` });
  } else if (!sameScopeChain(load.manifest.scopes, descriptor.scopes)) {
    manifestState = "scope_mismatch";
    issues.push({
      code: "scope_mismatch",
      message: `Manifest claims ${describeChain(load.manifest.scopes)} but the descriptor is ${describeChain(descriptor.scopes)}.`,
    });
  } else if (load.manifest.policyDigest !== descriptor.policyDigest) {
    manifestState = "policy_drift";
    issues.push({
      code: "policy_drift",
      message: `Manifest policy digest ${load.manifest.policyDigest} differs from the resolved ${descriptor.policyDigest}.`,
    });
  } else {
    manifestState = "ok";
  }

  const usage = exists ? await measureTree(descriptor.workDir) : { bytes: 0, files: 0, symlinks: 0, temporaryFiles: [] };
  const diskLimitBytes = descriptor.limits.maxDiskMb === undefined ? undefined : descriptor.limits.maxDiskMb * 1024 * 1024;
  const overDiskLimit = diskLimitBytes !== undefined && usage.bytes > diskLimitBytes;
  if (overDiskLimit) {
    issues.push({
      code: "disk_limit_exceeded",
      message: `Runtime uses ${usage.bytes} bytes; declared ceiling is ${diskLimitBytes} bytes (${descriptor.limits.maxDiskMb} MiB).`,
    });
  }
  if (usage.temporaryFiles.length > 0) {
    issues.push({
      code: "stale_temp_files",
      message: `${usage.temporaryFiles.length} leftover manifest temp file(s); a previous atomic write crashed.`,
    });
  }
  if (usage.symlinks > 0) {
    issues.push({ code: "symlinks_present", message: `${usage.symlinks} symlink(s) present; disk usage excludes their targets.` });
  }

  const orphans = options.includeOrphans === false ? [] : await scanOrphans(descriptor.root);
  if (orphans.length > 0) {
    issues.push({ code: "orphaned_runtimes", message: `${orphans.length} runtime director(ies) under ${descriptor.root} do not describe themselves.` });
  }

  return {
    workDir: descriptor.workDir,
    owner: descriptor.owner,
    exists,
    manifestState,
    manifest: load.status === "ok" ? load.manifest : undefined,
    diskBytes: usage.bytes,
    fileCount: usage.files,
    symlinkCount: usage.symlinks,
    diskLimitBytes,
    overDiskLimit,
    modeOctal,
    temporaryFiles: usage.temporaryFiles,
    orphans,
    issues,
    healthy: manifestState === "ok" && exists && !overDiskLimit && usage.temporaryFiles.length === 0,
  };
}

interface TreeUsage {
  bytes: number;
  files: number;
  symlinks: number;
  temporaryFiles: string[];
}

/**
 * Depth-bounded, symlink-refusing tree walk. Following symlinks would let a
 * single planted link make "disk usage of this scope's runtime" mean "disk usage
 * of the filesystem", and would walk the auditor out of the scope boundary it
 * is auditing. Links are counted and skipped.
 */
async function measureTree(root: string, maxDepth = 32): Promise<TreeUsage> {
  const usage: TreeUsage = { bytes: 0, files: 0, symlinks: 0, temporaryFiles: [] };
  const pending: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (pending.length > 0) {
    const { dir, depth } = pending.pop()!;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        usage.symlinks += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (depth + 1 <= maxDepth) pending.push({ dir: path, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      usage.files += 1;
      if (entry.name.startsWith(`${SCOPED_RUNTIME_MANIFEST_FILE}.`) && entry.name.endsWith(".tmp")) usage.temporaryFiles.push(path);
      const fileStats = await stat(path).catch(() => undefined);
      usage.bytes += fileStats?.size ?? 0;
    }
  }
  usage.temporaryFiles.sort();
  return usage;
}

/**
 * A healthy runtime directory names itself: its parent is its owner's scope
 * kind and its own name is `scopedRuntimeSlug(owner.id)`. Anything that fails
 * that round-trip is orphaned state — an abandoned first run, a manual copy, or
 * a renamed scope — and is reported rather than deleted.
 */
async function scanOrphans(root: string): Promise<ScopedRuntimeOrphan[]> {
  const orphans: ScopedRuntimeOrphan[] = [];
  const kindEntries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const kindEntry of kindEntries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
    if (!kindEntry.isDirectory()) continue;
    const kindDir = join(root, kindEntry.name);
    if (SCOPE_SPECIFICITY[kindEntry.name as MemoryScopeKind] === undefined) {
      orphans.push({ path: kindDir, reason: "unknown_scope_kind" });
      continue;
    }
    const runtimeEntries = await readdir(kindDir, { withFileTypes: true }).catch(() => []);
    for (const runtimeEntry of runtimeEntries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
      if (!runtimeEntry.isDirectory()) continue;
      const runtimeDir = join(kindDir, runtimeEntry.name);
      const load = await loadManifest(join(runtimeDir, SCOPED_RUNTIME_MANIFEST_FILE)).catch(
        (error: unknown): ManifestLoad => ({ status: "corrupt", detail: errorDetail(error) }),
      );
      if (load.status === "missing") {
        orphans.push({ path: runtimeDir, reason: "no_manifest" });
      } else if (load.status === "corrupt") {
        orphans.push({ path: runtimeDir, reason: "corrupt_manifest", detail: load.detail });
      } else if (load.manifest.owner.kind !== kindEntry.name || scopedRuntimeSlug(load.manifest.owner.id) !== runtimeEntry.name) {
        orphans.push({
          path: runtimeDir,
          reason: "path_scope_mismatch",
          detail: `manifest owner ${formatMemoryScope(load.manifest.owner)} does not hash to this path`,
        });
      }
    }
  }
  return orphans;
}

/* ---------- shared helpers ---------- */

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Key-sorted, undefined-dropping serialization so digests are stable across engines and field order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, field]) => `${JSON.stringify(key)}:${canonicalJson(field)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
