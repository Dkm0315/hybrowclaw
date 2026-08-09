import assert from "node:assert/strict";
import { test } from "node:test";
import { frappeChannelQuickReply, frappeEvidenceQuickReply, frappePermissionContextForTurn, frappeTaskKindForIntent, isFrappeBusinessIntent } from "../src/frappe-channel.js";
import { frappeNativeSessionPolicyKey } from "../src/frappe-ingress.js";
import { surfaceReplyToTelegramSend } from "../src/adapters/telegram.js";
import type { PairedIdentity } from "../src/pairing.js";

const identity: PairedIdentity = {
  provider: "frappe",
  site: "https://erp.example.test",
  user: "asha@example.test",
  employee: "EMP-0042",
  employeeName: "Asha Example",
  employeeStatus: "Active",
  department: "DEP-1097",
  departmentName: "Operations",
  company: "Example Holdings",
  reportsTo: "EMP-0007",
  reportsToName: "Ravi Manager",
  roles: ["Employee"],
  resolvedAt: "2026-07-13T00:00:00.000Z",
};

test("Frappe business intents select a capable route without becoming architecture work", () => {
  assert.equal(frappeTaskKindForIntent("record_create", "Give me a concise plan to apply leave next Monday"), "workflow");
  assert.equal(frappeTaskKindForIntent("record_lookup", "Show my pending leave requests"), "simple_qa");
  assert.equal(frappeTaskKindForIntent("report", "Prepare a PDF report of my leave history"), "artifact");
  assert.equal(frappeTaskKindForIntent("office_artifact", "Prepare my leave history"), "artifact");
  assert.equal(frappeTaskKindForIntent(undefined, "Discuss this with me"), undefined);
  assert.equal(isFrappeBusinessIntent("record_lookup"), true);
  assert.equal(isFrappeBusinessIntent("office_artifact"), true);
  assert.equal(isFrappeBusinessIntent("help"), false);
  assert.equal(isFrappeBusinessIntent("unknown"), false);
});

test("Frappe native-session policy identity is stable but changes with permissions and governed tools", () => {
  const assistant = { name: "OxygenHR Assistant", organization: "OxygenHR", domains: ["Leave", "People"] };
  const first = frappeNativeSessionPolicyKey(
    { ...identity, roles: ["Employee", "Desk User"], permissionHash: "permission-a", rolesHash: "roles-a" },
    assistant,
    true,
    ["playwright", "frappe_control_plane"],
  );
  const reordered = frappeNativeSessionPolicyKey(
    { ...identity, roles: ["Desk User", "Employee"], permissionHash: "permission-a", rolesHash: "roles-a" },
    { ...assistant, domains: ["People", "Leave"] },
    true,
    ["frappe_control_plane", "playwright"],
  );
  const permissionChanged = frappeNativeSessionPolicyKey(
    { ...identity, roles: ["Employee", "Desk User"], permissionHash: "permission-b", rolesHash: "roles-a" },
    assistant,
    true,
    ["playwright", "frappe_control_plane"],
  );

  assert.equal(first, reordered);
  assert.notEqual(first, permissionChanged);
  assert.notEqual(first, frappeNativeSessionPolicyKey(identity, assistant, true, []));
});

test("Frappe orientation prompts are deterministic, deployment-aware, and token-free", () => {
  const reply = frappeChannelQuickReply("what can you do?", identity, {
    name: "OxygenHR Assistant",
    organization: "OxygenHR",
  }, true);
  assert.ok(reply);
  assert.match(reply.text, /OxygenHR Assistant/);
  assert.match(reply.text, /Ask naturally/);
  assert.match(reply.text, /What needs my attention today/);
  assert.match(reply.text, /connected to OxygenHR/);
  assert.equal(reply.presentation?.tables?.length ?? 0, 0, "quick help must not start with a catalog table");
  assert.ok((reply.presentation?.actions?.length ?? 0) <= 3, "quick help must keep next actions focused");
  assert.doesNotMatch(reply.text, /DocType|fieldname|property setter|Frappe|workspace|filesystem|debug|refactor/i);
});

