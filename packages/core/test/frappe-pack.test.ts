import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
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
  computeFrappePermissionEpoch,
  deriveFrappeHierarchyScope,
  FRAPPE_INDEX_KINDS,
  pollFrappeEnterpriseSnapshot,
  resolveFrappeRead,
  signFrappeApproval,
  SqliteFrappeReadModel,
  validateFrappeCustomerProfile,
  tools as frappeTools,
  type FrappeCacheIdentity,
  type FrappeEnterpriseSnapshot,
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

function enterpriseSnapshot(
  site = "https://erp.example.test",
  overrides: Partial<FrappeEnterpriseSnapshot> = {},
): FrappeEnterpriseSnapshot {
  return {
    site,
    observedAt: "2026-07-10T08:00:00.000Z",
    validUntil: "2026-07-10T08:05:00.000Z",
    dataRevision: "data-1",
    apps: [{ name: "frappe", version: "15" }, { name: "customer_ops", version: "1" }],
    modules: [{ name: "Operations" }],
    doctypes: [{
      name: "Service Request",
      module: "Operations",
      modified: "2026-07-10T07:59:00.000Z",
      fields: [
        { fieldname: "subject", label: "Subject", fieldtype: "Data", reqd: 1, idx: 1 },
        { fieldname: "priority", label: "Priority", fieldtype: "Select", options: "Low\nHigh", idx: 2 },
      ],
    }],
    customFields: [{ name: "Service Request-custom_region", dt: "Service Request", fieldname: "custom_region", label: "Region", fieldtype: "Link", options: "Region" }],
    propertySetters: [{ name: "Service Request-subject-reqd", doc_type: "Service Request", field_name: "subject", property: "reqd", value: "1" }],
    workflows: [{ name: "Service Request Approval", document_type: "Service Request", is_active: 1 }],
    reports: [{ name: "Service Request Ageing", ref_doctype: "Service Request", report_type: "Query Report" }],
    printFormats: [{ name: "Service Request Summary", doc_type: "Service Request" }],
    clientScripts: [{ name: "Service Request Client", dt: "Service Request", enabled: 1 }],
    serverScripts: [{ name: "Service Request Validation", reference_doctype: "Service Request", disabled: 0, api_secret: "must-not-persist", script: "token='must-not-persist-either'\nfrappe.msgprint('validated')" }],
    funnels: [{ name: "Request Fulfilment", document_type: "Service Request" }],
    flowConfigs: [{ name: "Request Flow", document_type: "Service Request" }],
    dynamicAssignments: [{ name: "Request Rotation", document_type: "Service Request", assignment_basis: "Round Robin" }],
    ...overrides,
  };
}

