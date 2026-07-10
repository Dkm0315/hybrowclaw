import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfig } from "@musterhq/core";
import {
  INTERACTION_COMMANDS,
  approvePairing,
  bindSurfaceAction,
  createAsyncAcknowledgement,
  discordInteractionToInbound,
  dispatchCommand,
  gchatDeliveryId,
  gchatEventToSurfaceMessage,
  idempotencyLookup,
  idempotencyStore,
  paginateRows,
  parseSurfaceAction,
  sanitizePresentationForAudience,
  requestPairing,
  slackDeliveryId,
  slackEventToSurfaceMessage,
  startGatewayServer,
  surfaceReplyToDiscordInteractionResponse,
  surfaceReplyToGchatResponse,
  surfaceReplyToSlackPost,
  surfaceReplyToTeamsActivity,
  surfaceReplyToTelegramSend,
  surfaceReplyToWhatsAppSend,
  teamsActivityToSurfaceMessage,
  telegramUpdateToSurfaceMessage,
  whatsAppWebhookToSurfaceMessages,
} from "../src/index.js";
import type { GatewayConfig, PairedSender, SurfaceMessage, SurfacePresentation, SurfaceReply } from "../src/index.js";

const BASE_PAIRED: PairedSender = {
  pairingId: "pair_person",
  surfaceId: "gchat:app",
  senderId: "users/person",
  approvedAt: "2026-07-10T00:00:00.000Z",
};

const MANAGER_PAIRED: PairedSender = {
  ...BASE_PAIRED,
  pairingId: "pair_manager",
  identity: {
    provider: "frappe",
    site: "https://erp.example.test",
    user: "manager@example.test",
    employee: "EMP-0001",
    roles: ["Employee", "Reports Manager"],
    resolvedAt: "2026-07-10T00:00:00.000Z",
  },
};

function message(text: string): SurfaceMessage {
  return { surfaceId: "gchat:app", conversationId: "spaces/A", senderId: "users/person", text };
}

function commandContext(paired = BASE_PAIRED, gateway?: GatewayConfig) {
  return {
    config: defaultConfig(),
    profile: "enterprise",
    paired,
    gateway,
    conversationKey: "gchat:app:spaces/A",
  };
}

function inboundText(inbound: unknown): string | undefined {
  if (typeof inbound !== "object" || inbound === null || (inbound as { kind?: string }).kind !== "message") return undefined;
  return (inbound as { message: SurfaceMessage }).message.text;
}

const ALL_DIRECT_COMMANDS = [
  "status", "whoami", "tools", "reports", "tokens", "usage", "limits", "security", "evals", "index", "settings", "help",
  "approvals", "audit", "incidents", "providers", "models", "plugins", "skills", "mcp", "channels", "agents", "artifacts", "sessions", "memory",
];

test("registry preserves the complete direct slash-command contract", () => {
  const names = new Set(INTERACTION_COMMANDS.map((descriptor) => descriptor.name));
  for (const command of ALL_DIRECT_COMMANDS) assert.ok(names.has(command as never), `missing /${command}`);
  assert.equal(new Set(INTERACTION_COMMANDS.map((descriptor) => descriptor.name)).size, INTERACTION_COMMANDS.length, "registry names must be unique");
});

