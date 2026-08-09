# Muster AI Operating System for Frappe v16

Status: implementation contract  
Date: 2026-07-19  
Owners: Muster core, Muster gateway, Frappe capability pack, standalone Frappe app

## Outcome

Muster becomes a durable AI automation operating layer embedded in Frappe v16. A user can ask anything about the site or their work: a factual question, explanation, analysis, report, artifact, one-off governed action, reusable workflow, or application customization. The assistant answers directly when evidence is sufficient, asks for missing business detail when necessary, and offers a reviewable plan only when the outcome requires work. A prompt is never silently converted into a mission. Users can keep working elsewhere in Desk while approved agents and nested subagents operate on permitted records and metadata, recover from failures, and verify every effect. The graph runtime remains universal; Frappe is a first-class host and business capability provider, not a hardcoded API wrapper.

## Decisions

1. Muster's append-only mission event stream is execution authority. Frappe persists the business-facing mission, work-unit tree, approvals, changes, artifacts, and a permission-filtered event projection.
2. Existing clean primitives are reused: `packages/core/src/flow.ts`, `subagents.ts`, `artifacts.ts`, `enterprise-governance.ts`, and `packages/gateway/src/async-message-store.ts`. New graph/event modules adapt them without rewriting dirty user-owned integration work.
3. All Frappe mutation compiles to a typed change-set IR and executes through governed Frappe permission checks and safe writes. Browser or model-authored arbitrary REST is forbidden.
4. OAuth establishes site/principal trust. Frappe roles, DocPerm, User Permission, shares, field-level restrictions, workflow rights, policy, and approval are intersected immediately before every effect.
5. Frappe's native Workflow is a document state machine. Muster Workflow is a versioned agent graph. They remain distinct in storage, UI, APIs, and tests.
6. The UI uses a native `/desk` Desktop Icon and Workspace Sidebar, a persistent activity dock, and a full `/desk/muster-control` Vue surface. Runs survive navigation, disconnect, and browser closure.
7. The production target is a dedicated Frappe-2 bench/site, not an existing customer bench. It uses stable Python 3.14.x, Node 24.x, Frappe v16 pinned to a tested revision, and an isolated port/service block.
8. Telegram onboarding begins inside an authenticated Frappe session with a short-lived, one-use bot link. Generic operator pairing remains a controlled fallback only.
9. `Ask` is the universal default entry point. `Build workflow` is an optional explicit shortcut for durable automation design, not a prerequisite for questions or action requests. The current Desk route is advisory context and never an implicit authority boundary or search ceiling.
10. Prompt routing is outcome-aware and reviewable: answer/explain, permission-filtered read or analysis, artifact, governed one-off action, reusable workflow, and privileged development/customization are distinct execution classes. Classification grants no authority; every read and effect still passes its own live checks.
11. Attended CRUD uses the real Desk form. Muster visibly navigates, fills, selects, and saves through a labeled cursor while Frappe enforces the caller's session permissions. A hidden REST write cannot be presented as cursor-driven work. Server-side preflight, approval binding, and post-save reread still provide authority and verification without applying the mutation a second time.

## Four Planes

- Control: site/principal/role bindings, policies, agents, workflow definitions and versions, triggers, credentials, approvals, budgets.
- Execution: missions, graph nodes, attempts, leases/fencing, retries, cancellation, compensation, tool calls, events, artifacts.
- Experience: activity dock, mission board/canvas, inspector, diffs, approvals, evidence, standard DocType fallbacks, desktop/mobile controls.
- Evidence: immutable receipts, permission decisions, snapshots, hashes, test cases, screenshots, traces, release manifest, video timestamps.

## Ownership and Interfaces

| Owner | New primary surface | Responsibility |
|---|---|---|
| Muster core | `agent-graph.ts`, `run-events.ts` | portable graph definition, validation, durable state transitions, delegation, event contract |
| Muster gateway | structured async run event endpoint | authenticated dispatch, cursor/event transport, channel identity, pause/cancel/steer |
| Frappe capability pack | `change-set.ts` | typed plan, preflight, approval binding, permission-safe execution, verification, compensation |
| Frappe app | `frappe_app/muster` | business/control records, projection, Desk/mobile UI, Frappe-side executors and permissions |

The versioned `RunEvent` envelope contains event id, mission/root run/node/attempt ids, tenant/site, monotonic sequence, type, state, sanitized summary/payload, actor/agent, reference, evidence ids, timestamp, and schema version. It never contains chain-of-thought or secrets.

