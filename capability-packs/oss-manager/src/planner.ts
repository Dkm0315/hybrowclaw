import {
  ALLOWED_OPERATION_TYPES,
  ENGINE_DESCRIPTORS,
  GENERIC_OSS_QA_PROFILE,
  HYBROWLABS_OSS_MANAGER_PROFILE,
  POLICY_ROLES,
  operationRole,
} from "./catalog.js";
import { selectUseCases } from "./use-cases.js";
import type {
  ChangeCategory,
  ChangedFile,
  ClassifiedFile,
  DeploymentProfile,
  DiffClassification,
  DocumentationImpactGate,
  DocumentationWaiver,
  EngineId,
  OwnedDocumentation,
  ProfilePathRule,
  QaPlan,
  QaScenario,
  QaState,
  QaUseCasePlan,
  QaUseCaseSelection,
  SourceLock,
  TypedOperation,
} from "./types.js";
import { asRecord, isoTimestamp, jsonRecord, nonNegativeInteger, optionalString, requiredString, sha256, shortDigest, uniqueSorted } from "./utils.js";

const SHA_PATTERN = /^[a-f0-9]{7,64}$/i;
const ENGINE_IDS = new Set<EngineId>(Object.keys(ENGINE_DESCRIPTORS) as EngineId[]);
const FORBIDDEN_OPERATION_KEYS = /^(?:command|cmd|shell|script|argv|executable|rawcommand)$/i;
const TARGET_PATTERN = /^(?:profile|engine|topology|fixture|receipt):\/\/[A-Za-z0-9._:/-]{1,240}$/;

export function sourceLockFromArgs(args: Record<string, unknown>): SourceLock {
  const repository = requiredString(args.repository, "repository");
  const branch = requiredString(args.branch, "branch");
  const baseSha = gitSha(args.baseSha, "baseSha");
  const headSha = gitSha(args.headSha, "headSha");
  const lockedAt = isoTimestamp(args.lockedAt, "lockedAt");
  if (baseSha === headSha && args.allowSameSha !== true) throw new Error("baseSha and headSha are identical; pass allowSameSha only for an explicit no-change certification.");
  const identity = { repository, branch, baseSha, headSha };
  return { ...identity, lockedAt, lockDigest: sha256(identity) };
}

export function classifyDiffFromArgs(args: Record<string, unknown>): DiffClassification {
  const lock = normalizeLock(args.lock);
  const profile = resolveProfile(args.profile, optionalString(args.profileId));
  const rawChanges = Array.isArray(args.changes) ? args.changes : [];
  const files = rawChanges.map((item, index) => classifyFile(item, index, profile));
  const categories = new Set(files.flatMap((file) => file.categories));
  const riskScore = files.reduce((total, file) => total + file.risk, 0);
  const impact = determineImpact(files, categories, riskScore);
  const reasons = impactReasons(impact, files, categories);
  const classificationBody = {
    lockDigest: lock.lockDigest,
    baseSha: lock.baseSha,
    headSha: lock.headSha,
    impact,
    meaningful: impact === "RUNTIME" || impact === "HIGH_RISK",
    riskScore,
    files,
    apps: uniqueSorted(files.flatMap((file) => file.apps)),
    modules: uniqueSorted(files.flatMap((file) => file.modules)),
    engines: uniqueSorted(files.flatMap((file) => file.engines)) as EngineId[],
    reasons,
  };
  return { classificationDigest: sha256(classificationBody), ...classificationBody };
}

export function compilePlanFromArgs(args: Record<string, unknown>): QaPlan {
  const lock = normalizeLock(args.lock);
  const classification = normalizeClassification(args.classification, lock);
  const profile = resolveProfile(args.profile, optionalString(args.profileId));
  const documentationImpact = evaluateDocumentationImpact(
    classification,
    lock,
    args.documentationImpact ?? args.documentation,
  );
  const useCases = selectUseCases(profile, classification, lock.headSha);
  const scenarios = compileScenarios(profile, classification, lock, useCases);
  const scenarioMutationIds = scenarios.flatMap((scenario) => scenario.operations)
    .filter((operation) => operation.mutating)
    .map((operation) => operation.id);
  const commonOperations = compileCommonOperations(lock, classification, documentationImpact, useCases, scenarioMutationIds);
  const operations = dedupeOperations([...commonOperations, ...scenarios.flatMap((scenario) => scenario.operations)]);
  operations.forEach(validateTypedOperation);
  const tokenPolicy = {
    deterministicFirst: true as const,
    noModelShell: true as const,
    modelUse: "bounded_diff_summary_only" as const,
    cacheKey: sha256({
      baseSha: lock.baseSha,
      headSha: lock.headSha,
      profileId: profile.id,
      documentationImpact,
      suiteCatalogDigest: useCases.catalogDigest,
      useCaseIds: useCases.selected.map((item) => item.selectionId),
      scenarios: scenarios.map((item) => item.id),
    }),
  };
  const planBody = {
    profileId: profile.id,
    lockDigest: lock.lockDigest,
    sourceSha: lock.headSha,
    documentationImpact,
    useCases,
    scenarios,
    operations,
    mutationCount: operations.filter((operation) => operation.mutating).length,
    tokenPolicy,
  };
  const planDigest = sha256(planBody);
  const planId = `qa-plan-${shortDigest(planBody)}`;
  return {
    planId,
    planDigest,
    ...planBody,
  };
}

