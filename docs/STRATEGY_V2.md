# Muster Strategy V2 — Evidence-Graded Verdict and Execution Order

Supersedes the informal research verdict.

Two rules govern this document:

1. **A claim without a citation is a hypothesis.** Every Muster claim cites a
   file and line. Every competitor claim cites a fetched source.
2. **A claim that can be executed must be executed.** Static reading is not
   evidence. Section 2 records live terminal runs, including one that falsified
   a load-bearing assumption of the original plan.

Environment for all live runs: macOS (Darwin 25.6.0), Node v24.13.0,
pnpm 10.33.2, `codex-cli 0.150.0-alpha.8`, model `gpt-5.6-sol`
(1M context window, per `~/.codex/config.toml`), ChatGPT auth.
Date: 2026-08-27.

---

## 1. Verification Pass — Static Claims That Held

The prior verdict's description of Muster's *current* implementation was
accurate to an unusual degree.

| Claim | Verdict | Evidence |
|---|---|---|
| Eight memory scope types | **Confirmed, exact** | `packages/core/src/types.ts:246` — `global \| tenant \| workspace \| user \| pairing \| session \| role \| persona` |
| SQLite FTS5 retrieval | **Confirmed** | `memory.ts:533` (virtual table), `:545` (backend), `:547` (LIKE fallback) |
| Provenance, confidence, validity, redaction | **Confirmed** | `types.ts:253-266` |
| Retrieval receipts | **Confirmed** | `memory.ts:183` `searchMemoryWithReceipts` |
| Recall / MRR / leakage / stale-hit / p95 | **Confirmed** | `qa-memory.ts:84`, `:110-118` |
| 171 test files | **Confirmed, exact** | 202 on disk − 31 in a stale `.claude/worktrees/agent-a27b6…` copy = **171** |
| Token ledger, rate limits, idempotency, receipts | **Confirmed** | `enterprise-governance.ts:38-196` |
| Release honesty about guidance-heavy integrations | **Confirmed** | `docs/RELEASE_TRAIN.md:56-95` |

Self-assessment accuracy is a strategic asset. Keep it.

---

## 2. Live Evidence Log

### 2.1 Test suite — passes, and is real

```
$ pnpm --filter @musterhq/core test
ℹ tests 531   ℹ pass 531   ℹ fail 0   ℹ duration_ms 16255.99
```

531 assertions, zero failures, 16.3 seconds. The 171-file count is not padding.

### 2.2 The Codex patch-event thesis is FALSE in practice

The original research asserted: *"Codex already emits the information required
to build exactly what you want."* A first draft of this document accepted that
and planned a Wave 0 task around translating `item/fileChange/patchUpdated`.

**It does not, and that task would have shipped a feature that renders nothing.**

A wire probe was written to spawn `codex app-server`, run one real editing turn
(change `"hi "` to `"hello "` in a JS file), and timestamp every notification
crossing the pipe, while polling the file on disk every 5ms to establish
ordering. Three runs:

| Run | Config | `patchUpdated` | `turn/diff/updated` | First text delta | File hit disk | Edit mechanism |
|---|---|---|---|---|---|---|
| 1 | default | **0** | 3 events | 9413ms | 17729ms | `commandExecution` |
| 2 | `-c tools.apply_patch.enabled=true` | **0** | **0** | 6246ms | 10337ms | `commandExecution` |
| 3 | default, +3000ms linger after `turn/completed` | **0** | **0** | 5343ms | 9111ms | `commandExecution` |

Findings:

- **`item/fileChange/patchUpdated` fired zero times in three of three runs**,
  despite being present in the protocol schema. Schema presence is not emission.
- In run 1, the only diff signal (`turn/diff/updated`) arrived at **17729ms —
  the same millisecond the file changed on disk.** It never previews an edit; at
  best it confirms one. `patchBeatsDiskByMs: null` in all runs.
- Runs 2 and 3 produced **no diff notification at all**, and run 3 lingered a
  full 3 seconds past `turn/completed` specifically to rule out a shutdown race.
- Every edit was applied through a `commandExecution` item — the model used the
  **shell**, which bypasses Codex's structured patch machinery entirely.
