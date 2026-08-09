import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfig, executeRun, listCliBackends } from "../src/index.js";
import type { MusterConfig } from "../src/index.js";

test("provider-agnostic CLI backend registry lists each native runtime (add a provider = one entry)", () => {
  const backends = listCliBackends();
  assert.ok(backends.includes("codex"), "codex backend registered");
  assert.ok(backends.includes("claude-code"), "claude-code backend registered");
});

interface RecordedMessage { role: string; content: string }

/** OpenAI-compatible stub that records each turn's messages and replies "ASSISTANT_REPLY". */
function startStub(): Promise<{ url: string; turns: RecordedMessage[][]; close: () => Promise<void> }> {
  const turns: RecordedMessage[][] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body) as { messages: RecordedMessage[] };
          turns.push(parsed.messages);
        } catch { /* ignore */ }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "ASSISTANT_REPLY" } }] }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}/v1`, turns, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function nativeConfig(baseUrl: string): MusterConfig {
  const base = defaultConfig();
  return {
    ...base,
    providers: { ...base.providers, stub: { id: "stub", kind: "openai-compatible", baseUrl, defaultModel: "stub-model", timeoutMs: 5000 } },
    runtimes: { native: { id: "native", enabled: true, provider: "stub", routes: {} } },
    routing: { ...base.routing, defaultRuntime: "native" },
  };
}

test("provider-direct runs accumulate a budgeted multi-turn transcript across turns", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-multiturn-"));
  const stub = await startStub();
  const config = nativeConfig(stub.url);
  try {
    await executeRun(config, { prompt: "first question", cwd, conversationKey: "web:demo:c1", skipMemoryWrite: true, skipAgentRules: true });
    await executeRun(config, { prompt: "second question", cwd, conversationKey: "web:demo:c1", skipMemoryWrite: true, skipAgentRules: true });

    assert.equal(stub.turns.length, 2, "two model calls");
    // Turn 1 sends only the first user turn (no prior).
    assert.deepEqual(stub.turns[0].map((m) => m.content), ["first question"]);
    // Turn 2 carries the prior user + assistant turns, ending with the new user turn.
    const t2 = stub.turns[1].map((m) => m.content);
    assert.ok(t2.includes("first question"), "prior user turn replayed");
    assert.ok(t2.includes("ASSISTANT_REPLY"), "prior assistant turn replayed");
    assert.equal(t2.at(-1), "second question", "new user turn is last");
  } finally {
    await stub.close();
  }
});

test("grounded standalone turns shed stale history while explicit follow-ups retain continuity", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-multiturn-activation-"));
  const stub = await startStub();
  const config = nativeConfig(stub.url);
  const base = { cwd, conversationKey: "web:demo:activation", skipMemoryWrite: true, skipAgentRules: true } as const;
  const systemContext = "Trusted host context: the permission-filtered pending request count is 2.";
  try {
    await executeRun(config, { ...base, prompt: "Store this unrelated opening question for later." });
    const standalone = await executeRun(config, {
      ...base,
      prompt: "How many requests are pending for me?",
      systemContext,
    });
    const followUp = await executeRun(config, {
      ...base,
      prompt: "What about approved ones?",
      systemContext,
    });

    assert.deepEqual(stub.turns[1].map((message) => message.content), [systemContext, "How many requests are pending for me?"], "self-contained grounded QA omits unrelated transcript");
    assert.ok(stub.turns[2].some((message) => message.content === "How many requests are pending for me?"), "referential follow-up receives the prior user turn");
    assert.ok(stub.turns[2].some((message) => message.content === "ASSISTANT_REPLY"), "referential follow-up receives prior assistant context");
    assert.match(standalone.episode.evidence.find((item) => item.label === "context_activation")?.detail ?? "", /mode=lean .*history=fresh/);
    assert.match(followUp.episode.evidence.find((item) => item.label === "context_activation")?.detail ?? "", /mode=lean .*history=continuity/);
  } finally {
    await stub.close();
  }
});

test("a DIFFERENT conversation does not see another conversation's turns (isolation)", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-multiturn-iso-"));
  const stub = await startStub();
  const config = nativeConfig(stub.url);
  try {
    await executeRun(config, { prompt: "alice secret", cwd, conversationKey: "web:demo:alice", skipMemoryWrite: true, skipAgentRules: true });
    await executeRun(config, { prompt: "bob question", cwd, conversationKey: "web:demo:bob", skipMemoryWrite: true, skipAgentRules: true });
    assert.deepEqual(stub.turns[1].map((m) => m.content), ["bob question"], "bob's turn carries no trace of alice");
  } finally {
    await stub.close();
  }
});

test("no conversationKey keeps the original single-message behavior", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-multiturn-single-"));
  const stub = await startStub();
  const config = nativeConfig(stub.url);
  try {
    await executeRun(config, { prompt: "one-shot", cwd, skipMemoryWrite: true, skipAgentRules: true });
    await executeRun(config, { prompt: "another one-shot", cwd, skipMemoryWrite: true, skipAgentRules: true });
    // Each is a fresh single user message — no accumulation without a conversationKey.
    assert.deepEqual(stub.turns[1].map((m) => m.content), ["another one-shot"]);
  } finally {
    await stub.close();
  }
});