test("role and capability visibility fail closed without sending commands to the model", async () => {
  const restricted = await dispatchCommand(message("/audit"), commandContext());
  assert.ok(restricted?.presentation);
  assert.equal(restricted.presentation.title, "Command unavailable");

  const manager = await dispatchCommand(message("/audit"), commandContext(MANAGER_PAIRED));
  assert.equal(manager?.presentation?.title, "Audit");
  assert.equal(manager?.presentation?.privacy?.rawPromptsIncluded, false);

  const capabilityGateway: GatewayConfig = {
    token: "test",
    governance: { assignments: { default: { capabilities: ["tokens"] } } },
  };
  const tokens = await dispatchCommand(message("/tokens"), commandContext(BASE_PAIRED, capabilityGateway));
  const mcp = await dispatchCommand(message("/mcp"), commandContext(BASE_PAIRED, capabilityGateway));
  assert.equal(tokens?.presentation?.title, "Usage");
  assert.equal(mcp?.presentation?.title, "Command unavailable");

  const emptyAllowlist: GatewayConfig = { token: "test", governance: { assignments: { default: { capabilities: [] } } } };
  const deniedByEmptyAllowlist = await dispatchCommand(message("/tokens"), commandContext(BASE_PAIRED, emptyAllowlist));
  assert.equal(deniedByEmptyAllowlist?.presentation?.title, "Command unavailable");

  const genericManager: GatewayConfig = { token: "test", governance: { assignments: { default: { roles: ["Operations Manager"] } } } };
  const managerWithoutFrappe = await dispatchCommand(message("/audit"), commandContext(BASE_PAIRED, genericManager));
  assert.equal(managerWithoutFrappe?.presentation?.title, "Audit", "manager visibility must not be hardcoded to Frappe identities");
});

test("help pagination actions persist and execute as direct commands", async () => {
  const first = await dispatchCommand(message("/help"), commandContext());
  const next = first?.presentation?.actions?.find((action) => action.kind === "page");
  assert.ok(next, "first page should expose an executable next action");
  const binding = bindSurfaceAction(next, 64);
  assert.ok(binding);
  const command = parseSurfaceAction(binding);
  assert.equal(command, "/help page=2");

  const second = await dispatchCommand(message(command!), commandContext());
  assert.equal(second?.presentation?.tables?.[0].pagination?.page, 2);
  assert.notDeepEqual(second?.presentation?.tables?.[0].rows, first?.presentation?.tables?.[0].rows);
});

test("manager report sanitizer removes raw prompt-like columns and values", () => {
  const presentation: SurfacePresentation = {
    kind: "report",
    title: "Team usage",
    summary: "Authorized hierarchy",
    audience: "manager",
    tables: [{ id: "runs", columns: ["User", "Prompt", "Tokens"], rows: [["EMP-1", "secret customer escalation", "320"]] }],
    privacy: { rawPromptsIncluded: false },
  };
  const safe = sanitizePresentationForAudience(presentation);
  assert.deepEqual(safe.tables?.[0].columns, ["User", "Tokens"]);
  assert.doesNotMatch(JSON.stringify(safe), /secret customer escalation|"Prompt"/);
});

function visualReply(): SurfaceReply {
  return {
    text: "secret fallback prompt that must never bypass presentation privacy",
    presentation: {
      kind: "report",
      title: "Team usage",
      summary: "Usage, latency, cache, and outcomes for the authorized hierarchy.",
      audience: "manager",
      kpis: [
        { label: "Runs", value: "42" },
        { label: "p95", value: "2.4s" },
      ],
      trends: [{ id: "latency", label: "Latency", unit: "ms", points: [{ label: "p50", value: 620 }, { label: "p95", value: 2400 }] }],
      tables: [{
        id: "people",
        columns: ["User", "Prompt", "Tokens"],
        rows: [["EMP-1", "secret customer escalation", "320"], ["EMP-2", "another private prompt", "410"]],
        pagination: { page: 1, pageSize: 2, totalRows: 12 },
      }],
      filters: [{ id: "period", label: "Period", selected: "7d" }],
      drilldowns: [{ id: "limits", label: "View limits", command: "/limits", kind: "drilldown" }],
      actions: [{ id: "next", label: "Next page", command: "/usage page=2", kind: "page", style: "primary" }],
      work: { id: "work-1", state: "running", label: "Refreshing usage" },
      privacy: { rawPromptsIncluded: false, note: "Raw prompts hidden." },
    },
  };
}

