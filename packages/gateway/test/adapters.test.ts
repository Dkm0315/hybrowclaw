import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dataDir, defaultConfig, profileWorkspaceDir } from "@musterhq/core";
import type { MusterConfig } from "@musterhq/core";
import { createHash, createHmac } from "node:crypto";
import {
  approvePairing,
  createGatewayIngressFingerprint,
  DurableGatewayIngress,
  DurableGatewayIngressSpool,
  gatewayConfigPath,
  loadGatewayConfig,
  openSqliteGatewayEnterpriseRuntime,
  pollSlackSocket,
  pollTelegram,
  requestPairing,
  resetAdapterAuthWarnings,
  slackEventToSurfaceMessage,
  slackSignatureIsValid,
  SLACK_REPLAY_WINDOW_SECONDS,
  startGatewayServer,
  surfaceReplyToSlackPost,
  surfaceReplyToTelegramSend,
  telegramUpdateToSurfaceMessage,
  TELEGRAM_SURFACE_ID,
} from "../src/index.js";

/** Build the X-Slack-Signature value Slack would send for a given body/timestamp/secret. */
function slackSignature(timestamp: string, rawBody: string, secret: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`, "utf8").digest("hex")}`;
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

async function channelArtifactManifest(cwd: string): Promise<{ artifacts: Array<{ delivery: { state: string; channel?: string; providerMessageId?: string } }> }> {
  const root = join(cwd, ".muster", "data", "artifacts");
  const entries = await readdir(root, { recursive: true });
  const manifest = entries.find((entry) => entry.endsWith("manifest.json"));
  assert.ok(manifest, "channel artifact manifest should exist");
  return JSON.parse(await readFile(join(root, manifest), "utf8"));
}

// --- realistic fixtures (shape per Bot API / Events API docs) ---

const telegramUpdate = {
  update_id: 837366021,
  message: {
    message_id: 142,
    from: { id: 5599220011, is_bot: false, first_name: "Dhairya", username: "dhairya" },
    chat: { id: -1001234567890, title: "Muster Ops", type: "supergroup" },
    date: 1765432100,
    text: "what is the deploy status?",
    reply_to_message: { message_id: 141 },
  },
};

const slackEventCallback = {
  token: "XXYYZZ",
  team_id: "T024BE7LD",
  api_app_id: "A4H1JB4AZ",
  type: "event_callback",
  event_id: "Ev0PV52K21",
  event_time: 1765432100,
  event: {
    type: "message",
    channel: "C2147483705",
    user: "U2147483697",
    text: "muster: summarize the open tickets",
    ts: "1765432100.000259",
    thread_ts: "1765432000.000200",
  },
};

const slackUrlVerification = {
  token: "Jhj5dZrVaK7ZwHHjRyZWjbDl",
  challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P",
  type: "url_verification",
};

// --- Telegram mapper ---

test("telegram update maps to a SurfaceMessage with chat/sender/replyTo preserved", () => {
  const message = telegramUpdateToSurfaceMessage(telegramUpdate);
  assert.ok(message);
  assert.equal(message.surfaceId, TELEGRAM_SURFACE_ID);
  assert.equal(message.conversationId, "-1001234567890");
  assert.equal(message.senderId, "5599220011");
  assert.equal(message.text, "what is the deploy status?");
  assert.equal(message.replyTo, "141");
  assert.equal(message.raw, telegramUpdate);
});

test("telegram non-text updates map to undefined", () => {
  assert.equal(telegramUpdateToSurfaceMessage({ update_id: 1 }), undefined);
  assert.equal(telegramUpdateToSurfaceMessage({ update_id: 1, message: { chat: { id: 5 }, from: { id: 7 }, sticker: {} } }), undefined);
  assert.equal(telegramUpdateToSurfaceMessage("not json object"), undefined);
});

test("telegram reply maps to sendMessage; unbound approvals fail closed to text", () => {
  const plain = surfaceReplyToTelegramSend({ text: "deploy is green" }, "-100123");
  assert.deepEqual(plain, { chat_id: "-100123", text: "deploy is green" });

  const pairing = surfaceReplyToTelegramSend({ status: "pairing_required", code: "AB23CD45" }, "-100123");
  assert.match(pairing.text, /muster pairing approve AB23CD45/);
  assert.equal(pairing.reply_markup, undefined);

  const approval = surfaceReplyToTelegramSend({
    text: "drafted",
    approvalRequest: { runId: "flowrun_1a2b3c4d", gateId: "gate", show: "ship it?", options: ["approve", "reject"] },
  }, "-100123");
  assert.match(approval.text, /Approval required/);
  assert.match(approval.text, /Authenticated approval controls are unavailable/);
  assert.equal(approval.reply_markup, undefined);
});

// --- Slack mapper ---

test("slack url_verification challenge is recognized and echoed", () => {
  const inbound = slackEventToSurfaceMessage(slackUrlVerification);
  assert.equal(inbound.kind, "url_verification");
  assert.equal((inbound as { challenge: string }).challenge, slackUrlVerification.challenge);
});

test("slack event_callback message maps to a SurfaceMessage", () => {
  const inbound = slackEventToSurfaceMessage(slackEventCallback);
  assert.equal(inbound.kind, "message");
  const message = (inbound as { message: { surfaceId: string; conversationId: string; senderId: string; text: string; replyTo?: string } }).message;
  assert.equal(message.surfaceId, "slack:T024BE7LD");
  assert.equal(message.conversationId, "C2147483705");
  assert.equal(message.senderId, "U2147483697");
  assert.equal(message.text, "muster: summarize the open tickets");
  assert.equal(message.replyTo, "1765432000.000200");
});

test("slack bot echoes and unsupported events are ignored", () => {
  const botEcho = slackEventToSurfaceMessage({
    type: "event_callback",
    team_id: "T024BE7LD",
    event: { type: "message", bot_id: "B19", channel: "C1", user: "U1", text: "I am the bot" },
  });
  assert.equal(botEcho.kind, "ignored");
  const reaction = slackEventToSurfaceMessage({
    type: "event_callback",
    team_id: "T024BE7LD",
    event: { type: "reaction_added", user: "U1" },
  });
  assert.equal(reaction.kind, "ignored");
});

test("slack reply maps to chat.postMessage; unbound approvals fail closed to text", () => {
  const plain = surfaceReplyToSlackPost({ text: "3 open tickets" }, "C1", "1765432000.000200");
  assert.deepEqual(plain, { channel: "C1", thread_ts: "1765432000.000200", text: "3 open tickets" });

  const approval = surfaceReplyToSlackPost({
    text: "draft ready",
    approvalRequest: { runId: "flowrun_9z8y7x6w", gateId: "publish", show: { title: "Q2 report" }, options: ["approve", "reject"] },
  }, "C1");
  assert.ok(approval.blocks);
  const actions = approval.blocks!.find((block) => (block as { type: string }).type === "actions");
  assert.equal(actions, undefined);
  assert.match(approval.text, /Authenticated approval controls are unavailable/);

  const pairing = surfaceReplyToSlackPost({ status: "pairing_required", code: "QR45ST67" }, "C1");
  assert.match(pairing.text, /muster pairing approve QR45ST67/);
});

// --- webhook routes (injected fetcher, no live network) ---

function stubConfig(baseUrl: string): MusterConfig {
  const config = defaultConfig();
  return {
    ...config,
    providers: { stub: { id: "stub", kind: "openai-compatible", baseUrl, defaultModel: "stub-model", timeoutMs: 5000 } },
    runtimes: { native: { id: "native", enabled: true, provider: "stub", routes: {} } },
    routing: { ...config.routing, defaultRuntime: "native" },
  };
}

function startStubLlm(content: string, delayMs = 0): Promise<{ url: string; calls: () => number; close: () => void }> {
  return import("node:http").then(({ createServer }) => new Promise((resolvePromise) => {
    let calls = 0;
    const server = createServer((_request, response) => {
      calls += 1;
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { content } }] }));
      }, delayMs);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolvePromise({ url: `http://127.0.0.1:${port}/v1`, calls: () => calls, close: () => server.close() });
    });
  }));
}

