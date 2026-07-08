import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { defaultConfig, loadCapabilityPack, parseFlow, runFlow } from "../src/index.js";
import type { FlowToolRegistry } from "../src/index.js";
import {
  frappe_chat_interaction_plan,
  frappe_fast_route,
  frappe_identity_resolve,
  frappe_read_model_plan,
  frappe_user_identity_resolve,
  frappe_records_create,
  frappe_semantic_data_resolve_lite,
  tools as frappeTools,
  type FrappeToolContext,
} from "../../../capability-packs/frappe/src/index.js";

const packDir = resolve(import.meta.dirname, "..", "..", "..", "capability-packs", "frappe");

interface RecordedRequest {
  method: string;
  url: string;
  authorization?: string;
  body: string;
}

type FrappePackTool = (args: Record<string, unknown>, context: FrappeToolContext) => Promise<unknown>;

function frappeTool(name: string): FrappePackTool {
  const tool = (frappeTools as Record<string, FrappePackTool | undefined>)[name];
  assert.equal(typeof tool, "function", `${name} should be implemented by the Frappe pack`);
  return tool;
}

/** Stub Frappe site: logged-user endpoint, resource list, resource create, and a 403 PermissionError doctype. */
function startFrappeStub(): Promise<{ url: string; requests: RecordedRequest[]; close: () => void }> {
  const requests: RecordedRequest[] = [];
  return new Promise((resolvePromise) => {
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        requests.push({ method: request.method ?? "", url: request.url ?? "", authorization: request.headers.authorization, body });
        const respond = (status: number, payload: unknown) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(payload));
        };
        const url = request.url ?? "";
        if (!request.headers.authorization) {
          return respond(401, { exc_type: "AuthenticationError", exception: "frappe.exceptions.AuthenticationError: Invalid token" });
        }
        if (url.startsWith("/api/method/frappe.auth.get_logged_user")) {
          return respond(200, { message: "dhairya@hybrowlabs.com" });
        }
        if (url.startsWith("/api/method/frappe.core.doctype.user.user.get_roles")) {
          return respond(200, { message: ["Employee", "HR User"] });
        }
        if (url.startsWith("/api/resource/Employee")) {
          return respond(200, { data: [{
            name: "EMP-0001",
            employee_name: "Dhairya Marwaha",
            department: "People",
            company: "HyBrowLabs",
            designation: "Founder",
            status: "Active",
          }] });
        }
        if (url.startsWith("/api/method/frappe.utils.change_log.get_versions")) {
          return respond(200, { message: { frappe: { version: "15.42.0" }, erpnext: { version: "15.38.1" }, hrms: { version: "16.0.0" } } });
        }
        if (url.startsWith("/api/method/frappe.desk.desktop.get_workspace_sidebar_items")) {
          return respond(200, { message: { pages: [{ title: "HR" }, { title: "Payroll" }] } });
        }
        if (url.startsWith("/api/method/frappe.client.has_permission")) {
          const parsed = new URL(`http://frappe.test${url}`);
          const doctype = parsed.searchParams.get("doctype");
          const ptype = parsed.searchParams.get("ptype") ?? parsed.searchParams.get("perm_type") ?? "read";
          const allowed = doctype === "Leave Application" && ["create", "write", "read"].includes(ptype);
          return respond(200, { message: allowed });
        }
        if (url.startsWith("/api/resource/Salary%20Slip")) {
          // exact Frappe PermissionError shape, passed through verbatim
          return respond(403, {
            exc_type: "PermissionError",
            exception: "frappe.exceptions.PermissionError: User dhairya@hybrowlabs.com does not have doctype access via role permission for document Salary Slip",
            _server_messages: JSON.stringify([JSON.stringify({ message: "Insufficient Permission for Salary Slip" })]),
          });
        }
        if (url.startsWith("/api/resource/HD%20Ticket") && request.method === "GET") {
          return respond(200, { data: [{ name: "T-1", status: "Open" }, { name: "T-2", status: "Open" }] });
        }
        if (url.startsWith("/api/resource/DocType/Leave%20Application")) {
          return respond(200, { data: leaveApplicationDoctype() });
        }
        if (url.startsWith("/api/resource/DocType/Salary%20Slip")) {
          return respond(200, { data: salarySlipDoctype() });
        }
        if (url.startsWith("/api/resource/DocType") && request.method === "GET") {
          return respond(200, { data: [
            { name: "Leave Application", module: "HR", custom: 0, istable: 0 },
            { name: "Salary Slip", module: "Payroll", custom: 0, istable: 0 },
            { name: "Leave Application Detail", module: "HR", custom: 1, istable: 1 },
          ] });
        }
        if (url.startsWith("/api/resource/Custom%20Field")) {
          return respond(200, { data: [{ name: "Leave Application-custom_manager_note", dt: "Leave Application", fieldname: "custom_manager_note", fieldtype: "Small Text", label: "Manager Note" }] });
        }
        if (url.startsWith("/api/resource/Property%20Setter")) {
          return respond(200, { data: [{ name: "Leave Application-leave_reason-reqd", doc_type: "Leave Application", field_name: "leave_reason", property: "reqd", value: "1" }] });
        }
        if (url.startsWith("/api/resource/Workflow")) {
          return respond(200, { data: [{
            name: "Leave Approval",
            document_type: "Leave Application",
            is_active: 1,
            states: [{ state: "Open", allow_edit: "Employee" }, { state: "Approved", allow_edit: "HR Manager" }],
            transitions: [{ state: "Open", action: "Submit", next_state: "Pending Approval", allowed: "Employee" }, { state: "Pending Approval", action: "Approve", next_state: "Approved", allowed: "HR Manager" }],
          }] });
        }
        if (url.startsWith("/api/resource/Report")) {
          return respond(200, { data: [{ name: "Leave Balance", ref_doctype: "Leave Application", report_type: "Script Report", module: "HR" }] });
        }
        if (url.startsWith("/api/resource/Print%20Format")) {
          return respond(200, { data: [{ name: "Leave Application Print", doc_type: "Leave Application", module: "HR" }] });
        }
        if (url.startsWith("/api/resource/Dashboard")) {
          return respond(200, { data: [{ name: "HR Dashboard", module: "HR" }] });
        }
        if (url.startsWith("/api/resource/Client%20Script")) {
          return respond(200, { data: [{ name: "Leave Application Client", dt: "Leave Application", enabled: 1 }] });
        }
        if (url.startsWith("/api/resource/Server%20Script")) {
          return respond(200, { data: [{ name: "Leave Validation", reference_doctype: "Leave Application", script_type: "DocType Event", disabled: 0 }] });
        }
        if (url.startsWith("/api/resource/Web%20Form")) {
          return respond(200, { data: [{ name: "leave-application", doc_type: "Leave Application", module: "HR" }] });
        }
        if (url.startsWith("/api/resource/Notification")) {
          return respond(200, { data: [{ name: "Leave Approval Notification", document_type: "Leave Application", enabled: 1 }] });
        }
        if (url.startsWith("/api/resource/Assignment%20Rule")) {
          return respond(200, { data: [{ name: "Leave Assignment", document_type: "Leave Application", disabled: 0 }] });
        }
        if (url.startsWith("/api/resource/Role")) {
          return respond(200, { data: [{ name: "Employee" }, { name: "HR Manager" }] });
        }
        if (url.startsWith("/api/resource/Leave%20Application/HR-LAP-0001") && request.method === "GET") {
          return respond(200, { data: { name: "HR-LAP-0001", doctype: "Leave Application", employee: "EMP-0001", leave_type: "Annual Leave" } });
        }
        if (url.startsWith("/api/resource/Leave%20Application") && request.method === "POST") {
          const doc = JSON.parse(body) as Record<string, unknown>;
          return respond(200, { data: { name: "HR-LAP-0001", doctype: "Leave Application", ...doc } });
        }
        if (url.startsWith("/api/resource/ToDo") && request.method === "POST") {
          const doc = JSON.parse(body) as Record<string, unknown>;
          return respond(200, { data: { name: "TODO-0001", doctype: "ToDo", ...doc } });
        }
        return respond(404, { exc_type: "DoesNotExistError", exception: `frappe.exceptions.DoesNotExistError: ${url}` });
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolvePromise({ url: `http://127.0.0.1:${port}`, requests, close: () => server.close() });
    });
  });
}

