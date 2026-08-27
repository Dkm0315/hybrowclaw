/**
 * Workspace observer — the authoritative source of file-change truth for
 * Muster's audit spine (docs/STRATEGY_V2.md §2.2, §5.1, Wave 0 row 3).
 *
 * §2.2 measured `item/fileChange/patchUpdated` firing ZERO times across three
 * live Codex turns while all three edits landed on disk through shell
 * `commandExecution`. An observer that trusts backend self-report records
 * nothing. This module derives truth by OBSERVING THE WORKSPACE.
 *
 * FOUR INVARIANTS, stated once and enforced everywhere:
 *
 * 1. WATCH EVENTS ARE A TRIGGER, NEVER DATA. Every cycle re-derives full state
 *    from git + fs from scratch. Dropping every watch event costs latency
 *    (bounded by pollMs), never correctness. Live probe on Darwin 25.6.0 /
 *    Node 24: recursive fs.watch reports EVERY change as "rename", coalesces
 *    create-then-delete into one event, invents ancestor-directory entries, and
 *    may hand back a null filename. The payloads are unusable as data.
 *
 * 2. `git status` ALONE IS NOT SUFFICIENT. Verified: an agent that runs
 *    `git commit` mid-turn makes its own edits invisible to
 *    `git status --porcelain` (empty), while `git diff --name-status -M <rev>`
 *    against a rev pinned at start() still reports every change. So the
 *    observer pins a baseline commit and diffs the WORKTREE against it, using
 *    status only to discover untracked files and to inherit .gitignore.
 *
 * 3. STRICTLY READ-ONLY against the workspace and .git. Never `git add`, never
 *    `hash-object -w`, never the index lock (`--no-optional-locks` everywhere).
 *    The only writes go to a shadow tree under os.tmpdir(), deliberately
 *    outside the watched root so the observer can never trigger itself or
 *    perturb `git status`.
 *
 * 4. EVENTS ARE STRICTLY CHANGES SINCE start(). start() seeds the baseline and
 *    NEVER emits. Pre-existing dirty state is the world as the run found it,
 *    not something the run caused.
 *
 * KNOWN BLIND SPOT, stated rather than papered over: a file created and deleted
 * entirely between two detection cycles is invisible. Neither git nor the
 * lossy, type-less macOS watch stream can recover it. The window is bounded by
 * debounceMs/pollMs; a caller that flush()es at every tool-call boundary
 * shrinks it to near zero for shell-driven edits, which §2.2 shows is how Codex
 * actually edits.
 *
 * SECURITY: every diff invocation carries `--no-ext-diff --no-textconv`. That
 * is not cosmetic — a workspace-supplied .gitattributes diff driver would
 * otherwise execute an attacker-chosen command inside the audit path. Never
 * relax it for "nicer" binary diffs.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, watch, type FSWatcher } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

/* ---------- errors: fail closed, RunEventConflictError idiom ---------- */

export type WorkspaceObserverErrorCode =
  | "root_not_found"
  | "root_not_directory"
  | "not_a_git_repository"
  | "git_unavailable"
  | "already_started"
  | "not_started";