function startFlakyStubLlm(): Promise<{ url: string; calls: () => number; close: () => void }> {
  return import("node:http").then(({ createServer }) => new Promise((resolvePromise) => {
    let calls = 0;
    const server = createServer((_request, response) => {
      calls += 1;
      response.writeHead(calls === 1 ? 500 : 200, { "content-type": "application/json" });
      response.end(calls === 1
        ? JSON.stringify({ error: { message: "temporary provider failure" } })
        : JSON.stringify({ choices: [{ message: { content: "retry completed" } }] }));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolvePromise({ url: `http://127.0.0.1:${port}/v1`, calls: () => calls, close: () => server.close() });
    });
  }));
}

test("telegram webhook: pairing challenge then governed reply, outbound via injected fetcher", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-telegram-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(cwd, ".muster"), { recursive: true });
  await writeFile(gatewayConfigPath(cwd), JSON.stringify({ token: "test-token", telegram: { botToken: "123:ABC" } }));
  const gateway = await loadGatewayConfig(cwd);

  const llm = await startStubLlm("deploy is green");
  const outbound: Array<{ url: string; body: unknown }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    outbound.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  const running = await startGatewayServer({ config: stubConfig(llm.url), gateway, cwd, fetcher }, 0);
  const post = async () => fetch(`http://127.0.0.1:${running.port}/v1/adapters/telegram`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify(telegramUpdate),
  });
  try {
    // first contact: pairing challenge goes back to the chat
    assert.equal((await post()).status, 200);
    await running.waitForIdle();
    assert.equal(outbound.length, 1);
    assert.match(outbound[0].url, /^https:\/\/api\.telegram\.org\/bot123:ABC\/sendMessage$/);
    const challengeBody = outbound[0].body as { chat_id: string; text: string };
    assert.equal(challengeBody.chat_id, "-1001234567890");
    const code = challengeBody.text.match(/approve ([A-Z2-9]{8})/)?.[1];
    assert.ok(code, "pairing code is included in the challenge text");

    await approvePairing(code!, cwd);

    // second contact: a new Telegram update from the now-paired sender runs governed.
    const governed = await fetch(`http://127.0.0.1:${running.port}/v1/adapters/telegram`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({ ...telegramUpdate, update_id: 837366022 }),
    });
    assert.equal(governed.status, 200);
    await running.waitForIdle();
    assert.equal(outbound.length, 2);
    assert.equal((outbound[1].body as { text: string }).text, "deploy is green");
  } finally {
    await running.close();
    llm.close();
  }
});

test("telegram webhook shows typing and delivers MEDIA artifacts as documents", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-telegram-artifact-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(cwd, ".muster"), { recursive: true });
  const workspaceDir = profileWorkspaceDir(cwd, "default");
  const artifactPath = join(workspaceDir, "artifacts", "features.pdf");
  await mkdir(join(workspaceDir, "artifacts"), { recursive: true });
  await writeFile(artifactPath, "%PDF-1.4\n% telegram artifact\n%%EOF\n");
  await writeFile(gatewayConfigPath(cwd), JSON.stringify({ token: "test-token", telegram: { botToken: "123:ABC", status: "typing", thinking: "progress" } }));
  const gateway = await loadGatewayConfig(cwd);
  await requestPairing(TELEGRAM_SURFACE_ID, "5599220011", cwd).then((pending) => approvePairing(pending.code, cwd));

  const llm = await startStubLlm("Here is the PDF.\nMEDIA:artifacts/features.pdf");
  const outbound: Array<{ method: string; body: unknown }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split("/").pop() ?? "";
    outbound.push({ method, body: init?.body instanceof FormData ? init.body : JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify(method === "sendDocument" ? { ok: true, result: { message_id: 991 } } : { ok: true }), { status: 200 });
  }) as typeof fetch;
  const running = await startGatewayServer({ config: stubConfig(llm.url), gateway, cwd, fetcher }, 0);
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}/v1/adapters/telegram`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({ ...telegramUpdate, update_id: 837366099, message: { ...telegramUpdate.message, text: "create and attach a PDF feature brief" } }),
    });
    assert.equal(response.status, 200);
    await running.waitForIdle();
    assert.ok(outbound.some((entry) => entry.method === "sendChatAction"), "typing presence is sent while the run is active");
    assert.ok(outbound.some((entry) => entry.method === "sendDocument"), "local MEDIA artifact is attached as a Telegram document");
    const textMessages = outbound.filter((entry) => entry.method === "sendMessage").map((entry) => (entry.body as { text?: string }).text ?? "");
    const progress = textMessages.find((text) => text.includes("Processing"));
    assert.ok(progress, "progress can be toggled on");
    assert.match(progress!, /Preparing artifact route/, "artifact requests show the artifact route");
    assert.doesNotMatch(progress!, /memory/i, "memory is not claimed unless the request asks for recall");
    assert.ok(textMessages.some((text) => text === "Here is the PDF."), "visible reply strips MEDIA tag");
    const manifest = await channelArtifactManifest(cwd);
    assert.equal(manifest.artifacts[0].delivery.state, "uploaded");
    assert.equal(manifest.artifacts[0].delivery.providerMessageId, "991");
  } finally {
    await running.close();
    llm.close();
  }
});

test("telegram artifact delivery rejects absolute paths and workspace symlink escapes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-telegram-artifact-containment-"));
  const { mkdir, symlink } = await import("node:fs/promises");
  await mkdir(join(cwd, ".muster"), { recursive: true });
  const workspaceDir = profileWorkspaceDir(cwd, "default");
  await mkdir(join(workspaceDir, "artifacts"), { recursive: true });
  const outside = join(cwd, "outside-secret.pdf");
  await writeFile(outside, "credential material that must never leave the host");
  await symlink(outside, join(workspaceDir, "artifacts", "escape.pdf"));
  await writeFile(gatewayConfigPath(cwd), JSON.stringify({ token: "test-token", telegram: { botToken: "123:ABC" } }));
  const gateway = await loadGatewayConfig(cwd);
  await requestPairing(TELEGRAM_SURFACE_ID, "5599220011", cwd).then((pending) => approvePairing(pending.code, cwd));
  const llm = await startStubLlm(`Created the files.\nMEDIA:${outside}\nMEDIA:artifacts/escape.pdf`);
  const outbound: Array<{ method: string; body: unknown }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    outbound.push({ method: String(url).split("/").pop() ?? "", body: init?.body instanceof FormData ? init.body : JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  const running = await startGatewayServer({ config: stubConfig(llm.url), gateway, cwd, fetcher }, 0);
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}/v1/adapters/telegram`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({ ...telegramUpdate, update_id: 837366100, message: { ...telegramUpdate.message, text: "attach the generated PDF" } }),
    });
    assert.equal(response.status, 200);
    await running.waitForIdle();
    assert.equal(outbound.some((entry) => entry.method === "sendDocument"), false);
    const serialized = JSON.stringify(outbound);
    assert.match(serialized, /Artifact delivery failed/);
    assert.doesNotMatch(serialized, /credential material|outside-secret\.pdf|artifacts\/escape\.pdf/);
  } finally {
    await running.close();
    llm.close();
  }
});

