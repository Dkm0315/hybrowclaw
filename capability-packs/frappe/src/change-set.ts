import { createHash } from "node:crypto";

export type FrappeJsonPrimitive = string | number | boolean | null;
export type FrappeJsonValue = FrappeJsonPrimitive | readonly FrappeJsonValue[] | { readonly [key: string]: FrappeJsonValue };

export type FrappeRiskClass =
  | "read_only"
  | "record_mutation"
  | "workflow_business_state"
  | "metadata_ui"
  | "executable_integration"
  | "security_permission"
  | "destructive";

export type FrappeApprovalClass = "none" | "policy" | "explicit_scoped" | "dual_control";

export type FrappeChangeSurface =
  | "record"
  | "doctype"
  | "custom_field"
  | "property_setter"
  | "frappe_workflow"
  | "workspace"
  | "workspace_sidebar"
  | "page"
  | "web_page"
  | "web_form"
  | "dashboard"
  | "dashboard_chart"
  | "number_card"
  | "report"
  | "print_format"
  | "client_script"
  | "server_script"
  | "notification"
  | "assignment_rule"
  | "webhook"
  | "email_template"
  | "letter_head"
  | "role"
  | "permission";

export type FrappeChangeAction =
  | "read"
  | "create"
  | "update"
  | "delete"
  | "submit"
  | "cancel"
  | "apply_workflow"
  | "enable"
  | "disable"
  | "install"
  | "uninstall";

export type FrappePermission =
  | "read"
  | "write"
  | "create"
  | "delete"
  | "submit"
  | "cancel"
  | "amend"
  | "select"
  | "report"
  | "export"
  | "import"
  | "print"
  | "email"
  | "share";

export interface FrappeChangeTarget {
  readonly doctype: string;
  readonly name?: string;
  readonly field?: string;
  readonly route?: string;
}

export interface FrappeSemanticDiffEntry {
  readonly path: string;
  readonly before: FrappeJsonValue;
  readonly after: FrappeJsonValue;
  readonly summary?: string;
}

export type FrappeAssertionOperator = "equals" | "not_equals" | "exists" | "absent" | "contains";

export interface FrappePostcondition {
  readonly id: string;
  readonly description: string;
  readonly path: string;
  readonly operator: FrappeAssertionOperator;
  readonly expected?: FrappeJsonValue;
}

export interface FrappeRepairOperation {
  readonly id: string;
  readonly surface: FrappeChangeSurface;
  readonly action: FrappeChangeAction;
  readonly target: FrappeChangeTarget;
  readonly value: FrappeJsonValue;
  readonly requiredPermissions: readonly FrappePermission[];
  readonly requiredCapabilities: readonly string[];
  readonly idempotencyKey: string;
  readonly postconditions: readonly FrappePostcondition[];
}

export type FrappeRepairPlan =
  | { readonly strategy: "inverse"; readonly reason: string; readonly operations: readonly FrappeRepairOperation[] }
  | { readonly strategy: "forward_repair"; readonly reason: string; readonly operations: readonly FrappeRepairOperation[] }
  | { readonly strategy: "manual"; readonly reason: string; readonly operations?: undefined };

export interface FrappeEffectReceipt {
  readonly receiptId: string;
  readonly changeSetId: string;
  readonly operationId: string;
  readonly planHash: string;
  readonly site: string;
  readonly actor: string;
  readonly permissionEpoch: string;
  readonly schemaRevision: string;
  readonly dataRevision: string;
  readonly idempotencyKey: string;
  readonly beforeHash: string;
  readonly afterHash: string;
  readonly status: "applied" | "no_effect";
  readonly executor: string;
  readonly appliedAt: string;
  readonly evidenceIds: readonly string[];
}