function leaveApplicationDoctype(): Record<string, unknown> {
  return {
    name: "Leave Application",
    module: "HR",
    custom: 0,
    istable: 0,
    autoname: "HR-LAP-.YYYY.-.#####",
    fields: [
      { fieldname: "naming_series", label: "Series", fieldtype: "Select", options: "HR-LAP-.YYYY.-.#####\nHR-SICK-.YYYY.-.#####" },
      { fieldname: "employee", label: "Employee", fieldtype: "Link", options: "Employee", reqd: 1 },
      { fieldname: "leave_type", label: "Leave Type", fieldtype: "Link", options: "Leave Type", reqd: 1 },
      { fieldname: "leave_reason", label: "Leave Reason", fieldtype: "Small Text" },
      { fieldname: "details", label: "Details", fieldtype: "Table", options: "Leave Application Detail" },
    ],
    permissions: [
      { role: "Employee", read: 1, create: 1, write: 1, submit: 0 },
      { role: "HR Manager", read: 1, create: 1, write: 1, submit: 1 },
    ],
  };
}

function salarySlipDoctype(): Record<string, unknown> {
  return {
    name: "Salary Slip",
    module: "Payroll",
    custom: 0,
    istable: 0,
    autoname: "Salary Slip-.YYYY.-.#####",
    fields: [
      { fieldname: "employee", label: "Employee", fieldtype: "Link", options: "Employee" },
      { fieldname: "earnings", label: "Earnings", fieldtype: "Table", options: "Salary Detail" },
      { fieldname: "deductions", label: "Deductions", fieldtype: "Table", options: "Salary Detail" },
    ],
    permissions: [
      { role: "Employee", read: 0, create: 0, write: 0 },
      { role: "HR Manager", read: 1, create: 1, write: 1 },
    ],
  };
}

