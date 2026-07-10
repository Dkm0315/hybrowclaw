import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { buildCodexArgs, parseCodexEvents, runCodex } from "../src/codex.js";
import { clearCodexAppServerSessions, runCodexAppServer } from "../src/codex-app-server.js";

test("buildCodexArgs: fresh turn runs codex exec at full native power", () => {
  const args = buildCodexArgs({
    prompt: "build me an xlsx of last week's tickets",
    cwd: "/home/goblin/.muster/profiles/tg/workspace",
    model: "gpt-5.5",
    instructionsFile: "/tmp/muster-inject.md",
    networkAccess: true,
    ignoreRules: true,
  }, "/tmp/out.txt");

  assert.deepEqual(args, [
    "exec", "--json",
    "-C", "/home/goblin/.muster/profiles/tg/workspace", "--skip-git-repo-check",
    "-m", "gpt-5.5",
    "-s", "workspace-write",
    "--ignore-rules",
    "-c", "approval_policy=never",
    "-c", "sandbox_workspace_write.network_access=true",
    "-c", "experimental_instructions_file=/tmp/muster-inject.md",
    "-o", "/tmp/out.txt",
    "build me an xlsx of last week's tickets",
  ]);
});

test("buildCodexArgs: resume threads the native session id", () => {
  const args = buildCodexArgs({
    prompt: "now add a totals row",
    cwd: "/ws",
    sessionId: "11111111-2222-3333-4444-555555555555",
    resume: true,
  }, "/tmp/o.txt");

  assert.deepEqual(args, [
    "exec", "resume", "--json",
    "--skip-git-repo-check",
    "-c", "approval_policy=never",
    "-o", "/tmp/o.txt",
    "11111111-2222-3333-4444-555555555555",
    "now add a totals row",
  ]);
  // never passes --no-session-persistence; full native power retained
  assert.ok(!args.includes("--no-session-persistence"));
  assert.ok(!args.includes("-q"));
});

test("buildCodexArgs: ephemeral fresh turns skip native session persistence for speed", () => {
  const args = buildCodexArgs({
    prompt: "hi",
    cwd: "/ws",
    model: "gpt-5.5",
    ephemeral: true,
  }, "/tmp/o.txt");

  assert.deepEqual(args.slice(0, 5), ["exec", "--json", "--ephemeral", "-C", "/ws"]);
  assert.ok(args.includes("--ephemeral"));
});

test("parseCodexEvents: extracts thread_id (resume handle) from the JSONL stream", () => {
  const stream = [
    '{"type":"thread.started","thread_id":"abc-123"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"type":"assistant_message","text":"done"}}',
    '{"type":"turn.completed"}',
  ].join("\n");
  const r = parseCodexEvents(stream);
  assert.equal(r.threadId, "abc-123");
  assert.equal(r.failed, false);
});

test("parseCodexEvents: detects a failed turn and its message", () => {
  const stream = [
    '{"type":"thread.started","thread_id":"x"}',
    '{"type":"turn.failed","error":{"message":"401 Unauthorized"}}',
  ].join("\n");
  const r = parseCodexEvents(stream);
  assert.equal(r.failed, true);
  assert.equal(r.failureMessage, "401 Unauthorized");
});

test("parseCodexEvents: tolerates non-JSON log lines without throwing", () => {
  const stream = "warning: --full-auto is deprecated\n{\"type\":\"thread.started\",\"thread_id\":\"y\"}\nplain log line";
  const r = parseCodexEvents(stream);
  assert.equal(r.threadId, "y");
  assert.equal(r.failed, false);
});