test("telegram webhook edits one progress message into the final reply", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-telegram-progress-final-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(cwd, ".muster"), { recursive: true });
  await writeFile(gatewayConfigPath(cwd), JSON.stringify({ token: "test-token", telegram: { botToken: "123:ABC", status: "typing", thinking: "progress" } }));
  const gateway = await loadGatewayConfig(cwd);
  await requestPairing(TELEGRAM_SURFACE_ID, "5599220011", cwd).then((pending) => approvePairing(pending.code, cwd));

  const llm = await startStubLlm("slow run complete");
  const outbound: Array<{ method: string; body: unknown }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split("/").pop() ?? "";
    outbound.push({ method, body: JSON.parse(String(init?.body ?? "{}")) });
    if (method === "sendMessage") return new Response(JSON.stringify({ ok: true, result: { message_id: 777 } }), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  const running = await startGatewayServer({ config: stubConfig(llm.url), gateway, cwd, fetcher }, 0);
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}/v1/adapters/telegram`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({ ...telegramUpdate, update_id: 837366111, message: { ...telegramUpdate.message, text: "long running status please" } }),
    });
    assert.equal(response.status, 200);
    await running.waitForIdle();
    const sentMessages = outbound.filter((entry) => entry.method === "sendMessage");
    assert.equal(sentMessages.length, 1, "Telegram uses one progress message instead of posting a second final message");
    assert.match((sentMessages[0].body as { text: string }).text, /Processing/);
    assert.ok(outbound.some((entry) => entry.method === "editMessageText" && (entry.body as { text?: string }).text === "slow run complete"), "final reply edits the progress message in place");
  } finally {
    await running.close();
    llm.close();
  }
});

test("telegram progress final edit failure falls back to a final send", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-telegram-progress-edit-fail-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(cwd, ".muster"), { recursive: true });
  await writeFile(gatewayConfigPath(cwd), JSON.stringify({ token: "test-token", telegram: { botToken: "123:ABC", thinking: "progress" } }));
  const gateway = await loadGatewayConfig(cwd);
  await requestPairing(TELEGRAM_SURFACE_ID, "5599220011", cwd).then((pending) => approvePairing(pending.code, cwd));

  const llm = await startStubLlm("final after edit failure");
  const outbound: Array<{ method: string; body: unknown }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split("/").pop() ?? "";
    outbound.push({ method, body: JSON.parse(String(init?.body ?? "{}")) });
    if (method === "sendMessage") return new Response(JSON.stringify({ ok: true, result: { message_id: 778 } }), { status: 200 });
    if (method === "editMessageText") return new Response(JSON.stringify({ ok: false, description: "message is not modified" }), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  const running = await startGatewayServer({ config: stubConfig(llm.url), gateway, cwd, fetcher }, 0);
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}/v1/adapters/telegram`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({ ...telegramUpdate, update_id: 837366114, message: { ...telegramUpdate.message, text: "long running edit failure" } }),
    });
    assert.equal(response.status, 200);
    await running.waitForIdle();
    const sentTexts = outbound.filter((entry) => entry.method === "sendMessage").map((entry) => (entry.body as { text?: string }).text ?? "");
    assert.equal(sentTexts.length, 2, "Telegram sends a fallback final message when progress edit fails");
    assert.match(sentTexts[0], /Processing/);
    assert.equal(sentTexts[1], "final after edit failure");
  } finally {
    await running.close();
    llm.close();
  }
});

test("telegram webhook replay of an unpaired update does not resend pairing instructions", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-telegram-unpaired-replay-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(cwd, ".muster"), { recursive: true });
  await writeFile(gatewayConfigPath(cwd), JSON.stringify({ token: "test-token", telegram: { botToken: "123:ABC" } }));
  const gateway = await loadGatewayConfig(cwd);
  const llm = await startStubLlm("should not run");
  const outbound: Array<{ method: string; body: unknown }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    outbound.push({ method: String(url).split("/").pop() ?? "", body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  const running = await startGatewayServer({ config: stubConfig(llm.url), gateway, cwd, fetcher }, 0);
  const post = () => fetch(`http://127.0.0.1:${running.port}/v1/adapters/telegram`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify({ ...telegramUpdate, update_id: 837366112 }),
  });
  try {
    assert.equal((await post()).status, 200);
    assert.equal((await post()).status, 200);
    await running.waitForIdle();
    assert.equal(outbound.length, 1, "Telegram update_id replay is idempotent even for pairing challenges");
    assert.match((outbound[0].body as { text: string }).text, /pairing approve/);
  } finally {
    await running.close();
    llm.close();
  }
});

test("telegram polling restart skips an already handled queued update", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-telegram-poll-restart-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(cwd, ".muster"), { recursive: true });
  const gateway = { token: "test-token", telegram: { botToken: "123:ABC" } };
  await requestPairing(TELEGRAM_SURFACE_ID, "5599220011", cwd).then((pending) => approvePairing(pending.code, cwd));
  const queuedUpdate = { ...telegramUpdate, update_id: 837366113, message: { ...telegramUpdate.message, text: "/help" } };
  const sends: string[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    if (target.includes("/deleteWebhook")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (target.includes("/getUpdates")) return new Response(JSON.stringify({ ok: true, result: [queuedUpdate] }), { status: 200 });
    if (target.includes("/sendMessage")) {
      sends.push((JSON.parse(String(init?.body ?? "{}")) as { text?: string }).text ?? "");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  await pollTelegram({ config: defaultConfig(), gateway, cwd, fetcher, log: () => {}, maxIterations: 1 });
  await pollTelegram({ config: defaultConfig(), gateway, cwd, fetcher, log: () => {}, maxIterations: 1 });

  assert.equal(sends.length, 1, "a queued update already handled before restart is not replayed into the chat");
  assert.match(sends[0], /Commands/);
  assert.match(sends[0], /\/tools/);
});

test("telegram polling durably acknowledges then recovers a failed update without platform replay", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-telegram-poll-retry-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(cwd, ".muster"), { recursive: true });
  const gateway = { token: "test-token", telegram: { botToken: "123:ABC" } };
  await requestPairing(TELEGRAM_SURFACE_ID, "5599220011", cwd).then((pending) => approvePairing(pending.code, cwd));
  const queuedUpdate = { ...telegramUpdate, update_id: 837366115, message: { ...telegramUpdate.message, text: "retry this provider turn" } };
  const llm = await startFlakyStubLlm();
  const offsets: string[] = [];
  const sends: string[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    if (target.includes("/deleteWebhook")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (target.includes("/getUpdates")) {
      offsets.push(new URL(target).searchParams.get("offset") ?? "");
      return new Response(JSON.stringify({ ok: true, result: [queuedUpdate] }), { status: 200 });
    }
    if (target.includes("/sendMessage")) {
      sends.push((JSON.parse(String(init?.body ?? "{}")) as { text?: string }).text ?? "");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  try {
    await pollTelegram({ config: stubConfig(llm.url), gateway, cwd, fetcher, log: () => {}, maxIterations: 1 });
    await pollTelegram({ config: stubConfig(llm.url), gateway, cwd, fetcher, log: () => {}, maxIterations: 1 });
    assert.equal(llm.calls(), 2, "the failed provider turn is recovered from the local spool on restart");
    assert.deepEqual(offsets, ["0", "837366116"], "the platform offset advances only after the payload is durably spooled");
    assert.deepEqual(sends, ["retry completed"], "only the successful retry is delivered");
  } finally {
    llm.close();
  }
});

test("slack webhook answers url_verification with the challenge", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-slack-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(cwd, ".muster"), { recursive: true });
  await writeFile(gatewayConfigPath(cwd), JSON.stringify({ token: "test-token", slack: { botToken: "xoxb-test" } }));
  const gateway = await loadGatewayConfig(cwd);
  const llm = await startStubLlm("unused");
  const running = await startGatewayServer({ config: stubConfig(llm.url), gateway, cwd }, 0);
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}/v1/adapters/slack`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify(slackUrlVerification),
    });
    assert.equal(response.status, 200);
    await running.waitForIdle();
    assert.deepEqual(await response.json(), { challenge: slackUrlVerification.challenge });
  } finally {
    await running.close();
    llm.close();
  }
});

test("slack webhook posts governed reply via chat.postMessage with bot token", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-slack-msg-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(cwd, ".muster"), { recursive: true });
  await writeFile(gatewayConfigPath(cwd), JSON.stringify({ token: "test-token", slack: { botToken: "xoxb-test" } }));
  const gateway = await loadGatewayConfig(cwd);

  await requestPairing("slack:T024BE7LD", "U2147483697", cwd).then((pending) => approvePairing(pending.code, cwd));

  const llm = await startStubLlm("3 open tickets");
  const outbound: Array<{ url: string; auth?: string; body: unknown }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    outbound.push({ url: String(url), auth: headers?.authorization, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  const running = await startGatewayServer({ config: stubConfig(llm.url), gateway, cwd, fetcher }, 0);
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}/v1/adapters/slack`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify(slackEventCallback),
    });
    assert.equal(response.status, 200);
    await running.waitForIdle();
    assert.equal(outbound.length, 1);
    assert.equal(outbound[0].url, "https://slack.com/api/chat.postMessage");
    assert.equal(outbound[0].auth, "Bearer xoxb-test");
    const body = outbound[0].body as { channel: string; text: string; thread_ts?: string };
    assert.equal(body.channel, "C2147483705");
    assert.equal(body.text, "3 open tickets");
    assert.equal(body.thread_ts, "1765432000.000200");

    const retry = await fetch(`http://127.0.0.1:${running.port}/v1/adapters/slack`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token", "x-slack-retry-num": "1", "x-slack-retry-reason": "http_timeout" },
      body: JSON.stringify(slackEventCallback),
    });
    assert.equal(retry.status, 200);
    assert.equal(outbound.length, 1, "Slack retry with the same event_id must not double-post or spend tokens twice");
  } finally {
    await running.close();
    llm.close();
  }
});