export interface FrappeChangeOperation {
  readonly id: string;
  readonly surface: FrappeChangeSurface;
  readonly action: FrappeChangeAction;
  readonly target: FrappeChangeTarget;
  readonly dependsOn: readonly string[];
  readonly idempotencyKey: string;
  readonly before: FrappeJsonValue;
  readonly after: FrappeJsonValue;
  readonly concurrencyToken?: string;
  readonly requiredPermissions: readonly FrappePermission[];
  readonly requiredCapabilities: readonly string[];
  readonly riskClass: FrappeRiskClass;
  readonly dryRun: {
    readonly summary: string;
    readonly diff: readonly FrappeSemanticDiffEntry[];
  };
  readonly postconditions: readonly FrappePostcondition[];
  readonly repair: FrappeRepairPlan;
  readonly effectReceipt?: FrappeEffectReceipt;
}

export interface FrappeChangePrerequisite {
  readonly id: string;
  readonly description: string;
  readonly kind: "app" | "version" | "record" | "permission" | "policy" | "schema" | "custom";
  readonly expected: FrappeJsonValue;
}

export interface FrappeVerificationRule {
  readonly id: string;
  readonly description: string;
  readonly operationId?: string;
  readonly assertion: FrappePostcondition;
}

export interface FrappeApprovalBinding {
  readonly planHash: string;
  readonly actor: string;
  readonly approver: string;
  readonly site: string;
  readonly permissionEpoch: string;
  readonly scope: readonly string[];
  readonly approvedAt: string;
  readonly expiresAt: string;
}

export interface FrappeChangeSet {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly target: { readonly site: string; readonly app: string };
  readonly actor: string;
  readonly permissionEpoch: string;
  readonly schemaRevision: string;
  readonly dataRevision: string;
  readonly createdAt: string;
  readonly riskClass: FrappeRiskClass;
  readonly approvalClass: FrappeApprovalClass;
  readonly prerequisites: readonly FrappeChangePrerequisite[];
  readonly operations: readonly FrappeChangeOperation[];
  readonly verification: readonly FrappeVerificationRule[];
  readonly approval?: FrappeApprovalBinding;
  readonly evidenceIds: readonly string[];
  readonly planHash: string;
}

export type FrappeChangeOperationInput = Omit<FrappeChangeOperation, "riskClass" | "effectReceipt"> & {
  readonly riskClass?: FrappeRiskClass;
};

export type FrappeChangeSetInput = Omit<
  FrappeChangeSet,
  "schemaVersion" | "riskClass" | "approvalClass" | "operations" | "planHash" | "approval" | "evidenceIds"
> & {
  readonly riskClass?: FrappeRiskClass;
  readonly approvalClass?: FrappeApprovalClass;
  readonly operations: readonly FrappeChangeOperationInput[];
  readonly approval?: FrappeApprovalBinding;
  readonly evidenceIds?: readonly string[];
};

export interface FrappeChangeSetValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export class FrappeChangeSetValidationError extends Error {
  readonly issues: readonly FrappeChangeSetValidationIssue[];

  constructor(message: string, issues: readonly FrappeChangeSetValidationIssue[]) {
    super(message);
    this.name = "FrappeChangeSetValidationError";
    this.issues = issues;
  }
}

export class FrappeChangeSetDriftError extends Error {
  readonly dimension: "site" | "actor" | "permission_epoch" | "schema_revision" | "data_revision" | "concurrency_token";

  constructor(dimension: FrappeChangeSetDriftError["dimension"], message: string) {
    super(message);
    this.name = "FrappeChangeSetDriftError";
    this.dimension = dimension;
  }
}

const RISK_RANK: Readonly<Record<FrappeRiskClass, number>> = {
  read_only: 0,
  record_mutation: 1,
  workflow_business_state: 2,
  metadata_ui: 3,
  executable_integration: 4,
  security_permission: 5,
  destructive: 6,
};

const APPROVAL_RANK: Readonly<Record<FrappeApprovalClass, number>> = {
  none: 0,
  policy: 1,
  explicit_scoped: 2,
  dual_control: 3,
};

const EXECUTABLE_SURFACES = new Set<FrappeChangeSurface>([
  "client_script", "server_script", "webhook", "web_page", "web_form", "report", "print_format",
]);
const SECURITY_SURFACES = new Set<FrappeChangeSurface>(["role", "permission"]);
const METADATA_SURFACES = new Set<FrappeChangeSurface>([
  "doctype", "custom_field", "property_setter", "frappe_workflow", "workspace", "workspace_sidebar", "page",
  "dashboard", "dashboard_chart", "number_card", "notification", "assignment_rule", "email_template", "letter_head",
]);