The `FrappeChangeSet` contains target site/app, actor, permission epoch, schema/data revision, immutable plan hash, risk and approval classes, prerequisites, ordered typed operations, verification, inverse/forward repair, and evidence. Each operation carries before/after, concurrency token, required permissions/capabilities, idempotency key, dependencies, receipt, and postconditions.

## Runtime Semantics

- Delivery is at-least-once; effects are idempotent and deduplicated.
- Leases carry fencing tokens. Stale workers cannot write events or effects.
- Per-mission event sequences are monotonic and cursor-replayable.
- Raw cycles are invalid; bounded loop nodes declare caps and progress predicates.
- Defaults are depth 3, fan-out 8, 32 active nodes, three bounded retries, plus explicit time/tool/token/cost/artifact ceilings.
- Child rights equal the intersection of caller rights, parent and workflow policy, agent allowlist, node request, tenant/site scope, live Frappe permission, remaining budget, and approval.
- Cancellation is a durable state transition, propagates to descendants, stops new effects, waits for safe points, and may invoke compensation. Failed compensation becomes `Needs Intervention`.

## Universal Ask Semantics

- Conversation continuity is isolated by tenant, site, Frappe principal, and conversation. Reusing an idempotency key or run id across any authority lane fails closed.
- General explanations may use model knowledge but must clearly distinguish it from live site facts. Any claim about current records, configuration, permissions, or installed behavior requires fresh host-supplied evidence.
- Live reads compile to a closed data-only read IR. They use Frappe metadata and permission APIs under the caller and support bounded detail, list, count, and approved aggregates; arbitrary SQL, method names, URLs, scripts, and provider-side Frappe connectors are forbidden.
- A normal Ask request may propose a one-off action or reusable workflow. It cannot apply an effect merely because a model classified the prompt as actionable. The UI shows the inferred outcome, scope, impact, missing inputs, and required approval before dispatch.
- One-off effects use a per-mission immutable plan and approval binding. Reusable workflows additionally require an inert proposal, human review, publication of an immutable version, and explicit start.
- Artifact and development requests retain the full agent and subagent runtime, but files, code-bearing Frappe surfaces, browser control, and external connectors remain capability-scoped and evidence-backed.
- Before attended CRUD, Frappe derives a live effective-form snapshot from base DocType fields, Custom Fields, Property Setters, workflow/state behavior, field permission levels, and relevant form customization metadata. The snapshot records sanitized provenance and a revision hash; any drift before save stops the run for review.
- Client Script and rendered DOM contents are untrusted data. They may explain why the live form differs, but can never add an action, selector, capability, credential, or instruction to the signed plan.
- Frappe v16 custom DocType creation is explicitly two-stage: core Quick Entry inserts a minimal skeleton before routing to the full Form Builder. Muster models this as an attended saga rather than overriding Frappe: complete-schema review and approval precede the native skeleton insert; the intermediate revision is receipted; the full Fields and Permissions tables are then populated and paused before Save; failure or abandonment compensates only an unchanged, receipt-bound skeleton.
- Every cursor milestone names the current form and user-visible action without exposing secret values. Cursor evidence is emitted only after the browser transport proves the action occurred, and completion requires a fresh server-side reread of the saved document.

## Frappe App Model

Configuration and identity:

- `Muster Settings` (Single): connection, OAuth/trust, defaults/limits, channels, diagnostics; secrets are Password fields and never booted.
- `Muster Site Binding`: site UUID, gateway tenant, trust fingerprint, status, versions/capabilities and health. Site database remains the hard tenant boundary.
- `Muster Principal Link`: Frappe user to external provider subject, scopes, status, sync/revocation data.
- `Muster Role Binding`: user/role subject to Site, Company, Module, DocType, Document, Agent, or Workflow scope.
- `Muster Policy` with child `Muster Policy Rule`: default-deny capability, action, resource, constraints, approvals, limits.
- `Muster Channel Account` and `Muster Channel Identity`: bot/provider configuration and verified channel-to-user bindings.

Automation design:

- `Muster Agent` with `Muster Agent Capability` and `Muster Agent Delegation`: Business, Module, DocType, Specialist, or Supervisor agents with scoped identity and bounded delegation.
- `Muster Workflow`, draft child `Muster Workflow Node`/`Edge`, and immutable standalone `Muster Workflow Version`.
- `Muster Trigger`: Manual, Doc Event, Schedule, Webhook, or Telegram trigger with explicit run-as identity and dedupe window.

