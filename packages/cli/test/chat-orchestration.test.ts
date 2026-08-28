import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODEL_CARD_SEED, snapshotKanbanBoard, type KanbanEvent, type KanbanTask } from "@musterhq/core";
import {
  authenticatedModelCards,
  boardEventsPath,
  buildMissionPlanPrompt,
  explainAssignment,
  openBoardStore,
  parseBoardCliCommand,
  parseChatOrchestrationCommand,
  parseMissionPlan,
  parseOrchestrationInvocation,
  renderBoardView,
  renderMissionSummaryCard,
  renderNeedsInterventionCard,
  renderTaskAssignedCard,
  renderTaskDoneCard,
  renderTaskNarrationLine,
  renderWhyView,
  runAssignCommand,
  runBoardCommand,
  runMissionCommand,
  runWhyCommand,
  stripOrchestrationAnsi,
  type BackendAuth,
  type MissionTaskRunInput,
  type MissionTaskRunResult,
  type OrchestrationDeps,
} from "../src/chat-orchestration.js";

/**
 * Card ids are read from the seed, never pasted: the seed is explicitly "a
 * starting inventory, not a source of truth" and its model strings move with the
 * backends (gpt-5.5 → gpt-5.6-sol landed mid-branch). A test that hardcodes them
 * fails on a routing change it was never meant to guard.
 */
const CLI_CARDS = MODEL_CARD_SEED.filter((card) => card.deployment === "cli" && card.retired !== true);
const CLAUDE_CARD = CLI_CARDS.find((card) => card.provider === "claude-code")!.id;
const CODEX_CARD = CLI_CARDS.find((card) => card.provider === "codex-cli")!.id;
const FIXED_NOW = new Date("2026-08-27T10:00:00.000Z");

function plain(lines: readonly string[]): string[] {
  return lines.map(stripOrchestrationAnsi);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "muster-board-"));
}

let harnessSeq = 0;

interface Harness {
  readonly deps: OrchestrationDeps;
  readonly lines: string[];
  readonly executed: MissionTaskRunInput[];
  readonly cwd: string;
}

function harness(cwd: string, overrides: {
  readonly auth?: BackendAuth;
  readonly plan?: (prompt: string) => Promise<string>;
  readonly execute?: (input: MissionTaskRunInput) => Promise<MissionTaskRunResult>;
  readonly sessionName?: string;
} = {}): Harness {
  const lines: string[] = [];
  const executed: MissionTaskRunInput[] = [];
  const prefix = `h${(harnessSeq += 1)}`;
  let counter = 0;
  const deps: OrchestrationDeps = {
    sessionName: overrides.sessionName ?? "main",
    cwd,
    color: false,
    width: 100,
    now: () => FIXED_NOW,
    // Ids stay deterministic but never collide across harnesses: two /assign
    // calls on one board are two different events, not a duplicate delivery.
    newId: () => `evt-${prefix}-${(counter += 1).toString().padStart(3, "0")}`,
    emit: (line) => lines.push(stripOrchestrationAnsi(line)),
    detectAuth: async () => overrides.auth ?? { codex: true, claude: true },
    plan: overrides.plan ?? (async () => JSON.stringify({ tasks: [] })),
    execute: overrides.execute ?? (async (input) => {
      executed.push(input);
      input.onNarration(`editing ${input.task.id}/limiter.ts`);
      return { ok: true, summary: "14 tests pass", costUsd: 0.04, runId: `run-${input.task.id}` };
    }),
    progressIntervalMs: 0,
  };
  return { deps, lines, executed, cwd };
}

const TWO_TASK_PLAN = JSON.stringify({
  tasks: [
    {
      title: "rate-limiter",
      goal: "add a token bucket rate limiter to the api",
      requiredCapabilities: ["agentic_shell"],
      preferredStrengths: ["agentic_shell"],
      dependsOn: [],
      priority: "high",
      estimatedContextTokens: 8000,
    },
    {
      title: "tests",
      goal: "author tests for the limiter",
      requiredCapabilities: ["test_authoring"],
      preferredStrengths: ["test_authoring"],
      dependsOn: ["t1"],
      priority: "normal",
      estimatedContextTokens: 6000,
    },
  ],
});

/* ------------------------------ command parsing ------------------------------ */