test("Frappe quick reply does not intercept a real business request", () => {
  assert.equal(frappeChannelQuickReply("Show my pending leave requests", identity, undefined, true), undefined);
  assert.equal(frappeChannelQuickReply("Show my department's pending leave requests", identity, undefined, true), undefined);
});

test("paired self-profile questions are deterministic and need no provider call", () => {
  const department = frappeChannelQuickReply("Which department am I in?", identity, undefined, true);
  assert.ok(department);
  assert.match(department.text, /Department: Operations/);
  assert.match(department.text, /Verified from the work account connected to this chat/);
  assert.doesNotMatch(department.text, /DEP-1097/);
  assert.equal(department.presentation?.tables?.length ?? 0, 0);

  const manager = frappeChannelQuickReply("Who do I report to?", identity, undefined, false);
  assert.ok(manager);
  assert.match(manager.text, /Reports to: Ravi Manager/);
  assert.doesNotMatch(manager.text, /EMP-0007/);
  assert.match(manager.text, /last verified sign-in/);

  const employee = frappeChannelQuickReply("What is my employee ID?", identity, undefined, true);
  assert.ok(employee);
  assert.match(employee.text, /Employee ID: EMP-0042/);
});

test("combined self-profile questions stay on the deterministic identity path", () => {
  const reply = frappeChannelQuickReply(
    "Which department am I in, and who do I report to?",
    identity,
    { name: "OxygenHR Assistant", organization: "OxygenHR" },
    true,
  );
  assert.ok(reply);
  assert.match(reply.text, /Department: Operations/);
  assert.match(reply.text, /Reports to: Ravi Manager/);
});

test("live Frappe context uses the actor OAuth token internally and returns only permission-filtered evidence", async () => {
  let liveArgs: Record<string, unknown> | undefined;
  const result = await frappePermissionContextForTurn({
    prompt: "Show my pending leave requests",
    surfaceId: "telegram:oxygenhr",
    identity,
    authorization: {
      connectionId: "oxygenhr",
      site: "https://erp.example.test",
      header: "Bearer oauth-secret-value",
      identity: {
        site: identity.site,
        user: identity.user,
        employee: identity.employee,
        roles: identity.roles,
      },
    },
    registry: {
      "frappe-federated-bridge__frappe_fast_route": async () => ({
        intent: "record_lookup",
        answerPath: "live_frappe",
        candidateDoctypes: ["Leave Application"],
        requiredChecks: ["live_frappe_permission_preflight"],
        reason: "Fresh records required.",
      }),
      "frappe-federated-bridge__frappe_semantic_data_resolve_lite": async (args) => {
        liveArgs = args;
        return { doctype: "Leave Application", rows: [{ name: "LEAVE-0001", modified: "2026-07-13" }], count: 1 };
      },
    },
  });

  assert.equal(result.source, "live_frappe");
  assert.match(result.context ?? "", /LEAVE-0001/);
  assert.match(result.context ?? "", /\/app\/leave-application\/LEAVE-0001/);
  assert.doesNotMatch(result.context ?? "", /oauth-secret-value/);
  assert.equal(liveArgs?.apiToken, "oauth-secret-value");
  assert.equal(liveArgs?.user, identity.user);
  assert.equal(liveArgs?.prompt, "Show my pending leave requests");
  assert.equal(liveArgs?.fields, undefined, "the pack must derive a bounded projection from current effective metadata");
  assert.deepEqual(liveArgs?.scope, { mode: "self", user: identity.user, employee: identity.employee });
  assert.equal(liveArgs?.filters, undefined, "the read service owns metadata-aware field filtering");

  const reply = frappeEvidenceQuickReply(result);
  assert.ok(reply?.presentation, "a simple live lookup should render without a provider turn");
  assert.match(reply.text, /1 matching item/i);
  assert.match(reply.text, /LEAVE-0001/);
  const telegram = surfaceReplyToTelegramSend(reply, "42");
  assert.match(telegram.text, /https:\/\/erp\.example\.test\/app\/leave-application\/LEAVE-0001/);
  assert.doesNotMatch(reply.text, /doctype|oauth-secret-value/i);
});

