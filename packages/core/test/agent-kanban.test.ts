import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTEXT_HEADROOM,
  KANBAN_CAPACITY_STATUSES,
  KANBAN_PRIORITY_RANK,
  KANBAN_STATUSES,
  KANBAN_TRANSITIONS,
  MAX_EVENT_STRING_CHARS,
  MAX_TASK_ATTEMPTS,
  MODEL_CARD_SEED,
  SELECTION_BASE_WEIGHTS,
  SELECTION_GATE_ORDER,
  SELECTION_PRIORITY_WEIGHTS,
  assignWithConsultation,
  computeReadyTasks,
  createDeterministicConsultStrategy,
  createKanbanBoardState,
  findKanbanDependencyCycles,
  findModelCard,
  isLegalKanbanTransition,
  KanbanEventConflictError,
  nextKanbanEvent,
  parseKanbanTask,
  planKanbanAssignments,
  reduceKanbanEvent,
  renderContextBundle,
  renderKanbanBoard,
  renderSelectionRationale,
  replayKanbanEvents,
  resolveContext,
  selectModelForTask,
  snapshotKanbanBoard,
  suggestCapabilityMatches,
  toContextBundleReceipt,
  validateKanbanTask,
  type ContextRef,
  type ContextRequest,
  type ContextResolution,
  type ContextResolver,
  type KanbanBoardState,
  type KanbanEvent,
  type KanbanEventBody,
  type KanbanEventEnvelope,
  type KanbanTask,
  type ModelCard,
  type SelectionDimension,
  type TaskAssignment,
} from "../src/agent-kanban.js";
import { PROVIDER_PRESETS } from "../src/providers-catalog.js";

// ---------------------------------------------------------------------------
// Local fixtures. Every timestamp is caller-supplied: the module has no clock.
// ---------------------------------------------------------------------------

const identity = { boardId: "board-1", tenantId: "tenant-1", siteId: "site-1" };

let tick = 0;
function at(): string {
  tick += 1;
  return new Date(Date.UTC(2026, 7, 27, 0, 0, 0, 0) + tick * 1000).toISOString();
}

type EnvelopeOverrides = Partial<Pick<KanbanEventEnvelope, "id" | "at" | "actorId" | "actorKind" | "summary">>;

function ev(state: KanbanBoardState, body: KanbanEventBody, extra: EnvelopeOverrides = {}): KanbanEvent {
  return nextKanbanEvent(state, {
    id: extra.id ?? `event-${state.nextSequence}`,
    at: extra.at ?? at(),
    actorId: extra.actorId ?? "planner@example.com",
    actorKind: extra.actorKind ?? "system",
    summary: extra.summary ?? body.type,
  }, body);
}

function apply(state: KanbanBoardState, body: KanbanEventBody, extra: EnvelopeOverrides = {}, log?: KanbanEvent[]): KanbanBoardState {
  const event = ev(state, body, extra);
  log?.push(event);
  return reduceKanbanEvent(state, event);
}

function card(overrides: Partial<ModelCard> & { readonly id: string }): ModelCard {
  return {
    provider: overrides.id.split("/")[0]!,
    model: overrides.id.split("/").slice(1).join("/") || "model",
    deployment: "cloud",
    capabilities: ["code_edit", "tool_use"],
    strengths: ["refactoring"],
    costTier: "medium",
    latencyTier: "standard",
    contextWindow: 200_000,
    evidence: [{ kind: "vendor_claim", ref: "packages/core/src/providers-catalog.ts:22" }],
    ...overrides,
  };
}

function task(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: "task-1",
    title: "Fix the failing importer",
    goal: "edit the importer and add a regression test",
    requiredCapabilities: ["code_edit"],
    contextRefs: [],
    dependsOn: [],
    priority: "normal",
    createdAt: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
}

const CARD_A = card({ id: "alpha/one", strengths: ["refactoring", "code_review"] });
const CARD_B = card({ id: "beta/two", costTier: "low", latencyTier: "fast" });
const CARD_C = card({ id: "gamma/three", capabilities: ["research"], strengths: ["citations"] });

function openBoard(cards: readonly ModelCard[] = [CARD_A, CARD_B, CARD_C], log?: KanbanEvent[]): KanbanBoardState {
  let state = createKanbanBoardState(identity);
  state = apply(state, { type: "board_opened", defaults: { defaultWipPerModel: 1, defaultWipPerAgent: 1 } }, { actorId: "operator@example.com", actorKind: "human" }, log);
  for (const entry of cards) state = apply(state, { type: "model_card_registered", card: entry }, {}, log);
  return state;
}

/** A structurally valid assignment: weights sum to 100 and total equals the weighted sum. */
function assignment(cardId: string, agentId: string, extra: Partial<TaskAssignment> = {}): TaskAssignment {
  const breakdown = (Object.keys(SELECTION_BASE_WEIGHTS) as SelectionDimension[]).map((dimension) => ({
    dimension,
    raw: 1000,
    weight: SELECTION_BASE_WEIGHTS[dimension],
    weighted: SELECTION_BASE_WEIGHTS[dimension] * 10,
    reason: "fixture",
  }));
  return {
    cardId,
    agentId,
    assignedAt: "2026-08-27T00:10:00.000Z",
    total: breakdown.reduce((accumulator, entry) => accumulator + entry.weighted, 0),
    breakdown,
    policyDigest: "sha256:fixture",
    rationale: "fixture assignment",
    ...extra,
  };
}

function createReady(state: KanbanBoardState, overrides: Partial<KanbanTask> = {}, log?: KanbanEvent[]): KanbanBoardState {
  const definition = task(overrides);
  let next = apply(state, { type: "task_created", taskId: definition.id, task: definition }, {}, log);
  next = apply(next, { type: "task_ready", taskId: definition.id, satisfiedDependencies: [] }, {}, log);
  return next;
}

function driveToDone(state: KanbanBoardState, taskId: string, cardId: string, agentId: string, log?: KanbanEvent[]): KanbanBoardState {
  let next = apply(state, { type: "task_assigned", taskId, assignment: assignment(cardId, agentId) }, {}, log);
  next = apply(next, { type: "task_started", taskId, agentId, attemptId: `${taskId}-attempt-1` }, { actorId: agentId, actorKind: "agent" }, log);
  next = apply(next, { type: "task_submitted_for_review", taskId }, { actorId: agentId, actorKind: "agent" }, log);
  next = apply(next, { type: "task_completed", taskId, reviewerId: "reviewer@example.com", receiptHash: `sha256:${taskId}` }, { actorId: "reviewer@example.com", actorKind: "human" }, log);
  return next;
}

// ---------------------------------------------------------------------------
// 1-4. Envelope, payload guard, lattice, authority
// ---------------------------------------------------------------------------

