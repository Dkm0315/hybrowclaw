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

/** Pure Google Chat event mapping plus an injectable modern request verifier. */

export interface GchatRequestVerificationInput {
  readonly authorization: string | undefined;
  readonly rawBody: string;
  readonly payload: unknown;
  readonly audience: string;
}

export interface GchatRequestVerifier {
  verify(input: GchatRequestVerificationInput): boolean | Promise<boolean>;
}

export interface GchatMappingOptions {
  readonly commands?: Readonly<Record<string, string>>;
  readonly approvalActions?: ApprovalActionParser;
}

export interface GchatRenderOptions {
  readonly approvalAction?: ApprovalActionRenderContext;
}

export type GchatInbound =
  | { readonly kind: "message"; readonly message: SurfaceMessage }
  | { readonly kind: "ignored"; readonly reason: string };

interface GchatUser {
  readonly name?: string;
  readonly type?: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly domainId?: string;
}

export interface GchatActor {
  readonly resourceName: string;
  readonly email?: string;
  readonly displayName?: string;
  readonly domainId?: string;
}

interface GchatEvent {
  readonly type?: string;
  readonly token?: string;
  readonly eventTime?: string;
  readonly user?: GchatUser;
  readonly space?: { readonly name?: string };
  readonly message?: {
    readonly name?: string;
    readonly text?: string;
    readonly argumentText?: string;
    readonly thread?: { readonly name?: string };
    readonly sender?: GchatUser;
    readonly slashCommand?: { readonly commandId?: string | number };
  };
  readonly appCommandMetadata?: { readonly appCommandId?: string | number };
  readonly common?: {
    readonly invokedFunction?: string;
    readonly parameters?: Readonly<Record<string, string>>;
    readonly formInputs?: Readonly<Record<string, { readonly stringInputs?: { readonly value?: readonly string[] } }>>;
    readonly user?: GchatUser;
  };
  readonly action?: {
    readonly actionMethodName?: string;
    readonly parameters?: ReadonlyArray<{ readonly key?: string; readonly value?: string }>;
  };
}

/** Extract the verification token Google includes in legacy event payloads. */
export function gchatEventToken(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const token = (payload as GchatEvent).token;
  return typeof token === "string" ? token : undefined;
}

/** Stable delivery key for retries across messages, app commands, and card actions. */
export function gchatDeliveryId(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const event = payload as GchatEvent;
  if (event.message?.name) return event.message.name;
  const action = event.common?.invokedFunction ?? event.action?.actionMethodName;
  const sender = event.message?.sender?.name ?? event.user?.name ?? event.common?.user?.name;
  const parts = [event.eventTime, event.space?.name, sender, action].filter((value): value is string => typeof value === "string" && value.length > 0);
  return parts.length >= 3 ? parts.join(":") : undefined;
}

/** Identity asserted by a platform-verified Google Chat event. */
export function gchatActor(payload: unknown): GchatActor | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const event = payload as GchatEvent;
  const sender = event.message?.sender ?? event.user ?? event.common?.user;
  if (!sender?.name || sender.type === "BOT") return undefined;
  const email = sender.email?.trim().toLowerCase();
  return {
    resourceName: sender.name,
    ...(email ? { email } : {}),
    ...(sender.displayName?.trim() ? { displayName: sender.displayName.trim() } : {}),
    ...(sender.domainId?.trim() ? { domainId: sender.domainId.trim() } : {}),
  };
}

/** Map MESSAGE, APP_COMMAND, CARD_CLICKED, APP_HOME, and SUBMIT_FORM events. */
export function gchatEventToSurfaceMessage(payload: unknown, options: GchatMappingOptions = {}): GchatInbound {
  if (typeof payload !== "object" || payload === null) return { kind: "ignored", reason: "payload is not an object" };
  const event = payload as GchatEvent;
  const sender = event.message?.sender ?? event.user ?? event.common?.user;
  if (sender?.type === "BOT") return { kind: "ignored", reason: "bot messages are not surfaced (echo guard)" };

  const candidate = gchatActionCandidate(event);
  const approval = sender?.name && event.space?.name && candidate
    ? pendingApprovalSurfaceFields(options.approvalActions, candidate, {
      actorId: sender.name,
      surfaceId: "gchat:app",
      conversationId: event.space.name,
    }, payload)
    : undefined;
  const text = approval?.text ?? gchatEventText(event, options);
  if (!sender?.name || !event.space?.name || !text) {
    return { kind: "ignored", reason: `event ${String(event.type)} is missing a supported command, sender, or space` };
  }
  return {
    kind: "message",
    message: {
      surfaceId: "gchat:app",
      conversationId: event.space.name,
      senderId: sender.name,
      text,
      replyTo: event.message?.thread?.name,
      raw: approval?.raw ?? payload,
    },
  };
}