test("chat command parsing covers every orchestration verb, quoted or bare", () => {
  assert.deepEqual(parseChatOrchestrationCommand('/tasks "harden the ragbot API"'), { kind: "mission", goal: "harden the ragbot API" });
  assert.deepEqual(parseChatOrchestrationCommand("/tasks harden the ragbot API"), { kind: "mission", goal: "harden the ragbot API" });
  assert.deepEqual(parseChatOrchestrationCommand("/tasks “smart quoted goal”"), { kind: "mission", goal: "smart quoted goal" });
  assert.deepEqual(parseChatOrchestrationCommand("/tasks"), { kind: "board" });
  assert.deepEqual(parseChatOrchestrationCommand("/tasks why t4"), { kind: "why", taskId: "t4" });
  assert.deepEqual(parseChatOrchestrationCommand("/tasks assign t4 claude-code/claude-fable-5"), {
    kind: "assign", taskId: "t4", cardId: "claude-code/claude-fable-5",
  });
  assert.equal(parseChatOrchestrationCommand("/tasks why")!.kind, "usage");
  assert.equal(parseChatOrchestrationCommand("/tasks assign t4")!.kind, "usage");
  // Compatibility law: /mission remains a hidden working alias.
  assert.deepEqual(parseChatOrchestrationCommand('/mission "legacy goal"'), { kind: "mission", goal: "legacy goal" });
  // Non-orchestration input is left entirely alone for the existing dispatcher.
  assert.equal(parseChatOrchestrationCommand("/status"), undefined);
  assert.equal(parseChatOrchestrationCommand("just a normal question"), undefined);
  assert.equal(parseOrchestrationInvocation("status", ""), undefined);
});

test("the CLI door maps muster tasks onto the same command union", () => {
  assert.deepEqual(parseBoardCliCommand([]), { kind: "board" });
  assert.deepEqual(parseBoardCliCommand(["list"]), { kind: "board" });
  assert.deepEqual(parseBoardCliCommand(["why", "t2"]), { kind: "why", taskId: "t2" });
  assert.deepEqual(parseBoardCliCommand(["assign", "t2", CODEX_CARD]), { kind: "assign", taskId: "t2", cardId: CODEX_CARD });
  assert.equal(parseBoardCliCommand(["why"]).kind, "usage");
  assert.equal(parseBoardCliCommand(["nonsense"]).kind, "usage");
});

/* ---------------------------- authenticated reality ---------------------------- */

test("selection sees only backends this machine can actually drive", () => {
  assert.deepEqual(authenticatedModelCards({ codex: true, claude: true }).map((card) => card.id).sort(), [CLAUDE_CARD, CODEX_CARD]);
  assert.deepEqual(authenticatedModelCards({ codex: false, claude: true }).map((card) => card.id), [CLAUDE_CARD]);
  assert.deepEqual(authenticatedModelCards({ codex: true, claude: false }).map((card) => card.id), [CODEX_CARD]);
  assert.deepEqual(authenticatedModelCards({ codex: false, claude: false }), []);
  // An API-keyed cloud card is never "authenticated" just because it is seeded.
  assert.ok(MODEL_CARD_SEED.some((card) => card.id === "anthropic/claude-fable-5"));
  assert.ok(!authenticatedModelCards({ codex: true, claude: true }).some((card) => card.deployment !== "cli"));
});

test("the planning prompt only offers capabilities the live backends have", () => {
  const codexOnly = authenticatedModelCards({ codex: true, claude: false });
  const prompt = buildMissionPlanPrompt("harden the api", codexOnly);
  assert.match(prompt, new RegExp(`requiredCapabilities MUST come from: ${[...codexOnly[0]!.capabilities].sort().join(", ")}`));
  assert.ok(!/test_authoring/.test(prompt), "a codex-only run must not advertise claude's test_authoring");
  // With no backend at all the planner still gets the canonical vocabulary.
  assert.match(buildMissionPlanPrompt("x", []), /requiredCapabilities MUST come from: code_edit, code_review/);
});

/* ------------------------- planner output → task mapping ------------------------- */

