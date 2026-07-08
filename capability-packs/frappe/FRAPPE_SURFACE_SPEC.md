# Frappe Surface Spec — what no other harness can build

The Frappe pack is not "a chatbot for ERPNext". It is an AI operating layer that
sees what the user sees, knows how the site was customized, and remembers each
employee separately — enforced by Muster's trust kernel, not by prompt hope.

Oxygen HR (uat-erp.pwhr.in) is a reference deployment and stress-test shape,
not the boundary of the product. The pack must work for any Frappe bench:
ERPNext, HRMS, Helpdesk, Raven, Gameplan, NextAI, ChatNext, and arbitrary
custom apps that carry the real business logic. If a custom app is the heavy
lifter, Muster should discover it, index it, respect its permissions, and route
work to it instead of pretending every site is vanilla ERPNext.

## 0. Speed Contract: Sub-3s or It Is Not Good Enough

The user-facing SLA is hard:

- deterministic greetings/help/status: target 250ms
- indexed metadata/data answers: target 800ms
- live Frappe reads or write preflights: target 2.5s
- provider-backed reasoning: target 3s with a tiny context packet

No "thinking" or progress text should appear before 1.2s, and it must never be
used to hide a slow answer. The answer is the product.

This requires a Frappe read model, not prompt stuffing:

1. **Structure index**: DocTypes, DocFields, custom fields, property setters,
   workflows, reports, print formats, dashboards, installed apps, app modules,
   hooks/events, whitelisted methods, background jobs, and integration points.
2. **Permission index**: roles, user permissions, field permlevels, workflow
   action roles, shares, company/department/employee scoping.
3. **Operational data index**: bounded summaries and facts for records users
   commonly ask about: their tasks, approvals, tickets, leave, attendance,
   expense claims, reports, and recent failures.
4. **Semantic business index**: department vocabulary, custom app vocabulary,
   and site-specific aliases:
   "cab claim" -> Expense Claim, "holiday" -> Leave Application, "payslip" ->
   Salary Slip, "ask nextai" -> the installed NextAI endpoint/tooling, plus
   aliases learned from field labels, report names, workflow names, custom app
   pages, whitelisted methods, and safe usage patterns.

The data index is not a global answer cache. It is a Postgres-backed, scoped
read model. Every candidate answer still checks the current Frappe permission
hash before revealing records or fields.

### Postgres Read Model

Use Postgres for the low-latency operational read path:

- `muster_frappe.site_index`: metadata and customization graph
- `muster_frappe.permission_snapshot`: role/user permission hashes
- `muster_frappe.operational_fact`: permission-scoped business facts
- `muster_frappe.semantic_alias`: site and department vocabulary
- `muster_frappe.query_plan_cache`: safe query/action plans, not private raw
  answers

Recommended indexes:

- GIN full-text indexes for metadata/alias/fact search
- `(site, owner_user, department, doctype, valid_until)` for hot user queries
- `(site, permission_hash, roles_hash)` for permission cache invalidation
- `(site, scope_hash, query_signature)` for query-plan reuse

### Cron + Delta Sync

Cron is a safety net; Frappe document events keep the read model fresh.

- every minute: roles, user permissions, shares, workflows, custom fields,
  property setters
- every two minutes: hot operational records for paired users/departments
- every five minutes: aliases from usage, fields, reports, workflows
- nightly: full site induction, leakage evals, p95 report, stale index repair

Delta events should enqueue small updates for DocType, Custom Field, Property
Setter, Workflow, Report, Print Format, Role, Has Role, User Permission,
DocShare, installed-app metadata, scheduled jobs, whitelisted methods, custom
page routes, and indexed business DocTypes.

### Fast Answer Router

Before any provider call:

1. classify the prompt
2. resolve department language to candidate DocTypes/actions
3. check index freshness and permission hashes
4. choose one path:
   - deterministic answer
   - indexed data answer
   - live Frappe query/preflight
   - provider with tiny context

Provider calls are the last mile, not the default path. The provider receives a
small packet containing intent, candidate DocTypes, allowed fields, missing
inputs, exact Frappe errors, and the answer goal.

## 1. Screen Context Protocol (the "it picks up the current screen" layer)

A ~2KB embeddable snippet (`muster-frappe-surface.js`) for ANY Frappe UI —
Desk, Helpdesk, Gameplan, ChatNext, custom SPAs. It observes, never controls:

- Hooks `frappe.router` (Desk) / route change events (SPA) to capture:
  `{ route, doctype, docname, view (form/list/report/kanban), workspace }`
- On form views: visible fields, dirty fields, current values of non-sensitive
  fields (permlevel-0 only, redaction rules applied client-side), validation
  errors currently shown, workflow state + available actions.
- On list/report views: active filters, sort, visible columns, selected rows.
- User interactions stream (throttled): field focus, failed saves, repeated
  attempts — the "user is stuck" signal.

