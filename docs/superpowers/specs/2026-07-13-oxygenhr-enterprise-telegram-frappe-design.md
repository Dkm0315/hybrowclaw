# OxygenHR Enterprise Channel And Frappe Design

Status: implementation contract, not a readiness claim.

## Objective

Connect Telegram, Google Chat, Slack, and NextAI to one lightweight Muster control plane while Frappe remains the identity, permission, workflow, and record authority. Direct answers should normally arrive in under three seconds. Longer work must be durable, visible, steerable, and return verified Frappe record or private File links.

The design is reusable for customized Frappe deployments. OxygenHR is the proving environment, not a hardcoded product boundary.

## Evidence Baseline

The OxygenHR UAT site currently contains 1,764 DocTypes, 4,215 Custom Fields, 959 Property Setters, 135 Funnels, 6,059 Funnel Definition nodes, 7,309 Funnel Tasks, 112 Flow Config rows, 61 Dynamic User Assignment groups, and multiple custom HR, payroll, recruitment, leave, attendance, expense, helpdesk, and studio apps.

The current administrator session is not a valid RBAC baseline because it has broad cross-department roles. Release evidence therefore requires separate users for an unlinked sender, employee, manager or HRBP, specialist, and system manager.

Static review found concrete fail-open or permission-bypassing paths in NextAI and several deployed custom apps. Muster must not call those paths merely because they are convenient. Native permission-aware Frappe reads, workflow APIs, and canonical document operations remain the enforcement path.

## Non-Negotiable Invariants

1. A channel identity never grants Frappe access by display name, phone number, resource id, or email alone.
2. Telegram and Slack require pairing followed by Frappe OAuth. Google Chat requires a platform-verified email plus an exact enabled Frappe User or unambiguous active Employee mapping.
3. A Frappe User is the authentication principal. Employee mapping has explicit zero, one, and multiple-match outcomes; multiple matches fail closed.
4. Every read is authorized and hydrated as the same Frappe user at request time. A search index may return candidate identifiers, never authoritative record data.
5. Every mutation follows `resolve -> preflight -> canonical diff -> approval -> revalidate -> execute -> verify -> receipt`.
6. A timeout after dispatch is `unknown`, never `failed` or safe to retry. Reconciliation precedes retry.
7. Memory, cache, token ledger, rate limits, approvals, artifacts, and provider sessions are scoped by tenant, site, user, pairing, and conversation.
8. Frappe artifacts are private Files by default. A successful response includes the real record route or private File route and a delivery receipt.
9. No internal chain-of-thought is exposed. Real provider text, provider-supported reasoning summaries, tool events, elapsed time, and evidence are shown without invented progress.
10. A feature is not release-ready until its negative cases and live evidence pass.

## Channel Identity Flow

### Telegram And Slack

1. The sender starts a conversation and receives a short pairing challenge.
2. An operator approves the channel sender once.
3. `/connect` creates a 256-bit state and PKCE S256 verifier, then returns a one-tap OxygenHR authorization link.
4. Frappe shows its normal login and consent screen using the dedicated `Muster OxygenHR Gateway` OAuth Client.
5. The Frappe callback stores only the one-time authorization code keyed by a hash of state, with a five-minute TTL.
6. Muster consumes the code once, exchanges it with PKCE, resolves OpenID profile, roles, and Employee cardinality, then encrypts tokens at rest.
7. Muster binds the Frappe identity to the existing channel pairing. A sender cannot be silently rebound to another site or user.
8. Role, Employee, and permission generations are revalidated before sensitive reads, before every write, after revocation, and on bounded cache expiry.

The OAuth callback terminates at Muster's HTTPS gateway endpoint. The exact same callback URI must be registered in the Frappe OAuth Client and used during authorization and token exchange; a stable ingress or managed tunnel is therefore required.

### Google Chat

Google-signed requests provide the actor email. The exact normalized email must match an enabled Frappe User or one active Employee mapping. The Workspace domain allowlist is defense in depth, not authorization. Users outside the configured Workspace domain are denied even if the Chat app is externally reachable.

### NextAI

NextAI submits a signed, permission-filtered turn envelope and receives an asynchronous run handle. It never forwards raw session cookies, CSRF tokens, or privileged service-user credentials. Frappe imports verified artifacts as private Files and renders their actual links.

## OAuth And Secret Storage

- OAuth Client: `Muster OxygenHR Gateway`
- Flow: Authorization Code with PKCE S256 and explicit consent
- Scope: `all openid`
- Redirect: the OxygenHR-hosted one-time callback
- Telegram bot token: gateway secret only; never stored in OAuth Client
- OAuth client secret: encrypted or mode-0600 gateway secret; never committed
- Access and refresh tokens: AES-256-GCM encrypted with a separate mode-0600 master key
- Pending state: hashed lookup key, five-minute TTL, one-time consumption
- Logs and receipts: fingerprints only; never tokens, codes, state, cookies, or raw secrets

## Request Planes

### Plane 1: Deterministic Fast Path

Use for greetings, identity, command menus, current limits, token ledger summaries, exact record ids, metadata, exact counts, and simple permission-aware filters. No provider call. Target p95: 100-650 ms depending on live authorization.

### Plane 2: Indexed Frappe Retrieval

