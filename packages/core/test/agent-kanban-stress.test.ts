/**
 * Adversarial NEGATIVE + STRESS verification for agent-kanban.ts.
 *
 * The base suite (agent-kanban.test.ts) proves the happy paths; this file assumes the module is
 * wrong and tries to break it: scale (1000 tasks / 10k+ events under a wall-clock budget), forged
 * and replayed event streams, hostile resolvers, saturated WIP, and prototype-chain payloads.
 * Every scenario asserts the failure is CLOSED: rejected events leave the board byte-identical.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_EVENT_STRING_CHARS,
  MODEL_CARD_SEED,
  computeReadyTasks,
  createKanbanBoardState,
  findKanbanDependencyCycles,
  findModelCard,
  nextKanbanEvent,
  planKanbanAssignments,
  reduceKanbanEvent,
  replayKanbanEvents,
  resolveContext,
  selectModelForTask,
  snapshotKanbanBoard,
  toContextBundleReceipt,
  validateKanbanTask,
  type ContextResolution,
  type ContextResolver,
  type KanbanBoardState,
  type KanbanEvent,
  type KanbanEventBody,
  type KanbanEventEnvelope,
  type KanbanTask,
  type ModelCard,
  type SelectionPolicy,
  type TaskAssignment,
} from "../src/agent-kanban.js";

// ---------------------------------------------------------------------------
// Fixtures: caller-supplied clock, event log capture, minimal cards/tasks.
// ---------------------------------------------------------------------------

const identity = { boardId: "stress-board", tenantId: "tenant-stress", siteId: "site-1" };

const BASE_MS = Date.UTC(2026, 7, 27, 12, 0, 0, 0);
let tick = 0;
function at(): string {
  tick += 1;
  return new Date(BASE_MS + tick * 10).toISOString();
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

function task(overrides: Partial<KanbanTask> & { readonly id: string }): KanbanTask {
  return {
    title: `Task ${overrides.id}`,
    goal: "edit the module and add a regression test",
    requiredCapabilities: ["code_edit"],
    contextRefs: [],
    dependsOn: [],
    priority: "normal",
    createdAt: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
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

/** Structurally valid fixture assignment (weights sum to 100, total = Σ weighted). */
function forgedAssignment(cardId: string, agentId: string, extra: Partial<TaskAssignment> = {}): TaskAssignment {
  const breakdown = [
    { dimension: "strength" as const, raw: 1000, weight: 35, weighted: 350, reason: "fixture" },
    { dimension: "evidence" as const, raw: 1000, weight: 20, weighted: 200, reason: "fixture" },
    { dimension: "cost" as const, raw: 1000, weight: 15, weighted: 150, reason: "fixture" },
    { dimension: "latency" as const, raw: 1000, weight: 15, weighted: 150, reason: "fixture" },
    { dimension: "context" as const, raw: 1000, weight: 15, weighted: 150, reason: "fixture" },
  ];
  return { cardId, agentId, assignedAt: at(), total: 1000, breakdown, policyDigest: "sha256:fixture", rationale: "fixture", ...extra };
}

// ---------------------------------------------------------------------------
// 1. Scale: 1000 tasks x 20 model cards, driven to done, 10k+ events, < 2s.
// ---------------------------------------------------------------------------

/**
 * Wall-clock budgets measure THIS reducer, not the machine it shares.
 *
 * The 2s budget passes comfortably when the core suite runs alone and fails when
 * the core and cli suites race for the same cores — a false red that says
 * nothing about agent-kanban.ts. Two corrections: the budget is scalable via
 * MUSTER_TEST_BUDGET_SCALE (CI under contention sets 2), and the timer starts at
 * the drive loop so board setup and planning are not billed to it.
 */
function budgetMs(baseMs: number): number {
  const raw = Number(process.env.MUSTER_TEST_BUDGET_SCALE ?? "1");
  const scale = Number.isFinite(raw) && raw > 0 ? raw : 1;
  return baseMs * scale;
}

const SCALE_LOG: KanbanEvent[] = [];
let SCALE_FINAL: KanbanBoardState | undefined;

