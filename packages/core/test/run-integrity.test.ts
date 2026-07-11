import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { test } from "node:test";
import {
  addMemory,
  buildRecalledBlock,
  defaultConfig,
  episodesPath,
  executeRun,
  listEpisodes,
  listGoalLoopTurns,
  listTokenRecords,
  loadSessionHandle,
  promotedMemoryWrite,
  promoteSkill,
  renderIntegrityReport,
  runHarnessChecks,
  searchMemory,
  tokensPath,
  verifyIntegrity,
  writeCandidateSkill,
  clearCodexAppServerSessions,
} from "../src/index.js";
import type { EvolveReport, MusterConfig } from "../src/index.js";

function report(converged: boolean, tasks = 1): EvolveReport {
  return {
    startedAt: new Date().toISOString(),
    iterations: [{ iteration: 1, passed: converged ? tasks : 0, failed: converged ? 0 : tasks, results: Array.from({ length: tasks }, (_, index) => ({ taskId: `t${index}`, status: converged ? "passed" as const : "failed" as const, durationMs: 1 })) }],
    harnessChecks: [],
    converged,
  };
}

function stubConfig(baseUrl: string): MusterConfig {
  const config = defaultConfig();
  return {
    ...config,
    providers: {
      ...config.providers,
      stub: { id: "stub", kind: "openai-compatible", baseUrl, defaultModel: "stub-model", timeoutMs: 5000 },
    },
    runtimes: {
      native: { id: "native", enabled: true, provider: "stub", routes: {} },
    },
    routing: { ...config.routing, defaultRuntime: "native" },
  };
}

function startStubServer(handler: (body: string) => { status: number; payload: unknown }): Promise<{ url: string; close: () => void }> {
  return import("node:http").then(({ createServer }) => new Promise((resolvePromise) => {
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const result = handler(body);
        response.writeHead(result.status, { "content-type": "application/json" });
        response.end(JSON.stringify(result.payload));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolvePromise({ url: `http://127.0.0.1:${port}/v1`, close: () => server.close() });
    });
  }));
}

test("executeRun records the episode, token usage, and a session-scoped memory candidate", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-run-"));
  const server = await startStubServer(() => ({
    status: 200,
    payload: { choices: [{ message: { content: "stubbed answer about Muster" } }] },
  }));
  try {
    const outcome = await executeRun(stubConfig(server.url), { prompt: "what is muster?", cwd });
    assert.equal(outcome.episode.outcome?.kind, "completed");
    assert.equal(outcome.episode.responseText, "stubbed answer about Muster");

    const episodes = await listEpisodes(cwd);
    assert.equal(episodes.length, 1);

    const tokens = await listTokenRecords(cwd);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].runId, outcome.plan.runId);
    assert.equal(tokens[0].estimated, true);

    const runUser = process.env.USER || process.env.USERNAME || "local";
    const sessionMemory = await searchMemory({
      scopes: [{ kind: "session", id: outcome.plan.runId }, { kind: "user", id: runUser }],
    }, cwd);
    assert.equal(sessionMemory.length, 1, "completed runs write a session-scoped memory candidate");

    const otherSession = await searchMemory({
      scopes: [{ kind: "session", id: "some-other-run" }, { kind: "user", id: runUser }],
    }, cwd);
    assert.equal(otherSession.length, 0, "memory candidates never leak across sessions");
  } finally {
    server.close();
  }
});

