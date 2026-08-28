# The Ick Ledger — every human-felt flaw, hunted live

Method: real terminal batteries + long sit-ins, judged against the bar of
Claude Code / the Codex app. An ick stays open until fixed AND re-felt as
fixed in a live session. Severity: ☠ breaks trust/flow · ● daily irritation ·
○ polish. (Live evidence date: 2026-08-28.)

## Open

| # | Sev | Ick (human words) | Fix |
|---|---|---|---|
| 1 | ☠ | `/modle` (typo) does NOTHING — silent swallow, no "did you mean /model?" | Unknown slash → one dim line with nearest-command suggestion |
| 2 | ☠ | `/tools` overlay = **271 rows**, full of "unreachable · not installed" catalog entries and `installed, enabled` filler text | Default = YOUR working set (active/installed, actionable) ≈ 20 rows; catalog behind `/tools all` or a filter toggle; use manifest displayName + shortDescription (already in core since today) instead of status filler |
| 3 | ● | Idle session elapsed ticks forever in the status row (21.7s → 23.7s on an untouched chat) | Show elapsed only during a running turn; idle shows nothing |
| 4 | ● | Wordmark path is raw + edge-truncated for non-home dirs (`/private/tmp/…-Documents`) | Middle-ellipsis to fit; ~ for home; always show the LAST path segment |
| 5 | ● | `--help` opens with a 6-line ASCII banner; "Muster v0" though the version is 0.1.11 | Banner only on interactive launch; help prints instantly; real version |
| 6 | ● | `/status` prints the session id twice + "fallbacks none configured" jargon | One id line; human phrasing; drop machine hints into `muster sessions show` |
| 7 | ● | Shell `muster modle` → "Unknown command: modle", no suggestion, no help pointer | Same did-you-mean treatment as in-chat |
| 8 | ● | `muster status` speaks machine: ISO header, dashed ruler, raw run UUID | Human summary ("8 runs, last 34m ago · $0.02 today"); ids on demand |
| 9 | ● | Streamed sentences concatenate ("suite now.Tests pass") — item boundaries lost | Paragraph break on provider item boundary/heuristic in the painter |
| 10 | ● | Reasoning lines show raw `**markdown**` asterisks | Strip emphasis markers in formatReasoningLine |
| 11 | ○ | Mid-word wrap ("wri/te") in flow-mode transcript | Word-aware wrapLine; hard-break only over-width words |
| 12 | ● | Thread-conflict error card suggests `--fork` even for native (non-imported) sessions where the cure is `/reset` | Card distinguishes imported vs native session and names the right cure |
| 13 | ● | Session-thread conflicts caused by muster's own long-lived gateway daemon holding warm threads | Daemon warm-session TTL + doctor check "gateway holds N warm threads" |
| 14 | ○ | Composer picker anchoring on very tall terminals (fix landed; re-verify feel) | Re-drive after next build |
| 15 | ● | 44-row `/` popup: dailies-first landed, but descriptions still muster-jargon ("read-model indexing controls", "eval gates") | Rewrite every description as what YOU get; plugins by name |
| 16 | ● | Plugins still not directly invocable (`/pdf`, `/documents` absent from popup) — manifest identity landed in core, cli wiring pending | Dynamic slash entries per inherited plugin (displayName + shortDescription), `/pdf <ask>` runs engaged turn |

## Fixed (kept for honesty — each was live-felt, then live-re-felt)

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
