import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dataDir, defaultConfig, getFlowRun, runFlow, type FlowToolRegistry } from "@musterhq/core";
import {
  approvePairing,
  createApprovalActionCodec,
  createInMemoryGatewayEnterpriseRuntime,
  handleSurfaceMessage,
  requestPairing,
  SqliteApprovalActionStore,
  surfaceReplyToTelegramSend,
  startGatewayServer,
  telegramUpdateToSurfaceMessage,
} from "../src/index.js";

test("approval execution recovery is exclusively leased across gateway stores", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-approval-lease-"));
  const filename = join(cwd, "approval.db");
  const first = new SqliteApprovalActionStore(filename);
  const second = new SqliteApprovalActionStore(filename);
  try {
    const now = Date.now();
    const codec = createApprovalActionCodec({
      secret: Buffer.alloc(32, 4),
      store: first,
      now: () => now,
      idFactory: () => "approval_lease_1",
    });
    const tokens = codec.issue({
      actorId: "user-1",
      surfaceId: "telegram:bot",
      conversationId: "chat-1",
      runId: "run-1",
      gateId: "gate-1",
      revision: "revision-1",
      expiresAt: now + 60_000,
    });
    assert.ok(tokens);
    assert.equal(codec.parse(tokens.approve, {
      actorId: "user-1",
      surfaceId: "telegram:bot",
      conversationId: "chat-1",
    }).ok, true);

    const firstClaims = first.claimPending("worker-a", now + 1, 60_000);
    const secondClaims = second.claimPending("worker-b", now + 1, 60_000);
    assert.equal(firstClaims.length, 1);
    assert.equal(firstClaims[0].binding.id, "approval_lease_1");
    assert.equal(secondClaims.length, 0, "only one gateway process may own approval recovery");
  } finally {
    first.close();
    second.close();
  }
});

test("verified channel approval resumes only its current gate and leaves a durable execution receipt", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-approval-server-"));
  const registry: FlowToolRegistry = { echo: async (args) => args };
  const pending = await runFlow({
    id: "channel-gate",
    steps: [
      { id: "prepare", kind: "tool", tool: "echo", args: { result: "ready" } },
      { id: "authorize", kind: "gate", show: "prepare.result" },
      { id: "apply", kind: "tool", tool: "echo", args: { applied: true } },
    ],
  }, { config: defaultConfig(), registry, cwd });
  assert.equal(pending.status, "awaiting_approval");
  assert.equal(pending.gateId, "authorize");

  const store = new SqliteApprovalActionStore(join(cwd, ".muster", "approval.db"));
  const enterprise = createInMemoryGatewayEnterpriseRuntime();
  const codec = createApprovalActionCodec({ secret: Buffer.alloc(32, 7), store });
  const revision = createHash("sha256").update(JSON.stringify([pending.runId, pending.gateId, pending.show])).digest("hex");
  const rendered = surfaceReplyToTelegramSend({
    text: "Review this action",
    approvalRequest: { runId: pending.runId, gateId: pending.gateId!, show: pending.show, options: ["approve", "reject"] },
  }, "chat-7", {
    approvalAction: {
      codec,
      actorId: "user-9",
      surfaceId: "telegram:bot",
      conversationId: "chat-7",
      runId: pending.runId,
      gateId: pending.gateId!,
      revision,
      expiresAt: Date.now() + 60_000,
    },
  });
  const token = rendered.reply_markup?.inline_keyboard[0][0].callback_data;
  assert.ok(token);

  const inbound = telegramUpdateToSurfaceMessage({
    update_id: 99,
    callback_query: {
      id: "callback-99",
      from: { id: "user-9" },
      data: token,
      message: { message_id: 8, chat: { id: "chat-7" } },
    },
  }, { approvalActions: codec });
  assert.ok(inbound);
  const pairing = await requestPairing("telegram:bot", "user-9", cwd);
  await approvePairing(pairing.code, cwd);

  const reply = await handleSurfaceMessage(inbound!, {
    config: defaultConfig(),
    gateway: { token: "test" },
    enterprise,
    approvalActions: codec,
    approvalStore: store,
    registry,
    cwd,
  });
  assert.match("text" in reply ? reply.text : "", /Approval accepted/);
  assert.equal((await getFlowRun(pending.runId, cwd)).status, "completed");
  assert.equal(store.listPending().length, 0);
  const receipts = await enterprise.receiptStore.listReceipts();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].action, "approval.approve");
  assert.equal(receipts[0].outcome, "completed");
  assert.equal(JSON.stringify(receipts).includes("Review this action"), false, "approval audit receipts must not persist gate content");

  const replay = telegramUpdateToSurfaceMessage({
    update_id: 100,
    callback_query: {
      id: "callback-100",
      from: { id: "user-9" },
      data: token,
      message: { message_id: 8, chat: { id: "chat-7" } },
    },
  }, { approvalActions: codec });
  assert.ok(replay);
  const replayReply = await handleSurfaceMessage(replay!, {
    config: defaultConfig(),
    gateway: { token: "test" },
    enterprise,
    approvalActions: codec,
    approvalStore: store,
    registry,
    cwd,
  });
  assert.match("text" in replayReply ? replayReply.text : "", /replay/);
  assert.equal((await getFlowRun(pending.runId, cwd)).status, "completed", "a consumed approval cannot execute twice");
  store.close();
});

