import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, open, readFile, rename, mkdir, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { AcceptanceCheckResult, KanbanBoardState, KanbanEvent } from "@musterhq/core";

export interface CommandResult { readonly exitCode: number; readonly stdout: string; readonly stderr: string }
export type CommandRunner = (command: string, args: readonly string[], cwd: string) => Promise<CommandResult>;

export const runCommand: CommandRunner = (command, args, cwd) => new Promise((resolveRun, reject) => {
  const child = spawn(command, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  child.once("error", reject);
  child.once("exit", (code) => resolveRun({ exitCode: code ?? 1, stdout, stderr }));
});

/** One write + fdatasync before acknowledgement. The caller's reducer supplies idempotency. */
export async function appendFsync(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY, 0o600);
  try { await handle.write(`${line}\n`); await handle.datasync(); } finally { await handle.close(); }
}

export interface BoardLease {
  readonly writable: boolean;
  readonly message?: string;
  readonly ownerPid: number;
}

const ownedLeases = new Map<string, number>();

/** Process-duration single-writer lease. Stale owners are replaced; live owners force read-only. */
export async function acquireBoardLease(path: string, options: {
  readonly pid?: number;
  readonly processAlive?: (pid: number) => boolean;
} = {}): Promise<BoardLease> {
  const pid = options.pid ?? process.pid;
  const alive = options.processAlive ?? ((candidate) => { try { process.kill(candidate, 0); return true; } catch { return false; } });
  if (ownedLeases.get(path) === pid) return { writable: true, ownerPid: pid };
  await mkdir(dirname(path), { recursive: true });
  const claim = async (): Promise<BoardLease> => {
    const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { await handle.writeFile(JSON.stringify({ pid, acquiredAt: new Date().toISOString() })); await handle.datasync(); } finally { await handle.close(); }
    ownedLeases.set(path, pid);
    return { writable: true, ownerPid: pid };
  };
  try { return await claim(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let ownerPid = -1;
    try { ownerPid = Number((JSON.parse(await readFile(path, "utf8")) as { pid?: unknown }).pid); } catch { /* corrupt is stale */ }
    if (ownerPid === pid) { ownedLeases.set(path, pid); return { writable: true, ownerPid: pid }; }
    if (Number.isInteger(ownerPid) && ownerPid > 0 && alive(ownerPid)) return { writable: false, ownerPid, message: `tasks board is read-only: writer lease is held by process ${ownerPid}` };
    await unlink(path).catch(() => {});
    return claim();
  }
}

export interface AttemptWorkspace { readonly path: string; readonly branchName: string }

export async function createAttemptWorktree(projectCwd: string, boardId: string, taskId: string, attemptId: string, runner: CommandRunner = runCommand): Promise<AttemptWorkspace> {
  const safe = `${boardId}-${taskId}-${attemptId}`.replace(/[^a-zA-Z0-9._-]/g, "-");
  const path = join(projectCwd, ".muster", "worktrees", safe);
  const branchName = `muster/${safe}`;
  const result = await runner("git", ["worktree", "add", "-b", branchName, path, "HEAD"], projectCwd);
  if (result.exitCode !== 0) throw new Error(`could not create attempt worktree: ${(result.stderr || result.stdout).trim()}`);
  return { path, branchName };
}

export interface ApprovalResult {
  readonly accepted: boolean;
  readonly checks: readonly AcceptanceCheckResult[];
  readonly diffHashes: readonly string[];
  readonly mergeCommit?: string;
  readonly conflict?: string;
}

function tail(value: string, max = 1200): string { const text = value.trim(); return text.length <= max ? text : text.slice(-max); }

/** Checks, hashes and merge all operate on the retained attempt worktree. */
export async function approveAttempt(input: {
  readonly projectCwd: string;
  readonly worktree: AttemptWorkspace;
  readonly checks: readonly { readonly command: string; readonly expectedExitCode?: number }[];
  readonly runner?: CommandRunner;
}): Promise<ApprovalResult> {
  const runner = input.runner ?? runCommand;
  const checks: AcceptanceCheckResult[] = [];
  for (const check of input.checks) {
    const result = await runner(process.platform === "win32" ? "cmd" : "sh", process.platform === "win32" ? ["/d", "/s", "/c", check.command] : ["-lc", check.command], input.worktree.path);
    const expectedExitCode = check.expectedExitCode ?? 0;
    checks.push({ command: check.command, expectedExitCode, exitCode: result.exitCode, outputTail: tail(`${result.stdout}\n${result.stderr}`), passed: result.exitCode === expectedExitCode });
    if (result.exitCode !== expectedExitCode) return { accepted: false, checks, diffHashes: [] };
  }
  const diff = await runner("git", ["diff", "--binary", "HEAD"], input.worktree.path);
  const untracked = await runner("git", ["ls-files", "--others", "--exclude-standard"], input.worktree.path);
  const diffHashes = [diff.stdout, untracked.stdout].filter(Boolean).map((value) => `sha256:${createHash("sha256").update(value).digest("hex")}`);
  const add = await runner("git", ["add", "-A"], input.worktree.path);
  if (add.exitCode !== 0) return { accepted: false, checks, diffHashes, conflict: tail(add.stderr || add.stdout) };
  const commit = await runner("git", ["-c", "user.name=Muster", "-c", "user.email=muster@localhost", "commit", "--allow-empty", "-m", `muster: approve ${input.worktree.branchName}`], input.worktree.path);
  if (commit.exitCode !== 0) return { accepted: false, checks, diffHashes, conflict: tail(commit.stderr || commit.stdout) };
  const merge = await runner("git", ["merge", "--no-ff", "--no-edit", input.worktree.branchName], input.projectCwd);
  if (merge.exitCode !== 0) {
    await runner("git", ["merge", "--abort"], input.projectCwd).catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
    return { accepted: false, checks, diffHashes, conflict: tail(merge.stderr || merge.stdout || "merge conflict") };
  }
  const head = await runner("git", ["rev-parse", "HEAD"], input.projectCwd);
  return { accepted: true, checks, diffHashes, mergeCommit: head.stdout.trim() };
}

export interface RecoveryEvidence { readonly taskId: string; readonly attemptId: string; readonly processId: string; readonly evidence: string }

export interface StallEvidence { readonly taskId: string; readonly attemptId: string; readonly idleBudgetMs: number; readonly lastEvent: string; readonly lastOutputLine: string }

/** Derive stalls from facts and each attempt's declared idle budget; no live spinner state participates. */
export function findStalledAttempts(events: readonly KanbanEvent[], nowMs: number = Date.now()): readonly StallEvidence[] {
  const active = new Map<string, { taskId: string; attemptId: string; idleBudgetMs: number; lastAt: number; lastEvent: string; lastOutputLine: string; stalled: boolean }>();
  for (const event of events) {
    const keyed = "attemptId" in event && typeof event.attemptId === "string" ? `${"taskId" in event ? event.taskId : ""}:${event.attemptId}` : undefined;
    if (event.type === "task_attempt_started") active.set(`${event.taskId}:${event.attemptId}`, { taskId: event.taskId, attemptId: event.attemptId, idleBudgetMs: event.idleBudgetMs ?? 120_000, lastAt: Date.parse(event.at), lastEvent: event.type, lastOutputLine: "no output yet", stalled: false });
    else if (keyed && active.has(keyed)) {
      const item = active.get(keyed)!; item.lastAt = Date.parse(event.at); item.lastEvent = event.type;
      if (event.type === "attempt_output") item.lastOutputLine = event.line;
      if (event.type === "attempt_stalled") item.stalled = true;
      if (["task_attempt_completed", "task_attempt_failed", "task_attempt_cancelled"].includes(event.type)) active.delete(keyed);
    } else if ("taskId" in event && (event.type === "task_progress")) {
      const item = [...active.values()].find((candidate) => candidate.taskId === event.taskId);
      if (item) { item.lastAt = Date.parse(event.at); item.lastEvent = event.type; item.lastOutputLine = event.note; }
    }
  }
  return [...active.values()].filter((item) => !item.stalled && nowMs - item.lastAt > item.idleBudgetMs).map(({ taskId, attemptId, idleBudgetMs, lastEvent, lastOutputLine }) => ({ taskId, attemptId, idleBudgetMs, lastEvent, lastOutputLine }));
}

/** Reap only processes that the facts identify as running but the executor cannot reattach. */
export function recoverOrphanedAttempts(state: KanbanBoardState, processAlive: (pid: number) => boolean, reap: (pid: number) => void): readonly RecoveryEvidence[] {
  const evidence: RecoveryEvidence[] = [];
  for (const [taskId, task] of state.tasks) {
    for (const attempt of task.attemptHistory.values()) {
      if (attempt.status !== "running" || !attempt.processId || !/^\d+$/.test(attempt.processId)) continue;
      const pid = Number(attempt.processId);
      if (processAlive(pid)) { reap(pid); evidence.push({ taskId, attemptId: attempt.attemptId, processId: attempt.processId, evidence: "orphaned executor reaped during board reconstruction" }); }
    }
  }
  return evidence;
}

/** A process-duration owner fence makes relaunch recovery deterministic even for opaque executor ids. */
export function findRelaunchOrphans(state: KanbanBoardState, currentPid: number = process.pid): readonly RecoveryEvidence[] {
  const evidence: RecoveryEvidence[] = [];
  for (const [taskId, task] of state.tasks) for (const attempt of task.attemptHistory.values()) {
    if (attempt.status === "running" && attempt.processId && attempt.processOwnerPid && attempt.processOwnerPid !== currentPid) evidence.push({
      taskId, attemptId: attempt.attemptId, processId: attempt.processId,
      evidence: `orphaned executor ${attempt.processId} from process ${attempt.processOwnerPid} reaped during board reconstruction`,
    });
  }
  return evidence;
}

/** Remove directories under Muster's worktree root only when no retained attempt fact owns them. */
export async function sweepZombieWorktrees(projectCwd: string, events: readonly KanbanEvent[], runner: CommandRunner = runCommand): Promise<readonly string[]> {
  const owned = new Set(events.filter((event) => event.type === "task_attempt_started" && event.worktreePath).map((event) => resolve((event as Extract<KanbanEvent, { type: "task_attempt_started" }>).worktreePath!)));
  const listed = await runner("git", ["worktree", "list", "--porcelain"], projectCwd);
  const removed: string[] = [];
  const root = resolve(projectCwd, ".muster", "worktrees");
  for (const line of listed.stdout.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const path = resolve(line.slice(9));
    if (!path.startsWith(`${root}/`) || owned.has(path)) continue;
    const result = await runner("git", ["worktree", "remove", "--force", path], projectCwd);
    if (result.exitCode === 0) removed.push(path);
  }
  await runner("git", ["worktree", "prune"], projectCwd);
  return removed;
}

export type WorkerState = "parked" | "woken" | "retired";
export interface DurableWorker { readonly id: string; readonly sessionId: string; readonly state: WorkerState; readonly fence: number; readonly updatedAt: string }
export type ContinuationState = "open" | "claimed" | "committed" | "aborted";
export interface Continuation { readonly id: string; readonly workerId: string; readonly oldSessionId: string; readonly replacementSessionId?: string; readonly state: ContinuationState; readonly fence: number; readonly claimToken?: string }

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.datasync(); } finally { await handle.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); }
}

