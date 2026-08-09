import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultConfig } from "@musterhq/core";
import {
  createFrappeWorkflowProposal,
  createFrappeWorkflowProposalResult,
  createGovernedFrappeWorkflowPlanner,
  defaultFrappeWorkflowPlanner,
  FrappeWorkflowPlanningError,
  parseTrustedFrappeWorkflowPlanningRequest,
} from "../src/frappe-workflow-planner.js";

const request = {
  schemaVersion: 1 as const,
  requestId: "plan-1",
  objective: "Review overdue invoices and ask before sending reminders",
  context: { route: "List/Sales Invoice" },
  allowedCapabilities: ["frappe.invoice.read"],
};

test("creates a data-only, approval-gated proposal with nested and parallel work", async () => {
  const proposal = await createFrappeWorkflowProposal(request, { tenantId: "tenant", siteId: "site", userId: "user@example.com" });
  assert.equal(proposal.schemaVersion, 1);
  assert.ok(proposal.steps.some((step) => step.kind === "approval"));
  assert.ok(proposal.steps.some((step) => step.kind === "parallel"));
  assert.equal(JSON.stringify(proposal).includes("frappe.invoice.write"), false);
});

test("rejects arbitrary JavaScript instead of evaluating it", async () => {
  await assert.rejects(
    createFrappeWorkflowProposal(request, { tenantId: "tenant", userId: "user@example.com" }, async () => "export default agent({})" as never),
    (error: unknown) => error instanceof FrappeWorkflowPlanningError && error.code === "invalid_proposal" && /never evals/i.test(error.message),
  );
});

test("rejects capability escalation from an injected AI planner", async () => {
  await assert.rejects(
    createFrappeWorkflowProposal(request, { tenantId: "tenant", userId: "user@example.com" }, async (input) => ({
      schemaVersion: 1, id: "unsafe.plan", version: "1", meta: { name: "Unsafe", description: "Unsafe", phases: [{ title: "Write" }] }, goal: input.objective,
      resultSchema: { type: "object" }, budget: { runtimeMs: 1000, toolCalls: 1, modelCalls: 1, tokens: 100, costMicros: 10, artifactBytes: 10 },
      limits: { maxDepth: 2, maxChildrenPerNode: 2, maxActiveNodes: 2, maxRetries: 1 },
      steps: [{ kind: "agent", label: "Escalate", prompt: "write", capabilities: ["frappe.invoice.write"] }],
    })),
    (error: unknown) => error instanceof FrappeWorkflowPlanningError && error.code === "capability_escalation",
  );
});

test("rejects oversized and unknown planning input", () => {
  assert.throws(() => parseTrustedFrappeWorkflowPlanningRequest({ ...request, context: { text: "x".repeat(64_001) } }), /size limit/);
  assert.throws(() => parseTrustedFrappeWorkflowPlanningRequest({ ...request, script: "do evil" }), /unknown field/);
});

test("rejects syntactically valid but excessive planner budgets", async () => {
  await assert.rejects(
    createFrappeWorkflowProposal(request, { tenantId: "tenant", userId: "user@example.com" }, async (input) => ({
      schemaVersion: 1, id: "expensive.plan", version: "1", meta: { name: "Expensive", description: "Expensive", phases: [{ title: "Plan" }] }, goal: input.objective,
      resultSchema: { type: "object" }, budget: { runtimeMs: 999_999_999, toolCalls: 1, modelCalls: 1, tokens: 10, costMicros: 10, artifactBytes: 10 },
      limits: { maxDepth: 2, maxChildrenPerNode: 2, maxActiveNodes: 2, maxRetries: 1 },
      steps: [{ kind: "agent", label: "Plan", prompt: "Plan" }],
    })),
    /budget runtimeMs exceeds/,
  );
});

test("repairs one invalid provider proposal without weakening capability admission", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const proposal = await createFrappeWorkflowProposal(request, { tenantId: "tenant", userId: "user@example.com" }, async (candidate) => {
    seen.push(candidate.context);
    if (seen.length === 1) return { schemaVersion: 1, id: "broken" };
    return defaultFrappeWorkflowPlanner(candidate, { tenantId: "tenant", userId: "user@example.com" });
  });
  assert.equal(proposal.schemaVersion, 1);
  assert.equal(seen.length, 2);
  assert.match(String(seen[1]?.plannerFeedback), /rejected by the exact WorkflowModuleDefinition validator/i);
  assert.deepEqual(request.context, { route: "List/Sales Invoice" });
});

