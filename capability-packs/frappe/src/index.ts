import { createHash, randomUUID } from "node:crypto";

/**
 * Frappe/ERPNext capability pack v0 — three real tools ported from the
 * production patterns in ../FRAPPE_SURFACE_SPEC.md and the
 * frappe2-openclaw-gateway reference deployment.
 *
 * Contract:
 * - Pure functions: every tool takes (args, context) where context is the
 *   frozen, permission-scoped CapabilityToolContext handed in by the loader
 *   (HC-012). No ambient fetch, no direct process.env reads.
 * - Permission-scoped: every call executes as the configured Frappe user;
 *   Frappe remains the only authorization authority. A 403 PermissionError is
 *   returned verbatim, never masked.
 * - Error-diagnostic: failures return { error } carrying the exact Frappe
 *   message (exception / _server_messages / message) plus HTTP status and
 *   exc_type — never a swallowed "malformed data".
 *
 * Config comes from manifest secrets via context.config:
 *   FRAPPE_SITE_URL  e.g. https://uat-erp.pwhr.in
 *   FRAPPE_API_TOKEN api_key:api_secret ("token ..." auth) or a bare OAuth
 *                    bearer token ("Bearer ..." auth)
 */

import { frappeFastRoute, frappeReadModelPlan, type FrappeSemanticAlias } from "./read-model.js";
import {
  buildFrappeIndexRecords,
  createFrappeApprovalProposal,
  computeFrappePermissionEpoch,
  deriveFrappeHierarchyScope,
  FRAPPE_POSTGRES_DEPLOYMENT_CONTRACT,
  FRAPPE_ZERO_APP_RESOURCE_SPECS,
  pollFrappeEnterpriseSnapshot,
  SqliteFrappeReadModel,
  validateFrappeCustomerProfile,
  verifyFrappeApproval,
  type FrappeApprovalProposal,
  type FrappeApprovalReceipt,
  type FrappeHierarchyConfig,
  type FrappeIndexRecord,
} from "./enterprise.js";
import {
  FrappeReadService,
  FrappeReadServiceError,
  hydrateFrappeEffectiveDocTypeMetadata,
  requiredFieldsFromEffectiveMetadata,
  type FrappeEffectiveDocTypeMetadata,
} from "./read-service.js";

export * from "./enterprise.js";
export * from "./read-service.js";
export * from "./change-set.js";

export interface FrappeToolContext {
  readonly fetch?: typeof globalThis.fetch;
  readonly config: Readonly<Record<string, string | undefined>>;
}

export interface FrappeError {
  readonly error: string;
  readonly status?: number;
  readonly excType?: string;
}

interface FrappeCallOk {
  readonly ok: true;
  readonly data: Record<string, unknown>;
  readonly headers?: Headers;
}

interface FrappeBusinessApiSpec {
  readonly id: string;
  readonly operation: "read";
  readonly doctype: string;
  readonly phrases: readonly string[];
  readonly method: string;
  readonly params: Readonly<Record<string, "$employee" | "$user" | "$company" | "$today">>;
  readonly responsePath: string;
  readonly resultLabel?: string;
  readonly view?: {
    readonly title?: string;
    readonly summary?: string;
    readonly emptyTitle?: string;
    readonly emptySummary?: string;
    readonly columns?: readonly { readonly field: string; readonly label: string }[];
  };
  readonly includeWhen?: { readonly field: string; readonly equals: string | number | boolean };
  readonly fields?: readonly { readonly target: string; readonly sources: readonly string[] }[];
}

type FrappeCallResult = FrappeCallOk | (FrappeError & { readonly ok?: undefined });
type FrappeHttpMethod = "GET" | "POST" | "PUT" | "DELETE";

const frappeReadServices = new Map<string, { readonly service: FrappeReadService; readonly store: SqliteFrappeReadModel }>();
const frappeEffectiveMetadataCache = new Map<string, { readonly expiresAt: number; readonly value: FrappeEffectiveDocTypeMetadata }>();
const FRAPPE_EFFECTIVE_METADATA_TTL_MS = 60_000;
const SENSITIVE_READ_DOCTYPES = new Set([
  "Employee",
  "Employee Checkin",
  "Attendance",
  "Attendance Request",
  "Leave Application",
  "Leave Allocation",
  "Expense Claim",
  "Salary Slip",
  "Payroll Entry",
  "Bank Account",
  "Employee Tax Exemption Declaration",
]);
const PERMISSION_AFFECTING_DOCTYPES = new Set([
  "User",
  "Role",
  "Has Role",
  "User Permission",
  "DocShare",
  "Custom DocPerm",
  "Role Permission for Page and Report",
  "Employee",
]);
const METADATA_AFFECTING_DOCTYPES = new Set([
  ...PERMISSION_AFFECTING_DOCTYPES,
  "DocType",
  "DocField",
  "Custom Field",
  "Property Setter",
  "Workflow",
  "Workflow State",
  "Workflow Action Master",
]);

type FrappeAuth =
  | { readonly kind: "token"; readonly value: string }
  | { readonly kind: "cookie"; readonly value: string };

interface FrappeResolvedIdentity {
  readonly site: string;
  readonly authMode: "oauth_bearer" | "api_token" | "admin_login";
  readonly user: string;
  readonly employee?: {
    readonly name: string;
    readonly employeeName?: string;
    readonly department?: string;
    readonly company?: string;
    readonly designation?: string;
    readonly status?: string;
  };
  readonly roles: readonly string[];
  readonly permissionScope: {
    readonly user: string;
    readonly employee?: string;
    readonly roles: readonly string[];
    readonly permissionHash: string;
    readonly rolesHash: string;
  };
  readonly pairing: {
    readonly recommendedScopeIds: readonly string[];
    readonly channelSafe: boolean;
    readonly proof: readonly string[];
  };
}

type FrappeInteractionKind = "direct_answer" | "table_result" | "guided_crud" | "blocked" | "setup_required";

interface FrappeInteractionPlan {
  readonly kind: FrappeInteractionKind;
  readonly title: string;
  readonly message: string;
  readonly reason?: string;
  readonly doctype?: string;
  readonly operation?: "read" | "create" | "update" | "submit" | "approve" | "reject";
  readonly requiredFields: Array<{ readonly fieldname: string; readonly label: string; readonly reason: string; readonly options?: readonly string[] }>;
  readonly table?: {
    readonly columns: readonly string[];
    readonly rows: readonly string[][];
  };
  readonly documentLinks: Array<{ readonly label: string; readonly doctype: string; readonly name: string; readonly url: string }>;
  readonly next: Array<{ readonly label: string; readonly detail: string }>;
  readonly renderHints: {
    readonly phone: "numbered_actions" | "native_buttons_when_available";
    readonly desktop: "clickable_table" | "side_panel_form";
    readonly tui: "arrow_selectable";
  };
  readonly safety: {
    readonly permissionCheckRequired: boolean;
    readonly previewBeforeWrite: boolean;
    readonly approvalRequired: boolean;
  };
}

interface FrappeDocSource {
  readonly label: string;
  readonly url: string;
  readonly scope: "framework" | "erpnext" | "frappe-suite" | "installed-app" | "module";
}

interface FrappeModuleContext {
  readonly module: string;
  readonly apps: string[];
  readonly docs: FrappeDocSource[];
  readonly concepts: string[];
  readonly retrievalHints: string[];
}

type FrappeQueryClass =
  | "schema"
  | "field"
  | "permission"
  | "workflow"
  | "report"
  | "customization"
  | "installed_app"
  | "docs"
  | "record_lookup"
  | "record_creation"
  | "record_update"
  | "artifact_generation"
  | "troubleshooting"
  | "migration_custom_app_impact"
  | "role_safe_management_summary";

type FrappePermissionName = "read" | "write" | "create" | "delete" | "submit" | "cancel" | "amend" | "select" | "report" | "export" | "import" | "print" | "email" | "share";

interface FrappeDocFieldIndex {
  readonly fieldname: string;
  readonly label?: string;
  readonly fieldtype?: string;
  readonly options?: string;
  readonly reqd?: boolean;
  readonly hidden?: boolean;
  readonly permlevel?: number;
}

interface FrappePermissionIndex {
  readonly role: string;
  readonly read?: boolean;
  readonly write?: boolean;
  readonly create?: boolean;
  readonly delete?: boolean;
  readonly submit?: boolean;
  readonly cancel?: boolean;
  readonly amend?: boolean;
  readonly select?: boolean;
  readonly report?: boolean;
  readonly export?: boolean;
  readonly import?: boolean;
  readonly print?: boolean;
  readonly email?: boolean;
  readonly share?: boolean;
}

interface FrappeDocTypeIndex {
  readonly name: string;
  readonly module?: string;
  readonly custom?: boolean;
  readonly istable?: boolean;
  readonly autoname?: string;
  readonly fields: FrappeDocFieldIndex[];
  readonly links: Array<{ readonly fieldname: string; readonly target: string }>;
  readonly childTables: Array<{ readonly fieldname: string; readonly target: string }>;
  readonly namingSeries: string[];
  readonly permissions: FrappePermissionIndex[];
}

interface FrappeGraph {
  readonly nodes: Array<{ readonly id: string; readonly type: string; readonly label: string }>;
  readonly edges: Array<{ readonly from: string; readonly to: string; readonly type: string; readonly label?: string }>;
}

interface FrappeSiteInduction {
  readonly site: {
    readonly url: string;
    readonly authMode: "api_token" | "admin_login";
    readonly identity: { readonly user?: string };
    readonly versions: Record<string, string>;
    readonly installedApps: string[];
  };
  readonly modules: string[];
  readonly workspaces: string[];
  readonly doctypes: FrappeDocTypeIndex[];
  readonly roles: string[];
  readonly permissions: Array<{ readonly doctype: string; readonly role: string; readonly permission: FrappePermissionName; readonly allowed: boolean }>;
  readonly workflows: unknown[];
  readonly reports: unknown[];
  readonly printFormats: unknown[];
  readonly dashboards: unknown[];
  readonly webForms: unknown[];
  readonly notificationRules: unknown[];
  readonly assignmentRules: unknown[];
  readonly customizations: {
    readonly customFields: unknown[];
    readonly propertySetters: unknown[];
    readonly clientScripts: unknown[];
    readonly serverScripts: unknown[];
  };
  readonly docs: FrappeDocSource[];
  readonly graph: FrappeGraph;
  readonly evidence: string[];
  readonly warnings: string[];
}

const FRAPPE_DOCS: readonly FrappeDocSource[] = [
  { label: "Frappe Framework docs", url: "https://frappeframework.com/docs", scope: "framework" },
  { label: "Frappe REST API", url: "https://frappeframework.com/docs/user/en/api/rest", scope: "framework" },
  { label: "Frappe DocType model", url: "https://frappeframework.com/docs/user/en/basics/doctypes", scope: "framework" },
  { label: "Frappe Custom Fields", url: "https://frappeframework.com/docs/user/en/customize-erpnext/custom-field", scope: "framework" },
  { label: "Frappe Workflows", url: "https://frappeframework.com/docs/user/en/desk/workflows", scope: "framework" },
  { label: "ERPNext manual", url: "https://docs.erpnext.com/", scope: "erpnext" },
  { label: "ERPNext modules", url: "https://docs.erpnext.com/docs/user/manual/en/modules", scope: "erpnext" },
  { label: "Frappe CRM docs", url: "https://docs.frappe.io/crm", scope: "frappe-suite" },
  { label: "Frappe HR docs", url: "https://docs.frappe.io/hr", scope: "frappe-suite" },
  { label: "Frappe Helpdesk docs", url: "https://docs.frappe.io/helpdesk", scope: "frappe-suite" },
  { label: "Frappe Insights docs", url: "https://docs.frappe.io/insights", scope: "frappe-suite" },
  { label: "Frappe Builder docs", url: "https://docs.frappe.io/builder", scope: "frappe-suite" },
  { label: "Frappe LMS docs", url: "https://docs.frappe.io/lms", scope: "frappe-suite" },
  { label: "Frappe Wiki docs", url: "https://docs.frappe.io/wiki", scope: "frappe-suite" },
];

const MODULE_PRIORS: readonly FrappeModuleContext[] = [
  modulePrior("Accounts", ["erpnext"], ["Company", "Account", "Journal Entry", "Sales Invoice", "Purchase Invoice", "Payment Entry"], ["GL Entry", "accounting dimensions", "party ledger", "currency"]),
  modulePrior("Selling", ["erpnext"], ["Customer", "Lead", "Opportunity", "Quotation", "Sales Order", "Sales Invoice"], ["selling pipeline", "pricing rules", "taxes", "territory"]),
  modulePrior("Buying", ["erpnext"], ["Supplier", "Material Request", "Request for Quotation", "Purchase Order", "Purchase Receipt", "Purchase Invoice"], ["supplier quotation", "stock impact", "landed cost"]),
  modulePrior("Stock", ["erpnext"], ["Item", "Warehouse", "Stock Entry", "Delivery Note", "Purchase Receipt", "Bin"], ["valuation", "serial/batch", "reserved stock", "reorder"]),
  modulePrior("Manufacturing", ["erpnext"], ["BOM", "Work Order", "Job Card", "Production Plan", "Operation"], ["routing", "workstation", "subcontracting", "WIP"]),
  modulePrior("Projects", ["erpnext"], ["Project", "Task", "Timesheet", "Project Template"], ["milestones", "billing", "costing"]),
  modulePrior("HR", ["erpnext", "hrms"], ["Employee", "Department", "Designation", "Leave Application", "Attendance", "Salary Slip"], ["permissions by employee", "payroll", "shift", "leave allocation"]),
  modulePrior("Payroll", ["erpnext", "hrms"], ["Payroll Entry", "Salary Structure", "Salary Component", "Salary Slip"], ["earnings", "deductions", "tax", "arrears"]),
  modulePrior("CRM", ["erpnext", "frappe_crm"], ["Lead", "Deal", "Contact", "Organization", "Opportunity"], ["pipeline", "assignment", "communication timeline"]),
  modulePrior("Support", ["erpnext", "helpdesk"], ["Issue", "Ticket", "SLA", "Customer"], ["service levels", "assignment", "responses"]),
  modulePrior("Website", ["frappe", "webshop"], ["Web Page", "Website Theme", "Blog Post", "Item Group"], ["portal", "route", "guest access"]),
];

function configError(name: string): FrappeError {
  return { error: `Frappe pack is not configured: ${name} is missing. Declare it in the environment (manifest secret).` };
}

function authorizationHeader(token: string): string {
  // Frappe API key:secret pairs use "token ..."; bare OAuth access tokens use "Bearer ...".
  return token.includes(":") ? `token ${token}` : `Bearer ${token}`;
}

function argString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Extracts the exact human-readable Frappe error from a failed response body. */
function extractFrappeMessage(body: unknown, rawText: string): string {
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    if (typeof record.exception === "string" && record.exception.trim()) return record.exception;
    if (typeof record._server_messages === "string" && record._server_messages.trim()) {
      try {
        const outer = JSON.parse(record._server_messages) as unknown[];
        const messages = outer.map((item) => {
          if (typeof item !== "string") return String(item);
          try {
            const inner = JSON.parse(item) as { message?: string };
            return typeof inner.message === "string" ? inner.message : item;
          } catch {
            return item;
          }
        });
        if (messages.length) return messages.join(" | ");
      } catch {
        return record._server_messages;
      }
    }
    if (typeof record.message === "string" && record.message.trim()) return record.message;
  }
  return rawText || "Frappe returned an empty error body.";
}

