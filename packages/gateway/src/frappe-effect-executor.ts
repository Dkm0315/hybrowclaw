import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type {
  FrappeMissionNodeExecutionInput,
  FrappeMissionNodeExecutionResult,
  FrappeMissionNodeExecutor,
} from "./frappe-mission-bridge.js";
import type { FrappeSiteBindingCoordinator } from "./frappe-connect.js";

/**
 * This module is deliberately not a generic HTTP or tool adapter. The only
 * possible effects are the operations in CAPABILITY_REGISTRY and transports
 * receive typed data, never a URL, method name, command, script, or tool id.
 */
export const FRAPPE_EFFECT_CALLBACK_PATH = "/api/method/muster.api.effect_callback.execute" as const;

const CAPABILITY_REGISTRY = Object.freeze({
  "frappe.record.create": { family: "record", action: "create", risk: "write" },
  "frappe.record.update": { family: "record", action: "update", risk: "write" },
  "frappe.record.submit": { family: "record", action: "submit", risk: "business_state" },
  "frappe.record.apply_workflow": { family: "record", action: "apply_workflow", risk: "business_state" },
  "frappe.record.delete": { family: "record", action: "delete", risk: "destructive" },
  "frappe.metadata.custom_field.create": { family: "native", artifact: "custom_field", risk: "metadata" },
  "frappe.metadata.property_setter.create": { family: "native", artifact: "property_setter", risk: "metadata" },
  "frappe.metadata.doctype.create": { family: "native", artifact: "doctype", risk: "metadata" },
  "frappe.metadata.page.create": { family: "native", artifact: "page", risk: "metadata" },
  "frappe.metadata.report.create": { family: "native", artifact: "report", risk: "executable" },
  "frappe.metadata.print_format.create": { family: "native", artifact: "print_format", risk: "executable" },
  "frappe.metadata.web_page.create": { family: "native", artifact: "web_page", risk: "executable" },
} as const);

export type GovernedFrappeCapability = keyof typeof CAPABILITY_REGISTRY;
type RegisteredCapability = (typeof CAPABILITY_REGISTRY)[GovernedFrappeCapability];
type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

export interface FrappeEffectAuthoritySnapshot {
  readonly tenantId: string;
  readonly siteId: string;
  readonly siteOrigin: string;
  readonly userId: string;
  readonly permissionEpoch: string;
  readonly rolesHash?: string;
  readonly schemaRevision: string;
  readonly dataRevision: string;
}

export interface FrappeBoundApprovalReceipt {
  readonly receiptId: string;
  readonly planHash: string;
  readonly actor: string;
  readonly approvers: readonly string[];
  readonly approvedAt: string;
  readonly expiresAt: string;
  readonly scope: readonly string[];
  readonly approvalClass: "single" | "dual_control";
  /** Opaque host signature. It is passed only to the fixed safe-write/native endpoint. */
  readonly proof: Readonly<Record<string, Json>>;
}

export interface GovernedFrappeRecordOperation {
  readonly kind: "record";
  readonly action: "create" | "update" | "submit" | "apply_workflow" | "delete";
  readonly doctype: string;
  readonly docname?: string;
  readonly values: Readonly<Record<string, Json>>;
  readonly expectedModified?: string;
  readonly workflowAction?: string;
}

export interface GovernedFrappeNativeOperation {
  readonly kind: "native_artifact";
  readonly artifactType: "custom_field" | "property_setter" | "doctype" | "page" | "report" | "print_format" | "web_page";
  /** The Frappe app validates this declarative artifact intent again. */
  readonly intent: Readonly<Record<string, Json>>;
}

export type GovernedFrappeOperation = GovernedFrappeRecordOperation | GovernedFrappeNativeOperation;

export interface GovernedFrappeEffectPlan {
  readonly schemaVersion: 1;
  readonly capability: GovernedFrappeCapability;
  readonly authority: FrappeEffectAuthoritySnapshot;
  readonly operation: GovernedFrappeOperation;
  readonly idempotencyKey: string;
  readonly postconditions: readonly {
    readonly path: string;
    readonly operator: "equals" | "exists" | "absent";
    readonly expected?: Json;
  }[];
  readonly approval: FrappeBoundApprovalReceipt;
  readonly planHash: string;
}

export interface FrappeEffectProposal {
  readonly planHash: string;
  readonly authority: FrappeEffectAuthoritySnapshot;
  readonly summary: string;
  readonly approvalBindingHash: string;
}

export interface FrappeEffectApplication {
  readonly receiptId: string;
  readonly resultRef: Readonly<Record<string, Json>>;
  readonly evidenceIds: readonly string[];
  /** API/native-builder effects never imply visible browser control. */
  readonly executionSurface?: "server_side";
  readonly siteReceiptSignature?: string;
}

export interface FrappeEffectExecutionContext {
  readonly missionId: string;
  readonly rootRunId: string;
  readonly nodeId: string;
  readonly actor: string;
}

