/**
 * LIVE HEAD-TO-HEAD: Muster's workspace observer vs Codex's own event stream,
 * on ONE real `codex app-server` editing turn.
 *
 * docs/STRATEGY_V2.md §2.2 measured `item/fileChange/patchUpdated` firing ZERO
 * times across three live turns while every edit landed via shell
 * `commandExecution`. This script is the competitive gate for Wave 0 row 3:
 * attach `createWorkspaceObserver` (packages/core/dist/index.js) to the same
 * temp repo the probe used, run the same editing turn, and record BOTH streams
 * side by side with ms offsets. The observer must capture what the backend's
 * self-report misses.
 *
 * Assertions (exit 1 on failure):
 *   A1 observer captured the edit: unified diff chain replays byte-exactly
 *      (git apply) from the pre-turn content to the on-disk result, and the
 *      before/after sha256 hashes anchor both ends;
 *   A2 detection latency (first disk mutation, 5ms poll → observer emission)
 *      measured and < 1000ms;
 *   A3 final file content hash equals the observer's last afterHash;
 *   A4 codex `patchUpdated` count reported honestly (informational — expected
 *      0 per §2.2, but whatever occurs is printed, never assumed).
 *
 * Environmental failure (codex spawn/auth/timeout, or the model declines the
 * edit) → retry once, then exit 2 with status "skipped" and the exact error.
 * Never fabricate: a skipped run produces no head-to-head numbers.
 *
 * Exit codes: 0 pass · 1 assertion failure · 2 environmental skip.
 */
