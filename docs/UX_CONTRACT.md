# Muster UX Contract — The Daily-Driver Redesign Spec

Owner-ratified 2026-08-28. This document is BINDING for every UI change. A
change that violates it is a bug regardless of tests passing. Decisions here
were made explicitly by the owner; do not relitigate them.

**The product in one line: Claude Code's UX + Codex's models and ecosystem +
Cursor's inline diff, in one terminal, losing nothing the owner already has.**

## Ratified decisions

1. **Visuals: replicate Claude Code exactly.** Default terminal foreground for
   prose. Dim warm gray for ALL chrome (gutters, borders, results, hints). One
   coral accent (`217;119;87`) used rarely: bullets, the active selection.
   Color must MEAN something; if a colored element carries no state, remove the
   color. Banner art at most once per launch, small. No cyan, no lime, no
   lavender anywhere in the chat surface.
2. **Mid-session provider switching: muster owns continuity.** The transcript
   is muster's; switching codex↔claude mid-session continues the SAME muster
   conversation, seeding the new provider's fresh native thread with the
   running context (recent transcript + summary via applicationContext). The
   prior native thread remains resumable if the user switches back.
3. **Command surface: full catalog stays; dailies ranked first** in every
   completion surface. Nothing hidden, nothing removed.

## Vocabulary law

Never invent a noun. Provider concepts use the provider's exact words; work
concepts use the worker's words.

- Codex reasoning = **"Effort"** with the app's labels, mapped 1:1 to the
  verified config values (machine-checked 2026-08-28, codex-cli 0.150.0-alpha.8):
  Light=`low` · Medium=`medium` · High=`high` · Extra High=`xhigh` ·
  Max=`max` · Ultra=`ultra` (Ultra hint: "Consumes usage limits faster" — keep
  their honest hint). The setting IS `model_reasoning_effort`; muster applies
  it per-session via `configOverrides` on the app-server run (never edits the
  user's config.toml silently) and shows the app default when unset.
- Claude reasoning = **"Extended thinking"**, Claude's semantics. Never show
  codex effort tiers on a claude turn.
- Orchestration = **tasks** and **agents** in every user-visible string. The
  engine's internal names (kanban, mission) must not leak to the UI. Primary
  trigger is natural language ("split this into tasks and run them in
  parallel"); slash commands are shortcuts.

## Model catalog (real lineup, provider-marked)

- codex: **GPT-5.6 Sol / Terra / Luna** (`gpt-5.6-sol|terra|luna`) + GPT-5.5;
  active model read from `~/.codex/config.toml`.
- claude: **Fable 5 / Opus 5 / Sonnet 5 / Haiku 4.5** via the claude CLI.
- The composer picker mirrors the Codex app exactly: **Model · Effort · Speed**
  anchored at the composer (see owner's screenshot), arrow-driven, current
  value ✓-marked, one-line consequence hints.

## The transcript contract (Claude Code grammar)

- Everything flows into NATIVE scrollback, additively, forever (flow mode —
  already shipped; never reintroduce windowing).
- `> ` dim gutter for user turns; `●` blocks for assistant prose; `⏺ Action(target)`
  with `  ⎿ dim result` for every tool action; long results collapse with an
  honest count.
- **Thinking is visible**: provider reasoning summaries paint dim-italic into
  the transcript as they stream (codex `item/reasoning/summaryTextDelta`;
  claude thinking summaries). If the provider sends none, show nothing —
  never fake it.
- **History is visible**: opening/resuming any session with prior messages
  REPLAYS them into the transcript sink (not console.log — engine-line routing
  swallows that; this was the "codex threads do not print history" bug). Dim
  separator with counts; the same `> `/`●` grammar.
- Nothing internal ever prints raw: run records, memory receipts, stderr —
  chips or the session log, always.
- **Esc interrupts the running turn** (codex: `turn/interrupt`; claude:
  SIGINT), landing as a visible "interrupted" line. This is a keystroke, not a
  command.

## Inline diff (Cursor grade)

Diff cards stream mid-turn (shipped) and remain receipted. Next grade: the
current turn's cumulative diff is always inspectable (`ctrl+d` toggles a live
diff panel of the turn), red/green painted, per-file, from the workspace
observer — never from provider self-report.

## One place for capabilities

`/tools` becomes THE capabilities surface: an arrow-driven overlay listing —
native toolsets, **inherited codex/claude MCP servers (status-marked),
inherited plugins (documents/pdf/spreadsheets/presentations/computer-use/…),
skills** — every row actionable in ≤2 keystrokes: enable/attach/authenticate/
insert-into-prompt. Computer-use shows its real enable state and how to flip
it. No tables that end in "run this other command."

## Directory awareness

- `muster` in a directory lists/creates sessions BELONGING to that directory
  first (muster sessions by workspace + codex rollouts by cwd).
- Resuming a session whose workspace ≠ cwd shows a one-line banner:
  "this conversation belongs to ~/other/repo — [enter] work there · [c] continue here".
- New sessions bind to cwd; the binding is visible in the wordmark line.

## Definition of done (owner's law)

Not suites. A scripted REAL-USER protocol in a real PTY, frames judged by eye
against this contract, every scenario: launch feel · resume codex thread with
visible history · thinking painting mid-turn · esc interrupt · mid-session
codex→claude switch with continuity · effort change via composer picker
reflected in the actual run · /tools to a usable capability in ≤5 keystrokes ·
directory-mismatch banner · an edit turn with live diff · /help sanity. Suites
are the regression floor only.