async function frappeRequest(
  context: FrappeToolContext,
  method: FrappeHttpMethod,
  path: string,
  body?: Record<string, unknown>,
): Promise<FrappeCallResult> {
  if (typeof context.fetch !== "function") {
    return { error: "Frappe pack has no network access: the loader did not grant fetch (manifest must declare the \"network\" permission)." };
  }
  const siteUrl = context.config.FRAPPE_SITE_URL;
  if (!siteUrl) return configError("FRAPPE_SITE_URL");
  const token = context.config.FRAPPE_API_TOKEN;
  if (!token) return configError("FRAPPE_API_TOKEN");

  const url = `${siteUrl.replace(/\/$/, "")}${path}`;
  let response: Response;
  try {
    response = await context.fetch(url, {
      method,
      headers: {
        Authorization: authorizationHeader(token),
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    return { error: `Frappe request to ${url} failed before a response: ${error instanceof Error ? error.message : String(error)}` };
  }

  const rawText = await response.text();
  let parsed: unknown;
  try {
    parsed = rawText ? JSON.parse(rawText) : {};
  } catch {
    parsed = undefined;
  }
  if (!response.ok) {
    const excType =
      typeof parsed === "object" && parsed !== null && typeof (parsed as Record<string, unknown>).exc_type === "string"
        ? ((parsed as Record<string, unknown>).exc_type as string)
        : undefined;
    return { error: extractFrappeMessage(parsed, rawText), status: response.status, excType };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { error: `Frappe returned a non-JSON success body from ${url}: ${rawText.slice(0, 200)}`, status: response.status };
  }
  return { ok: true, data: parsed as Record<string, unknown> };
}

async function frappeAuthedRequest(
  fetchFn: typeof globalThis.fetch,
  siteUrl: string,
  auth: FrappeAuth,
  method: FrappeHttpMethod,
  path: string,
  body?: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<FrappeCallResult> {
  const url = `${siteUrl.replace(/\/$/, "")}${path}`;
  let response: Response;
  try {
    response = await fetchFn(url, {
      method,
      headers: {
        ...(auth.kind === "token" ? { Authorization: authorizationHeader(auth.value) } : { Cookie: auth.value }),
        Accept: "application/json",
        ...(idempotencyKey ? { "X-Frappe-Idempotency-Key": idempotencyKey } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    return { error: `Frappe request to ${url} failed before a response: ${error instanceof Error ? error.message : String(error)}` };
  }
  const rawText = await response.text();
  let parsed: unknown;
  try {
    parsed = rawText ? JSON.parse(rawText) : {};
  } catch {
    parsed = undefined;
  }
  if (!response.ok) {
    const excType =
      typeof parsed === "object" && parsed !== null && typeof (parsed as Record<string, unknown>).exc_type === "string"
        ? ((parsed as Record<string, unknown>).exc_type as string)
        : undefined;
    return { error: extractFrappeMessage(parsed, rawText), status: response.status, excType };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { error: `Frappe returned a non-JSON success body from ${url}: ${rawText.slice(0, 200)}`, status: response.status };
  }
  return { ok: true, data: parsed as Record<string, unknown>, headers: response.headers };
}

async function resolveRuntimeAuth(args: Record<string, unknown>, context: FrappeToolContext): Promise<{ siteUrl: string; auth: FrappeAuth; mode: "api_token" | "admin_login" } | FrappeError> {
  if (typeof context.fetch !== "function") {
    return { error: "Frappe pack has no network access: the loader did not grant fetch (manifest must declare the \"network\" permission)." };
  }
  const siteUrl = argString(args, "siteUrl") ?? context.config.FRAPPE_SITE_URL;
  if (!siteUrl) return configError("FRAPPE_SITE_URL");
  const token = argString(args, "apiToken") ?? context.config.FRAPPE_API_TOKEN;
  if (token) return { siteUrl, auth: { kind: "token", value: token }, mode: "api_token" };

  const user = argString(args, "adminUser") ?? argString(args, "user");
  const password = argString(args, "adminPassword") ?? argString(args, "password");
  if (!user || !password) {
    return { error: "Frappe context build needs FRAPPE_API_TOKEN, or runtime args siteUrl + adminUser + adminPassword. Password args are used only for this call and are never returned." };
  }
  const login = await frappeLogin(context.fetch, siteUrl, user, password);
  if ("error" in login) return login;
  return { siteUrl, auth: { kind: "cookie", value: login.cookie }, mode: "admin_login" };
}

async function frappeLogin(fetchFn: typeof globalThis.fetch, siteUrl: string, user: string, password: string): Promise<{ ok: true; cookie: string } | FrappeError> {
  const url = `${siteUrl.replace(/\/$/, "")}/api/method/login`;
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ usr: user, pwd: password }).toString(),
    });
  } catch (error) {
    return { error: `Frappe login to ${url} failed before a response: ${error instanceof Error ? error.message : String(error)}` };
  }
  const rawText = await response.text();
  let parsed: unknown;
  try {
    parsed = rawText ? JSON.parse(rawText) : {};
  } catch {
    parsed = undefined;
  }
  if (!response.ok) return { error: extractFrappeMessage(parsed, rawText), status: response.status };
  const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  const rawCookie = getSetCookie.length ? getSetCookie.join(",") : response.headers.get("set-cookie") ?? "";
  const cookie = rawCookie.split(/,(?=[^;]+?=)/).map((item) => item.split(";")[0]?.trim()).filter(Boolean).join("; ");
  if (!cookie) return { error: "Frappe login succeeded but no session cookie was returned; use an API token instead.", status: response.status };
  return { ok: true, cookie };
}

/** GET /api/method/frappe.auth.get_logged_user — who does this token act as? */
export async function frappe_identity_resolve(
  _args: Record<string, unknown>,
  context: FrappeToolContext,
): Promise<{ user: string; site: string } | FrappeError> {
  const result = await frappeRequest(context, "GET", "/api/method/frappe.auth.get_logged_user");
  if (!result.ok) return result;
  const user = result.data.message;
  if (typeof user !== "string" || !user) {
    return { error: `Frappe get_logged_user returned no user: ${JSON.stringify(result.data).slice(0, 200)}` };
  }
  return { user, site: context.config.FRAPPE_SITE_URL as string };
}

export async function frappe_user_identity_resolve(
  args: Record<string, unknown>,
  context: FrappeToolContext,
): Promise<FrappeResolvedIdentity | FrappeError> {
  const auth = await resolveRuntimeAuth(args, context);
  if ("error" in auth) return auth;
  const userResult = await frappeAuthedRequest(context.fetch!, auth.siteUrl, auth.auth, "GET", "/api/method/frappe.auth.get_logged_user");
  if (!userResult.ok) return userResult;
  const user = typeof userResult.data.message === "string" ? userResult.data.message : "";
  if (!user) return { error: `Frappe get_logged_user returned no user: ${JSON.stringify(userResult.data).slice(0, 200)}` };

  const employee = await resolveEmployeeForUser(auth, context, user);
  if (employee && "error" in employee) return employee;
  const roles = await resolveRolesForUser(auth, context, user);
  if ("error" in roles) return roles;
  const employeeId = employee?.name;
  const roleList = roles.roles;
  const rolesHash = stableHash(roleList.join("|"));
  const permissionHash = stableHash([auth.siteUrl, user, employeeId ?? "", ...roleList].join("|"));
  return {
    site: auth.siteUrl,
    authMode: auth.mode === "api_token" && auth.auth.kind === "token" && !auth.auth.value.includes(":") ? "oauth_bearer" : auth.mode,
    user,
    ...(employee ? { employee } : {}),
    roles: roleList,
    permissionScope: {
      user,
      ...(employeeId ? { employee: employeeId } : {}),
      roles: roleList,
      permissionHash,
      rolesHash,
    },
    pairing: {
      recommendedScopeIds: [
        `frappe-user:${user}`,
        ...(employeeId ? [`frappe-employee:${employeeId}`] : []),
        ...roleList.map((role) => `frappe-role:${role}`),
      ],
      channelSafe: true,
      proof: [
        "frappe.auth.get_logged_user",
        employee ? "Employee.user_id lookup" : "Employee lookup returned no linked employee",
        "frappe.core.doctype.user.user.get_roles",
      ],
    },
  };
}

/**
 * Lite resource-list resolution: GET /api/resource/:doctype with fields,
 * filters, and limit. Permission scoping is Frappe's: a doctype the user
 * cannot read returns the exact PermissionError.
 */
export async function frappe_semantic_data_resolve_lite(
  args: Record<string, unknown>,
  context: FrappeToolContext,
): Promise<{ doctype: string; rows: unknown[]; count: number; total?: number; scope?: Record<string, unknown>; view?: FrappeBusinessApiSpec["view"] } | FrappeError> {
  const doctype = typeof args.doctype === "string" ? args.doctype.trim() : "";
  if (!doctype) return { error: 'frappe_semantic_data_resolve_lite requires a "doctype" argument.' };
  const query = new URLSearchParams();
  const explicitFields = Array.isArray(args.fields)
    ? args.fields.map(String).map((field) => field.trim()).filter(Boolean)
    : [];
  if (explicitFields.length) query.set("fields", JSON.stringify(explicitFields));
  if (args.filters !== undefined) query.set("filters", JSON.stringify(args.filters));
  if (args.orFilters !== undefined) query.set("or_filters", JSON.stringify(args.orFilters));
  const limit = typeof args.limit === "number" && Number.isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : 20;
  query.set("limit_page_length", String(limit));

  const auth = await resolveRuntimeAuth(args, context);
  if ("error" in auth) return auth;
  const prompt = argString(args, "prompt") ?? "";
  const requestedScope = recordObject(args.scope);
  const readModelPath = context.config.FRAPPE_READ_MODEL_PATH;
  const businessApi = selectFrappeBusinessApi(context.config.FRAPPE_BUSINESS_API_CATALOG, prompt, doctype);
  if (!businessApi && !readModelPath && explicitFields.length && !requestedScope && !booleanArg(args.includeTotal)) {
    return executeFrappeListRead(context, auth, doctype, `/api/resource/${encodeURIComponent(doctype)}?${query.toString()}`);
  }
  const expectedPrincipal = argString(args, "user") ?? await resolveAuthenticatedPrincipal(context, auth);
  if (typeof expectedPrincipal !== "string") return expectedPrincipal;
  if (businessApi) {
    if (!readModelPath) {
      const actualPrincipal = await resolveAuthenticatedPrincipal(context, auth);
      if (typeof actualPrincipal !== "string") return actualPrincipal;
      if (actualPrincipal.toLowerCase() !== expectedPrincipal.toLowerCase()) {
        return { error: "The connected Frappe account no longer matches this chat identity. Reconnect before continuing." };
      }
      return executeFrappeBusinessRead(context, auth, businessApi, actualPrincipal, requestedScope);
    }
    const { service } = frappeReadService(readModelPath);
    const querySignature = JSON.stringify({
      operation: "business_api",
      api: businessApi.id,
      method: businessApi.method,
      responsePath: businessApi.responsePath,
      params: businessApi.params,
      scope: requestedScope ?? null,
      date: Object.values(businessApi.params).includes("$today") ? new Date().toISOString().slice(0, 10) : null,
    });
    try {
      const resolved = await service.read({
        site: auth.siteUrl,
        principal: expectedPrincipal,
        querySignature,
        resolveIdentity: async () => resolveFrappePermissionEpoch(context, auth, expectedPrincipal),
        live: async () => {
          const value = await executeFrappeBusinessRead(context, auth, businessApi, expectedPrincipal, requestedScope);
          if ("error" in value) throw frappeReadError(value);
          return { site: auth.siteUrl, principal: expectedPrincipal, value };
        },
        ttlMs: 5_000,
      });
      return resolved.value;
    } catch (error) {
      return frappeReadServiceFailure(error);
    }
  }
  if (!readModelPath) {
    const actualPrincipal = await resolveAuthenticatedPrincipal(context, auth);
    if (typeof actualPrincipal !== "string") return actualPrincipal;
    const expectedPrincipal = argString(args, "user");
    if (expectedPrincipal && expectedPrincipal.toLowerCase() !== actualPrincipal.toLowerCase()) {
      return { error: "The connected Frappe account no longer matches this chat identity. Reconnect before continuing." };
    }
    const plan = await frappeListReadPlan(context, auth, actualPrincipal, doctype, query, argString(args, "prompt") ?? "", requestedScope);
    if ("error" in plan) return plan;
    return executeFrappeListRead(context, auth, doctype, plan.path, booleanArg(args.includeTotal) ? plan.countPath : undefined, plan.scope);
  }

  const includeTotal = booleanArg(args.includeTotal);
  const readPlan = explicitFields.length && !requestedScope && !includeTotal
    ? {
        path: `/api/resource/${encodeURIComponent(doctype)}?${query.toString()}`,
        countPath: undefined,
        scope: undefined,
      }
    : await frappeListReadPlan(
        context,
        auth,
        expectedPrincipal,
        doctype,
        query,
        argString(args, "prompt") ?? "",
        requestedScope,
        explicitFields,
      );
  if ("error" in readPlan) return readPlan;
  const { service } = frappeReadService(readModelPath);
  // Cache the compiled, permission-scoped read plan rather than user wording.
  // Paraphrases and site-specific aliases that resolve to the same query can
  // share a fresh result without caching generated answers.
  const querySignature = JSON.stringify({
    operation: "resource_list",
    doctype,
    path: readPlan.path,
    countPath: includeTotal ? readPlan.countPath ?? null : null,
    scope: readPlan.scope ?? null,
  });
  try {
    const resolved = await service.read({
      site: auth.siteUrl,
      principal: expectedPrincipal,
      querySignature,
      resolveIdentity: async () => resolveFrappePermissionEpoch(context, auth, expectedPrincipal),
      live: async (identity) => {
        const value = await executeFrappeListRead(
          context,
          auth,
          doctype,
          readPlan.path,
          includeTotal ? readPlan.countPath : undefined,
          readPlan.scope,
        );
        if ("error" in value) throw frappeReadError(value);
        return {
          site: auth.siteUrl,
          principal: expectedPrincipal,
          value,
          objectRefs: value.rows.flatMap((row) => {
            const name = recordString(row, "name");
            return name ? [`${doctype}:${name}`] : [];
          }),
        };
      },
      ttlMs: SENSITIVE_READ_DOCTYPES.has(doctype) ? 5_000 : 30_000,
      ...(SENSITIVE_READ_DOCTYPES.has(doctype)
        ? {}
        : { fallback: { mode: "stale_if_unavailable" as const, maxStaleMs: 30_000 } }),
    });
    return resolved.value;
  } catch (error) {
    return frappeReadServiceFailure(error);
  }
}

function selectFrappeBusinessApi(
  rawCatalog: string | undefined,
  prompt: string,
  doctype: string,
): FrappeBusinessApiSpec | undefined {
  if (!rawCatalog?.trim() || !prompt.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawCatalog);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const promptWords = normalizedBusinessWords(prompt);
  const normalizedPrompt = promptWords.join(" ");
  const candidates = parsed.flatMap((value): Array<{ readonly spec: FrappeBusinessApiSpec; readonly score: number }> => {
    const spec = parseFrappeBusinessApiSpec(value);
    if (!spec || spec.doctype.toLowerCase() !== doctype.toLowerCase()) return [];
    let score = 0;
    for (const phrase of spec.phrases) {
      const phraseWords = normalizedBusinessWords(phrase);
      if (!phraseWords.length) continue;
      if (normalizedPrompt.includes(phraseWords.join(" "))) score = Math.max(score, 200 + phraseWords.length);
      else if (phraseWords.every((word) => promptWords.includes(word))) score = Math.max(score, 100 + phraseWords.length);
    }
    return score ? [{ spec, score }] : [];
  }).sort((left, right) => right.score - left.score || left.spec.id.localeCompare(right.spec.id));
  if (candidates.length > 1 && candidates[0]?.score === candidates[1]?.score && candidates[0]?.spec.id !== candidates[1]?.spec.id) {
    return undefined;
  }
  return candidates[0]?.spec;
}

function parseFrappeBusinessApiSpec(value: unknown): FrappeBusinessApiSpec | undefined {
  const input = recordObject(value);
  if (!input || input.operation !== "read") return undefined;
  const id = recordString(input, "id");
  const doctype = recordString(input, "doctype");
  const method = recordString(input, "method");
  const responsePath = recordString(input, "responsePath");
  const phrases = Array.isArray(input.phrases)
    ? input.phrases.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
  if (!id || !doctype || !method || !responsePath || !phrases.length || !/^[A-Za-z0-9_.]+$/.test(method)) return undefined;
  const rawParams = recordObject(input.params) ?? {};
  const params: Record<string, "$employee" | "$user" | "$company" | "$today"> = {};
  for (const [key, source] of Object.entries(rawParams)) {
    if (/^[A-Za-z][A-Za-z0-9_]*$/.test(key) && (source === "$employee" || source === "$user" || source === "$company" || source === "$today")) params[key] = source;
  }
  const rawView = recordObject(input.view);
  const fields = Array.isArray(input.fields) ? input.fields.flatMap((field) => {
    const item = recordObject(field);
    const target = item ? recordString(item, "target") : undefined;
    const sources = item && Array.isArray(item.sources)
      ? item.sources.filter((source): source is string => typeof source === "string" && Boolean(source.trim()))
      : [];
    return target && /^[A-Za-z][A-Za-z0-9_]*$/.test(target) && sources.length ? [{ target, sources }] : [];
  }) : undefined;
  const resultLabel = recordString(input, "resultLabel");
  const title = rawView ? recordString(rawView, "title") : undefined;
  const summary = rawView ? recordString(rawView, "summary") : undefined;
  const emptyTitle = rawView ? recordString(rawView, "emptyTitle") : undefined;
  const emptySummary = rawView ? recordString(rawView, "emptySummary") : undefined;
  const columns = rawView && Array.isArray(rawView.columns) ? rawView.columns.flatMap((column) => {
    const item = recordObject(column);
    const field = item ? recordString(item, "field") : undefined;
    const label = item ? recordString(item, "label") : undefined;
    return field && label && /^[A-Za-z][A-Za-z0-9_]*$/.test(field) ? [{ field, label }] : [];
  }) : undefined;
  const rawIncludeWhen = recordObject(input.includeWhen);
  const includeField = rawIncludeWhen ? recordString(rawIncludeWhen, "field") : undefined;
  const includeEquals = rawIncludeWhen?.equals;
  const includeWhen = includeField
    && /^[A-Za-z][A-Za-z0-9_]*$/.test(includeField)
    && (typeof includeEquals === "string" || typeof includeEquals === "number" || typeof includeEquals === "boolean")
    ? { field: includeField, equals: includeEquals }
    : undefined;
  return {
    id,
    operation: "read",
    doctype,
    phrases,
    method,
    params,
    responsePath,
    ...(resultLabel ? { resultLabel } : {}),
    ...(title || summary || emptyTitle || emptySummary || columns?.length ? { view: {
      ...(title ? { title } : {}),
      ...(summary ? { summary } : {}),
      ...(emptyTitle ? { emptyTitle } : {}),
      ...(emptySummary ? { emptySummary } : {}),
      ...(columns?.length ? { columns } : {}),
    } } : {}),
    ...(includeWhen ? { includeWhen } : {}),
    ...(fields?.length ? { fields } : {}),
  };
}

async function executeFrappeBusinessRead(
  context: FrappeToolContext,
  auth: { readonly siteUrl: string; readonly auth: FrappeAuth },
  spec: FrappeBusinessApiSpec,
  principal: string,
  scope?: Record<string, unknown>,
): Promise<{ doctype: string; rows: unknown[]; count: number; scope: Record<string, unknown>; view?: FrappeBusinessApiSpec["view"] } | FrappeError> {
  const employee = recordString(scope, "employee");
  const params: Record<string, unknown> = {};
  for (const [name, source] of Object.entries(spec.params)) {
    if (source === "$employee") {
      if (!employee) return { error: "The connected Frappe account does not have an employee record available for this request." };
      params[name] = employee;
    } else if (source === "$user") params[name] = principal;
    else if (source === "$company") {
      const company = recordString(scope, "company");
      if (!company) return { error: "The connected Frappe account does not have a company available for this request." };
      params[name] = company;
    }
    else params[name] = new Date().toISOString().slice(0, 10);
  }
  const result = await frappeAuthedRequest(
    context.fetch!,
    auth.siteUrl,
    auth.auth,
    "POST",
    `/api/method/${spec.method}`,
    params,
  );
  if (!result.ok) return result;
  const applicationError = frappeBusinessApplicationError(result.data);
  if (applicationError) return { error: applicationError };
  const resolved = valueAtPath(result.data, spec.responsePath);
  if (resolved === undefined) {
    return { error: `Frappe API "${spec.id}" returned an unexpected response. No data was shown.` };
  }
  const values = (Array.isArray(resolved) ? resolved : resolved === undefined || resolved === null ? [] : [resolved])
    .filter((value) => {
      if (!spec.includeWhen) return true;
      return recordObject(value)?.[spec.includeWhen.field] === spec.includeWhen.equals;
    });
  const rows = values.map((value) => projectBusinessApiRow(value, spec.fields))
    .filter((row) => Object.values(row).some(hasRenderableBusinessValue));
  return {
    doctype: spec.resultLabel ?? spec.doctype,
    rows,
    count: rows.length,
    scope: { mode: "self", authority: "frappe_permissions", api: spec.id },
    ...(spec.view ? { view: spec.view } : {}),
  };
}

function hasRenderableBusinessValue(value: unknown): boolean {
  if (typeof value === "string") return Boolean(value.trim());
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some(hasRenderableBusinessValue);
  const record = recordObject(value);
  return record ? Object.values(record).some(hasRenderableBusinessValue) : false;
}

function frappeBusinessApplicationError(payload: Record<string, unknown>): string | undefined {
  const message = recordObject(payload.message);
  const failed = payload.success === false || message?.success === false;
  const status = String(payload.status ?? message?.status ?? "").toLowerCase();
  const error = recordString(payload, "error")
    ?? recordString(payload, "exception")
    ?? recordString(payload, "exc_type")
    ?? (message ? recordString(message, "error") ?? recordString(message, "exception") : undefined);
  if (!failed && status !== "error" && status !== "failed" && !error) return undefined;
  const detail = error?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
  return detail ? `Frappe could not complete this read: ${detail}` : "Frappe could not complete this read.";
}

function projectBusinessApiRow(value: unknown, fields: FrappeBusinessApiSpec["fields"]): Record<string, unknown> {
  const row = recordObject(value);
  if (!row) return { title: String(value) };
  if (!fields?.length) return row;
  const projected: Record<string, unknown> = {};
  for (const field of fields) {
    const source = field.sources.find((name) => row[name] !== undefined && row[name] !== null && String(row[name]).trim());
    if (source) projected[field.target] = row[source];
  }
  return projected;
}

function valueAtPath(value: unknown, path: string): unknown {
  return path.split(".").filter(Boolean).reduce<unknown>((current, key) => recordObject(current)?.[key], value);
}

function normalizedBusinessWords(value: string): string[] {
  const aliases: Readonly<Record<string, string>> = {
    chhutti: "leave",
    chhuttiya: "leave",
    chhuttiyan: "leave",
    chutti: "leave",
    chuttiya: "leave",
    chuttiyan: "leave",
    bacha: "balance",
    bache: "balance",
    bachi: "balance",
    left: "balance",
    remaining: "balance",
  };
  const filler = new Set([
    "a", "am", "are", "can", "could", "do", "does", "hai", "hain", "have", "how", "i", "is", "it",
    "kitna", "kitne", "kitni", "me", "mera", "mere", "meri", "mujhe", "my", "please", "show", "tell",
    "the", "to", "what", "would", "you",
  ]);
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean)
    .map((word) => aliases[word] ?? (word === "leaves" ? "leave" : word.endsWith("ies") ? `${word.slice(0, -3)}y` : word))
    .filter((word) => !filler.has(word));
}

function frappeReadService(path: string): { readonly service: FrappeReadService; readonly store: SqliteFrappeReadModel } {
  const existing = frappeReadServices.get(path);
  if (existing) return existing;
  const store = new SqliteFrappeReadModel(path);
  const entry = {
    store,
    service: new FrappeReadService({
      store,
      identityTtlMs: 10_000,
      queryTtlMs: 30_000,
      maxQueryTtlMs: 30_000,
      maxStaleMs: 30_000,
      maxConcurrency: 8,
      maxQueue: 128,
    }),
  };
  frappeReadServices.set(path, entry);
  return entry;
}

async function executeFrappeListRead(
  context: FrappeToolContext,
  auth: { readonly siteUrl: string; readonly auth: FrappeAuth },
  doctype: string,
  path: string,
  countPath?: string,
  scope?: Record<string, unknown>,
): Promise<{ doctype: string; rows: unknown[]; count: number; total?: number; scope?: Record<string, unknown> } | FrappeError> {
  let effectivePath = path;
  let result: FrappeCallResult | undefined;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    result = await frappeAuthedRequest(context.fetch!, auth.siteUrl, auth.auth, "GET", effectivePath);
    if (result.ok) break;
    const fallback = queryPathWithoutRejectedField(effectivePath, result);
    if (!fallback) return result;
    effectivePath = fallback;
  }
  if (!result || !result.ok) return result ?? { error: "Frappe read did not return a result." };
  const countResult = countPath
    ? await frappeAuthedRequest(context.fetch!, auth.siteUrl, auth.auth, "GET", countPath)
    : undefined;
  if (countResult && !countResult.ok) return countResult;
  const rows = Array.isArray(result.data.data) ? result.data.data : [];
  const totalValue = countResult?.data.message;
  const total = typeof totalValue === "number" && Number.isFinite(totalValue)
    ? totalValue
    : typeof totalValue === "string" && Number.isFinite(Number(totalValue))
      ? Number(totalValue)
      : undefined;
  return { doctype, rows, count: rows.length, ...(total !== undefined ? { total } : {}), ...(scope ? { scope } : {}) };
}

function queryPathWithoutRejectedField(path: string, error: FrappeError): string | undefined {
  if (error.status !== 417) return undefined;
  const match = /Field not permitted in query:\s*([A-Za-z0-9_]+)/i.exec(error.error);
  if (!match?.[1]) return undefined;
  const url = new URL(path, "https://muster.invalid");
  const fields = jsonStringArrayQuery(url.searchParams.get("fields"))
    .filter((field) => field !== match[1]);
  if (!fields.length) return undefined;
  url.searchParams.set("fields", JSON.stringify(fields));
  return `${url.pathname}${url.search}`;
}

async function frappeListReadPlan(
  context: FrappeToolContext,
  auth: { readonly siteUrl: string; readonly auth: FrappeAuth },
  principal: string,
  doctype: string,
  baseQuery: URLSearchParams,
  prompt: string,
  scopeInput?: Record<string, unknown>,
  explicitFields: readonly string[] = [],
): Promise<{ path: string; countPath: string; scope?: Record<string, unknown> } | FrappeError> {
  const standard = standardSelfScopedReadPlan(doctype, baseQuery, principal, prompt, scopeInput, explicitFields);
  if (standard) return standard;
  const metadata = await cachedEffectiveMetadata(context, auth, principal, doctype);
  if ("error" in metadata) {
    const fallback = new URLSearchParams(baseQuery);
    fallback.set("fields", JSON.stringify(explicitFields.length ? explicitFields : ["name", "modified"]));
    return {
      path: `/api/resource/${encodeURIComponent(doctype)}?${fallback.toString()}`,
      countPath: `/api/method/frappe.desk.reportview.get_count?${new URLSearchParams({
        doctype,
        fields: JSON.stringify(["name"]),
        filters: fallback.get("filters") ?? "[]",
        or_filters: fallback.get("or_filters") ?? "[]",
      }).toString()}`,
      ...(scopeInput ? { scope: { mode: recordString(scopeInput, "mode") ?? "none", authority: "frappe_permissions" } } : {}),
    };
  }
  const fields = explicitFields.length ? [...explicitFields] : effectiveReadProjection(metadata, prompt);
  const query = new URLSearchParams(baseQuery);
  query.set("fields", JSON.stringify(fields));
  const scope = permissionScopedReadQuery(metadata, principal, prompt, scopeInput);
  const existingFilters = jsonArrayQuery(query.get("filters"));
  const existingOrFilters = jsonArrayQuery(query.get("or_filters"));
  const filters = [...existingFilters, ...scope.filters];
  const orFilters = [...existingOrFilters, ...scope.orFilters];
  if (filters.length) query.set("filters", JSON.stringify(filters));
  else query.delete("filters");
  if (orFilters.length) query.set("or_filters", JSON.stringify(orFilters));
  else query.delete("or_filters");
  const countQuery = new URLSearchParams({
    doctype,
    fields: JSON.stringify(["name"]),
    filters: JSON.stringify(filters),
    or_filters: JSON.stringify(orFilters),
  });
  return {
    path: `/api/resource/${encodeURIComponent(doctype)}?${query.toString()}`,
    countPath: `/api/method/frappe.desk.reportview.get_count?${countQuery.toString()}`,
    ...(scope.summary ? { scope: scope.summary } : {}),
  };
}

function standardSelfScopedReadPlan(
  doctype: string,
  baseQuery: URLSearchParams,
  principal: string,
  prompt: string,
  scopeInput?: Record<string, unknown>,
  explicitFields: readonly string[] = [],
): { path: string; countPath: string; scope?: Record<string, unknown> } | undefined {
  if ((recordString(scopeInput, "mode") ?? "none") !== "self") return undefined;
  const employee = recordString(scopeInput, "employee");
  const normalized = doctype.toLowerCase();
  const fields = explicitFields.length
    ? [...explicitFields]
    : normalized === "todo"
      ? ["name", "description", "status", "priority", "reference_type", "reference_name", "date", "modified"]
      : normalized === "task"
        ? ["name", "subject", "status", "priority", "exp_start_date", "exp_end_date", "modified"]
        : normalized === "leave application"
          ? ["name", "leave_type", "status", "workflow_state", "from_date", "to_date", "employee", "employee_name", "modified"]
          : [];
  if (!fields.length) return undefined;
  const filters: unknown[][] = jsonArrayQuery(baseQuery.get("filters"));
  const orFilters: unknown[][] = jsonArrayQuery(baseQuery.get("or_filters"));
  const scopeSummary: Record<string, unknown> = { mode: "self", authority: "frappe_permissions", fastPath: "standard_frappe" };
  if (normalized === "todo") {
    filters.push(["allocated_to", "=", principal]);
    if (/\b(?:open|pending|todo|to do|to-do)\b/i.test(prompt)) filters.push(["status", "!=", "Closed"]);
    scopeSummary.identityField = "allocated_to";
  } else if (normalized === "task") {
    if (/\b(?:open|pending|active|incomplete)\b/i.test(prompt)) filters.push(["status", "not in", ["Completed", "Cancelled", "Canceled", "Closed"]]);
    orFilters.push(["owner", "=", principal], ["_assign", "like", `%${principal}%`]);
    scopeSummary.identityField = "owner_or_assignment";
  } else if (normalized === "leave application" && employee) {
    filters.push(["employee", "=", employee]);
    if (/\b(?:open|pending)\b/i.test(prompt)) filters.push(["status", "not in", ["Approved", "Rejected", "Cancelled", "Canceled"]]);
    scopeSummary.identityField = "employee";
  } else {
    return undefined;
  }
  const query = new URLSearchParams(baseQuery);
  query.set("fields", JSON.stringify([...new Set(fields)]));
  if (filters.length) query.set("filters", JSON.stringify(filters));
  else query.delete("filters");
  if (orFilters.length) query.set("or_filters", JSON.stringify(orFilters));
  else query.delete("or_filters");
  const countQuery = new URLSearchParams({
    doctype,
    fields: JSON.stringify(["name"]),
    filters: JSON.stringify(filters),
    or_filters: JSON.stringify(orFilters),
  });
  return {
    path: `/api/resource/${encodeURIComponent(doctype)}?${query.toString()}`,
    countPath: `/api/method/frappe.desk.reportview.get_count?${countQuery.toString()}`,
    scope: scopeSummary,
  };
}

async function cachedEffectiveMetadata(
  context: FrappeToolContext,
  auth: { readonly siteUrl: string; readonly auth: FrappeAuth },
  principal: string,
  doctype: string,
): Promise<FrappeEffectiveDocTypeMetadata | FrappeError> {
  const key = `${auth.siteUrl.replace(/\/$/, "").toLowerCase()}\0${principal.toLowerCase()}\0${doctype}`;
  const cached = frappeEffectiveMetadataCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const loaded = await loadFrappeEffectiveDocTypeMetadata(context, auth.siteUrl, auth.auth, doctype);
  if ("error" in loaded) return loaded;
  frappeEffectiveMetadataCache.set(key, { expiresAt: Date.now() + FRAPPE_EFFECTIVE_METADATA_TTL_MS, value: loaded });
  return loaded;
}

function effectiveReadProjection(metadata: FrappeEffectiveDocTypeMetadata, prompt: string): string[] {
  const promptTerms = new Set(prompt.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 3));
  const commonBusinessField = /^(?:title|subject|status|workflow_state|employee|employee_name|department|company|designation|reports_to|owner|assigned_to|priority|from_date|to_date|posting_date|transaction_date|attendance_date|leave_type|total|grand_total|amount|total_claimed_amount)$/;
  const excludedTypes = new Set([
    "Button", "Column Break", "Fold", "Geolocation", "Heading", "HTML", "Image", "Section Break", "Tab Break",
    "Table", "Table MultiSelect", "Password", "Code", "Text Editor", "Long Text", "Markdown Editor", "Signature",
  ]);
  const ranked = metadata.fields.flatMap((field): Array<{ readonly name: string; readonly score: number }> => {
    if (field.hidden || field.permlevel > 0 || excludedTypes.has(field.fieldtype ?? "")) return [];
    const fieldTerms = `${field.fieldname} ${field.label}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const promptMatch = fieldTerms.some((term) => promptTerms.has(term));
    const score = (promptMatch ? 160 : 0)
      + (field.inListView ? 100 : 0)
      + (field.inStandardFilter ? 70 : 0)
      + (field.searchIndex ? 45 : 0)
      + (commonBusinessField.test(field.fieldname) ? 40 : 0)
      + (field.reqd ? 15 : 0);
    return score > 0 ? [{ name: field.fieldname, score }] : [];
  }).sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
  return ["name", ...ranked.map((field) => field.name), "modified"]
    .filter((field, index, values) => values.indexOf(field) === index)
    .slice(0, 12);
}

function permissionScopedReadQuery(
  metadata: FrappeEffectiveDocTypeMetadata,
  principal: string,
  prompt: string,
  input: Record<string, unknown> | undefined,
): {
  readonly filters: unknown[][];
  readonly orFilters: unknown[][];
  readonly summary?: Record<string, unknown>;
} {
  const filters: unknown[][] = [];
  const orFilters: unknown[][] = [];
  const mode = recordString(input, "mode") ?? "none";
  const statusFilter = operationalStatusFilter(metadata, prompt);
  if (statusFilter) filters.push(statusFilter);
  if (mode !== "self") {
    return {
      filters,
      orFilters,
      ...(mode !== "none" ? { summary: { mode, authority: "frappe_permissions" } } : {}),
    };
  }

  const employee = recordString(input, "employee");
  const usableFields = metadata.fields.filter((field) => !field.hidden && field.permlevel === 0);
  const employeeField = employee
    ? usableFields
        .filter((field) => field.fieldtype === "Link" && field.options === "Employee")
        .sort((left, right) => identityFieldScore(right.fieldname, "employee") - identityFieldScore(left.fieldname, "employee"))[0]
    : undefined;
  if (employee && employeeField) {
    filters.push([employeeField.fieldname, "=", employee]);
    return {
      filters,
      orFilters,
      summary: { mode: "self", authority: "frappe_permissions", identityField: employeeField.fieldname },
    };
  }

  const userField = usableFields
    .filter((field) => field.fieldtype === "Link" && field.options === "User" && identityFieldScore(field.fieldname, "user") > 0)
    .sort((left, right) => identityFieldScore(right.fieldname, "user") - identityFieldScore(left.fieldname, "user"))[0];
  if (userField) {
    filters.push([userField.fieldname, "=", principal]);
    return {
      filters,
      orFilters,
      summary: { mode: "self", authority: "frappe_permissions", identityField: userField.fieldname },
    };
  }

  // Every Frappe record has owner and _assign columns. This fallback remains
  // permission-filtered by Frappe and avoids assuming a customer-specific field.
  orFilters.push(["owner", "=", principal], ["_assign", "like", `%${principal}%`]);
  return {
    filters,
    orFilters,
    summary: { mode: "self", authority: "frappe_permissions", identityField: "owner_or_assignment" },
  };
}

function identityFieldScore(fieldname: string, kind: "employee" | "user"): number {
  const normalized = fieldname.toLowerCase();
  if (kind === "employee") {
    if (normalized === "employee") return 100;
    if (/^(?:employee_id|employee_number|requested_for_employee)$/.test(normalized)) return 80;
    if (/(?:^|_)employee(?:_|$)/.test(normalized)) return 40;
    return 0;
  }
  if (/^(?:allocated_to|assigned_to|requested_by|raised_by|user|user_id)$/.test(normalized)) return 100;
  if (/(?:allocated|assigned|requested|raised|applicant|requestor|requester).*(?:user|to|by)$/.test(normalized)) return 60;
  return 0;
}

function operationalStatusFilter(metadata: FrappeEffectiveDocTypeMetadata, prompt: string): unknown[] | undefined {
  const requested = /\bopen\b/i.test(prompt) ? "open" : /\bpending\b/i.test(prompt) ? "pending" : undefined;
  if (!requested) return undefined;
  const statusField = metadata.fields.find((field) => field.fieldname === "status" && !field.hidden && field.permlevel === 0);
  if (!statusField) return undefined;
  const options = statusField.options?.split("\n").map((value) => value.trim()).filter(Boolean) ?? [];
  const exact = options.find((value) => value.toLowerCase() === requested);
  if (exact) return ["status", "=", exact];
  const terminal = options.filter((value) => /^(?:completed|cancelled|canceled|closed|rejected|resolved)$/i.test(value));
  return terminal.length ? ["status", "not in", terminal] : undefined;
}

function jsonArrayQuery(value: string | null): unknown[][] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is unknown[] => Array.isArray(item)) : [];
  } catch {
    return [];
  }
}

function jsonStringArrayQuery(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && item.length > 0)
      : [];
  } catch {
    return [];
  }
}

async function resolveAuthenticatedPrincipal(
  context: FrappeToolContext,
  auth: { readonly siteUrl: string; readonly auth: FrappeAuth },
): Promise<string | FrappeError> {
  const result = await frappeAuthedRequest(context.fetch!, auth.siteUrl, auth.auth, "GET", "/api/method/frappe.auth.get_logged_user");
  if (!result.ok) return result;
  const principal = typeof result.data.message === "string" ? result.data.message.trim() : "";
  return principal || { error: "The connected Frappe account did not return a user identity." };
}

async function resolveFrappePermissionEpoch(
  context: FrappeToolContext,
  auth: { readonly siteUrl: string; readonly auth: FrappeAuth },
  expectedPrincipal: string,
) {
  const resolvedPrincipal = await resolveAuthenticatedPrincipal(context, auth);
  if (typeof resolvedPrincipal !== "string") throw frappeReadError(resolvedPrincipal);
  if (resolvedPrincipal.toLowerCase() !== expectedPrincipal.toLowerCase()) {
    throw new FrappeReadServiceError(
      "identity_mismatch",
      "The connected Frappe account no longer matches this chat identity. Reconnect before continuing.",
    );
  }
  const [employee, roles] = await Promise.all([
    resolveEmployeeForUser(auth, context, resolvedPrincipal),
    resolveRolesForUser(auth, context, resolvedPrincipal),
  ]);
  if (employee && "error" in employee) throw frappeReadError(employee);
  if ("error" in roles) throw frappeReadError(roles);
  return computeFrappePermissionEpoch({
    site: auth.siteUrl,
    principal: resolvedPrincipal,
    roles: roles.roles,
    hierarchyInputs: employee ? [employee] : [],
  });
}

function frappeReadError(error: FrappeError): FrappeReadServiceError {
  const kind = error.status === 401
    ? "authentication_failed"
    : error.status === 403
      ? "permission_denied"
      : "unavailable";
  return new FrappeReadServiceError(kind, error.error, { cause: error });
}

function frappeReadServiceFailure(error: unknown): FrappeError {
  if (error instanceof FrappeReadServiceError) {
    const cause = error.cause;
    if (typeof cause === "object" && cause !== null && "error" in cause) return cause as FrappeError;
    if (error.kind === "overloaded") return { error: "The connected work system is busy. Please try again in a moment.", status: 503 };
    if (error.kind === "invalidated") return { error: "Your work data changed during this request. Please try once more.", status: 409 };
    return { error: error.message, status: error.kind === "permission_denied" ? 403 : error.kind === "authentication_failed" ? 401 : 503 };
  }
  return { error: error instanceof Error ? error.message : String(error), status: 503 };
}

/** Fetches Frappe's permission-filtered, customization-applied DocType metadata. */
export async function frappeEffectiveDocTypeMetadata(
  args: Record<string, unknown>,
  context: FrappeToolContext,
): Promise<FrappeEffectiveDocTypeMetadata | FrappeError> {
  const doctype = argString(args, "doctype");
  if (!doctype) return { error: 'Frappe effective metadata requires a "doctype" argument.' };
  const auth = await resolveRuntimeAuth(args, context);
  if ("error" in auth) return auth;
  return loadFrappeEffectiveDocTypeMetadata(context, auth.siteUrl, auth.auth, doctype);
}

/**
 * Return docs and module priors used by retrieval before hitting a live site.
 * This is intentionally generic: OxygenHR is just one custom app name in args.apps.
 */
export async function frappe_docs_context(
  args: Record<string, unknown>,
  _context: FrappeToolContext,
): Promise<{ apps: string[]; modules: FrappeModuleContext[]; docs: FrappeDocSource[]; retrievalPlan: string[] }> {
  const apps = stringList(args.apps);
  const modules = stringList(args.modules);
  const query = typeof args.query === "string" ? args.query : "";
  const selectedModules = selectModulePriors({ apps, modules, query });
  const installedDocs = apps
    .filter((app) => !["frappe", "erpnext", "hrms"].includes(app.toLowerCase()))
    .map((app): FrappeDocSource => ({
      label: `${app} installed app docs`,
      url: `apps/${app}/README.md`,
      scope: "installed-app",
    }));
  return {
    apps,
    modules: selectedModules,
    docs: uniqueDocs([...FRAPPE_DOCS, ...installedDocs, ...selectedModules.flatMap((module) => module.docs)]),
    retrievalPlan: [
      "Start with installed apps and sites/apps.txt or live version metadata.",
      "Index app README/docs plus each app's module tree before field-level memory.",
      "Index DocType, DocField, Custom Field, Property Setter, Workflow, Role Permission, Report, Print Format, Workspace, Client Script, and Server Script nodes.",
      "Create graph links: app -> module -> DocType -> fields/customizations/workflows/permissions/reports.",
      "Use scoped FTS for the seed, then graph-expand to linked module and field evidence.",
    ],
  };
}

export async function frappe_context_setup_plan(
  args: Record<string, unknown>,
  _context: FrappeToolContext,
): Promise<{ plugin: string; setupModes: string[]; fields: string[]; setupUrls: string[]; notes: string[]; next: string[] }> {
  const siteUrl = argString(args, "siteUrl") ?? "<your-frappe-site-url>";
  return {
    plugin: "frappe-federated-bridge",
    setupModes: ["recommended: siteUrl + API token", "one-time: siteUrl + adminUser + adminPassword"],
    fields: ["siteUrl", "apiToken", "adminUser", "adminPassword"],
    setupUrls: [
      `${siteUrl.replace(/\/$/, "")}/app/user`,
      "https://frappeframework.com/docs/user/en/api/rest",
      "https://docs.erpnext.com/",
      "https://frappeframework.com/docs",
    ],
    notes: [
      "Keep the main Muster binary light: this plugin owns Frappe/ERPNext context building.",
      "API token is preferred for repeatable use. Admin password mode is for a one-time context build and should not be stored.",
      "The context builder discovers installed apps/modules, then combines live metadata with Frappe, ERPNext, and Frappe Suite docs.",
      "Generated context should be indexed as scoped memory by tenant/site/user before agent runs use it.",
    ],
    next: [
      "Run plugin setup with site URL and token, or one-time admin credentials.",
      "Build installed context.",
      "Run module context for high-value modules such as Accounts, HR, Selling, Buying, Stock, CRM, or custom apps.",
      "Seed retrieval evals with module-specific DocType/field/workflow cases before relying on it in production.",
    ],
  };
}

/**
 * Live-site context: installed apps, workspaces/modules, plus docs and priors.
 * The method calls are read-only and tolerate permission-limited Frappe users.
 */
export async function frappe_installed_context(
  args: Record<string, unknown>,
  context: FrappeToolContext,
): Promise<{ site?: string; installedApps: string[]; modules: string[]; docs: FrappeDocSource[]; warnings: string[] } | FrappeError> {
  const warnings: string[] = [];
  const installedApps = new Set(stringList(args.apps));
  const modules = new Set(stringList(args.modules));

  const auth = await resolveRuntimeAuth(args, context);
  if ("error" in auth) return auth;

  const versions = await frappeAuthedRequest(context.fetch!, auth.siteUrl, auth.auth, "GET", "/api/method/frappe.utils.change_log.get_versions");
  if (versions.ok) {
    for (const app of extractInstalledApps(versions.data)) installedApps.add(app);
  } else {
    warnings.push(`versions unavailable: ${versions.error}`);
  }

  const workspaces = await frappeAuthedRequest(context.fetch!, auth.siteUrl, auth.auth, "GET", "/api/method/frappe.desk.desktop.get_workspace_sidebar_items");
  if (workspaces.ok) {
    for (const module of extractWorkspaceModules(workspaces.data)) modules.add(module);
  } else {
    warnings.push(`workspace modules unavailable: ${workspaces.error}`);
  }

  const docs = await frappe_docs_context({ apps: [...installedApps], modules: [...modules], query: args.query }, context);
  return {
    site: auth.siteUrl,
    installedApps: [...installedApps].sort(),
    modules: [...modules].sort(),
    docs: docs.docs,
    warnings,
  };
}

export async function frappe_context_build(
  args: Record<string, unknown>,
  context: FrappeToolContext,
): Promise<{
  site: string;
  authMode: "api_token" | "admin_login";
  installedApps: string[];
  modules: string[];
  docs: FrappeDocSource[];
  moduleContexts: Array<Awaited<ReturnType<typeof frappe_module_context>>>;
  indexPlan: string[];
  warnings: string[];
} | FrappeError> {
  const auth = await resolveRuntimeAuth(args, context);
  if ("error" in auth) return auth;
  const installed = await frappe_installed_context(args, context);
  if ("error" in installed) return installed;
  const requestedModules = stringList(args.modules);
  const modules = requestedModules.length ? requestedModules : installed.modules.slice(0, 8);
  const moduleContexts = [];
  for (const module of modules) {
    moduleContexts.push(await frappe_module_context({ ...args, module, siteUrl: auth.siteUrl }, context));
  }
  return {
    site: auth.siteUrl,
    authMode: auth.mode,
    installedApps: installed.installedApps,
    modules: installed.modules,
    docs: installed.docs,
    moduleContexts,
    indexPlan: [
      "Index site/app/module overview as scoped memory.",
      "Index Frappe/ERPNext/Frappe Suite docs URLs as retrieval sources, not prompt bulk.",
      "Index live DocType, DocField, Custom Field, Workflow, Permission, Report, Print Format, Workspace, Client Script, and Server Script nodes.",
      "Link nodes app -> module -> DocType -> child table/Link fields/customizations/workflows/permissions.",
      "Run retrieval eval seed-frappe-pack or module-specific fixtures before enabling graph expansion for production users.",
    ],
    warnings: installed.warnings,
  };
}

/**
 * Module-specific retrieval context for Frappe/ERPNext and installed suite apps.
 * Returns DocTypes when the paired user can read metadata; otherwise returns priors
 * plus exact diagnostics so the UI can guide setup instead of pretending context exists.
 */
export async function frappe_module_context(
  args: Record<string, unknown>,
  context: FrappeToolContext,
): Promise<{
  module: string;
  docs: FrappeDocSource[];
  priors: FrappeModuleContext[];
  doctypes: unknown[];
  customFields: unknown[];
  workflows: unknown[];
  warnings: string[];
} | FrappeError> {
  const module = typeof args.module === "string" && args.module.trim() ? args.module.trim() : "";
  if (!module) return { error: 'frappe_module_context requires a "module" argument.' };
  const warnings: string[] = [];
  const apps = stringList(args.apps);
  const docs = await frappe_docs_context({ apps, modules: [module], query: args.query }, context);
  const auth = await resolveRuntimeAuth(args, context);
  if ("error" in auth) {
    warnings.push(auth.error);
    return { module, docs: docs.docs, priors: docs.modules, doctypes: [], customFields: [], workflows: [], warnings };
  }
  const doctypes = await frappeList(context, auth.siteUrl, auth.auth, "DocType", ["name", "module", "custom", "istable"], [["module", "=", module]], 200, warnings);
  const moduleDoctypes = doctypes.flatMap((row) => recordString(row, "name") ?? []);
  const customFields = moduleDoctypes.length
    ? await frappeList(context, auth.siteUrl, auth.auth, "Custom Field", ["name", "dt", "fieldname", "fieldtype", "options"], [["dt", "in", moduleDoctypes]], 500, warnings)
    : [];
  const workflows = moduleDoctypes.length
    ? await frappeList(context, auth.siteUrl, auth.auth, "Workflow", ["name", "document_type", "is_active"], [["document_type", "in", moduleDoctypes]], 200, warnings)
    : [];
  return {
    module,
    docs: docs.docs,
    priors: docs.modules,
    doctypes,
    customFields,
    workflows,
    warnings,
  };
}

export async function frappe_site_induction(
  args: Record<string, unknown>,
  context: FrappeToolContext,
): Promise<FrappeSiteInduction | FrappeError> {
  const auth = await resolveRuntimeAuth(args, context);
  if ("error" in auth) return auth;
  const warnings: string[] = [];
  const identity = await frappeAuthedRequest(context.fetch!, auth.siteUrl, auth.auth, "GET", "/api/method/frappe.auth.get_logged_user");
  if (!identity.ok) warnings.push(`identity unavailable: ${identity.error}`);

  const versionsResult = await frappeAuthedRequest(context.fetch!, auth.siteUrl, auth.auth, "GET", "/api/method/frappe.utils.change_log.get_versions");
  const versions = versionsResult.ok ? extractAppVersions(versionsResult.data) : {};
  if (!versionsResult.ok) warnings.push(`versions unavailable: ${versionsResult.error}`);

  const workspaceResult = await frappeAuthedRequest(context.fetch!, auth.siteUrl, auth.auth, "GET", "/api/method/frappe.desk.desktop.get_workspace_sidebar_items");
  const workspaces = workspaceResult.ok ? uniqueSorted(extractWorkspaceModules(workspaceResult.data)) : [];
  if (!workspaceResult.ok) warnings.push(`workspaces unavailable: ${workspaceResult.error}`);

  const requestedModules = stringList(args.modules);
  const modules = uniqueSorted([...requestedModules, ...workspaces]);
  const requestedDoctypes = stringList(args.doctypes);
  const doctypeNames = requestedDoctypes.length ? requestedDoctypes : await discoverDoctypeNames(context, auth.siteUrl, auth.auth, modules, warnings);
  const doctypes: FrappeDocTypeIndex[] = [];
  const limit = positiveInteger(args.limit, 50);
  for (const doctype of doctypeNames.slice(0, limit)) {
    const resource = await frappeGetResource(context, auth.siteUrl, auth.auth, "DocType", doctype, warnings);
    if (resource) doctypes.push(normalizeDoctype(resource));
  }

  const customFields = await frappeList(context, auth.siteUrl, auth.auth, "Custom Field", ["name", "dt", "fieldname", "fieldtype", "label", "options"], [], 500, warnings);
  const propertySetters = await frappeList(context, auth.siteUrl, auth.auth, "Property Setter", ["name", "doc_type", "field_name", "property", "value"], [], 500, warnings);
  const workflows = await frappeList(context, auth.siteUrl, auth.auth, "Workflow", ["name", "document_type", "is_active", "states", "transitions"], [], 200, warnings);
  const reports = await frappeList(context, auth.siteUrl, auth.auth, "Report", ["name", "ref_doctype", "report_type", "module"], [], 200, warnings);
  const printFormats = await frappeList(context, auth.siteUrl, auth.auth, "Print Format", ["name", "doc_type", "module"], [], 200, warnings);
  const dashboards = await frappeList(context, auth.siteUrl, auth.auth, "Dashboard", ["name", "module"], [], 200, warnings);
  const clientScripts = await frappeList(context, auth.siteUrl, auth.auth, "Client Script", ["name", "dt", "enabled"], [], 200, warnings);
  const serverScripts = await frappeList(context, auth.siteUrl, auth.auth, "Server Script", ["name", "reference_doctype", "script_type", "disabled"], [], 200, warnings);
  const webForms = await frappeList(context, auth.siteUrl, auth.auth, "Web Form", ["name", "doc_type", "module"], [], 200, warnings);
  const notificationRules = await frappeList(context, auth.siteUrl, auth.auth, "Notification", ["name", "document_type", "enabled"], [], 200, warnings);
  const assignmentRules = await frappeList(context, auth.siteUrl, auth.auth, "Assignment Rule", ["name", "document_type", "disabled"], [], 200, warnings);
  const roleRows = await frappeList(context, auth.siteUrl, auth.auth, "Role", ["name"], [], 500, warnings);
  const roles = uniqueSorted(roleRows.flatMap((role) => recordString(role, "name") ?? []));
  const docs = await frappe_docs_context({ apps: Object.keys(versions), modules }, context);
  const permissions = flattenPermissions(doctypes);

  return {
    site: {
      url: auth.siteUrl,
      authMode: auth.mode,
      identity: { user: identity.ok && typeof identity.data.message === "string" ? identity.data.message : undefined },
      versions,
      installedApps: uniqueSorted(Object.keys(versions)),
    },
    modules,
    workspaces,
    doctypes,
    roles,
    permissions,
    workflows,
    reports,
    printFormats,
    dashboards,
    webForms,
    notificationRules,
    assignmentRules,
    customizations: {
      customFields,
      propertySetters,
      clientScripts,
      serverScripts,
    },
    docs: docs.docs,
    graph: buildFrappeGraph({
      site: auth.siteUrl,
      apps: Object.keys(versions),
      modules,
      doctypes,
      roles,
      workflows,
      reports,
      customFields,
      propertySetters,
    }),
    evidence: [
      "identity:get_logged_user",
      "versions:get_versions",
      "workspaces:get_workspace_sidebar_items",
      "metadata:DocType/Custom Field/Property Setter/Workflow/Report/Script",
    ],
    warnings,
  };
}

export async function frappe_query_classify(
  args: Record<string, unknown>,
  _context: FrappeToolContext,
): Promise<{
  prompt: string;
  primaryClass: FrappeQueryClass;
  classes: Array<{ readonly class: FrappeQueryClass; readonly confidence: number; readonly reason: string }>;
  retrievalStrategy: string[];
  memoryPolicy: { readonly recall: boolean; readonly reason: string; readonly candidateScopes: string[] };
  safeWriteRequired: boolean;
}> {
  const prompt = argString(args, "prompt") ?? argString(args, "query") ?? "";
  const primaryClass = classifyFrappePrompt(prompt);
  const classes = candidateClasses(prompt);
  const retrievalStrategy = retrievalStrategyFor(primaryClass);
  const memoryPolicy = memoryPolicyForPrompt(prompt, args);
  return {
    prompt,
    primaryClass,
    classes,
    retrievalStrategy,
    memoryPolicy,
    safeWriteRequired: primaryClass === "record_creation" || primaryClass === "record_update",
  };
}

export async function frappe_hybrid_retrieve(
  args: Record<string, unknown>,
  context: FrappeToolContext,
): Promise<{
  intent: FrappeQueryClass;
  allowedSiteScope: { readonly site?: string; readonly user?: string; readonly roles: string[] };
  candidateDocTypes: string[];
  candidateFields: Array<{ readonly doctype: string; readonly fieldname: string; readonly label?: string; readonly fieldtype?: string; readonly options?: string }>;
  relevantPermissions: Array<{ readonly doctype: string; readonly role: string; readonly permission: FrappePermissionName; readonly allowed: boolean }>;
  relevantWorkflows: unknown[];
  relevantReports: unknown[];
  relevantCustomizations: unknown[];
  docsReferences: FrappeDocSource[];
  safeActionOptions: string[];
  blockedPermissions: Array<{ readonly doctype: string; readonly permission: FrappePermissionName; readonly roles: string[] }>;
  memory: { readonly searched: boolean; readonly reason: string; readonly scopes: string[]; readonly hits: unknown[] };
  graphTrace: string[];
}> {
  const prompt = argString(args, "prompt") ?? argString(args, "query") ?? "";
  const classification = await frappe_query_classify({ prompt }, context);
  const induction = normalizeInductionArg(args.induction);
  const roles = stringList(args.roles);
  const candidateDoctypes = selectCandidateDoctypes(prompt, induction);
  const blockedPermissions: Array<{ doctype: string; permission: FrappePermissionName; roles: string[] }> = [];
  const allowedDoctypes = candidateDoctypes.filter((doctype) => {
    const allowed = fixturePermissionDecision(induction, doctype.name, "read", roles.length ? roles : ["All"]);
    if (!allowed.allowed) {
      blockedPermissions.push({ doctype: doctype.name, permission: "read", roles: roles.length ? roles : ["All"] });
      return false;
    }
    return true;
  });
  const allowedNames = new Set(allowedDoctypes.map((doctype) => doctype.name));
  const relevantPermissions = induction.permissions.filter((permission) => allowedNames.has(permission.doctype) || candidateDoctypes.some((doctype) => doctype.name === permission.doctype));
  const workflows = filterByDoctypeLike(induction.workflows, allowedNames, ["document_type", "doctype", "ref_doctype"]);
  const reports = filterByDoctypeLike(induction.reports, allowedNames, ["ref_doctype", "doctype", "doc_type"]);
  const customizations = [
    ...filterByDoctypeLike(induction.customizations.customFields, allowedNames, ["dt", "doctype", "doc_type"]),
    ...filterByDoctypeLike(induction.customizations.propertySetters, allowedNames, ["doc_type", "doctype", "dt"]),
    ...filterByDoctypeLike(induction.customizations.clientScripts, allowedNames, ["dt", "doctype", "doc_type"]),
    ...filterByDoctypeLike(induction.customizations.serverScripts, allowedNames, ["reference_doctype", "doctype", "doc_type"]),
  ];
  const memoryPolicy = memoryPolicyForPrompt(prompt, args);
  const memoryRows = Array.isArray(args.memory) ? args.memory : [];
  const memoryHits = memoryPolicy.recall ? memoryRows : [];
  return {
    intent: classification.primaryClass,
    allowedSiteScope: {
      site: induction.site.url,
      user: induction.site.identity.user,
      roles,
    },
    candidateDocTypes: allowedDoctypes.map((doctype) => doctype.name),
    candidateFields: allowedDoctypes.flatMap((doctype) => doctype.fields.map((field) => ({
      doctype: doctype.name,
      fieldname: field.fieldname,
      label: field.label,
      fieldtype: field.fieldtype,
      options: field.options,
    }))),
    relevantPermissions,
    relevantWorkflows: workflows,
    relevantReports: reports,
    relevantCustomizations: customizations,
    docsReferences: docsForIntent(classification.primaryClass, induction.docs),
    safeActionOptions: safeActionOptionsFor(classification.primaryClass, allowedDoctypes.map((doctype) => doctype.name)),
    blockedPermissions,
    memory: {
      searched: memoryPolicy.recall,
      reason: memoryPolicy.reason,
      scopes: memoryHits.flatMap((hit) => recordString(hit, "scope") ?? []),
      hits: memoryHits,
    },
    graphTrace: allowedDoctypes.flatMap((doctype) => [
      `site:${induction.site.url ?? "fixture"} -> doctype:${doctype.name}`,
      ...doctype.links.map((link) => `doctype:${doctype.name} -> link:${link.target}`),
      ...doctype.childTables.map((table) => `doctype:${doctype.name} -> child_table:${table.target}`),
    ]),
  };
}

export async function frappe_permission_check(
  args: Record<string, unknown>,
  context: FrappeToolContext,
): Promise<{
  doctype: string;
  permission: FrappePermissionName;
  allowed: boolean;
  matchedRoles: string[];
  deniedRoles: string[];
  source: "fixture" | "live";
  reason?: string;
} | FrappeError> {
  const doctype = argString(args, "doctype");
  if (!doctype) return { error: 'frappe_permission_check requires a "doctype" argument.' };
  const permission = permissionName(argString(args, "permission") ?? argString(args, "ptype") ?? "read");
  const roles = stringList(args.roles);
  if (args.induction !== undefined) {
    const induction = normalizeInductionArg(args.induction);
    const decision = fixturePermissionDecision(induction, doctype, permission, roles.length ? roles : ["All"]);
    return {
      doctype,
      permission,
      allowed: decision.allowed,
      matchedRoles: decision.matchedRoles,
      deniedRoles: decision.deniedRoles,
      source: "fixture",
    };
  }

  const auth = await resolveRuntimeAuth(args, context);
  if ("error" in auth) return auth;
  const preflight = await livePermissionPreflight(context, auth.siteUrl, auth.auth, doctype, permission, argString(args, "docname"));
  return {
    doctype,
    permission,
    allowed: preflight.allowed,
    matchedRoles: [],
    deniedRoles: preflight.allowed ? [] : roles,
    source: "live",
    reason: preflight.reason,
  };
}

export async function frappe_safe_write(
  args: Record<string, unknown>,
  context: FrappeToolContext,
): Promise<{
  status: "approval_required" | "denied" | "executed" | "reconciled";
  operation: "create" | "update" | "delete" | "submit" | "cancel" | "apply_workflow";
  doctype: string;
  preflight: { readonly allowed: boolean; readonly reason: string; readonly source: "frappe_api" };
  proposedMutation: { readonly operation: "create" | "update" | "delete" | "submit" | "cancel" | "apply_workflow"; readonly doctype: string; readonly docname?: string; readonly fields: string[]; readonly dryRun: boolean; readonly expectedModified?: string };
  approvalGate: { readonly required: boolean; readonly approved: boolean; readonly approvalNote?: string; readonly instruction: string };
  approvalProposal?: FrappeApprovalProposal;
  result?: { readonly created?: Record<string, unknown>; readonly updated?: Record<string, unknown>; readonly deleted?: boolean; readonly action?: string };
  verification?: { readonly verified: boolean; readonly fetched?: Record<string, unknown>; readonly reason?: string };
  evidenceLog: string[];
} | FrappeError> {
  const requestedOperation = argString(args, "operation") ?? "create";
  const supportedOperations = ["create", "update", "delete", "submit", "cancel", "apply_workflow"] as const;
  if (!supportedOperations.includes(requestedOperation as typeof supportedOperations[number])) {
    return { error: `frappe_safe_write does not support operation "${requestedOperation}".` };
  }
  const operation = requestedOperation as typeof supportedOperations[number];
  const doctype = argString(args, "doctype");
  if (!doctype) return { error: 'frappe_safe_write requires a "doctype" argument.' };
  const doc = args.doc;
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return { error: 'frappe_safe_write requires a "doc" object with proposed fields.' };
  }
  const docRecord = doc as Record<string, unknown>;
  const docname = argString(args, "docname");
  if (operation !== "create" && !docname) {
    return { error: `frappe_safe_write ${operation} requires a "docname" argument.` };
  }
  const expectedModified = argString(args, "expected_modified");
  const existingOperation = operation !== "create";
  if (existingOperation && !expectedModified) return { error: `frappe_safe_write ${operation} requires expected_modified from a live document read.` };
  const auth = await resolveRuntimeAuth(args, context);
  if ("error" in auth) return auth;
  const effectiveMetadata = await loadFrappeEffectiveDocTypeMetadata(context, auth.siteUrl, auth.auth, doctype);
  if ("error" in effectiveMetadata) return effectiveMetadata;
  const permission = operation === "create" ? "create" : operation === "delete" ? "delete" : operation === "submit" ? "submit" : operation === "cancel" ? "cancel" : "write";
  const evidenceLog = ["resolve_identity:ok", "effective_metadata:hydrated"];
  const preflightResult = await livePermissionPreflight(context, auth.siteUrl, auth.auth, doctype, permission, docname, effectiveMetadata);
  const preflight = {
    allowed: preflightResult.allowed,
    reason: preflightResult.reason,
    source: "frappe_api" as const,
  };
  evidenceLog.push(preflight.allowed ? "permission_preflight:allowed" : "permission_preflight:denied");
  const proposedMutation: {
    operation: "create" | "update" | "delete" | "submit" | "cancel" | "apply_workflow";
    doctype: string;
    docname?: string;
    fields: string[];
    dryRun: boolean;
    expectedModified?: string;
  } = {
    operation,
    doctype,
    ...(docname ? { docname } : {}),
    fields: Object.keys(docRecord).sort(),
    dryRun: true,
    ...(expectedModified ? { expectedModified } : {}),
  };
  let liveDoc: Record<string, unknown> | undefined;
  if (existingOperation) {
    const current = await frappeAuthedRequest(context.fetch!, auth.siteUrl, auth.auth, "GET", `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(docname!)}`);
    if (!current.ok) return current;
    liveDoc = recordObject(current.data.data);
    const modified = liveDoc && recordString(liveDoc, "modified");
    if (!modified) return { error: "Frappe returned no modified timestamp for the governed mutation." };
    if (modified !== expectedModified) return { error: `Frappe document changed since expected_modified (${expectedModified}); refresh and request approval again.` };
    if (operation === "apply_workflow") {
      const requestedAction = argString(args, "action");
      if (!requestedAction) return { error: "To move forward with this request, choose the workflow action you want to apply." };
      const transitionResult = await frappeAuthedRequest(
        context.fetch!,
        auth.siteUrl,
        auth.auth,
        "GET",
        `/api/method/frappe.model.workflow.get_transitions?${new URLSearchParams({
          doc: JSON.stringify({ doctype, name: docname }),
        }).toString()}`,
      );
      if (!transitionResult.ok) return transitionResult;
      const transitions = Array.isArray(transitionResult.data.message)
        ? transitionResult.data.message.map(recordObject).filter((row): row is Record<string, unknown> => Boolean(row))
        : [];
      const permitted = transitions.some((transition) => recordString(transition, "action") === requestedAction);
      if (!permitted) {
        const available = transitions.map((transition) => recordString(transition, "action")).filter((value): value is string => Boolean(value));
        return {
          error: available.length
            ? `That action is not available for this record right now. Available actions: ${available.join(", ")}.`
            : "No workflow action is available for this record under the current user's permissions.",
        };
      }
      evidenceLog.push("workflow_transition:allowed");
    }
  }
  if (operation === "create" || operation === "update") {
    const effectiveDocument = operation === "update" ? { ...(liveDoc ?? {}), ...docRecord } : docRecord;
    const missing = requiredFieldsFromEffectiveMetadata(effectiveMetadata, effectiveDocument)
      .filter((field) => !hasMeaningfulValue(effectiveDocument[field.fieldname]));
    if (missing.length) {
      return {
        error: `To move forward, provide the information still required for this request: ${missing.map((field) => field.label).join(", ")}.`,
      };
    }
  }
  const userResult = await frappeAuthedRequest(context.fetch!, auth.siteUrl, auth.auth, "GET", "/api/method/frappe.auth.get_logged_user");
  if (!userResult.ok) return userResult;
  const principal = typeof userResult.data.message === "string" ? userResult.data.message : "";
  if (!principal) return { error: "Frappe write approval could not resolve the authenticated principal." };
  const suppliedReceipt = normalizeApprovalReceipt(args.approvalReceipt);
  const approvalProposal = createFrappeApprovalProposal({
    site: auth.siteUrl,
    principal,
    operation,
    doctype,
    ...(proposedMutation.docname ? { docname: proposedMutation.docname } : {}),
    doc: { ...docRecord, ...(expectedModified ? { expected_modified: expectedModified } : {}), ...(operation === "apply_workflow" ? { workflow_action: argString(args, "action") ?? "" } : {}) },
    permissionEpoch: argString(args, "permissionEpoch") ?? `live-preflight:${stableHash([auth.siteUrl, principal, doctype, permission].join("|"))}`,
    schemaRevision: argString(args, "schemaRevision") ?? "live",
    dataRevision: argString(args, "dataRevision") ?? "live",
    issuedAt: suppliedReceipt?.proposal.issuedAt ?? new Date().toISOString(),
    ttlMs: Math.max(30_000, Math.min(positiveInteger(args.approvalTtlMs, 300_000), 600_000)),
    nonce: suppliedReceipt?.proposal.nonce ?? randomUUID(),
  });
  const signingKey = context.config.FRAPPE_APPROVAL_SIGNING_KEY ?? "";
  const approvalDecision = suppliedReceipt
    ? verifyFrappeApproval({ receipt: suppliedReceipt, expected: approvalProposal, signingKey })
    : { valid: false, reason: "A human-approved, mutation-bound receipt is required." };
  const approvalGate = {
    required: true,
    approved: approvalDecision.valid,
    approvalNote: argString(args, "approvalNote"),
    instruction: "Approve this exact proposal through the host UI, then pass its signed receipt. A bare approved=true flag is not accepted.",
  };

  if (!preflight.allowed) {
    return {
      status: "denied",
      operation,
      doctype,
      preflight,
      proposedMutation,
      approvalGate,
      approvalProposal,
      evidenceLog,
    };
  }
  if (!approvalGate.approved) {
    evidenceLog.push("dry_run:proposal_only");
    return {
      status: "approval_required",
      operation,
      doctype,
      preflight,
      proposedMutation,
      approvalGate,
      approvalProposal,
      evidenceLog,
    };
  }

  if (!suppliedReceipt) return { error: "Frappe write approval receipt is missing." };
  const readModelPath = context.config.FRAPPE_READ_MODEL_PATH;
  if (!readModelPath) return { error: "Frappe write execution requires FRAPPE_READ_MODEL_PATH so approval consumption is atomic and replay-safe." };
  const approvalStore = new SqliteFrappeReadModel(readModelPath);
  try {
    if (!approvalStore.consumeApproval(suppliedReceipt.proposal.proposalId, suppliedReceipt.signature)) {
      return { error: "Frappe approval receipt was already consumed; request a fresh approval." };
    }
  } finally {
    approvalStore.close();
  }
  evidenceLog.push("approval_binding:verified", "approval_receipt:consumed");

  const mutationPath = operation === "create"
    ? `/api/resource/${encodeURIComponent(doctype)}`
    : operation === "update" ? `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(proposedMutation.docname ?? "")}`
    : operation === "delete" ? `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(proposedMutation.docname ?? "")}`
    : `/api/method/${operation === "apply_workflow" ? "frappe.model.workflow.apply_workflow" : `frappe.client.${operation}`}`;
  const mutationBody = operation === "create" || operation === "update" ? docRecord
    : operation === "delete" ? undefined
    : operation === "apply_workflow" ? { doc: JSON.stringify({ doctype, name: docname, ...docRecord }), action: argString(args, "action") ?? "" }
    : { doc: JSON.stringify({ doctype, name: docname, ...docRecord }) };
  const mutation = await frappeAuthedRequest(context.fetch!, auth.siteUrl, auth.auth, operation === "create" ? "POST" : operation === "update" ? "PUT" : operation === "delete" ? "DELETE" : "POST", mutationPath, mutationBody, suppliedReceipt.proposal.proposalId);
  if (!mutation.ok) return mutation;
  evidenceLog.push("execute_mutation:ok");
  const returnedDoc = recordObject(mutation.data.data) ?? {};
  const createdOrUpdatedName = recordString(returnedDoc, "name") ?? proposedMutation.docname;
  let verification: { verified: boolean; fetched?: Record<string, unknown>; reason?: string };
  if (operation === "delete") {
    const deletedRead = await frappeAuthedRequest(context.fetch!, auth.siteUrl, auth.auth, "GET", `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(docname!)}`);
    const notFound = !deletedRead.ok && deletedRead.status === 404;
    verification = notFound ? { verified: true, fetched: { name: docname!, deleted: true } } : { verified: false, reason: deletedRead.ok ? "Deleted document is still readable." : `Delete verification expected 404, received ${deletedRead.status ?? "an error"}: ${deletedRead.error}` };
    evidenceLog.push(notFound ? "verify_delete:ok" : "verify_delete:failed");
  } else if (createdOrUpdatedName) {
    const fetched = await frappeAuthedRequest(context.fetch!, auth.siteUrl, auth.auth, "GET", `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(createdOrUpdatedName)}`);
    if (fetched.ok && recordObject(fetched.data.data)) {
      const fetchedDoc = recordObject(fetched.data.data)!;
      const expectedState = argString(args, "expected_state") ?? argString(args, "expected_status");
      const postcondition = Object.entries(docRecord).every(([key, value]) => JSON.stringify(fetchedDoc[key]) === JSON.stringify(value))
        && (!expectedState || fetchedDoc.workflow_state === expectedState || fetchedDoc.status === expectedState || fetchedDoc.docstatus === expectedState);
      verification = { verified: postcondition, fetched: fetchedDoc, ...(postcondition ? {} : { reason: "Frappe returned a document that does not satisfy the requested postcondition." }) };
      evidenceLog.push(postcondition ? "verify_result:ok" : "verify_result:failed");
    } else {
      verification = { verified: false, reason: fetched.ok ? "Frappe verification returned no document." : fetched.error };
      evidenceLog.push("verify_result:failed");
    }
  } else {
    verification = { verified: false, reason: "Frappe mutation returned no document name to verify." };
    evidenceLog.push("verify_result:failed");
  }

  const cachedReads = frappeReadServices.get(readModelPath);
  if (cachedReads) {
    cachedReads.service.invalidate({
      site: auth.siteUrl,
      permissionChanged: PERMISSION_AFFECTING_DOCTYPES.has(doctype),
    });
    evidenceLog.push("read_cache:invalidated");
  }
  if (METADATA_AFFECTING_DOCTYPES.has(doctype)) {
    const sitePrefix = `${auth.siteUrl.replace(/\/$/, "").toLowerCase()}\0`;
    for (const key of frappeEffectiveMetadataCache.keys()) {
      if (key.startsWith(sitePrefix)) frappeEffectiveMetadataCache.delete(key);
    }
    evidenceLog.push("effective_metadata_cache:invalidated");
  }

  return {
    status: "executed",
    operation,
    doctype,
    preflight,
    proposedMutation: { ...proposedMutation, dryRun: false },
    approvalGate,
    approvalProposal,
    result: operation === "create" ? { created: returnedDoc } : operation === "update" ? { updated: returnedDoc } : operation === "delete" ? { deleted: true } : { action: operation },
    verification,
    evidenceLog,
  };
}

export async function frappe_artifact_brief(
  args: Record<string, unknown>,
  context: FrappeToolContext,
): Promise<{
  id: string;
  title: string;
  format: string;
  mimeType: string;
  metadata: {
    site: string;
    user: string;
    doctypes: string[];
    permissionScope: unknown;
    prompt: string;
    dataQuery: unknown;
    mode: "fixture" | "live";
    generatedAt: string;
  };
  content: string;
  evidence: string[];
}> {
  const mode: "fixture" | "live" = argString(args, "mode") === "live" ? "live" : "fixture";
  const artifactType = argString(args, "artifactType") ?? "implementation_brief";
  const format = argString(args, "format") ?? "markdown";
  const site = argString(args, "site") ?? context.config.FRAPPE_SITE_URL ?? "fixture-site";
  const user = argString(args, "user") ?? "fixture-user";
  const prompt = argString(args, "prompt") ?? "";
  const doctypes = stringList(args.doctypes);
  const generatedAt = argString(args, "generatedAt") ?? new Date().toISOString();
  const output = argString(args, "output") ?? "No output body was supplied.";
  const metadata = {
    site,
    user,
    doctypes,
    permissionScope: args.permissionScope ?? {},
    prompt,
    dataQuery: args.dataQuery ?? {},
    mode,
    generatedAt,
  };
  return {
    id: stableArtifactId(site, user, prompt, generatedAt),
    title: `Frappe ${artifactType.replace(/_/g, " ")}`,
    format,
    mimeType: mimeTypeForArtifactFormat(format),
    metadata,
    content: [
      `# Frappe ${artifactType.replace(/_/g, " ")}`,
      "",
      `Site: ${site}`,
      `User: ${user}`,
      `DocTypes: ${doctypes.length ? doctypes.join(", ") : "not specified"}`,
      "",
      output,
    ].join("\n"),
    evidence: [
      `mode:${mode}`,
      `site:${site}`,
      `user:${user}`,
      `doctypes:${doctypes.join(",")}`,
      "permission_scope:attached",
      "prompt:attached",
      "output:attached",
    ],
  };
}