test("stress: 1000 tasks x 20 cards fully assigned and driven to done within a 2s wall-clock budget", () => {
  assert.equal(MODEL_CARD_SEED.length, 20, "the seed registry is the 20-card fixture this scenario specifies");

  // Four capability pools so the work spreads over several distinct cards.
  const pools: readonly (readonly string[])[] = [
    ["code_edit"],
    ["research", "web_search"],
    ["classification"],
    ["long_context"],
  ];

  let state = createKanbanBoardState(identity);
  state = apply(state, { type: "board_opened", defaults: { defaultWipPerModel: 2000, defaultWipPerAgent: 2000 } }, { actorId: "operator@example.com", actorKind: "human" }, SCALE_LOG);
  for (const entry of MODEL_CARD_SEED) state = apply(state, { type: "model_card_registered", card: entry }, {}, SCALE_LOG);

  for (let index = 0; index < 1000; index += 1) {
    const id = `task-${String(index).padStart(4, "0")}`;
    const definition = task({ id, requiredCapabilities: [...pools[index % pools.length]!] });
    state = apply(state, { type: "task_created", taskId: id, task: definition }, {}, SCALE_LOG);
    state = apply(state, { type: "task_ready", taskId: id, satisfiedDependencies: [] }, {}, SCALE_LOG);
  }

  const agents = [
    { id: "agent-a", maxConcurrentTasks: 250 },
    { id: "agent-b", maxConcurrentTasks: 250 },
    { id: "agent-c", maxConcurrentTasks: 250 },
    { id: "agent-d", maxConcurrentTasks: 250 },
  ];
  const plan = planKanbanAssignments(state, { agents, now: at() });
  assert.equal(plan.escalations.length, 0, `no escalations expected at this capacity: ${JSON.stringify(plan.escalations[0] ?? null)}`);
  assert.equal(plan.proposals.length, 1000, "every ready task is proposed");

  const started = performance.now();
  for (const proposal of plan.proposals) {
    const taskId = proposal.taskId;
    const agentId = proposal.assignment.agentId;
    state = apply(state, { type: "task_assigned", taskId, assignment: proposal.assignment }, {}, SCALE_LOG);
    state = apply(state, { type: "task_started", taskId, agentId, attemptId: `${taskId}-attempt-1` }, { actorId: agentId, actorKind: "agent" }, SCALE_LOG);
    for (let step = 1; step <= 4; step += 1) {
      state = apply(state, { type: "task_progress", taskId, note: `step ${step}`, percentComplete: step * 20 }, { actorId: agentId, actorKind: "agent" }, SCALE_LOG);
    }
    state = apply(state, { type: "task_submitted_for_review", taskId }, { actorId: agentId, actorKind: "agent" }, SCALE_LOG);
    state = apply(state, { type: "task_completed", taskId, reviewerId: "reviewer@example.com", receiptHash: `sha256:${taskId}` }, { actorId: "reviewer@example.com", actorKind: "human" }, SCALE_LOG);
  }
  const elapsed = performance.now() - started;

  assert.ok(elapsed < budgetMs(2000), `1000 tasks must drive to done in < ${budgetMs(2000)}ms; took ${elapsed.toFixed(0)}ms`);
  assert.ok(SCALE_LOG.length >= 10_000, `expected a 10k+ event history, got ${SCALE_LOG.length}`);

  const snapshot = snapshotKanbanBoard(state);
  assert.equal(snapshot.counts.done, 1000);
  for (const status of ["backlog", "ready", "assigned", "in_progress", "review", "blocked", "needs_intervention"] as const) {
    assert.equal(snapshot.counts[status], 0, `no task may be stranded in ${status}`);
  }
  assert.equal(state.loadByModel.size, 0, "finished work holds zero model capacity");
  assert.equal(state.loadByAgent.size, 0, "finished work holds zero agent capacity");
  assert.equal(state.completedReceipts.size, 1000);

  // Zero misassignments at scale: every assignment's card covers every required capability.
  const distinctCards = new Set<string>();
  for (const entry of state.tasks.values()) {
    const assigned = entry.assignment!;
    const model = findModelCard(assigned.cardId)!;
    distinctCards.add(model.id);
    for (const capability of entry.task.requiredCapabilities) {
      assert.ok(model.capabilities.includes(capability), `${model.id} must cover ${capability} for ${entry.task.id}`);
    }
    assert.equal(entry.attempts, 1);
  }
  assert.ok(distinctCards.size >= 4, `work must spread over the pools' distinct winners, got ${distinctCards.size}`);

  SCALE_FINAL = state;
});

test("stress: replay of the 10k-event history equals the incrementally folded state, byte for byte", () => {
  assert.ok(SCALE_FINAL, "scale scenario must have produced a final state");
  const replayed = replayKanbanEvents(createKanbanBoardState(identity), SCALE_LOG);
  assert.deepStrictEqual(replayed, SCALE_FINAL, "the board is reconstructable from its log alone");
  assert.deepStrictEqual(snapshotKanbanBoard(replayed), snapshotKanbanBoard(SCALE_FINAL!));
  // Duplicate transport delivery of the entire history is a pure no-op (same reference back).
  assert.equal(replayKanbanEvents(replayed, SCALE_LOG), replayed);
});

// ---------------------------------------------------------------------------
// 2. Dependency cycles fail closed: detected, reported, never spun on.
// ---------------------------------------------------------------------------

