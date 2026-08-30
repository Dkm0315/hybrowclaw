# The Board — Muster's Bridge (binding spec)

Owner's vision, verbatim intent: *"My kanban should be fully operational — I
click on it, it opens the agent and shows me the work. I want the human touch —
I want to read the code. Human in the loop is the point."*

The board is not a status display. Every card is a DOOR into that agent's live
session. The human is the reviewer with real controls, and nothing merges
without them. Companion contracts: docs/UX_CONTRACT.md (visual/interaction
law), docs/research/harness-code-study.md (mechanism sources).

## Data model — five identities (vibe-kanban's proven shape)

Every piece of work carries, in SQLite:

```
task_id       the ticket — survives everything
attempt_id    one execution try — retry creates a NEW attempt, never erases the ticket
session_id    the muster conversation the agent works in (existing session store)
turn_id       one provider turn within the session
process_id    the OS-level execution (kill/crash granularity)
```

- The kanban engine (packages/core/src/agent-kanban.ts) gains attempt identity;
  each task binds to its muster session (task_id ↔ session_id) so "open the
  card" = "open that session's transcript".
- FACTS ONLY (T3 Code's law): the board renders exclusively from appended
  events — task/kanban events + RunEvents. `run.requested` is appended BEFORE
  spawn; `process.started/exited`, `approval.requested`, `review.accepted`
  as they occur. An idle pane must never imply completion.

## Execution — worktree per attempt

- Each attempt runs in its own git worktree (T3/vibe/Sandcastle consensus);
  the diff the human reviews is the worktree's delta, observed by the
  workspace observer (never agent self-report).
- Approve = merge the worktree back (explicit board transition). Retry = new
  attempt, fresh worktree, same ticket, prior attempt's evidence retained.
- Bounded loops (Sandcastle): idle timeout, explicit completion signal,
  bounded retries — never a heroic prompt.

## The Board UI (full-screen mode)

- Enter from chat via /tasks board (and F3). Columns: Backlog · Ready ·
  Running · Review · Done, cards showing title · model (score) · elapsed ·
  cost · live one-line narration for running tasks.
- Navigation: arrows move, enter OPENS the card. Mouse: muster enables SGR
  mouse reporting (\x1b[?1002h\x1b[?1006h) through pi-tui's raw input
  listener and hit-tests clicks against rendered card rects — click a card,
  it opens. Esc returns. q back to chat.
- Live: cards update in place from events (spinner on running cards lives in
  the card, narration line truncated).

## The Task View — the door (what opening a card shows)

Three stacked regions, all live:
1. **The agent's transcript** — that session's conversation streaming
   (thinking dim-italic, narration, tool lines) exactly as chat renders it.
2. **The work** — the attempt's cumulative diff via the full-file canvas
   (lane-5 renderer, per-task): complete files, green/red in place, follow
   mode. Tab cycles files.
3. **Controls (the human touch)**:
   - `c` — comment: type a note (optionally anchored to the file/line under
     the cursor in the diff); it is sent as the NEXT TURN to that agent's
     session in its worktree (vibe-kanban's review-as-corrective-execution).
   - `a` — approve: runs the task's acceptance checks, then merges the
     worktree; records `review.accepted` with the human as actor.
   - `r` — retry as new attempt · `x` — cancel attempt · `o` — open the file
     under cursor in $EDITOR · esc — back to board.
- NOTHING merges without explicit human approval. The approval event records
  actor, acceptance-check results, and diff hashes.

## Verification (the research white-space, made ours)

- Each task carries acceptance checks (commands + expected outcomes) declared
  at planning; `a` runs them and shows results before merge.
- Worker self-report and verifier verdict are stored as SEPARATE events —
  the board shows both, and disagreement blocks Done with a visible reason.

## Build order (codex builds, fable validates, human reviews)

K-A  data model: five identities + task↔session binding + facts projection API
K-B  board UI + task view (transcript pane, canvas pane, controls skeleton)
K-C  worktree-per-attempt execution + comment→next-turn + approve/merge
K-D  acceptance checks + independent verifier + mouse hit-testing + polish

Each phase lands only after: suite green + fable's critical pass + a real
muster-builds-muster run through the new surface.
