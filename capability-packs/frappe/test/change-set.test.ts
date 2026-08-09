import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FrappeChangeSetDriftError,
  FrappeChangeSetValidationError,
  assertFrappeChangeSetFresh,
  attachFrappeApproval,
  attachFrappeEffectReceipt,
  computeFrappeChangeSetPlanHash,
  createFrappeChangeSet,
  createFrappeEffectReceipt,
  hashFrappeCanonical,
  orderFrappeChangeOperations,
  selectFrappeRepair,
  validateFrappeApprovalBinding,
  validateFrappeChangeSet,
  verifyFrappeChangeSetEffects,
  type FrappeChangeOperationInput,
  type FrappeChangeSet,
  type FrappeChangeSetInput,
} from "../src/change-set.js";

const postcondition = {
  id: "title-updated",
  description: "The title has the approved value.",
  path: "title",
  operator: "equals" as const,
  expected: "Approved title",
};

function updateOperation(overrides: Partial<FrappeChangeOperationInput> = {}): FrappeChangeOperationInput {
  return {
    id: "update-task",
    surface: "record",
    action: "update",
    target: { doctype: "ToDo", name: "TODO-1" },
    dependsOn: [],
    idempotencyKey: "mission-1:update-task",
    before: { title: "Old title" },
    after: { title: "Approved title" },
    concurrencyToken: "2026-07-19T10:00:00.000Z",
    requiredPermissions: ["read", "write"],
    requiredCapabilities: ["frappe.record.update"],
    dryRun: {
      summary: "Change ToDo title from Old title to Approved title.",
      diff: [{ path: "title", before: "Old title", after: "Approved title" }],
    },
    postconditions: [postcondition],
    repair: {
      strategy: "inverse",
      reason: "A scalar record update has a captured before value.",
      operations: [{
        id: "restore-task",
        surface: "record",
        action: "update",
        target: { doctype: "ToDo", name: "TODO-1" },
        value: { title: "Old title" },
        requiredPermissions: ["write"],
        requiredCapabilities: ["frappe.record.update"],
        idempotencyKey: "mission-1:restore-task",
        postconditions: [{ ...postcondition, id: "title-restored", expected: "Old title" }],
      }],
    },
    ...overrides,
  };
}

function changeSetInput(overrides: Partial<FrappeChangeSetInput> = {}): FrappeChangeSetInput {
  return {
    id: "change-1",
    target: { site: "site-1.example", app: "muster" },
    actor: "user@example.test",
    permissionEpoch: "permission-1",
    schemaRevision: "schema-1",
    dataRevision: "data-1",
    createdAt: "2026-07-19T10:00:00.000Z",
    prerequisites: [],
    operations: [updateOperation()],
    verification: [{ id: "verify-title", description: "Read the title back.", operationId: "update-task", assertion: postcondition }],
    ...overrides,
  };
}

test("canonical hashing ignores object key insertion order and rejects unsafe JSON", () => {
  assert.equal(hashFrappeCanonical({ b: 2, a: [true, null] }), hashFrappeCanonical({ a: [true, null], b: 2 }));
  assert.throws(() => hashFrappeCanonical({ unsafe: Number.NaN }), /Non-finite/);
  assert.throws(() => hashFrappeCanonical({ unsafe: undefined }), /Undefined/);
});

test("operations are topologically ordered with a deterministic lexical tie break", () => {
  const ordered = orderFrappeChangeOperations([
    { id: "publish", dependsOn: ["field", "doctype"] },
    { id: "field", dependsOn: ["doctype"] },
    { id: "z-independent", dependsOn: [] },
    { id: "doctype", dependsOn: [] },
  ]);
  assert.deepEqual(ordered.map(({ id }) => id), ["doctype", "z-independent", "field", "publish"]);
});

test("missing dependencies and cycles fail closed", () => {
  assert.throws(
    () => orderFrappeChangeOperations([{ id: "a", dependsOn: ["missing"] }]),
    (error: unknown) => error instanceof FrappeChangeSetValidationError && error.issues[0]?.code === "missing_dependency",
  );
  assert.throws(
    () => orderFrappeChangeOperations([{ id: "a", dependsOn: ["b"] }, { id: "b", dependsOn: ["a"] }]),
    (error: unknown) => error instanceof FrappeChangeSetValidationError && error.issues[0]?.code === "dependency_cycle",
  );
});

