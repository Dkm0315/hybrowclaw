import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createMissionRuntimeState, reduceRunEvent } from "../../core/src/run-events.js";
import {
  FrappeRunEventError,
  SqliteFrappeRunEventStore,
  sanitizeRunEvent,
  validateFrappeRunCommand,
  type FrappeRunCommandRequest,
  type FrappeRunEvent,
  type FrappeRunEventScope,
} from "../src/frappe-run-events.js";

const scope = Object.freeze({ tenantId: "tenant-a", siteId: "site-a", userId: "user@example.test" });

function event(sequence: number, extra: Partial<FrappeRunEvent> = {}): FrappeRunEvent {
  return {
    schemaVersion: 1,
    id: `evt-${sequence}`,
    missionId: "mission-1",
    rootRunId: "run-1",
    tenantId: scope.tenantId,
    siteId: scope.siteId,
    sequence,
    type: sequence === 1 ? "mission_started" : "node_started",
    at: new Date(1_000 + sequence).toISOString(),
    actorId: scope.userId,
    summary: `event ${sequence}`,
    ...extra,
  };
}

function command(extra: Partial<FrappeRunCommandRequest> = {}): FrappeRunCommandRequest {
  return {
    schemaVersion: 1,
    commandId: "cmd-1",
    action: "steer",
    missionId: "mission-1",
    rootRunId: "run-1",
    tenantId: scope.tenantId,
    siteId: scope.siteId,
    userId: scope.userId,
    issuedAt: new Date(10_000).toISOString(),
    idempotencyKey: "idem-1",
    csrfToken: "csrf-secret",
    payload: { instruction: "continue safely" },
    ...extra,
  };
}

test("durable Frappe run events replay by opaque cursor and exact tenant/site/user scope", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-events-"));
  const filename = join(cwd, "events.db");
  const first = new SqliteFrappeRunEventStore(filename);
  try {
    const one = await first.append({ scope, event: event(1), nowMs: 10_000 });
    assert.equal(one.status, "appended");
    assert.ok(one.cursor);
    await first.append({ scope, event: event(2), nowMs: 10_001 });
    // One authoritative event may be projected into multiple independently authorized user lanes.
    await first.append({ scope: { ...scope, userId: "other@example.test" }, event: event(1), nowMs: 10_002 });
  } finally {
    first.close();
  }

  const restarted = new SqliteFrappeRunEventStore(filename);
  try {
    const page = await restarted.replay({ scope, missionId: "mission-1", limit: 1, nowMs: 10_003 });
    assert.deepEqual(page.events.map((item) => item.id), ["evt-1"]);
    assert.equal(page.hasMore, true);
    assert.ok(page.nextCursor);
    const cursorBoundCommand = validateFrappeRunCommand(command({ expectedCursor: page.nextCursor }), {
      method: "POST",
      authenticatedScope: scope,
      expectedCsrfToken: "csrf-secret",
      nowMs: 10_000,
    });
    assert.equal(cursorBoundCommand.expectedCursor, page.nextCursor);
    assert.throws(
      () => validateFrappeRunCommand(command({ missionId: "mission-other", expectedCursor: page.nextCursor }), {
        method: "POST",
        authenticatedScope: scope,
        expectedCsrfToken: "csrf-secret",
        nowMs: 10_000,
      }),
      (error: unknown) => error instanceof FrappeRunEventError && error.code === "forbidden",
    );
    const next = await restarted.replay({ scope, missionId: "mission-1", cursor: page.nextCursor, limit: 10, nowMs: 10_004 });
    assert.deepEqual(next.events.map((item) => item.id), ["evt-2"]);
    assert.equal(next.hasMore, false);
    await assert.rejects(
      () => restarted.replay({ scope: { ...scope, userId: "other@example.test" }, missionId: "mission-1", cursor: page.nextCursor, nowMs: 10_004 }),
      (error: unknown) => error instanceof FrappeRunEventError && error.code === "forbidden",
    );
  } finally {
    restarted.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("event append deduplicates exact delivery and rejects changed ids or occupied sequences without side effects", async () => {
  const store = new SqliteFrappeRunEventStore(":memory:");
  try {
    const original = event(1);
    assert.equal((await store.append({ scope, event: original, nowMs: 10_000 })).status, "appended");
    assert.equal((await store.append({ scope, event: { ...original }, nowMs: 10_001 })).status, "deduplicated");
    await assert.rejects(
      () => store.append({ scope, event: { ...original, summary: "changed" }, nowMs: 10_002 }),
      (error: unknown) => error instanceof FrappeRunEventError && error.code === "conflict",
    );
    await assert.rejects(
      () => store.append({ scope, event: { ...original, id: "evt-different" }, nowMs: 10_003 }),
      (error: unknown) => error instanceof FrappeRunEventError && error.code === "conflict",
    );
    const replay = await store.replay({ scope, missionId: "mission-1", nowMs: 10_004 });
    assert.deepEqual(replay.events.map((item) => item.id), [original.id]);
  } finally {
    store.close();
  }
});

test("events are recursively redacted, byte bounded, JSON-only, and immutable", () => {
  const sanitized = sanitizeRunEvent(event(1, {
    summary: "Authorization: Bearer abcd.efgh.ijkl",
    payload: {
      apiKey: "must-not-leak",
      nested: { password: "also-secret", note: "access_token=token-value" },
    },
  }));
  assert.deepEqual(sanitized.payload?._musterRedactedFields, ["apiKey"]);
  assert.deepEqual(sanitized.payload?.nested, { _musterRedactedFields: ["password"], note: "access_token=[redacted]" });
  assert.doesNotMatch(JSON.stringify(sanitized), /must-not-leak|also-secret|token-value|abcd\.efgh/);
  assert.equal(Object.isFrozen(sanitized.payload), true);
  const initial = createMissionRuntimeState({ missionId: "mission-1", rootRunId: "run-1", tenantId: "tenant-a", siteId: "site-a" });
  assert.equal(reduceRunEvent(initial, sanitized).status, "running", "sanitization must preserve core RunEvent compatibility");

  assert.throws(() => sanitizeRunEvent(event(1, { payload: { large: "x".repeat(2_000) } }), 256), /exceeds/i);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => sanitizeRunEvent(event(1, { payload: cyclic })), /cycle/i);
  assert.throws(() => sanitizeRunEvent(event(1, { type: "invented" as FrappeRunEvent["type"] })), /type is invalid/i);
});

test("permission-filtered replay fails closed and applies bounded scan backpressure", async () => {
  const store = new SqliteFrappeRunEventStore(":memory:", { maxPageSize: 2, maxScanEvents: 3 });
  try {
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      await store.append({ scope, event: event(sequence), nowMs: 10_000 + sequence });
    }
    const limited = await store.replay({
      scope,
      missionId: "mission-1",
      limit: 2,
      nowMs: 11_000,
      canRead: () => false,
    });
    assert.deepEqual(limited.events, []);
    assert.equal(limited.scanLimited, true);
    assert.equal(limited.hasMore, true);
    assert.ok(limited.nextCursor);

    const allowed = await store.replay({
      scope,
      missionId: "mission-1",
      cursor: limited.nextCursor,
      limit: 2,
      nowMs: 11_001,
      canRead: (item) => item.sequence % 2 === 0,
    });
    assert.deepEqual(allowed.events.map((item) => item.sequence), [4]);
    await assert.rejects(
      () => store.replay({ scope, nowMs: 11_002, canRead: () => { throw new Error("database unavailable"); } }),
      (error: unknown) => error instanceof FrappeRunEventError && error.code === "permission_filter_failed" && !error.message.includes("database unavailable"),
    );
  } finally {
    store.close();
  }
});