test("configured business API columns render as native Telegram fields", async () => {
  const result = await frappePermissionContextForTurn({
    prompt: "meri chutti kitni bachi hai?",
    surfaceId: "telegram:oxygenhr",
    identity,
    authorization: {
      connectionId: "oxygenhr",
      site: identity.site,
      header: "Bearer oauth-secret-value",
      identity: { site: identity.site, user: identity.user, employee: identity.employee, roles: identity.roles },
    },
    registry: {
      "frappe-federated-bridge__frappe_fast_route": async () => ({
        intent: "record_lookup",
        candidateDoctypes: ["Leave Application"],
      }),
      "frappe-federated-bridge__frappe_semantic_data_resolve_lite": async () => ({
        doctype: "Leave balance",
        rows: [{ title: "Bereavement Leave", available: 3, entitled: 3, used: 0 }],
        count: 1,
        scope: { mode: "self", authority: "frappe_permissions", api: "leave_balance" },
        view: {
          title: "Your leave balance",
          summary: "Here is the leave currently available to you.",
          columns: [
            { field: "title", label: "Leave type" },
            { field: "available", label: "Available" },
            { field: "entitled", label: "Entitled" },
            { field: "used", label: "Used" },
          ],
        },
      }),
    },
  });

  const reply = frappeEvidenceQuickReply(result);
  assert.ok(reply);
  const telegram = surfaceReplyToTelegramSend(reply, "42");
  assert.match(telegram.text, /1\. <b>Leave type<\/b>: Bereavement Leave/);
  assert.match(telegram.text, /<b>Available<\/b>: 3/);
  assert.match(telegram.text, /<b>Entitled<\/b>: 3/);
  assert.match(telegram.text, /<b>Used<\/b>: 0/);
  assert.doesNotMatch(telegram.text, /<b>Item<\/b>|[\u2500-\u257f]/);
  assert.doesNotMatch(telegram.text, /Notice|permission-filtered|Nothing was created or changed/i);
});

test("analytical questions keep live rows as provider evidence instead of returning a shallow list", async () => {
  const result = await frappePermissionContextForTurn({
    prompt: "Analyze why my open work is overdue and summarize the blockers",
    surfaceId: "telegram:oxygenhr",
    identity,
    authorization: {
      connectionId: "oxygenhr",
      site: identity.site,
      header: "Bearer oauth-secret-value",
      identity: { site: identity.site, user: identity.user, employee: identity.employee, roles: identity.roles },
    },
    registry: {
      "frappe-federated-bridge__frappe_fast_route": async () => ({
        intent: "record_lookup",
        candidateDoctypes: ["Task"],
      }),
      "frappe-federated-bridge__frappe_semantic_data_resolve_lite": async () => ({
        doctype: "Task",
        rows: [{ name: "WORK-1", subject: "Complete review", status: "Open" }],
        count: 1,
      }),
    },
  });

  assert.equal(result.evidenceState, "verified_matches");
  assert.equal(result.directReply, false);
  assert.equal(frappeEvidenceQuickReply(result), undefined);
  assert.match(result.context ?? "", /Complete review/);
});

test("read-only workflow reviews use live effective requirements without a provider turn", async () => {
  const result = await frappePermissionContextForTurn({
    prompt: "Review my connected workflow requirements before preparing this request. Do not create or submit anything.",
    surfaceId: "telegram:oxygenhr",
    identity,
    authorization: {
      connectionId: "oxygenhr",
      site: identity.site,
      header: "Bearer oauth-secret-value",
      identity: { site: identity.site, user: identity.user, employee: identity.employee, roles: identity.roles },
    },
    registry: {
      "frappe-federated-bridge__frappe_fast_route": async () => ({
        intent: "record_lookup",
        candidateDoctypes: ["Custom Request"],
      }),
      "frappe-federated-bridge__frappe_chat_interaction_plan": async () => ({
        kind: "guided_crud",
        title: "Before I prepare this request",
        message: "I checked the current requirements.",
        requiredFields: [{ fieldname: "custom_business_reason", label: "Business reason", reason: "Required by the current form." }],
        permission: { allowed: true, reason: "Current user can create this request." },
      }),
      "frappe-federated-bridge__frappe_semantic_data_resolve_lite": async () => ({
        doctype: "Custom Request",
        rows: [],
        count: 0,
      }),
    },
  });

  const reply = frappeEvidenceQuickReply(result);
  assert.equal(result.interactionReview, true);
  assert.equal(reply?.presentation?.kind, "form");
  assert.match(reply?.text ?? "", /Business reason/);
  assert.doesNotMatch(reply?.text ?? "", /Nothing was created, saved, submitted, approved, or changed/);
  assert.doesNotMatch(reply?.text ?? "", /custom_business_reason|oauth-secret-value/);
});