test("envelope invariants: sequence, scope, timestamps, duplicate delivery", () => {
  const fresh = createKanbanBoardState(identity);
  assert.throws(() => reduceKanbanEvent(fresh, ev(fresh, { type: "task_blocked", taskId: "task-1", reason: "nope" })), /Board is not open/);

  let state = openBoard();
  const gapped = { ...ev(state, { type: "task_created", taskId: "task-1", task: task() }), sequence: state.nextSequence + 3 } as KanbanEvent;
  assert.throws(() => reduceKanbanEvent(state, gapped), new RegExp(`Expected sequence ${state.nextSequence}; received ${state.nextSequence + 3}`));

  const foreign = { ...ev(state, { type: "task_created", taskId: "task-1", task: task() }), tenantId: "tenant-2" } as KanbanEvent;
  assert.throws(() => reduceKanbanEvent(state, foreign), /authority scope does not match/);

  const backwards = { ...ev(state, { type: "task_created", taskId: "task-1", task: task() }), at: "2020-01-01T00:00:00.000Z" } as KanbanEvent;
  assert.throws(() => reduceKanbanEvent(state, backwards), /timestamp moves backwards/);

  const created = ev(state, { type: "task_created", taskId: "task-1", task: task() });
  state = reduceKanbanEvent(state, created);
  const afterDuplicate = reduceKanbanEvent(state, created);
  assert.equal(afterDuplicate, state, "duplicate transport delivery must be a no-op returning the same state");
  assert.equal(state.nextSequence, created.sequence + 1);
  assert.equal(state.tasks.get("task-1")?.status, "backlog");
});

test("forbidden payload keys and secret-looking values are rejected", () => {
  let state = openBoard();
  state = createReady(state);

  const nestedSecret = {
    ...ev(state, { type: "task_progress", taskId: "task-1", note: "working" }),
    meta: { adapter: { apiKey: "irrelevant-value" } },
  } as unknown as KanbanEvent;
  assert.throws(() => reduceKanbanEvent(state, nestedSecret), /forbidden secret or hidden-reasoning fields/);

  const thinking = { ...ev(state, { type: "task_blocked", taskId: "task-1", reason: "waiting" }), chain_of_thought: "step 1" } as unknown as KanbanEvent;
  assert.throws(() => reduceKanbanEvent(state, thinking), /forbidden secret or hidden-reasoning fields/);

  const leaked = ev(state, { type: "task_blocked", taskId: "task-1", reason: "key sk-ABCDEFGHIJKLMNOPQRSTUV rotated" });
  assert.throws(() => reduceKanbanEvent(state, leaked), /known credential pattern/);

  const oversized = ev(state, { type: "task_blocked", taskId: "task-1", reason: "x".repeat(MAX_EVENT_STRING_CHARS + 1) });
  assert.throws(() => reduceKanbanEvent(state, oversized), /longer than 4000 characters/);

  // The board is untouched by any rejected event.
  assert.equal(state.tasks.get("task-1")?.status, "ready");
});

test("transition lattice is total, done is terminal, and illegal jumps are refused", () => {
  const legalPairs = KANBAN_STATUSES.flatMap((from) => KANBAN_TRANSITIONS[from].map((to) => `${from}->${to}`));
  assert.equal(legalPairs.length, 24, "24 legal transitions out of 64 status pairs");
  for (const status of KANBAN_STATUSES) assert.ok(Array.isArray(KANBAN_TRANSITIONS[status]), `${status} must appear in the lattice`);
  for (const to of KANBAN_STATUSES) assert.equal(isLegalKanbanTransition("done", to), false, "done is terminal");
  assert.equal(isLegalKanbanTransition("backlog", "done"), false);
  assert.equal(isLegalKanbanTransition("review", "in_progress"), false, "rework re-enters via assigned so attempts stay bounded");
  assert.equal(isLegalKanbanTransition("review", "assigned"), true);
  assert.deepEqual([...KANBAN_CAPACITY_STATUSES].sort(), ["assigned", "in_progress"]);

  let state = openBoard();
  state = apply(state, { type: "task_created", taskId: "task-1", task: task() });
  assert.throws(() => apply(state, { type: "task_assigned", taskId: "task-1", assignment: assignment(CARD_A.id, "agent-1") }), /must be ready to assign \(was backlog\)/);

  state = apply(state, { type: "task_ready", taskId: "task-1", satisfiedDependencies: [] });
  assert.throws(() => apply(state, { type: "task_started", taskId: "task-1", agentId: "agent-1", attemptId: "a1" }), /must be assigned before it starts/);
  assert.throws(() => apply(state, { type: "task_ready", taskId: "task-1", satisfiedDependencies: [] }), /only become ready from backlog or blocked/);

  state = driveToDone(state, "task-1", CARD_A.id, "agent-1");
  assert.equal(state.tasks.get("task-1")?.status, "done");
  assert.throws(() => apply(state, { type: "task_progress", taskId: "task-1", note: "still going" }), /terminal \(done\)/);
  assert.throws(() => apply(state, { type: "task_blocked", taskId: "task-1", reason: "reopen" }), /terminal \(done\)/);
});

test("needs_intervention releases only to a human actor", () => {
  let state = openBoard();
  state = createReady(state);
  state = apply(state, { type: "task_escalated", taskId: "task-1", reason: "operator_request", detail: "pause for review" });
  assert.equal(state.tasks.get("task-1")?.status, "needs_intervention");

  assert.throws(
    () => apply(state, { type: "task_intervention_resolved", taskId: "task-1", resolution: "requeue", note: "self-cleared" }, { actorId: "agent-1", actorKind: "agent" }),
    /Only a human actor may resolve an intervention/,
  );
  assert.throws(
    () => apply(state, { type: "task_ready", taskId: "task-1", satisfiedDependencies: [] }),
    /only become ready from backlog or blocked/,
  );

  state = apply(state, { type: "task_intervention_resolved", taskId: "task-1", resolution: "requeue", note: "operator requeued" }, { actorId: "operator@example.com", actorKind: "human" });
  assert.equal(state.tasks.get("task-1")?.status, "ready");
});

test("task validation refuses empty capabilities, self-dependencies and unscoped context refs", () => {
  assert.deepEqual(validateKanbanTask(task()), []);
  assert.ok(validateKanbanTask(task({ requiredCapabilities: [] })).some((issue) => /at least one required capability/.test(issue)));
  assert.ok(validateKanbanTask(task({ requiredCapabilities: ["Code Edit"] })).some((issue) => /lower_snake token/.test(issue)));
  assert.ok(validateKanbanTask(task({ dependsOn: ["task-1"] })).some((issue) => /cannot depend on itself/.test(issue)));
  assert.ok(validateKanbanTask(task({ contextRefs: [{ id: "r1", kind: "memory", uri: "memory://x" } as unknown as ContextRef] }))
    .some((issue) => /unscoped ref cannot be authority-checked/.test(issue)));
  assert.ok(validateKanbanTask(task({ priority: "urgent" as never })).some((issue) => /priority is invalid/.test(issue)));
  assert.throws(() => parseKanbanTask(task({ requiredCapabilities: [] })), /Invalid kanban task/);

  const state = openBoard();
  assert.throws(() => apply(state, { type: "task_created", taskId: "task-1", task: task({ requiredCapabilities: [] }) }), KanbanEventConflictError);
});

// ---------------------------------------------------------------------------
// 6-9. Dependency gating, cycles, WIP
// ---------------------------------------------------------------------------