test("creation infers risk, enforces approval strength, orders operations and freezes the plan", () => {
  const create = updateOperation({
    id: "create-task",
    action: "create",
    dependsOn: [],
    idempotencyKey: "mission-1:create-task",
    before: null,
    concurrencyToken: undefined,
  });
  const update = updateOperation({ dependsOn: ["create-task"] });
  const changeSet = createFrappeChangeSet(changeSetInput({ operations: [update, create] }));
  assert.equal(changeSet.riskClass, "record_mutation");
  assert.equal(changeSet.approvalClass, "policy");
  assert.deepEqual(changeSet.operations.map(({ id }) => id), ["create-task", "update-task"]);
  assert.ok(Object.isFrozen(changeSet));
  assert.ok(Object.isFrozen(changeSet.operations));
  assert.equal(validateFrappeChangeSet(changeSet).length, 0);
  assert.throws(() => createFrappeChangeSet(changeSetInput({ approvalClass: "none" })), /weaker than required/);
});

test("metadata and executable plans cannot understate risk or bypass scoped approval", () => {
  const metadata = updateOperation({ surface: "custom_field", target: { doctype: "Custom Field", name: "ToDo-muster_note" } });
  const changeSet = createFrappeChangeSet(changeSetInput({ operations: [metadata] }));
  assert.equal(changeSet.riskClass, "metadata_ui");
  assert.equal(changeSet.approvalClass, "explicit_scoped");
  assert.throws(() => createFrappeChangeSet(changeSetInput({ operations: [metadata], riskClass: "record_mutation" })), /understates/);

  const script = updateOperation({ surface: "server_script", target: { doctype: "Server Script", name: "Unsafe" } });
  assert.equal(createFrappeChangeSet(changeSetInput({ operations: [script] })).riskClass, "executable_integration");
});

test("plan hashes bind immutable intent but exclude approval, receipts and evidence", () => {
  const changeSet = createFrappeChangeSet(changeSetInput());
  const withEvidence = { ...changeSet, evidenceIds: ["artifact-1"] };
  assert.equal(computeFrappeChangeSetPlanHash(withEvidence), changeSet.planHash);

  const tampered = {
    ...changeSet,
    operations: [{ ...changeSet.operations[0]!, after: { title: "Model silently changed this" } }],
  } as FrappeChangeSet;
  assert.ok(validateFrappeChangeSet(tampered).some(({ code }) => code === "plan_hash_mismatch"));
});

test("approval validation binds plan, actor, site, permission epoch, scope, expiry and separation of duties", () => {
  const changeSet = createFrappeChangeSet(changeSetInput({ approvalClass: "dual_control" }));
  const approved = attachFrappeApproval(changeSet, {
      scope: ["frappe.record.update:ToDo:TODO-1"],
      approver: "manager@example.test",
      approvedAt: "2026-07-19T10:01:00.000Z",
      expiresAt: "2026-07-19T10:06:00.000Z",
  });
  assert.deepEqual(validateFrappeApprovalBinding(approved, "2026-07-19T10:02:00.000Z"), []);
  assert.ok(validateFrappeApprovalBinding({ ...approved, approval: { ...approved.approval!, approver: changeSet.actor } }, "2026-07-19T10:02:00.000Z")
    .some(({ code }) => code === "separation_of_duties"));
  assert.ok(validateFrappeApprovalBinding(approved, "2026-07-19T10:07:00.000Z").some(({ path }) => path === "approval.expiresAt"));
  assert.ok(validateFrappeApprovalBinding({ ...approved, approval: { ...approved.approval!, permissionEpoch: "old" } }, "2026-07-19T10:02:00.000Z")
    .some(({ path }) => path === "approval.permissionEpoch"));
});

test("execution fails closed on permission, revision and optimistic concurrency drift", () => {
  const changeSet = createFrappeChangeSet(changeSetInput());
  const snapshot = {
    site: changeSet.target.site,
    actor: changeSet.actor,
    permissionEpoch: changeSet.permissionEpoch,
    schemaRevision: changeSet.schemaRevision,
    dataRevision: changeSet.dataRevision,
    concurrencyTokens: { "update-task": "2026-07-19T10:00:00.000Z" },
  };
  assert.doesNotThrow(() => assertFrappeChangeSetFresh(changeSet, snapshot, "update-task"));
  assert.throws(
    () => assertFrappeChangeSetFresh(changeSet, { ...snapshot, permissionEpoch: "permission-2" }),
    (error: unknown) => error instanceof FrappeChangeSetDriftError && error.dimension === "permission_epoch",
  );
  assert.throws(
    () => assertFrappeChangeSetFresh(changeSet, { ...snapshot, concurrencyTokens: { "update-task": "changed" } }, "update-task"),
    (error: unknown) => error instanceof FrappeChangeSetDriftError && error.dimension === "concurrency_token",
  );
});

