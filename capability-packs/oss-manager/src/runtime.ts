import { POLICY_ROLE_IDS, QA_STATES } from "./types.js";
import type {
  EvidenceReceipt,
  MutationLedgerEntry,
  PolicyRoleId,
  QaAssertion,
  QaPlan,
  QaRun,
  QaState,
  QaVerdict,
  StateResult,
  TypedOperation,
} from "./types.js";
import { normalizeLock, validateTypedOperation } from "./planner.js";
import { asRecord, isoTimestamp, optionalString, redactExcerpt, requiredString, sha256, shortDigest, uniqueSorted } from "./utils.js";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/i;
const PROBE_REQUIRED = new Set<QaState>(["TOPOLOGY", "BEFORE_SNAPSHOT", "SEED", "FAULT", "OBSERVE", "COMMAND_MATRIX", "DATA_VERIFY", "RESTORE", "POST_PROOF"]);
const NOT_APPLICABLE_FORBIDDEN = new Set<QaState>(["SOURCE_LOCK", "DIFF", "REPORT"]);

const REQUIRED_RECEIPT_KIND: Readonly<Record<QaState, EvidenceReceipt["kind"]>> = {
  SOURCE_LOCK: "source",
  DIFF: "diff",
  TOPOLOGY: "topology",
  BEFORE_SNAPSHOT: "snapshot",
  GATE: "gate",
  SEED: "command",
  FAULT: "command",
  OBSERVE: "probe",
  COMMAND_MATRIX: "command",
  DATA_VERIFY: "data_digest",
  RESTORE: "restore",
  POST_PROOF: "proof",
  REPORT: "report",
};

const PROGRESS_COPY: Readonly<Record<QaState, string>> = {
  SOURCE_LOCK: "Locking source",
  DIFF: "Classifying change",
  TOPOLOGY: "Discovering topology",
  BEFORE_SNAPSHOT: "Capturing baseline",
  GATE: "Checking safety gate",
  SEED: "Seeding test data",
  FAULT: "Applying controlled fault",
  OBSERVE: "Observing behavior",
  COMMAND_MATRIX: "Running command matrix",
  DATA_VERIFY: "Verifying every test record",
  RESTORE: "Restoring original state",
  POST_PROOF: "Checking post-state",
  REPORT: "Preparing evidence report",
};

export function createRunFromArgs(args: Record<string, unknown>): QaRun {
  const lock = normalizeLock(args.lock);
  const plan = normalizePlan(args.plan, lock.lockDigest, lock.headSha);
  const startedAt = isoTimestamp(args.startedAt, "startedAt", new Date().toISOString());
  const runId = optionalString(args.runId) ?? `qa-run-${shortDigest({ planId: plan.planId, startedAt })}`;
  return {
    schemaVersion: 1,
    runId,
    profileId: plan.profileId,
    lock,
    plan,
    currentState: "SOURCE_LOCK",
    status: "RUNNING",
    startedAt,
    stateResults: [],
    evidence: [],
    mutationLedger: [],
    failureOrigins: [],
    recovery: { requested: false, pendingOperationIds: [] },
  };
}

export function registerCompensationFromArgs(args: Record<string, unknown>): QaRun {
  const run = normalizeRun(args.run);
  assertRunning(run);
  const operationId = requiredString(args.operationId, "operationId");
  const operation = findOperation(run, operationId);
  if (!operation.mutating || !operation.compensation) throw new Error(`Operation ${operationId} is not a compensated mutation.`);
  if (operation.state !== run.currentState) throw new Error(`Operation ${operationId} belongs to ${operation.state}, not current state ${run.currentState}.`);
  if (run.mutationLedger.some((entry) => entry.operationId === operationId)) throw new Error(`Compensation for ${operationId} is already registered.`);
  const registeredAt = isoTimestamp(args.registeredAt, "registeredAt", new Date().toISOString());
  const entry: MutationLedgerEntry = {
    operationId,
    compensation: operation.compensation,
    registeredAt,
    status: "REGISTERED",
    receiptIds: [],
  };
  return { ...run, mutationLedger: [...run.mutationLedger, entry] };
}

