import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_BOARD_COLUMNS,
  bandUserRow,
  formatBoardHeader,
  formatEarlierHistoryLine,
  missionStatusGlyph,
  pruneHistory,
  renderInlineProse,
  renderProse,
  renderReasoningLine,
} from "../src/prose-renderer.js";

function plain(value: string | readonly string[]): string {
  return (Array.isArray(value) ? value.join("\n") : value).replace(/\x1b\[[0-9;]*m/g, "");
}

test("semantic prose renders markdown blocks without leaking source glyphs", () => {
  const rendered = renderProse([
    "## Release notes",
    "- **Fixed** *streaming* in `chat-tui.ts`",
    "```ts",
    "const ready = true;",
    "```",
  ].join("\n"), { firstPrefix: "● ", continuationPrefix: "  " });
  assert.deepEqual(plain(rendered).split("\n"), [
    "● Release notes",
    "  • Fixed streaming in chat-tui.ts",
    "  ts",
    "  const ready = true;",
  ]);
  const ansi = rendered.join("\n");
  if (!process.env.NO_COLOR) {
    assert.match(ansi, /\x1b\[1m/, "headers and bold carry weight");
    assert.match(ansi, /48;2;42;40;38/, "fenced code carries the subtle code background");
    assert.match(ansi, /217;119;87/, "bullet markers use the semantic accent");
  }
});

test("inline prose distinguishes code, files, branches, commands and URLs", () => {
  const rendered = renderInlineProse("Edit packages/cli/src/chat-tui.ts on feature/polish with /history; see https://example.com and `pnpm test`.");
  assert.equal(plain(rendered), "Edit packages/cli/src/chat-tui.ts on feature/polish with /history; see https://example.com and pnpm test.");
  if (!process.env.NO_COLOR) {
    assert.ok((rendered.match(/224;175;104/g) ?? []).length >= 3, "file, URL, and code use warm semantic tint");
    assert.ok((rendered.match(/217;119;87/g) ?? []).length >= 2, "branch and command use the accent tint");
  }
});

test("thinking owns the sole violet identity", () => {
  const line = renderReasoningLine("**Checking** `src/a.ts`");
  assert.equal(plain(line), "✻ Checking src/a.ts");
  if (!process.env.NO_COLOR) assert.match(line, /\x1b\[3m.*183;157;219/);
});

test("history replay keeps twelve messages and collapses trivial turns", () => {
  const rows = Array.from({ length: 21 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: index === 10 || index === 19 ? "ok" : `message ${index}` }));
  const history = pruneHistory(rows);
  assert.equal(history.earlier, 9);
  assert.equal(history.trivial, 2);
  assert.equal(history.rows.length, 10);
  assert.equal(history.rows[0]?.content, "message 9", "selection is the actual last twelve before compaction");
  assert.equal(formatEarlierHistoryLine(history.earlier), "… 9 earlier messages — /history for all");
});

test("shared board polish has compact headers, empty copy, and only three status glyphs", () => {
  assert.equal(formatBoardHeader(4), "tasks · 4");
  assert.equal(EMPTY_BOARD_COLUMNS, "Backlog · Ready · Running · Review — empty");
  assert.deepEqual([missionStatusGlyph("ready"), missionStatusGlyph("running"), missionStatusGlyph("done"), missionStatusGlyph("failed")], ["●", "◔", "●", "✖"]);
});

test("user rows paint their subtle band through the requested width", () => {
  const row = bandUserRow("\x1b[2m>\x1b[0m hello", 20);
  assert.equal(plain(row).length, 20);
  if (!process.env.NO_COLOR) {
    assert.ok((row.match(/48;2;38;37;35/g) ?? []).length >= 2, "inline resets reapply the full-row band");
    assert.match(row, / +\x1b\[0m$/, "padding remains inside the band");
  }
});
