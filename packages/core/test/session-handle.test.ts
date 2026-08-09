import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canReuseHandle, clearConversationSessionHandles, clearSessionHandle, loadSessionHandle, saveSessionHandle } from "../src/index.js";
import type { SessionHandleRecord } from "../src/index.js";

const rec = (over: Partial<SessionHandleRecord> = {}): SessionHandleRecord => ({
  conversationKey: "telegram:bot:c1",
  backendId: "codex",
  handle: "thread-abc",
  cwd: "/ws/tg",
  model: "gpt-5.5",
  updatedAt: "2026-06-15T00:00:00Z",
  ...over,
});

test("session handle round-trips and is keyed by (backend, conversation)", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-sh-"));
  assert.equal(await loadSessionHandle("telegram:bot:c1", "codex", cwd), undefined);

  await saveSessionHandle(rec(), cwd);
  await saveSessionHandle(rec({ conversationKey: "telegram:bot:c2", handle: "thread-two" }), cwd);
  await saveSessionHandle(rec({ backendId: "claude", handle: "sess-claude" }), cwd);

  assert.equal((await loadSessionHandle("telegram:bot:c1", "codex", cwd))?.handle, "thread-abc");
  assert.equal((await loadSessionHandle("telegram:bot:c2", "codex", cwd))?.handle, "thread-two");
  assert.equal((await loadSessionHandle("telegram:bot:c1", "claude", cwd))?.handle, "sess-claude");
});

test("saving the same key overwrites; clear removes only that key", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-sh-clear-"));
  await saveSessionHandle(rec({ handle: "v1" }), cwd);
  await saveSessionHandle(rec({ handle: "v2" }), cwd);
  assert.equal((await loadSessionHandle("telegram:bot:c1", "codex", cwd))?.handle, "v2");

  await saveSessionHandle(rec({ conversationKey: "other", handle: "keep" }), cwd);
  await clearSessionHandle("telegram:bot:c1", "codex", cwd);
  assert.equal(await loadSessionHandle("telegram:bot:c1", "codex", cwd), undefined);
  assert.equal((await loadSessionHandle("other", "codex", cwd))?.handle, "keep", "clear is surgical");
});

test("concurrent session-handle saves preserve every conversation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-sh-concurrent-"));
  const records = Array.from({ length: 24 }, (_, index) => rec({
    conversationKey: `conversation-${index}`,
    handle: `thread-${index}`,
  }));

  await Promise.all(records.map((record) => saveSessionHandle(record, cwd)));

  const loaded = await Promise.all(records.map((record) => loadSessionHandle(record.conversationKey, record.backendId, cwd)));
  assert.deepEqual(loaded.map((record) => record?.handle), records.map((record) => record.handle));
});

test("clearConversationSessionHandles removes every backend handle for one conversation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-sh-clear-all-"));
  await saveSessionHandle(rec({ backendId: "codex", handle: "codex-thread" }), cwd);
  await saveSessionHandle(rec({ backendId: "claude", handle: "claude-session" }), cwd);
  await saveSessionHandle(rec({ backendId: "future-provider", handle: "future-session" }), cwd);
  await saveSessionHandle(rec({ backendId: "codex", conversationKey: "other", handle: "keep" }), cwd);

  const removed = await clearConversationSessionHandles("telegram:bot:c1", cwd);

  assert.equal(removed, 3);
  assert.equal(await loadSessionHandle("telegram:bot:c1", "codex", cwd), undefined);
  assert.equal(await loadSessionHandle("telegram:bot:c1", "claude", cwd), undefined);
  assert.equal(await loadSessionHandle("telegram:bot:c1", "future-provider", cwd), undefined);
  assert.equal((await loadSessionHandle("other", "codex", cwd))?.handle, "keep");
});

test("canReuseHandle: resume only when workspace, model, and injected context are unchanged", () => {
  const record = rec({ contextHash: "ctx-a" });
  assert.equal(canReuseHandle(record, "/ws/tg", "gpt-5.5", "ctx-a"), true);
  assert.equal(canReuseHandle(record, "/ws/tg", "gpt-5.5"), true, "callers without context hashes keep legacy compatibility");
  assert.equal(canReuseHandle(record, "/ws/OTHER", "gpt-5.5"), false, "changed workspace → fresh thread");
  assert.equal(canReuseHandle(record, "/ws/tg", "gpt-5.4"), false, "changed model → fresh thread");
  assert.equal(canReuseHandle(record, "/ws/tg", "gpt-5.5", "ctx-b"), false, "changed injected memory/skills/rules → fresh thread");
  assert.equal(canReuseHandle(rec(), "/ws/tg", "gpt-5.5", "ctx-a"), false, "old records without context hash are not reused when context-aware callers opt in");
  assert.equal(canReuseHandle(undefined, "/ws/tg", "gpt-5.5"), false, "no stored handle → fresh thread");
});

test("canReuseHandle: rotates legacy, old, and over-budget provider threads", () => {
  const createdAt = "2026-07-13T08:00:00.000Z";
  const nowMs = Date.parse("2026-07-13T09:00:00.000Z");
  const budget = { maxTurns: 12, maxAgeMs: 2 * 60 * 60_000, nowMs };

  assert.equal(
    canReuseHandle(rec({ contextHash: "ctx-a" }), "/ws/tg", "gpt-5.5", "ctx-a", budget),
    false,
    "legacy records without bounded-session metadata rotate instead of carrying unbounded history",
  );
  assert.equal(
    canReuseHandle(rec({ contextHash: "ctx-a", createdAt, turnCount: 11 }), "/ws/tg", "gpt-5.5", "ctx-a", budget),
    true,
  );
  assert.equal(
    canReuseHandle(rec({ contextHash: "ctx-a", createdAt, turnCount: 12 }), "/ws/tg", "gpt-5.5", "ctx-a", budget),
    false,
    "turn budget is exclusive",
  );
  assert.equal(
    canReuseHandle(
      rec({ contextHash: "ctx-a", createdAt: "2026-07-13T06:59:59.999Z", turnCount: 1 }),
      "/ws/tg",
      "gpt-5.5",
      "ctx-a",
      budget,
    ),
    false,
    "age budget rotates old context",
  );
});