export class WorkspaceObserverError extends Error {
  readonly code: WorkspaceObserverErrorCode;
  readonly detail?: string;
  constructor(code: WorkspaceObserverErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "WorkspaceObserverError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/* ---------- events ---------- */

export type WorkspaceChangeKind = "add" | "modify" | "delete" | "rename";

export type DiffOmittedReason =
  | "binary"
  | "too_large"
  | "redacted_path"
  | "baseline_unavailable"
  | "budget"
  | "git_error"
  | "mode_only";

export interface WorkspacePatchEvent {
  readonly schemaVersion: 1;
  /** Literal — asserts provenance is NOT backend self-report (§2.2). */
  readonly source: "observer";
  readonly sequence: number;
  readonly atIso: string;
  readonly observerId: string;
  readonly root: string;
  /** POSIX, relative to the git toplevel; the NEW path for renames. */
  readonly path: string;
  readonly previousPath?: string;
  readonly changeKind: WorkspaceChangeKind;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly bytesBefore: number | null;
  readonly bytesAfter: number | null;
  readonly modeBefore: number | null;
  readonly modeAfter: number | null;
  readonly binary: boolean;
  readonly diff: string | null;
  readonly diffHash: string | null;
  readonly diffContextLines: number;
  readonly diffOmitted?: DiffOmittedReason;
  readonly detectedBy: "watch" | "poll" | "flush";
  readonly unstableRead?: true;
  readonly receiptHash: string;
  readonly idempotencyKey: string;
}

export type WorkspaceObserverDiagnosticCode =
  | "watch_unavailable"
  | "watch_error"
  | "git_command_failed"
  | "diff_failed"
  | "read_failed"
  | "shadow_evicted"
  | "cycle_overrun"
  | "listener_threw";

export interface WorkspaceObserverDiagnostic {
  readonly code: WorkspaceObserverDiagnosticCode;
  readonly detail: string;
  readonly path?: string;
  readonly atIso: string;
}

/* ---------- options + handle ---------- */

export type IgnoreMatcher = readonly string[] | ((relPath: string) => boolean);

export interface WorkspaceObserverOptions {
  /** Workspace to observe. May be the git toplevel or any directory inside it. */
  readonly root: string;
  /** Delivered once per detected change, in deterministic path order. Never called from start(). */
  readonly onPatch: (event: WorkspacePatchEvent) => void;
  /** Non-fatal degradation. Never throws; absence of a handler is not an error. */
  readonly onDiagnostic?: (diagnostic: WorkspaceObserverDiagnostic) => void;
  /** Trailing-edge debounce after a watch trigger. Default 120. */
  readonly debounceMs?: number;
  /** Hard cap so a continuous write storm cannot starve emission. Default debounceMs * 8. */
  readonly maxDebounceMs?: number;
  /** Periodic fallback cycle; the sole correctness guarantee if watch is lossy. Default 2000. 0 disables (tests only). */
  readonly pollMs?: number;
  /** Install fs.watch at all. Default true. `false` gives a deterministic poll-only observer. */
  readonly watch?: boolean;
  /** Extra exclusions beyond .gitignore. Strings match exact path, path prefix, or any whole segment. ".git" is always excluded. */
  readonly ignore?: IgnoreMatcher;
  /** Paths whose diff text is suppressed (hashes still emitted → audit complete, secret not leaked). */
  readonly secretPathPatterns?: readonly string[];
  /** Above this, hashes only; diff omitted "too_large". Hashing is streamed and has no size limit. Default 8 MiB. */
  readonly maxDiffBytes?: number;
  /** Unified context lines. Pinned onto every event so a verifier can recompute. Default 3. */
  readonly contextLines?: number;
  /** Total shadow-tree budget; beyond it the largest baselines are dropped. Default 256 MiB. */
  readonly maxShadowBytes?: number;
  /** Spawn budget per cycle; overflow marks diffOmitted "budget". Default 200. */
  readonly maxGitSpawnsPerCycle?: number;
  readonly gitBin?: string;
  readonly gitTimeoutMs?: number;
  /** Injectable clock (stream.ts precedent). Default Date.now. */
  readonly now?: () => number;
}

export interface WorkspaceFileState {
  readonly hash: string;
  readonly bytes: number;
  readonly mode: number;
  /** null ⇒ baseline unavailable, diffs degrade to hashes. */
  readonly shadowPath: string | null;
}

export interface WorkspaceObserverStats {
  readonly cycles: number;
  readonly watchTriggers: number;
  readonly pollTriggers: number;
  readonly gitSpawns: number;
  readonly lastCycleMs: number;
  readonly eventsEmitted: number;
}

export interface WorkspaceObserver {
  /** Resolves root, verifies git (fails closed), pins the baseline rev, seeds shadows for already-dirty paths, installs watch + poll. Emits nothing. */
  start(): Promise<void>;
  /** Idempotent. Clears timers, closes the watcher, removes the shadow tree. Safe before start(). */
  stop(): Promise<void>;
  /** Forces a cycle that begins AFTER this call returns to the event loop; awaits any in-flight cycle first. */
  flush(): Promise<readonly WorkspacePatchEvent[]>;
  /** Git toplevel, realpath-resolved. NOTE: event paths are toplevel-relative even when `root` was a subdirectory. */
  readonly root: string;
  readonly scope: string;
  readonly baselineRev: string;
  readonly sequence: number;
  readonly degraded: boolean;
  readonly stats: WorkspaceObserverStats;
  /** Last observed state per path; absent paths (observed deletes) are not listed. */
  snapshot(): ReadonlyMap<string, WorkspaceFileState>;
}

/* ---------- pure helpers (unit-testable without a repo) ---------- */

export interface StatusEntry { readonly x: string; readonly y: string; readonly path: string; readonly origPath?: string; }
export interface NameStatusEntry { readonly status: string; readonly path: string; readonly origPath?: string; }

function sha256Hex(input: string | Uint8Array): string {
  const digest = createHash("sha256");
  digest.update(typeof input === "string" ? Buffer.from(input, "utf8") : input);
  return digest.digest("hex");
}

/** sha256 over RAW BYTES — no line-ending or encoding normalization, ever. */
export function hashBytes(bytes: Uint8Array): string {
  return `sha256:${sha256Hex(bytes)}`;
}

/** git's own heuristic: a NUL inside the first 8000 bytes. Decided by US, never by parsing git output. */
export function isBinaryContent(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8000).includes(0);
}

/** F1: `XY<space>path\0`; renames are `R  <NEW>\0<OLD>\0` — NEW FIRST. */
export function parseStatusZ(stdout: string): readonly StatusEntry[] {
  const records = stdout.split("\0");
  const entries: StatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.length < 4) continue;
    const x = record[0]!;
    const y = record[1]!;
    const path = record.slice(3);
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      index += 1;
      entries.push({ x, y, path, origPath: records[index] ?? "" });
    } else {
      entries.push({ x, y, path });
    }
  }
  return entries;
}

/** F2: `M\0path\0`; renames are `R100\0<OLD>\0<NEW>\0` — OLD FIRST, the opposite of F1. */
export function parseNameStatusZ(stdout: string): readonly NameStatusEntry[] {
  const records = stdout.split("\0");
  const entries: NameStatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const status = records[index]!;
    if (!status) continue;
    if (status[0] === "R" || status[0] === "C") {
      const origPath = records[index + 1] ?? "";
      const path = records[index + 2] ?? "";
      index += 2;
      if (path) entries.push({ status, path, origPath });
    } else {
      const path = records[index + 1] ?? "";
      index += 1;
      if (path) entries.push({ status, path });
    }
  }
  return entries;
}

/** Ordering must never depend on locale — Buffer.compare of utf8, never localeCompare. */
export function comparePathBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Strings match exact path, path prefix, or any whole path segment. */
export function matchesIgnore(relPath: string, matcher?: IgnoreMatcher): boolean {
  if (!matcher) return false;
  if (typeof matcher === "function") return matcher(relPath);
  const segments = relPath.split("/");
  return matcher.some((raw) => {
    const pattern = raw.replace(/\/+$/, "");
    if (!pattern) return false;
    return relPath === pattern || relPath.startsWith(`${pattern}/`) || segments.includes(pattern);
  });
}

const globCache = new Map<string, RegExp>();

function globMatches(pattern: string, value: string): boolean {
  let compiled = globCache.get(pattern);
  if (!compiled) {
    const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
    compiled = new RegExp(`^${source}$`);
    globCache.set(pattern, compiled);
  }
  return compiled.test(value);
}

function matchesSecretPattern(relPath: string, patterns: readonly string[]): boolean {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  return patterns.some((pattern) => globMatches(pattern, relPath) || globMatches(pattern, base));
}