export function documentationImpactFromArgs(args: Record<string, unknown>): DocumentationImpactGate {
  const lock = normalizeLock(args.lock);
  const classification = normalizeClassification(args.classification, lock);
  return evaluateDocumentationImpact(classification, lock, args.documentationImpact ?? args.documentation);
}

export function resolveProfile(value: unknown, profileId?: string): DeploymentProfile {
  if (value !== undefined) return normalizeProfile(value);
  if (profileId === HYBROWLABS_OSS_MANAGER_PROFILE.id) return HYBROWLABS_OSS_MANAGER_PROFILE;
  return GENERIC_OSS_QA_PROFILE;
}

export function validateTypedOperation(operation: TypedOperation): void {
  if (!ALLOWED_OPERATION_TYPES.has(operation.operationType)) throw new Error(`Unknown typed operation: ${operation.operationType}.`);
  if (operation.executorRole !== "typed-executor") throw new Error(`Operation ${operation.id} must dispatch through the typed executor.`);
  if (!TARGET_PATTERN.test(operation.target)) throw new Error(`Operation ${operation.id} has an invalid typed target selector.`);
  if (!Number.isInteger(operation.timeoutMs) || operation.timeoutMs < 100 || operation.timeoutMs > 900_000) {
    throw new Error(`Operation ${operation.id} timeout must be between 100 and 900000 ms.`);
  }
  rejectFreeFormExecution(operation.params, `operation ${operation.id} params`);
  const role = POLICY_ROLES.find((candidate) => candidate.id === operation.role);
  if (!role || !role.allowedOperationPrefixes.some((prefix) => operation.operationType.startsWith(prefix))) {
    throw new Error(`Role ${operation.role} cannot own operation ${operation.operationType}.`);
  }
  if (operation.mutating && !operation.compensation) throw new Error(`Mutation ${operation.id} has no predeclared compensation.`);
  if (!operation.mutating && operation.compensation) throw new Error(`Read-only operation ${operation.id} cannot declare a compensation.`);
  if (operation.compensation) {
    if (!ALLOWED_OPERATION_TYPES.has(operation.compensation.operationType)) throw new Error(`Unknown compensation operation: ${operation.compensation.operationType}.`);
    if (!operation.compensation.operationType.startsWith("restore.") && !operation.compensation.operationType.includes("cleanup")) {
      throw new Error(`Compensation ${operation.compensation.operationType} is not a recovery operation.`);
    }
    if (!TARGET_PATTERN.test(operation.compensation.target)) throw new Error(`Mutation ${operation.id} has an invalid compensation target.`);
    rejectFreeFormExecution(operation.compensation.params, `operation ${operation.id} compensation params`);
  }
}

export function normalizeLock(value: unknown): SourceLock {
  const lock = asRecord(value, "lock");
  const normalized: SourceLock = {
    repository: requiredString(lock.repository, "lock.repository"),
    branch: requiredString(lock.branch, "lock.branch"),
    baseSha: gitSha(lock.baseSha, "lock.baseSha"),
    headSha: gitSha(lock.headSha, "lock.headSha"),
    lockedAt: isoTimestamp(lock.lockedAt, "lock.lockedAt"),
    lockDigest: requiredString(lock.lockDigest, "lock.lockDigest"),
  };
  const expected = sha256({ repository: normalized.repository, branch: normalized.branch, baseSha: normalized.baseSha, headSha: normalized.headSha });
  if (normalized.lockDigest !== expected) throw new Error("Source lock digest does not match its repository, branch, and SHAs.");
  return normalized;
}