export async function frappe_read_model_plan(
  args: Record<string, unknown>,
  _context: FrappeToolContext,
): Promise<ReturnType<typeof frappeReadModelPlan>> {
  return frappeReadModelPlan(args);
}

export async function frappe_fast_route(
  args: Record<string, unknown>,
  context: FrappeToolContext,
): Promise<ReturnType<typeof frappeFastRoute> | FrappeError> {
  const prompt = argString(args, "prompt") ?? argString(args, "query");
  if (!prompt) return { error: 'frappe_fast_route requires a "prompt" or "query" argument.' };
  const site = argString(args, "site") ?? argString(args, "siteUrl");
  const indexed = indexedRouteContext(prompt, site, context.config.FRAPPE_READ_MODEL_PATH);
  return frappeFastRoute({
    prompt,
    site,
    user: argString(args, "user"),
    roles: stringList(args.roles),
    department: argString(args, "department"),
    channel: argString(args, "channel"),
    installedApps: uniqueSorted([...stringList(args.installedApps), ...indexed.installedApps]),
    heavyLifterApps: stringList(args.heavyLifterApps),
    hasFreshIndex: args.hasFreshIndex === undefined ? indexed.fresh : booleanArg(args.hasFreshIndex),
    hasLiveCredentials: booleanArg(args.hasLiveCredentials),
    allowedDoctypes: stringList(args.allowedDoctypes),
    aliases: [
      ...businessApiRouteAliases(context.config.FRAPPE_BUSINESS_API_CATALOG),
      ...indexed.aliases,
      ...semanticAliasesFromArgs(args.aliases),
    ],
  });
}