test("dependency gating: task_ready requires every dependency done", () => {
  let state = openBoard();
  state = apply(state, { type: "task_created", taskId: "task-a", task: task({ id: "task-a" }) });
  state = apply(state, { type: "task_created", taskId: "task-b", task: task({ id: "task-b", dependsOn: ["task-a"] }) });
  state = apply(state, { type: "task_created", taskId: "task-c", task: task({ id: "task-c", dependsOn: ["task-missing"] }) });

  assert.deepEqual(computeReadyTasks(state), ["task-a"]);
  assert.throws(() => apply(state, { type: "task_ready", taskId: "task-b", satisfiedDependencies: ["task-a"] }), /gated by "task-a" \(backlog\)/);
  assert.throws(() => apply(state, { type: "task_ready", taskId: "task-c", satisfiedDependencies: [] }), /depends on unknown task "task-missing"/);
  assert.throws(() => apply(state, { type: "task_ready", taskId: "task-b", satisfiedDependencies: ["task-c"] }), /does not depend on "task-c"/);

  state = apply(state, { type: "task_ready", taskId: "task-a", satisfiedDependencies: [] });
  state = driveToDone(state, "task-a", CARD_A.id, "agent-1");
  assert.deepEqual(computeReadyTasks(state), ["task-b"]);
  state = apply(state, { type: "task_ready", taskId: "task-b", satisfiedDependencies: ["task-a"] });
  assert.equal(state.tasks.get("task-b")?.status, "ready");
});

test("dependency cycles are reported, never silently starved", () => {
  let state = openBoard();
  state = apply(state, { type: "task_created", taskId: "task-a", task: task({ id: "task-a", dependsOn: ["task-b"] }) });
  state = apply(state, { type: "task_created", taskId: "task-b", task: task({ id: "task-b", dependsOn: ["task-a"] }) });
  state = apply(state, { type: "task_created", taskId: "task-solo", task: task({ id: "task-solo" }) });

  assert.deepEqual(findKanbanDependencyCycles(state), [["task-a", "task-b"]]);
  assert.deepEqual(computeReadyTasks(state), ["task-solo"], "cycle members never become ready");

  let acyclic = openBoard();
  acyclic = apply(acyclic, { type: "task_created", taskId: "task-a", task: task({ id: "task-a" }) });
  assert.deepEqual(findKanbanDependencyCycles(acyclic), []);
});

test("per-model and per-agent WIP limits block assignment and release on unassign, review and escalation", () => {
  let state = openBoard();
  state = createReady(state, { id: "task-1" });
  state = createReady(state, { id: "task-2" });
  state = apply(state, { type: "task_assigned", taskId: "task-1", assignment: assignment(CARD_A.id, "agent-1") });
  assert.equal(state.loadByModel.get(CARD_A.id), 1);
  assert.equal(state.loadByAgent.get("agent-1"), 1);

  assert.throws(() => apply(state, { type: "task_assigned", taskId: "task-2", assignment: assignment(CARD_A.id, "agent-2") }), /Card "alpha\/one" is at its WIP limit \(1\/1\)/);
  assert.throws(() => apply(state, { type: "task_assigned", taskId: "task-2", assignment: assignment(CARD_B.id, "agent-1") }), /Agent "agent-1" is at its WIP limit \(1\/1\)/);

  const unassigned = apply(state, { type: "task_unassigned", taskId: "task-1", reason: "operator recall" });
  assert.equal(unassigned.loadByModel.get(CARD_A.id), undefined);
  assert.equal(unassigned.loadByAgent.get("agent-1"), undefined);
  assert.equal(unassigned.tasks.get("task-1")?.assignment, undefined);
  assert.doesNotThrow(() => apply(unassigned, { type: "task_assigned", taskId: "task-2", assignment: assignment(CARD_A.id, "agent-1") }));

  // review releases capacity; the reducer derives that from status alone.
  let working = apply(state, { type: "task_started", taskId: "task-1", agentId: "agent-1", attemptId: "a1" }, { actorId: "agent-1", actorKind: "agent" });
  assert.equal(working.loadByModel.get(CARD_A.id), 1, "in_progress still holds capacity");
  working = apply(working, { type: "task_submitted_for_review", taskId: "task-1" }, { actorId: "agent-1", actorKind: "agent" });
  assert.equal(working.loadByModel.get(CARD_A.id), undefined);
  // rework re-acquires it.
  working = apply(working, { type: "task_review_rejected", taskId: "task-1", reviewerId: "reviewer@example.com", reason: "missing test" }, { actorId: "reviewer@example.com", actorKind: "human" });
  assert.equal(working.tasks.get("task-1")?.status, "assigned");
  assert.equal(working.loadByModel.get(CARD_A.id), 1);
  assert.throws(
    () => apply(working, { type: "task_review_rejected", taskId: "task-1", reviewerId: "agent-1", reason: "self review" }, { actorId: "agent-1", actorKind: "agent" }),
    /is not in review/,
  );

  const escalated = apply(state, { type: "task_escalated", taskId: "task-1", reason: "operator_request", detail: "halt" });
  assert.equal(escalated.loadByModel.get(CARD_A.id), undefined);
  assert.equal(escalated.loadByAgent.get("agent-1"), undefined);
});

test("wip_limit_set changes capacity mid-board and replays identically", () => {
  const log: KanbanEvent[] = [];
  let state = openBoard([CARD_A, CARD_B, CARD_C], log);
  state = createReady(state, { id: "task-1" }, log);
  state = createReady(state, { id: "task-2" }, log);
  state = apply(state, { type: "wip_limit_set", scope: "model", targetId: CARD_A.id, limit: 2 }, { actorId: "operator@example.com", actorKind: "human" }, log);
  state = apply(state, { type: "wip_limit_set", scope: "default_agent", limit: 3 }, { actorId: "operator@example.com", actorKind: "human" }, log);
  state = apply(state, { type: "task_assigned", taskId: "task-1", assignment: assignment(CARD_A.id, "agent-1") }, {}, log);
  state = apply(state, { type: "task_assigned", taskId: "task-2", assignment: assignment(CARD_A.id, "agent-1") }, {}, log);
  assert.equal(state.loadByModel.get(CARD_A.id), 2);
  assert.equal(state.loadByAgent.get("agent-1"), 2);

  assert.throws(() => apply(state, { type: "wip_limit_set", scope: "model", limit: 4 }), /targetId for scope model is required/);
  assert.throws(() => apply(state, { type: "wip_limit_set", scope: "default_model", limit: -1 }), /non-negative integer limit/);

  const replayed = replayKanbanEvents(createKanbanBoardState(identity), log);
  assert.deepStrictEqual(replayed, state, "the board is reconstructable from its log alone");
});

// ---------------------------------------------------------------------------
// 10-18. Selection
// ---------------------------------------------------------------------------

