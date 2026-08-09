import { createHash, createHmac, randomBytes } from "node:crypto";
import type {
  FrappeMissionNodeExecutionInput,
  FrappeMissionNodeExecutionResult,
  FrappeMissionNodeExecutor,
} from "./frappe-mission-bridge.js";
import type { FrappeSiteBindingCoordinator } from "./frappe-connect.js";

/** Browser work is selected only by a hash-bound host publication manifest. */
export const FRAPPE_BROWSER_BOOTSTRAP_ISSUE_PATH = "/api/method/muster.api.browser_session.issue" as const;
export const FRAPPE_BROWSER_BOOTSTRAP_CONSUME_PATH = "/api/method/muster.api.browser_session.consume" as const;
export const FRAPPE_BROWSER_SCHEMA_VERIFY_PATH = "/api/method/muster.api.browser_session.verify_schema" as const;
export const FRAPPE_BROWSER_RECORD_VERIFY_PATH = "/api/method/muster.api.browser_session.verify_record" as const;
export const FRAPPE_ATTENDED_FORM_ROUTE = "@attended-form" as const;

export interface FrappeAttendedCrudBinding {
  readonly operation: "create" | "read" | "update";
  readonly doctype: string;
  readonly record_name: string | null;
  readonly fields: readonly string[];
  readonly schema_hash: string;
  readonly revision: string;
}

export interface FrappeAttendedFormSchemaReceipt {
  readonly doctype: string;
  readonly schema_hash: string;
  readonly revision: string;
  readonly customized_fields: readonly { readonly fieldname: string; readonly label: string; readonly source: "custom_field" | "doctype_field"; readonly property_setter_count: number }[];
  readonly doctype_property_setter_count: number;
  readonly workflow: unknown;
  readonly client_scripts: readonly { readonly name: string; readonly view: string; readonly modified: string }[];
  readonly custom_permission_count: number;
  readonly server_script_count: number;
  readonly form_action_count: number;
  readonly form_link_count: number;
}

export type FrappeBrowserTarget =
  | { readonly kind: "role"; readonly role: "button" | "link" | "textbox" | "combobox" | "checkbox" | "tab"; readonly name: string }
  | { readonly kind: "label"; readonly name: string }
  | { readonly kind: "test_id"; readonly name: string };

export type FrappeBrowserPostcondition =
  | { readonly kind: "route"; readonly route: string }
  | { readonly kind: "target"; readonly target: FrappeBrowserTarget; readonly state: "visible" | "hidden" }
  | { readonly kind: "bind_route"; readonly token: "attended_form"; readonly doctype: string }
  | { readonly kind: "record_saved"; readonly doctype: string; readonly recordName: string | null };

interface BrowserActionBase {
  readonly route: string;
  readonly doctype?: string;
  readonly recordName?: string;
}

export type FrappeBrowserAction =
  | (BrowserActionBase & { readonly kind: "navigate" })
  | (BrowserActionBase & { readonly kind: "click"; readonly target: FrappeBrowserTarget; readonly postcondition: FrappeBrowserPostcondition })
  | (BrowserActionBase & { readonly kind: "fill"; readonly target: FrappeBrowserTarget; readonly field: string; readonly value: string; readonly postcondition: FrappeBrowserPostcondition })
  | (BrowserActionBase & { readonly kind: "select"; readonly target: FrappeBrowserTarget; readonly field: string; readonly option: string; readonly postcondition: FrappeBrowserPostcondition })
  | (BrowserActionBase & { readonly kind: "upload"; readonly target: FrappeBrowserTarget; readonly field: string; readonly artifactId: string; readonly postcondition: FrappeBrowserPostcondition })
  | (BrowserActionBase & { readonly kind: "screenshot"; readonly scope: "viewport_redacted"; readonly redactFields: readonly string[] })
  | (BrowserActionBase & { readonly kind: "read_visible"; readonly target?: FrappeBrowserTarget; readonly maxChars: number });

export interface FrappeBrowserActionPlan {
  readonly schemaVersion: 1;
  readonly actions: readonly FrappeBrowserAction[];
  readonly actionBudget: number;
  readonly attendedCrud?: FrappeAttendedCrudBinding;
}

export interface FrappeBrowserBootstrap {
  /** Opaque one-use credential. It must never be put in a URL or log. */
  readonly ticket: string;
  readonly browserChallenge: string;
  readonly bootstrapId: string;
  readonly expiresAt: string;
  readonly siteOrigin: string;
  readonly actorId: string;
  readonly permissionEpoch: string;
  readonly attendedCrud?: FrappeAttendedCrudBinding;
  readonly formSchema?: FrappeAttendedFormSchemaReceipt;
}

export interface FrappeBrowserBootstrapPort {
  issue(input: {
    readonly tenantId: string;
    readonly siteId: string;
    readonly siteOrigin: string;
    readonly userId: string;
    readonly permissionEpoch: string;
    readonly missionId: string;
    readonly rootRunId: string;
    readonly nodeId: string;
    readonly browserChallenge: string;
    readonly attendedCrud?: FrappeAttendedCrudBinding;
    readonly signal: AbortSignal;
  }): Promise<FrappeBrowserBootstrap>;
}

export interface FrappeBrowserActionReady {
  readonly actionId: string;
  readonly kind: FrappeBrowserAction["kind"];
  readonly route: string;
  /** Viewport-relative percentages used by the observed-work-session cursor. */
  readonly pointer: { readonly x: number; readonly y: number };
}

export interface FrappeBrowserActionResult extends FrappeBrowserActionReady {
  readonly performed: true;
  readonly postconditionVerified: true;
  readonly rbac: "allowed" | "denied";
  readonly bootstrapId: string;
  readonly sessionFingerprint: string;
  readonly fieldsAffected?: readonly string[];
  readonly visibleText?: string;
  readonly evidence?: {
    readonly id: string;
    readonly sha256: string;
    readonly maskingScope: "explicit_fields_and_password_controls";
    readonly requestedMasksVerified: true;
  };
  readonly serverRecordProof?: { readonly doctype: string; readonly recordName: string; readonly proofHash: string };
}