test("negative: circular dependsOn is detected and fails closed with no assignment and no infinite loop", () => {
  let state = apply(createKanbanBoardState(identity), { type: "board_opened", defaults: { defaultWipPerModel: 10, defaultWipPerAgent: 10 } }, { actorKind: "human" });
  state = apply(state, { type: "model_card_registered", card: card({ id: "alpha/one" }) });

  // Self-dependency is refused at validation, before it can ever enter the log.
  assert.ok(validateKanbanTask(task({ id: "task-self", dependsOn: ["task-self"] })).some((issue) => /cannot depend on itself/.test(issue)));

  // A 3-cycle plus one clean task.
  state = apply(state, { type: "task_created", taskId: "cyc-a", task: task({ id: "cyc-a", dependsOn: ["cyc-c"] }) });
  state = apply(state, { type: "task_created", taskId: "cyc-b", task: task({ id: "cyc-b", dependsOn: ["cyc-a"] }) });
  state = apply(state, { type: "task_created", taskId: "cyc-c", task: task({ id: "cyc-c", dependsOn: ["cyc-b"] }) });
  state = apply(state, { type: "task_created", taskId: "clean", task: task({ id: "clean" }) });

  assert.deepEqual(findKanbanDependencyCycles(state), [["cyc-a", "cyc-c", "cyc-b"]]);
  assert.deepEqual(computeReadyTasks(state), ["clean"], "cycle members never become ready");
  for (const member of ["cyc-a", "cyc-b", "cyc-c"]) {
    assert.throws(() => apply(state, { type: "task_ready", taskId: member, satisfiedDependencies: [] }), /is gated by/);
    assert.throws(
      () => apply(state, { type: "task_assigned", taskId: member, assignment: forgedAssignment("alpha/one", "agent-1") }),
      /must be ready to assign/,
      "a cycle member cannot be assigned even by a forged event",
    );
  }
  // The planner sees zero ready cycle members, so the cycle produces zero proposals.
  const plan = planKanbanAssignments(state, { agents: [{ id: "agent-1" }], now: at() });
  assert.deepEqual(plan.proposals.map((proposal) => proposal.taskId), []);
  // The escalation path stays open: a cycle is reported to a human, not silently starved.
  state = apply(state, { type: "task_escalated", taskId: "cyc-a", reason: "dependency_cycle", detail: "cyc-a>cyc-c>cyc-b" });
  assert.equal(state.tasks.get("cyc-a")?.status, "needs_intervention");
  assert.match(state.tasks.get("cyc-a")?.reason ?? "", /^dependency_cycle:/);

  // A 5000-node cycle terminates promptly: the DFS is iterative, so no recursion depth limit applies.
  let big = apply(createKanbanBoardState({ boardId: "big", tenantId: "t" }), { type: "board_opened", defaults: { defaultWipPerModel: 1, defaultWipPerAgent: 1 } }, { actorKind: "human" });
  const N = 5000;
  for (let index = 0; index < N; index += 1) {
    const id = `n-${String(index).padStart(4, "0")}`;
    const next = `n-${String((index + 1) % N).padStart(4, "0")}`;
    big = apply(big, { type: "task_created", taskId: id, task: task({ id, dependsOn: [next] }) });
  }
  const started = performance.now();
  const cycles = findKanbanDependencyCycles(big);
  const elapsed = performance.now() - started;
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0]!.length, N);
  assert.deepEqual(computeReadyTasks(big), [], "every member of the giant cycle stays gated");
  assert.ok(elapsed < budgetMs(1000), `5000-node cycle detection must terminate promptly; took ${elapsed.toFixed(0)}ms`);
});

// ---------------------------------------------------------------------------
// 3. Empty registry: every task escalates with a rationale, none dangles.
// ---------------------------------------------------------------------------