test("slack webhook acknowledges before a slow provider finishes and drains delivery", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-slack-fast-ack-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(cwd, ".muster"), { recursive: true });
  await writeFile(gatewayConfigPath(cwd), JSON.stringify({ token: "test-token", slack: { botToken: "xoxb-test" } }));
  const gateway = await loadGatewayConfig(cwd);
  await requestPairing("slack:T024BE7LD", "U2147483697", cwd).then((pending) => approvePairing(pending.code, cwd));
  const llm = await startStubLlm("slow provider completed", 500);
  const outbound: unknown[] = [];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    outbound.push(init?.body);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  const running = await startGatewayServer({ config: stubConfig(llm.url), gateway, cwd, fetcher }, 0);
  try {
    const started = performance.now();
    const response = await fetch(`http://127.0.0.1:${running.port}/v1/adapters/slack`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({ ...slackEventCallback, event_id: "Ev-slow-provider-fast-ack" }),
    });
    const acknowledgementMs = performance.now() - started;
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, accepted: true });
    assert.ok(acknowledgementMs < 250, `webhook acknowledgement took ${acknowledgementMs.toFixed(1)}ms`);
    await running.waitForIdle();
    assert.match(JSON.stringify(outbound), /slow provider completed/);
    assert.equal((await new DurableGatewayIngressSpool(
      join(dataDir(cwd), "gateway-ingress-spool"),
      createHash("sha256").update("muster-ingress-spool:test-token").digest(),
    ).snapshot()).entries.length, 0);
  } finally {
    await running.close();
    llm.close();
  }
});

test("gateway startup recovers a Slack payload durably spooled before a crashed async run", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-slack-spool-recovery-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(cwd, ".muster"), { recursive: true });
  await writeFile(gatewayConfigPath(cwd), JSON.stringify({ token: "test-token", slack: { botToken: "xoxb-test" } }));
  const gateway = await loadGatewayConfig(cwd);
  await requestPairing("slack:T024BE7LD", "U2147483697", cwd).then((pending) => approvePairing(pending.code, cwd));
  const payloadObject = { ...slackEventCallback, event_id: "Ev-crashed-after-ack" };
  const body = JSON.stringify(payloadObject);
  const deliveryId = "slack:Ev-crashed-after-ack";
  const identity = {
    scope: "adapter:slack",
    deliveryId,
    fingerprint: createGatewayIngressFingerprint(["slack", deliveryId, body]),
  };
  const enterprise = openSqliteGatewayEnterpriseRuntime(cwd);
  const crashedIngress = new DurableGatewayIngress(enterprise.idempotencyStore, { defaultLeaseMs: 15 * 60_000 });
  const crashedClaim = await crashedIngress.claim(identity);
  assert.equal(crashedClaim.status, "claimed");
  assert.ok(crashedClaim.claimToken);
  const ownership = { ...identity, claimToken: crashedClaim.claimToken };
  await crashedIngress.transition({ ...ownership, to: "running" });
  const spoolRoot = join(dataDir(cwd), "gateway-ingress-spool");
  const spool = new DurableGatewayIngressSpool(
    spoolRoot,
    createHash("sha256").update("muster-ingress-spool:test-token").digest(),
    { pid: 2_147_483_647 },
  );
  await spool.put({ adapterId: "slack", ownership, body });
  await enterprise.close?.();

  const llm = await startStubLlm("recovered after crash");
  const outbound: string[] = [];
  const fetcher = (async (url: string | URL | Request) => {
    outbound.push(String(url));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  const running = await startGatewayServer({ config: stubConfig(llm.url), gateway, cwd, fetcher }, 0);
  try {
    await running.waitForIdle();
    assert.equal(llm.calls(), 1, "the accepted payload is recovered without waiting for a platform retry");
    assert.ok(outbound.includes("https://slack.com/api/chat.postMessage"));
    assert.equal((await spool.snapshot()).entries.length, 0, "successful recovery removes the write-ahead payload");
  } finally {
    await running.close();
    llm.close();
  }
});

test("gateway recovery finalizes a platform-delivered payload from a partial delivering lifecycle", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-slack-partial-delivery-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(cwd, ".muster"), { recursive: true });
  await writeFile(gatewayConfigPath(cwd), JSON.stringify({ token: "test-token", slack: { botToken: "xoxb-test" } }));
  const gateway = await loadGatewayConfig(cwd);
  const payloadObject = { ...slackEventCallback, event_id: "Ev-partial-delivery" };
  const body = JSON.stringify(payloadObject);
  const deliveryId = "slack:Ev-partial-delivery";
  const identity = { scope: "adapter:slack", deliveryId, fingerprint: createGatewayIngressFingerprint(["slack", deliveryId, body]) };
  const enterprise = openSqliteGatewayEnterpriseRuntime(cwd);
  const ingress = new DurableGatewayIngress(enterprise.idempotencyStore, { defaultLeaseMs: 15 * 60_000 });
  const claim = await ingress.claim(identity);
  assert.ok(claim.claimToken);
  const ownership = { ...identity, claimToken: claim.claimToken };
  await ingress.transition({ ...ownership, to: "running" });
  await ingress.transition({ ...ownership, to: "generated" });
  await ingress.transition({ ...ownership, to: "delivering" });
  const spool = new DurableGatewayIngressSpool(
    join(dataDir(cwd), "gateway-ingress-spool"),
    createHash("sha256").update("muster-ingress-spool:test-token").digest(),
    { pid: 2_147_483_647 },
  );
  await spool.put({ adapterId: "slack", ownership, body });
  await spool.markExecutionCompleted(ownership, [{
    message: { surfaceId: "slack:T024BE7LD", conversationId: "C2147483705", senderId: "U2147483697", text: "partial" },
    reply: { text: "already delivered" },
  }]);
  await spool.markSendAttempted(ownership);
  await spool.markPlatformDelivered(ownership);
  await enterprise.close?.();

  const llm = await startStubLlm("must not run");
  const running = await startGatewayServer({ config: stubConfig(llm.url), gateway, cwd }, 0);
  try {
    assert.equal(llm.calls(), 0);
    assert.equal((await spool.snapshot()).entries.length, 0, "partial lifecycle recovery finishes without replaying delivery");
  } finally {
    await running.close();
    llm.close();
  }
});

test("a network interruption after send intent becomes unknown and is never replayed automatically", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-slack-unknown-send-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(cwd, ".muster"), { recursive: true });
  await writeFile(gatewayConfigPath(cwd), JSON.stringify({ token: "test-token", slack: { botToken: "xoxb-test" } }));
  const gateway = await loadGatewayConfig(cwd);
  await requestPairing("slack:T024BE7LD", "U2147483697", cwd).then((pending) => approvePairing(pending.code, cwd));
  const llm = await startStubLlm("unknown send answer");
  let sendAttempts = 0;
  const fetcher = (async () => {
    sendAttempts += 1;
    throw new Error("connection reset after request write");
  }) as typeof fetch;
  const running = await startGatewayServer({ config: stubConfig(llm.url), gateway, cwd, fetcher }, 0);
  const payload = JSON.stringify({ ...slackEventCallback, event_id: "Ev-unknown-after-send" });
  const post = () => fetch(`http://127.0.0.1:${running.port}/v1/adapters/slack`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    body: payload,
  });
  try {
    assert.equal((await post()).status, 200);
    await running.waitForIdle();
    assert.equal((await post()).status, 200);
    await running.waitForIdle();
    assert.equal(llm.calls(), 1);
    assert.equal(sendAttempts, 1, "an unknown send is not duplicated by webhook replay");
    const spool = new DurableGatewayIngressSpool(
      join(dataDir(cwd), "gateway-ingress-spool"),
      createHash("sha256").update("muster-ingress-spool:test-token").digest(),
    );
    assert.equal((await spool.snapshot()).entries[0]?.state, "unknown-after-send");
  } finally {
    await running.close();
    llm.close();
  }
});

