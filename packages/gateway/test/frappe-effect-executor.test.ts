import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentGraphDefinition } from "@musterhq/core";
import {
  createEffectfulFrappeMissionExecutor,
  createCapabilityPackFrappeEffectTransport,
  GovernedFrappeEffectError,
  SqliteGovernedFrappeEffectStore,
  type FrappeBoundApprovalReceipt,
  type FrappeEffectApplication,
  type FrappeEffectAuthoritySnapshot,
  type FrappeEffectProposal,
  type GovernedFrappeEffectPlan,
  type GovernedFrappeEffectTransport,
} from "../src/frappe-effect-executor.js";
import { DurableFrappeMissionBridge, type FrappeMissionNodeExecutionInput } from "../src/frappe-mission-bridge.js";
import { SqliteFrappeRunEventStore } from "../src/frappe-run-events.js";

const authority: FrappeEffectAuthoritySnapshot = {
  tenantId: "tenant-a", siteId: "site-a", siteOrigin: "https://erp.example.test",
  userId: "operator@example.test", permissionEpoch: "epoch-1", rolesHash: "a".repeat(64),
  schemaRevision: "schema-1", dataRevision: "data-1",
};

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`;
}
function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }

function plan(overrides: Partial<GovernedFrappeEffectPlan> = {}): GovernedFrappeEffectPlan {
  const operation = overrides.operation ?? { kind: "record" as const, action: "create" as const, doctype: "ToDo", values: { description: "Call customer" } };
  const base = {
    schemaVersion: 1 as const,
    capability: overrides.capability ?? "frappe.record.create" as const,
    authority: overrides.authority ?? authority,
    operation,
    idempotencyKey: overrides.idempotencyKey ?? "effect-1",
    postconditions: overrides.postconditions ?? [{ path: "$.description", operator: "equals" as const, expected: "Call customer" }],
  };
  const planHash = digest(base);
  const approval: FrappeBoundApprovalReceipt = overrides.approval ?? {
    receiptId: "approval-1", planHash, actor: authority.userId,
    approvers: ["manager@example.test"], approvedAt: "2026-07-19T10:00:00.000Z",
    expiresAt: "2026-07-19T11:00:00.000Z", scope: [base.capability], approvalClass: "single", proof: { signature: "opaque" },
  };
  return { ...base, approval, planHash, ...overrides } as GovernedFrappeEffectPlan;
}

function input(effect: unknown, overrides: Partial<FrappeMissionNodeExecutionInput> = {}): FrappeMissionNodeExecutionInput {
  const workflow: AgentGraphDefinition = {
    schemaVersion: 1, id: "effect-graph", version: "1", entryNodeId: "write",
    nodes: [{ id: "write", kind: "command", requestedCapabilities: ["frappe.record.create"] }], edges: [],
    budget: { runtimeMs: 60_000, toolCalls: 4, modelCalls: 0, tokens: 0, costMicros: 0, artifactBytes: 1_000 },
  };
  const nodePlans = effect === undefined ? {} : {
    write: {
      surface: "server_effect" as const,
      plan: effect,
      resourceScope: effectScope(effect),
    },
  };
  const unsignedManifest = { schemaVersion: 1 as const, workflowSnapshotHash: digest(workflow), nodePlans };
  return {
    mission: {
      schemaVersion: 1, missionId: "mission-1", rootRunId: "run-1", idempotencyKey: "mission-key",
      submittedAt: "2026-07-19T10:00:00.000Z", objective: "Create a ToDo", workflow,
      identity: { tenantId: authority.tenantId, siteId: authority.siteId, userId: authority.userId, permissionEpoch: authority.permissionEpoch, rolesHash: authority.rolesHash },
      context: { governedEffects: { write: effect } },
      executionManifest: { ...unsignedManifest, manifestHash: digest(unsignedManifest) },
    },
    node: workflow.nodes[0]!, parentNodeIds: [], depth: 0, attemptId: "attempt-1", fencingToken: 1,
    steering: [], effectiveCapabilities: ["frappe.record.create"], signal: new AbortController().signal,
    ...overrides,
  };
}

function effectScope(effect: unknown) {
  const operation = (effect as { operation?: Record<string, unknown> } | undefined)?.operation;
  if (operation?.kind === "record") {
    return {
      routes: [],
      doctypes: typeof operation.doctype === "string" ? [operation.doctype] : [],
      recordNames: typeof operation.docname === "string" ? [operation.docname] : [],
      fields: operation.values && typeof operation.values === "object" && !Array.isArray(operation.values)
        ? Object.keys(operation.values).sort()
        : [],
    };
  }
  const intent = operation?.intent as { artifacts?: Array<Record<string, unknown>> } | undefined;
  const artifacts = intent?.artifacts ?? [];
  const unique = (values: unknown[]) => [...new Set(values.filter((value): value is string => typeof value === "string"))].sort();
  return {
    routes: [],
    doctypes: unique(artifacts.map((item) => item.target_doctype)),
    recordNames: unique(artifacts.map((item) => item.target_name)),
    fields: unique(artifacts.flatMap((item) => item.values && typeof item.values === "object" && !Array.isArray(item.values) ? Object.keys(item.values) : [])),
  };
}

class FakeTransport implements GovernedFrappeEffectTransport {
  resolves = 0; plans = 0; applies = 0; observes = 0; compensates = 0;
  authoritySequence: FrappeEffectAuthoritySnapshot[] = [authority];
  observation: Record<string, string> = { description: "Call customer" };
  application: FrappeEffectApplication = { receiptId: "effect-receipt-1", resultRef: { doctype: "ToDo", name: "TODO-1" }, evidenceIds: ["evidence-1"] };
  async resolveAuthority(): Promise<FrappeEffectAuthoritySnapshot> { return this.authoritySequence[Math.min(this.resolves++, this.authoritySequence.length - 1)]!; }
  async plan({ plan: value }: { plan: GovernedFrappeEffectPlan }): Promise<FrappeEffectProposal> { this.plans++; return { planHash: value.planHash, authority: value.authority, summary: "Dry run", approvalBindingHash: digest(value.approval) }; }
  async apply(): Promise<FrappeEffectApplication> { this.applies++; return this.application; }
  async observe(): Promise<Record<string, string>> { this.observes++; return this.observation; }
  async compensate(): Promise<{ repaired: boolean; evidenceIds: string[] }> { this.compensates++; return { repaired: false, evidenceIds: ["repair-1"] }; }
}

async function fixture(effect = plan(), transport = new FakeTransport()) {
  const directory = await mkdtemp(join(tmpdir(), "muster-frappe-effects-"));
  const store = new SqliteGovernedFrappeEffectStore(join(directory, "effects.db"));
  const executor = createEffectfulFrappeMissionExecutor({
    transport, store, fallback: async () => ({ summary: "read-only fallback" }),
    now: () => new Date("2026-07-19T10:05:00.000Z"),
  });
  return { executor, transport, store, effect };
}

test("governed effect plans, rechecks authority twice, consumes approval, rereads and emits fenced receipts", async () => {
  const fx = await fixture();
  const events: string[] = [];
  try {
    const result = await fx.executor(input(fx.effect, {
      recordEffectStarted: async (key) => { events.push(`start:${key}`); },
      recordEffectCommitted: async (key, receipt) => { events.push(`commit:${key}:${receipt}`); },
    }));
    assert.equal(result.payload?.verified, true);
    assert.deepEqual(result.evidenceIds, ["evidence-1"]);
    assert.equal(fx.transport.resolves, 2);
    assert.equal(fx.transport.applies, 1);
    assert.match(events[0]!, /^start:effect-1$/);
    assert.match(events[1]!, /^commit:effect-1:[a-f0-9]{64}$/);
  } finally { fx.store.close(); }
});

test("RBAC revoke between dry-run and effect fails before the mutation", async () => {
  const transport = new FakeTransport();
  transport.authoritySequence = [authority, { ...authority, permissionEpoch: "epoch-revoked" }];
  const fx = await fixture(plan(), transport);
  try {
    await assert.rejects(() => fx.executor(input(fx.effect)), /authority or revision drifted/i);
    assert.equal(transport.applies, 0);
  } finally { fx.store.close(); }
});

test("stale approval is denied before any transport call", async () => {
  const original = plan();
  const fx = await fixture({ ...original, approval: { ...original.approval, expiresAt: "2026-07-19T10:04:59.000Z" } });
  try {
    await assert.rejects(() => fx.executor(input(fx.effect)), /approval is stale/i);
    assert.equal(fx.transport.resolves, 0);
  } finally { fx.store.close(); }
});

test("self-approval and wrong execution actor are denied before any transport call", async () => {
  const original = plan();
  const selfApproved = { ...original, approval: { ...original.approval, approvers: [original.authority.userId] } };
  const first = await fixture(selfApproved);
  try {
    await assert.rejects(() => first.executor(input(selfApproved)), /independent approver/i);
    assert.equal(first.transport.resolves, 0);
  } finally { first.store.close(); }
  const wrongActor = { ...original, approval: { ...original.approval, actor: "other@example.test" } };
  const second = await fixture(wrongActor);
  try {
    await assert.rejects(() => second.executor(input(wrongActor)), /execution principal/i);
    assert.equal(second.transport.resolves, 0);
  } finally { second.store.close(); }
});

test("committed idempotency replay returns the stored receipt without double execution", async () => {
  const fx = await fixture();
  try {
    await fx.executor(input(fx.effect));
    const replay = await fx.executor(input(fx.effect, { fencingToken: 2 }));
    assert.equal(replay.payload?.replayed, true);
    assert.equal(fx.transport.applies, 1);
  } finally { fx.store.close(); }
});

test("stale fencing cannot replay a committed effect", async () => {
  const fx = await fixture();
  try {
    await fx.executor(input(fx.effect, { fencingToken: 2 }));
    await assert.rejects(() => fx.executor(input(fx.effect, { fencingToken: 1 })), /stale fencing/i);
    assert.equal(fx.transport.applies, 1);
  } finally { fx.store.close(); }
});

test("cross-tenant live authority is rejected", async () => {
  const transport = new FakeTransport(); transport.authoritySequence = [{ ...authority, tenantId: "tenant-b" }];
  const fx = await fixture(plan(), transport);
  try { await assert.rejects(() => fx.executor(input(fx.effect)), /authority or revision drifted/i); assert.equal(transport.applies, 0); }
  finally { fx.store.close(); }
});

test("capability escalation is rejected when any authority term omitted the capability", async () => {
  const fx = await fixture();
  try { await assert.rejects(() => fx.executor(input(fx.effect, { effectiveCapabilities: [] })), /trusted authority intersection/i); assert.equal(fx.transport.resolves, 0); }
  finally { fx.store.close(); }
});

test("prompt-injected URL and tool selectors are rejected as unknown structural fields", async () => {
  const injected = { ...plan(), operation: { kind: "record", action: "create", doctype: "ToDo", values: { description: "safe data" }, url: "https://evil.test", tool: "shell" } };
  const fx = await fixture(injected as unknown as GovernedFrappeEffectPlan);
  try { await assert.rejects(() => fx.executor(input(injected)), /unknown or missing fields/i); assert.equal(fx.transport.resolves, 0); }
  finally { fx.store.close(); }
});

test("model/context effect injection is inert without a host execution-manifest entry", async () => {
  const effect = plan();
  const fx = await fixture(effect);
  try {
    const execution = input(undefined);
    const result = await fx.executor(execution);
    assert.equal(result.summary, "read-only fallback");
    assert.equal(fx.transport.resolves, 0);
    assert.equal(fx.transport.applies, 0);
  } finally { fx.store.close(); }
});

test("server-effect resource projection drift is denied before any transport call", async () => {
  const effect = plan();
  const fx = await fixture(effect);
  try {
    const execution = input(effect);
    const manifest = execution.mission.executionManifest!;
    (execution.mission as { executionManifest?: unknown }).executionManifest = {
      ...manifest,
      nodePlans: {
        write: { ...manifest.nodePlans.write!, resourceScope: { routes: [], doctypes: ["User"], recordNames: [], fields: ["description"] } },
      },
    };
    await assert.rejects(() => fx.executor(execution), /immutable resource scope/i);
    assert.equal(fx.transport.resolves, 0);
  } finally { fx.store.close(); }
});

test("schema or data drift immediately before effect is denied", async () => {
  const transport = new FakeTransport(); transport.authoritySequence = [authority, { ...authority, schemaRevision: "schema-2", dataRevision: "data-2" }];
  const fx = await fixture(plan(), transport);
  try { await assert.rejects(() => fx.executor(input(fx.effect)), /authority or revision drifted/i); assert.equal(transport.applies, 0); }
  finally { fx.store.close(); }
});

test("executor ignores an apply-time verification lie and requires an independent reread", async () => {
  const transport = new FakeTransport();
  transport.application = { ...transport.application, resultRef: { verified: true, description: "Call customer" } };
  transport.observation = { description: "different" };
  const fx = await fixture(plan(), transport);
  try {
    await assert.rejects(() => fx.executor(input(fx.effect)), (error) => error instanceof GovernedFrappeEffectError && error.disposition === "needs_intervention");
    assert.equal(transport.observes, 1); assert.equal(transport.compensates, 1);
  } finally { fx.store.close(); }
});

test("verification failure reports compensated only after the fixed transport verifies repair", async () => {
  const transport = new FakeTransport(); transport.observation = { description: "different" };
  transport.compensate = async () => { transport.compensates++; return { repaired: true, evidenceIds: ["repair-ok"] }; };
  const fx = await fixture(plan(), transport);
  try { await assert.rejects(() => fx.executor(input(fx.effect)), (error) => error instanceof GovernedFrappeEffectError && error.disposition === "compensated"); }
  finally { fx.store.close(); }
});

test("destructive and executable metadata remain denied without explicit policy and dual control", async () => {
  const destructiveOperation = { kind: "record" as const, action: "delete" as const, doctype: "ToDo", docname: "TODO-1", values: {}, expectedModified: "2026-07-19 10:00:00" };
  const destructive = plan({ capability: "frappe.record.delete", operation: destructiveOperation });
  const fx = await fixture(destructive);
  try { await assert.rejects(() => fx.executor(input(destructive, { node: { id: "write", kind: "command", requestedCapabilities: ["frappe.record.delete"] }, effectiveCapabilities: ["frappe.record.delete"] })), /disabled by policy/i); }
  finally { fx.store.close(); }
});

test("mutation after approval invalidates the immutable plan hash", async () => {
  const approved = plan();
  const tampered = { ...approved, operation: { ...approved.operation, values: { description: "Injected after approval" } } };
  const fx = await fixture(tampered as GovernedFrappeEffectPlan);
  try { await assert.rejects(() => fx.executor(input(tampered)), /immutable effect plan hash/i); assert.equal(fx.transport.resolves, 0); }
  finally { fx.store.close(); }
});

test("one approval receipt cannot authorize a second idempotency key", async () => {
  const first = plan();
  const fx = await fixture(first);
  try {
    await fx.executor(input(first));
    const secondBase = plan({ idempotencyKey: "effect-2" });
    const second = { ...secondBase, approval: { ...secondBase.approval, receiptId: first.approval.receiptId } };
    await assert.rejects(() => fx.executor(input(second, { fencingToken: 2 })), /approval receipt was already consumed/i);
    assert.equal(fx.transport.applies, 1);
  } finally { fx.store.close(); }
});

test("concurrent duplicate execution cannot cross the durable claimed boundary", async () => {
  const transport = new FakeTransport();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  transport.apply = async () => { transport.applies++; await gate; return transport.application; };
  const fx = await fixture(plan(), transport);
  try {
    const first = fx.executor(input(fx.effect));
    while (transport.applies === 0) await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(() => fx.executor(input(fx.effect, { fencingToken: 2 })), /in-flight or its outcome is unknown/i);
    release();
    await first;
    assert.equal(transport.applies, 1);
  } finally { fx.store.close(); }
});

test("an ambiguous partial apply is never retried automatically", async () => {
  const transport = new FakeTransport();
  transport.apply = async () => { transport.applies++; throw new Error("connection lost after server accepted write"); };
  const fx = await fixture(plan(), transport);
  try {
    await assert.rejects(() => fx.executor(input(fx.effect)), /connection lost/i);
    await assert.rejects(() => fx.executor(input(fx.effect, { fencingToken: 2 })), /prior failed effect requires a fresh plan/i);
    assert.equal(transport.applies, 1);
  } finally { fx.store.close(); }
});

test("concrete capability-pack transport invokes only frappe_safe_write and an independent typed record read", async () => {
  const proposal = { proposalId: "proposal-1", humanSummary: "Create ToDo", mutationHash: "b".repeat(64) };
  const original = plan();
  const effect = { ...original, approval: { ...original.approval, proof: { frappeSafeWriteReceipt: { proposal, approvedBy: "manager@example.test", signature: "signed-receipt" } } } };
  const calls: Record<string, unknown>[] = [];
  const transport = createCapabilityPackFrappeEffectTransport({
    resolveAuthority: async () => authority,
    frappeSafeWrite: async (args) => {
      calls.push({ ...args });
      if (!("approvalReceipt" in args)) return { status: "approval_required", approvalProposal: proposal };
      return { status: "executed", verification: { verified: true }, result: { created: { name: "TODO-1" } }, evidenceLog: ["approval_receipt:consumed"] };
    },
    readRecord: async ({ doctype, docname }) => ({ doctype, name: docname, description: "Call customer" }),
  });
  const directory = await mkdtemp(join(tmpdir(), "muster-frappe-safe-write-"));
  const store = new SqliteGovernedFrappeEffectStore(join(directory, "effects.db"));
  const executor = createEffectfulFrappeMissionExecutor({ transport, store, fallback: async () => ({ summary: "fallback" }), now: () => new Date("2026-07-19T10:05:00.000Z") });
  try {
    const result = await executor(input(effect));
    assert.equal(result.payload?.verified, true);
    assert.equal(calls.length, 2);
    assert.deepEqual(Object.keys(calls[0]!).sort(), ["dataRevision", "doc", "doctype", "operation", "permissionEpoch", "schemaRevision"]);
    assert.equal("url" in calls[0]!, false);
    assert.equal("tool" in calls[0]!, false);
  } finally { store.close(); }
});

test("an unrepaired verification failure projects a terminal needs_intervention mission", async () => {
  const transport = new FakeTransport(); transport.observation = { description: "wrong" };
  const fx = await fixture(plan(), transport);
  const events = new SqliteFrappeRunEventStore(":memory:");
  const bridge = new DurableFrappeMissionBridge({ store: events, executeNode: fx.executor });
  const base = input(fx.effect).mission;
  const mission = { ...base, submittedAt: new Date().toISOString(), authority: { callerCapabilities: ["frappe.record.create"], workflowCapabilities: ["frappe.record.create"] } };
  const scope = { tenantId: authority.tenantId, siteId: authority.siteId, userId: authority.userId };
  try {
    await bridge.submit(mission, scope);
    await bridge.waitForIdle(mission.missionId);
    const status = await bridge.status(scope, mission.missionId);
    assert.equal(status?.status, "needs_intervention", JSON.stringify(status?.events.map((event) => ({ type: event.type, summary: event.summary }))));
    assert.deepEqual(status?.events.slice(-3).map((event) => event.type), ["mission_failed", "compensation_started", "compensation_failed"]);
  } finally { await bridge.close(); events.close(); fx.store.close(); }
});

test("closed native registry supports a governed Custom Field through fixed native-builder ports", async () => {
  const operation = { kind: "native_artifact" as const, artifactType: "custom_field" as const, intent: { mission: "MISSION-1", artifacts: [{ type: "custom_field", doctype: "ToDo", fieldname: "priority_note" }] } };
  const effect = plan({ capability: "frappe.metadata.custom_field.create", operation, postconditions: [{ path: "$.fieldname", operator: "equals", expected: "priority_note" }] });
  const transport = new FakeTransport(); transport.observation = { fieldname: "priority_note" };
  const fx = await fixture(effect, transport);
  try {
    const result = await fx.executor(input(effect, { node: { id: "write", kind: "command", requestedCapabilities: [effect.capability] }, effectiveCapabilities: [effect.capability] }));
    assert.equal(result.payload?.verified, true);
    assert.equal(transport.applies, 1);
  } finally { fx.store.close(); }
});

test("executable metadata requires policy opt-in and a maker-checker approval class", async () => {
  const operation = { kind: "native_artifact" as const, artifactType: "report" as const, intent: { mission: "MISSION-1", artifacts: [{ type: "report", name: "Safe Report" }] } };
  const base = plan({ capability: "frappe.metadata.report.create", operation, postconditions: [{ path: "$.name", operator: "equals", expected: "Safe Report" }] });
  const single = { ...base, approval: { ...base.approval, approvalClass: "single" as const } };
  const transport = new FakeTransport(); transport.observation = { name: "Safe Report" };
  const directory = await mkdtemp(join(tmpdir(), "muster-frappe-dual-"));
  const store = new SqliteGovernedFrappeEffectStore(join(directory, "effects.db"));
  const executor = createEffectfulFrappeMissionExecutor({ transport, store, fallback: async () => ({ summary: "fallback" }), policy: { allowExecutableMetadata: true }, now: () => new Date("2026-07-19T10:05:00.000Z") });
  const executionInput = (effect: GovernedFrappeEffectPlan) => input(effect, { node: { id: "write", kind: "command", requestedCapabilities: [effect.capability] }, effectiveCapabilities: [effect.capability] });
  try {
    await assert.rejects(() => executor(executionInput(single)), /maker-checker dual control/i);
    const dual = { ...base, approval: { ...base.approval, approvalClass: "dual_control" as const } };
    const result = await executor(executionInput(dual));
    assert.equal(result.payload?.verified, true);
  } finally { store.close(); }
});
