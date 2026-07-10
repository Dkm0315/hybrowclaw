import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createEnterpriseActionReceipt,
  enterpriseCounterKey,
  enterpriseScopeMatches,
  enterpriseWindowBounds,
  evaluateEnterprisePolicyCounter,
  InMemoryEnterpriseGovernanceStore,
  normalizeEnterpriseSubjects,
  prepareEnterpriseGovernance,
  resolveEffectiveEnterprisePolicies,
  type EnterpriseLimitPolicy,
  type EnterpriseSubject,
} from "../src/index.js";

const now = Date.parse("2026-07-10T10:24:30.000Z");

function policy(
  id: string,
  policyKey: string,
  scope: readonly EnterpriseSubject[],
  overrides: Partial<EnterpriseLimitPolicy> = {},
): EnterpriseLimitPolicy {
  return {
    id,
    policyKey,
    kind: "rate_limit",
    scope,
    metric: "runs",
    window: "minute",
    limit: 10,
    warnAtPercent: 80,
    action: "throttle",
    ...overrides,
  };
}

test("enterprise subjects cover the full hierarchy and normalize exact duplicates", () => {
  const subjects = normalizeEnterpriseSubjects([
    { kind: "tenant", id: " acme " },
    { kind: "site", id: "erp.acme.test" },
    { kind: "workspace", id: "operations" },
    { kind: "channel", id: "gchat:space-1" },
    { kind: "department", id: "support" },
    { kind: "role", id: "manager" },
    { kind: "user", id: "u-1" },
    { kind: "agent", id: "assistant" },
    { kind: "plugin", id: "frappe" },
    { kind: "skill", id: "reporting" },
    { kind: "mcp", id: "drive" },
    { kind: "provider", id: "provider-a" },
    { kind: "model", id: "fast-model" },
    { kind: "workflow", id: "leave" },
    { kind: "artifact", id: "xlsx" },
    { kind: "tenant", id: "acme" },
  ]);

  assert.equal(subjects.length, 15);
  assert.equal(subjects[0]?.id, "acme");
  assert.equal(Object.isFrozen(subjects), true);
  assert.equal(enterpriseScopeMatches(subjects, [{ kind: "tenant", id: "acme" }, { kind: "user", id: "u-1" }]), true);
  assert.equal(enterpriseScopeMatches(subjects, [{ kind: "user", id: "u-2" }]), false);
  assert.throws(() => normalizeEnterpriseSubjects([{ kind: "user", id: " " }]), /requires an id/);
});

test("policy overrides choose the most specific matching hierarchy scope", () => {
  const subjects: EnterpriseSubject[] = [
    { kind: "tenant", id: "acme" },
    { kind: "department", id: "engineering" },
    { kind: "role", id: "lead" },
    { kind: "user", id: "u-1" },
  ];
  const effective = resolveEffectiveEnterprisePolicies(subjects, [
    policy("tenant-default", "interactive-runs", [{ kind: "tenant", id: "acme" }], { limit: 20 }),
    policy("department-default", "interactive-runs", [{ kind: "department", id: "engineering" }], { limit: 15 }),
    policy("role-default", "interactive-runs", [{ kind: "role", id: "lead" }], { limit: 12 }),
    policy("user-override", "interactive-runs", [{ kind: "user", id: "u-1" }], { limit: 30 }),
    policy("other-user", "interactive-runs", [{ kind: "user", id: "u-2" }], { limit: 1 }),
    policy("tenant-model", "model-budget", [{ kind: "tenant", id: "acme" }, { kind: "model", id: "fast-model" }]),
  ]);

  assert.deepEqual(effective.map((entry) => entry.id), ["user-override"]);

  const withModel = resolveEffectiveEnterprisePolicies([...subjects, { kind: "model", id: "fast-model" }], [
    policy("tenant-model", "model-budget", [{ kind: "tenant", id: "acme" }, { kind: "model", id: "fast-model" }]),
    policy("tenant-default", "interactive-runs", [{ kind: "tenant", id: "acme" }]),
  ]);
  assert.deepEqual(withModel.map((entry) => entry.id), ["tenant-default", "tenant-model"]);

  const duplicateScopeCannotCheat = resolveEffectiveEnterprisePolicies(subjects, [
    policy("duplicated-role", "interactive-runs", [{ kind: "role", id: "lead" }, { kind: "role", id: "lead" }]),
    policy("user-wins", "interactive-runs", [{ kind: "user", id: "u-1" }]),
  ]);
  assert.equal(duplicateScopeCannotCheat[0]?.id, "user-wins");
});