function contextFor(siteUrl: string, token = "api-key:api-secret"): FrappeToolContext {
  return Object.freeze({
    fetch: globalThis.fetch.bind(globalThis),
    config: Object.freeze({ FRAPPE_SITE_URL: siteUrl, FRAPPE_API_TOKEN: token }),
  });
}

test("frappe_identity_resolve returns the logged user with token auth", async () => {
  const site = await startFrappeStub();
  try {
    const result = await frappe_identity_resolve({}, contextFor(site.url));
    assert.deepEqual(result, { user: "dhairya@hybrowlabs.com", site: site.url });
    assert.equal(site.requests[0].authorization, "token api-key:api-secret", "key:secret tokens use Frappe token auth");

    await frappe_identity_resolve({}, contextFor(site.url, "bare-oauth-token"));
    assert.equal(site.requests[1].authorization, "Bearer bare-oauth-token", "bare tokens use Bearer auth");
  } finally {
    site.close();
  }
});

test("frappe_user_identity_resolve proves OAuth/API identity and maps Employee plus roles", async () => {
  const site = await startFrappeStub();
  try {
    const result = await frappe_user_identity_resolve({}, {
      fetch,
      config: { FRAPPE_SITE_URL: site.url, FRAPPE_API_TOKEN: "oauth-access-token" },
    });
    assert.equal("error" in result, false);
    if ("error" in result) return;
    assert.equal(result.authMode, "oauth_bearer");
    assert.equal(result.user, "dhairya@hybrowlabs.com");
    assert.equal(result.employee?.name, "EMP-0001");
    assert.equal(result.employee?.department, "People");
    assert.deepEqual(result.roles, ["Employee", "HR User"]);
    assert.equal(result.permissionScope.employee, "EMP-0001");
    assert.match(result.permissionScope.permissionHash, /^[0-9a-f]{16}$/);
    assert.deepEqual(result.pairing.recommendedScopeIds, [
      "frappe-user:dhairya@hybrowlabs.com",
      "frappe-employee:EMP-0001",
      "frappe-role:Employee",
      "frappe-role:HR User",
    ]);
    assert.doesNotMatch(JSON.stringify(result), /oauth-access-token/);
    assert.equal(site.requests.some((request) => request.authorization === "Bearer oauth-access-token"), true);
  } finally {
    site.close();
  }
});

test("frappe_fast_route keeps greetings off the provider path", async () => {
  const result = await frappe_fast_route(
    { prompt: "hi", site: "https://uat-erp.pwhr.in", user: "pradip.irkar@pw.live", hasFreshIndex: true },
    contextFor("http://127.0.0.1:9"),
  );
  assert.equal("error" in result, false);
  if ("error" in result) return;
  assert.equal(result.intent, "greeting");
  assert.equal(result.answerPath, "deterministic");
  assert.equal(result.invokeProvider, false);
  assert.equal(result.showProgress, false);
  assert.equal(result.targetLatencyMs <= 250, true);
});