export interface GovernedFrappeEffectTransport {
  /** Must call Frappe live as the execution principal; cached identity is invalid here. */
  resolveAuthority(input: {
    readonly execution: FrappeEffectExecutionContext;
    readonly authority: FrappeEffectAuthoritySnapshot;
    readonly operation: GovernedFrappeOperation;
    readonly signal: AbortSignal;
  }): Promise<FrappeEffectAuthoritySnapshot>;
  /** Must be a dry run. It may not mutate Frappe. */
  plan(input: {
    readonly execution: FrappeEffectExecutionContext;
    readonly plan: GovernedFrappeEffectPlan;
    readonly signal: AbortSignal;
  }): Promise<FrappeEffectProposal>;
  /** Fixed frappe_safe_write or native-builder apply implementation. */
  apply(input: {
    readonly execution: FrappeEffectExecutionContext;
    readonly plan: GovernedFrappeEffectPlan;
    readonly proposal: FrappeEffectProposal;
    readonly fencingToken: number;
    readonly signal: AbortSignal;
  }): Promise<FrappeEffectApplication>;
  /** Independent read after apply; apply's own verification claim is ignored. */
  observe(input: {
    readonly execution: FrappeEffectExecutionContext;
    readonly plan: GovernedFrappeEffectPlan;
    readonly application: FrappeEffectApplication;
    readonly signal: AbortSignal;
  }): Promise<Readonly<Record<string, Json>>>;
  /** Uses only the preplanned inverse owned by the fixed transport. */
  compensate?(input: {
    readonly execution: FrappeEffectExecutionContext;
    readonly plan: GovernedFrappeEffectPlan;
    readonly application: FrappeEffectApplication;
    readonly fencingToken: number;
    readonly signal: AbortSignal;
  }): Promise<{ readonly repaired: boolean; readonly evidenceIds: readonly string[] }>;
}

export interface CapabilityPackFrappeEffectPorts {
  /** Host-bound live resolver; must call the Frappe site, not a cache. */
  readonly resolveAuthority: GovernedFrappeEffectTransport["resolveAuthority"];
  /** Exactly capability-packs/frappe frappe_safe_write, already bound to actor OAuth/token context. */
  readonly frappeSafeWrite: (args: Readonly<Record<string, unknown>>) => Promise<unknown>;
  /** Independent Frappe resource read. It is intentionally not a generic request function. */
  readonly readRecord: (input: { readonly doctype: string; readonly docname: string; readonly signal: AbortSignal }) => Promise<Readonly<Record<string, Json>> | undefined>;
  /** Fixed Muster native-builder endpoints, when the custom app is installed. */
  readonly nativeBuilder?: {
    preview(intent: Readonly<Record<string, Json>>, signal: AbortSignal): Promise<{ readonly changeSet: string; readonly planHash: string; readonly summary: string }>;
    apply(changeSet: string, signal: AbortSignal): Promise<{ readonly status: "Verified"; readonly receiptId: string; readonly resultRef: Readonly<Record<string, Json>>; readonly evidenceIds: readonly string[] }>;
    observe(changeSet: string, signal: AbortSignal): Promise<Readonly<Record<string, Json>>>;
    rollback?(changeSet: string, signal: AbortSignal): Promise<{ readonly repaired: boolean; readonly evidenceIds: readonly string[] }>;
  };
}

/**
 * Concrete adapter for the existing capability-pack safe-write and Muster
 * native-builder surfaces. The ports are named functions rather than a tool
 * registry, so model text can never choose a tool or route.
 */
export function createCapabilityPackFrappeEffectTransport(ports: CapabilityPackFrappeEffectPorts): GovernedFrappeEffectTransport {
  const nativePlans = new Map<string, string>();
  return {
    resolveAuthority: ports.resolveAuthority,
    async plan({ plan, signal }) {
      if (plan.operation.kind === "record") {
        const args = safeWriteArgs(plan);
        const dryRun = requiredRecord(await ports.frappeSafeWrite(args), "frappe_safe_write dry-run result");
        if (dryRun.status !== "approval_required") throw new GovernedFrappeEffectError(`Frappe safe-write dry run did not reach approval_required (${String(dryRun.status ?? dryRun.error ?? "unknown")}).`);
        const proposal = requiredRecord(dryRun.approvalProposal, "frappe_safe_write approval proposal");
        const receipt = requiredRecord(plan.approval.proof.frappeSafeWriteReceipt, "frappe_safe_write approval receipt");
        if (hash(receipt.proposal) !== hash(proposal)) throw new GovernedFrappeEffectError("Frappe safe-write receipt is bound to another dry-run proposal.");
        return { planHash: plan.planHash, authority: plan.authority, summary: typeof proposal.humanSummary === "string" ? proposal.humanSummary : "Governed Frappe record mutation", approvalBindingHash: hash(plan.approval) };
      }
      if (!ports.nativeBuilder) throw new GovernedFrappeEffectError("Muster native-builder endpoints are unavailable on this Frappe site.");
      const preview = await ports.nativeBuilder.preview(plan.operation.intent, signal);
      const proof = requiredRecord(plan.approval.proof.nativeBuilderApproval, "native-builder approval proof");
      if (proof.changeSet !== preview.changeSet || proof.planHash !== preview.planHash) throw new GovernedFrappeEffectError("Native-builder approval is bound to another persisted Frappe Change Set.");
      nativePlans.set(plan.planHash, preview.changeSet);
      return { planHash: plan.planHash, authority: plan.authority, summary: preview.summary, approvalBindingHash: hash(plan.approval) };
    },
    async apply({ plan, signal }) {
      if (plan.operation.kind === "record") {
        const receipt = requiredRecord(plan.approval.proof.frappeSafeWriteReceipt, "frappe_safe_write approval receipt");
        const executed = requiredRecord(await ports.frappeSafeWrite({ ...safeWriteArgs(plan), approvalReceipt: receipt, approvalNote: "Approved through a hash-bound Muster mission gate." }), "frappe_safe_write execution result");
        const verification = requiredRecord(executed.verification, "frappe_safe_write verification");
        if (executed.status !== "executed" || verification.verified !== true) throw new GovernedFrappeEffectError(typeof executed.error === "string" ? executed.error : "Frappe safe-write did not return a verified execution.", "needs_intervention");
        const result = requiredRecord(executed.result, "frappe_safe_write result");
        const resultRef = (record(result.created) ?? record(result.updated) ?? result) as Readonly<Record<string, Json>>;
        const receiptId = typeof receipt.signature === "string" ? `frappe-safe-write:${hash(receipt.signature)}` : `frappe-safe-write:${hash(receipt)}`;
        return { receiptId, resultRef, evidenceIds: Array.isArray(executed.evidenceLog) ? executed.evidenceLog.filter((item): item is string => typeof item === "string") : [] };
      }
      if (!ports.nativeBuilder) throw new GovernedFrappeEffectError("Muster native-builder endpoints are unavailable on this Frappe site.");
      const changeSet = nativePlans.get(plan.planHash);
      if (!changeSet) throw new GovernedFrappeEffectError("Native-builder preview is absent or stale.");
      return ports.nativeBuilder.apply(changeSet, signal);
    },
    async observe({ plan, application, signal }) {
      if (plan.operation.kind === "native_artifact") {
        const changeSet = nativePlans.get(plan.planHash);
        if (!ports.nativeBuilder || !changeSet) throw new GovernedFrappeEffectError("Native-builder observation is unavailable.");
        return ports.nativeBuilder.observe(changeSet, signal);
      }
      const name = plan.operation.docname ?? (typeof application.resultRef.name === "string" ? application.resultRef.name : "");
      if (plan.operation.action === "delete") {
        const found = name ? await ports.readRecord({ doctype: plan.operation.doctype, docname: name, signal }) : undefined;
        return found ? { deleted: false } : { deleted: true };
      }
      if (!name) throw new GovernedFrappeEffectError("Frappe effect returned no record name for independent verification.", "needs_intervention");
      const observed = await ports.readRecord({ doctype: plan.operation.doctype, docname: name, signal });
      if (!observed) throw new GovernedFrappeEffectError("Frappe record is missing during independent verification.", "needs_intervention");
      return observed;
    },
    async compensate({ plan, signal }) {
      if (plan.operation.kind !== "native_artifact" || !ports.nativeBuilder?.rollback) return { repaired: false, evidenceIds: [] };
      const changeSet = nativePlans.get(plan.planHash);
      return changeSet ? ports.nativeBuilder.rollback(changeSet, signal) : { repaired: false, evidenceIds: [] };
    },
  };
}