Resolve user language through exact aliases, FTS/BM25, scoped terminology, then the DocType/Link/Dynamic Link/Funnel/workflow graph. Search results contain identifiers and evidence versions. Frappe hydrates the final records as the user. No arbitrary fallback to the first DocTypes.

Target p95: 1.8 seconds for live list/get and under three seconds end to end.

### Plane 3: Provider Synthesis

Use only when deterministic data still needs explanation, comparison, drafting, or ambiguity resolution. Load only the top relevant tool schemas and bounded, permission-filtered evidence. Preserve the provider's natural answer and streaming output. Cut off or degrade gracefully when the provider cannot meet the route budget.

### Plane 4: Durable Heavy Work

Reports, large office artifacts, multi-document changes, Funnel workflows, and long analysis become durable operations with an operation id, state, checkpoints, idempotency key, cancellation, and recovery. Telegram shows real stage updates and elapsed time. The final receipt lists records read or changed, links, artifacts, policy decisions, provider/model, tokens, and verification outcome.

## Retrieval And Cache Model

Cache entries bind to site, user, Employee, roles hash, permission hash, schema generation, workflow generation, data version or evidence hashes, normalized query, policy version, provider route, and tool manifest.

Separate caches:

- immutable schema and effective Meta
- alias and graph indexes
- exact permission-safe query results with short TTL
- provider prefix or session cache
- evidence-bound answer cache for read-only, low-risk questions

Never cache mutation results, unresolved references, sensitive exports, or records without evidence versions. Any role, User Permission, share, workflow, Custom Field, Property Setter, Dynamic User Assignment, or relevant document change invalidates only dependent generations.

## Permission-Safe CRUD

Reads use permission-aware list/get methods, not `get_all` and not the incompatible `frappe.client.has_permission` preflight currently used by the pack.

Create and update flows discover effective mandatory fields, Property Setters, field permissions, workflow state, and server-side validations before prompting. The user receives a humane missing-information form. Before dispatch, Muster binds approval to the actor, operation, canonical payload hash, expected `modified`, schema/workflow/auth generations, and idempotency key.

Post-write verification compares requested fields, untouched protected fields, child rows, `modified`, `docstatus`, workflow state, assignments, shares, and hook side effects. Submit, cancel, delete, and workflow actions retain their native Frappe semantics.

Every successfully referenced record includes its canonical Desk or web-app route.

## Funnel And Workflow Rules

Funnel discovery includes only published definitions the current user can execute. Muster does not switch to a System Manager Funnel user before authorization. Stored Python, dotted-path execution, unrestricted HTTP, and ignore-permission actions are privileged-code capabilities and require explicit policy plus a trusted operator role.

Dynamic User Assignment is recalculated server-side in the same transaction or revalidated immediately before execution. Inactive Employees, stale memberships, and duplicate assignments fail closed.

## Progress UX

The channel should show useful state, not slogans:

- Checking your OxygenHR access
- Finding the relevant records
- Validating required fields and workflow state
- Waiting for approval
- Running the approved action
- Verifying the saved record
- Creating and validating the document
- Uploading a private File

Provider text deltas and provider-supported reasoning summaries may stream unchanged. Tool names, bounded arguments, results, and errors are summarized truthfully. Private reasoning is never requested or rendered. The typing signal is refreshed for the entire active run.

A second message can be queued, used to steer the active operation when supported, or rejected by policy. It must never create a duplicate run.

## Link And Artifact Contract

Final replies distinguish:

- `Records used`: canonical Frappe routes
- `Records changed`: canonical Frappe routes plus before/after receipt
- `Files`: private Frappe File routes or native channel uploads
- `Run`: durable operation id and status route where available

Office documents are produced by the selected provider/tool path, structurally and visually validated, imported as private Files, then attached or linked. A local filesystem path is not successful delivery.

## Latency And Accuracy Gates

- deterministic metadata/alias p95 <= 100 ms
- indexed retrieval plus live authorization p95 <= 650 ms
- live list/get p95 <= 1.8 s
- direct user answer p95 <= 3 s
- write preflight p95 <= 2 s
- commit plus verification p95 <= 5 s, excluding known Frappe job duration
- target resolution top-1 >= 97%, Recall@5 >= 99.5%
- permission-scoped record precision and recall >= 99%
- false allow, forbidden field, cross-user cache leak, stale authorization, and duplicate mutation: zero

The token ledger records setup, identity, retrieval, cache, provider TTFT, generation, tools, persistence, delivery, retry, and total latency separately.

## Release Evidence

Required rings:

1. deterministic unit and integration regression
2. temporally fresh UAT read-only differential tests
3. disposable-clone mutation, workflow, race, chaos, and adaptive security tests
4. production canary with bounded permissions and rollback

Telegram validation must cover unlinked, inactive, duplicate-Employee, employee, manager or HRBP, specialist, and system-manager identities; slash commands and drilldowns; permission-denied reads; mandatory-field CRUD; workflow/Funnel approvals; rate limits; cache revocation; concurrent turns; retries; large DOCX/PDF/XLSX/PPTX creation; private links; and role revocation during a paused run.

No screenshot, mocked permission response, zero exit code, or administrator-only run is sufficient evidence.