function classifyFile(value: unknown, index: number, profile: DeploymentProfile): ClassifiedFile {
  const item = asRecord(value, `changes[${index}]`);
  const path = normalizeRepoPath(requiredString(item.path, `changes[${index}].path`));
  const status = normalizeStatus(item.status);
  const additions = nonNegativeInteger(item.additions, `changes[${index}].additions`);
  const deletions = nonNegativeInteger(item.deletions, `changes[${index}].deletions`);
  const categories = categoriesFor(path);
  const matches = profile.pathRules.filter((rule) => path === rule.prefix || path.startsWith(`${rule.prefix}/`) || path.includes(`/${rule.prefix}/`));
  const inferredEngines = (Object.keys(ENGINE_DESCRIPTORS) as EngineId[]).filter((engine) => engineMentioned(path, engine));
  const apps = matches.length ? uniqueSorted(matches.map((rule) => rule.app)) : inferApps(path);
  const modules = matches.length ? uniqueSorted(matches.map((rule) => rule.module)) : inferModules(path, inferredEngines);
  const engines = uniqueSorted([...matches.flatMap((rule) => rule.engines), ...inferredEngines]) as EngineId[];
  return { path, status, additions, deletions, categories, apps, modules, engines, risk: riskFor(categories, status) };
}

function categoriesFor(path: string): ChangeCategory[] {
  const categories = new Set<ChangeCategory>();
  if (/(^|\/)(?:docs?|documentation)(\/|$)|\.(?:md|mdx|rst|txt)$/i.test(path)) categories.add("docs");
  if (/(^|\/)(?:tests?|specs?|qa|evals?)(\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path)) categories.add("tests");
  if (/(^|\/)(?:schema|migrations?|patches?|doctype)(\/|$)|\.(?:sql|ddl)$/i.test(path)) categories.add("schema");
  if (/(^|\/)(?:security|auth|permissions?|rbac|secrets?)(\/|$)/i.test(path)) categories.add("security");
  if (/(^|\/)(?:jenkins|\.github|ci|build|deploy|docker)(\/|$)|(?:Dockerfile|Jenkinsfile)$/i.test(path)) categories.add("build");
  if (/(^|\/)(?:config|configs|settings)(\/|$)|\.(?:ya?ml|toml|ini|env\.example)$/i.test(path)) categories.add("config");
  if (/\.(?:py|[cm]?[jt]sx?|go|rs|java|sh)$/i.test(path) && !categories.has("tests")) categories.add("runtime");
  if (!categories.size) categories.add("unknown");
  return [...categories].sort();
}

function determineImpact(files: readonly ClassifiedFile[], categories: ReadonlySet<ChangeCategory>, risk: number): DiffClassification["impact"] {
  if (!files.length) return "NO_CHANGE";
  if ([...categories].every((category) => category === "docs")) return "DOCUMENTATION_ONLY";
  if ([...categories].every((category) => category === "tests")) return "TEST_ONLY";
  if (categories.has("security") || categories.has("schema") || risk >= 12) return "HIGH_RISK";
  if (categories.has("runtime")) return "RUNTIME";
  return "NON_RUNTIME";
}

function impactReasons(impact: DiffClassification["impact"], files: readonly ClassifiedFile[], categories: ReadonlySet<ChangeCategory>): string[] {
  if (impact === "NO_CHANGE") return ["No changed files; compile only source-lock and no-change contract checks."];
  const reasons = [`${files.length} changed file(s) classified as ${impact.toLowerCase().replaceAll("_", " ")}.`];
  if (categories.has("security")) reasons.push("Security-sensitive paths require elevated gates and negative controls.");
  if (categories.has("schema")) reasons.push("Schema changes require data-integrity and rollback evidence.");
  if (impact === "DOCUMENTATION_ONLY" || impact === "TEST_ONLY") reasons.push("Non-runtime changes still receive deterministic contract checks; they are never silently ignored.");
  return reasons;
}

