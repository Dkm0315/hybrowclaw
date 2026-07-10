import { isPairingChallenge } from "../envelope.js";
import type { PairingChallenge, SurfaceMessage, SurfaceReply } from "../envelope.js";
import {
  approvalFallbackText,
  bindSurfaceAction,
  issueApprovalActions,
  parseSurfaceAction,
  parseVerifiedApprovalSurfaceFields,
  presentationActions,
  renderPresentationText,
  sanitizePresentationForAudience,
} from "../presentation.js";
import type { ApprovalActionParser, ApprovalActionRenderContext } from "../presentation.js";

/**
 * Telegram Bot API adapter: PURE mappers only (no network). The gateway
 * server receives webhook updates on POST /v1/adapters/telegram and sends
 * outbound payloads to https://api.telegram.org/bot<token>/sendMessage.
 */

export const TELEGRAM_SURFACE_ID = "telegram:bot";

export interface TelegramMappingOptions {
  readonly approvalActions?: ApprovalActionParser;
}

export interface TelegramRenderOptions {
  readonly approvalAction?: ApprovalActionRenderContext;
}

interface TelegramUpdate {
  readonly update_id?: number;
  readonly message?: {
    readonly message_id?: number;
    readonly from?: { readonly id?: number | string };
    readonly chat?: { readonly id?: number | string };
    readonly text?: string;
    readonly caption?: string;
    readonly reply_to_message?: { readonly message_id?: number };
  };
  readonly callback_query?: {
    readonly id?: string;
    readonly from?: { readonly id?: number | string };
    readonly data?: string;
    readonly message?: {
      readonly message_id?: number;
      readonly chat?: { readonly id?: number | string };
    };
  };
}

/** Map a Telegram update to the gateway envelope. Non-text updates map to undefined. */
export function telegramUpdateToSurfaceMessage(update: unknown, options: TelegramMappingOptions = {}): SurfaceMessage | undefined {
  if (typeof update !== "object" || update === null) return undefined;
  const typed = update as TelegramUpdate;
  const callback = typed.callback_query;
  const approval = callback?.message?.chat?.id && callback.from?.id
    ? parseVerifiedApprovalSurfaceFields(options.approvalActions, callback.data, {
      actorId: String(callback.from.id),
      surfaceId: TELEGRAM_SURFACE_ID,
      conversationId: String(callback.message.chat.id),
    }, update)
    : undefined;
  const command = approval?.text ?? parseSurfaceAction(callback?.data);
  if (callback?.message?.chat?.id && callback.from?.id && command) {
    return {
      surfaceId: TELEGRAM_SURFACE_ID,
      conversationId: String(callback.message.chat.id),
      senderId: String(callback.from.id),
      text: command,
      replyTo: callback.message.message_id === undefined ? undefined : String(callback.message.message_id),
      raw: approval?.raw ?? update,
    };
  }
  const message = typed.message;
  if (!message?.chat?.id || !message.from?.id) return undefined;
  const text = message.text ?? message.caption;
  if (typeof text !== "string" || !text.trim()) return undefined;
  return {
    surfaceId: TELEGRAM_SURFACE_ID,
    conversationId: String(message.chat.id),
    senderId: String(message.from.id),
    text,
    replyTo: message.reply_to_message?.message_id !== undefined ? String(message.reply_to_message.message_id) : undefined,
    raw: update,
  };
}

export interface TelegramSendMessagePayload {
  readonly chat_id: string;
  readonly text: string;
  readonly reply_markup?: {
    readonly inline_keyboard: ReadonlyArray<ReadonlyArray<{ readonly text: string; readonly callback_data: string }>>;
  };
}

export function telegramCallbackQueryId(update: unknown): string | undefined {
  if (typeof update !== "object" || update === null) return undefined;
  const id = (update as TelegramUpdate).callback_query?.id;
  return typeof id === "string" && id ? id : undefined;
}

/** Map a gateway reply (or pairing challenge) to a Bot API sendMessage payload. */
export function surfaceReplyToTelegramSend(
  reply: SurfaceReply | PairingChallenge,
  chatId: string,
  options: TelegramRenderOptions = {},
): TelegramSendMessagePayload {
  if (isPairingChallenge(reply)) {
    return {
      chat_id: chatId,
      text: `This chat is not paired with Muster yet. Ask an operator to run:\nmuster pairing approve ${reply.code}`,
    };
  }
  if (reply.approvalRequest) {
    const { runId, gateId, show } = reply.approvalRequest;
    const shown = typeof show === "string" ? show : JSON.stringify(show, null, 2);
    const actions = issueApprovalActions(reply.approvalRequest, options.approvalAction, 64);
    return {
      chat_id: chatId,
      text: `${reply.text ? `${reply.text}\n\n` : ""}Approval required (gate "${gateId}", run ${runId}):\n${shown}\n\n${approvalFallbackText(Boolean(actions))}`,
      ...(actions ? { reply_markup: {
        inline_keyboard: [[
          { text: "Approve", callback_data: actions.approve },
          { text: "Reject", callback_data: actions.reject },
        ]],
      } } : {}),
    };
  }
  if (reply.presentation) {
    const presentation = sanitizePresentationForAudience(reply.presentation);
    const allActions = presentationActions(presentation);
    const actions = allActions
      .map((action) => ({ action, binding: bindSurfaceAction(action, 64) }))
      .filter((entry): entry is { action: typeof entry.action; binding: string } => entry.binding !== undefined);
    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    for (let index = 0; index < actions.length; index += 2) {
      keyboard.push(actions.slice(index, index + 2).map(({ action, binding }) => ({ text: action.label.slice(0, 32), callback_data: binding })));
    }
    return {
      chat_id: chatId,
      text: renderPresentationText(presentation, { maxRowsPerTable: 6, maxCellWidth: 22, includeActions: actions.length !== allActions.length }),
      ...(keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    };
  }
  return { chat_id: chatId, text: reply.text };
}