test("a fail-closed escalation names the nearest known capability instead of just refusing", () => {
  // The gate is unchanged — the DETAIL is what gains the pointer, so an
  // operator who typed "code_edits" is not left staring at a blank refusal.
  const selection = selectModelForTask(task({ requiredCapabilities: ["code_edits"] }), MODEL_CARD_SEED);

  assert.equal(selection.outcome, "needs_intervention");
  if (selection.outcome !== "needs_intervention") return;
  assert.equal(selection.reason, "no_qualified_model");
  assert.match(selection.detail, /no card declares "code_edits" — did you mean code_edit\?/);
  // Deterministic: the same board escalates with the same bytes every time.
  assert.equal(selectModelForTask(task({ requiredCapabilities: ["code_edits"] }), MODEL_CARD_SEED).detail, selection.detail);
});

test("a capability every card lacks BUT that some card declares gets no invented suggestion", () => {
  // "vision" is a real, declared capability; CARD_A/B/C simply do not have it.
  // That is a capacity/coverage fact, not a typo, so no hint is fabricated.
  const selection = selectModelForTask(task({ requiredCapabilities: ["code_edit", "vision"] }), [CARD_A, CARD_B, CARD_C]);
  assert.equal(selection.outcome, "needs_intervention");
  if (selection.outcome !== "needs_intervention") return;
  assert.doesNotMatch(selection.detail, /did you mean/);
});

test("suggestCapabilityMatches ranks by edit distance, then alphabetically, and stays bounded", () => {
  const known = ["code_edit", "code_review", "classification", "long_context"];
  assert.deepEqual(suggestCapabilityMatches("code_edits", known), ["code_edit"]);
  // Substring relation counts even past the distance ceiling.
  assert.deepEqual(suggestCapabilityMatches("edit", known), ["code_edit"]);
  assert.deepEqual(suggestCapabilityMatches("code_", known), ["code_edit", "code_review"]);
  // Nothing close: refuse to guess.
  assert.deepEqual(suggestCapabilityMatches("quantum_annealing", known), []);
  assert.equal(suggestCapabilityMatches("code_", known).length <= 3, true);
});

test("selection fails closed to needs_intervention when no card covers the capabilities", () => {
  const selection = selectModelForTask(task({ requiredCapabilities: ["code_edit", "vision"] }), [CARD_A, CARD_B, CARD_C]);
  assert.equal(selection.outcome, "needs_intervention");
  if (selection.outcome !== "needs_intervention") return;
  assert.equal(selection.reason, "no_qualified_model");
  assert.match(selection.detail, /no card qualified for capabilities \[code_edit, vision\]/);
  assert.equal(selection.candidates.length, 3);
  for (const candidate of selection.candidates) {
    assert.equal(candidate.qualified, false);
    assert.equal(candidate.blockedBy, "capability");
    assert.equal(candidate.total, 0);
    assert.deepEqual(candidate.breakdown, []);
    assert.deepEqual(candidate.gates.map((gate) => gate.id), [...SELECTION_GATE_ORDER], "all nine gates are always reported");
  }
  assert.match(selection.rationale, /alpha\/one blocked at capability: missing capabilities \[vision\]/);
  // Fail-closed, not fuzzy: a typo'd capability escalates rather than guessing a near match.
  const typo = selectModelForTask(task({ requiredCapabilities: ["code_edits"] }), [CARD_A]);
  assert.equal(typo.outcome, "needs_intervention");
  assert.equal(selectModelForTask(task(), []).outcome, "needs_intervention");
  assert.match(renderSelectionRationale(selectModelForTask(task(), [])), /no model cards registered/);
});

test("selection is order-independent and deterministic under shuffled card input", () => {
  const cards = [CARD_A, CARD_B, card({ id: "delta/four", costTier: "free", latencyTier: "realtime" }), CARD_C];
  const subject = task({ preferredStrengths: ["refactoring", "code_review"] });
  const forward = selectModelForTask(subject, cards);
  const reversed = selectModelForTask(subject, [...cards].reverse());
  const rotated = selectModelForTask(subject, [cards[2]!, cards[0]!, cards[3]!, cards[1]!]);
  assert.deepStrictEqual(reversed, forward);
  assert.deepStrictEqual(rotated, forward);
  assert.equal(JSON.stringify(reversed), JSON.stringify(forward), "byte-identical, not merely deep-equal");
  assert.deepStrictEqual(selectModelForTask(subject, cards), forward, "repeated calls are stable");
});

test("score breakdown is auditable: weights sum to 100 and total equals the sum of weighted parts", () => {
  for (const [priority, weights] of Object.entries(SELECTION_PRIORITY_WEIGHTS)) {
    const sum = Object.values(weights).reduce((accumulator, weight) => accumulator + weight, 0);
    assert.equal(sum, 100, `${priority} weights must sum to 100`);
  }
  assert.equal(Object.values(SELECTION_BASE_WEIGHTS).reduce((a, b) => a + b, 0), 100);

  const selection = selectModelForTask(task({ preferredStrengths: ["refactoring"] }), [CARD_A, CARD_B]);
  assert.equal(selection.outcome, "selected");
  if (selection.outcome !== "selected") return;
  assert.deepEqual([...selection.breakdown].map((entry) => entry.dimension).sort(), ["context", "cost", "evidence", "latency", "strength"]);
  assert.equal(selection.breakdown.reduce((accumulator, entry) => accumulator + entry.weight, 0), 100);
  assert.equal(selection.breakdown.reduce((accumulator, entry) => accumulator + entry.weighted, 0), selection.total);
  for (const entry of selection.breakdown) {
    assert.equal(entry.weighted, Math.round((entry.raw * entry.weight) / 100));
    assert.ok(entry.raw >= 0 && entry.raw <= 1000);
    assert.ok(entry.reason.length > 0, "every dimension explains itself");
  }
  // A custom weight vector that does not sum to 100 is normalized, keeping the audit invariant true.
  const custom = selectModelForTask(task(), [CARD_A], { weights: { strength: 10, cost: 10, latency: 10, context: 10, evidence: 10 } });
  assert.equal(custom.outcome, "selected");
  if (custom.outcome !== "selected") return;
  assert.equal(custom.breakdown.reduce((accumulator, entry) => accumulator + entry.weight, 0), 100);
  assert.equal(custom.breakdown.reduce((accumulator, entry) => accumulator + entry.weighted, 0), custom.total);
});

test("golden vector pins the arithmetic", () => {
  const golden = card({
    id: "acme/golden",
    capabilities: ["code_edit"],
    strengths: ["refactoring", "sql"],
    costTier: "low",
    latencyTier: "fast",
    contextWindow: 80_000,
    evidence: [{ kind: "vendor_claim", ref: "packages/core/src/providers-catalog.ts:22" }],
  });
  const subject = task({ preferredStrengths: ["refactoring", "low_latency"] });

  const selection = selectModelForTask(subject, [golden]);
  assert.equal(selection.outcome, "selected");
  if (selection.outcome !== "selected") return;
  const byDimension = Object.fromEntries(selection.breakdown.map((entry) => [entry.dimension, entry.weighted]));
  assert.deepEqual(byDimension, { context: 120, cost: 128, evidence: 80, latency: 128, strength: 175 });
  assert.equal(selection.total, 631);
  assert.equal(selection.tieBreak, "score");
  assert.equal(selection.runnerUpCardId, undefined);

  // An undeclared context need scores the neutral 800 band. Declaring a need 8x smaller than the
  // window promotes it to the 1000 band: 150 weighted, total 661.
  const withNeed = selectModelForTask({ ...subject, estimatedContextTokens: 10_000 }, [golden]);
  assert.equal(withNeed.outcome, "selected");
  if (withNeed.outcome !== "selected") return;
  assert.deepEqual(Object.fromEntries(withNeed.breakdown.map((entry) => [entry.dimension, entry.weighted])), { context: 150, cost: 128, evidence: 80, latency: 128, strength: 175 });
  assert.equal(withNeed.total, 661);
});