test("gateway startup recovers an approval consumed before execution", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-approval-recovery-"));
  const registry: FlowToolRegistry = { echo: async (args) => args };
  const pending = await runFlow({
    id: "recover-gate",
    steps: [
      { id: "prepare", kind: "tool", tool: "echo", args: { message: "recover this" } },
      { id: "gate", kind: "gate", show: "prepare.message" },
      { id: "after", kind: "tool", tool: "echo", args: { recovered: true } },
    ],
  }, { config: defaultConfig(), registry, cwd });
  const filename = join(dataDir(cwd), "enterprise-control-plane.db");
  const store = new SqliteApprovalActionStore(filename);
  const codec = createApprovalActionCodec({ secret: Buffer.alloc(32, 9), store });
  const revision = createHash("sha256").update(JSON.stringify([pending.runId, pending.gateId, pending.show])).digest("hex");
  const tokens = codec.issue({
    actorId: "user-recovery",
    surfaceId: "telegram:bot",
    conversationId: "chat-recovery",
    runId: pending.runId,
    gateId: pending.gateId!,
    revision,
    expiresAt: Date.now() + 60_000,
  });
  assert.ok(tokens);
  assert.equal(codec.parse(tokens.approve, {
    actorId: "user-recovery",
    surfaceId: "telegram:bot",
    conversationId: "chat-recovery",
  }).ok, true);
  assert.equal(store.listPending().length, 1);
  store.close();
  const pairing = await requestPairing("telegram:bot", "user-recovery", cwd);
  await approvePairing(pairing.code, cwd);

  const running = await startGatewayServer({
    config: defaultConfig(),
    gateway: { token: "a".repeat(48) },
    registry,
    cwd,
  }, 0);
  try {
    assert.equal((await getFlowRun(pending.runId, cwd)).status, "completed");
    const recovered = new SqliteApprovalActionStore(filename);
    assert.equal(recovered.listPending().length, 0);
    recovered.close();
  } finally {
    await running.close();
  }
});

test("gateway recovery refuses a consumed approval when the actor is not paired", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-approval-recovery-unpaired-"));
  const registry: FlowToolRegistry = { echo: async (args) => args };
  const pending = await runFlow({
    id: "recover-unpaired-gate",
    steps: [
      { id: "prepare", kind: "tool", tool: "echo", args: { message: "do not recover" } },
      { id: "gate", kind: "gate", show: "prepare.message" },
      { id: "after", kind: "tool", tool: "echo", args: { unsafe: true } },
    ],
  }, { config: defaultConfig(), registry, cwd });
  const filename = join(dataDir(cwd), "enterprise-control-plane.db");
  const store = new SqliteApprovalActionStore(filename);
  const codec = createApprovalActionCodec({ secret: Buffer.alloc(32, 11), store });
  const revision = createHash("sha256").update(JSON.stringify([pending.runId, pending.gateId, pending.show])).digest("hex");
  const tokens = codec.issue({
    actorId: "revoked-user",
    surfaceId: "telegram:bot",
    conversationId: "chat-revoked",
    runId: pending.runId,
    gateId: pending.gateId!,
    revision,
    expiresAt: Date.now() + 60_000,
  });
  assert.ok(tokens);
  assert.equal(codec.parse(tokens.approve, {
    actorId: "revoked-user",
    surfaceId: "telegram:bot",
    conversationId: "chat-revoked",
  }).ok, true);
  store.close();

  const running = await startGatewayServer({ config: defaultConfig(), gateway: { token: "b".repeat(48) }, registry, cwd }, 0);
  try {
    assert.equal((await getFlowRun(pending.runId, cwd)).status, "awaiting_approval");
    const recovered = new SqliteApprovalActionStore(filename);
    assert.equal(recovered.listPending().length, 0, "the unauthorized decision is terminally failed, not retried later");
    recovered.close();
  } finally {
    await running.close();
  }
});