test("planner output maps to board-legal tasks, normalizing what the reducer would reject", () => {
  const raw = [
    "Here is the plan.",
    "```json",
    JSON.stringify({
      tasks: [
        { title: "rate-limiter", goal: "add a bucket", requiredCapabilities: ["agentic_shell"], dependsOn: [], priority: "high", estimatedContextTokens: 900_000 },
        { title: "tests", goal: "cover it", requiredCapabilities: ["TEST_AUTHORING", "telepathy"], dependsOn: ["t1"], priority: "urgent" },
        { title: "docs", goal: "write them", requiredCapabilities: [], dependsOn: ["t9"] },
      ],
    }),
    "```",
  ].join("\n");
  const { tasks, issues } = parseMissionPlan(raw, { createdAt: FIXED_NOW.toISOString(), availableCapabilities: ["agentic_shell", "code_edit"] });

  assert.deepEqual(tasks.map((task) => task.id), ["t1", "t2", "t3"]);
  assert.deepEqual(tasks.map((task) => task.title), ["rate-limiter", "tests", "docs"]);
  // Planner-local "t1" is mapped onto the real board id; an unknown ref is dropped.
  assert.deepEqual(tasks[1]!.dependsOn, ["t1"]);
  assert.deepEqual(tasks[2]!.dependsOn, []);
  // Case is normalized, unknown capabilities are dropped, empty ones defaulted.
  assert.deepEqual(tasks[1]!.requiredCapabilities, ["test_authoring"]);
  assert.deepEqual(tasks[2]!.requiredCapabilities, ["code_edit"]);
  // An unknown priority falls back rather than failing validation.
  assert.equal(tasks[1]!.priority, "normal");
  assert.equal(tasks[0]!.priority, "high");
  // A hallucinated context estimate is clamped so it cannot fail the window gate.
  assert.equal(tasks[0]!.estimatedContextTokens, 120_000);

  assert.ok(issues.some((issue) => issue.includes('dropped unknown capability "telepathy"')));
  assert.ok(issues.some((issue) => issue.includes('no authenticated backend offers "test_authoring"')));
  assert.ok(issues.some((issue) => issue.includes("defaulted to code_edit")));
  assert.ok(issues.some((issue) => issue.includes("clamped context estimate")));
});

test("planner output that cannot be used is reported, never invented", () => {
  assert.deepEqual(parseMissionPlan("I could not plan this.", { createdAt: FIXED_NOW.toISOString() }), {
    tasks: [], issues: ["planner returned no JSON object"],
  });
  assert.deepEqual(parseMissionPlan("{ nope", { createdAt: FIXED_NOW.toISOString() }).tasks, []);
  assert.deepEqual(parseMissionPlan(JSON.stringify({ tasks: [] }), { createdAt: FIXED_NOW.toISOString() }), {
    tasks: [], issues: ["planner produced no tasks"],
  });
  const many = parseMissionPlan(JSON.stringify({
    tasks: Array.from({ length: 8 }, (_, index) => ({ title: `t${index}`, goal: "go", requiredCapabilities: ["code_edit"] })),
  }), { createdAt: FIXED_NOW.toISOString() });
  assert.equal(many.tasks.length, 5);
  assert.ok(many.issues.some((issue) => issue.includes("kept the first 5")));
});

test("a second mission on the same board keeps counting task ids", () => {
  const { tasks } = parseMissionPlan(JSON.stringify({
    tasks: [{ title: "a", goal: "a", requiredCapabilities: ["code_edit"] }, { title: "b", goal: "b", requiredCapabilities: ["code_edit"], dependsOn: ["t1"] }],
  }), { createdAt: FIXED_NOW.toISOString(), startIndex: 4 });
  assert.deepEqual(tasks.map((task) => task.id), ["t4", "t5"]);
  assert.deepEqual(tasks[1]!.dependsOn, ["t4"]);
});

/* -------------------------------- render snapshots -------------------------------- */

test("mission cards render exactly the contract in docs/PRODUCT_MODES.md", () => {
  // Literal ids here on purpose: these assert the CARD FORMAT, not the seed.
  assert.equal(
    stripOrchestrationAnsi(renderTaskAssignedCard({ taskId: "t1", title: "rate-limiter", cardId: "claude-code/claude-fable-5", total: 768 }, { color: false })),
    "◔ t1 rate-limiter → claude-code/claude-fable-5 (768)",
  );
  assert.equal(
    stripOrchestrationAnsi(renderTaskDoneCard({ taskId: "t1", detail: "14 tests pass", costUsd: 0.04 }, { color: false })),
    "● t1 done · 14 tests pass · $0.04",
  );
  assert.equal(
    stripOrchestrationAnsi(renderTaskDoneCard({ taskId: "t2", detail: "run failed: timeout", ok: false }, { color: false })),
    "◼ t2 blocked · run failed: timeout · cost unpriced",
  );
  assert.equal(
    stripOrchestrationAnsi(renderTaskNarrationLine("t1", "  writing api/limiter.ts\n  and more  ", { color: false })),
    "  ⎿ t1 writing api/limiter.ts and more",
  );
});