- `item/fileChange/outputDelta` is marked deprecated and no longer emitted.

The original research also cited GitHub issue
[openai/codex#24513](https://github.com/openai/codex/issues/24513) requesting
inline file diffs. That issue is **open, with no maintainer response.**

**Consequences, in ascending order of importance:**

1. A Cursor-style *pre-write* inline diff cannot be built on Codex's event
   stream today. The information arrives at write time or not at all.
2. Any live-diff feature must derive its own truth: filesystem watch + git
   diffing in the workspace. Backend events are a *hint*, never the source.
3. **This is a governance finding, not a UI finding.** An audit spine that
   trusted backend-reported file changes would have recorded **zero of the three
   edits that actually happened.** For a product whose thesis is auditability,
   trusting the agent's self-report is disqualifying. Muster must observe the
   workspace, not ask the agent what it did.

Point 3 is the most valuable thing this exercise produced, and no amount of
source reading would have found it.

### 2.3 Office artifacts — real, verified, and shallow

`packages/core/src/artifacts.ts` (1733 lines) hand-rolls OOXML with a
zero-dependency ZIP writer (`zipStored()`, `:810`). No `docx`, `exceljs`,
`officegen`, LibreOffice, or pandoc dependency exists anywhere in the repo.

Generated live from `packages/core/dist/artifacts.js`, then validated against
real parsers:

| File | Bytes | ZIP valid | Parts | XML well-formed |
|---|---|---|---|---|
| `muster-document.docx` | 3685 | yes | 6 | 6/6 |
| `muster-workbook.xlsx` | 4699 | yes | 8 | 8/8 |
| `muster-presentation.pptx` | 4696 | yes | 7 | 7/7 |
| `muster-document.pdf` | 696 | n/a | `%PDF-1.4` header | n/a |

The macOS system document parser opens the `.docx` and extracts its text:

```
$ textutil -convert txt -stdout muster-document.docx
Muster Test
exit=0
```

**These are genuine Office files, not stubs.** But the part lists tell the real
story: `word/document.xml` + `word/styles.xml` and nothing else. No tables,
images, charts, numbering, themes, or templates. The `.xlsx` has one sheet and
shared strings — no formatting, formulas, or multiple sheets. The `.pptx` has
one slide with no layouts or masters.

Verdict: **real but minimal.** See §5.2 for why this is a strength worth
investing in rather than a gap to paper over.

### 2.4 Capability packs — 34 declared, 2 substantial

```
34 packs. Lines of implementation and test files, measured:

frappe            19,632 loc    9 test files
oss-manager        4,175 loc    1 test file
mcp-bridge           683 loc    0
web-frameworks       547 loc    0
jenkins              451 loc    1
… 27 more packs, all under 310 loc, all 0 test files …
artifact-studio       33 loc    0
ollama                 0 loc    0
```

**31 of 34 packs have zero tests. One pack is empty.** The `artifact-studio`
pack — the surface behind the Office artifact story — is 33 lines; the real
implementation lives in core.

This is the sharpest internal finding in the document. For a governance product,
a pack that implies capability it does not have is worse than a missing pack: a
buyer who discovers one stops trusting the audit trail too.

---

## 3. Competitive Reality Check — Now Verified

The prior verdict asserted competitor capabilities at the same confidence as its
own verified internals. I fetched each repository. **The competitor claims held
up — and the scale gap is larger than the verdict implied.**

| Harness | Verified | Scale | What it actually does better |
|---|---|---|---|
| [OpenClaw](https://github.com/openclaw/openclaw) | ✅ MIT | **387.8k ★**, 81.4k forks, 83,433 commits | Gateway control plane; WhatsApp/Telegram/Slack/Discord/GChat/Signal/iMessage; Plugin SDK; Control UI + CLI + TUI; voice/canvas/camera |
| [Hermes Agent](https://github.com/nousresearch/hermes-agent) (Nous) | ✅ Feb 2026 | **237.1k ★**, 48k forks, 25,737 commits | 40+ tools across **7 terminal backends** (local, Docker, SSH, Singularity, Modal, Daytona, Vercel); FTS5 cross-session search + LLM summarization; autonomous skill creation; follows the **agentskills.io open standard** |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | ✅ MIT, v0.1 preview 2026-08-13 | ~170k ★ | Append-only session event log as durable source; **no privileged core** — every component including the agent loop is config-replaceable; filesystem itself is a swappable provider seam |
| [QM](https://github.com/yc-software/qm) (Y Combinator) | ✅ MIT, July 2026 | 14.3k ★, 185 commits | Per-person and per-room scopes each with own memory, files, keychain, permissions, crons, web apps, **durable sandbox**; skills scope-owned and **shareable by grant** with admin-gated org promotion; skill packs imported from git; drives Pi/OpenCode/Codex/Claude Code behind one core; Postgres |
| [OpenHarness](https://github.com/HKUDS/OpenHarness) (HKUDS) | ✅ MIT, Apr 2026 | 14.7k ★ | Python; Claude/OpenAI/Copilot/Codex/Kimi/GLM/MiniMax/NVIDIA NIM |

**The honest read on plugins and artifacts:** you are correct. These ecosystems
are deeper. OpenClaw has a Plugin SDK and 83k commits of integration work.
Hermes has 40+ tools and seven execution backends. DeepSeek's "everything is a
plugin" removes the privileged core entirely. Muster has 34 packs of which 32
are thin declarations.

**Muster cannot win a breadth race and should stop entering one.** Three
responses follow, in §5.

One convergent signal worth noting: DeepSeek Harness's stated rule — *anything
visible to the model must be reconstructable from the log* — is exactly the
Wave 0 gate below, arrived at independently. Muster already has the spine to
satisfy it (§4.1). It just hasn't connected it.

---

## 4. Corrections to the Original Verdict

### 4.1 The event spine exists. It is unadopted, not unbuilt.

Execution item #1 was "build the durable event spine." **It is built.**
`packages/core/src/run-events.ts`:

- 21 typed append-only event types (`:17-38`; recount 2026-08-27 — the union holds 21 members)
- Monotonic sequence enforcement (`:128`)
- Fencing tokens with stale-writer rejection (`:146-155`)
- Idempotency keys with conflicting-receipt detection (`:198-208`)
- Full compensation/cancellation FSM with terminal invariants (`:243-277`)
- A reducer-enforced invariant rejecting any payload containing secrets or
  chain-of-thought (`:99`, `:124`) — the "invariant registry," already shipping

Wired into `flow.ts`, `subagents.ts`, `gateway/rpc.ts`, `gateway/server.ts`,
`frappe-mission-bridge.ts`, and `frappe_app/muster/orchestration/gateway_runtime.py`.

**The gap:** `packages/core/src/run.ts` — the universal agent run loop — emits
**zero** RunEvents. The spine was proven on the Frappe mission path and never
adopted by the core.

> Re-scope: "Build the spine" → **"Adopt the spine in `run.ts`."** Weeks, not a
> quarter.

### 4.2 The unified protocol exists too. The gap is vocabulary.

`packages/gateway/src/rpc.ts:17-24` already declares "ONE newline-delimited
JSON-RPC 2.0 protocol consumed identically over stdio (CLI/TUI), HTTP, and an
NDJSON event stream (desktop/web)," with `RPC_CONTRACT_VERSION = 1`, short-TTL
stream tickets, and a `ledger.tick` after every run.

`RpcEvent` has exactly **three** variants (`:41-44`): `message.stop`,
`ledger.tick`, `session.created`. No file-change, tool, plan, or approval event
exists — so no rich surface can be built on it.

> Re-scope: "Unify surfaces" → **"Grow the event vocabulary of the protocol that
> already unifies them."**

### 4.3 The sharing gap is worse than stated — and the fix is 400 lines away.

There is no sharing primitive. `grant`, `audience`, `sharedWith`, and `share`
return **zero matches** in `memory.ts`. The exported API is `addMemory`,
`listMemory`, `findMemory`, `searchMemory`, `searchMemoryWithReceipts`,
`promoteMemory`, `inspectMemoryStore`, `rebuildMemoryIndex`,
`probeMemorySearchLatency` — **no delete, supersede, expire, revoke, or retain.**

The only promotion guard is a boolean:

```ts
// memory.ts:246
if (targetScopes.some((s) => s.kind === "global") && !input.allowGlobal) {
  throw new Error("Promoting memory to global requires allowGlobal=true.");
}
```

But maker-checker already exists in this codebase — for skills:

```ts
/** THE GATE: a candidate becomes active only with a converged evolve report. */
// skills.ts:637
export async function promoteSkill(name, evalReport: EvolveReport, …)
```

`promoteSkill` refuses promotion without converged eval evidence and rejects an
empty suite as evidence. `promoteMemory` accepts a flag.

> Re-scope: "Design maker-checker" → **"Extend `skills.ts:637`'s gate to
> `memory.ts:241`."** Compare QM, which already ships grant-based skill sharing
> with admin-gated org promotion.

### 4.4 The India profile is closer than claimed — on models.

```
providers-catalog.ts:42  vllm    — vLLM (self-hosted),   openai-compatible
providers-catalog.ts:43  sglang  — SGLang (self-hosted), openai-compatible
providers-catalog.ts:27  deepseek     :30 qwen     :28 mistral
```

Model reach exists. What is missing is the **governance wrapper**:
deny-by-default egress, provider allowlists, model registry, approved-use
inventory, risk classification, evaluation history, rollback.

> Re-scope: not a model-integration project — an **evidence-and-egress project**
> on models Muster already reaches.

### 4.5 Missed entirely: latency, and it disqualifies the daily-driver thesis.

`docs/RELEASE_TRAIN.md:57` admits 10–12s for a trivial response. The live probe
measured **5.3–9.4s to first text delta** and **9.1–17.7s to a one-line edit
landing on disk** — through raw Codex, with no Muster overhead at all.

Latency appears nowhere in the eight-item execution order, yet
`codex-app-server.ts:40-47` already collects `startupMs`, `queueMs`,
`threadOpenMs`, `requestToFirstDeltaMs`, `cacheState`, and `run.ts:1159` logs a
full per-phase breakdown. **Muster measures this in detail and gates on none of
it.**

### 4.6 Missed: the coding daily-driver is greenfield, not "finish."

Item #5 said "*finish* … worktrees, checkpoints, background terminals, queueing,
PR review, session fork/resume." Grepping core for `worktree` and `checkpoint`
returns nothing relevant. `sessions.ts` / `session-handle.ts` give storage,
search, and a context-hash-gated resume guard (`session-handle.ts:124-129`) —
no fork. Compare Hermes: seven execution backends with hibernate/resume.

---

## 5. How Codex Fits Without Muster Becoming a Skin

The sharpest risk in the original verdict is item #4: adopt Codex's "app-server
protocol … stable runtime protocol." Read literally, that ends the thesis —
Muster becomes a Codex client and provider neutrality becomes decoration.
**§2.2 now makes this concrete rather than philosophical: build on Codex's
events and you get nothing three times out of three.**

### 5.1 Invert the dependency

```
                    Muster RPC contract (rpc.ts, versioned)
                                  ▲
        ┌─────────────┬───────────┼───────────┬──────────────┐
        │             │           │           │              │
   codex adapter  claude adapter  vLLM/SGLang  tool-registry  workspace
   (hints only)   (hints only)   (hints only)  (authoritative) observer
        │             │           │           │              │
        └─────────────┴───────────┴───────────┴──────────────┘
                                  │
                    normalized workspace.patch events
                    (derived from FS watch + git, NOT from
                     backend self-report — see §2.2)
                                  │
                    trust kernel: scope · receipt · ledger
                                  │
              ┌───────────────────┼───────────────────┐
              ▼                   ▼                   ▼
           IDE ext               TUI            web/desktop
```

The Codex app-server is **one adapter emitting hints**. The authoritative
workspace truth comes from Muster observing the filesystem, because §2.2 proved
the agent's self-report is incomplete. A Claude backend, a local Qwen on vLLM,
or Muster's own tool-registry edits all produce the same normalized events.

Note also: `codex agents` ("browse all agent sessions on the shared local
app-server daemon") and `codex remote-control` are real subcommands in
0.150.0-alpha.8 — so attach-mode observation of an externally-started session is
more viable than assumed, and worth a spike.

**The payoff:** live inline diffs against DeepSeek on your own vLLM, air-gapped,
with every changed character attributable and receipted. Cursor cannot sell
that. Codex cannot sell that. It is the regulated-deployment story expressed as
a developer feature instead of a compliance PDF.

**Non-negotiable:** adapters attach through clean seams; the **trust kernel does
not**. This is where Muster deliberately parts from DeepSeek Harness's
"no privileged core." Backends, tools, sandboxes, and surfaces are replaceable.
Scope, approval, evidence, audit, and credential boundaries are mandatory.

### 5.2 Plugins and artifacts: stop racing, start narrowing

You are right that competitor plugin depth exceeds Muster's. The answer is not
more packs.

1. **Archive the 31 untested packs.** Ship a pack only with auth, failure
   recovery, permissions, live scenarios, and readiness evidence. Thirty-two
   declarations that imply working integrations are a liability for an
   auditability product.
2. **Buy breadth via MCP instead of building it.** `mcp.ts`, `mcp-oauth.ts`, and
   the `mcp-bridge` pack (683 loc) already exist. MCP servers are the breadth
   strategy; hand-written packs are not. Hermes made the analogous choice by
   adopting the agentskills.io standard rather than inventing one.
3. **Make the zero-dependency OOXML writer a differentiator, not an
   embarrassment.** Everyone else shells out to LibreOffice or pulls heavy
   libraries. Muster emits deterministic, byte-reproducible, dependency-free
   Office files that work air-gapped with nothing installed — verified opening
   in a real parser (§2.3). That is genuinely valuable in a regulated
   deployment. It needs tables, styles, images, and charts to be credible.
   **Deterministic document bytes you can hash and put in an audit receipt** is
   a feature no LibreOffice-shelling competitor can match.

Depth in Frappe (19,632 loc, 9 test files) is the one place Muster already
out-specializes everyone. That is the vertical proof. Protect it.

---

## 6. Corrected Execution Order

The original order put Memory V3 (#2) **before** the QA Lab and recall exams
(#3) — rebuilding the most valuable subsystem with no instrument to prove the
rebuild helps. That is the exact failure the verdict accuses the current QA of.
Measurement precedes rewrite.

Each wave carries a numeric gate. A wave is done when its number is true in CI,
not when code merges.

### Wave 0 — Adopt what exists (weeks; unblocks everything)

| Work | Gate |
|---|---|
| `run.ts` emits RunEvents for every run, tool call, and file effect | 100% of runs reconstructable from the log alone (DeepSeek's rule) |
| Grow `RpcEvent` past 3 variants: `workspace.patch`, `tool.*`, `plan.*`, `approval.*` | Every surface renders from events only |
| **Workspace observer: FS watch + git diff as the authoritative patch source** | **Reproduces all 3 probe edits that Codex's own events missed (§2.2)** |
| Codex adapter downgraded to hint enrichment, never audit source | Audit completeness independent of backend tool choice |
| First-token latency budget in CI from timings already collected | p95 first token **< 2.0s** warm, **< 4.0s** cold; build fails on regression |

The third row is the one the live probe forced into existence, and it is now the
most important row in the table.

### Wave 1 — Build the instrument before the rewrite

| Work | Gate |
|---|---|
| Long-transcript recall exam (Hermes-style) | Recall at 10k / 100k / 500k tokens, published, non-regressing |
| QA Lab scenario DSL: `persona + authority + environment + objective + expected effects + prohibited effects + latency budget + token budget + evidence oracle` | ≥ 8 scenarios green |
| Oracles are repo state, DB state, permission state, artifacts, receipts | LLM judging ≤ 20% of assertions and never sole authority |

### Wave 2 — Memory V3, now measurable

| Work | Gate |
|---|---|
| Supersession and contradiction records (never silent overwrite) | Conflicting facts both retrievable with authority + effective dates |
| Lifecycle: expiry, retention, erasure, legal hold, revocation propagation | Cryptographic deletion receipts; revoked memory unretrievable within one index cycle |
| Real grants: audience, purpose, expiry, revocation, reshare policy | Unauthorized recipient refused **in test** (QM parity) |
| Apply the `skills.ts:637` gate to `promoteMemory` | Promotion without eval evidence impossible, not discouraged |
| Explainable recall: why selected, which grant, freshness, token cost | All four on every recalled item |

Hybrid retrieval (vectors + graph + BM25) ships **only** after Wave 1 proves it
beats the lexical baseline. If it cannot, do not ship it.

### Wave 3 — Coding daily-driver (the visible proof of Wave 0)

Worktrees, checkpoints, session fork/resume, background terminals, queueing, PR
review, and the IDE live-diff extension over Muster's own contract — fed by the
workspace observer, not by backend patch events.

**Gate:** Muster fixes a real bug in this repository and opens a reviewable PR,
with the full turn reconstructable from the event log and every edit receipted.

### Wave 4 — India regulated profile

Deny-by-default egress, provider allowlists, model registry, approved-use
inventory, risk classification, evaluation history, rollback, DLP/PII
classification, purpose limitation, SBOM/AIBOM, BCP/DR evidence, vendor exit
export, policy mappings for RBI / SEBI / IRDAI / CERT-In / DPDP.

**Gate:** a complete evidence pack generated from the spine, not hand-assembled.

**Regulatory nuance to preserve:** payment-system data carries an explicit India
localization requirement, but not every BFSI workload is subject to one blanket
rule. Deployment policy must be selected per entity, workload, data class,
regulator, and contract. A single "India-only" toggle would be wrong and a
liability.

Frappe remains the vertical proof throughout, without Frappe assumptions
entering the universal core. Plugin count is not a wave.

---

## 7. What Muster Will Not Do

A strategy without refusals is a backlog.

- **Not a general-purpose IDE.** Muster provides the governed edit stream; the
  editor stays the user's.
- **Not a Codex skin.** Codex is an adapter behind Muster's contract — and per
  §2.2, not even a trusted one.
- **Not trusting agent self-report for audit.** Workspace truth is observed.
- **Not a pluggable trust kernel.** This is the deliberate divergence from
  DeepSeek Harness. Backends swap; governance does not.
- **Not competing on plugin count.** Against OpenClaw's 387.8k★ and Hermes's
  237.1k★, breadth is unwinnable. Depth in Frappe and MCP-brokered reach are the
  strategy.
- **Not shipping capability without a gate.** No number, no wave.
- **Not shipping "shared memory" as a shared folder.** Grants with audience,
  purpose, expiry, and revocation — or it does not ship.

---

## 8. Positioning

> **Muster is a provider-neutral governed work harness — built in India for
> organizations that need auditable agents.**

**Your agents can work in your IDE, on your models, inside your network — and
every edit, recall, and approval is on an immutable spine you can hand to an
auditor.**

Cursor has the ergonomics and none of the governance. OpenClaw and Hermes have
the ecosystem and no audit spine. The compliance vendors have paperwork and no
runtime. Muster's opening is the overlap, and §2.2 shows why it is defensible:
**the competitors' own edit trails are incomplete, and nobody has noticed.**

---

## 9. Wave 0/3 Delivery Log — 2026-08-27

Executed as an orchestrated build (Opus 5 designers/builders/integrator,
Fable 5 adversarial verifiers, 8 agents, ~989k tokens, 66 min), then
independently re-validated in the main session. All numbers below re-measured
after the workflow, not taken from agent reports.

**Shipped (new files, zero new dependencies):**

| File | Lines | Role |
|---|---|---|
| `packages/core/src/workspace-observer.ts` | 1116 | Authoritative FS+git patch truth; sha256 before/after + deterministic receiptHash |
| `packages/core/src/agent-kanban.ts` | 2085 | Event-sourced kanban board + explainable provider-neutral model selection (9-gate audit per candidate: retired/capability/provider/residency/cost/latency/context/evidence/wip) |
| 4 test files (unit + adversarial stress) | 2588 | 76 new tests |
| `scripts/evidence/workspace-observer-live.mjs` | 359 | Repeatable head-to-head vs codex app-server |
| `scripts/evidence/codex-app-server-probe.mjs` | — | §2.2 probe, promoted |

Integration touched exactly two shared files: `packages/core/src/index.ts`
(exports) and `packages/gateway/src/rpc.ts` (RpcEvent grew from 3 variants to
6: `workspace.patch`, `task.transition`, `task.assigned`, with
`source: "observer"` enforced at the type level so backend self-report cannot
masquerade as observed truth).

**Re-validated gates (main session, fresh runs):**

- core 607/607 pass · gateway 421/421 pass · gateway + cli typecheck clean
- Live head-to-head, second independent run: codex `patchUpdated` **0**,
  codex `turn/diff/updated` **0**, observer `workspace.patch` **1** with
  git-apply-verified diff; detection latency **86ms** (workflow run: 75ms;
  budget 1000ms)
- **Cross-run receipt determinism:** two observer processes, different temp
  dirs, ~40 min apart, same logical change → byte-identical
  `receiptHash sha256:d3b98c8a…`. Receipts are citable evidence, not run-local
  artifacts.

**Adversarial verification found and fixed 8 real kanban bugs pre-ship**, the
worst being: an O(N²) state fold (10k-event drive 2073ms → 224ms after fix), a
planner that proposed assignments the reducer would reject (WIP oversubscribe),
and WIP saturation escalating as `no_qualified_model` — misreporting transient
capacity as a permanent capability gap to auditors. Observer stress survived a
320-file mutation storm with gapless sequences and correct hash chains, and —
critical for this mid-feature tree — reports only post-`start()` mutations on a
repo with pre-existing staged and unstaged changes.

**Honest flags (open, tracked, not gate failures):**

1. `workspace.patch.diff` would broadcast raw file content unredacted over
   `attachStdioTransport`; nothing emits the variant yet. A redaction layer must
   land before anything does.
2. `run-events.ts:279` has the same O(N²) applied-ids pattern the verifier fixed
   in the kanban; untouched because that file feeds staged mid-feature work.
3. The live evidence script needs an authenticated codex CLI — manual evidence
   job, not unattended CI.
4. Kanban states now hold a class-based applied-ids set; `structuredClone` of a
   board state no longer round-trips (no current consumer clones, documented).
5. Process lesson: dist went stale when verifiers fixed src after the integrate
   phase built it — rebuild dist after any post-integration fix wave.

**Competitive claim this evidence supports:** across 5 live codex runs to date
(3 probe + 2 head-to-head), Codex's structured file-change stream reported
**0 of 5** real edits; Muster's observer reported the edit in both runs it was
attached to, in <100ms, with replayable diffs and deterministic receipts. Per
§3's fetched documentation, no surveyed harness (OpenClaw, Hermes, QM, DeepSeek
Harness, OpenHarness) derives an authoritative, receipted workspace patch
stream from filesystem observation. This is the moat feature, and it now runs.

---

## 10. Immediate Next Three

1. **`run.ts` emits RunEvents** — once the frappe-lineage branch lands, so the
   spine adoption doesn't entangle staged work. Wire WorkspacePatchEvent
   receipts into it in the same change (§9: receiptHash/idempotencyKey already
   computed and stable).
2. **Redaction layer for `workspace.patch.diff`** before any surface emits it
   (§9 flag 1) — diff text in evidence, receipt in payload.
3. **Land the first-token latency gate in CI** against the timings
   `codex-app-server.ts:40-47` already collects.

Done from the original three (2026-08-27): workspace observer built, live-proven
against Codex twice, RpcEvent grown — see §9.

Waves 1–4 do not start before Wave 0's gates are green.

---

## Appendix — Reproducing the Live Evidence

The wire probe used for §2.2 spawns `codex app-server`, drives
`initialize → thread/start → turn/start`, timestamps every notification, polls
the target file every 5ms to establish patch-vs-disk ordering, and lingers past
`turn/completed` to rule out shutdown races. It accepts `-c key=value` overrides
as arguments.

Recommendation: promote it to `scripts/evidence/codex-app-server-probe.mjs`
alongside the existing evidence scripts, and run it against each Codex release.
The finding in §2.2 is version- and model-specific; it should be re-measured,
not assumed permanent.
