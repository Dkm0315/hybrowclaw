# The Production Program — onboarding to real work, no half-baked surfaces

Owner's mandate, verbatim intent: *"Break my harness down but build it up so
no one can complain. Production-level, end-to-end, world-class — completing my
daily work better than I do it today."*

Rules of the program:
1. Every surface below has a DEFINITION OF DONE (DoD). A surface is IN
   PROGRESS or DONE — there is no "mostly". Done requires: suite green + a
   live sit-in where the surface is FELT as finished + an ICK_LEDGER sweep of
   that surface returning empty.
2. Work proceeds through gates in order (parallel only when files are
   disjoint). Codex builds, fable validates and hunts, the human reviews.
3. The final acceptance is not a checklist: it is A FULL SIMULATED WORKDAY
   (see Gate 9) run end-to-end through muster alone.

Status legend: ✅ done (evidence cited) · 🔧 in progress · ⬜ not started

## The journey, broken down

### Gate 0 — Install & first contact
DoD: one command from nothing to chatting (`npx @musterhq/cli` or brew/curl),
codex/claude auth auto-detected, zero credential ceremony, zero wizard on the
happy path; `muster update` works; help instant with real version.
State 🔧: shim works locally; onboarding has `s`-skip; --help banner/version in
K-ICK. MISSING: the one-command public install story; npm publish pipeline.

### Gate 1 — The chrome & the feel
DoD: one idle chrome line; composer pinned at the bottom; content flows above
into native scrollback; no idle timers; no duplicate facts; warm palette; no
machine text ever visible; resize-proof; wide-terminal-proof.
State ✅ (2026-08-28): layout law live-verified; 221/221; edge-glyph kill;
craterless filler verified. Residual: #17/#18/#19 machine-text stragglers →
Gate 2.

### Gate 2 — Daily conversation
DoD: streaming narration + visible thinking on every turn; sentences never
concatenate; esc always interrupts cleanly; errors are cards with the right
cure; every command discoverable by typo-tolerant search; history always
visible on entry; cost chips truthful (billed == shown, proven).
State 🔧: streaming/thinking/esc/model-truth done with receipts. In K-ICK:
did-you-mean, conflict-card cures. Remaining after: #9 sentence joins
(muster's first SELF-BUILT fix), #19 receipt chips, #21 menu expiry.

### Gate 3 — Sessions & continuity
DoD: sessions are directory-bound; the launch lists this project's work;
resume replays history; codex threads continue natively via picker (no IDs);
claude sessions resumable the same way; mismatch banner; `/sessions` and
`/codex sessions` share one human table style.
State 🔧: all shipped except claude-session resume (⬜) and table unification
(#17/#18, queued).

### Gate 4 — Capabilities in one place
DoD: /tools = working set with the Codex app's own names; /pdf /documents
/spreadsheets… direct commands; computer-use enable/use in ≤5 keystrokes;
MCPs attach natively where reachable; nothing requires reading a table.
State 🔧: manifest identity in core done; overlay + direct commands in K-ICK.

### Gate 5 — The board (the bridge)
DoD per docs/BOARD_SPEC.md: full-screen board; click/enter opens the agent's
live session; per-task transcript + full-file green/red canvas; comment →
next turn; approve → acceptance checks → merge; retry = new attempt, history
kept; facts-only rendering; nothing merges without the human.
State 🔧: K-A data model done (221/221). K-B UI ⬜ next after K-ICK. K-C
review loop ⬜. K-D verifier ⬜.

### Gate 6 — Orchestration that earns trust
DoD: /tasks plans real goals into parallel work with explainable model
choice; worktree-per-attempt isolation; live multiplexed streams; bounded
loops; a stall is visible with its reason; the research governor principle —
parallelism only when it pays — encoded as defaults.
State 🔧: single-task loop live-proven ($0.02, real file). Parallel
multiplexing, worktrees, stall visibility ⬜ (K-B/K-C scope).

### Gate 7 — Memory that behaves
DoD: policy enforced (done); recall receipts as chips; recall quality gated
by the long-transcript exam (10k/100k/500k); stemming verified (done);
scoped leakage negative-proof in CI (done).
State 🔧: exam ⬜ — scheduled after Gate 5 so board traces feed it.

### Gate 8 — Self-hosting (muster builds muster)
DoD: goals filed as /tasks inside muster; built on the codex sub; reviewed on
the board by the human; merged only through approve; every self-built change
traceable end to end. First target: ick #9.
State ⬜ blocked on Gate 5's board for review UX (chat-only self-build allowed
for small fixes before that).

### Gate 9 — THE ACCEPTANCE: a full workday through muster
DoD: one continuous real day simulated end-to-end, muster only: morning —
resume yesterday's codex thread, review overnight state; midday — three real
coding tasks (one parallel set via the board, one interrupted and steered,
one cross-provider switch); afternoon — a document produced via /documents,
a web-informed answer, memory recalled correctly across sessions; evening —
review + approve on the board, costs reconciled against the ledger, exit and
re-enter with everything intact. Every friction found = ledger + fix + rerun.
The program is DONE when this day completes with an empty new-ick count.

## Standing quality mechanisms
- ICK_LEDGER.md: every human-felt flaw, hunted continuously, closed with
  re-felt evidence.
- Suites as regression floor (currently core 727+ / cli 221 / gateway 429).
- Contention-flake watchlist: doctor scorecard, kanban-stress budget.
- Debt honestly parked: run.ts spine adoption (frozen with frappe branch),
  redaction before workspace.patch leaves the process, npm publish pipeline.
