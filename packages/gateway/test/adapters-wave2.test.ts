import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfig } from "@musterhq/core";
import type { MusterConfig } from "@musterhq/core";
import {
  approvePairing,
  DISCORD_PONG,
  discordInteractionToInbound,
  discordSignatureIsValid,
  gatewayConfigPath,
  gchatEventToSurfaceMessage,
  loadGatewayConfig,
  requestPairing,
  startGatewayServer,
  surfaceReplyToDiscordChannelMessage,
  surfaceReplyToDiscordInteractionResponse,
  surfaceReplyToGchatResponse,
  surfaceReplyToTeamsActivity,
  surfaceReplyToWhatsAppSend,
  teamsActivityToSurfaceMessage,
  teamsHmacIsValid,
  whatsAppVerifyChallenge,
  whatsAppWebhookToSurfaceMessages,
} from "../src/index.js";

// --- realistic fixtures (shapes per the respective platform docs) ---

const discordPing = { id: "846462639134605312", application_id: "264811613708746752", type: 1, token: "A_UNIQUE_TOKEN", version: 1 };

const discordCommand = {
  id: "1066034254401368074",
  application_id: "264811613708746752",
  type: 2,
  token: "interaction-token",
  version: 1,
  guild_id: "290926798626357999",
  channel_id: "645027906669510667",
  member: {
    user: { id: "53908232506183680", username: "dhairya", discriminator: "0", bot: false },
    roles: ["539082325061831684"],
  },
  data: {
    id: "771825006014889984",
    name: "muster",
    type: 1,
    options: [{ name: "prompt", type: 3, value: "what changed in the last deploy?" }],
  },
};

const whatsAppNotification = {
  object: "whatsapp_business_account",
  entry: [{
    id: "102290129340398",
    changes: [{
      field: "messages",
      value: {
        messaging_product: "whatsapp",
        metadata: { display_phone_number: "15550783881", phone_number_id: "106540352242922" },
        contacts: [{ profile: { name: "Dhairya" }, wa_id: "919812345678" }],
        messages: [{
          from: "919812345678",
          id: "wamid.HBgLOTE5ODEyMzQ1Njc4FQIAEhggNzVCNUQ3RDM=",
          timestamp: "1765432100",
          type: "text",
          text: { body: "summarize today's episodes" },
          context: { id: "wamid.PREVIOUSMESSAGE=" },
        }],
      },
    }],
  }],
};

const gchatMessageEvent = {
  type: "MESSAGE",
  eventTime: "2026-06-10T12:00:00.000Z",
  token: "gchat-verification-token",
  space: { name: "spaces/AAAAAAAAAAA", type: "ROOM", displayName: "Muster Ops" },
  message: {
    name: "spaces/AAAAAAAAAAA/messages/CCCCCCCCCCC",
    sender: { name: "users/103284139", displayName: "Dhairya", type: "HUMAN" },
    text: "@Muster what flows are pending?",
    argumentText: " what flows are pending?",
    thread: { name: "spaces/AAAAAAAAAAA/threads/BBBBBBBBBBB" },
    createTime: "2026-06-10T12:00:00.000Z",
  },
  user: { name: "users/103284139", displayName: "Dhairya", type: "HUMAN" },
};

const teamsActivity = {
  type: "message",
  id: "1765432100000",
  timestamp: "2026-06-10T12:00:00.000Z",
  serviceUrl: "https://smba.trafficmanager.net/amer/",
  channelId: "msteams",
  from: { id: "29:1bSnHZ7Js2STWrgk6ScEErLk1Lp2zQuD5H2qQ960rtvqKz", name: "Dhairya" },
  conversation: { id: "19:253b1f341670408fb6fe51050b6e5ceb@thread.skype" },
  recipient: { id: "28:c9e8c047-2a74-40a2-b28a-b162d5f5327c", name: "Muster" },
  text: "<at>Muster</at> show the ledger for today",
  channelData: { tenant: { id: "4dcaf6e7-c4d3-44a5-8ad1-ee3b92baf4a5" } },
};