export function recordMutationFromArgs(args: Record<string, unknown>): QaRun {
  const run = normalizeRun(args.run);
  assertRunning(run);
  const operationId = requiredString(args.operationId, "operationId");
  const event = requiredString(args.event, "event");
  if (!["dispatching", "applied", "restored", "restore_failed"].includes(event)) {
    throw new Error("event must be dispatching, applied, restored, or restore_failed.");
  }
  const operation = findOperation(run, operationId);
  const ledger = run.mutationLedger.find((entry) => entry.operationId === operationId);
  if (!ledger) throw new Error(`Mutation ${operationId} cannot run before its compensation is registered.`);
  if (event === "dispatching") {
    if (run.currentState !== operation.state) throw new Error(`Mutation ${operationId} cannot dispatch during ${run.currentState}.`);
    if (ledger.status !== "REGISTERED") throw new Error(`Mutation ${operationId} is ${ledger.status}, not REGISTERED.`);
    const dispatchingAt = isoTimestamp(args.recordedAt, "recordedAt", new Date().toISOString());
    if (Date.parse(dispatchingAt) < Date.parse(ledger.registeredAt)) throw new Error(`Mutation ${operationId} dispatch journal predates compensation registration.`);
    return {
      ...run,
      mutationLedger: run.mutationLedger.map((entry) => entry.operationId === operationId
        ? { ...entry, status: "DISPATCHING", dispatchingAt }
        : entry),
    };
  }
  const expectedState = event === "applied" ? operation.state : "RESTORE";
  if (event === "applied" && run.currentState !== operation.state) throw new Error(`Mutation ${operationId} cannot apply during ${run.currentState}.`);
  if (event !== "applied" && run.currentState !== "RESTORE") throw new Error(`Compensation ${operationId} can execute only during RESTORE.`);
  const receipt = normalizeReceipt(args.receipt, expectedState);
  if (receipt.operationId !== operationId) throw new Error(`Mutation receipt ${receipt.id} must identify operation ${operationId}.`);
  const expectedProducer = event === "applied" ? operation.role : "recovery-controller";
  if (receipt.producerRole !== expectedProducer) throw new Error(`Mutation receipt ${receipt.id} must be produced by ${expectedProducer}.`);
  if (event === "applied" && receipt.kind !== "command") throw new Error(`Applied mutation ${operationId} requires a command receipt.`);
  if (event !== "applied" && receipt.kind !== "restore") throw new Error(`Compensation ${operationId} requires a restore receipt.`);
  if (receipt.sourceSha !== run.lock.headSha) throw new Error(`Mutation receipt ${receipt.id} uses ${receipt.sourceSha}, expected locked SHA ${run.lock.headSha}.`);
  if (run.evidence.some((item) => item.id === receipt.id)) throw new Error(`Evidence receipt ${receipt.id} already exists.`);

  const at = receipt.observedAt;
  if (Date.parse(at) < Date.parse(ledger.registeredAt)) throw new Error(`Mutation receipt ${receipt.id} predates compensation registration.`);
  if (event !== "applied" && ledger.appliedAt && Date.parse(at) < Date.parse(ledger.appliedAt)) throw new Error(`Recovery receipt ${receipt.id} predates mutation application.`);
  const mutationLedger = run.mutationLedger.map((entry): MutationLedgerEntry => {
    if (entry.operationId !== operationId) return entry;
    if (event === "applied") {
      if (entry.status !== "DISPATCHING") throw new Error(`Mutation ${operationId} is ${entry.status}, not DISPATCHING.`);
      return { ...entry, status: "APPLIED", appliedAt: at, receiptIds: [...entry.receiptIds, receipt.id] };
    }
    if (entry.status !== "DISPATCHING" && entry.status !== "APPLIED") {
      throw new Error(`Compensation ${operationId} requires DISPATCHING or APPLIED state, got ${entry.status}.`);
    }
    if (event === "restored") return { ...entry, status: "RESTORED", restoredAt: at, receiptIds: [...entry.receiptIds, receipt.id] };
    return {
      ...entry,
      status: "RESTORE_FAILED",
      restoredAt: at,
      receiptIds: [...entry.receiptIds, receipt.id],
      failure: optionalString(args.failure) ?? "Typed recovery operation failed.",
    };
  });
  return { ...run, mutationLedger, evidence: [...run.evidence, receipt] };
}