test("all channel renderers preserve visual meaning, privacy, and executable actions", () => {
  const reply = visualReply();
  const rendered = {
    telegram: surfaceReplyToTelegramSend(reply, "100"),
    slack: surfaceReplyToSlackPost(reply, "C1", "1.2"),
    gchat: surfaceReplyToGchatResponse(reply, "spaces/A/threads/B"),
    teams: surfaceReplyToTeamsActivity(reply),
    discord: surfaceReplyToDiscordInteractionResponse(reply),
    whatsapp: surfaceReplyToWhatsAppSend(reply, "919999999999"),
  };
  for (const [channel, payload] of Object.entries(rendered)) {
    const json = JSON.stringify(payload);
    assert.match(json, /Team usage/, `${channel} lost the title`);
    assert.match(json, /View limits|Next page/, `${channel} lost actions`);
    assert.match(json, /muster:cmd:\/(?:limits|usage page=2)/, `${channel} actions are decorative only`);
    assert.doesNotMatch(json, /secret customer escalation|another private prompt|secret fallback prompt|"Prompt"/, `${channel} leaked manager prompt text`);
  }
});

test("every channel callback maps its rendered binding back to the slash command", () => {
  const binding = bindSurfaceAction({ command: "/usage page=2" });
  assert.ok(binding);

  assert.equal(telegramUpdateToSurfaceMessage({
    update_id: 2,
    callback_query: { id: "q1", from: { id: 7 }, data: binding, message: { message_id: 4, chat: { id: 5 } } },
  })?.text, "/usage page=2");

  assert.equal(inboundText(slackEventToSurfaceMessage({
    type: "block_actions",
    trigger_id: "trigger-1",
    team: { id: "T1" },
    user: { id: "U1" },
    channel: { id: "C1" },
    container: { message_ts: "1.2" },
    actions: [{ action_id: "next", action_ts: "1.3", value: binding }],
  })), "/usage page=2");

  assert.equal(inboundText(gchatEventToSurfaceMessage({
    type: "CARD_CLICKED",
    eventTime: "2026-07-10T10:00:00Z",
    user: { name: "users/1", type: "HUMAN" },
    space: { name: "spaces/A" },
    common: { invokedFunction: "muster_command", parameters: { command: binding } },
  })), "/usage page=2");

  assert.equal(inboundText(teamsActivityToSurfaceMessage({
    type: "message",
    id: "activity-1",
    from: { id: "user-1" },
    conversation: { id: "conversation-1" },
    channelData: { tenant: { id: "tenant-1" } },
    value: { musterAction: binding },
  })), "/usage page=2");

  assert.equal(inboundText(discordInteractionToInbound({
    type: 3,
    id: "interaction-1",
    guild_id: "guild-1",
    channel_id: "channel-1",
    member: { user: { id: "user-1" } },
    message: { id: "message-1" },
    data: { custom_id: binding },
  })), "/usage page=2");

  const whatsapp = whatsAppWebhookToSurfaceMessages({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: {
      metadata: { phone_number_id: "phone-1" },
      messages: [{ from: "919999999999", id: "wamid.1", type: "interactive", interactive: { button_reply: { id: binding, title: "Next" } } }],
    } }] }],
  });
  assert.equal(whatsapp[0]?.text, "/usage page=2");
});

test("Google Chat supports slash metadata, app commands, app home, and submitted actions", () => {
  const common = { eventTime: "2026-07-10T10:00:00Z", user: { name: "users/1", type: "HUMAN" }, space: { name: "spaces/A" } };
  const appCommand = gchatEventToSurfaceMessage({
    ...common,
    type: "APP_COMMAND",
    appCommandMetadata: { appCommandId: 7 },
    message: { argumentText: "page=2" },
  }, { commands: { "7": "/tokens" } });
  assert.equal(inboundText(appCommand), "/tokens page=2");

  const messageCommand = gchatEventToSurfaceMessage({
    ...common,
    type: "MESSAGE",
    message: { argumentText: "scope=team", slashCommand: { commandId: "8" }, sender: common.user },
  }, { commands: { "8": "usage" } });
  assert.equal(inboundText(messageCommand), "/usage scope=team");
  assert.equal(inboundText(gchatEventToSurfaceMessage({ ...common, type: "APP_HOME" })), "/start");

  const binding = bindSurfaceAction({ command: "/reports" });
  assert.equal(inboundText(gchatEventToSurfaceMessage({
    ...common,
    type: "SUBMIT_FORM",
    common: {
      user: common.user,
      invokedFunction: "muster_command",
      parameters: { command: binding! },
      formInputs: { period: { stringInputs: { value: ["7d"] } } },
    },
  })), "/reports period=7d");

  const dialog = surfaceReplyToGchatResponse({
    text: "Choose a period",
    presentation: {
      kind: "form",
      title: "Report filters",
      summary: "Choose the report period.",
      filters: [{ id: "period", label: "Period", options: [{ label: "7 days", value: "7d" }, { label: "30 days", value: "30d" }] }],
      actions: [{ id: "apply", label: "Apply", command: "/reports", kind: "filter", style: "primary" }],
    },
  });
  assert.equal(dialog.actionResponse?.type, "DIALOG");
  assert.equal(dialog.actionResponse?.dialogAction.dialog.body.sections[0].widgets.some((widget) => widget.selectionInput?.name === "period"), true);
});

