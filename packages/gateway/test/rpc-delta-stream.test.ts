import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { defaultConfig } from "@musterhq/core";
import type { MusterConfig } from "@musterhq/core";
import { attachStdioTransport, createRpcCore } from "../src/rpc.js";
import type { RpcEvent } from "../src/rpc.js";

/**
 * Gateway delta streaming (docs/PRODUCT_MODES.md "Parent-model streaming").
 * The contract under test: web/desktop/channel surfaces see the parent model's
 * narration WHILE it happens, and the turn is still correct for a surface that
 * saw none of it — deltas are additive UX, message.stop stays authoritative.
 */

type DeltaEvent = Extract<RpcEvent, { type: "message.delta" | "reasoning.delta" }>;

function startStubLlm(reply: string): Promise<{ url: string; close(): void }> {
  return new Promise((resolve) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/v1`, close: () => server.close() });
    });
  });
}

function stubConfig(baseUrl: string): MusterConfig {
  const config = defaultConfig();
  return {
    ...config,
    providers: { stub: { id: "stub", kind: "openai-compatible", baseUrl, defaultModel: "stub-model", timeoutMs: 5000 } },
    runtimes: { native: { id: "native", enabled: true, provider: "stub", routes: {} } },
    routing: { ...config.routing, defaultRuntime: "native" },
  };
}

/**
 * A long fenced answer: forces multiple frames and exercises the fence guard.
 * Deliberately free of trailing whitespace — executeRun trims the final response,
 * so a padded fixture would make exact reassembly fail for a reason unrelated to
 * framing (covered on purpose by the "additive, never authoritative" test below).
 */
function fencedNarration(): string {
  const prose = "Splitting the mission into three tasks now. ".repeat(12).trimEnd();
  const code = Array.from({ length: 40 }, (_unused, line) => `  const step${line} = await runStep(${line}, { retries: 2 });`).join("\n");
  const tail = "Done. Every step above is idempotent, so a partial run is safe to replay. ".repeat(8).trimEnd();
  return `${prose}\n\n\`\`\`ts\n${code}\n\`\`\`\n\n${tail}`;
}

/**
 * Fake Codex app-server. Unlike the openai-compatible path (which synthesizes
 * deltas from the already-normalized response), this streams the provider's RAW
 * bytes — the only harness that can exercise a delta stream disagreeing with the
 * final. It also emits a hidden chain-of-thought item so the tests can prove the
 * gateway has no path from raw reasoning to the wire (codex-app-server.ts:34).
 */
async function writeCodexFake(cwd: string, script: { readonly summary: string; readonly answer: string }): Promise<string> {
  const fake = join(cwd, "codex-fake.mjs");
  await writeFile(fake, `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const threadId = "thread-" + process.pid;
const summary = ${JSON.stringify(script.summary)};
const answer = ${JSON.stringify(script.answer)};
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
process.on("SIGTERM", () => process.exit(0));
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { userAgent: "fake" } });
  else if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: threadId } } });
  else if (msg.method === "turn/start") {
    const turnId = "turn-1";
    send({ id: msg.id, result: { turn: { id: turnId, status: "inProgress" } } });
    send({ method: "item/reasoning/rawContentDelta", params: { threadId, turnId, itemId: "r", delta: "SECRET-RAW-COT" } });
    for (const chunk of (summary.match(/[\\s\\S]{1,40}/g) ?? [])) send({ method: "item/reasoning/summaryTextDelta", params: { threadId, turnId, itemId: "r", delta: chunk } });
    for (const chunk of (answer.match(/[\\s\\S]{1,40}/g) ?? [])) send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "m", delta: chunk } });
    send({ method: "item/completed", params: { item: { type: "agentMessage", id: "m", text: answer }, threadId, turnId } });
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
  }
});
`, "utf8");
  await chmod(fake, 0o755);
  return fake;
}

async function runOnePrompt(
  config: MusterConfig,
  cwd: string,
  prompt: string,
): Promise<{ events: RpcEvent[]; sessionId: string; result: { runId: string; text: string } }> {
  const core = createRpcCore({ config, cwd });
  try {
    const events: RpcEvent[] = [];
    core.subscribe((event) => events.push(event));
    const created = await core.handle({ jsonrpc: "2.0", id: 1, method: "session.create" });
    const sessionId = (created.result as { sessionId: string }).sessionId;
    const reply = await core.handle({ jsonrpc: "2.0", id: 2, method: "prompt.submit", params: { sessionId, prompt } });
    assert.equal(reply.error, undefined, `prompt.submit failed: ${reply.error?.message}`);
    return { events, sessionId, result: reply.result as { runId: string; text: string } };
  } finally {
    core.close();
  }
}

const deltasOf = (events: readonly RpcEvent[], type: DeltaEvent["type"]): DeltaEvent[] =>
  events.filter((event): event is DeltaEvent => event.type === type);

test("message deltas reassemble to exactly the final text and never split a code fence", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-rpc-delta-"));
  const narration = fencedNarration();
  const llm = await startStubLlm(narration);
  try {
    const { events } = await runOnePrompt(stubConfig(llm.url), cwd, "plan the mission");
    const deltas = deltasOf(events, "message.delta");
    const stop = events.find((event) => event.type === "message.stop");
    assert.ok(stop?.type === "message.stop");

    assert.ok(deltas.length > 1, `narration must arrive in multiple frames, got ${deltas.length}`);
    // The whole point: a client that concatenates frames gets the real answer.
    assert.equal(deltas.map((delta) => delta.text).join(""), stop.text);
    assert.equal(stop.text, narration, "message.stop carries the FULL final text");

    // Fence integrity: no frame boundary lands inside an open ``` block, so every
    // frame is independently renderable markdown.
    let running = "";
    for (const delta of deltas.slice(0, -1)) {
      running += delta.text;
      const fences = running.match(/^[ \t]{0,3}```/gm) ?? [];
      assert.equal(fences.length % 2, 0, `frame boundary at ${running.length} chars split a code fence`);
    }
    // ...and the fence really was large enough to have been split naively.
    assert.ok(narration.indexOf("```") + 200 < narration.lastIndexOf("```"), "fixture fence must exceed the min block size");
  } finally {
    llm.close();
  }
});

test("message.stop is authoritative even where it disagrees with the raw delta bytes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-rpc-delta-authority-"));
  // executeRun normalizes the final response; deltas carry the provider's raw
  // bytes. A surface must therefore render the final from message.stop, never
  // from its own reassembly — that is what "additive UX, never authoritative" buys.
  const padded = `${fencedNarration()}   \n\n`;
  const fake = await writeCodexFake(cwd, { summary: "", answer: padded });
  const previousCommand = process.env.MUSTER_CODEX_COMMAND;
  process.env.MUSTER_CODEX_COMMAND = fake;
  const core = createRpcCore({ config: defaultConfig(), cwd, nativeTransportOwner: "rpc:delta-authority" });
  try {
    const events: RpcEvent[] = [];
    core.subscribe((event) => events.push(event));
    const created = await core.handle({ jsonrpc: "2.0", id: 1, method: "session.create" });
    const sessionId = (created.result as { sessionId: string }).sessionId;
    const reply = await core.handle({ jsonrpc: "2.0", id: 2, method: "prompt.submit", params: { sessionId, prompt: "plan the mission" } });
    assert.equal(reply.error, undefined, `prompt.submit failed: ${reply.error?.message}`);

    const stop = events.find((event) => event.type === "message.stop");
    assert.ok(stop?.type === "message.stop");
    const reassembled = deltasOf(events, "message.delta").map((delta) => delta.text).join("");

    assert.equal(reassembled, padded, "deltas are lossless over what the provider actually streamed");
    assert.equal(stop.text, padded.trim(), "the final is the normalized text, not the raw stream");
    assert.equal(stop.text, (reply.result as { text: string }).text, "message.stop and the RPC result never disagree");
    assert.notEqual(reassembled, stop.text, "fixture must actually exercise the disagreement");
  } finally {
    core.close();
    if (previousCommand === undefined) delete process.env.MUSTER_CODEX_COMMAND;
    else process.env.MUSTER_CODEX_COMMAND = previousCommand;
  }
});

test("seq is strictly increasing, scoped to the stream run, and shared across both channels", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-rpc-delta-seq-"));
  const llm = await startStubLlm(fencedNarration());
  try {
    const { events } = await runOnePrompt(stubConfig(llm.url), cwd, "plan the mission");
    const deltas = events.filter((event): event is DeltaEvent => event.type === "message.delta" || event.type === "reasoning.delta");
    assert.ok(deltas.length > 1);

    const runIds = new Set(deltas.map((delta) => delta.runId));
    assert.equal(runIds.size, 1, "one stream run id scopes the whole seq space");
    for (let at = 1; at < deltas.length; at += 1) {
      assert.ok(deltas[at]!.seq > deltas[at - 1]!.seq, `seq must strictly increase: ${deltas[at - 1]!.seq} -> ${deltas[at]!.seq}`);
    }

    const stop = events.find((event) => event.type === "message.stop");
    assert.ok(stop?.type === "message.stop");
    assert.equal(stop.streamRunId, deltas[0]!.runId, "message.stop ties the final back to its delta frames");
    // The authoritative run id stays the core one, matching ledger.tick and the RPC result.
    const tick = events.find((event) => event.type === "ledger.tick");
    assert.ok(tick?.type === "ledger.tick");
    assert.equal(stop.runId, tick.runId);
    assert.notEqual(stop.runId, stop.streamRunId);
  } finally {
    llm.close();
  }
});

test("no delta is emitted after message.stop", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-rpc-delta-order-"));
  const llm = await startStubLlm(fencedNarration());
  try {
    const { events } = await runOnePrompt(stubConfig(llm.url), cwd, "plan the mission");
    const stopAt = events.findIndex((event) => event.type === "message.stop");
    assert.ok(stopAt > 0);
    const afterStop = events.slice(stopAt + 1).filter((event) => event.type === "message.delta" || event.type === "reasoning.delta");
    assert.deepEqual(afterStop, [], "deltas after the final are forbidden");
  } finally {
    llm.close();
  }
});

test("a provider failure terminates the delta stream instead of stranding it", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-rpc-delta-fail-"));
  const server = createServer((_request, response) => {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "upstream exploded" } }));
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/v1`;
  const core = createRpcCore({ config: stubConfig(url), cwd });
  try {
    const events: RpcEvent[] = [];
    core.subscribe((event) => events.push(event));
    const created = await core.handle({ jsonrpc: "2.0", id: 1, method: "session.create" });
    const sessionId = (created.result as { sessionId: string }).sessionId;
    const reply = await core.handle({ jsonrpc: "2.0", id: 2, method: "prompt.submit", params: { sessionId, prompt: "plan the mission" } });

    assert.ok(reply.error, "the caller still learns the run failed");
    // Whatever narration arrived before the failure is flushed, then the stream
    // is inert: the idle ticker is cleared and no frame can trail the failure.
    const stopAt = events.findIndex((event) => event.type === "message.stop");
    const tail = (stopAt >= 0 ? events.slice(stopAt + 1) : []).filter(
      (event) => event.type === "message.delta" || event.type === "reasoning.delta",
    );
    assert.deepEqual(tail, [], "no delta may follow a terminal event on the failure path");
    // Deltas are still self-consistent: one run id, strictly increasing seq.
    const deltas = events.filter((event): event is DeltaEvent => event.type === "message.delta");
    for (let at = 1; at < deltas.length; at += 1) assert.ok(deltas[at]!.seq > deltas[at - 1]!.seq);
  } finally {
    core.close();
    server.close();
  }
});

test("a subscriber that joins mid-run misses deltas but still gets the correct full final", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-rpc-delta-late-"));
  const narration = fencedNarration();
  const llm = await startStubLlm(narration);
  const core = createRpcCore({ config: stubConfig(llm.url), cwd });
  try {
    const early: RpcEvent[] = [];
    const late: RpcEvent[] = [];
    let joined = false;
    let seenDeltas = 0;
    core.subscribe((event) => {
      early.push(event);
      if (event.type !== "message.delta") return;
      seenDeltas += 1;
      // Join once narration is already under way — the realistic web-refresh case.
      if (seenDeltas >= 2 && !joined) {
        joined = true;
        core.subscribe((next) => late.push(next));
      }
    });

    const created = await core.handle({ jsonrpc: "2.0", id: 1, method: "session.create" });
    const sessionId = (created.result as { sessionId: string }).sessionId;
    await core.handle({ jsonrpc: "2.0", id: 2, method: "prompt.submit", params: { sessionId, prompt: "plan the mission" } });

    assert.ok(joined, "the late subscriber attached during the run");
    const lateStop = late.find((event) => event.type === "message.stop");
    assert.ok(lateStop?.type === "message.stop");
    assert.equal(lateStop.text, narration, "the late joiner's final is complete, not the tail it happened to catch");
    assert.ok(
      deltasOf(late, "message.delta").length < deltasOf(early, "message.delta").length,
      "the late joiner genuinely missed frames",
    );
  } finally {
    core.close();
    llm.close();
  }
});

test("reasoning summaries stream on their own channel and raw narration never leaks into it", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-rpc-delta-reasoning-"));
  const fake = await writeCodexFake(cwd, {
    summary: "Weighing two designs for the limiter. ".repeat(12).trimEnd(),
    answer: "Use a token bucket keyed per chat. ".repeat(14).trimEnd(),
  });
  const previousCommand = process.env.MUSTER_CODEX_COMMAND;
  process.env.MUSTER_CODEX_COMMAND = fake;
  const core = createRpcCore({ config: defaultConfig(), cwd, nativeTransportOwner: "rpc:delta-reasoning" });
  try {
    const events: RpcEvent[] = [];
    core.subscribe((event) => events.push(event));
    const created = await core.handle({ jsonrpc: "2.0", id: 1, method: "session.create" });
    const sessionId = (created.result as { sessionId: string }).sessionId;
    const reply = await core.handle({ jsonrpc: "2.0", id: 2, method: "prompt.submit", params: { sessionId, prompt: "design the limiter" } });
    assert.equal(reply.error, undefined, `prompt.submit failed: ${reply.error?.message}`);

    const message = deltasOf(events, "message.delta");
    const reasoning = deltasOf(events, "reasoning.delta");
    assert.ok(reasoning.length > 0, "approved reasoning summaries reach the wire");
    assert.ok(message.length > 0, "narration reaches the wire");

    const reasoningText = reasoning.map((delta) => delta.text).join("");
    const messageText = message.map((delta) => delta.text).join("");
    assert.match(reasoningText, /Weighing two designs/);
    assert.doesNotMatch(reasoningText, /SECRET-RAW-COT/, "raw chain-of-thought is never forwarded");
    assert.doesNotMatch(messageText, /SECRET-RAW-COT/);
    // Separate channels: the summary must not bleed into the answer stream.
    assert.doesNotMatch(messageText, /Weighing two designs/);
    assert.doesNotMatch(reasoningText, /token bucket/);

    const stop = events.find((event) => event.type === "message.stop");
    assert.ok(stop?.type === "message.stop");
    assert.equal(messageText, stop.text, "narration deltas reassemble to the final answer");
    assert.doesNotMatch(stop.text, /Weighing two designs/, "the final answer excludes reasoning");
    assert.equal(reasoning[0]!.runId, message[0]!.runId, "both channels share one stream run id");
  } finally {
    core.close();
    if (previousCommand === undefined) delete process.env.MUSTER_CODEX_COMMAND;
    else process.env.MUSTER_CODEX_COMMAND = previousCommand;
  }
});

test("stdio transport carries delta variants unchanged", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-rpc-delta-stdio-"));
  const narration = fencedNarration();
  const llm = await startStubLlm(narration);
  const core = createRpcCore({ config: stubConfig(llm.url), cwd });
  try {
    const input = new PassThrough();
    const output = new PassThrough();
    const detach = attachStdioTransport(core, input, output);
    let received = "";
    output.on("data", (chunk) => { received += chunk.toString(); });

    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.create" })}\n`);
    const deadline = Date.now() + 5_000;
    // The session.created EVENT also mentions sessionId, so wait for the response id too.
    while (!(received.includes("sessionId") && received.includes('"id":1')) && Date.now() < deadline) await delay(20);
    const sessionId = (JSON.parse(received.split("\n").find((line) => line.includes("sessionId") && line.includes("result"))!) as { result: { sessionId: string } }).result.sessionId;

    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "prompt.submit", params: { sessionId, prompt: "plan the mission" } })}\n`);
    while (!received.includes('"type":"ledger.tick"') && Date.now() < deadline) await delay(20);

    const frames = received.trim().split("\n").map((line) => JSON.parse(line) as { method?: string; params?: RpcEvent });
    const deltas = frames
      .filter((frame) => frame.method === "event" && frame.params?.type === "message.delta")
      .map((frame) => frame.params as DeltaEvent);
    assert.ok(deltas.length > 1, "delta frames survive NDJSON framing");
    // Unchanged over the wire: same shape, same order, same reassembly.
    assert.equal(deltas.map((delta) => delta.text).join(""), narration);
    for (const delta of deltas) {
      assert.deepEqual(Object.keys(delta).sort(), ["runId", "seq", "sessionId", "text", "type"]);
      assert.equal(delta.sessionId, sessionId);
    }
    detach();
  } finally {
    core.close();
    llm.close();
  }
});