export function recordStateFromArgs(args: Record<string, unknown>): QaRun {
  const run = normalizeRun(args.run);
  assertRunning(run);
  const requestedState = optionalString(args.state);
  if (requestedState && requestedState !== run.currentState) throw new Error(`Cannot record ${requestedState}; current state is ${run.currentState}.`);
  const state = run.currentState;
  const completedAt = isoTimestamp(args.completedAt, "completedAt", new Date().toISOString());
  const notApplicableReason = optionalString(args.notApplicableReason);
  const newReceipts = normalizeReceiptArray(args.receipts, state);
  assertUniqueEvidence(run.evidence, newReceipts);
  const stateReceipts = [...run.evidence.filter((receipt) => receipt.state === state), ...newReceipts];
  const assertions = normalizeAssertions(args.assertions, "assertions");
  const probes = normalizeAssertions(args.probes, "probes");
  const evaluated = evaluateState(run, state, stateReceipts, assertions, probes, notApplicableReason);
  const result: StateResult = {
    state,
    verdict: evaluated.verdict,
    receiptIds: stateReceipts.map((receipt) => receipt.id),
    assertionIds: assertions.map((assertion) => assertion.id),
    probeIds: probes.map((probe) => probe.id),
    reason: evaluated.reason,
    completedAt,
  };
  const stateResults = [...run.stateResults, result];
  const failureOrigins = ["FAIL", "INCONCLUSIVE", "RESTORE_FAILED"].includes(result.verdict)
    ? [...run.failureOrigins, { state, verdict: result.verdict, reason: result.reason }]
    : run.failureOrigins;
  const evidence = [...run.evidence, ...newReceipts];

  if (state === "REPORT") {
    return {
      ...run,
      stateResults,
      failureOrigins,
      evidence,
      status: finalVerdict(stateResults, run.mutationLedger),
      finishedAt: completedAt,
      recovery: { ...run.recovery, pendingOperationIds: pendingRestores(run.mutationLedger).map((entry) => entry.operationId) },
    };
  }

  const currentState = nextState(run, result);
  return {
    ...run,
    currentState,
    stateResults,
    failureOrigins,
    evidence,
    recovery: {
      ...run.recovery,
      pendingOperationIds: pendingRestores(run.mutationLedger).map((entry) => entry.operationId),
    },
  };
}

export function recoverRunFromArgs(args: Record<string, unknown>): { run: QaRun; recoveryOperations: readonly { operationId: string; compensation: MutationLedgerEntry["compensation"] }[] } {
  const run = normalizeRun(args.run);
  if (run.status !== "RUNNING") throw new Error(`Cannot recover completed run ${run.runId} (${run.status}).`);
  const recoveredAt = isoTimestamp(args.recoveredAt, "recoveredAt", new Date().toISOString());
  const pending = pendingRestores(run.mutationLedger);
  const reason = optionalString(args.reason) ?? `Run heartbeat was lost; recovery controller claimed the finally path at ${recoveredAt}.`;
  const recovered: QaRun = {
    ...run,
    currentState: pending.length ? "RESTORE" : run.currentState,
    recovery: { requested: true, reason, pendingOperationIds: pending.map((entry) => entry.operationId) },
  };
  return {
    run: recovered,
    recoveryOperations: pending.map((entry) => ({ operationId: entry.operationId, compensation: entry.compensation })),
  };
}

