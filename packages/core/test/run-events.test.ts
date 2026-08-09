import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createMissionRuntimeState,
  reduceRunEvent,
  replayRunEvents,
  RunEventConflictError,
  type MissionRuntimeState,
  type RunEvent,
  type RunEventType,
} from "../src/index.js";

const identity = { missionId: "mission-1", rootRunId: "run-1", tenantId: "tenant-1", siteId: "site-1" };

function event(sequence: number, type: RunEventType, extra: Partial<RunEvent> = {}): RunEvent {
  return {
    schemaVersion: 1,
    id: extra.id ?? `event-${sequence}`,
    ...identity,
    sequence,
    type,
    at: "2026-07-19T10:00:00.000Z",
    actorId: "user@example.com",
    summary: type,
    ...extra,
  };
}

function leasedState(): MissionRuntimeState {
  return replayRunEvents(createMissionRuntimeState(identity), [
    event(1, "mission_started"),
    event(2, "node_started", { nodeId: "work", attemptId: "attempt-1" }),
    event(3, "lease_claimed", {
      nodeId: "work", attemptId: "attempt-1", fencingToken: 1,
      payload: { leaseExpiresAt: "2026-07-19T10:05:00.000Z" },
    }),
  ]);
}

test("authoritative events build immutable state with monotonic mission sequence", () => {
  const initial = createMissionRuntimeState(identity);
  const started = reduceRunEvent(initial, event(1, "mission_started"));
  assert.equal(initial.status, "pending");
  assert.equal(started.status, "running");
  assert.equal(started.nextSequence, 2);
  assert.throws(() => reduceRunEvent(started, event(3, "mission_completed")), /Expected sequence 2/);
  assert.throws(() => reduceRunEvent(started, event(2, "mission_started")), /start only once/);
});

test("duplicate transport delivery is harmless and does not consume sequence", () => {
  const initial = createMissionRuntimeState(identity);
  const firstEvent = event(1, "mission_started");
  const once = reduceRunEvent(initial, firstEvent);
  assert.equal(reduceRunEvent(once, firstEvent), once);
  assert.equal(once.nextSequence, 2);
});

test("authority scope mismatch and malformed envelopes are rejected", () => {
  const initial = createMissionRuntimeState(identity);
  assert.throws(() => reduceRunEvent(initial, event(1, "mission_started", { tenantId: "other" })), /authority scope/);
  assert.throws(() => reduceRunEvent(initial, event(1, "mission_started", { at: "not-a-date" })), /Invalid run event envelope/);
  assert.throws(() => reduceRunEvent(initial, event(1, "mission_started", { payload: { nested: { apiKey: "must-not-leak" } } })), /forbidden secret/);
});

test("lease claims advance fencing tokens and stale workers cannot commit", () => {
  const state = leasedState();
  assert.throws(() => reduceRunEvent(state, event(4, "effect_started", {
    nodeId: "work", attemptId: "attempt-1", fencingToken: 0, idempotencyKey: "op-1",
  })), /Stale or missing fencing token/);
  assert.throws(() => reduceRunEvent(state, event(4, "lease_claimed", {
    nodeId: "work", attemptId: "attempt-2", fencingToken: 1,
    payload: { leaseExpiresAt: "2026-07-19T10:05:00.000Z" },
  })), /must advance/);
  const reclaimed = reduceRunEvent(state, event(4, "lease_claimed", {
    nodeId: "work", attemptId: "attempt-2", fencingToken: 2,
    payload: { leaseExpiresAt: "2026-07-19T10:05:00.000Z" },
  }));
  assert.equal(reclaimed.nodes.get("work")?.fencingToken, 2);
  assert.throws(() => reduceRunEvent(reclaimed, event(5, "lease_heartbeat", {
    nodeId: "work", attemptId: "attempt-1", fencingToken: 2,
    payload: { leaseExpiresAt: "2026-07-19T10:06:00.000Z" },
  })), /Attempt does not own/);
});

test("an expired lease cannot authorize effects or heartbeats", () => {
  const state = leasedState();
  assert.throws(() => reduceRunEvent(state, event(4, "effect_started", {
    at: "2026-07-19T10:05:01.000Z", nodeId: "work", attemptId: "attempt-1", fencingToken: 1, idempotencyKey: "late-op",
  })), /has expired/);
  assert.throws(() => reduceRunEvent(state, event(4, "lease_heartbeat", {
    at: "2026-07-19T10:05:01.000Z", nodeId: "work", attemptId: "attempt-1", fencingToken: 1,
    payload: { leaseExpiresAt: "2026-07-19T10:10:00.000Z" },
  })), /has expired/);
});

