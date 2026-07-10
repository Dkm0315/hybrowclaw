import { createHmac, timingSafeEqual } from "node:crypto";
import { isPairingChallenge } from "../envelope.js";
import type { PairingChallenge, SurfaceMessage, SurfaceReply } from "../envelope.js";
import {
  approvalFallbackText,
  bindSurfaceAction,
  issueApprovalActions,
  parseSurfaceAction,
  pendingApprovalSurfaceFields,
  presentationActions,
  renderPresentationText,
  sanitizePresentationForAudience,
} from "../presentation.js";
import type { ApprovalActionParser, ApprovalActionRenderContext } from "../presentation.js";

/**
 * Slack Events API adapter: PURE mappers only (no network). The gateway
 * server receives events on POST /v1/adapters/slack and posts replies to
 * https://slack.com/api/chat.postMessage with the bot token.
 */

/** Reject Slack webhooks whose timestamp is older than this (replay window). */
export const SLACK_REPLAY_WINDOW_SECONDS = 5 * 60;

/**
 * Verify a Slack request signature (https://api.slack.com/authentication/verifying-requests-from-slack).
 * Slack signs `v0:{timestamp}:{rawBody}` with the app signing secret using
 * HMAC-SHA256 and sends `v0=<hex>` in X-Slack-Signature, with the timestamp in
 * X-Slack-Request-Timestamp. Returns false on any missing/malformed input, on
 * signature mismatch, or when the timestamp is outside the replay window.
 * The comparison is constant-time. `now` is injectable for tests.
 */
