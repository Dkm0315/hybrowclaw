import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFrappeReadPlannerPrompt,
  createFrappeReadPlan,
  FrappeReadPlanningError,
  parseTrustedFrappeReadPlanningRequest,
} from "../src/frappe-read-planner.js";

const authority = { tenantId: "tenant-a", siteId: "site-a", userId: "accounts@example.test" };
const request = {
  schemaVersion: 1 as const,
  requestId: "read-1",
  question: "How many overdue sales invoices are outstanding?",
  catalog: [
    { doctype: "Sales Invoice", fields: ["name", "status", "outstanding_amount", "customer", "due_date"] },
    { doctype: "Employee", fields: ["name", "employee_name", "department"] },
  ],
  context: { route: "/app/sales-invoice" },
};

test("provider contract supplies the exact read-plan request identity", () => {
  const built = buildFrappeReadPlannerPrompt(request, authority);
  assert.match(built.prompt, /Required request identity \(copy exactly\): read-1/);
  assert.match(built.prompt, /requestId must exactly equal/);
  assert.doesNotMatch(built.systemContext, /read-1/);
});

test("admits bounded list, count, and numeric aggregate plans from the permitted catalog", async () => {
  const cases = [
    { fields: ["name", "customer"], filters: [{ field: "status", operator: "=", value: "Overdue" }], orderBy: [{ field: "due_date", direction: "asc" }], limit: 25 },
    { fields: [], filters: [{ field: "status", operator: "=", value: "Overdue" }], aggregate: { function: "count" }, orderBy: [], limit: 1 },
    { fields: [], filters: [{ field: "status", operator: "=", value: "Overdue" }], aggregate: { function: "sum", field: "outstanding_amount" }, orderBy: [], limit: 1 },
  ];
  for (const query of cases) {
    const plan = await createFrappeReadPlan(request, authority, async () => ({ schemaVersion: 1, requestId: "read-1", disposition: "query", reason: "Fresh invoice evidence is required.", queries: [{ doctype: "Sales Invoice", ...query }] }));
    assert.equal(plan.queries[0]?.doctype, "Sales Invoice");
    assert.ok(plan.queries[0]!.limit <= 100);
  }
});

test("canonicalizes the provider's bounded count shorthand without weakening numeric aggregates", async () => {
  const count = await createFrappeReadPlan(request, authority, async () => ({
    schemaVersion: 1, requestId: "read-1", disposition: "query", reason: "Fresh count evidence is required.",
    queries: [{doctype: "Sales Invoice", fields: [], filters: [], aggregate: "count", orderBy: [], limit: 1}],
  }));
  assert.deepEqual(count.queries[0]?.aggregate, {function: "count"});
  await assert.rejects(createFrappeReadPlan(request, authority, async () => ({
    schemaVersion: 1, requestId: "read-1", disposition: "query", reason: "Invalid numeric shorthand.",
    queries: [{doctype: "Sales Invoice", fields: [], filters: [], aggregate: "sum", orderBy: [], limit: 1}],
  })), /Read aggregate is invalid/);
});

test("rejects SQL, methods, URLs, scripts, joins, unknown fields, and child-table escapes as non-contract data", async () => {
  const hostile = [
    { schemaVersion: 1, requestId: "read-1", disposition: "query", reason: "x", queries: [], sql: "select * from tabUser" },
    { schemaVersion: 1, requestId: "read-1", disposition: "query", reason: "x", queries: [], method: "frappe.client.get_list" },
    { schemaVersion: 1, requestId: "read-1", disposition: "query", reason: "x", queries: [], url: "https://evil.test" },
    { schemaVersion: 1, requestId: "read-1", disposition: "query", reason: "x", queries: [], script: "process.exit()" },
    { schemaVersion: 1, requestId: "read-1", disposition: "query", reason: "x", queries: [{ doctype: "Sales Invoice", fields: ["customer.customer_name"], filters: [], orderBy: [], limit: 10 }] },
    { schemaVersion: 1, requestId: "read-1", disposition: "query", reason: "x", queries: [{ doctype: "Sales Invoice Item", fields: ["item_code"], filters: [], orderBy: [], limit: 10 }] },
  ];
  for (const value of hostile) {
    await assert.rejects(createFrappeReadPlan(request, authority, async () => value), FrappeReadPlanningError);
  }
});

test("rejects prompt-injected IR, leading wildcard scans, excessive limits, and cross-catalog reads", async () => {
  assert.throws(() => parseTrustedFrappeReadPlanningRequest({ ...request, admin: true }), /unknown field/i);
  const queries = [
    { doctype: "Sales Invoice", fields: ["name"], filters: [{ field: "customer", operator: "like", value: "%Corp" }], orderBy: [], limit: 10 },
    { doctype: "Sales Invoice", fields: ["name"], filters: [], orderBy: [], limit: 1000 },
    { doctype: "User", fields: ["name"], filters: [], orderBy: [], limit: 10 },
    { doctype: "Sales Invoice", fields: ["password"], filters: [], orderBy: [], limit: 10 },
  ];
  for (const query of queries) {
    await assert.rejects(
      createFrappeReadPlan(request, authority, async () => ({ schemaVersion: 1, requestId: "read-1", disposition: "query", reason: "x", queries: [query] })),
      FrappeReadPlanningError,
    );
  }
});

test("returns explicit unsupported and action-needed classes without inventing evidence", async () => {
  for (const disposition of ["unsupported", "action_needed"] as const) {
    const plan = await createFrappeReadPlan(request, authority, async () => ({
      schemaVersion: 1, requestId: "read-1", disposition, reason: "This turn does not require a live record query.", queries: [],
    }));
    assert.equal(plan.disposition, disposition);
    assert.deepEqual(plan.queries, []);
  }
});

test("repairs one invalid provider plan without weakening catalog admission", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const plan = await createFrappeReadPlan(request, authority, async (candidate) => {
    seen.push(candidate.context);
    if (seen.length === 1) {
      return { schemaVersion: 1, requestId: "read-1", disposition: "query", reason: "Needs evidence.", queries: [{ doctype: "Sales Invoice", fields: ["invented_field"], filters: [], orderBy: [], limit: 10 }] };
    }
    return { schemaVersion: 1, requestId: "read-1", disposition: "query", reason: "Uses the exact catalog.", queries: [{ doctype: "Sales Invoice", fields: ["name"], filters: [], orderBy: [], limit: 10 }] };
  });
  assert.equal(seen.length, 2);
  assert.equal(plan.queries[0]?.fields[0], "name");
  assert.match(String(seen[1]?.plannerFeedback), /outside the supplied catalog/i);
});