/**
 * F9: `--no-index` header paths are the absolute paths with the leading "/"
 * stripped, and git appends a TAB to `---`/`+++` when the name has a space.
 * Rewrites ONLY line 0 and the `--- `/`+++ `/`Binary files ` lines that occur
 * BEFORE the first `@@` — a file whose CONTENT mentions the shadow path must
 * not be corrupted.
 */
export function rewriteDiffHeader(diff: string, from: string, to: string, path: string, previousPath?: string): string {
  if (!diff) return diff;
  const aPath = previousPath ?? path;
  const aLabel = `a/${aPath}`;
  const bLabel = `b/${path}`;
  // git tab-terminates names containing spaces; keep that so `git apply` reparses.
  const aLine = aPath.includes(" ") ? `${aLabel}\t` : aLabel;
  const bLine = path.includes(" ") ? `${bLabel}\t` : bLabel;
  const fromLabel = `a/${from.replace(/^\/+/, "")}`;
  const toLabel = `b/${to.replace(/^\/+/, "")}`;
  const lines = diff.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith("@@")) break;
    if (index === 0 && line.startsWith("diff --git ")) { lines[index] = `diff --git ${aLabel} ${bLabel}`; continue; }
    if (line.startsWith("--- ")) { lines[index] = line.startsWith("--- /dev/null") ? "--- /dev/null" : `--- ${aLine}`; continue; }
    if (line.startsWith("+++ ")) { lines[index] = line.startsWith("+++ /dev/null") ? "+++ /dev/null" : `+++ ${bLine}`; continue; }
    if (line.startsWith("Binary files ")) lines[index] = line.split(fromLabel).join(aLabel).split(toLabel).join(bLabel);
  }
  return lines.join("\n");
}

/** git's own -M does NOT pair an unstaged mv (verified), so rename diffs are synthesized deterministically. */
export function synthesizeRenameDiff(previousPath: string, path: string): string {
  return [`diff --git a/${previousPath} b/${path}`, "similarity index 100%", `rename from ${previousPath}`, `rename to ${path}`, ""].join("\n");
}

/**
 * Array form, not object — sidesteps key-ordering ambiguity entirely.
 * `sequence`, `atIso`, `observerId` and `detectedBy` are deliberately EXCLUDED:
 * two observers watching the same physical transition must agree on the
 * receipt, or run-events.ts:198-208 fires a conflict on benign timing skew.
 */
export function computePatchReceipt(
  event: Omit<WorkspacePatchEvent, "receiptHash" | "idempotencyKey">,
): { readonly receiptHash: string; readonly idempotencyKey: string } {
  const idempotency = sha256Hex(JSON.stringify([
    1, event.root, event.changeKind, event.path, event.previousPath ?? "", event.beforeHash ?? "", event.afterHash ?? "",
  ]));
  const receipt = sha256Hex(JSON.stringify([
    1, event.changeKind, event.path, event.previousPath ?? "", event.beforeHash ?? "", event.afterHash ?? "",
    event.modeBefore ?? 0, event.modeAfter ?? 0, event.binary, event.diffHash ?? "", event.diffOmitted ?? "", event.diffContextLines,
  ]));
  return { receiptHash: `sha256:${receipt}`, idempotencyKey: `workspace.patch:${idempotency}` };
}

/* ---------- runGit: private, binary-safe ---------- */

interface GitResult { readonly code: number; readonly stdout: Buffer; readonly stderr: string; }

/**
 * Deliberate duplication of subprocess.ts: that helper accumulates stdout with
 * `chunk.toString()` (subprocess.ts:74), which corrupts `cat-file blob` on
 * binary content. Buffers are concatenated instead and only decoded where the
 * caller knows the payload is text. Teardown is graded in the spirit of
 * subprocess.ts:61-68 — SIGTERM, SIGKILL after the grace, then unref, so a
 * wedged git can never keep the host alive.
 */
function runGit(gitBin: string, args: readonly string[], options: { readonly cwd: string; readonly timeoutMs: number; readonly killGraceMs?: number }): Promise<GitResult> {
  const killGraceMs = options.killGraceMs ?? 1500;
  return new Promise<GitResult>((resolveResult, rejectResult) => {
    const chunks: Buffer[] = [];
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(gitBin, [...args], { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      rejectResult(toGitSpawnError(error, gitBin));
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      sigkillTimer = setTimeout(() => { child.kill("SIGKILL"); child.unref(); }, killGraceMs);
      sigkillTimer.unref?.();
    }, options.timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error: Error) => {
      clearTimeout(timer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      if (settled) return;
      settled = true;
      rejectResult(toGitSpawnError(error, gitBin));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      if (settled) return;
      settled = true;
      if (timedOut) { rejectResult(new Error(`git timed out after ${options.timeoutMs}ms: ${args.join(" ")}`)); return; }
      resolveResult({ code: code ?? -1, stdout: Buffer.concat(chunks), stderr });
    });
  });
}

function toGitSpawnError(error: unknown, gitBin: string): Error {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT" || code === "EACCES") {
    return new WorkspaceObserverError("git_unavailable", `Cannot execute git binary "${gitBin}" (${code}).`, String((error as Error).message ?? code));
  }
  return error instanceof Error ? error : new Error(String(error));
}

/* ---------- internals ---------- */

type Trigger = "watch" | "poll" | "flush";

interface InternalState {
  readonly present: boolean;
  readonly hash: string | null;
  readonly bytes: number | null;
  readonly mode: number | null;
  readonly shadowPath: string | null;
  readonly shadowBytes: number;
}

interface CurrentRead {
  readonly present: boolean;
  readonly content: Buffer | null;
  readonly head: Buffer;
  readonly hash: string | null;
  readonly bytes: number | null;
  readonly mode: number | null;
  readonly unstable: boolean;
}