test("priority weighting flips the winner between a premium and a cheap card", () => {
  const premium = card({ id: "premium/model", strengths: ["refactoring", "code_review"], costTier: "premium", latencyTier: "standard" });
  const cheap = card({ id: "cheap/model", strengths: ["refactoring"], costTier: "free", latencyTier: "fast" });
  const subject = task({ preferredStrengths: ["refactoring", "code_review"] });

  const normal = selectModelForTask({ ...subject, priority: "normal" }, [premium, cheap]);
  assert.equal(normal.outcome === "selected" && normal.cardId, "premium/model");
  const low = selectModelForTask({ ...subject, priority: "low" }, [premium, cheap]);
  assert.equal(low.outcome === "selected" && low.cardId, "cheap/model");
  assert.equal(KANBAN_PRIORITY_RANK.critical < KANBAN_PRIORITY_RANK.low, true);
  if (normal.outcome === "selected" && low.outcome === "selected") {
    assert.notEqual(normal.policyDigest, low.policyDigest, "priority changes the effective weight vector, so the digest changes");
    assert.equal(normal.runnerUpCardId, "cheap/model");
    assert.ok(normal.margin > 0);
  }
});

test("policy gates: provider allowlist, denylist, cost and latency ceilings", () => {
  const cards = [CARD_A, CARD_B];
  const blockedBy = (selection: ReturnType<typeof selectModelForTask>, cardId: string): string | undefined =>
    selection.candidates.find((candidate) => candidate.cardId === cardId)?.blockedBy;

  const allow = selectModelForTask(task(), cards, { allowedProviders: ["beta"] });
  assert.equal(allow.outcome === "selected" && allow.cardId, CARD_B.id);
  assert.equal(blockedBy(allow, CARD_A.id), "provider");

  const deny = selectModelForTask(task(), cards, { allowedProviders: ["alpha", "beta"], deniedProviders: ["beta"] });
  assert.equal(deny.outcome === "selected" && deny.cardId, CARD_A.id, "denial always wins over an allowlist");
  assert.equal(blockedBy(deny, CARD_B.id), "provider");

  const cost = selectModelForTask(task(), cards, { maxCostTier: "low" });
  assert.equal(cost.outcome === "selected" && cost.cardId, CARD_B.id);
  assert.equal(blockedBy(cost, CARD_A.id), "cost");

  const latency = selectModelForTask(task(), cards, { maxLatencyTier: "fast" });
  assert.equal(latency.outcome === "selected" && latency.cardId, CARD_B.id);
  assert.equal(blockedBy(latency, CARD_A.id), "latency");

  // WIP saturation of the winner falls back to the runner-up rather than escalating.
  const saturated = selectModelForTask(task(), cards, { modelLoad: new Map([[CARD_B.id, 1]]), defaultWipPerModel: 1, maxCostTier: "medium" });
  assert.equal(saturated.outcome === "selected" && saturated.cardId, CARD_A.id);
  assert.equal(blockedBy(saturated, CARD_B.id), "wip");
  // Runtime load must not perturb the policy digest an auditor compares across runs.
  const unloaded = selectModelForTask(task(), cards, { maxCostTier: "medium" });
  assert.equal(saturated.policyDigest, unloaded.policyDigest);
});

test("on_premise residency selects the self-hosted card and rejects cloud and aggregator cards", () => {
  const subject = task({ requiredCapabilities: ["code_edit", "tool_use"] });
  const selection = selectModelForTask(subject, MODEL_CARD_SEED, { requiredDataResidency: "on_premise" });
  assert.equal(selection.outcome, "selected");
  if (selection.outcome !== "selected") return;
  assert.equal(selection.cardId, "vllm/served-model");
  const winnerCard = findModelCard(selection.cardId)!;
  assert.equal(winnerCard.deployment, "local");
  assert.equal(winnerCard.dataResidency, "on_premise");
  for (const candidate of selection.candidates) {
    const entry = findModelCard(candidate.cardId)!;
    if (entry.deployment === "cloud" || entry.deployment === "aggregator") {
      assert.equal(candidate.qualified, false, `${entry.id} must not qualify under an on-premise constraint`);
      assert.ok(candidate.blockedBy === "residency" || candidate.blockedBy === "capability");
    }
  }
});

test("context headroom is enforced: a 900k-token need does not fit a 1M window", () => {
  const million = findModelCard("anthropic/claude-fable-5")!;
  assert.equal(million.contextWindow, 1_000_000);
  assert.equal(Math.ceil(900_000 * CONTEXT_HEADROOM), 1_125_000);

  const tight = selectModelForTask(task({ requiredCapabilities: ["code_edit"], estimatedContextTokens: 900_000 }), MODEL_CARD_SEED);
  assert.equal(tight.outcome, "needs_intervention");
  if (tight.outcome !== "needs_intervention") return;
  assert.equal(tight.candidates.find((candidate) => candidate.cardId === million.id)?.blockedBy, "context");

  const fits = selectModelForTask(task({ requiredCapabilities: ["code_edit"], estimatedContextTokens: 700_000 }), MODEL_CARD_SEED);
  assert.equal(fits.outcome, "selected");
  if (fits.outcome !== "selected") return;
  assert.equal(findModelCard(fits.cardId)!.contextWindow, 1_000_000);
  assert.equal(selectModelForTask(task({ estimatedContextTokens: 5_000_000 }), MODEL_CARD_SEED).outcome, "needs_intervention");
});

test("requireVerifiedEvidence excludes vendor-claim-only cards", () => {
  const probed = card({
    id: "probed/model",
    evidence: [{ kind: "live_probe", ref: "docs/STRATEGY_V2.md#2.2", metric: "first_token_ms", value: 6246 }],
    costTier: "high",
  });
  const claimed = card({ id: "claimed/model", costTier: "free", latencyTier: "realtime" });

  const open = selectModelForTask(task(), [probed, claimed]);
  assert.equal(open.outcome === "selected" && open.cardId, "claimed/model", "without the policy the cheap card wins on price");

  const strict = selectModelForTask(task(), [probed, claimed], { requireVerifiedEvidence: true });
  assert.equal(strict.outcome === "selected" && strict.cardId, "probed/model");
  const rejected = strict.candidates.find((candidate) => candidate.cardId === "claimed/model");
  assert.equal(rejected?.blockedBy, "evidence");
  assert.match(rejected?.gates.find((gate) => gate.id === "evidence")?.summary ?? "", /vendor claims only/);
});