test("frappe_fast_route maps department language to Frappe actions without hardcoded answers", async () => {
  const result = await frappe_fast_route(
    {
      prompt: "Put in a cab reimbursement claim for yesterday for 850 rupees",
      site: "https://uat-erp.pwhr.in",
      user: "employee@example.test",
      roles: ["Employee"],
      department: "Finance",
      hasFreshIndex: true,
      hasLiveCredentials: true,
    },
    contextFor("http://127.0.0.1:9"),
  );
  assert.equal("error" in result, false);
  if ("error" in result) return;
  assert.equal(result.intent, "record_create");
  assert.equal(result.invokeProvider, false);
  assert.equal(result.answerPath, "live_frappe");
  assert.deepEqual(result.candidateDoctypes, ["Expense Claim"]);
  assert.match(result.requiredChecks.join(","), /write_preflight/);
  assert.equal(result.targetLatencyMs <= 3000, true);
});

test("frappe_read_model_plan defines Postgres-backed operational indexes and cron", async () => {
  const plan = await frappe_read_model_plan({ site: "https://uat-erp.pwhr.in" }, contextFor("http://127.0.0.1:9"));
  assert.equal(plan.goal, "sub_3s_permission_backed_operational_answers");
  assert.equal(plan.latencyBudgetMs.providerTinyContext, 3000);
  assert.equal(plan.stores.some((store) => store.id === "operational_data_index"), true);
  assert.equal(plan.stores.some((store) => store.id === "semantic_business_index"), true);
  assert.equal(plan.stores.some((store) => store.examples.some((example) => example.includes("installed apps"))), true);
  assert.equal(plan.cron.some((job) => job.id === "frappe_operational_hot_sync"), true);
  assert.equal(plan.cron.some((job) => job.target.includes("whitelisted methods")), true);
  assert.equal(plan.postgres.ddl.some((sql) => sql.includes("muster_frappe.operational_fact")), true);
  assert.equal(plan.postgres.indexes.some((sql) => sql.includes("using gin")), true);
  assert.match(plan.safetyInvariants.join("\n"), /Every candidate record is filtered by current Frappe permission/);
});

test("frappe_fast_route treats custom apps like NextAI as available Frappe surfaces, not product boundaries", async () => {
  const result = await frappe_fast_route(
    {
      prompt: "Ask NextAI to summarize the payroll exception pattern",
      site: "https://erp.example.test",
      user: "ops@example.test",
      roles: ["System Manager"],
      installedApps: ["erpnext", "nextai", "oxygenhr"],
      heavyLifterApps: ["nextai"],
      hasFreshIndex: true,
      hasLiveCredentials: true,
    },
    contextFor("http://127.0.0.1:9"),
  );
  assert.equal("error" in result, false);
  if ("error" in result) return;
  assert.equal(result.invokeProvider, false);
  assert.deepEqual(result.minimalContext.installedApps, ["erpnext", "nextai", "oxygenhr"]);
  assert.deepEqual(result.minimalContext.heavyLifterApps, ["nextai"]);
  assert.match(JSON.stringify(result.minimalContext.matchedAliases), /NextAI/);
});

test("frappe_semantic_data_resolve_lite lists resources with fields/filters/limit", async () => {
  const site = await startFrappeStub();
  try {
    const result = await frappe_semantic_data_resolve_lite(
      { doctype: "HD Ticket", fields: ["name", "status"], filters: { status: "Open" }, limit: 5 },
      contextFor(site.url),
    );
    assert.deepEqual(result, {
      doctype: "HD Ticket",
      rows: [{ name: "T-1", status: "Open" }, { name: "T-2", status: "Open" }],
      count: 2,
    });
    const url = site.requests[0].url;
    assert.match(url, /fields=%5B%22name%22%2C%22status%22%5D/, "fields are JSON-encoded query params");
    assert.match(url, /filters=/);
    assert.match(url, /limit_page_length=5/);

    const noDoctype = await frappe_semantic_data_resolve_lite({}, contextFor(site.url));
    assert.match((noDoctype as { error: string }).error, /requires a "doctype"/);
  } finally {
    site.close();
  }
});

test("frappe_records_create posts the doc and returns the created document", async () => {
  const site = await startFrappeStub();
  try {
    const result = await frappe_records_create(
      { doctype: "ToDo", doc: { description: "Follow up on T-1", priority: "High" }, trustedFixture: true },
      contextFor(site.url),
    );
    assert.deepEqual(result, {
      created: { name: "TODO-0001", doctype: "ToDo", description: "Follow up on T-1", priority: "High" },
    });
    assert.equal(site.requests[0].method, "POST");
    assert.deepEqual(JSON.parse(site.requests[0].body), { description: "Follow up on T-1", priority: "High" });
  } finally {
    site.close();
  }
});

