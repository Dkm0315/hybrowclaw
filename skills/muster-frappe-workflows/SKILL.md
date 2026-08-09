---
name: muster-frappe-workflows
description: Design and implement durable multi-step Muster workflows for Frappe with agent, subagent, and nested task graphs. Use for workflow definitions, planning, delegation, tool policies, approvals, retries, schedules, triggers, artifacts, dynamic page creation, or Claude-style universal JS and JSON automation.
---

# Muster Frappe Workflows

Build a universal workflow runtime, not a sequence of API calls. A workflow is a versioned graph of goals, tasks, agents, tools, policies, approvals, events, artifacts, and compensation.

## Canonical Model

Every definition has versioned inputs, outputs, nodes, edges, policy bindings, budgets, approval rules, and compatibility metadata. Every run has an immutable event stream and a materialized current state.

Node kinds include plan, agent, subworkflow, Frappe command, deterministic transform, condition, parallel map, human approval, wait/event, artifact, verification, and compensation. Agent nodes may spawn bounded children; inheritance of tenant, identity, permissions, budget, and tool allowlists must be explicit.

Execution is at-least-once. Every attempt uses a stable operation idempotency key and a lease fencing token; a stale worker cannot commit events or effects. Events receive a monotonic sequence from the authoritative store, consumers resume from cursors, and duplicate delivery must be harmless. The default safety envelope is depth 3, 8 children per node, 32 active nodes per mission, and no unbounded tokens/time/cost; policies may lower or explicitly raise these limits.

Raw graph cycles are invalid. Repetition uses a bounded loop node with an iteration cap, progress predicate, budget, and cancellation checkpoint. Cancellation prevents new effects, propagates to descendants, and waits for in-flight operations to reach a declared safe point. Compensation is a separately recorded best-effort workflow; a failed compensation leaves the mission `needs intervention`, never falsely `rolled back`.

## Workflow

1. Audit `.workflows`, Claude Code workflow conventions, Muster run/router/roster code, and existing Frappe capability packs before adding a format.
2. Define a portable JSON schema and a JS/TypeScript authoring API that compile to the same intermediate representation.
3. Validate graphs for raw cycles, unreachable nodes, invalid schemas, excessive depth/fan-out, unbounded loops, incompatible permissions, missing compensation, and unsafe triggers.
4. Persist definitions separately from runs. Pin each run to an immutable definition version.
5. Execute through durable queues with leases, heartbeats, idempotency keys, bounded retries, timeouts, cancellation propagation, and resume.
6. Stream sanitized events to Frappe while retaining full authorized evidence server-side.
7. Test nested failure, partial success, duplicated delivery, worker death, approval expiry, concurrent edits, and compensation.

## Frappe Operations

Translate business intent into typed change-set commands. Each command declares required roles, tenant/site, target app and DocType, preconditions, dry-run output, effect, evidence, and inverse. Run permission checks both when planning and immediately before applying.

Triggers never bypass approval or authorization. Schedules, webhooks, document events, and channel messages only create a run under an explicit service or user identity.

Keep the runtime independent: Frappe is one first-class host and capability provider, not a hardcoded dependency of the graph engine.

Read [workflow-runtime-contract.md](references/workflow-runtime-contract.md) when changing graph schemas, scheduling, events, delegation, or recovery.