test("seed catalog is honest and vendor-neutral", () => {
  const ids = MODEL_CARD_SEED.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "card ids are unique");
  assert.equal(MODEL_CARD_SEED.length, 20);

  const presetIds = new Set(PROVIDER_PRESETS.map((preset) => preset.id));
  for (const entry of MODEL_CARD_SEED) {
    assert.ok(entry.evidence.length > 0, `${entry.id} must cite evidence`);
    assert.ok(entry.contextWindow > 0);
    assert.equal(entry.id, `${entry.provider}/${entry.model}`);
    for (const citation of entry.evidence) assert.ok(citation.ref.trim().length > 0, `${entry.id} evidence needs a ref`);
    if (entry.provider !== "claude-code") assert.ok(presetIds.has(entry.provider), `${entry.provider} must exist in PROVIDER_PRESETS`);
  }
  assert.deepEqual([...new Set(MODEL_CARD_SEED.map((entry) => entry.deployment))].sort(), ["aggregator", "cli", "cloud", "local"]);
  for (const entry of MODEL_CARD_SEED.filter((candidate) => candidate.deployment === "local")) assert.equal(entry.dataResidency, "on_premise");

  // The finding that forced this design: the codex backend is not an audit source (STRATEGY_V2 §2.2).
  const codex = findModelCard("codex-cli/gpt-5.6-sol")!;
  assert.ok(codex.evidence.some((citation) => citation.kind === "live_probe" && citation.value === 6246));
  assert.ok(codex.caveats?.some((caveat) => /zero item\/fileChange\/patchUpdated events/.test(caveat)));

  // Anti-favoritism: an ordinary coding task must qualify several independent providers.
  const selection = selectModelForTask(task({ requiredCapabilities: ["code_edit", "tool_use"] }), MODEL_CARD_SEED);
  assert.equal(selection.outcome, "selected");
  const providers = new Set(selection.candidates.filter((candidate) => candidate.qualified).map((candidate) => findModelCard(candidate.cardId)!.provider));
  assert.ok(providers.size >= 4, `expected >= 4 distinct qualified providers, got ${providers.size}`);
});

// ---------------------------------------------------------------------------
// 20-21. Context assembly
// ---------------------------------------------------------------------------

const REFS: readonly ContextRef[] = [
  { id: "ref-spec", kind: "file", uri: "file://spec.md", scope: { kind: "workspace", id: "repo" }, required: true },
  { id: "ref-notes", kind: "memory", uri: "memory://notes", scope: { kind: "user", id: "alice" } },
  { id: "ref-secretsafe", kind: "doctype", uri: "doctype://Invoice", scope: { kind: "tenant", id: "other-tenant" } },
  { id: "ref-gone", kind: "artifact", uri: "artifact://missing", scope: { kind: "workspace", id: "repo" } },
];

function request(overrides: Partial<ContextRequest> = {}): ContextRequest {
  return {
    taskId: "task-1",
    purpose: "implement the importer fix",
    grantedScopes: [{ kind: "workspace", id: "*" }, { kind: "user", id: "alice" }],
    tokenBudget: 100,
    assembledAt: "2026-08-27T00:05:00.000Z",
    ...overrides,
  };
}

test("context bundle records inclusions, scope denials, budget exhaustion and estimated tokens", async () => {
  const seenByResolver: string[] = [];
  const resolver: ContextResolver = {
    resolve(ref): ContextResolution {
      seenByResolver.push(ref.id);
      if (ref.id === "ref-gone") return { outcome: "missing", reason: "artifact was garbage collected" };
      if (ref.id === "ref-notes") return { outcome: "included", reason: "ok", text: "n".repeat(400) };
      return { outcome: "included", reason: "ok", text: "s".repeat(40) };
    },
  };

  const bundle = await resolveContext(task({ contextRefs: REFS }), resolver, request());
  assert.deepEqual(bundle.included.map((item) => item.refId), ["ref-spec"], "required refs are resolved first");
  assert.equal(bundle.included[0]?.estimatedTokens, 10, "4 chars per token, mirroring tokens.ts");
  assert.equal(bundle.estimatedTokens, 10);
  assert.equal(bundle.truncated, true);
  assert.equal(bundle.satisfiesRequired, true);

  const denials = Object.fromEntries(bundle.denied.map((denial) => [denial.refId, denial.reason]));
  assert.deepEqual(denials, { "ref-notes": "budget_exhausted", "ref-secretsafe": "out_of_scope", "ref-gone": "missing" });
  assert.equal(seenByResolver.includes("ref-secretsafe"), false, "deny-by-default: the store never sees an out-of-scope ref");
  assert.deepEqual(seenByResolver, ["ref-spec", "ref-notes", "ref-gone"]);

  // A required ref that is denied fails the bundle closed.
  const narrow = await resolveContext(task({ contextRefs: REFS }), resolver, request({ grantedScopes: [{ kind: "user", id: "alice" }] }));
  assert.equal(narrow.satisfiesRequired, false);
  assert.equal(narrow.denied.find((denial) => denial.refId === "ref-spec")?.reason, "out_of_scope");

  // A throwing resolver becomes a denial carrying the error name only, never its message.
  const explosive: ContextResolver = {
    resolve(): ContextResolution { throw new TypeError("connection string postgres://user:hunter2@db/prod failed"); },
  };
  const failed = await resolveContext(task({ contextRefs: [REFS[0]!] }), explosive, request());
  assert.equal(failed.denied[0]?.reason, "resolver_error");
  assert.equal(failed.denied[0]?.detail, "TypeError");
  assert.equal(failed.satisfiesRequired, false);
  assert.equal(JSON.stringify(failed).includes("hunter2"), false);

  // A resolver that truncates on its own terms stays attributable.
  const truncating: ContextResolver = {
    resolve(): ContextResolution { return { outcome: "truncated", reason: "head 20 chars", text: "t".repeat(20), estimatedTokens: 5 }; },
  };
  const trimmed = await resolveContext(task({ contextRefs: [REFS[0]!] }), truncating, request());
  assert.equal(trimmed.truncated, true);
  assert.equal(trimmed.included[0]?.truncated, true);
  assert.equal(trimmed.estimatedTokens, 5);
  assert.match(renderContextBundle(trimmed), /truncated/);
});

test("context bundle receipt carries digests only", async () => {
  const secretText = "PATIENT NAME: Alice Example, MRN 12345";
  const resolver: ContextResolver = { resolve(): ContextResolution { return { outcome: "included", reason: "ok", text: secretText }; } };
  const bundle = await resolveContext(task({ contextRefs: [REFS[0]!] }), resolver, request());
  assert.equal(bundle.included[0]?.text, secretText, "the in-memory bundle carries text");

  const receipt = toContextBundleReceipt(bundle);
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes("PATIENT"), false);
  assert.equal(serialized.includes("Alice Example"), false);
  assert.equal(serialized.includes("text"), false);
  assert.deepEqual(receipt.includedRefIds, ["ref-spec"]);
  assert.equal(receipt.itemDigests.length, 1);
  assert.match(receipt.itemDigests[0]!, /^sha256:[0-9a-f]{64}$/);
  assert.equal(receipt.digest, bundle.digest);
  assert.equal(receipt.estimatedTokens, bundle.estimatedTokens);
  assert.match(renderContextBundle(receipt), /^context task-1 — implement the importer fix/);

  // Two assemblies of the same content produce the same digest; different content does not.
  const again = toContextBundleReceipt(await resolveContext(task({ contextRefs: [REFS[0]!] }), resolver, request()));
  assert.equal(again.digest, receipt.digest);
  const other: ContextResolver = { resolve(): ContextResolution { return { outcome: "included", reason: "ok", text: `${secretText}!` }; } };
  const changed = toContextBundleReceipt(await resolveContext(task({ contextRefs: [REFS[0]!] }), other, request()));
  assert.notEqual(changed.digest, receipt.digest);
});