test("frappe_records_create refuses ungated writes outside an explicit trusted fixture", async () => {
  const site = await startFrappeStub();
  try {
    const result = await frappe_records_create(
      { doctype: "ToDo", doc: { description: "Follow up on T-1" } },
      contextFor(site.url),
    );
    assert.match((result as { error: string }).error, /requires approval/);
    assert.ok(!site.requests.some((request) => request.method === "POST" && request.url.startsWith("/api/resource/ToDo")));
  } finally {
    site.close();
  }
});

test("a 403 PermissionError passes through with the exact Frappe message, never swallowed", async () => {
  const site = await startFrappeStub();
  try {
    const result = await frappe_semantic_data_resolve_lite({ doctype: "Salary Slip" }, contextFor(site.url));
    assert.equal((result as { status: number }).status, 403);
    assert.equal((result as { excType: string }).excType, "PermissionError");
    assert.match(
      (result as { error: string }).error,
      /frappe\.exceptions\.PermissionError: User dhairya@hybrowlabs\.com does not have doctype access/,
      "the exact Frappe exception string is returned",
    );
  } finally {
    site.close();
  }
});

test("missing config and missing network access produce diagnostic errors", async () => {
  const noSite = await frappe_identity_resolve({}, Object.freeze({ fetch: globalThis.fetch, config: Object.freeze({ FRAPPE_API_TOKEN: "x" }) }));
  assert.match((noSite as { error: string }).error, /FRAPPE_SITE_URL is missing/);

  const noToken = await frappe_identity_resolve({}, Object.freeze({ fetch: globalThis.fetch, config: Object.freeze({ FRAPPE_SITE_URL: "https://x" }) }));
  assert.match((noToken as { error: string }).error, /FRAPPE_API_TOKEN is missing/);

  const noFetch = await frappe_identity_resolve({}, Object.freeze({ config: Object.freeze({ FRAPPE_SITE_URL: "https://x", FRAPPE_API_TOKEN: "y" }) }));
  assert.match((noFetch as { error: string }).error, /no network access/);
});

test("frappe_site_induction indexes site identity, DocType graph, permissions, customizations, and docs", async () => {
  const site = await startFrappeStub();
  try {
    const induction = await frappeTool("frappe_site_induction")(
      { modules: ["HR", "Payroll"], doctypes: ["Leave Application", "Salary Slip"], includeCustomizations: true },
      contextFor(site.url),
    ) as Record<string, unknown>;

    assert.deepEqual(induction.site, {
      url: site.url,
      authMode: "api_token",
      identity: { user: "dhairya@hybrowlabs.com" },
      versions: { frappe: "15.42.0", erpnext: "15.38.1", hrms: "16.0.0" },
      installedApps: ["erpnext", "frappe", "hrms"],
    });
    assert.deepEqual(induction.modules, ["HR", "Payroll"]);
    assert.deepEqual(induction.workspaces, ["HR", "Payroll"]);

    const doctypes = induction.doctypes as Array<Record<string, unknown>>;
    const leave = doctypes.find((doctype) => doctype.name === "Leave Application");
    assert.ok(leave, "Leave Application should be indexed");
    assert.deepEqual(leave?.namingSeries, ["HR-LAP-.YYYY.-.#####", "HR-SICK-.YYYY.-.#####"]);
    assert.deepEqual(leave?.links, [{ fieldname: "employee", target: "Employee" }, { fieldname: "leave_type", target: "Leave Type" }]);
    assert.deepEqual(leave?.childTables, [{ fieldname: "details", target: "Leave Application Detail" }]);
    assert.deepEqual((leave?.permissions as Array<Record<string, unknown>>).map((perm) => perm.role), ["Employee", "HR Manager"]);

    const customizations = induction.customizations as Record<string, unknown[]>;
    assert.equal(customizations.customFields.length, 1);
    assert.equal(customizations.propertySetters.length, 1);
    assert.equal(customizations.clientScripts.length, 1);
    assert.equal(customizations.serverScripts.length, 1);

    assert.ok((induction.graph as { edges: Array<Record<string, unknown>> }).edges.some((edge) => edge.type === "doctype_link" && edge.to === "Employee"));
    assert.ok((induction.docs as Array<Record<string, unknown>>).some((doc) => String(doc.url).includes("frappeframework.com/docs")));
    assert.deepEqual(induction.warnings, []);
  } finally {
    site.close();
  }
});