export interface FrappeBrowserSession {
  readonly contextId: string;
  readonly siteOrigin: string;
  readonly actorId: string;
  readonly bootstrapId: string;
  readonly sessionFingerprint: string;
  readonly bootstrapConsumed: true;
  perform(
    action: FrappeBrowserAction,
    input: {
      readonly actionId: string;
      readonly idempotencyKey: string;
      readonly signal: AbortSignal;
      /** Called by the browser transport only after resolving the real target. */
      readonly onActionReady: (ready: FrappeBrowserActionReady) => Promise<void>;
    },
  ): Promise<FrappeBrowserActionResult>;
  /** Logs out the Frappe session before destroying the isolated browser context. */
  close(reason: "completed" | "failed" | "cancelled"): Promise<{ readonly serverSessionRevoked: true }>;
}

export interface FrappeBrowserAutomationPort {
  open(input: {
    readonly contextId: string;
    readonly bootstrap: FrappeBrowserBootstrap;
    readonly signal: AbortSignal;
  }): Promise<FrappeBrowserSession>;
  /** Releases a gateway-owned browser process. Active sessions close themselves. */
  close?(): Promise<void>;
}

export interface FrappeBrowserWorkSessionOptions {
  readonly siteOrigin: string;
  readonly bootstrap: FrappeBrowserBootstrapPort;
  readonly browser: FrappeBrowserAutomationPort;
  readonly fallback?: FrappeMissionNodeExecutor;
  readonly maxActionsPerNode?: number;
  readonly now?: () => number;
}

/**
 * Route browser plans only through the browser executor. Every other node stays
 * on the supplied governed executor. The site origin comes exclusively from a
 * unique reciprocally verified binding, never from mission/model context.
 */
export function createVerifiedBindingFrappeBrowserMissionExecutor(options: {
  readonly bindings: FrappeSiteBindingCoordinator;
  readonly browser: FrappeBrowserAutomationPort;
  readonly fallback: FrappeMissionNodeExecutor;
  readonly maxActionsPerNode?: number;
  readonly now?: () => number;
  readonly fetcher?: typeof fetch;
}): FrappeMissionNodeExecutor {
  const executors = new Map<string, FrappeMissionNodeExecutor>();
  return async (input) => {
    if (readNodePlan(input) === undefined) return options.fallback(input);
    const siteId = input.mission.identity.siteId;
    if (!siteId) throw new FrappeBrowserWorkSessionError("Browser work requires an exact bound Frappe site identity.");
    const matches = options.bindings.verifiedBindings().filter((binding) =>
      binding.tenantId === input.mission.identity.tenantId && binding.siteUuid === siteId,
    );
    if (matches.length !== 1) throw new FrappeBrowserWorkSessionError("Browser work requires one unique reciprocally verified Frappe binding.");
    const binding = matches[0]!;
    let executor = executors.get(binding.bindingId);
    if (!executor) {
      executor = createFrappeBrowserWorkSessionExecutor({
        siteOrigin: binding.siteOrigin,
        bootstrap: createVerifiedBindingFrappeBrowserBootstrapPort({ bindings: options.bindings, now: options.now, fetcher: options.fetcher }),
        browser: options.browser,
        maxActionsPerNode: options.maxActionsPerNode,
        now: options.now,
      });
      executors.set(binding.bindingId, executor);
    }
    return executor(input);
  };
}

/** Fixed signed gateway-to-Frappe port for issuing the one-use browser SID bootstrap. */
export function createVerifiedBindingFrappeBrowserBootstrapPort(options: {
  readonly bindings: FrappeSiteBindingCoordinator;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}): FrappeBrowserBootstrapPort {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = boundedInteger(options.timeoutMs ?? 15_000, 1_000, 60_000, "browser bootstrap timeout");
  return {
    async issue(input) {
      const origin = exactHttpsOrigin(input.siteOrigin);
      const binding = options.bindings.verifiedBinding({ tenantId: input.tenantId, siteUuid: input.siteId, siteOrigin: origin });
      if (!binding) throw new FrappeBrowserWorkSessionError("No reciprocally verified Frappe binding matches this browser mission.");
      const envelope = {
        schema_version: 1,
        binding_id: binding.bindingId,
        tenant_id: input.tenantId,
        site_id: input.siteId,
        site_origin: origin,
        mission_id: input.missionId,
        root_run_id: input.rootRunId,
        node_id: input.nodeId,
        actor: input.userId,
        permission_epoch: input.permissionEpoch,
        browser_challenge: input.browserChallenge,
        form_schema_binding: input.attendedCrud ?? null,
      };
      const body = JSON.stringify({ envelope });
      const timestamp = String(Math.floor(now() / 1_000));
      const nonce = randomBytes(24).toString("base64url");
      const bodyHash = digest(body);
      const signature = createHmac("sha256", binding.secrets.hmacSecret).update(`${timestamp}\n${nonce}\n${bodyHash}`).digest("hex");
      let response: Response;
      try {
        response = await fetcher(new URL(FRAPPE_BROWSER_BOOTSTRAP_ISSUE_PATH, origin), {
          method: "POST",
          headers: {
            authorization: `Bearer ${binding.secrets.accessToken}`,
            accept: "application/json",
            "content-type": "application/json",
            "x-muster-timestamp": timestamp,
            "x-muster-nonce": nonce,
            "x-muster-signature": `sha256=${signature}`,
          },
          body,
          redirect: "manual",
          signal: AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)]),
        });
      } catch {
        throw new FrappeBrowserWorkSessionError("Frappe browser bootstrap is unavailable.");
      }
      if (response.status >= 300 && response.status < 400) throw new FrappeBrowserWorkSessionError("Frappe browser bootstrap refused a redirect.");
      const raw = await response.text();
      if (Buffer.byteLength(raw) > 65_536) throw new FrappeBrowserWorkSessionError("Frappe browser bootstrap response exceeded 64 KiB.");
      let outer: unknown;
      try { outer = JSON.parse(raw); } catch { throw new FrappeBrowserWorkSessionError("Frappe browser bootstrap returned invalid JSON."); }
      if (!response.ok) throw new FrappeBrowserWorkSessionError(`Frappe rejected the browser bootstrap with HTTP ${response.status}.`);
      const outerRecord = asRecord(outer);
      const message = asRecord(outerRecord?.message);
      if (!message) throw new FrappeBrowserWorkSessionError("Frappe browser bootstrap response is invalid.");
      const ticket = requiredResponseText(message.ticket, "ticket", 4_096);
      const browserChallenge = requiredResponseText(message.browser_challenge, "browser_challenge", 256);
      const bootstrapId = requiredResponseText(message.bootstrap_id, "bootstrap_id", 256);
      const expiresAt = requiredResponseText(message.expires_at, "expires_at", 128);
      const siteOrigin = exactHttpsOrigin(requiredResponseText(message.site_origin, "site_origin", 500));
      const actorId = requiredResponseText(message.actor_id, "actor_id", 256);
      const permissionEpoch = requiredResponseText(message.permission_epoch, "permission_epoch", 256);
      const formSchema = input.attendedCrud ? parseFormSchemaReceipt(message.form_schema, input.attendedCrud) : undefined;
      return Object.freeze({ ticket, browserChallenge, bootstrapId, expiresAt, siteOrigin, actorId, permissionEpoch, ...(input.attendedCrud ? { attendedCrud: input.attendedCrud, formSchema } : {}) });
    },
  };
}

