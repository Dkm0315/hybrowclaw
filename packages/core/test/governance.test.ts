import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAuditReceipt,
  decideMemoryRecall,
  disabledEnterpriseDecision,
  evaluateGovernance,
  evaluateTokenBudget,
  evaluateTokenRateLimit,
  renderTokenBudgetReport,
  validateAssistantProfile,
} from "../src/index.js";

test("validateAssistantProfile accepts department assistant governance primitives", () => {
  const profile = validateAssistantProfile({
    id: "finance-month-end",
    departmentType: "finance",
    responseStyle: "evidence-first",
    allowedModels: [{ provider: "openai", model: "gpt-5.5" }],
    allowedTools: ["frappe_records_create", "xlsx_report"],
    allowedMcps: ["google-drive"],
    allowedChannels: ["slack"],
    memoryScopes: [
      { kind: "tenant", id: "acme" },
      { kind: "workspace", id: "finance" },
      { kind: "role", id: "finance-manager" },
      { kind: "user", id: "pavan" },
    ],
    artifactPermissions: {
      create: true,
      export: true,
      externalShare: false,
      allowedMimeTypes: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    },
    approvalThresholds: {
      toolRisk: "medium",
      memoryHandoff: "required",
      budgetUsd: 10,
      artifactExternalShare: "required",
    },
    tokenBudget: { period: "monthly", maxTokens: 2_000_000, warnAtPercent: 80 },
    rateLimits: [{ window: "minute", maxRuns: 12, maxTokens: 120_000 }],
  });

  assert.equal(profile.departmentType, "finance");
  assert.equal(profile.responseStyle, "evidence-first");
  assert.equal(profile.allowedModels[0]?.provider, "openai");
  assert.deepEqual(profile.memoryScopes.map((scope) => `${scope.kind}:${scope.id}`), [
    "tenant:acme",
    "workspace:finance",
    "role:finance-manager",
    "user:pavan",
  ]);
});

test("validateAssistantProfile rejects unsafe artifact sharing without approval", () => {
  assert.throws(() => validateAssistantProfile({
    id: "sales-auto-share",
    departmentType: "sales",
    responseStyle: "executive-summary",
    allowedModels: [{ provider: "openai", model: "gpt-5.5" }],
    allowedTools: [],
    allowedMcps: [],
    allowedChannels: ["slack"],
    memoryScopes: [{ kind: "tenant", id: "acme" }, { kind: "role", id: "sales" }],
    artifactPermissions: { create: true, export: true, externalShare: true },
    approvalThresholds: { memoryHandoff: "required", artifactExternalShare: "none" },
  }), /External artifact sharing requires approval/);
});

test("decideMemoryRecall skips low-context prompts with explicit reasons", () => {
  const greeting = decideMemoryRecall({ prompt: "hi", scopes: [{ kind: "user", id: "pavan" }] });
  const folder = decideMemoryRecall({ prompt: "list the current folder", scopes: [{ kind: "user", id: "pavan" }] });

  assert.equal(greeting.action, "skip");
  assert.equal(greeting.skipReason, "simple_greeting");
  assert.equal(folder.action, "skip");
  assert.equal(folder.skipReason, "deterministic_tool_call");
  assert.equal(folder.shouldSearch, false);
});

test("decideMemoryRecall recalls only for prompts that need prior scoped context", () => {
  const decision = decideMemoryRecall({
    prompt: "Use the finance handoff from last week and explain the Frappe approval state",
    scopes: [{ kind: "tenant", id: "acme" }, { kind: "workspace", id: "finance" }, { kind: "user", id: "pavan" }],
  });

  assert.equal(decision.action, "recall");
  assert.equal(decision.shouldSearch, true);
  assert.ok(decision.reasons.includes("prior_work_reference"));
  assert.ok(decision.reasons.includes("frappe_user_state"));
  assert.deepEqual(decision.effectiveScopes.map((scope) => `${scope.kind}:${scope.id}`), [
    "tenant:acme",
    "workspace:finance",
    "user:pavan",
  ]);
});

test("decideMemoryRecall blocks shared memory handoff without explicit approval", () => {
  const decision = decideMemoryRecall({
    prompt: "Use the shared team handoff for the renewal",
    scopes: [{ kind: "tenant", id: "acme" }, { kind: "workspace", id: "sales" }, { kind: "user", id: "pavan" }],
    requestedSharedScopes: [{ kind: "role", id: "sales" }],
    handoffApproved: false,
  });

  assert.equal(decision.action, "blocked");
  assert.equal(decision.skipReason, "shared_memory_handoff_requires_approval");
  assert.equal(decision.shouldSearch, false);
});

