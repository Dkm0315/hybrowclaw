import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HYBROWLABS_SUITE_CATALOG,
  oss_qa_compensation_register,
  oss_qa_diff_classify,
  oss_qa_executor_next,
  oss_qa_mutation_record,
  oss_qa_operation_validate,
  oss_qa_report_build,
  oss_qa_run_create,
  oss_qa_run_recover,
  oss_qa_scenario_compile,
  oss_qa_source_lock,
  oss_qa_state_record,
  oss_qa_suite_catalog,
  oss_qa_suite_manifest_validate,
  oss_qa_use_case_select,
  type EvidenceReceipt,
  type QaAssertion,
  type QaPlan,
  type QaRun,
  type QaState,
  type SourceLock,
  type TypedOperation,
} from "../src/index.js";

const BASE_SHA = "1".repeat(40);
const HEAD_SHA = "2".repeat(40);
const WRONG_SHA = "3".repeat(40);
const NOW = "2026-07-10T12:00:00.000Z";
const DIGEST = `sha256:${"a".repeat(64)}`;

const REQUIRED_KIND: Record<QaState, EvidenceReceipt["kind"]> = {
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

const CRITICAL = new Set<QaState>(["TOPOLOGY", "BEFORE_SNAPSHOT", "SEED", "FAULT", "OBSERVE", "COMMAND_MATRIX", "DATA_VERIFY", "RESTORE", "POST_PROOF"]);

let sequence = 0;

async function fixture(path = "sentinel/failover.ts", profileId = "generic-oss-qa") {
  const lock = await oss_qa_source_lock({
    repository: "https://example.test/customer/app",
    branch: "dev",
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    lockedAt: NOW,
  });
  const classification = await oss_qa_diff_classify({
    lock,
    profileId,
    changes: [{ path, status: "modified", additions: 12, deletions: 3 }],
  });
  const plan = await oss_qa_scenario_compile({ lock, classification, profileId });
  const run = await oss_qa_run_create({ lock, plan, startedAt: NOW });
  return { lock, classification, plan, run };
}

function receipt(
  run: QaRun,
  state: QaState,
  kind: EvidenceReceipt["kind"],
  options: { operationId?: string; sourceSha?: string; producerRole?: EvidenceReceipt["producerRole"]; exitCode?: number; suffix?: string } = {},
): EvidenceReceipt {
  const suffix = options.suffix ?? String(++sequence);
  return {
    id: `receipt-${state.toLowerCase()}-${suffix}`,
    state,
    kind,
    operationId: options.operationId,
    producerRole: options.producerRole ?? producerFor(state),
    subject: options.operationId ?? state.toLowerCase(),
    observedAt: NOW,
    sourceSha: options.sourceSha ?? run.lock.headSha,
    payloadDigest: DIGEST,
    evidenceRef: `artifact://qa/${run.runId}/${state.toLowerCase()}/${suffix}`,
    redactedExcerpt: "verified fixture output",
    exitCode: options.exitCode,
  };
}

function assertion(id: string, evidenceId: string, passed = true, subject = "semantic invariant"): QaAssertion {
  return {
    id,
    subject,
    passed,
    evidenceIds: [evidenceId],
    expected: "expected invariant",
    actual: passed ? "expected invariant" : "mismatched value",
    producerRole: "invariant-auditor",
  };
}

async function passState(run: QaRun): Promise<QaRun> {
  const state = run.currentState;
  const operations = run.plan.operations.filter((operation) => operation.state === state);
  const newReceipts: EvidenceReceipt[] = [];
  const assertions: QaAssertion[] = [];
  const probes: QaAssertion[] = [];
  const subjects: Array<{ operationId?: string; primaryId: string }> = [];

  if (!operations.length) {
    const primary = receipt(run, state, REQUIRED_KIND[state]);
    newReceipts.push(primary);
    subjects.push({ primaryId: primary.id });
  } else {
    for (const operation of operations) {
      const existing = run.evidence.find((item) => item.state === state && item.operationId === operation.id && item.producerRole !== "invariant-auditor");
      if (existing) subjects.push({ operationId: operation.id, primaryId: existing.id });
      else {
        const primary = receipt(run, state, REQUIRED_KIND[state], { operationId: operation.id });
        newReceipts.push(primary);
        subjects.push({ operationId: operation.id, primaryId: primary.id });
      }
    }
  }

  for (const subject of subjects) {
    assertions.push(assertion(`assert-${state}-${subject.operationId ?? "state"}`, subject.primaryId));
    if (CRITICAL.has(state)) {
      const probeReceipt = receipt(run, state, "probe", {
        operationId: subject.operationId,
        producerRole: state === "RESTORE" ? "recovery-controller" : "invariant-auditor",
        suffix: `probe-${subject.operationId ?? "state"}`,
      });
      newReceipts.push(probeReceipt);
      probes.push(assertion(`probe-${state}-${subject.operationId ?? "state"}`, probeReceipt.id, true, "independent probe"));
    }
  }
  return oss_qa_state_record({ run, receipts: newReceipts, assertions, probes, completedAt: NOW });
}

async function markNotApplicable(run: QaRun, reason = "No operation is selected for this locked change."): Promise<QaRun> {
  return oss_qa_state_record({ run, notApplicableReason: reason, completedAt: NOW });
}

async function advanceToSeed(run: QaRun): Promise<QaRun> {
  run = await passState(run); // source
  run = await passState(run); // diff
  run = await passState(run); // topology
  run = await passState(run); // before snapshot
  run = await passState(run); // gate
  assert.equal(run.currentState, "SEED");
  return run;
}

function producerFor(state: QaState): EvidenceReceipt["producerRole"] {
  if (state === "SOURCE_LOCK" || state === "DIFF" || state === "GATE") return "release-sentinel";
  if (state === "TOPOLOGY" || state === "BEFORE_SNAPSHOT" || state === "POST_PROOF") return "topology-surveyor";
  if (state === "RESTORE") return "recovery-controller";
  if (state === "REPORT") return "human-reporter";
  return "typed-executor";
}

function mutationReceipt(run: QaRun, operation: TypedOperation, state: "SEED" | "FAULT"): EvidenceReceipt {
  return receipt(run, state, "command", { operationId: operation.id, producerRole: "typed-executor" });
}

async function markDispatching(run: QaRun, operation: TypedOperation): Promise<QaRun> {
  return oss_qa_mutation_record({ run, operationId: operation.id, event: "dispatching", recordedAt: NOW });
}

test("source locks and diff classification are deterministic", async () => {
  const first = await fixture("apps/control/security/policy.ts");
  const second = await fixture("apps/control/security/policy.ts");
  assert.deepEqual(first.lock, second.lock);
  assert.deepEqual(first.classification, second.classification);
  assert.equal(first.classification.impact, "HIGH_RISK");
  assert.equal(first.classification.meaningful, true);
  assert.deepEqual(first.classification.files[0].categories, ["runtime", "security"]);
});

test("scenario compiler selects direct engine and bounded adjacent regressions", async () => {
  const { plan } = await fixture();
  assert.equal(plan.scenarios.some((scenario) => scenario.engine === "sentinel" && scenario.selection === "direct"), true);
  assert.equal(plan.scenarios.some((scenario) => scenario.selection === "adjacent"), true);
  assert.equal(plan.tokenPolicy.noModelShell, true);
  assert.equal(plan.tokenPolicy.modelUse, "bounded_diff_summary_only");
  assert.equal(plan.operations.some((operation) => operation.operationType === "observe.sentinel_failover"), true);
  assert.equal(plan.operations.filter((operation) => operation.mutating).every((operation) => operation.compensation), true);
  const fault = plan.operations.find((operation) => operation.state === "FAULT");
  assert.ok(fault?.compensation);
  assert.equal(fault.target.includes("current-primary"), false);
  assert.equal(fault.compensation.target, fault.target);
});

test("sanitized OSS Manager suite catalog covers all 138 source contracts without shell", async () => {
  const report = await oss_qa_suite_catalog({ profileId: "hybrowlabs-oss-manager" });
  assert.equal(report.count, 138);
  assert.equal(report.count, HYBROWLABS_SUITE_CATALOG.length);
  assert.equal(report.commandIdCount, 234);
  assert.equal(report.containsCommands, false);
  assert.equal(new Set(HYBROWLABS_SUITE_CATALOG.map((item) => item.id)).size, 138);
  assert.equal(HYBROWLABS_SUITE_CATALOG.some((item) => item.engine === "postgres" && item.suite === "active_active_validate"), true);
  assert.equal(HYBROWLABS_SUITE_CATALOG.some((item) => item.engine === "postgres" && item.suite === "migration_validate"), true);
  assert.equal(JSON.stringify(HYBROWLABS_SUITE_CATALOG).includes('"command"'), false);
});

test("source manifest metadata must match the reviewed suite catalog and rejects raw commands", async () => {
  const manifest = {
    sourceSha: HEAD_SHA,
    version: 2,
    suites: HYBROWLABS_SUITE_CATALOG.map((item) => ({
      engine: item.engine,
      suite: item.suite,
      configScope: item.scopes.join(","),
      safe: item.risk !== "mutation_gated",
      requiresAllowApply: item.risk === "mutation_gated",
      destructive: item.risk === "destructive_plan",
      commandIds: item.commandIds,
    })),
  };
  const exact = await oss_qa_suite_manifest_validate({ profileId: "hybrowlabs-oss-manager", manifest });
  assert.equal(exact.verdict, "PASS");
  assert.equal(exact.suiteCount, 138);
  assert.deepEqual(exact.drift, { missing: [], extra: [], mismatched: [] });

  const drifted = await oss_qa_suite_manifest_validate({
    profileId: "hybrowlabs-oss-manager",
    manifest: { ...manifest, suites: manifest.suites.slice(1) },
  });
  assert.equal(drifted.verdict, "INCONCLUSIVE");
  assert.equal(drifted.drift.missing.length, 1);

  const missingCommand = structuredClone(manifest);
  missingCommand.suites[0].commandIds = missingCommand.suites[0].commandIds.slice(1);
  const commandDrift = await oss_qa_suite_manifest_validate({ profileId: "hybrowlabs-oss-manager", manifest: missingCommand });
  assert.equal(commandDrift.verdict, "INCONCLUSIVE");
  assert.equal(commandDrift.drift.mismatched.length, 1);

  await assert.rejects(oss_qa_suite_manifest_validate({
    profileId: "hybrowlabs-oss-manager",
    manifest: {
      sourceSha: HEAD_SHA,
      version: 2,
      suites: [{ engine: "redis", suite: "status", configScope: "all", safe: true, commands: ["./ossmgr status"] }],
    },
  }), /forbidden raw execution field commands/);
});

test("real OSS Manager feature paths select deep direct and adjacent use cases", async () => {
  const lock = await oss_qa_source_lock({
    repository: "https://github.com/hybrowlabs/OSS-Manager",
    branch: "dev",
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    lockedAt: NOW,
  });
  const paths = [
    "redis-script/cli/commands/apply.py",
    "redis-script/cli/commands/destroy.py",
    "redis-script/engines/postgres/pgactive.py",
    "redis-script/engines/postgres/patroni.py",
    "redis-script/engines/postgres/migration.py",
    "redis-script/engines/postgres/backup.py",
    "redis-script/engines/postgres/status.py",
    "redis-script/config/postgres-localvm-patroni-ha-security.yml",
    "redis-script/config/postgres-localvm-standalone-tls.yml",
    "redis-script/engines/qdrant/backup.py",
    "redis-script/engines/kafka/status.py",
    "redis-script/engines/mongo/backup.py",
    "redis-script/engines/valkey/commands/backup.py",
    "redis-script/engines/observability/status.py",
  ];
  const classification = await oss_qa_diff_classify({
    lock,
    profileId: "hybrowlabs-oss-manager",
    changes: paths.map((path) => ({ path, status: "modified", additions: 20, deletions: 5 })),
  });
  const useCases = await oss_qa_use_case_select({ lock, classification, profileId: "hybrowlabs-oss-manager" });
  const has = (engine: string, suite: string) => useCases.selected.some((item) => item.targetEngine === engine && item.suite === suite);
  assert.equal(classification.impact, "HIGH_RISK");
  assert.equal(has("postgres", "active_active_validate"), true);
  assert.equal(has("postgres", "patroni_ha_validate"), true);
  assert.equal(has("postgres", "migration_validate"), true);
  assert.equal(has("postgres", "tls_validate"), true);
  assert.equal(has("postgres", "backup"), true);
  assert.equal(has("postgres", "restore_validate"), true);
  assert.equal(has("postgres", "status_refresh_all"), true);
  assert.equal(has("postgres", "apply"), true);
  assert.equal(has("postgres", "destructive_plan"), true);
  assert.equal(has("qdrant", "backup"), true);
  assert.equal(has("kafka", "status_refresh_all"), true);
  assert.equal(has("mongo", "backup"), true);
  assert.equal(has("valkey", "backup"), true);
  assert.equal(has("observability", "dashboard"), true);
  assert.equal(useCases.selected.filter((item) => item.risk === "mutation_gated").every((item) => item.dispatch === "approval_compensation_adapter_required"), true);

  const plan = await oss_qa_scenario_compile({ lock, classification, profileId: "hybrowlabs-oss-manager" });
  assert.equal(plan.scenarios.length <= classification.engines.length * 2, true);
  const selectedMutationIds = new Set(useCases.selected.filter((item) => item.risk === "mutation_gated").map((item) => item.id));
  assert.equal(plan.operations.some((operation) => operation.operationType === "matrix.suite_contract" && selectedMutationIds.has(String(operation.params.suiteContractId))), false);
});

test("status-only changes stay read-only while Sentinel changes earn controlled failover", async () => {
  const statusOnly = await fixture("redis-script/engines/postgres/status.py", "hybrowlabs-oss-manager");
  assert.deepEqual(statusOnly.classification.engines, ["postgres"]);
  assert.equal(statusOnly.plan.mutationCount, 0);
  assert.equal(statusOnly.plan.operations.some((operation) => operation.state === "FAULT"), false);

  const sentinel = await fixture("redis-script/config/sentinel-cluster.yml", "hybrowlabs-oss-manager");
  assert.deepEqual(sentinel.classification.engines, ["sentinel"]);
  assert.equal(sentinel.plan.operations.some((operation) => operation.operationType === "observe.sentinel_failover"), true);
  assert.equal(sentinel.plan.operations.filter((operation) => operation.mutating).every((operation) => operation.compensation), true);
});

test("PostgreSQL failover paths never create Redis or Sentinel false positives", async () => {
  const postgres = await fixture("redis-script/engines/postgres/failover.py", "hybrowlabs-oss-manager");
  assert.deepEqual(postgres.classification.engines, ["postgres"]);
  assert.equal(postgres.plan.scenarios.some((scenario) => scenario.engine === "sentinel" || scenario.engine === "redis"), false);
});

test("docs-only and test-only changes never select infrastructure mutations", async () => {
  for (const path of ["docs/runbooks/status.md", "redis-script/tests/test_postgres_engine.py"]) {
    const { classification, plan } = await fixture(path, "hybrowlabs-oss-manager");
    assert.equal(["DOCUMENTATION_ONLY", "TEST_ONLY"].includes(classification.impact), true);
    assert.equal(plan.mutationCount, 0);
    assert.equal(plan.useCases.gatedCount, 0);
    assert.equal(plan.useCases.selected.every((item) => item.selection === "contract"), true);
  }
});

test("unknown custom app changes never inherit an arbitrary engine fault scenario", async () => {
  const { classification, plan } = await fixture("apps/customer_portal/src/workflow.ts");
  assert.deepEqual(classification.engines, []);
  assert.equal(plan.mutationCount, 0);
  assert.equal(plan.scenarios.length, 1);
  assert.equal(plan.scenarios[0].app, "customer_portal");
  assert.equal(plan.scenarios[0].engine, undefined);
});

test("run creation rejects a plan whose deterministic content was altered", async () => {
  const { lock, plan } = await fixture();
  const tampered: QaPlan = { ...plan, mutationCount: plan.mutationCount + 1 };
  await assert.rejects(oss_qa_run_create({ lock, plan: tampered, startedAt: NOW }), /Plan digest or id/);
});

test("typed operation validation rejects arbitrary model-generated shell", async () => {
  const { plan } = await fixture();
  const operation = plan.operations[0];
  await assert.rejects(
    oss_qa_operation_validate({ operation: { ...operation, params: { command: "sudo rm -rf /" } } }),
    /forbidden execution key command/,
  );
  assert.deepEqual(await oss_qa_operation_validate({ operation }), {
    valid: true,
    operationId: operation.id,
    operationType: operation.operationType,
  });
});

test("deterministic dispatcher blocks every mutation until compensation registration", async () => {
  let { run } = await fixture();
  run = await advanceToSeed(run);
  const seedOperation = run.plan.operations.find((operation) => operation.state === "SEED");
  assert.ok(seedOperation);
  const blocked = await oss_qa_executor_next({ run });
  assert.equal((blocked.blocked as Array<{ operationId: string }>).some((item) => item.operationId === seedOperation.id), true);
  run = await oss_qa_compensation_register({ run, operationId: seedOperation.id, registeredAt: NOW });
  const journaled = await oss_qa_executor_next({ run });
  assert.equal((journaled.blocked as Array<{ operationId: string; reason: string }>).some((item) => item.operationId === seedOperation.id && item.reason === "record_dispatching_before_side_effect"), true);
  run = await markDispatching(run, seedOperation);
  const ready = await oss_qa_executor_next({ run });
  assert.equal((ready.dispatchable as TypedOperation[]).some((item) => item.id === seedOperation.id), true);
});

test("a forged successful receipt cannot pass a mutation outside the compensation ledger", async () => {
  let { run } = await fixture();
  run = await advanceToSeed(run);
  run = await passState(run);
  assert.equal(run.stateResults.at(-1)?.verdict, "INCONCLUSIVE");
  assert.match(run.stateResults.at(-1)?.reason ?? "", /not APPLIED through the compensation ledger/);
});

test("a compiled state cannot be skipped with NOT_APPLICABLE", async () => {
  let { run } = await fixture();
  run = await passState(run);
  run = await passState(run);
  assert.equal(run.currentState, "TOPOLOGY");
  run = await markNotApplicable(run, "skip expensive checks");
  assert.equal(run.stateResults.at(-1)?.verdict, "INCONCLUSIVE");
  assert.match(run.stateResults.at(-1)?.reason ?? "", /compiled operations/);
});

test("exit code zero without semantic evidence is INCONCLUSIVE, never PASS", async () => {
  const { run } = await fixture();
  const operation = run.plan.operations.find((item) => item.state === "SOURCE_LOCK");
  assert.ok(operation);
  const sourceReceipt = receipt(run, "SOURCE_LOCK", "source", { operationId: operation.id, exitCode: 0 });
  const result = await oss_qa_state_record({ run, receipts: [sourceReceipt], assertions: [], completedAt: NOW });
  assert.equal(result.stateResults[0].verdict, "INCONCLUSIVE");
  assert.match(result.stateResults[0].reason, /Exit status and receipts alone/);
});

test("negative control failure is surfaced even when the command exits zero", async () => {
  const { run } = await fixture();
  const operation = run.plan.operations.find((item) => item.state === "SOURCE_LOCK");
  assert.ok(operation);
  const sourceReceipt = receipt(run, "SOURCE_LOCK", "source", { operationId: operation.id, exitCode: 0, suffix: "source" });
  const negative = receipt(run, "SOURCE_LOCK", "negative_control", { exitCode: 0, suffix: "negative" });
  const result = await oss_qa_state_record({
    run,
    receipts: [sourceReceipt, negative],
    assertions: [assertion("negative-control", negative.id, false, "negative control detection")],
    completedAt: NOW,
  });
  assert.equal(result.stateResults[0].verdict, "FAIL");
});

test("wrong source SHA fails the run before any target mutation", async () => {
  const { run } = await fixture();
  const operation = run.plan.operations.find((item) => item.state === "SOURCE_LOCK");
  assert.ok(operation);
  const sourceReceipt = receipt(run, "SOURCE_LOCK", "source", { operationId: operation.id, sourceSha: WRONG_SHA });
  const result = await oss_qa_state_record({
    run,
    receipts: [sourceReceipt],
    assertions: [assertion("source-lock", sourceReceipt.id)],
    completedAt: NOW,
  });
  assert.equal(result.stateResults[0].verdict, "FAIL");
  assert.match(result.stateResults[0].reason, /locked SHA/);
  assert.equal(result.currentState, "REPORT");
});

test("missing evidence for any compiled operation prevents a state PASS", async () => {
  let { run } = await fixture();
  run = await passState(run);
  run = await passState(run);
  assert.equal(run.currentState, "TOPOLOGY");
  const operations = run.plan.operations.filter((item) => item.state === "TOPOLOGY");
  assert.equal(operations.length > 1, true);
  const only = receipt(run, "TOPOLOGY", "topology", { operationId: operations[0].id });
  const result = await oss_qa_state_record({
    run,
    receipts: [only],
    assertions: [assertion("partial-topology", only.id)],
    probes: [],
    completedAt: NOW,
  });
  assert.equal(result.stateResults.at(-1)?.verdict, "INCONCLUSIVE");
  assert.match(result.stateResults.at(-1)?.reason ?? "", /has no evidence receipt/);
});

test("data mismatch is FAIL with raw digest evidence", async () => {
  let { run } = await fixture("docs/overview.md");
  run = await passState(run); // source
  run = await passState(run); // diff
  run = await markNotApplicable(run); // topology
  run = await markNotApplicable(run); // before
  run = await passState(run); // gate
  run = await markNotApplicable(run); // seed
  run = await markNotApplicable(run); // fault
  run = await markNotApplicable(run); // observe
  run = await markNotApplicable(run); // matrix
  assert.equal(run.currentState, "DATA_VERIFY");
  const digest = receipt(run, "DATA_VERIFY", "data_digest", { suffix: "mismatch" });
  const probeReceipt = receipt(run, "DATA_VERIFY", "probe", { producerRole: "invariant-auditor", suffix: "mismatch-probe" });
  const result = await oss_qa_state_record({
    run,
    receipts: [digest, probeReceipt],
    assertions: [assertion("data-digest", digest.id, false, "every row and column digest")],
    probes: [assertion("data-probe", probeReceipt.id, true, "independent data probe")],
    completedAt: NOW,
  });
  assert.equal(result.stateResults.at(-1)?.verdict, "FAIL");
  assert.equal(result.currentState, "REPORT");
});

test("killed run recovery emits compensations in reverse mutation order", async () => {
  let { run } = await fixture();
  run = await advanceToSeed(run);
  const seed = run.plan.operations.find((operation) => operation.state === "SEED");
  assert.ok(seed);
  run = await oss_qa_compensation_register({ run, operationId: seed.id, registeredAt: NOW });
  run = await markDispatching(run, seed);
  run = await oss_qa_mutation_record({ run, operationId: seed.id, event: "applied", receipt: mutationReceipt(run, seed, "SEED") });
  run = await passState(run);
  assert.equal(run.currentState, "FAULT");
  const fault = run.plan.operations.find((operation) => operation.state === "FAULT");
  assert.ok(fault);
  run = await oss_qa_compensation_register({ run, operationId: fault.id, registeredAt: NOW });
  run = await markDispatching(run, fault);
  run = await oss_qa_mutation_record({ run, operationId: fault.id, event: "applied", receipt: mutationReceipt(run, fault, "FAULT") });
  const recovered = await oss_qa_run_recover({ run, recoveredAt: NOW, reason: "worker process killed" });
  assert.equal(recovered.run.currentState, "RESTORE");
  assert.deepEqual(recovered.recoveryOperations.map((item) => item.operationId), [fault.id, seed.id]);
});

test("dispatch journal closes the crash window before an applied receipt exists", async () => {
  let { run } = await fixture();
  run = await advanceToSeed(run);
  const seed = run.plan.operations.find((operation) => operation.state === "SEED");
  assert.ok(seed);
  run = await oss_qa_compensation_register({ run, operationId: seed.id, registeredAt: NOW });
  run = await markDispatching(run, seed);

  const recovered = await oss_qa_run_recover({ run, recoveredAt: NOW, reason: "worker died after side effect and before receipt" });
  assert.equal(recovered.run.currentState, "RESTORE");
  assert.deepEqual(recovered.recoveryOperations.map((item) => item.operationId), [seed.id]);
  const restoreReceipt = receipt(recovered.run, "RESTORE", "restore", {
    operationId: seed.id,
    producerRole: "recovery-controller",
    suffix: "dispatch-window",
  });
  run = await oss_qa_mutation_record({
    run: recovered.run,
    operationId: seed.id,
    event: "restored",
    receipt: restoreReceipt,
  });
  assert.equal(run.mutationLedger[0].status, "RESTORED");
});

test("restoration failure is terminal RESTORE_FAILED and cannot be reported as PASS", async () => {
  let { run } = await fixture();
  run = await advanceToSeed(run);
  const seed = run.plan.operations.find((operation) => operation.state === "SEED");
  assert.ok(seed);
  run = await oss_qa_compensation_register({ run, operationId: seed.id, registeredAt: NOW });
  run = await markDispatching(run, seed);
  run = await oss_qa_mutation_record({ run, operationId: seed.id, event: "applied", receipt: mutationReceipt(run, seed, "SEED") });
  run = (await oss_qa_run_recover({ run, recoveredAt: NOW })).run;
  const restoreReceipt = receipt(run, "RESTORE", "restore", { operationId: seed.id, producerRole: "recovery-controller", suffix: "restore-failed" });
  run = await oss_qa_mutation_record({
    run,
    operationId: seed.id,
    event: "restore_failed",
    receipt: restoreReceipt,
    failure: "service did not return to captured state",
  });
  const probeReceipt = receipt(run, "RESTORE", "probe", { operationId: seed.id, producerRole: "recovery-controller", suffix: "restore-probe" });
  run = await oss_qa_state_record({
    run,
    receipts: [probeReceipt],
    assertions: [assertion("restore-semantic", restoreReceipt.id)],
    probes: [assertion("restore-independent", probeReceipt.id)],
    completedAt: NOW,
  });
  assert.equal(run.stateResults.at(-1)?.verdict, "RESTORE_FAILED");
  assert.equal(run.currentState, "REPORT");
  run = await passState(run);
  assert.equal(run.status, "RESTORE_FAILED");
  const report = await oss_qa_report_build({ run });
  assert.equal(report.verdict, "RESTORE_FAILED");
});

test("successful mutation run verifies every operation and every compensation before PASS", async () => {
  let { run } = await fixture();
  run = await advanceToSeed(run);

  for (const operation of run.plan.operations.filter((item) => item.state === "SEED")) {
    run = await oss_qa_compensation_register({ run, operationId: operation.id, registeredAt: NOW });
    run = await markDispatching(run, operation);
    run = await oss_qa_mutation_record({ run, operationId: operation.id, event: "applied", receipt: mutationReceipt(run, operation, "SEED") });
  }
  run = await passState(run);
  for (const operation of run.plan.operations.filter((item) => item.state === "FAULT")) {
    run = await oss_qa_compensation_register({ run, operationId: operation.id, registeredAt: NOW });
    run = await markDispatching(run, operation);
    run = await oss_qa_mutation_record({ run, operationId: operation.id, event: "applied", receipt: mutationReceipt(run, operation, "FAULT") });
  }
  run = await passState(run); // fault
  run = await passState(run); // observe
  run = await passState(run); // matrix
  run = await passState(run); // data
  assert.equal(run.currentState, "RESTORE");

  const dispatch = await oss_qa_executor_next({ run });
  const restorationAssertions: QaAssertion[] = [];
  const restorationProbes: QaAssertion[] = [];
  const probeReceipts: EvidenceReceipt[] = [];
  for (const item of dispatch.dispatchable as Array<{ operationId: string }>) {
    const restoreReceipt = receipt(run, "RESTORE", "restore", {
      operationId: item.operationId,
      producerRole: "recovery-controller",
      suffix: `restore-${item.operationId}`,
    });
    run = await oss_qa_mutation_record({ run, operationId: item.operationId, event: "restored", receipt: restoreReceipt });
    restorationAssertions.push(assertion(`assert-restore-${item.operationId}`, restoreReceipt.id));
    const probeReceipt = receipt(run, "RESTORE", "probe", {
      operationId: item.operationId,
      producerRole: "recovery-controller",
      suffix: `probe-${item.operationId}`,
    });
    probeReceipts.push(probeReceipt);
    restorationProbes.push(assertion(`probe-restore-${item.operationId}`, probeReceipt.id, true, "independent restored-state probe"));
  }
  run = await oss_qa_state_record({
    run,
    receipts: probeReceipts,
    assertions: restorationAssertions,
    probes: restorationProbes,
    completedAt: NOW,
  });
  run = await passState(run); // post-proof
  run = await passState(run); // report
  assert.equal(run.status, "PASS");
  assert.equal(run.mutationLedger.every((entry) => entry.status === "RESTORED"), true);
});

test("no-change contract completes PASS with explicit NOT_APPLICABLE states", async () => {
  const lock = await oss_qa_source_lock({
    repository: "https://example.test/customer/app",
    branch: "dev",
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    lockedAt: NOW,
  });
  const classification = await oss_qa_diff_classify({ lock, changes: [] });
  const plan = await oss_qa_scenario_compile({ lock, classification });
  let run = await oss_qa_run_create({ lock, plan, startedAt: NOW });
  run = await passState(run); // source
  run = await passState(run); // diff
  run = await markNotApplicable(run); // topology
  run = await markNotApplicable(run); // before
  run = await passState(run); // gate
  run = await markNotApplicable(run); // seed
  run = await markNotApplicable(run); // fault
  run = await markNotApplicable(run); // observe
  run = await markNotApplicable(run); // command matrix
  run = await markNotApplicable(run); // data
  run = await markNotApplicable(run, "No mutations were applied."); // restore
  run = await passState(run); // post-proof common operation
  run = await passState(run); // report
  assert.equal(run.status, "PASS");
  assert.equal(run.stateResults.some((result) => result.verdict === "NOT_APPLICABLE"), true);
});