/**
 * Production transport for a reciprocally verified site binding. It has no URL,
 * method, tool, or code input: every operation is a signed POST to the one fixed
 * Muster callback installed by the Frappe app.
 */
export function createVerifiedBindingFrappeEffectTransport(options: {
  readonly bindings: FrappeSiteBindingCoordinator;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}): GovernedFrappeEffectTransport {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 30_000, 60_000));

  const invoke = async (phase: "resolve" | "plan" | "apply" | "observe" | "compensate", execution: FrappeEffectExecutionContext, authority: FrappeEffectAuthoritySnapshot, content: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<Record<string, unknown>> => {
    const binding = options.bindings.verifiedBinding({ tenantId: authority.tenantId, siteUuid: authority.siteId, siteOrigin: authority.siteOrigin });
    if (!binding) throw new GovernedFrappeEffectError("No reciprocally verified Frappe site binding matches this effect authority.");
    const envelope = {
      schema_version: 1,
      phase,
      binding_id: binding.bindingId,
      tenant_id: authority.tenantId,
      site_id: authority.siteId,
      site_origin: authority.siteOrigin,
      mission_id: execution.missionId,
      root_run_id: execution.rootRunId,
      node_id: execution.nodeId,
      actor: execution.actor,
      ...content,
    };
    const body = JSON.stringify({ envelope });
    const timestamp = String(Math.floor(now() / 1_000));
    const nonce = randomBytes(24).toString("base64url");
    const bodyHash = createHash("sha256").update(body).digest("hex");
    const signature = createHmac("sha256", binding.secrets.hmacSecret).update(`${timestamp}\n${nonce}\n${bodyHash}`).digest("hex");
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    const response = await fetcher(new URL(FRAPPE_EFFECT_CALLBACK_PATH, binding.siteOrigin), {
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
      signal: combined,
    });
    if (response.status >= 300 && response.status < 400) throw new GovernedFrappeEffectError("Frappe effect callback refused a redirect.");
    const raw = await response.text();
    if (Buffer.byteLength(raw) > 1_048_576) throw new GovernedFrappeEffectError("Frappe effect callback response exceeded 1 MiB.");
    let decoded: unknown;
    try { decoded = JSON.parse(raw); } catch { throw new GovernedFrappeEffectError("Frappe effect callback returned invalid JSON."); }
    if (!response.ok) {
      const failure = record(decoded);
      throw new GovernedFrappeEffectError(typeof failure?.exception === "string" ? "Frappe rejected the governed effect." : `Frappe effect callback failed with HTTP ${response.status}.`);
    }
    const outer = requiredRecord(decoded, "Frappe callback response");
    return requiredRecord(outer.message, "Frappe callback message");
  };

  return {
    async resolveAuthority({ execution, authority, operation, signal }) {
      const result = await invoke("resolve", execution, authority, { authority, operation }, signal);
      return parseAuthority(result.authority);
    },
    async plan({ execution, plan, signal }) {
      const result = await invoke("plan", execution, plan.authority, { plan }, signal);
      const proposal = requiredRecord(result.proposal, "Frappe callback proposal");
      return {
        planHash: String(proposal.planHash),
        authority: parseAuthority(proposal.authority),
        summary: String(proposal.summary),
        approvalBindingHash: String(proposal.approvalBindingHash),
      };
    },
    async apply({ execution, plan, proposal, fencingToken, signal }) {
      const result = await invoke("apply", execution, plan.authority, { plan, proposal, fencing_token: fencingToken }, signal);
      const application = requiredRecord(result.application, "Frappe callback application");
      const resultRef = requiredRecord(application.resultRef, "Frappe callback resultRef");
      if (!safeId(application.receiptId) || !Array.isArray(application.evidenceIds) || application.evidenceIds.some((item) => !safeId(item))) deny("Frappe callback application is invalid.");
      assertJson(resultRef, "application.resultRef");
      if (application.executionSurface !== "server_side") deny("Frappe callback must label API/native-builder effects as server_side.");
      const expectedReceipt = createHmac("sha256", bindingSecret(options.bindings, plan.authority)).update(canonical({ plan: plan.planHash, result: resultRef })).digest("hex");
      if (typeof application.receiptSignature !== "string" || application.receiptSignature !== expectedReceipt) deny("Frappe callback receipt signature is invalid.");
      return { receiptId: application.receiptId as string, resultRef: resultRef as Record<string, Json>, evidenceIds: application.evidenceIds as string[], executionSurface: "server_side", siteReceiptSignature: application.receiptSignature };
    },
    async observe({ execution, plan, application, signal }) {
      const result = await invoke("observe", execution, plan.authority, { plan, application }, signal);
      const observation = requiredRecord(result.observation, "Frappe callback observation");
      assertJson(observation, "observation");
      return observation as Record<string, Json>;
    },
    async compensate({ execution, plan, application, fencingToken, signal }) {
      const result = await invoke("compensate", execution, plan.authority, { plan, application, fencing_token: fencingToken }, signal);
      const compensation = requiredRecord(result.compensation, "Frappe callback compensation");
      if (typeof compensation.repaired !== "boolean" || !Array.isArray(compensation.evidenceIds) || compensation.evidenceIds.some((item) => !safeId(item))) deny("Frappe callback compensation is invalid.");
      return { repaired: compensation.repaired, evidenceIds: compensation.evidenceIds as string[] };
    },
  };
}