test("frappe_query_classify covers required Frappe query classes with class-specific retrieval strategies", async () => {
  const classify = frappeTool("frappe_query_classify");
  const cases: Array<[string, string]> = [
    ["Explain the schema for Leave Application", "schema"],
    ["Which field stores the leave type?", "field"],
    ["Can an Employee role read Salary Slip?", "permission"],
    ["What workflow transitions can HR Manager approve?", "workflow"],
    ["Which report shows leave balance?", "report"],
    ["Show custom fields and property setters for Leave Application", "customization"],
    ["Which installed apps are present on this site?", "installed_app"],
    ["Find Frappe docs for workflows", "docs"],
    ["Look up open Leave Application records", "record_lookup"],
    ["Create a safe draft Leave Application", "record_creation"],
    ["Update the leave reason on HR-LAP-0001", "record_update"],
    ["Generate a PDF module summary for HR", "artifact_generation"],
    ["Why can't this user save the document?", "troubleshooting"],
    ["What is the migration impact of the custom_app upgrade?", "migration_custom_app_impact"],
    ["Write a role-safe management summary for payroll", "role_safe_management_summary"],
  ];

  const strategies = new Set<string>();
  for (const [prompt, expectedClass] of cases) {
    const result = await classify({ prompt }, { config: {} }) as Record<string, unknown>;
    assert.equal(result.primaryClass, expectedClass, prompt);
    assert.ok(Array.isArray(result.retrievalStrategy), `${expectedClass} should declare a retrieval strategy`);
    strategies.add((result.retrievalStrategy as string[]).join(" > "));
  }
  assert.ok(strategies.size > 8, "query classes should not collapse to one generic REST/docs strategy");
});

test("frappe_hybrid_retrieve builds a compact permission-filtered context packet and recalls memory only when useful", async () => {
  const site = await startFrappeStub();
  try {
    const induction = await frappeTool("frappe_site_induction")(
      { modules: ["HR", "Payroll"], doctypes: ["Leave Application", "Salary Slip"] },
      contextFor(site.url),
    ) as Record<string, unknown>;
    const retrieve = frappeTool("frappe_hybrid_retrieve");

    const salaryPacket = await retrieve(
      { prompt: "Explain fields and permissions for Salary Slip", induction, roles: ["Employee"] },
      contextFor(site.url),
    ) as Record<string, unknown>;
    assert.equal(salaryPacket.intent, "permission");
    assert.deepEqual(salaryPacket.candidateDocTypes, []);
    assert.deepEqual(salaryPacket.blockedPermissions, [{ doctype: "Salary Slip", permission: "read", roles: ["Employee"] }]);
    assert.equal((salaryPacket.memory as Record<string, unknown>).searched, false);

    const workflowPacket = await retrieve(
      { prompt: "Remember my previous leave approval issue and show workflow transitions for Leave Application", induction, roles: ["Employee"], memory: [{ scope: "user:dhairya@hybrowlabs.com", text: "Prefers concise HR answers" }] },
      contextFor(site.url),
    ) as Record<string, unknown>;
    assert.equal(workflowPacket.intent, "workflow");
    assert.deepEqual(workflowPacket.candidateDocTypes, ["Leave Application"]);
    assert.ok((workflowPacket.relevantWorkflows as unknown[]).length > 0);
    assert.equal((workflowPacket.memory as Record<string, unknown>).searched, true);
    assert.deepEqual((workflowPacket.memory as Record<string, unknown>).scopes, ["user:dhairya@hybrowlabs.com"]);
  } finally {
    site.close();
  }
});

test("frappe_permission_check supports fixture role allow and deny decisions", async () => {
  const induction = {
    site: { url: "https://erp.example.test", identity: { user: "employee@example.test" } },
    doctypes: [leaveApplicationDoctype(), salarySlipDoctype()],
  };
  const check = frappeTool("frappe_permission_check");

  assert.deepEqual(await check({ induction, doctype: "Leave Application", permission: "create", roles: ["Employee"] }, { config: {} }), {
    doctype: "Leave Application",
    permission: "create",
    allowed: true,
    matchedRoles: ["Employee"],
    deniedRoles: [],
    source: "fixture",
  });
  assert.deepEqual(await check({ induction, doctype: "Salary Slip", permission: "read", roles: ["Employee"] }, { config: {} }), {
    doctype: "Salary Slip",
    permission: "read",
    allowed: false,
    matchedRoles: [],
    deniedRoles: ["Employee"],
    source: "fixture",
  });
});