test("negative: empty model registry escalates every task to needs_intervention with a rationale", () => {
  let state = apply(createKanbanBoardState(identity), { type: "board_opened", defaults: { defaultWipPerModel: 5, defaultWipPerAgent: 5 } }, { actorKind: "human" });
  const taskIds: string[] = [];
  for (let index = 0; index < 25; index += 1) {
    const id = `empty-${String(index).padStart(2, "0")}`;
    taskIds.push(id);
    state = apply(state, { type: "task_created", taskId: id, task: task({ id }) });
    state = apply(state, { type: "task_ready", taskId: id, satisfiedDependencies: [] });
  }

  const plan = planKanbanAssignments(state, { agents: [{ id: "agent-1" }], now: at() });
  assert.equal(plan.proposals.length, 0);
  assert.deepEqual(plan.escalations.map((escalation) => escalation.taskId), taskIds, "every task escalates; none is silently dropped");
  for (const escalation of plan.escalations) {
    assert.equal(escalation.reason, "no_qualified_model");
    assert.equal(escalation.detail, "no model cards registered");
    assert.ok(escalation.selection, "the escalation carries the full selection evidence");
    if (escalation.selection?.outcome === "needs_intervention") {
      assert.match(escalation.selection.rationale, /no model selected \(no_qualified_model\): no model cards registered/);
    } else {
      assert.fail("selection must be needs_intervention");
    }
  }
  // Applying the escalations lands every task in needs_intervention, releasable only by a human.
  for (const escalation of plan.escalations) {
    state = apply(state, { type: "task_escalated", taskId: escalation.taskId, reason: escalation.reason, detail: escalation.detail });
  }
  const snapshot = snapshotKanbanBoard(state);
  assert.equal(snapshot.counts.needs_intervention, 25);
  assert.equal(snapshot.counts.ready, 0);
  for (const summary of snapshot.columns.needs_intervention) assert.match(summary.reason ?? "", /^no_qualified_model: no model cards registered$/);
});

// ---------------------------------------------------------------------------
// 4. Capability gap: no near-matching, no misassignment, ever.
// ---------------------------------------------------------------------------

test("negative: when every card misses one required capability there are zero misassignments", () => {
  let state = apply(createKanbanBoardState(identity), { type: "board_opened", defaults: { defaultWipPerModel: 50, defaultWipPerAgent: 50 } }, { actorKind: "human" });
  for (const entry of MODEL_CARD_SEED) state = apply(state, { type: "model_card_registered", card: entry });

  // No seed card declares this capability, so every candidate must block at the capability gate.
  const impossible = ["code_edit", "quantum_annealing"];
  for (let index = 0; index < 10; index += 1) {
    const id = `gap-${index}`;
    state = apply(state, { type: "task_created", taskId: id, task: task({ id, requiredCapabilities: impossible }) });
    state = apply(state, { type: "task_ready", taskId: id, satisfiedDependencies: [] });
  }

  const plan = planKanbanAssignments(state, { agents: [{ id: "agent-1" }], now: at() });
  assert.equal(plan.proposals.length, 0, "not one proposal may exist");
  assert.equal(plan.escalations.length, 10);
  for (const escalation of plan.escalations) {
    assert.equal(escalation.reason, "no_qualified_model");
    assert.match(escalation.detail, /no card qualified for capabilities \[code_edit, quantum_annealing\]/);
    if (escalation.selection?.outcome !== "needs_intervention") assert.fail("selection must fail closed");
    for (const candidate of escalation.selection.candidates) {
      assert.equal(candidate.qualified, false);
      const capabilityGate = candidate.gates.find((gate) => gate.id === "capability");
      assert.equal(capabilityGate?.status, "blocked", `${candidate.cardId} must block at capability`);
      assert.match(capabilityGate?.summary ?? "", /quantum_annealing/);
    }
  }
  // The reducer independently refuses a forged assignment onto every single card.
  for (const entry of MODEL_CARD_SEED) {
    assert.throws(
      () => apply(state, { type: "task_assigned", taskId: "gap-0", assignment: forgedAssignment(entry.id, "agent-1") }),
      /lacks required capabilities \[(?:[^\]]*, )?quantum_annealing\]/,
      `${entry.id} must be refused`,
    );
  }
  assert.equal([...state.tasks.values()].filter((entry) => entry.assignment !== undefined).length, 0, "no task ever carried an assignment");
});

// ---------------------------------------------------------------------------
// 5. Adversarial event streams: forged, out-of-order, replayed, secret-bearing.
// ---------------------------------------------------------------------------

