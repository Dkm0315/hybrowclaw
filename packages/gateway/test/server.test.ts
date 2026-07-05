import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfig, loadSessionHandle, promoteSkill, runFlow, saveSessionHandle, writeCandidateSkill } from "@musterhq/core";
import type { EvolveReport, MusterConfig } from "@musterhq/core";
import { approvePairing, initGatewayConfig, pollTelegram, startGatewayServer } from "../src/index.js";
import type { GatewayConfig, PairingChallenge, SurfaceReply } from "../src/index.js";

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

function report(): EvolveReport {
  return {
    startedAt: new Date().toISOString(),
    iterations: [{ iteration: 1, passed: 1, failed: 0, results: [{ taskId: "smoke", status: "passed", durationMs: 1 }] }],
    harnessChecks: [],
    converged: true,
  };
}

async function startTestGateway(cwd: string, llmUrl: string): Promise<{ url: string; gateway: GatewayConfig; close: () => Promise<void> }> {
  const init = await initGatewayConfig(cwd);
  const running = await startGatewayServer({ config: stubConfig(llmUrl), gateway: init.config, cwd }, 0);
  return { url: `http://127.0.0.1:${running.port}`, gateway: init.config, close: running.close };
}

test("gateway health endpoint answers without auth", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-health-"));
  const llm = await startStubServer(() => ({ status: 200, payload: { choices: [{ message: { content: "ok" } }] } }));
  const gw = await startTestGateway(cwd, llm.url);
  try {
    const response = await fetch(`${gw.url}/v1/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, service: "muster-gateway" });
  } finally {
    await gw.close();
    llm.close();
  }
});

test("gateway init stores secrets with private file permissions", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-perms-"));
  const init = await initGatewayConfig(cwd);

  assert.equal((await stat(join(cwd, ".muster"))).mode & 0o777, 0o700);
  assert.equal((await stat(init.path)).mode & 0o777, 0o600);
});

test("POST /v1/messages requires the gateway bearer token", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-auth-"));
  const llm = await startStubServer(() => ({ status: 200, payload: { choices: [{ message: { content: "ok" } }] } }));
  const gw = await startTestGateway(cwd, llm.url);
  try {
    const response = await fetch(`${gw.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong-token" },
      body: JSON.stringify({ surfaceId: "web:demo", conversationId: "c1", senderId: "s1", text: "hi" }),
    });
    assert.equal(response.status, 401);
  } finally {
    await gw.close();
    llm.close();
  }
});

test("invalid envelopes are rejected with 400 and a reason", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-envelope-"));
  const llm = await startStubServer(() => ({ status: 200, payload: { choices: [{ message: { content: "ok" } }] } }));
  const gw = await startTestGateway(cwd, llm.url);
  try {
    const response = await fetch(`${gw.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${gw.gateway.token}` },
      body: JSON.stringify({ surfaceId: "web:demo", text: "missing conversation and sender" }),
    });
    assert.equal(response.status, 400);
    const payload = await response.json() as { error: string };
    assert.match(payload.error, /conversationId/);
  } finally {
    await gw.close();
    llm.close();
  }
});

test("WhatsApp POST webhooks require and verify Meta app-secret signatures", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-whatsapp-sig-"));
  const llm = await startStubServer(() => ({ status: 200, payload: { choices: [{ message: { content: "ok" } }] } }));
  const init = await initGatewayConfig(cwd);
  const gateway: GatewayConfig = {
    ...init.config,
    whatsapp: {
      accessToken: "ACCESS",
      verifyToken: "VERIFY",
      phoneNumberId: "PHONE",
      appSecret: "APP_SECRET",
    },
  };
  const fetcher = (async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) as Response) as typeof fetch;
  const running = await startGatewayServer({ config: stubConfig(llm.url), gateway, cwd, fetcher }, 0);
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "PHONE" }, messages: [{ from: "919999999999", id: "m1", type: "text", text: { body: "hi" } }] } }] }],
  });
  try {
    const unsigned = await fetch(`http://127.0.0.1:${running.port}/v1/adapters/whatsapp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.equal(unsigned.status, 401);

    const signature = `sha256=${createHmac("sha256", gateway.whatsapp!.appSecret!).update(body).digest("hex")}`;
    const signed = await fetch(`http://127.0.0.1:${running.port}/v1/adapters/whatsapp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": signature },
      body,
    });
    assert.equal(signed.status, 200);
  } finally {
    await running.close();
    llm.close();
  }
});