function canonicalJson(value: unknown, path = "$"): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Non-finite number at ${path} cannot be canonicalized.`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry, index) => canonicalJson(entry, `${path}[${index}]`)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => {
      const entry = record[key];
      if (entry === undefined) throw new TypeError(`Undefined value at ${path}.${key} cannot be canonicalized.`);
      return `${JSON.stringify(key)}:${canonicalJson(entry, `${path}.${key}`)}`;
    }).join(",")}}`;
  }
  throw new TypeError(`Unsupported ${typeof value} value at ${path}.`);
}

export function hashFrappeCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new TypeError(`${label} must be non-empty.`);
}

function assertIsoTimestamp(value: string, label: string): void {
  if (!value || Number.isNaN(Date.parse(value))) throw new TypeError(`${label} must be an ISO timestamp.`);
}

function maxRisk(left: FrappeRiskClass, right: FrappeRiskClass): FrappeRiskClass {
  return RISK_RANK[left] >= RISK_RANK[right] ? left : right;
}

export function inferFrappeOperationRisk(operation: Pick<FrappeChangeOperationInput, "surface" | "action">): FrappeRiskClass {
  if (operation.action === "read") return "read_only";
  if (operation.action === "delete" || operation.action === "uninstall") return "destructive";
  if (SECURITY_SURFACES.has(operation.surface)) return "security_permission";
  if (EXECUTABLE_SURFACES.has(operation.surface)) return "executable_integration";
  if (operation.surface === "frappe_workflow" || operation.action === "submit" || operation.action === "cancel" || operation.action === "apply_workflow") {
    return "workflow_business_state";
  }
  if (METADATA_SURFACES.has(operation.surface)) return "metadata_ui";
  return "record_mutation";
}

export function requiredFrappeApproval(risk: FrappeRiskClass): FrappeApprovalClass {
  if (RISK_RANK[risk] >= RISK_RANK.metadata_ui) return "explicit_scoped";
  if (risk === "workflow_business_state" || risk === "record_mutation") return "policy";
  return "none";
}

function normalizeOperation(input: FrappeChangeOperationInput): FrappeChangeOperation {
  const inferred = inferFrappeOperationRisk(input);
  const riskClass = input.riskClass ? maxRisk(input.riskClass, inferred) : inferred;
  const { concurrencyToken, riskClass: _declaredRisk, ...operation } = input;
  const { name, field, route, ...target } = operation.target;
  return {
    ...operation,
    target: {
      ...target,
      ...(name !== undefined ? { name } : {}),
      ...(field !== undefined ? { field } : {}),
      ...(route !== undefined ? { route } : {}),
    },
    ...(concurrencyToken !== undefined ? { concurrencyToken } : {}),
    riskClass,
  };
}

export function orderFrappeChangeOperations<T extends { readonly id: string; readonly dependsOn: readonly string[] }>(operations: readonly T[]): readonly T[] {
  const byId = new Map<string, T>();
  const issues: FrappeChangeSetValidationIssue[] = [];
  for (const operation of operations) {
    if (byId.has(operation.id)) issues.push({ code: "duplicate_operation", path: `operations.${operation.id}`, message: `Duplicate operation id ${operation.id}.` });
    byId.set(operation.id, operation);
  }
  for (const operation of operations) {
    for (const dependency of operation.dependsOn) {
      if (!byId.has(dependency)) issues.push({ code: "missing_dependency", path: `operations.${operation.id}.dependsOn`, message: `Operation ${operation.id} depends on missing operation ${dependency}.` });
      if (dependency === operation.id) issues.push({ code: "self_dependency", path: `operations.${operation.id}.dependsOn`, message: `Operation ${operation.id} cannot depend on itself.` });
    }
  }
  if (issues.length) throw new FrappeChangeSetValidationError("Frappe change operation dependencies are invalid.", issues);

  const remaining = new Map([...byId.entries()].map(([id, operation]) => [id, new Set(operation.dependsOn)]));
  const ordered: T[] = [];
  while (remaining.size) {
    const ready = [...remaining.entries()].filter(([, dependencies]) => dependencies.size === 0).map(([id]) => id).sort();
    if (!ready.length) {
      const cycle = [...remaining.keys()].sort();
      throw new FrappeChangeSetValidationError("Frappe change operation graph contains a cycle.", [
        { code: "dependency_cycle", path: "operations", message: `Dependency cycle involves: ${cycle.join(", ")}.` },
      ]);
    }
    for (const id of ready) {
      ordered.push(byId.get(id)!);
      remaining.delete(id);
      for (const dependencies of remaining.values()) dependencies.delete(id);
    }
  }
  return ordered;
}