test("in-memory rate-limit consumption is atomic under concurrent requests", async () => {
  const store = new InMemoryEnterpriseGovernanceStore();
  const window = enterpriseWindowBounds("minute", now);
  const attempts = await Promise.all(Array.from({ length: 100 }, () => store.consumeRateLimit({
    key: "tenant:acme:user:u-1:runs",
    windowStartMs: window.startMs,
    windowEndMs: window.endMs,
    amount: 1,
    limit: 17,
  })));

  assert.equal(attempts.filter((attempt) => attempt.accepted).length, 17);
  assert.equal(attempts.filter((attempt) => !attempt.accepted).length, 83);
  assert.equal(await store.readRateLimit({ key: "tenant:acme:user:u-1:runs", windowStartMs: window.startMs, nowMs: now }), 17);
  assert.equal(await store.readRateLimit({ key: "tenant:acme:user:u-1:runs", windowStartMs: window.startMs, nowMs: window.endMs }), 0);
});

test("budget counters support integer token and micro-USD accounting without committing rejected use", async () => {
  const store = new InMemoryEnterpriseGovernanceStore();
  const window = enterpriseWindowBounds("month", now);
  const first = await store.consumeBudget({ key: "cost", windowStartMs: window.startMs, windowEndMs: window.endMs, amount: 750_000, limit: 1_000_000 });
  const rejected = await store.consumeBudget({ key: "cost", windowStartMs: window.startMs, windowEndMs: window.endMs, amount: 300_001, limit: 1_000_000 });
  const warned = await store.consumeBudget({ key: "soft-cost", windowStartMs: window.startMs, windowEndMs: window.endMs, amount: 1_100_000, limit: 1_000_000, commitOnExceed: true });

  assert.equal(first.accepted, true);
  assert.deepEqual({ accepted: rejected.accepted, before: rejected.usedBefore, after: rejected.usedAfter }, { accepted: false, before: 750_000, after: 750_000 });
  assert.deepEqual({ accepted: warned.accepted, after: warned.usedAfter }, { accepted: false, after: 1_100_000 });
});

test("idempotency claims distinguish first execution, replay, conflict, completion, and expiry", async () => {
  const store = new InMemoryEnterpriseGovernanceStore();
  const claims = await Promise.all(Array.from({ length: 32 }, () => store.claimIdempotency({
    namespace: "gchat",
    key: "event-42",
    fingerprint: "sha256:abc",
    ttlMs: 1_000,
    nowMs: now,
  })));
  assert.equal(claims.filter((claim) => claim.status === "claimed").length, 1);
  assert.equal(claims.filter((claim) => claim.status === "replay").length, 31);

  const conflict = await store.claimIdempotency({ namespace: "gchat", key: "event-42", fingerprint: "sha256:different", ttlMs: 1_000, nowMs: now });
  assert.equal(conflict.status, "conflict");

  const completed = await store.completeIdempotency({ namespace: "gchat", key: "event-42", fingerprint: "sha256:abc", resultRef: "receipt-1", nowMs: now + 10 });
  assert.equal(completed.state, "completed");
  assert.equal((await store.claimIdempotency({ namespace: "gchat", key: "event-42", fingerprint: "sha256:abc", ttlMs: 1_000, nowMs: now + 20 })).record.resultRef, "receipt-1");
  await assert.rejects(store.completeIdempotency({ namespace: "gchat", key: "event-42", fingerprint: "sha256:abc", resultRef: "receipt-2", nowMs: now + 30 }), /another result/);

  const afterExpiry = await store.claimIdempotency({ namespace: "gchat", key: "event-42", fingerprint: "sha256:new", ttlMs: 1_000, nowMs: now + 1_000 });
  assert.equal(afterExpiry.status, "claimed");
});