export function renderProgressFromArgs(args: Record<string, unknown>): { text: string; state: QaState; step: number; total: number } {
  const run = normalizeRun(args.run);
  const state = run.currentState;
  const step = QA_STATES.indexOf(state) + 1;
  const detail = optionalString(args.detail);
  const suffix = detail ? ` · ${detail.slice(0, 72)}` : "";
  return { text: `[${step}/${QA_STATES.length}] ${PROGRESS_COPY[state]}${suffix}`, state, step, total: QA_STATES.length };
}

export function nextDispatchFromArgs(args: Record<string, unknown>): Record<string, unknown> {
  const run = normalizeRun(args.run);
  assertRunning(run);
  if (run.currentState === "RESTORE") {
    const pending = pendingRestores(run.mutationLedger);
    return {
      state: "RESTORE",
      role: "recovery-controller",
      dispatchable: pending.map((entry) => ({
        operationId: entry.operationId,
        operation: entry.compensation,
        reason: "registered_compensation_finally_path",
      })),
      blocked: [],
    };
  }
  const operations = run.plan.operations.filter((operation) => operation.state === run.currentState);
  const dispatchable: TypedOperation[] = [];
  const blocked: Array<{ operationId?: string; useCaseId?: string; reason: string }> = [];
  for (const operation of operations) {
    if (!operation.mutating) {
      dispatchable.push(operation);
      continue;
    }
    const ledger = run.mutationLedger.find((entry) => entry.operationId === operation.id);
    if (!ledger) blocked.push({ operationId: operation.id, reason: "register_compensation_before_dispatch" });
    else if (ledger.status === "REGISTERED") blocked.push({ operationId: operation.id, reason: "record_dispatching_before_side_effect" });
    else if (ledger.status === "DISPATCHING") dispatchable.push(operation);
    else blocked.push({ operationId: operation.id, reason: `mutation_${ledger.status.toLowerCase()}` });
  }
  if (run.currentState === "COMMAND_MATRIX") {
    for (const useCase of run.plan.useCases.selected.filter((item) => item.risk === "mutation_gated")) {
      blocked.push({
        useCaseId: useCase.selectionId,
        reason: "bind_reviewed_typed_adapter_and_exact_compensation_before_dispatch",
      });
    }
  }
  return {
    state: run.currentState,
    role: operations[0]?.executorRole ?? null,
    dispatchable,
    blocked,
    completeStateWithoutDispatch: operations.length === 0,
  };
}

export function buildReportFromArgs(args: Record<string, unknown>): Record<string, unknown> {
  const run = normalizeRun(args.run);
  const verdict = run.status === "RUNNING" ? finalVerdict(run.stateResults, run.mutationLedger) : run.status;
  const stateCounts = Object.fromEntries(
    (["PASS", "FAIL", "INCONCLUSIVE", "NOT_APPLICABLE", "RESTORE_FAILED"] as const).map((status) => [status, run.stateResults.filter((result) => result.verdict === status).length]),
  );
  const pending = pendingRestores(run.mutationLedger);
  return {
    runId: run.runId,
    profileId: run.profileId,
    sourceSha: run.lock.headSha,
    verdict,
    summary: summaryFor(verdict, run, pending.length),
    stateCounts,
    useCases: {
      catalogVersion: run.plan.useCases.catalogVersion,
      catalogDigest: run.plan.useCases.catalogDigest,
      selected: run.plan.useCases.selected.length,
      readOnly: run.plan.useCases.readOnlyCount,
      gated: run.plan.useCases.gatedCount,
      families: uniqueSorted(run.plan.useCases.selected.map((item) => item.family)),
      items: run.plan.useCases.selected.map((item) => ({
        selectionId: item.selectionId,
        targetEngine: item.targetEngine,
        suite: item.suite,
        family: item.family,
        selection: item.selection,
        risk: item.risk,
        dispatch: item.dispatch,
      })),
    },
    scenarios: run.plan.scenarios.map((scenario) => ({
      id: scenario.id,
      title: scenario.title,
      selection: scenario.selection,
      engine: scenario.engine,
      useCaseIds: scenario.useCaseIds,
    })),
    restoration: {
      registered: run.mutationLedger.length,
      restored: run.mutationLedger.filter((entry) => entry.status === "RESTORED").length,
      failed: run.mutationLedger.filter((entry) => entry.status === "RESTORE_FAILED").length,
      pending: pending.map((entry) => entry.operationId),
    },
    failures: run.failureOrigins,
    evidence: run.evidence.map((receipt) => ({
      id: receipt.id,
      state: receipt.state,
      kind: receipt.kind,
      operationId: receipt.operationId,
      subject: receipt.subject,
      payloadDigest: receipt.payloadDigest,
      evidenceRef: receipt.evidenceRef,
      redactedExcerpt: receipt.redactedExcerpt,
    })),
    tokenPolicy: run.plan.tokenPolicy,
  };
}