test("executeRun answers trivial current-folder listing locally without provider latency", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-run-local-list-"));
  await mkdir(join(cwd, "apps"));
  await writeFile(join(cwd, "README.md"), "hello", "utf8");
  let providerCalls = 0;
  const server = await startStubServer(() => {
    providerCalls += 1;
    return {
      status: 200,
      payload: { choices: [{ message: { content: "provider should not answer this" } }] },
    };
  });
  try {
    const outcome = await executeRun(stubConfig(server.url), {
      prompt: "List the files and directories in the current folder. Keep it brief.",
      cwd,
      skipAgentRules: true,
    });

    assert.equal(providerCalls, 0);
    assert.equal(outcome.episode.providerId, "muster-local");
    assert.equal(outcome.episode.model, "workspace-read");
    assert.equal(outcome.timings?.providerMs, 0);
    assert.equal(outcome.timings?.recallMs, 0);
    assert.match(outcome.episode.responseText, /`README\.md`/);
    assert.match(outcome.episode.responseText, /`apps\/`/);
    assert.ok(outcome.episode.evidence.some((item) => item.label === "local_workspace_listing"));
    assert.ok(outcome.episode.evidence.some((item) => item.label === "memory_recall" && item.detail?.includes("skipped=local_fast_path")));

    const tokens = await listTokenRecords(cwd);
    assert.equal(tokens[0].provider, "muster-local");
    assert.equal(tokens[0].inputTokens, 0);
    assert.equal(tokens[0].outputTokens, 0);

    const goals = await listGoalLoopTurns(cwd);
    assert.equal(goals[0].memoryWrite.status, "skipped");
  } finally {
    server.close();
  }
});

test("executeRun does not fast-path folder prompts that ask for reasoning or search", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-run-local-list-guard-"));
  await writeFile(join(cwd, "README.md"), "hello", "utf8");
  let providerCalls = 0;
  const server = await startStubServer(() => {
    providerCalls += 1;
    return {
      status: 200,
      payload: { choices: [{ message: { content: "provider handled reasoning" } }] },
    };
  });
  try {
    const outcome = await executeRun(stubConfig(server.url), {
      prompt: "Search the current folder and explain which files matter.",
      cwd,
      skipAgentRules: true,
    });

    assert.equal(providerCalls, 1);
    assert.equal(outcome.episode.providerId, "stub");
    assert.equal(outcome.episode.responseText, "provider handled reasoning");
    assert.notEqual(outcome.timings?.providerMs, 0);
  } finally {
    server.close();
  }
});

test("executeRun does not fast-path targeted folders, file contents, or changed-file prompts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-run-local-list-guard-targets-"));
  await mkdir(join(cwd, "packages"));
  await writeFile(join(cwd, "package.json"), "{}", "utf8");
  let providerCalls = 0;
  const server = await startStubServer(() => {
    providerCalls += 1;
    return {
      status: 200,
      payload: { choices: [{ message: { content: "provider handled specific folder request" } }] },
    };
  });
  try {
    const prompts = [
      "List files in packages/core/src directory.",
      "Show the contents of package.json in this directory.",
      "Which files changed in this folder?",
    ];
    for (const prompt of prompts) {
      const outcome = await executeRun(stubConfig(server.url), { prompt, cwd, skipAgentRules: true });
      assert.equal(outcome.episode.providerId, "stub");
      assert.equal(outcome.episode.responseText, "provider handled specific folder request");
    }
    assert.equal(providerCalls, prompts.length);
  } finally {
    server.close();
  }
});

test("executeRun injects recalled scoped memory into the prompt", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-run-recall-"));
  let observedPrompt = "";
  let observedMessages: Array<{ role: string; content: string }> = [];
  const server = await startStubServer((body) => {
    observedMessages = JSON.parse(body).messages as Array<{ role: string; content: string }>;
    observedPrompt = observedMessages.map((message) => message.content).join("\n");
    return { status: 200, payload: { choices: [{ message: { content: "ok" } }] } };
  });
  try {
    await addMemory({
      summary: "The deployment target is uat-erp.pwhr.in.",
      provenance: ["test"],
      scopes: [{ kind: "user", id: "tester" }],
    }, cwd);
    await executeRun(stubConfig(server.url), {
      prompt: "what is the deployment target?",
      cwd,
      scopes: [{ kind: "user", id: "tester" }],
    });
    assert.match(observedPrompt, /Recalled context/);
    assert.match(observedPrompt, /uat-erp\.pwhr\.in/);
    assert.equal(observedMessages.at(-1)?.role, "user");
    assert.match(observedMessages.at(-1)?.content ?? "", /what is the deployment target\?/);
    assert.match(observedMessages.at(-1)?.content ?? "", /Recalled context/);
    assert.equal(observedMessages.some((message) => message.role === "system" && message.content.includes("Recalled context")), false);
    assert.equal(observedMessages.some((message) => message.role === "user" && message.content.includes("Operating discipline")), false);
  } finally {
    server.close();
  }
});