test("the mission summary card totals the board without inventing a price", () => {
  assert.deepEqual(plain(renderMissionSummaryCard({
    goal: "harden the ragbot API",
    boardId: "board.main",
    elapsedMs: 252_000,
    costUsd: 0.19,
    tasks: [
      { taskId: "t1", title: "rate-limiter", status: "done", cardId: "claude-code/claude-fable-5", total: 768, costUsd: 0.04 },
      { taskId: "t2", title: "tests", status: "blocked", cardId: "codex-cli/gpt-5.5", total: 712 },
      { taskId: "t3", title: "docs", status: "backlog" },
    ],
  }, { color: false })), [
    "── tasks tasks.main · harden the ragbot API",
    "   3 task(s) · 1 done · 1 stalled · $0.19 · 04:12",
    "   ● t1   rate-limiter                       claude-code/claude-fable-5 (768)   $0.04",
    "   ◼ t2   tests                              codex-cli/gpt-5.5 (712)            cost unpriced",
    "   · t3   docs                               unrouted                           cost unpriced",
    "   /tasks for the list · /tasks why <taskId> for the gate table",
  ]);
});

test("the needs-intervention card names the fix, not just the failure", () => {
  assert.deepEqual(plain(renderNeedsInterventionCard({
    title: "2 task(s) planned, none routable",
    detail: "selection ran against zero authenticated model cards",
    fixes: ["codex login"],
  }, { color: false })), [
    "! needs intervention · 2 task(s) planned, none routable",
    "   selection ran against zero authenticated model cards",
    "   fix: codex login",
  ]);
});

test("an empty board says so instead of rendering blank columns", async () => {
  const cwd = await workspace();
  const { deps, lines } = harness(cwd);
  const snapshot = await runBoardCommand(deps);
  assert.equal(snapshot.atSequence, 0);
  assert.deepEqual(lines, [
    "── tasks tasks.main · seq 0 · 0 task(s)",
    '   no tasks yet — /tasks "<goal>" opens one',
  ]);
});

/* ------------------------- mission: plan → route → run → narrate ------------------------- */

test("a mission plans, routes per task, streams typed cards, and summarizes", async () => {
  const cwd = await workspace();
  const { deps, lines, executed } = harness(cwd, { plan: async () => TWO_TASK_PLAN });

  const outcome = await runMissionCommand("harden the ragbot API", deps);

  assert.ok(outcome);
  assert.deepEqual(outcome.tasks, ["t1", "t2"]);
  assert.deepEqual(outcome.done, ["t1", "t2"]);
  // test_authoring is a claude-only capability on the authenticated seed, so the
  // two tasks must land on different backends — routing, not a default.
  assert.deepEqual(executed.map((entry) => entry.task.id), ["t1", "t2"]);
  assert.equal(executed[1]!.cardId, CLAUDE_CARD);

  const text = lines.join("\n");
  assert.match(text, /^── tasks tasks\.main · codex authenticated · claude on PATH$/m);
  assert.match(text, new RegExp(`^◔ t1 rate-limiter → (${escapeRegExp(CLAUDE_CARD)}|${escapeRegExp(CODEX_CARD)}) \\(\\d+\\)$`, "m"));
  assert.match(text, /^ {2}⎿ t1 editing t1\/limiter\.ts$/m);
  assert.match(text, /^● t1 done · 14 tests pass · \$0\.04$/m);
  assert.match(text, new RegExp(`^◔ t2 tests → ${escapeRegExp(CLAUDE_CARD)} \\(\\d+\\)$`, "m"));
  assert.match(text, /^● t2 done · 14 tests pass · \$0\.04$/m);
  assert.match(text, /^── tasks tasks\.main · harden the ragbot API$/m);
  assert.match(text, /^ {3}2 task\(s\) · 2 done · 0 stalled · \$0\.08 · 00:00$/m);
  assert.equal(outcome.costUsd, 0.08);

  // t1 gates t2: the dependent task can only start after the first is done.
  assert.ok(text.indexOf("● t1 done") < text.indexOf("◔ t2 tests"), "t2 must be routed only after t1 completed");
});

test("the board renders the columns, model and score the mission recorded", async () => {
  const cwd = await workspace();
  const { deps } = harness(cwd, { plan: async () => TWO_TASK_PLAN });
  await runMissionCommand("harden the ragbot API", deps);

  const reader = harness(cwd, {});
  await runBoardCommand(reader.deps);
  const rendered = reader.lines;
  assert.match(rendered[0]!, /^── tasks tasks\.main · seq \d+ · 2 task\(s\)$/);
  assert.equal(rendered[1], "   DONE (2)");
  // Columns are fixed-width so the model + score line up down the board.
  assert.match(rendered[2]!, new RegExp(`^ {5}● t1 {3}rate-limiter {21}high {5}(${escapeRegExp(CLAUDE_CARD)}|${escapeRegExp(CODEX_CARD)}) \\(\\d+\\)$`));
  assert.match(rendered[3]!, new RegExp(`^ {5}● t2 {3}tests {28}normal {3}${escapeRegExp(CLAUDE_CARD)} \\(\\d+\\)$`));
  assert.equal(rendered.at(-1), "   wip idle");
});