export function normalizeRun(value: unknown): QaRun {
  const run = asRecord(value, "run") as unknown as QaRun;
  if (run.schemaVersion !== 1) throw new Error("run.schemaVersion must be 1.");
  if (!QA_STATES.includes(run.currentState)) throw new Error("run.currentState is invalid.");
  if (!Array.isArray(run.stateResults) || !Array.isArray(run.evidence) || !Array.isArray(run.mutationLedger)) throw new Error("run is missing state, evidence, or mutation ledgers.");
  const lock = normalizeLock(run.lock);
  const plan = normalizePlan(run.plan, lock.lockDigest, lock.headSha);
  return { ...run, lock, plan };
}

function evaluateState(
  run: QaRun,
  state: QaState,
  receipts: readonly EvidenceReceipt[],
  assertions: readonly QaAssertion[],
  probes: readonly QaAssertion[],
  notApplicableReason?: string,
): { verdict: QaVerdict; reason: string } {
  if (notApplicableReason) {
    if (NOT_APPLICABLE_FORBIDDEN.has(state)) return { verdict: "FAIL", reason: `${state} cannot be marked not applicable.` };
    if (run.plan.operations.some((operation) => operation.state === state)) {
      return inconclusiveFor(state, `${state} has compiled operations and cannot be skipped as not applicable.`);
    }
    if (state === "RESTORE" && pendingRestores(run.mutationLedger).length) return { verdict: "RESTORE_FAILED", reason: "RESTORE cannot be skipped while applied mutations remain." };
    return { verdict: "NOT_APPLICABLE", reason: notApplicableReason };
  }
  const wrongSha = receipts.find((receipt) => receipt.sourceSha !== run.lock.headSha);
  if (wrongSha) return failureFor(state, `Receipt ${wrongSha.id} uses source ${wrongSha.sourceSha}; locked SHA is ${run.lock.headSha}.`);
  const requiredKind = REQUIRED_RECEIPT_KIND[state];
  if (!receipts.some((receipt) => receipt.kind === requiredKind)) return inconclusiveFor(state, `Missing required ${requiredKind} receipt.`);
  const plannedOperations = run.plan.operations.filter((operation) => operation.state === state);
  const expectedOperationIds = state === "RESTORE"
    ? run.mutationLedger.filter((entry) => entry.appliedAt).map((entry) => entry.operationId)
    : plannedOperations.map((operation) => operation.id);
  const unknownOperationReceipt = receipts.find((receipt) => receipt.operationId && !expectedOperationIds.includes(receipt.operationId));
  if (unknownOperationReceipt) return failureFor(state, `Receipt ${unknownOperationReceipt.id} references unplanned operation ${unknownOperationReceipt.operationId}.`);
  const missingOperationId = expectedOperationIds.find((operationId) => !receipts.some((receipt) => receipt.operationId === operationId));
  if (missingOperationId) return inconclusiveFor(state, `Operation ${missingOperationId} has no evidence receipt.`);
  const unappliedMutation = plannedOperations.find((operation) => operation.mutating && run.mutationLedger.find((entry) => entry.operationId === operation.id)?.status !== "APPLIED");
  if (unappliedMutation) return inconclusiveFor(state, `Mutation ${unappliedMutation.id} is not APPLIED through the compensation ledger.`);
  if (!assertions.length) return inconclusiveFor(state, "Exit status and receipts alone cannot pass; a semantic assertion is required.");
  const receiptIds = new Set(receipts.map((receipt) => receipt.id));
  const missingAssertionEvidence = [...assertions, ...probes].find((assertion) => !assertion.evidenceIds.length || assertion.evidenceIds.some((id) => !receiptIds.has(id)));
  if (missingAssertionEvidence) return inconclusiveFor(state, `Assertion ${missingAssertionEvidence.id} lacks valid state evidence.`);
  const failedAssertion = assertions.find((assertion) => !assertion.passed);
  if (failedAssertion) return failureFor(state, `${failedAssertion.subject}: expected ${failedAssertion.expected}; observed ${failedAssertion.actual}.`);
  const unassertedOperationId = expectedOperationIds.find((operationId) => {
    const operationReceiptIds = receipts.filter((receipt) => receipt.operationId === operationId).map((receipt) => receipt.id);
    return !operationReceiptIds.some((receiptId) => assertions.some((assertion) => assertion.evidenceIds.includes(receiptId)));
  });
  if (unassertedOperationId) return inconclusiveFor(state, `Operation ${unassertedOperationId} has no semantic assertion.`);
  if (PROBE_REQUIRED.has(state)) {
    if (!probes.length) return inconclusiveFor(state, "Independent probe evidence is required for this state.");
    const invalidProbe = probes.find((probe) => !["invariant-auditor", "recovery-controller"].includes(probe.producerRole));
    if (invalidProbe) return inconclusiveFor(state, `Probe ${invalidProbe.id} was not produced by an independent auditor or recovery controller.`);
    const semanticEvidence = new Set(assertions.flatMap((assertion) => assertion.evidenceIds));
    const independent = probes.some((probe) => probe.evidenceIds.some((id) => !semanticEvidence.has(id)));
    if (!independent) return inconclusiveFor(state, "Probe must reference evidence independent of the semantic assertion receipt.");
    const unprobedOperationId = expectedOperationIds.find((operationId) => {
      const probeReceiptIds = receipts.filter((receipt) => receipt.operationId === operationId && receipt.kind === "probe").map((receipt) => receipt.id);
      return !probeReceiptIds.some((receiptId) => probes.some((probe) => probe.evidenceIds.includes(receiptId)));
    });
    if (unprobedOperationId) return inconclusiveFor(state, `Operation ${unprobedOperationId} has no independent probe.`);
    const failedProbe = probes.find((probe) => !probe.passed);
    if (failedProbe) return failureFor(state, `Independent probe failed: ${failedProbe.subject}.`);
  }
  if (receipts.some((receipt) => receipt.kind === "negative_control") && !assertions.some((assertion) => assertion.subject.toLowerCase().includes("negative control") && assertion.passed)) {
    return failureFor(state, "Negative control was not detected by a passing semantic assertion.");
  }
  if (state === "RESTORE") {
    if (run.mutationLedger.some((entry) => entry.status === "RESTORE_FAILED")) return { verdict: "RESTORE_FAILED", reason: "At least one registered compensation failed." };
    if (pendingRestores(run.mutationLedger).length) return { verdict: "INCONCLUSIVE", reason: "Applied mutations remain without verified compensation receipts." };
  }
  return { verdict: "PASS", reason: `${state} satisfied semantic and evidence requirements.` };
}

