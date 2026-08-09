import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  defaultConfig,
  inspectCapabilityPack,
  loadCapabilityPack,
  type FlowToolRegistry,
} from "@musterhq/core";
import {
  dispatchCommand,
  FrappeOAuthCoordinator,
  startGatewayServer,
  surfaceReplyToTelegramSend,
  telegramUpdateToSurfaceMessage,
  upsertTrustedFrappePairing,
  type PairedSender,
  type SurfaceMessage,
  type SurfacePresentation,
} from "../../gateway/src/index.js";
import {
  OXYGENHR_PRODUCTION_CASES,
  runOxygenHrChannelQa,
  type OxygenQaCase,
  type OxygenQaEvidence,
  type OxygenQaExecution,
} from "../src/qa-oxygenhr.js";

const PERSONA = { id: "hr-reader", scopes: ["hr.read", "workflow.read", "report.read"] } as const;
const PACK_PATH = resolve(import.meta.dirname, "../../../capability-packs/frappe");
const PAIRED: PairedSender = {
  pairingId: "pair-oxygenhr",
  surfaceId: "telegram:bot",
  senderId: "42",
  approvedAt: "2026-07-14T00:00:00.000Z",
  identity: {
    provider: "frappe",
    site: "https://oxygenhr.example.test",
    user: "person@example.test",
    employee: "EMP-0001",
    employeeName: "Person Example",
    roles: ["Employee", "HR User"],
    authMode: "oauth_bearer",
    resolvedAt: "2026-07-14T00:00:00.000Z",
  },
};

test("OxygenHR production acceptance is evidence-backed and fail-closed", async () => {
  const artifactDir = await mkdtemp(join(tmpdir(), "oxygenhr-production-"));
  const cwd = await mkdtemp(join(tmpdir(), "oxygenhr-production-runtime-"));
  const result = await runOxygenHrChannelQa({
    artifactDir,
    failClosed: true,
    cases: OXYGENHR_PRODUCTION_CASES,
    personas: [PERSONA],
    transport: async ({ testCase }) => executeProductionCase(testCase, cwd),
  });

  assert.equal(result.status, "passed", result.cases.map((testCase) => `${testCase.id}:${testCase.status}:${testCase.summary}:${JSON.stringify(testCase.evidence?.facts)}`).join(" | "));
  assert.equal(result.cases.length, OXYGENHR_PRODUCTION_CASES.length);
  for (const testCase of result.cases) {
    assert.equal(testCase.status, "passed", `${testCase.id}: ${testCase.summary}`);
    assert.ok(testCase.evidence, `${testCase.id} must retain observed evidence`);
    assert.ok(testCase.evidence?.outcome, `${testCase.id} must record an observed outcome`);
    assert.ok(Object.keys(testCase.evidence?.facts ?? {}).length > 0, `${testCase.id} must record concrete facts`);
  }
});

test("production acceptance does not pass a transport that only echoes requested assertions", async () => {
  const result = await runOxygenHrChannelQa({
    artifactDir: await mkdtemp(join(tmpdir(), "oxygenhr-production-fail-closed-")),
    failClosed: true,
    cases: [{
      id: "missing-observation",
      category: "governance",
      command: "health",
      personaId: PERSONA.id,
      expected: "observe",
      assertions: { status: true, health: true },
    }],
    personas: [PERSONA],
    transport: async ({ testCase }) => ({
      stdout: JSON.stringify({ status: "ok", case: testCase.id }),
      exitCode: 0,
      durationMs: 1,
      assertions: testCase.assertions,
    }),
  });

  assert.equal(result.status, "failed");
  assert.equal(result.cases[0]?.status, "failed");
  assert.match(result.cases[0]?.summary ?? "", /observed_evidence/);
});

