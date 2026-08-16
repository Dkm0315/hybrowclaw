import assert from "node:assert/strict";
import { test } from "node:test";
import {
  digestFrappeLineageManifest,
  planFrappeLineageRemediation,
  type FrappeReviewedLineageManifest,
} from "../src/lineage-remediation.js";
import { validateFrappeLineage, type FrappeLineageDocument, type FrappeLineageManifest } from "../src/lineage.js";

const manifest: FrappeLineageManifest = {
  schemaVersion: 1,
  id: "generic-engineering-lineage",
  label: "Generic engineering lineage",
  stages: [
    { id: "source", label: "Reviewed source", doctype: "Reviewed Source" },
    { id: "target", label: "Generated target", doctype: "Generated Target" },
  ],
  relationships: [{
    id: "source-to-target",
    from: "source",
    to: "target",
    cardinality: "one",
    required: true,
    identity: [{ from: "business_key", to: "business_key", label: "Business identity" }],
    revision: [{ from: "revision", to: "source_revision", label: "Revision" }],
    content: [
      { from: "operations[].operation", to: "steps[].operation", label: "Operation", comparison: "ordered", mismatchStatus: "Inconsistent" },
      { from: "operations[].tolerance", to: "steps[].tolerance", label: "Tolerance", comparison: "ordered", mismatchStatus: "Inconsistent" },
    ],
  }],
};

const provenance = {
  site: "https://erp.example.test",
  principal: "authorized.user@example.test",
  permissionEpoch: "permission-7",
  schemaRevision: "schema-4",
  dataRevision: "data-12",
  observedAt: "2026-08-16T08:00:00.000Z",
  evidenceId: "source-evidence",
} as const;

function source(values: FrappeLineageDocument["values"] = {
  business_key: "ITEM-001",
  revision: "B",
  operations: [
    { operation: "Form", tolerance: "0.05 mm" },
    { operation: "Inspect", tolerance: "0.02 mm" },
  ],
}): FrappeLineageDocument {
  return { stage: "source", name: "SRC-001", readable: true, values, modified: "2026-08-16T07:00:00.000Z", route: "/app/reviewed-source/SRC-001", provenance };
}

function target(overrides: Partial<FrappeLineageDocument> = {}): FrappeLineageDocument {
  return {
    stage: "target",
    name: "TGT-001",
    readable: true,
    modified: "2026-08-16T07:30:00.000Z",
    route: "/app/generated-target/TGT-001",
    values: {
      business_key: "ITEM-001",
      source_revision: "A",
      steps: [
        { name: "ROW-1", parent: "TGT-001", idx: 1, doctype: "Target Step", operation: "Legacy form", tolerance: "0.20 mm", instruction: "Keep fixture A" },
        { name: "ROW-2", parent: "TGT-001", idx: 2, doctype: "Target Step", operation: "Legacy inspect", tolerance: "0.10 mm", instruction: "Keep gauge B" },
      ],
    },
    provenance: { ...provenance, evidenceId: "target-evidence" },
    ...overrides,
  };
}

function reviewed(value: FrappeLineageManifest = manifest): FrappeReviewedLineageManifest {
  return {
    manifest: value,
    review: {
      status: "reviewed",
      manifestDigest: digestFrappeLineageManifest(value),
      reviewedBy: "architecture-review",
      reviewedAt: "2026-08-16T08:05:00.000Z",
    },
  };
}

function plan(documents: readonly FrappeLineageDocument[], value: FrappeLineageManifest = manifest) {
  const validation = validateFrappeLineage({ manifest: value, documents });
  return planFrappeLineageRemediation({ reviewedManifest: reviewed(value), documents, validation });
}

test("plans deterministic scalar and child-table updates without executing writes", () => {
  const documents = [source(), target()];
  const first = plan(documents);
  const second = plan(documents);
  assert.deepEqual(first, second);
  assert.equal(first.actions.length, 1);
  assert.equal(first.refusals.length, 0);
  const action = first.actions[0]!;
  assert.equal(action.expected_modified, "2026-08-16T07:30:00.000Z");
  assert.equal(action.route, "/app/generated-target/TGT-001");
  assert.equal(action.executionRequirements.writer, "frappe_safe_write");
  assert.equal(action.executionRequirements.freshPermissionCheck, true);
  assert.equal(action.executionRequirements.humanApproval, "one-use");
  assert.match(action.executionRequirements.statement, /frappe_safe_write.*fresh permission check.*one-use human approval/);
  assert.equal(action.changes.find((change) => change.path === "source_revision")?.value, "B");
  assert.match(action.changes.find((change) => change.path === "source_revision")?.before ?? "", /"A"/);
  assert.match(action.changes.find((change) => change.path === "source_revision")?.after ?? "", /"B"/);
});