function nextState(run: QaRun, result: StateResult): QaState {
  if (result.state === "RESTORE") return result.verdict === "PASS" || result.verdict === "NOT_APPLICABLE" ? "POST_PROOF" : "REPORT";
  if (result.verdict === "FAIL" || result.verdict === "INCONCLUSIVE" || result.verdict === "RESTORE_FAILED") {
    return pendingRestores(run.mutationLedger).length ? "RESTORE" : "REPORT";
  }
  const index = QA_STATES.indexOf(result.state);
  return QA_STATES[Math.min(index + 1, QA_STATES.length - 1)];
}

function failureFor(state: QaState, reason: string): { verdict: QaVerdict; reason: string } {
  return { verdict: state === "RESTORE" ? "RESTORE_FAILED" : "FAIL", reason };
}

function inconclusiveFor(state: QaState, reason: string): { verdict: QaVerdict; reason: string } {
  return { verdict: state === "RESTORE" ? "RESTORE_FAILED" : "INCONCLUSIVE", reason };
}

function finalVerdict(results: readonly StateResult[], ledger: readonly MutationLedgerEntry[]): QaVerdict {
  if (ledger.some((entry) => entry.status === "RESTORE_FAILED") || results.some((result) => result.verdict === "RESTORE_FAILED")) return "RESTORE_FAILED";
  if (pendingRestores(ledger).length) return "RESTORE_FAILED";
  if (results.some((result) => result.verdict === "FAIL")) return "FAIL";
  if (results.some((result) => result.verdict === "INCONCLUSIVE")) return "INCONCLUSIVE";
  if (results.length && results.every((result) => result.verdict === "NOT_APPLICABLE")) return "NOT_APPLICABLE";
  return "PASS";
}