export class FrappeBrowserWorkSessionError extends Error {
  readonly disposition = "needs_intervention" as const;

  constructor(message: string) {
    super(message);
    this.name = "FrappeBrowserWorkSessionError";
  }
}

const CAPABILITY: Readonly<Record<FrappeBrowserAction["kind"], string>> = Object.freeze({
  navigate: "frappe.browser.navigate",
  click: "frappe.browser.click",
  fill: "frappe.browser.fill",
  select: "frappe.browser.select",
  upload: "frappe.browser.upload",
  screenshot: "frappe.browser.screenshot",
  read_visible: "frappe.browser.read_visible",
});
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const SHA256 = /^(?:sha256:)?[a-f0-9]{64}$/i;
const SECRET_FIELD = /password|passwd|secret|api.?key|token|authorization|cookie|private.?key/i;

/**
 * Create an executor for a fixed, isolated Frappe Desk browser session.
 * The browser port may be backed by Playwright, browser MCP, or a remote
 * computer-use service, but it can receive only the closed actions above.
 */
export function createFrappeBrowserWorkSessionExecutor(options: FrappeBrowserWorkSessionOptions): FrappeMissionNodeExecutor {
  const origin = exactHttpsOrigin(options.siteOrigin);
  const maximum = boundedInteger(options.maxActionsPerNode ?? 40, 1, 100, "maxActionsPerNode");
  const now = options.now ?? Date.now;
  const claimedActions = new Map<string, number>();
  const claimTtlMs = 24 * 60 * 60 * 1_000;
  const maximumClaims = 10_000;

  return async (input): Promise<FrappeMissionNodeExecutionResult> => {
    const entry = readNodePlan(input);
    if (entry === undefined) {
      if (options.fallback) return options.fallback(input);
      throw new FrappeBrowserWorkSessionError(`Node ${input.node.id} has no governed browser plan.`);
    }
    validateResourceScope(entry.plan, entry.resourceScope);
    const plan = parsePlan(entry.plan, origin, maximum);
    for (const action of plan.actions) {
      if (!input.effectiveCapabilities.includes(CAPABILITY[action.kind])) {
        throw new FrappeBrowserWorkSessionError(`Browser action ${action.kind} is outside this node's effective capabilities.`);
      }
    }
    if (!input.mission.identity.siteId) throw new FrappeBrowserWorkSessionError("Browser work requires an exact bound Frappe site identity.");
    if (!input.recordEffectStarted || !input.recordEffectCommitted) {
      throw new FrappeBrowserWorkSessionError("Authenticated browser RunEvent boundaries are unavailable.");
    }

    const challenge = randomBytes(32).toString("base64url");
    let bootstrap: FrappeBrowserBootstrap;
    try {
      bootstrap = await options.bootstrap.issue({
        tenantId: input.mission.identity.tenantId,
        siteId: input.mission.identity.siteId,
        siteOrigin: origin,
        userId: input.mission.identity.userId,
        permissionEpoch: input.mission.identity.permissionEpoch,
        missionId: input.mission.missionId,
        rootRunId: input.mission.rootRunId,
        nodeId: input.node.id,
        browserChallenge: challenge,
        ...(plan.attendedCrud ? { attendedCrud: plan.attendedCrud } : {}),
        signal: input.signal,
      });
    } catch {
      throw new FrappeBrowserWorkSessionError("Frappe refused the one-use browser session bootstrap.");
    }
    validateBootstrap(bootstrap, { origin, actor: input.mission.identity.userId, permissionEpoch: input.mission.identity.permissionEpoch, challenge, now: now() });
    if (plan.attendedCrud) validateAttendedBootstrap(bootstrap, plan.attendedCrud);
    const contextId = contextKey(input);
    let session: FrappeBrowserSession | undefined;
    const evidenceIds: string[] = [];
    const observations: Array<{ readonly actionId: string; readonly sha256: string; readonly characters: number }> = [];
    try {
      session = await options.browser.open({ contextId, bootstrap, signal: input.signal });
      validateSession(session, { contextId, origin, actor: input.mission.identity.userId, bootstrapId: bootstrap.bootstrapId });
      for (const [index, action] of plan.actions.entries()) {
        await input.controlCheckpoint?.();
        if (input.signal.aborted) throw new FrappeBrowserWorkSessionError("Browser work was cancelled before the next action.");
        const actionId = `${input.node.id}:${index + 1}`;
        const idempotencyKey = `browser-${digest(`${contextId}:${input.fencingToken}:${index}:${canonicalAction(action)}`).slice(0, 48)}`;
        const replayKey = `${contextId}:${idempotencyKey}`;
        const claimNow = now();
        for (const [key, expiresAt] of claimedActions) if (expiresAt <= claimNow) claimedActions.delete(key);
        if (claimedActions.has(replayKey)) throw new FrappeBrowserWorkSessionError("A duplicate browser action was denied in this gateway lifetime.");
        if (claimedActions.size >= maximumClaims) throw new FrappeBrowserWorkSessionError("The bounded browser duplicate-action guard is full.");
        claimedActions.set(replayKey, claimNow + claimTtlMs);
        let ready: FrappeBrowserActionReady | undefined;
        let started = false;
        let result: FrappeBrowserActionResult;
        try {
          result = await session.perform(action, {
            actionId,
            idempotencyKey,
            signal: input.signal,
            onActionReady: async (candidate) => {
              if (started) throw new FrappeBrowserWorkSessionError("The browser transport repeated an action-ready event.");
              ready = validateReady(candidate, action, actionId, origin);
              started = true;
              await input.recordEffectStarted!(idempotencyKey, {
                summary: `${actionLabel(action)} in an isolated Frappe Desk session.`,
                payload: {
                  ...browserEventPayload(action, ready),
                  ...(index === 0 && bootstrap.formSchema ? { customizationEvidence: customizationEvidence(bootstrap.formSchema) } : {}),
                },
              });
            },
          });
        } catch {
          // Never reflect transport errors: a browser/DOM error may contain form values or cookies.
          throw new FrappeBrowserWorkSessionError(`The isolated browser could not complete action ${index + 1}.`);
        }
        if (!started || !ready) throw new FrappeBrowserWorkSessionError("The browser reported an action without a verified action-ready boundary.");
        validateResult(result, { ready, action, session });
        if (plan.attendedCrud && action.kind === "click" && action.target.name.toLowerCase() === "save") {
          if (!result.serverRecordProof || result.serverRecordProof.doctype !== plan.attendedCrud.doctype || !SHA256.test(result.serverRecordProof.proofHash)) {
            throw new FrappeBrowserWorkSessionError("The attended CRUD Save lacks a server-side reread proof.");
          }
        }
        if (result.rbac !== "allowed") throw new FrappeBrowserWorkSessionError("Frappe denied the browser action for the mission actor.");
        const actionEvidence = validateEvidence(action, result.evidence);
        if (actionEvidence) evidenceIds.push(actionEvidence.id);
        if (action.kind === "read_visible" && typeof result.visibleText === "string") {
          const visible = sanitizeVisibleText(result.visibleText, action.maxChars);
          observations.push({ actionId, sha256: `sha256:${digest(visible)}`, characters: visible.length });
        }
        const receiptHash = `sha256:${digest(JSON.stringify({
          actionId,
          kind: action.kind,
          route: safeDeskRoute(result.route, origin),
          pointer: result.pointer,
          bootstrapId: result.bootstrapId,
          sessionFingerprint: result.sessionFingerprint,
          evidence: actionEvidence?.sha256,
          serverRecordProof: result.serverRecordProof?.proofHash,
        }))}`;
        await input.recordEffectCommitted!(idempotencyKey, receiptHash, actionEvidence ? [actionEvidence.id] : undefined, {
          summary: `${actionLabel(action)} completed and was observed in Frappe Desk.`,
          payload: {
            ...browserEventPayload(action, result),
            verificationStatus: "transport-confirmed",
          },
        });
      }
      const sessionFingerprint = session.sessionFingerprint;
      const closed = await session.close("completed");
      if (closed?.serverSessionRevoked !== true) throw new FrappeBrowserWorkSessionError("The isolated Frappe browser session was not revoked during teardown.");
      session = undefined;
      return {
        summary: `Completed ${plan.actions.length} governed action${plan.actions.length === 1 ? "" : "s"} in an isolated Frappe Desk session.`,
        payload: {
          executionSurface: "browser",
          actionCount: plan.actions.length,
          sessionFingerprint,
          // Raw DOM text can contain PII or prompt injection and never enters RunEvents.
          ...(observations.length ? { untrustedVisibleObservationHashes: observations } : {}),
        },
        evidenceIds: Object.freeze([...new Set(evidenceIds)]),
      };
    } catch (error) {
      if (session) {
        try { await session.close(input.signal.aborted ? "cancelled" : "failed"); } catch { /* preserve authoritative failure */ }
      }
      if (error instanceof FrappeBrowserWorkSessionError) throw error;
      throw new FrappeBrowserWorkSessionError("The isolated Frappe browser session failed closed.");
    }
  };
}