test("one authenticated backend still routes, and /why shows the other one's blocking gate", async () => {
  const cwd = await workspace();
  const { deps, lines } = harness(cwd, { plan: async () => TWO_TASK_PLAN, auth: { codex: false, claude: true } });
  const outcome = await runMissionCommand("harden the ragbot API", deps);

  assert.ok(outcome);
  assert.deepEqual(outcome.done, ["t1", "t2"]);
  assert.match(lines.join("\n"), /^── tasks tasks\.main · codex unavailable · claude on PATH$/m);

  const reader = harness(cwd, {});
  const explanation = await runWhyCommand("t1", reader.deps);
  assert.ok(explanation);
  assert.equal(explanation.assignment?.cardId, CLAUDE_CARD);
  // Every one of the nine gates is accounted for, in the engine's own order.
  assert.deepEqual(explanation.gates.map((gate) => gate.id), [
    "retired", "capability", "provider", "residency", "cost", "latency", "context", "evidence", "wip",
  ]);
  assert.ok(explanation.gates.every((gate) => gate.status === "passed"), "the winning card must pass all nine gates");
  assert.deepEqual(explanation.breakdown.map((entry) => entry.dimension).sort(), ["context", "cost", "evidence", "latency", "strength"]);
  assert.equal(explanation.breakdown.reduce((sum, entry) => sum + entry.weight, 0), 100);
  assert.equal(explanation.breakdown.reduce((sum, entry) => sum + entry.weighted, 0), explanation.assignment!.total);
  // The unauthenticated backend was never registered, so it cannot silently win.
  assert.equal(explanation.rejected.length, 0);

  const view = plain([...renderWhyView(explanation, { color: false })]);
  assert.equal(view[0], "── why t1 · rate-limiter");
  assert.match(view[1]!, new RegExp(`^ {3}assigned ${escapeRegExp(CLAUDE_CARD)} · total \\d+ · agent muster-subagent · status done$`));
  assert.match(view[2]!, /^ {3}policy sha256:[0-9a-f]{64}$/);
  assert.equal(view[3], "   gate         status   detail");
  assert.match(view[4]!, /^ {3}retired {6}passed {3}card is active$/);
  assert.equal(view.filter((line) => /^ {3}(retired|capability|provider|residency|cost|latency|context|evidence|wip) +(passed|blocked|unknown)/.test(line)).length, 9);
  assert.ok(view.some((line) => /^ {3}total\s+100%\s+\d+\s*$/.test(line)), `no total row in:\n${view.join("\n")}`);
});

test("zero authenticated backends escalates instead of routing to a backend that would fail", async () => {
  const cwd = await workspace();
  const { deps, lines, executed } = harness(cwd, { plan: async () => TWO_TASK_PLAN, auth: { codex: false, claude: false } });
  const outcome = await runMissionCommand("harden the ragbot API", deps);

  assert.ok(outcome);
  assert.deepEqual(outcome.done, []);
  assert.deepEqual(outcome.stalled, ["t1", "t2"]);
  assert.equal(executed.length, 0, "nothing may execute without an authenticated backend");
  const text = lines.join("\n");
  assert.match(text, /^! needs intervention · 2 task\(s\) planned, none routable$/m);
  assert.match(text, /^ {3}fix: codex login$/m);

  const reader = harness(cwd, {});
  const snapshot = await runBoardCommand(reader.deps);
  assert.equal(snapshot.counts.needs_intervention, 2);
  assert.match(reader.lines.join("\n"), /NEEDS INTERVENTION \(2\)/);
  assert.match(reader.lines.join("\n"), /no_qualified_model: no authenticated backend/);
});

test("a failed task blocks itself and starves its dependents instead of faking progress", async () => {
  const cwd = await workspace();
  const { deps, lines } = harness(cwd, {
    plan: async () => TWO_TASK_PLAN,
    execute: async () => ({ ok: false, summary: "build failed: tsc exited 2" }),
  });
  const outcome = await runMissionCommand("harden the ragbot API", deps);

  assert.ok(outcome);
  assert.deepEqual(outcome.done, []);
  const text = lines.join("\n");
  assert.match(text, /^◼ t1 blocked · build failed: tsc exited 2 · cost unpriced$/m);
  assert.match(text, /^ {3}t2 not started \(backlog; upstream unfinished\)$/m);
  assert.equal(outcome.costUsd, undefined, "an unpriced run must not report a price");
});

