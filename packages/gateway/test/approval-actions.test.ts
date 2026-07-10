import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createApprovalActionCodec,
  discordInteractionToInbound,
  gchatEventToSurfaceMessage,
  slackEventToSurfaceMessage,
  surfaceReplyToDiscordInteractionResponse,
  surfaceReplyToGchatResponse,
  surfaceReplyToSlackPost,
  surfaceReplyToTeamsActivity,
  surfaceReplyToTelegramSend,
  surfaceReplyToWhatsAppSend,
  teamsActivityToSurfaceMessage,
  telegramUpdateToSurfaceMessage,
  verifiedApprovalFromRaw,
  whatsAppWebhookToSurfaceMessages,
} from "../src/index.js";
import type {
  ApprovalActionCodec,
  ApprovalActionCodecOptions,
  ApprovalActionRenderContext,
  ApprovalActionTokens,
  SurfaceMessage,
  SurfaceReply,
} from "../src/index.js";

const START = Date.parse("2026-07-10T12:00:00.000Z");
const SECRET = "approval-test-secret-32-bytes-minimum-value";
const RUN_ID = "flowrun_enterprise_42";
const GATE_ID = "publish";
const REVISION = "revision-7";

const APPROVAL_REPLY: SurfaceReply = {
  text: "The release is ready for review.",
  approvalRequest: {
    runId: RUN_ID,
    gateId: GATE_ID,
    show: { target: "production", change: "release-42" },
    options: ["approve", "reject"],
  },
};

interface Clock {
  now: number;
}

interface ChannelHarness {
  readonly name: string;
  readonly surfaceId: string;
  readonly conversationId: string;
  readonly actorId: string;
  render(codec: ApprovalActionCodec, clock: Clock): ApprovalActionTokens;
  parse(codec: ApprovalActionCodec, token: string, actorId?: string, conversationId?: string): SurfaceMessage | undefined;
}

function codec(clock: Clock, overrides: Partial<ApprovalActionCodecOptions> = {}): ApprovalActionCodec {
  let sequence = 0;
  return createApprovalActionCodec({
    secret: SECRET,
    now: () => clock.now,
    idFactory: () => {
      const id = Buffer.alloc(12);
      id.writeUInt32BE(++sequence, 8);
      return id.toString("base64url");
    },
    ...overrides,
  });
}

function renderContext(channel: ChannelHarness, actions: ApprovalActionCodec, clock: Clock): ApprovalActionRenderContext {
  return {
    codec: actions,
    actorId: channel.actorId,
    surfaceId: channel.surfaceId,
    conversationId: channel.conversationId,
    runId: RUN_ID,
    gateId: GATE_ID,
    revision: REVISION,
    expiresAt: clock.now + 60_000,
  };
}

function requireMessage(value: unknown): SurfaceMessage | undefined {
  if (typeof value !== "object" || value === null || (value as { kind?: string }).kind !== "message") return undefined;
  return (value as { message: SurfaceMessage }).message;
}