test("host-compiles an attended record selection when provider workflow structure stays invalid", async () => {
  let attempts = 0;
  const attendedRequest = {
    ...request,
    objective: "Create Customer Acme with Customer Type Company",
    context: {
      attended_form_catalog: [{
        doctype: "Customer", actions: ["read", "create"], record_name: null,
        fields: [
          { fieldname: "customer_name", label: "Customer Name", writable: true },
          { fieldname: "customer_type", label: "Customer Type", writable: true },
        ],
      }],
    },
    allowedCapabilities: ["frappe.record.create"],
  };
  const result = await createFrappeWorkflowProposalResult(
    attendedRequest,
    { tenantId: "tenant", userId: "user@example.com" },
    async () => {
      attempts += 1;
      return {
        schemaVersion: 1, id: "model.invented", budget: { maxTotalSteps: 10 },
        steps: [{ kind: "execution", instructions: "Create", execution: { plan: {
          operation: { kind: "record", action: "create", doctype: "Customer", values: { customer_name: "Acme", customer_type: "Company" } },
        } } }],
      };
    },
  );
  assert.equal(attempts, 1, "the model infers one catalog-bound record intent before host compilation");
  assert.equal(result.proposal.meta.description.includes("host-compiled"), true);
  const execution = result.proposal.steps.find((step) => step.kind === "execution");
  assert.deepEqual(execution?.capabilities, ["frappe.record.create"]);
  assert.equal(JSON.stringify(result.proposal).includes("maxTotalSteps"), false);
});

test("attended fallback rejects model-selected fields outside the live writable catalog", async () => {
  await assert.rejects(
    createFrappeWorkflowProposalResult(
      {
        ...request,
        context: { attended_form_catalog: [{ doctype: "Customer", actions: ["create"], fields: [{ fieldname: "customer_name", writable: true }] }] },
        allowedCapabilities: ["frappe.record.create"],
      },
      { tenantId: "tenant", userId: "user@example.com" },
      async () => ({ schemaVersion: 1, operation: { kind: "record", action: "create", doctype: "Customer", values: { api_secret: "no" } } }),
    ),
    (error: unknown) => error instanceof FrappeWorkflowPlanningError && error.code === "invalid_proposal",
  );
});

test("attended delete selection is exact, value-free, and host-compiled for dual control", async () => {
  const result = await createFrappeWorkflowProposalResult(
    {
      ...request,
      objective: "Delete Customer ACME",
      context: {attended_form_catalog: [{
        doctype: "Customer", actions: ["read", "delete"], record_name: "ACME", fields: [],
      }]},
      allowedCapabilities: ["frappe.record.delete"],
    },
    {tenantId: "tenant", userId: "maker@example.test"},
    async () => ({kind: "record", action: "delete", doctype: "Customer", docname: "ACME"}),
  );
  const execution = result.proposal.steps.find((step) => step.kind === "execution");
  assert.ok(execution?.kind === "execution" && execution.execution.surface === "server_effect");
  const plan = execution.execution.plan as Record<string, unknown>;
  assert.equal(plan.capability, "frappe.record.delete");
  assert.equal(plan.approvalClass, "dual_control");
  assert.deepEqual(plan.operation, {kind: "record", action: "delete", doctype: "Customer", docname: "ACME"});
  assert.deepEqual(execution.capabilities, ["frappe.record.delete"]);
  assert.match(JSON.stringify(result.proposal), /Muster Approver/);

  const smuggled = await createFrappeWorkflowProposalResult(
    {
      ...request,
      objective: "Delete Customer ACME",
      context: {attended_form_catalog: [{doctype: "Customer", actions: ["read", "delete"], record_name: "ACME", fields: []}]},
      allowedCapabilities: ["frappe.record.delete"],
    },
    {tenantId: "tenant", userId: "maker@example.test"},
    async () => ({kind: "record", action: "delete", doctype: "Customer", docname: "ACME", values: {name: "smuggled"}}),
  );
  assert.equal(JSON.stringify(smuggled.proposal).includes("smuggled"), false);
});

