import { createPublicKey, verify as cryptoVerify } from "node:crypto";
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
import type { ApprovalActionParser, ApprovalActionRenderContext, ApprovalActionTokens } from "../presentation.js";

/**
 * Discord Interactions adapter: PURE mappers (no network) plus the ed25519
 * signature check Discord requires for interaction endpoints. The gateway
 * server receives interaction webhooks on POST /v1/adapters/discord, verifies
 * X-Signature-Ed25519/X-Signature-Timestamp against the raw body, and answers
 * synchronously with an interaction response (Discord delivers the response
 * body of the webhook back to the channel). PING (type 1) must be answered
 * with PONG (type 1) for endpoint verification.
 */

/**
 * SPKI DER prefix for an ed25519 public key: SEQUENCE(SEQUENCE(OID 1.3.101.112),
 * BIT STRING(0 unused bits, 32-byte raw key)). Concatenating the 32 raw key
 * bytes after this prefix yields a DER document node:crypto can import, which
 * lets us verify Discord signatures with zero dependencies (Node supports
 * ed25519 natively via crypto.verify since v12).
 */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function hexToBuffer(hex: string, expectedBytes: number): Buffer | undefined {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== expectedBytes * 2) return undefined;
  return Buffer.from(hex, "hex");
}

/**
 * Verify a Discord interaction request: ed25519 signature (X-Signature-Ed25519,
 * hex) over `timestamp + rawBody` (X-Signature-Timestamp) against the
 * application's public key (hex, from the Discord developer portal). Returns
 * false (never throws) on any malformed input.
 */
export function discordSignatureIsValid(
  rawBody: string,
  signatureHex: string | undefined,
  timestamp: string | undefined,
  publicKeyHex: string,
): boolean {
  if (!signatureHex || !timestamp) return false;
  const publicKeyRaw = hexToBuffer(publicKeyHex, 32);
  const signature = hexToBuffer(signatureHex, 64);
  if (!publicKeyRaw || !signature) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyRaw]),
      format: "der",
      type: "spki",
    });
    return cryptoVerify(null, Buffer.from(timestamp + rawBody, "utf8"), key, signature);
  } catch {
    return false;
  }
}

// Interaction types (https://discord.com/developers/docs/interactions)
const INTERACTION_PING = 1;
const INTERACTION_APPLICATION_COMMAND = 2;
const INTERACTION_MESSAGE_COMPONENT = 3;

// Interaction response types
const RESPONSE_PONG = 1;
const RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE = 4;

export type DiscordInbound =
  | { readonly kind: "pong" }
  | { readonly kind: "message"; readonly message: SurfaceMessage }
  | { readonly kind: "ignored"; readonly reason: string };

export interface DiscordMappingOptions {
  readonly approvalActions?: ApprovalActionParser;
}

export interface DiscordRenderOptions {
  readonly approvalAction?: ApprovalActionRenderContext;
}

interface DiscordInteraction {
  readonly type?: number;
  readonly id?: string;
  readonly guild_id?: string;
  readonly channel_id?: string;
  readonly member?: { readonly user?: { readonly id?: string; readonly bot?: boolean } };
  readonly user?: { readonly id?: string; readonly bot?: boolean };
  readonly message?: { readonly id?: string };
  readonly data?: {
    readonly name?: string;
    readonly custom_id?: string;
    readonly options?: ReadonlyArray<{ readonly name?: string; readonly type?: number; readonly value?: unknown }>;
  };
}