function planIntent(changeSet: Omit<FrappeChangeSet, "planHash">): unknown {
  return {
    schemaVersion: changeSet.schemaVersion,
    id: changeSet.id,
    target: changeSet.target,
    actor: changeSet.actor,
    permissionEpoch: changeSet.permissionEpoch,
    schemaRevision: changeSet.schemaRevision,
    dataRevision: changeSet.dataRevision,
    createdAt: changeSet.createdAt,
    riskClass: changeSet.riskClass,
    approvalClass: changeSet.approvalClass,
    prerequisites: changeSet.prerequisites,
    operations: changeSet.operations.map(({ effectReceipt: _receipt, ...operation }) => operation),
    verification: changeSet.verification,
  };
}

export function computeFrappeChangeSetPlanHash(changeSet: Omit<FrappeChangeSet, "planHash"> | FrappeChangeSet): string {
  return hashFrappeCanonical(planIntent(changeSet));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function createFrappeChangeSet(input: FrappeChangeSetInput): FrappeChangeSet {
  assertNonEmpty(input.id, "Change-set id");
  assertNonEmpty(input.target.site, "Target site");
  assertNonEmpty(input.target.app, "Target app");
  assertNonEmpty(input.actor, "Actor");
  assertNonEmpty(input.permissionEpoch, "Permission epoch");
  assertNonEmpty(input.schemaRevision, "Schema revision");
  assertNonEmpty(input.dataRevision, "Data revision");
  assertIsoTimestamp(input.createdAt, "Created at");
  if (!input.operations.length) throw new FrappeChangeSetValidationError("A Frappe change set must contain at least one operation.", [
    { code: "empty_operations", path: "operations", message: "At least one operation is required." },
  ]);

  const operations = orderFrappeChangeOperations(input.operations.map(normalizeOperation));
  const inferredRisk = operations.reduce<FrappeRiskClass>((risk, operation) => maxRisk(risk, operation.riskClass), "read_only");
  if (input.riskClass && RISK_RANK[input.riskClass] < RISK_RANK[inferredRisk]) {
    throw new FrappeChangeSetValidationError("Declared change-set risk understates an operation.", [
      { code: "understated_risk", path: "riskClass", message: `Risk ${input.riskClass} is lower than required ${inferredRisk}.` },
    ]);
  }
  const riskClass = input.riskClass ?? inferredRisk;
  const requiredApproval = requiredFrappeApproval(riskClass);
  const approvalClass = input.approvalClass ?? requiredApproval;
  if (APPROVAL_RANK[approvalClass] < APPROVAL_RANK[requiredApproval]) {
    throw new FrappeChangeSetValidationError("Declared approval class is weaker than required.", [
      { code: "weak_approval", path: "approvalClass", message: `${riskClass} requires at least ${requiredApproval}.` },
    ]);
  }

  const unhashed: Omit<FrappeChangeSet, "planHash"> = {
    schemaVersion: 1,
    id: input.id,
    target: input.target,
    actor: input.actor,
    permissionEpoch: input.permissionEpoch,
    schemaRevision: input.schemaRevision,
    dataRevision: input.dataRevision,
    createdAt: input.createdAt,
    riskClass,
    approvalClass,
    prerequisites: input.prerequisites,
    operations,
    verification: input.verification,
    ...(input.approval ? { approval: input.approval } : {}),
    evidenceIds: input.evidenceIds ?? [],
  };
  const changeSet: FrappeChangeSet = { ...unhashed, planHash: computeFrappeChangeSetPlanHash(unhashed) };
  const issues = validateFrappeChangeSet(changeSet);
  if (issues.length) throw new FrappeChangeSetValidationError("Frappe change set is invalid.", issues);
  return deepFreeze(changeSet);
}

export function validateFrappeApprovalBinding(changeSet: FrappeChangeSet, now = new Date().toISOString()): readonly FrappeChangeSetValidationIssue[] {
  if (changeSet.approvalClass === "none") return [];
  if (!changeSet.approval) return [{ code: "approval_missing", path: "approval", message: `${changeSet.approvalClass} approval is required before execution.` }];
  const approval = changeSet.approval;
  const issues: FrappeChangeSetValidationIssue[] = [];
  const approvedAt = Date.parse(approval.approvedAt);
  const expiresAt = Date.parse(approval.expiresAt);
  const currentTime = Date.parse(now);
  const checks: ReadonlyArray<[boolean, string, string]> = [
    [approval.planHash === changeSet.planHash, "approval.planHash", "Approval is bound to another plan hash."],
    [approval.actor === changeSet.actor, "approval.actor", "Approval is bound to another actor."],
    [approval.site === changeSet.target.site, "approval.site", "Approval is bound to another site."],
    [approval.permissionEpoch === changeSet.permissionEpoch, "approval.permissionEpoch", "Approval permission epoch is stale."],
    [approval.scope.length > 0, "approval.scope", "Approval scope must be non-empty."],
    [Number.isFinite(approvedAt), "approval.approvedAt", "Approval time is invalid."],
    [Number.isFinite(expiresAt), "approval.expiresAt", "Approval expiry is invalid."],
    [Number.isFinite(currentTime), "now", "Approval validation time is invalid."],
    [approvedAt >= Date.parse(changeSet.createdAt), "approval.approvedAt", "Approval predates the plan."],
    [approvedAt <= currentTime, "approval.approvedAt", "Approval is dated in the future."],
    [expiresAt > approvedAt, "approval.expiresAt", "Approval must expire after it is granted."],
    [expiresAt > currentTime, "approval.expiresAt", "Approval has expired."],
  ];
  for (const [valid, path, message] of checks) if (!valid) issues.push({ code: "approval_binding_invalid", path, message });
  if (changeSet.approvalClass === "dual_control" && approval.approver === approval.actor) {
    issues.push({ code: "separation_of_duties", path: "approval.approver", message: "Dual-control approval must come from a different principal." });
  }
  return issues;
}

export function attachFrappeApproval(
  changeSet: FrappeChangeSet,
  approval: Omit<FrappeApprovalBinding, "planHash" | "actor" | "site" | "permissionEpoch">,
  now = approval.approvedAt,
): FrappeChangeSet {
  if (changeSet.approvalClass === "none") {
    throw new FrappeChangeSetValidationError("This plan does not permit an approval override.", [
      { code: "approval_unexpected", path: "approval", message: "Read-only/no-approval plans must execute without an approval receipt." },
    ]);
  }
  if (changeSet.approval) {
    throw new FrappeChangeSetValidationError("The plan already has an approval binding.", [
      { code: "approval_conflict", path: "approval", message: "Approval bindings are append-once." },
    ]);
  }
  const updated: FrappeChangeSet = {
    ...changeSet,
    approval: {
      ...approval,
      planHash: changeSet.planHash,
      actor: changeSet.actor,
      site: changeSet.target.site,
      permissionEpoch: changeSet.permissionEpoch,
    },
  };
  const issues = validateFrappeApprovalBinding(updated, now);
  if (issues.length) throw new FrappeChangeSetValidationError("Approval binding is invalid.", issues);
  if (computeFrappeChangeSetPlanHash(updated) !== changeSet.planHash) throw new Error("Attaching approval changed immutable plan intent.");
  return deepFreeze(updated);
}

export function validateFrappeChangeSet(changeSet: FrappeChangeSet): readonly FrappeChangeSetValidationIssue[] {
  const issues: FrappeChangeSetValidationIssue[] = [];
  if (changeSet.schemaVersion !== 1) issues.push({ code: "schema_version", path: "schemaVersion", message: "Only schema version 1 is supported." });
  if (computeFrappeChangeSetPlanHash(changeSet) !== changeSet.planHash) issues.push({ code: "plan_hash_mismatch", path: "planHash", message: "Plan content does not match its immutable hash." });
  try {
    const ordered = orderFrappeChangeOperations(changeSet.operations);
    if (ordered.some((operation, index) => operation.id !== changeSet.operations[index]?.id)) {
      issues.push({ code: "operations_not_ordered", path: "operations", message: "Operations are not stored in deterministic dependency order." });
    }
  } catch (error) {
    if (error instanceof FrappeChangeSetValidationError) issues.push(...error.issues);
    else throw error;
  }
  const idempotencyKeys = new Set<string>();
  for (const [index, operation] of changeSet.operations.entries()) {
    const path = `operations[${index}]`;
    if (!operation.id.trim()) issues.push({ code: "empty_id", path: `${path}.id`, message: "Operation id must be non-empty." });
    if (!operation.target.doctype.trim()) issues.push({ code: "empty_doctype", path: `${path}.target.doctype`, message: "Target DocType must be non-empty." });
    if (!operation.idempotencyKey.trim()) issues.push({ code: "empty_idempotency_key", path: `${path}.idempotencyKey`, message: "Idempotency key must be non-empty." });
    if (idempotencyKeys.has(operation.idempotencyKey)) issues.push({ code: "duplicate_idempotency_key", path: `${path}.idempotencyKey`, message: "Idempotency keys must be unique within a plan." });
    idempotencyKeys.add(operation.idempotencyKey);
    if (operation.action !== "create" && operation.action !== "read" && !operation.concurrencyToken) {
      issues.push({ code: "concurrency_token_missing", path: `${path}.concurrencyToken`, message: `${operation.action} requires an optimistic concurrency token.` });
    }
    const inferred = inferFrappeOperationRisk(operation);
    if (RISK_RANK[operation.riskClass] < RISK_RANK[inferred]) issues.push({ code: "operation_risk_understated", path: `${path}.riskClass`, message: `Operation requires at least ${inferred} risk.` });
    if (!operation.postconditions.length) issues.push({ code: "postconditions_missing", path: `${path}.postconditions`, message: "Every operation must declare a postcondition." });
    if (operation.repair.strategy !== "manual" && operation.repair.operations.length === 0) issues.push({ code: "repair_empty", path: `${path}.repair.operations`, message: "Automated repair requires at least one operation." });
    if (operation.repair.strategy === "inverse" && (operation.action === "delete" || operation.action === "uninstall")) {
      issues.push({ code: "unsafe_inverse", path: `${path}.repair`, message: "Destructive operations cannot claim safe inverse repair." });
    }
  }
  const inferredRisk = changeSet.operations.reduce<FrappeRiskClass>((risk, operation) => maxRisk(risk, operation.riskClass), "read_only");
  if (RISK_RANK[changeSet.riskClass] < RISK_RANK[inferredRisk]) issues.push({ code: "understated_risk", path: "riskClass", message: `Change-set risk is lower than ${inferredRisk}.` });
  const requiredApproval = requiredFrappeApproval(changeSet.riskClass);
  if (APPROVAL_RANK[changeSet.approvalClass] < APPROVAL_RANK[requiredApproval]) issues.push({ code: "weak_approval", path: "approvalClass", message: `${changeSet.riskClass} requires ${requiredApproval}.` });
  if (!changeSet.verification.length) issues.push({ code: "verification_missing", path: "verification", message: "Every change set must declare independent verification." });
  for (const verification of changeSet.verification) {
    if (verification.operationId && !changeSet.operations.some((operation) => operation.id === verification.operationId)) {
      issues.push({ code: "verification_operation_missing", path: `verification.${verification.id}.operationId`, message: `Unknown operation ${verification.operationId}.` });
    }
  }
  return issues;
}

export interface FrappeExecutionSnapshot {
  readonly site: string;
  readonly actor: string;
  readonly permissionEpoch: string;
  readonly schemaRevision: string;
  readonly dataRevision: string;
  readonly concurrencyTokens?: Readonly<Record<string, string | undefined>>;
}

export function assertFrappeChangeSetFresh(changeSet: FrappeChangeSet, snapshot: FrappeExecutionSnapshot, operationId?: string): void {
  const checks: ReadonlyArray<[boolean, FrappeChangeSetDriftError["dimension"], string]> = [
    [snapshot.site === changeSet.target.site, "site", "Target site changed after planning."],
    [snapshot.actor === changeSet.actor, "actor", "Execution actor changed after planning."],
    [snapshot.permissionEpoch === changeSet.permissionEpoch, "permission_epoch", "Frappe permission epoch changed after planning."],
    [snapshot.schemaRevision === changeSet.schemaRevision, "schema_revision", "Frappe schema revision changed after planning."],
    [snapshot.dataRevision === changeSet.dataRevision, "data_revision", "Frappe data revision changed after planning."],
  ];
  for (const [valid, dimension, message] of checks) if (!valid) throw new FrappeChangeSetDriftError(dimension, message);
  if (operationId) {
    const operation = changeSet.operations.find((candidate) => candidate.id === operationId);
    if (!operation) throw new FrappeChangeSetValidationError(`Unknown operation ${operationId}.`, [{ code: "operation_missing", path: "operationId", message: `Unknown operation ${operationId}.` }]);
    if (operation.concurrencyToken !== undefined && snapshot.concurrencyTokens?.[operationId] !== operation.concurrencyToken) {
      throw new FrappeChangeSetDriftError("concurrency_token", `Optimistic concurrency token changed for operation ${operationId}.`);
    }
  }
}

export function createFrappeEffectReceipt(input: {
  readonly changeSet: FrappeChangeSet;
  readonly operationId: string;
  readonly status: FrappeEffectReceipt["status"];
  readonly executor: string;
  readonly appliedAt: string;
  readonly evidenceIds?: readonly string[];
}): FrappeEffectReceipt {
  const operation = input.changeSet.operations.find((candidate) => candidate.id === input.operationId);
  if (!operation) throw new FrappeChangeSetValidationError(`Unknown operation ${input.operationId}.`, [{ code: "operation_missing", path: "operationId", message: `Unknown operation ${input.operationId}.` }]);
  assertNonEmpty(input.executor, "Receipt executor");
  assertIsoTimestamp(input.appliedAt, "Receipt appliedAt");
  const planIssues = validateFrappeChangeSet(input.changeSet);
  if (planIssues.length) throw new FrappeChangeSetValidationError("Cannot record an effect for an invalid plan.", planIssues);
  const approvalIssues = validateFrappeApprovalBinding(input.changeSet, input.appliedAt);
  if (approvalIssues.length) throw new FrappeChangeSetValidationError("Cannot record an effect without a live bound approval.", approvalIssues);
  const receiptBase = {
    changeSetId: input.changeSet.id,
    operationId: operation.id,
    planHash: input.changeSet.planHash,
    site: input.changeSet.target.site,
    actor: input.changeSet.actor,
    permissionEpoch: input.changeSet.permissionEpoch,
    schemaRevision: input.changeSet.schemaRevision,
    dataRevision: input.changeSet.dataRevision,
    idempotencyKey: operation.idempotencyKey,
    beforeHash: hashFrappeCanonical(operation.before),
    afterHash: hashFrappeCanonical(operation.after),
    status: input.status,
    executor: input.executor,
    appliedAt: input.appliedAt,
    evidenceIds: input.evidenceIds ?? [],
  };
  return deepFreeze({ receiptId: `frappe-effect:${hashFrappeCanonical(receiptBase)}`, ...receiptBase });
}

export function attachFrappeEffectReceipt(changeSet: FrappeChangeSet, receipt: FrappeEffectReceipt): FrappeChangeSet {
  const operation = changeSet.operations.find((candidate) => candidate.id === receipt.operationId);
  if (!operation) throw new FrappeChangeSetValidationError("Receipt references an unknown operation.", [{ code: "receipt_operation_missing", path: "receipt.operationId", message: receipt.operationId }]);
  const expected = createFrappeEffectReceipt({
    changeSet,
    operationId: receipt.operationId,
    status: receipt.status,
    executor: receipt.executor,
    appliedAt: receipt.appliedAt,
    evidenceIds: receipt.evidenceIds,
  });
  if (hashFrappeCanonical(receipt) !== hashFrappeCanonical(expected)) {
    throw new FrappeChangeSetValidationError("Effect receipt binding is invalid.", [{ code: "receipt_binding_invalid", path: "receipt", message: "Receipt does not match the approved plan and operation." }]);
  }
  if (operation.effectReceipt && operation.effectReceipt.receiptId !== receipt.receiptId) {
    throw new FrappeChangeSetValidationError("Operation already has another effect receipt.", [{ code: "receipt_conflict", path: `operations.${operation.id}.effectReceipt`, message: "Effect receipts are append-once." }]);
  }
  const updated = {
    ...changeSet,
    operations: changeSet.operations.map((candidate) => candidate.id === operation.id ? { ...candidate, effectReceipt: receipt } : candidate),
  };
  if (computeFrappeChangeSetPlanHash(updated) !== changeSet.planHash) throw new Error("Attaching execution evidence changed immutable plan intent.");
  return deepFreeze(updated);
}

function contains(actual: FrappeJsonValue, expected: FrappeJsonValue): boolean {
  if (typeof actual === "string" && typeof expected === "string") return actual.includes(expected);
  if (Array.isArray(actual)) return actual.some((entry) => hashFrappeCanonical(entry) === hashFrappeCanonical(expected));
  if (actual !== null && typeof actual === "object" && expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
    const actualRecord = actual as Readonly<Record<string, FrappeJsonValue>>;
    return Object.entries(expected).every(([key, value]) => key in actualRecord && hashFrappeCanonical(actualRecord[key]) === hashFrappeCanonical(value));
  }
  return false;
}

export function verifyFrappePostcondition(assertion: FrappePostcondition, actual: FrappeJsonValue | undefined): boolean {
  switch (assertion.operator) {
    case "exists": return actual !== undefined && actual !== null;
    case "absent": return actual === undefined || actual === null;
    case "equals": return actual !== undefined && assertion.expected !== undefined && hashFrappeCanonical(actual) === hashFrappeCanonical(assertion.expected);
    case "not_equals": return actual === undefined || assertion.expected === undefined || hashFrappeCanonical(actual) !== hashFrappeCanonical(assertion.expected);
    case "contains": return actual !== undefined && assertion.expected !== undefined && contains(actual, assertion.expected);
  }
}

export interface FrappeVerificationResult {
  readonly valid: boolean;
  readonly checks: readonly { readonly id: string; readonly passed: boolean; readonly description: string }[];
}

export function verifyFrappeChangeSetEffects(changeSet: FrappeChangeSet, observations: Readonly<Record<string, FrappeJsonValue | undefined>>): FrappeVerificationResult {
  const checks = changeSet.verification.map((rule) => ({
    id: rule.id,
    passed: verifyFrappePostcondition(rule.assertion, observations[rule.id]),
    description: rule.description,
  }));
  return deepFreeze({ valid: checks.length > 0 && checks.every((check) => check.passed), checks });
}

export function selectFrappeRepair(changeSet: FrappeChangeSet, operationId: string): FrappeRepairPlan | undefined {
  const operation = changeSet.operations.find((candidate) => candidate.id === operationId);
  if (!operation) throw new FrappeChangeSetValidationError(`Unknown operation ${operationId}.`, [{ code: "operation_missing", path: "operationId", message: `Unknown operation ${operationId}.` }]);
  if (!operation.effectReceipt || operation.effectReceipt.status === "no_effect") return undefined;
  return operation.repair;
}