function businessApiRouteAliases(rawCatalog: string | undefined): FrappeSemanticAlias[] {
  if (!rawCatalog?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawCatalog);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((value): FrappeSemanticAlias[] => {
    const spec = parseFrappeBusinessApiSpec(value);
    if (!spec) return [];
    return spec.phrases.map((phrase) => ({
      phrase,
      canonical: spec.doctype,
      module: "Configured business API",
      confidence: 0.99,
      source: "admin_curated",
    }));
  });
}

const ROUTE_STOP_WORDS = new Set([
  "a", "an", "and", "are", "do", "for", "from", "have", "how", "i", "in", "is", "me", "my", "of", "on", "open", "please", "show", "the", "to", "what", "which", "with",
]);

function indexedRouteContext(
  prompt: string,
  site: string | undefined,
  path: string | undefined,
): { readonly fresh: boolean; readonly aliases: FrappeSemanticAlias[]; readonly installedApps: string[] } {
  if (!site || !path) return { fresh: false, aliases: [], installedApps: [] };
  try {
    const { store } = frappeReadService(path);
    const revision = store.getRevision(site.replace(/\/$/, "").toLowerCase());
    const observedAt = revision ? Date.parse(revision.observedAt) : Number.NaN;
    const fresh = Number.isFinite(observedAt) && Date.now() - observedAt <= 15 * 60_000;
    if (!fresh) return { fresh: false, aliases: [], installedApps: [] };
    const terms = [...new Set(prompt.toLowerCase().match(/[a-z0-9][a-z0-9_-]+/g) ?? [])]
      .filter((term) => term.length > 2 && !ROUTE_STOP_WORDS.has(term))
      .slice(0, 8);
    const scores = new Map<string, { score: number; module: string; phrase: string }>();
    for (const term of terms) {
      for (const record of store.searchIndex(site, term, ["doctype", "field", "custom_field", "property_setter", "report", "funnel", "flow_config", "dynamic_assignment"], 40)) {
        const doctype = indexedRecordDoctype(record);
        if (!doctype) continue;
        const weight = indexedRouteEvidence(record, term, doctype);
        const current = scores.get(doctype);
        // Repetition is not authority. A large customized DocType may contain
        // the same business noun hundreds of times; only its strongest piece
        // of semantic evidence should count for a term.
        if (!current || weight > current.score) {
          scores.set(doctype, {
            score: weight,
            module: record.module ?? current?.module ?? "Custom",
            phrase: term,
          });
        }
      }
    }
    const aliases = [...scores.entries()]
      .sort(([leftName, left], [rightName, right]) => right.score - left.score || leftName.localeCompare(rightName))
      .slice(0, 12)
      .map(([canonical, value]): FrappeSemanticAlias => ({
        phrase: value.phrase,
        canonical,
        module: value.module,
        confidence: Math.min(0.99, 0.55 + value.score / 180),
        source: "site_usage",
      }));
    const installedApps = store.searchIndex(site, "", ["app"], 100)
      .flatMap((record) => record.label ?? (typeof record.payload.name === "string" ? record.payload.name : []));
    return { fresh, aliases, installedApps: uniqueSorted(installedApps) };
  } catch {
    return { fresh: false, aliases: [], installedApps: [] };
  }
}