/** Map a Discord interaction to the gateway envelope. PING maps to "pong". */
export function discordInteractionToInbound(payload: unknown, options: DiscordMappingOptions = {}): DiscordInbound {
  if (typeof payload !== "object" || payload === null) {
    return { kind: "ignored", reason: "payload is not an object" };
  }
  const interaction = payload as DiscordInteraction;
  if (interaction.type === INTERACTION_PING) return { kind: "pong" };
  if (interaction.type === INTERACTION_MESSAGE_COMPONENT) {
    const sender = interaction.member?.user ?? interaction.user;
    const approval = sender?.id && interaction.channel_id
      ? parseVerifiedApprovalSurfaceFields(options.approvalActions, interaction.data?.custom_id, {
        actorId: sender.id,
        surfaceId: `discord:${interaction.guild_id ?? "dm"}`,
        conversationId: interaction.channel_id,
      }, payload)
      : undefined;
    const command = approval?.text ?? parseSurfaceAction(interaction.data?.custom_id);
    if (!command || !sender?.id || !interaction.channel_id) {
      return { kind: "ignored", reason: "component is not a bound command or is missing sender/channel" };
    }
    return {
      kind: "message",
      message: {
        surfaceId: `discord:${interaction.guild_id ?? "dm"}`,
        conversationId: interaction.channel_id,
        senderId: sender.id,
        text: command,
        replyTo: interaction.message?.id,
        raw: approval?.raw ?? payload,
      },
    };
  }
  if (interaction.type !== INTERACTION_APPLICATION_COMMAND || !interaction.data) {
    return { kind: "ignored", reason: `unsupported interaction type: ${String(interaction.type)}` };
  }
  const sender = interaction.member?.user ?? interaction.user;
  if (sender?.bot) return { kind: "ignored", reason: "bot interactions are not surfaced (echo guard)" };
  if (!sender?.id || !interaction.channel_id) {
    return { kind: "ignored", reason: "interaction is missing sender or channel" };
  }
  const argumentsText = (interaction.data.options ?? [])
    .map((option) => option.value)
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .trim();
  const text = interaction.data.name === "muster"
    ? argumentsText
    : `/${interaction.data.name ?? ""}${argumentsText ? ` ${argumentsText}` : ""}`;
  if (!text || text === "/") return { kind: "ignored", reason: "command carries no name or text option" };
  return {
    kind: "message",
    message: {
      surfaceId: `discord:${interaction.guild_id ?? "dm"}`,
      conversationId: interaction.channel_id,
      senderId: sender.id,
      text,
      replyTo: interaction.message?.id,
      raw: payload,
    },
  };
}

interface DiscordComponentRow {
  readonly type: 1;
  readonly components: ReadonlyArray<{
    readonly type: 2;
    readonly style: number;
    readonly label: string;
    readonly custom_id: string;
  }>;
}

export interface DiscordInteractionResponse {
  readonly type: number;
  readonly data?: { readonly content: string; readonly components?: readonly DiscordComponentRow[] };
}

export const DISCORD_PONG: DiscordInteractionResponse = { type: RESPONSE_PONG };

function approvalComponents(actions: ApprovalActionTokens): readonly DiscordComponentRow[] {
  return [{
    type: 1,
    components: [
      { type: 2, style: 3, label: "Approve", custom_id: actions.approve },
      { type: 2, style: 4, label: "Reject", custom_id: actions.reject },
    ],
  }];
}

function replyContent(reply: SurfaceReply | PairingChallenge, options: DiscordRenderOptions): { content: string; components?: readonly DiscordComponentRow[] } {
  if (isPairingChallenge(reply)) {
    return { content: `This sender is not paired with Muster yet. Ask an operator to run: \`muster pairing approve ${reply.code}\`` };
  }
  if (reply.approvalRequest) {
    const { runId, gateId, show } = reply.approvalRequest;
    const shown = typeof show === "string" ? show : JSON.stringify(show, null, 2);
    const actions = issueApprovalActions(reply.approvalRequest, options.approvalAction, 100);
    return {
      content: `${reply.text ? `${reply.text}\n\n` : ""}Approval required (gate \`${gateId}\`, run \`${runId}\`):\n\`\`\`${shown}\`\`\`\n${approvalFallbackText(Boolean(actions))}`,
      ...(actions ? { components: approvalComponents(actions) } : {}),
    };
  }
  if (reply.presentation) {
    const presentation = sanitizePresentationForAudience(reply.presentation);
    const allActions = presentationActions(presentation);
    const actions = allActions
      .map((action) => ({ action, binding: bindSurfaceAction(action) }))
      .filter((entry) => entry.binding !== undefined)
      .slice(0, 5);
    return {
      content: renderPresentationText(presentation, { maxRowsPerTable: 7, maxCellWidth: 22, includeActions: actions.length !== allActions.length }).slice(0, 2000),
      ...(actions.length ? {
        components: [{
          type: 1,
          components: actions.map(({ action, binding }) => ({
            type: 2 as const,
            style: action.style === "primary" ? 3 : action.style === "danger" ? 4 : 2,
            label: action.label.slice(0, 80),
            custom_id: binding!,
          })),
        }],
      } : {}),
    };
  }
  return { content: reply.text };
}

/** Map a gateway reply (or pairing challenge) to a synchronous interaction response. */
export function surfaceReplyToDiscordInteractionResponse(
  reply: SurfaceReply | PairingChallenge,
  options: DiscordRenderOptions = {},
): DiscordInteractionResponse {
  return { type: RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE, data: replyContent(reply, options) };
}

export interface DiscordChannelMessagePayload {
  readonly content: string;
  readonly components?: readonly DiscordComponentRow[];
}

/** Map a gateway reply to a REST channel-message payload (POST /channels/{id}/messages). */
export function surfaceReplyToDiscordChannelMessage(
  reply: SurfaceReply | PairingChallenge,
  options: DiscordRenderOptions = {},
): DiscordChannelMessagePayload {
  return replyContent(reply, options);
}