function readNodePlan(input: FrappeMissionNodeExecutionInput): {
  readonly plan: unknown;
  readonly resourceScope: Readonly<Record<string, unknown>>;
} | undefined {
  const manifest = input.mission.executionManifest;
  if (manifest === undefined) return undefined;
  if (!record(manifest) || !exactKeys(manifest, ["schemaVersion", "workflowSnapshotHash", "manifestHash", "nodePlans"]) || manifest.schemaVersion !== 1
    || !record(manifest.nodePlans) || typeof manifest.workflowSnapshotHash !== "string" || typeof manifest.manifestHash !== "string") {
    throw new FrappeBrowserWorkSessionError("The trusted browser execution manifest is invalid.");
  }
  const workflowHash = digest(JSON.stringify(stableValue(input.mission.workflow)));
  const unsigned = { schemaVersion: 1, workflowSnapshotHash: manifest.workflowSnapshotHash, nodePlans: manifest.nodePlans };
  if (manifest.workflowSnapshotHash !== workflowHash || manifest.manifestHash !== digest(JSON.stringify(stableValue(unsigned)))) {
    throw new FrappeBrowserWorkSessionError("The browser execution manifest evidence does not match this workflow.");
  }
  const entry = manifest.nodePlans[input.node.id];
  if (entry === undefined) return undefined;
  if (record(entry) && entry.surface === "server_effect") return undefined;
  if (!record(entry) || !exactKeys(entry, ["surface", "plan", "resourceScope"])
    || entry.surface !== "browser" || !record(entry.resourceScope)) {
    throw new FrappeBrowserWorkSessionError("The trusted browser node manifest is invalid.");
  }
  return { plan: entry.plan, resourceScope: entry.resourceScope };
}

function validateResourceScope(rawPlan: unknown, value: Readonly<Record<string, unknown>>): void {
  if (!exactKeys(value, ["routes", "doctypes", "recordNames", "fields"])) {
    throw new FrappeBrowserWorkSessionError("The trusted browser resource scope is invalid.");
  }
  if (!record(rawPlan) || !Array.isArray(rawPlan.actions) || rawPlan.actions.some((action) => !record(action))) {
    throw new FrappeBrowserWorkSessionError("The governed browser action plan is invalid.");
  }
  const actions = rawPlan.actions as ReadonlyArray<Readonly<Record<string, unknown>>>;
  const values = (key: string) => uniqueSorted(actions.flatMap((action) => typeof action[key] === "string" ? [action[key] as string] : []));
  const expected = {
    routes: values("route"),
    doctypes: values("doctype"),
    recordNames: values("recordName"),
    fields: values("field"),
  };
  for (const key of ["routes", "doctypes", "recordNames", "fields"] as const) {
    if (!Array.isArray(value[key]) || value[key]!.some((item) => typeof item !== "string")
      || JSON.stringify(value[key]) !== JSON.stringify(expected[key])) {
      throw new FrappeBrowserWorkSessionError("The browser plan exceeds its immutable resource scope.");
    }
  }
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}