export function slackSignatureIsValid(
  timestamp: string | undefined,
  rawBody: string,
  signature: string | undefined,
  secret: string,
  now: number = Date.now(),
): boolean {
  if (!timestamp || !signature || !secret) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  // Reject stale requests (replay protection). Math.abs guards against clock skew both ways.
  if (Math.abs(now / 1000 - ts) > SLACK_REPLAY_WINDOW_SECONDS) return false;
  const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`, "utf8").digest("hex")}`;
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export type SlackInbound =
  | { readonly kind: "url_verification"; readonly challenge: string }
  | { readonly kind: "message"; readonly message: SurfaceMessage }
  | { readonly kind: "ignored"; readonly reason: string };

export interface SlackMappingOptions {
  readonly approvalActions?: ApprovalActionParser;
}

export interface SlackRenderOptions {
  readonly approvalAction?: ApprovalActionRenderContext;
}

interface SlackEnvelope {
  readonly type?: string;
  readonly challenge?: string;
  readonly event_id?: string;
  readonly team_id?: string;
  readonly event?: {
    readonly type?: string;
    readonly subtype?: string;
    readonly bot_id?: string;
    readonly user?: string;
    readonly text?: string;
    readonly channel?: string;
    readonly ts?: string;
    readonly thread_ts?: string;
  };
}

interface SlackActionEnvelope {
  readonly type?: "block_actions";
  readonly trigger_id?: string;
  readonly team?: { readonly id?: string };
  readonly user?: { readonly id?: string };
  readonly channel?: { readonly id?: string };
  readonly container?: { readonly channel_id?: string; readonly message_ts?: string; readonly thread_ts?: string };
  readonly actions?: ReadonlyArray<{ readonly action_id?: string; readonly action_ts?: string; readonly value?: string }>;
}

interface SlackSlashCommand {
  readonly command?: string;
  readonly text?: string;
  readonly trigger_id?: string;
  readonly team_id?: string;
  readonly user_id?: string;
  readonly channel_id?: string;
}

export function slackDeliveryId(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const eventId = (payload as SlackEnvelope).event_id;
  if (typeof eventId === "string" && eventId) return eventId;
  const action = payload as SlackActionEnvelope;
  if (action.type === "block_actions") {
    const selected = action.actions?.[0];
    return action.trigger_id || [action.container?.message_ts, selected?.action_ts, selected?.action_id].filter(Boolean).join(":") || undefined;
  }
  const slash = payload as SlackSlashCommand;
  return slash.trigger_id || undefined;
}

/** Map a Slack Events API request body to the gateway envelope. */
export function slackEventToSurfaceMessage(payload: unknown, options: SlackMappingOptions = {}): SlackInbound {
  if (typeof payload !== "object" || payload === null) {
    return { kind: "ignored", reason: "payload is not an object" };
  }
  const action = payload as SlackActionEnvelope;
  if (action.type === "block_actions") {
    const selected = action.actions?.[0];
    const channel = action.channel?.id ?? action.container?.channel_id;
    const approval = action.user?.id && channel
      ? pendingApprovalSurfaceFields(options.approvalActions, selected?.value, {
        actorId: action.user.id,
        surfaceId: `slack:${action.team?.id ?? "unknown-team"}`,
        conversationId: channel,
      }, payload)
      : undefined;
    const command = approval?.text ?? parseSurfaceAction(selected?.value);
    if (!command || !action.user?.id || !channel) return { kind: "ignored", reason: "block action is missing a bound command, user, or channel" };
    return {
      kind: "message",
      message: {
        surfaceId: `slack:${action.team?.id ?? "unknown-team"}`,
        conversationId: channel,
        senderId: action.user.id,
        text: command,
        replyTo: action.container?.thread_ts ?? action.container?.message_ts,
        raw: approval?.raw ?? payload,
      },
    };
  }
  const slash = payload as SlackSlashCommand;
  if (typeof slash.command === "string" && slash.command.startsWith("/") && slash.user_id && slash.channel_id) {
    const text = `${slash.command}${slash.text?.trim() ? ` ${slash.text.trim()}` : ""}`;
    return {
      kind: "message",
      message: {
        surfaceId: `slack:${slash.team_id ?? "unknown-team"}`,
        conversationId: slash.channel_id,
        senderId: slash.user_id,
        text,
        raw: payload,
      },
    };
  }
  const envelope = payload as SlackEnvelope;
  if (envelope.type === "url_verification") {
    if (typeof envelope.challenge !== "string") return { kind: "ignored", reason: "url_verification without challenge" };
    return { kind: "url_verification", challenge: envelope.challenge };
  }
  if (envelope.type !== "event_callback" || !envelope.event) {
    return { kind: "ignored", reason: `unsupported envelope type: ${String(envelope.type)}` };
  }
  const event = envelope.event;
  if (event.bot_id || event.subtype === "bot_message") {
    return { kind: "ignored", reason: "bot messages are not surfaced (echo guard)" };
  }
  if (event.type !== "message" && event.type !== "app_mention") {
    return { kind: "ignored", reason: `unsupported event type: ${String(event.type)}` };
  }
  if (!event.user || !event.channel || typeof event.text !== "string" || !event.text.trim()) {
    return { kind: "ignored", reason: "event is missing user, channel, or text" };
  }
  return {
    kind: "message",
    message: {
      surfaceId: `slack:${envelope.team_id ?? "unknown-team"}`,
      conversationId: event.channel,
      senderId: event.user,
      text: event.text,
      replyTo: event.thread_ts ?? event.ts,
      raw: payload,
    },
  };
}

export interface SlackPostMessagePayload {
  readonly channel: string;
  readonly text: string;
  readonly thread_ts?: string;
  readonly blocks?: readonly unknown[];
}

/** Map a gateway reply (or pairing challenge) to a chat.postMessage payload. */
export function surfaceReplyToSlackPost(
  reply: SurfaceReply | PairingChallenge,
  channel: string,
  threadTs?: string,
  options: SlackRenderOptions = {},
): SlackPostMessagePayload {
  if (isPairingChallenge(reply)) {
    return {
      channel,
      thread_ts: threadTs,
      text: `This sender is not paired with Muster yet. Ask an operator to run: \`muster pairing approve ${reply.code}\``,
    };
  }
  if (reply.approvalRequest) {
    const { runId, gateId, show } = reply.approvalRequest;
    const shown = typeof show === "string" ? show : JSON.stringify(show, null, 2);
    const actions = issueApprovalActions(reply.approvalRequest, options.approvalAction, 64);
    return {
      channel,
      thread_ts: threadTs,
      text: `Approval required (gate "${gateId}", run ${runId}). ${approvalFallbackText(Boolean(actions))}`,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: `${reply.text ? `${reply.text}\n\n` : ""}*Approval required* (gate \`${gateId}\`, run \`${runId}\`):\n\`\`\`${shown}\`\`\`\n${approvalFallbackText(Boolean(actions))}` },
        },
        ...(actions ? [{
          type: "actions",
          elements: [
            { type: "button", text: { type: "plain_text", text: "Approve" }, style: "primary", action_id: "muster_approval_approve", value: actions.approve },
            { type: "button", text: { type: "plain_text", text: "Reject" }, style: "danger", action_id: "muster_approval_reject", value: actions.reject },
          ],
        }] : []),
      ],
    };
  }
  if (reply.presentation) {
    const presentation = sanitizePresentationForAudience(reply.presentation);
    const blocks: unknown[] = [
      { type: "header", text: { type: "plain_text", text: presentation.title.slice(0, 150) } },
      { type: "section", text: { type: "mrkdwn", text: escapeSlack(presentation.summary) } },
    ];
    if (presentation.kpis?.length) {
      blocks.push({
        type: "section",
        fields: presentation.kpis.slice(0, 10).map((kpi) => ({ type: "mrkdwn", text: `*${escapeSlack(kpi.label)}*\n${escapeSlack(kpi.value)}${kpi.detail ? `\n_${escapeSlack(kpi.detail)}_` : ""}` })),
      });
    }
    for (const trend of presentation.trends ?? []) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `*${escapeSlack(trend.label)}*\n${trend.points.map((point) => `${escapeSlack(point.label)}: ${point.value}${trend.unit ?? ""}`).join(" · ")}` },
      });
    }
    for (const table of presentation.tables ?? []) {
      const compact = renderPresentationText({ kind: "report", title: table.title ?? "Details", summary: "", tables: [table] }, { maxRowsPerTable: 8, maxCellWidth: 28, includeActions: false });
      blocks.push({ type: "section", text: { type: "mrkdwn", text: `\`\`\`${escapeSlack(compact).slice(0, 2800)}\`\`\`` } });
    }
    const actions = presentationActions(presentation)
      .map((action) => ({ action, binding: bindSurfaceAction(action) }))
      .filter((entry) => entry.binding !== undefined);
    for (let index = 0; index < actions.length; index += 5) {
      blocks.push({
        type: "actions",
        elements: actions.slice(index, index + 5).map(({ action, binding }) => ({
          type: "button",
          text: { type: "plain_text", text: action.label.slice(0, 75) },
          action_id: action.id.slice(0, 255),
          value: binding,
          ...(action.style === "primary" || action.style === "danger" ? { style: action.style } : {}),
        })),
      });
    }
    if (presentation.filters?.length) {
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: `Filters: ${presentation.filters.map((filter) => `${escapeSlack(filter.label)}${filter.selected ? `=${escapeSlack(filter.selected)}` : ""}`).join(" · ")}` }],
      });
    }
    if (presentation.privacy?.note) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: escapeSlack(presentation.privacy.note) }] });
    return { channel, thread_ts: threadTs, text: renderPresentationText(presentation, { maxRowsPerTable: 8, maxCellWidth: 28 }), blocks };
  }
  return { channel, thread_ts: threadTs, text: reply.text };
}

function escapeSlack(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