test("a planning turn that fails degrades to a needs-intervention card", async () => {
  const cwd = await workspace();
  const { deps, lines } = harness(cwd, { plan: async () => { throw new Error("no provider configured"); } });
  assert.equal(await runMissionCommand("harden the ragbot API", deps), undefined);
  assert.match(lines.join("\n"), /^! needs intervention · planning "harden the ragbot API"$/m);
  assert.match(lines.join("\n"), /the planning turn failed: no provider configured/);
  // A failed plan writes no board at all.
  await assert.rejects(readFile(boardEventsPath("main", cwd), "utf8"));
});

/* ----------------------------- event-sourced persistence ----------------------------- */

function sampleTask(id: string): KanbanTask {
  return {
    id,
    title: `task ${id}`,
    goal: "do the thing",
    requiredCapabilities: ["agentic_shell"],
    preferredStrengths: ["agentic_shell"],
    contextRefs: [],
    dependsOn: [],
    priority: "normal",
    createdAt: FIXED_NOW.toISOString(),
  };
}

test("board state is an event log, and reopening a session replays it byte-for-byte", async () => {
  const cwd = await workspace();
  let counter = 0;
  const options = { sessionName: "wave", cwd, now: () => FIXED_NOW, newId: () => `evt-${(counter += 1)}` };

  const store = await openBoardStore(options);
  await store.commit({ actorId: "muster-orchestrator", actorKind: "system", summary: "open" }, {
    type: "board_opened", defaults: { defaultWipPerModel: 4, defaultWipPerAgent: 4 },
  });
  await store.commit({ actorId: "muster-orchestrator", actorKind: "system", summary: "card" }, {
    type: "model_card_registered", card: MODEL_CARD_SEED.find((card) => card.id === CODEX_CARD)!,
  });
  await store.commit({ actorId: "muster-orchestrator", actorKind: "system", summary: "create" }, {
    type: "task_created", taskId: "t1", task: sampleTask("t1"),
  });
  const written = snapshotKanbanBoard(store.state());

  const raw = await readFile(boardEventsPath("wave", cwd), "utf8");
  const events = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as KanbanEvent);
  assert.deepEqual(events.map((event) => event.type), ["board_opened", "model_card_registered", "task_created"]);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3]);
  assert.ok(events.every((event) => event.boardId === "board.wave" && event.tenantId === "local"));

  const reopened = await openBoardStore(options);
  assert.deepEqual(snapshotKanbanBoard(reopened.state()), written);
  assert.equal(reopened.state().nextSequence, 4);

  // A rejected transition leaves no trace on disk: the reducer runs first.
  await assert.rejects(reopened.commit({ actorId: "x", actorKind: "system", summary: "illegal" }, {
    type: "task_completed", taskId: "t1", reviewerId: "r", receiptHash: "sha256:x",
  }));
  assert.equal((await readFile(boardEventsPath("wave", cwd), "utf8")).split("\n").filter(Boolean).length, 3);
  assert.deepEqual(snapshotKanbanBoard(reopened.state()), written);
});

test("a repeated event id fails loudly instead of writing a line replay will ignore", async () => {
  const cwd = await workspace();
  const store = await openBoardStore({ sessionName: "dup", cwd, now: () => FIXED_NOW, newId: () => "same-id" });
  await store.commit({ actorId: "o", actorKind: "system", summary: "open" }, {
    type: "board_opened", defaults: { defaultWipPerModel: 4, defaultWipPerAgent: 4 },
  });
  await assert.rejects(
    store.commit({ actorId: "o", actorKind: "system", summary: "create" }, { type: "task_created", taskId: "t1", task: sampleTask("t1") }),
    /event ids must be unique per task set/,
  );
  // The log still replays to exactly what the caller was shown.
  assert.equal((await readFile(boardEventsPath("dup", cwd), "utf8")).split("\n").filter(Boolean).length, 1);
  const reopened = await openBoardStore({ sessionName: "dup", cwd });
  assert.deepEqual(snapshotKanbanBoard(reopened.state()), snapshotKanbanBoard(store.state()));
});

test("boards are per session, so two named chats never share a log", async () => {
  const cwd = await workspace();
  const first = harness(cwd, { plan: async () => TWO_TASK_PLAN, sessionName: "alpha" });
  await runMissionCommand("goal one", first.deps);

  const second = harness(cwd, { sessionName: "beta" });
  const snapshot = await runBoardCommand(second.deps);
  assert.equal(snapshot.boardId, "board.beta");
  assert.equal(Object.values(snapshot.counts).reduce((sum, count) => sum + count, 0), 0);
  assert.notEqual(boardEventsPath("alpha", cwd), boardEventsPath("beta", cwd));
});

