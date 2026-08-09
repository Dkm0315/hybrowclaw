import assert from "node:assert/strict";
import { test } from "node:test";
import { createFrappeApprovalProposal, frappe_safe_write, type FrappeToolContext } from "../src/index.js";

const context: FrappeToolContext = {
  config: { FRAPPE_SITE_URL: "https://frappe.test", FRAPPE_API_TOKEN: "key:secret" },
};

test("existing-record mutations require a live expected_modified guard", async () => {
  const result = await frappe_safe_write({ operation: "delete", doctype: "ToDo", docname: "TODO-1", doc: {} }, context);
  assert.match((result as { error: string }).error, /expected_modified/);
});

test("workflow approvals bind the action and use the governed operation label", () => {
  const proposal = createFrappeApprovalProposal({
    site: "https://frappe.test", principal: "user@example.test", operation: "apply_workflow",
    doctype: "Leave Application", docname: "LEAVE-1", doc: { workflow_action: "Approve" },
    permissionEpoch: "p1", schemaRevision: "s1", dataRevision: "d1", nonce: "n1",
  });
  assert.equal(proposal.operation, "apply_workflow");
  assert.match(proposal.humanSummary, /Apply workflow/);
  assert.deepEqual(proposal.fields, ["workflow_action"]);
});

test("unsupported mutation names do not silently become creates", async () => {
  const result = await frappe_safe_write({ operation: "archive", doctype: "ToDo", doc: {} }, context);
  assert.match((result as { error: string }).error, /does not support operation/);
  assert.notEqual((result as { operation?: string }).operation, "create");
});