interface Draft {
  readonly path: string;
  readonly previousPath?: string;
  readonly changeKind: WorkspaceChangeKind;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly bytesBefore: number | null;
  readonly bytesAfter: number | null;
  readonly modeBefore: number | null;
  readonly modeAfter: number | null;
  readonly binary: boolean;
  readonly unstable: boolean;
  readonly shadowPath: string | null;
  readonly current: CurrentRead;
}

const ABSENT: CurrentRead = { present: false, content: null, head: Buffer.alloc(0), hash: null, bytes: null, mode: null, unstable: false };
const DEFAULT_SECRET_PATTERNS: readonly string[] = [".env", ".env.*", "*.pem", "*.key", "id_rsa*", "*.p12", "*.pfx"];
const EMPTY_STATS: WorkspaceObserverStats = { cycles: 0, watchTriggers: 0, pollTriggers: 0, gitSpawns: 0, lastCycleMs: 0, eventsEmitted: 0 };

function toPosix(value: string): string {
  return sep === "/" ? value : value.split(sep).join("/");
}

function isGitInternal(relPath: string): boolean {
  return relPath === ".git" || relPath.startsWith(".git/");
}

function filePermission(mode: number | null): number {
  return mode === 100755 ? 0o755 : 0o644;
}

function streamHash(absPath: string): Promise<{ readonly hash: string; readonly bytes: number; readonly head: Buffer }> {
  return new Promise((resolveHash, rejectHash) => {
    const digest = createHash("sha256");
    const headParts: Buffer[] = [];
    let headBytes = 0;
    let bytes = 0;
    const stream = createReadStream(absPath);
    stream.on("data", (chunk: string | Buffer) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      digest.update(buffer);
      bytes += buffer.length;
      if (headBytes < 8000) { headParts.push(buffer.subarray(0, 8000 - headBytes)); headBytes += Math.min(buffer.length, 8000 - headBytes); }
    });
    stream.on("error", rejectHash);
    stream.on("end", () => resolveHash({ hash: `sha256:${digest.digest("hex")}`, bytes, head: Buffer.concat(headParts) }));
  });
}

/* ---------- factory ---------- */

