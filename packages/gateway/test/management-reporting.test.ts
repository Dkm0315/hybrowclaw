import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultConfig } from "@musterhq/core";
import {
  createInMemoryGatewayEnterpriseRuntime,
  dispatchCommand,
} from "../src/index.js";
import type { GatewayConfig, PairedSender, SurfaceMessage } from "../src/index.js";

const PAIRED: PairedSender = {
  pairingId: "pair-manager",
  surfaceId: "gchat:app",
  senderId: "users/manager",
  approvedAt: "2026-07-10T00:00:00.000Z",
  identity: {
    provider: "frappe",
    site: "https://erp.example.test",
    user: "manager@example.test",
    employee: "EMP-MANAGER",
    roles: ["Reports Manager"],
    resolvedAt: "2026-07-10T00:00:00.000Z",
  },
};

function message(text: string): SurfaceMessage {
  return {
    surfaceId: "gchat:app",
    conversationId: "spaces/management",
    senderId: "users/manager",
    text,
  };
}

function gateway(canViewIdentifiedUsage = true): GatewayConfig {
  return {
    token: "test",
    governance: {
      assignments: {
        default: {
          tenantId: "tenant-oxygen",
          roles: ["Reports Manager"],
          managedUserIds: ["alice@example.test", "bob@example.test"],
          managedDepartmentIds: ["HR", "Finance"],
          canViewIdentifiedUsage,
        },
      },
    },
  };
}

function context(enterprise: ReturnType<typeof createInMemoryGatewayEnterpriseRuntime>, canViewIdentifiedUsage = true) {
  return {
    config: defaultConfig(),
    profile: "enterprise",
    paired: PAIRED,
    gateway: gateway(canViewIdentifiedUsage),
    conversationKey: "gchat:app:spaces/management",
    enterprise,
  };
}

async function addUsage(
  enterprise: ReturnType<typeof createInMemoryGatewayEnterpriseRuntime>,
  input: {
    readonly eventId: string;
    readonly daysAgo: number;
    readonly user: string;
    readonly department: string;
    readonly channel: string;
    readonly provider: string;
    readonly workload: string;
    readonly outcome: "success" | "error" | "blocked";
    readonly cacheStatus: "hit" | "miss" | "bypass";
  },
): Promise<void> {
  await enterprise.usageStore.appendUsage({
    eventId: input.eventId,
    occurredAt: new Date(Date.now() - input.daysAgo * 24 * 60 * 60_000).toISOString(),
    subjects: [
      { kind: "tenant", id: "tenant-oxygen" },
      { kind: "user", id: input.user },
      { kind: "department", id: input.department },
      { kind: "channel", id: `${input.channel}:spaces/management` },
      { kind: "provider", id: input.provider },
    ],
    outcome: input.outcome,
    latencyMs: 100,
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: input.cacheStatus === "hit" ? 40 : 0,
    costMicrousd: 999,
    cacheStatus: input.cacheStatus,
    requestCategory: input.workload,
  });
}

test("usage defaults to seven days, reports outcome rates, and omits unverifiable billing", async () => {
  const enterprise = createInMemoryGatewayEnterpriseRuntime();
  await addUsage(enterprise, {
    eventId: "recent-success",
    daysAgo: 1,
    user: "alice@example.test",
    department: "HR",
    channel: "gchat",
    provider: "openai",
    workload: "retrieval",
    outcome: "success",
    cacheStatus: "hit",
  });
  await addUsage(enterprise, {
    eventId: "recent-error",
    daysAgo: 2,
    user: "bob@example.test",
    department: "Finance",
    channel: "telegram",
    provider: "anthropic",
    workload: "artifact",
    outcome: "error",
    cacheStatus: "miss",
  });
  await addUsage(enterprise, {
    eventId: "recent-blocked",
    daysAgo: 3,
    user: "alice@example.test",
    department: "HR",
    channel: "gchat",
    provider: "openai",
    workload: "retrieval",
    outcome: "blocked",
    cacheStatus: "bypass",
  });
  await addUsage(enterprise, {
    eventId: "outside-default-period",
    daysAgo: 10,
    user: "alice@example.test",
    department: "HR",
    channel: "gchat",
    provider: "openai",
    workload: "retrieval",
    outcome: "success",
    cacheStatus: "hit",
  });

  const reply = await dispatchCommand(message("/usage scope=team"), context(enterprise));
  assert.ok(reply?.presentation);
  const kpi = (label: string) => reply.presentation.kpis?.find((item) => item.label === label)?.value;
  assert.equal(kpi("Period"), "Last 7 days");
  assert.equal(kpi("Runs"), "3");
  assert.equal(kpi("Success"), "33.3%");
  assert.equal(kpi("Errors"), "33.3%");
  assert.equal(kpi("Blocked safely"), "33.3%");
  assert.equal(reply.presentation.kpis?.some((item) => item.label === "Cost"), false);
  assert.match(reply.text, /billing is shown only after a verifiable provider billing source/i);
  assert.doesNotMatch(reply.text, /999|micro-?USD|\$/i);

  const period = reply.presentation.filters?.find((filter) => filter.id === "period");
  assert.equal(period?.selected, "7d");
  assert.equal(period?.action?.command, "/usage scope=team period={value}");
  assert.deepEqual(reply.presentation.filters?.map((filter) => filter.id), ["period", "scope"], "overview should not dump every management filter");
  assert.ok(reply.presentation.actions?.some((action) => action.command.includes("view=work")));

  const breakdown = await dispatchCommand(message("/usage scope=team view=work"), context(enterprise));
  for (const id of ["user", "department", "channel", "provider", "workload"]) {
    assert.ok(breakdown?.presentation?.filters?.some((filter) => filter.id === id), `${id} should appear only after opening the breakdown`);
  }
  assert.equal(reply.presentation.kpis?.some((item) => item.label === "Cache hit"), false);
});