test("negative: adversarial event streams are rejected without corrupting the board", async () => {
  const log: KanbanEvent[] = [];
  let state = apply(createKanbanBoardState(identity), { type: "board_opened", defaults: { defaultWipPerModel: 5, defaultWipPerAgent: 5 } }, { actorKind: "human" }, log);
  state = apply(state, { type: "model_card_registered", card: card({ id: "alpha/one" }) }, {}, log);
  state = apply(state, { type: "task_created", taskId: "task-1", task: task({ id: "task-1" }) }, {}, log);
  state = apply(state, { type: "task_ready", taskId: "task-1", satisfiedDependencies: [] }, {}, log);
  const baseline = snapshotKanbanBoard(state);

  const rejects = (mutate: (event: KanbanEvent) => KanbanEvent, body: KanbanEventBody, pattern: RegExp): void => {
    assert.throws(() => reduceKanbanEvent(state, mutate(ev(state, body))), pattern);
    assert.deepStrictEqual(snapshotKanbanBoard(state), baseline, "a rejected event must leave the board untouched");
  };
  const progress: KanbanEventBody = { type: "task_blocked", taskId: "task-1", reason: "adversarial probe" };

  // Wrong sequence: gapped, replayed-position, zero, negative, fractional.
  rejects((event) => ({ ...event, sequence: event.sequence + 5 }) as KanbanEvent, progress, /Expected sequence/);
  rejects((event) => ({ ...event, sequence: 1 }) as KanbanEvent, progress, /Expected sequence/);
  rejects((event) => ({ ...event, sequence: 0 }) as KanbanEvent, progress, /Invalid kanban event envelope/);
  rejects((event) => ({ ...event, sequence: -3 }) as KanbanEvent, progress, /Invalid kanban event envelope/);
  rejects((event) => ({ ...event, sequence: event.sequence + 0.5 }) as KanbanEvent, progress, /Invalid kanban event envelope/);

  // Forged authority scope and envelope fields.
  rejects((event) => ({ ...event, tenantId: "tenant-evil" }) as KanbanEvent, progress, /authority scope does not match/);
  rejects((event) => ({ ...event, boardId: "other-board" }) as KanbanEvent, progress, /authority scope does not match/);
  rejects((event) => ({ ...event, siteId: undefined }) as KanbanEvent, progress, /authority scope does not match/);
  rejects((event) => ({ ...event, schemaVersion: 2 as never }) as KanbanEvent, progress, /Unsupported event schema version/);
  rejects((event) => ({ ...event, actorKind: "root" as never }) as KanbanEvent, progress, /Invalid kanban event envelope/);
  rejects((event) => ({ ...event, at: new Date(BASE_MS - 86_400_000).toISOString() }) as KanbanEvent, progress, /timestamp moves backwards/);
  rejects((event) => ({ ...event, at: "not-a-date" }) as KanbanEvent, progress, /Invalid kanban event envelope/);
  rejects((event) => ({ ...event, id: "" }) as KanbanEvent, progress, /Invalid kanban event envelope/);

  // Secret-bearing payloads: credential values, forbidden keys (nested), oversized strings.
  rejects((event) => event, { type: "task_blocked", taskId: "task-1", reason: `rotate sk-${"A".repeat(24)} now` }, /known credential pattern/);
  rejects((event) => event, { type: "task_blocked", taskId: "task-1", reason: `push with ghp_${"b".repeat(24)}` }, /known credential pattern/);
  rejects((event) => event, { type: "task_blocked", taskId: "task-1", reason: `AKIA${"Q".repeat(16)} leaked` }, /known credential pattern/);
  rejects((event) => event, { type: "task_blocked", taskId: "task-1", reason: "-----BEGIN RSA PRIVATE KEY-----" }, /known credential pattern/);
  rejects((event) => ({ ...event, debug: { nested: { api_key: "x" } } }) as unknown as KanbanEvent, progress, /forbidden secret or hidden-reasoning/);
  rejects((event) => ({ ...event, chain_of_thought: "step 1: lie" }) as unknown as KanbanEvent, progress, /forbidden secret or hidden-reasoning/);
  rejects((event) => ({ ...event, evidenceIds: [{ authorization: "Bearer x" }] as never }) as KanbanEvent, progress, /forbidden secret or hidden-reasoning/);
  rejects((event) => event, { type: "task_blocked", taskId: "task-1", reason: "y".repeat(MAX_EVENT_STRING_CHARS + 1) }, /longer than 4000 characters/);
  // Boundary: exactly MAX chars is legal (proves the guard is off-by-none).
  const boundary = apply(state, { type: "task_blocked", taskId: "task-1", reason: "y".repeat(MAX_EVENT_STRING_CHARS) });
  assert.equal(boundary.tasks.get("task-1")?.status, "blocked");

  // Forged assignments: every authority field the reducer re-derives is checked.
  rejects((event) => event, { type: "task_assigned", taskId: "task-1", assignment: forgedAssignment("ghost/card", "agent-1") }, /names unregistered card/);
  rejects((event) => event, { type: "task_assigned", taskId: "task-1", assignment: forgedAssignment("alpha/one", "") }, /agentId is required/);
  rejects((event) => event, { type: "task_assigned", taskId: "task-1", assignment: forgedAssignment("alpha/one", "agent-1", { policyDigest: "" }) }, /policyDigest is required/);
  rejects((event) => event, { type: "task_assigned", taskId: "task-1", assignment: forgedAssignment("alpha/one", "agent-1", { total: 9999 }) }, /does not equal its weighted sum/);
  rejects((event) => event, {
    type: "task_assigned", taskId: "task-1",
    assignment: forgedAssignment("alpha/one", "agent-1", { breakdown: [{ dimension: "cost", raw: 1000, weight: 55, weighted: 550, reason: "forged" }], total: 550 }),
  }, /weights sum to 55, not 100/);
  rejects((event) => event, { type: "task_assigned", taskId: "task-1", assignment: forgedAssignment("alpha/one", "agent-1", { consultationId: "consult-ghost" }) }, /cites unknown consultation/);

  // Forged context receipts: NaN token accounting and truthy non-boolean flags fail closed.
  const resolver: ContextResolver = { resolve: (): ContextResolution => ({ outcome: "included", reason: "ok", text: "spec ".repeat(10) }) };
  const contextTask = task({ id: "task-1", contextRefs: [{ id: "r1", kind: "file", uri: "file://spec.md", scope: { kind: "workspace", id: "repo" } }] });
  const receipt = toContextBundleReceipt(await resolveContext(contextTask, resolver, {
    taskId: "task-1", purpose: "probe", grantedScopes: [{ kind: "workspace", id: "*" }], tokenBudget: 500, assembledAt: at(),
  }));
  rejects((event) => event, { type: "context_bundle_attached", taskId: "task-1", bundle: { ...receipt, estimatedTokens: Number.NaN } }, /non-negative integer token counts/);
  rejects((event) => event, { type: "context_bundle_attached", taskId: "task-1", bundle: { ...receipt, estimatedTokens: -50 } }, /non-negative integer token counts/);
  rejects((event) => event, { type: "context_bundle_attached", taskId: "task-1", bundle: { ...receipt, tokenBudget: 1.5 } }, /non-negative integer token counts/);
  rejects((event) => event, { type: "context_bundle_attached", taskId: "task-1", bundle: { ...receipt, satisfiesRequired: "yes" as never } }, /boolean satisfiesRequired/);
  rejects((event) => event, { type: "context_bundle_attached", taskId: "task-1", bundle: { ...receipt, digest: " " } }, /digest is required/);
  rejects((event) => event, { type: "context_bundle_attached", taskId: "task-1", bundle: { ...receipt, taskId: "task-other" } }, /names task "task-other"/);

  // A prototype-chain priority never enters the board.
  rejects((event) => event, { type: "task_created", taskId: "task-proto", task: task({ id: "task-proto", priority: "toString" as never }) }, /priority is invalid/);
  rejects((event) => event, { type: "task_created", taskId: "task-proto", task: task({ id: "task-proto", priority: "hasOwnProperty" as never }) }, /priority is invalid/);

  // Maker-checker forgeries downstream: drive to review, then attack.
  state = apply(state, { type: "task_assigned", taskId: "task-1", assignment: forgedAssignment("alpha/one", "agent-1") }, {}, log);
  state = apply(state, { type: "task_started", taskId: "task-1", agentId: "agent-1", attemptId: "a1" }, { actorId: "agent-1", actorKind: "agent" }, log);
  assert.throws(() => apply(state, { type: "task_started", taskId: "task-1", agentId: "agent-1", attemptId: "a2" }, { actorId: "agent-1", actorKind: "agent" }), /must be assigned before it starts/);
  assert.throws(() => apply(state, { type: "task_progress", taskId: "task-1", note: "n", percentComplete: Number.NaN }), /between 0 and 100/);
  assert.throws(() => apply(state, { type: "task_progress", taskId: "task-1", note: "n", percentComplete: Number.POSITIVE_INFINITY }), /between 0 and 100/);
  state = apply(state, { type: "task_submitted_for_review", taskId: "task-1" }, { actorId: "agent-1", actorKind: "agent" }, log);
  assert.throws(() => apply(state, { type: "task_review_rejected", taskId: "task-1", reviewerId: "agent-1", reason: "lgtm-not" }), /may not review their own work/);
  assert.throws(() => apply(state, { type: "task_review_rejected", taskId: "task-1", reviewerId: " ", reason: "anon" }), /reviewerId is required/);
  assert.throws(() => apply(state, { type: "task_completed", taskId: "task-1", reviewerId: "", receiptHash: "sha256:x" }, { actorKind: "human" }), /reviewerId is required/);
  assert.throws(() => apply(state, { type: "task_completed", taskId: "task-1", reviewerId: "agent-1", receiptHash: "sha256:x" }, { actorKind: "human" }), /cannot be completed by its own worker/);
  assert.throws(
    () => apply(state, { type: "task_completed", taskId: "task-1", reviewerId: "reviewer@example.com", receiptHash: "sha256:x" }, { actorId: "agent-1", actorKind: "agent" }),
    /cannot be completed by its own worker/,
  );
  state = apply(state, { type: "task_completed", taskId: "task-1", reviewerId: "reviewer@example.com", receiptHash: "sha256:final" }, { actorId: "reviewer@example.com", actorKind: "human" }, log);

  // Replayed duplicates: byte-identical redelivery is a no-op; a forged different body reusing an
  // applied id is discarded without effect (the log position, not the transport, is authoritative).
  const lastApplied = log[log.length - 1]!;
  assert.equal(reduceKanbanEvent(state, lastApplied), state, "same-reference short circuit");
  const forgedReuse = { ...ev(state, { type: "task_blocked", taskId: "task-1", reason: "smuggled" }), id: lastApplied.id } as KanbanEvent;
  assert.equal(reduceKanbanEvent(state, forgedReuse), state, "an already-applied id is inert whatever body it carries");
  assert.equal(state.tasks.get("task-1")?.status, "done");

  // After the entire adversarial barrage, the accepted log still replays to the same state.
  assert.deepStrictEqual(replayKanbanEvents(createKanbanBoardState(identity), log), state);
});