function parsePlan(value: unknown, origin: string, maximum: number): FrappeBrowserActionPlan {
  if (!record(value) || !exactKeys(value, ["schemaVersion", "actions", "actionBudget", ...(value.attendedCrud === undefined ? [] : ["attendedCrud"])]) || value.schemaVersion !== 1 || !Array.isArray(value.actions)) {
    throw new FrappeBrowserWorkSessionError("The governed browser action plan is invalid.");
  }
  const budget = boundedInteger(value.actionBudget, 1, maximum, "actionBudget");
  if (value.actions.length === 0 || value.actions.length > budget) throw new FrappeBrowserWorkSessionError("The browser plan exceeds its action budget.");
  const actions = value.actions.map((item) => parseAction(item, origin));
  const attendedCrud = value.attendedCrud === undefined ? undefined : parseAttendedCrud(value.attendedCrud);
  if (attendedCrud) {
    const usedFields = uniqueSorted(actions.flatMap((action) => "field" in action ? [action.field] : []));
    if (JSON.stringify(usedFields) !== JSON.stringify(uniqueSorted(attendedCrud.fields))) throw new FrappeBrowserWorkSessionError("The attended CRUD fields do not match the fixed browser actions.");
    for (const action of actions) {
      if (action.kind === "upload") throw new FrappeBrowserWorkSessionError("Attended CRUD v1 does not support attachment field verification.");
      if (action.doctype && action.doctype !== attendedCrud.doctype) throw new FrappeBrowserWorkSessionError("The attended CRUD DocType does not match the fixed browser actions.");
      if (action.recordName && action.recordName !== attendedCrud.record_name) throw new FrappeBrowserWorkSessionError("The attended CRUD record does not match the fixed browser actions.");
    }
  }
  let attendedRouteBound = false;
  for (const action of actions) {
    if (action.route === FRAPPE_ATTENDED_FORM_ROUTE && !attendedRouteBound) throw new FrappeBrowserWorkSessionError("The attended form route token was used before a verified New transition.");
    if ((action.kind === "click" || action.kind === "fill" || action.kind === "select" || action.kind === "upload") && action.postcondition.kind === "bind_route") {
      if (!attendedCrud || attendedCrud.operation !== "create" || attendedRouteBound || action.route === FRAPPE_ATTENDED_FORM_ROUTE || action.postcondition.doctype !== attendedCrud.doctype) {
        throw new FrappeBrowserWorkSessionError("The attended form route binding is invalid.");
      }
      attendedRouteBound = true;
    }
  }
  if (!attendedCrud && actions.some((action) => action.route === FRAPPE_ATTENDED_FORM_ROUTE)) throw new FrappeBrowserWorkSessionError("Only attended CRUD may use a session-bound form route.");
  return Object.freeze({ schemaVersion: 1, actionBudget: budget, actions: Object.freeze(actions), ...(attendedCrud ? { attendedCrud } : {}) });
}

function parseAttendedCrud(value: unknown): FrappeAttendedCrudBinding {
  if (!record(value) || !exactKeys(value, ["operation", "doctype", "record_name", "fields", "schema_hash", "revision"])
    || !["create", "read", "update"].includes(String(value.operation)) || !Array.isArray(value.fields) || value.fields.length > 100
    || (value.record_name !== null && typeof value.record_name !== "string")) {
    throw new FrappeBrowserWorkSessionError("The attended CRUD schema binding is invalid or requests an unsupported lifecycle action.");
  }
  const operation = value.operation as "create" | "read" | "update";
  const doctype = requiredSafeText(value.doctype, "attended CRUD doctype");
  const record_name = value.record_name === null ? null : requiredSafeText(value.record_name, "attended CRUD record");
  if ((operation === "update" && record_name === null) || (operation === "create" && record_name !== null)) throw new FrappeBrowserWorkSessionError("The attended CRUD record binding is invalid.");
  const fields = uniqueSorted(value.fields.map((item) => requiredSafeText(item, "attended CRUD field")));
  if (!SHA256.test(String(value.schema_hash)) || !SHA256.test(String(value.revision))) throw new FrappeBrowserWorkSessionError("The attended CRUD schema evidence is invalid.");
  return Object.freeze({ operation, doctype, record_name, fields, schema_hash: String(value.schema_hash).replace(/^sha256:/, ""), revision: String(value.revision).replace(/^sha256:/, "") });
}