// --- Discord mapper ---

test("discord PING maps to PONG (endpoint verification handshake)", () => {
  const inbound = discordInteractionToInbound(discordPing);
  assert.deepEqual(inbound, { kind: "pong" });
  assert.deepEqual(DISCORD_PONG, { type: 1 });
});

test("discord application command maps to a SurfaceMessage", () => {
  const inbound = discordInteractionToInbound(discordCommand);
  assert.equal(inbound.kind, "message");
  const message = (inbound as { message: { surfaceId: string; conversationId: string; senderId: string; text: string } }).message;
  assert.equal(message.surfaceId, "discord:290926798626357999");
  assert.equal(message.conversationId, "645027906669510667");
  assert.equal(message.senderId, "53908232506183680");
  assert.equal(message.text, "what changed in the last deploy?");
});

test("discord component interactions and textless commands are ignored", () => {
  const component = discordInteractionToInbound({ type: 3, channel_id: "C1", member: { user: { id: "U1" } }, data: { custom_id: "muster:approve:run_1" } });
  assert.equal(component.kind, "ignored");
  const noText = discordInteractionToInbound({ type: 2, channel_id: "C1", member: { user: { id: "U1" } }, data: { name: "muster", options: [] } });
  assert.equal(noText.kind, "ignored");
  assert.equal(discordInteractionToInbound("nope").kind, "ignored");
});

test("discord reply maps to interaction response; approvals render button components", () => {
  const plain = surfaceReplyToDiscordInteractionResponse({ text: "deploy v42 shipped" });
  assert.deepEqual(plain, { type: 4, data: { content: "deploy v42 shipped" } });

  const pairing = surfaceReplyToDiscordInteractionResponse({ status: "pairing_required", code: "AB23CD45" });
  assert.match(pairing.data!.content, /muster pairing approve AB23CD45/);

  const approval = surfaceReplyToDiscordInteractionResponse({
    text: "draft ready",
    approvalRequest: { runId: "flowrun_1a2b3c4d", gateId: "publish", show: "ship it?", options: ["approve", "reject"] },
  });
  assert.equal(approval.type, 4);
  const buttons = approval.data!.components![0].components;
  assert.deepEqual(buttons.map((button) => button.custom_id), ["muster:approve:flowrun_1a2b3c4d", "muster:reject:flowrun_1a2b3c4d"]);

  // REST channel-message payload mirrors the same content/components.
  const channelMessage = surfaceReplyToDiscordChannelMessage({
    text: "",
    approvalRequest: { runId: "flowrun_1a2b3c4d", gateId: "publish", show: "ship it?", options: ["approve", "reject"] },
  });
  assert.equal(channelMessage.components![0].components[0].custom_id, "muster:approve:flowrun_1a2b3c4d");
});

// --- Discord ed25519 signature verification (real keypair, no mocks) ---

/** Real ed25519 keypair; raw 32-byte public key is the SPKI DER minus its 12-byte prefix. */
function discordTestKeys(): { publicKeyHex: string; signFor: (timestamp: string, body: string) => string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPublicKey = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return {
    publicKeyHex: Buffer.from(rawPublicKey).toString("hex"),
    signFor: (timestamp, body) => cryptoSign(null, Buffer.from(timestamp + body, "utf8"), privateKey).toString("hex"),
  };
}

