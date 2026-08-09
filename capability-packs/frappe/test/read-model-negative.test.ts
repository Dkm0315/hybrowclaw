import assert from "node:assert/strict";
import { test } from "node:test";
import { frappe_fast_route } from "../src/index.js";

const CONTEXT = { config: {} };
const BASE_ARGS = {
  site: "https://erp.example.test",
  user: "worker@example.test",
  roles: ["Employee"],
  department: "Operations",
  hasFreshIndex: true,
  hasLiveCredentials: true,
} as const;

type RouteDecision = Exclude<Awaited<ReturnType<typeof frappe_fast_route>>, { readonly error: string }>;

async function route(
  prompt: string,
  overrides: Record<string, unknown> = {},
): Promise<RouteDecision> {
  const result = await frappe_fast_route({ ...BASE_ARGS, ...overrides, prompt }, CONTEXT);
  if ("error" in result) assert.fail(`Routing failed for ${JSON.stringify(prompt)}: ${result.error}`);
  return result;
}

function assertNoMutation(decision: RouteDecision): void {
  const prompt = JSON.stringify(decision.minimalContext.prompt);
  assert.equal(
    ["record_create", "record_update", "workflow_action"].includes(decision.intent),
    false,
    `${prompt} produced unexpected mutation intent: ${decision.intent}`,
  );
  for (const check of ["write_preflight", "required_fields_check", "approval_or_user_confirmation"]) {
    assert.equal(decision.requiredChecks.includes(check), false, `${prompt} produced unexpected mutation check: ${check}`);
  }
}

function assertIndexedLookup(decision: RouteDecision, doctype: string): void {
  const prompt = JSON.stringify(decision.minimalContext.prompt);
  assert.equal(decision.intent, "record_lookup", prompt);
  assert.deepEqual(decision.candidateDoctypes, [doctype], prompt);
  assert.equal(decision.answerPath, "indexed_data", prompt);
  assert.equal(decision.invokeProvider, false, prompt);
  assert.ok(decision.requiredChecks.includes("record_visibility_filter"), prompt);
  assertNoMutation(decision);
}

test("open project work resolves to Task across ordinary business phrasing", async () => {
  const prompts = [
    "Show my open tasks",
    "Which project tasks are still open?",
    "Find the project work assigned to me",
  ];

  for (const prompt of prompts) assertIndexedLookup(await route(prompt), "Task");
});

test("todo spellings and action-list language resolve to ToDo rather than Task", async () => {
  const prompts = [
    "List my todos",
    "What's on my to-do list?",
    "Show my pending action items",
    "What is on my personal action list right now?",
  ];

  for (const prompt of prompts) assertIndexedLookup(await route(prompt), "ToDo");
});

test("ordinary business aliases resolve across major ERP modules without internal names", async () => {
  const cases = [
    ["Have I asked for any time off recently?", "Leave Application"],
    ["Did I submit any corrections for my check-out recently?", "Attendance Request"],
    ["Which hiring candidates am I allowed to review?", "Job Applicant"],
    ["Show upcoming learning sessions I can see", "Training Event"],
    ["Which recent customer bills am I allowed to see?", "Sales Invoice"],
  ] as const;

  for (const [prompt, doctype] of cases) assertIndexedLookup(await route(prompt), doctype);
});

test("portable ERP vocabulary covers major work modules without asking users for internal names", async () => {
  const cases = [
    ["Show my open project work", "Task"],
    ["Which people are being considered for open roles?", "Job Applicant"],
    ["Show support requests I am allowed to see", "HD Ticket"],
    ["Which company equipment is assigned to me?", "Asset"],
    ["Show my upcoming work travel requests", "Travel Request"],
    ["Show my performance reviews", "Appraisal"],
    ["Show customer orders I am allowed to see", "Sales Order"],
    ["Show vendor orders I am allowed to see", "Purchase Order"],
    ["Show my recent time entries", "Timesheet"],
    ["Show my onboarding checklist", "Employee Onboarding"],
  ] as const;

  for (const [prompt, doctype] of cases) {
    const decision = await route(prompt);
    assert.equal(decision.candidateDoctypes[0], doctype, prompt);
    assertNoMutation(decision);
  }
});

test("complete business phrases outrank noisy one-word site metadata", async () => {
  const projectWork = await route("What work is still waiting for me on projects?", {
    aliases: [
      { phrase: "projects", canonical: "Project", module: "Projects", confidence: 0.99, source: "site_usage" },
      { phrase: "work", canonical: "Work Order", module: "Manufacturing", confidence: 0.92, source: "site_usage" },
    ],
  });
  assert.equal(projectWork.candidateDoctypes[0], "Task");

  const timeEntries = await route("Show my recent time entries", {
    aliases: [
      { phrase: "entries", canonical: "Unreconcile Payment Entries", module: "Accounts", confidence: 0.99, source: "site_usage" },
      { phrase: "recent", canonical: "Activity Log", module: "Core", confidence: 0.9, source: "site_usage" },
    ],
  });
  assert.equal(timeEntries.candidateDoctypes[0], "Timesheet");
});