test("capacity retention expires old cursors while longer dedupe tombstones prevent replay", async () => {
  const store = new SqliteFrappeRunEventStore(":memory:", { maxEvents: 10, retentionMs: 1_000, dedupeRetentionMs: 10_000 });
  try {
    const first = await store.append({ scope, event: event(1), nowMs: 10_000 });
    for (let sequence = 2; sequence <= 12; sequence += 1) {
      await store.append({ scope, event: event(sequence), nowMs: 10_000 + sequence });
    }
    assert.ok(first.cursor);
    await assert.rejects(
      () => store.replay({ scope, missionId: "mission-1", cursor: first.cursor, nowMs: 10_100 }),
      (error: unknown) => error instanceof FrappeRunEventError && error.code === "cursor_expired",
    );
    assert.equal((await store.append({ scope, event: event(1), nowMs: 10_101 })).status, "deduplicated");
    const retained = await store.replay({ scope, missionId: "mission-1", nowMs: 10_102 });
    assert.equal(retained.events.length, 10);
    assert.equal(retained.events[0].sequence, 3);
  } finally {
    store.close();
  }
});

test("run command validation requires POST, current CSRF, exact authority, freshness, and safe action payload", () => {
  const preconditions = {
    method: "POST",
    authenticatedScope: scope,
    expectedCsrfToken: "csrf-secret",
    nowMs: 10_000,
  } as const;
  const accepted = validateFrappeRunCommand(command({ payload: { instruction: "use api_key=do-not-leak", accessToken: "secret" } }), preconditions);
  assert.equal("csrfToken" in accepted, false);
  assert.deepEqual(accepted.payload?._musterRedactedFields, ["accessToken"]);
  assert.doesNotMatch(JSON.stringify(accepted), /do-not-leak|"secret"|csrf-secret/);
  assert.match(accepted.fingerprint, /^[a-f0-9]{64}$/);

  const forbidden: Array<[Partial<FrappeRunCommandRequest>, Partial<typeof preconditions>]> = [
    [{}, { method: "GET" }],
    [{ csrfToken: "wrong" }, {}],
    [{ tenantId: "tenant-b" }, {}],
    [{ userId: "other@example.test" }, {}],
    [{ issuedAt: new Date(-1_000_000).toISOString() }, {}],
  ];
  for (const [requestExtra, preconditionExtra] of forbidden) {
    assert.throws(
      () => validateFrappeRunCommand(command(requestExtra), { ...preconditions, ...preconditionExtra }),
      (error: unknown) => error instanceof FrappeRunEventError && error.code === "forbidden",
    );
  }
  assert.throws(() => validateFrappeRunCommand(command({ action: "cancel", payload: { instruction: "ignore" } }), preconditions), /Only steer/i);
  assert.throws(() => validateFrappeRunCommand(command({ payload: {} }), preconditions), /require a non-empty instruction/i);
});