test("policy counter decisions expose every enforcement action without hiding proceed semantics", () => {
  const deny = policy("deny", "runs", [{ kind: "user", id: "u-1" }], { action: "deny" });
  const rejected = evaluateEnterprisePolicyCounter(deny, {
    accepted: false,
    usedBefore: 10,
    usedAfter: 10,
    remaining: 0,
    limit: 10,
    resetAt: "2026-07-10T10:25:00.000Z",
  });
  assert.deepEqual({ action: rejected.action, proceed: rejected.proceed, threshold: rejected.threshold }, { action: "deny", proceed: false, threshold: "exceeded" });

  const warning = evaluateEnterprisePolicyCounter(deny, {
    accepted: true,
    usedBefore: 7,
    usedAfter: 8,
    remaining: 2,
    limit: 10,
    resetAt: "2026-07-10T10:25:00.000Z",
  });
  assert.deepEqual({ action: warning.action, proceed: warning.proceed, threshold: warning.threshold }, { action: "warn", proceed: true, threshold: "warning" });
  assert.match(enterpriseCounterKey(deny), /^runs:runs:/);

  for (const [action, proceed] of [
    ["allow", true],
    ["warn", true],
    ["degrade", true],
    ["throttle", false],
    ["queue", false],
    ["approval", false],
    ["deny", false],
    ["quarantine", false],
  ] as const) {
    const decision = evaluateEnterprisePolicyCounter(policy(action, `action-${action}`, [{ kind: "user", id: "u-1" }], { action }), {
      accepted: false,
      usedBefore: 10,
      usedAfter: 10,
      remaining: 0,
      limit: 10,
      resetAt: "2026-07-10T10:25:00.000Z",
    });
    assert.equal(decision.proceed, proceed, action);
  }
});

test("action receipts are immutable, secret-redacted, hash-linked, and append-only", async () => {
  const store = new InMemoryEnterpriseGovernanceStore();
  const receipt = createEnterpriseActionReceipt({
    receiptId: "receipt-1",
    occurredAt: "2026-07-10T10:24:30.000Z",
    actor: [{ kind: "user", id: "manager" }],
    target: [{ kind: "department", id: "support" }],
    action: "budget.override",
    outcome: "completed",
    policyIds: ["policy-b", "policy-a"],
    requestFingerprint: "sha256:request",
    metadata: { reasonCode: "incident", detail: "API_TOKEN=secret-value" },
    previousReceiptHash: "sha256:previous",
  });

  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.actor), true);
  assert.equal(receipt.metadata.detail, "API_TOKEN=[redacted]");
  assert.deepEqual(receipt.policyIds, ["policy-a", "policy-b"]);
  assert.match(receipt.integrityHash, /^[a-f0-9]{64}$/);
  assert.throws(() => { (receipt.metadata as Record<string, unknown>).changed = true; }, TypeError);
  assert.throws(() => createEnterpriseActionReceipt({
    actor: [{ kind: "user", id: "manager" }],
    target: [{ kind: "user", id: "u-1" }],
    action: "inspect",
    outcome: "completed",
    requestFingerprint: "sha256:x",
    metadata: { rawPrompt: "private" },
  }), /raw conversational content/);

  await store.appendReceipt(receipt);
  await store.appendReceipt(receipt);
  assert.equal((await store.listReceipts()).length, 1);
  const conflicting = createEnterpriseActionReceipt({
    receiptId: "receipt-1",
    occurredAt: "2026-07-10T10:24:30.000Z",
    actor: [{ kind: "user", id: "manager" }],
    target: [{ kind: "department", id: "support" }],
    action: "budget.delete",
    outcome: "completed",
    requestFingerprint: "sha256:request",
  });
  await assert.rejects(store.appendReceipt(conflicting), /different content/);
  await assert.rejects(store.appendReceipt({ ...receipt, integrityHash: "0".repeat(64) }), /integrity check/);
});

test("disabled enterprise mode is a constant-time fast path that does not load or validate policy state", async () => {
  let loads = 0;
  const prepared = await prepareEnterpriseGovernance({
    enabled: false,
    subjects: [{ kind: "user", id: " " }],
    loadPolicies: async () => {
      loads += 1;
      throw new Error("must not load");
    },
  });
  assert.deepEqual(prepared, { enabled: false, policies: [] });
  assert.equal(loads, 0);
  assert.equal(Object.isFrozen(prepared), true);
  const second = await prepareEnterpriseGovernance({ enabled: false, subjects: [], loadPolicies: async () => [] });
  assert.equal(prepared, second, "disabled calls reuse one immutable result instead of allocating policy state");
});

test("window boundaries are stable across UTC minute, week, month, and run scopes", () => {
  const minute = enterpriseWindowBounds("minute", now);
  const week = enterpriseWindowBounds("week", now);
  const month = enterpriseWindowBounds("month", now);
  const run = enterpriseWindowBounds("run", now, "run-1");

  assert.equal(new Date(minute.startMs).toISOString(), "2026-07-10T10:24:00.000Z");
  assert.equal(new Date(week.startMs).toISOString(), "2026-07-06T00:00:00.000Z");
  assert.equal(new Date(month.startMs).toISOString(), "2026-07-01T00:00:00.000Z");
  assert.equal(run.key, "run:run-1");
  assert.throws(() => enterpriseWindowBounds("run", now), /Run id/);
});