function pendingRestores(ledger: readonly MutationLedgerEntry[]): MutationLedgerEntry[] {
  return ledger.filter((entry) => entry.status === "DISPATCHING" || entry.status === "APPLIED" || entry.status === "RESTORE_FAILED").slice().reverse();
}

function normalizePlan(value: unknown, lockDigest: string, sourceSha: string): QaPlan {
  const plan = asRecord(value, "plan") as unknown as QaPlan;
  if (plan.lockDigest !== lockDigest || plan.sourceSha !== sourceSha) throw new Error("Plan does not match the supplied source lock.");
  if (!Array.isArray(plan.operations) || !Array.isArray(plan.scenarios) || !plan.useCases || !Array.isArray(plan.useCases.selected)) {
    throw new Error("Plan is missing operations, scenarios, or use-case contracts.");
  }
  const expectedDigest = sha256({
    profileId: plan.profileId,
    lockDigest: plan.lockDigest,
    sourceSha: plan.sourceSha,
    useCases: plan.useCases,
    scenarios: plan.scenarios,
    operations: plan.operations,
    mutationCount: plan.mutationCount,
    tokenPolicy: plan.tokenPolicy,
  });
  if (plan.planDigest !== expectedDigest || plan.planId !== `qa-plan-${shortDigest({
    profileId: plan.profileId,
    lockDigest: plan.lockDigest,
    sourceSha: plan.sourceSha,
    useCases: plan.useCases,
    scenarios: plan.scenarios,
    operations: plan.operations,
    mutationCount: plan.mutationCount,
    tokenPolicy: plan.tokenPolicy,
  })}`) throw new Error("Plan digest or id does not match its deterministic content.");
  plan.operations.forEach(validateTypedOperation);
  return plan;
}

function normalizeReceiptArray(value: unknown, state: QaState): EvidenceReceipt[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("receipts must be an array.");
  return value.map((item) => normalizeReceipt(item, state));
}

