import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  comparePathBytes,
  computePatchReceipt,
  createWorkspaceObserver,
  hashBytes,
  isBinaryContent,
  matchesIgnore,
  parseNameStatusZ,
  parseStatusZ,
  rewriteDiffHeader,
  synthesizeRenameDiff,
  withWorkspaceObserver,
  WorkspaceObserverError,
  type WorkspaceObserver,
  type WorkspaceObserverDiagnostic,
  type WorkspaceObserverOptions,
  type WorkspacePatchEvent,
} from "../src/workspace-observer.js";

/* ---------- hermetic repo helpers ---------- */

// The TESTS pin git config for hermeticity. The OBSERVER must never do this —
// it inherits the user's real .gitignore/config semantics on purpose (F7).
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Muster Test",
  GIT_AUTHOR_EMAIL: "test@muster.invalid",
  GIT_COMMITTER_NAME: "Muster Test",
  GIT_COMMITTER_EMAIL: "test@muster.invalid",
};

function git(cwd: string, ...args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function makeRepo(t: TestContext, files: Readonly<Record<string, string>> = { "keep.txt": "a\nb\nc\n" }): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "muster-observer-repo-")));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  assert.equal(git(dir, "init", "-q", "-b", "main", ".").status, 0);
  for (const [name, body] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), body);
  }
  if (Object.keys(files).length > 0) {
    assert.equal(git(dir, "add", "-A").status, 0);
    assert.equal(git(dir, "commit", "-qm", "init").status, 0);
  }
  return dir;
}

interface Harness {
  readonly observer: WorkspaceObserver;
  readonly events: WorkspacePatchEvent[];
  readonly diagnostics: WorkspaceObserverDiagnostic[];
}

/** Default posture: no watcher, no poll — every cycle is driven by flush(). Deterministic, no sleeps. */
async function attach(t: TestContext, root: string, overrides: Partial<WorkspaceObserverOptions> = {}): Promise<Harness> {
  const events: WorkspacePatchEvent[] = [];
  const diagnostics: WorkspaceObserverDiagnostic[] = [];
  const observer = createWorkspaceObserver({
    root,
    watch: false,
    pollMs: 0,
    onPatch: (event) => events.push(event),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    ...overrides,
  });
  t.after(async () => { await observer.stop(); });
  await observer.start();
  return { observer, events, diagnostics };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.fail(`Condition not met within ${timeoutMs}ms.`);
}

