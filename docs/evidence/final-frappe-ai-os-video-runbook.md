# Muster Frappe AI OS — final continuous video runbook

Status: release-gated. Do not record the final take until every precondition below is green.

## Non-negotiable presentation contract

- One continuous, normal-speed demonstration with chapters; no sped-up implementation, hidden cuts, seeded outcomes presented as live work, or API-only proof.
- The master take begins in the real Muster TUI and reaches Chrome through the product's own browser-opening handoff. Do not stop, splice, or replace the capture at the terminal-to-browser boundary.
- Human-level pacing is mandatory: record at 1×, keep typed prompts readable, leave route transitions and filled forms visible long enough to inspect, and pause naturally at questions, approvals, denials, loading states, and verification receipts.
- Record terminal and browser at 1440×900 or higher. Mobile chapters use a named phone viewport and return to desktop visibly.
- Cursor movement, clicks, typing, route changes, field values, approvals, denials, and verification remain readable.
- Autonomous UI interactions display `Muster is controlling this work session` beside a distinct Muster cursor/halo.
- The cursor/halo and takeover label must be emitted by the running product UI and move with the real interaction target; post-production cursor animation cannot stand in for browser control.
- Server-side operations display `Muster is working server-side`; approval pauses display `Waiting for you`; manual interaction displays `User control`.
- The main Desk remains usable while the autonomous session runs in a dedicated live-work viewport.
- Every asserted result has a RunEvent, immutable receipt/evidence id, actor, tenant/site, permission epoch, plan hash, and independent postcondition read.
- Never expose passwords, API secrets, bearer/HMAC/webhook tokens, provider keys, chain-of-thought, or raw private prompts in the recording.

## Release preconditions

- MariaDB production-style site; SQLite is forbidden for the final claim.
- Stable public HTTPS origins for Frappe and Muster; no localhost or ephemeral quick-tunnel origin in the final take.
- Reciprocal Frappe↔Muster binding is initially absent and the gateway registry starts clean.
- Real provider-backed workflow planning is configured. A deterministic/demo planner is forbidden.
- Effectful executor is enabled through the explicit typed Frappe capability registry; arbitrary URLs/code/tool names remain denied.
- Personas, companies, records, SOP/design inputs, and approval policies are reproducibly seeded, but mission outcomes are not.
- All focused, full, adversarial, tenant-isolation, replay, recovery, and load suites pass from a clean restore.

## Continuous story

### 1. Clean terminal onboarding

1. Show `muster doctor`/TUI status: gateway healthy, Frappe not connected, provider ready, no secret values.
2. Type the real command: `muster frappe connect https://<frappe-site> --muster-url https://<muster-gateway>`.
3. TUI shows installed-app discovery, supported protocol/capabilities, and `opening_native_frappe_consent`; it never prints credentials.
4. Browser opens naturally on the Frappe site. If signed out, sign in as Administrator and return to the same consent URL.
5. Review exact Frappe and Muster origins, click `Authorize and connect`, follow PKCE redirect, and return to success.
6. Show Settings/Site Binding become `Trusted` only after reciprocal challenge verification. Show terminal TUI connected status and tenant/site fingerprint (non-secret).

### 2. Prompt-first workflow creation

1. From an ordinary ERPNext Desk page, open global `Ask Muster` without entering the Muster app.
2. Enter a business goal with constraints and approval boundary.
3. Live work view shows provider-backed planning: goal, context, phases, parallel specialists, nested verifier, capabilities, budgets, success checks, approval, and compensation.
4. Open the inert Workflow Proposal. Inspect its human-readable JS artifact and canonical JSON/graph; prove source code was not evaluated.
5. Reject one unsafe proposal/capability escalation, then approve and publish the corrected proposal. Approval alone must not execute.

### 3. Normal RBAC-aware CRUD

1. Sales persona asks Muster to inspect overdue invoices, create a follow-up ToDo/draft, and wait before communication.
2. Labeled Muster cursor navigates Sales Invoice/Customer/ToDo in the isolated work viewport while the user opens another Desk task.
3. Show preflight, exact document/field diff, approval, create/update, postcondition re-read, and evidence receipt.
4. Switch to a restricted persona and repeat a forbidden cross-company/read/write request. Show native Frappe denial and no mutation.
5. Repeat across HRMS and CRM with an Employee/Leave or Lead/Deal example, including a mid-run permission revocation.
6. Enter CRM and Helpdesk through their native Vue interfaces. Ask from the Muster-owned site overlay, then show each external adapter use the existing app router/components without any fork or target-app source modification. Show an unsupported-version case fail closed.

### 4. Business workflow and approvals

1. Request a submit/apply-workflow operation with `expected_modified` concurrency proof.
2. Show available native workflow actions, signed proposal, manager approval, one-shot receipt consumption, state transition, and verification.
3. Replay the approval and show denial. Change the document before execution and show drift rejection/replan.

### 5. Deep customization

1. Prompt for a custom field and Property Setter based on a real business requirement.
2. Show metadata analysis, affected forms/reports/permissions, preview, explicit scoped approval, apply, cache/schema refresh, and form verification.
3. Create a Custom DocType, Workspace/Page, report/chart, print format, Web Form/Page, notification/assignment rule, and safe custom-app code change through separate governed steps.
4. Executable/security/destructive surfaces require dual control or remain visibly denied.
5. Use the resulting UI as two different personas and prove field-level/module/company boundaries.
6. Show the coding ladder explicitly: guided Custom Field for a beginner; controller/hook and Query Report for an intermediate user; patch/migration, Vue/React SPA page, upgrade test and rollback for an advanced developer. Every code case uses a registered app and reviewed diff.