function gchatEventText(event: GchatEvent, options: GchatMappingOptions): string | undefined {
  if (event.type === "APP_HOME") return "/start";
  if (event.type === "CARD_CLICKED" || event.type === "SUBMIT_FORM") {
    const parameters = gchatActionParameters(event);
    const candidate = parameters.command ?? parameters.value ?? event.common?.invokedFunction ?? event.action?.actionMethodName;
    const command = parseSurfaceAction(candidate) ?? (candidate === "muster_command" && parameters.command?.startsWith("/") ? parameters.command : undefined);
    return command ? appendFormInputs(command, event.common?.formInputs) : undefined;
  }
  if (event.type !== "MESSAGE" && event.type !== "APP_COMMAND") return undefined;

  const commandId = event.message?.slashCommand?.commandId ?? event.appCommandMetadata?.appCommandId;
  const mapped = commandId === undefined ? undefined : options.commands?.[String(commandId)];
  const argument = (event.message?.argumentText ?? "").trim();
  if (mapped) {
    const command = mapped.startsWith("/") ? mapped : `/${mapped}`;
    return `${command}${argument ? ` ${argument}` : ""}`;
  }
  const text = (event.message?.argumentText ?? event.message?.text ?? "").trim();
  return text || undefined;
}

function gchatActionParameters(event: GchatEvent): Readonly<Record<string, string>> {
  return {
    ...(event.common?.parameters ?? {}),
    ...Object.fromEntries((event.action?.parameters ?? []).flatMap((parameter) => parameter.key && parameter.value ? [[parameter.key, parameter.value]] : [])),
  };
}

function gchatActionCandidate(event: GchatEvent): string | undefined {
  if (event.type !== "CARD_CLICKED" && event.type !== "SUBMIT_FORM") return undefined;
  const parameters = gchatActionParameters(event);
  return parameters.command ?? parameters.value;
}

function appendFormInputs(
  command: string,
  inputs: Readonly<Record<string, { readonly stringInputs?: { readonly value?: readonly string[] } }>> | undefined,
): string {
  const args = Object.entries(inputs ?? {}).flatMap(([key, input]) => (input.stringInputs?.value ?? []).map((value) => `${key}=${encodeURIComponent(value)}`));
  return args.length ? `${command} ${args.join(" ")}` : command;
}

interface GchatButton {
  readonly text: string;
  readonly onClick: {
    readonly action: {
      readonly function: string;
      readonly parameters: ReadonlyArray<{ readonly key: string; readonly value: string }>;
      readonly interaction?: "OPEN_DIALOG";
    };
  };
}

interface GchatWidget {
  readonly textParagraph?: { readonly text: string };
  readonly decoratedText?: { readonly topLabel?: string; readonly text: string; readonly bottomLabel?: string };
  readonly buttonList?: { readonly buttons: readonly GchatButton[] };
  readonly selectionInput?: {
    readonly name: string;
    readonly label: string;
    readonly type: "DROPDOWN";
    readonly items: ReadonlyArray<{ readonly text: string; readonly value: string; readonly selected?: boolean }>;
  };
}

export interface GchatResponsePayload {
  readonly text: string;
  readonly thread?: { readonly name: string };
  readonly cardsV2?: ReadonlyArray<{
    readonly cardId: string;
    readonly card: {
      readonly header?: { readonly title: string; readonly subtitle?: string };
      readonly sections: ReadonlyArray<{ readonly header?: string; readonly widgets: readonly GchatWidget[] }>;
    };
  }>;
  readonly actionResponse?: {
    readonly type: "DIALOG";
    readonly dialogAction: {
      readonly dialog: {
        readonly body: {
          readonly header?: { readonly title: string; readonly subtitle?: string };
          readonly sections: ReadonlyArray<{ readonly header?: string; readonly widgets: readonly GchatWidget[] }>;
        };
      };
    };
  };
}