function compileScenarios(
  profile: DeploymentProfile,
  classification: DiffClassification,
  lock: SourceLock,
  useCases: QaUseCasePlan,
): QaScenario[] {
  const contractUseCases = useCases.selected.filter((item) => item.selection === "contract").map((item) => item.selectionId);
  if (classification.impact === "NO_CHANGE") return [contractScenario("no-change", "No-change certification", "Verify source identity and cached certification state.", lock, contractUseCases)];
  if (classification.impact === "DOCUMENTATION_ONLY") return [contractScenario("docs-contract", "Documentation contract", "Verify examples, command names, and documented surfaces against the locked source.", lock, contractUseCases)];
  if (classification.impact === "TEST_ONLY") return [contractScenario("test-contract", "Test-manifest contract", "Verify changed tests are discoverable and still exercise declared capabilities.", lock, contractUseCases)];

  const inferred = classification.engines.length ? classification.engines : inferEnginesFromModules(classification.modules, profile.enabledEngines);
  const engines = inferred.filter((engine) => profile.enabledEngines.includes(engine));
  const scenarios: QaScenario[] = [];
  for (const engine of engines) {
    const descriptor = ENGINE_DESCRIPTORS[engine];
    const changedModule = primaryModuleForEngine(classification, engine);
    const selections = useCases.selected.filter((item) => item.targetEngine === engine);
    const direct = selections.filter((item) => item.selection === "direct");
    const adjacent = selections.filter((item) => item.selection === "adjacent");
    const behavior = engineBehaviorFor(classification, engine);
    scenarios.push(engineScenario(
      engine,
      changedModule,
      "direct",
      `Changed paths map to ${descriptor.title}; selected ${direct.length} direct suite contract(s).`,
      lock,
      direct,
      behavior,
    ));
    if (adjacent.length) {
      scenarios.push(engineScenario(
        engine,
        "adjacent-regression",
        "adjacent",
        `${adjacent.length} bounded suite contract(s) protect behavior adjacent to changed ${changedModule} paths.`,
        lock,
        adjacent,
        { readOnly: true, requiresFixture: false, requiresFault: false },
      ));
    }
  }
  if (!scenarios.length) {
    const app = classification.apps[0] ?? "runtime-app";
    const module = classification.modules[0] ?? "control-plane";
    scenarios.push({
      ...contractScenario(`control-plane-${app}-${module}`, "Control-plane regression", "No engine was inferred; verify generic app contracts without infrastructure mutation.", lock, contractUseCases),
      app,
      module,
    });
  }
  return dedupeScenarios(scenarios);
}

function engineScenario(
  engine: EngineId,
  module: string,
  selection: "direct" | "adjacent",
  reason: string,
  lock: SourceLock,
  useCases: readonly QaUseCaseSelection[],
  behavior: { readonly readOnly: boolean; readonly requiresFixture: boolean; readonly requiresFault: boolean },
): QaScenario {
  const descriptor = ENGINE_DESCRIPTORS[engine];
  const seed = `${engine}-${module}-${lock.headSha}`;
  const target = `engine://${engine}/discovered-cluster`;
  const topologyOperation = operation(seed, "TOPOLOGY", descriptor.topologyOperation, target, engine, false, { scope: "all_nodes" });
  const snapshotOperation = operation(seed, "BEFORE_SNAPSHOT", descriptor.snapshotOperation, target, engine, false, { include: ["roles", "health", "data_digest", "service_state"] });
  const capturedPrimary = `topology://${engine}/captured-primary/${shortDigest(snapshotOperation.id)}`;
  const operations: TypedOperation[] = [topologyOperation, snapshotOperation];
  if (behavior.requiresFixture) {
    operations.push(
      operation(seed, "SEED", descriptor.seedOperation, `fixture://${engine}/${shortDigest(seed)}`, engine, true, { coverage: "all_supported_types", namespace: `qa_${shortDigest(seed)}` }, {
        operationType: descriptor.cleanupOperation,
        target: `fixture://${engine}/${shortDigest(seed)}`,
        params: { scope: "exact_fixture_namespace" },
      }),
    );
  }
  if (behavior.requiresFault) {
    operations.push(
      operation(seed, "FAULT", descriptor.faultOperation, capturedPrimary, engine, true, {
        mode: "controlled_single_service_stop",
        immutableBinding: "before_snapshot_primary",
        snapshotOperationId: snapshotOperation.id,
      }, {
        operationType: descriptor.recoverOperation,
        target: capturedPrimary,
        params: { restore: "captured_service_state", snapshotOperationId: snapshotOperation.id },
      }),
      operation(seed, "OBSERVE", descriptor.observeOperation, target, engine, false, { requireIndependentProbe: true }),
    );
  }
  operations.push(
    ...descriptor.commandMatrix.map((operationType) => operation(seed, "COMMAND_MATRIX", operationType, target, engine, false, { mode: module })),
    ...useCases
      .filter((item) => item.risk !== "mutation_gated")
      .map((item) => operation(
        `${seed}-${item.id}`,
        "COMMAND_MATRIX",
        "matrix.suite_contract",
        `engine://${engine}/suite/${item.suite}`,
        engine,
        false,
        {
          suiteContractId: item.id,
          selectionId: item.selectionId,
          family: item.family,
          scopes: item.scopes,
          selection: item.selection,
          approvalRequired: item.approvalRequired,
          validatorId: item.validator.id,
          sourceSha: lock.headSha,
        },
      )),
    operation(seed, "DATA_VERIFY", descriptor.dataDigestOperation, target, engine, false, { coverage: "every_seeded_record_and_field", ttlToleranceMs: 1500 }),
  );
  return {
    id: `scenario-${shortDigest({ engine, module, selection, headSha: lock.headSha })}`,
    title: `${descriptor.title}: ${module}`,
    app: "runtime-app",
    module,
    engine,
    selection,
    reason,
    useCaseIds: useCases.map((item) => item.selectionId),
    invariants: descriptor.invariants,
    operations,
  };
}