export function createWorkspaceObserver(options: WorkspaceObserverOptions): WorkspaceObserver {
  const debounceMs = options.debounceMs ?? 120;
  const maxDebounceMs = options.maxDebounceMs ?? debounceMs * 8;
  const pollMs = options.pollMs ?? 2000;
  const useWatch = options.watch ?? true;
  const secretPatterns = options.secretPathPatterns ?? DEFAULT_SECRET_PATTERNS;
  const maxDiffBytes = options.maxDiffBytes ?? 8 * 1024 * 1024;
  const contextLines = options.contextLines ?? 3;
  const maxShadowBytes = options.maxShadowBytes ?? 256 * 1024 * 1024;
  const maxGitSpawnsPerCycle = options.maxGitSpawnsPerCycle ?? 200;
  const gitBin = options.gitBin ?? "git";
  const gitTimeoutMs = options.gitTimeoutMs ?? 10_000;
  const now = options.now ?? Date.now;
  const observerId = randomUUID();

  const state = new Map<string, InternalState>();
  let toplevel = "";
  let observedDir = "";
  let scope = "";
  let baselineRev = "";
  let shadowRoot: string | null = null;
  let shadowTotal = 0;
  let sequence = 0;
  let degraded = false;
  let started = false;
  let stopped = false;
  let watcher: FSWatcher | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let debounceStartedAt: number | undefined;
  let queuedNonFlush = false;
  let queuedNonFlushPromise: Promise<readonly WorkspacePatchEvent[]> | undefined;
  let tail: Promise<void> = Promise.resolve();
  let spawnsThisCycle = 0;
  let stats = EMPTY_STATS;

  const diagnostic = (code: WorkspaceObserverDiagnosticCode, detail: string, path?: string): void => {
    if (!options.onDiagnostic) return;
    try {
      options.onDiagnostic(path === undefined
        ? { code, detail, atIso: new Date(now()).toISOString() }
        : { code, detail, path, atIso: new Date(now()).toISOString() });
    } catch { /* diagnostics must never escalate */ }
  };

  const git = async (args: readonly string[], allowed: readonly number[] = [0]): Promise<GitResult> => {
    spawnsThisCycle += 1;
    stats = { ...stats, gitSpawns: stats.gitSpawns + 1 };
    const prefix = ["--no-optional-locks", "-c", "core.quotepath=false", "-c", "diff.algorithm=histogram", "-C", toplevel || observedDir];
    const result = await runGit(gitBin, [...prefix, ...args], { cwd: toplevel || observedDir, timeoutMs: gitTimeoutMs });
    if (!allowed.includes(result.code)) {
      throw new Error(`git ${args.join(" ")} exited ${result.code}: ${result.stderr.trim()}`);
    }
    return result;
  };

  const pathspec = (): string => (scope === "" ? "." : scope);
  const absolute = (relPath: string): string => join(toplevel, relPath);
  const isExcluded = (relPath: string): boolean => isGitInternal(relPath) || matchesIgnore(relPath, options.ignore);
  const shadowFor = (relPath: string): string => join(shadowRoot!, `${sha256Hex(relPath)}.blob`);

  /* --- workspace reads --- */

  async function readCurrent(relPath: string): Promise<CurrentRead> {
    const absPath = absolute(relPath);
    let info;
    try {
      info = await lstat(absPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") diagnostic("read_failed", `lstat failed: ${String((error as Error).message)}`, relPath);
      return ABSENT;
    }
    if (info.isDirectory()) {
      diagnostic("read_failed", "Path is a directory where a file was observed; recorded as a delete.", relPath);
      return ABSENT;
    }
    if (info.isSymbolicLink()) {
      // Hash the LINK TARGET STRING (git's blob content for a symlink), so a
      // dangling symlink is observable rather than an ENOENT.
      try {
        const content = Buffer.from(await readlink(absPath), "utf8");
        return { present: true, content, head: content.subarray(0, 8000), hash: hashBytes(content), bytes: content.length, mode: 120000, unstable: false };
      } catch (error) {
        diagnostic("read_failed", `readlink failed: ${String((error as Error).message)}`, relPath);
        return ABSENT;
      }
    }
    if (!info.isFile()) return ABSENT;
    const mode = (info.mode & 0o111) !== 0 ? 100755 : 100644;
    try {
      let content: Buffer | null = null;
      let head: Buffer;
      let hash: string;
      let bytes: number;
      if (info.size <= maxDiffBytes) {
        content = await readFile(absPath);
        head = content.subarray(0, 8000);
        hash = hashBytes(content);
        bytes = content.length;
      } else {
        const streamed = await streamHash(absPath);
        head = streamed.head;
        hash = streamed.hash;
        bytes = streamed.bytes;
      }
      let unstable = false;
      try {
        const after = await lstat(absPath);
        unstable = after.size !== info.size || after.mtimeMs !== info.mtimeMs;
      } catch { unstable = true; }
      return { present: true, content, head, hash, bytes, mode, unstable };
    } catch (error) {
      diagnostic("read_failed", `read failed: ${String((error as Error).message)}`, relPath);
      return ABSENT;
    }
  }

  async function commitShadow(relPath: string, read: CurrentRead): Promise<{ shadowPath: string | null; shadowBytes: number }> {
    if (!shadowRoot || !read.present) return { shadowPath: null, shadowBytes: 0 };
    const target = shadowFor(relPath);
    try {
      if (read.content) await writeFile(target, read.content);
      else await copyFile(absolute(relPath), target);
      await chmod(target, filePermission(read.mode));
      return { shadowPath: target, shadowBytes: read.bytes ?? 0 };
    } catch (error) {
      diagnostic("read_failed", `shadow write failed: ${String((error as Error).message)}`, relPath);
      return { shadowPath: null, shadowBytes: 0 };
    }
  }

  function enforceShadowBudget(): void {
    if (shadowTotal <= maxShadowBytes) return;
    const evictable = [...state.entries()]
      .filter(([, entry]) => entry.shadowPath !== null)
      .sort((a, b) => b[1].shadowBytes - a[1].shadowBytes);
    for (const [relPath, entry] of evictable) {
      if (shadowTotal <= maxShadowBytes) break;
      void unlink(entry.shadowPath!).catch(() => {});
      shadowTotal -= entry.shadowBytes;
      state.set(relPath, { ...entry, shadowPath: null, shadowBytes: 0 });
      diagnostic("shadow_evicted", `Evicted shadow baseline to stay under ${maxShadowBytes} bytes.`, relPath);
    }
  }

  /* --- discovery --- */

  async function discoverCandidates(): Promise<Set<string>> {
    const candidates = new Set<string>();
    // (a) worktree vs the PINNED baseline — survives a mid-run `git commit` (F6).
    const nameStatus = await git(["diff", "--name-status", "-z", "-M", "--no-ext-diff", "--no-textconv", "--no-color", baselineRev, "--", pathspec()]);
    for (const entry of parseNameStatusZ(nameStatus.stdout.toString("utf8"))) {
      candidates.add(entry.path);
      if (entry.origPath) candidates.add(entry.origPath);
    }
    // (b) untracked files; -uall is REQUIRED or an untracked directory collapses to "dir/" (F4).
    //     Ignored files never appear here (F7), so .gitignore semantics come free from the user's real config.
    const status = await git(["status", "--porcelain", "-z", "-uall", "--", pathspec()]);
    for (const entry of parseStatusZ(status.stdout.toString("utf8"))) {
      candidates.add(entry.path);
      if (entry.origPath) candidates.add(entry.origPath);
    }
    for (const relPath of [...candidates]) if (!relPath || isExcluded(relPath)) candidates.delete(relPath);
    return candidates;
  }

  /** F14: one batched ls-tree gives baseline modes for every first-sight path. */
  async function baselineModes(paths: readonly string[]): Promise<Map<string, number>> {
    const modes = new Map<string, number>();
    for (let at = 0; at < paths.length; at += 200) {
      const batch = paths.slice(at, at + 200);
      const result = await git(["ls-tree", "-z", baselineRev, "--", ...batch]);
      for (const record of result.stdout.toString("utf8").split("\0")) {
        const tab = record.indexOf("\t");
        if (tab < 0) continue;
        const mode = Number.parseInt(record.slice(0, record.indexOf(" ")), 10);
        modes.set(record.slice(tab + 1), Number.isNaN(mode) ? 100644 : mode);
      }
    }
    return modes;
  }

  /** F13: one command answers both "baseline content?" and "did it exist at baseline?". */
  async function baselineBlob(relPath: string): Promise<Buffer | null> {
    const result = await git(["cat-file", "blob", `${baselineRev}:${relPath}`], [0, 128]);
    return result.code === 0 ? result.stdout : null;
  }

  /* --- diffing --- */

  async function buildDiff(draft: Draft): Promise<{ diff: string | null; omitted?: DiffOmittedReason }> {
    if (draft.changeKind === "rename") return { diff: synthesizeRenameDiff(draft.previousPath!, draft.path) };
    if (draft.binary) return { diff: null, omitted: "binary" };
    if (matchesSecretPattern(draft.path, secretPatterns)) return { diff: null, omitted: "redacted_path" };
    if ((draft.bytesBefore ?? 0) > maxDiffBytes || (draft.bytesAfter ?? 0) > maxDiffBytes) return { diff: null, omitted: "too_large" };
    if (draft.beforeHash !== null && draft.shadowPath === null) return { diff: null, omitted: "baseline_unavailable" };
    if (spawnsThisCycle >= maxGitSpawnsPerCycle) return { diff: null, omitted: "budget" };

    const before = draft.shadowPath ?? "/dev/null"; // F11: /dev/null works as either side
    let after = "/dev/null";
    if (draft.current.present) {
      // A symlink cannot be handed to --no-index as itself; materialize the
      // target string so the diff shows the retarget. modeAfter still reports 120000.
      after = draft.modeAfter === 120000 && shadowRoot
        ? await materializeAfter(draft)
        : absolute(draft.path);
    }
    if (draft.shadowPath) {
      // F10: mismatched modes make git inject spurious old/new mode lines, so
      // pin the shadow to modeBefore. Genuine chmods then render for free.
      try { await chmod(draft.shadowPath, filePermission(draft.modeBefore)); } catch { /* best effort */ }
    }
    let result: GitResult;
    try {
      // --no-ext-diff/--no-textconv are a SECURITY requirement (see module header).
      result = await git(["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", `-U${contextLines}`, "--", before, after], [0, 1]);
    } catch (error) {
      diagnostic("diff_failed", String((error as Error).message), draft.path);
      return { diff: null, omitted: "git_error" };
    } finally {
      if (after !== "/dev/null" && after !== absolute(draft.path)) void unlink(after).catch(() => {});
    }
    // F8: exit 1 means BOTH "differences found" and "could not access".
    if (result.code === 1 && result.stdout.length === 0) {
      diagnostic("diff_failed", result.stderr.trim() || "git diff --no-index reported an error with no output.", draft.path);
      return { diff: null, omitted: "git_error" };
    }
    const text = rewriteDiffHeader(result.stdout.toString("utf8"), before, after, draft.path, draft.previousPath);
    if (draft.beforeHash !== null && draft.beforeHash === draft.afterHash) return { diff: text, omitted: "mode_only" };
    return { diff: text };
  }

  async function materializeAfter(draft: Draft): Promise<string> {
    const target = join(shadowRoot!, `after-${sha256Hex(draft.path)}.blob`);
    await writeFile(target, draft.current.content ?? Buffer.alloc(0));
    await chmod(target, 0o644);
    return target;
  }

  /* --- the detection cycle --- */

  async function detectOnce(reason: Trigger): Promise<readonly WorkspacePatchEvent[]> {
    if (!started || stopped) return [];
    const cycleStart = now();
    spawnsThisCycle = 0;
    stats = { ...stats, cycles: stats.cycles + 1 };
    let drafts: Draft[] = [];
    let requeue = false;
    try {
      const candidates = await discoverCandidates();
      // (c) every path already in the state map — MANDATORY. This is what catches
      //     a revert-to-baseline, which (a) and (b) both report as "nothing".
      for (const relPath of state.keys()) if (!isExcluded(relPath)) candidates.add(relPath);
      const ordered = [...candidates].sort(comparePathBytes);
      const firstSight = ordered.filter((relPath) => !state.has(relPath));
      const treeModes = firstSight.length > 0 ? await baselineModes(firstSight) : new Map<string, number>();

      for (const relPath of ordered) {
        const current = await readCurrent(relPath);
        let prior = state.get(relPath);
        if (!prior) {
          // First sight: F13 answers "baseline content?" and "did it exist?" in one command.
          const treeMode = treeModes.get(relPath);
          const blob = treeMode === undefined ? null : await baselineBlob(relPath);
          prior = blob
            ? { present: true, hash: hashBytes(blob), bytes: blob.length, mode: treeMode ?? 100644, ...(await commitBaselineShadow(relPath, blob, treeMode ?? 100644)) }
            : { present: false, hash: null, bytes: null, mode: null, shadowPath: null, shadowBytes: 0 };
          state.set(relPath, prior);
        }
        if (!prior.present && !current.present) continue;
        if (prior.present && current.present && prior.hash === current.hash && prior.mode === current.mode) continue;
        drafts.push({
          path: relPath,
          changeKind: !prior.present ? "add" : !current.present ? "delete" : "modify",
          beforeHash: prior.hash,
          afterHash: current.hash,
          bytesBefore: prior.bytes,
          bytesAfter: current.bytes,
          modeBefore: prior.mode,
          modeAfter: current.mode,
          binary: isBinaryContent(current.head) || (await baselineIsBinary(prior)),
          unstable: current.unstable,
          shadowPath: prior.shadowPath,
          current,
        });
        if (current.unstable) requeue = true;
      }
      drafts = pairRenames(drafts);
    } catch (error) {
      diagnostic("git_command_failed", String((error as Error).message));
      return [];
    }

    const emitted: WorkspacePatchEvent[] = [];
    for (const draft of drafts) {
      const { diff, omitted } = await buildDiff(draft);
      const partial = {
        schemaVersion: 1 as const,
        source: "observer" as const,
        sequence: sequence + 1,
        atIso: new Date(now()).toISOString(),
        observerId,
        root: toplevel,
        path: draft.path,
        ...(draft.previousPath !== undefined ? { previousPath: draft.previousPath } : {}),
        changeKind: draft.changeKind,
        beforeHash: draft.beforeHash,
        afterHash: draft.afterHash,
        bytesBefore: draft.bytesBefore,
        bytesAfter: draft.bytesAfter,
        modeBefore: draft.modeBefore,
        modeAfter: draft.modeAfter,
        binary: draft.binary,
        diff,
        diffHash: diff === null ? null : hashBytes(Buffer.from(diff, "utf8")),
        diffContextLines: contextLines,
        ...(omitted !== undefined ? { diffOmitted: omitted } : {}),
        detectedBy: reason,
        ...(draft.unstable ? { unstableRead: true as const } : {}),
      };
      sequence += 1;
      emitted.push({ ...partial, ...computePatchReceipt(partial) });
    }

    for (const event of emitted) {
      // A throwing listener must never abort delivery of the remaining events.
      try { options.onPatch(event); }
      catch (error) { diagnostic("listener_threw", String((error as Error)?.message ?? error), event.path); }
    }

    for (const draft of drafts) {
      if (draft.previousPath !== undefined) await retire(draft.previousPath);
      await adopt(draft.path, draft.current);
    }
    enforceShadowBudget();

    const elapsed = now() - cycleStart;
    stats = { ...stats, lastCycleMs: elapsed, eventsEmitted: stats.eventsEmitted + emitted.length };
    if (pollMs > 0 && elapsed > pollMs) diagnostic("cycle_overrun", `Cycle took ${elapsed}ms, exceeding pollMs=${pollMs}.`);
    if (requeue) enqueue("poll");
    return emitted;
  }

  async function baselineIsBinary(prior: InternalState): Promise<boolean> {
    if (!prior.present || !prior.shadowPath) return false;
    try {
      const handle = await readFile(prior.shadowPath);
      return isBinaryContent(handle.subarray(0, 8000));
    } catch { return false; }
  }

  async function commitBaselineShadow(relPath: string, blob: Buffer, mode: number): Promise<{ shadowPath: string | null; shadowBytes: number }> {
    if (!shadowRoot) return { shadowPath: null, shadowBytes: 0 };
    const target = shadowFor(relPath);
    try {
      await writeFile(target, blob);
      await chmod(target, filePermission(mode));
      shadowTotal += blob.length;
      return { shadowPath: target, shadowBytes: blob.length };
    } catch (error) {
      diagnostic("read_failed", `shadow seed failed: ${String((error as Error).message)}`, relPath);
      return { shadowPath: null, shadowBytes: 0 };
    }
  }

  async function adopt(relPath: string, current: CurrentRead): Promise<void> {
    const prior = state.get(relPath);
    if (prior?.shadowPath) shadowTotal -= prior.shadowBytes;
    if (!current.present) {
      if (prior?.shadowPath) void unlink(prior.shadowPath).catch(() => {});
      state.set(relPath, { present: false, hash: null, bytes: null, mode: null, shadowPath: null, shadowBytes: 0 });
      return;
    }
    const shadow = await commitShadow(relPath, current);
    shadowTotal += shadow.shadowBytes;
    state.set(relPath, { present: true, hash: current.hash, bytes: current.bytes, mode: current.mode, ...shadow });
  }

  async function retire(relPath: string): Promise<void> {
    const prior = state.get(relPath);
    if (prior?.shadowPath) { shadowTotal -= prior.shadowBytes; void unlink(prior.shadowPath).catch(() => {}); }
    state.set(relPath, { present: false, hash: null, bytes: null, mode: null, shadowPath: null, shadowBytes: 0 });
  }

  /**
   * Rename detection is OURS: git reports an unstaged `mv` as ` D old` + `?? new`
   * and -M does not pair it (verified). A delete and an add in the SAME cycle
   * with identical content collapse into one rename. A rename WITH an edit
   * degrades to delete + add — coarser, never wrong.
   */
  function pairRenames(drafts: readonly Draft[]): Draft[] {
    const deletes = drafts.filter((draft) => draft.changeKind === "delete");
    const adds = drafts.filter((draft) => draft.changeKind === "add");
    if (deletes.length === 0 || adds.length === 0) return [...drafts];
    const consumed = new Set<Draft>();
    const renames = new Map<Draft, Draft>();
    for (const removed of deletes) {
      const match = adds.find((added) => !consumed.has(added) && added.afterHash !== null && added.afterHash === removed.beforeHash);
      if (!match) continue;
      consumed.add(match);
      consumed.add(removed);
      renames.set(match, removed);
    }
    const result: Draft[] = [];
    for (const draft of drafts) {
      const removed = renames.get(draft);
      if (removed) {
        result.push({ ...draft, changeKind: "rename", previousPath: removed.path, beforeHash: removed.beforeHash, bytesBefore: removed.bytesBefore, modeBefore: removed.modeBefore, shadowPath: removed.shadowPath });
        continue;
      }
      if (consumed.has(draft)) continue; // the delete half of a pair
      result.push(draft);
    }
    return result.sort((a, b) => comparePathBytes(a.path, b.path));
  }

  /* --- scheduling --- */

  function enqueue(reason: Trigger): Promise<readonly WorkspacePatchEvent[]> {
    if (reason !== "flush") {
      // Collapse: a queued-but-unstarted non-flush cycle already covers this trigger.
      if (queuedNonFlush && queuedNonFlushPromise) return queuedNonFlushPromise;
      queuedNonFlush = true;
    }
    const run = (): Promise<readonly WorkspacePatchEvent[]> => {
      if (reason !== "flush") { queuedNonFlush = false; queuedNonFlushPromise = undefined; }
      return detectOnce(reason);
    };
    const next = tail.then(run, run);
    tail = next.then(() => {}, () => {});
    if (reason !== "flush") { queuedNonFlushPromise = next; next.catch(() => {}); }
    return next;
  }

  function scheduleDebounced(): void {
    if (!started || stopped) return;
    stats = { ...stats, watchTriggers: stats.watchTriggers + 1 };
    if (debounceStartedAt === undefined) debounceStartedAt = now();
    if (debounceTimer) clearTimeout(debounceTimer);
    const elapsed = now() - debounceStartedAt;
    const wait = Math.max(0, Math.min(debounceMs, maxDebounceMs - elapsed));
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      debounceStartedAt = undefined;
      enqueue("watch");
    }, wait);
    debounceTimer.unref?.();
  }

  let watchRearmed = false;

  function installWatch(): void {
    if (!useWatch) { degraded = true; return; }
    try {
      watcher = watch(observedDir, { recursive: true }, (_type, filename) => {
        // Invariant 1: the payload is discarded. It only decides whether to run
        // a cycle, and a wrong decision to run is free.
        if (filename === null || filename === undefined) { scheduleDebounced(); return; }
        const name = toPosix(String(filename));
        const relPath = scope === "" ? name : `${scope}/${name}`;
        if (isExcluded(relPath)) return;
        scheduleDebounced();
      });
      watcher.unref();
      watcher.on("error", (error: Error) => {
        diagnostic("watch_error", String(error.message));
        try { watcher?.close(); } catch { /* already gone */ }
        watcher = undefined;
        if (watchRearmed || stopped) { degraded = true; return; } // one re-arm, then degrade to poll-only
        watchRearmed = true;
        installWatch();
      });
    } catch (error) {
      degraded = true;
      diagnostic("watch_unavailable", String((error as Error).message));
    }
  }

  /* --- lifecycle --- */

  let starting = false;

  async function start(): Promise<void> {
    // Re-entry fails closed: a second start() during an in-flight start() would
    // install a second watcher and orphan the first shadow tree.
    if (started || starting) throw new WorkspaceObserverError("already_started", "Observer has already been started.");
    starting = true;
    stopped = false;
    try {
      await startInner();
    } finally {
      starting = false;
    }
  }

  async function startInner(): Promise<void> {
    let resolved: string;
    try {
      resolved = await realpath(resolve(options.root));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") throw new WorkspaceObserverError("root_not_found", `Workspace root does not exist: ${options.root}`);
      throw error;
    }
    if (!(await stat(resolved)).isDirectory()) throw new WorkspaceObserverError("root_not_directory", `Workspace root is not a directory: ${options.root}`);
    observedDir = resolved;

    // F15: fails closed on a non-repo; toplevel comes back realpath-resolved.
    const top = await runGit(gitBin, ["--no-optional-locks", "-C", resolved, "rev-parse", "--show-toplevel"], { cwd: resolved, timeoutMs: gitTimeoutMs });
    if (top.code !== 0) throw new WorkspaceObserverError("not_a_git_repository", `Not a git repository: ${resolved}`, top.stderr.trim());
    toplevel = await realpath(top.stdout.toString("utf8").trim());
    const remainder = relative(toplevel, resolved);
    scope = remainder === "" ? "" : toPosix(remainder);

    // F12: an unborn HEAD still diffs against the object-format-correct empty tree.
    const head = await git(["rev-parse", "--verify", "HEAD"], [0, 128]);
    baselineRev = head.code === 0
      ? head.stdout.toString("utf8").trim()
      : (await git(["hash-object", "-t", "tree", "/dev/null"])).stdout.toString("utf8").trim();

    const candidateShadow = await realpath(await mkdtemp(join(tmpdir(), "muster-workspace-observer-")));
    // Invariant 3: the shadow tree must live OUTSIDE the observed root or the
    // observer would trigger itself and pollute `git status`.
    if (candidateShadow === toplevel || candidateShadow.startsWith(`${toplevel}${sep}`)) {
      await rm(candidateShadow, { recursive: true, force: true }).catch(() => {});
      shadowRoot = null;
      diagnostic("shadow_evicted", `TMPDIR resolves inside the workspace (${candidateShadow}); shadows disabled, diffs degrade to hashes.`);
    } else {
      shadowRoot = candidateShadow;
      await mkdir(shadowRoot, { recursive: true });
    }

    // Invariant 4: seed only. Pre-existing dirty state is the world as the run
    // found it — recorded as the baseline, never emitted.
    try {
      for (const relPath of [...(await discoverCandidates())].sort(comparePathBytes)) {
        const current = await readCurrent(relPath);
        await adopt(relPath, current);
      }
      enforceShadowBudget();
    } catch (error) {
      await stop();
      throw error;
    }

    // stop() raced start(): honor the stop. Tear down what start() built rather
    // than resurrecting a watcher and timers after stop() already resolved.
    if (stopped) { await stop(); return; }
    // `started` flips only after the baseline is fully seeded: a flush() that
    // slips in mid-seed fails closed (not_started) instead of racing the seed
    // and emitting pre-existing dirty state as events (invariant 4).
    started = true;
    installWatch();
    if (pollMs > 0) {
      pollTimer = setInterval(() => { stats = { ...stats, pollTriggers: stats.pollTriggers + 1 }; enqueue("poll"); }, pollMs);
      pollTimer.unref?.();
    }
  }

  async function stop(): Promise<void> {
    started = false;
    stopped = true;
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = undefined; }
    debounceStartedAt = undefined;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; }
    if (watcher) { try { watcher.close(); } catch { /* already closed */ } watcher = undefined; }
    await tail.catch(() => {});
    if (shadowRoot) { await rm(shadowRoot, { recursive: true, force: true }).catch(() => {}); shadowRoot = null; }
    shadowTotal = 0;
  }

  return {
    start,
    stop,
    async flush(): Promise<readonly WorkspacePatchEvent[]> {
      if (!started || stopped) throw new WorkspaceObserverError("not_started", "Observer is not started.");
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = undefined; debounceStartedAt = undefined; }
      return enqueue("flush");
    },
    get root() { return toplevel; },
    get scope() { return scope; },
    get baselineRev() { return baselineRev; },
    get sequence() { return sequence; },
    get degraded() { return degraded; },
    get stats() { return stats; },
    snapshot(): ReadonlyMap<string, WorkspaceFileState> {
      if (!started || stopped) throw new WorkspaceObserverError("not_started", "Observer is not started.");
      const view = new Map<string, WorkspaceFileState>();
      for (const [relPath, entry] of state) {
        if (!entry.present || entry.hash === null) continue;
        view.set(relPath, { hash: entry.hash, bytes: entry.bytes ?? 0, mode: entry.mode ?? 100644, shadowPath: entry.shadowPath });
      }
      return view;
    },
  };
}

/** start → fn → flush → stop. The standalone attach form the live evidence script uses. */
export async function withWorkspaceObserver<T>(
  options: Omit<WorkspaceObserverOptions, "onPatch"> & { readonly onPatch?: (event: WorkspacePatchEvent) => void },
  fn: (observer: WorkspaceObserver) => Promise<T>,
): Promise<{ readonly result: T; readonly events: readonly WorkspacePatchEvent[] }> {
  const events: WorkspacePatchEvent[] = [];
  const observer = createWorkspaceObserver({
    ...options,
    onPatch: (event) => {
      events.push(event);
      options.onPatch?.(event);
    },
  });
  await observer.start();
  try {
    const result = await fn(observer);
    await observer.flush();
    return { result, events: [...events] };
  } finally {
    await observer.stop();
  }
}