function contextFor(siteUrl: string, token = "api-key:api-secret", extra: Record<string, string | undefined> = {}): FrappeToolContext {
  return Object.freeze({
    fetch: globalThis.fetch.bind(globalThis),
    config: Object.freeze({ FRAPPE_SITE_URL: siteUrl, FRAPPE_API_TOKEN: token, ...extra }),
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
    assert.match((result as { error: string }).error, /Direct Frappe create is disabled/);
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
    const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-approval-"));
    const signingKey = "test-only-frappe-approval-key";
    const context = contextFor(site.url, "api-key:api-secret", {
      FRAPPE_APPROVAL_SIGNING_KEY: signingKey,
      FRAPPE_READ_MODEL_PATH: join(cwd, "frappe-read-model.db"),
    });
    const mutation = { operation: "create", doctype: "Leave Application", doc: { employee: "EMP-0001", leave_type: "Annual Leave" } };

    const missingDynamicField = await safeWrite({
      ...mutation,
      fields: [{ fieldname: "backup_person", label: "Backup person", reqd: 1 }],
    }, context) as Record<string, unknown>;
    assert.match(String(missingDynamicField.error), /provide.*Backup person/i);

    const proposal = await safeWrite(
      mutation,
      context,
    ) as Record<string, unknown>;
    assert.equal(proposal.status, "approval_required");
    assert.equal((proposal.preflight as Record<string, unknown>).allowed, true);
    assert.deepEqual((proposal.proposedMutation as Record<string, unknown>).fields, ["employee", "leave_type"]);
    assert.ok(!site.requests.some((request) => request.method === "POST" && request.url.startsWith("/api/resource/Leave%20Application")), "dry-run must not create a record");

    const bareBoolean = await safeWrite({ ...mutation, approved: true }, context) as Record<string, unknown>;
    assert.equal(bareBoolean.status, "approval_required", "approved=true is not proof of a human approval");

    const denied = await safeWrite(
      { operation: "create", doctype: "Salary Slip", doc: { employee: "EMP-0001" }, approved: true },
      context,
    ) as Record<string, unknown>;
    assert.equal(denied.status, "denied");
    assert.match(String((denied.preflight as Record<string, unknown>).reason), /Frappe denied create/);

    const approval = signFrappeApproval(
      proposal.approvalProposal as Parameters<typeof signFrappeApproval>[0],
      "approver@example.test",
      signingKey,
      String((proposal.approvalProposal as Record<string, unknown>).issuedAt),
    );
    const tampered = await safeWrite({
      ...mutation,
      doc: { employee: "EMP-0001", leave_type: "Sick Leave" },
      approvalReceipt: approval,
    }, context) as Record<string, unknown>;
    assert.equal(tampered.status, "approval_required", "an approval for one mutation must not authorize changed fields");
    const approved = await safeWrite(
      { ...mutation, approvalReceipt: approval, approvalNote: "Approved by fixture test" },
      context,
    ) as Record<string, unknown>;
    assert.equal(approved.status, "executed");
    assert.deepEqual((approved.result as Record<string, unknown>).created, { name: "HR-LAP-0001", doctype: "Leave Application", employee: "EMP-0001", leave_type: "Annual Leave" });
    assert.equal((approved.verification as Record<string, unknown>).verified, true);
    assert.ok((approved.evidenceLog as string[]).includes("permission_preflight:allowed"));
    assert.ok((approved.evidenceLog as string[]).includes("approval_receipt:consumed"));
    assert.ok((approved.evidenceLog as string[]).includes("verify_result:ok"));

    const replay = await safeWrite({ ...mutation, approvalReceipt: approval }, context) as Record<string, unknown>;
    assert.match(String(replay.error), /already consumed/);
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
    doctype: "Leave Application",
    siteUrl: "https://erp.example.test",
    values: { from_date: "2026-07-09", to_date: "2026-07-09" },
    fields: [
      { fieldname: "leave_type", label: "Leave type", fieldtype: "Select", options: "Casual Leave\nSick Leave", reqd: 1 },
      { fieldname: "from_date", label: "From date", fieldtype: "Date", reqd: 1 },
      { fieldname: "to_date", label: "To date", fieldtype: "Date", reqd: 1 },
      { fieldname: "description", label: "Reason", fieldtype: "Small Text", reqd: 1 },
    ],
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

test("SQLite enterprise read model persists every required Frappe metadata surface", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-read-model-"));
  const path = join(cwd, "frappe.db");
  const first = new SqliteFrappeReadModel(path);
  const revision = first.replaceSnapshot(enterpriseSnapshot());
  assert.match(revision.schemaRevision, /^[0-9a-f]{64}$/);
  assert.equal(first.searchIndex("https://erp.example.test", "https://erp.example.test").length, 0, "site identifiers are scope, not indexed answer text");
  first.close();

  const reopened = new SqliteFrappeReadModel(path);
  try {
    const records = reopened.searchIndex("https://erp.example.test", "", FRAPPE_INDEX_KINDS, 100);
    const kinds = new Set(records.map((record) => record.kind));
    for (const kind of FRAPPE_INDEX_KINDS) assert.equal(kinds.has(kind), true, `${kind} should survive a database reopen`);
    const fields = reopened.searchIndex("https://erp.example.test", "priority", ["field"]);
    assert.equal(fields[0]?.doctype, "Service Request");
    assert.equal(fields[0]?.payload.fieldname, "priority");
    assert.doesNotMatch(JSON.stringify(records), /must-not-persist/);
    assert.match(JSON.stringify(records), /\[REDACTED\]/);
    assert.deepEqual(reopened.getRevision("https://erp.example.test"), revision);
  } finally {
    reopened.close();
  }
});

test("permission epochs invalidate cache for roles, User Permissions, shares, permlevels, workflow, and hierarchy changes", async () => {
  const store = new SqliteFrappeReadModel(":memory:");
  try {
    const baseInput = {
      site: "https://erp.example.test",
      principal: "worker@example.test",
      roles: ["Desk User", "Employee"],
      userPermissions: [{ allow: "Company", for_value: "Example Co" }],
      shares: [{ doctype: "Service Request", name: "REQ-1", read: 1 }],
      permlevels: [{ doctype: "Service Request", permlevel: 0, read: 1 }],
      workflowInputs: [{ doctype: "Service Request", state: "Open", action: "Submit" }],
      hierarchyInputs: [{ record: "EMP-2", reports_to: "EMP-1" }],
    };
    const epoch = computeFrappePermissionEpoch(baseInput);
    const reordered = computeFrappePermissionEpoch({ ...baseInput, roles: ["Employee", "Desk User"] });
    assert.equal(epoch.epoch, reordered.epoch, "equivalent permission sets should not churn the epoch");
    store.putPermissionEpoch(epoch, "2026-07-10T08:00:00.000Z");
    const identity: FrappeCacheIdentity = {
      site: epoch.site,
      principal: epoch.principal,
      permissionEpoch: epoch.epoch,
      schemaRevision: "schema-1",
      dataRevision: "data-1",
    };
    await resolveFrappeRead({
      store,
      identity,
      querySignature: "my open requests",
      ttlMs: 30_000,
      now: "2026-07-10T08:00:00.000Z",
      live: async () => ({ value: [{ name: "REQ-1" }] }),
    });
    const variants = [
      { ...baseInput, roles: [...baseInput.roles, "Request Approver"] },
      { ...baseInput, userPermissions: [{ allow: "Company", for_value: "Other Co" }] },
      { ...baseInput, shares: [{ doctype: "Service Request", name: "REQ-2", read: 1 }] },
      { ...baseInput, permlevels: [{ doctype: "Service Request", permlevel: 1, read: 1 }] },
      { ...baseInput, workflowInputs: [{ doctype: "Service Request", state: "Approved", action: "Close" }] },
      { ...baseInput, hierarchyInputs: [{ record: "EMP-2", reports_to: "EMP-9" }] },
    ];
    for (const changed of variants) {
      const changedEpoch = computeFrappePermissionEpoch(changed);
      assert.notEqual(changedEpoch.epoch, epoch.epoch);
      assert.equal(store.getCache({ ...identity, permissionEpoch: changedEpoch.epoch }, "my open requests"), undefined);
    }
  } finally {
    store.close();
  }
});

test("read-model cache never crosses Frappe principals", async () => {
  const store = new SqliteFrappeReadModel(":memory:");
  try {
    const alice: FrappeCacheIdentity = {
      site: "https://erp.example.test",
      principal: "alice@example.test",
      permissionEpoch: "epoch-alice",
      schemaRevision: "schema-1",
      dataRevision: "data-1",
    };
    await resolveFrappeRead({
      store,
      identity: alice,
      querySignature: "private dashboard",
      ttlMs: 30_000,
      now: "2026-07-10T08:00:00.000Z",
      live: async () => ({ value: { confidentialCount: 7 }, objectRefs: ["Service Request:REQ-7"] }),
    });
    const bob = { ...alice, principal: "bob@example.test", permissionEpoch: "epoch-bob" };
    assert.equal(store.getCache(bob, "private dashboard"), undefined);
    let liveCalls = 0;
    const result = await resolveFrappeRead({
      store,
      identity: bob,
      querySignature: "private dashboard",
      ttlMs: 30_000,
      now: "2026-07-10T08:00:01.000Z",
      live: async () => { liveCalls += 1; return { value: { confidentialCount: 0 } }; },
    });
    assert.equal(liveCalls, 1);
    assert.deepEqual(result.value, { confidentialCount: 0 });
    assert.doesNotMatch(JSON.stringify(result.presentation), /epoch-|cacheKey|Service Request:REQ-7/);
  } finally {
    store.close();
  }
});

test("customization drift changes schema revision and removes stale cached answers", async () => {
  const store = new SqliteFrappeReadModel(":memory:");
  try {
    const first = store.replaceSnapshot(enterpriseSnapshot());
    const permission = computeFrappePermissionEpoch({ site: first.site, principal: "user@example.test", roles: ["Employee"] });
    const identity: FrappeCacheIdentity = {
      site: first.site,
      principal: permission.principal,
      permissionEpoch: permission.epoch,
      schemaRevision: first.schemaRevision,
      dataRevision: first.dataRevision,
    };
    await resolveFrappeRead({
      store,
      identity,
      querySignature: "required fields",
      ttlMs: 60_000,
      now: "2026-07-10T08:00:00.000Z",
      live: async () => ({ value: ["subject"] }),
    });
    const second = store.replaceSnapshot(enterpriseSnapshot("https://erp.example.test", {
      observedAt: "2026-07-10T08:01:00.000Z",
      propertySetters: [{ name: "Service Request-custom_region-reqd", doc_type: "Service Request", field_name: "custom_region", property: "reqd", value: "1" }],
    }));
    assert.notEqual(second.schemaRevision, first.schemaRevision);
    assert.equal(store.getCache(identity, "required fields"), undefined);
    assert.equal(store.searchIndex(second.site, "custom_region", ["property_setter"])[0]?.payload.value, "1");
  } finally {
    store.close();
  }
});

test("manager hierarchy scope comes only from configured live Frappe fields", () => {
  const rows = [
    { name: "EMP-1", user_id: "manager@example.test", reports_to: "", status: "Active" },
    { name: "EMP-2", user_id: "direct@example.test", reports_to: "EMP-1", status: "Active" },
    { name: "EMP-3", user_id: "indirect@example.test", reports_to: "EMP-2", status: "Active" },
    { name: "EMP-4", user_id: "inactive@example.test", reports_to: "EMP-1", status: "Left" },
    { name: "EMP-5", user_id: "cycle@example.test", reports_to: "EMP-5", status: "Active" },
  ];
  const config = {
    sourceDoctype: "Employee",
    recordIdField: "name",
    principalField: "user_id",
    managerRecordField: "reports_to",
    activeField: "status",
    activeValues: ["Active"],
  };
  const scope = deriveFrappeHierarchyScope("manager@example.test", config, rows);
  assert.deepEqual(scope.directReportPrincipals, ["direct@example.test"]);
  assert.deepEqual(scope.descendantPrincipals, ["direct@example.test", "indirect@example.test"]);
  assert.equal(scope.depthByRecordId["EMP-3"], 2);
  assert.equal(scope.descendantPrincipals.includes("inactive@example.test"), false);

  const titleOnly = deriveFrappeHierarchyScope("fake-manager@example.test", config, [
    ...rows,
    { name: "EMP-6", user_id: "fake-manager@example.test", reports_to: "", status: "Active", roles: ["Senior Manager", "HR Manager"] },
  ]);
  assert.deepEqual(titleOnly.descendantPrincipals, [], "role or title strings must never manufacture hierarchy scope");
});

test("cache hit and stale fallback preserve data order while keeping internal provenance separate", async () => {
  const store = new SqliteFrappeReadModel(":memory:");
  try {
    const identity: FrappeCacheIdentity = {
      site: "https://erp.example.test",
      principal: "worker@example.test",
      permissionEpoch: "permission-1",
      schemaRevision: "schema-1",
      dataRevision: "data-1",
    };
    let calls = 0;
    const live = async () => ({ value: [{ rank: 2 }, { rank: 1 }], objectRefs: ["Service Request:REQ-2", "Service Request:REQ-1"] });
    const first = await resolveFrappeRead({ store, identity, querySignature: "ranked queue", ttlMs: 1_000, now: "2026-07-10T08:00:00.000Z", live: async () => { calls += 1; return live(); } });
    const hit = await resolveFrappeRead({ store, identity, querySignature: "ranked queue", ttlMs: 1_000, now: "2026-07-10T08:00:00.500Z", live: async () => { calls += 1; return live(); } });
    const stale = await resolveFrappeRead({ store, identity, querySignature: "ranked queue", ttlMs: 1_000, now: "2026-07-10T08:00:02.000Z", live: async () => { calls += 1; return { value: [{ rank: 3 }, { rank: 2 }] }; } });
    assert.equal(calls, 2);
    assert.deepEqual(first.value, [{ rank: 2 }, { rank: 1 }]);
    assert.deepEqual(hit.value, [{ rank: 2 }, { rank: 1 }]);
    assert.equal(hit.receipt.cacheState, "hit");
    assert.equal(stale.receipt.cacheState, "stale");
    assert.equal(stale.presentation.status, "refreshed");
  } finally {
    store.close();
  }
});

test("optional Frappe events are idempotent and invalidate cached data revisions", async () => {
  const store = new SqliteFrappeReadModel(":memory:");
  try {
    const revision = store.replaceSnapshot(enterpriseSnapshot());
    const identity: FrappeCacheIdentity = {
      site: revision.site,
      principal: "worker@example.test",
      permissionEpoch: "permission-1",
      schemaRevision: revision.schemaRevision,
      dataRevision: revision.dataRevision,
    };
    await resolveFrappeRead({
      store,
      identity,
      querySignature: "live count",
      ttlMs: 60_000,
      now: "2026-07-10T08:00:00.000Z",
      live: async () => ({ value: { count: 1 } }),
    });
    const event = {
      eventId: "event-1",
      site: revision.site,
      operation: "data_changed" as const,
      revision: "data-2",
      observedAt: "2026-07-10T08:01:00.000Z",
    };
    const first = store.applyEvent(event);
    const duplicate = store.applyEvent(event);
    assert.equal(first.applied, true);
    assert.equal(first.invalidatedCacheEntries, 1);
    assert.equal(duplicate.duplicate, true);
    assert.equal(store.getCache(identity, "live count"), undefined);
    assert.equal(store.getRevision(revision.site)?.dataRevision, "data-2");
  } finally {
    store.close();
  }
});

test("enterprise indexing derives answers from arbitrary customer metadata without customer-name branches", () => {
  const store = new SqliteFrappeReadModel(":memory:");
  try {
    store.replaceSnapshot(enterpriseSnapshot("https://tenant-a.example.test", {
      doctypes: [{ name: "Incident Dispatch Grid", module: "Field Operations", fields: [{ fieldname: "dispatch_window", label: "Dispatch Window", fieldtype: "Duration" }] }],
    }));
    assert.deepEqual(store.searchIndex("https://tenant-a.example.test", "dispatch window").map((record) => record.objectId), ["Incident Dispatch Grid", "Incident Dispatch Grid:dispatch_window"]);
    assert.equal(store.searchIndex("https://tenant-a.example.test", "OxygenHR").length, 0);
    store.replaceSnapshot(enterpriseSnapshot("https://tenant-a.example.test", {
      observedAt: "2026-07-10T08:10:00.000Z",
      doctypes: [{ name: "Roster Divergence", module: "Field Operations", fields: [{ fieldname: "variance", label: "Variance", fieldtype: "Float" }] }],
    }));
    assert.equal(store.searchIndex("https://tenant-a.example.test", "dispatch window").length, 0);
    assert.equal(store.searchIndex("https://tenant-a.example.test", "roster variance")[0]?.doctype, "Roster Divergence");
  } finally {
    store.close();
  }
});

test("zero-app OAuth polling builds a field-hydrated snapshot from standard Frappe REST endpoints", async () => {
  const requests: string[] = [];
  const fetchStub: typeof globalThis.fetch = async (url, init) => {
    const value = String(url);
    requests.push(value);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer oauth-test-token");
    if (value.includes("frappe.utils.change_log.get_versions")) return new Response(JSON.stringify({ message: { frappe: { version: "15.1.0" } } }), { status: 200 });
    if (value.includes("/api/resource/Module%20Def")) return new Response(JSON.stringify({ data: [{ name: "Operations" }] }), { status: 200 });
    if (value.includes("/api/resource/DocType/Service%20Request")) return new Response(JSON.stringify({ data: { name: "Service Request", module: "Operations", fields: [{ fieldname: "subject", label: "Subject" }] } }), { status: 200 });
    if (value.includes("/api/resource/DocType")) return new Response(JSON.stringify({ data: [{ name: "Service Request", module: "Operations" }] }), { status: 200 });
    return new Response(JSON.stringify({ exception: "not found" }), { status: 404 });
  };
  const result = await pollFrappeEnterpriseSnapshot({
    site: "https://erp.example.test/",
    fetch: fetchStub,
    oauth: { getAccessToken: async () => ({ accessToken: "oauth-test-token" }) },
    pageSize: 10,
    observedAt: "2026-07-10T08:00:00.000Z",
    resources: [
      { snapshotKey: "modules", kind: "module", doctype: "Module Def", optional: false },
      { snapshotKey: "doctypes", kind: "doctype", doctype: "DocType", optional: false },
    ],
  });
  assert.equal(result.warnings.length, 0);
  assert.equal(result.snapshot.apps?.[0] && (result.snapshot.apps[0] as Record<string, unknown>).name, "frappe");
  assert.equal((result.snapshot.doctypes?.[0] as Record<string, unknown>).fields instanceof Array, true);
  assert.match(result.snapshot.schemaRevision ?? "", /^[0-9a-f]{64}$/);
  assert.equal(requests.some((url) => url.includes("/api/resource/DocType/Service%20Request")), true);
});

test("sanitized OxygenHR profile is valid data and contains no deployment secrets", async () => {
  const path = resolve(packDir, "profiles", "oxygenhr.sanitized.json");
  const raw = await readFile(path, "utf8");
  const profile = JSON.parse(raw) as unknown;
  const result = validateFrappeCustomerProfile(profile);
  assert.equal(result.valid, true);
  assert.doesNotMatch(raw, /api[_-]?secret|client[_-]?secret|password|pwhr\.in|ragnardataops/i);
  assert.match(raw, /"sourceDoctype": "Employee"/);
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
        "frappe-federated-bridge__frappe_customer_profile_validate",
        "frappe-federated-bridge__frappe_docs_context",
        "frappe-federated-bridge__frappe_enterprise_contract",
        "frappe-federated-bridge__frappe_fast_route",
        "frappe-federated-bridge__frappe_hierarchy_scope",
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