test("authorized management filters execute across user, department, channel, provider, and workload", async () => {
  const enterprise = createInMemoryGatewayEnterpriseRuntime();
  await addUsage(enterprise, {
    eventId: "matching-run",
    daysAgo: 1,
    user: "alice@example.test",
    department: "HR",
    channel: "gchat",
    provider: "openai",
    workload: "retrieval",
    outcome: "success",
    cacheStatus: "bypass",
  });
  await addUsage(enterprise, {
    eventId: "non-matching-run",
    daysAgo: 1,
    user: "bob@example.test",
    department: "Finance",
    channel: "telegram",
    provider: "anthropic",
    workload: "artifact",
    outcome: "success",
    cacheStatus: "bypass",
  });

  const reply = await dispatchCommand(
    message("/usage scope=team period=30d user=alice%40example.test department=HR channel=gchat provider=openai workload=retrieval outcome=success"),
    context(enterprise),
  );
  assert.equal(reply?.presentation?.kpis?.find((item) => item.label === "Runs")?.value, "1");
  assert.match(reply?.presentation?.privacy?.note ?? "", /authorized person-level drill-downs/i);
  for (const id of ["user", "department", "channel", "provider", "workload"]) {
    const filter = reply?.presentation?.filters?.find((item) => item.id === id);
    assert.ok(filter?.action?.command.includes(`${id}={value}`), `${id} filter must be executable`);
  }
});

test("manager user drilldowns remain hidden without identified-usage authorization", async () => {
  const enterprise = createInMemoryGatewayEnterpriseRuntime();
  await addUsage(enterprise, {
    eventId: "private-run",
    daysAgo: 1,
    user: "alice@example.test",
    department: "HR",
    channel: "gchat",
    provider: "openai",
    workload: "retrieval",
    outcome: "success",
    cacheStatus: "bypass",
  });

  const reply = await dispatchCommand(message("/usage scope=team"), context(enterprise, false));
  assert.equal(reply?.presentation?.filters?.some((filter) => filter.id === "user"), false);
  assert.doesNotMatch(JSON.stringify(reply?.presentation), /alice@example\.test/);
  assert.match(reply?.presentation?.privacy?.note ?? "", /unapproved user identities are not included/i);
});

test("limits distinguish an unavailable counter from an uncapped policy", async () => {
  const configured: GatewayConfig = {
    token: "test",
    governance: {
      assignments: { default: { userId: "manager@example.test" } },
      rateLimits: [{ subject: { kind: "user", id: "manager@example.test" }, window: "day", maxRuns: 5, maxTokens: 1000 }],
    },
  };
  const reply = await dispatchCommand(message("/limits"), {
    config: defaultConfig(),
    profile: "enterprise",
    paired: PAIRED,
    gateway: configured,
    conversationKey: "gchat:app:spaces/management",
  });
  assert.ok(reply?.presentation);
  assert.equal(reply.presentation.kpis?.find((item) => item.label === "Request balance")?.value, "Counter unavailable");
  assert.equal(reply.presentation.kpis?.find((item) => item.label === "Token balance")?.value, "Counter unavailable");
  assert.match(reply.text, /no provider billing amount/i);
  assert.doesNotMatch(reply.text, /provider credits|\$\d/i);
});
