import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregateEnterpriseUsage,
  buildEnterpriseManagerUsageReport,
  InMemoryEnterpriseUsageStore,
  nearestRankPercentile,
  type EnterpriseSubject,
  type EnterpriseUsageEvent,
} from "../src/index.js";

function usage(
  eventId: string,
  userId: string,
  overrides: Partial<EnterpriseUsageEvent> = {},
): EnterpriseUsageEvent {
  const subjects: EnterpriseSubject[] = [
    { kind: "tenant", id: "acme" },
    { kind: "site", id: "erp.acme.test" },
    { kind: "department", id: "support" },
    { kind: "user", id: userId },
    { kind: "channel", id: "gchat:space-1" },
    { kind: "provider", id: "provider-a" },
    { kind: "model", id: "fast-model" },
  ];
  return {
    eventId,
    occurredAt: "2026-07-10T10:00:00.000Z",
    subjects,
    outcome: "success",
    latencyMs: 20,
    inputTokens: 100,
    outputTokens: 25,
    cachedInputTokens: 50,
    costMicrousd: 120,
    cacheStatus: "hit",
    tool: "frappe.query",
    requestCategory: "operational_lookup",
    ...overrides,
  };
}

test("nearest-rank percentile math is deterministic at boundaries and rejects invalid samples", () => {
  const values = Array.from({ length: 100 }, (_, index) => index + 1);
  assert.equal(nearestRankPercentile([], 0.95), 0);
  assert.equal(nearestRankPercentile([42], 0), 42);
  assert.equal(nearestRankPercentile([42], 1), 42);
  assert.equal(nearestRankPercentile(values, 0.5), 50);
  assert.equal(nearestRankPercentile(values, 0.95), 95);
  assert.equal(nearestRankPercentile(values, 0.99), 99);
  assert.throws(() => nearestRankPercentile([1, Number.NaN], 0.5), /finite and non-negative/);
  assert.throws(() => nearestRankPercentile([1], 1.01), /between 0 and 1/);
});

test("usage aggregation exposes token, cost, latency, cache, provider, and tool dimensions", () => {
  const events = [
    usage("e1", "u-1", { latencyMs: 10, inputTokens: 100, outputTokens: 10, cachedInputTokens: 80, costMicrousd: 100, cacheStatus: "hit" }),
    usage("e2", "u-1", { latencyMs: 20, inputTokens: 200, outputTokens: 20, cachedInputTokens: 0, costMicrousd: 200, cacheStatus: "miss", outcome: "error" }),
    usage("e3", "u-2", { latencyMs: 100, inputTokens: 300, outputTokens: 30, cachedInputTokens: 0, costMicrousd: 300, cacheStatus: "bypass", tool: "mcp.search", subjects: [
      { kind: "tenant", id: "acme" },
      { kind: "department", id: "support" },
      { kind: "user", id: "u-2" },
      { kind: "provider", id: "provider-b" },
      { kind: "model", id: "deep-model" },
      { kind: "mcp", id: "search" },
    ] }),
  ];
  const report = aggregateEnterpriseUsage(events, ["provider", "tool"]);

  assert.deepEqual({
    runs: report.totals.runs,
    success: report.totals.successfulRuns,
    failed: report.totals.failedRuns,
    tokens: report.totals.totalTokens,
    cached: report.totals.cachedInputTokens,
    cost: report.totals.costMicrousd,
    hitRate: report.totals.cacheHitRate,
    p50: report.totals.p50LatencyMs,
    p95: report.totals.p95LatencyMs,
    p99: report.totals.p99LatencyMs,
  }, { runs: 3, success: 2, failed: 1, tokens: 660, cached: 80, cost: 600, hitRate: 50, p50: 20, p95: 100, p99: 100 });
  assert.deepEqual(report.groups.map((group) => group.key), [
    "provider=provider-a|tool=frappe.query",
    "provider=provider-b|tool=mcp.search",
  ]);
});

test("manager reports enforce subordinate and department scope and pseudonymize users by default", () => {
  const malicious = {
    ...usage("e1", "u-1"),
    rawPrompt: "show me private payroll",
    secretPayload: "must not survive normalization",
  } as EnterpriseUsageEvent;
  const events = [
    malicious,
    usage("e2", "u-2", { occurredAt: "2026-07-10T11:00:00.000Z", requestCategory: "document_create" }),
    usage("e3", "outside", { occurredAt: "2026-07-10T12:00:00.000Z" }),
    usage("e4", "u-1", { occurredAt: "2026-07-09T12:00:00.000Z" }),
    usage("e5", "u-1", { subjects: [
      { kind: "tenant", id: "acme" },
      { kind: "department", id: "finance" },
      { kind: "user", id: "u-1" },
      { kind: "provider", id: "provider-a" },
    ] }),
  ];
  const report = buildEnterpriseManagerUsageReport({
    managerScope: {
      managerUserId: "manager-1",
      subordinateUserIds: ["u-1", "u-2"],
      departmentIds: ["support"],
      additionalScope: [{ kind: "tenant", id: "acme" }],
    },
    events,
    groupBy: ["user", "request_category", "hour"],
    from: "2026-07-10T00:00:00.000Z",
    to: "2026-07-11T00:00:00.000Z",
    generatedAt: "2026-07-10T13:00:00.000Z",
  });

  const serialized = JSON.stringify(report);
  assert.equal(report.totals.runs, 2);
  assert.equal(report.privacy.rawPromptsIncluded, false);
  assert.equal(report.privacy.userIdentity, "pseudonymous");
  assert.equal(serialized.includes('"user":"u-1"'), false);
  assert.equal(serialized.includes('"user":"u-2"'), false);
  assert.doesNotMatch(serialized, /outside|private payroll|secretPayload|"rawPrompt":/);
  assert.match(serialized, /user_[a-f0-9]{10}/);
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.groups), true);
});

