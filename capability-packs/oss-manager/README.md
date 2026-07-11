# OSS Manager QA Pack

Native Muster capability pack for app-aware, engine-aware infrastructure QA. It is a reusable framework and contains no other customer profile. `hybrowlabs/OSS-Manager` is included only as a sanitized deployment profile with no hosts, credentials, tickets, or customer data.

## Safety contract

The pack compiles plans and evaluates executor receipts. It does not receive a shell function and cannot run arbitrary commands.

1. Lock repository, branch, base SHA, and head SHA.
2. Classify changed files deterministically.
3. Compile direct scenarios plus bounded adjacent regressions.
4. Reconcile the locked source manifest with all 138 reviewed suite contracts and their command IDs.
5. Dispatch only catalog operation IDs with JSON parameters and typed target selectors.
6. Register the exact compensation, then durably journal `DISPATCHING`, before every mutation.
7. Require a semantic assertion and independent probe; exit code alone never passes.
8. Enter `RESTORE` after a killed run or failed state whenever a mutation may have reached its target.
9. Run compensations against immutable captured targets in reverse registration order.
10. Preserve raw evidence by digest/reference and emit only redacted excerpts in chat progress.

The state contract is fixed:

```text
SOURCE_LOCK -> DIFF -> TOPOLOGY -> BEFORE_SNAPSHOT -> GATE -> SEED
-> FAULT -> OBSERVE -> COMMAND_MATRIX -> DATA_VERIFY -> RESTORE
-> POST_PROOF -> REPORT
```

Terminal verdicts are `PASS`, `FAIL`, `INCONCLUSIVE`, `NOT_APPLICABLE`, and `RESTORE_FAILED`. Restoration failure has the highest precedence and cannot be hidden by report generation.

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

Actual infrastructure adapters map operation IDs such as `fault.service_stop` or `data.postgres_row_digest` to reviewed implementation code. Runtime inventory resolves selectors such as `topology://sentinel/current-primary`; it never enters the plan as model-written shell.

## Tools

- `oss_qa_source_lock`
- `oss_qa_diff_classify`
- `oss_qa_scenario_compile`
- `oss_qa_use_case_select`
- `oss_qa_suite_catalog`
- `oss_qa_suite_manifest_validate`
- `oss_qa_run_create`
- `oss_qa_executor_next`
- `oss_qa_compensation_register`
- `oss_qa_mutation_record`
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

Live infrastructure certification remains deployment-specific. A deployment must supply reviewed operation adapters, target inventory, secret references, authorization policy, durable run storage, and an independent recovery worker.

## Ragnar agent

Ragnar exposes this workflow through the role-scoped `@oss-manager-tester` agent. Selecting the agent isolates its provider history and applies the same source-lock, approval, evidence, and restoration contract. The agent can plan with this pack, but it must report `BLOCKED` or `INCONCLUSIVE` when the deployment has not supplied the required typed adapters or credentials.