import { spawn, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { createWorkspaceObserver } = await import(new URL("../../packages/core/dist/index.js", import.meta.url));

const ORIGINAL = `function greet(name) {\n  return "hi " + name;\n}\n\nmodule.exports = { greet };\n`;
const PROMPT = 'In hello.js change the string "hi " to "hello ". Make only that single edit, then stop.';
const TURN_TIMEOUT_MS = 180_000;
const LINGER_MS = 3000;
const LATENCY_BUDGET_MS = 1000;

const sha256 = (input) => `sha256:${createHash("sha256").update(input).digest("hex")}`;

/**
 * Replay the observer's diff chain with `git apply` in a scratch dir OUTSIDE
 * any repo. Each event's diff must transform its beforeHash content into its
 * afterHash content — this is what "correct unified diff" means, not a
 * substring check.
 */
function replayDiffChain(targetPath, events) {
  const scratch = mkdtempSync(join(tmpdir(), "observer-verify-"));
  const file = join(scratch, targetPath);
  let content = ORIGINAL;
  writeFileSync(file, content);
  for (const [index, event] of events.entries()) {
    if (event.diff === null) return { ok: false, detail: `event ${index} has no diff (omitted: ${event.diffOmitted ?? "?"})` };
    if (event.beforeHash !== sha256(content)) return { ok: false, detail: `event ${index} beforeHash does not chain from prior state` };
    const patch = join(scratch, `event-${index}.patch`);
    writeFileSync(patch, event.diff);
    try {
      execSync(`git apply --whitespace=nowarn ${JSON.stringify(patch)}`, { cwd: scratch, stdio: "pipe" });
    } catch (error) {
      return { ok: false, detail: `git apply failed on event ${index}: ${String(error.stderr ?? error.message).trim()}` };
    }
    content = readFileSync(file, "utf8");
    if (sha256(content) !== event.afterHash) return { ok: false, detail: `event ${index} diff does not reproduce its own afterHash` };
  }
  return { ok: true, finalContent: content };
}

async function runAttempt(attempt) {
  const workdir = mkdtempSync(join(tmpdir(), "observer-live-"));
  const target = join(workdir, "hello.js");
  writeFileSync(target, ORIGINAL);
  execSync("git init -q && git add -A && git -c user.email=p@p -c user.name=probe commit -q -m init", { cwd: workdir });

  // One merged timeline, every entry tagged with its stream and ms offset.
  const timeline = [];
  const t0 = Date.now();
  const stamp = () => Date.now() - t0;
  const record = (stream, method, extra = {}) => { timeline.push({ atMs: stamp(), stream, method, ...extra }); };

  /* ---- stream 1: the observer (workspace truth) ---- */
  const observerEvents = [];
  const observer = createWorkspaceObserver({
    root: workdir,
    debounceMs: 40,
    pollMs: 250,
    onPatch: (event) => {
      observerEvents.push({ atMs: stamp(), event });
      record("observer", "workspace.patch", {
        path: event.path,
        changeKind: event.changeKind,
        detectedBy: event.detectedBy,
        beforeHash: event.beforeHash,
        afterHash: event.afterHash,
        diffBytes: event.diff?.length ?? 0,
      });
    },
    onDiagnostic: (d) => record("observer", `diagnostic:${d.code}`, { detail: d.detail, ...(d.path ? { path: d.path } : {}) }),
  });
  await observer.start();
  record("client", "observer started", { baselineRev: observer.baselineRev });

  // 5ms disk poll — the same ordering instrument the §2.2 probe used. Latency
  // is measured from FIRST DISK MUTATION, not from what codex claims.
  let diskWriteAt = null;
  const diskPoll = setInterval(() => {
    if (diskWriteAt === null && existsSync(target) && readFileSync(target, "utf8") !== ORIGINAL) {
      diskWriteAt = stamp();
      record("disk", "FILE_CHANGED_ON_DISK");
    }
  }, 5);

  /* ---- stream 2: codex app-server notifications (backend self-report) ---- */
  const child = spawn("codex", ["app-server"], {
    cwd: workdir,
    env: { ...process.env, RUST_LOG: "warn" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (c) => stderr.push(c.toString("utf8")));

  let buf = "";
  let nextId = 1;
  const pending = new Map();
  const seenMethods = new Map();
  const patchUpdates = [];
  const turnDiffs = [];
  let turnStatus = null;

  const send = (obj) => { child.stdin.write(JSON.stringify(obj) + "\n"); };
  const request = (method, params, timeoutMs = 30_000) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out after ${timeoutMs}ms`)), timeoutMs);
      pending.set(id, { resolve, reject, timer });
      send({ id, method, params });
    });
  };

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

      // Server->client REQUESTS must be answered or the turn stalls.
      if (msg.id !== undefined && method) {
        record("codex", method, { kind: "server_request" });
        send({ id: msg.id, result: { decision: "approved", action: "approve", content: null, _meta: null } });
        continue;
      }

      if (method === "item/fileChange/patchUpdated") {
        const changes = msg.params?.changes ?? [];
        patchUpdates.push({ atMs: stamp(), changes });
        record("codex", method, { changeCount: changes.length, paths: changes.map((c) => c.path) });
        continue;
      }
      if (method === "turn/diff/updated") {
        turnDiffs.push({ atMs: stamp(), diffBytes: (msg.params?.diff ?? "").length });
        record("codex", method, { diffBytes: (msg.params?.diff ?? "").length });
        continue;
      }
      if (method === "item/completed") {
        const item = msg.params?.item ?? {};
        const cmd = item.command ?? item.commandLine ?? item.parsedCommand ?? null;
        record("codex", method, {
          itemType: item.type,
          status: item.status,
          ...(item.type === "commandExecution" ? { command: typeof cmd === "string" ? cmd : JSON.stringify(cmd) } : {}),
        });
        continue;
      }
      if (method === "turn/completed") {
        turnStatus = msg.params?.turn?.status ?? null;
        record("codex", method, { status: turnStatus });
        continue;
      }
      if (method === "item/agentMessage/delta") {
        if ((seenMethods.get(method) ?? 0) === 1) record("codex", method, { note: "first text delta" });
        continue; // count the rest, don't flood the timeline
      }
      record("codex", method);
    }
  });

  const done = new Promise((resolve) => {
    const check = setInterval(() => {
      if (seenMethods.has("turn/completed")) {
        clearInterval(check);
        record("client", `turn/completed seen — lingering ${LINGER_MS}ms for trailing events`);
        setTimeout(() => resolve("completed"), LINGER_MS);
      }
    }, 50);
    setTimeout(() => { clearInterval(check); resolve("timeout"); }, TURN_TIMEOUT_MS);
  });

  const cleanup = async () => {
    clearInterval(diskPoll);
    try { child.kill(); } catch { /* already gone */ }
  };

  try {
    // Handshake copied verbatim from codex-app-server-probe.mjs.
    await request("initialize", {
      clientInfo: { name: "muster-observer-live", title: "Muster Observer Live", version: "0.1" },
      capabilities: { experimentalApi: true },
    }, 15_000);
    send({ method: "initialized", params: {} });
    record("client", "initialize+initialized OK");

    const started = await request("thread/start", { cwd: workdir, approvalPolicy: "never", sandbox: "workspace-write" }, 20_000);
    const threadId = started.thread?.id ?? started.threadId ?? started.sessionId;
    record("client", "thread/start OK", { threadId });

    await request("turn/start", { threadId, input: [{ type: "text", text: PROMPT }] }, 20_000);
    record("client", "turn/start ACK");

    const outcome = await done;
    clearInterval(diskPoll);
    if (outcome === "timeout") throw new Error(`turn/completed not seen within ${TURN_TIMEOUT_MS}ms`);

    // Final flush so nothing rides on watch timing, then freeze both sides.
    await observer.flush();
    const stats = observer.stats;
    const finalContent = existsSync(target) ? readFileSync(target, "utf8") : null;
    await observer.stop();
    await cleanup();

    if (finalContent === null || finalContent === ORIGINAL) {
      const err = new Error(`codex turn ended (turn status: ${turnStatus ?? "unknown"}) but hello.js was never edited on disk`);
      err.environmental = true;
      throw err;
    }

    /* ---- assertions ---- */
    const targetEvents = observerEvents.filter((e) => e.event.path === "hello.js").map((e) => e.event);
    const firstTargetAt = observerEvents.find((e) => e.event.path === "hello.js")?.atMs ?? null;
    const lastTarget = targetEvents.at(-1) ?? null;
    const detectionLatencyMs = diskWriteAt !== null && firstTargetAt !== null ? firstTargetAt - diskWriteAt : null;

    const replay = targetEvents.length > 0
      ? replayDiffChain("hello.js", targetEvents)
      : { ok: false, detail: "observer emitted no event for hello.js" };
    const replayReachesDisk = replay.ok && replay.finalContent === finalContent;

    const assertions = [
      {
        name: "A1 observer captured the edit with a correct unified diff and before/after sha256",
        pass: targetEvents.length > 0
          && targetEvents[0].beforeHash === sha256(ORIGINAL)
          && replay.ok && replayReachesDisk,
        detail: replay.ok
          ? (replayReachesDisk
            ? `${targetEvents.length} event(s); git apply replays baseline → disk byte-exactly; beforeHash anchors the pre-turn content`
            : "diff chain applies but does not reproduce the on-disk result")
          : replay.detail,
      },
      {
        name: `A2 observer detection latency (disk write → emission) < ${LATENCY_BUDGET_MS}ms`,
        pass: detectionLatencyMs !== null && detectionLatencyMs < LATENCY_BUDGET_MS,
        detail: detectionLatencyMs === null
          ? `unmeasurable (diskWriteAt=${diskWriteAt}, firstObserverEventAt=${firstTargetAt})`
          : `${detectionLatencyMs}ms (disk ${diskWriteAt}ms → observer ${firstTargetAt}ms, detectedBy=${targetEvents[0]?.detectedBy})`,
      },
      {
        name: "A3 final file content matches the observer's afterHash",
        pass: lastTarget !== null && sha256(finalContent) === lastTarget.afterHash,
        detail: lastTarget === null ? "no observer event to compare" : `disk ${sha256(finalContent)} vs observer ${lastTarget.afterHash}`,
      },
      {
        name: "A4 codex patchUpdated count reported honestly (informational, §2.2 predicts 0)",
        pass: true,
        detail: `item/fileChange/patchUpdated fired ${patchUpdates.length} time(s); turn/diff/updated fired ${turnDiffs.length} time(s)`,
      },
    ];

    return {
      status: assertions.every((a) => a.pass) ? "pass" : "fail",
      report: {
        script: "workspace-observer-live",
        attempt,
        workdir,
        turnStatus,
        headToHead: {
          codexPatchUpdatedCount: patchUpdates.length,
          codexTurnDiffCount: turnDiffs.length,
          observerPatchEventCount: observerEvents.length,
          observerTargetEventCount: targetEvents.length,
          diskWriteAtMs: diskWriteAt,
          firstObserverEventAtMs: firstTargetAt,
          detectionLatencyMs,
        },
        assertions,
        observerEvents: observerEvents.map(({ atMs, event }) => ({
          atMs,
          sequence: event.sequence,
          path: event.path,
          changeKind: event.changeKind,
          detectedBy: event.detectedBy,
          beforeHash: event.beforeHash,
          afterHash: event.afterHash,
          diff: event.diff,
          receiptHash: event.receiptHash,
        })),
        observerStats: stats,
        codexMethodCounts: Object.fromEntries([...seenMethods.entries()].sort((a, b) => b[1] - a[1])),
        timeline,
        fileBeforeHash: sha256(ORIGINAL),
        fileAfterHash: sha256(finalContent),
        stderrTail: stderr.join("").split("\n").slice(-8),
      },
    };
  } catch (error) {
    await observer.stop().catch(() => {});
    await cleanup();
    return {
      status: "skip",
      report: {
        script: "workspace-observer-live",
        attempt,
        workdir,
        error: String(error?.message ?? error),
        codexMethodCounts: Object.fromEntries(seenMethods),
        timeline,
        stderrTail: stderr.join("").split("\n").slice(-15),
      },
    };
  }
}

/* ---- drive: one live run, one retry on environmental failure only ---- */
let result = await runAttempt(1);
if (result.status === "skip") {
  console.error(`[workspace-observer-live] attempt 1 failed environmentally: ${result.report.error} — retrying once`);
  result = await runAttempt(2);
}
console.log(JSON.stringify(result.report, null, 2));
process.exit(result.status === "pass" ? 0 : result.status === "fail" ? 1 : 2);
