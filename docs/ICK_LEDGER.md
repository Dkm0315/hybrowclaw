# The Ick Ledger — every human-felt flaw, hunted live

Method: real terminal batteries + long sit-ins, judged against the bar of
Claude Code / the Codex app. An ick stays open until fixed AND re-felt as
fixed in a live session. Severity: ☠ breaks trust/flow · ● daily irritation ·
○ polish. (Live evidence date: 2026-08-28.)

## Open

| # | Sev | Ick (human words) | Fix |
|---|---|---|---|
| 9 | ● | Streamed sentences concatenate ("suite now.Tests pass") — item boundaries lost | Paragraph break on provider item boundary/heuristic in the painter |
| 14 | ○ | Composer picker anchoring on very tall terminals (fix landed; re-verify feel) | Re-drive after next build |
| 17 | ● | `/sessions` prints a raw TSV dump — literal tabs, ISO timestamp, `in=74586 out=140` — while `/codex sessions` has a proper human table | One table style for both: name · when (relative) · messages · cost |
| 18 | ○ | Orphaned `(1 here · 2 total)` fragment floats above the /sessions table | Fold into the table header line |
| 19 | ● | Memory receipt in transcript: `score=0.211 reason=matched and scopes=user:dhairya` — mangled grammar, machine format | Chip form: `▸ recalled 1 memory (deploy target)`; detail to session log |
| 20 | ○ | Invalid picker selection message renders one frame late | Flush render after menu rejection |
| 21 | ○ | A pure-number chat message gets eaten by a stale picker menu (menu never expires) | Menu expires after one invalid entry or any non-selection input |

## Fixed (kept for honesty — each was live-felt, then live-re-felt)

- #4 Wordmark path is raw + edge-truncated for non-home dirs (`/private/tmp/…-Documents`) → ~-shortened middle-ellipsis paths
- #10 Reasoning lines show raw `**markdown**` asterisks → markdown stripped from reasoning lines
- #11 Mid-word wrap ("wri/te") in flow-mode transcript → word-aware wrap (40% threshold)

- History invisible on resume (console.log swallowed) → sink-appended initialLines
- Running history vanishing (windowed transcript) → flow mode into native scrollback
- Thinking invisible → summaries requested per-run (now `detailed`) + dim-italic painting
- Header/model display ≠ billed model → managed-runtime naming; billed==planned==shown (proof: ledger)
- Esc wedging warm thread on interrupt → warm-session drop after interrupt
- `/reasoning` provider-native picker (Light…Ultra ↔ config values); `/codex` bare = human picker, no IDs
- 45s wall-clock timeout killing streaming turns → idle-based timeout
- Live-diff painting muster's own ledger writes as user diffs → internal ignore
- Raw run-record JSON / memory diagnostics in transcript → chips + session log
- `run --help` executing a paid turn → global help interception
- Cold cyan/lime palette → warm coral/gray per UX contract
- Unknown slash and shell commands → one-line edit-distance suggestion, with `/help` fallback
- `/tools` → compact working set with manifest names/descriptions; full catalog at `/tools all`
- Idle status row stays hidden until a turn is running
- `--help`/`-h` → banner-free package-version help; banner remains on interactive launch
- `/status` → one conversation id path and no empty fallbacks row
- `muster status` → human summary; timestamps and run ids require `--verbose`
- Thread-conflict cards → `/reset` for native chats, `--fork` only for imported Codex threads
- Gateway Codex threads → 5m env-tunable idle TTL and a counted `muster doctor` check
- Slash descriptions → concise user outcomes with an automated jargon guard
- Active inherited plugins → direct cached slash commands with manifest descriptions and prompt engagement