test("frappe_safe_write gates creates with permission preflight, dry-run proposal, approval, execution, verification, and evidence", async () => {
  const site = await startFrappeStub();
  try {
    const safeWrite = frappeTool("frappe_safe_write");

    const proposal = await safeWrite(
      { operation: "create", doctype: "Leave Application", doc: { employee: "EMP-0001", leave_type: "Annual Leave" } },
      contextFor(site.url),
    ) as Record<string, unknown>;
    assert.equal(proposal.status, "approval_required");
    assert.equal((proposal.preflight as Record<string, unknown>).allowed, true);
    assert.deepEqual((proposal.proposedMutation as Record<string, unknown>).fields, ["employee", "leave_type"]);
    assert.ok(!site.requests.some((request) => request.method === "POST" && request.url.startsWith("/api/resource/Leave%20Application")), "dry-run must not create a record");

    const denied = await safeWrite(
      { operation: "create", doctype: "Salary Slip", doc: { employee: "EMP-0001" }, approved: true },
      contextFor(site.url),
    ) as Record<string, unknown>;
    assert.equal(denied.status, "denied");
    assert.match(String((denied.preflight as Record<string, unknown>).reason), /Frappe denied create/);

    const approved = await safeWrite(
      { operation: "create", doctype: "Leave Application", doc: { employee: "EMP-0001", leave_type: "Annual Leave" }, approved: true, approvalNote: "Approved by fixture test" },
      contextFor(site.url),
    ) as Record<string, unknown>;
    assert.equal(approved.status, "executed");
    assert.deepEqual((approved.result as Record<string, unknown>).created, { name: "HR-LAP-0001", doctype: "Leave Application", employee: "EMP-0001", leave_type: "Annual Leave" });
    assert.equal((approved.verification as Record<string, unknown>).verified, true);
    assert.ok((approved.evidenceLog as string[]).includes("permission_preflight:allowed"));
    assert.ok((approved.evidenceLog as string[]).includes("verify_result:ok"));
  } finally {
    site.close();
  }
});

test("frappe_artifact_brief emits fixture/live metadata linking site, user, DocTypes, permission scope, prompt, and output", async () => {
  const artifact = await frappeTool("frappe_artifact_brief")({
    mode: "fixture",
    artifactType: "permission_audit",
    format: "markdown",
    site: "https://erp.example.test",
    user: "hr.manager@example.test",
    prompt: "Generate a permission audit for Leave Application",
    doctypes: ["Leave Application"],
    permissionScope: { roles: ["HR Manager"], permissions: ["read", "write"] },
    dataQuery: { source: "fixture", filters: [["module", "=", "HR"]] },
    output: "HR Manager can read and write Leave Application records.",
    generatedAt: "2026-07-03T00:00:00.000Z",
  }, { config: {} }) as Record<string, unknown>;

  assert.equal(artifact.title, "Frappe permission audit");
  assert.equal(artifact.mimeType, "text/markdown");
  assert.deepEqual(artifact.metadata, {
    site: "https://erp.example.test",
    user: "hr.manager@example.test",
    doctypes: ["Leave Application"],
    permissionScope: { roles: ["HR Manager"], permissions: ["read", "write"] },
    prompt: "Generate a permission audit for Leave Application",
    dataQuery: { source: "fixture", filters: [["module", "=", "HR"]] },
    mode: "fixture",
    generatedAt: "2026-07-03T00:00:00.000Z",
  });
  assert.match(String(artifact.content), /HR Manager can read and write Leave Application/);
});

test("frappe_chat_interaction_plan asks humane missing-field questions for leave CRUD", async () => {
  const plan = await frappe_chat_interaction_plan({
    prompt: "I want to apply leave for 9th",
    siteUrl: "https://erp.example.test",
    values: { from_date: "2026-07-09", to_date: "2026-07-09" },
    leaveTypes: ["Casual Leave", "Sick Leave"],
  }, { config: {} });

  assert.equal(plan.kind, "guided_crud");
  assert.equal(plan.doctype, "Leave Application");
  assert.equal(plan.operation, "create");
  assert.match(plan.message, /To move forward with your request/);
  assert.deepEqual(plan.requiredFields.map((field) => field.fieldname), ["leave_type", "description"]);
  assert.deepEqual(plan.requiredFields[0].options, ["Casual Leave", "Sick Leave"]);
  assert.equal(plan.safety.previewBeforeWrite, true);
  assert.equal(plan.renderHints.phone, "native_buttons_when_available");
});