test("executeRun keeps simple provider prompts compact when no context is needed", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-run-compact-"));
  let observedMessages: Array<{ role: string; content: string }> = [];
  const server = await startStubServer((body) => {
    observedMessages = JSON.parse(body).messages as Array<{ role: string; content: string }>;
    return { status: 200, payload: { choices: [{ message: { content: "hi" } }] } };
  });
  try {
    await executeRun(stubConfig(server.url), { prompt: "hi", cwd });
    assert.deepEqual(observedMessages.map((message) => message.role), ["system", "user"]);
    assert.equal(observedMessages.at(-1)?.content, "hi");
    assert.equal(observedMessages[0].content.includes("Operating discipline"), false);
    assert.ok(observedMessages[0].content.length < 120);
  } finally {
    server.close();
  }
});

test("executeRun records exact Codex app-server token usage in the ledger", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-run-codex-app-server-tokens-"));
  const fake = join(cwd, "codex-fake.mjs");
  await writeFile(fake, `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const threadId = "thread-ledger";
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { userAgent: "fake" } });
  else if (msg.method === "initialized") {}
  else if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: threadId } } });
  else if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
    send({ method: "item/completed", params: { item: { type: "agentMessage", id: "m", text: "ledger ok" }, threadId, turnId: "turn-1" } });
    send({ method: "thread/tokenUsage/updated", params: { threadId, turnId: "turn-1", tokenUsage: { last: { inputTokens: 1234, cachedInputTokens: 321, outputTokens: 56 } } } });
    send({ method: "turn/completed", params: { threadId, turn: { id: "turn-1", status: "completed" } } });
  }
});
`, "utf8");
  await chmod(fake, 0o755);
  const previousCommand = process.env.MUSTER_CODEX_COMMAND;
  const previousTransport = process.env.MUSTER_CODEX_TRANSPORT;
  process.env.MUSTER_CODEX_COMMAND = fake;
  process.env.MUSTER_CODEX_TRANSPORT = "app-server";
  try {
    const outcome = await executeRun(defaultConfig(), {
      prompt: "token ledger exact usage",
      cwd,
      workspaceDir: cwd,
      runtime: "codex",
      conversationKey: "cli-chat:ledger",
      nativeSession: true,
      skipAgentRules: true,
      skipMemoryWrite: true,
    });
    assert.equal(outcome.episode.responseText, "ledger ok");
    const records = await listTokenRecords(cwd);
    assert.equal(records.length, 1);
    assert.equal(records[0].inputTokens, 1234);
    assert.equal(records[0].cachedInputTokens, 321);
    assert.equal(records[0].outputTokens, 56);
    assert.equal(records[0].estimated, false);
    const handle = await loadSessionHandle("cli-chat:ledger", "codex", cwd);
    assert.equal(handle?.handle, "thread-ledger");
    assert.match(handle?.contextHash ?? "", /^[a-f0-9]{64}$/);
  } finally {
    clearCodexAppServerSessions();
    if (previousCommand === undefined) delete process.env.MUSTER_CODEX_COMMAND;
    else process.env.MUSTER_CODEX_COMMAND = previousCommand;
    if (previousTransport === undefined) delete process.env.MUSTER_CODEX_TRANSPORT;
    else process.env.MUSTER_CODEX_TRANSPORT = previousTransport;
  }
});

