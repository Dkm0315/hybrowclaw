import assert from "node:assert/strict";
import test from "node:test";
import type { BoardView } from "@musterhq/core";
import { BoardScreen, hitTestCard, moveBoardFocus, parseSgrMouseSequence, renderBoardLayout, stripMouseSequences } from "../src/board-screen.js";

const fixture: BoardView = {
  columns: { backlog: ["t1"], ready: ["t2", "t3"], running: ["t4"], review: [], done: ["t5"] },
  cards: {
    t1: { taskId: "t1", title: "Write the plan", status: "backlog", lastEventAt: "2026-08-28T09:00:00.000Z" },
    t2: { taskId: "t2", title: "Build board", status: "assigned", modelId: "codex/gpt-5.6-sol", score: 91, lastEventAt: "2026-08-28T09:01:00.000Z" },
    t3: { taskId: "t3", title: "Test navigation", status: "assigned", modelId: "claude/sonnet-5", score: 84, lastEventAt: "2026-08-28T09:02:00.000Z" },
    t4: { taskId: "t4", title: "Wire live updates", status: "in_progress", modelId: "codex/gpt-5.6-terra", score: 88, startedAt: "2026-08-28T09:00:00.000Z", lastEventAt: "2026-08-28T09:03:00.000Z", costUsd: 0.014, lastNarrationLine: "Reading the session stream now" },
    t5: { taskId: "t5", title: "Ship it", status: "done", modelId: "codex/gpt-5.6-luna", score: 79, lastEventAt: "2026-08-28T09:04:00.000Z", costUsd: 0.02 },
  },
};

test("board layout snapshot is stable and contains the five task columns", () => {
  const layout = renderBoardLayout(fixture, 100, 18, { column: 2, row: 0 }, { color: false, nowMs: Date.parse("2026-08-28T09:02:03.000Z"), spinnerFrame: 0 });
  const snapshot = layout.lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
  assert.deepEqual(snapshot, [
    "tasks · 5 tasks",
    "Backlog 1           Ready 2             Running 1           Review 0            Done 1",
    "· Write the plan    · Build board       ⠋ Wire live updat…                      · Ship it",
    "  unassigned          gpt-5.6-sol (91)    gpt-5.6-terra (…                        gpt-5.6-luna (7…",
    "  — · cost —          — · cost —          2m · $0.014                             — · $0.020",
    "  backlog             assigned            Reading the ses…                        done",
    "", "                    · Test navigation", "                      sonnet-5 (84)",
    "                      — · cost —", "                      assigned", "", "", "", "", "", "",
    "↑↓←→ move · enter open · esc/q chat · mouse click",
  ]);
  assert.equal(layout.cardRects.length, 5);
});

test("focus movement matrix preserves rows, skips empty columns, and clamps", () => {
  assert.deepEqual(moveBoardFocus(fixture, { column: 1, row: 1 }, "right"), { column: 2, row: 0 });
  assert.deepEqual(moveBoardFocus(fixture, { column: 2, row: 0 }, "right"), { column: 4, row: 0 });
  assert.deepEqual(moveBoardFocus(fixture, { column: 1, row: 0 }, "down"), { column: 1, row: 1 });
  assert.deepEqual(moveBoardFocus(fixture, { column: 1, row: 1 }, "down"), { column: 1, row: 1 });
  assert.deepEqual(moveBoardFocus(fixture, { column: 0, row: 0 }, "left"), { column: 0, row: 0 });
});

test("card open and board close callbacks round-trip without losing focus", () => {
  const opened: string[] = [];
  let closed = 0;
  const screen = new BoardScreen({ view: () => fixture, rows: () => 18, requestRender: () => {}, openTask: (id) => opened.push(id), close: () => { closed += 1; }, color: false });
  screen.render(100);
  screen.handleInput("\r");
  screen.handleInput("\x1b");
  screen.handleInput("\r");
  assert.deepEqual(opened, ["t1", "t1"]);
  assert.equal(closed, 1);
});

test("click hit testing uses inclusive origin and exclusive far edges", () => {
  const rect = { taskId: "t", column: 1, row: 2, x: 10, y: 5, width: 20, height: 4 };
  assert.equal(hitTestCard([rect], 10, 5)?.taskId, "t");
  assert.equal(hitTestCard([rect], 29, 8)?.taskId, "t");
  assert.equal(hitTestCard([rect], 30, 8), undefined);
  assert.equal(hitTestCard([rect], 29, 9), undefined);
});

test("SGR reports parse and are stripped before keyboard input", () => {
  assert.deepEqual(parseSgrMouseSequence("\x1b[<0;17;9M"), { button: 0, x: 17, y: 9, release: false });
  assert.equal(stripMouseSequences("a\x1b[<0;17;9M\x1b[<0;17;9mb"), "ab");
  assert.equal(stripMouseSequences("plain"), "plain");
});