function parseAction(value: unknown, origin: string): FrappeBrowserAction {
  if (!record(value) || typeof value.kind !== "string") throw new FrappeBrowserWorkSessionError("A browser action is invalid.");
  const baseKeys = ["kind", "route", "doctype", "recordName"];
  const route = browserPlanRoute(value.route, origin);
  const base = {
    route,
    ...(optionalSafeText(value.doctype, "doctype") ? { doctype: optionalSafeText(value.doctype, "doctype") } : {}),
    ...(optionalSafeText(value.recordName, "recordName") ? { recordName: optionalSafeText(value.recordName, "recordName") } : {}),
  };
  switch (value.kind) {
    case "navigate":
      assertKeys(value, baseKeys);
      return Object.freeze({ kind: "navigate", ...base });
    case "click": {
      assertKeys(value, [...baseKeys, "target", "postcondition"]);
      const target = parseTarget(value.target);
      const postcondition = parsePostcondition(value.postcondition, origin);
      if ((postcondition.kind === "route" && postcondition.route === route)
        || (postcondition.kind === "target" && postcondition.state === "visible" && sameTarget(postcondition.target, target))) {
        throw new FrappeBrowserWorkSessionError("A click postcondition must prove an observable state change.");
      }
      return Object.freeze({ kind: "click", ...base, target, postcondition });
    }
    case "fill": {
      assertKeys(value, [...baseKeys, "target", "field", "value", "postcondition"]);
      const field = requiredSafeText(value.field, "field");
      if (SECRET_FIELD.test(field)) throw new FrappeBrowserWorkSessionError("Password and secret fields are not available to browser workflows.");
      if (typeof value.value !== "string" || value.value.length > 10_000) throw new FrappeBrowserWorkSessionError("A browser fill value is invalid.");
      return Object.freeze({ kind: "fill", ...base, target: parseTarget(value.target), field, value: value.value, postcondition: parsePostcondition(value.postcondition, origin) });
    }
    case "select": {
      assertKeys(value, [...baseKeys, "target", "field", "option", "postcondition"]);
      const field = requiredSafeText(value.field, "field");
      if (SECRET_FIELD.test(field)) throw new FrappeBrowserWorkSessionError("Secret fields are not available to browser workflows.");
      return Object.freeze({ kind: "select", ...base, target: parseTarget(value.target), field, option: requiredSafeText(value.option, "option"), postcondition: parsePostcondition(value.postcondition, origin) });
    }
    case "upload": {
      assertKeys(value, [...baseKeys, "target", "field", "artifactId", "postcondition"]);
      const field = requiredSafeText(value.field, "field");
      if (SECRET_FIELD.test(field)) throw new FrappeBrowserWorkSessionError("Secret fields are not available to browser workflows.");
      const artifactId = requiredSafeText(value.artifactId, "artifactId");
      if (!SAFE_ID.test(artifactId)) throw new FrappeBrowserWorkSessionError("Uploads require a governed artifact id, never a filesystem path.");
      return Object.freeze({ kind: "upload", ...base, target: parseTarget(value.target), field, artifactId, postcondition: parsePostcondition(value.postcondition, origin) });
    }
    case "screenshot": {
      assertKeys(value, [...baseKeys, "scope", "redactFields"]);
      if (value.scope !== "viewport_redacted" || !Array.isArray(value.redactFields) || value.redactFields.length === 0 || value.redactFields.length > 50) {
        throw new FrappeBrowserWorkSessionError("Screenshots require a bounded viewport and explicit PII redaction fields.");
      }
      const redactFields = value.redactFields.map((item) => requiredSafeText(item, "redact field"));
      return Object.freeze({ kind: "screenshot", ...base, scope: "viewport_redacted", redactFields: Object.freeze(redactFields) });
    }
    case "read_visible": {
      const keys = [...baseKeys, "maxChars", ...(value.target === undefined ? [] : ["target"])];
      assertKeys(value, keys);
      const maxChars = boundedInteger(value.maxChars, 1, 10_000, "maxChars");
      return Object.freeze({ kind: "read_visible", ...base, ...(value.target === undefined ? {} : { target: parseTarget(value.target) }), maxChars });
    }
    default:
      throw new FrappeBrowserWorkSessionError("The browser action kind is not supported.");
  }
}

function parseTarget(value: unknown): FrappeBrowserTarget {
  if (!record(value) || typeof value.kind !== "string") throw new FrappeBrowserWorkSessionError("The semantic browser target is invalid.");
  const name = requiredSafeText(value.name, "target name");
  if (value.kind === "label" || value.kind === "test_id") {
    if (!exactKeys(value, ["kind", "name"])) throw new FrappeBrowserWorkSessionError("The semantic browser target is invalid.");
    return Object.freeze({ kind: value.kind, name });
  }
  if (value.kind !== "role" || !exactKeys(value, ["kind", "role", "name"])) throw new FrappeBrowserWorkSessionError("Raw selectors are not allowed in browser workflows.");
  if (!["button", "link", "textbox", "combobox", "checkbox", "tab"].includes(String(value.role))) throw new FrappeBrowserWorkSessionError("The browser target role is unsupported.");
  return Object.freeze({ kind: "role", role: value.role as "button" | "link" | "textbox" | "combobox" | "checkbox" | "tab", name });
}

function parsePostcondition(value: unknown, origin: string): FrappeBrowserPostcondition {
  if (!record(value) || typeof value.kind !== "string") throw new FrappeBrowserWorkSessionError("A mutating browser action requires a closed postcondition.");
  if (value.kind === "route" && exactKeys(value, ["kind", "route"])) return Object.freeze({ kind: "route", route: safeDeskRoute(value.route, origin) });
  if (value.kind === "target" && exactKeys(value, ["kind", "target", "state"]) && (value.state === "visible" || value.state === "hidden")) {
    return Object.freeze({ kind: "target", target: parseTarget(value.target), state: value.state });
  }
  if (value.kind === "record_saved" && exactKeys(value, ["kind", "doctype", "recordName"]) && (value.recordName === null || typeof value.recordName === "string")) {
    return Object.freeze({ kind: "record_saved", doctype: requiredSafeText(value.doctype, "saved record DocType"), recordName: value.recordName === null ? null : requiredSafeText(value.recordName, "saved record name") });
  }
  if (value.kind === "bind_route" && exactKeys(value, ["kind", "token", "doctype"]) && value.token === "attended_form") {
    return Object.freeze({ kind: "bind_route", token: "attended_form", doctype: requiredSafeText(value.doctype, "bound route DocType") });
  }
  throw new FrappeBrowserWorkSessionError("A mutating browser action requires a closed postcondition.");
}

function sameTarget(left: FrappeBrowserTarget, right: FrappeBrowserTarget): boolean {
  return left.kind === right.kind && left.name === right.name && (left.kind !== "role" || (right.kind === "role" && left.role === right.role));
}

function validateBootstrap(value: FrappeBrowserBootstrap, expected: { origin: string; actor: string; permissionEpoch: string; challenge: string; now: number }): void {
  if (!value || value.siteOrigin !== expected.origin || value.actorId.toLowerCase() !== expected.actor.toLowerCase() || value.permissionEpoch !== expected.permissionEpoch || value.browserChallenge !== expected.challenge) {
    throw new FrappeBrowserWorkSessionError("The browser bootstrap authority does not match this mission.");
  }
  if (!SAFE_ID.test(value.bootstrapId) || value.ticket.length < 32 || value.ticket.length > 4_096) throw new FrappeBrowserWorkSessionError("The browser bootstrap credential is invalid.");
  const expires = Date.parse(value.expiresAt);
  if (!Number.isFinite(expires) || expires <= expected.now || expires > expected.now + 120_000) throw new FrappeBrowserWorkSessionError("The browser bootstrap is stale or overlong.");
}