function contractScenario(id: string, title: string, reason: string, lock: SourceLock, useCaseIds: readonly string[] = []): QaScenario {
  return {
    id: `scenario-${id}-${lock.headSha.slice(0, 8)}`,
    title,
    app: "source-contract",
    module: id,
    selection: "contract",
    reason,
    useCaseIds,
    invariants: ["The source lock matches every receipt.", "Declared surfaces remain internally consistent."],
    operations: [],
  };
}

function compileCommonOperations(
  lock: SourceLock,
  classification: DiffClassification,
  documentationImpact: DocumentationImpactGate,
  useCases: QaUseCasePlan,
  mutationOperationIds: readonly string[],
): TypedOperation[] {
  const seed = `common-${lock.headSha}`;
  return [
    operation(seed, "SOURCE_LOCK", "source.verify_lock", "profile://source/repository", undefined, false, { lockDigest: lock.lockDigest, headSha: lock.headSha }),
    operation(seed, "DIFF", "diff.verify_classification", "profile://source/diff", undefined, false, { impact: classification.impact, fileCount: classification.files.length }),
    operation(seed, "GATE", "gate.approve_plan", "profile://qa/release-gate", undefined, false, {
      riskScore: classification.riskScore,
      sourceSha: lock.headSha,
      suiteCatalogDigest: useCases.catalogDigest,
      gatedUseCaseIds: useCases.selected.filter((item) => item.approvalRequired).map((item) => item.selectionId),
      mutationOperationIds,
      documentationImpactStatus: documentationImpact.status,
      documentationAffectedPaths: documentationImpact.affectedPaths,
      documentationWaiverId: documentationImpact.waiver?.id ?? null,
    }),
    ...useCases.selected
      .filter((item) => item.selection === "contract")
      .map((item) => operation(
        `${seed}-${item.id}`,
        "COMMAND_MATRIX",
        "matrix.suite_contract",
        `profile://qa/suite/${item.suite}`,
        undefined,
        false,
        {
          suiteContractId: item.id,
          selectionId: item.selectionId,
          family: item.family,
          scopes: item.scopes,
          selection: item.selection,
          approvalRequired: item.approvalRequired,
          validatorId: item.validator.id,
          sourceSha: lock.headSha,
        },
      )),
    operation(seed, "POST_PROOF", "proof.snapshot_compare", "profile://qa/post-proof", undefined, false, { comparison: "before_vs_after_allowed_state" }),
    operation(seed, "REPORT", "report.render_receipts", "profile://qa/report", undefined, false, { format: "human_summary_plus_raw_receipt_index" }),
  ];
}