test("negative: hostile resolver token arithmetic cannot corrupt budget accounting or receipts", async () => {
  const ref = { id: "r1", kind: "file" as const, uri: "file://x", scope: { kind: "workspace" as const, id: "repo" } };
  const subject = task({ id: "task-ctx", contextRefs: [ref] });
  const request = {
    taskId: "task-ctx", purpose: "probe", grantedScopes: [{ kind: "workspace" as const, id: "*" }], tokenBudget: 10, assembledAt: at(),
  };
  // 400 chars is ~100 tokens; the resolver lies that it is negative / NaN / fractional to sneak
  // under a 10-token budget. The count must fall back to the text-derived estimate and be denied.
  for (const lie of [-5000, Number.NaN, Number.POSITIVE_INFINITY, 2.5]) {
    const hostile: ContextResolver = { resolve: (): ContextResolution => ({ outcome: "included", reason: "ok", text: "x".repeat(400), estimatedTokens: lie }) };
    const bundle = await resolveContext(subject, hostile, request);
    assert.equal(bundle.included.length, 0, `estimatedTokens=${lie} must not be trusted`);
    assert.equal(bundle.denied[0]?.reason, "budget_exhausted");
    assert.equal(bundle.estimatedTokens, 0);
    const receipt = toContextBundleReceipt(bundle);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(receipt)), receipt, "receipts stay JSON-safe under hostile input");
  }
  // An honest small count within budget is still accepted verbatim.
  const honest: ContextResolver = { resolve: (): ContextResolution => ({ outcome: "included", reason: "ok", text: "tiny", estimatedTokens: 1 }) };
  const fine = await resolveContext(subject, honest, request);
  assert.equal(fine.included[0]?.estimatedTokens, 1);
});