test("guided business requests outrank generic help language and punctuation variants", async () => {
  const reimbursement = await route("Help me prepare a reimbursement for a taxi ride without submitting it");
  assert.equal(reimbursement.intent, "record_create");
  assert.deepEqual(reimbursement.candidateDoctypes, ["Expense Claim"]);

  const correction = await route("I need to correct yesterday's check-out time but do not submit anything");
  assert.equal(correction.intent, "record_create");
  assert.deepEqual(correction.candidateDoctypes, ["Attendance Request"]);

  const datedAbsence = await route("Help me request next Monday off. Prepare it only and do not submit.");
  assert.equal(datedAbsence.intent, "record_create");
  assert.equal(datedAbsence.candidateDoctypes[0], "Leave Application");

  const missedClockOut = await route("I forgot to clock out yesterday. Help me correct it, but do not save anything.");
  assert.equal(missedClockOut.intent, "record_create");
  assert.equal(missedClockOut.candidateDoctypes[0], "Attendance Request");

  const paidTaxi = await route("I paid for a taxi yesterday. Help me get reimbursed, but do not submit anything.");
  assert.equal(paidTaxi.intent, "record_create");
  assert.equal(paidTaxi.candidateDoctypes[0], "Expense Claim");

  const naturalPaidTaxi = await route("I paid for a taxi yesterday and need to get reimbursed. Ask me before saving anything.");
  assert.equal(naturalPaidTaxi.intent, "record_create");
  assert.equal(naturalPaidTaxi.candidateDoctypes[0], "Expense Claim");
});

test("caller-provided allowed document scope is enforced by the router", async () => {
  const decision = await route("Show recent customer bills", { allowedDoctypes: ["Customer"] });
  assert.equal(decision.candidateDoctypes.includes("Sales Invoice"), false);
});

test("leave explanations remain read-only when the user explicitly declines creation", async () => {
  const prompts = [
    "Explain how to apply for leave, but do not create anything",
    "How does a leave application work? Information only, no submission",
    "Tell me the leave request process without filing a request",
  ];

  for (const prompt of prompts) assertIndexedLookup(await route(prompt), "Leave Application");
});

test("self and team wording keep the same Task domain and permission-scoped lookup contract", async () => {
  const self = await route("Show my open project tasks");
  const team = await route("Show my team's open project tasks");

  assertIndexedLookup(self, "Task");
  assertIndexedLookup(team, "Task");
  assert.equal(self.minimalContext.user, BASE_ARGS.user);
  assert.equal(team.minimalContext.user, BASE_ARGS.user);
  assert.equal(team.minimalContext.department, BASE_ARGS.department);
  assert.equal(team.minimalContext.prompt, "Show my team's open project tasks");
});

test("site vocabulary disambiguates business language while unresolved language stays unguessed", async () => {
  const aliased = await route("What's waiting in the dispatch docket?", {
    aliases: [{
      phrase: "dispatch docket",
      canonical: "Field Service Visit",
      module: "Field Operations",
      confidence: 0.98,
      source: "admin_curated",
    }],
  });
  assertIndexedLookup(aliased, "Field Service Visit");

  const ambiguous = await route("What needs attention today?", {
    hasLiveCredentials: false,
  });
  assert.equal(ambiguous.intent, "unknown");
  assert.deepEqual(ambiguous.candidateDoctypes, []);
  assert.equal(ambiguous.answerPath, "provider_tiny_context");
  assertNoMutation(ambiguous);
});

test("reports and office artifacts win over mutation verbs and retain dataset checks", async () => {
  const cases = [
    { prompt: "Create an overdue project task report", intent: "report", doctype: "Task" },
    { prompt: "Build a summary report of my todo list", intent: "report", doctype: "ToDo" },
    { prompt: "Export my todo list as an XLSX workbook", intent: "office_artifact", doctype: "ToDo" },
    { prompt: "Create a PDF of open project work", intent: "office_artifact", doctype: "Task" },
  ] as const;

  for (const item of cases) {
    const decision = await route(item.prompt);
    assert.equal(decision.intent, item.intent);
    assert.deepEqual(decision.candidateDoctypes, [item.doctype]);
    assert.ok(decision.requiredChecks.includes("dataset_permission_filter"));
    assert.ok(decision.requiredChecks.includes("artifact_size_cap"));
    assertNoMutation(decision);
  }
});

test("negated create, update, submit, and approve wording cannot open a mutation route", async () => {
  const cases = [
    { prompt: "Do not create a task; show the open project work instead", doctype: "Task" },
    { prompt: "Don't update the ticket; just show its current status", doctype: "HD Ticket" },
    { prompt: "Never submit a leave request; list my pending leave instead", doctype: "Leave Application" },
    { prompt: "Please don't approve anything; list my pending actions", doctype: "ToDo" },
  ] as const;

  for (const item of cases) assertIndexedLookup(await route(item.prompt), item.doctype);

  const positiveControl = await route("Create a task for the quarterly inventory review");
  assert.equal(positiveControl.intent, "record_create");
  assert.deepEqual(positiveControl.candidateDoctypes, ["Task"]);
  assert.equal(positiveControl.answerPath, "live_frappe");
  assert.ok(positiveControl.requiredChecks.includes("write_preflight"));
});