function validateAttendedBootstrap(value: FrappeBrowserBootstrap, expected: FrappeAttendedCrudBinding): void {
  if (!value.attendedCrud || JSON.stringify(stableValue(value.attendedCrud)) !== JSON.stringify(stableValue(expected)) || !value.formSchema) {
    throw new FrappeBrowserWorkSessionError("Frappe did not bind the attended CRUD session to its effective form schema.");
  }
  parseFormSchemaReceipt(value.formSchema, expected);
}

function parseFormSchemaReceipt(value: unknown, expected: FrappeAttendedCrudBinding): FrappeAttendedFormSchemaReceipt {
  if (!record(value) || !exactKeys(value, ["doctype", "schema_hash", "revision", "customized_fields", "doctype_property_setter_count", "workflow", "client_scripts", "custom_permission_count", "server_script_count", "form_action_count", "form_link_count"])
    || value.doctype !== expected.doctype || value.schema_hash !== expected.schema_hash || value.revision !== expected.revision
    || !Array.isArray(value.customized_fields) || value.customized_fields.length > 100 || !Array.isArray(value.client_scripts) || value.client_scripts.length > 100
    || [value.doctype_property_setter_count, value.custom_permission_count, value.server_script_count, value.form_action_count, value.form_link_count].some((count) => !Number.isInteger(count) || Number(count) < 0)) {
    throw new FrappeBrowserWorkSessionError("Frappe returned invalid or stale effective form schema evidence.");
  }
  const customized_fields = value.customized_fields.map((item) => {
    if (!record(item) || !exactKeys(item, ["fieldname", "label", "source", "property_setter_count"])
      || !["custom_field", "doctype_field"].includes(String(item.source)) || !Number.isInteger(item.property_setter_count) || Number(item.property_setter_count) < 0) {
      throw new FrappeBrowserWorkSessionError("Frappe returned invalid customization provenance.");
    }
    return Object.freeze({ fieldname: requiredSafeText(item.fieldname, "customized field"), label: requiredSafeText(item.label, "customized field label"), source: item.source as "custom_field" | "doctype_field", property_setter_count: Number(item.property_setter_count) });
  });
  // Client Script source is absent by contract. Treat even metadata as evidence
  // only; it is never appended to objectives, prompts, action labels or model input.
  const client_scripts = value.client_scripts.map((item) => {
    if (!record(item) || !exactKeys(item, ["name", "view", "modified"])) throw new FrappeBrowserWorkSessionError("Frappe returned invalid Client Script metadata.");
    return Object.freeze({ name: requiredSafeText(item.name, "Client Script name"), view: requiredSafeText(item.view, "Client Script view"), modified: requiredResponseText(item.modified, "Client Script revision", 128) });
  });
  return Object.freeze({ doctype: expected.doctype, schema_hash: expected.schema_hash, revision: expected.revision, customized_fields: Object.freeze(customized_fields), doctype_property_setter_count: Number(value.doctype_property_setter_count), workflow: value.workflow, client_scripts: Object.freeze(client_scripts), custom_permission_count: Number(value.custom_permission_count), server_script_count: Number(value.server_script_count), form_action_count: Number(value.form_action_count), form_link_count: Number(value.form_link_count) });
}

function validateSession(session: FrappeBrowserSession, expected: { contextId: string; origin: string; actor: string; bootstrapId: string }): void {
  if (!session.bootstrapConsumed || session.contextId !== expected.contextId || session.siteOrigin !== expected.origin || session.actorId.toLowerCase() !== expected.actor.toLowerCase() || session.bootstrapId !== expected.bootstrapId || !SAFE_ID.test(session.sessionFingerprint)) {
    throw new FrappeBrowserWorkSessionError("The isolated browser session did not prove its one-use bootstrap authority.");
  }
}

function validateReady(value: FrappeBrowserActionReady, action: FrappeBrowserAction, actionId: string, origin: string): FrappeBrowserActionReady {
  if (!value || value.actionId !== actionId || value.kind !== action.kind) throw new FrappeBrowserWorkSessionError("The browser action-ready boundary does not match the fixed action.");
  const actualRoute = safeDeskRoute(value.route, origin);
  if (action.route !== FRAPPE_ATTENDED_FORM_ROUTE && actualRoute !== action.route) throw new FrappeBrowserWorkSessionError("The browser action-ready boundary does not match the fixed action.");
  const pointer = validatePointer(value.pointer);
  return Object.freeze({ actionId, kind: action.kind, route: actualRoute, pointer });
}

function validateResult(result: FrappeBrowserActionResult, expected: { ready: FrappeBrowserActionReady; action: FrappeBrowserAction; session: FrappeBrowserSession }): void {
  if (!result || result.performed !== true || result.postconditionVerified !== true || result.actionId !== expected.ready.actionId || result.kind !== expected.action.kind || !resultRouteMatches(expected.action, safeDeskRoute(result.route, expected.session.siteOrigin), expected.ready.route) || result.bootstrapId !== expected.session.bootstrapId || result.sessionFingerprint !== expected.session.sessionFingerprint) {
    throw new FrappeBrowserWorkSessionError("The browser action receipt does not match the isolated session and fixed action.");
  }
  const pointer = validatePointer(result.pointer);
  if (pointer.x !== expected.ready.pointer.x || pointer.y !== expected.ready.pointer.y) throw new FrappeBrowserWorkSessionError("The browser pointer receipt drifted from the actual action boundary.");
}

function resultRouteMatches(action: FrappeBrowserAction, observed: string, readyRoute: string): boolean {
  if ((action.kind === "click" || action.kind === "fill" || action.kind === "select" || action.kind === "upload") && action.postcondition.kind === "bind_route") {
    const parts = observed.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
    return parts.length >= 3 && parts.at(-2)?.toLowerCase().replaceAll("-", " ") === action.postcondition.doctype.toLowerCase().replaceAll("-", " ") && Boolean(parts.at(-1));
  }
  if ((action.kind === "click" || action.kind === "fill" || action.kind === "select" || action.kind === "upload") && action.postcondition.kind === "record_saved") {
    const parts = observed.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
    const expectedDoctype = action.postcondition.doctype;
    const recordName = parts.at(-1) ?? "";
    return parts.length >= 3 && parts.at(-2)?.toLowerCase().replaceAll("-", " ") === expectedDoctype.toLowerCase().replaceAll("-", " ")
      && !recordName.startsWith("new-") && (action.postcondition.recordName === null || recordName === action.postcondition.recordName);
  }
  if (action.route === FRAPPE_ATTENDED_FORM_ROUTE) return observed === readyRoute;
  return observed === expectedResultRoute(action);
}