test("preserves unmapped child-row business fields and removes Frappe system fields", () => {
  const result = plan([source(), target()]);
  const table = result.actions[0]?.changes.find((change) => change.path === "steps");
  assert.equal(table?.kind, "child_table");
  assert.deepEqual(table?.value, [
    { instruction: "Keep fixture A", operation: "Form", tolerance: "0.05 mm" },
    { instruction: "Keep gauge B", operation: "Inspect", tolerance: "0.02 mm" },
  ]);
  assert.equal(JSON.stringify(table?.value).includes("ROW-1"), false);
  assert.equal(JSON.stringify(table?.value).includes("parent"), false);
  assert.equal(JSON.stringify(table?.value).includes("doctype"), false);
  assert.match(table?.before ?? "", /Keep fixture A/);
  assert.match(table?.after ?? "", /0.05 mm/);
});

test("refuses blocked, missing, unreadable, and inspection-incomplete targets", () => {
  const blockedTarget = target({ readable: false });
  const blocked = plan([source(), blockedTarget]);
  assert.equal(blocked.actions.length, 0);
  assert.equal(blocked.refusals[0]?.code, "blocked");

  const missing = plan([source()]);
  assert.equal(missing.actions.length, 0);
  assert.equal(missing.refusals[0]?.code, "missing_record");

  const noModified = plan([source(), target({ modified: undefined })]);
  assert.equal(noModified.actions.length, 0);
  assert.equal(noModified.refusals[0]?.code, "missing_concurrency_token");

  const noRoute = plan([source(), target({ route: undefined })]);
  assert.equal(noRoute.actions.length, 0);
  assert.equal(noRoute.refusals[0]?.code, "missing_route");
});

test("refuses mappings that would change record identity", () => {
  const identityChanging: FrappeLineageManifest = {
    ...manifest,
    relationships: [{
      ...manifest.relationships[0]!,
      content: [{ from: "replacement_key", to: "business_key", label: "Replacement identity", mismatchStatus: "Inconsistent" }],
    }],
  };
  const result = plan([
    source({ business_key: "ITEM-001", replacement_key: "ITEM-002", revision: "B" }),
    target({ values: { business_key: "ITEM-001", source_revision: "A" } }),
  ], identityChanging);
  assert.equal(result.actions.length, 0);
  assert.equal(result.refusals[0]?.code, "identity_change");
});

test("refuses stale validation and a review for a different manifest", () => {
  const documents = [source(), target()];
  const validation = validateFrappeLineage({ manifest, documents });
  assert.throws(() => planFrappeLineageRemediation({
    reviewedManifest: { ...reviewed(), review: { ...reviewed().review, manifestDigest: "0".repeat(64) } },
    documents,
    validation,
  }), /exact manifest digest/);
  assert.throws(() => planFrappeLineageRemediation({
    reviewedManifest: reviewed(),
    documents: [source({ business_key: "ITEM-001", revision: "C" }), target()],
    validation,
  }), /supplied permission-scoped documents/);
});

test("refuses ambiguous child evidence rather than inventing row alignment", () => {
  const uneven = source({
    business_key: "ITEM-001",
    revision: "B",
    operations: [
      { operation: "Form", tolerance: "0.05 mm" },
      { operation: "Inspect" },
    ],
  });
  const result = plan([uneven, target()]);
  assert.equal(result.actions.length, 0);
  assert.equal(result.refusals[0]?.code, "ambiguous_child_rows");
});

test("refuses order-insensitive child mappings because row business fields cannot be aligned safely", () => {
  const unordered: FrappeLineageManifest = {
    ...manifest,
    relationships: [{
      ...manifest.relationships[0]!,
      content: [{ from: "operations[].operation", to: "steps[].operation", label: "Operation", comparison: "set", mismatchStatus: "Inconsistent" }],
    }],
  };
  const result = plan([
    source({ business_key: "ITEM-001", revision: "B", operations: [{ operation: "Form" }, { operation: "Inspect" }] }),
    target({ values: { business_key: "ITEM-001", source_revision: "A", steps: [{ operation: "Legacy form", instruction: "Keep A" }, { operation: "Legacy inspect", instruction: "Keep B" }] } }),
  ], unordered);
  assert.equal(result.actions.length, 0);
  assert.equal(result.refusals[0]?.code, "ambiguous_child_rows");
});