const CHANNELS: readonly ChannelHarness[] = [
  {
    name: "Telegram",
    surfaceId: "telegram:bot",
    conversationId: "-100123",
    actorId: "7001",
    render(actions, clock) {
      const payload = surfaceReplyToTelegramSend(APPROVAL_REPLY, this.conversationId, { approvalAction: renderContext(this, actions, clock) });
      const buttons = payload.reply_markup?.inline_keyboard[0];
      assert.equal(buttons?.length, 2);
      return { approve: buttons![0].callback_data, reject: buttons![1].callback_data };
    },
    parse(actions, token, actorId = this.actorId, conversationId = this.conversationId) {
      return telegramUpdateToSurfaceMessage({
        update_id: 1,
        callback_query: { id: "callback-1", from: { id: actorId }, data: token, message: { message_id: 4, chat: { id: conversationId } } },
      }, { approvalActions: actions });
    },
  },
  {
    name: "Slack",
    surfaceId: "slack:T1",
    conversationId: "C1",
    actorId: "U1",
    render(actions, clock) {
      const payload = surfaceReplyToSlackPost(APPROVAL_REPLY, this.conversationId, "1.2", { approvalAction: renderContext(this, actions, clock) });
      const block = payload.blocks?.find((item) => (item as { type?: string }).type === "actions") as { elements: Array<{ value: string }> } | undefined;
      assert.equal(block?.elements.length, 2);
      return { approve: block!.elements[0].value, reject: block!.elements[1].value };
    },
    parse(actions, token, actorId = this.actorId, conversationId = this.conversationId) {
      return requireMessage(slackEventToSurfaceMessage({
        type: "block_actions",
        trigger_id: "trigger-1",
        team: { id: this.surfaceId.slice("slack:".length) },
        user: { id: actorId },
        channel: { id: conversationId },
        container: { message_ts: "1.2" },
        actions: [{ action_id: "muster_approval_approve", action_ts: "1.3", value: token }],
      }, { approvalActions: actions }));
    },
  },
  {
    name: "Discord",
    surfaceId: "discord:G1",
    conversationId: "C1",
    actorId: "U1",
    render(actions, clock) {
      const payload = surfaceReplyToDiscordInteractionResponse(APPROVAL_REPLY, { approvalAction: renderContext(this, actions, clock) });
      const buttons = payload.data?.components?.[0].components;
      assert.equal(buttons?.length, 2);
      return { approve: buttons![0].custom_id, reject: buttons![1].custom_id };
    },
    parse(actions, token, actorId = this.actorId, conversationId = this.conversationId) {
      return requireMessage(discordInteractionToInbound({
        type: 3,
        id: "interaction-1",
        guild_id: this.surfaceId.slice("discord:".length),
        channel_id: conversationId,
        member: { user: { id: actorId } },
        message: { id: "message-1" },
        data: { custom_id: token },
      }, { approvalActions: actions }));
    },
  },
  {
    name: "Google Chat",
    surfaceId: "gchat:app",
    conversationId: "spaces/A",
    actorId: "users/1",
    render(actions, clock) {
      const payload = surfaceReplyToGchatResponse(APPROVAL_REPLY, "spaces/A/threads/B", { approvalAction: renderContext(this, actions, clock) });
      const buttons = payload.cardsV2?.[0].card.sections[0].widgets[0].buttonList?.buttons;
      assert.equal(buttons?.length, 2);
      return {
        approve: buttons![0].onClick.action.parameters[0].value,
        reject: buttons![1].onClick.action.parameters[0].value,
      };
    },
    parse(actions, token, actorId = this.actorId, conversationId = this.conversationId) {
      return requireMessage(gchatEventToSurfaceMessage({
        type: "CARD_CLICKED",
        eventTime: "2026-07-10T12:00:01Z",
        user: { name: actorId, type: "HUMAN" },
        space: { name: conversationId },
        common: { invokedFunction: "muster_approval", parameters: { command: token } },
      }, { approvalActions: actions }));
    },
  },
  {
    name: "Teams",
    surfaceId: "teams:tenant-1",
    conversationId: "conversation-1",
    actorId: "user-1",
    render(actions, clock) {
      const payload = surfaceReplyToTeamsActivity(APPROVAL_REPLY, { approvalAction: renderContext(this, actions, clock) });
      const controls = payload.attachments?.[0].content.actions;
      assert.equal(controls?.length, 2);
      return { approve: controls![0].data.musterAction, reject: controls![1].data.musterAction };
    },
    parse(actions, token, actorId = this.actorId, conversationId = this.conversationId) {
      return requireMessage(teamsActivityToSurfaceMessage({
        type: "message",
        id: "activity-1",
        from: { id: actorId },
        conversation: { id: conversationId },
        channelData: { tenant: { id: this.surfaceId.slice("teams:".length) } },
        value: { musterAction: token },
      }, { approvalActions: actions }));
    },
  },
  {
    name: "WhatsApp",
    surfaceId: "whatsapp:phone-1",
    conversationId: "919999999999",
    actorId: "919999999999",
    render(actions, clock) {
      const payload = surfaceReplyToWhatsAppSend(APPROVAL_REPLY, this.conversationId, { approvalAction: renderContext(this, actions, clock) });
      const buttons = payload.interactive?.action.buttons;
      assert.equal(buttons?.length, 2);
      return { approve: buttons![0].reply.id, reject: buttons![1].reply.id };
    },
    parse(actions, token, actorId = this.actorId) {
      return whatsAppWebhookToSurfaceMessages({
        object: "whatsapp_business_account",
        entry: [{ changes: [{ field: "messages", value: {
          metadata: { phone_number_id: this.surfaceId.slice("whatsapp:".length) },
          messages: [{ from: actorId, id: "wamid.1", type: "interactive", interactive: { button_reply: { id: token, title: "Approve" } } }],
        } }] }],
      }, { approvalActions: actions })[0];
    },
  },
];