test("unpaired sender gets pairing_required; after approval the message runs governed", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-pairing-"));
  const llm = await startStubServer(() => ({ status: 200, payload: { choices: [{ message: { content: "governed answer" } }] } }));
  const gw = await startTestGateway(cwd, llm.url);
  const send = async () => fetch(`${gw.url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${gw.gateway.token}` },
    body: JSON.stringify({ surfaceId: "web:demo", conversationId: "c1", senderId: "visitor-1", text: "hello muster" }),
  });
  try {
    const challengeResponse = await send();
    assert.equal(challengeResponse.status, 200);
    const challenge = await challengeResponse.json() as PairingChallenge;
    assert.equal(challenge.status, "pairing_required");
    assert.match(challenge.code, /^[A-Z2-9]{8}$/);

    await approvePairing(challenge.code, cwd);

    const replyResponse = await send();
    assert.equal(replyResponse.status, 200);
    const reply = await replyResponse.json() as SurfaceReply;
    assert.equal(reply.text, "governed answer");
  } finally {
    await gw.close();
    llm.close();
  }
});

test("POST /v1/flows/:runId/approve resumes a gated flow run", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-flow-"));
  const llm = await startStubServer(() => ({ status: 200, payload: { choices: [{ message: { content: "ok" } }] } }));
  const config = stubConfig(llm.url);
  const registry = { echo: async (args: Record<string, unknown>) => args };
  const pending = await runFlow({
    id: "gated",
    steps: [
      { id: "draft", kind: "tool", tool: "echo", args: { text: "ship it?" } },
      { id: "gate", kind: "gate", show: "draft.text" },
      { id: "after", kind: "tool", tool: "echo", args: { done: true } },
    ],
  }, { config, registry, cwd });
  assert.equal(pending.status, "awaiting_approval");

  const init = await initGatewayConfig(cwd);
  const running = await startGatewayServer({ config, gateway: init.config, cwd, registry }, 0);
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}/v1/flows/${pending.runId}/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${init.config.token}` },
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as { status: string; runId: string };
    assert.equal(payload.runId, pending.runId);
    assert.equal(payload.status, "completed");
  } finally {
    await running.close();
    llm.close();
  }
});

test("pollTelegram clears the webhook, polls getUpdates, and replies via sendMessage", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-poll-"));
  const calls = { deleteWebhook: 0, getUpdates: 0, sendMessage: [] as string[] };
  let getUpdatesCall = 0;
  const fetcher = (async (url: string | URL, init?: { body?: string }) => {
    const u = String(url);
    if (u.includes("/deleteWebhook")) { calls.deleteWebhook += 1; return { ok: true, json: async () => ({}) } as Response; }
    if (u.includes("/getUpdates")) {
      calls.getUpdates += 1;
      getUpdatesCall += 1;
      const result = getUpdatesCall === 1
        ? [{ update_id: 10, message: { message_id: 1, text: "hello", chat: { id: 555, type: "private" }, from: { id: 777 } } }]
        : [];
      return { ok: true, json: async () => ({ ok: true, result }) } as Response;
    }
    if (u.includes("/sendMessage")) { calls.sendMessage.push(String(init?.body ?? "")); return { ok: true, json: async () => ({}) } as Response; }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  }) as typeof fetch;

  const gateway: GatewayConfig = { token: "t", telegram: { botToken: "BOT" } };
  await pollTelegram({ config: defaultConfig(), gateway, cwd, fetcher, log: () => {}, maxIterations: 1 });

  assert.equal(calls.deleteWebhook, 1, "clears any webhook before long-polling");
  assert.ok(calls.getUpdates >= 1, "polls getUpdates");
  assert.equal(calls.sendMessage.length, 1, "replies to the single update");
  // The unpaired sender gets a pairing challenge delivered to their chat (555).
  assert.match(calls.sendMessage[0], /555/);
});

test("a paired sender's /help is answered by the gateway dispatcher, never the model", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-cmd-"));
  const llm = await startStubServer(() => ({ status: 200, payload: { choices: [{ message: { content: "MODEL_WAS_CALLED" } }] } }));
  const gw = await startTestGateway(cwd, llm.url);
  const send = (text: string) => fetch(`${gw.url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${gw.gateway.token}` },
    body: JSON.stringify({ surfaceId: "web:demo", conversationId: "c1", senderId: "visitor-1", text }),
  });
  try {
    const challenge = await (await send("hi")).json() as PairingChallenge;
    await approvePairing(challenge.code, cwd);
    const reply = await (await send("/help")).json() as SurfaceReply;
    assert.match(reply.text, /\/start/, "builtin command list returned");
    assert.doesNotMatch(reply.text, /MODEL_WAS_CALLED/, "the model must NOT be invoked for a builtin command");
  } finally {
    await gw.close();
    llm.close();
  }
});

test("a paired sender's /new clears provider session handles without invoking the model", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-new-"));
  await saveSessionHandle({
    conversationKey: "web:demo:c1",
    backendId: "codex",
    handle: "thread-abc",
    cwd: "/ws/demo",
    model: "gpt-5.5",
    updatedAt: "2026-06-20T00:00:00Z",
  }, cwd);
  await saveSessionHandle({
    conversationKey: "web:demo:c1",
    backendId: "claude",
    handle: "sess-abc",
    cwd: "/ws/demo",
    model: "sonnet",
    updatedAt: "2026-06-20T00:00:00Z",
  }, cwd);
  let modelCalls = 0;
  const llm = await startStubServer(() => {
    modelCalls += 1;
    return { status: 200, payload: { choices: [{ message: { content: "MODEL_WAS_CALLED" } }] } };
  });
  const gw = await startTestGateway(cwd, llm.url);
  const send = (text: string) => fetch(`${gw.url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${gw.gateway.token}` },
    body: JSON.stringify({ surfaceId: "web:demo", conversationId: "c1", senderId: "visitor-1", text }),
  });
  try {
    const challenge = await (await send("hi")).json() as PairingChallenge;
    await approvePairing(challenge.code, cwd);
    const reply = await (await send("/new")).json() as SurfaceReply;
    assert.equal(modelCalls, 0);
    assert.match(reply.text, /fresh muster thread/i);
    assert.equal(await loadSessionHandle("web:demo:c1", "codex", cwd), undefined);
    assert.equal(await loadSessionHandle("web:demo:c1", "claude", cwd), undefined);
  } finally {
    await gw.close();
    llm.close();
  }
});

test("a paired sender's custom command rewrites the model prompt before native passthrough", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-custom-cmd-"));
  let lastBody = "";
  const llm = await startStubServer((body) => {
    lastBody = body;
    return { status: 200, payload: { choices: [{ message: { content: "custom answer" } }] } };
  });
  const init = await initGatewayConfig(cwd);
  const gateway: GatewayConfig = {
    ...init.config,
    commands: {
      entries: {
        deploy: {
          description: "Deploy selected site",
          prompt: "Deploy using standard operating procedure. Args: {args}",
          surfaces: ["web"],
        },
      },
    },
  };
  const running = await startGatewayServer({ config: stubConfig(llm.url), gateway, cwd }, 0);
  const url = `http://127.0.0.1:${running.port}`;
  const send = (text: string) => fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${gateway.token}` },
    body: JSON.stringify({ surfaceId: "web:demo", conversationId: "c1", senderId: "visitor-1", text }),
  });
  try {
    const challenge = await (await send("hi")).json() as PairingChallenge;
    await approvePairing(challenge.code, cwd);
    const reply = await (await send("/deploy site-a")).json() as SurfaceReply;
    assert.equal(reply.text, "custom answer");
    const request = JSON.parse(lastBody) as { messages: Array<{ role: string; content: string }> };
    const userPrompt = request.messages.find((message) => message.role === "user")?.content ?? "";
    assert.match(userPrompt, /Run custom surface command "\/deploy"/);
    assert.match(userPrompt, /Deploy selected site/);
    assert.match(userPrompt, /Deploy using standard operating procedure\. Args: site-a/);
  } finally {
    await running.close();
    llm.close();
  }
});

test("a paired sender's tool-dispatch skill command runs the tool without invoking the model", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-skill-tool-"));
  await writeCandidateSkill({
    name: "make-record",
    description: "Create a record",
    body: "Use the configured creation tool.",
    frontmatter: {
      userInvocable: true,
      disableModelInvocation: true,
      commandDispatch: "tool",
      commandTool: "skill.echo",
      commandArgMode: "raw",
    },
  }, cwd);
  await promoteSkill("make-record", report(), cwd);
  let modelCalls = 0;
  const llm = await startStubServer(() => {
    modelCalls += 1;
    return { status: 200, payload: { choices: [{ message: { content: "MODEL_WAS_CALLED" } }] } };
  });
  const init = await initGatewayConfig(cwd);
  const registry = {
    "skill.echo": async (args: Record<string, unknown>) => ({ ok: true, args }),
  };
  const running = await startGatewayServer({ config: stubConfig(llm.url), gateway: init.config, cwd, registry }, 0);
  const url = `http://127.0.0.1:${running.port}`;
  const send = (text: string) => fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${init.config.token}` },
    body: JSON.stringify({ surfaceId: "web:demo", conversationId: "c1", senderId: "visitor-1", text }),
  });
  try {
    const challenge = await (await send("hi")).json() as PairingChallenge;
    await approvePairing(challenge.code, cwd);
    const reply = await (await send("/make-record Task subject")).json() as SurfaceReply;
    assert.equal(modelCalls, 0);
    assert.match(reply.text, /"ok": true/);
    assert.match(reply.text, /"command": "Task subject"/);
    assert.match(reply.text, /"skillName": "make-record"/);
  } finally {
    await running.close();
    llm.close();
  }
});

test("a paired sender's prompt-dispatch skill command rewrites the model prompt", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-skill-prompt-"));
  await writeCandidateSkill({
    name: "deploy-frappe",
    description: "Deploy Frappe safely",
    body: "Backup first, migrate second.",
    frontmatter: { userInvocable: true },
  }, cwd);
  await promoteSkill("deploy-frappe", report(), cwd);
  let lastBody = "";
  const llm = await startStubServer((body) => {
    lastBody = body;
    return { status: 200, payload: { choices: [{ message: { content: "skill answer" } }] } };
  });
  const gw = await startTestGateway(cwd, llm.url);
  const send = (text: string) => fetch(`${gw.url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${gw.gateway.token}` },
    body: JSON.stringify({ surfaceId: "web:demo", conversationId: "c1", senderId: "visitor-1", text }),
  });
  try {
    const challenge = await (await send("hi")).json() as PairingChallenge;
    await approvePairing(challenge.code, cwd);
    const reply = await (await send("/deploy-frappe site-a")).json() as SurfaceReply;
    assert.equal(reply.text, "skill answer");
    assert.match(lastBody, /Run user-invocable skill/);
    assert.match(lastBody, /Backup first, migrate second/);
    assert.match(lastBody, /site-a/);
  } finally {
    await gw.close();
    llm.close();
  }
});