function indexedRecordDoctype(record: FrappeIndexRecord): string | undefined {
  if (record.kind === "doctype") return record.objectId;
  if (record.kind === "funnel") return "Funnel";
  if (record.kind === "flow_config") return "Flow Config";
  const payload = record.payload;
  for (const key of ["dt", "doc_type", "document_type", "ref_doctype", "doctype", "parent"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return record.doctype?.trim() || undefined;
}

function indexedRouteWeight(kind: FrappeIndexRecord["kind"]): number {
  if (kind === "doctype") return 30;
  if (kind === "custom_field" || kind === "property_setter") return 16;
  if (kind === "dynamic_assignment" || kind === "flow_config") return 14;
  if (kind === "field" || kind === "report") return 10;
  return 6;
}

function indexedRouteEvidence(record: FrappeIndexRecord, term: string, doctype: string): number {
  const normalizedTerm = lexicalKey(term);
  const objectId = lexicalKey(record.objectId);
  const label = lexicalKey(record.label ?? "");
  const target = lexicalKey(doctype);
  const payloadField = lexicalKey(
    typeof record.payload.fieldname === "string"
      ? record.payload.fieldname
      : typeof record.payload.name === "string"
        ? record.payload.name
        : "",
  );
  const exact = (value: string): boolean => value === normalizedTerm || singularKey(value) === singularKey(normalizedTerm);
  const tokenMatch = (value: string): boolean => value.split(" ").some((token) => exact(token));
  return indexedRouteWeight(record.kind)
    + (record.kind === "doctype" && exact(objectId) ? 120 : 0)
    + (exact(target) ? 100 : 0)
    + (exact(label) ? 90 : tokenMatch(label) ? 35 : 0)
    + (exact(payloadField) ? 60 : 0);
}

function lexicalKey(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, " ").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function singularKey(value: string): string {
  return value.endsWith("ies") ? `${value.slice(0, -3)}y` : value.endsWith("s") && !value.endsWith("ss") ? value.slice(0, -1) : value;
}

const SEMANTIC_ALIAS_SOURCES: readonly FrappeSemanticAlias["source"][] = [
  "erpnext_prior",
  "site_usage",
  "admin_curated",
  "field_label",
  "report_name",
];

/**
 * Site-specific vocabulary is authoritative for disambiguation, so it must reach
 * the router. Callers (gateway/read service) pass discovered aliases as plain
 * objects; coerce them into typed FrappeSemanticAlias entries and drop anything
 * that lacks a real phrase/canonical pair.
 */
function semanticAliasesFromArgs(value: unknown): FrappeSemanticAlias[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): FrappeSemanticAlias[] => {
    const row = recordObject(item);
    if (!row) return [];
    const phrase = recordString(row, "phrase");
    const canonical = recordString(row, "canonical") ?? recordString(row, "doctype");
    if (!phrase || !canonical) return [];
    const confidence = numberLike(row.confidence);
    const source = recordString(row, "source");
    return [{
      phrase,
      canonical,
      module: recordString(row, "module") ?? "",
      confidence: confidence !== undefined && confidence >= 0 && confidence <= 1 ? confidence : 0.85,
      source: SEMANTIC_ALIAS_SOURCES.includes(source as FrappeSemanticAlias["source"])
        ? source as FrappeSemanticAlias["source"]
        : "admin_curated",
    }];
  });
}