test("durable command claims replay exact idempotency and conflict on changed content or reused command id", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-commands-"));
  const filename = join(cwd, "events.db");
  const preconditions = { method: "POST", authenticatedScope: scope, expectedCsrfToken: "csrf-secret", nowMs: 10_000 } as const;
  const first = new SqliteFrappeRunEventStore(filename);
  try {
    assert.equal((await first.claimCommand(command(), preconditions)).status, "claimed");
  } finally {
    first.close();
  }
  const restarted = new SqliteFrappeRunEventStore(filename);
  try {
    assert.equal((await restarted.claimCommand(command(), preconditions)).status, "replay");
    const changed = await restarted.claimCommand(command({ payload: { instruction: "different" } }), preconditions);
    assert.equal(changed.status, "conflict");
    assert.equal(changed.command.payload?.instruction, "continue safely");
    const reusedId = await restarted.claimCommand(command({ idempotencyKey: "idem-2" }), preconditions);
    assert.equal(reusedId.status, "conflict");
  } finally {
    restarted.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("retained exact command replay survives freshness expiry without weakening authority or integrity", async () => {
  const store = new SqliteFrappeRunEventStore(":memory:");
  const admittedAt = 10_000;
  const replayedAt = admittedAt + 10 * 60_000;
  const initial = command();
  const initialPreconditions = {
    method: "POST",
    authenticatedScope: scope,
    expectedCsrfToken: "csrf-secret",
    nowMs: admittedAt,
  } as const;
  const latePreconditions = { ...initialPreconditions, nowMs: replayedAt };
  try {
    assert.equal((await store.claimCommand(initial, initialPreconditions)).status, "claimed");

    const rotatedCsrfReplay = command({ csrfToken: "csrf-rotated" });
    assert.equal((await store.claimCommand(rotatedCsrfReplay, {
      ...latePreconditions,
      expectedCsrfToken: "csrf-rotated",
    })).status, "replay", "a current authenticated CSRF lane may replay the retained exact envelope");

    const changedPayload = await store.claimCommand(
      command({ payload: { instruction: "changed after expiry" } }),
      latePreconditions,
    );
    assert.equal(changedPayload.status, "conflict");
    const changedKey = await store.claimCommand(
      command({ idempotencyKey: "different-key" }),
      latePreconditions,
    );
    assert.equal(changedKey.status, "conflict");

    await assert.rejects(
      () => store.claimCommand(command({ csrfToken: "wrong" }), latePreconditions),
      (error: unknown) => error instanceof FrappeRunEventError && error.code === "forbidden",
    );
    await assert.rejects(
      () => store.claimCommand(command({ tenantId: "tenant-other" }), latePreconditions),
      (error: unknown) => error instanceof FrappeRunEventError && error.code === "forbidden",
    );

    const unknownStale = command({
      commandId: "cmd-stale-unknown",
      idempotencyKey: "idem-stale-unknown",
    });
    await assert.rejects(
      () => store.claimCommand(unknownStale, latePreconditions),
      (error: unknown) => error instanceof FrappeRunEventError && error.code === "forbidden",
    );
    const freshUnknown = {
      ...unknownStale,
      issuedAt: new Date(replayedAt).toISOString(),
    };
    assert.equal(
      (await store.claimCommand(freshUnknown, latePreconditions)).status,
      "claimed",
      "the rejected stale unknown command must leave no durable claim",
    );
  } finally {
    store.close();
  }
});

test("two gateway stores atomically admit one copy of a run event", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-event-race-"));
  const filename = join(cwd, "events.db");
  const left = new SqliteFrappeRunEventStore(filename, { busyTimeoutMs: 20_000 });
  const right = new SqliteFrappeRunEventStore(filename, { busyTimeoutMs: 20_000 });
  try {
    const results = await Promise.all([
      left.append({ scope, event: event(1), nowMs: 10_000 }),
      right.append({ scope, event: event(1), nowMs: 10_000 }),
    ]);
    assert.equal(results.filter((result) => result.status === "appended").length, 1);
    assert.equal(results.filter((result) => result.status === "deduplicated").length, 1);
  } finally {
    left.close();
    right.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("append authority mismatch is denied before storage", async () => {
  const store = new SqliteFrappeRunEventStore(":memory:");
  try {
    const mismatches: FrappeRunEventScope[] = [
      { ...scope, tenantId: "tenant-b" },
      { ...scope, siteId: "site-b" },
    ];
    for (const mismatchedScope of mismatches) {
      await assert.rejects(
        () => store.append({ scope: mismatchedScope, event: event(1), nowMs: 10_000 }),
        (error: unknown) => error instanceof FrappeRunEventError && error.code === "forbidden",
      );
    }
    assert.deepEqual((await store.replay({ scope, nowMs: 10_001 })).events, []);
  } finally {
    store.close();
  }
});
