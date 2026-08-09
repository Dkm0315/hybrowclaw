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
 * Microsoft Teams outgoing-webhook adapter: PURE mappers only (no network).
 * Teams posts a message activity to POST /v1/adapters/teams (signed with an
 * HMAC security token) and renders the JSON body of the webhook response as
 * the bot's reply (plain text or an Adaptive Card for approvals).
 */

export type TeamsInbound =
  | { readonly kind: "message"; readonly message: SurfaceMessage }
  | { readonly kind: "ignored"; readonly reason: string };

export interface TeamsMappingOptions {
  readonly approvalActions?: ApprovalActionParser;
}

export interface TeamsRenderOptions {
  readonly approvalAction?: ApprovalActionRenderContext;
}

interface TeamsActivity {
  readonly type?: string;
  readonly id?: string;
  readonly text?: string;
  readonly from?: { readonly id?: string; readonly name?: string };
  readonly conversation?: { readonly id?: string };
  readonly channelData?: { readonly tenant?: { readonly id?: string } };
  readonly value?: { readonly musterAction?: string; readonly command?: string };
}

/** Strip the <at>Bot</at> mention markup Teams prefixes onto outgoing-webhook text. */
function stripMentions(text: string): string {
  return text.replace(/<at>.*?<\/at>/g, "").trim();
}

/** Map a Teams message activity to the gateway envelope. */
export function teamsActivityToSurfaceMessage(payload: unknown, options: TeamsMappingOptions = {}): TeamsInbound {
  if (typeof payload !== "object" || payload === null) {
    return { kind: "ignored", reason: "payload is not an object" };
  }
  const activity = payload as TeamsActivity;
  if (activity.type !== "message") {
    return { kind: "ignored", reason: `unsupported activity type: ${String(activity.type)}` };
  }
  const surfaceId = `teams:${activity.channelData?.tenant?.id ?? "tenant"}`;
  const approval = activity.from?.id && activity.conversation?.id
    ? pendingApprovalSurfaceFields(options.approvalActions, activity.value?.musterAction ?? activity.value?.command, {
      actorId: activity.from.id,
      surfaceId,
      conversationId: activity.conversation.id,
    }, payload)
    : undefined;
  const text = approval?.text ?? parseSurfaceAction(activity.value?.musterAction ?? activity.value?.command)
    ?? (typeof activity.text === "string" ? stripMentions(activity.text) : "");
  if (!activity.from?.id || !activity.conversation?.id || !text) {
    return { kind: "ignored", reason: "activity is missing from.id, conversation.id, or text" };
  }
  return {
    kind: "message",
    message: {
      surfaceId,
      conversationId: activity.conversation.id,
      senderId: activity.from.id,
      text,
      replyTo: activity.id,
      raw: approval?.raw ?? payload,
    },
  };
}

/**
 * Validate the outgoing-webhook HMAC: Authorization header carries
 * "HMAC <base64(hmac-sha256(rawBody, base64-decoded secret))>".
 */