export class DurableWorkerStore {
  private workers = new Map<string, DurableWorker>();
  private continuations = new Map<string, Continuation>();
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}
  async restore(): Promise<void> {
    try { const data = JSON.parse(await readFile(this.path, "utf8")) as { workers: DurableWorker[]; continuations: Continuation[] }; this.workers = new Map(data.workers.map((item) => [item.id, item])); this.continuations = new Map(data.continuations.map((item) => [item.id, item])); } catch { /* first launch */ }
  }
  private persist(): Promise<void> {
    const write = this.writes.then(() => atomicJson(this.path, { workers: [...this.workers.values()], continuations: [...this.continuations.values()] }));
    this.writes = write.catch(() => {});
    return write;
  }
  listWorkers(): readonly DurableWorker[] { return [...this.workers.values()]; }
  async setWorker(id: string, sessionId: string, state: WorkerState): Promise<DurableWorker> {
    const prior = this.workers.get(id); if (prior?.state === "retired" && state !== "retired") throw new Error(`worker ${id} is retired and cannot be revived`);
    const worker = { id, sessionId, state, fence: (prior?.fence ?? 0) + 1, updatedAt: new Date().toISOString() } satisfies DurableWorker;
    this.workers.set(id, worker); await this.persist(); return worker;
  }
  async openContinuation(workerId: string): Promise<Continuation> {
    const worker = this.workers.get(workerId); if (!worker || worker.state === "retired") throw new Error(`worker ${workerId} is unavailable`);
    const record = { id: `cont_${randomUUID()}`, workerId, oldSessionId: worker.sessionId, state: "open", fence: worker.fence + 1 } satisfies Continuation;
    this.continuations.set(record.id, record); await this.persist(); return record;
  }
  async claim(id: string, replacementSessionId: string): Promise<Continuation> {
    const prior = this.continuations.get(id); if (!prior || prior.state !== "open") throw new Error(`continuation ${id} cannot be claimed`);
    const next = { ...prior, state: "claimed", replacementSessionId, claimToken: randomUUID(), fence: prior.fence + 1 } satisfies Continuation;
    this.continuations.set(id, next); await this.persist(); return next;
  }
  async commit(id: string, claimToken: string, fence: number): Promise<Continuation> {
    const prior = this.continuations.get(id); if (!prior || prior.state !== "claimed" || prior.claimToken !== claimToken || prior.fence !== fence) throw new Error(`stale continuation fence for ${id}`);
    const worker = this.workers.get(prior.workerId)!;
    this.workers.set(worker.id, { ...worker, sessionId: prior.replacementSessionId!, fence: worker.fence + 1, updatedAt: new Date().toISOString() });
    const next = { ...prior, state: "committed", fence: prior.fence + 1 } satisfies Continuation; this.continuations.set(id, next); await this.persist(); return next;
  }
  async abort(id: string, claimToken?: string): Promise<Continuation> {
    const prior = this.continuations.get(id); if (!prior || prior.state === "committed") throw new Error(`continuation ${id} cannot be aborted`);
    if (prior.claimToken && prior.claimToken !== claimToken) throw new Error(`stale continuation claim for ${id}`);
    const next = { ...prior, state: "aborted", fence: prior.fence + 1 } satisfies Continuation; this.continuations.set(id, next); await this.persist(); return next;
  }
}

export async function pathExists(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }
