# Muster Product Modes — Daily-Driver UX Contract

Owner-driven spec (Dhairya, 2026-08-27). Defines the terminal experience the
next waves build toward. Grounding: every referenced primitive exists —
citations inline. Companion: `docs/STRATEGY_V2.md` §9-10.

## The Four Modes

One keystroke cycles modes; all render from the same event stream (RpcEvent /
WorkspacePatchEvent / kanban events). No mode owns state.

| Mode | Key | What fills the screen |
|---|---|---|
| **Zen** | `F1` | Chat + compact diff cards (ships in current wave) |
| **Canvas** | `F2` | Cursor-style full-file live edit view |
| **Board** | `F3` | Kanban: tasks × agents × models, live |
| **Ledger** | `F4` | Cost, receipts, evidence, mission timeline |

## Canvas Mode — full-file live painting (the Cursor experience)

When the agent edits `src/auth.ts`, Canvas shows the **entire file**, and paints
changes into it as they land:

```
┌─ src/auth.ts ── 142 lines ── ● editing ─────────────── turn 00:07 ─┐
│  38   export async function login(req: Request) {                  │
│  39 -   const token = req.token;                        (red, dim) │
│  39 +   const token = getBearerToken(req);            (green, bold)│
│  40 +   if (!token) throw new AuthError("missing");        (green) │
│  41     const user = await verify(token);                          │
│  …scrolls to follow the edit cursor…                               │
├────────────────────────────────────────────────────────────────────┤
│ [Ctrl+X stop] [Ctrl+S steer] [Tab next file] [F1..F4 modes]        │
└────────────────────────────────────────────────────────────────────┘
```

Mechanics — all primitives exist:
- File content + hunk positions come from `WorkspacePatchEvent.diff`
  (`packages/core/src/workspace-observer.ts`, 86ms detection, live-proven).
  Removed lines render red/dim above their green replacements; unchanged lines
  render normally. The view auto-scrolls to the newest hunk ("follow mode",
  toggle with `f`).
- Terminal canvas: `@earendil-works/pi-tui` (already the chat TUI's framework,
  `packages/cli/package.json:19`) supports full-screen redraws.
- Sub-second cadence is the observer's debounce window; each repaint is
  receipt-hashed, so what you SEE is what the audit log RECORDS.
- Honest boundary: Codex/Claude write via shell in bursts (proven §2.2), so
  painting granularity is per-write-burst (~100ms–2s apart), not per-token.
  Muster-native tool-registry edits can stream finer. Never fake smoothness
  the backend doesn't provide.

### Stop and steer mid-turn

- `Ctrl+X` → codex backend: `turn/interrupt` (native ClientRequest, verified in
  0.150.0-alpha.8 schema); claude backend: SIGINT to the subprocess; mission
  path: `cancellation_requested` event (`run-events.ts:243`).
- `Ctrl+S` → input line opens mid-turn; codex: native `turn/steer`; others:
  queued as next-turn correction. Mission path: `steered` event (`:238`).
- Every stop/steer lands in the event log with actor + timestamp — an
  interrupted turn is an auditable fact, not a lost one.

## Board Mode — the kanban that deserves the name

Requirement from owner: the ASCII sketch is not enough. Board mode is a full
TUI app view:

```
┌─ MISSION: harden ragbot API ──────────────────── 3 agents · $0.31 ─┐
│ BACKLOG(2)   READY(1)   IN PROGRESS(3)          REVIEW(1)  DONE(4) │
│ ┌──────────┐            ┌─────────────────────┐                    │
│ │ t7 docs  │            │ t4 rate-limiter     │  ← selected        │
│ │ t8 bench │            │ ● fable-5 (768)     │                    │
│ └──────────┘            │ ▸ api/limiter.ts +84│                    │
│                         │ ⣷ 00:41  8.2k tok   │                    │
│                         ├─────────────────────┤                    │
│                         │ t5 tests            │                    │
│                         │ ● gpt-5.5 (712)     │                    │
│                         └─────────────────────┘                    │
│ [enter] task detail: score breakdown · context bundle · live diff  │
│ [m] reassign  [p] pause  [x] cancel  [g] grant context             │
└────────────────────────────────────────────────────────────────────┘
```

- Cards show live state from kanban events (`agent-kanban.ts` reducer —
  replayable, so the board can time-travel: `[` `]` scrub history).
- Enter on a card: the full 9-gate score table + context bundle
  (inclusions/denials/tokens) + that task's Canvas view.
- Reassign is an event (`task_review_rejected`-style), never a mutation.

## Shared context — automatic from natural prompts

No `share` command required. The ask path runs a lightweight intent detector
(same pattern as the existing ask-intent machinery in
`packages/gateway/src/frappe-ask-intent.ts`, generalized):

```
muster › walk rohan through the jenkins outage — he's taking the incident

  ▸ share intent detected: recipient "rohan" · purpose incident-handoff
  PREVIEW  ✔ 12 memories · 3 diffs · timeline    ✘ 2 items redacted (creds, tenant:nuvama)
  [enter] grant 7d  [e] edit selection  [esc] just answer, no share
```

Rules: the grant NEVER auto-sends — preview + one keypress, because sharing is
an outward-facing effect. Detection is conservative (named recipient + transfer
verb); a plain question about Rohan never triggers it. Grants carry audience,
purpose, expiry, revocation (Wave 2 memory-grants feature; QM-parity target).

## Routing with exactly two backends (codex + claude)

The 20-card seed filters to **authenticated reality** at startup: cards whose
provider has no working auth are marked unavailable (codex: `codex login
status`; claude: CLI present + keychain). With two live backends the 9 gates
still run — what differentiates is strengths, cost, latency, and accumulated
EVIDENCE:

| Task shape | Default pick | Why (gate signals) |
|---|---|---|
| Long autonomous coding, shell-heavy | claude (fable-5) | strength `agentic_shell`, evidence from integration tests |
| Deep single-file reasoning / review | codex (gpt-5.6-sol high) | strength `code_review`, reasoning tier |
| Cheap fast turns (rename, summarize) | codex (low effort) / haiku-class card | cost+latency gates dominate |
| Doc generation to file | muster-native artifacts | zero-dep OOXML always ships; codex's python-docx dep FAILED live on this machine (2026-08-27) |
| Anything mid-mission when one backend errors | the other, automatically | fallback chain already in `run.ts` (`backendFallbackMs`) |

Evidence loop: every completed task writes an outcome receipt against its
model card (`evidence` gate input), so routing sharpens from YOUR history —
after a month, "which model for jenkins work" is answered by receipts, not
vibes. `board why t4` prints the full gate table — routing is never a black box.

## Streaming & scale — the honest architecture answer

**There is no Kafka, and today that is correct.** What exists (verified):

- Append-only event contracts with monotonic sequence, **fencing tokens,
  leases, idempotency keys with conflicting-receipt detection**
  (`run-events.ts:146-208`) — the semantics of a distributed log, without the
  distributed log.
- File-backed ingress spool with delivery-state machine
  (`gateway/ingress-spool.ts`: accepted → execution-completed → send-attempted
  → platform-delivered) and lease-based durable ingress with 7-day replay
  retention (`durable-ingress.ts`).
- NDJSON event streams over one versioned RPC contract (`rpc.ts`).
- SQLite (WAL) + JSONL stores throughout.

Scale path — three stages, no contract change:

1. **Laptop (now):** single process, SQLite WAL, spool recovery. Reliability
   work: launchd/systemd supervision for the gateway, crash-replay drill in QA
   Lab, backpressure counters in `runtime-doctor`.
2. **Team box:** same binaries, Postgres for stores (QM ships this shape),
   N workers claiming node leases — **fencing tokens already reject stale
   writers**, so multi-worker needs no redesign, only a shared store.
3. **Org scale:** introduce an `EventLogStore` seam; Kafka/Redpanda/NATS as an
   adapter BEHIND the same append-only contract. Consumers replay from offset =
   `replayRunEvents` from sequence. The reducer doesn't change; only transport.

Known debt on this path (tracked): `run.ts` not on the event spine yet (blocked
on frappe branch), `run-events.ts:279` O(N²) applied-ids fold (fix proven in
kanban, port it), no gateway supervisor yet.

## Parent-model streaming — narrate everything, always (owner requirement)

The product is only efficient if the user always sees what the driving model is
SAYING, not just what it did. Requirements:

1. **The parent/orchestrator model's narration streams live** in every mode —
   Zen shows it as the chat stream; Board shows it as a narration line above
   the board ("splitting into 3 tasks: limiter, tests, docs…"); Canvas shows it
   in a one-line status bar under the file.
2. **Child agents multiplex**: each in-progress board card streams its own
   agent's latest delta line (truncated), so a 3-agent mission reads like three
   terminals at once. Codex already provides `item/agentMessage/delta` +
   `item/reasoning/summaryTextDelta` (both consumed in
   `codex-app-server.ts:622-633`); Claude subprocess streams stdout.
3. **Gateway gap (tracked)**: the TUI receives deltas in-process, but the
   `RpcEvent` union has NO delta variant — web/desktop surfaces currently get
   only `message.stop`. Add `message.delta` (+ `reasoning.delta`, rate-limited,
   redaction-aware) so every surface streams identically. Raw hidden
   chain-of-thought is never forwarded — only provider-approved summaries
   (existing invariant, `codex-app-server.ts:34`).

## Lessons adopted from T3 Code (Theo Browne's Codex wrapper)

Reviewed 2026-08-27. T3 Code = desktop UI over Codex: multi-repo/multi-agent
parallelism via git worktrees, task-oriented chat with full reasoning +
tool-call visibility, visual diffs approved before landing. Take the best,
skip the rest:

- **Adopt — worktree-per-task**: Board tasks that touch the same repo run in
  isolated git worktrees; merge-back is an explicit board transition
  (review → done applies the worktree patch). Pairs with scoped-runtime v1's
  durable per-scope dirs.
- **Adopt — approve-before-land as a MODE, not a mandate**: `--gate-writes`
  runs the agent in a worktree and the Zen/Canvas diff gets
  [a]pprove / [r]eject per file before muster applies it to the real tree.
  Default stays live-apply with observed receipts (muster's differentiator);
  the gated mode reuses the same observer + receipts.
- **Skip — desktop-app chrome**: T3 ships an Electron-class app; the 2GB Codex
  desktop RSS measured on this laptop is the cautionary tale. Muster stays
  terminal-first; web surfaces render from the gateway stream.
- **Muster's edge to keep**: T3 shows diffs the agent reports; muster shows
  diffs the FILESYSTEM proves (0/5 vs 2/2 head-to-head), with receipts.

## Non-negotiables carried into every mode

- A mode renders events; it never invents state. If the log can't show it, the
  UI doesn't show it.
- Stop always works, always lands in the log, and never corrupts an in-flight
  effect (safe-point semantics: `run-events.ts:231`).
- Redaction before broadcast: no diff text leaves the local process until the
  redaction layer lands (STRATEGY_V2 §9 flag 1).
- Degrade politely: non-git dir → Zen mode still works; backend without
  steer → queued correction; no TTY → plain streaming.