### 6. SOP/design-to-custom ERP

1. Upload a real SOP document and a design/reference file.
2. Show artifact extraction and citations, requirement mapping, ambiguity questions, proposed data model/workflows/RBAC/pages/reports/print outputs, and acceptance tests.
3. Show multiple agents working in parallel: process analyst, Frappe architect, RBAC adversary, UI builder, test verifier, and documentation/artifact agent.
4. Approve bounded implementation phases. Show autonomous coding, migrations, fixtures, tests, browser validation, and compensation/recovery for one intentionally broken change.
5. Operate the finished customized ERP end to end and produce a reviewed office artifact/report from live permission-filtered data.
6. Trace each implemented field, workflow, page, report, print output and test back to cited SOP/PRD passages; show one conflicting requirement pause for clarification and one document-borne instruction rejected as untrusted data.

### 7. Channels, resilience, and closure

1. Pair Telegram from an authenticated Frappe session without generic Muster pairing; execute one read and one approval-bound action as the linked identity.
2. Demonstrate pause, steer, resume, cancel, gateway restart/recovery, idempotent replay, and tenant isolation.
3. Show the evidence registry, hashes, app/site revisions, RBAC coverage matrix, test totals, and remaining production caveats.
4. End on a concise TUI/browser status screen showing connected site, active provider, published workflows, evidence count, and zero unresolved critical failures.

## Invalid take conditions

- Any zero-byte/undecodable or nonstandard-resolution desktop clip.
- Any mission claimed as AI work when the provider/gateway was disconnected.
- Hidden setup that materially changes trust, RBAC, workflow, data, or code.
- A synthetic cursor/video annotation presented as a real autonomous product event.
- An effect without exact actor authority, approval when required, idempotency, independent verification, and evidence receipt.
- Secrets, chain-of-thought, private data outside the stated persona scope, or cross-tenant leakage.

## Required Frappeverse deliverables

- One continuous master MP4 in normal speed with chapter timestamps and readable terminal/browser/mobile UI.
- One evidence manifest mapping every acceptance case to video timestamps, actor, role, site revision, expected/actual result and independent verification.
- A Frappeverse slide deck with the product thesis, architecture, trust model, native-surface strategy, workflow/subagent model, live use cases, failure cases, measured evidence and roadmap.
- The master demonstration embedded in the deck where the presentation format permits it; also include a stable linked copy and QR fallback so venue playback does not depend on live internet.
- Presenter notes, a timed talk track, a short backup clip per major chapter and a PDF export whose links remain usable.

## Frappeverse deck narrative

The deck is a problem-to-proof story, not a feature inventory. Its communication job is: by the end, Frappeverse builders and business operators should believe that AI can safely operate and extend their existing Frappe estate because Muster works through native surfaces, live Frappe authority, reviewable workflows, and visible evidence.

1. **Muster: AI that operates Frappe in front of you** — minimal title and one-line thesis.
2. **Frappe automation still stops at the last mile** — the problem: people translate intent into forms, metadata, scripts, reports, migrations and approvals by hand.
3. **A chatbot or API wrapper cannot own the workflow** — why generic assistants fail: no native UI truth, weak context, hidden authority, no recovery, and no durable proof.
4. **Muster turns intent into governed, visible work** — the solution: one Ask surface for questions, CRUD, workflows, customization and app development.
5. **It works with the Frappe estate you already have** — Desk, ERPNext, HRMS, CRM, Helpdesk and untouched custom Vue/React apps; no target-app fork.
6. **Frappe remains the source of authority** — live RBAC, effective metadata, maker/checker approval, exact revisions, idempotency, compensation and audit evidence.
7. **Live proof: clean install to customized ERP** — frame the question the continuous demonstration will answer and state that the footage is normal speed with no hidden effects.
8. **Embedded continuous demonstration** — the master video is the primary content; keep surrounding slide chrome minimal and provide a local-file plus QR/link fallback.
9. **What the demonstration proved** — map the visible chapters to receipts: onboarding, native CRUD, CRM/Helpdesk/custom app, SOP/PRD customization, coding, recovery, Telegram and RBAC denials.
10. **Agents coordinate; workflows recover** — explain goals, business/module specialists, subagents, fan-out/join, pause/steer/resume and durable recovery using one small architecture visual.
11. **The hard cases are the product** — show real failures discovered and repaired: clarification loops, Frappe DocType skeleton creation, child-row normalization, cache/version drift and permission boundaries.
12. **One operating layer changes how Frappe is implemented** — implications for administrators, developers, partners and business teams; distinguish faster work from ungoverned work.
13. **The next milestone is production-scale adoption** — stable deployment, ecosystem adapters, measured performance, community extension points and the specific audience invitation.

Every slide title must state the point a presenter would say aloud. Implementation inventories, test totals and internal production notes belong in speaker notes or evidence appendix unless they materially prove the current claim.

The slide-ready copy, visual direction, speaker notes, and final-deck release checks are maintained in `docs/evidence/frappeverse-presentation-storyboard.md`.