test("failed background webhook work releases ingress so the same platform delivery can retry", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-slack-retry-failure-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(cwd, ".muster"), { recursive: true });
  await writeFile(gatewayConfigPath(cwd), JSON.stringify({ token: "test-token", slack: { botToken: "xoxb-test" } }));
  const gateway = await loadGatewayConfig(cwd);
  await requestPairing("slack:T024BE7LD", "U2147483697", cwd).then((pending) => approvePairing(pending.code, cwd));
  const llm = await startFlakyStubLlm();
  const outbound: unknown[] = [];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    outbound.push(init?.body);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  const running = await startGatewayServer({ config: stubConfig(llm.url), gateway, cwd, fetcher }, 0);
  const payload = JSON.stringify({ ...slackEventCallback, event_id: "Ev-retry-after-provider-failure" });
  const post = () => fetch(`http://127.0.0.1:${running.port}/v1/adapters/slack`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    body: payload,
  });
  try {
    assert.equal((await post()).status, 200);
    await running.waitForIdle();
    assert.equal(llm.calls(), 1);
    assert.equal((await post()).status, 200);
    await running.waitForIdle();
    assert.equal(llm.calls(), 2, "the failed pending claim must not suppress the platform retry");
    assert.match(JSON.stringify(outbound), /retry completed/);
  } finally {
    await running.close();
    llm.close();
  }
});

test("an unacknowledged Slack final reply retries its checkpoint without rerunning the provider", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-slack-delivery-retry-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(cwd, ".muster"), { recursive: true });
  await writeFile(gatewayConfigPath(cwd), JSON.stringify({ token: "test-token", slack: { botToken: "xoxb-test" } }));
  const gateway = await loadGatewayConfig(cwd);
  await requestPairing("slack:T024BE7LD", "U2147483697", cwd).then((pending) => approvePairing(pending.code, cwd));
  const llm = await startStubLlm("delivery retry completed");
  let postCalls = 0;
  const texts: string[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === "https://slack.com/api/chat.postMessage") {
      postCalls += 1;
      texts.push((JSON.parse(String(init?.body ?? "{}")) as { text?: string }).text ?? "");
      return new Response(JSON.stringify(postCalls === 1 ? { ok: false, error: "temporary_delivery_failure" } : { ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  const running = await startGatewayServer({ config: stubConfig(llm.url), gateway, cwd, fetcher }, 0);
  const payload = JSON.stringify({ ...slackEventCallback, event_id: "Ev-retry-after-delivery-failure" });
  const post = () => fetch(`http://127.0.0.1:${running.port}/v1/adapters/slack`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    body: payload,
  });
  try {
    assert.equal((await post()).status, 200);
    await running.waitForIdle();
    assert.equal(llm.calls(), 1);
    assert.equal((await post()).status, 200);
    await running.waitForIdle();
    assert.equal(llm.calls(), 1, "a platform-level delivery failure reuses the generated checkpoint");
    assert.ok(texts.some((text) => text.includes("Nothing is being claimed as complete")), "the first failed attempt receives a truthful recovery notice");
    assert.equal(texts.at(-1), "delivery retry completed");
  } finally {
    await running.close();
    llm.close();
  }
});

test("slack webhook rejects unverified remote MEDIA URLs instead of claiming an attachment", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-slack-artifact-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(cwd, ".muster"), { recursive: true });
  await writeFile(gatewayConfigPath(cwd), JSON.stringify({ token: "test-token", slack: { botToken: "xoxb-test", status: "message", thinking: "progress" } }));
  const gateway = await loadGatewayConfig(cwd);
  await requestPairing("slack:T024BE7LD", "U2147483697", cwd).then((pending) => approvePairing(pending.code, cwd));

  const llm = await startStubLlm("Created the workbook.\nMEDIA:https://artifacts.example.test/workbook.xlsx");
  const outbound: Array<{ url: string; body: unknown }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    outbound.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  const running = await startGatewayServer({ config: stubConfig(llm.url), gateway, cwd, fetcher }, 0);
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}/v1/adapters/slack`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({
        ...slackEventCallback,
        event_id: "Ev-artifact-progress",
        event: { ...slackEventCallback.event, text: "muster: create a workbook artifact for channel QA" },
      }),
    });
    assert.equal(response.status, 200);
    await running.waitForIdle();
    const posts = outbound.filter((entry) => entry.url === "https://slack.com/api/chat.postMessage").map((entry) => entry.body as { text: string });
    const progress = posts.find((post) => post.text.includes("Processing"));
    assert.ok(progress, "progress message is posted");
    assert.match(progress!.text, /Preparing artifact route/, "artifact requests show the artifact route");
    assert.doesNotMatch(progress!.text, /memory/i, "memory is not claimed unless the request asks for recall");
    assert.ok(posts.some((post) => post.text.includes("Created the workbook.") && post.text.includes("did not declare a verifiable file path")), "final text strips the unsafe MEDIA tag and reports the verification failure");
    assert.equal(posts.some((post) => post.text.includes("Some artifacts could not be attached directly")), false, "an unverified remote URL is not represented as an attachment");
  } finally {
    await running.close();
    llm.close();
  }
});

test("slack webhook edits one progress message into the final reply", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-slack-progress-final-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(cwd, ".muster"), { recursive: true });
  await writeFile(gatewayConfigPath(cwd), JSON.stringify({ token: "test-token", slack: { botToken: "xoxb-test", status: "message", thinking: "progress" } }));
  const gateway = await loadGatewayConfig(cwd);
  await requestPairing("slack:T024BE7LD", "U2147483697", cwd).then((pending) => approvePairing(pending.code, cwd));

  const llm = await startStubLlm("slow slack run complete");
  const outbound: Array<{ url: string; body: unknown }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    outbound.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ ok: true, ts: "1765432000.000777" }), { status: 200 });
  }) as typeof fetch;
  const running = await startGatewayServer({ config: stubConfig(llm.url), gateway, cwd, fetcher }, 0);
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}/v1/adapters/slack`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({
        ...slackEventCallback,
        event_id: "Ev-progress-final",
        event: { ...slackEventCallback.event, text: "muster: run a slow channel task" },
      }),
    });
    assert.equal(response.status, 200);
    await running.waitForIdle();
    const posts = outbound.filter((entry) => entry.url === "https://slack.com/api/chat.postMessage");
    assert.equal(posts.length, 1, "Slack uses one progress message instead of posting a second final message");
    assert.match((posts[0].body as { text: string }).text, /Processing/);
    assert.ok(outbound.some((entry) => entry.url === "https://slack.com/api/chat.update" && (entry.body as { text?: string }).text === "slow slack run complete"), "final reply edits the progress message in place");
  } finally {
    await running.close();
    llm.close();
  }
});