// ---------------------------------------------------------------------------
// 22-24. Reducer re-validation, consultation, lifecycle
// ---------------------------------------------------------------------------

test("assignment is re-validated by the reducer", async () => {
  let state = openBoard();
  state = createReady(state, { id: "task-1", requiredCapabilities: ["code_edit", "tool_use"] });

  // A forged assignment naming a card that lacks a required capability is refused outright.
  assert.throws(
    () => apply(state, { type: "task_assigned", taskId: "task-1", assignment: assignment(CARD_C.id, "agent-1") }),
    /lacks required capabilities \[code_edit, tool_use\]/,
  );
  assert.throws(
    () => apply(state, { type: "task_assigned", taskId: "task-1", assignment: assignment("ghost/model", "agent-1") }),
    /names unregistered card "ghost\/model"/,
  );
  assert.throws(
    () => apply(state, { type: "task_assigned", taskId: "task-1", assignment: assignment(CARD_A.id, "agent-1", { consultationId: "consult-nope" }) }),
    /cites unknown consultation/,
  );
  assert.throws(
    () => apply(state, { type: "task_assigned", taskId: "task-1", assignment: assignment(CARD_A.id, "agent-1", { breakdown: [] }) }),
    /carries no score breakdown/,
  );
  assert.throws(
    () => apply(state, { type: "task_assigned", taskId: "task-1", assignment: assignment(CARD_A.id, "agent-1", { total: 999 }) }),
    /does not equal its weighted sum/,
  );
  assert.throws(
    () => apply(state, {
      type: "task_assigned",
      taskId: "task-1",
      assignment: assignment(CARD_A.id, "agent-1", { breakdown: [{ dimension: "cost", raw: 1000, weight: 40, weighted: 400, reason: "forged" }], total: 400 }),
    }),
    /weights sum to 40, not 100/,
  );

  // A retired card is no longer selectable, but in-flight work is untouched.
  let retired = apply(state, { type: "model_card_retired", cardId: CARD_A.id, reason: "superseded" }, { actorId: "operator@example.com", actorKind: "human" });
  assert.throws(() => apply(retired, { type: "task_assigned", taskId: "task-1", assignment: assignment(CARD_A.id, "agent-1") }), /is retired and cannot take new work/);
  retired = apply(retired, { type: "task_assigned", taskId: "task-1", assignment: assignment(CARD_B.id, "agent-1") });
  assert.equal(retired.tasks.get("task-1")?.status, "assigned");

  // A task declaring context refs cannot be assigned without a satisfied, digest-matched bundle.
  let contextual = openBoard();
  contextual = createReady(contextual, { id: "task-ctx", contextRefs: [REFS[0]!], estimatedContextTokens: 10 });
  assert.throws(
    () => apply(contextual, { type: "task_assigned", taskId: "task-ctx", assignment: assignment(CARD_A.id, "agent-1") }),
    /declares context refs but has no attached context bundle/,
  );
  const resolver: ContextResolver = { resolve(): ContextResolution { return { outcome: "included", reason: "ok", text: "s".repeat(40) }; } };
  const receipt = toContextBundleReceipt(await resolveContext(task({ id: "task-ctx", contextRefs: [REFS[0]!] }), resolver, request({ taskId: "task-ctx" })));
  contextual = apply(contextual, { type: "context_bundle_attached", taskId: "task-ctx", bundle: receipt });
  assert.throws(
    () => apply(contextual, { type: "task_assigned", taskId: "task-ctx", assignment: assignment(CARD_A.id, "agent-1", { contextBundleDigest: "sha256:stale" }) }),
    /cites a stale context bundle digest/,
  );
  assert.doesNotThrow(() => apply(contextual, { type: "task_assigned", taskId: "task-ctx", assignment: assignment(CARD_A.id, "agent-1", { contextBundleDigest: receipt.digest }) }));

  // An over-limit context need is refused even when the planner claims it fits.
  let oversized = openBoard([card({ id: "small/model", contextWindow: 10_000 })]);
  oversized = createReady(oversized, { id: "task-big", estimatedContextTokens: 9_000 });
  assert.throws(
    () => apply(oversized, { type: "task_assigned", taskId: "task-big", assignment: assignment("small/model", "agent-1") }),
    /window 10000 is below the 11250 required/,
  );
});