test("a mission on an existing board keeps numbering and does not re-register cards", async () => {
  const cwd = await workspace();
  await runMissionCommand("first goal", harness(cwd, { plan: async () => TWO_TASK_PLAN }).deps);
  const second = harness(cwd, { plan: async () => TWO_TASK_PLAN });
  const outcome = await runMissionCommand("second goal", second.deps);
  assert.deepEqual(outcome?.tasks, ["t3", "t4"]);

  const events = (await readFile(boardEventsPath("main", cwd), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as KanbanEvent);
  assert.equal(events.filter((event) => event.type === "board_opened").length, 1);
  assert.equal(events.filter((event) => event.type === "model_card_registered").length, 2);
  assert.equal(events.filter((event) => event.type === "task_created").length, 4);
});

test("narration is recorded as throttled task_progress evidence, deduplicated", async () => {
  const cwd = await workspace();
  const { deps } = harness(cwd, {
    plan: async () => TWO_TASK_PLAN,
    execute: async (input) => {
      input.onNarration("reading api/limiter.ts");
      input.onNarration("reading api/limiter.ts");
      input.onNarration("writing api/limiter.ts");
      return { ok: true, summary: "done", runId: `run-${input.task.id}` };
    },
  });
  await runMissionCommand("harden", deps);
  const events = (await readFile(boardEventsPath("main", cwd), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as KanbanEvent);
  const progress = events.filter((event) => event.type === "task_progress");
  assert.deepEqual(progress.map((event) => (event as { note: string }).note), [
    "reading api/limiter.ts", "writing api/limiter.ts", "reading api/limiter.ts", "writing api/limiter.ts",
  ]);
  assert.ok(progress.every((event) => event.actorKind === "agent"));
});

/* ---------------------------------- manual override ---------------------------------- */

async function boardWithReadyTask(cwd: string): Promise<void> {
  let counter = 0;
  const store = await openBoardStore({ sessionName: "main", cwd, now: () => FIXED_NOW, newId: () => `seed-${(counter += 1)}` });
  await store.commit({ actorId: "muster-orchestrator", actorKind: "system", summary: "open" }, {
    type: "board_opened", defaults: { defaultWipPerModel: 4, defaultWipPerAgent: 4 },
  });
  for (const cardId of [CLAUDE_CARD, CODEX_CARD]) {
    await store.commit({ actorId: "muster-orchestrator", actorKind: "system", summary: "card" }, {
      type: "model_card_registered", card: MODEL_CARD_SEED.find((card) => card.id === cardId)!,
    });
  }
  await store.commit({ actorId: "muster-orchestrator", actorKind: "system", summary: "create" }, {
    type: "task_created", taskId: "t1", task: sampleTask("t1"),
  });
  await store.commit({ actorId: "muster-orchestrator", actorKind: "system", summary: "ready" }, {
    type: "task_ready", taskId: "t1", satisfiedDependencies: [],
  });
}

test("/assign records a user-override as an event, scored by the same selector", async () => {
  const cwd = await workspace();
  await boardWithReadyTask(cwd);

  const router = harness(cwd, {});
  assert.equal(await runAssignCommand("t1", CODEX_CARD, router.deps), true);
  const override = harness(cwd, {});
  assert.equal(await runAssignCommand("t1", CLAUDE_CARD, override.deps), true);

  const events = (await readFile(boardEventsPath("main", cwd), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as KanbanEvent);
  const unassigned = events.filter((event) => event.type === "task_unassigned");
  assert.equal(unassigned.length, 1);
  assert.equal((unassigned[0] as { reason: string }).reason, "user-override");
  assert.equal(unassigned[0]!.actorKind, "human");
  assert.equal(unassigned[0]!.actorId, "user");

  const assigned = events.filter((event) => event.type === "task_assigned");
  assert.equal(assigned.length, 2);
  const last = assigned.at(-1) as unknown as { assignment: { cardId: string; total: number; rationale: string; breakdown: { weight: number; weighted: number }[] } };
  assert.equal(last.assignment.cardId, CLAUDE_CARD);
  assert.ok(last.assignment.rationale.startsWith("user-override:"));
  // The override is auditable arithmetic, not a rubber stamp.
  assert.equal(last.assignment.breakdown.reduce((sum, entry) => sum + entry.weight, 0), 100);
  assert.equal(last.assignment.breakdown.reduce((sum, entry) => sum + entry.weighted, 0), last.assignment.total);

  const reader = harness(cwd, {});
  const explanation = await runWhyCommand("t1", reader.deps);
  assert.equal(explanation?.assignment?.cardId, CLAUDE_CARD);
  assert.ok(
    explanation?.notes.some((note) => note.includes("recorded by a user-override")),
    "the /why table must say a human pinned this card",
  );
  // The router's own answer is still shown, so the override is visibly a choice.
  assert.ok(
    explanation?.notes.some((note) => note.includes(`the router would pick ${CODEX_CARD}`)),
    `divergence note missing from:\n${explanation?.notes.join("\n")}`,
  );
  assert.match(override.lines.join("\n"), new RegExp(`^◔ t1 task t1 → ${escapeRegExp(CLAUDE_CARD)} \\(\\d+\\)$`, "m"));
  assert.match(override.lines.join("\n"), /recorded as user-override/);
});

test("/assign refuses what the reducer would reject, and says which gate blocked it", async () => {
  const cwd = await workspace();
  let counter = 0;
  const store = await openBoardStore({ sessionName: "main", cwd, now: () => FIXED_NOW, newId: () => `seed-${(counter += 1)}` });
  await store.commit({ actorId: "o", actorKind: "system", summary: "open" }, {
    type: "board_opened", defaults: { defaultWipPerModel: 4, defaultWipPerAgent: 4 },
  });
  for (const cardId of [CLAUDE_CARD, CODEX_CARD]) {
    await store.commit({ actorId: "o", actorKind: "system", summary: "card" }, {
      type: "model_card_registered", card: MODEL_CARD_SEED.find((card) => card.id === cardId)!,
    });
  }
  // test_authoring is a claude capability; codex's card does not carry it.
  const task = { ...sampleTask("t1"), requiredCapabilities: ["test_authoring"] };
  await store.commit({ actorId: "o", actorKind: "system", summary: "create" }, { type: "task_created", taskId: "t1", task });
  await store.commit({ actorId: "o", actorKind: "system", summary: "ready" }, { type: "task_ready", taskId: "t1", satisfiedDependencies: [] });

  const before = (await readFile(boardEventsPath("main", cwd), "utf8")).split("\n").filter(Boolean).length;
  const attempt = harness(cwd, {});
  assert.equal(await runAssignCommand("t1", CODEX_CARD, attempt.deps), false);
  assert.match(attempt.lines.join("\n"), new RegExp(`override refused: ${escapeRegExp(CODEX_CARD)} is blocked at gate "capability" — missing capabilities \\[test_authoring\\]`));
  assert.equal((await readFile(boardEventsPath("main", cwd), "utf8")).split("\n").filter(Boolean).length, before);

  const unknown = harness(cwd, {});
  assert.equal(await runAssignCommand("t9", CLAUDE_CARD, unknown.deps), false);
  assert.match(unknown.lines.join("\n"), /no task "t9" in tasks\.main/);
  const unknownCard = harness(cwd, {});
  assert.equal(await runAssignCommand("t1", "openai/gpt-5.4", unknownCard.deps), false);
  assert.match(unknownCard.lines.join("\n"), /card "openai\/gpt-5\.4" is not registered for these tasks — known: /);
});

test("/assign will not rewrite work already in flight", async () => {
  const cwd = await workspace();
  await boardWithReadyTask(cwd);
  const first = harness(cwd, {});
  await runAssignCommand("t1", CLAUDE_CARD, first.deps);
  let counter = 0;
  const store = await openBoardStore({ sessionName: "main", cwd, now: () => FIXED_NOW, newId: () => `run-${(counter += 1)}` });
  await store.commit({ actorId: "o", actorKind: "system", summary: "start" }, {
    type: "task_started", taskId: "t1", agentId: "muster-subagent", attemptId: "a1",
  });

  const blocked = harness(cwd, {});
  assert.equal(await runAssignCommand("t1", CODEX_CARD, blocked.deps), false);
  assert.match(blocked.lines.join("\n"), /t1 is in_progress; an override would rewrite work already in flight/);
});

test("/why on an unknown task points at /board instead of guessing", async () => {
  const cwd = await workspace();
  const { deps, lines } = harness(cwd, {});
  assert.equal(await runWhyCommand("t42", deps), undefined);
  assert.match(lines.join("\n"), /no task "t42" in tasks\.main — \/tasks lists what exists/);
  assert.equal(explainAssignment((await openBoardStore({ sessionName: "main", cwd })).state(), "t42"), undefined);
});
