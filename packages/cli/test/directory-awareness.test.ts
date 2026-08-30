import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatWorkspaceMismatchBanner,
  isParallelWorkPrompt,
  parallelTaskChoiceForKey,
  workspaceMismatchChoiceForKey,
  workspaceOverrideForMismatchChoice,
} from "../src/directory-awareness.js";

test("parallel-work matcher suggests explicit task orchestration and ignores ordinary prompts", () => {
  const matrix: readonly [string, boolean][] = [
    ["Split this into tasks and implement it", true],
    ["split the migration into parallel tasks", true],
    ["Run the API and UI changes in parallel", true],
    ["Build the API and UI in parallel", true],
    ["Can you orchestrate this release?", true],
    ["Divide the work across the available agents", true],
    ["Parallelize the implementation", true],
    ["Explain how parallel lines work", false],
    ["Divide 144 by 12", false],
    ["List the tasks in this document", false],
    ["What does orchestration mean?", false],
    ["Fix the login bug", false],
  ];
  for (const [prompt, expected] of matrix) assert.equal(isParallelWorkPrompt(prompt), expected, prompt);
});

test("parallel-work choice accepts enter and sends every other key to one normal turn", () => {
  assert.equal(parallelTaskChoiceForKey("\r"), "tasks");
  assert.equal(parallelTaskChoiceForKey("\n"), "tasks");
  assert.equal(parallelTaskChoiceForKey("\x1b"), "single");
  assert.equal(parallelTaskChoiceForKey("x"), "single");
});

test("workspace mismatch banner and both choices follow the directory contract", () => {
  assert.equal(
    formatWorkspaceMismatchBanner("/Users/example/other/repo", "/Users/example"),
    "this conversation belongs to ~/other/repo — [enter] work there · [c] continue here",
  );
  assert.equal(workspaceMismatchChoiceForKey("\r"), "home");
  assert.equal(workspaceMismatchChoiceForKey("c"), "here");
  assert.equal(workspaceMismatchChoiceForKey("C"), "here");
  assert.equal(workspaceMismatchChoiceForKey("x"), undefined);
  assert.equal(workspaceOverrideForMismatchChoice("/other/repo", "home"), "/other/repo");
  assert.equal(workspaceOverrideForMismatchChoice("/other/repo", "here"), undefined);
});