test("evaluateTokenBudget supports per-user, per-role, and per-channel budgets with alerts", () => {
  const decision = evaluateTokenBudget({
    request: {
      userId: "pavan",
      roleIds: ["finance-manager"],
      channelId: "slack:C123",
      estimatedInputTokens: 70_000,
      estimatedOutputTokens: 30_000,
    },
    budgets: [
      { subject: { kind: "user", id: "pavan" }, period: "monthly", maxTokens: 120_000, usedTokens: 10_000, warnAtPercent: 75 },
      { subject: { kind: "role", id: "finance-manager" }, period: "daily", maxTokens: 500_000, usedTokens: 200_000, warnAtPercent: 80 },
      { subject: { kind: "channel", id: "slack:C123" }, period: "daily", maxTokens: 240_000, usedTokens: 80_000, warnAtPercent: 80 },
    ],
  });

  assert.equal(decision.status, "warn");
  assert.equal(decision.projectedTokens, 100_000);
  assert.deepEqual(decision.matchedSubjects, ["user:pavan", "role:finance-manager", "channel:slack:C123"]);
  assert.ok(decision.alerts.some((alert) => alert.subject === "user:pavan" && alert.level === "warning"));
});

test("evaluateTokenBudget blocks the tightest matching budget", () => {
  const decision = evaluateTokenBudget({
    request: {
      userId: "pavan",
      roleIds: ["support"],
      channelId: "telegram:42",
      estimatedInputTokens: 90_000,
      estimatedOutputTokens: 30_000,
    },
    budgets: [
      { subject: { kind: "role", id: "support" }, period: "daily", maxTokens: 1_000_000, usedTokens: 0 },
      { subject: { kind: "channel", id: "telegram:42" }, period: "daily", maxTokens: 100_000, usedTokens: 1_000 },
    ],
  });

  assert.equal(decision.status, "block");
  assert.equal(decision.blockedBy?.subject, "channel:telegram:42");
});

test("evaluateTokenRateLimit blocks projected request bursts by run or token volume", () => {
  const decision = evaluateTokenRateLimit({
    request: {
      userId: "pavan",
      roleIds: ["engineering"],
      channelId: "slack:C123",
      estimatedInputTokens: 5_000,
      estimatedOutputTokens: 3_000,
    },
    limits: [
      { subject: { kind: "user", id: "pavan" }, window: "minute", maxRuns: 3, maxTokens: 50_000, currentRuns: 3, currentTokens: 10_000 },
    ],
  });

  assert.equal(decision.status, "block");
  assert.equal(decision.blockedBy?.reason, "run_limit");
});

test("renderTokenBudgetReport groups governed ledger entries by user role and channel", () => {
  const report = renderTokenBudgetReport([
    { userId: "pavan", roleIds: ["finance"], channelId: "slack:C123", inputTokens: 10, outputTokens: 5 },
    { userId: "pavan", roleIds: ["finance"], channelId: "telegram:42", inputTokens: 20, outputTokens: 5 },
    { userId: "maya", roleIds: ["support"], channelId: "slack:C123", inputTokens: 7, outputTokens: 3 },
  ]);

  assert.match(report, /user:pavan\s+40/);
  assert.match(report, /role:finance\s+40/);
  assert.match(report, /channel:slack:C123\s+25/);
});

test("buildAuditReceipt captures run governance without leaking secrets", () => {
  const receipt = buildAuditReceipt({
    runId: "run_audit",
    channel: { id: "slack:C123", kind: "slack", userId: "U123", threadId: "171.2" },
    provider: { id: "openai", model: "gpt-5.5" },
    memory: {
      action: "skip",
      shouldSearch: false,
      reasons: [],
      skipReason: "setup_command",
      effectiveScopes: [{ kind: "user", id: "pavan" }],
    },
    artifacts: [{ title: "Token report", mimeType: "text/markdown", deliveryStatus: "artifact_hosted", url: "https://example.test/report.md?token=secret" }],
    delivery: { status: "completed", target: "slack:C123" },
    approvals: [{ kind: "artifact_external_share", status: "approved", approverId: "manager" }],
    failures: [{ stage: "upload", message: "missing SLACK_BOT_TOKEN=xoxb-secret" }],
  });

  assert.equal(receipt.channel.id, "slack:C123");
  assert.equal(receipt.provider.model, "gpt-5.5");
  assert.equal(receipt.memory.skipReason, "setup_command");
  assert.equal(receipt.artifacts[0]?.url, "https://example.test/report.md?token=[redacted]");
  assert.match(receipt.failures[0]?.message ?? "", /\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(receipt), /xoxb-secret|token=secret/);
});

test("disabled enterprise governance adds no policy-loader overhead to personal mode", async () => {
  let policyLoads = 0;
  const decision = await evaluateGovernance({
    enterprise: { enabled: false },
    loadEnterprisePolicy: async () => {
      policyLoads += 1;
      throw new Error("policy loader should not run in personal mode");
    },
    request: {
      prompt: "hi",
      userId: "local",
      roleIds: [],
      channelId: "local",
      estimatedInputTokens: 1,
      estimatedOutputTokens: 1,
      scopes: [{ kind: "user", id: "local" }],
    },
  });

  assert.equal(policyLoads, 0);
  assert.deepEqual(decision, disabledEnterpriseDecision());
});
