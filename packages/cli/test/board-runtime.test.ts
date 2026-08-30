import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { KanbanBoardState } from "@musterhq/core";
import {
  DurableWorkerStore,
  acquireBoardLease,
  appendFsync,
  approveAttempt,
  findStalledAttempts,
  findRelaunchOrphans,
  recoverOrphanedAttempts,
  type CommandRunner,
} from "../src/board-runtime.js";

test("writer lease makes a contending board process honestly read-only", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-lease-"));
  const path = join(cwd, "board.lease");
  const first = await acquireBoardLease(path, { pid: 4101, processAlive: () => true });
  const second = await acquireBoardLease(path, { pid: 4102, processAlive: () => true });
  assert.equal(first.writable, true);
  assert.equal(second.writable, false);
  assert.match(second.message ?? "", /read-only.*4101/);
});

test("fsync append preserves complete independent facts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-fsync-"));
  const path = join(cwd, "events.jsonl");
  await appendFsync(path, '{"id":"one"}');
  await appendFsync(path, '{"id":"two"}');
  assert.deepEqual((await readFile(path, "utf8")).trim().split("\n").map(JSON.parse), [{ id: "one" }, { id: "two" }]);
});

test("crash recovery simulation reaps a live orphaned fake executor and returns evidence", () => {
  const attempt = { attemptId: "a1", status: "running", startedAt: "2026-08-28T00:00:00.000Z", processId: "991" } as const;
  const state = { tasks: new Map([["t1", { attemptHistory: new Map([["a1", attempt]]) }]]) } as unknown as KanbanBoardState;
  const killed: number[] = [];
  const evidence = recoverOrphanedAttempts(state, (pid) => pid === 991, (pid) => killed.push(pid));
  assert.deepEqual(killed, [991]);
  assert.deepEqual(evidence, [{ taskId: "t1", attemptId: "a1", processId: "991", evidence: "orphaned executor reaped during board reconstruction" }]);
});

test("relaunch reconstruction fences and reaps an executor owned by the killed board process", () => {
  const attempt = { attemptId: "a2", status: "running", startedAt: "2026-08-28T00:00:00.000Z", processId: "sub_dead", processOwnerPid: 7001 } as const;
  const state = { tasks: new Map([["t2", { attemptHistory: new Map([["a2", attempt]]) }]]) } as unknown as KanbanBoardState;
  assert.deepEqual(findRelaunchOrphans(state, 7002), [{ taskId: "t2", attemptId: "a2", processId: "sub_dead", evidence: "orphaned executor sub_dead from process 7001 reaped during board reconstruction" }]);
  assert.deepEqual(findRelaunchOrphans(state, 7001), []);
});

test("idle budget derives a stall with the last fact and last output line", () => {
  const base = { schemaVersion: 1 as const, boardId: "b", tenantId: "t", actorId: "system", actorKind: "system" as const, summary: "fact" };
  const events = [
    { ...base, id: "e1", sequence: 0, at: "2026-08-28T00:00:00.000Z", type: "task_attempt_started" as const, taskId: "t1", attemptId: "a1", agentId: "agent", idleBudgetMs: 1000 },
    { ...base, id: "e2", sequence: 1, at: "2026-08-28T00:00:00.500Z", type: "attempt_output" as const, taskId: "t1", attemptId: "a1", line: "building index.ts" },
  ];
  assert.deepEqual(findStalledAttempts(events, Date.parse("2026-08-28T00:00:02.000Z")), [{ taskId: "t1", attemptId: "a1", idleBudgetMs: 1000, lastEvent: "attempt_output", lastOutputLine: "building index.ts" }]);
});

test("approve surfaces merge conflicts honestly and aborts the merge", async () => {
  const calls: string[] = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "sh") return { exitCode: 0, stdout: "12 tests passed", stderr: "" };
    if (args[0] === "diff") return { exitCode: 0, stdout: "diff --git a/a b/a", stderr: "" };
    if (args[0] === "ls-files") return { exitCode: 0, stdout: "", stderr: "" };
    if (args[0] === "merge" && args[1] !== "--abort") return { exitCode: 1, stdout: "", stderr: "CONFLICT (content): Merge conflict in a.ts" };
    return { exitCode: 0, stdout: args[0] === "rev-parse" ? "abc\n" : "", stderr: "" };
  };
  const result = await approveAttempt({ projectCwd: "/repo", worktree: { path: "/repo/.muster/worktrees/a1", branchName: "muster/a1" }, checks: [{ command: "pnpm test" }], runner });
  assert.equal(result.accepted, false);
  assert.match(result.conflict ?? "", /CONFLICT.*a\.ts/);
  assert.ok(calls.some((call) => call === "git merge --abort"));
});

test("durable workers park, wake, retire and continuation claims are fenced", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-workers-"));
  const path = join(cwd, "workers.json");
  const store = new DurableWorkerStore(path);
  await store.setWorker("w1", "session-old", "parked");
  await store.setWorker("w1", "session-old", "woken");
  const opened = await store.openContinuation("w1");
  const claim = await store.claim(opened.id, "session-new");
  await assert.rejects(store.commit(opened.id, claim.claimToken!, claim.fence - 1), /stale continuation fence/);
  await store.commit(opened.id, claim.claimToken!, claim.fence);
  await store.setWorker("w1", "session-new", "retired");
  await assert.rejects(store.setWorker("w1", "session-new", "woken"), /cannot be revived/);

  const restored = new DurableWorkerStore(path);
  await restored.restore();
  assert.deepEqual(restored.listWorkers().map(({ id, sessionId, state }) => ({ id, sessionId, state })), [{ id: "w1", sessionId: "session-new", state: "retired" }]);
});