test("slack progress final update failure falls back to a final post", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-slack-progress-update-fail-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(cwd, ".muster"), { recursive: true });
  await writeFile(gatewayConfigPath(cwd), JSON.stringify({ token: "test-token", slack: { botToken: "xoxb-test", status: "message", thinking: "progress" } }));
  const gateway = await loadGatewayConfig(cwd);
  await requestPairing("slack:T024BE7LD", "U2147483697", cwd).then((pending) => approvePairing(pending.code, cwd));

  const llm = await startStubLlm("final after update failure");
  const outbound: Array<{ url: string; body: unknown }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    outbound.push({ url: target, body: JSON.parse(String(init?.body ?? "{}")) });
    if (target === "https://slack.com/api/chat.update") return new Response(JSON.stringify({ ok: false, error: "message_not_found" }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, ts: "1765432000.000778" }), { status: 200 });
  }) as typeof fetch;
  const running = await startGatewayServer({ config: stubConfig(llm.url), gateway, cwd, fetcher }, 0);
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}/v1/adapters/slack`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({
        ...slackEventCallback,
        event_id: "Ev-progress-update-fail",
        event: { ...slackEventCallback.event, text: "muster: run a slow task with update failure" },
      }),
    });
    assert.equal(response.status, 200);
    await running.waitForIdle();
    const postTexts = outbound.filter((entry) => entry.url === "https://slack.com/api/chat.postMessage").map((entry) => (entry.body as { text?: string }).text ?? "");
    assert.equal(postTexts.length, 2, "Slack sends a fallback final message when progress update fails");
    assert.match(postTexts[0], /Processing/);
    assert.equal(postTexts[1], "final after update failure");
  } finally {
    await running.close();
    llm.close();
  }
});

test("slack webhook uploads local MEDIA artifacts with the Slack files API", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-slack-local-artifact-"));
  const { mkdir } = await import("node:fs/promises");
  const workspace = profileWorkspaceDir(cwd, "default");
  await mkdir(join(cwd, ".muster"), { recursive: true });
  await mkdir(join(workspace, "artifacts"), { recursive: true });
  const reportBytes = Buffer.from("%PDF-1.4\n% muster test pdf\n%%EOF\n");
  await writeFile(join(workspace, "artifacts", "provider-report.pdf"), reportBytes);
  await writeFile(gatewayConfigPath(cwd), JSON.stringify({ token: "test-token", slack: { botToken: "xoxb-test", status: "message", thinking: "progress" } }));
  const gateway = await loadGatewayConfig(cwd);
  await requestPairing("slack:T024BE7LD", "U2147483697", cwd).then((pending) => approvePairing(pending.code, cwd));

  const llm = await startStubLlm("Created and verified the PDF.\nMEDIA:artifacts/provider-report.pdf");
  const outbound: Array<{ url: string; body: unknown; method?: string }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    outbound.push({ url: target, method: init?.method, body: init?.body });
    if (target === "https://slack.com/api/files.getUploadURLExternal") {
      const form = new URLSearchParams(String(init?.body ?? ""));
      assert.equal(form.get("filename"), "provider-report.pdf");
      assert.equal(form.get("length"), String(reportBytes.byteLength));
      return new Response(JSON.stringify({ ok: true, upload_url: "https://uploads.slack.test/provider-report", file_id: "F123" }), { status: 200 });
    }
    if (target === "https://uploads.slack.test/provider-report") {
      assert.ok(init?.body, "upload request includes file bytes");
      return new Response("OK", { status: 200 });
    }
    if (target === "https://slack.com/api/files.completeUploadExternal") {
      const form = new URLSearchParams(String(init?.body ?? ""));
      assert.equal(form.get("channel_id"), "C2147483705");
      assert.equal(form.get("thread_ts"), "1765432000.000200");
      assert.equal(form.get("files"), JSON.stringify([{ id: "F123", title: "provider-report.pdf" }]));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, ts: "1765432000.000400" }), { status: 200 });
  }) as typeof fetch;
  const running = await startGatewayServer({ config: stubConfig(llm.url), gateway, cwd, fetcher }, 0);
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}/v1/adapters/slack`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({
        ...slackEventCallback,
        event_id: "Ev-local-artifact-upload",
        event: { ...slackEventCallback.event, text: "muster: create a provider-generated pdf artifact" },
      }),
    });
    assert.equal(response.status, 200);
    await running.waitForIdle();
    assert.ok(outbound.some((entry) => entry.url === "https://slack.com/api/files.getUploadURLExternal"), "Slack upload URL is requested");
    assert.ok(outbound.some((entry) => entry.url === "https://uploads.slack.test/provider-report"), "artifact bytes are uploaded to Slack");
    assert.ok(outbound.some((entry) => entry.url === "https://slack.com/api/files.completeUploadExternal"), "Slack upload is completed");
    const updates = outbound
      .filter((entry) => entry.url === "https://slack.com/api/chat.update")
      .map((entry) => JSON.parse(String(entry.body ?? "{}")) as { text?: string });
    assert.ok(updates.some((post) => post.text === "Created and verified the PDF."), "final text strips MEDIA tag");
    assert.ok(!updates.some((post) => post.text?.includes("created locally at")), "successful Slack upload does not leak server-local paths");
    const manifest = await channelArtifactManifest(cwd);
    assert.equal(manifest.artifacts[0].delivery.state, "uploaded");
    assert.equal(manifest.artifacts[0].delivery.channel, "slack");
    assert.equal(manifest.artifacts[0].delivery.providerMessageId, "F123");
  } finally {
    await running.close();
    llm.close();
  }
});

test("slack webhook never uploads a provider artifact that fails structural verification", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-slack-invalid-artifact-"));
  const { mkdir } = await import("node:fs/promises");
  const workspace = profileWorkspaceDir(cwd, "default");
  await mkdir(join(cwd, ".muster"), { recursive: true });
  await mkdir(join(workspace, "artifacts"), { recursive: true });
  await writeFile(join(workspace, "artifacts", "broken.pdf"), "%PDF-1.4\nmissing trailer\n");
  await writeFile(gatewayConfigPath(cwd), JSON.stringify({ token: "test-token", slack: { botToken: "xoxb-test", status: "message" } }));
  const gateway = await loadGatewayConfig(cwd);
  await requestPairing("slack:T024BE7LD", "U2147483697", cwd).then((pending) => approvePairing(pending.code, cwd));
  const llm = await startStubLlm("Created the PDF.\nMEDIA:artifacts/broken.pdf");
  const outbound: Array<{ url: string; body: unknown }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    outbound.push({ url: String(url), body: init?.body });
    return new Response(JSON.stringify({ ok: true, ts: "1765432000.000401" }), { status: 200 });
  }) as typeof fetch;
  const running = await startGatewayServer({ config: stubConfig(llm.url), gateway, cwd, fetcher }, 0);
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}/v1/adapters/slack`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({
        ...slackEventCallback,
        event_id: "Ev-invalid-artifact-blocked",
        event: { ...slackEventCallback.event, text: "muster: create a pdf artifact" },
      }),
    });
    assert.equal(response.status, 200);
    await running.waitForIdle();
    assert.ok(!outbound.some((entry) => entry.url.includes("files.getUploadURLExternal")), "failed verification never requests an upload URL");
    assert.match(JSON.stringify(outbound), /Artifact delivery failed/);
    const manifest = await channelArtifactManifest(cwd);
    assert.equal(manifest.artifacts[0].verification.status, "failed");
    assert.equal(manifest.artifacts[0].delivery.state, "failed");
  } finally {
    await running.close();
    llm.close();
  }
});

test("slack webhook infers provider-created artifact paths when MEDIA tags are missing", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-slack-inferred-artifact-"));
  const { mkdir } = await import("node:fs/promises");
  const workspace = profileWorkspaceDir(cwd, "default");
  await mkdir(join(cwd, ".muster"), { recursive: true });
  await mkdir(join(workspace, "artifacts", "live-proof"), { recursive: true });
  const reportBytes = Buffer.from("%PDF-1.4\n% inferred artifact\n%%EOF\n");
  await writeFile(join(workspace, "artifacts", "live-proof", "provider-created-without-media.pdf"), reportBytes);
  await writeFile(gatewayConfigPath(cwd), JSON.stringify({ token: "test-token", slack: { botToken: "xoxb-test", status: "message", thinking: "progress" } }));
  const gateway = await loadGatewayConfig(cwd);
  await requestPairing("slack:T024BE7LD", "U2147483697", cwd).then((pending) => approvePairing(pending.code, cwd));

  const llm = await startStubLlm("Created: `artifacts/live-proof/provider-created-without-media.pdf`");
  const outbound: Array<{ url: string; body: unknown; method?: string }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    outbound.push({ url: target, method: init?.method, body: init?.body });
    if (target === "https://slack.com/api/files.getUploadURLExternal") {
      const form = new URLSearchParams(String(init?.body ?? ""));
      assert.equal(form.get("filename"), "provider-created-without-media.pdf");
      assert.equal(form.get("length"), String(reportBytes.byteLength));
      return new Response(JSON.stringify({ ok: true, upload_url: "https://uploads.slack.test/inferred-report", file_id: "F124" }), { status: 200 });
    }
    if (target === "https://uploads.slack.test/inferred-report") {
      assert.ok(init?.body, "upload request includes inferred artifact bytes");
      return new Response("OK", { status: 200 });
    }
    if (target === "https://slack.com/api/files.completeUploadExternal") {
      const form = new URLSearchParams(String(init?.body ?? ""));
      assert.equal(form.get("channel_id"), "C2147483705");
      assert.equal(form.get("thread_ts"), "1765432000.000200");
      assert.equal(form.get("files"), JSON.stringify([{ id: "F124", title: "provider-created-without-media.pdf" }]));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, ts: "1765432000.000402" }), { status: 200 });
  }) as typeof fetch;
  const running = await startGatewayServer({ config: stubConfig(llm.url), gateway, cwd, fetcher }, 0);
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}/v1/adapters/slack`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({
        ...slackEventCallback,
        event_id: "Ev-local-artifact-inferred-path",
        event: { ...slackEventCallback.event, text: "muster: create a provider-generated pdf artifact" },
      }),
    });
    assert.equal(response.status, 200);
    await running.waitForIdle();
    assert.ok(outbound.some((entry) => entry.url === "https://slack.com/api/files.getUploadURLExternal"), "Slack upload URL is requested for inferred artifact");
    assert.ok(outbound.some((entry) => entry.url === "https://uploads.slack.test/inferred-report"), "inferred artifact bytes are uploaded to Slack");
    assert.ok(outbound.some((entry) => entry.url === "https://slack.com/api/files.completeUploadExternal"), "Slack upload is completed for inferred artifact");
  } finally {
    await running.close();
    llm.close();
  }
});