test("attended fallback recovers a catalog-bound record or browser field selection", async () => {
  const attendedRequest = {
    ...request,
    objective: "Create Customer Acme",
    context: { attended_form_catalog: [{
      doctype: "Customer", actions: ["create"], record_name: null,
      fields: [{ fieldname: "customer_name", writable: true }, { fieldname: "customer_type", writable: true }],
    }] },
    allowedCapabilities: ["frappe.record.create"],
  };
  for (const invented of [
    { record: { action: "create", doctype: "Customer", fields: { customer_name: "Acme", customer_type: "Company" } } },
    { actions: [
      { kind: "fill", doctype: "Customer", field: "customer_name", value: "Acme" },
      { kind: "select", doctype: "Customer", field: "customer_type", option: "Company" },
    ] },
  ]) {
    const result = await createFrappeWorkflowProposalResult(
      attendedRequest,
      { tenantId: "tenant", userId: "user@example.com" },
      async () => ({ schemaVersion: 1, id: "model.invented", steps: [{ kind: "execution", execution: { plan: invented } }] }),
    );
    assert.match(JSON.stringify(result.proposal), /customer_name/);
    assert.equal(JSON.stringify(result.proposal).includes("model.invented"), false);
  }
});

test("attended inference accepts only the model's catalog-bound record decision and host-compiles the workflow", async () => {
  let plannerCalls = 0;
  const result = await createFrappeWorkflowProposalResult(
    {
      ...request,
      objective: "Create a Customer named Acme, with Customer Type Company, Customer Group Commercial, and Territory All Territories.",
      context: { attended_form_catalog: [{
        doctype: "Customer", actions: ["create"], record_name: null,
        fields: [
          { fieldname: "customer_name", label: "Customer Name", writable: true },
          { fieldname: "customer_type", label: "Customer Type", writable: true },
          { fieldname: "customer_group", label: "Customer Group", writable: true },
          { fieldname: "territory", label: "Territory", writable: true },
        ],
      }, { doctype: "Customer Group", actions: ["create"], record_name: null, fields: [{ fieldname: "customer_group_name", label: "Customer Group Name", writable: true }] }] },
      allowedCapabilities: ["frappe.record.create"],
    },
    { tenantId: "tenant", userId: "user@example.com" },
    async () => {
      plannerCalls += 1;
      return {kind: "record", action: "create", doctype: "Customer", values: {
        customer_name: "Acme", customer_type: "Company", customer_group: "Commercial", territory: "All Territories",
      }};
    },
  );
  const encoded = JSON.stringify(result.proposal);
  for (const expected of ["Acme", "Company", "Commercial", "All Territories"]) assert.match(encoded, new RegExp(expected));
  assert.equal(plannerCalls, 1, "natural language is inferred once before trusted host compilation");
});

test("attended prompt values stop before trailing execution instructions", async () => {
  let plannerCalls = 0;
  const result = await createFrappeWorkflowProposalResult(
    {
      ...request,
      objective: "Create a new Customer named Muster Visible CRUD Proof F 2026-07-19, with Customer Type Company, Customer Group Commercial, and Territory All Territories. Show every Desk step and do not save until I explicitly approve.",
      context: { attended_form_catalog: [{
        doctype: "Customer", actions: ["create"], record_name: null,
        fields: [
          { fieldname: "customer_name", label: "Customer Name", writable: true },
          { fieldname: "customer_type", label: "Customer Type", writable: true },
          { fieldname: "customer_group", label: "Customer Group", writable: true },
          { fieldname: "territory", label: "Territory", writable: true },
        ],
      }] },
      allowedCapabilities: ["frappe.record.create"],
    },
    { tenantId: "tenant", userId: "user@example.com" },
    async () => { plannerCalls += 1; return { schemaVersion: 1, id: "invalid-without-record-intent" }; },
  );
  const encoded = JSON.stringify(result.proposal);
  assert.match(encoded, /"territory":"All Territories"/);
  assert.equal(encoded.includes('"value":"All Territories. Show every Desk step"'), false);
  assert.equal(plannerCalls, 2, "the narrow prompt parser is a final recovery path after semantic inference fails closed");
});

test("attended labelled sentences do not bleed into the next live field", async () => {
  const result = await createFrappeWorkflowProposalResult(
    {
      ...request,
      objective: "Create a Purchase Order. Company: Muster Frappeverse Demo. Supplier: Frappeverse Supplier 001. Currency: INR. Open the live form and do not save.",
      context: { attended_form_catalog: [{
        doctype: "Purchase Order", actions: ["create"], record_name: null,
        fields: [
          { fieldname: "company", label: "Company", writable: true },
          { fieldname: "supplier", label: "Supplier", writable: true },
          { fieldname: "currency", label: "Currency", writable: true },
        ],
      }] },
      allowedCapabilities: ["frappe.record.create"],
    },
    { tenantId: "tenant", userId: "user@example.com" },
    async () => ({kind: "record", action: "create", doctype: "Purchase Order", values: {
      company: "Muster Frappeverse Demo. Supplier: Frappeverse Supplier 001",
      supplier: "Frappeverse Supplier 001. Currency: INR",
      currency: "INR. Open the live form",
    }}),
  );
  const operation = (result.proposal.steps.find((step) => step.kind === "execution") as any).execution.plan.operation;
  assert.deepEqual(operation.values, {
    company: "Muster Frappeverse Demo",
    supplier: "Frappeverse Supplier 001",
    currency: "INR",
  });
});

