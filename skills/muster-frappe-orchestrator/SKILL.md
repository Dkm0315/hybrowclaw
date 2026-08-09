---
name: muster-frappe-orchestrator
description: Coordinate end-to-end Muster automation work across Frappe or ERPNext architecture, metadata, UI, workflows, security, testing, deployment, and evidence. Use for cross-cutting features, production plans, multi-agent delivery, or work that spans Muster core and a Frappe app.
---

# Muster Frappe Orchestrator

Build a native AI operating layer for Frappe, not a chat wrapper. Keep decisions, execution, approvals, evidence, and recovery visible inside the product.

## Start With Reconnaissance

1. Read repository instructions and inspect the dirty worktree before editing.
2. Locate the target bench, site, Frappe version, installed apps, ports, process manager, and deployment boundaries.
3. Map existing Muster core, gateway, OAuth, RBAC, workflow, channel, and Frappe capability code.
4. Create an acceptance matrix covering desktop, mobile, permissions, failure recovery, observability, and evidence.
5. Record assumptions and irreversible choices as ADRs before implementation.

For Frappe implementation, also load the relevant installed `frappe-agent` skills. Use the five specialist Muster skills for bounded sections of work.

## Architecture Contract

Separate four planes:

- Control plane: tenants, identities, grants, policies, agents, workflow definitions, approvals, budgets, and credentials.
- Execution plane: durable runs, hierarchical tasks, leases, retries, cancellation, idempotency, tool calls, and artifacts.
- Experience plane: Desk/mobile workspaces, sidecar activity, mission control, previews, diffs, approvals, and undo.
- Evidence plane: immutable events, permission decisions, snapshots, test results, screenshots, traces, and release manifests.

Frappe is the system of record for business metadata and user-visible automation state. Muster is the execution engine. Communicate through versioned commands and events; do not couple the systems through ad hoc API calls.

## Delegate Safely

When parallel work is authorized, assign non-overlapping ownership:

- `$muster-frappe-metadata`: DocTypes and customization change sets.
- `$muster-frappe-ui`: native Frappe v16 desktop/mobile experience.
- `$muster-frappe-workflows`: agent graphs and durable execution.
- `$muster-frappe-security`: tenant isolation, OAuth, RBAC, and adversarial tests.
- `$muster-frappe-release`: benches, data, browser QA, evidence, and presentation.

Give each worker an explicit read/write scope, expected artifacts, and tests. The orchestrator owns integration, conflict resolution, and final negative verification.

## Completion Rule

Never call a feature complete because a command or screen exists. It must be configured, enabled, exercised with realistic data, observed, permission-checked, failure-tested, documented, and represented in the evidence manifest. Read [acceptance-gates.md](references/acceptance-gates.md) before declaring a milestone complete.