test("slack webhook reports missing files:write when local MEDIA upload cannot start", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-slack-missing-files-write-"));
  const { mkdir } = await import("node:fs/promises");
  const workspace = profileWorkspaceDir(cwd, "default");
  await mkdir(join(cwd, ".muster"), { recursive: true });
  await mkdir(join(workspace, "artifacts"), { recursive: true });
  await writeFile(join(workspace, "artifacts", "artifact-scope-gap.pdf"), "%PDF-1.4\n% scope gap\n%%EOF\n");
  await writeFile(gatewayConfigPath(cwd), JSON.stringify({ token: "test-token", slack: { botToken: "xoxb-test", status: "message", thinking: "progress" } }));
  const gateway = await loadGatewayConfig(cwd);
  await requestPairing("slack:T024BE7LD", "U2147483697", cwd).then((pending) => approvePairing(pending.code, cwd));

  const llm = await startStubLlm("Created the PDF.\nMEDIA:artifacts/artifact-scope-gap.pdf");
  const outbound: Array<{ url: string; body: unknown; method?: string }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    outbound.push({ url: target, method: init?.method, body: init?.body });
    if (target === "https://slack.com/api/files.getUploadURLExternal") {
      return new Response(JSON.stringify({ ok: false, error: "missing_scope" }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, ts: "1765432000.000401" }), { status: 200 });
  }) as typeof fetch;
  const running = await startGatewayServer({ config: stubConfig(llm.url), gateway, cwd, fetcher }, 0);
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}/v1/adapters/slack`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({
        ...slackEventCallback,
        event_id: "Ev-local-artifact-missing-files-write",
        event: { ...slackEventCallback.event, text: "muster: create a provider-generated pdf artifact" },
      }),
    });
    assert.equal(response.status, 200);
    await running.waitForIdle();
    assert.ok(outbound.some((entry) => entry.url === "https://slack.com/api/files.getUploadURLExternal"), "Slack upload URL is requested");
    assert.ok(!outbound.some((entry) => String(entry.url).includes("uploads.slack.test")), "artifact bytes are not uploaded after missing_scope");
    const posts = outbound
      .filter((entry) => entry.url === "https://slack.com/api/chat.postMessage")
      .map((entry) => JSON.parse(String(entry.body ?? "{}")) as { text?: string });
    const failure = posts.find((post) => post.text?.includes("Some artifacts could not be attached directly"));
    assert.ok(failure, "missing files:write is surfaced in Slack");
    assert.match(failure!.text ?? "", /files:write/);
    assert.match(failure!.text ?? "", /reinstall the Slack app/);
    const manifest = await channelArtifactManifest(cwd);
    assert.equal(manifest.artifacts[0].delivery.state, "failed");
    assert.equal(manifest.artifacts[0].delivery.channel, "slack");
  } finally {
    await running.close();
    llm.close();
  }
});

// --- Slack signing-secret verification (fix #6) ---

test("slackSignatureIsValid accepts a correct v0 signature and rejects tampering/replay", () => {
  const secret = "8f742231b10e8888abcd99yyyzzz85a5";
  const rawBody = JSON.stringify(slackEventCallback);
  const now = 1_765_432_500_000; // fixed clock
  const ts = String(Math.floor(now / 1000));
  const good = slackSignature(ts, rawBody, secret);

  assert.equal(slackSignatureIsValid(ts, rawBody, good, secret, now), true, "valid signature passes");
  assert.equal(slackSignatureIsValid(ts, `${rawBody} `, good, secret, now), false, "tampered body fails");
  assert.equal(slackSignatureIsValid(ts, rawBody, "v0=deadbeef", secret, now), false, "bad signature fails");
  assert.equal(slackSignatureIsValid(ts, rawBody, good, "wrong-secret", now), false, "wrong secret fails");
  assert.equal(slackSignatureIsValid(undefined, rawBody, good, secret, now), false, "missing timestamp fails");
  assert.equal(slackSignatureIsValid(ts, rawBody, undefined, secret, now), false, "missing signature fails");

  // A timestamp older than the replay window is rejected even with a correct HMAC.
  const oldTs = String(Math.floor(now / 1000) - SLACK_REPLAY_WINDOW_SECONDS - 1);
  const oldSig = slackSignature(oldTs, rawBody, secret);
  assert.equal(slackSignatureIsValid(oldTs, rawBody, oldSig, secret, now), false, "stale timestamp rejected (replay)");
});

test("slack webhook verifies the signing secret before processing when configured", async () => {
  resetAdapterAuthWarnings();
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-slack-sig-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(cwd, ".muster"), { recursive: true });
  const signingSecret = "topsecretsigning";
  await writeFile(gatewayConfigPath(cwd), JSON.stringify({ token: "test-token", slack: { botToken: "xoxb-test", signingSecret } }));
  const gateway = await loadGatewayConfig(cwd);
  const llm = await startStubLlm("unused");
  const running = await startGatewayServer({ config: stubConfig(llm.url), gateway, cwd }, 0);
  const rawBody = JSON.stringify(slackUrlVerification);
  const ts = String(Math.floor(Date.now() / 1000));
  const postSlack = (headers: Record<string, string>) => fetch(`http://127.0.0.1:${running.port}/v1/adapters/slack`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: rawBody,
  });
  try {
    // No signature headers -> 401.
    assert.equal((await postSlack({})).status, 401);
    // Wrong signature -> 401.
    assert.equal((await postSlack({ "x-slack-request-timestamp": ts, "x-slack-signature": "v0=bad" })).status, 401);
    // Tampered body (valid sig for different body) -> 401.
    const sigForOther = slackSignature(ts, "{}", signingSecret);
    assert.equal((await postSlack({ "x-slack-request-timestamp": ts, "x-slack-signature": sigForOther })).status, 401);
    // Correct signature -> 200 and the url_verification challenge echoes back.
    const good = slackSignature(ts, rawBody, signingSecret);
    const ok = await postSlack({ "x-slack-request-timestamp": ts, "x-slack-signature": good });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { challenge: slackUrlVerification.challenge });
  } finally {
    await running.close();
    llm.close();
  }
});

