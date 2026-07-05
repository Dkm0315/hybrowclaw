# Muster Deep Completion Execution Spec

Date: 2026-07-03

Status: execution contract for same-day worker threads and convergence review.

This document defines the depth bar for the next Muster push. It is not a
marketing roadmap. It is the engineering contract for completing the current
product slice deeply enough that Slack, Telegram, Frappe/ERPNext, artifacts,
memory, channels, and governance behave as one coherent harness.

The most important rule:

> No feature is complete because a command exists. It is complete only when a
> real user can set it up, understand the impact, authenticate safely, verify
> it, run a real sample, observe progress, receive the result, and inspect
> evidence without secrets or false positives.

The second most important rule:

> Do not break what is already flawless. Stable setup paths, existing channel
> responses, artifact creation, token-ledger behavior, memory boundaries, and
> TUI flows must be preserved unless a concrete bug is reproduced and fixed
> with a focused test.

## 1. Product Objective

Muster should become the governed agentic framework that an enterprise can run
across channels, apps, providers, memory, plugins, MCPs, and Frappe/ERPNext
without losing control of identity, data scope, token spend, artifacts, or
audit evidence.

The open-source personal harness must remain fast. The enterprise depth should
not slow down a single user running Muster locally like a personal assistant.

The working product promise for this pass:

> A user can connect Muster to Slack and Telegram, ask real work questions,
> trigger provider-generated artifacts, see progress while the run is alive,
> receive documents back in-channel, and use a deep Frappe/ERPNext pack that
> understands site metadata, permissions, installed apps, DocTypes, fields,
> workflows, reports, customizations, and docs context.

## 2. Current Baseline From The Codebase

Existing assets that must be preserved and built upon:

- `docs/SURFACE_GATEWAY_SPEC.md` defines one surface envelope for chat apps
  and frontends.
- `packages/gateway/src/server.ts` already has:
  - pairing challenge and approval flow,
  - scoped gateway dispatch,
  - Slack and Telegram delivery paths,
  - channel progress text,
  - Telegram `sendChatAction` typing loop,
  - Slack progress message update loop,
  - `MEDIA:` artifact extraction,
  - Slack file upload fallback behavior,
  - Telegram document upload behavior.
- `capability-packs/slack/manifest.json` and
  `capability-packs/telegram/manifest.json` describe channel setup packs.
- `capability-packs/frappe/manifest.json` already declares implemented tools:
  - `frappe_identity_resolve`
  - `frappe_semantic_data_resolve_lite`
  - `frappe_records_create`
  - `frappe_docs_context`
  - `frappe_context_setup_plan`
  - `frappe_context_build`
  - `frappe_installed_context`
  - `frappe_module_context`
- `capability-packs/frappe/FRAPPE_SURFACE_SPEC.md` describes the deeper Frappe
  surface vision: screen context, customization context, per-employee memory,
  workflow loop studio, and embeddable surface.
- `packages/cli/test/cli.test.ts` already contains channel setup, status,
  doctor, workflow, artifact, and QA scorecard coverage.
- `docs/RELEASE_TRAIN.md` requires artifact-backed QA and Frappe-2 evidence
  before release claims.

The known gaps:

- Slack and Telegram are connected enough to respond, but not yet polished
  enough for long, artifact-heavy, human-facing production workflows.
- Progress and typing UX is not reliable enough across channels. Users can
  think the bot is dead during long runs.
- Artifact return paths are still too dependent on local files and missing
  Slack scopes or gateway hosting.
- Frappe context is promising but not deep enough to call it complete. It needs
  site induction, DocType graph retrieval, permission snapshots, docs context,
  installed-app awareness, and role-safe test coverage.
- The current setup paths are still too technical in places. A normal user
  should not need to understand every webhook, token, and flag before the first
  successful run.

## 3. Definition Of Complete

Every slice below must satisfy the same lifecycle:

1. Pick
   - User chooses a channel, plugin, MCP, artifact workflow, or Frappe site.
   - Muster explains what it will be able to read, write, spend, and remember.