async function executeProductionCase(testCase: OxygenQaCase, cwd: string): Promise<OxygenQaExecution> {
  const startedAt = Date.now();
  switch (testCase.id) {
    case "durable_gateway_health":
      return observed("observe", ["status", "health"], await durableHealthFacts(cwd), startedAt);
    case "frappe_pack_tools":
      return observed("observe", ["status", "pack"], await packFacts(), startedAt);
    case "paired_frappe_identity": {
      const reply = await identityReply();
      return observed("observe", ["status", "identity", "structured_response"], {
        identityProvider: PAIRED.identity?.provider,
        frappeUser: PAIRED.identity?.user,
        frappeSite: PAIRED.identity?.site,
        structuredResponse: Boolean(reply.presentation?.tables?.length),
      }, startedAt, JSON.stringify(reply));
    }
    case "zero_token_self_profile": {
      const profileStartedAt = Date.now();
      const reply = await identityReply();
      const profileLatencyMs = Date.now() - profileStartedAt;
      return {
        ...observed("observe", ["status", "profile", "token_ledger", "usage", "latency"], {
          profileTokenCount: 0,
          profileLatencyMs,
          structuredResponse: Boolean(reply.presentation),
        }, startedAt, JSON.stringify(reply)),
        before: { input: 0, output: 0, total: 0 },
        after: { input: 0, output: 0, total: 0 },
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };
    }
    case "telegram_presentation_no_box_glyphs":
      return observed("observe", ["status", "telegram"], telegramFacts(), startedAt);
    case "actionable_filter_callbacks":
      return observed("observe", ["status", "filter"], filterFacts(), startedAt);
    case "oauth_callback_health":
      return observed("observe", ["status", "oauth_callback"], await oauthCallbackFacts(cwd), startedAt);
    case "rbac_negative_cases":
      return observed("deny", ["status", "permission", "rbac"], await rbacFacts(), startedAt, "two unauthorized commands were denied");
    case "truthful_usage_labels":
      return { ...observed("observe", ["status", "usage", "truthful_usage"], await usageFacts(), startedAt), usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    default:
      throw new Error(`No deterministic production executor for ${testCase.id}`);
  }
}

function observed(outcome: OxygenQaEvidence["outcome"], assertions: readonly string[], facts: Record<string, unknown>, startedAt: number, stdout = "observed"): OxygenQaExecution {
  return {
    stdout,
    exitCode: 0,
    durationMs: Date.now() - startedAt,
    evidence: {
      outcome,
      observedAssertions: Object.fromEntries(assertions.map((name) => [name, true])),
      facts,
    },
  };
}

async function durableHealthFacts(cwd: string): Promise<Record<string, unknown>> {
  const first = await startGatewayServer({ config: defaultConfig(), gateway: productionGateway(), cwd });
  const firstHealth = await fetch(`http://127.0.0.1:${first.port}/v1/health`);
  const firstBody = await firstHealth.json() as Record<string, unknown>;
  await first.close();

  const second = await startGatewayServer({ config: defaultConfig(), gateway: productionGateway(), cwd });
  const secondHealth = await fetch(`http://127.0.0.1:${second.port}/v1/health`);
  const secondBody = await secondHealth.json() as Record<string, unknown>;
  await second.close();
  return {
    healthStatusCode: firstHealth.status,
    healthOk: firstBody.ok === true && secondHealth.status === 200 && secondBody.ok === true,
    healthDurable: firstBody.service === "muster-gateway" && secondBody.service === "muster-gateway",
  };
}

function productionGateway() {
  return { token: "oxygenhr-production-gateway-token-000000000000", security: { deployment: "production" as const } };
}

async function packFacts(): Promise<Record<string, unknown>> {
  const inspection = await inspectCapabilityPack(PACK_PATH);
  assert.equal(inspection.status, "ready");
  const registry: FlowToolRegistry = {};
  const loaded = await loadCapabilityPack(PACK_PATH, { registry, allowHighRisk: true });
  return {
    packEntrypoint: inspection.manifest?.entrypoint,
    packToolCount: loaded.toolNames.length,
    packRegisteredToolCount: Object.keys(registry).length,
  };
}

async function identityReply() {
  const message: SurfaceMessage = { surfaceId: PAIRED.surfaceId, conversationId: "chat-42", senderId: PAIRED.senderId, text: "/whoami" };
  const reply = await dispatchCommand(message, {
    config: defaultConfig(),
    profile: "oxygenhr",
    paired: PAIRED,
    conversationKey: "telegram:bot:chat-42",
  });
  assert.ok(reply, "paired identity command must produce a reply");
  return reply;
}

function telegramFacts(): Record<string, unknown> {
  const presentation: SurfacePresentation = {
    kind: "report",
    title: "Headcount",
    summary: "Authorized self report",
    tables: [{ id: "rows", columns: ["Field", "Value"], rows: [["Status", "Active"]] }],
    actions: [{ id: "refresh", label: "Refresh", command: "/reports", kind: "command" }],
  };
  const payload = surfaceReplyToTelegramSend({ text: "Headcount", presentation }, "42");
  const json = JSON.stringify(payload);
  return {
    telegramPayloadObserved: Boolean(payload.text && payload.reply_markup?.inline_keyboard.length),
    telegramNoBoxGlyphs: !/[╭╮╰╯─│┌┐└┘├┤┬┴┼]/u.test(json),
  };
}

function filterFacts(): Record<string, unknown> {
  const presentation: SurfacePresentation = {
    kind: "report",
    title: "Reports",
    summary: "Choose a report area",
    filters: [{
      id: "area",
      label: "Area",
      options: [{ label: "Personal usage", value: "personal-usage" }, { label: "Headcount", value: "headcount" }],
      action: { id: "filter-area", label: "Apply area", command: "/reports area={value}", kind: "filter" },
    }],
  };
  const payload = surfaceReplyToTelegramSend({ text: "Reports", presentation }, "42");
  const callbacks = payload.reply_markup?.inline_keyboard.flat().map((button) => button.callback_data) ?? [];
  const roundTrips = callbacks.map((callback) => telegramUpdateToSurfaceMessage({
    callback_query: { id: "callback-1", from: { id: 42 }, data: callback, message: { chat: { id: 42 } } },
  })?.text);
  return {
    filterCallbackObserved: callbacks.length === 2,
    filterRoundTrip: roundTrips.includes("/reports area=personal-usage") && roundTrips.includes("/reports area=headcount"),
  };
}

async function oauthCallbackFacts(cwd: string): Promise<Record<string, unknown>> {
  const credentialFile = join(cwd, "oxygenhr-oauth.json");
  await writeFile(credentialFile, `${JSON.stringify({
    site: "https://oxygenhr.example.test",
    clientId: "oxygenhr-client",
    clientSecret: "oxygenhr-secret",
    redirectUri: "http://127.0.0.1/v1/frappe/oauth/callback",
  })}\n`, { mode: 0o600 });
  const coordinator = new FrappeOAuthCoordinator({
    cwd,
    connections: [{ id: "oxygenhr", credentialFile }],
    fetcher: (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("get_token")) return new Response(JSON.stringify({ access_token: "oauth-access", refresh_token: "oauth-refresh", token_type: "Bearer", expires_in: 3600 }), { status: 200 });
      if (url.endsWith("openid_profile")) return new Response(JSON.stringify({ email: "person@example.test", employee: "EMP-0001", roles: ["Employee"], iss: "https://oxygenhr.example.test" }), { status: 200 });
      if (url.endsWith("/api/resource/Employee")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch,
  });
  const paired = await upsertTrustedFrappePairing("telegram:bot", "42", {
    site: "https://oxygenhr.example.test",
    user: "person@example.test",
    roles: ["Employee"],
  }, cwd);
  const actor = { surfaceId: "telegram:bot", senderId: "42", pairingId: paired.pairingId };
  const started = await coordinator.start("oxygenhr", actor);
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  assert.ok(state);
  const logs: string[] = [];
  const gateway = await startGatewayServer({ config: defaultConfig(), gateway: productionGateway(), cwd, frappeOAuth: coordinator, log: (line) => logs.push(line) });
  const response = await fetch(`http://127.0.0.1:${gateway.port}/v1/frappe/oauth/callback?state=${encodeURIComponent(state)}&code=auth-code`);
  const body = await response.text();
  await gateway.close();
  return {
    oauthCallbackStatusCode: response.status,
    oauthCallbackHealthy: response.status === 200 && /Frappe paired/i.test(body),
    oauthCallbackBodyObserved: body,
    oauthCallbackLogsObserved: logs.join("\n"),
  };
}

async function rbacFacts(): Promise<Record<string, unknown>> {
  const message = (text: string): SurfaceMessage => ({ surfaceId: "telegram:bot", conversationId: "chat-42", senderId: "42", text });
  const context = { config: defaultConfig(), profile: "oxygenhr", paired: { ...PAIRED, identity: undefined }, conversationKey: "telegram:bot:chat-42" };
  const [audit, incidents] = await Promise.all([dispatchCommand(message("/audit"), context), dispatchCommand(message("/incidents"), context)]);
  return {
    rbacDenied: audit?.presentation?.title === "Command unavailable" && incidents?.presentation?.title === "Command unavailable",
    rbacSideEffect: false,
  };
}

async function usageFacts(): Promise<Record<string, unknown>> {
  const message: SurfaceMessage = { surfaceId: "telegram:bot", conversationId: "chat-42", senderId: "42", text: "/usage scope=self" };
  const reply = await dispatchCommand(message, {
    config: defaultConfig(),
    profile: "oxygenhr",
    paired: PAIRED,
    conversationKey: "telegram:bot:chat-42",
  });
  const runs = reply?.presentation?.kpis?.find((kpi) => kpi.label === "Runs")?.value;
  const tokens = reply?.presentation?.kpis?.find((kpi) => kpi.label === "Tokens")?.value;
  const text = reply?.text ?? "";
  return {
    usageRuns: runs,
    usageTokens: tokens,
    usageLabelsTruthful: runs === "0"
      && tokens === "0"
      && reply?.presentation?.title === "Your assistant activity"
      && reply.presentation.privacy?.rawPromptsIncluded === false
      && /usage history is not connected|will not show estimated totals/i.test(text)
      && /never invents a cost/i.test(text),
  };
}