Payload posts to the harness as a `ContextObject`:
```json
{
  "kind": "frappe_screen_context",
  "summary": "Form: Leave Application HR-LAP-2026-00031, state=Open, dirty=[leave_type], validation_error='Leave Reason is required'",
  "scopes": [{"kind":"user","id":"pradip.irkar@pw.live"},{"kind":"session","id":"desk:tab:9f2"}],
  "redactionState": "redacted",
  "provenance": ["surface:desk", "site:uat-erp.pwhr.in"],
  "validTo": "<now + 10 minutes>"
}
```
Key properties: session-scoped + short TTL (screen context is perishable),
redacted client-side, and the agent receives it through normal recall — so
"why can't I save this?" is answered from the user's ACTUAL screen state.

## 1A. User and Employee Identity

Channel users are not trusted just because Slack, Telegram, Google Chat, or
WhatsApp delivered a message. The identity chain is:

1. channel sender creates a pending Muster pairing
2. operator approves the pairing
3. Frappe identity is resolved through OAuth bearer token or API token using
   `frappe.auth.get_logged_user`
4. linked Employee is resolved through `Employee.user_id`
5. roles are resolved from Frappe
6. permission/role hashes become the cache invalidation keys for the read model

This gives each channel turn a concrete business identity:

- `pairing:<surface>:<sender>` for channel continuity
- `user:<pairing-id>` for legacy Muster continuity
- `tenant:<site>` for site-scoped approved knowledge
- `user:frappe:<frappe-user>` for Frappe user memory
- `user:frappe-employee:<employee-id>` for employee-specific memory
- `role:frappe:<site>:<role>` for role-scoped memory and budget reports

OAuth is preferred because the token proves the Frappe user without storing a
password. API tokens are supported for service/admin setups. Manual operator
assertion is allowed for controlled demos and air-gapped deployments, but it is
marked as `operator_asserted`, not as OAuth proof.

## 2. Customization Core (bench-wide, not app-specific)

The `frappe_customization_context` engine shape from Oxygen HR becomes a generic
bench induction layer:
- Read-only, permission-scoped map of custom fields, property setters,
  workflows, server/client scripts, print formats, reports, DocPerms,
  assignment rules — by doctype, module, app, or free-text flow.
- Domain DocType priors validated against the live site index (payslip →
  Salary Slip only if that doctype exists on THIS site).
- Error-aware fetch diagnostics: the agent reports the exact blocker
  ("Expense Claim Type Cab/Taxi has no default account") — never "malformed data".
- Custom app handoff: if apps such as NextAI, ChatNext, OxygenHR, or an
  industry-specific app own the right endpoint, report, method, workflow, or
  DocType, Muster routes through that app's exposed surface with the same
  permission checks instead of duplicating its business logic.

## 3. Per-employee memory lanes (thousands of users, zero leaks)

Direct mapping onto Muster scoped memory — already enforced and tested:
- `user:<frappe_user>` — personal facts, preferences, recurring requests
- `role:<frappe_role>` — what HR managers vs employees see
- `workspace:<module>` — module-level operational memory (HR, Payroll, Helpdesk)
- `tenant:<site>` — site-wide approved knowledge (promotion-gated)
- `session:<surface tab>` — screen context, expires
Promotion to tenant/global requires the eval gate. The harness self-check
(`memory_isolation`) makes cross-employee leakage a CI failure, not a hope.

## 4. Workflow Loop Studio (what others haven't thought of)

Not "AI writes a script": governed creation of living automation:
- `frappe_workflow_draft`: from natural language ("expense claims over 50k
  need L2 approval then CFO"), generate a real Frappe Workflow document draft
  + transition matrix, validated against live roles/states, behind approval.
- `frappe_loop_create`: recurring agent loops bound to doctype events or cron
  ("every Monday 9am: summarize unassigned HD Tickets per team and post to
  the team lead") — each loop is a Muster schedule + run with its own
  token budget, evidence trail, and kill switch. Loops are data: list, diff,
  pause, replay (`hc loop list/pause/replay`).
- `frappe_script_propose`: server/client script drafts with a dry-run diff of
  affected records — never applied without explicit approval.
- Every generated artifact carries provenance and an eval fixture, so a site
  upgrade that breaks a loop is caught by `hc evolve`, not by users.

## 5. Embeddable everywhere

One contract, three transports:
- `<script>` snippet for classic Desk
- npm package `@musterhq/frappe-surface` for Vue/React SPAs (Helpdesk,
  Gameplan, ChatNext, custom apps) — 0 deps, emits ContextObjects + renders
  an optional headless chat/drawer primitive (BYO styling)
- REST/WS bridge for server-side surfaces (Telegram/WhatsApp federation,
  already proven on the OpenClaw gateway)

## Build order (each a PR slice with tests)
1. `frappe-surface` types + ContextObject ingestion endpoint in core (screen
   context as perishable session memory) + simulator fixture for tests
2. Port customization-context + identity tools from frappe2-openclaw-gateway
   into the pack (loader: HC-012)
3. Desk snippet + SPA package (observe-only v1)
4. Workflow Loop Studio: loop_create on top of `hc schedule` + approval gates
5. OxygenHR pilot: Pradip's 158-case workbook as the pack's eval suite