2. Configure
   - User provides only the minimum required credentials.
   - Optional advanced fields exist but are not required for the happy path.
   - Secrets are never printed back.

3. Verify
   - Muster runs local validation and live validation when credentials allow it.
   - It reports pass, warning, or blocked with a next action.
   - A warning is not reported as ready.

4. Enable
   - Gateway or pack is enabled only after required checks pass.
   - If a daemon, socket mode, webhook, or hosted URL is needed, Muster says so
     plainly and starts or points to the correct command.

5. Run Sample
   - Muster runs a realistic sample that exercises identity, memory, provider,
     progress, and artifact behavior where applicable.
   - The sample creates evidence artifacts.

6. Observe
   - Long runs show typing/progress updates.
   - The user sees what is happening without seeing irrelevant internal jargon.

7. Deliver
   - Text response returns in the correct channel/thread/chat.
   - Artifacts return as file upload where possible, hosted URL where required,
     or honest local path fallback with remediation.

8. Audit
   - The run is recorded with token ledger, surface identity, pairing, model,
     memory retrieval decision, artifacts, and delivery status.
   - QA scorecard can consume the evidence.

## 4. Slack Depth Bar

### 4.1 Setup UX

Slack setup must support two modes:

1. Socket Mode happy path
   - Required inputs:
     - Slack bot token
     - Slack app-level token
   - Recommended scopes:
     - `app_mentions:read`
     - `chat:write`
     - `channels:history`
     - `im:history`
     - `im:write`
     - `files:write`
   - No public URL required.
   - Best for local demos and private workspaces.

2. HTTP Events API hosted path
   - Required inputs:
     - Slack bot token
     - signing secret
     - public HTTPS gateway URL
   - Best for deployed gateways.

Muster should not ask for every Slack value by default. The command path should
begin with:

```bash
muster channels ready slack
```

If tokens are missing, it should move into guided setup:

```bash
muster channels setup slack
```

The setup output must say:

- what the Slack app can read,
- what it can write,
- whether it can upload files,
- whether it uses Socket Mode or Events API,
- how to verify it,
- how to run a sample,
- what is blocked.

### 4.2 Runtime UX

Slack runtime must support:

- app mention in channel,
- direct message,
- threaded replies,
- pairing challenge,
- progress message updated every few seconds,
- final response replacing or completing the progress state,
- file upload for artifacts when `files:write` exists,
- clear scope warning when `files:write` is absent,
- channel-safe memory retrieval only when needed.

The progress message should not repeatedly say "Muster". It should say what is
happening:

```text
Processing · 9s
1. Checking the request
2. Looking up scoped memory
3. Preparing artifact route
4. Running the provider
5. Will verify and attach generated files
```

Slack must not spam multiple progress messages for one run. It should create
one progress message and update that message.

### 4.3 Artifact UX

Slack artifact delivery must be truthful:

- If native upload succeeds, post the file.
- If native upload fails due to missing `files:write`, tell the user exactly
  which scope is missing and how to fix it.
- If the artifact is a hosted URL, post the URL.
- If the artifact exists only on the gateway machine, say that the file was
  created locally and cannot be attached until upload scope or hosting is
  configured.

Slack must support real tests for:

- PDF over 10 pages,
- DOCX,
- PPTX,
- XLSX,
- Markdown fallback,
- large response plus artifact,
- provider-generated artifact content,
- artifact path that does not exist,
- missing file upload scope.

## 5. Telegram Depth Bar

### 5.1 Setup UX

Telegram setup should be much simpler than it was:

Required happy-path inputs:

- bot name,
- bot token.

Optional advanced inputs:

- webhook public URL,
- webhook secret token,
- polling/daemon preference,
- progress mode,
- artifact hosting base URL.

The user should be able to run:

```bash
muster channels ready telegram --name <bot-name> --bot-token <token>
```

or guided:

```bash
muster channels setup telegram
```

Muster should explain:

- bot identity,
- webhook vs daemon polling,
- whether the gateway is currently running,
- whether the bot can call `getMe`,
- how to send a sample message,
- how pairing works.