function sha256(input: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(typeof input === "string" ? Buffer.from(input, "utf8") : input).digest("hex")}`;
}

/* ---------- pure helpers ---------- */

test("pure helpers parse git's -z porcelain and name-status shapes", () => {
  assert.equal(hashBytes(Buffer.from("abc")), sha256("abc"));
  assert.equal(isBinaryContent(Buffer.from("plain text")), false);
  assert.equal(isBinaryContent(Buffer.from([0x61, 0x00, 0x62])), true);
  assert.equal(isBinaryContent(Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])])), false, "NUL past 8000 bytes is not binary");

  // F1: status renames are NEW first.
  assert.deepEqual(parseStatusZ("R  new.txt\0old.txt\0 M keep.txt\0?? add.txt\0"), [
    { x: "R", y: " ", path: "new.txt", origPath: "old.txt" },
    { x: " ", y: "M", path: "keep.txt" },
    { x: "?", y: "?", path: "add.txt" },
  ]);
  // F2: name-status renames are OLD first — the opposite order.
  assert.deepEqual(parseNameStatusZ("M\0keep.txt\0R100\0old.txt\0new.txt\0D\0gone.txt\0"), [
    { status: "M", path: "keep.txt" },
    { status: "R100", path: "new.txt", origPath: "old.txt" },
    { status: "D", path: "gone.txt" },
  ]);
  // F3: -z never quotes; spaces and non-ASCII arrive raw.
  assert.deepEqual(parseStatusZ("?? sp ace ü.txt\0"), [{ x: "?", y: "?", path: "sp ace ü.txt" }]);

  assert.ok(comparePathBytes("a.txt", "b.txt") < 0);
  assert.ok(comparePathBytes("B.txt", "a.txt") < 0, "byte order, never locale order");

  assert.equal(matchesIgnore("node_modules/x/y.js", ["node_modules"]), true);
  assert.equal(matchesIgnore("src/node_modules/y.js", ["node_modules"]), true, "whole path segment matches");
  assert.equal(matchesIgnore("src/nodes.js", ["node_modules"]), false);
  assert.equal(matchesIgnore("dist/a.js", (p) => p.startsWith("dist/")), true);
});

test("rewriteDiffHeader touches only the header, never the body", () => {
  const raw = [
    "diff --git a/tmp/shadow/x.blob b/tmp/work/keep.txt",
    "index de98044..7be73ce 100644",
    "--- a/tmp/shadow/x.blob",
    "+++ b/tmp/work/keep.txt",
    "@@ -1,3 +1,3 @@",
    " a",
    "--- a/tmp/shadow/x.blob",
    "+++ b/tmp/work/keep.txt",
    "",
  ].join("\n");
  const out = rewriteDiffHeader(raw, "/tmp/shadow/x.blob", "/tmp/work/keep.txt", "keep.txt");
  const lines = out.split("\n");
  assert.equal(lines[0], "diff --git a/keep.txt b/keep.txt");
  assert.equal(lines[2], "--- a/keep.txt");
  assert.equal(lines[3], "+++ b/keep.txt");
  assert.equal(lines[6], "--- a/tmp/shadow/x.blob", "body content mentioning the shadow path is untouched");
  assert.equal(lines[7], "+++ b/tmp/work/keep.txt");

  const nulled = rewriteDiffHeader("diff --git a/x b/x\n--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+z\n", "/dev/null", "/x", "new.txt");
  assert.ok(nulled.includes("--- /dev/null"));
  assert.ok(nulled.includes("+++ b/new.txt"));

  assert.equal(
    synthesizeRenameDiff("old.txt", "new.txt"),
    "diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n",
  );
});

/* ---------- 1-2: fail closed ---------- */

test("1: a non-git directory fails closed with git's own fatal line", async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "muster-observer-nogit-")));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const observer = createWorkspaceObserver({ root: dir, watch: false, pollMs: 0, onPatch: () => {} });
  t.after(async () => { await observer.stop(); });
  await assert.rejects(
    () => observer.start(),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceObserverError);
      assert.equal(error.code, "not_a_git_repository");
      assert.match(String(error.detail), /not a git repository/i);
      return true;
    },
  );
});

test("2: missing root, flush-before-start, and double start all fail closed", async (t) => {
  const missing = createWorkspaceObserver({ root: join(tmpdir(), "muster-observer-absent-xyz"), watch: false, pollMs: 0, onPatch: () => {} });
  await assert.rejects(() => missing.start(), (e: unknown) => (e as WorkspaceObserverError).code === "root_not_found");
  await assert.rejects(() => missing.flush(), (e: unknown) => (e as WorkspaceObserverError).code === "not_started");

  const repo = await makeRepo(t);
  const { observer } = await attach(t, repo);
  await assert.rejects(() => observer.start(), (e: unknown) => (e as WorkspaceObserverError).code === "already_started");
});

/* ---------- 3-4: invariant 4 and adds ---------- */

test("3: start() never emits, and pre-existing dirty content becomes the baseline", async (t) => {
  const repo = await makeRepo(t);
  await writeFile(join(repo, "keep.txt"), "dirty\n");
  await writeFile(join(repo, "untracked.txt"), "already here\n");

  const { observer, events } = await attach(t, repo);
  assert.deepEqual(events, [], "invariant 4: pre-existing dirty state is the world as the run found it");
  assert.equal(observer.sequence, 0);

  await writeFile(join(repo, "keep.txt"), "dirty2\n");
  const emitted = await observer.flush();
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]!.beforeHash, sha256("dirty\n"), "baseline is the dirty content, not HEAD");
  assert.equal(emitted[0]!.afterHash, sha256("dirty2\n"));
});

test("4: an untracked add carries a /dev/null diff, exact hashes, and observer provenance", async (t) => {
  const repo = await makeRepo(t);
  const { observer, events } = await attach(t, repo);
  await writeFile(join(repo, "new.txt"), "hello\n");

  const emitted = await observer.flush();
  assert.equal(emitted.length, 1);
  const event = emitted[0]!;
  assert.equal(event.changeKind, "add");
  assert.equal(event.path, "new.txt");
  assert.equal(event.beforeHash, null);
  assert.equal(event.afterHash, sha256("hello\n"));
  assert.equal(event.bytesBefore, null);
  assert.equal(event.bytesAfter, 6);
  assert.equal(event.modeAfter, 100644);
  assert.equal(event.sequence, 1);
  assert.equal(event.schemaVersion, 1);
  assert.equal(event.source, "observer");
  assert.equal(event.detectedBy, "flush");
  assert.equal(event.diffContextLines, 3);
  assert.ok(event.diff!.includes("--- /dev/null"));
  assert.ok(event.diff!.includes("+++ b/new.txt"));
  assert.ok(event.diff!.includes("+hello"));
  assert.equal(event.diffHash, sha256(event.diff!));
  assert.match(event.idempotencyKey, /^workspace\.patch:[0-9a-f]{64}$/);
  assert.match(event.receiptHash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(events, [...emitted], "onPatch and the flush() return value agree");
  assert.equal(observer.snapshot().get("new.txt")?.hash, sha256("hello\n"));
});

/* ---------- 5-8: modify, receipts, coalescing, revert ---------- */

test("5: a modify produces an applicable unified diff with canonical a/ b/ headers", async (t) => {
  const repo = await makeRepo(t);
  const { observer } = await attach(t, repo);
  await writeFile(join(repo, "keep.txt"), "a\nB\nc\n");

  const [event] = await observer.flush();
  assert.equal(event!.changeKind, "modify");
  assert.equal(event!.beforeHash, sha256("a\nb\nc\n"));
  assert.equal(event!.afterHash, sha256("a\nB\nc\n"));
  assert.ok(event!.diff!.startsWith("diff --git a/keep.txt b/keep.txt\n"));
  assert.ok(event!.diff!.includes("--- a/keep.txt\n"));
  assert.ok(event!.diff!.includes("+++ b/keep.txt\n"));
  assert.ok(event!.diff!.includes("-b\n+B\n"));

  // Applicability: the rewritten diff is a checkpoint/rollback primitive, not just a render payload.
  const clone = await realpath(await mkdtemp(join(tmpdir(), "muster-observer-clone-")));
  t.after(async () => { await rm(clone, { recursive: true, force: true }); });
  assert.equal(git(clone, "init", "-q", "-b", "main", ".").status, 0);
  await writeFile(join(clone, "keep.txt"), "a\nb\nc\n");
  await writeFile(join(clone, "patch.diff"), event!.diff!);
  const check = git(clone, "apply", "--check", "patch.diff");
  assert.equal(check.status, 0, `git apply --check failed: ${check.stderr}`);
});

test("6: consecutive edits chain — the second beforeHash is the first afterHash", async (t) => {
  const repo = await makeRepo(t);
  const { observer } = await attach(t, repo);
  await writeFile(join(repo, "keep.txt"), "v1\n");
  const [first] = await observer.flush();
  await writeFile(join(repo, "keep.txt"), "v2\n");
  const [second] = await observer.flush();

  assert.equal(second!.beforeHash, first!.afterHash);
  assert.equal(first!.sequence, 1);
  assert.equal(second!.sequence, 2);
  assert.notEqual(first!.idempotencyKey, second!.idempotencyKey);
});

test("7: five writes then one flush coalesce into one event at the final content", async (t) => {
  const repo = await makeRepo(t);
  const { observer } = await attach(t, repo);
  for (const value of ["1", "2", "3", "4", "final"]) await writeFile(join(repo, "keep.txt"), `${value}\n`);

  const emitted = await observer.flush();
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]!.afterHash, sha256("final\n"));
});

test("8: write-then-revert inside one window emits nothing; a later revert is seen via the state map", async (t) => {
  const repo = await makeRepo(t);
  const { observer } = await attach(t, repo);
  await writeFile(join(repo, "keep.txt"), "changed\n");
  await writeFile(join(repo, "keep.txt"), "a\nb\nc\n");
  assert.deepEqual(await observer.flush(), []);

  await writeFile(join(repo, "keep.txt"), "changed\n");
  const [forward] = await observer.flush();
  await writeFile(join(repo, "keep.txt"), "a\nb\nc\n");
  // git status and git diff both report "nothing" here — only candidate source (c) finds it.
  const [back] = await observer.flush();
  assert.equal(back!.beforeHash, forward!.afterHash);
  assert.equal(back!.afterHash, forward!.beforeHash);
});

/* ---------- 9-11: delete and rename ---------- */

test("9: deleting a tracked file emits a delete whose diff ends at /dev/null", async (t) => {
  const repo = await makeRepo(t);
  const { observer } = await attach(t, repo);
  await unlink(join(repo, "keep.txt"));

  const [event] = await observer.flush();
  assert.equal(event!.changeKind, "delete");
  assert.equal(event!.afterHash, null);
  assert.equal(event!.beforeHash, sha256("a\nb\nc\n"));
  assert.equal(event!.modeAfter, null);
  assert.ok(event!.diff!.includes("+++ /dev/null"));
  assert.equal(observer.snapshot().has("keep.txt"), false);
});

test("10: an unstaged mv collapses to ONE rename (git itself reports D + ??)", async (t) => {
  const repo = await makeRepo(t);
  const { observer } = await attach(t, repo);
  await rename(join(repo, "keep.txt"), join(repo, "moved.txt"));

  // Verified: git's own -M does not pair this.
  assert.match(git(repo, "status", "--porcelain").stdout, /^ D keep\.txt$/m);

  const emitted = await observer.flush();
  assert.equal(emitted.length, 1);
  const event = emitted[0]!;
  assert.equal(event.changeKind, "rename");
  assert.equal(event.path, "moved.txt");
  assert.equal(event.previousPath, "keep.txt");
  assert.equal(event.beforeHash, event.afterHash);
  assert.ok(event.diff!.includes("rename from keep.txt"));
  assert.ok(event.diff!.includes("rename to moved.txt"));
});

test("11: a rename WITH an edit degrades to delete + add — intended, coarser, never wrong", async (t) => {
  const repo = await makeRepo(t);
  const { observer } = await attach(t, repo);
  await unlink(join(repo, "keep.txt"));
  await writeFile(join(repo, "moved.txt"), "a\nb\nc\nd\n");

  const emitted = await observer.flush();
  assert.deepEqual(emitted.map((event) => event.changeKind), ["delete", "add"], "byte order: keep.txt then moved.txt");
  assert.deepEqual(emitted.map((event) => event.path), ["keep.txt", "moved.txt"]);
});

/* ---------- 12: binary ---------- */

test("12: a binary file records hashes with no diff and round-trips through JSON", async (t) => {
  const repo = await makeRepo(t);
  const { observer } = await attach(t, repo);
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0xff]);
  await writeFile(join(repo, "blob.bin"), bytes);

  const [event] = await observer.flush();
  assert.equal(event!.binary, true);
  assert.equal(event!.diff, null);
  assert.equal(event!.diffHash, null);
  assert.equal(event!.diffOmitted, "binary");
  assert.equal(event!.afterHash, sha256(bytes));
  assert.deepEqual(JSON.parse(JSON.stringify(event)), event, "the event payload is exactly JSON-representable");
});

/* ---------- 13-14: the only timer-dependent tests ---------- */

test("13: correctness survives a missed watch event — poll alone detects the change", async (t) => {
  const repo = await makeRepo(t);
  const { events } = await attach(t, repo, { watch: false, pollMs: 40 });
  await writeFile(join(repo, "polled.txt"), "seen\n");

  await waitFor(() => events.length > 0);
  assert.equal(events[0]!.detectedBy, "poll");
  assert.equal(events[0]!.afterHash, sha256("seen\n"));
});

test("14: the watch path debounces a burst without losing the final content", async (t) => {
  const repo = await makeRepo(t);
  const { events } = await attach(t, repo, { watch: true, pollMs: 0, debounceMs: 50 });
  for (const value of ["1", "2", "3", "4", "final"]) await writeFile(join(repo, "keep.txt"), `${value}\n`);

  await waitFor(() => events.length > 0);
  // Tolerant bound on purpose: macOS FSEvents coalesces unpredictably. Tightening
  // this to an exact count produces an intermittently red suite.
  assert.ok(events.length <= 2, `expected at most 2 coalesced events, got ${events.length}`);
  assert.equal(events.at(-1)!.afterHash, sha256("final\n"));
  assert.equal(events[0]!.detectedBy, "watch");
});

/* ---------- 15: the governance finding ---------- */

test("15: a mid-run `git commit` hides the change from status — the pinned baseline still reports it", async (t) => {
  const repo = await makeRepo(t);
  const { observer } = await attach(t, repo);
  await writeFile(join(repo, "keep.txt"), "agent edit\n");
  await writeFile(join(repo, "spawned.txt"), "agent add\n");

  assert.equal(git(repo, "add", "-A").status, 0);
  assert.equal(git(repo, "commit", "-qm", "agent commits its own work").status, 0);
  assert.equal(git(repo, "status", "--porcelain").stdout, "", "status is blind after the agent commits");

  const emitted = await observer.flush();
  assert.deepEqual(emitted.map((event) => event.path), ["keep.txt", "spawned.txt"]);
  assert.equal(emitted[0]!.changeKind, "modify");
  assert.equal(emitted[0]!.afterHash, sha256("agent edit\n"));
  assert.equal(emitted[1]!.changeKind, "add");
  assert.notEqual(observer.baselineRev, git(repo, "rev-parse", "HEAD").stdout.trim());
});

/* ---------- 16-19: exclusion, modes, size, secrets ---------- */

test("16: .gitignore'd and explicitly ignored paths never produce events", async (t) => {
  const repo = await makeRepo(t, { "keep.txt": "a\n", ".gitignore": "ignored.log\n" });
  const { observer } = await attach(t, repo, { ignore: ["node_modules"] });

  await writeFile(join(repo, "ignored.log"), "noise\n");
  await mkdir(join(repo, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(repo, "node_modules", "pkg", "index.js"), "module.exports = 1\n");
  await mkdir(join(repo, "src", "node_modules"), { recursive: true });
  await writeFile(join(repo, "src", "node_modules", "nested.js"), "nested\n");
  await writeFile(join(repo, "seen.txt"), "visible\n");

  const emitted = await observer.flush();
  assert.deepEqual(emitted.map((event) => event.path), ["seen.txt"]);
});

test("17: chmod with identical content is a modify flagged mode_only", async (t) => {
  const repo = await makeRepo(t);
  const { observer } = await attach(t, repo);
  await chmod(join(repo, "keep.txt"), 0o755);

  const [event] = await observer.flush();
  assert.equal(event!.changeKind, "modify");
  assert.equal(event!.modeBefore, 100644);
  assert.equal(event!.modeAfter, 100755);
  assert.equal(event!.beforeHash, event!.afterHash);
  assert.ok(event!.diffOmitted === "mode_only" || /new mode 100755/.test(event!.diff ?? ""));
});

test("18: above maxDiffBytes the hashes stay exact and the diff is omitted", async (t) => {
  const repo = await makeRepo(t);
  const { observer } = await attach(t, repo, { maxDiffBytes: 64 });
  const body = "x".repeat(4096);
  await writeFile(join(repo, "big.txt"), body);

  const [event] = await observer.flush();
  assert.equal(event!.diff, null);
  assert.equal(event!.diffOmitted, "too_large");
  assert.equal(event!.afterHash, sha256(body), "hashing is streamed and has no size limit");
  assert.equal(event!.bytesAfter, 4096);
});

test("19: secret paths are recorded by hash with the text withheld", async (t) => {
  const repo = await makeRepo(t);
  const { observer } = await attach(t, repo);
  const secret = "OPENAI_API_KEY=sk-super-secret-value\n";
  await writeFile(join(repo, ".env"), secret);

  const [event] = await observer.flush();
  assert.equal(event!.changeKind, "add");
  assert.equal(event!.afterHash, sha256(secret), "audit stays complete");
  assert.equal(event!.diff, null);
  assert.equal(event!.diffOmitted, "redacted_path");
  assert.ok(!JSON.stringify(event).includes("sk-super-secret-value"), "the secret must not reach the audit stream");
});

/* ---------- 20: determinism ---------- */

test("20: the same physical transition yields the same receipt from two observers and two clocks", async (t) => {
  const runOnce = async (nowFn: () => number): Promise<WorkspacePatchEvent> => {
    const repo = await makeRepo(t);
    const { observer } = await attach(t, repo, { now: nowFn });
    await writeFile(join(repo, "keep.txt"), "a\nB\nc\n");
    const [event] = await observer.flush();
    return event!;
  };
  // `root` participates in the idempotency key, so compare receipts across
  // repos and keys within a single repo path.
  let ticks = 1_000_000;
  const first = await runOnce(() => (ticks += 1000));
  const second = await runOnce(() => 42);

  assert.equal(first.receiptHash, second.receiptHash, "receiptHash is time-, observer- and trigger-independent");
  assert.notEqual(first.observerId, second.observerId);
  assert.notEqual(first.atIso, second.atIso);
  assert.equal(second.atIso, new Date(42).toISOString());

  const { receiptHash, idempotencyKey, ...rest } = first;
  const recomputed = computePatchReceipt(rest);
  assert.equal(recomputed.receiptHash, receiptHash);
  assert.equal(recomputed.idempotencyKey, idempotencyKey);
  // Changing anything the diff bytes depend on must change the receipt.
  assert.notEqual(computePatchReceipt({ ...rest, diffContextLines: 5 }).receiptHash, receiptHash);
});

/* ---------- 21-22: unborn HEAD, exotic paths ---------- */

test("21: an unborn HEAD diffs against the empty tree", async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "muster-observer-unborn-")));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  assert.equal(git(dir, "init", "-q", "-b", "main", ".").status, 0);

  const { observer } = await attach(t, dir);
  assert.match(observer.baselineRev, /^[0-9a-f]{40,64}$/);
  await writeFile(join(dir, "first.txt"), "genesis\n");

  const [event] = await observer.flush();
  assert.equal(event!.changeKind, "add");
  assert.equal(event!.afterHash, sha256("genesis\n"));
  assert.ok(event!.diff!.includes("+genesis"));
});

test("22: paths with spaces and non-ASCII survive parsing and header rewriting", async (t) => {
  const repo = await makeRepo(t);
  const { observer } = await attach(t, repo);
  const relPath = "dir/sp ace ü.txt";
  await mkdir(join(repo, "dir"), { recursive: true });
  await writeFile(join(repo, relPath), "café\n");

  const [event] = await observer.flush();
  assert.equal(event!.path, relPath);
  assert.ok(event!.diff!.startsWith(`diff --git a/${relPath} b/${relPath}\n`));
  assert.ok(event!.diff!.includes(`+++ b/${relPath}\t`), "git tab-terminates names containing spaces");
});

/* ---------- 23-27: listener isolation, symlinks, teardown, ordering, scope ---------- */

test("23: a throwing onPatch is diagnosed and never aborts the remaining deliveries", async (t) => {
  const repo = await makeRepo(t);
  const seen: string[] = [];
  const diagnostics: WorkspaceObserverDiagnostic[] = [];
  const observer = createWorkspaceObserver({
    root: repo,
    watch: false,
    pollMs: 0,
    onPatch: (event) => { seen.push(event.path); if (event.path === "a.txt") throw new Error("listener exploded"); },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  t.after(async () => { await observer.stop(); });
  await observer.start();
  await writeFile(join(repo, "a.txt"), "1\n");
  await writeFile(join(repo, "b.txt"), "2\n");

  const emitted = await observer.flush();
  assert.equal(emitted.length, 2);
  assert.deepEqual(seen, ["a.txt", "b.txt"]);
  assert.equal(diagnostics.filter((d) => d.code === "listener_threw").length, 1);
  assert.match(diagnostics.find((d) => d.code === "listener_threw")!.detail, /listener exploded/);
});

test("24: a symlink hashes its target string as mode 120000, dangling included", async (t) => {
  const repo = await makeRepo(t);
  const { observer } = await attach(t, repo);
  await symlink("keep.txt", join(repo, "link.txt"));
  await symlink("nowhere.txt", join(repo, "dangling.txt"));

  const emitted = await observer.flush();
  const byPath = new Map(emitted.map((event) => [event.path, event]));
  assert.equal(byPath.get("link.txt")!.modeAfter, 120000);
  assert.equal(byPath.get("link.txt")!.afterHash, sha256("keep.txt"));
  assert.equal(byPath.get("dangling.txt")!.afterHash, sha256("nowhere.txt"), "a dangling symlink is observable, not an ENOENT");
});

test("25: stop() is idempotent, detaches everything, and removes the shadow tree", async (t) => {
  const repo = await makeRepo(t);
  const { observer } = await attach(t, repo, { watch: true, pollMs: 50 });
  await writeFile(join(repo, "keep.txt"), "z\n");
  await observer.flush();
  const shadow = observer.snapshot().get("keep.txt")!.shadowPath!;
  assert.ok(existsSync(shadow));

  await observer.stop();
  await observer.stop();
  assert.equal(existsSync(shadow), false);
  await assert.rejects(() => observer.flush(), (e: unknown) => (e as WorkspaceObserverError).code === "not_started");
  assert.throws(() => observer.snapshot(), (e: unknown) => (e as WorkspaceObserverError).code === "not_started");
});

test("26: sequences follow byte order regardless of write order", async (t) => {
  const repo = await makeRepo(t);
  const { observer } = await attach(t, repo);
  await writeFile(join(repo, "c.txt"), "c\n");
  await writeFile(join(repo, "a.txt"), "a\n");
  await writeFile(join(repo, "b.txt"), "b\n");

  const emitted = await observer.flush();
  assert.deepEqual(emitted.map((event) => event.path), ["a.txt", "b.txt", "c.txt"]);
  assert.deepEqual(emitted.map((event) => event.sequence), [1, 2, 3]);
});

test("27: a subdirectory root reports toplevel-relative paths and ignores changes outside its scope", async (t) => {
  const repo = await makeRepo(t, { "sub/inside.txt": "in\n", "outside.txt": "out\n" });
  const { observer } = await attach(t, join(repo, "sub"));
  assert.equal(observer.root, repo, "root is the git toplevel, not the observed subdirectory");
  assert.equal(observer.scope, "sub");

  await writeFile(join(repo, "sub", "inside.txt"), "in2\n");
  await writeFile(join(repo, "outside.txt"), "out2\n");

  const emitted = await observer.flush();
  assert.deepEqual(emitted.map((event) => event.path), ["sub/inside.txt"], "paths are toplevel-relative (API sharp edge, pinned)");
});

test("invariant 3: a full session leaves the workspace, the index and .git byte-identical", async (t) => {
  const repo = await makeRepo(t);
  const before = {
    status: git(repo, "status", "--porcelain", "-uall").stdout,
    head: git(repo, "rev-parse", "HEAD").stdout,
    index: git(repo, "ls-files", "--stage").stdout,
    objects: git(repo, "count-objects", "-v").stdout,
  };

  const { observer } = await attach(t, repo);
  await writeFile(join(repo, "keep.txt"), "edited\n");
  await writeFile(join(repo, "added.txt"), "new\n");
  await observer.flush();
  await unlink(join(repo, "added.txt"));
  await observer.flush();

  assert.equal(git(repo, "status", "--porcelain", "-uall").stdout, " M keep.txt\n", "only the agent's edit is dirty — the observer added nothing");
  assert.equal(git(repo, "rev-parse", "HEAD").stdout, before.head);
  assert.equal(git(repo, "ls-files", "--stage").stdout, before.index, "the index was never touched");
  assert.equal(git(repo, "count-objects", "-v").stdout, before.objects, "no objects were written (never hash-object -w)");
  assert.equal(existsSync(join(repo, ".git", "index.lock")), false);
  void before.status;
});

test("the per-cycle git spawn budget degrades diffs instead of stalling the cycle", async (t) => {
  const repo = await makeRepo(t);
  const { observer } = await attach(t, repo, { maxGitSpawnsPerCycle: 3 });
  for (const name of ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"]) await writeFile(join(repo, name), `${name}\n`);

  const emitted = await observer.flush();
  assert.equal(emitted.length, 5, "every change is still recorded");
  assert.ok(emitted.every((event) => event.afterHash !== null), "hashes stay exact under budget pressure");
  assert.ok(emitted.some((event) => event.diffOmitted === "budget"), "the overflow is declared, not silently dropped");
});

/* ---------- withWorkspaceObserver ---------- */

test("withWorkspaceObserver runs start → fn → flush → stop and returns every event", async (t) => {
  const repo = await makeRepo(t);
  const { result, events } = await withWorkspaceObserver({ root: repo, watch: false, pollMs: 0 }, async (observer) => {
    await writeFile(join(repo, "keep.txt"), "turn output\n");
    assert.equal(observer.root, repo);
    return "done";
  });

  assert.equal(result, "done");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.afterHash, sha256("turn output\n"));
  assert.equal(events[0]!.detectedBy, "flush");
});