function bindingSecret(bindings: FrappeSiteBindingCoordinator, authority: FrappeEffectAuthoritySnapshot): string {
  const binding = bindings.verifiedBinding({ tenantId: authority.tenantId, siteUuid: authority.siteId, siteOrigin: authority.siteOrigin });
  if (!binding) deny("Verified Frappe binding disappeared before receipt validation.");
  return binding!.secrets.hmacSecret;
}

function safeWriteArgs(plan: GovernedFrappeEffectPlan): Readonly<Record<string, unknown>> {
  if (plan.operation.kind !== "record") throw new TypeError("safeWriteArgs accepts record operations only.");
  return {
    operation: plan.operation.action,
    doctype: plan.operation.doctype,
    doc: plan.operation.values,
    ...(plan.operation.docname ? { docname: plan.operation.docname } : {}),
    ...(plan.operation.expectedModified ? { expected_modified: plan.operation.expectedModified } : {}),
    ...(plan.operation.workflowAction ? { action: plan.operation.workflowAction } : {}),
    permissionEpoch: plan.authority.permissionEpoch,
    schemaRevision: plan.authority.schemaRevision,
    dataRevision: plan.authority.dataRevision,
  };
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  const row = record(value);
  if (!row) throw new GovernedFrappeEffectError(`${label} must be an object.`);
  return row;
}

export interface FrappeEffectPolicy {
  readonly allowDestructive?: boolean;
  readonly allowExecutableMetadata?: boolean;
  readonly allowSecurityMetadata?: boolean;
  readonly requireDualControlForBusinessState?: boolean;
}

interface ClaimInput {
  readonly scopeKey: string;
  readonly idempotencyKey: string;
  readonly planHash: string;
  readonly approvalReceiptId: string;
  readonly approvalHash: string;
  readonly fencingToken: number;
}

export type FrappeEffectClaim =
  | { readonly status: "claimed" }
  | { readonly status: "replayed"; readonly result: FrappeMissionNodeExecutionResult }
  | { readonly status: "conflict"; readonly reason: string };

export interface GovernedFrappeEffectStore {
  claim(input: ClaimInput): FrappeEffectClaim;
  commit(input: ClaimInput, result: FrappeMissionNodeExecutionResult, receiptHash: string): void;
  fail(input: ClaimInput, reason: string): void;
  close(): void;
}

interface SqliteStatement {
  run(...params: unknown[]): { readonly changes?: number | bigint };
  get(...params: unknown[]): unknown;
}
interface SqliteDatabase { exec(sql: string): void; prepare(sql: string): SqliteStatement; close(): void }