### 5.2 Runtime UX

Telegram runtime must support:

- private chat,
- group mention or reply when supported by Bot API settings,
- pairing challenge,
- `sendChatAction` typing heartbeat while provider runs,
- progress message edit for long operations,
- final response,
- document upload via `sendDocument`,
- honest fallback if local path cannot be attached.

Typing heartbeat is not optional for long runs. If Telegram does not display
typing, tests must capture whether `sendChatAction` was called and why it did
not show in the client.

### 5.3 Stray Message Isolation

The bug where Telegram randomly sends unrelated Redis/Jedis or OSS manager
content must be treated as a serious isolation defect.

The required behavior:

- Every inbound Telegram update must map to a conversation id and sender id.
- Delivery idempotency must prevent replayed updates from re-running.
- Active runs must be isolated by conversation lane.
- A stale run cannot post into a newer chat unless it belongs to the same
  conversation id and delivery chain.
- Unknown or unpaired sender gets only pairing instructions.
- Old provider output cannot leak into a current Telegram conversation.

Tests must include:

- two chats sending messages at the same time,
- stale update replay,
- unpaired sender,
- paired sender,
- long artifact run followed by normal message,
- provider error followed by retry,
- gateway restart with queued update.

## 6. Shared Channel Execution Model

Slack and Telegram should use the same internal state machine:

```text
inbound event
  -> normalize SurfaceMessage
  -> idempotency check
  -> pairing resolution
  -> lane lock or queue
  -> progress start
  -> command/tool fast path when possible
  -> provider run
  -> artifact extraction
  -> artifact delivery
  -> final channel response
  -> ledger and evidence write
  -> progress stop
```

The state machine must expose explicit delivery status:

```ts
type ChannelDeliveryStatus =
  | "acknowledged"
  | "pairing_required"
  | "progress_started"
  | "provider_running"
  | "artifact_created"
  | "artifact_uploaded"
  | "artifact_hosted"
  | "artifact_local_only"
  | "completed"
  | "failed";
```

The channel adapter should not decide memory policy, provider policy, or
artifact content. It only maps channel API events into the gateway contract and
maps replies back to the channel.

## 7. Artifact And Office Depth Bar

Artifact creation must be provider-led where the user asked for rich content.
Muster should not generate shallow placeholder documents simply to satisfy the
file extension.

Supported formats for this pass:

- PDF
- DOCX
- PPTX
- XLSX
- Markdown

Supported origin modes:

1. Provider-generated content
   - The provider receives the user request and produces the report, brief,
     deck outline, workbook data, or narrative.
   - Muster handles file writing, validation, and delivery.

2. Harness-created structured artifacts
   - Useful for deterministic scorecards, ledgers, QA reports, and tables.
   - The generated content must be based on source data, not filler.

3. Existing file handoff
   - User asks channel bot to package, convert, or send an existing file.

Every artifact must have:

- path or URL,
- mime type,
- title,
- source prompt,
- created-by provider/runtime,
- validation status,
- delivery status,
- visible user-facing summary,
- ledger link.

Minimum test artifacts:

- a 10+ page PDF describing Muster features and evidence,
- a PPTX for CTO demo,
- an XLSX feature battlecard or token report,
- a DOCX implementation brief,
- one artifact generated from a Slack prompt,
- one artifact generated from a Telegram prompt,
- one failure case for missing Slack `files:write`,
- one failure case for Telegram local file read failure.

## 8. Frappe / ERPNext Depth Bar

The Frappe pack must become a real vertical pack, not a generic REST wrapper.
The target is:

> A Frappe/ERPNext site-aware assistant that understands DocTypes, fields,
> roles, workflows, installed apps, customizations, reports, scripts, modules,
> docs, permissions, and artifacts while preserving Frappe as the authority for
> authorization.

### 8.1 Setup

The setup flow must support:

- site URL,
- API key/secret token or admin login-derived token flow,
- optional docs URLs,
- optional installed app source paths,
- optional module selection,
- optional safe-write mode,
- optional artifact destination.

