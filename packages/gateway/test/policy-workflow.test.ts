import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfig, enterpriseWindowBounds } from "@musterhq/core";
import {
  createInMemoryGatewayEnterpriseRuntime,
  dispatchCommand,
  enforceGatewayRateLimits,
  gatewayEnterpriseSubjects,
  openSqliteGatewayEnterpriseRuntime,
  type GatewayConfig,
  type PairedSender,
  type SurfaceMessage,
} from "../src/index.js";

const MANAGER: PairedSender = {
  pairingId: "pair-ajay",
  surfaceId: "telegram",
  senderId: "ajay",
  approvedAt: "2026-07-14T00:00:00.000Z",
  identity: {
    provider: "frappe",
    site: "https://site-a.example.test",
    user: "ajay@example.test",
    employee: "EMP-AJAY",
    department: "Operations",
    roles: ["Employee", "Reports Manager"],
    resolvedAt: "2026-07-14T00:00:00.000Z",
  },
};

function gateway(overrides: GatewayConfig["governance"] = {}): GatewayConfig {
  return {
    token: "test",
    governance: {
      enabled: true,
      assignments: {
        default: {
          roles: ["Reports Manager"],
          managedUserIds: ["alice@example.test"],
          managedDepartmentIds: ["Operations"],
          ...overrides?.assignments?.default,
        },
      },
      ...overrides,
    },
  };
}

function message(text: string, senderId = MANAGER.senderId): SurfaceMessage {
  return { surfaceId: MANAGER.surfaceId, conversationId: "chat-1", senderId, text };
}

function context(enterprise: ReturnType<typeof createInMemoryGatewayEnterpriseRuntime>, config = gateway()) {
  return {
    config: defaultConfig(),
    profile: "enterprise",
    paired: MANAGER,
    gateway: config,
    enterprise,
    conversationKey: "telegram:chat-1",
  };
}

function tokenFromPreview(reply: Awaited<ReturnType<typeof dispatchCommand>>): string {
  const token = reply?.presentation?.actions?.find((action) => action.id.includes("apply"))?.command.split(" ").at(-1);
  assert.ok(token?.startsWith("muster_limit_"));
  return token;
}

test("policy targets are proven scopes, drafts require preview, and apply is actor-bound", async () => {
  const enterprise = createInMemoryGatewayEnterpriseRuntime();
  const preview = await dispatchCommand(message("/limits set scope=department:Operations window=hour requests=2"), context(enterprise));
  assert.equal(preview?.presentation?.title, "Review this limit");
  const token = tokenFromPreview(preview);
  assert.match(preview?.text ?? "", /What will change/);
  assert.doesNotMatch(preview?.text ?? "", /User request:|first request|second request/i);

  const unauthorized = await dispatchCommand(message("/limits set scope=user:global@example.test window=hour requests=1"), context(enterprise));
  assert.equal(unauthorized?.presentation?.title, "Limit preview rejected");
  assert.equal((await enterprise.policyStore.listPolicies()).length, 0);

  const wrongActor = await dispatchCommand(message(`/limits apply ${token}`, "other-sender"), context(enterprise));
  assert.equal(wrongActor?.presentation?.title, "Limit apply rejected");
  assert.equal((await enterprise.policyStore.listPolicies()).length, 0);

  const applied = await dispatchCommand(message(`/limits apply ${token}`), context(enterprise));
  assert.equal(applied?.presentation?.title, "Limit applied");
  const replay = await dispatchCommand(message(`/limits apply ${token}`), context(enterprise));
  assert.equal(replay?.presentation?.title, "Limit apply rejected");
});

test("limit setup is a short progressive workflow with only authorized choices", async () => {
  const enterprise = createInMemoryGatewayEnterpriseRuntime();
  const pickTarget = await dispatchCommand(message("/limits set"), context(enterprise));
  assert.equal(pickTarget?.presentation?.title, "Who should this apply to?");
  assert.ok((pickTarget?.presentation?.actions?.length ?? 0) <= 3);
  assert.doesNotMatch(pickTarget?.text ?? "", /scope=|doctype|property setter/i);
  const managedPage = await dispatchCommand(message("/limits set p=3"), context(enterprise));
  const managedIndex = managedPage?.presentation?.actions?.find((action) => /Alice/i.test(action.label))?.command.match(/t=(\d+)/)?.[1];
  assert.ok(managedIndex);

  const pickMetric = await dispatchCommand(message(`/limits set t=${managedIndex}`), context(enterprise));
  assert.equal(pickMetric?.presentation?.title, "What should be controlled?");
  assert.deepEqual(pickMetric?.presentation?.actions?.slice(0, 2).map((action) => action.label), ["Number of requests", "Token allowance"]);

  const pickWindow = await dispatchCommand(message(`/limits set t=${managedIndex} m=r`), context(enterprise));
  assert.equal(pickWindow?.presentation?.title, "When should the allowance reset?");
  assert.ok((pickWindow?.presentation?.actions?.length ?? 0) <= 3);

  const pickAmount = await dispatchCommand(message(`/limits set t=${managedIndex} m=r w=d`), context(enterprise));
  assert.equal(pickAmount?.presentation?.title, "Choose the allowance");
  assert.ok((pickAmount?.presentation?.actions?.length ?? 0) <= 3);

  const review = await dispatchCommand(message(`/limits set t=${managedIndex} m=r w=d a=25`), context(enterprise));
  assert.equal(review?.presentation?.title, "Review this limit");
  assert.match(review?.text ?? "", /Alice/);
  assert.doesNotMatch(review?.text ?? "", /user:alice@example\.test/);
});

