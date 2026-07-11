export const QA_STATES = [
  "SOURCE_LOCK",
  "DIFF",
  "TOPOLOGY",
  "BEFORE_SNAPSHOT",
  "GATE",
  "SEED",
  "FAULT",
  "OBSERVE",
  "COMMAND_MATRIX",
  "DATA_VERIFY",
  "RESTORE",
  "POST_PROOF",
  "REPORT",
] as const;

export type QaState = (typeof QA_STATES)[number];
export type QaVerdict = "PASS" | "FAIL" | "INCONCLUSIVE" | "NOT_APPLICABLE" | "RESTORE_FAILED";
export type QaRunStatus = "RUNNING" | QaVerdict;

export const POLICY_ROLE_IDS = [
  "release-sentinel",
  "topology-surveyor",
  "engine-specialist",
  "typed-executor",
  "invariant-auditor",
  "recovery-controller",
  "human-reporter",
] as const;

export type PolicyRoleId = (typeof POLICY_ROLE_IDS)[number];
export type EngineId = "sentinel" | "redis" | "valkey" | "postgres" | "mongo" | "kafka" | "qdrant" | "observability";
export type QaSuiteEngineId = Exclude<EngineId, "sentinel"> | "all";
export type ChangeCategory = "docs" | "tests" | "runtime" | "schema" | "config" | "security" | "build" | "unknown";
export type ChangeImpact = "NO_CHANGE" | "DOCUMENTATION_ONLY" | "TEST_ONLY" | "NON_RUNTIME" | "RUNTIME" | "HIGH_RISK";
export type QaUseCaseFamily =
  | "baseline"
  | "configuration"
  | "deployment"
  | "health_status"
  | "diagnostics"
  | "backup_restore"
  | "recovery"
  | "high_availability"
  | "disaster_recovery"
  | "migration"
  | "security"
  | "scale_upgrade"
  | "integrations"
  | "observability"
  | "destructive_dry_run";
export type QaUseCaseRisk = "read_only" | "mutation_gated" | "destructive_plan";
export type QaUseCaseDispatch = "typed_adapter_required" | "approval_adapter_required" | "approval_compensation_adapter_required";
export type QaValidationVerdict = "PASS" | "FAIL" | "INCONCLUSIVE" | "BLOCKED";
export type DocumentationImpactStatus = "NOT_REQUIRED" | "SATISFIED" | "WAIVED" | "BLOCKED";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface PolicyRole {
  readonly id: PolicyRoleId;
  readonly purpose: string;
  readonly allowedOperationPrefixes: readonly string[];
  readonly mayPropose: boolean;
  readonly mayExecute: boolean;
  readonly mayApprove: boolean;
  readonly mayAssert: boolean;
  readonly separationOfDuties: readonly string[];
}

export interface SourceLock {
  readonly repository: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly lockedAt: string;
  readonly lockDigest: string;
}

export interface ChangedFile {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted" | "renamed";
  readonly additions: number;
  readonly deletions: number;
}

export interface ClassifiedFile extends ChangedFile {
  readonly categories: readonly ChangeCategory[];
  readonly apps: readonly string[];
  readonly modules: readonly string[];
  readonly engines: readonly EngineId[];
  readonly risk: number;
}

export interface DiffClassification {
  readonly classificationDigest: string;
  readonly lockDigest: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly impact: ChangeImpact;
  readonly meaningful: boolean;
  readonly riskScore: number;
  readonly files: readonly ClassifiedFile[];
  readonly apps: readonly string[];
  readonly modules: readonly string[];
  readonly engines: readonly EngineId[];
  readonly reasons: readonly string[];
}

export interface ProfilePathRule {
  readonly prefix: string;
  readonly app: string;
  readonly module: string;
  readonly engines: readonly EngineId[];
}

export interface DeploymentProfile {
  readonly id: string;
  readonly name: string;
  readonly repository: string;
  readonly branch: string;
  readonly schedule?: string;
  readonly timezone?: string;
  readonly pathRules: readonly ProfilePathRule[];
  readonly enabledEngines: readonly EngineId[];
  readonly adjacentModules: Readonly<Record<string, readonly string[]>>;
  readonly labels?: Readonly<Record<string, string>>;
}