test("runCodexAppServer: streams a turn and reuses the session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-codex-app-server-"));
  const fake = join(dir, "codex-fake.mjs");
  await writeFile(fake, `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
let threadId = "thread-1";
let turn = 0;
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { userAgent: "fake" } });
  else if (msg.method === "initialized") {}
  else if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: threadId } } });
  else if (msg.method === "turn/start") {
    turn += 1;
    send({ id: msg.id, result: { turn: { id: "turn-" + turn, status: "inProgress" } } });
    send({ method: "item/agentMessage/delta", params: { threadId, turnId: "turn-" + turn, itemId: "m", delta: "ok" + turn } });
    send({ method: "item/completed", params: { item: { type: "agentMessage", id: "m", text: "ok" + turn }, threadId, turnId: "turn-" + turn } });
    send({ method: "thread/tokenUsage/updated", params: { threadId, turnId: "turn-" + turn, tokenUsage: { last: { inputTokens: 10 + turn, cachedInputTokens: turn === 1 ? 0 : 10, outputTokens: 1 } } } });
    send({ method: "turn/completed", params: { threadId, turn: { id: "turn-" + turn, status: "completed" } } });
  }
});
`, "utf8");
  await chmod(fake, 0o755);
  try {
    const deltas: string[] = [];
    const first = await runCodexAppServer({ prompt: "one", cwd: dir, command: fake, cacheKey: "test", onDelta: (delta) => deltas.push(delta) });
    const second = await runCodexAppServer({ prompt: "two", cwd: dir, command: fake, cacheKey: "test", onDelta: (delta) => deltas.push(delta) });
    assert.equal(first.status, "completed");
    assert.equal(first.finalMessage, "ok1");
    assert.equal(typeof first.firstDeltaMs, "number");
    assert.equal(second.finalMessage, "ok2");
    assert.equal(second.threadId, "thread-1");
    assert.equal(typeof second.firstDeltaMs, "number");
    assert.deepEqual(deltas, ["ok1", "ok2"]);
    assert.equal(second.tokenUsage?.cachedInputTokens, 10);
  } finally {
    clearCodexAppServerSessions();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCodexAppServer: serializes concurrent turns on one warm session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-codex-app-server-serial-"));
  const fake = join(dir, "codex-fake.mjs");
  const log = join(dir, "turns.log");
  await writeFile(fake, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const log = ${JSON.stringify(log)};
let turn = 0;
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
function later(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
rl.on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { userAgent: "fake" } });
  else if (msg.method === "initialized") {}
  else if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: "thread-serial" } } });
  else if (msg.method === "turn/start") {
    turn += 1;
    const id = "turn-" + turn;
    const prompt = msg.params.input[0].text;
    appendFileSync(log, "start:" + prompt + "\\n");
    send({ id: msg.id, result: { turn: { id, status: "inProgress" } } });
    await later(prompt === "one" ? 60 : 1);
    send({ method: "item/completed", params: { item: { type: "agentMessage", id: "m-" + id, text: "ok:" + prompt }, threadId: "thread-serial", turnId: id } });
    appendFileSync(log, "done:" + prompt + "\\n");
    send({ method: "turn/completed", params: { threadId: "thread-serial", turn: { id, status: "completed" } } });
  }
});
`, "utf8");
  await chmod(fake, 0o755);
  try {
    await runCodexAppServer({ prompt: "warm", cwd: dir, command: fake, cacheKey: "serial" });
    const [one, two] = await Promise.all([
      runCodexAppServer({ prompt: "one", cwd: dir, command: fake, cacheKey: "serial" }),
      runCodexAppServer({ prompt: "two", cwd: dir, command: fake, cacheKey: "serial" }),
    ]);

    assert.equal(one.finalMessage, "ok:one");
    assert.equal(two.finalMessage, "ok:two");
    const events = (await readFile(log, "utf8")).trim().split("\n");
    assert.deepEqual(events, ["start:warm", "done:warm", "start:one", "done:one", "start:two", "done:two"]);
  } finally {
    clearCodexAppServerSessions();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCodexAppServer: instruction content changes create a fresh cached session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-codex-app-server-instructions-"));
  const fake = join(dir, "codex-fake.mjs");
  const instructions = join(dir, "instructions.md");
  await writeFile(fake, `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const threadId = "thread-" + process.pid;
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { userAgent: "fake" } });
  else if (msg.method === "initialized") {}
  else if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: threadId } } });
  else if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
    send({ method: "item/completed", params: { item: { type: "agentMessage", id: "m", text: threadId }, threadId, turnId: "turn-1" } });
    send({ method: "turn/completed", params: { threadId, turn: { id: "turn-1", status: "completed" } } });
  }
});
`, "utf8");
  await chmod(fake, 0o755);
  try {
    await writeFile(instructions, "context one", "utf8");
    const first = await runCodexAppServer({ prompt: "one", cwd: dir, command: fake, cacheKey: "same-chat", instructionsFile: instructions });
    await writeFile(instructions, "context two", "utf8");
    const second = await runCodexAppServer({ prompt: "two", cwd: dir, command: fake, cacheKey: "same-chat", instructionsFile: instructions });

    assert.equal(first.status, "completed");
    assert.equal(second.status, "completed");
    assert.notEqual(second.threadId, first.threadId, "changed injected context must not reuse a warm Codex process");
  } finally {
    clearCodexAppServerSessions();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCodexAppServer: warm session cache evicts the least-recent idle process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-codex-app-server-lru-"));
  const fake = join(dir, "codex-fake.mjs");
  await writeFile(fake, `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const threadId = "thread-" + process.pid;
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { userAgent: "fake" } });
  else if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: threadId } } });
  else if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
    send({ method: "item/completed", params: { item: { type: "agentMessage", id: "m", text: threadId }, threadId, turnId: "turn-1" } });
    send({ method: "turn/completed", params: { threadId, turn: { id: "turn-1", status: "completed" } } });
  }
});
`, "utf8");
  await chmod(fake, 0o755);
  const previous = process.env.MUSTER_NATIVE_SESSION_CACHE_SIZE;
  process.env.MUSTER_NATIVE_SESSION_CACHE_SIZE = "2";
  try {
    clearCodexAppServerSessions();
    const firstA = await runCodexAppServer({ prompt: "A1", cwd: dir, command: fake, cacheKey: "A" });
    await runCodexAppServer({ prompt: "B", cwd: dir, command: fake, cacheKey: "B" });
    await runCodexAppServer({ prompt: "C", cwd: dir, command: fake, cacheKey: "C" });
    const secondA = await runCodexAppServer({ prompt: "A2", cwd: dir, command: fake, cacheKey: "A" });
    assert.notEqual(secondA.threadId, firstA.threadId, "the oldest idle session is replaced after the cache reaches its bound");
  } finally {
    if (previous === undefined) delete process.env.MUSTER_NATIVE_SESSION_CACHE_SIZE;
    else process.env.MUSTER_NATIVE_SESSION_CACHE_SIZE = previous;
    clearCodexAppServerSessions();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCodexAppServer: keepAlive=false closes the app-server instead of caching it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-codex-app-server-no-cache-"));
  const fake = join(dir, "codex-fake.mjs");
  await writeFile(fake, `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const threadId = "thread-" + process.pid;
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { userAgent: "fake" } });
  else if (msg.method === "initialized") {}
  else if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: threadId } } });
  else if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
    send({ method: "item/completed", params: { item: { type: "agentMessage", id: "m", text: threadId }, threadId, turnId: "turn-1" } });
    send({ method: "turn/completed", params: { threadId, turn: { id: "turn-1", status: "completed" } } });
  }
});
`, "utf8");
  await chmod(fake, 0o755);
  try {
    const first = await runCodexAppServer({ prompt: "one", cwd: dir, command: fake, cacheKey: "same-chat", keepAlive: false });
    const second = await runCodexAppServer({ prompt: "two", cwd: dir, command: fake, cacheKey: "same-chat", keepAlive: false });

    assert.equal(first.status, "completed");
    assert.equal(second.status, "completed");
    assert.notEqual(second.threadId, first.threadId);
  } finally {
    clearCodexAppServerSessions();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCodex refuses legacy Codex before passing modern exec flags", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-codex-legacy-"));
  const fake = join(dir, "codex-legacy.mjs");
  const unsafeMarker = join(dir, "unsafe.txt");
  await writeFile(fake, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "exec" && args[1] === "--help") {
  console.error("Usage: codex [options] <prompt>");
  process.exit(2);
}
if (args.includes("-c")) writeFileSync(${JSON.stringify(unsafeMarker)}, "unsafe");
process.exit(0);
`, "utf8");
  await chmod(fake, 0o755);
  try {
    const result = await runCodex({
      prompt: "hi",
      cwd: dir,
      command: fake,
      instructionsFile: join(dir, "instructions.md"),
      timeoutMs: 1_000,
    });

    assert.equal(result.status, "failed");
    assert.match(result.errorMessage ?? "", /does not support `codex exec --json`/);
    await assert.rejects(readFile(unsafeMarker, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