test("attended inference preserves only live writable child-table fields", async () => {
  const result = await createFrappeWorkflowProposalResult(
    {
      ...request,
      objective: "Create a Purchase Order for item MFD-ITEM-001 with quantity 2 and warehouse Stores - MFD. Open the live form and do not save.",
      context: { attended_form_catalog: [{
        doctype: "Purchase Order", actions: ["create"], record_name: null,
        fields: [{
          fieldname: "items", label: "Items", fieldtype: "Table", writable: true,
          child_fields: [
            {fieldname: "item_code", label: "Item", fieldtype: "Link", writable: true},
            {fieldname: "qty", label: "Qty", fieldtype: "Float", writable: true},
            {fieldname: "warehouse", label: "Warehouse", fieldtype: "Link", writable: true},
            {fieldname: "margin_rate_or_amount", label: "Margin", fieldtype: "Currency", writable: false},
          ],
        }],
      }] },
      allowedCapabilities: ["frappe.record.create"],
    },
    { tenantId: "tenant", userId: "user@example.com" },
    async () => ({kind: "record", action: "create", doctype: "Purchase Order", values: {
      items: [{item_code: "MFD-ITEM-001", qty: 2, warehouse: "Stores - MFD"}],
    }}),
  );
  const operation = (result.proposal.steps.find((step) => step.kind === "execution") as any).execution.plan.operation;
  assert.deepEqual(operation.values.items, [{item_code: "MFD-ITEM-001", qty: 2, warehouse: "Stores - MFD"}]);
});

test("attended inference rejects denied child-table fields", async () => {
  await assert.rejects(createFrappeWorkflowProposalResult(
    {
      ...request,
      objective: "Create a Purchase Order with margin 10. Do not save.",
      context: { attended_form_catalog: [{doctype: "Purchase Order", actions: ["create"], fields: [{
        fieldname: "items", label: "Items", fieldtype: "Table", writable: true,
        child_fields: [{fieldname: "margin_rate_or_amount", label: "Margin", writable: false}],
      }]}] },
      allowedCapabilities: ["frappe.record.create"],
    },
    { tenantId: "tenant", userId: "user@example.com" },
    async () => ({kind: "record", action: "create", doctype: "Purchase Order", values: {
      items: [{margin_rate_or_amount: 10}],
    }}),
  ), /Invalid workflow module/i);
});

test("attended inference completes an unambiguous customer and ISO date from natural phrasing", async () => {
  const result = await createFrappeWorkflowProposalResult(
    {
      ...request,
      objective: "Create a Service Visit for Frappeverse Customer 001 scheduled on 2026-08-05 with Status Planned and Notes Bring a replacement scanner.",
      context: { attended_form_catalog: [{
        doctype: "Service Visit", actions: ["create"], record_name: null,
        fields: [
          { fieldname: "customer", label: "Customer", fieldtype: "Data", required: true, writable: true },
          { fieldname: "scheduled_on", label: "Scheduled On", fieldtype: "Date", required: true, writable: true },
          { fieldname: "status", label: "Status", fieldtype: "Select", required: true, writable: true },
          { fieldname: "notes", label: "Notes", fieldtype: "Small Text", writable: true },
        ],
      }] },
      allowedCapabilities: ["frappe.record.create"],
    },
    { tenantId: "tenant", userId: "user@example.com" },
    async () => ({schemaVersion: 1, id: "invalid-without-record-intent"}),
  );
  const encoded = JSON.stringify(result.proposal);
  assert.match(encoded, /"customer":"Frappeverse Customer 001"/);
  assert.match(encoded, /"scheduled_on":"2026-08-05"/);
  assert.match(encoded, /"status":"Planned"/);
});

