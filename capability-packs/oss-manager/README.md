# OSS Manager QA Pack

Local deterministic planning and validation contract for app-aware, engine-aware infrastructure QA. The pack does not bundle live infrastructure adapters or execute shell. `hybrowlabs/OSS-Manager` is included only as a sanitized reference profile with no hosts, credentials, tickets, or customer data.

## Safety contract

The pack compiles plans and evaluates executor receipts. It does not receive a shell function and cannot run arbitrary commands.

1. Lock repository, branch, base SHA, and head SHA.
2. Classify changed files deterministically.
3. Compile direct scenarios plus bounded adjacent regressions.
4. Reconcile the locked source manifest with all 138 reviewed suite contracts and inert command IDs.
5. Bind every suite to a feature-owned deterministic validator and catalog-owned expected value.
6. Gate runtime and high-risk changes on exact feature-owned documentation coverage or a source-SHA-, impact-, and path-bounded approval.
7. Dispatch only catalog operation IDs with JSON parameters and typed target selectors.
8. Register the exact compensation, then durably journal `DISPATCHING`, before every planned mutation.
9. Accept observed values and evidence, never a caller-authored verdict; legacy `passed` fields are ignored for state assertions and rejected for suite validation.
10. Require an immutable terminal validation result for every selected suite. Missing, blocked, or inconclusive selections prevent `PASS`.
11. Require mutation-gated deployment evidence to precede its validation and require selected health validators to run after deployment.
12. Enter `RESTORE` after a killed run or failed state whenever a mutation may have reached its target.
13. Run compensations against immutable captured targets in reverse registration order.
14. Preserve structured expected/observed/reason/evidence results plus raw evidence digests and references.

The state contract is fixed:

```text
SOURCE_LOCK -> DIFF -> TOPOLOGY -> BEFORE_SNAPSHOT -> GATE -> SEED
-> FAULT -> OBSERVE -> COMMAND_MATRIX -> DATA_VERIFY -> RESTORE
-> POST_PROOF -> REPORT
```

Terminal run verdicts are `PASS`, `FAIL`, `INCONCLUSIVE`, `NOT_APPLICABLE`, and `RESTORE_FAILED`. Suite validation results are `PASS`, `FAIL`, `INCONCLUSIVE`, or `BLOCKED`. Restoration failure has the highest precedence and cannot be hidden by report generation.

## Policy roles

| Role | Boundary |
|---|---|
| Release sentinel | Locks source, classifies diff, gates plan; cannot mutate or certify evidence |
| Topology surveyor | Read-only topology and snapshots |
| Engine specialist | Selects engine invariants; cannot issue shell |
| Typed executor | Executes only deployment-adapter operation IDs |
| Invariant auditor | Evaluates semantic assertions and independent probes |
| Recovery controller | Owns the independent finally path and reverse-order compensation |
| Human reporter | Renders concise progress and evidence references; cannot alter verdicts |

## Engine descriptors

The catalog includes Redis Sentinel as the full HA reference and generic Redis, Valkey, PostgreSQL, MongoDB, Kafka, Qdrant, and observability descriptors. Each descriptor defines topology, snapshot, seed, fault, observe, command-matrix, full-data verification, recovery, and post-proof contracts.

Deployment-specific infrastructure adapters map operation IDs such as `fault.service_stop` or `data.postgres_row_digest` to reviewed implementation code. Runtime inventory resolves typed selectors; it never enters the plan as model-written shell. This repository does not provide those adapters.

## Documentation impact

For `RUNTIME` and `HIGH_RISK` changes, `documentationImpact.ownedDocumentation` must cover every affected path. Each declaration uses an owner derived from classification, such as `app:runtime-app`, `module:redis`, or `engine:postgres`. Alternatively, `documentationImpact.waiver` must identify an approver and exactly match the locked source SHA, impact, and affected path set. Partial, unrelated, or broader declarations remain `BLOCKED`.

## Tools

- `oss_qa_source_lock`
- `oss_qa_diff_classify`
- `oss_qa_documentation_impact`
- `oss_qa_scenario_compile`
- `oss_qa_use_case_select`
- `oss_qa_suite_catalog`
- `oss_qa_suite_manifest_validate`
- `oss_qa_run_create`
- `oss_qa_executor_next`
- `oss_qa_compensation_register`
- `oss_qa_mutation_record`
- `oss_qa_validator_evaluate`
- `oss_qa_suite_validation_record`
- `oss_qa_validation_coverage`
- `oss_qa_state_record`
- `oss_qa_run_recover`
- `oss_qa_progress_render`
- `oss_qa_report_build`
- `oss_qa_operation_validate`
- `oss_qa_catalog`
- `oss_qa_profile_describe`
- `oss_qa_evidence_digest`

## Validation

```bash
pnpm exec tsc --noEmit -p capability-packs/oss-manager/tsconfig.json
pnpm exec tsx --test capability-packs/oss-manager/test/*.test.ts
pnpm hc capability inspect capability-packs/oss-manager
```

The tested readiness claim is a local CLI planning/evaluation tool. Mutation-gated catalog selections carry an explicit blocked reason in this pack and cannot produce `PASS`. A live integration must add reviewed operation adapters, target inventory, secret references, authorization policy, durable run storage, approval/compensation bindings, and an independent recovery worker before it can offer infrastructure certification.