Minimum command:

```bash
muster plugins setup frappe
```

The setup plan must explain:

- what the pack can read,
- what the pack can write,
- which user identity it uses,
- whether writes require approval,
- what data is indexed locally,
- where context is stored,
- how secrets are stored,
- how to remove the site.

### 8.2 Site Induction

Frappe context build must index:

- site identity,
- Frappe version,
- ERPNext version if installed,
- installed apps and versions,
- modules,
- workspaces,
- DocTypes,
- fields,
- field types,
- links,
- child tables,
- naming series,
- permissions,
- roles,
- workflows,
- workflow states and transitions,
- reports,
- print formats,
- dashboards,
- server scripts,
- client scripts,
- custom fields,
- property setters,
- web forms,
- notification rules,
- assignment rules,
- hooks where accessible,
- app docs and public docs.

The index should not live in the main binary. It belongs to the Frappe pack and
is stored as scoped context objects or a pack-local SQLite index.

### 8.3 Hybrid Retrieval

Frappe retrieval must combine:

1. lexical search over names, labels, fields, modules, reports, and scripts,
2. structured lookup by DocType, field, module, role, workflow, and app,
3. graph traversal across:
   - DocType -> field,
   - DocType -> child table,
   - DocType -> linked DocType,
   - role -> permission -> DocType,
   - workflow -> state -> transition -> role,
   - app -> module -> DocType,
   - report -> reference DocTypes,
   - custom field/property setter -> target DocType,
4. docs retrieval for Frappe, ERPNext, and installed Frappe Suite apps,
5. permission filtering before context is shown to the model.

The model should receive a compact context packet:

```text
question intent
allowed site scope
candidate DocTypes
candidate fields
relevant permissions
relevant workflows
relevant reports/scripts/customizations
docs references
safe action options
blocked permissions
```

### 8.4 Query Classes

The pack must classify Frappe prompts into at least these classes:

- schema question,
- field question,
- permission question,
- workflow question,
- report question,
- customization question,
- installed app question,
- docs question,
- record lookup,
- record creation,
- record update,
- artifact generation,
- troubleshooting,
- migration/custom app impact,
- role-safe management summary.

Each class must have a different retrieval strategy. A payroll permission
question must not retrieve generic docs first. A field question must retrieve
DocType metadata first. A workflow question must retrieve state transitions and
allowed roles first.

### 8.5 Safe Writes

Frappe writes must be approval-gated unless the command explicitly runs in a
trusted test fixture.

Safe write flow:

```text
user request
  -> resolve identity
  -> classify write intent
  -> permission preflight
  -> build proposed mutation
  -> show dry-run summary
  -> approval gate
  -> execute through Frappe API
  -> verify result
  -> record evidence
```

The assistant must never bypass Frappe permissions. If Frappe denies the user,
Muster reports the permission boundary instead of retrying as admin.

### 8.6 Frappe Artifacts

The Frappe pack must support artifacts from live or fixture data:

- implementation brief,
- permission audit,
- customization impact report,
- workflow transition matrix,
- DocType field dictionary,
- module summary,
- support-ticket triage report,
- token/cost report for Frappe users,
- Excel workbook for feature or data comparison,
- PDF management report,
- PPTX stakeholder deck.

Each artifact must link back to:

- site,
- user,
- prompt,
- data query,
- DocTypes used,
- permission scope,
- generated file,
- delivery channel.

### 8.7 Frappe Tests

Required tests:

- setup plan without credentials,
- setup plan with credentials redacted,
- site identity probe,
- installed apps probe,
- DocType metadata fixture,
- custom fields fixture,
- property setter fixture,
- workflow fixture,
- report fixture,
- role permission allow,
- role permission deny,
- docs context retrieval,
- module context retrieval,
- query classification for all query classes,
- safe create dry-run,
- safe create approval,
- denied write,
- artifact generation from Frappe fixture,
- memory isolation between two Frappe users,
- Frappe-2 live prompt regression.