test("exact field labels override a provider span with redundant connectors", async () => {
  const result = await createFrappeWorkflowProposalResult(
    {
      ...request,
      objective: "Create a Service Visit for Customer Live Governed Browser Proof 2026-07-20 with Scheduled On 2026-07-20, Status Planned, and Notes Native takeover proof.",
      context: { attended_form_catalog: [{
        doctype: "Service Visit", actions: ["create"], record_name: null,
        fields: [
          { fieldname: "customer", label: "Customer", fieldtype: "Data", writable: true },
          { fieldname: "scheduled_on", label: "Scheduled On", fieldtype: "Date", writable: true },
          { fieldname: "status", label: "Status", fieldtype: "Select", writable: true },
          { fieldname: "notes", label: "Notes", fieldtype: "Small Text", writable: true },
        ],
      }] },
      allowedCapabilities: ["frappe.record.create"],
    },
    { tenantId: "tenant", userId: "user@example.com" },
    async () => ({kind: "record", action: "create", doctype: "Service Visit", values: {
      customer: "Customer Live Governed Browser Proof 2026-07-20 with",
      scheduled_on: "2026-07-20", status: "Planned", notes: "Native takeover proof",
    }}),
  );
  const encoded = JSON.stringify(result.proposal);
  assert.match(encoded, /"customer":"Live Governed Browser Proof 2026-07-20"/);
});

test("attended structural inference fails closed for ambiguous dates and non-customer fields", async () => {
  const result = await createFrappeWorkflowProposalResult(
    {
      ...request,
      objective: "Create a Task for Project Alpha on 2026-08-05 or 2026-08-06 with Status Open.",
      context: { attended_form_catalog: [{
        doctype: "Task", actions: ["create"], record_name: null,
        fields: [
          { fieldname: "subject", label: "Subject", fieldtype: "Data", required: true, writable: true },
          { fieldname: "exp_start_date", label: "Expected Start Date", fieldtype: "Date", writable: true },
          { fieldname: "status", label: "Status", fieldtype: "Select", writable: true },
        ],
      }] },
      allowedCapabilities: ["frappe.record.create"],
    },
    { tenantId: "tenant", userId: "user@example.com" },
    async () => ({kind: "record", action: "create", doctype: "Task", values: {status: "Open"}}),
  );
  const encoded = JSON.stringify(result.proposal);
  assert.equal(encoded.includes('"subject":"Project Alpha"'), false);
  assert.equal(encoded.includes('"exp_start_date"'), false);
  assert.match(encoded, /"status":"Open"/);
});

test("governed provider planner is read-only/offline and returns separately validated run metadata", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-governed-frappe-planner-"));
  const command = join(cwd, "fake-codex.mjs");
  const argsFile = join(cwd, "args.json");
  const validProposal = await createFrappeWorkflowProposal(request, { tenantId: "tenant", userId: "user@example.com" });
  await writeFile(command, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));
const output = args[args.indexOf("-o") + 1];
writeFileSync(output, process.env.FAKE_FRAPPE_PLANNER_RESPONSE || "");
process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"planner-thread"})+"\\n");
process.stdout.write(JSON.stringify({type:"turn.completed"})+"\\n");
`, "utf8");
  await chmod(command, 0o755);
  const priorCommand = process.env.MUSTER_CODEX_COMMAND;
  const priorResponse = process.env.FAKE_FRAPPE_PLANNER_RESPONSE;
  process.env.MUSTER_CODEX_COMMAND = command;
  process.env.FAKE_FRAPPE_PLANNER_RESPONSE = JSON.stringify(validProposal);
  try {
    const result = await createFrappeWorkflowProposalResult(
      request,
      { tenantId: "tenant", userId: "user@example.com" },
      createGovernedFrappeWorkflowPlanner({ config: defaultConfig(), cwd, workspaceDir: cwd }),
    );
    assert.equal(result.proposal.schemaVersion, 1);
    assert.equal(result.runMetadata?.executionBoundary, "read-only-offline-provider");
    const args = JSON.parse(await (await import("node:fs/promises")).readFile(argsFile, "utf8")) as string[];
    assert.ok(args.includes("read-only"));
    assert.ok(args.includes("--skip-git-repo-check"));

    process.env.FAKE_FRAPPE_PLANNER_RESPONSE = "```json\n{}\n```";
    await assert.rejects(
      createFrappeWorkflowProposalResult(
        request,
        { tenantId: "tenant", userId: "user@example.com" },
        createGovernedFrappeWorkflowPlanner({ config: defaultConfig(), cwd, workspaceDir: cwd }),
      ),
      /strict JSON object without Markdown/,
    );
  } finally {
    if (priorCommand === undefined) delete process.env.MUSTER_CODEX_COMMAND; else process.env.MUSTER_CODEX_COMMAND = priorCommand;
    if (priorResponse === undefined) delete process.env.FAKE_FRAPPE_PLANNER_RESPONSE; else process.env.FAKE_FRAPPE_PLANNER_RESPONSE = priorResponse;
    await rm(cwd, { recursive: true, force: true });
  }
});
