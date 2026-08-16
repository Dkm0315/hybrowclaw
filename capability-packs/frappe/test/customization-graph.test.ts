import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFrappeCustomizationGraph, buildFrappeCustomizationGraphFromIndex, frappeCustomizationNeighborhood, type FrappeGraphProvenance } from "../src/customization-graph.js";

const provenance: FrappeGraphProvenance = {
  site: "https://erp.example.test",
  principal: "engineer@example.test",
  permissionEpoch: "permission-1",
  schemaRevision: "schema-1",
  dataRevision: "data-1",
  observedAt: "2026-08-16T00:00:00.000Z",
  evidenceId: "evidence-1",
};

test("customization graph is deterministic, deduplicated, and queryable", () => {
  const graph = buildFrappeCustomizationGraph({
    nodes: [
      { id: "doctype:Control_Plan", kind: "doctype", label: "Control Plan", provenance },
      { id: "field:Control_Plan.item", kind: "custom_field", label: "Item", doctype: "Control Plan", provenance },
      { id: "doctype:Item", kind: "doctype", label: "Item", provenance },
      { id: "doctype:Control_Plan", kind: "doctype", label: "Control Plan", provenance },
    ],
    edges: [
      { from: "doctype:Control_Plan", to: "field:Control_Plan.item", kind: "contains", provenance },
      { from: "field:Control_Plan.item", to: "doctype:Item", kind: "links_to", provenance },
      { from: "field:Control_Plan.item", to: "doctype:Item", kind: "links_to", provenance },
    ],
  });
  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.edges.length, 2);
  assert.equal(graph.digest.length, 64);
  const neighborhood = frappeCustomizationNeighborhood(graph, ["field:Control_Plan.item"], 1);
  assert.deepEqual(neighborhood.nodes.map((node) => node.id), ["doctype:Control_Plan", "doctype:Item", "field:Control_Plan.item"]);
});

test("customization graph rejects permission mixing, dangling edges, and secret material", () => {
  assert.throws(() => buildFrappeCustomizationGraph({
    nodes: [
      { id: "doctype:A", kind: "doctype", label: "A", provenance },
      { id: "doctype:B", kind: "doctype", label: "B", provenance: { ...provenance, principal: "other@example.test" } },
    ],
    edges: [],
  }), /principal scopes/);
  assert.throws(() => buildFrappeCustomizationGraph({
    nodes: [{ id: "doctype:A", kind: "doctype", label: "A", provenance }],
    edges: [{ from: "doctype:A", to: "doctype:missing", kind: "links_to", provenance }],
  }), /unavailable node/);
  assert.throws(() => buildFrappeCustomizationGraph({
    nodes: [{ id: "script:A", kind: "server_script", label: "A", attributes: { api_token: "leak" }, provenance }],
    edges: [],
  }), /forbidden/);
});

test("enterprise index records become a graph without script bodies or credentials", () => {
  const graph = buildFrappeCustomizationGraphFromIndex({
    principal: provenance.principal,
    permissionEpoch: provenance.permissionEpoch,
    schemaRevision: provenance.schemaRevision,
    dataRevision: provenance.dataRevision,
    records: [
      { site: provenance.site, kind: "doctype", objectId: "Control Plan", label: "Control Plan", searchText: "control plan", payload: { name: "Control Plan" }, revision: "r1", observedAt: provenance.observedAt, validUntil: "2026-08-16T00:05:00.000Z", source: "rest_poll" },
      { site: provenance.site, kind: "custom_field", objectId: "Control Plan-custom_item", doctype: "Control Plan", label: "Item", searchText: "item", payload: { dt: "Control Plan", fieldname: "custom_item", fieldtype: "Link", options: "Item", api_token: "must-not-enter-graph" }, revision: "r2", observedAt: provenance.observedAt, validUntil: "2026-08-16T00:05:00.000Z", source: "rest_poll" },
      { site: provenance.site, kind: "server_script", objectId: "Validate Control Plan", doctype: "Control Plan", label: "Validate Control Plan", searchText: "validate", payload: { reference_doctype: "Control Plan", script_type: "DocType Event", disabled: 0, script: "frappe.throw('must-not-enter-graph')", accessToken: "also-secret" }, revision: "r3", observedAt: provenance.observedAt, validUntil: "2026-08-16T00:05:00.000Z", source: "rest_poll" },
    ],
  });
  const controlPlan = graph.nodes.find((node) => node.kind === "doctype" && node.label === "Control Plan");
  const item = graph.nodes.find((node) => node.kind === "doctype" && node.label === "Item");
  assert.ok(controlPlan);
  assert.ok(item);
  assert.ok(graph.edges.some((edge) => edge.kind === "links_to" && edge.to === item.id));
  assert.doesNotMatch(JSON.stringify(graph), /must-not-enter-graph/);
  assert.doesNotMatch(JSON.stringify(graph), /also-secret/);
});

test("index node ids remain deterministic when display names normalize to the same slug", () => {
  const records = ["A B", "A_B"].map((objectId, index) => ({
    site: provenance.site, kind: "doctype" as const, objectId, label: objectId, searchText: objectId,
    payload: { name: objectId }, revision: `r${index}`, observedAt: provenance.observedAt,
    validUntil: "2026-08-16T00:05:00.000Z", source: "rest_poll" as const,
  }));
  const build = (items: typeof records) => buildFrappeCustomizationGraphFromIndex({
    records: items, principal: provenance.principal, permissionEpoch: provenance.permissionEpoch,
    schemaRevision: provenance.schemaRevision, dataRevision: provenance.dataRevision,
  });
  const forward = build(records);
  const reverse = build([...records].reverse());
  assert.equal(forward.nodes.length, 2);
  assert.equal(forward.digest, reverse.digest);
  assert.notEqual(forward.nodes[0]?.id, forward.nodes[1]?.id);
});
