/**
 * Live wire probe: spawn `codex app-server`, run one real editing turn, and
 * record EVERY notification that crosses the pipe with a millisecond offset.
 *
 * This exists to answer one question with evidence instead of schema reading:
 * does a real Codex turn emit `item/fileChange/patchUpdated` before the file
 * lands on disk, and what exactly is in it?
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

const workdir = mkdtempSync(join(tmpdir(), "codex-probe-"));
const target = join(workdir, "hello.js");
writeFileSync(target, `function greet(name) {\n  return "hi " + name;\n}\n\nmodule.exports = { greet };\n`);
execSync("git init -q && git add -A && git -c user.email=p@p -c user.name=probe commit -q -m init", { cwd: workdir });
const before = readFileSync(target, "utf8");

const log = [];
const t0 = Date.now();
const stamp = () => Date.now() - t0;
function record(kind, method, extra = {}) {
  const entry = { atMs: stamp(), kind, method, ...extra };
  log.push(entry);
  return entry;
}

// Extra `-c key=value` overrides so we can test whether a structured
// apply_patch tool can be forced on instead of shell-based edits.
const overrides = process.argv.slice(2).flatMap((kv) => ["-c", kv]);
const child = spawn("codex", ["app-server", ...overrides], {
  cwd: workdir,
  env: { ...process.env, RUST_LOG: "warn" },
  stdio: ["pipe", "pipe", "pipe"],
});

let buf = "";
let nextId = 1;
const pending = new Map();
const seenMethods = new Map();
let firstPatchAt = null;
let firstDeltaAt = null;
let diskWriteAt = null;
const patchEvents = [];
const turnDiffs = [];
const commands = [];

// Poll the file so we can prove ordering: does the patch event beat the write?
const diskPoll = setInterval(() => {
  if (diskWriteAt === null && existsSync(target) && readFileSync(target, "utf8") !== before) {
    diskWriteAt = stamp();
    record("disk", "FILE_CHANGED_ON_DISK");
  }
}, 5);

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + "\n");
}
function request(method, params, timeoutMs = 30000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
    pending.set(id, { resolve, reject, timer });
    send({ id, method, params });
  });
}

child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }

    if (msg.id !== undefined && msg.method === undefined) {
      const p = pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result ?? {});
      }
      continue;
    }

    const method = msg.method ?? "";
    seenMethods.set(method, (seenMethods.get(method) ?? 0) + 1);

    // Server->client REQUESTS (have an id) must be answered or the turn stalls.
    if (msg.id !== undefined && method) {
      record("server_request", method);
      send({ id: msg.id, result: { decision: "approved", action: "approve", content: null, _meta: null } });
      continue;
    }

    if (method === "item/agentMessage/delta") {
      if (firstDeltaAt === null) { firstDeltaAt = stamp(); record("notify", method, { note: "FIRST TEXT DELTA" }); }
      continue;
    }
    if (method === "item/fileChange/patchUpdated") {
      if (firstPatchAt === null) firstPatchAt = stamp();
      const changes = msg.params?.changes ?? [];
      patchEvents.push({ atMs: stamp(), changes });
      record("notify", method, {
        changeCount: changes.length,
        paths: changes.map((c) => c.path),
        kinds: changes.map((c) => c.kind?.type ?? c.kind),
        diffBytes: changes.reduce((n, c) => n + (c.diff?.length ?? 0), 0),
      });
      continue;
    }
    if (method === "turn/diff/updated") {
      turnDiffs.push({ atMs: stamp(), diff: msg.params?.diff ?? "" });
      record("notify", method, { diffBytes: (msg.params?.diff ?? "").length });
      continue;
    }
    if (method === "item/completed") {
      const item = msg.params?.item ?? {};
      // Capture HOW the edit was made: a shell command bypasses Codex's
      // structured patch machinery entirely.
      const cmd = item.command ?? item.commandLine ?? item.parsedCommand ?? null;
      if (item.type === "commandExecution") {
        commands.push({ atMs: stamp(), command: typeof cmd === "string" ? cmd : JSON.stringify(cmd) });
      }
      record("notify", method, { itemType: item.type, status: item.status });
      continue;
    }
    if (method === "turn/completed") { record("notify", method, { status: msg.params?.turn?.status }); continue; }
    record("notify", method);
  }
});

const stderr = [];
child.stderr.on("data", (c) => stderr.push(c.toString("utf8")));

const done = new Promise((resolve) => {
  // Linger after turn/completed so a trailing diff event cannot be lost to a
  // shutdown race — that ambiguity would weaken the whole finding.
  const check = setInterval(() => {
    if (seenMethods.has("turn/completed")) {
      clearInterval(check);
      record("client", "turn/completed seen — lingering 3000ms for trailing events");
      setTimeout(() => resolve("completed"), 3000);
    }
  }, 50);
  setTimeout(() => { clearInterval(check); resolve("timeout"); }, 180000);
});

try {
  await request("initialize", {
    clientInfo: { name: "muster-probe", title: "Muster Probe", version: "0.1" },
    capabilities: { experimentalApi: true },
  }, 15000);
  send({ method: "initialized", params: {} });
  record("client", "initialize+initialized OK");

  const started = await request("thread/start", {
    cwd: workdir,
    approvalPolicy: "never",
    sandbox: "workspace-write",
  }, 20000);
  const threadId = started.thread?.id ?? started.threadId ?? started.sessionId;
  record("client", "thread/start OK", { threadId });

  const turnStartAt = stamp();
  await request("turn/start", {
    threadId,
    input: [{ type: "text", text: 'In hello.js change the string "hi " to "hello ". Make only that single edit, then stop.' }],
  }, 20000);
  record("client", "turn/start ACK");

  const outcome = await done;
  clearInterval(diskPoll);

  const after = existsSync(target) ? readFileSync(target, "utf8") : "(missing)";
  const report = {
    outcome,
    workdir,
    timeline: log,
    methodCounts: Object.fromEntries([...seenMethods.entries()].sort((a, b) => b[1] - a[1])),
    latency: {
      turnStartAtMs: turnStartAt,
      firstPatchUpdatedAtMs: firstPatchAt,
      firstTextDeltaAtMs: firstDeltaAt,
      fileChangedOnDiskAtMs: diskWriteAt,
      patchBeatsDiskByMs: firstPatchAt !== null && diskWriteAt !== null ? diskWriteAt - firstPatchAt : null,
    },
    patchEventCount: patchEvents.length,
    turnDiffCount: turnDiffs.length,
    firstPatchPayload: patchEvents[0] ?? null,
    lastTurnDiff: turnDiffs.at(-1) ?? null,
    fileBefore: before,
    fileAfter: after,
    fileActuallyChanged: before !== after,
    stderrTail: stderr.join("").split("\n").slice(-8),
  };
  console.log(JSON.stringify(report, null, 2));
} catch (err) {
  clearInterval(diskPoll);
  console.log(JSON.stringify({ error: String(err), timeline: log, methodCounts: Object.fromEntries(seenMethods), stderrTail: stderr.join("").split("\n").slice(-15) }, null, 2));
} finally {
  child.kill();
  process.exit(0);
}