test("identified manager reports require explicit authority and still contain no prompt field", () => {
  const base = {
    managerScope: { managerUserId: "manager-1", subordinateUserIds: ["u-1"] },
    events: [usage("e1", "u-1")],
    groupBy: ["user" as const],
    privacy: { userIdentity: "identified" as const },
    generatedAt: "2026-07-10T13:00:00.000Z",
  };
  assert.throws(() => buildEnterpriseManagerUsageReport(base), /does not permit identified/);

  const report = buildEnterpriseManagerUsageReport({
    ...base,
    managerScope: { ...base.managerScope, canViewIdentifiedUsage: true },
  });
  assert.equal(report.groups[0]?.dimensions.user, "u-1");
  assert.equal(report.privacy.rawPromptsIncluded, false);
  assert.doesNotMatch(JSON.stringify(report), /"rawPrompt":|private payroll/i);
});

test("manager report minimum group size suppresses narrow drilldowns without changing scoped totals", () => {
  const report = buildEnterpriseManagerUsageReport({
    managerScope: { managerUserId: "manager-1", subordinateUserIds: ["u-1", "u-2"] },
    events: [usage("e1", "u-1"), usage("e2", "u-2", { requestCategory: "document_create" })],
    groupBy: ["request_category"],
    privacy: { userIdentity: "aggregate", minGroupSize: 2 },
    generatedAt: "2026-07-10T13:00:00.000Z",
  });
  assert.equal(report.totals.runs, 2);
  assert.equal(report.groups.length, 0);
  assert.equal(report.suppressedGroups, 2);
});

test("in-memory usage store is idempotent, bounded, queryable, and strips unknown runtime fields", async () => {
  const store = new InMemoryEnterpriseUsageStore(2);
  const first = { ...usage("e1", "u-1"), rawPrompt: "private" } as EnterpriseUsageEvent;
  await Promise.all(Array.from({ length: 20 }, () => store.appendUsage(first)));
  await store.appendUsage(usage("e2", "u-2", { occurredAt: "2026-07-10T11:00:00.000Z" }));
  await store.appendUsage(usage("e3", "u-3", { occurredAt: "2026-07-10T12:00:00.000Z" }));

  const all = await store.queryUsage();
  assert.deepEqual(all.map((event) => event.eventId), ["e2", "e3"]);
  assert.doesNotMatch(JSON.stringify(all), /private|rawPrompt/);
  const filtered = await store.queryUsage({ subjects: [{ kind: "user", id: "u-3" }], limit: 1 });
  assert.deepEqual(filtered.map((event) => event.eventId), ["e3"]);
  await assert.rejects(store.appendUsage(usage("e3", "u-3", { latencyMs: 999 })), /different content/);
  await assert.rejects(store.queryUsage({ limit: 0 }), /positive safe integer/);
});

test("usage validation rejects negative, non-finite, and impossible cache metrics", () => {
  assert.throws(() => aggregateEnterpriseUsage([usage("bad", "u-1", { latencyMs: -1 })]), /latencyMs/);
  assert.throws(() => aggregateEnterpriseUsage([usage("bad", "u-1", { costMicrousd: Number.POSITIVE_INFINITY })]), /costMicrousd/);
  assert.throws(() => aggregateEnterpriseUsage([usage("bad", "u-1", { inputTokens: 10, cachedInputTokens: 11 })]), /cannot exceed/);
  assert.throws(() => aggregateEnterpriseUsage([usage("bad", "u-1", { inputTokens: 10.5 })]), /safe integer/);
  assert.throws(() => aggregateEnterpriseUsage([usage("bad", "u-1", { cacheStatus: "unknown" as EnterpriseUsageEvent["cacheStatus"] })]), /invalid cacheStatus/);
  assert.throws(() => aggregateEnterpriseUsage([
    usage("large-1", "u-1", { inputTokens: Number.MAX_SAFE_INTEGER, cachedInputTokens: 0 }),
    usage("large-2", "u-1", { inputTokens: 1, cachedInputTokens: 0 }),
  ]), /safe integer range/);
});