export interface TypedCompensation {
  readonly operationType: string;
  readonly target: string;
  readonly params: Readonly<Record<string, JsonValue>>;
}

export interface TypedOperation {
  readonly id: string;
  readonly state: QaState;
  readonly role: PolicyRoleId;
  readonly executorRole: "typed-executor";
  readonly operationType: string;
  readonly engine?: EngineId;
  readonly target: string;
  readonly params: Readonly<Record<string, JsonValue>>;
  readonly mutating: boolean;
  readonly compensation?: TypedCompensation;
  readonly timeoutMs: number;
  readonly evidenceRequired: readonly string[];
}

export interface QaValidatorOwner {
  readonly kind: "feature_suite";
  readonly feature: QaUseCaseFamily;
  readonly suiteContractId: string;
}

export interface QaSuiteValidator {
  readonly id: string;
  readonly owner: QaValidatorOwner;
  readonly operator: "deep_equal";
  readonly expected: JsonValue;
  readonly evidenceRequired: readonly string[];
  readonly terminal: true;
  readonly deployment: {
    readonly required: boolean;
    readonly postDeploymentFamilies: readonly QaUseCaseFamily[];
  };
}

export interface QaSuiteContract {
  readonly id: string;
  readonly engine: QaSuiteEngineId;
  readonly suite: string;
  readonly scopes: readonly string[];
  readonly family: QaUseCaseFamily;
  readonly risk: QaUseCaseRisk;
  readonly approvalRequired: boolean;
  readonly compensationRequired: boolean;
  readonly commandIds: readonly string[];
  readonly evidenceRequired: readonly string[];
  readonly validator: QaSuiteValidator;
}

export interface QaUseCaseSelection extends QaSuiteContract {
  readonly selectionId: string;
  readonly targetEngine?: EngineId;
  readonly selection: "direct" | "adjacent" | "contract";
  readonly dispatch: QaUseCaseDispatch;
  readonly blockedReason?: string;
  readonly reason: string;
}

export interface QaUseCasePlan {
  readonly catalogVersion: string;
  readonly catalogDigest: string;
  readonly sourceSha: string;
  readonly profileId: string;
  readonly selected: readonly QaUseCaseSelection[];
  readonly readOnlyCount: number;
  readonly gatedCount: number;
}

export interface OwnedDocumentation {
  readonly path: string;
  readonly owner: string;
  readonly covers: readonly string[];
}

export interface DocumentationWaiver {
  readonly id: string;
  readonly approvedBy: string;
  readonly reason: string;
  readonly sourceSha: string;
  readonly impact: Extract<ChangeImpact, "RUNTIME" | "HIGH_RISK">;
  readonly paths: readonly string[];
}

export interface DocumentationImpactGate {
  readonly required: boolean;
  readonly status: DocumentationImpactStatus;
  readonly affectedPaths: readonly string[];
  readonly ownedDocumentation: readonly OwnedDocumentation[];
  readonly waiver?: DocumentationWaiver;
  readonly reason: string;
}

export interface QaScenario {
  readonly id: string;
  readonly title: string;
  readonly app: string;
  readonly module: string;
  readonly engine?: EngineId;
  readonly selection: "direct" | "adjacent" | "contract";
  readonly reason: string;
  readonly useCaseIds: readonly string[];
  readonly invariants: readonly string[];
  readonly operations: readonly TypedOperation[];
}

export interface QaPlan {
  readonly planId: string;
  readonly planDigest: string;
  readonly profileId: string;
  readonly lockDigest: string;
  readonly sourceSha: string;
  readonly documentationImpact: DocumentationImpactGate;
  readonly useCases: QaUseCasePlan;
  readonly scenarios: readonly QaScenario[];
  readonly operations: readonly TypedOperation[];
  readonly mutationCount: number;
  readonly tokenPolicy: {
    readonly deterministicFirst: true;
    readonly noModelShell: true;
    readonly modelUse: "bounded_diff_summary_only";
    readonly cacheKey: string;
  };
}

