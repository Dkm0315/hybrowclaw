import { isPairingChallenge } from "../envelope.js";
import type { PairingChallenge, SurfaceMessage, SurfaceReply } from "../envelope.js";

/**
 * WhatsApp Cloud API adapter: PURE mappers only (no network). The gateway
 * server receives webhook notifications on POST /v1/adapters/whatsapp, sends
 * outbound payloads to https://graph.facebook.com/<ver>/<phoneNumberId>/messages,
 * and answers Meta's GET hub.challenge verification handshake.
 */

/**
 * GET verification handshake: Meta calls the webhook with
 * ?hub.mode=subscribe&hub.verify_token=...&hub.challenge=... and expects the
 * raw challenge echoed back iff the verify token matches.
 */
export function whatsAppVerifyChallenge(
  query: { readonly mode?: string; readonly verifyToken?: string; readonly challenge?: string },
  expectedVerifyToken: string,
): string | undefined {
  if (query.mode !== "subscribe") return undefined;
  if (!query.verifyToken || query.verifyToken !== expectedVerifyToken) return undefined;
  return query.challenge;
}

interface WhatsAppWebhook {
  readonly object?: string;
  readonly entry?: ReadonlyArray<{
    readonly id?: string;
    readonly changes?: ReadonlyArray<{
      readonly field?: string;
      readonly value?: {
        readonly messaging_product?: string;
        readonly metadata?: { readonly phone_number_id?: string };
        readonly messages?: ReadonlyArray<{
          readonly from?: string;
          readonly id?: string;
          readonly type?: string;
          readonly text?: { readonly body?: string };
          readonly button?: { readonly text?: string; readonly payload?: string };
          readonly context?: { readonly id?: string };
        }>;
      };
    }>;
  }>;
}

export function whatsAppMessageIds(payload: unknown): readonly string[] {
  if (typeof payload !== "object" || payload === null) return [];
  const webhook = payload as WhatsAppWebhook;
  const ids: string[] = [];
  for (const entry of webhook.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value?.messages ?? []) {
        if (message.id) ids.push(message.id);
      }
    }
  }
  return ids;
}

/** Map a Cloud API webhook (entry[].changes[].value.messages[]) to SurfaceMessages. */
export function whatsAppWebhookToSurfaceMessages(payload: unknown): readonly SurfaceMessage[] {
  if (typeof payload !== "object" || payload === null) return [];
  const webhook = payload as WhatsAppWebhook;
  if (webhook.object !== "whatsapp_business_account") return [];
  const messages: SurfaceMessage[] = [];
  for (const entry of webhook.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages" || !change.value) continue;
      const phoneNumberId = change.value.metadata?.phone_number_id ?? "unknown-number";
      for (const message of change.value.messages ?? []) {
        const text = message.type === "text" ? message.text?.body : undefined;
        if (!message.from || typeof text !== "string" || !text.trim()) continue;
        messages.push({
          surfaceId: `whatsapp:${phoneNumberId}`,
          conversationId: message.from,
          senderId: message.from,
          text,
          replyTo: message.context?.id,
          raw: payload,
        });
      }
    }
  }
  return messages;
}

export interface WhatsAppSendPayload {
  readonly messaging_product: "whatsapp";
  readonly recipient_type: "individual";
  readonly to: string;
  readonly type: "text" | "interactive";
  readonly text?: { readonly body: string };
  readonly interactive?: {
    readonly type: "button";
    readonly body: { readonly text: string };
    readonly action: {
      readonly buttons: ReadonlyArray<{ readonly type: "reply"; readonly reply: { readonly id: string; readonly title: string } }>;
    };
  };
}

/** Map a gateway reply (or pairing challenge) to a Cloud API /messages payload. */
export function surfaceReplyToWhatsAppSend(reply: SurfaceReply | PairingChallenge, to: string): WhatsAppSendPayload {
  if (isPairingChallenge(reply)) {
    return {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { body: `This number is not paired with Muster yet. Ask an operator to run:\nmuster pairing approve ${reply.code}` },
    };
  }
  if (reply.approvalRequest) {
    const { runId, gateId, show } = reply.approvalRequest;
    const shown = typeof show === "string" ? show : JSON.stringify(show, null, 2);
    return {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: `${reply.text ? `${reply.text}\n\n` : ""}Approval required (gate "${gateId}"):\n${shown}` },
        action: {
          buttons: [
            { type: "reply", reply: { id: `muster:approve:${runId}`, title: "Approve" } },
            { type: "reply", reply: { id: `muster:reject:${runId}`, title: "Reject" } },
          ],
        },
      },
    };
  }
  return { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { body: reply.text } };
}