export async function frappe_chat_interaction_plan(
  args: Record<string, unknown>,
  context: FrappeToolContext,
): Promise<FrappeInteractionPlan | FrappeError> {
  const prompt = argString(args, "prompt") ?? argString(args, "query") ?? "";
  if (!prompt) return { error: 'frappe_chat_interaction_plan requires a "prompt" or "query" argument.' };
  const siteUrl = argString(args, "site") ?? argString(args, "siteUrl") ?? argString(args, "frappeSiteUrl") ?? "";
  const doctype = inferDoctype(prompt, args);
  const requestedOperation = argString(args, "operation");
  const operation = requestedOperation && ["read", "create", "update", "submit", "approve", "reject"].includes(requestedOperation)
    ? requestedOperation as FrappeInteractionPlan["operation"]
    : inferOperation(prompt);
  const supplied = recordObject(args.values) ?? recordObject(args.doc) ?? {};
  const documentLinks = documentLinksForInteraction(siteUrl, args);

  if (booleanArg(args.blocked)) {
    return {
      kind: "blocked",
      title: `Cannot ${operationLabel(operation)} ${doctype}`,
      message: "I cannot move forward with this request yet.",
      reason: argString(args, "reason") ?? "The current Frappe permission, workflow, or validation state does not allow this action.",
      doctype,
      operation,
      requiredFields: [],
      documentLinks,
      next: [
        { label: "Show reason", detail: "Explain the permission, workflow, or validation blocker" },
        { label: "Open related document", detail: "Open the Frappe record if you have access" },
        { label: "Choose another action", detail: "Try a read-only summary, export, or request approval" },
      ],
      renderHints: defaultRenderHints(),
      safety: safetyFor(operation),
    };
  }

  let requiredFields: FrappeInteractionPlan["requiredFields"] = [];
  if (operation !== "read") {
    const metadata = await frappeEffectiveDocTypeMetadata({ ...args, doctype }, context);
    if ("error" in metadata) return metadata;
    requiredFields = requiredFieldsFromEffectiveMetadata(metadata, supplied)
      .filter((field) => !hasMeaningfulValue(supplied[field.fieldname]));
  }

  if (operation !== "read" && requiredFields.length) {
    return {
      kind: "guided_crud",
      title: `${operationTitle(operation)} ${doctype}`,
      message: "I can help with this. I will ask only for the information still needed, explain why it matters, and show you a review before anything changes.",
      doctype,
      operation,
      requiredFields,
      documentLinks,
      next: [
        { label: "Provide missing details", detail: requiredFields.map((field) => field.label).join(", ") },
        { label: "Preview before submitting", detail: "I will show the exact document fields before any write action" },
        { label: "Cancel", detail: "Stop this request without changing Frappe" },
      ],
      renderHints: defaultRenderHints(),
      safety: safetyFor(operation),
    };
  }

  if (operation !== "read") {
    return {
      kind: "guided_crud",
      title: `Review ${doctype}`,
      message: "I have the required details. I will show exactly what will change and ask for confirmation before saving it.",
      doctype,
      operation,
      requiredFields: [],
      table: {
        columns: ["Field", "Value"],
        rows: Object.entries(supplied).map(([key, value]) => [humanizeField(key), String(value)]),
      },
      documentLinks,
      next: [
        { label: "Submit", detail: "Run the permission preflight, then create or update the document" },
        { label: "Edit details", detail: "Change one of the fields before submitting" },
        { label: "Cancel", detail: "Stop this request without changing Frappe" },
      ],
      renderHints: defaultRenderHints(),
      safety: safetyFor(operation),
    };
  }

  return {
    kind: "table_result",
    title: reportTitleFor(prompt, doctype),
    message: "I can show this as a table with filters, drilldowns, exports, and Frappe document links where records are available.",
    doctype,
    operation,
    requiredFields: [],
    table: sampleOrProvidedTable(args),
    documentLinks,
    next: [
      { label: "Filter", detail: "Date range, department, employee, status, owner, company, branch" },
      { label: "Group", detail: "Department, manager, status, month, workflow state" },
      { label: "Sort", detail: "Newest, oldest, highest amount, pending first, exception first" },
      { label: "Export", detail: "Excel, PDF, or report pack when allowed" },
      { label: "Open in Frappe", detail: "Open the underlying document or list view" },
    ],
    renderHints: defaultRenderHints(),
    safety: safetyFor(operation),
  };
}

export async function frappe_enterprise_contract(
  _args: Record<string, unknown>,
  _context: FrappeToolContext,
): Promise<{
  postgres: typeof FRAPPE_POSTGRES_DEPLOYMENT_CONTRACT;
  zeroAppResources: typeof FRAPPE_ZERO_APP_RESOURCE_SPECS;
  profileSchemaVersion: 1;
}> {
  return {
    postgres: FRAPPE_POSTGRES_DEPLOYMENT_CONTRACT,
    zeroAppResources: FRAPPE_ZERO_APP_RESOURCE_SPECS,
    profileSchemaVersion: 1,
  };
}

const DEFAULT_OPERATIONAL_DOCTYPES = [
  "Employee",
  "Leave Application",
  "Leave Allocation",
  "Attendance",
  "Attendance Request",
  "Employee Checkin",
  "Expense Claim",
  "Salary Slip",
  "Task",
  "ToDo",
  "Issue",
  "HD Ticket",
  "Project",
  "Job Applicant",
  "Job Opening",
  "Purchase Order",
  "Purchase Invoice",
  "Sales Order",
  "Sales Invoice",
] as const;

/**
 * Refresh the metadata-only enterprise index used for routing and form
 * planning. Record reads and writes never use this shared snapshot for
 * authorization; they continue through the current sender's OAuth grant.
 */