test("discord ed25519 signature: valid passes; tampered body/timestamp/signature fail", () => {
  const keys = discordTestKeys();
  const body = JSON.stringify(discordCommand);
  const timestamp = "1765432100";
  const signature = keys.signFor(timestamp, body);

  assert.equal(discordSignatureIsValid(body, signature, timestamp, keys.publicKeyHex), true);

  // Tampered body, timestamp, or signature must all be rejected.
  assert.equal(discordSignatureIsValid(`${body} `, signature, timestamp, keys.publicKeyHex), false);
  assert.equal(discordSignatureIsValid(body, signature, "1765432101", keys.publicKeyHex), false);
  const flipped = (signature[0] === "0" ? "1" : "0") + signature.slice(1);
  assert.equal(discordSignatureIsValid(body, flipped, timestamp, keys.publicKeyHex), false);

  // Signature from a different key must be rejected.
  const otherKeys = discordTestKeys();
  assert.equal(discordSignatureIsValid(body, otherKeys.signFor(timestamp, body), timestamp, keys.publicKeyHex), false);

  // Missing or malformed inputs return false instead of throwing.
  assert.equal(discordSignatureIsValid(body, undefined, timestamp, keys.publicKeyHex), false);
  assert.equal(discordSignatureIsValid(body, signature, undefined, keys.publicKeyHex), false);
  assert.equal(discordSignatureIsValid(body, "not-hex", timestamp, keys.publicKeyHex), false);
  assert.equal(discordSignatureIsValid(body, signature, timestamp, "deadbeef"), false);
});

// --- WhatsApp mapper ---

test("whatsapp hub.challenge verification echoes only on matching verify token", () => {
  const ok = whatsAppVerifyChallenge({ mode: "subscribe", verifyToken: "secret-verify", challenge: "1158201444" }, "secret-verify");
  assert.equal(ok, "1158201444");
  assert.equal(whatsAppVerifyChallenge({ mode: "subscribe", verifyToken: "wrong", challenge: "1158201444" }, "secret-verify"), undefined);
  assert.equal(whatsAppVerifyChallenge({ mode: "unsubscribe", verifyToken: "secret-verify", challenge: "1158201444" }, "secret-verify"), undefined);
});

test("whatsapp notification maps entry[].changes[].value.messages[] to SurfaceMessages", () => {
  const messages = whatsAppWebhookToSurfaceMessages(whatsAppNotification);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].surfaceId, "whatsapp:106540352242922");
  assert.equal(messages[0].conversationId, "919812345678");
  assert.equal(messages[0].senderId, "919812345678");
  assert.equal(messages[0].text, "summarize today's episodes");
  assert.equal(messages[0].replyTo, "wamid.PREVIOUSMESSAGE=");
});

test("whatsapp status-only notifications map to no messages", () => {
  const statuses = {
    object: "whatsapp_business_account",
    entry: [{ id: "1", changes: [{ field: "messages", value: { metadata: { phone_number_id: "106540352242922" }, statuses: [{ id: "wamid.X", status: "delivered" }] } }] }],
  };
  assert.deepEqual(whatsAppWebhookToSurfaceMessages(statuses), []);
  assert.deepEqual(whatsAppWebhookToSurfaceMessages({ object: "page" }), []);
});

test("whatsapp reply maps to /messages payload; approvals render interactive buttons", () => {
  const plain = surfaceReplyToWhatsAppSend({ text: "12 episodes today" }, "919812345678");
  assert.deepEqual(plain, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: "919812345678",
    type: "text",
    text: { body: "12 episodes today" },
  });

  const approval = surfaceReplyToWhatsAppSend({
    text: "draft ready",
    approvalRequest: { runId: "flowrun_9z8y7x6w", gateId: "send", show: "send invoice?", options: ["approve", "reject"] },
  }, "919812345678");
  assert.equal(approval.type, "interactive");
  assert.deepEqual(approval.interactive!.action.buttons.map((button) => button.reply.id), [
    "muster:approve:flowrun_9z8y7x6w",
    "muster:reject:flowrun_9z8y7x6w",
  ]);

  const pairing = surfaceReplyToWhatsAppSend({ status: "pairing_required", code: "QR45ST67" }, "919812345678");
  assert.match(pairing.text!.body, /muster pairing approve QR45ST67/);
});

// --- Google Chat mapper ---

test("gchat MESSAGE event maps to a SurfaceMessage with mention stripped", () => {
  const inbound = gchatEventToSurfaceMessage(gchatMessageEvent);
  assert.equal(inbound.kind, "message");
  const message = (inbound as { message: { surfaceId: string; conversationId: string; senderId: string; text: string; replyTo?: string } }).message;
  assert.equal(message.surfaceId, "gchat:app");
  assert.equal(message.conversationId, "spaces/AAAAAAAAAAA");
  assert.equal(message.senderId, "users/103284139");
  assert.equal(message.text, "what flows are pending?");
  assert.equal(message.replyTo, "spaces/AAAAAAAAAAA/threads/BBBBBBBBBBB");
});