test("idempotent effects deduplicate matching receipts and reject conflicts", () => {
  let state = leasedState();
  state = reduceRunEvent(state, event(4, "effect_started", { nodeId: "work", attemptId: "attempt-1", fencingToken: 1, idempotencyKey: "op-1" }));
  state = reduceRunEvent(state, event(5, "effect_committed", { nodeId: "work", attemptId: "attempt-1", fencingToken: 1, idempotencyKey: "op-1", receiptHash: "sha256:a" }));
  const duplicateOperation = reduceRunEvent(state, event(6, "effect_committed", { nodeId: "work", attemptId: "attempt-1", fencingToken: 1, idempotencyKey: "op-1", receiptHash: "sha256:a" }));
  assert.equal(duplicateOperation.committedEffects.get("op-1"), "sha256:a");
  assert.throws(() => reduceRunEvent(duplicateOperation, event(7, "effect_committed", { nodeId: "work", attemptId: "attempt-1", fencingToken: 1, idempotencyKey: "op-1", receiptHash: "sha256:b" })), /conflicting receipt/);
});

test("cancellation prevents new work and waits for effect safe points", () => {
  let state = leasedState();
  state = reduceRunEvent(state, event(4, "effect_started", { nodeId: "work", attemptId: "attempt-1", fencingToken: 1, idempotencyKey: "op-1" }));
  state = reduceRunEvent(state, event(5, "cancellation_requested"));
  assert.throws(() => reduceRunEvent(state, event(6, "node_started", { nodeId: "late", attemptId: "attempt-2" })), /prevents new node work/);
  assert.throws(() => reduceRunEvent(state, event(6, "effect_started", { nodeId: "work", attemptId: "attempt-1", fencingToken: 1, idempotencyKey: "op-2" })), /prevents new effects/);
  state = reduceRunEvent(state, event(6, "cancelling"));
  assert.throws(() => reduceRunEvent(state, event(7, "cancelled")), /safe points/);
  state = reduceRunEvent(state, event(7, "effect_committed", { nodeId: "work", attemptId: "attempt-1", fencingToken: 1, idempotencyKey: "op-1", receiptHash: "sha256:a" }));
  assert.equal(reduceRunEvent(state, event(8, "cancelled")).status, "cancelled");
});

test("pause, steer, resume, and cancellation are authoritative safe-point transitions", () => {
  let state = leasedState();
  state = reduceRunEvent(state, event(4, "pause_requested"));
  state = reduceRunEvent(state, event(5, "steered", { payload: { instruction: "use the verified ledger" } }));
  state = reduceRunEvent(state, event(6, "paused"));
  assert.equal(state.status, "paused");
  assert.throws(() => reduceRunEvent(state, event(7, "node_started", { nodeId: "late", attemptId: "attempt-2" })), /prevents new node work/);
  state = reduceRunEvent(state, event(7, "resumed"));
  assert.equal(state.status, "running");
  state = reduceRunEvent(state, event(8, "pause_requested"));
  state = reduceRunEvent(state, event(9, "cancellation_requested"));
  assert.equal(state.status, "cancel_requested");
});

test("completion wins before cancellation, but cancellation wins after its event", () => {
  let complete = leasedState();
  complete = reduceRunEvent(complete, event(4, "node_completed", { nodeId: "work", attemptId: "attempt-1", fencingToken: 1 }));
  complete = reduceRunEvent(complete, event(5, "mission_completed"));
  assert.equal(complete.status, "completed");
  assert.throws(() => reduceRunEvent(complete, event(6, "cancellation_requested")), /terminal/);

  let cancelled = leasedState();
  cancelled = reduceRunEvent(cancelled, event(4, "cancellation_requested"));
  assert.throws(() => reduceRunEvent(cancelled, event(5, "mission_completed")), /Cancellation wins/);
});

test("failed compensation becomes needs intervention and never claims rollback", () => {
  let state = leasedState();
  state = reduceRunEvent(state, event(4, "mission_failed"));
  state = reduceRunEvent(state, event(5, "compensation_started"));
  state = reduceRunEvent(state, event(6, "compensation_failed"));
  assert.equal(state.status, "needs_intervention");
  assert.throws(() => reduceRunEvent(state, event(7, "compensation_completed")), RunEventConflictError);
});
