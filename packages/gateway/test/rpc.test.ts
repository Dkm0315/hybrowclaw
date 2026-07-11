import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { defaultConfig } from "@musterhq/core";
import type { MusterConfig } from "@musterhq/core";
import { RPC_CONTRACT_VERSION, attachStdioTransport, createRpcCore } from "../src/rpc.js";

function startStubLlm(): Promise<{ url: string; close(): void }> {
  return new Promise((resolve) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "rpc reply" } }] }));
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

test("contract handshake, session lifecycle, prompt round-trip with ledger.tick", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-rpc-"));
  const llm = await startStubLlm();
  try {
    const core = createRpcCore({ config: stubConfig(llm.url), cwd });
    const events: string[] = [];
    core.subscribe((event) => events.push(event.type));

    const version = await core.handle({ jsonrpc: "2.0", id: 1, method: "contract.version" });
    assert.deepEqual(version.result, { contract: RPC_CONTRACT_VERSION, name: "muster-gateway" });

    const created = await core.handle({ jsonrpc: "2.0", id: 2, method: "session.create" });
    const sessionId = (created.result as { sessionId: string }).sessionId;

    const reply = await core.handle({ jsonrpc: "2.0", id: 3, method: "prompt.submit", params: { sessionId, prompt: "hello" } });
    assert.equal((reply.result as { text: string }).text, "rpc reply");
    assert.deepEqual(events, ["session.created", "message.stop", "ledger.tick"]);

    const ledger = await core.handle({ jsonrpc: "2.0", id: 4, method: "ledger.recent" });
    assert.equal((ledger.result as { records: unknown[] }).records.length, 1);
  } finally {
    llm.close();
  }
});

test("RPC uses owned warm transports and isolates native threads by session", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-rpc-native-"));
  const fake = join(cwd, "codex-fake.mjs");
  const closeLog = join(cwd, "closed.log");
  await writeFile(fake, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const threadId = "thread-" + process.pid;
let turn = 0;
let closeRecorded = false;
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
function recordClose() {
  if (closeRecorded) return;
  closeRecorded = true;
  appendFileSync(${JSON.stringify(closeLog)}, process.pid + "\\n");
}
process.on("exit", recordClose);
process.on("SIGTERM", () => process.exit(0));
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { userAgent: "fake" } });
  else if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: threadId } } });
  else if (msg.method === "turn/start") {
    turn += 1;
    const turnId = "turn-" + turn;
    send({ id: msg.id, result: { turn: { id: turnId, status: "inProgress" } } });
    send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "m", delta: threadId } });
    send({ method: "item/completed", params: { item: { type: "agentMessage", id: "m", text: threadId }, threadId, turnId } });
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
  }
});
`, "utf8");
  await chmod(fake, 0o755);
  const previousCommand = process.env.MUSTER_CODEX_COMMAND;
  process.env.MUSTER_CODEX_COMMAND = fake;
  const core = createRpcCore({ config: defaultConfig(), cwd, nativeTransportOwner: "rpc:test-owner" });
  try {
    const create = async (id: number): Promise<string> => {
      const response = await core.handle({ jsonrpc: "2.0", id, method: "session.create" });
      return (response.result as { sessionId: string }).sessionId;
    };
    const submit = async (id: number, sessionId: string, prompt: string) => {
      const response = await core.handle({ jsonrpc: "2.0", id, method: "prompt.submit", params: { sessionId, prompt } });
      assert.equal(response.error, undefined);
      return response.result as { text: string; timings?: { providerTransport?: string; providerCacheState?: string } };
    };
    const sessionA = await create(1);
    const sessionB = await create(2);
    const firstA = await submit(3, sessionA, "alpha request");
    const secondA = await submit(4, sessionA, "continue alpha");
    const firstB = await submit(5, sessionB, "beta request");

    assert.equal(firstA.text, secondA.text, "one RPC session keeps its native thread");
    assert.notEqual(firstA.text, firstB.text, "separate RPC sessions use isolated native threads");
    assert.equal(firstA.timings?.providerTransport, "warm");
    assert.equal(firstA.timings?.providerCacheState, "miss");
    assert.equal(secondA.timings?.providerCacheState, "hit");
    assert.equal(firstB.timings?.providerCacheState, "miss");

    core.close();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const closed = await readFile(closeLog, "utf8").catch(() => "");
      if (closed.trim().split("\n").filter(Boolean).length === 2) break;
      await delay(25);
    }
    const closedPids = (await readFile(closeLog, "utf8")).trim().split("\n");
    assert.equal(new Set(closedPids).size, 2, "RPC shutdown closes every process owned by that host");
  } finally {
    core.close();
    if (previousCommand === undefined) delete process.env.MUSTER_CODEX_COMMAND;
    else process.env.MUSTER_CODEX_COMMAND = previousCommand;
  }
});

test("contract mismatch halts loudly; unknown methods and sessions error cleanly", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-rpc-err-"));
  const core = createRpcCore({ config: defaultConfig(), cwd });
  const mismatch = await core.handle({ jsonrpc: "2.0", id: 1, method: "session.create", params: { minContract: 99 } });
  assert.match(mismatch.error?.message ?? "", /Contract mismatch.*never silently downgrade/);
  const unknown = await core.handle({ jsonrpc: "2.0", id: 2, method: "nope" });
  assert.equal(unknown.error?.code, -32601);
  const badSession = await core.handle({ jsonrpc: "2.0", id: 3, method: "prompt.submit", params: { sessionId: "ghost", prompt: "x" } });
  assert.match(badSession.error?.message ?? "", /Unknown session/);
});

test("stream tickets are single-use and expire", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-rpc-ticket-"));
  const core = createRpcCore({ config: defaultConfig(), cwd });
  const { ticket } = core.mintTicket();
  assert.equal(core.consumeTicket(ticket), true);
  assert.equal(core.consumeTicket(ticket), false, "single-use");
  assert.equal(core.consumeTicket("tk_forged"), false);
});

test("stdio transport: NDJSON requests, responses, and pushed events on one pipe", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-rpc-stdio-"));
  const llm = await startStubLlm();
  try {
    const core = createRpcCore({ config: stubConfig(llm.url), cwd });
    const input = new PassThrough();
    const output = new PassThrough();
    const detach = attachStdioTransport(core, input, output);
    let received = "";
    output.on("data", (chunk) => { received += chunk.toString(); });

    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.create" })}\n`);
    await delay(50);
    const sessionId = (JSON.parse(received.split("\n").find((line) => line.includes("sessionId") && line.includes("result"))!) as { result: { sessionId: string } }).result.sessionId;

    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "prompt.submit", params: { sessionId, prompt: "hi" } })}\n`);
    await delay(300);
    input.write("not-json\n");
    await delay(50);

    const lines = received.trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(lines.some((line) => line.method === "event" && line.params?.type === "ledger.tick"), "events pushed on the same pipe");
    assert.ok(lines.some((line) => line.result?.text === "rpc reply"));
    assert.ok(lines.some((line) => line.error?.code === -32700), "parse errors answered, not fatal");
    detach();
  } finally {
    llm.close();
  }
});