export async function frappe_enterprise_sync(
  args: Record<string, unknown>,
  context: FrappeToolContext,
): Promise<Record<string, unknown> | FrappeError> {
  const auth = await resolveRuntimeAuth(args, context);
  if ("error" in auth) return auth;
  if (auth.auth.kind !== "token") return { error: "Frappe enterprise sync requires an OAuth or API token; session cookies are not persisted or reused." };
  const readModelPath = argString(args, "readModelPath") ?? context.config.FRAPPE_READ_MODEL_PATH;
  if (!readModelPath) return configError("FRAPPE_READ_MODEL_PATH");
  const priorityDoctypes = uniqueSorted([...DEFAULT_OPERATIONAL_DOCTYPES, ...stringList(args.doctypes)]);
  const maxHydratedDoctypes = Math.max(1, Math.min(positiveInteger(args.maxHydratedDoctypes, 64), 256));
  const signal = args.signal && typeof args.signal === "object" && "aborted" in args.signal
    ? args.signal as AbortSignal
    : undefined;
  const store = new SqliteFrappeReadModel(readModelPath);
  try {
    const normalizedSite = auth.siteUrl.replace(/\/$/, "").toLowerCase();
    const previous = store.getRevision(normalizedSite);
    const full = booleanArg(args.full) || !previous;
    const result = await pollFrappeEnterpriseSnapshot({
      site: auth.siteUrl,
      fetch: context.fetch!,
      ...(signal ? { signal } : {}),
      ...(!full && previous ? { modifiedAfter: previous.observedAt } : {}),
      authorization: authorizationHeader(auth.auth.value),
      pageSize: Math.max(1, Math.min(positiveInteger(args.pageSize, 500), 500)),
      hydrateDoctypes: "priority",
      priorityDoctypes,
      maxHydratedDoctypes,
    });
    const deltaRecords = full ? [] : buildFrappeIndexRecords(result.snapshot);
    const revision = full
      ? store.replaceSnapshot(result.snapshot)
      : {
          site: normalizedSite,
          schemaRevision: deltaRecords.length
            ? createHash("sha256").update(`${previous!.schemaRevision}:${result.snapshot.schemaRevision ?? "delta"}`).digest("hex")
            : previous!.schemaRevision,
          dataRevision: previous!.dataRevision,
          observedAt: result.snapshot.observedAt,
        };
    if (!full) {
      if (deltaRecords.length) {
        store.upsertIndex(deltaRecords);
        store.invalidateSiteCache(normalizedSite);
      }
      store.setRevision(revision);
    }
      const count = (value: readonly unknown[] | undefined): number => value?.length ?? 0;
      const hydrated = (result.snapshot.doctypes ?? []).filter((value) => Array.isArray(recordObject(value)?.fields)).length;
      return {
        status: "ready",
        mode: full ? "full" : "delta",
        changedRecords: full ? undefined : deltaRecords.length,
        site: revision.site,
        observedAt: revision.observedAt,
        schemaRevision: revision.schemaRevision,
        dataRevision: revision.dataRevision,
        requests: result.requests,
        hydratedDoctypes: hydrated,
        counts: {
          apps: count(result.snapshot.apps),
          modules: count(result.snapshot.modules),
          doctypes: count(result.snapshot.doctypes),
          customFields: count(result.snapshot.customFields),
          propertySetters: count(result.snapshot.propertySetters),
          permissionRules: count(result.snapshot.permissionRules),
          reports: count(result.snapshot.reports),
          funnels: count(result.snapshot.funnels),
          flowConfigs: count(result.snapshot.flowConfigs),
          dynamicAssignments: count(result.snapshot.dynamicAssignments),
        },
        warnings: result.warnings.slice(0, 100),
      };
  } catch (error) {
    return { error: `Frappe enterprise metadata sync failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    store.close();
  }
}

export async function frappe_customer_profile_validate(
  args: Record<string, unknown>,
  _context: FrappeToolContext,
): Promise<ReturnType<typeof validateFrappeCustomerProfile>> {
  return validateFrappeCustomerProfile(args.profile ?? args);
}

export async function frappe_hierarchy_scope(
  args: Record<string, unknown>,
  _context: FrappeToolContext,
): Promise<ReturnType<typeof deriveFrappeHierarchyScope> | FrappeError> {
  const principal = argString(args, "principal") ?? argString(args, "user");
  if (!principal) return { error: 'frappe_hierarchy_scope requires a "principal" argument.' };
  const config = recordObject(args.config);
  if (!config) return { error: 'frappe_hierarchy_scope requires a data-driven "config" object.' };
  const rows: Array<Record<string, unknown>> = Array.isArray(args.rows)
    ? args.rows.flatMap((row): Array<Record<string, unknown>> => {
      const record = recordObject(row);
      return record ? [record] : [];
    })
    : [];
  try {
    return deriveFrappeHierarchyScope(principal, config as unknown as FrappeHierarchyConfig, rows);
  } catch (error) {
    return { error: `Frappe hierarchy scope could not be derived: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Loader entrypoint contract: tools record, registered as frappe-federated-bridge__<name>. */
export const tools = {
  frappe_identity_resolve,
  frappe_user_identity_resolve,
  frappe_semantic_data_resolve_lite,
  frappe_docs_context,
  frappe_context_setup_plan,
  frappe_context_build,
  frappe_installed_context,
  frappe_module_context,
  frappe_site_induction,
  frappe_query_classify,
  frappe_hybrid_retrieve,
  frappe_read_model_plan,
  frappe_fast_route,
  frappe_chat_interaction_plan,
  frappe_permission_check,
  frappe_safe_write,
  frappe_artifact_brief,
  frappe_enterprise_contract,
  frappe_enterprise_sync,
  frappe_customer_profile_validate,
  frappe_hierarchy_scope,
};

function inferDoctype(prompt: string, args: Record<string, unknown>): string {
  const explicit = argString(args, "doctype") ?? argString(args, "resolvedDoctype");
  if (explicit) return explicit;
  const lower = prompt.toLowerCase();
  const aliases = Array.isArray(args.aliases) ? args.aliases : [];
  for (const alias of aliases) {
    const row = recordObject(alias);
    const phrase = row ? recordString(row, "phrase") : undefined;
    const doctype = row ? recordString(row, "doctype") : undefined;
    if (phrase && doctype && lower.includes(phrase.toLowerCase())) return doctype;
  }
  return "Frappe Document";
}

function inferOperation(prompt: string): FrappeInteractionPlan["operation"] {
  const lower = prompt.toLowerCase();
  if (/\b(apply|create|raise|make|add|submit)\b/.test(lower)) return "create";
  if (/\b(update|change|modify|edit)\b/.test(lower)) return "update";
  if (/\bapprove\b/.test(lower)) return "approve";
  if (/\breject\b/.test(lower)) return "reject";
  return "read";
}

function documentLinksForInteraction(siteUrl: string, args: Record<string, unknown>): Array<{ label: string; doctype: string; name: string; url: string }> {
  const docs = Array.isArray(args.documents) ? args.documents : [];
  const fromDocs = docs.flatMap((doc) => {
    const row = recordObject(doc);
    if (!row) return [];
    const doctype = recordString(row, "doctype") ?? recordString(row, "docType");
    const name = recordString(row, "name") ?? recordString(row, "docname");
    if (!siteUrl || !doctype || !name) return [];
    return [{ label: `${doctype} ${name}`, doctype, name, url: frappeDeskUrl(siteUrl, doctype, name) }];
  });
  const doctype = argString(args, "doctype");
  const docname = argString(args, "docname") ?? argString(args, "name");
  if (siteUrl && doctype && docname) return [...fromDocs, { label: `${doctype} ${docname}`, doctype, name: docname, url: frappeDeskUrl(siteUrl, doctype, docname) }];
  return fromDocs;
}

function frappeDeskUrl(siteUrl: string, doctype: string, name: string): string {
  return `${siteUrl.replace(/\/$/, "")}/app/${slugifyDoctype(doctype)}/${encodeURIComponent(name)}`;
}

function slugifyDoctype(doctype: string): string {
  return doctype.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function operationLabel(operation: FrappeInteractionPlan["operation"]): string {
  switch (operation) {
    case "create": return "create";
    case "update": return "update";
    case "submit": return "submit";
    case "approve": return "approve";
    case "reject": return "reject";
    case "read": return "read";
    default: return "process";
  }
}

function operationTitle(operation: FrappeInteractionPlan["operation"]): string {
  return operation === "create" ? "Create" : operation === "update" ? "Update" : operation === "approve" ? "Approve" : operation === "reject" ? "Reject" : "Open";
}

function safetyFor(operation: FrappeInteractionPlan["operation"]): FrappeInteractionPlan["safety"] {
  const write = operation !== "read";
  return { permissionCheckRequired: true, previewBeforeWrite: write, approvalRequired: write };
}

function defaultRenderHints(): FrappeInteractionPlan["renderHints"] {
  return {
    phone: "native_buttons_when_available",
    desktop: "clickable_table",
    tui: "arrow_selectable",
  };
}

function sampleOrProvidedTable(args: Record<string, unknown>): FrappeInteractionPlan["table"] {
  const table = recordObject(args.table);
  const columns = Array.isArray(table?.columns) ? table.columns.map(String) : ["No", "Item", "Action"];
  const rows = Array.isArray(table?.rows)
    ? table.rows.map((row) => Array.isArray(row) ? row.map(String) : [String(row)])
    : [["1", "Matching records", "Filter, open, export, or ask a follow-up"]];
  return { columns, rows };
}

function reportTitleFor(prompt: string, doctype: string): string {
  const lower = prompt.toLowerCase();
  if (lower.includes("pending")) return `Pending ${doctype}`;
  if (lower.includes("usage")) return `${doctype} Usage`;
  if (lower.includes("summary")) return `${doctype} Summary`;
  return `${doctype} Results`;
}

function humanizeField(fieldname: string): string {
  return fieldname.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function booleanish(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true" || value === "Yes" || value === "yes";
}

function hasMeaningfulValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

function modulePrior(module: string, apps: string[], doctypes: string[], concepts: string[]): FrappeModuleContext {
  const slug = module.toLowerCase().replace(/\s+/g, "-");
  return {
    module,
    apps,
    docs: [
      { label: `${module} module docs`, url: `https://docs.erpnext.com/docs/user/manual/en/${slug}`, scope: "module" },
    ],
    concepts,
    retrievalHints: [
      ...doctypes.map((doctype) => `DocType:${doctype}`),
      ...concepts.map((concept) => `concept:${concept}`),
    ],
  };
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

async function resolveEmployeeForUser(
  auth: { readonly siteUrl: string; readonly auth: FrappeAuth },
  context: FrappeToolContext,
  user: string,
): Promise<FrappeResolvedIdentity["employee"] | FrappeError | undefined> {
  const fields = ["name", "employee_name", "department", "company", "designation", "status"];
  const query = new URLSearchParams({
    fields: JSON.stringify(fields),
    filters: JSON.stringify([["user_id", "=", user]]),
    limit_page_length: "1",
  });
  const result = await frappeAuthedRequest(context.fetch!, auth.siteUrl, auth.auth, "GET", `/api/resource/Employee?${query.toString()}`);
  if (!result.ok) {
    if (result.status === 403) return undefined;
    return result;
  }
  const rows = Array.isArray(result.data.data) ? result.data.data : [];
  const first = recordObject(rows[0]);
  if (!first) return undefined;
  const name = recordString(first, "name");
  if (!name) return undefined;
  return {
    name,
    employeeName: recordString(first, "employee_name"),
    department: recordString(first, "department"),
    company: recordString(first, "company"),
    designation: recordString(first, "designation"),
    status: recordString(first, "status"),
  };
}

async function resolveRolesForUser(
  auth: { readonly siteUrl: string; readonly auth: FrappeAuth },
  context: FrappeToolContext,
  user: string,
): Promise<{ roles: string[] } | FrappeError> {
  const direct = await frappeAuthedRequest(
    context.fetch!,
    auth.siteUrl,
    auth.auth,
    "GET",
    `/api/method/frappe.core.doctype.user.user.get_roles?${new URLSearchParams({ user }).toString()}`,
  );
  if (direct.ok) {
    const message = direct.data.message;
    const roles = Array.isArray(message) ? uniqueSorted(message.map(String)) : [];
    if (roles.length) return { roles };
  } else if (direct.status === 401) {
    return direct;
  }

  // Custom Frappe deployments frequently override, restrict, or break the
  // convenience get_roles method. Has Role remains the permission-bearing
  // source and is safe to query through the current OAuth principal.
  const childQuery = new URLSearchParams({
    fields: JSON.stringify(["role"]),
    filters: JSON.stringify([["parent", "=", user]]),
    limit_page_length: "200",
  });
  const childRows = await frappeAuthedRequest(context.fetch!, auth.siteUrl, auth.auth, "GET", `/api/resource/Has%20Role?${childQuery.toString()}`);
  if (!childRows.ok) {
    if (childRows.status === 403 || childRows.status === 404) return { roles: [] };
    return childRows;
  }
  const roles = Array.isArray(childRows.data.data)
    ? uniqueSorted(childRows.data.data.map((row) => recordString(row, "role") ?? "").filter(Boolean))
    : [];
  return { roles };
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function selectModulePriors(input: { readonly apps: readonly string[]; readonly modules: readonly string[]; readonly query: string }): FrappeModuleContext[] {
  const appSet = new Set(input.apps.map((app) => app.toLowerCase()));
  const moduleSet = new Set(input.modules.map((module) => module.toLowerCase()));
  const query = input.query.toLowerCase();
  if (moduleSet.size) {
    const selected = MODULE_PRIORS.filter((prior) => moduleSet.has(prior.module.toLowerCase()));
    if (selected.length) return selected;
  }
  const selected = MODULE_PRIORS.filter((prior) => {
    if (prior.apps.some((app) => appSet.has(app))) return true;
    if (query && [prior.module, ...prior.concepts, ...prior.retrievalHints].some((text) => text.toLowerCase().includes(query) || query.includes(text.toLowerCase()))) return true;
    return false;
  });
  return selected.length ? selected : MODULE_PRIORS.slice(0, 6);
}

function uniqueDocs(docs: readonly FrappeDocSource[]): FrappeDocSource[] {
  return [...new Map(docs.map((doc) => [doc.url, doc])).values()];
}

function extractInstalledApps(data: Record<string, unknown>): string[] {
  const message = data.message;
  if (typeof message === "object" && message !== null) {
    return Object.keys(message as Record<string, unknown>);
  }
  return [];
}

function extractAppVersions(data: Record<string, unknown>): Record<string, string> {
  const message = data.message;
  if (typeof message !== "object" || message === null) return {};
  const versions: Record<string, string> = {};
  for (const [app, value] of Object.entries(message as Record<string, unknown>)) {
    if (typeof value === "string") {
      versions[app] = value;
    } else if (typeof value === "object" && value !== null) {
      const version = (value as Record<string, unknown>).version;
      versions[app] = typeof version === "string" ? version : "installed";
    } else {
      versions[app] = "installed";
    }
  }
  return versions;
}

function extractWorkspaceModules(data: Record<string, unknown>): string[] {
  const message = data.message;
  const source = Array.isArray(message) ? message : Array.isArray((message as Record<string, unknown> | undefined)?.pages) ? (message as { pages: unknown[] }).pages : [];
  return source.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const row = item as Record<string, unknown>;
    const title = typeof row.title === "string" ? row.title : typeof row.name === "string" ? row.name : undefined;
    return title ? [title] : [];
  });
}

async function frappeList(
  context: FrappeToolContext,
  siteUrl: string,
  auth: FrappeAuth,
  doctype: string,
  fields: readonly string[],
  filters: readonly unknown[],
  limit: number,
  warnings: string[],
): Promise<unknown[]> {
  const query = new URLSearchParams();
  query.set("fields", JSON.stringify(fields));
  query.set("filters", JSON.stringify(filters));
  query.set("limit_page_length", String(limit));
  if (typeof context.fetch !== "function") {
    warnings.push(`${doctype} unavailable: network permission was not granted`);
    return [];
  }
  const result = await frappeAuthedRequest(context.fetch, siteUrl, auth, "GET", `/api/resource/${encodeURIComponent(doctype)}?${query.toString()}`);
  if (!result.ok) {
    warnings.push(`${doctype} unavailable: ${result.error}`);
    return [];
  }
  return Array.isArray(result.data.data) ? result.data.data : [];
}

async function frappeGetResource(
  context: FrappeToolContext,
  siteUrl: string,
  auth: FrappeAuth,
  doctype: string,
  name: string,
  warnings: string[],
): Promise<Record<string, unknown> | undefined> {
  if (typeof context.fetch !== "function") {
    warnings.push(`${doctype} ${name} unavailable: network permission was not granted`);
    return undefined;
  }
  const result = await frappeAuthedRequest(context.fetch, siteUrl, auth, "GET", `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`);
  if (!result.ok) {
    warnings.push(`${doctype} ${name} unavailable: ${result.error}`);
    return undefined;
  }
  return recordObject(result.data.data);
}

async function discoverDoctypeNames(
  context: FrappeToolContext,
  siteUrl: string,
  auth: FrappeAuth,
  modules: readonly string[],
  warnings: string[],
): Promise<string[]> {
  const filters = modules.length ? [["module", "in", modules]] : [];
  const rows = await frappeList(context, siteUrl, auth, "DocType", ["name", "module", "custom", "istable"], filters, 200, warnings);
  return uniqueSorted(rows.flatMap((row) => recordString(row, "name") ?? []));
}

function normalizeDoctype(raw: Record<string, unknown>): FrappeDocTypeIndex {
  const fields = Array.isArray(raw.fields) ? raw.fields.map(normalizeField).filter((field): field is FrappeDocFieldIndex => Boolean(field.fieldname)) : [];
  const permissions = Array.isArray(raw.permissions) ? raw.permissions.map(normalizePermission).filter((permission): permission is FrappePermissionIndex => Boolean(permission.role)) : [];
  return {
    name: recordString(raw, "name") ?? "Unknown DocType",
    module: recordString(raw, "module"),
    custom: booleanLike(raw.custom),
    istable: booleanLike(raw.istable),
    autoname: recordString(raw, "autoname"),
    fields,
    links: fields
      .filter((field) => field.fieldtype === "Link" && field.options)
      .map((field) => ({ fieldname: field.fieldname, target: field.options as string })),
    childTables: fields
      .filter((field) => ["Table", "Table MultiSelect"].includes(field.fieldtype ?? "") && field.options)
      .map((field) => ({ fieldname: field.fieldname, target: field.options as string })),
    namingSeries: extractNamingSeries(raw, fields),
    permissions,
  };
}

function normalizeField(raw: unknown): FrappeDocFieldIndex {
  const record = recordObject(raw) ?? {};
  return {
    fieldname: recordString(record, "fieldname") ?? "",
    label: recordString(record, "label"),
    fieldtype: recordString(record, "fieldtype"),
    options: recordString(record, "options"),
    reqd: booleanLike(record.reqd),
    hidden: booleanLike(record.hidden),
    permlevel: numberLike(record.permlevel),
  };
}

function normalizePermission(raw: unknown): FrappePermissionIndex {
  const record = recordObject(raw) ?? {};
  return {
    role: recordString(record, "role") ?? "",
    read: booleanLike(record.read),
    write: booleanLike(record.write),
    create: booleanLike(record.create),
    delete: booleanLike(record.delete),
    submit: booleanLike(record.submit),
    cancel: booleanLike(record.cancel),
    amend: booleanLike(record.amend),
    select: booleanLike(record.select),
    report: booleanLike(record.report),
    export: booleanLike(record.export),
    import: booleanLike(record.import),
    print: booleanLike(record.print),
    email: booleanLike(record.email),
    share: booleanLike(record.share),
  };
}

function extractNamingSeries(raw: Record<string, unknown>, fields: readonly FrappeDocFieldIndex[]): string[] {
  const series = new Set<string>();
  const namingField = fields.find((field) => field.fieldname === "naming_series");
  if (namingField?.options) {
    for (const option of namingField.options.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) series.add(option);
  }
  const autoname = recordString(raw, "autoname");
  if (autoname && (autoname.includes("#") || autoname.includes(".YYYY."))) series.add(autoname);
  return [...series];
}

function flattenPermissions(doctypes: readonly FrappeDocTypeIndex[]): Array<{ doctype: string; role: string; permission: FrappePermissionName; allowed: boolean }> {
  return doctypes.flatMap((doctype) => doctype.permissions.flatMap((permission) => {
    const role = permission.role;
    return PERMISSION_NAMES.map((name) => ({
      doctype: doctype.name,
      role,
      permission: name,
      allowed: permission[name] === true,
    }));
  }));
}

function buildFrappeGraph(input: {
  readonly site: string;
  readonly apps: readonly string[];
  readonly modules: readonly string[];
  readonly doctypes: readonly FrappeDocTypeIndex[];
  readonly roles: readonly string[];
  readonly workflows: readonly unknown[];
  readonly reports: readonly unknown[];
  readonly customFields: readonly unknown[];
  readonly propertySetters: readonly unknown[];
}): FrappeGraph {
  const nodes = new Map<string, { id: string; type: string; label: string }>();
  const edges: Array<{ from: string; to: string; type: string; label?: string }> = [];
  const addNode = (id: string, type: string, label = id) => nodes.set(id, { id, type, label });
  addNode(`site:${input.site}`, "site", input.site);
  for (const app of input.apps) {
    addNode(`app:${app}`, "app", app);
    edges.push({ from: `site:${input.site}`, to: `app:${app}`, type: "site_app" });
  }
  for (const module of input.modules) {
    addNode(`module:${module}`, "module", module);
    edges.push({ from: `site:${input.site}`, to: `module:${module}`, type: "site_module" });
  }
  for (const role of input.roles) addNode(`role:${role}`, "role", role);
  for (const doctype of input.doctypes) {
    addNode(`doctype:${doctype.name}`, "doctype", doctype.name);
    if (doctype.module) {
      addNode(`module:${doctype.module}`, "module", doctype.module);
      edges.push({ from: `module:${doctype.module}`, to: `doctype:${doctype.name}`, type: "module_doctype" });
    }
    for (const field of doctype.fields) {
      addNode(`field:${doctype.name}.${field.fieldname}`, "field", field.label ?? field.fieldname);
      edges.push({ from: `doctype:${doctype.name}`, to: `field:${doctype.name}.${field.fieldname}`, type: "doctype_field", label: field.fieldtype });
    }
    for (const link of doctype.links) {
      addNode(`doctype:${link.target}`, "doctype", link.target);
      edges.push({ from: `doctype:${doctype.name}`, to: `doctype:${link.target}`, type: "doctype_link", label: link.fieldname });
    }
    for (const table of doctype.childTables) {
      addNode(`doctype:${table.target}`, "doctype", table.target);
      edges.push({ from: `doctype:${doctype.name}`, to: `doctype:${table.target}`, type: "doctype_child_table", label: table.fieldname });
    }
    for (const permission of doctype.permissions) {
      addNode(`role:${permission.role}`, "role", permission.role);
      edges.push({ from: `role:${permission.role}`, to: `doctype:${doctype.name}`, type: "role_permission" });
    }
  }
  addCustomizationGraphNodes(input.customFields, "custom_field", "dt", nodes, edges);
  addCustomizationGraphNodes(input.propertySetters, "property_setter", "doc_type", nodes, edges);
  addDocumentTypeResourceNodes(input.workflows, "workflow", "document_type", nodes, edges);
  addDocumentTypeResourceNodes(input.reports, "report", "ref_doctype", nodes, edges);
  return { nodes: [...nodes.values()], edges };
}

function addCustomizationGraphNodes(
  rows: readonly unknown[],
  type: string,
  doctypeKey: string,
  nodes: Map<string, { id: string; type: string; label: string }>,
  edges: Array<{ from: string; to: string; type: string; label?: string }>,
): void {
  for (const row of rows) {
    const name = recordString(row, "name");
    const doctype = recordString(row, doctypeKey);
    if (!name || !doctype) continue;
    nodes.set(`${type}:${name}`, { id: `${type}:${name}`, type, label: name });
    edges.push({ from: `${type}:${name}`, to: `doctype:${doctype}`, type: `${type}_target` });
  }
}

function addDocumentTypeResourceNodes(
  rows: readonly unknown[],
  type: string,
  doctypeKey: string,
  nodes: Map<string, { id: string; type: string; label: string }>,
  edges: Array<{ from: string; to: string; type: string; label?: string }>,
): void {
  for (const row of rows) {
    const name = recordString(row, "name");
    const doctype = recordString(row, doctypeKey);
    if (!name) continue;
    nodes.set(`${type}:${name}`, { id: `${type}:${name}`, type, label: name });
    if (doctype) edges.push({ from: `${type}:${name}`, to: `doctype:${doctype}`, type: `${type}_doctype` });
  }
}

const PERMISSION_NAMES: readonly FrappePermissionName[] = ["read", "write", "create", "delete", "submit", "cancel", "amend", "select", "report", "export", "import", "print", "email", "share"];

function classifyFrappePrompt(prompt: string): FrappeQueryClass {
  const text = prompt.toLowerCase();
  if (/\b(pdf|pptx?|deck|excel|xlsx|workbook|artifact|generate|export)\b/.test(text) && /\b(summary|brief|report|audit|matrix|dictionary|deck|pdf|excel|xlsx|pptx?)\b/.test(text)) return "artifact_generation";
  if (/\b(role-safe|management summary|executive summary|cto|cfo|leadership)\b/.test(text)) return "role_safe_management_summary";
  if (/\b(migration|migrate|upgrade|patch|custom app|custom_app|impact)\b/.test(text)) return "migration_custom_app_impact";
  if (/\b(why|can't|cannot|error|failed|failing|blocked|not allowed|won't save|save)\b/.test(text)) return "troubleshooting";
  if (/\b(?:docs?|documentation|manual|guide|how do i|api reference)\b/.test(text)) return "docs";
  if (/\b(?:installed apps?|apps present|which apps|app versions?)\b/.test(text)) return "installed_app";
  if (/\b(?:workflow|transition|state|approve|approval)\b/.test(text)) return "workflow";
  if (/\b(?:permissions?|roles?|allowed|access|can .* read|can .* write|deny|denied)\b/.test(text)) return "permission";
  if (/\b(?:report|dashboard|print format|number card|chart)\b/.test(text)) return "report";
  if (/\b(?:custom fields?|property setters?|client scripts?|server scripts?|customizations?|customisations?|script)\b/.test(text)) return "customization";
  if (/\b(?:create|add|new|draft|insert)\b/.test(text)) return "record_creation";
  if (/\b(?:update|change|set|edit|modify|submit|cancel)\b/.test(text)) return "record_update";
  if (/\b(?:find|list|lookup|look up|show|get|fetch|open)\b/.test(text)) return "record_lookup";
  if (/\b(?:fields?|labels?|fieldtypes?|options|links?|child tables?|naming series)\b/.test(text)) return "field";
  return "schema";
}

function candidateClasses(prompt: string): Array<{ class: FrappeQueryClass; confidence: number; reason: string }> {
  const primary = classifyFrappePrompt(prompt);
  const classes: Array<{ class: FrappeQueryClass; confidence: number; reason: string }> = [{ class: primary, confidence: 0.88, reason: "Matched Frappe-specific prompt terms." }];
  const text = prompt.toLowerCase();
  for (const candidate of QUERY_CLASS_ORDER) {
    if (candidate === primary) continue;
    const strategy = retrievalStrategyFor(candidate);
    const token = candidate.replace(/_/g, " ");
    if (text.includes(token.split(" ")[0] ?? token)) classes.push({ class: candidate, confidence: 0.45, reason: `Secondary hint for ${candidate}.` });
    if (classes.length >= 3) break;
    void strategy;
  }
  return classes;
}

const QUERY_CLASS_ORDER: readonly FrappeQueryClass[] = [
  "schema",
  "field",
  "permission",
  "workflow",
  "report",
  "customization",
  "installed_app",
  "docs",
  "record_lookup",
  "record_creation",
  "record_update",
  "artifact_generation",
  "troubleshooting",
  "migration_custom_app_impact",
  "role_safe_management_summary",
];

function retrievalStrategyFor(queryClass: FrappeQueryClass): string[] {
  switch (queryClass) {
    case "schema":
      return ["DocType metadata", "DocField list", "Link and child-table graph", "module priors"];
    case "field":
      return ["DocType metadata", "DocField exact/label search", "Custom Field overlay", "Property Setter overlay"];
    case "permission":
      return ["role permission table", "DocPerm rows", "workflow role transitions", "blocked permission summary"];
    case "workflow":
      return ["Workflow document", "states", "transitions", "allowed role filter", "DocType permission overlay"];
    case "report":
      return ["Report by name/module", "reference DocType graph", "dashboard/print-format siblings"];
    case "customization":
      return ["Custom Field", "Property Setter", "Client Script", "Server Script", "target DocType graph"];
    case "installed_app":
      return ["version metadata", "installed app list", "workspace modules", "installed app docs"];
    case "docs":
      return ["Frappe/ERPNext docs", "Frappe Suite docs", "installed app README/docs", "module docs"];
    case "record_lookup":
      return ["intent DocType", "permission preflight", "resource list filters", "bounded rows"];
    case "record_creation":
      return ["write intent classification", "create permission preflight", "dry-run mutation proposal", "approval gate"];
    case "record_update":
      return ["write intent classification", "write permission preflight", "record fetch", "dry-run mutation diff", "approval gate"];
    case "artifact_generation":
      return ["DocType graph", "permission-scoped dataset", "artifact metadata", "delivery evidence"];
    case "troubleshooting":
      return ["screen/context errors", "DocType validation fields", "workflow state", "permission boundary", "exact Frappe error"];
    case "migration_custom_app_impact":
      return ["installed apps", "custom app DocTypes", "customizations", "scripts", "migration risk graph"];
    case "role_safe_management_summary":
      return ["role permissions", "allowed DocType summaries", "blocked-sensitive data", "executive-safe artifact"];
  }
}

function memoryPolicyForPrompt(prompt: string, args: Record<string, unknown>): { recall: boolean; reason: string; candidateScopes: string[] } {
  const text = prompt.toLowerCase();
  const recall = /\b(previous|remember|again|my preference|last time|handoff|prior|recurring)\b/.test(text);
  const scopes = [
    ...stringList(args.memoryScopes),
    ...stringList(args.user).map((user) => `user:${user}`),
    ...stringList(args.site).map((site) => `tenant:${site}`),
  ];
  return {
    recall,
    reason: recall ? "Prompt references prior/personal Frappe context." : "Prompt is answerable from live or fixture Frappe context without scoped memory.",
    candidateScopes: scopes,
  };
}

function normalizeInductionArg(value: unknown): FrappeSiteInduction {
  const record = recordObject(value) ?? {};
  const site = recordObject(record.site) ?? {};
  const customizations = recordObject(record.customizations) ?? {};
  const doctypes = Array.isArray(record.doctypes) ? record.doctypes.map((doctype) => normalizeDoctype(recordObject(doctype) ?? {})) : [];
  return {
    site: {
      url: recordString(site, "url") ?? "",
      authMode: recordString(site, "authMode") === "admin_login" ? "admin_login" : "api_token",
      identity: { user: recordString(recordObject(site.identity) ?? {}, "user") },
      versions: recordObject(site.versions) as Record<string, string> | undefined ?? {},
      installedApps: Array.isArray(site.installedApps) ? site.installedApps.map(String) : [],
    },
    modules: Array.isArray(record.modules) ? record.modules.map(String) : [],
    workspaces: Array.isArray(record.workspaces) ? record.workspaces.map(String) : [],
    doctypes,
    roles: Array.isArray(record.roles) ? record.roles.map(String) : [],
    permissions: Array.isArray(record.permissions) ? record.permissions as Array<{ doctype: string; role: string; permission: FrappePermissionName; allowed: boolean }> : flattenPermissions(doctypes),
    workflows: Array.isArray(record.workflows) ? record.workflows : [],
    reports: Array.isArray(record.reports) ? record.reports : [],
    printFormats: Array.isArray(record.printFormats) ? record.printFormats : [],
    dashboards: Array.isArray(record.dashboards) ? record.dashboards : [],
    webForms: Array.isArray(record.webForms) ? record.webForms : [],
    notificationRules: Array.isArray(record.notificationRules) ? record.notificationRules : [],
    assignmentRules: Array.isArray(record.assignmentRules) ? record.assignmentRules : [],
    customizations: {
      customFields: Array.isArray(customizations.customFields) ? customizations.customFields : [],
      propertySetters: Array.isArray(customizations.propertySetters) ? customizations.propertySetters : [],
      clientScripts: Array.isArray(customizations.clientScripts) ? customizations.clientScripts : [],
      serverScripts: Array.isArray(customizations.serverScripts) ? customizations.serverScripts : [],
    },
    docs: Array.isArray(record.docs) ? record.docs as FrappeDocSource[] : [],
    graph: recordObject(record.graph) as FrappeGraph | undefined ?? { nodes: [], edges: [] },
    evidence: Array.isArray(record.evidence) ? record.evidence.map(String) : [],
    warnings: Array.isArray(record.warnings) ? record.warnings.map(String) : [],
  };
}

function selectCandidateDoctypes(prompt: string, induction: FrappeSiteInduction): FrappeDocTypeIndex[] {
  const text = prompt.toLowerCase();
  const selected = induction.doctypes.filter((doctype) => {
    const haystack = [
      doctype.name,
      doctype.module ?? "",
      ...doctype.fields.flatMap((field) => [field.fieldname, field.label ?? "", field.options ?? ""]),
    ].join(" ").toLowerCase();
    return haystack.split(/\s+/).some((word) => word.length > 2 && text.includes(word)) || text.includes(doctype.name.toLowerCase());
  });
  return selected.length ? selected : induction.doctypes.slice(0, 3);
}

function fixturePermissionDecision(
  induction: FrappeSiteInduction,
  doctypeName: string,
  permission: FrappePermissionName,
  roles: readonly string[],
): { allowed: boolean; matchedRoles: string[]; deniedRoles: string[] } {
  const doctype = induction.doctypes.find((item) => item.name === doctypeName);
  if (!doctype) return { allowed: false, matchedRoles: [], deniedRoles: [...roles] };
  const matchedRoles: string[] = [];
  const deniedRoles: string[] = [];
  for (const role of roles) {
    const row = doctype.permissions.find((permissionRow) => permissionRow.role === role || role === "All");
    if (row?.[permission] === true) matchedRoles.push(role);
    else deniedRoles.push(role);
  }
  return { allowed: matchedRoles.length > 0, matchedRoles, deniedRoles };
}

function filterByDoctypeLike(rows: readonly unknown[], doctypes: ReadonlySet<string>, keys: readonly string[]): unknown[] {
  if (!doctypes.size) return [];
  return rows.filter((row) => keys.some((key) => {
    const value = recordString(row, key);
    return value ? doctypes.has(value) : false;
  }));
}

function docsForIntent(intent: FrappeQueryClass, docs: readonly FrappeDocSource[]): FrappeDocSource[] {
  if (intent === "docs") return docs.slice(0, 8);
  if (intent === "workflow") return docs.filter((doc) => /workflow/i.test(doc.label) || /workflow/i.test(doc.url)).slice(0, 4);
  if (intent === "customization") return docs.filter((doc) => /custom/i.test(doc.label) || /custom/i.test(doc.url)).slice(0, 4);
  return docs.slice(0, 3);
}

function safeActionOptionsFor(intent: FrappeQueryClass, doctypes: readonly string[]): string[] {
  if (intent === "record_creation") return doctypes.map((doctype) => `Propose create for ${doctype}, then require approval before POST.`);
  if (intent === "record_update") return doctypes.map((doctype) => `Fetch ${doctype}, propose diff, then require approval before PUT.`);
  if (intent === "artifact_generation") return doctypes.map((doctype) => `Build permission-scoped artifact data from ${doctype}.`);
  return doctypes.map((doctype) => `Read-only context packet for ${doctype}.`);
}

async function livePermissionPreflight(
  context: FrappeToolContext,
  siteUrl: string,
  auth: FrappeAuth,
  doctype: string,
  permission: FrappePermissionName,
  docname?: string,
  suppliedMetadata?: FrappeEffectiveDocTypeMetadata,
): Promise<{ allowed: boolean; reason: string }> {
  if (typeof context.fetch !== "function") return { allowed: false, reason: "No network access for Frappe permission preflight." };
  if (docname) {
    const result = await frappeAuthedRequest(
      context.fetch,
      siteUrl,
      auth,
      "GET",
      `/api/method/frappe.client.has_permission?${new URLSearchParams({
        doctype,
        docname,
        perm_type: permission,
      }).toString()}`,
    );
    if (!result.ok) return { allowed: false, reason: `Frappe permission preflight failed: ${result.error}` };
    const message = result.data.message;
    const permissionResult = recordObject(message);
    const allowed = message === true || permissionResult?.has_permission === true || permissionResult?.has_permission === 1;
    return {
      allowed,
      reason: allowed
        ? `Frappe permits ${permission} on this ${doctype} for the authenticated user.`
        : `Frappe does not permit ${permission} on this ${doctype} for the authenticated user.`,
    };
  }
  if (permission !== "create") return { allowed: false, reason: `Frappe cannot prove ${permission} permission for ${doctype} from effective metadata.` };
  const metadata = suppliedMetadata ?? await loadFrappeEffectiveDocTypeMetadata(context, siteUrl, auth, doctype);
  if ("error" in metadata) return { allowed: false, reason: `Frappe effective metadata preflight failed: ${metadata.error}` };
  const userResult = await frappeAuthedRequest(context.fetch, siteUrl, auth, "GET", "/api/method/frappe.auth.get_logged_user");
  if (!userResult.ok) return { allowed: false, reason: `Frappe identity preflight failed: ${userResult.error}` };
  const principal = typeof userResult.data.message === "string" ? userResult.data.message : "";
  if (!principal) return { allowed: false, reason: "Frappe identity preflight returned no authenticated principal." };
  const rolesResult = await frappeAuthedRequest(
    context.fetch,
    siteUrl,
    auth,
    "GET",
    `/api/method/frappe.core.doctype.user.user.get_roles?${new URLSearchParams({ user: principal }).toString()}`,
  );
  if (!rolesResult.ok) return { allowed: false, reason: `Frappe role preflight failed: ${rolesResult.error}` };
  const roles = Array.isArray(rolesResult.data.message) ? rolesResult.data.message.filter((role): role is string => typeof role === "string") : [];
  const allowed = metadata.permissions.some((row) => {
    const permissionRow = recordObject(row);
    if (!permissionRow) return false;
    const role = recordString(permissionRow, "role");
    const hasRole = role === "All" || (role ? roles.includes(role) : false);
    const value = permissionRow[permission];
    return hasRole && (value === 1 || value === true);
  });
  return {
    allowed,
    reason: allowed
      ? `Frappe effective metadata permits ${permission} on ${doctype} for the authenticated user's live roles.`
      : `Frappe effective metadata does not permit ${permission} on ${doctype} for the authenticated user's live roles.`,
  };
}

async function loadFrappeEffectiveDocTypeMetadata(
  context: FrappeToolContext,
  siteUrl: string,
  auth: FrappeAuth,
  doctype: string,
): Promise<FrappeEffectiveDocTypeMetadata | FrappeError> {
  if (typeof context.fetch !== "function") return { error: "No network access for Frappe effective metadata hydration." };
  const result = await frappeAuthedRequest(
    context.fetch,
    siteUrl,
    auth,
    "GET",
    `/api/method/frappe.desk.form.load.getdoctype?${new URLSearchParams({ doctype, with_parent: "1" }).toString()}`,
  );
  if (!result.ok) return result;
  try {
    return hydrateFrappeEffectiveDocTypeMetadata(result.data, doctype);
  } catch (error) {
    return { error: `Frappe effective metadata hydration failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function permissionName(value: string): FrappePermissionName {
  const normalized = value === "update" ? "write" : value;
  return (PERMISSION_NAMES as readonly string[]).includes(normalized) ? normalized as FrappePermissionName : "read";
}

function mimeTypeForArtifactFormat(format: string): string {
  switch (format.toLowerCase()) {
    case "pdf":
      return "application/pdf";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "markdown":
    case "md":
    default:
      return "text/markdown";
  }
}

function stableArtifactId(site: string, user: string, prompt: string, generatedAt: string): string {
  const seed = `${site}|${user}|${prompt}|${generatedAt}`;
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return `frappe-artifact-${hash.toString(16).padStart(8, "0")}`;
}

function recordObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function normalizeApprovalReceipt(value: unknown): FrappeApprovalReceipt | undefined {
  const receipt = recordObject(value);
  const proposal = recordObject(receipt?.proposal);
  if (!receipt || !proposal) return undefined;
  const signature = recordString(receipt, "signature");
  const approvedBy = recordString(receipt, "approvedBy");
  const approvedAt = recordString(receipt, "approvedAt");
  if (!signature || !approvedBy || !approvedAt) return undefined;
  const requiredProposalFields = [
    "proposalId",
    "mutationHash",
    "site",
    "principal",
    "operation",
    "doctype",
    "permissionEpoch",
    "schemaRevision",
    "dataRevision",
    "issuedAt",
    "expiresAt",
    "nonce",
    "humanSummary",
  ];
  if (!requiredProposalFields.every((key) => recordString(proposal, key))) return undefined;
  if (!Array.isArray(proposal.fields) || !proposal.fields.every((field) => typeof field === "string")) return undefined;
  if (!Array.isArray(proposal.bindingRequirements) || !proposal.bindingRequirements.every((item) => typeof item === "string")) return undefined;
  return value as FrappeApprovalReceipt;
}

function recordString(value: unknown, key: string): string | undefined {
  const record = recordObject(value);
  const item = record?.[key];
  return typeof item === "string" && item.trim() ? item.trim() : undefined;
}

function numberLike(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function booleanLike(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true" || value === "yes";
}

function booleanArg(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