export interface EvidenceReceipt {
  readonly id: string;
  readonly state: QaState;
  readonly kind: "source" | "diff" | "topology" | "snapshot" | "gate" | "command" | "probe" | "data_digest" | "restore" | "proof" | "report" | "negative_control";
  readonly operationId?: string;
  readonly selectionId?: string;
  readonly producerRole: PolicyRoleId;
  readonly subject: string;
  readonly observedAt: string;
  readonly sourceSha: string;
  readonly payloadDigest: string;
  readonly evidenceRef?: string;
  readonly redactedExcerpt?: string;
  readonly exitCode?: number;
}

export interface QaAssertion {
  readonly id: string;
  readonly subject: string;
  /** @deprecated Evaluators derive the verdict from expected and actual. */
  readonly passed?: boolean;
  readonly evidenceIds: readonly string[];
  readonly expected: string;
  readonly actual: string;
  readonly producerRole: PolicyRoleId;
}

export interface QaValidationEvidence {
  readonly [requirement: string]: readonly string[];
}

export interface QaValidationObservation {
  readonly selectionId: string;
  readonly validatorId: string;
  readonly observed: JsonValue;
  readonly evidence: QaValidationEvidence;
  readonly observedAt: string;
  readonly blockedReason?: string;
  readonly deployment?: {
    readonly evidenceId: string;
    readonly observedAt: string;
  };
}

export interface QaValidationResult {
  readonly id: string;
  readonly selectionId: string;
  readonly validatorId: string;
  readonly owner: QaValidatorOwner;
  readonly verdict: QaValidationVerdict;
  readonly terminal: true;
  readonly expected: JsonValue;
  readonly observed: JsonValue;
  readonly reason: string;
  readonly evidence: QaValidationEvidence;
  readonly evidenceIds: readonly string[];
  readonly observedAt: string;
  readonly deploymentEvidenceId?: string;
  readonly deploymentObservedAt?: string;
}

export interface QaValidationCoverage {
  readonly expectedCount: number;
  readonly terminalCount: number;
  readonly passedCount: number;
  readonly complete: boolean;
  readonly passable: boolean;
  readonly missingSelectionIds: readonly string[];
  readonly failedSelectionIds: readonly string[];
  readonly inconclusiveSelectionIds: readonly string[];
  readonly blockedSelectionIds: readonly string[];
  readonly duplicateSelectionIds: readonly string[];
  readonly invalidSelectionIds: readonly string[];
  readonly unexpectedSelectionIds: readonly string[];
  readonly deploymentOrderFailures: readonly string[];
}

export interface StateResult {
  readonly state: QaState;
  readonly verdict: QaVerdict;
  readonly receiptIds: readonly string[];
  readonly assertionIds: readonly string[];
  readonly probeIds: readonly string[];
  readonly reason: string;
  readonly completedAt: string;
}

export interface MutationLedgerEntry {
  readonly operationId: string;
  readonly compensation: TypedCompensation;
  readonly registeredAt: string;
  readonly dispatchingAt?: string;
  readonly appliedAt?: string;
  readonly restoredAt?: string;
  readonly status: "REGISTERED" | "DISPATCHING" | "APPLIED" | "RESTORED" | "RESTORE_FAILED";
  readonly receiptIds: readonly string[];
  readonly failure?: string;
}

export interface QaRun {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly profileId: string;
  readonly lock: SourceLock;
  readonly plan: QaPlan;
  readonly currentState: QaState;
  readonly status: QaRunStatus;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly stateResults: readonly StateResult[];
  readonly evidence: readonly EvidenceReceipt[];
  readonly validationResults: readonly QaValidationResult[];
  readonly mutationLedger: readonly MutationLedgerEntry[];
  readonly failureOrigins: readonly { readonly state: QaState; readonly verdict: QaVerdict; readonly reason: string }[];
  readonly recovery: {
    readonly requested: boolean;
    readonly reason?: string;
    readonly pendingOperationIds: readonly string[];
  };
}

export interface EngineDescriptor {
  readonly id: EngineId;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly modules: readonly string[];
  readonly adjacentModules: readonly string[];
  readonly topologyOperation: string;
  readonly snapshotOperation: string;
  readonly seedOperation: string;
  readonly cleanupOperation: string;
  readonly faultOperation: string;
  readonly recoverOperation: string;
  readonly observeOperation: string;
  readonly dataDigestOperation: string;
  readonly commandMatrix: readonly string[];
  readonly invariants: readonly string[];
}