test("executeRun flags replay waste on continued native Codex sessions", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-run-codex-waste-"));
  const fake = join(cwd, "codex-fake.mjs");
  await writeFile(fake, `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const threadId = "thread-waste";
let turn = 0;
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { userAgent: "fake" } });
  else if (msg.method === "initialized") {}
  else if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: threadId } } });
  else if (msg.method === "turn/start") {
    turn += 1;
    const id = "turn-" + turn;
    const inputTokens = turn === 1 ? 20 : 50000;
    send({ id: msg.id, result: { turn: { id, status: "inProgress" } } });
    send({ method: "item/completed", params: { item: { type: "agentMessage", id: "m-" + turn, text: "ok " + turn }, threadId, turnId: id } });
    send({ method: "thread/tokenUsage/updated", params: { threadId, turnId: id, tokenUsage: { last: { inputTokens, cachedInputTokens: turn === 1 ? 0 : 49000, outputTokens: 2 } } } });
    send({ method: "turn/completed", params: { threadId, turn: { id, status: "completed" } } });
  }
});
`, "utf8");
  await chmod(fake, 0o755);
  const previousCommand = process.env.MUSTER_CODEX_COMMAND;
  const previousTransport = process.env.MUSTER_CODEX_TRANSPORT;
  process.env.MUSTER_CODEX_COMMAND = fake;
  process.env.MUSTER_CODEX_TRANSPORT = "app-server";
  try {
    const base = {
      cwd,
      workspaceDir: cwd,
      runtime: "codex" as const,
      conversationKey: "cli-chat:waste",
      nativeSession: true,
      skipAgentRules: true,
      skipMemoryWrite: true,
    };
    const first = await executeRun(defaultConfig(), { ...base, prompt: "one" });
    const second = await executeRun(defaultConfig(), { ...base, prompt: "two" });

    assert.equal(first.episode.responseText, "ok 1");
    assert.equal(second.episode.responseText, "ok 2");
    const records = await listTokenRecords(cwd);
    assert.equal(records.length, 2);
    assert.equal(records[0].sessionMode, "create");
    assert.equal(records[0].wasteRatio, undefined);
    assert.equal(records[1].sessionMode, "continue");
    assert.equal(records[1].sessionId, "thread-waste");
    assert.ok((records[1].wasteRatio ?? 0) > 3);
  } finally {
    clearCodexAppServerSessions();
    if (previousCommand === undefined) delete process.env.MUSTER_CODEX_COMMAND;
    else process.env.MUSTER_CODEX_COMMAND = previousCommand;
    if (previousTransport === undefined) delete process.env.MUSTER_CODEX_TRANSPORT;
    else process.env.MUSTER_CODEX_TRANSPORT = previousTransport;
  }
});