test("policy drafts expire and persisted policies survive gateway restart", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-policy-store-"));
  const first = openSqliteGatewayEnterpriseRuntime(cwd);
  const actor = { surfaceId: "telegram", senderId: "ajay", pairingId: "pair-ajay" };
  try {
    const expired = await first.policyStore.createDraft({
      actor,
      policy: { subject: { kind: "user", id: "ajay@example.test" }, window: "day", maxTokens: 100 },
      nowMs: 1_000,
      ttlMs: 1_000,
    });
    await assert.rejects(() => first.policyStore.applyDraft({ actor, token: expired.token, nowMs: 2_001 }), /invalid, expired/);

    const persistent = await first.policyStore.createDraft({
      actor,
      policy: { subject: { kind: "department", id: "Operations" }, window: "hour", maxRuns: 2, maxTokens: 500 },
      nowMs: Date.now(),
    });
    await first.policyStore.applyDraft({ actor, token: persistent.token });
  } finally {
    await first.close?.();
  }
  const second = openSqliteGatewayEnterpriseRuntime(cwd);
  try {
    const policies = await second.policyStore.listPolicies();
    assert.equal(policies.length, 1);
    assert.deepEqual(policies[0]?.subject, { kind: "department", id: "Operations" });
    assert.equal(policies[0]?.maxTokens, 500);
  } finally {
    await second.close?.();
  }
});

test("persisted policies are enforced atomically and reported from the same counters", async () => {
  const enterprise = createInMemoryGatewayEnterpriseRuntime();
  const actor = { surfaceId: MANAGER.surfaceId, senderId: MANAGER.senderId, pairingId: MANAGER.pairingId };
  const draft = await enterprise.policyStore.createDraft({
    actor,
    policy: { subject: { kind: "department", id: "Operations" }, window: "hour", maxRuns: 1, maxTokens: 10_000 },
  });
  await enterprise.policyStore.applyDraft({ actor, token: draft.token });
  const config = gateway({ enabled: true, estimatedOutputTokens: 1 });
  const assignment = config.governance?.assignments?.default ?? {};
  const first = await enforceGatewayRateLimits({ runtime: enterprise, gateway: config, message: message("first request"), paired: MANAGER, assignment, agentId: "enterprise", estimatedTokens: 1 });
  assert.equal(first.blocked, undefined);
  const second = await enforceGatewayRateLimits({ runtime: enterprise, gateway: config, message: message("second request"), paired: MANAGER, assignment, agentId: "enterprise", estimatedTokens: 1 });
  assert.match(second.blocked ?? "", /Rate limit exceeded/);
  const bounds = enterpriseWindowBounds("hour", Date.now());
  const used = await enterprise.rateLimitStore.readRateLimit({ key: `gateway:department:Operations:${bounds.key}:runs`, windowStartMs: bounds.startMs, nowMs: Date.now() });
  assert.equal(used, 1);

  const limits = await dispatchCommand(message("/limits"), context(enterprise, config));
  assert.match(limits?.text ?? "", /department:Operations/);
  assert.match(limits?.text ?? "", /1 \/ 1/);
});

test("Frappe System Manager reporting is site-bounded without a static tenant flag", async () => {
  const enterprise = createInMemoryGatewayEnterpriseRuntime();
  await enterprise.usageStore.appendUsage({
    eventId: "site-a", occurredAt: new Date().toISOString(),
    subjects: [{ kind: "site", id: "https://site-a.example.test" }, { kind: "user", id: "alice@example.test" }],
    outcome: "success", latencyMs: 10, inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, costMicrousd: 0, cacheStatus: "bypass",
  });
  await enterprise.usageStore.appendUsage({
    eventId: "site-b", occurredAt: new Date().toISOString(),
    subjects: [{ kind: "site", id: "https://site-b.example.test" }, { kind: "user", id: "other@example.test" }],
    outcome: "success", latencyMs: 10, inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, costMicrousd: 0, cacheStatus: "bypass",
  });
  const system: PairedSender = { ...MANAGER, identity: { ...MANAGER.identity!, roles: ["System Manager"] } };
  const reply = await dispatchCommand(message("/usage scope=team"), { ...context(enterprise), paired: system, gateway: gateway({ assignments: { default: { roles: ["System Manager"] } } }) });
  assert.equal(reply?.presentation?.kpis?.find((kpi) => kpi.label === "Runs")?.value, "1");
  assert.doesNotMatch(reply?.text ?? "", /other@example|site-b|prompt text/i);
});

test("identity department becomes a usage subject and unauthorized managers do not see team usage", async () => {
  const subjects = gatewayEnterpriseSubjects(message("hello"), MANAGER, {});
  assert.ok(subjects.some((subject) => subject.kind === "department" && subject.id === "Operations"));
  const enterprise = createInMemoryGatewayEnterpriseRuntime();
  const noScope: PairedSender = { ...MANAGER, identity: { ...MANAGER.identity!, roles: ["Employee"] } };
  const reply = await dispatchCommand(message("/reports"), { ...context(enterprise), paired: noScope, gateway: gateway({ assignments: { default: { roles: ["Employee"] } } }) });
  assert.doesNotMatch(JSON.stringify(reply?.presentation), /Team usage|Team reports/i);
});
