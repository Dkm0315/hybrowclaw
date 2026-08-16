import assert from "node:assert/strict";
import { test } from "node:test";
import { validateFrappeLineage, type FrappeLineageDocument, type FrappeLineageManifest } from "../src/lineage.js";

const manifest: FrappeLineageManifest = {
  schemaVersion: 1,
  id: "engineering-change",
  label: "Engineering change",
  stages: [
    { id: "control-plan", label: "Control Plan", doctype: "Control Plan" },
    { id: "process-flow", label: "Process Flow", doctype: "Process Flow" },
  ],
  relationships: [{
    id: "control-plan-to-process-flow",
    from: "control-plan",
    to: "process-flow",
    cardinality: "one",
    required: true,
    identity: [{ from: "item", to: "item", label: "Component" }],
    revision: [{ from: "revision", to: "control_plan_revision", label: "Engineering revision" }],
    content: [{ from: "operations[].name", to: "operations[].name", label: "Operation sequence", comparison: "set", mismatchStatus: "Inconsistent" }],
  }],
};

const provenance = {
  site: "https://erp.example.test",
  principal: "engineer@example.test",
  permissionEpoch: "permission-1",
  schemaRevision: "schema-1",
  dataRevision: "data-1",
  observedAt: "2026-08-16T00:00:00.000Z",
  evidenceId: "evidence-cp",
} as const;

function source(): FrappeLineageDocument {
  return { stage: "control-plan", name: "MUSTER-DEMO-CP-002", readable: true, route: "/app/control-plan/MUSTER-DEMO-CP-002", values: { item: "MUSTER-DEMO-ITEM", revision: "B", operations: [{ name: "Cut" }, { name: "Inspect" }] }, provenance };
}

function target(overrides: Partial<FrappeLineageDocument> = {}): FrappeLineageDocument {
  return { stage: "process-flow", name: "MUSTER-DEMO-PF-002", readable: true, route: "/app/process-flow/MUSTER-DEMO-PF-002", values: { item: "MUSTER-DEMO-ITEM", control_plan_revision: "B", operations: [{ name: "Inspect" }, { name: "Cut" }] }, provenance: { ...provenance, evidenceId: "evidence-pf" }, ...overrides };
}

test("lineage validator returns deterministic current evidence", () => {
  const result = validateFrappeLineage({ manifest, documents: [source(), target()] });
  assert.equal(result.verdict, "PASS");
  assert.equal(result.counts.Current, 1);
  assert.equal(result.findings[0]?.status, "Current");
  assert.match(result.findings[0]?.to?.route ?? "", /MUSTER-DEMO-PF-002/);
});

test("lineage validator distinguishes missing, stale, inconsistent, blocked, and superseded relationships", () => {
  const missing = validateFrappeLineage({ manifest, documents: [source()] });
  assert.equal(missing.findings[0]?.status, "Requires regeneration");

  const stale = validateFrappeLineage({ manifest, documents: [source(), target({ values: { item: "MUSTER-DEMO-ITEM", control_plan_revision: "A", operations: [{ name: "Cut" }, { name: "Inspect" }] } })] });
  assert.equal(stale.findings[0]?.status, "Requires regeneration");

  const inconsistent = validateFrappeLineage({ manifest, documents: [source(), target({ values: { item: "MUSTER-DEMO-ITEM", control_plan_revision: "B", operations: [{ name: "Legacy Cut" }] } })] });
  assert.equal(inconsistent.findings[0]?.status, "Inconsistent");

  const blocked = validateFrappeLineage({ manifest, documents: [source(), target({ readable: false })] });
  assert.equal(blocked.verdict, "BLOCKED");

  const superseded = validateFrappeLineage({ manifest, documents: [source(), target({ lifecycle: "superseded" })] });
  assert.equal(superseded.findings[0]?.status, "Superseded");
});

test("lineage validator refuses mixed permission scopes and duplicate authoritative records", () => {
  assert.throws(() => validateFrappeLineage({
    manifest,
    documents: [source(), target({ provenance: { ...provenance, principal: "other@example.test" } })],
  }), /principal scopes/);
  const duplicate = validateFrappeLineage({
    manifest,
    documents: [source(), target(), target({ name: "MUSTER-DEMO-PF-003", provenance: { ...provenance, evidenceId: "evidence-pf-2" } })],
  });
  assert.equal(duplicate.findings[0]?.status, "Inconsistent");
  assert.match(duplicate.findings[0]?.summary ?? "", /one authoritative record/);
});

test("lineage validator rejects incomplete source coverage and blank identities", () => {
  assert.throws(() => validateFrappeLineage({ manifest, documents: [target()] }), /required source stage/);
  const blankSource = source();
  const blankTarget = target();
  const result = validateFrappeLineage({
    manifest,
    documents: [
      { ...blankSource, values: { ...blankSource.values, item: "" } },
      { ...blankTarget, values: { ...blankTarget.values, item: "" } },
    ],
  });
  assert.equal(result.verdict, "FAIL");
  assert.equal(result.findings[0]?.status, "Requires regeneration");
});

test("ordered comparisons detect operation sequence changes", () => {
  const orderedManifest: FrappeLineageManifest = {
    ...manifest,
    relationships: [{
      ...manifest.relationships[0]!,
      content: [{ from: "operations[].name", to: "operations[].name", label: "Operation sequence", comparison: "ordered", mismatchStatus: "Inconsistent" }],
    }],
  };
  const result = validateFrappeLineage({ manifest: orderedManifest, documents: [source(), target()] });
  assert.equal(result.verdict, "FAIL");
  assert.equal(result.findings[0]?.status, "Inconsistent");
});
