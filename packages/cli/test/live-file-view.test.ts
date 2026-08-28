import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkspacePatchEvent } from "@musterhq/core";
import {
  followScrollTarget,
  LiveFileOverlay,
  LiveFileTurnAccumulator,
  renderFullFileLine,
  renderLiveFilePlain,
} from "../src/live-file-view.js";

let sequence = 0;

function event(path: string, diff: string, overrides: Partial<WorkspacePatchEvent> = {}): WorkspacePatchEvent {
  sequence += 1;
  return {
    schemaVersion: 1,
    source: "observer",
    sequence,
    atIso: "2026-08-28T10:00:00.000Z",
    observerId: "observer-test",
    root: "/repo",
    path,
    changeKind: "modify",
    beforeHash: `sha256:before-${sequence}`,
    afterHash: `sha256:after-${sequence}`,
    bytesBefore: 1,
    bytesAfter: 1,
    modeBefore: 0o100644,
    modeAfter: 0o100644,
    binary: false,
    diff,
    diffHash: `sha256:diff-${sequence}`,
    diffContextLines: 3,
    detectedBy: "watch",
    receiptHash: `sha256:receipt-${sequence}`,
    idempotencyKey: `event-${sequence}`,
    ...overrides,
  };
}

function diff(path: string, hunk: readonly string[]): string {
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...hunk, ""].join("\n");
}

test("hunk accumulator reconstructs turn baseline and applies sequential edits", () => {
  const turn = new LiveFileTurnAccumulator();
  turn.add(event("src/a.ts", diff("src/a.ts", [
    "@@ -1,3 +1,4 @@",
    " one",
    "+inserted",
    " two",
    " three",
  ])), "one\ninserted\ntwo\nthree\n");
  turn.add(event("src/a.ts", diff("src/a.ts", [
    "@@ -2,3 +2,3 @@",
    " inserted",
    "-two",
    "+second",
    " three",
  ])), "one\ninserted\nsecond\nthree\n");

  assert.deepEqual(turn.baseline("src/a.ts"), ["one", "two", "three"]);
  assert.deepEqual(turn.view("src/a.ts")?.lines, [
    { kind: "unchanged", gutter: " ", lineNumber: 1, text: "one" },
    { kind: "added", gutter: "+", lineNumber: 2, text: "inserted" },
    { kind: "removed", gutter: "-", lineNumber: 2, text: "two" },
    { kind: "added", gutter: "+", lineNumber: 3, text: "second" },
    { kind: "unchanged", gutter: " ", lineNumber: 4, text: "three" },
  ]);
});

test("overlapping sequential hunks keep the turn-start removal, not an intermediate phantom", () => {
  const turn = new LiveFileTurnAccumulator();
  turn.add(event("src/auth.ts", diff("src/auth.ts", [
    "@@ -1,3 +1,3 @@",
    " before",
    "-const token = req.token;",
    "+const token = bearer(req);",
    " after",
  ])), "before\nconst token = bearer(req);\nafter\n");
  turn.add(event("src/auth.ts", diff("src/auth.ts", [
    "@@ -1,3 +1,4 @@",
    " before",
    "-const token = bearer(req);",
    "+const token = getBearerToken(req);",
    "+if (!token) throw new Error('missing');",
    " after",
  ])), "before\nconst token = getBearerToken(req);\nif (!token) throw new Error('missing');\nafter\n");

  const view = turn.view("src/auth.ts")!;
  assert.deepEqual(view.lines.map((line) => [line.kind, line.text]), [
    ["unchanged", "before"],
    ["removed", "const token = req.token;"],
    ["added", "const token = getBearerToken(req);"],
    ["added", "if (!token) throw new Error('missing');"],
    ["unchanged", "after"],
  ]);
  assert.equal(view.lines.some((line) => line.text === "const token = bearer(req);"), false);
  assert.deepEqual({ additions: view.additions, deletions: view.deletions }, { additions: 2, deletions: 1 });
});

test("full-file renderer classifies exact gutters and preserves unchanged foreground", () => {
  const rows = [
    renderFullFileLine({ kind: "unchanged", gutter: " ", lineNumber: 1, text: "const before = 1;" }, 40, { color: false }),
    renderFullFileLine({ kind: "removed", gutter: "-", lineNumber: 2, text: "const old = 2;" }, 40, { color: false }),
    renderFullFileLine({ kind: "added", gutter: "+", lineNumber: 2, text: "const next = 2;" }, 40, { color: false }),
  ];
  assert.deepEqual(rows.map((row) => row.trimEnd()), [
    "    1   const before = 1;",
    "    2 - const old = 2;",
    "    2 + const next = 2;",
  ]);
});

test("multi-file order is first-touch stable while the overlay opens and follows the most recent file", () => {
  const turn = new LiveFileTurnAccumulator();
  turn.add(event("a.ts", diff("a.ts", ["@@ -1 +1 @@", "-a", "+A"])), "A\n");
  turn.add(event("b.ts", diff("b.ts", ["@@ -1 +1 @@", "-b", "+B"])), "B\n");
  turn.add(event("a.ts", diff("a.ts", ["@@ -1 +1 @@", "-A", "+AA"])), "AA\n");
  assert.deepEqual(turn.paths(), ["a.ts", "b.ts"]);
  assert.equal(turn.mostRecentPath(), "a.ts");

  const overlay = new LiveFileOverlay(turn, { terminalRows: () => 30, requestRender() {}, close() {}, color: false });
  assert.match(overlay.render(80)[0]!, /^a\.ts ·/);
  overlay.handleInput("\t");
  assert.match(overlay.render(80)[0]!, /^b\.ts ·/);
  overlay.handleInput("\t");
  assert.match(overlay.render(80)[0]!, /^a\.ts ·/);
});

test("follow-mode target math centers then clamps the newest hunk", () => {
  assert.equal(followScrollTarget(50, 100, 20), 40);
  assert.equal(followScrollTarget(3, 100, 20), 0);
  assert.equal(followScrollTarget(98, 100, 20), 80);
  assert.equal(followScrollTarget(4, 5, 20), 0);
});

test("plain fallback prints a cumulative per-file delta", () => {
  const turn = new LiveFileTurnAccumulator();
  turn.add(event("hello.js", diff("hello.js", ["@@ -1 +1 @@", "-hello", "+hello world"])), "hello world\n");
  assert.deepEqual(renderLiveFilePlain(turn), [
    "--- turn-start/hello.js",
    "+++ current/hello.js",
    "-hello",
    "+hello world",
  ]);
});