function evaluateDocumentationImpact(
  classification: DiffClassification,
  lock: SourceLock,
  value: unknown,
): DocumentationImpactGate {
  const required = classification.impact === "RUNTIME" || classification.impact === "HIGH_RISK";
  const affectedPaths = uniqueSorted(classification.files
    .filter((file) => !file.categories.every((category) => category === "docs" || category === "tests"))
    .map((file) => file.path));
  if (!required) {
    return {
      required: false,
      status: "NOT_REQUIRED",
      affectedPaths: [],
      ownedDocumentation: [],
      reason: `${classification.impact} changes do not require the runtime documentation-impact gate.`,
    };
  }

  const declaration = value === undefined ? {} : asRecord(value, "documentationImpact");
  const rawOwned = declaration.ownedDocumentation ?? declaration.ownedDocs ?? [];
  if (!Array.isArray(rawOwned)) throw new Error("documentationImpact.ownedDocumentation must be an array.");
  const ownedDocumentation = rawOwned.map((item, index) => normalizeOwnedDocumentation(item, index, classification, affectedPaths));
  const covered = new Set(ownedDocumentation.flatMap((item) => item.covers));
  const uncovered = affectedPaths.filter((path) => !covered.has(path));
  if (!uncovered.length && ownedDocumentation.length) {
    return {
      required: true,
      status: "SATISFIED",
      affectedPaths,
      ownedDocumentation,
      reason: "Owned documentation explicitly covers every runtime or high-risk changed path.",
    };
  }

  const rawWaiver = declaration.waiver ?? declaration.approval;
  const waiver = rawWaiver === undefined ? undefined : normalizeDocumentationWaiver(rawWaiver);
  if (waiver) {
    const pathsMatch = sameStrings(waiver.paths, affectedPaths);
    const sourceMatches = waiver.sourceSha === lock.headSha;
    const impactMatches = waiver.impact === classification.impact;
    if (pathsMatch && sourceMatches && impactMatches) {
      return {
        required: true,
        status: "WAIVED",
        affectedPaths,
        ownedDocumentation,
        waiver,
        reason: `Documentation impact was explicitly approved for the locked source and ${affectedPaths.length} exact changed path(s).`,
      };
    }
    const mismatches = [
      !sourceMatches ? "source SHA" : undefined,
      !impactMatches ? "impact" : undefined,
      !pathsMatch ? "path scope" : undefined,
    ].filter(Boolean).join(", ");
    return {
      required: true,
      status: "BLOCKED",
      affectedPaths,
      ownedDocumentation,
      waiver,
      reason: `Documentation waiver is not bounded to the locked ${mismatches}.`,
    };
  }

  return {
    required: true,
    status: "BLOCKED",
    affectedPaths,
    ownedDocumentation,
    reason: uncovered.length
      ? `Documentation impact is missing owned coverage for ${uncovered.join(", ")}.`
      : "Documentation impact requires owned documentation or an explicit bounded approval.",
  };
}

function normalizeOwnedDocumentation(
  value: unknown,
  index: number,
  classification: DiffClassification,
  affectedPaths: readonly string[],
): OwnedDocumentation {
  const item = asRecord(value, `documentationImpact.ownedDocumentation[${index}]`);
  const path = normalizeRepoPath(requiredString(item.path, `documentationImpact.ownedDocumentation[${index}].path`));
  if (!categoriesFor(path).includes("docs")) throw new Error(`Owned documentation path ${path} is not a documentation path.`);
  const covers = stringArray(item.covers, `documentationImpact.ownedDocumentation[${index}].covers`).map(normalizeRepoPath);
  const outsideScope = covers.find((coveredPath) => !affectedPaths.includes(coveredPath));
  if (outsideScope) throw new Error(`Owned documentation coverage ${outsideScope} is outside the locked change scope.`);
  const owner = requiredString(item.owner, `documentationImpact.ownedDocumentation[${index}].owner`);
  for (const coveredPath of covers) {
    const file = classification.files.find((candidate) => candidate.path === coveredPath);
    const allowedOwners = file ? uniqueSorted([
      ...file.apps.map((app) => `app:${app}`),
      ...file.modules.map((module) => `module:${module}`),
      ...file.engines.map((engine) => `engine:${engine}`),
    ]) : [];
    if (!allowedOwners.includes(owner)) {
      throw new Error(`Owned documentation owner ${owner} does not own ${coveredPath}; expected one of ${allowedOwners.join(", ")}.`);
    }
  }
  return {
    path,
    owner,
    covers,
  };
}