Frappe-2 live regression must include prompts such as:

- "Which installed apps are present on this site?"
- "Explain the fields and permissions for a selected DocType."
- "What workflow transitions are available for this role?"
- "Generate a PDF summary of this module's key DocTypes."
- "Create a safe draft record and show me the approval gate."
- "Why would this user not be allowed to access this document?"

## 9. Memory And Personalization Rules

Memory must be invoked only when useful. Channel prompts like "hi" or "list the
current folder" should not automatically inject old context.

Memory recall policy:

- recall if the prompt references prior work, named session, preference,
  remembered facts, Frappe user state, project handoff, or previous decisions;
- do not recall for simple greetings, status commands, setup commands, or
  deterministic tool calls;
- show a short progress line only when memory was actually searched;
- record whether recall was skipped and why in the run receipt.

Shared/team memory for enterprise must be gated by:

- tenant,
- workspace/project,
- role,
- user,
- channel pairing,
- session,
- explicit handoff approval.

## 10. Enterprise Assistant Depth

Enterprise-only assistant configuration must support:

- department assistant type:
  - HR,
  - Finance,
  - Sales,
  - Support,
  - Engineering,
  - Frappe Admin,
  - CTO/CFO oversight,
- response style:
  - concise,
  - detailed,
  - evidence-first,
  - executive summary,
  - technical runbook,
  - non-technical explanation,
- allowed providers and models,
- allowed tools and MCPs,
- allowed channels,
- memory scopes,
- token budget,
- rate limits,
- approval thresholds,
- artifact permissions,
- Frappe site permissions,
- escalation rules.

This belongs behind an enterprise license module. The open-source personal path
must not pay a runtime cost for enterprise checks.

## 11. QA And Evidence Gates

No worker thread may claim completion unless it returns:

- files changed,
- tests added,
- commands run,
- evidence artifact path,
- live Slack result if channel work touched Slack,
- live Telegram result if channel work touched Telegram,
- Frappe fixture or Frappe-2 result if work touched Frappe,
- screenshots/video only as supporting evidence, never as the only proof,
- list of known misses.

Minimum command gates:

```bash
pnpm --filter @musterhq/core test
pnpm --filter @musterhq/gateway test
pnpm --filter @musterhq/cli test
pnpm --filter muster-website build
muster qa scorecard --strict-release
```

Minimum live gates:

```bash
muster channels doctor slack --live
muster channels doctor telegram --live
muster channels simulate slack --message "generate a PDF feature brief"
muster channels simulate telegram --message "generate an Excel token report"
muster qa run frappe2_real_prompts --artifact-dir <dir> --evidence <file>
```

If live credentials or external services block a test, the worker must mark it
blocked with exact missing dependency. It must not downgrade the test to a smoke
test and call it complete.

## 12. Worker Thread Topology

This pass should run as multiple vertical worker threads plus one convergence
thread.

### Thread A: Slack And Telegram Runtime Depth

Mission:

- Fix progress/typing UX.
- Fix pairing and stray-message isolation.
- Make setup one-command where possible.
- Verify real Slack and Telegram messages.
- Produce raw live results.

Owned areas:

- `packages/gateway/src/server.ts`
- `packages/gateway/src/adapters/slack.ts`
- `packages/gateway/src/adapters/telegram.ts`
- `packages/gateway/test/adapters.test.ts`
- `packages/cli/src/index.ts`
- `packages/cli/test/cli.test.ts`
- `capability-packs/slack`
- `capability-packs/telegram`

Exit evidence:

- Slack live setup and response transcript.
- Telegram live setup and response transcript.
- Long-run heartbeat proof.
- Artifact delivery proof.
- Secret redaction proof.

### Thread B: Frappe / ERPNext Deep Pack

Mission:

- Complete the Frappe pack as a vertical context system.
- Implement or harden site induction, DocType graph, permission snapshots,
  docs/app context, query classification, and safe write gates.
- Prove Frappe-2 prompts.

Owned areas:

- `capability-packs/frappe`
- Frappe-related tests in `packages/core/test/integration-packs.test.ts`
- CLI setup surfaces for plugins/integrations if needed.
- Frappe docs and QA artifacts.

Exit evidence:

- Frappe fixture tests.
- Frappe-2 live prompt transcript.
- Permission allow/deny proof.
- DocType graph retrieval proof.
- Frappe artifact generation proof.

### Thread C: Office Artifacts And Delivery

Mission:

- Make PDF/DOCX/PPTX/XLSX artifact workflows deep enough to demo.
- Ensure provider-generated content can become files and return to channels.
- Validate long documents and readable workbooks/decks.

Owned areas:

- `packages/core/src/artifacts.ts`
- artifact CLI paths in `packages/cli/src/index.ts`
- artifact tests in core/CLI
- channel artifact delivery hooks where needed.

Exit evidence:

- 10+ page PDF.
- DOCX implementation brief.
- PPTX CTO demo deck.
- XLSX token/report workbook.
- Slack delivery proof.
- Telegram delivery proof.

### Thread D: Enterprise Assistant And Memory Governance

Mission:

- Design and, where feasible, implement the configuration primitives for
  department assistants, response style, memory scopes, budgets, and licensing
  seams without slowing personal mode.

Owned areas:

- config/types in core,
- memory policies,
- docs/specs,
- tests for hot-path speed and scope checks.

Exit evidence:

- assistant config schema.
- memory recall decision tests.
- personal-mode no-license hot-path proof.
- enterprise-only feature gate design.

### Thread E: Heavy Thinker Convergence

Mission:

- Review A-D as a product architect, QA lead, and CTO skeptic.
- Reject shallow completions.
- Merge concepts into one release plan.
- Produce final release readiness report.

Review checklist:

- Does this work for a non-technical user?
- Does this work for a CTO demo?
- Does this preserve provider-agnostic architecture?
- Does it avoid secret leaks?
- Does it avoid memory leaks?
- Does it avoid false positives?
- Does it have live Slack/Telegram/Frappe evidence?
- Does it degrade honestly when scopes, URLs, or credentials are missing?
- Does it keep personal Muster fast?

## 13. Same-Day Execution Order

1. Freeze this document as the coordination contract.
2. Spawn worker threads A-D.
3. Spawn convergence thread E.
4. Workers inspect current code and produce implementation changes on separate
   branches or local task branches.
5. Each worker returns:
   - concise summary,
   - changed files,
   - evidence,
   - known misses,
   - exact commands.
6. Convergence thread reviews all outputs and flags what is release-blocking.
7. Main thread integrates accepted changes.
8. Run full test suite and live tests.
9. Update changelog and release notes only for evidence-backed claims.

## 14. Non-Negotiables

- Do not hide behind "setup guidance" when a real setup workflow is required.
- Do not call a pack complete if it has no auth path, no verification, and no
  failure behavior.
- Do not claim Slack artifact support if `files:write` is missing and the user
  is only given a local path.
- Do not claim Telegram typing support unless `sendChatAction` is called and
  the client behavior is verified or the limitation is explained.
- Do not let a stale channel run post unrelated content into a conversation.
- Do not let Frappe read/write actions bypass Frappe's own permissions.
- Do not inject memory when the prompt does not need memory.
- Do not let enterprise licensing slow down personal open-source runs.
- Do not release without Frappe-2, Slack, and Telegram evidence for the slices
  touched in this pass.

## 15. Success State

This pass is successful when a CTO can watch or personally try the following:

1. Fresh setup path for Slack.
2. Fresh setup path for Telegram.
3. Pairing works.
4. A normal question gets a fast answer.
5. A long artifact request shows progress.
6. PDF/DOCX/PPTX/XLSX artifacts are generated and delivered or truthfully
   reported with fix instructions.
7. Frappe context setup runs.
8. Frappe prompts answer with DocType, permission, workflow, installed-app, and
   docs awareness.
9. Token ledger and evidence show what happened.
10. QA scorecard distinguishes proven, partial, and blocked work honestly.