function normalizeReceipt(value: unknown, state: QaState): EvidenceReceipt {
  const receipt = asRecord(value, "receipt");
  const receiptState = requiredString(receipt.state, "receipt.state") as QaState;
  if (receiptState !== state) throw new Error(`Receipt state ${receiptState} does not match ${state}.`);
  const kind = requiredString(receipt.kind, "receipt.kind") as EvidenceReceipt["kind"];
  if (!Object.values(REQUIRED_RECEIPT_KIND).includes(kind) && kind !== "negative_control") throw new Error(`Unknown evidence kind ${kind}.`);
  const producerRole = normalizeRole(receipt.producerRole, "receipt.producerRole");
  const payloadDigest = requiredString(receipt.payloadDigest, "receipt.payloadDigest");
  if (!DIGEST_PATTERN.test(payloadDigest)) throw new Error("receipt.payloadDigest must be sha256:<64 hex>.");
  const exitCode = receipt.exitCode;
  if (exitCode !== undefined && (typeof exitCode !== "number" || !Number.isInteger(exitCode))) throw new Error("receipt.exitCode must be an integer.");
  const evidenceRef = optionalString(receipt.evidenceRef);
  if (evidenceRef && !/^(?:artifact|evidence):\/\/[A-Za-z0-9._:/-]{1,400}$/.test(evidenceRef)) {
    throw new Error("receipt.evidenceRef must be an opaque artifact:// or evidence:// reference.");
  }
  return {
    id: requiredString(receipt.id, "receipt.id"),
    state,
    kind,
    operationId: optionalString(receipt.operationId),
    producerRole,
    subject: requiredString(receipt.subject, "receipt.subject"),
    observedAt: isoTimestamp(receipt.observedAt, "receipt.observedAt"),
    sourceSha: requiredString(receipt.sourceSha, "receipt.sourceSha").toLowerCase(),
    payloadDigest,
    evidenceRef,
    redactedExcerpt: redactExcerpt(receipt.redactedExcerpt),
    exitCode,
  };
}

function normalizeAssertions(value: unknown, label: string): QaAssertion[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value.map((item, index) => {
    const assertion = asRecord(item, `${label}[${index}]`);
    if (typeof assertion.passed !== "boolean") throw new Error(`${label}[${index}].passed must be boolean.`);
    if (!Array.isArray(assertion.evidenceIds) || !assertion.evidenceIds.every((id) => typeof id === "string" && id.trim())) {
      throw new Error(`${label}[${index}].evidenceIds must contain receipt IDs.`);
    }
    return {
      id: requiredString(assertion.id, `${label}[${index}].id`),
      subject: requiredString(assertion.subject, `${label}[${index}].subject`),
      passed: assertion.passed,
      evidenceIds: uniqueSorted(assertion.evidenceIds as string[]),
      expected: requiredString(assertion.expected, `${label}[${index}].expected`),
      actual: requiredString(assertion.actual, `${label}[${index}].actual`),
      producerRole: normalizeRole(assertion.producerRole, `${label}[${index}].producerRole`),
    };
  });
}

function normalizeRole(value: unknown, label: string): PolicyRoleId {
  const role = requiredString(value, label) as PolicyRoleId;
  if (!POLICY_ROLE_IDS.includes(role)) throw new Error(`${label} is not a policy role.`);
  return role;
}

function findOperation(run: QaRun, operationId: string): TypedOperation {
  const operation = run.plan.operations.find((candidate) => candidate.id === operationId);
  if (!operation) throw new Error(`Operation ${operationId} is not in locked plan ${run.plan.planId}.`);
  return operation;
}

function assertRunning(run: QaRun): void {
  if (run.status !== "RUNNING") throw new Error(`Run ${run.runId} is already complete with ${run.status}.`);
}

function assertUniqueEvidence(existing: readonly EvidenceReceipt[], incoming: readonly EvidenceReceipt[]): void {
  const ids = new Set(existing.map((receipt) => receipt.id));
  for (const receipt of incoming) {
    if (ids.has(receipt.id)) throw new Error(`Evidence receipt ${receipt.id} already exists.`);
    ids.add(receipt.id);
  }
}

function summaryFor(verdict: QaVerdict, run: QaRun, pending: number): string {
  if (verdict === "PASS") return `${run.plan.scenarios.length} scenario(s) passed with semantic evidence and verified restoration.`;
  if (verdict === "RESTORE_FAILED") return `Recovery is not complete; ${pending} mutation(s) still require operator attention.`;
  if (verdict === "FAIL") return `${run.failureOrigins.length} verified failure(s) were found; see raw evidence receipts.`;
  if (verdict === "INCONCLUSIVE") return "The run did not collect enough independent evidence to certify a result.";
  return "No selected scenario applied to this locked change.";
}

export function evidenceDigest(value: unknown): string {
  return sha256(value);
}