test("frappe_chat_interaction_plan respects metadata and property-setter mandatory fields", async () => {
  const plan = await frappe_chat_interaction_plan({
    prompt: "create a leave request",
    doctype: "Leave Application",
    values: { leave_type: "Casual Leave", from_date: "2026-07-09", to_date: "2026-07-09", description: "Personal work" },
    fields: [{ fieldname: "employee", label: "Employee", reqd: 1 }],
    propertySetters: [{ field_name: "backup_person", property: "reqd", value: "1" }],
  }, { config: {} });

  assert.equal(plan.kind, "guided_crud");
  assert.deepEqual(plan.requiredFields.map((field) => field.fieldname), ["employee", "backup_person"]);
  assert.match(plan.requiredFields[1].reason, /Property Setter/);
});

test("frappe_chat_interaction_plan attaches Frappe document links and report next steps", async () => {
  const plan = await frappe_chat_interaction_plan({
    prompt: "show pending leaves for my team",
    siteUrl: "https://erp.example.test",
    documents: [{ doctype: "Leave Application", name: "HR-LAP-0001" }],
    table: { columns: ["Employee", "Status"], rows: [["Amit Sharma", "Pending"]] },
  }, { config: {} });

  assert.equal(plan.kind, "table_result");
  assert.equal(plan.documentLinks[0].url, "https://erp.example.test/app/leave-application/HR-LAP-0001");
  assert.ok(plan.next.some((action) => action.label === "Filter"));
  assert.ok(plan.next.some((action) => action.label === "Export"));
  assert.deepEqual(plan.table?.rows, [["Amit Sharma", "Pending"]]);
});

test("the frappe pack loads through loadCapabilityPack and runs inside a flow", async () => {
  const site = await startFrappeStub();
  try {
    const registry: FlowToolRegistry = {};
    const loaded = await loadCapabilityPack(packDir, {
      registry,
      allowHighRisk: true, // declares secrets -> high risk by design
      env: { FRAPPE_SITE_URL: site.url, FRAPPE_API_TOKEN: "api-key:api-secret" },
    });
    assert.equal(loaded.manifest.id, "frappe-federated-bridge");
    assert.deepEqual(
      [...loaded.toolNames].sort(),
      [
        "frappe-federated-bridge__frappe_artifact_brief",
        "frappe-federated-bridge__frappe_chat_interaction_plan",
        "frappe-federated-bridge__frappe_context_build",
        "frappe-federated-bridge__frappe_context_setup_plan",
        "frappe-federated-bridge__frappe_docs_context",
        "frappe-federated-bridge__frappe_fast_route",
        "frappe-federated-bridge__frappe_hybrid_retrieve",
        "frappe-federated-bridge__frappe_identity_resolve",
        "frappe-federated-bridge__frappe_installed_context",
        "frappe-federated-bridge__frappe_module_context",
        "frappe-federated-bridge__frappe_permission_check",
        "frappe-federated-bridge__frappe_query_classify",
        "frappe-federated-bridge__frappe_read_model_plan",
        "frappe-federated-bridge__frappe_records_create",
        "frappe-federated-bridge__frappe_safe_write",
        "frappe-federated-bridge__frappe_semantic_data_resolve_lite",
        "frappe-federated-bridge__frappe_site_induction",
        "frappe-federated-bridge__frappe_user_identity_resolve",
      ].sort(),
    );

    const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-flow-"));
    const flow = parseFlow({
      id: "frappe-smoke",
      steps: [
        { id: "who", kind: "tool", tool: "frappe-federated-bridge__frappe_identity_resolve" },
        { id: "tickets", kind: "tool", tool: "frappe-federated-bridge__frappe_semantic_data_resolve_lite", args: { doctype: "HD Ticket", limit: 10 } },
        { id: "todo", kind: "tool", tool: "frappe-federated-bridge__frappe_records_create", args: { doctype: "ToDo", doc: { description: "{{who.user}} has {{tickets.count}} open tickets" }, trustedFixture: true } },
      ],
    });
    const result = await runFlow(flow, { config: defaultConfig(), registry, cwd });
    assert.equal(result.status, "completed");
    assert.equal(
      ((result.outputs.todo as { created: { description: string } }).created).description,
      "dhairya@hybrowlabs.com has 2 open tickets",
    );
  } finally {
    site.close();
  }
});
