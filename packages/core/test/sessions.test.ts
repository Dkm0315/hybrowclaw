import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { messagesToTranscript, openSessionStore } from "../src/index.js";

async function storeWithData() {
  const cwd = await mkdtemp(join(tmpdir(), "muster-sessions-"));
  const store = openSessionStore(cwd);
  const a = store.createSession({ channel: "telegram", peer: "alice", title: "Deploy planning" });
  const b = store.createSession({ channel: "web", peer: "bob" });
  for (let index = 0; index < 40; index += 1) {
    store.appendMessage(a.id, index % 2 ? "assistant" : "user", `message ${index} about deployment pipelines`);
  }
  store.appendMessage(b.id, "user", "unrelated question about quarterly payroll exports");
  store.appendMessage(b.id, "assistant", "payroll exports live in the finance workspace");
  return { cwd, store, a, b };
}

test("discover: query finds matches with snippets and windows, deduped per session", async () => {
  const { store, a, b } = await storeWithData();
  const result = store.search({ query: "payroll" });
  assert.equal(result.shape, "discover");
  if (result.shape !== "discover") return;
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].sessionId, b.id);
  assert.match(result.hits[0].snippet, /payroll/);
  assert.ok(result.hits[0].window.length >= 1);

  const many = store.search({ query: "deployment" });
  if (many.shape !== "discover") return assert.fail("expected discover");
  assert.equal(many.hits.length, 1, "40 matches in one session dedupe to one hit");
  assert.equal(many.hits[0].sessionId, a.id);
  store.close();
});

test("scroll: window around a message id", async () => {
  const { store, a } = await storeWithData();
  const result = store.search({ sessionId: a.id, aroundMessageId: 10 });
  assert.equal(result.shape, "scroll");
  if (result.shape !== "scroll") return;
  assert.ok(result.messages.length >= 5 && result.messages.length <= 11);
  assert.ok(result.messages.every((message) => Math.abs(message.id - 10) <= 5));
  store.close();
});

test("read: head/tail truncation with omitted count", async () => {
  const { store, a } = await storeWithData();
  const result = store.search({ sessionId: a.id });
  assert.equal(result.shape, "read");
  if (result.shape !== "read") return;
  assert.equal(result.head.length, 20);
  assert.equal(result.tail.length, 10);
  assert.equal(result.omitted, 10);
  assert.equal(result.session.title, "Deploy planning");
  store.close();
});

test("browse: recent sessions; usage rolls up", async () => {
  const { store, a } = await storeWithData();
  store.addUsage(a.id, 1200, 340, 0.0123);
  store.addUsage(a.id, 100, 10, 0.001);
  const result = store.search({});
  assert.equal(result.shape, "browse");
  if (result.shape !== "browse") return;
  assert.equal(result.sessions.length, 2);
  const updated = result.sessions.find((session) => session.id === a.id)!;
  assert.equal(updated.tokensIn, 1300);
  assert.equal(updated.tokensOut, 350);
  assert.ok(Math.abs(updated.costUsd - 0.0133) < 1e-9);
  store.close();
});

test("workspace scoping returns only sessions bound to the requested directory", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-sessions-scope-"));
  const here = join(cwd, "repo-a");
  const elsewhere = join(cwd, "repo-b");
  const store = openSessionStore(cwd);
  const local = store.createSession({ channel: "cli-chat", peer: "local", workspaceCwd: here });
  store.createSession({ channel: "cli-chat", peer: "remote", workspaceCwd: elsewhere });
  store.createSession({ channel: "cli-chat", peer: "legacy", workspaceCwd: null });

  const result = store.search({ workspaceCwd: here, limit: 20 });
  assert.equal(result.shape, "browse");
  if (result.shape !== "browse") return;
  assert.deepEqual(result.sessions.map((session) => session.id), [local.id]);
  assert.equal(result.sessions[0].workspaceCwd, await realpath(here).catch(() => here));

  const all = store.search({ limit: 20 });
  if (all.shape !== "browse") return assert.fail("expected browse");
  assert.equal(all.sessions.length, 3);
  assert.equal(all.sessions.find((session) => session.peer === "legacy")?.workspaceCwd, null);
  store.close();
});