test("mobile pagination truncates rows and unsupported callbacks retain a text fallback", () => {
  const rows = Array.from({ length: 17 }, (_, index) => [`Row ${index + 1}`, `Value ${index + 1}`]);
  const page = paginateRows(rows, 2, 5);
  assert.equal(page.rows.length, 5);
  assert.deepEqual(page.pagination, { page: 2, pageSize: 5, totalRows: 17 });

  const longCommand = `/${"x".repeat(80)}`;
  const reply: SurfaceReply = {
    text: "fallback",
    presentation: {
      kind: "report",
      title: "Mobile report",
      summary: "Page two",
      tables: [{ id: "rows", columns: ["Row", "Value"], rows: page.rows, pagination: page.pagination }],
      actions: [
        { id: "refresh", label: "Refresh", command: "/status" },
        { id: "long", label: "Run long command", command: longCommand },
      ],
    },
  };
  const telegram = surfaceReplyToTelegramSend(reply, "5");
  assert.equal(telegram.reply_markup?.inline_keyboard.flat().length, 1, "only the safe callback should be emitted");
  assert.match(telegram.text, /Run long command/);
  assert.match(telegram.text, /Page 2\/4/);
});

test("async acknowledgement is visible and actionable across channel renderers", () => {
  const reply = createAsyncAcknowledgement({
    id: "work-42",
    label: "Generating the report",
    detail: "Accepted; updates will replace this status.",
    actions: [{ id: "status", label: "Check status", command: "/status" }],
  });
  assert.equal(reply.presentation.work?.state, "accepted");
  assert.match(JSON.stringify(surfaceReplyToSlackPost(reply, "C1")), /Generating the report/);
  assert.match(JSON.stringify(surfaceReplyToTelegramSend(reply, "5")), /muster:cmd:\/status/);
});

test("replay identities and idempotency keys are deterministic", () => {
  const gchat = {
    type: "CARD_CLICKED",
    eventTime: "2026-07-10T10:00:00Z",
    user: { name: "users/1" },
    space: { name: "spaces/A" },
    common: { invokedFunction: "muster_command" },
  };
  assert.equal(gchatDeliveryId(gchat), gchatDeliveryId(structuredClone(gchat)));
  const slack = { type: "block_actions", trigger_id: "trigger-1" };
  assert.equal(slackDeliveryId(slack), "trigger-1");

  const key = `interaction-test-${Date.now()}-${Math.random()}`;
  idempotencyStore(key, { text: "same reply" });
  assert.deepEqual(idempotencyLookup(key), { text: "same reply" });
});