/** Map a gateway reply to a synchronous Chat response. */
export function surfaceReplyToGchatResponse(
  reply: SurfaceReply | PairingChallenge,
  threadName?: string,
  options: GchatRenderOptions = {},
): GchatResponsePayload {
  const thread = threadName ? { name: threadName } : undefined;
  if (isPairingChallenge(reply)) {
    return { text: `This sender is not paired with Muster yet. Ask an operator to run: muster pairing approve ${reply.code}`, thread };
  }
  if (reply.approvalRequest) {
    const { runId, gateId, show } = reply.approvalRequest;
    const shown = typeof show === "string" ? show : JSON.stringify(show, null, 2);
    const actions = issueApprovalActions(reply.approvalRequest, options.approvalAction, 64);
    return {
      text: `${reply.text ? `${reply.text}\n\n` : ""}Approval required (gate "${gateId}", run ${runId}):\n${shown}\n\n${approvalFallbackText(Boolean(actions))}`,
      thread,
      ...(actions ? { cardsV2: [{
        cardId: `muster-approval-${runId}`,
        card: { sections: [{ widgets: [{ buttonList: { buttons: [approvalButton("Approve", actions.approve), approvalButton("Reject", actions.reject)] } }] }] },
      }] } : {}),
    };
  }
  if (reply.presentation) {
    const presentation = sanitizePresentationForAudience(reply.presentation);
    const widgets: GchatWidget[] = [{ textParagraph: { text: escapeGchat(presentation.summary) } }];
    for (const kpi of presentation.kpis ?? []) {
      widgets.push({ decoratedText: { topLabel: kpi.label, text: kpi.value, ...(kpi.detail ? { bottomLabel: kpi.detail } : {}) } });
    }
    for (const trend of presentation.trends ?? []) {
      widgets.push({ textParagraph: { text: `<b>${escapeGchat(trend.label)}</b><br>${trend.points.map((point) => `${escapeGchat(point.label)}: ${point.value}${trend.unit ?? ""}`).join(" · ")}` } });
    }
    for (const table of presentation.tables ?? []) {
      const text = renderPresentationText({ kind: "report", title: table.title ?? "Details", summary: "", tables: [table] }, { maxRowsPerTable: 8, maxCellWidth: 26, includeActions: false });
      widgets.push({ textParagraph: { text: `<pre>${escapeGchat(text).slice(0, 3800)}</pre>` } });
    }
    const actions = presentationActions(presentation)
      .map((action) => ({ action, binding: bindSurfaceAction(action) }))
      .filter((entry) => entry.binding !== undefined);
    if (actions.length) {
      widgets.push({
        buttonList: {
          buttons: actions.slice(0, 10).map(({ action, binding }) => ({
            text: action.label.slice(0, 40),
            onClick: {
              action: {
                function: "muster_command",
                parameters: [{ key: "command", value: binding! }],
                ...(action.kind === "filter" ? { interaction: "OPEN_DIALOG" as const } : {}),
              },
            },
          })),
        },
      });
    }
    if (actions.length > 10) {
      widgets.push({ textParagraph: { text: `<b>More actions</b><br>${actions.slice(10).map(({ action }) => `${escapeGchat(action.label)}: <code>${escapeGchat(action.command)}</code>`).join("<br>")}` } });
    }
    for (const filter of presentation.filters ?? []) {
      if (presentation.kind === "form" && filter.options?.length) {
        widgets.push({
          selectionInput: {
            name: filter.id,
            label: filter.label,
            type: "DROPDOWN",
            items: filter.options.map((option) => ({ text: option.label, value: option.value, ...(filter.selected === option.value ? { selected: true } : {}) })),
          },
        });
      } else {
        widgets.push({ decoratedText: { topLabel: "Filter", text: filter.label, ...(filter.selected ? { bottomLabel: filter.selected } : {}) } });
      }
    }
    if (presentation.privacy?.note) widgets.push({ textParagraph: { text: `<i>${escapeGchat(presentation.privacy.note)}</i>` } });
    const card = { header: { title: presentation.title }, sections: [{ widgets }] };
    if (presentation.kind === "form") {
      return {
        text: renderPresentationText(presentation, { maxRowsPerTable: 8, maxCellWidth: 26 }),
        thread,
        actionResponse: { type: "DIALOG", dialogAction: { dialog: { body: card } } },
      };
    }
    return {
      text: renderPresentationText(presentation, { maxRowsPerTable: 8, maxCellWidth: 26 }),
      thread,
      cardsV2: [{
        cardId: `muster-${presentation.kind}-${slug(presentation.title)}`,
        card,
      }],
    };
  }
  return { text: reply.text, thread };
}

function approvalButton(text: string, token: string): GchatButton {
  return { text, onClick: { action: { function: "muster_approval", parameters: [{ key: "command", value: token }] } } };
}

function escapeGchat(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "card";
}