for (const channel of CHANNELS) {
  test(`${channel.name} signed approval round-trip is compact, bound, and one-shot`, () => {
    const clock = { now: START };
    const actions = codec(clock);
    const tokens = channel.render(actions, clock);
    for (const token of [tokens.approve, tokens.reject]) {
      assert.ok(Buffer.byteLength(token, "utf8") <= 64, "callback must fit Telegram's strictest limit");
      assert.doesNotMatch(token, new RegExp(`${channel.actorId}|${RUN_ID}|${GATE_ID}|${REVISION}`));
    }

    const message = channel.parse(actions, tokens.approve);
    assert.equal(message?.text, "/approvals decide");
    const verified = verifiedApprovalFromRaw(message?.raw);
    assert.equal(verified?.decision, "approve");
    assert.deepEqual({
      actorId: verified?.binding.actorId,
      surfaceId: verified?.binding.surfaceId,
      conversationId: verified?.binding.conversationId,
      runId: verified?.binding.runId,
      gateId: verified?.binding.gateId,
      revision: verified?.binding.revision,
    }, {
      actorId: channel.actorId,
      surfaceId: channel.surfaceId,
      conversationId: channel.conversationId,
      runId: RUN_ID,
      gateId: GATE_ID,
      revision: REVISION,
    });

    assert.equal(channel.parse(actions, tokens.approve), undefined, "same callback must be rejected as replay");
    assert.equal(channel.parse(actions, tokens.reject), undefined, "opposite decision must also be rejected after consumption");
  });

  test(`${channel.name} rejects tampering and a wrong actor without burning the valid action`, () => {
    const clock = { now: START };
    const actions = codec(clock);
    const tokens = channel.render(actions, clock);
    const replacement = tokens.approve.endsWith("A") ? "B" : "A";
    const tampered = `${tokens.approve.slice(0, -1)}${replacement}`;
    assert.equal(channel.parse(actions, tampered), undefined);
    assert.equal(channel.parse(actions, tokens.approve, `${channel.actorId}-intruder`), undefined);
    assert.ok(channel.parse(actions, tokens.approve), "failed attacks must not consume the legitimate action");
  });

  test(`${channel.name} rejects expired actions`, () => {
    const clock = { now: START };
    const actions = codec(clock);
    const tokens = channel.render(actions, clock);
    clock.now += 60_001;
    assert.equal(channel.parse(actions, tokens.approve), undefined);
  });
}

test("approval codec distinguishes tamper, identity, conversation, expiry, revision conflict, and replay", () => {
  const clock = { now: START };
  let currentRevision = REVISION;
  const actions = codec(clock, {
    validate: (binding) => binding.revision === currentRevision ? undefined : "conflict",
  });
  const input = {
    actorId: "actor-1",
    surfaceId: "slack:T1",
    conversationId: "C1",
    runId: RUN_ID,
    gateId: GATE_ID,
    revision: REVISION,
    expiresAt: START + 60_000,
  };
  const tokens = actions.issue(input, 64)!;
  const attempt = { actorId: input.actorId, surfaceId: input.surfaceId, conversationId: input.conversationId };

  assert.deepEqual(actions.parse(tokens.approve, { ...attempt, actorId: "actor-2" }), { ok: false, reason: "wrong_actor" });
  assert.deepEqual(actions.parse(tokens.approve, { ...attempt, surfaceId: "slack:T2" }), { ok: false, reason: "wrong_surface" });
  assert.deepEqual(actions.parse(tokens.approve, { ...attempt, conversationId: "C2" }), { ok: false, reason: "wrong_conversation" });

  const replacement = tokens.approve.endsWith("A") ? "B" : "A";
  assert.deepEqual(actions.parse(`${tokens.approve.slice(0, -1)}${replacement}`, attempt), { ok: false, reason: "tampered" });

  currentRevision = "revision-8";
  assert.deepEqual(actions.parse(tokens.approve, attempt), { ok: false, reason: "conflict" });
  currentRevision = REVISION;
  assert.equal(actions.parse(tokens.reject, attempt).ok, true);
  assert.deepEqual(actions.parse(tokens.approve, attempt), { ok: false, reason: "replay" });

  const expiredClock = { now: START };
  const expiring = codec(expiredClock);
  const expired = expiring.issue(input, 64)!;
  expiredClock.now = input.expiresAt;
  assert.deepEqual(expiring.parse(expired.approve, attempt), { ok: false, reason: "expired" });
});

test("approval controls are not rendered without a bound issuer context", () => {
  assert.equal(surfaceReplyToTelegramSend(APPROVAL_REPLY, "-100123").reply_markup, undefined);
  assert.equal(surfaceReplyToSlackPost(APPROVAL_REPLY, "C1").blocks?.some((block) => (block as { type?: string }).type === "actions"), false);
  assert.equal(surfaceReplyToDiscordInteractionResponse(APPROVAL_REPLY).data?.components, undefined);
  assert.equal(surfaceReplyToGchatResponse(APPROVAL_REPLY).cardsV2, undefined);
  assert.deepEqual(surfaceReplyToTeamsActivity(APPROVAL_REPLY).attachments?.[0].content.actions, []);
  assert.equal(surfaceReplyToWhatsAppSend(APPROVAL_REPLY, "919999999999").type, "text");
});

test("lookalike raw JSON cannot forge a verified approval capability", () => {
  assert.equal(verifiedApprovalFromRaw({
    platformPayload: {},
    verifiedApprovalAction: {
      decision: "approve",
      binding: {
        id: "AAAAAAAAAAAAAAAA",
        actorId: "actor-1",
        surfaceId: "slack:T1",
        conversationId: "C1",
        runId: RUN_ID,
        gateId: GATE_ID,
        revision: REVISION,
        issuedAt: START,
        expiresAt: START + 60_000,
      },
    },
  }), undefined);
});