function normalizeDocumentationWaiver(value: unknown): DocumentationWaiver {
  const waiver = asRecord(value, "documentationImpact.waiver");
  const impact = requiredString(waiver.impact, "documentationImpact.waiver.impact");
  if (impact !== "RUNTIME" && impact !== "HIGH_RISK") {
    throw new Error("documentationImpact.waiver.impact must be RUNTIME or HIGH_RISK.");
  }
  return {
    id: requiredString(waiver.id ?? waiver.approvalId, "documentationImpact.waiver.id"),
    approvedBy: requiredString(waiver.approvedBy ?? waiver.approver, "documentationImpact.waiver.approvedBy"),
    reason: requiredString(waiver.reason, "documentationImpact.waiver.reason"),
    sourceSha: gitSha(waiver.sourceSha, "documentationImpact.waiver.sourceSha"),
    impact,
    paths: stringArray(waiver.paths, "documentationImpact.waiver.paths").map(normalizeRepoPath),
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = uniqueSorted(left);
  const normalizedRight = uniqueSorted(right);
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function operation(
  seed: string,
  state: QaState,
  operationType: string,
  target: string,
  engine: EngineId | undefined,
  mutating: boolean,
  params: Record<string, unknown>,
  compensation?: { operationType: string; target: string; params: Record<string, unknown> },
): TypedOperation {
  const id = `op-${shortDigest({ seed, state, operationType, target, params })}`;
  return {
    id,
    state,
    role: operationRole(state),
    executorRole: "typed-executor",
    operationType,
    engine,
    target,
    params: jsonRecord(params, `${id}.params`),
    mutating,
    compensation: compensation ? {
      operationType: compensation.operationType,
      target: compensation.target,
      params: jsonRecord(compensation.params, `${id}.compensation.params`),
    } : undefined,
    timeoutMs: state === "FAULT" || state === "RESTORE" ? 300_000 : 60_000,
    evidenceRequired: evidenceFor(state),
  };
}

function evidenceFor(state: QaState): string[] {
  if (["TOPOLOGY", "BEFORE_SNAPSHOT", "SEED", "FAULT", "OBSERVE", "COMMAND_MATRIX", "DATA_VERIFY", "RESTORE", "POST_PROOF"].includes(state)) {
    return ["semantic_assertion", "independent_probe", "payload_digest", "source_sha"];
  }
  return ["semantic_assertion", "payload_digest", "source_sha"];
}

function normalizeProfile(value: unknown): DeploymentProfile {
  const profile = asRecord(value, "profile");
  const pathRules = Array.isArray(profile.pathRules) ? profile.pathRules.map(normalizePathRule) : [];
  const enabledEngines = normalizeEngines(profile.enabledEngines, "profile.enabledEngines");
  const rawAdjacent = asRecord(profile.adjacentModules ?? {}, "profile.adjacentModules");
  const adjacentModules = Object.fromEntries(Object.entries(rawAdjacent).map(([key, list]) => [key, stringArray(list, `profile.adjacentModules.${key}`)]));
  return {
    id: requiredString(profile.id, "profile.id"),
    name: requiredString(profile.name, "profile.name"),
    repository: requiredString(profile.repository, "profile.repository"),
    branch: requiredString(profile.branch, "profile.branch"),
    schedule: optionalString(profile.schedule),
    timezone: optionalString(profile.timezone),
    pathRules,
    enabledEngines,
    adjacentModules,
  };
}

function normalizePathRule(value: unknown, index: number): ProfilePathRule {
  const rule = asRecord(value, `profile.pathRules[${index}]`);
  return {
    prefix: normalizeRepoPath(requiredString(rule.prefix, `profile.pathRules[${index}].prefix`)),
    app: requiredString(rule.app, `profile.pathRules[${index}].app`),
    module: requiredString(rule.module, `profile.pathRules[${index}].module`),
    engines: normalizeEngines(rule.engines, `profile.pathRules[${index}].engines`),
  };
}

function normalizeClassification(value: unknown, lock: SourceLock): DiffClassification {
  const classification = asRecord(value, "classification") as unknown as DiffClassification;
  if (classification.lockDigest !== lock.lockDigest || classification.baseSha !== lock.baseSha || classification.headSha !== lock.headSha) {
    throw new Error("Diff classification does not belong to the supplied source lock.");
  }
  if (!Array.isArray(classification.files) || !Array.isArray(classification.engines) || !Array.isArray(classification.modules)) {
    throw new Error("classification is missing normalized files, engines, or modules.");
  }
  const { classificationDigest, ...body } = classification;
  if (classificationDigest !== sha256(body)) throw new Error("Diff classification digest does not match its deterministic content.");
  return classification;
}

function normalizeEngines(value: unknown, label: string): EngineId[] {
  const values = stringArray(value, label);
  for (const engine of values) if (!ENGINE_IDS.has(engine as EngineId)) throw new Error(`${label} contains unknown engine ${engine}.`);
  return uniqueSorted(values) as EngineId[];
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) throw new Error(`${label} must be an array of non-empty strings.`);
  return uniqueSorted(value.map((item) => item.trim()));
}

function normalizeStatus(value: unknown): ChangedFile["status"] {
  const status = optionalString(value) ?? "modified";
  if (!["added", "modified", "deleted", "renamed"].includes(status)) throw new Error(`Unsupported change status: ${status}.`);
  return status as ChangedFile["status"];
}

function normalizeRepoPath(value: string): string {
  const path = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
  if (!path || path.startsWith("/") || path.split("/").includes("..")) throw new Error(`Unsafe repository path: ${value}.`);
  return path.replace(/\/$/, "");
}

function gitSha(value: unknown, label: string): string {
  const sha = requiredString(value, label).toLowerCase();
  if (!SHA_PATTERN.test(sha)) throw new Error(`${label} must be a 7-64 character hexadecimal Git object id.`);
  return sha;
}

function inferApps(path: string): string[] {
  const parts = path.split("/");
  if (parts[0] === "apps" && parts[1]) return [parts[1]];
  return [parts[0] || "unknown"];
}

function inferModules(path: string, engines: readonly EngineId[]): string[] {
  if (engines.length) return [...engines];
  const parts = path.split("/").filter(Boolean);
  return [parts.length > 1 ? parts[parts.length - 2] : parts[0] ?? "unknown"];
}

function engineMentioned(path: string, engine: EngineId): boolean {
  const descriptor = ENGINE_DESCRIPTORS[engine];
  // OSS Manager's historical redis-script/ package root is not an engine signal.
  const normalized = path.toLowerCase().replace(/^redis-script\//, "");
  return [engine, ...descriptor.aliases].some((alias) => new RegExp(`(^|[/_.-])${escapeRegExp(alias)}([/_.-]|$)`, "i").test(normalized));
}

function inferEnginesFromModules(modules: readonly string[], enabled: readonly EngineId[]): EngineId[] {
  return enabled.filter((engine) => {
    const descriptor = ENGINE_DESCRIPTORS[engine];
    return modules.some((module) => descriptor.modules.includes(module) || descriptor.aliases.includes(module));
  });
}

function primaryModuleForEngine(classification: DiffClassification, engine: EngineId): string {
  const descriptor = ENGINE_DESCRIPTORS[engine];
  const modules = uniqueSorted(classification.files
    .filter((file) => file.engines.includes(engine))
    .flatMap((file) => file.modules));
  return modules.find((module) => descriptor.modules.includes(module) || descriptor.adjacentModules.includes(module))
    ?? descriptor.modules[0]
    ?? engine;
}

function engineBehaviorFor(
  classification: DiffClassification,
  engine: EngineId,
): { readOnly: false; requiresFixture: boolean; requiresFault: boolean } {
  const paths = classification.files
    .filter((file) => !file.engines.length || file.engines.includes(engine))
    .map((file) => file.path)
    .join("\n");
  const requiresFault = /(^|[/_.-])(?:sentinel|failover|patroni|active[_-]?active|pgactive|dr[_-]?lifecycle)([/_.-]|$)/i.test(paths);
  const requiresFixture = requiresFault
    || /(^|[/_.-])(?:apply|backup|restore|recovery|migration|migrate|seed|schema)([/_.-]|$)/i.test(paths);
  return { readOnly: false, requiresFixture, requiresFault };
}

function riskFor(categories: readonly ChangeCategory[], status: ChangedFile["status"]): number {
  const weights: Record<ChangeCategory, number> = { docs: 0, tests: 1, runtime: 3, schema: 5, config: 2, security: 6, build: 2, unknown: 2 };
  return categories.reduce((total, category) => total + weights[category], status === "deleted" ? 2 : 0);
}

function rejectFreeFormExecution(value: unknown, label: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectFreeFormExecution(item, `${label}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) {
    if (typeof value === "string" && (/\n|\r/.test(value) || /^(?:sudo|sh\s+-c|bash\s+-c|\/bin\/)/i.test(value))) {
      throw new Error(`${label} contains free-form execution text.`);
    }
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_OPERATION_KEYS.test(key)) throw new Error(`${label} contains forbidden execution key ${key}.`);
    rejectFreeFormExecution(item, `${label}.${key}`);
  }
}

function dedupeOperations(operations: readonly TypedOperation[]): TypedOperation[] {
  return [...new Map(operations.map((operation) => [operation.id, operation])).values()].sort((left, right) => {
    const stateOrder = stateIndex(left.state) - stateIndex(right.state);
    return stateOrder || left.id.localeCompare(right.id);
  });
}

function dedupeScenarios(scenarios: readonly QaScenario[]): QaScenario[] {
  return [...new Map(scenarios.map((scenario) => [scenario.id, scenario])).values()].sort((left, right) => left.id.localeCompare(right.id));
}

function stateIndex(state: QaState): number {
  const order: readonly QaState[] = ["SOURCE_LOCK", "DIFF", "TOPOLOGY", "BEFORE_SNAPSHOT", "GATE", "SEED", "FAULT", "OBSERVE", "COMMAND_MATRIX", "DATA_VERIFY", "RESTORE", "POST_PROOF", "REPORT"];
  return order.indexOf(state);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