test("executeRun re-opens the persisted Codex thread after warm cache eviction", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-run-codex-resume-"));
  const fake = join(cwd, "codex-fake.mjs");
  const resumeLog = join(cwd, "resume.log");
  await writeFile(fake, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
let threadId = "thread-persisted";
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { userAgent: "fake" } });
  else if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: threadId } } });
  else if (msg.method === "thread/resume") {
    appendFileSync(${JSON.stringify(resumeLog)}, JSON.stringify(msg.params) + "\\n");
    threadId = msg.params.threadId;
    send({ id: msg.id, result: { thread: { id: threadId } } });
  } else if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
    send({ method: "item/agentMessage/delta", params: { threadId, turnId: "turn-1", itemId: "m", delta: threadId } });
    send({ method: "item/completed", params: { item: { type: "agentMessage", id: "m", text: threadId }, threadId, turnId: "turn-1" } });
    send({ method: "turn/completed", params: { threadId, turn: { id: "turn-1", status: "completed" } } });
  }
});
`, "utf8");
  await chmod(fake, 0o755);
  const previousCommand = process.env.MUSTER_CODEX_COMMAND;
  process.env.MUSTER_CODEX_COMMAND = fake;
  try {
    const base = {
      cwd,
      workspaceDir: cwd,
      runtime: "codex" as const,
      conversationKey: "gateway:resume-test",
      nativeSession: true,
      nativeTransport: "warm" as const,
      skipRecall: true,
      skipSkillSelection: true,
      skipAgentRules: true,
      skipMemoryWrite: true,
    };
    const first = await executeRun(defaultConfig(), { ...base, prompt: "one" });
    clearCodexAppServerSessions();
    const second = await executeRun(defaultConfig(), { ...base, prompt: "two" });

    assert.equal(first.episode.responseText, "thread-persisted");
    assert.equal(second.episode.responseText, "thread-persisted");
    assert.equal(second.timings?.providerTransport, "warm");
    assert.equal(second.timings?.providerCacheState, "miss");
    assert.equal(second.timings?.providerThreadOpenState, "resumed");
    assert.equal(typeof second.timings?.providerRequestToFirstDeltaMs, "number");
    const resume = JSON.parse((await readFile(resumeLog, "utf8")).trim()) as Record<string, unknown>;
    assert.equal(resume.threadId, "thread-persisted");
    assert.equal(resume.cwd, cwd);
    assert.equal(resume.excludeTurns, true);
  } finally {
    clearCodexAppServerSessions();
    if (previousCommand === undefined) delete process.env.MUSTER_CODEX_COMMAND;
    else process.env.MUSTER_CODEX_COMMAND = previousCommand;
  }
});

test("executeRun keeps warm native Codex session when only recalled memory changes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-run-codex-stable-context-"));
  await addMemory({
    summary: "alpha project detail belongs to the first turn",
    provenance: ["test:alpha"],
    scopes: [{ kind: "user", id: "tester" }],
    confidence: 0.9,
  }, cwd);
  await addMemory({
    summary: "beta project detail belongs to the second turn",
    provenance: ["test:beta"],
    scopes: [{ kind: "user", id: "tester" }],
    confidence: 0.9,
  }, cwd);
  const fake = join(cwd, "codex-fake.mjs");
  await writeFile(fake, `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const threadId = "thread-stable-context";