/** Durable single-use approval + idempotency/fencing ledger. */
export class SqliteGovernedFrappeEffectStore implements GovernedFrappeEffectStore {
  readonly #db: SqliteDatabase;
  constructor(filename: string) {
    if (!filename.trim()) throw new Error("Frappe effect ledger filename must be non-empty.");
    mkdirSync(dirname(filename), { recursive: true });
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new(path: string) => SqliteDatabase };
    this.#db = new DatabaseSync(filename);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS governed_frappe_effects (
        scope_key TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        plan_hash TEXT NOT NULL,
        approval_receipt_id TEXT NOT NULL UNIQUE,
        approval_hash TEXT NOT NULL,
        fencing_token INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('claimed','committed','failed')),
        receipt_hash TEXT,
        result_json TEXT,
        failure_reason TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(scope_key, idempotency_key)
      );
    `);
  }
  claim(input: ClaimInput): FrappeEffectClaim {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#db.prepare("SELECT * FROM governed_frappe_effects WHERE scope_key=? AND idempotency_key=?").get(input.scopeKey, input.idempotencyKey) as Record<string, unknown> | undefined;
      if (existing) {
        if (existing.plan_hash !== input.planHash || existing.approval_hash !== input.approvalHash || existing.approval_receipt_id !== input.approvalReceiptId) {
          this.#db.exec("ROLLBACK");
          return { status: "conflict", reason: "Idempotency key is bound to another plan or approval." };
        }
        if (Number(existing.fencing_token) > input.fencingToken) {
          this.#db.exec("ROLLBACK");
          return { status: "conflict", reason: "A stale fencing token cannot replay or commit this effect." };
        }
        if (existing.state === "committed" && typeof existing.result_json === "string") {
          const result = JSON.parse(existing.result_json) as FrappeMissionNodeExecutionResult;
          this.#db.exec("COMMIT");
          return { status: "replayed", result };
        }
        this.#db.exec("ROLLBACK");
        return { status: "conflict", reason: existing.state === "claimed" ? "A prior effect is still in-flight or its outcome is unknown." : "A prior failed effect requires a fresh plan and approval." };
      }
      const approval = this.#db.prepare("SELECT scope_key,idempotency_key FROM governed_frappe_effects WHERE approval_receipt_id=?").get(input.approvalReceiptId);
      if (approval) {
        this.#db.exec("ROLLBACK");
        return { status: "conflict", reason: "Approval receipt was already consumed." };
      }
      this.#db.prepare("INSERT INTO governed_frappe_effects(scope_key,idempotency_key,plan_hash,approval_receipt_id,approval_hash,fencing_token,state,updated_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(input.scopeKey, input.idempotencyKey, input.planHash, input.approvalReceiptId, input.approvalHash, input.fencingToken, "claimed", Date.now());
      this.#db.exec("COMMIT");
      return { status: "claimed" };
    } catch (error) {
      try { this.#db.exec("ROLLBACK"); } catch { /* preserve original */ }
      throw error;
    }
  }
  commit(input: ClaimInput, result: FrappeMissionNodeExecutionResult, receiptHash: string): void {
    const changed = this.#db.prepare("UPDATE governed_frappe_effects SET state='committed',receipt_hash=?,result_json=?,updated_at=? WHERE scope_key=? AND idempotency_key=? AND plan_hash=? AND approval_hash=? AND fencing_token=? AND state='claimed'")
      .run(receiptHash, JSON.stringify(result), Date.now(), input.scopeKey, input.idempotencyKey, input.planHash, input.approvalHash, input.fencingToken).changes;
    if (Number(changed ?? 0) !== 1) throw new Error("Frappe effect commit lost its fencing or idempotency claim.");
  }
  fail(input: ClaimInput, reason: string): void {
    this.#db.prepare("UPDATE governed_frappe_effects SET state='failed',failure_reason=?,updated_at=? WHERE scope_key=? AND idempotency_key=? AND plan_hash=? AND approval_hash=? AND fencing_token=? AND state='claimed'")
      .run(reason.slice(0, 500), Date.now(), input.scopeKey, input.idempotencyKey, input.planHash, input.approvalHash, input.fencingToken);
  }
  close(): void { this.#db.close(); }
}

export class GovernedFrappeEffectError extends Error {
  constructor(message: string, readonly disposition: "denied" | "compensated" | "needs_intervention" = "denied") {
    super(message); this.name = "GovernedFrappeEffectError";
  }
}

export function createEffectfulFrappeMissionExecutor(options: {
  readonly transport: GovernedFrappeEffectTransport;
  readonly store: GovernedFrappeEffectStore;
  readonly fallback: FrappeMissionNodeExecutor;
  readonly policy?: FrappeEffectPolicy;
  readonly now?: () => Date;
}): FrappeMissionNodeExecutor {
  const now = options.now ?? (() => new Date());
  return async (input) => {
    const raw = effectForNode(input);
    if (raw === undefined) return options.fallback(input);
    const plan = parsePlan(raw);
    const registered = CAPABILITY_REGISTRY[plan.capability];
    enforceCapabilityAndOperation(input, plan, registered, options.policy ?? {});
    const expectedHash = hash(planIntent(plan));
    if (plan.planHash !== expectedHash || plan.approval.planHash !== plan.planHash) deny("Approval is not bound to the immutable effect plan hash.");
    validateApproval(plan, registered, options.policy ?? {}, now());
    const execution: FrappeEffectExecutionContext = {
      missionId: input.mission.missionId,
      rootRunId: input.mission.rootRunId,
      nodeId: input.node.id,
      actor: input.mission.identity.userId.toLowerCase(),
    };

    const liveBeforePlan = await options.transport.resolveAuthority({ execution, authority: plan.authority, operation: plan.operation, signal: input.signal });
    assertAuthority(plan.authority, liveBeforePlan, input, "planning");
    const proposal = await options.transport.plan({ execution, plan, signal: input.signal });
    if (proposal.planHash !== plan.planHash || proposal.approvalBindingHash !== hash(plan.approval) || !sameAuthority(proposal.authority, plan.authority)) {
      deny("Frappe dry-run proposal is not bound to the approved plan and live authority.");
    }

    // TOCTOU boundary: identity, permissions, schema, and data revision are
    // resolved again immediately before the one fixed effect call.
    const liveBeforeEffect = await options.transport.resolveAuthority({ execution, authority: plan.authority, operation: plan.operation, signal: input.signal });
    assertAuthority(plan.authority, liveBeforeEffect, input, "execution");
    const claimInput: ClaimInput = {
      scopeKey: `${plan.authority.tenantId}\0${plan.authority.siteId}\0${plan.authority.userId}`,
      idempotencyKey: plan.idempotencyKey,
      planHash: plan.planHash,
      approvalReceiptId: plan.approval.receiptId,
      approvalHash: hash(plan.approval),
      fencingToken: input.fencingToken,
    };
    const claim = options.store.claim(claimInput);
    if (claim.status === "replayed") return { ...claim.result, payload: { ...(claim.result.payload ?? {}), replayed: true } };
    if (claim.status === "conflict") throw new GovernedFrappeEffectError(claim.reason, "needs_intervention");

    try {
      await input.recordEffectStarted?.(plan.idempotencyKey);
      const application = await options.transport.apply({ execution, plan, proposal, fencingToken: input.fencingToken, signal: input.signal });
      const observed = await options.transport.observe({ execution, plan, application, signal: input.signal });
      if (!verifyPostconditions(plan.postconditions, observed)) {
        const compensation = options.transport.compensate
          ? await options.transport.compensate({ execution, plan, application, fencingToken: input.fencingToken, signal: input.signal })
          : { repaired: false, evidenceIds: [] };
        options.store.fail(claimInput, compensation.repaired ? "Independent verification failed; effect compensated." : "Independent verification failed; compensation unavailable or failed.");
        throw new GovernedFrappeEffectError(
          compensation.repaired ? "Frappe postcondition failed and the effect was compensated." : "Frappe postcondition failed; manual intervention is required.",
          compensation.repaired ? "compensated" : "needs_intervention",
        );
      }
      const evidenceIds = Object.freeze([...new Set(application.evidenceIds)]);
      const receiptHash = hash({ application, observed, planHash: plan.planHash, fencingToken: input.fencingToken });
      const result: FrappeMissionNodeExecutionResult = {
        summary: `Verified governed Frappe ${plan.capability} effect.`,
        payload: {
          capability: plan.capability,
          planHash: plan.planHash,
          receiptId: application.receiptId,
          receiptHash,
          idempotencyKey: plan.idempotencyKey,
          fencingToken: input.fencingToken,
          executionSurface: application.executionSurface ?? "server_side",
          verified: true,
        },
        evidenceIds,
      };
      options.store.commit(claimInput, result, receiptHash);
      await input.recordEffectCommitted?.(plan.idempotencyKey, receiptHash, evidenceIds);
      return result;
    } catch (error) {
      if (!(error instanceof GovernedFrappeEffectError)) options.store.fail(claimInput, error instanceof Error ? error.message : "Unknown effect failure");
      throw error;
    }
  };
}

function effectForNode(input: FrappeMissionNodeExecutionInput): unknown {
  const manifest = input.mission.executionManifest;
  if (manifest === undefined) return undefined;
  const entry = manifest.nodePlans[input.node.id];
  if (entry === undefined || entry.surface !== "server_effect") return undefined;
  validateEffectResourceScope(entry.plan, entry.resourceScope);
  return entry.plan;
}

/**
 * The host publishes this projection next to the immutable per-mission plan.
 * Recomputing it here prevents a signed manifest from hiding scope expansion in
 * an opaque plan. Mission context/model output is deliberately never consulted.
 */
function validateEffectResourceScope(
  rawPlan: unknown,
  rawScope: TrustedFrappeResourceScope,
): void {
  const row = record(rawPlan);
  const operation = record(row?.operation);
  if (!row || !operation) deny("The trusted server-effect node manifest is invalid.");
  let expected: TrustedFrappeResourceScope;
  if (operation.kind === "record") {
    const values = record(operation.values);
    expected = {
      routes: [],
      doctypes: typeof operation.doctype === "string" ? [operation.doctype] : [],
      recordNames: typeof operation.docname === "string" ? [operation.docname] : [],
      fields: values ? Object.keys(values).sort() : [],
    };
  } else if (operation.kind === "native_artifact") {
    const intent = record(operation.intent);
    expected = {
      routes: [],
      doctypes: projectNativeDoctypes(intent),
      recordNames: projectNativeRecordNames(intent),
      fields: projectNativeFields(intent),
    };
  } else {
    deny("The trusted server-effect operation kind is not registered.");
  }
  for (const key of ["routes", "doctypes", "recordNames", "fields"] as const) {
    const actual = uniqueSorted(rawScope[key]);
    if (JSON.stringify(actual) !== JSON.stringify(expected![key])) {
      deny("The server-effect plan exceeds its immutable resource scope.");
    }
  }
}

type TrustedFrappeResourceScope = {
  readonly routes: readonly string[];
  readonly doctypes: readonly string[];
  readonly recordNames: readonly string[];
  readonly fields: readonly string[];
};

function projectNativeDoctypes(intent: Record<string, unknown> | undefined): string[] {
  const artifacts = Array.isArray(intent?.artifacts) ? intent.artifacts : [];
  return uniqueSorted(artifacts.flatMap((item) => {
    const row = record(item);
    return typeof row?.target_doctype === "string" ? [row.target_doctype] : [];
  }));
}

function projectNativeRecordNames(intent: Record<string, unknown> | undefined): string[] {
  const artifacts = Array.isArray(intent?.artifacts) ? intent.artifacts : [];
  return uniqueSorted(artifacts.flatMap((item) => {
    const row = record(item);
    const value = row?.target_name;
    return typeof value === "string" ? [value] : [];
  }));
}

function projectNativeFields(intent: Record<string, unknown> | undefined): string[] {
  const artifacts = Array.isArray(intent?.artifacts) ? intent.artifacts : [];
  return uniqueSorted(artifacts.flatMap((item) => {
    const row = record(item);
    const values = record(row?.values);
    return values ? Object.keys(values) : [];
  }));
}

function uniqueSorted(values: readonly unknown[]): string[] {
  if (values.some((value) => typeof value !== "string")) deny("The server-effect resource scope is invalid.");
  return [...new Set(values as readonly string[])].sort();
}

function parsePlan(value: unknown): GovernedFrappeEffectPlan {
  const plan = exactRecord(value, ["schemaVersion", "capability", "authority", "operation", "idempotencyKey", "postconditions", "approval", "planHash"], "effect plan");
  if (plan.schemaVersion !== 1 || typeof plan.capability !== "string" || !(plan.capability in CAPABILITY_REGISTRY)) deny("Effect plan capability is not registered.");
  if (!safeId(plan.idempotencyKey) || !safeHash(plan.planHash)) deny("Effect plan idempotency key or hash is invalid.");
  const authority = parseAuthority(plan.authority);
  const operation = parseOperation(plan.operation);
  const approval = parseApproval(plan.approval);
  if (!Array.isArray(plan.postconditions) || plan.postconditions.length === 0 || plan.postconditions.length > 32) deny("Every effect requires bounded postconditions.");
  const postconditions = plan.postconditions.map((item) => {
    const row = exactRecord(item, ["path", "operator", "expected"], "postcondition", ["expected"]);
    if (typeof row.path !== "string" || !/^\$?(?:\.[A-Za-z0-9_-]+)+$/.test(row.path) || !["equals", "exists", "absent"].includes(String(row.operator))) deny("Postcondition is invalid.");
    assertJson(row.expected, "postcondition.expected", true);
    return { path: row.path, operator: row.operator as "equals" | "exists" | "absent", ...(row.expected !== undefined ? { expected: row.expected as Json } : {}) };
  });
  return Object.freeze({ schemaVersion: 1, capability: plan.capability as GovernedFrappeCapability, authority, operation, idempotencyKey: plan.idempotencyKey as string, postconditions, approval, planHash: plan.planHash as string });
}

function parseAuthority(value: unknown): FrappeEffectAuthoritySnapshot {
  const row = exactRecord(value, ["tenantId", "siteId", "siteOrigin", "userId", "permissionEpoch", "rolesHash", "schemaRevision", "dataRevision"], "authority", ["rolesHash"]);
  for (const key of ["tenantId", "siteId", "userId", "permissionEpoch", "schemaRevision", "dataRevision"] as const) if (!safeId(row[key])) deny(`Authority ${key} is invalid.`);
  let siteOrigin: string;
  try { const url = new URL(String(row.siteOrigin)); if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) throw new Error(); siteOrigin = url.origin; }
  catch { deny("Authority siteOrigin must be an exact HTTPS origin."); }
  if (row.rolesHash !== undefined && !safeHash(row.rolesHash)) deny("Authority rolesHash is invalid.");
  return { tenantId: row.tenantId as string, siteId: row.siteId as string, siteOrigin: siteOrigin!, userId: (row.userId as string).toLowerCase(), permissionEpoch: row.permissionEpoch as string, ...(row.rolesHash ? { rolesHash: row.rolesHash as string } : {}), schemaRevision: row.schemaRevision as string, dataRevision: row.dataRevision as string };
}

function parseOperation(value: unknown): GovernedFrappeOperation {
  const base = record(value); if (!base || typeof base.kind !== "string") deny("Effect operation is invalid.");
  if (base.kind === "record") {
    const row = exactRecord(value, ["kind", "action", "doctype", "docname", "values", "expectedModified", "workflowAction"], "record operation", ["docname", "expectedModified", "workflowAction"]);
    if (!["create", "update", "submit", "apply_workflow", "delete"].includes(String(row.action)) || !safeLabel(row.doctype)) deny("Record operation action or DocType is invalid.");
    if (row.action !== "create" && !safeLabel(row.docname)) deny("Existing-record operations require a safe document name.");
    if (row.action !== "create" && typeof row.expectedModified !== "string") deny("Existing-record operations require expectedModified from a live read.");
    if (row.action === "apply_workflow" && !safeLabel(row.workflowAction)) deny("Workflow operation requires a fixed workflowAction.");
    const values = record(row.values); if (!values) deny("Record values must be an object."); assertJson(values, "record.values");
    return { kind: "record", action: row.action as GovernedFrappeRecordOperation["action"], doctype: row.doctype as string, ...(row.docname ? { docname: row.docname as string } : {}), values: values as Record<string, Json>, ...(row.expectedModified ? { expectedModified: row.expectedModified as string } : {}), ...(row.workflowAction ? { workflowAction: row.workflowAction as string } : {}) };
  }
  if (base.kind === "native_artifact") {
    const row = exactRecord(value, ["kind", "artifactType", "intent"], "native artifact operation");
    const supported = ["custom_field", "property_setter", "doctype", "page", "report", "print_format", "web_page"];
    if (!supported.includes(String(row.artifactType))) deny("Native artifact type is not registered.");
    const intent = record(row.intent); if (!intent) deny("Native artifact intent must be an object."); assertJson(intent, "native.intent");
    return { kind: "native_artifact", artifactType: row.artifactType as GovernedFrappeNativeOperation["artifactType"], intent: intent as Record<string, Json> };
  }
  deny("Effect operation kind is not registered.");
}

function parseApproval(value: unknown): FrappeBoundApprovalReceipt {
  const row = exactRecord(value, ["receiptId", "planHash", "actor", "approvers", "approvedAt", "expiresAt", "scope", "approvalClass", "proof"], "approval");
  if (!safeId(row.receiptId) || !safeHash(row.planHash) || !safeId(row.actor)) deny("Approval identity or binding is invalid.");
  const approvers = stringArray(row.approvers, "approval approvers");
  const scope = stringArray(row.scope, "approval scope");
  const proof = record(row.proof); if (!proof) deny("Approval proof is invalid."); assertJson(proof, "approval.proof");
  if (row.approvalClass !== "single" && row.approvalClass !== "dual_control") deny("Approval class is invalid.");
  return { receiptId: row.receiptId as string, planHash: row.planHash as string, actor: (row.actor as string).toLowerCase(), approvers: approvers.map((item) => item.toLowerCase()), approvedAt: String(row.approvedAt), expiresAt: String(row.expiresAt), scope, approvalClass: row.approvalClass, proof: proof as Record<string, Json> };
}

function enforceCapabilityAndOperation(input: FrappeMissionNodeExecutionInput, plan: GovernedFrappeEffectPlan, registered: RegisteredCapability, policy: FrappeEffectPolicy): void {
  if (!input.effectiveCapabilities.includes(plan.capability) || !input.node.requestedCapabilities?.includes(plan.capability)) deny("Effect capability is absent from the trusted authority intersection.");
  if (registered.family === "record" && (plan.operation.kind !== "record" || plan.operation.action !== registered.action)) deny("Capability does not match the typed record operation.");
  if (registered.family === "native" && (plan.operation.kind !== "native_artifact" || plan.operation.artifactType !== registered.artifact)) deny("Capability does not match the typed native artifact operation.");
  if (registered.risk === "destructive" && !policy.allowDestructive) deny("Destructive Frappe effects are disabled by policy.");
  if (registered.risk === "executable" && !policy.allowExecutableMetadata) deny("Executable Frappe metadata is disabled by policy.");
}

function validateApproval(plan: GovernedFrappeEffectPlan, registered: RegisteredCapability, policy: FrappeEffectPolicy, current: Date): void {
  const approval = plan.approval;
  if (approval.actor !== plan.authority.userId.toLowerCase()) deny("Approval actor does not match the execution principal.");
  const approvedAt = Date.parse(approval.approvedAt), expiresAt = Date.parse(approval.expiresAt), now = current.getTime();
  if (![approvedAt, expiresAt, now].every(Number.isFinite) || approvedAt > now + 30_000 || expiresAt <= now || expiresAt <= approvedAt) deny("Approval is stale or has an invalid time window.");
  if (!approval.scope.includes(plan.capability) || approval.scope.some((scope) => !(scope in CAPABILITY_REGISTRY))) deny("Approval scope is not an exact registered capability set.");
  const uniqueApprovers = new Set(approval.approvers.filter((item) => item !== approval.actor));
  const dual = registered.risk === "destructive" || registered.risk === "executable" || (registered.risk === "business_state" && policy.requireDualControlForBusinessState);
  if (uniqueApprovers.size < 1) deny("Every write requires an independent approver.");
  if (dual && approval.approvalClass !== "dual_control") deny("This effect requires maker-checker dual control.");
}

function assertAuthority(expected: FrappeEffectAuthoritySnapshot, actual: FrappeEffectAuthoritySnapshot, input: FrappeMissionNodeExecutionInput, stage: string): void {
  if (!sameAuthority(expected, actual)) deny(`Frappe authority or revision drifted before ${stage}.`);
  if (actual.tenantId !== input.mission.identity.tenantId || actual.siteId !== input.mission.identity.siteId || actual.userId.toLowerCase() !== input.mission.identity.userId.toLowerCase() || actual.permissionEpoch !== input.mission.identity.permissionEpoch || (input.mission.identity.rolesHash && actual.rolesHash !== input.mission.identity.rolesHash)) deny(`Live Frappe authority does not match the admitted mission before ${stage}.`);
}

function sameAuthority(left: FrappeEffectAuthoritySnapshot, right: FrappeEffectAuthoritySnapshot): boolean { return hash(left) === hash(right); }
function planIntent(plan: GovernedFrappeEffectPlan): unknown { return { schemaVersion: plan.schemaVersion, capability: plan.capability, authority: plan.authority, operation: plan.operation, idempotencyKey: plan.idempotencyKey, postconditions: plan.postconditions }; }
function verifyPostconditions(rules: GovernedFrappeEffectPlan["postconditions"], observed: Readonly<Record<string, Json>>): boolean {
  return rules.every((rule) => { const value = resolvePath(observed, rule.path); return rule.operator === "exists" ? value !== undefined && value !== null : rule.operator === "absent" ? value === undefined || value === null : value !== undefined && hash(value) === hash(rule.expected); });
}
function resolvePath(value: unknown, path: string): unknown {
  let cursor = value;
  for (const key of path.replace(/^\$?\./, "").split(".")) {
    const row = record(cursor);
    if (!row || !(key in row)) return undefined;
    cursor = row[key];
  }
  return cursor;
}
function hash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const row = record(value);
  if (row) return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`;
  throw new TypeError("Value is not canonical JSON.");
}
function record(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function exactRecord(value: unknown, allowed: readonly string[], label: string, optional: readonly string[] = []): Record<string, unknown> { const row = record(value); if (!row) deny(`${label} must be an object.`); const extras = Object.keys(row!).filter((key) => !allowed.includes(key)); const missing = allowed.filter((key) => !optional.includes(key) && !(key in row!)); if (extras.length || missing.length) deny(`${label} has unknown or missing fields.`); return row!; }
function safeId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:@\/-]{0,255}$/.test(value); }
function safeHash(value: unknown): value is string { return typeof value === "string" && /^(?:sha256:)?[a-f0-9]{64}$/i.test(value); }
function safeLabel(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= 140 && !/[\u0000-\u001f]/.test(value); }
function stringArray(value: unknown, label: string): string[] { if (!Array.isArray(value) || value.length === 0 || value.length > 32 || value.some((item) => !safeId(item))) deny(`${label} are invalid.`); return [...new Set(value as string[])]; }
function assertJson(value: unknown, path: string, allowUndefined = false, depth = 0): void { if (allowUndefined && value === undefined) return; if (depth > 12) deny(`${path} exceeds JSON depth.`); if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return; if (Array.isArray(value)) { if (value.length > 1_000) deny(`${path} is too large.`); value.forEach((entry, index) => assertJson(entry, `${path}[${index}]`, false, depth + 1)); return; } const row = record(value); if (!row || Object.keys(row).length > 1_000) deny(`${path} is not bounded JSON.`); for (const [key, entry] of Object.entries(row!)) { if (!key || key.length > 140 || /[\u0000-\u001f]/.test(key) || ["__proto__", "prototype", "constructor"].includes(key)) deny(`${path} contains an invalid key.`); assertJson(entry, `${path}.${key}`, false, depth + 1); } }
function deny(message: string): never { throw new GovernedFrappeEffectError(message); }