export function teamsHmacIsValid(rawBody: string, authorizationHeader: string | undefined, secretBase64: string): boolean {
  const presented = authorizationHeader?.startsWith("HMAC ") ? authorizationHeader.slice("HMAC ".length) : "";
  const expected = createHmac("sha256", Buffer.from(secretBase64, "base64")).update(rawBody, "utf8").digest("base64");
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface TeamsResponseActivity {
  readonly type: "message";
  readonly text?: string;
  readonly attachments?: ReadonlyArray<{
    readonly contentType: "application/vnd.microsoft.card.adaptive";
    readonly content: {
      readonly type: "AdaptiveCard";
      readonly version: string;
      readonly body: ReadonlyArray<
        { readonly type: "TextBlock"; readonly text: string; readonly wrap: boolean; readonly weight?: "Bolder"; readonly size?: "Medium" }
        | { readonly type: "FactSet"; readonly facts: ReadonlyArray<{ readonly title: string; readonly value: string }> }
      >;
      readonly actions: ReadonlyArray<{ readonly type: "Action.Submit"; readonly title: string; readonly data: { readonly musterAction: string }; readonly style?: "positive" | "destructive" }>;
    };
  }>;
}

/** Map a gateway reply to the synchronous Teams response (Adaptive Card for approvals). */
export function surfaceReplyToTeamsActivity(
  reply: SurfaceReply | PairingChallenge,
  options: TeamsRenderOptions = {},
): TeamsResponseActivity {
  if (isPairingChallenge(reply)) {
    return {
      type: "message",
      text: `This sender is not paired with Muster yet. Ask an operator to run: muster pairing approve ${reply.code}`,
    };
  }
  if (reply.approvalRequest) {
    const { runId, gateId, show } = reply.approvalRequest;
    const shown = typeof show === "string" ? show : JSON.stringify(show, null, 2);
    const actions = issueApprovalActions(reply.approvalRequest, options.approvalAction, 64);
    return {
      type: "message",
      attachments: [{
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          type: "AdaptiveCard",
          version: "1.5",
          body: [
            { type: "TextBlock", text: `${reply.text ? `${reply.text}\n\n` : ""}Approval required (gate "${gateId}", run ${runId})`, wrap: true },
            { type: "TextBlock", text: shown, wrap: true },
            { type: "TextBlock", text: approvalFallbackText(Boolean(actions)), wrap: true },
          ],
          actions: actions ? [
            { type: "Action.Submit", title: "Approve", data: { musterAction: actions.approve }, style: "positive" },
            { type: "Action.Submit", title: "Reject", data: { musterAction: actions.reject }, style: "destructive" },
          ] : [],
        },
      }],
    };
  }
  if (reply.presentation) {
    const presentation = sanitizePresentationForAudience(reply.presentation);
    const body: Array<
      { type: "TextBlock"; text: string; wrap: boolean; weight?: "Bolder"; size?: "Medium" }
      | { type: "FactSet"; facts: Array<{ title: string; value: string }> }
    > = [
      { type: "TextBlock", text: presentation.title, wrap: true, weight: "Bolder", size: "Medium" },
      { type: "TextBlock", text: presentation.summary, wrap: true },
    ];
    if (presentation.kpis?.length) body.push({ type: "FactSet", facts: presentation.kpis.map((kpi) => ({ title: kpi.label, value: kpi.value })) });
    for (const trend of presentation.trends ?? []) {
      body.push({ type: "TextBlock", text: `${trend.label}: ${trend.points.map((point) => `${point.label} ${point.value}${trend.unit ?? ""}`).join(" · ")}`, wrap: true });
    }
    for (const table of presentation.tables ?? []) {
      body.push({
        type: "TextBlock",
        text: renderPresentationText({ kind: "report", title: table.title ?? "Details", summary: "", tables: [table] }, { maxRowsPerTable: 8, maxCellWidth: 24, includeActions: false }),
        wrap: true,
      });
    }
    if (presentation.privacy?.note) body.push({ type: "TextBlock", text: presentation.privacy.note, wrap: true });
    if (presentation.filters?.length) {
      body.push({ type: "TextBlock", text: `Filters: ${presentation.filters.map((filter) => `${filter.label}${filter.selected ? `=${filter.selected}` : ""}`).join(" · ")}`, wrap: true });
    }
    const allActions = presentationActions(presentation);
    const bindableActions = allActions
      .map((action) => ({ action, binding: bindSurfaceAction(action) }))
      .filter((entry) => entry.binding !== undefined);
    const visibleActions = bindableActions.slice(0, 6);
    const visibleIds = new Set(visibleActions.map(({ action }) => action.id));
    const omittedActions = allActions.filter((action) => !visibleIds.has(action.id));
    if (omittedActions.length) {
      body.push({ type: "TextBlock", text: `More actions: ${omittedActions.map((action) => `${action.label} (${action.command})`).join(" · ")}`, wrap: true });
    }
    const actions = visibleActions
      .map(({ action, binding }) => ({
        type: "Action.Submit" as const,
        title: action.label,
        data: { musterAction: binding! },
        ...(action.style === "primary" ? { style: "positive" as const } : action.style === "danger" ? { style: "destructive" as const } : {}),
      }));
    return {
      type: "message",
      attachments: [{
        contentType: "application/vnd.microsoft.card.adaptive",
        content: { type: "AdaptiveCard", version: "1.5", body, actions },
      }],
    };
  }
  return { type: "message", text: reply.text };
}