let turn = 0;
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { userAgent: "fake" } });
  else if (msg.method === "initialized") {}
  else if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: threadId } } });
  else if (msg.method === "turn/start") {
    turn += 1;
    const id = "turn-" + turn;
    send({ id: msg.id, result: { turn: { id, status: "inProgress" } } });
    send({ method: "item/completed", params: { item: { type: "agentMessage", id: "m-" + turn, text: "ok " + turn }, threadId, turnId: id } });
    send({ method: "thread/tokenUsage/updated", params: { threadId, turnId: id, tokenUsage: { last: { inputTokens: 20, cachedInputTokens: 0, outputTokens: 2 } } } });
    send({ method: "turn/completed", params: { threadId, turn: { id, status: "completed" } } });
  }
});
`, "utf8");
  await chmod(fake, 0o755);
  const previousCommand = process.env.MUSTER_CODEX_COMMAND;
  const previousTransport = process.env.MUSTER_CODEX_TRANSPORT;
  process.env.MUSTER_CODEX_COMMAND = fake;
  process.env.MUSTER_CODEX_TRANSPORT = "app-server";
  try {
    const base = {
      cwd,
      workspaceDir: cwd,
      runtime: "codex" as const,
      conversationKey: "cli-chat:stable-context",
      nativeSession: true,
      skipAgentRules: true,
      skipMemoryWrite: true,
      scopes: [{ kind: "user" as const, id: "tester" }],
    };
    const first = await executeRun(defaultConfig(), { ...base, prompt: "alpha" });
    const second = await executeRun(defaultConfig(), { ...base, prompt: "beta" });

    assert.equal(first.episode.responseText, "ok 1");
    assert.equal(second.episode.responseText, "ok 2");
    assert.ok(first.tokens.recalledChars > 0);
    assert.ok(second.tokens.recalledChars > 0);
    const handle = await loadSessionHandle("cli-chat:stable-context", "codex", cwd);
    assert.equal(handle?.handle, "thread-stable-context");
  } finally {
    clearCodexAppServerSessions();
    if (previousCommand === undefined) delete process.env.MUSTER_CODEX_COMMAND;
    else process.env.MUSTER_CODEX_COMMAND = previousCommand;
    if (previousTransport === undefined) delete process.env.MUSTER_CODEX_TRANSPORT;
    else process.env.MUSTER_CODEX_TRANSPORT = previousTransport;
  }
});

test("executeRun records goal-loop retrieval and memory write disposition", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-run-goal-loop-"));
  const recalled = await addMemory({
    summary: "Goal loop retrieval evidence should show matched terms.",
    provenance: ["goal-loop:seed"],
    scopes: [{ kind: "user", id: "tester" }],
  }, cwd);
  const server = await startStubServer(() => ({
    status: 200,
    payload: { choices: [{ message: { content: "The answer is recorded." } }] },
  }));
  try {
    const outcome = await executeRun(stubConfig(server.url), {
      prompt: "goal loop retrieval evidence",
      cwd,
      scopes: [{ kind: "user", id: "tester" }],
    });
    const turns = await listGoalLoopTurns(cwd);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].runId, outcome.plan.runId);
    assert.equal(turns[0].activeGoal, "goal loop retrieval evidence");
    assert.equal(turns[0].createdAt, outcome.episode.createdAt);
    assert.equal(turns[0].status, "completed");
    assert.equal(turns[0].memoryWrite.status, "remembered");
    assert.equal(turns[0].retrieval.backend, "sqlite-fts5");
    assert.equal(turns[0].retrieval.receipts[0]?.memoryId, recalled.id);
    assert.ok(turns[0].retrieval.receipts[0]?.matchedTerms.includes("goal"));
    assert.deepEqual(turns[0].retrieval.receipts[0]?.provenance, ["goal-loop:seed"]);
    assert.equal(turns[0].followUpRetrieval.needed, false);
  } finally {
    server.close();
  }
});

test("executeRun records rejected memory write and follow-up need on failed run", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-run-goal-loop-fail-"));
  const server = await startStubServer(() => ({
    status: 500,
    payload: { error: { message: "provider down" } },
  }));
  try {
    const outcome = await executeRun(stubConfig(server.url), {
      prompt: "missing recall should be followed up",
      cwd,
      scopes: [{ kind: "user", id: "tester" }],
    });
    const turns = await listGoalLoopTurns(cwd);

    assert.equal(outcome.episode.outcome.kind, "failed");
    assert.equal(turns.length, 1);
    assert.equal(turns[0].status, "failed");
    assert.deepEqual(turns[0].memoryWrite, { status: "rejected", reason: "run did not complete; no memory auto-promotion" });
    assert.equal(turns[0].followUpRetrieval.needed, true);
    assert.equal(turns[0].followUpRetrieval.reason, "no_scoped_memory_recalled");
    assert.equal(turns[0].followUpRetrieval.query, "missing recall should be followed up");
  } finally {
    server.close();
  }
});

test("promotedMemoryWrite records source and target memory ids", async () => {
  const memory = await addMemory({
    summary: "Tenant-level deployment preference.",
    provenance: ["goal-loop:test"],
    scopes: [{ kind: "tenant", id: "hybrow" }],
  }, await mkdtemp(join(tmpdir(), "muster-goal-promoted-")));

  const write = promotedMemoryWrite(memory, "mem_source");

  assert.equal(write.status, "promoted");
  assert.equal(write.memoryId, memory.id);
  assert.equal(write.sourceMemoryId, "mem_source");
  assert.deepEqual(write.scope, ["tenant:hybrow"]);
});

test("executeRun applies selected skill env only during the provider attempt", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-run-skill-env-"));
  const envName = "MUSTER_SKILL_ENV_RUN_TEST";
  const previous = process.env[envName];
  delete process.env[envName];

  await writeCandidateSkill({
    name: "envprobe",
    description: "Envprobe provider attempt helper",
    body: "Use the configured host env.",
  }, cwd);
  await promoteSkill("envprobe", report(true), cwd);

  let observedDuringAttempt: string | undefined;
  const server = await startStubServer(() => {
    observedDuringAttempt = process.env[envName];
    return { status: 200, payload: { choices: [{ message: { content: "ok" } }] } };
  });
  try {
    const config: MusterConfig = {
      ...stubConfig(server.url),
      skills: { entries: { envprobe: { env: { [envName]: "scoped-secret" } } } },
    };
    await executeRun(config, {
      prompt: "please use envprobe for this provider attempt",
      cwd,
      skipMemoryWrite: true,
      skipAgentRules: true,
    });

    assert.equal(observedDuringAttempt, "scoped-secret");
    assert.equal(process.env[envName], undefined, "skill env must be restored after the run");
  } finally {
    server.close();
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
  }
});

test("governed fallback is recorded as evidence and never silent", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-run-fallback-"));
  let calls = 0;
  const server = await startStubServer(() => {
    calls += 1;
    if (calls === 1) return { status: 500, payload: { error: "primary down" } };
    return { status: 200, payload: { choices: [{ message: { content: "fallback answer" } }] } };
  });
  try {
    const config = stubConfig(server.url);
    const withFallback: MusterConfig = {
      ...config,
      routing: { ...config.routing, fallbacks: [{ provider: "stub", model: "fallback-model" }] },
    };
    const outcome = await executeRun(withFallback, { prompt: "hello", cwd });
    assert.equal(outcome.fallbackUsed, "stub/fallback-model");
    assert.equal(outcome.episode.model, "fallback-model");
    const fallbackEvidence = outcome.episode.evidence.find((item) => item.label === "model_fallback");
    assert.ok(fallbackEvidence, "fallback must be recorded as evidence");
    assert.match(fallbackEvidence!.detail ?? "", /primary route/i);

    const integrity = await verifyIntegrity(cwd);
    assert.equal(integrity.ok, true, "recorded fallback is not silent drift");
  } finally {
    server.close();
  }
});

test("verifyIntegrity detects corrupt lines, duplicate run ids, and silent model drift", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-integrity-"));
  const episodes = episodesPath(cwd);
  await mkdir(dirname(episodes), { recursive: true });
  const baseEpisode = {
    id: "run_dup",
    createdAt: new Date().toISOString(),
    cwd,
    prompt: "p",
    taskKind: "simple_qa",
    runtimeId: "native",
    providerId: "stub",
    model: "actual-model",
    responseText: "r",
    evidence: [],
    outcome: { kind: "completed" },
  };
  await writeFile(episodes, `${JSON.stringify(baseEpisode)}\n${JSON.stringify(baseEpisode)}\nnot-json\n`);
  await appendFile(tokensPath(cwd), `${JSON.stringify({ runId: "run_dup", plannedModel: "planned-model", model: "actual-model" })}\n`);

  const report = await verifyIntegrity(cwd);
  assert.equal(report.ok, false);
  const kinds = report.issues.map((issue) => issue.kind);
  assert.ok(kinds.includes("corrupt_line"));
  assert.ok(kinds.includes("duplicate_run_id"));
  assert.ok(kinds.includes("silent_model_drift"));
  assert.match(renderIntegrityReport(report), /ISSUES FOUND/);
});

test("harness self-checks pass on a clean workspace", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-selfcheck-"));
  const checks = await runHarnessChecks(cwd);
  assert.deepEqual(checks.map((check) => check.status), ["passed", "passed", "passed"]);
});

test("buildRecalledBlock formats memory deterministically and stays empty without memory", () => {
  assert.equal(buildRecalledBlock([]), "");
  const block = buildRecalledBlock([
    {
      id: "mem_1",
      kind: "fact",
      summary: "X is true",
      observedAt: new Date().toISOString(),
      confidence: 0.9,
      provenance: ["test"],
      scopes: [{ kind: "user", id: "u" }],
      redactionState: "none",
    },
  ]);
  assert.match(block, /Recalled context/);
  assert.match(block, /- \[fact\] X is true/);
});