function browserPlanRoute(value: unknown, origin: string): string {
  return value === FRAPPE_ATTENDED_FORM_ROUTE ? FRAPPE_ATTENDED_FORM_ROUTE : safeDeskRoute(value, origin);
}

function validateEvidence(action: FrappeBrowserAction, evidence: FrappeBrowserActionResult["evidence"]): FrappeBrowserActionResult["evidence"] | undefined {
  if (!evidence) {
    if (action.kind === "screenshot") throw new FrappeBrowserWorkSessionError("The screenshot action returned no evidence.");
    return undefined;
  }
  if (!SAFE_ID.test(evidence.id) || !SHA256.test(evidence.sha256)) throw new FrappeBrowserWorkSessionError("Browser evidence is invalid.");
  if (action.kind === "screenshot" && (evidence.maskingScope !== "explicit_fields_and_password_controls" || evidence.requestedMasksVerified !== true)) {
    throw new FrappeBrowserWorkSessionError("Screenshot evidence without a verified explicit masking scope was denied.");
  }
  return evidence;
}

function browserEventPayload(action: FrappeBrowserAction, event: FrappeBrowserActionReady | FrappeBrowserActionResult): Readonly<Record<string, unknown>> {
  return Object.freeze({
    executionSurface: "browser",
    takeoverLabel: "Muster has taken over",
    actionType: action.kind,
    actionLabel: actionLabel(action),
    route: event.route,
    pointer: event.pointer,
    ...(action.doctype ? { doctype: action.doctype } : {}),
    ...(action.recordName ? { recordName: action.recordName } : {}),
    ...("field" in action ? { fieldsAffected: [action.field] } : {}),
  });
}

function customizationEvidence(schema: FrappeAttendedFormSchemaReceipt): Readonly<Record<string, unknown>> {
  return Object.freeze({
    doctype: schema.doctype,
    schemaHash: schema.schema_hash,
    revision: schema.revision,
    customFieldCount: schema.customized_fields.filter((field) => field.source === "custom_field").length,
    propertySetterCount: schema.doctype_property_setter_count + schema.customized_fields.reduce((total, field) => total + field.property_setter_count, 0),
    workflowDetected: schema.workflow !== null,
    clientScriptCount: schema.client_scripts.length,
    clientScriptSourceUsedForPlanning: false,
    customPermissionCount: schema.custom_permission_count,
    serverScriptCount: schema.server_script_count,
    serverScriptSourceUsedForPlanning: false,
    formActionCount: schema.form_action_count,
    formLinkCount: schema.form_link_count,
  });
}

function expectedResultRoute(action: FrappeBrowserAction): string {
  return (action.kind === "click" || action.kind === "fill" || action.kind === "select" || action.kind === "upload") && action.postcondition.kind === "route"
    ? action.postcondition.route
    : action.route;
}

function actionLabel(action: FrappeBrowserAction): string {
  const target = "target" in action && action.target ? ` ${action.target.name}` : "";
  return `${({ navigate: "Open", click: "Click", fill: "Fill", select: "Select", upload: "Upload to", screenshot: "Capture", read_visible: "Read" } as const)[action.kind]}${target}`.slice(0, 180);
}

function safeDeskRoute(value: unknown, origin: string): string {
  if (typeof value !== "string" || value.length > 500 || value.includes("\\") || value.includes("\0")) throw new FrappeBrowserWorkSessionError("The browser route is invalid.");
  let parsed: URL;
  try { parsed = new URL(value, origin); } catch { throw new FrappeBrowserWorkSessionError("The browser route is invalid."); }
  if (parsed.origin !== origin || parsed.username || parsed.password || parsed.search || parsed.hash || !(parsed.pathname === "/desk" || parsed.pathname.startsWith("/desk/"))) {
    throw new FrappeBrowserWorkSessionError("Browser work is restricted to the exact bound Frappe Desk origin.");
  }
  return parsed.pathname;
}

function exactHttpsOrigin(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new FrappeBrowserWorkSessionError("The Frappe site origin is invalid."); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new FrappeBrowserWorkSessionError("Browser work requires an exact HTTPS Frappe site origin.");
  return parsed.origin;
}

function validatePointer(value: unknown): { readonly x: number; readonly y: number } {
  if (!record(value) || !exactKeys(value, ["x", "y"]) || typeof value.x !== "number" || typeof value.y !== "number" || !Number.isFinite(value.x) || !Number.isFinite(value.y) || value.x < 0 || value.x > 100 || value.y < 0 || value.y > 100) {
    throw new FrappeBrowserWorkSessionError("The browser transport did not report bounded pointer coordinates.");
  }
  return Object.freeze({ x: value.x, y: value.y });
}

function sanitizeVisibleText(value: string, maximum: number): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ").slice(0, maximum);
}

function contextKey(input: FrappeMissionNodeExecutionInput): string {
  return `frappe-browser:${digest([input.mission.identity.tenantId, input.mission.identity.siteId, input.mission.identity.userId.toLowerCase(), input.mission.missionId, input.node.id, input.attemptId].join("\0"))}`;
}

function canonicalAction(action: FrappeBrowserAction): string {
  return JSON.stringify(stableValue(action));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!record(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new FrappeBrowserWorkSessionError(`${label} is outside its safe bound.`);
  return value as number;
}

function requiredSafeText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\u0000-\u001F]/.test(value)) throw new FrappeBrowserWorkSessionError(`${label} is invalid.`);
  return value.trim();
}

function requiredResponseText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum || /[\u0000-\u001F]/.test(value)) throw new FrappeBrowserWorkSessionError(`Frappe browser bootstrap ${label} is invalid.`);
  return value;
}

function optionalSafeText(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredSafeText(value, label);
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const optional = new Set(["doctype", "recordName"]);
  const actual = Object.keys(value);
  if (actual.some((key) => !allowed.includes(key)) || allowed.some((key) => !optional.has(key) && !(key in value))) throw new FrappeBrowserWorkSessionError("A browser action has unknown or missing fields.");
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return record(value) ? value : undefined;
}