test("Slack form callbacks execute through the gateway once and replay safely", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-slack-action-"));
  await mkdir(join(cwd, ".muster"), { recursive: true });
  const gateway: GatewayConfig = { token: "gateway-token", slack: { botToken: "xoxb-test" } };
  await requestPairing("slack:T1", "U1", cwd).then((pending) => approvePairing(pending.code, cwd));
  const outbound: unknown[] = [];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    outbound.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ ok: true, ts: "1.2" }), { status: 200 });
  }) as typeof fetch;
  const running = await startGatewayServer({ config: defaultConfig(), gateway, cwd, fetcher }, 0);
  const binding = bindSurfaceAction({ command: "/status" });
  const payload = {
    type: "block_actions",
    trigger_id: "trigger-replay-1",
    team: { id: "T1" },
    user: { id: "U1" },
    channel: { id: "C1" },
    container: { message_ts: "1.1" },
    actions: [{ action_id: "status", action_ts: "1.2", value: binding }],
  };
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const post = () => fetch(`http://127.0.0.1:${running.port}/v1/adapters/slack`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Bearer gateway-token" },
    body,
  });
  try {
    assert.equal((await post()).status, 200);
    assert.equal(outbound.length, 1);
    assert.match(JSON.stringify(outbound[0]), /Status/);
    assert.equal((await post()).status, 200);
    assert.equal(outbound.length, 1, "replayed action must not rerun or redeliver");
  } finally {
    await running.close();
  }
});

test("Telegram callbacks clear the spinner, execute once, and acknowledge replays", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-telegram-action-"));
  await mkdir(join(cwd, ".muster"), { recursive: true });
  const gateway: GatewayConfig = { token: "gateway-token", telegram: { botToken: "123:test" } };
  await requestPairing("telegram:bot", "7", cwd).then((pending) => approvePairing(pending.code, cwd));
  const methods: string[] = [];
  const fetcher = (async (url: string | URL | Request) => {
    methods.push(String(url).split("/").pop() ?? "");
    return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), { status: 200 });
  }) as typeof fetch;
  const running = await startGatewayServer({ config: defaultConfig(), gateway, cwd, fetcher }, 0);
  const update = {
    update_id: 90,
    callback_query: {
      id: "callback-90",
      from: { id: 7 },
      data: bindSurfaceAction({ command: "/status" }),
      message: { message_id: 8, chat: { id: 5 } },
    },
  };
  const post = () => fetch(`http://127.0.0.1:${running.port}/v1/adapters/telegram`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer gateway-token" },
    body: JSON.stringify(update),
  });
  try {
    assert.equal((await post()).status, 200);
    assert.equal((await post()).status, 200);
    assert.equal(methods.filter((method) => method === "answerCallbackQuery").length, 2, "every callback delivery should clear the client spinner");
    assert.equal(methods.filter((method) => method === "sendMessage").length, 1, "replay must not rerun or redeliver the command");
  } finally {
    await running.close();
  }
});

test("Google Chat bearer verification fails closed and accepts only verifier-approved requests", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gchat-verifier-"));
  await mkdir(join(cwd, ".muster"), { recursive: true });
  const gateway: GatewayConfig = { token: "gateway-token", gchat: { verification: { mode: "bearer", audience: "chat-app-123" } } };
  const payload = {
    type: "APP_HOME",
    eventTime: "2026-07-10T10:00:00Z",
    user: { name: "users/1", type: "HUMAN" },
    space: { name: "spaces/A" },
  };
  const post = (port: number) => fetch(`http://127.0.0.1:${port}/v1/adapters/gchat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer google-oidc-token" },
    body: JSON.stringify(payload),
  });

  const noVerifier = await startGatewayServer({ config: defaultConfig(), gateway, cwd }, 0);
  try {
    assert.equal((await post(noVerifier.port)).status, 401);
  } finally {
    await noVerifier.close();
  }

  const denied = await startGatewayServer({ config: defaultConfig(), gateway, cwd, gchatVerifier: { verify: () => false } }, 0);
  try {
    assert.equal((await post(denied.port)).status, 401);
  } finally {
    await denied.close();
  }

  let inspectedAudience = "";
  const accepted = await startGatewayServer({
    config: defaultConfig(),
    gateway,
    cwd,
    gchatVerifier: { verify: (input) => { inspectedAudience = input.audience; return input.authorization === "Bearer google-oidc-token"; } },
  }, 0);
  try {
    const response = await post(accepted.port);
    assert.equal(response.status, 200);
    assert.equal(inspectedAudience, "chat-app-123");
    assert.match(JSON.stringify(await response.json()), /muster pairing approve/);
  } finally {
    await accepted.close();
  }
});