test("effect receipts are append-once, hash-bound evidence that do not mutate plan identity", () => {
  const planned = createFrappeChangeSet(changeSetInput());
  assert.throws(() => createFrappeEffectReceipt({
    changeSet: planned,
    operationId: "update-task",
    status: "applied",
    executor: "worker-1",
    appliedAt: "2026-07-19T10:03:00.000Z",
  }), /without a live bound approval/);
  const changeSet = attachFrappeApproval(planned, {
    approver: "policy:standard-record-writes",
    scope: ["frappe.record.update:ToDo:TODO-1"],
    approvedAt: "2026-07-19T10:01:00.000Z",
    expiresAt: "2026-07-19T10:06:00.000Z",
  });
  const receipt = createFrappeEffectReceipt({
    changeSet,
    operationId: "update-task",
    status: "applied",
    executor: "worker-1",
    appliedAt: "2026-07-19T10:03:00.000Z",
    evidenceIds: ["audit-1"],
  });
  const applied = attachFrappeEffectReceipt(changeSet, receipt);
  assert.equal(applied.planHash, changeSet.planHash);
  assert.equal(applied.operations[0]?.effectReceipt?.receiptId, receipt.receiptId);
  assert.equal(selectFrappeRepair(applied, "update-task")?.strategy, "inverse");

  assert.throws(
    () => attachFrappeEffectReceipt(changeSet, { ...receipt, actor: "attacker@example.test" }),
    /binding is invalid/,
  );
  const noEffect = attachFrappeEffectReceipt(changeSet, createFrappeEffectReceipt({
    changeSet,
    operationId: "update-task",
    status: "no_effect",
    executor: "worker-1",
    appliedAt: "2026-07-19T10:03:00.000Z",
  }));
  assert.equal(selectFrappeRepair(noEffect, "update-task"), undefined);
});

test("verification evaluates exact, containment and missing-value postconditions", () => {
  const changeSet = createFrappeChangeSet(changeSetInput({
    verification: [
      { id: "equal", description: "Exact title", assertion: postcondition },
      { id: "contains", description: "Role present", assertion: { id: "role", description: "Role present", path: "roles", operator: "contains", expected: "System Manager" } },
      { id: "absent", description: "No error", assertion: { id: "error", description: "No error", path: "error", operator: "absent" } },
    ],
  }));
  const result = verifyFrappeChangeSetEffects(changeSet, {
    equal: "Approved title",
    contains: ["Employee", "System Manager"],
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.checks.map(({ passed }) => passed), [true, true, true]);
  assert.equal(verifyFrappeChangeSetEffects(changeSet, { equal: "Wrong", contains: [] }).valid, false);
});

test("delete operations require forward repair or manual intervention, never claimed inverse", () => {
  const unsafe = updateOperation({ action: "delete", repair: { strategy: "inverse", reason: "unsafe", operations: [{
    id: "restore", surface: "record", action: "create", target: { doctype: "ToDo", name: "TODO-1" }, value: {},
    requiredPermissions: ["create"], requiredCapabilities: ["frappe.record.create"], idempotencyKey: "restore", postconditions: [postcondition],
  }] } });
  assert.throws(() => createFrappeChangeSet(changeSetInput({ operations: [unsafe] })), /invalid/);

  const forward = updateOperation({ action: "delete", repair: { strategy: "forward_repair", reason: "Reconcile references and restore from a separately verified backup.", operations: [{
    id: "reconcile", surface: "record", action: "create", target: { doctype: "ToDo", name: "TODO-1" }, value: {},
    requiredPermissions: ["create"], requiredCapabilities: ["frappe.record.create"], idempotencyKey: "reconcile", postconditions: [postcondition],
  }] } });
  assert.equal(createFrappeChangeSet(changeSetInput({ operations: [forward] })).operations[0]?.repair.strategy, "forward_repair");
});
