import assert from "node:assert/strict";
import { test } from "node:test";
import { loadLiveFrappeLineageEvidence, type FrappeLineageLiveContext } from "../src/lineage-live.js";
import { validateFrappeLineage, type FrappeLineageManifest } from "../src/lineage.js";

const manifest: FrappeLineageManifest = {
  schemaVersion: 1,
  id: "live-engineering-change",
  label: "Live engineering change",
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
    identity: [{ from: "item", to: "item", label: "Item" }],
    revision: [{ from: "revision", to: "control_plan_revision", label: "Revision" }],
    content: [{ from: "operations[].operation", to: "operations[].operation", label: "Operations", comparison: "ordered" }],
  }],
};

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function context(handler: (url: URL, init: RequestInit) => Response | Promise<Response>): FrappeLineageLiveContext {
  return {
    siteUrl: "https://erp.example.test/path-is-ignored",
    auth: { authorization: "Bearer live-oauth-token" },
    fetch: (async (input, init) => handler(new URL(String(input)), init ?? {})) as typeof globalThis.fetch,
  };
}

test("loads live permission-filtered lineage and validates it", async () => {
  const calls: URL[] = [];
  const documents = await loadLiveFrappeLineageEvidence({
    context: context((url, init) => {
      calls.push(url);
      assert.equal(init.method, "GET");
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer live-oauth-token");
      if (url.pathname.endsWith("frappe.auth.get_logged_user")) return response({ message: "engineer@example.test" });
      if (url.pathname === "/api/resource/Control%20Plan/CP-001") return response({ data: { name: "CP-001", item: "ITEM-1", revision: "B", modified: "2026-08-16T01:00:00.000Z", docstatus: 1, operations: [{ operation: "Bending" }] } }, 200, { etag: "cp-b" });
      if (url.pathname === "/api/resource/Process%20Flow") {
        assert.deepEqual(JSON.parse(url.searchParams.get("filters") ?? "[]"), [["item", "=", "ITEM-1"]]);
        return response({ data: [{ name: "PF-001", item: "ITEM-1", modified: "2026-08-16T01:01:00.000Z" }] });
      }
      if (url.pathname === "/api/resource/Process%20Flow/PF-001") return response({ data: { name: "PF-001", item: "ITEM-1", control_plan_revision: "B", modified: "2026-08-16T01:01:00.000Z", docstatus: 1, operations: [{ operation: "Bending" }], unrequested_private_field: "not returned by the evidence projection" } });
      throw new Error(`Unexpected request ${url}`);
    }),
    manifest,
    rootStage: "control-plan",
    rootName: "CP-001",
    principal: "engineer@example.test",
    permissionEpoch: "permission-1",
  });

  assert.equal(documents.length, 2);
  assert.equal(documents[0]?.provenance.site, "https://erp.example.test");
  assert.equal(documents[0]?.provenance.schemaRevision, documents[1]?.provenance.schemaRevision);
  assert.equal(documents[0]?.provenance.dataRevision, documents[1]?.provenance.dataRevision);
  assert.equal("unrequested_private_field" in (documents.find((doc) => doc.stage === "process-flow")?.values ?? {}), false);
  assert.equal(validateFrappeLineage({ manifest, documents }).verdict, "PASS");
  assert.equal(calls.filter((url) => url.pathname === "/api/resource/Process%20Flow").length, 1);
});

test("turns a forbidden target query into matching unreadable evidence", async () => {
  const documents = await loadLiveFrappeLineageEvidence({
    context: context((url) => {
      if (url.pathname.endsWith("frappe.auth.get_logged_user")) return response({ message: "engineer@example.test" });
      if (url.pathname === "/api/resource/Control%20Plan/CP-001") return response({ data: { name: "CP-001", item: "ITEM-1", revision: "B", modified: "2026-08-16T01:00:00.000Z", operations: [] } });
      if (url.pathname === "/api/resource/Process%20Flow") return response({ exc_type: "PermissionError" }, 403);
      throw new Error(`Unexpected request ${url}`);
    }),
    manifest,
    rootStage: "control-plan",
    rootName: "CP-001",
    principal: "engineer@example.test",
    permissionEpoch: "permission-1",
  });

  const denied = documents.find((document) => document.stage === "process-flow");
  assert.equal(denied?.readable, false);
  assert.equal(denied?.values.item, "ITEM-1");
  assert.equal(validateFrappeLineage({ manifest, documents }).verdict, "BLOCKED");
});

test("preserves a named unreadable target when its full document is forbidden", async () => {
  const documents = await loadLiveFrappeLineageEvidence({
    context: context((url) => {
      if (url.pathname.endsWith("frappe.auth.get_logged_user")) return response({ message: "engineer@example.test" });
      if (url.pathname === "/api/resource/Control%20Plan/CP-001") return response({ data: { name: "CP-001", item: "ITEM-1", revision: "B", modified: "2026-08-16T01:00:00.000Z", operations: [] } });
      if (url.pathname === "/api/resource/Process%20Flow") return response({ data: [{ name: "PF-SECRET", item: "ITEM-1" }] });
      if (url.pathname === "/api/resource/Process%20Flow/PF-SECRET") return response({ exc_type: "PermissionError" }, 403);
      throw new Error(`Unexpected request ${url}`);
    }),
    manifest,
    rootStage: "control-plan",
    rootName: "CP-001",
    principal: "engineer@example.test",
    permissionEpoch: "permission-1",
  });

  const denied = documents.find((document) => document.name === "PF-SECRET");
  assert.equal(denied?.readable, false);
  assert.equal(validateFrappeLineage({ manifest, documents }).verdict, "BLOCKED");
});

test("rejects identity drift, unbounded traversal, and relationships without queryable identity", async () => {
  await assert.rejects(() => loadLiveFrappeLineageEvidence({
    context: context(() => response({ message: "other@example.test" })),
    manifest,
    rootStage: "control-plan",
    rootName: "CP-001",
    principal: "engineer@example.test",
    permissionEpoch: "permission-1",
  }), /does not match/);

  await assert.rejects(() => loadLiveFrappeLineageEvidence({
    context: context((url) => {
      if (url.pathname.endsWith("frappe.auth.get_logged_user")) return response({ message: "engineer@example.test" });
      if (url.pathname === "/api/resource/Control%20Plan/CP-001") return response({ data: { name: "CP-001", item: "ITEM-1" } });
      if (url.pathname === "/api/resource/Process%20Flow") return response({ data: [{ name: "PF-001", item: "ITEM-1" }] });
      throw new Error(`Unexpected request ${url}`);
    }),
    manifest,
    rootStage: "control-plan",
    rootName: "CP-001",
    principal: "engineer@example.test",
    permissionEpoch: "permission-1",
    maxRecords: 1,
  }), /record cap/);

  const nestedIdentityManifest: FrappeLineageManifest = {
    ...manifest,
    relationships: [{ ...manifest.relationships[0]!, identity: [{ from: "item", to: "items[].item", label: "Item" }] }],
  };
  await assert.rejects(() => loadLiveFrappeLineageEvidence({
    context: context((url) => {
      if (url.pathname.endsWith("frappe.auth.get_logged_user")) return response({ message: "engineer@example.test" });
      return response({ data: { name: "CP-001", item: "ITEM-1" } });
    }),
    manifest: nestedIdentityManifest,
    rootStage: "control-plan",
    rootName: "CP-001",
    principal: "engineer@example.test",
    permissionEpoch: "permission-1",
  }), /no scalar top-level identity/);
});