test("gchat non-message and bot events are ignored", () => {
  assert.equal(gchatEventToSurfaceMessage({ type: "ADDED_TO_SPACE", space: { name: "spaces/A" } }).kind, "ignored");
  assert.equal(gchatEventToSurfaceMessage({
    type: "MESSAGE",
    space: { name: "spaces/A" },
    message: { text: "echo", sender: { name: "users/bot", type: "BOT" } },
  }).kind, "ignored");
});

test("gchat reply maps to sync response; approvals render cardsV2 buttons", () => {
  const plain = surfaceReplyToGchatResponse({ text: "2 flows pending" }, "spaces/A/threads/B");
  assert.deepEqual(plain, { text: "2 flows pending", thread: { name: "spaces/A/threads/B" } });

  const approval = surfaceReplyToGchatResponse({
    text: "",
    approvalRequest: { runId: "flowrun_5e6f7g8h", gateId: "deploy", show: { target: "prod" }, options: ["approve", "reject"] },
  });
  const buttons = approval.cardsV2![0].card.sections[0].widgets[0].buttonList.buttons;
  assert.deepEqual(buttons.map((button) => [button.onClick.action.function, button.onClick.action.parameters[0].value]), [
    ["muster_approve", "flowrun_5e6f7g8h"],
    ["muster_reject", "flowrun_5e6f7g8h"],
  ]);
});

// --- Teams mapper ---

test("teams message activity maps to a SurfaceMessage with <at> mention stripped", () => {
  const inbound = teamsActivityToSurfaceMessage(teamsActivity);
  assert.equal(inbound.kind, "message");
  const message = (inbound as { message: { surfaceId: string; conversationId: string; senderId: string; text: string } }).message;
  assert.equal(message.surfaceId, "teams:4dcaf6e7-c4d3-44a5-8ad1-ee3b92baf4a5");
  assert.equal(message.conversationId, "19:253b1f341670408fb6fe51050b6e5ceb@thread.skype");
  assert.equal(message.senderId, "29:1bSnHZ7Js2STWrgk6ScEErLk1Lp2zQuD5H2qQ960rtvqKz");
  assert.equal(message.text, "show the ledger for today");
});

test("teams non-message activities are ignored; HMAC validates raw body", () => {
  assert.equal(teamsActivityToSurfaceMessage({ type: "conversationUpdate" }).kind, "ignored");

  const secret = Buffer.from("teams-shared-secret").toString("base64");
  const body = JSON.stringify(teamsActivity);
  const signature = createHmac("sha256", Buffer.from(secret, "base64")).update(body, "utf8").digest("base64");
  assert.equal(teamsHmacIsValid(body, `HMAC ${signature}`, secret), true);
  assert.equal(teamsHmacIsValid(body, `HMAC ${signature}x`, secret), false);
  assert.equal(teamsHmacIsValid(body, undefined, secret), false);
});

test("teams reply maps to message activity; approvals render an Adaptive Card", () => {
  const plain = surfaceReplyToTeamsActivity({ text: "ledger: 48,112 tokens today" });
  assert.deepEqual(plain, { type: "message", text: "ledger: 48,112 tokens today" });

  const approval = surfaceReplyToTeamsActivity({
    text: "release notes drafted",
    approvalRequest: { runId: "flowrun_a1b2c3d4", gateId: "publish", show: "v1.2 notes", options: ["approve", "reject"] },
  });
  const card = approval.attachments![0];
  assert.equal(card.contentType, "application/vnd.microsoft.card.adaptive");
  assert.deepEqual(card.content.actions.map((action) => action.data.musterAction), [
    "muster:approve:flowrun_a1b2c3d4",
    "muster:reject:flowrun_a1b2c3d4",
  ]);

  const pairing = surfaceReplyToTeamsActivity({ status: "pairing_required", code: "ZX98WV76" });
  assert.match(pairing.text!, /muster pairing approve ZX98WV76/);
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

function startStubLlm(content: string): Promise<{ url: string; close: () => void }> {
  return import("node:http").then(({ createServer }) => new Promise((resolvePromise) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolvePromise({ url: `http://127.0.0.1:${port}/v1`, close: () => server.close() });
    });
  }));
}