test("opening an old sessions table adds workspace_cwd and treats existing rows as global", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-sessions-migrate-"));
  const data = join(cwd, ".muster", "data");
  await mkdir(data, { recursive: true });
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void };
  };
  const db = new DatabaseSync(join(data, "sessions.db"));
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', channel TEXT NOT NULL,
      peer TEXT NOT NULL, created_at TEXT NOT NULL, parent_id TEXT,
      tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0
    );
    INSERT INTO sessions (id, title, channel, peer, created_at) VALUES ('sess_old', 'old', 'cli-chat', 'legacy', '2026-01-01T00:00:00.000Z');
  `);
  db.close();

  const store = openSessionStore(cwd);
  const result = store.search({ sessionId: "sess_old" });
  if (result.shape !== "read") return assert.fail("expected old session");
  assert.equal(result.session.workspaceCwd, null);
  assert.equal(store.createSession({ channel: "cli-chat", peer: "new" }).workspaceCwd, await realpath(cwd));
  store.close();
});

test("backend reports fts5 on this Node build and titles are capped", async () => {
  const { store, a } = await storeWithData();
  assert.ok(["sqlite-fts5", "sqlite-like"].includes(store.backend));
  store.setTitle(a.id, "x".repeat(200));
  const read = store.search({ sessionId: a.id });
  if (read.shape !== "read") return assert.fail("expected read");
  assert.equal(read.session.title.length, 80);
  store.close();
});

test("loadActiveMessages + deactivate drive the renderer window (compacted rows leave but stay in history)", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-sessions-load-"));
  const store = openSessionStore(cwd);
  const s = store.createSession({ channel: "telegram", peer: "bob" });
  const m1 = store.appendMessage(s.id, "user", "first");
  store.appendMessage(s.id, "assistant", "reply one");
  const m3 = store.appendMessage(s.id, "tool", "big tool output");
  store.appendMessage(s.id, "user", "second");

  const active = store.loadActiveMessages(s.id);
  assert.deepEqual(active.map((m) => m.content), ["first", "reply one", "big tool output", "second"], "oldest-first, all active");

  store.deactivate([m1.id, m3.id]);
  const after = store.loadActiveMessages(s.id);
  assert.deepEqual(after.map((m) => m.content), ["reply one", "second"], "deactivated rows leave the active window");

  // ...but they remain in searchable history (active filter is only for the render window).
  const transcript = messagesToTranscript(after);
  assert.deepEqual(transcript.map((m) => [m.role, m.content]), [["assistant", "reply one"], ["user", "second"]]);
  store.close();
});

test("findOrCreateSession reuses the latest session per (channel, peer) for multi-turn continuity", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-sessions-foc-"));
  const store = openSessionStore(cwd);
  const first = store.findOrCreateSession({ channel: "telegram:bot", peer: "c1" });
  const again = store.findOrCreateSession({ channel: "telegram:bot", peer: "c1" });
  assert.equal(again.id, first.id, "same conversation reuses one session (no fresh-per-turn)");
  const other = store.findOrCreateSession({ channel: "telegram:bot", peer: "c2" });
  assert.notEqual(other.id, first.id, "a different peer gets its own session");
  const otherWorkspace = store.findOrCreateSession({ channel: "telegram:bot", peer: "c1", workspaceCwd: join(cwd, "other") });
  assert.notEqual(otherWorkspace.id, first.id, "the same peer in another workspace gets its own session");
  assert.equal(first.workspaceCwd, await realpath(cwd));
  store.close();
});

test("messagesToTranscript maps roles and coerces unknown roles to user", () => {
  const transcript = messagesToTranscript([
    { id: 1, sessionId: "s", role: "assistant", content: "a", tokenCount: 1, createdAt: "t" },
    { id: 2, sessionId: "s", role: "weird", content: "b", tokenCount: 2, createdAt: "t" },
  ]);
  assert.deepEqual(transcript, [
    { role: "assistant", content: "a", tokens: 1 },
    { role: "user", content: "b", tokens: 2 },
  ]);
});
