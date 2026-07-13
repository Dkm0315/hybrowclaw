import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { EnterpriseSqliteStore } from "@musterhq/core";
import { SqliteAsyncMessageRunStore } from "../src/async-message-store.js";
import { DurableConversationLease } from "../src/conversation-lease.js";

test("async run claims survive store restart and reject changed idempotent input", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-async-store-restart-"));
  const filename = join(cwd, "runs.db");
  const first = new SqliteAsyncMessageRunStore(filename);
  const claimed = await first.claim({
    fingerprint: "sha256:first",
    idempotencyScope: "scope-1",
    artifactRoots: [cwd],
    leaseMs: 10_000,
  });
  assert.equal(claimed.status, "claimed");
  assert.ok(claimed.ownerToken);
  assert.equal(await first.markRunning(claimed.record.runId, claimed.ownerToken!, Date.now(), 10_000), true);
  assert.equal(await first.appendPreview(claimed.record.runId, claimed.ownerToken!, "partialText", "working", 64_000), true);
  assert.equal(await first.complete(claimed.record.runId, claimed.ownerToken!, { text: "done" }), true);
  first.close();

  const restarted = new SqliteAsyncMessageRunStore(filename);
  try {
    const replay = await restarted.claim({
      fingerprint: "sha256:first",
      idempotencyScope: "scope-1",
      artifactRoots: [cwd],
      leaseMs: 10_000,
    });
    assert.equal(replay.status, "replay");
    assert.equal(replay.record.runId, claimed.record.runId);
    assert.equal(replay.record.status, "completed");
    assert.equal(replay.record.reply && "text" in replay.record.reply ? replay.record.reply.text : undefined, "done");
    assert.equal(replay.record.partialText, "working");

    const conflict = await restarted.claim({
      fingerprint: "sha256:changed",
      idempotencyScope: "scope-1",
      artifactRoots: [cwd],
      leaseMs: 10_000,
    });
    assert.equal(conflict.status, "conflict");
    assert.equal(conflict.record.runId, claimed.record.runId);
  } finally {
    restarted.close();
  }
});

test("expired async ownership becomes an unknown failure and is never replayed", async () => {
  const store = new SqliteAsyncMessageRunStore(":memory:");
  try {
    const claimed = await store.claim({
      fingerprint: "sha256:unknown",
      idempotencyScope: "scope-unknown",
      artifactRoots: [process.cwd()],
      leaseMs: 1_000,
      nowMs: 1_000,
    });
    assert.equal(claimed.status, "claimed");
    assert.equal(await store.markRunning(claimed.record.runId, claimed.ownerToken!, 1_000, 1_000), true);
    const interrupted = await store.read(claimed.record.runId, 2_000);
    assert.equal(interrupted?.status, "failed");
    assert.match(interrupted?.error ?? "", /outcome is unknown/i);

    const replay = await store.claim({
      fingerprint: "sha256:unknown",
      idempotencyScope: "scope-unknown",
      artifactRoots: [process.cwd()],
      leaseMs: 1_000,
      nowMs: 2_001,
    });
    assert.equal(replay.status, "replay");
    assert.equal(replay.ownerToken, undefined);
    assert.equal(replay.record.status, "failed");
  } finally {
    store.close();
  }
});

test("separate async stores atomically admit one worker for an idempotency scope", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-async-store-processes-"));
  const filename = join(cwd, "runs.db");
  const left = new SqliteAsyncMessageRunStore(filename);
  const right = new SqliteAsyncMessageRunStore(filename);
  try {
    const input = {
      fingerprint: "sha256:same",
      idempotencyScope: "scope-shared",
      artifactRoots: [cwd],
      leaseMs: 10_000,
    } as const;
    const results = await Promise.all([left.claim(input), right.claim(input)]);
    assert.equal(results.filter((result) => result.status === "claimed").length, 1);
    assert.equal(results.filter((result) => result.status === "replay").length, 1);
    assert.equal(results[0].record.runId, results[1].record.runId);
  } finally {
    left.close();
    right.close();
  }
});

test("durable conversation leases serialize independent gateway workers", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-conversation-lease-"));
  const filename = join(cwd, "enterprise.db");
  const leftStore = new EnterpriseSqliteStore(filename);
  const rightStore = new EnterpriseSqliteStore(filename);
  const left = new DurableConversationLease(leftStore, { leaseMs: 10_000, retryMs: 5 });
  const right = new DurableConversationLease(rightStore, { leaseMs: 10_000, retryMs: 5 });
  let active = 0;
  let maxActive = 0;
  try {
    await Promise.all([
      left.run("same-conversation", async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(60);
        active -= 1;
      }),
      right.run("same-conversation", async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(60);
        active -= 1;
      }),
    ]);
    assert.equal(maxActive, 1);
  } finally {
    leftStore.close();
    rightStore.close();
  }
});
