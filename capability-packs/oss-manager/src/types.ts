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
}

export interface QaUseCaseSelection extends QaSuiteContract {
  readonly selectionId: string;
  readonly targetEngine?: EngineId;
  readonly selection: "direct" | "adjacent" | "contract";
  readonly dispatch: QaUseCaseDispatch;
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
  readonly passed: boolean;
  readonly evidenceIds: readonly string[];
  readonly expected: string;
  readonly actual: string;
  readonly producerRole: PolicyRoleId;
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