async function startGatewayWith(
  gatewayJson: Record<string, unknown>,
  llmContent: string,
  fetcher?: typeof fetch,
): Promise<{ cwd: string; port: number; close: () => Promise<void>; llmClose: () => void }> {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-wave2-"));
  await mkdir(join(cwd, ".muster"), { recursive: true });
  await writeFile(gatewayConfigPath(cwd), JSON.stringify({ token: "test-token", ...gatewayJson }));
  const gateway = await loadGatewayConfig(cwd);
  const llm = await startStubLlm(llmContent);
  const running = await startGatewayServer({ config: stubConfig(llm.url), gateway, cwd, fetcher }, 0);
  return { cwd, port: running.port, close: running.close, llmClose: llm.close };
}

test("discord webhook answers PING with PONG and commands with a sync interaction response", async () => {
  const gw = await startGatewayWith({ discord: { botToken: "discord-bot-token" } }, "deploy v42 shipped");
  try {
    const ping = await fetch(`http://127.0.0.1:${gw.port}/v1/adapters/discord`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify(discordPing),
    });
    assert.equal(ping.status, 200);
    assert.deepEqual(await ping.json(), { type: 1 });

    await requestPairing("discord:290926798626357999", "53908232506183680", gw.cwd).then((pending) => approvePairing(pending.code, gw.cwd));
    const command = await fetch(`http://127.0.0.1:${gw.port}/v1/adapters/discord`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify(discordCommand),
    });
    assert.equal(command.status, 200);
    assert.deepEqual(await command.json(), { type: 4, data: { content: "deploy v42 shipped" } });
  } finally {
    await gw.close();
    gw.llmClose();
  }
});

test("discord webhook with publicKey configured verifies signed requests and 401s unsigned/tampered ones", async () => {
  const keys = discordTestKeys();
  const gw = await startGatewayWith({ discord: { botToken: "discord-bot-token", publicKey: keys.publicKeyHex } }, "deploy v42 shipped");
  try {
    const body = JSON.stringify(discordPing);
    const timestamp = String(Math.floor(Date.now() / 1000));

    const signed = await fetch(`http://127.0.0.1:${gw.port}/v1/adapters/discord`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-ed25519": keys.signFor(timestamp, body),
        "x-signature-timestamp": timestamp,
      },
      body,
    });
    assert.equal(signed.status, 200);
    assert.deepEqual(await signed.json(), { type: 1 });

    // No signature headers -> 401.
    const unsigned = await fetch(`http://127.0.0.1:${gw.port}/v1/adapters/discord`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.equal(unsigned.status, 401);

    // Signature over a different body -> 401 (raw-body tamper detection).
    const tampered = await fetch(`http://127.0.0.1:${gw.port}/v1/adapters/discord`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-ed25519": keys.signFor(timestamp, body),
        "x-signature-timestamp": timestamp,
      },
      body: JSON.stringify({ ...discordPing, type: 2 }),
    });
    assert.equal(tampered.status, 401);
  } finally {
    await gw.close();
    gw.llmClose();
  }
});

test("whatsapp webhook: GET verification handshake echoes hub.challenge as plain text", async () => {
  const gw = await startGatewayWith({
    whatsapp: { accessToken: "EAAG-token", verifyToken: "secret-verify", phoneNumberId: "106540352242922" },
  }, "unused");
  try {
    const ok = await fetch(`http://127.0.0.1:${gw.port}/v1/adapters/whatsapp?hub.mode=subscribe&hub.verify_token=secret-verify&hub.challenge=1158201444`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "1158201444");

    const bad = await fetch(`http://127.0.0.1:${gw.port}/v1/adapters/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1158201444`);
    assert.equal(bad.status, 403);
  } finally {
    await gw.close();
    gw.llmClose();
  }
});