test("slack webhook without a signing secret requires gateway bearer and warns once", async () => {
  resetAdapterAuthWarnings();
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-slack-warn-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(cwd, ".muster"), { recursive: true });
  await writeFile(gatewayConfigPath(cwd), JSON.stringify({ token: "test-token", slack: { botToken: "xoxb-test" } }));
  const gateway = await loadGatewayConfig(cwd);
  const llm = await startStubLlm("unused");
  const lines: string[] = [];
  const running = await startGatewayServer({ config: stubConfig(llm.url), gateway, cwd, log: (line) => lines.push(line) }, 0);
  const postSlack = () => fetch(`http://127.0.0.1:${running.port}/v1/adapters/slack`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify(slackUrlVerification),
  });
  try {
    const unsigned = await fetch(`http://127.0.0.1:${running.port}/v1/adapters/slack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(slackUrlVerification),
    });
    assert.equal(unsigned.status, 401, "unsigned slack webhook without signing secret is rejected");
    assert.equal((await postSlack()).status, 200, "gateway bearer permits private unsigned slack webhook");
    assert.equal((await postSlack()).status, 200);
    const warnings = lines.filter((line) => line.includes("UNAUTHENTICATED") && line.includes("slack"));
    assert.equal(warnings.length, 1, "warns exactly once per process");
  } finally {
    await running.close();
    llm.close();
  }
});

test("slack socket mode acks envelopes and posts governed replies without a public webhook", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-slack-socket-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(cwd, ".muster"), { recursive: true });
  await writeFile(gatewayConfigPath(cwd), JSON.stringify({ token: "test-token", slack: { botToken: "xoxb-test", appToken: "xapp-test", mode: "socket" } }));
  const gateway = await loadGatewayConfig(cwd);
  await requestPairing("slack:T024BE7LD", "U2147483697", cwd).then((pending) => approvePairing(pending.code, cwd));
  const llm = await startStubLlm("socket reply");
  const outbound: Array<{ url: string; auth?: string; body: unknown }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    const headers = init?.headers as Record<string, string> | undefined;
    if (target === "https://slack.com/api/apps.connections.open") {
      outbound.push({ url: target, auth: headers?.authorization, body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ ok: true, url: "wss://socket.slack.test/abc" }), { status: 200 });
    }
    outbound.push({ url: target, auth: headers?.authorization, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  const sent: string[] = [];
  let socket: {
    onopen: ((event: unknown) => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
    onerror: ((event: unknown) => void) | null;
    onclose: ((event: unknown) => void) | null;
    send(data: string): void;
    close(): void;
  } | undefined;
  const run = pollSlackSocket({
    config: stubConfig(llm.url),
    gateway,
    cwd,
    fetcher,
    maxConnections: 1,
    reconnectDelayMs: 1,
    log: () => undefined,
    webSocketFactory: (url) => {
      assert.equal(url, "wss://socket.slack.test/abc");
      socket = {
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        send: (data: string) => sent.push(data),
        close: () => setImmediate(() => socket?.onclose?.({})),
      };
      return socket;
    },
  });
  try {
    await waitForCondition(() => Boolean(socket));
    socket?.onopen?.({});
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    socket?.onmessage?.({ data: JSON.stringify({
      envelope_id: "env-1",
      type: "events_api",
      payload: { ...slackEventCallback, event_id: "Ev-socket-1" },
    }) });
    await waitForCondition(() => outbound.some((entry) => entry.url === "https://slack.com/api/chat.postMessage"));
    socket?.onclose?.({});
    await run;
    assert.deepEqual(sent.map((line) => JSON.parse(line)), [{ envelope_id: "env-1" }]);
    assert.equal(outbound[0].url, "https://slack.com/api/apps.connections.open");
    assert.equal(outbound[0].auth, "Bearer xapp-test");
    const post = outbound.find((entry) => entry.url === "https://slack.com/api/chat.postMessage");
    assert.ok(post);
    assert.equal(post.auth, "Bearer xoxb-test");
    assert.equal((post.body as { text: string }).text, "socket reply");
  } finally {
    llm.close();
  }
});

test("slack socket shutdown drains an acknowledged provider turn before stores close", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-slack-socket-drain-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(cwd, ".muster"), { recursive: true });
  const gateway = { token: "test-token", slack: { botToken: "xoxb-test", appToken: "xapp-test", mode: "socket" as const } };
  await requestPairing("slack:T024BE7LD", "U2147483697", cwd).then((pending) => approvePairing(pending.code, cwd));
  const llm = await startStubLlm("drained socket reply", 150);
  const outbound: string[] = [];
  const fetcher = (async (url: string | URL | Request) => {
    const target = String(url);
    outbound.push(target);
    if (target === "https://slack.com/api/apps.connections.open") {
      return new Response(JSON.stringify({ ok: true, url: "wss://socket.slack.test/drain" }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  let socket: {
    onopen: ((event: unknown) => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
    onerror: ((event: unknown) => void) | null;
    onclose: ((event: unknown) => void) | null;
    send(data: string): void;
    close(): void;
  } | undefined;
  const run = pollSlackSocket({
    config: stubConfig(llm.url), gateway, cwd, fetcher, maxConnections: 1, log: () => undefined,
    webSocketFactory: () => {
      socket = { onopen: null, onmessage: null, onerror: null, onclose: null, send: () => undefined, close: () => undefined };
      return socket;
    },
  });
  let settled = false;
  void run.then(() => { settled = true; });
  try {
    await waitForCondition(() => Boolean(socket));
    socket?.onopen?.({});
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    socket?.onmessage?.({ data: JSON.stringify({
      envelope_id: "env-drain",
      type: "events_api",
      payload: { ...slackEventCallback, event_id: "Ev-socket-drain" },
    }) });
    socket?.onclose?.({});
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    assert.equal(settled, false, "poller remains alive while acknowledged work is still running");
    await run;
    assert.ok(outbound.includes("https://slack.com/api/chat.postMessage"), "the accepted turn finishes delivery before shutdown returns");
  } finally {
    llm.close();
  }
});

// --- Telegram secret-token verification (fix #7) ---

test("telegram webhook requires the secret-token header when configured", async () => {
  resetAdapterAuthWarnings();
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-tg-secret-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(cwd, ".muster"), { recursive: true });
  const secretToken = "tg-webhook-secret-123";
  await writeFile(gatewayConfigPath(cwd), JSON.stringify({ token: "test-token", telegram: { botToken: "123:ABC", secretToken } }));
  const gateway = await loadGatewayConfig(cwd);
  const llm = await startStubLlm("unused");
  const fetcher = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;
  const running = await startGatewayServer({ config: stubConfig(llm.url), gateway, cwd, fetcher }, 0);
  const postTg = (headers: Record<string, string>) => fetch(`http://127.0.0.1:${running.port}/v1/adapters/telegram`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(telegramUpdate),
  });
  try {
    assert.equal((await postTg({})).status, 401, "missing secret token rejected");
    assert.equal((await postTg({ "x-telegram-bot-api-secret-token": "wrong" })).status, 401, "wrong secret token rejected");
    // Matching token is accepted (proceeds to pairing -> 200).
    assert.equal((await postTg({ "x-telegram-bot-api-secret-token": secretToken })).status, 200, "matching secret token accepted");
  } finally {
    await running.close();
    llm.close();
  }
});

test("telegram webhook without a secret token requires gateway bearer and warns once", async () => {
  resetAdapterAuthWarnings();
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-tg-warn-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(cwd, ".muster"), { recursive: true });
  await writeFile(gatewayConfigPath(cwd), JSON.stringify({ token: "test-token", telegram: { botToken: "123:ABC" } }));
  const gateway = await loadGatewayConfig(cwd);
  const llm = await startStubLlm("unused");
  const lines: string[] = [];
  const fetcher = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;
  const running = await startGatewayServer({ config: stubConfig(llm.url), gateway, cwd, fetcher, log: (line) => lines.push(line) }, 0);
  const postTg = () => fetch(`http://127.0.0.1:${running.port}/v1/adapters/telegram`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify(telegramUpdate),
  });
  try {
    const unsigned = await fetch(`http://127.0.0.1:${running.port}/v1/adapters/telegram`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(telegramUpdate),
    });
    assert.equal(unsigned.status, 401, "unsigned telegram webhook without secret token is rejected");
    assert.equal((await postTg()).status, 200, "gateway bearer permits private unsigned telegram webhook");
    assert.equal((await postTg()).status, 200);
    const warnings = lines.filter((line) => line.includes("UNAUTHENTICATED") && line.includes("telegram"));
    assert.equal(warnings.length, 1, "warns exactly once per process");
  } finally {
    await running.close();
    llm.close();
  }
});