// ---------------------------------------------------------------------------
// 6. Determinism: 100 repeated selections, shuffled inputs, one byte stream.
// ---------------------------------------------------------------------------

test("stress: selection is byte-deterministic across 100 repetitions with rotated card order", () => {
  const subject = task({
    id: "det-1",
    requiredCapabilities: ["code_edit", "tool_use"],
    preferredStrengths: ["refactoring", "code_review"],
    priority: "high",
    estimatedContextTokens: 40_000,
  });
  const policy: SelectionPolicy = {
    weights: { strength: 3, evidence: 2, cost: 2, latency: 2, context: 1 }, // sums to 10, must normalize to 100
    maxCostTier: "high",
    requireVerifiedEvidence: false,
    modelLoad: new Map([["codex-cli/gpt-5.6-sol", 1]]),
    defaultWipPerModel: 2,
  };
  const first = selectModelForTask(subject, MODEL_CARD_SEED, policy);
  assert.equal(first.outcome, "selected");
  const firstBytes = JSON.stringify(first);
  for (let iteration = 1; iteration <= 100; iteration += 1) {
    const rotation = iteration % MODEL_CARD_SEED.length;
    const rotated = [...MODEL_CARD_SEED.slice(rotation), ...MODEL_CARD_SEED.slice(0, rotation)];
    const again = selectModelForTask(subject, rotated, { ...policy, modelLoad: new Map(policy.modelLoad!) });
    assert.equal(JSON.stringify(again), firstBytes, `iteration ${iteration} must be byte-identical`);
    assert.equal(again.policyDigest, first.policyDigest, "runtime load and card order never perturb the digest");
  }
  if (first.outcome === "selected") {
    assert.equal(first.breakdown.reduce((accumulator, entry) => accumulator + entry.weight, 0), 100, "normalized weights keep the audit invariant");
  }
});

// ---------------------------------------------------------------------------
// 7. WIP starvation: saturated limits leave tasks in ready, never dropped.
// ---------------------------------------------------------------------------