test("whatsapp webhook posts governed reply to graph.facebook.com via injected fetcher", async () => {
  const outbound: Array<{ url: string; auth?: string; body: unknown }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    outbound.push({ url: String(url), auth: headers?.authorization, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), { status: 200 });
  }) as typeof fetch;
  const gw = await startGatewayWith({
    whatsapp: { accessToken: "EAAG-token", verifyToken: "secret-verify", phoneNumberId: "106540352242922" },
  }, "12 episodes today", fetcher);
  try {
    await requestPairing("whatsapp:106540352242922", "919812345678", gw.cwd).then((pending) => approvePairing(pending.code, gw.cwd));
    const response = await fetch(`http://127.0.0.1:${gw.port}/v1/adapters/whatsapp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify(whatsAppNotification),
    });
    assert.equal(response.status, 200);
    assert.equal(outbound.length, 1);
    assert.equal(outbound[0].url, "https://graph.facebook.com/v19.0/106540352242922/messages");
    assert.equal(outbound[0].auth, "Bearer EAAG-token");
    const body = outbound[0].body as { to: string; text: { body: string } };
    assert.equal(body.to, "919812345678");
    assert.equal(body.text.body, "12 episodes today");

    const retry = await fetch(`http://127.0.0.1:${gw.port}/v1/adapters/whatsapp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify(whatsAppNotification),
    });
    assert.equal(retry.status, 200);
    assert.equal(outbound.length, 1, "WhatsApp retry with the same message id must not double-send or spend tokens twice");
  } finally {
    await gw.close();
    gw.llmClose();
  }
});

test("gchat webhook checks the verification token and replies synchronously", async () => {
  const gw = await startGatewayWith({ gchat: { verificationToken: "gchat-verification-token" } }, "2 flows pending");
  try {
    await requestPairing("gchat:app", "users/103284139", gw.cwd).then((pending) => approvePairing(pending.code, gw.cwd));
    const response = await fetch(`http://127.0.0.1:${gw.port}/v1/adapters/gchat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(gchatMessageEvent),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { text: string; thread?: { name: string } };
    assert.equal(body.text, "2 flows pending");
    assert.deepEqual(body.thread, { name: "spaces/AAAAAAAAAAA/threads/BBBBBBBBBBB" });

    const forged = await fetch(`http://127.0.0.1:${gw.port}/v1/adapters/gchat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...gchatMessageEvent, token: "forged" }),
    });
    assert.equal(forged.status, 401);
  } finally {
    await gw.close();
    gw.llmClose();
  }
});

test("teams webhook validates HMAC and replies synchronously", async () => {
  const secret = Buffer.from("teams-shared-secret").toString("base64");
  const gw = await startGatewayWith({ teams: { hmacSecret: secret } }, "ledger: 48,112 tokens today");
  try {
    await requestPairing(
      "teams:4dcaf6e7-c4d3-44a5-8ad1-ee3b92baf4a5",
      "29:1bSnHZ7Js2STWrgk6ScEErLk1Lp2zQuD5H2qQ960rtvqKz",
      gw.cwd,
    ).then((pending) => approvePairing(pending.code, gw.cwd));

    const body = JSON.stringify(teamsActivity);
    const signature = createHmac("sha256", Buffer.from(secret, "base64")).update(body, "utf8").digest("base64");
    const response = await fetch(`http://127.0.0.1:${gw.port}/v1/adapters/teams`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `HMAC ${signature}` },
      body,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { type: "message", text: "ledger: 48,112 tokens today" });

    const unsigned = await fetch(`http://127.0.0.1:${gw.port}/v1/adapters/teams`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.equal(unsigned.status, 401);
  } finally {
    await gw.close();
    gw.llmClose();
  }
});