test("write requests carry current business requirements without leaking field names or OAuth tokens", async () => {
  let planArgs: Record<string, unknown> | undefined;
  const result = await frappePermissionContextForTurn({
    prompt: "Help me request leave next week",
    surfaceId: "telegram:oxygenhr",
    identity,
    authorization: {
      connectionId: "oxygenhr",
      site: identity.site,
      header: "Bearer oauth-secret-value",
      identity: { site: identity.site, user: identity.user, employee: identity.employee, roles: identity.roles },
    },
    registry: {
      "frappe-federated-bridge__frappe_fast_route": async () => ({
        intent: "record_create",
        answerPath: "live_frappe",
        candidateDoctypes: ["Leave Application"],
        requiredChecks: ["live_permission_preflight", "preview_before_write"],
      }),
      "frappe-federated-bridge__frappe_chat_interaction_plan": async (args) => {
        planArgs = args;
        return {
          kind: "guided_crud",
          message: "I will ask only for what is still needed.",
          requiredFields: [{ fieldname: "custom_handover_note", label: "Handover note", reason: "Required before this request can be saved." }],
          next: [{ label: "Provide the handover note", detail: "Who should cover urgent work?" }],
        };
      },
    },
  });

  assert.equal(planArgs?.apiToken, "oauth-secret-value");
  assert.equal(planArgs?.doctype, "Leave Application");
  assert.deepEqual((planArgs?.values as Record<string, unknown>)?.employee, identity.employee);
  assert.match(result.context ?? "", /Handover note/);
  assert.doesNotMatch(result.context ?? "", /custom_handover_note|oauth-secret-value/);
  assert.match(result.context ?? "", /one step at a time/i);
});

test("natural create prompts bind an obvious subject and description before asking for remaining live fields", async () => {
  const result = await frappePermissionContextForTurn({
    prompt: "Create a helpdesk ticket about my laptop not working.",
    surfaceId: "telegram:oxygenhr",
    identity,
    authorization: {
      connectionId: "oxygenhr",
      site: identity.site,
      header: "Bearer oauth-secret-value",
      identity: { site: identity.site, user: identity.user, employee: identity.employee, roles: identity.roles },
    },
    registry: {
      "frappe-federated-bridge__frappe_fast_route": async () => ({
        intent: "record_create",
        candidateDoctypes: ["HD Ticket"],
      }),
      "frappe-federated-bridge__frappe_chat_interaction_plan": async () => ({
        kind: "guided_crud",
        doctype: "HD Ticket",
        operation: "create",
        requiredFields: [
          { fieldname: "subject", label: "Subject", reason: "Required by the current form." },
          { fieldname: "description", label: "Description", reason: "Required by the current form." },
          { fieldname: "category", label: "Category", reason: "Required by the current form.", options: ["IT", "HR"] },
        ],
      }),
    },
  });

  assert.equal(result.pendingInteraction?.values.subject, "my laptop not working");
  assert.equal(result.pendingInteraction?.values.description, "my laptop not working");
  assert.deepEqual(result.pendingInteraction?.requiredFields.map((field) => field.label), ["Category"]);
  assert.doesNotMatch(frappeEvidenceQuickReply(result)?.text ?? "", /what should the subject be/i);
});