test("stress: WIP saturation escalates as wip_exhausted and strands nothing outside ready", () => {
  const cardX = card({ id: "xray/free", costTier: "free" });
  const cardY = card({ id: "yankee/paid" });
  const log: KanbanEvent[] = [];
  let state = apply(createKanbanBoardState(identity), { type: "board_opened", defaults: { defaultWipPerModel: 2, defaultWipPerAgent: 1 } }, { actorKind: "human" }, log);
  state = apply(state, { type: "model_card_registered", card: cardX }, {}, log);
  state = apply(state, { type: "model_card_registered", card: cardY }, {}, log);
  // The board override that used to be invisible to the planner (bug B6): X may hold only 1.
  state = apply(state, { type: "wip_limit_set", scope: "model", targetId: cardX.id, limit: 1 }, { actorKind: "human" }, log);

  const taskIds: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    const id = `wip-${index}`;
    taskIds.push(id);
    state = apply(state, { type: "task_created", taskId: id, task: task({ id }) }, {}, log);
    state = apply(state, { type: "task_ready", taskId: id, satisfiedDependencies: [] }, {}, log);
  }

  // agent-c declares a cap of 9 but the board's per-agent limit is 1; the planner must obey the board.
  const agents = [{ id: "agent-a" }, { id: "agent-b" }, { id: "agent-c", maxConcurrentTasks: 9 }];
  const plan = planKanbanAssignments(state, { agents, now: at() });

  // Capacity: X holds 1 (override), Y holds 2 (default) = 3 proposals; 3 tasks starve.
  assert.equal(plan.proposals.length, 3);
  assert.equal(plan.escalations.length, 3);
  const covered = [...plan.proposals.map((proposal) => proposal.taskId), ...plan.escalations.map((escalation) => escalation.taskId)].sort();
  assert.deepEqual(covered, [...taskIds].sort(), "every ready task is either proposed or escalated; none vanishes");
  assert.equal(plan.proposals.filter((proposal) => proposal.assignment.cardId === cardX.id).length, 1, "the per-model override is respected inside the plan");
  assert.equal(plan.proposals.filter((proposal) => proposal.assignment.cardId === cardY.id).length, 2);
  for (const escalation of plan.escalations) {
    assert.equal(escalation.reason, "wip_exhausted", "saturation is not a capability gap and must not masquerade as one");
    assert.match(escalation.detail, /at WIP capacity \[xray\/free, yankee\/paid\]/);
  }

  // The planner's no-oversubscribe contract: applying EVERY proposal must succeed.
  for (const proposal of plan.proposals) {
    state = apply(state, { type: "task_assigned", taskId: proposal.taskId, assignment: proposal.assignment }, {}, log);
  }
  assert.equal(state.loadByModel.get(cardX.id), 1);
  assert.equal(state.loadByModel.get(cardY.id), 2);
  for (const agent of agents) assert.equal(state.loadByAgent.get(agent.id), 1, `${agent.id} holds exactly one task`);

  // Starved tasks remain visible in ready — no silent drop, no phantom state.
  const snapshot = snapshotKanbanBoard(state);
  assert.equal(snapshot.counts.assigned, 3);
  assert.equal(snapshot.counts.ready, 3);
  assert.deepEqual(snapshot.columns.ready.map((summary) => summary.id), plan.escalations.map((escalation) => escalation.taskId).sort());
  assert.deepEqual(snapshot.wip.byModel.find((entry) => entry.cardId === cardX.id), { cardId: cardX.id, load: 1, limit: 1 });

  // Re-planning with zero freed capacity proposes nothing and re-escalates the same tasks.
  const stalled = planKanbanAssignments(state, { agents, now: at() });
  assert.equal(stalled.proposals.length, 0);
  assert.equal(stalled.escalations.length, 3);

  // Drain one task; the next plan immediately picks up a starved task on the freed card+agent.
  const drained = plan.proposals.find((proposal) => proposal.assignment.cardId === cardX.id)!;
  state = apply(state, { type: "task_started", taskId: drained.taskId, agentId: drained.assignment.agentId, attemptId: "a1" }, { actorId: drained.assignment.agentId, actorKind: "agent" }, log);
  state = apply(state, { type: "task_submitted_for_review", taskId: drained.taskId }, { actorId: drained.assignment.agentId, actorKind: "agent" }, log);
  state = apply(state, { type: "task_completed", taskId: drained.taskId, reviewerId: "reviewer@example.com", receiptHash: "sha256:drain" }, { actorId: "reviewer@example.com", actorKind: "human" }, log);
  const resumed = planKanbanAssignments(state, { agents, now: at() });
  assert.equal(resumed.proposals.length, 1);
  assert.equal(resumed.proposals[0]!.assignment.cardId, cardX.id);
  assert.doesNotThrow(() => apply(state, { type: "task_assigned", taskId: resumed.proposals[0]!.taskId, assignment: resumed.proposals[0]!.assignment }));

  // The whole starvation history replays byte-identically.
  assert.deepStrictEqual(replayKanbanEvents(createKanbanBoardState(identity), log), state);
});