test("consultation may reorder qualified candidates but never admit an unqualified one", async () => {
  const cards = [CARD_A, CARD_B, CARD_C];
  const subject = task({ preferredStrengths: ["refactoring", "code_review"], goal: "refactor the importer and review the diff" });
  const deterministic = selectModelForTask(subject, cards);
  assert.equal(deterministic.outcome === "selected" && deterministic.cardId, CARD_A.id);

  // The stub judge scores token overlap, so the runner-up wins by echoing the brief.
  const strategy = createDeterministicConsultStrategy({
    id: "stub",
    maxCandidates: 2,
    answer: (brief, entry) => entry.id === CARD_B.id ? `${brief.goal} ${brief.requiredCapabilities.join(" ")}` : "I will look into it.",
    latencyMs: (entry) => (entry.id === CARD_B.id ? 120 : 90),
  });
  const consulted = await assignWithConsultation({ task: subject, cards, strategy, consultationId: "consult-1", now: "2026-08-27T00:20:00.000Z" });
  assert.equal(consulted.outcome, "selected");
  if (consulted.outcome !== "selected") return;
  assert.equal(consulted.cardId, CARD_B.id);
  assert.equal(consulted.overrodeDeterministic, true);
  assert.equal(consulted.consultation?.deterministicWinnerCardId, CARD_A.id);
  assert.equal(consulted.consultation?.verdict.judgeKind, "deterministic");
  assert.equal(consulted.consultation?.answers.length, 2, "only the gated candidates are consulted");
  for (const answer of consulted.consultation!.answers) {
    assert.match(answer.answerDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal("text" in answer, false, "answers can only enter the log as digests");
    assert.ok(answer.answerChars > 0);
  }
  assert.equal(consulted.consultation!.answers.some((answer) => answer.cardId === CARD_C.id), false, "an unqualified card is never consulted");

  // A judge naming a card outside the gated set is refused, not obeyed.
  const rogue = createDeterministicConsultStrategy({ id: "rogue", answer: () => "x" });
  const smuggler = {
    id: rogue.id,
    maxCandidates: rogue.maxCandidates,
    async consult(input: Parameters<typeof rogue.consult>[0]) {
      const result = await rogue.consult(input);
      return { ...result, verdict: { ...result.verdict, winnerCardId: CARD_C.id } };
    },
  };
  const refused = await assignWithConsultation({ task: subject, cards, strategy: smuggler, consultationId: "consult-2", now: "2026-08-27T00:21:00.000Z" });
  assert.equal(refused.outcome, "needs_intervention");
  if (refused.outcome !== "needs_intervention") return;
  assert.equal(refused.reason, "consultation_unqualified");
  assert.match(refused.detail, /not in the gated candidate set/);
  assert.equal(refused.consultation?.overrodeDeterministic, true);

  // Consultation never rescues a board with no qualified card.
  const hopeless = await assignWithConsultation({ task: task({ requiredCapabilities: ["vision"] }), cards, strategy, consultationId: "consult-3", now: "2026-08-27T00:22:00.000Z" });
  assert.equal(hopeless.outcome, "needs_intervention");
  assert.equal(hopeless.outcome === "needs_intervention" && hopeless.reason, "no_qualified_model");
  assert.equal(hopeless.consultation, undefined);

  // Without a strategy the deterministic choice passes through untouched.
  const plain = await assignWithConsultation({ task: subject, cards, consultationId: "consult-4", now: "2026-08-27T00:23:00.000Z" });
  assert.equal(plain.outcome === "selected" && plain.cardId, CARD_A.id);
  assert.equal(plain.outcome === "selected" && plain.overrodeDeterministic, false);
  assert.equal(plain.consultation, undefined);

  // The consulted winner is recorded on the board and its assignment re-validated from its own candidate row.
  let state = openBoard(cards);
  state = createReady(state, subject);
  state = apply(state, { type: "consultation_recorded", taskId: subject.id, consultation: consulted.consultation! });
  assert.equal(state.tasks.get(subject.id)?.consultationId, "consult-1");
  const row = consulted.selection.candidates.find((candidate) => candidate.cardId === CARD_B.id)!;
  state = apply(state, {
    type: "task_assigned",
    taskId: subject.id,
    assignment: {
      cardId: CARD_B.id, agentId: "agent-1", assignedAt: "2026-08-27T00:24:00.000Z",
      total: row.total, breakdown: row.breakdown, policyDigest: consulted.selection.policyDigest,
      rationale: renderSelectionRationale(consulted.selection), consultationId: "consult-1",
    },
  });
  assert.equal(state.tasks.get(subject.id)?.assignment?.cardId, CARD_B.id);
  assert.equal(state.consultations.get("consult-1")?.overrodeDeterministic, true);
});

test("full lifecycle replays to an identical, JSON-safe snapshot", async () => {
  const log: KanbanEvent[] = [];
  let state = openBoard([CARD_A, CARD_B, CARD_C], log);
  const subject = task({ id: "task-1", contextRefs: [REFS[0]!], preferredStrengths: ["refactoring", "code_review"], priority: "high" });

  state = apply(state, { type: "task_created", taskId: subject.id, task: subject }, {}, log);
  state = apply(state, { type: "task_ready", taskId: subject.id, satisfiedDependencies: [] }, {}, log);

  const resolver: ContextResolver = { resolve(): ContextResolution { return { outcome: "included", reason: "ok", text: "spec body ".repeat(8) }; } };
  const bundle = await resolveContext(subject, resolver, request());
  const receipt = toContextBundleReceipt(bundle);
  state = apply(state, { type: "context_bundle_attached", taskId: subject.id, bundle: receipt }, {}, log);

  // Plan -> apply round trip: the planner proposes, the reducer independently re-validates.
  const plan = planKanbanAssignments(state, { agents: [{ id: "agent-1" }, { id: "agent-2", allowedCardIds: [CARD_B.id] }], now: "2026-08-27T00:30:00.000Z" });
  assert.deepEqual(plan.escalations, []);
  assert.equal(plan.proposals.length, 1);
  const proposal = plan.proposals[0]!;
  assert.equal(proposal.taskId, subject.id);
  assert.equal(proposal.assignment.cardId, CARD_A.id);
  assert.equal(proposal.assignment.contextBundleDigest, receipt.digest);
  assert.equal(proposal.assignment.total, proposal.selection.total);

  const beforeAssign = snapshotKanbanBoard(state);
  state = apply(state, { type: "task_assigned", taskId: proposal.taskId, assignment: proposal.assignment }, {}, log);
  assert.deepStrictEqual(snapshotKanbanBoard(replayKanbanEvents(createKanbanBoardState(identity), log.slice(0, -1))), beforeAssign, "reducing an event never mutates the prior state");

  state = apply(state, { type: "task_started", taskId: subject.id, agentId: "agent-1", attemptId: "attempt-1" }, { actorId: "agent-1", actorKind: "agent" }, log);
  state = apply(state, { type: "task_progress", taskId: subject.id, note: "importer patched", percentComplete: 60 }, { actorId: "agent-1", actorKind: "agent" }, log);
  state = apply(state, { type: "task_submitted_for_review", taskId: subject.id, artifactDigests: [receipt.digest] }, { actorId: "agent-1", actorKind: "agent" }, log);
  assert.throws(
    () => apply(state, { type: "task_completed", taskId: subject.id, reviewerId: "agent-1", receiptHash: "sha256:self" }, { actorId: "agent-1", actorKind: "agent" }),
    /cannot be completed by its own worker/,
  );
  state = apply(state, { type: "task_completed", taskId: subject.id, reviewerId: "reviewer@example.com", receiptHash: "sha256:done-1" }, { actorId: "reviewer@example.com", actorKind: "human" }, log);

  assert.equal(state.tasks.get(subject.id)?.status, "done");
  assert.equal(state.tasks.get(subject.id)?.attempts, 1);
  assert.ok(MAX_TASK_ATTEMPTS >= state.tasks.get(subject.id)!.attempts);
  assert.equal(state.completedReceipts.get(subject.id), "sha256:done-1");
  assert.equal(state.loadByModel.size, 0, "a finished task holds no capacity");
  assert.equal(state.loadByAgent.size, 0);

  // Replay equality: reduce(events) === the incrementally folded state.
  const replayed = replayKanbanEvents(createKanbanBoardState(identity), log);
  assert.deepStrictEqual(replayed, state);
  // Duplicate transport delivery of the whole log changes nothing.
  assert.deepStrictEqual(replayKanbanEvents(replayed, log), replayed);

  const snapshot = snapshotKanbanBoard(state);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(snapshot)), snapshot, "surfaces must render from a JSON-safe projection");
  assert.equal(snapshot.counts.done, 1);
  assert.equal(snapshot.columns.done[0]?.assignedCardId, CARD_A.id);
  assert.equal(snapshot.columns.done[0]?.contextTokens, receipt.estimatedTokens);
  assert.equal(snapshot.atSequence, log.length);
  assert.equal(snapshot.cards.length, 3);
  assert.equal(JSON.stringify(snapshot).includes("spec body"), false, "no context text reaches the board projection");
  assert.match(renderKanbanBoard(snapshot), /^done {17}1 {3}task-1->alpha\/one$/m);
  assert.match(renderKanbanBoard(snapshot), /^WIP {2}idle$/m);
});