Execution and evidence:

- `Muster Mission`: user-visible objective, scope, status, workflow/version, root agent, progress, budget/usage, correlation and idempotency.
- `Muster Work Unit`: standalone queryable nested tree with parent/path/depth, agent, target workspace, dependencies, attempts and lease state.
- `Muster Run`: immutable attempt snapshots, execution user, job, status, heartbeat/cursor, usage and redacted result/error.
- `Muster Activity`: append-only mission sequence with visibility, sanitized payload and target reference.
- `Muster Approval`: immutable action/diff hash, eligible principals, expiry and decision; execution rechecks current permission.
- `Muster Change Set` with child `Muster Change Operation`: proposed/preflighted/approved/applied/verified/repair lifecycle.
- `Muster Artifact`: File or Frappe reference, kind, MIME, checksum, visibility and verification.

Standalone records are used for Work Unit, Run, Activity, Approval, Workflow Version, and Artifact because they require independent indexes, permissions, pagination, retention, and reporting.

## Roles

- Muster Administrator: connection, bindings, policies, channel accounts, agents/workflows, all audit; Password values are never readable after storage.
- Muster Automation Manager: agents, workflows, triggers, changes and missions, but no credential access and no approval bypass.
- Muster Operator: own/assigned missions and allowed steer/pause/cancel operations.
- Muster Approver: eligible diffs and decisions only, subject to separation-of-duties policy.
- Muster Auditor: read/export authorized runs, activity, approvals, artifacts and snapshots; no mutation.
- Muster Viewer: shared/permitted missions and artifacts only.

A service role is never assigned to humans. Generic execution switches to the recorded requester and invokes ordinary Frappe APIs without blanket `ignore_permissions`.

## Frappe v16 UI

The Desktop Icon uses the canonical themuster.dev PNG SHA-256 `2342d61cd09bfa76e411a24a493a3a6a7b22a3be1f55e987ea33c9296e59c50d`. Workspace Sidebar sections are Operate, Build, Observe, and role-gated Admin.

The desktop activity dock is collapsible/resizable; mobile uses a safe-area bottom sheet and activity badge. It lists concurrent missions, nested work units, current targets, proposed and actual changes, approvals, artifacts, pause/steer/cancel, and evidence links. The full mission workspace provides board, graph/canvas, inspector, audit, and Agent Studio modes. Standard DocType forms remain a functional fallback.

Stateful endpoints are POST with CSRF and idempotency keys. Jobs use enqueue-after-commit and durable ids. Events persist before permission-filtered realtime publication; reconnect uses cursor pagination. No browser payload contains secrets, unrestricted logs, or hidden reasoning.

## Dynamic Frappe Surfaces

The change-set compiler covers record CRUD and submit/cancel/actions plus DocType, Custom Field, Property Setter, native Workflow, Workspace/Sidebar, Page, Web Page/Form, Dashboard, Chart, Number Card, Report, Print Format, Client/Server Script, Notification, Assignment Rule, Webhook, Email Template, and Letter Head. Coding workflows also cover existing DocType controllers and `doc_events`, ordinary form/list JavaScript, whitelisted services, permission-filtered ORM and Query Builder, Jinja print/email/web rendering, scheduler/background work, fixtures, patches and migrations; a new page is optional, not the default. Code-bearing surfaces require a separate privileged policy, static validation, explicit approval, injection tests, and rollback/forward repair.

## Deployment

Target: `/home/goblin/personal/muster-frappe-bench`, dedicated site and process config. Candidate isolated ports are web 8004, socket 9004, Redis cache 13004, queue 11004 after a final conflict check. Reference `/home/goblin/personal/frappe-bench2` is read-only source/cache only. Install stable Python 3.14.x before creating the bench.

## Delivery Order

1. Land schemas/contracts, graph/event core, and Frappe change-set validation with unit and negative tests.
2. Create the standalone app, metadata, permissions, projection, background jobs, and standard forms.
3. Add Desk shell, icon/sidebar, activity dock, mission control, Agent Studio and mobile behavior.
4. Connect gateway events/controls, OAuth binding and Telegram link protocol.
5. Add deep change executors and realistic ERPNext/custom-app scenarios.
6. Seed, load, break, recover, deploy, collect evidence, then record the presentation.

Production readiness is governed by `skills/muster-frappe-orchestrator/references/acceptance-gates.md` and `docs/RELEASE_TRAIN.md`; a screenshot, successful command, Administrator-only run, or demo video cannot satisfy a gate by itself.
