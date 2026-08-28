import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  CODEX_IMPORT_CHANNEL,
  CodexSessionError,
  codexImportTitlePrefix,
  codexSessionsDir,
  discoverCodexSessions,
  importCodexSession,
  isSyntheticCodexUserText,
  listCodexRolloutFiles,
  matchCodexThread,
  orderCodexSessionsByLineage,
  parseCodexSince,
  readCodexRollout,
  readCodexSessionMeta,
  resolveCodexForkChain,
  summarizeCodexPrompt,
  type CodexSessionSummary,
} from "../src/codex-sessions.js";
import { openSessionStore, type SessionStore } from "../src/sessions.js";

/* ---------- fixtures: the real 0.150.0-alpha.8 rollout shape ---------- */

interface FixtureTurn {
  readonly user: string;
  readonly assistant: string;
}

interface FixtureOptions {
  readonly threadId: string;
  /** `payload.session_id`; a multi-agent parent shares it with every subagent. */
  readonly rootSessionId?: string;
  readonly cwd?: string;
  readonly startedAt?: string;
  readonly forkedFromId?: string;
  readonly parentThreadId?: string;
  readonly threadSource?: string;
  readonly model?: string;
  readonly turns: readonly FixtureTurn[];
  /** Extra raw lines appended verbatim (corruption, unknown types, huge lines). */
  readonly extraLines?: readonly string[];
  readonly mtimeMs?: number;
}

function metaLine(options: FixtureOptions): string {
  const startedAt = options.startedAt ?? "2026-08-20T10:00:00.000Z";
  const subagent = options.threadSource === "subagent";
  return JSON.stringify({
    timestamp: startedAt,
    type: "session_meta",
    payload: {
      session_id: options.rootSessionId ?? options.threadId,
      id: options.threadId,
      timestamp: startedAt,
      cwd: options.cwd ?? "/Users/dhairya/Documents/redis-automation",
      originator: "codex-tui",
      cli_version: "0.150.0-alpha.8",
      // Real subagent rollouts carry an OBJECT here, not a string.
      source: subagent
        ? { subagent: { thread_spawn: { parent_thread_id: options.parentThreadId ?? "", depth: 1, agent_nickname: "Sagan" } } }
        : "vscode",
      model_provider: "openai",
      ...(options.threadSource ? { thread_source: options.threadSource } : {}),
      ...(options.forkedFromId ? { forked_from_id: options.forkedFromId } : {}),
      ...(options.parentThreadId ? { parent_thread_id: options.parentThreadId } : {}),
      // Codex really does inline the whole system prompt here; the parser must
      // not care.
      base_instructions: { text: "You are Codex…" },
    },
  });
}

function rolloutBody(options: FixtureOptions): string[] {
  const lines = [metaLine(options)];
  // The synthetic scaffolding Codex injects as a user-role item, verified
  // present as the FIRST user message of every real session on this machine.
  lines.push(JSON.stringify({
    timestamp: "2026-08-20T10:00:01.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "<environment_context>\n  <cwd>/tmp</cwd>\n</environment_context>" }],
    },
  }));
  lines.push(JSON.stringify({
    timestamp: "2026-08-20T10:00:01.500Z",
    type: "response_item",
    payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "<skills_instructions>…" }] },
  }));
  options.turns.forEach((turn, index) => {
    const at = `2026-08-20T10:0${index + 1}:00.000Z`;
    lines.push(JSON.stringify({
      timestamp: at,
      type: "turn_context",
      payload: { turn_id: `turn-${index}`, cwd: options.cwd ?? "/tmp", model: options.model ?? "gpt-5.6-sol" },
    }));
    lines.push(JSON.stringify({
      timestamp: at,
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: turn.user }] },
    }));
    // Duplicated on purpose: real rollouts carry BOTH an event_msg and a
    // response_item for the same assistant text. Import must store it once.
    lines.push(JSON.stringify({
      timestamp: at,
      type: "event_msg",
      payload: { type: "agent_message", message: turn.assistant, phase: "final_answer" },
    }));
    lines.push(JSON.stringify({
      timestamp: at,
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: turn.assistant }] },
    }));
    lines.push(JSON.stringify({
      timestamp: at,
      type: "response_item",
      payload: { type: "custom_tool_call", name: "exec", input: "ls -la" },
    }));
  });
  return [...lines, ...(options.extraLines ?? [])];
}

async function writeRollout(root: string, day: string, options: FixtureOptions): Promise<string> {
  const dir = join(root, "sessions", ...day.split("-"));
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `rollout-${day}T10-00-00-${options.threadId}.jsonl`);
  await writeFile(filePath, `${rolloutBody(options).join("\n")}\n`, "utf8");
  if (options.mtimeMs !== undefined) {
    const seconds = options.mtimeMs / 1000;
    await utimes(filePath, seconds, seconds);
  }
  return filePath;
}

async function withCodexHome(t: TestContext, run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "muster-codex-home-"));
  t.after(async () => { await rm(home, { recursive: true, force: true }); });
  await run(home);
}

async function withStore(t: TestContext, run: (store: SessionStore, cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "muster-codex-store-"));
  const store = openSessionStore(cwd);
  t.after(async () => {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  });
  await run(store, cwd);
}

/* ---------- paths ---------- */

test("codexSessionsDir prefers the explicit home over CODEX_HOME", () => {
  assert.equal(codexSessionsDir("/opt/codex"), join("/opt/codex", "sessions"));
});

test("listCodexRolloutFiles returns [] when the sessions root does not exist", async () => {
  const files = await listCodexRolloutFiles(join(tmpdir(), `muster-missing-${Date.now()}`));
  assert.deepEqual(files, []);
});

/* ---------- parsing ---------- */

test("readCodexRollout extracts meta, model, and the human transcript", async (t) => {
  await withCodexHome(t, async (home) => {
    const filePath = await writeRollout(home, "2026-08-20", {
      threadId: "019fd7c4-900a-74b1-989e-fd9562faf7bb",
      cwd: "/Users/dhairya/Documents/redis-automation",
      turns: [
        { user: "double the shards", assistant: "Scale-out only adds empty masters." },
        { user: "check those three commits", assistant: "Here are the file locations." },
      ],
    });

    const rollout = await readCodexRollout(filePath);

    assert.equal(rollout.meta.threadId, "019fd7c4-900a-74b1-989e-fd9562faf7bb");
    assert.equal(rollout.meta.cwd, "/Users/dhairya/Documents/redis-automation");
    assert.equal(rollout.meta.cliVersion, "0.150.0-alpha.8");
    assert.equal(rollout.model, "gpt-5.6-sol");
    // Synthetic <environment_context>, the developer item, the duplicated
    // event_msg, and the tool call are all excluded: four turns exactly.
    assert.deepEqual(rollout.messages.map((message) => message.role), ["user", "assistant", "user", "assistant"]);
    assert.equal(rollout.messages[0].text, "double the shards");
    assert.equal(rollout.messages[3].text, "Here are the file locations.");
    assert.equal(rollout.stats.truncated, false);
    assert.equal(rollout.stats.malformedLines, 0);
  });
});

test("readCodexRollout falls back to event_msg when no response_item messages exist", async (t) => {
  await withCodexHome(t, async (home) => {
    const dir = join(home, "sessions", "2026", "08", "21");
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "rollout-2026-08-21T10-00-00-legacy.jsonl");
    await writeFile(filePath, [
      metaLine({ threadId: "legacy-thread", turns: [] }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "legacy ask" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "legacy answer" } }),
    ].join("\n"), "utf8");

    const rollout = await readCodexRollout(filePath);

    assert.deepEqual(rollout.messages.map((message) => message.text), ["legacy ask", "legacy answer"]);
  });
});

test("readCodexRollout throws a typed error when session_meta is absent", async (t) => {
  await withCodexHome(t, async (home) => {
    const dir = join(home, "sessions", "2026", "08", "22");
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "rollout-2026-08-22T10-00-00-nometa.jsonl");
    await writeFile(filePath, `${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hi" } })}\n`, "utf8");

    await assert.rejects(
      () => readCodexRollout(filePath),
      (error: unknown) => error instanceof CodexSessionError && error.code === "missing_session_meta",
    );
  });
});

test("readCodexRollout counts malformed lines instead of failing the file", async (t) => {
  await withCodexHome(t, async (home) => {
    const filePath = await writeRollout(home, "2026-08-23", {
      threadId: "half-written",
      turns: [{ user: "ask", assistant: "answer" }],
      // A live tail: Codex was mid-write when we read.
      extraLines: ["{\"type\":\"response_item\",\"payload\":{\"type\":\"mess", "not json at all"],
    });

    const rollout = await readCodexRollout(filePath);

    assert.equal(rollout.stats.malformedLines, 2);
    assert.equal(rollout.messages.length, 2);
  });
});

test("readCodexRollout drops an oversized line without buffering it", async (t) => {
  await withCodexHome(t, async (home) => {
    const giant = JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "x".repeat(200_000) }] },
    });
    const filePath = await writeRollout(home, "2026-08-24", {
      threadId: "oversized",
      turns: [{ user: "ask", assistant: "answer" }],
      extraLines: [giant, JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "after the giant" }] },
      })],
    });

    const rollout = await readCodexRollout(filePath, { maxLineBytes: 4096 });

    assert.equal(rollout.stats.oversizedLines, 1);
    // The line AFTER the dropped one still parses — the skip resynchronizes.
    assert.deepEqual(rollout.messages.map((message) => message.text), ["ask", "answer", "after the giant"]);
  });
});

test("readCodexRollout clamps a single huge message and marks the truncation", async (t) => {
  await withCodexHome(t, async (home) => {
    const filePath = await writeRollout(home, "2026-08-25", {
      threadId: "clamped",
      turns: [{ user: "y".repeat(5000), assistant: "ok" }],
    });

    const rollout = await readCodexRollout(filePath, { maxMessageChars: 100 });

    assert.ok(rollout.messages[0].text.startsWith("y".repeat(100)));
    assert.ok(rollout.messages[0].text.includes("truncated by muster codex import"));
  });
});

test("readCodexRollout stops at the byte budget and reports truncation", async (t) => {
  await withCodexHome(t, async (home) => {
    const filePath = await writeRollout(home, "2026-08-26", {
      threadId: "budgeted",
      turns: Array.from({ length: 40 }, (_unused, index) => ({ user: `ask ${index}`, assistant: `answer ${index}` })),
    });

    const rollout = await readCodexRollout(filePath, { maxBytes: 2048 });

    assert.equal(rollout.stats.truncated, true);
    assert.ok(rollout.messages.length > 0);
    assert.ok(rollout.messages.length < 80);
  });
});

test("readCodexRollout keys on payload.id, not the shared session_id", async (t) => {
  await withCodexHome(t, async (home) => {
    // The shape measured in the wild: a spawned subagent inherits the parent's
    // session_id, so keying on it would collapse distinct threads into one.
    const filePath = await writeRollout(home, "2026-08-26", {
      threadId: "01a03d0e-c7c3-75b3-a294-7687cce4ec9a",
      rootSessionId: "019f83aa-1cc5-7180-a22a-506b580e9fc0",
      parentThreadId: "019f83aa-1cc5-7180-a22a-506b580e9fc0",
      forkedFromId: "019f83aa-1cc5-7180-a22a-506b580e9fc0",
      threadSource: "subagent",
      turns: [{ user: "delegated task", assistant: "done" }],
    });

    const rollout = await readCodexRollout(filePath);

    assert.equal(rollout.meta.threadId, "01a03d0e-c7c3-75b3-a294-7687cce4ec9a");
    assert.equal(rollout.meta.rootSessionId, "019f83aa-1cc5-7180-a22a-506b580e9fc0");
    assert.equal(rollout.meta.threadSource, "subagent");
    // `source` is an object on subagent rollouts; it must not become "[object Object]".
    assert.equal(rollout.meta.source, undefined);
  });
});

test("readCodexSessionMeta stops after the first line and matches the full read", async (t) => {
  await withCodexHome(t, async (home) => {
    const filePath = await writeRollout(home, "2026-08-26", {
      threadId: "meta-probe",
      turns: Array.from({ length: 30 }, (_unused, index) => ({ user: `ask ${index}`, assistant: `answer ${index}` })),
    });

    const meta = await readCodexSessionMeta(filePath);

    assert.deepEqual(meta, (await readCodexRollout(filePath)).meta);
  });
});

test("isSyntheticCodexUserText skips Codex scaffolding but keeps pasted markup", () => {
  assert.equal(isSyntheticCodexUserText("<environment_context>\n<cwd>/tmp</cwd>"), true);
  assert.equal(isSyntheticCodexUserText("<turn_aborted>"), true);
  assert.equal(isSyntheticCodexUserText("<div>fix this markup</div>"), false);
  assert.equal(isSyntheticCodexUserText("why is <environment_context> empty?"), false);
});

/* ---------- discovery ---------- */

test("discoverCodexSessions summarizes newest-first and skips the corrupt file", async (t) => {
  await withCodexHome(t, async (home) => {
    const now = Date.UTC(2026, 7, 27, 12, 0, 0);
    await writeRollout(home, "2026-08-20", {
      threadId: "aaaa1111-0000-0000-0000-000000000001",
      cwd: "/Users/dhairya/Documents/redis-automation",
      turns: [{ user: "double the shards", assistant: "ok" }],
      mtimeMs: now - 3 * 86_400_000,
    });
    await writeRollout(home, "2026-08-26", {
      threadId: "bbbb2222-0000-0000-0000-000000000002",
      cwd: "/Users/dhairya/Documents/muster",
      turns: [{ user: "ship the lane", assistant: "done" }, { user: "and tests", assistant: "green" }],
      mtimeMs: now - 3_600_000,
    });
    // A file with no session_meta at all: skipped and reported, never fatal.
    const brokenDir = join(home, "sessions", "2026", "08", "27");
    await mkdir(brokenDir, { recursive: true });
    const brokenPath = join(brokenDir, "rollout-2026-08-27T10-00-00-broken.jsonl");
    await writeFile(brokenPath, "}{ not json\n", "utf8");
    await utimes(brokenPath, now / 1000, now / 1000);

    const result = await discoverCodexSessions({ codexHome: home, nowMs: now });

    assert.equal(result.candidates, 3);
    assert.deepEqual(result.sessions.map((session) => session.threadId), [
      "bbbb2222-0000-0000-0000-000000000002",
      "aaaa1111-0000-0000-0000-000000000001",
    ]);
    assert.equal(result.sessions[0].turnCount, 2);
    assert.equal(result.sessions[0].turnCountExact, true);
    assert.equal(result.sessions[0].firstUserMessage, "ship the lane");
    assert.equal(result.sessions[1].cwd, "/Users/dhairya/Documents/redis-automation");
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].reason, "missing_session_meta");
    assert.equal(result.skipped[0].filePath, brokenPath);
  });
});

test("discoverCodexSessions honours since and limit without opening older files", async (t) => {
  await withCodexHome(t, async (home) => {
    const now = Date.UTC(2026, 7, 27, 12, 0, 0);
    await writeRollout(home, "2026-08-01", { threadId: "old-1", turns: [{ user: "a", assistant: "b" }], mtimeMs: now - 20 * 86_400_000 });
    await writeRollout(home, "2026-08-25", { threadId: "new-1", turns: [{ user: "a", assistant: "b" }], mtimeMs: now - 2 * 86_400_000 });
    await writeRollout(home, "2026-08-26", { threadId: "new-2", turns: [{ user: "a", assistant: "b" }], mtimeMs: now - 86_400_000 });

    const recent = await discoverCodexSessions({ codexHome: home, since: "7d", nowMs: now });
    assert.deepEqual(recent.sessions.map((session) => session.threadId), ["new-2", "new-1"]);
    assert.equal(recent.scanned, 2, "the 20-day-old rollout is never opened");

    const capped = await discoverCodexSessions({ codexHome: home, limit: 1, nowMs: now });
    assert.deepEqual(capped.sessions.map((session) => session.threadId), ["new-2"]);
    assert.equal(capped.scanned, 1);
  });
});

test("discoverCodexSessions hides multi-agent fan-out unless asked for it", async (t) => {
  await withCodexHome(t, async (home) => {
    const now = Date.UTC(2026, 7, 27, 12, 0, 0);
    await writeRollout(home, "2026-08-26", {
      threadId: "parent-thread",
      threadSource: "user",
      turns: [{ user: "plan the migration", assistant: "delegating" }],
      mtimeMs: now,
    });
    for (const child of ["sagan", "faraday"]) {
      await writeRollout(home, "2026-08-26", {
        threadId: `subagent-${child}`,
        rootSessionId: "parent-thread",
        parentThreadId: "parent-thread",
        threadSource: "subagent",
        turns: [{ user: "delegated task", assistant: "done" }],
        mtimeMs: now - 1000,
      });
    }
    // Older CLI builds omit thread_source entirely; those are the user's chats.
    await writeRollout(home, "2026-08-25", { threadId: "legacy-user-thread", turns: [{ user: "old ask", assistant: "old answer" }], mtimeMs: now - 2000 });

    const visible = await discoverCodexSessions({ codexHome: home, nowMs: now });
    assert.deepEqual(visible.sessions.map((session) => session.threadId), ["parent-thread", "legacy-user-thread"]);
    assert.equal(visible.subagentsHidden, 2);
    assert.equal(visible.candidates, 4);

    const all = await discoverCodexSessions({ codexHome: home, includeSubagents: true, nowMs: now });
    assert.equal(all.sessions.length, 4);
    assert.equal(all.subagentsHidden, 0);
  });
});

test("discoverCodexSessions can scope to a single project directory", async (t) => {
  await withCodexHome(t, async (home) => {
    const now = Date.UTC(2026, 7, 27, 12, 0, 0);
    await writeRollout(home, "2026-08-26", { threadId: "here", cwd: "/Users/dhairya/Documents/muster", turns: [{ user: "a", assistant: "b" }], mtimeMs: now });
    await writeRollout(home, "2026-08-26", { threadId: "elsewhere", cwd: "/Users/dhairya/Documents/redis-automation", turns: [{ user: "a", assistant: "b" }], mtimeMs: now - 1000 });

    const scoped = await discoverCodexSessions({ codexHome: home, cwd: "/Users/dhairya/Documents/muster", nowMs: now });

    assert.deepEqual(scoped.sessions.map((session) => session.threadId), ["here"]);
  });
});

test("parseCodexSince accepts relative spans, ISO dates, and rejects nonsense", () => {
  const now = Date.UTC(2026, 7, 27, 12, 0, 0);
  assert.equal(parseCodexSince("7d", now), now - 7 * 86_400_000);
  assert.equal(parseCodexSince("24h", now), now - 24 * 3_600_000);
  assert.equal(parseCodexSince("2026-08-20T00:00:00Z", now), Date.parse("2026-08-20T00:00:00Z"));
  assert.equal(parseCodexSince(undefined, now), undefined);
  assert.equal(parseCodexSince("last tuesday", now), undefined);
});

/* ---------- lineage ---------- */

test("resolveCodexForkChain walks fork lineage oldest-first and survives a cycle", async (t) => {
  await withCodexHome(t, async (home) => {
    const now = Date.UTC(2026, 7, 27, 12, 0, 0);
    await writeRollout(home, "2026-07-21", { threadId: "root-thread", turns: [{ user: "start", assistant: "ok" }], mtimeMs: now - 5 * 86_400_000 });
    await writeRollout(home, "2026-08-06", { threadId: "fork-a", forkedFromId: "root-thread", turns: [{ user: "branch", assistant: "ok" }], mtimeMs: now - 4 * 86_400_000 });
    await writeRollout(home, "2026-08-07", { threadId: "fork-b", forkedFromId: "fork-a", turns: [{ user: "branch again", assistant: "ok" }], mtimeMs: now - 3 * 86_400_000 });

    const result = await discoverCodexSessions({ codexHome: home, nowMs: now });
    const leaf = result.sessions.find((session) => session.threadId === "fork-b");
    assert.equal(leaf?.forkedFromId, "fork-a");

    assert.deepEqual(
      resolveCodexForkChain(result.sessions, "fork-b").map((session) => session.threadId),
      ["root-thread", "fork-a", "fork-b"],
    );
    assert.deepEqual(resolveCodexForkChain(result.sessions, "root-thread").map((session) => session.threadId), ["root-thread"]);
    assert.deepEqual(resolveCodexForkChain(result.sessions, "not-a-thread"), []);

    const cyclic = [
      { threadId: "x", forkedFromId: "y" },
      { threadId: "y", forkedFromId: "x" },
    ] as unknown as readonly CodexSessionSummary[];
    assert.deepEqual(resolveCodexForkChain(cyclic, "x").map((session) => session.threadId), ["y", "x"]);
  });
});

test("matchCodexThread resolves prefixes, prefers exact ids, and flags ambiguity", () => {
  const sessions = [
    { threadId: "01a04290-e28a-7df0-8133-81dfc1b3249b" },
    { threadId: "01a042d6-2151-70e0-bb08-823e0a1c71a0" },
    { threadId: "01a0" },
  ];

  assert.deepEqual(matchCodexThread(sessions, "01a04290"), { kind: "match", session: sessions[0] });
  assert.deepEqual(matchCodexThread(sessions, "01A04290-E28A-7DF0-8133-81DFC1B3249B"), { kind: "match", session: sessions[0] });
  // "01a0" prefixes all three, but it is also an exact id — exact wins.
  assert.deepEqual(matchCodexThread(sessions, "01a0"), { kind: "match", session: sessions[2] });
  assert.equal(matchCodexThread(sessions, "01a04").kind, "ambiguous");
  assert.deepEqual(matchCodexThread(sessions, "zzz"), { kind: "none" });
  assert.deepEqual(matchCodexThread(sessions, "  "), { kind: "none" });
});

/* ---------- import ---------- */

test("importCodexSession writes provenance plus the transcript as MessageRows", async (t) => {
  await withCodexHome(t, async (home) => {
    await withStore(t, async (store) => {
      const now = Date.UTC(2026, 7, 27, 12, 0, 0);
      await writeRollout(home, "2026-08-26", {
        threadId: "cccc3333-0000-0000-0000-000000000003",
        cwd: "/Users/dhairya/Documents/redis-automation",
        forkedFromId: "root-thread",
        turns: [{ user: "double the shards", assistant: "scale-out adds empty masters" }],
        mtimeMs: now,
      });
      const { sessions } = await discoverCodexSessions({ codexHome: home, nowMs: now });

      const result = await importCodexSession(sessions[0], store);

      assert.equal(result.created, true);
      assert.equal(result.diverged, false);
      assert.equal(result.appended, 3);
      assert.equal(result.threadId, "cccc3333-0000-0000-0000-000000000003");

      const rows = store.loadActiveMessages(result.sessionId);
      assert.deepEqual(rows.map((row) => row.role), ["system", "user", "assistant"]);
      assert.match(rows[0].content, /^Imported Codex session cccc3333-0000-0000-0000-000000000003$/m);
      assert.match(rows[0].content, /forked from: root-thread/);
      assert.equal(rows[1].content, "double the shards");
      assert.ok(rows[1].tokenCount > 0, "imported rows carry token estimates for the ledger");

      const browsed = store.search({ limit: 10 });
      assert.equal(browsed.shape, "browse");
      const session = browsed.shape === "browse" ? browsed.sessions[0] : undefined;
      assert.equal(session?.channel, CODEX_IMPORT_CHANNEL);
      assert.equal(session?.peer, "redis-automation", "peer is the project dir so browsing reads like the user's world");
      assert.ok(session?.title.startsWith(codexImportTitlePrefix("cccc3333-0000-0000-0000-000000000003")));

      // The imported text is reachable through cross-session search.
      const hits = store.search({ query: "shards" });
      assert.equal(hits.shape, "discover");
      assert.equal(hits.shape === "discover" ? hits.hits[0]?.sessionId : undefined, result.sessionId);
    });
  });
});

test("importCodexSession is idempotent and appends only the new turns", async (t) => {
  await withCodexHome(t, async (home) => {
    await withStore(t, async (store) => {
      const now = Date.UTC(2026, 7, 27, 12, 0, 0);
      const options = {
        threadId: "dddd4444-0000-0000-0000-000000000004",
        cwd: "/Users/dhairya/Documents/muster",
        turns: [{ user: "first ask", assistant: "first answer" }],
        mtimeMs: now,
      };
      await writeRollout(home, "2026-08-26", options);
      const first = await discoverCodexSessions({ codexHome: home, nowMs: now });
      const initial = await importCodexSession(first.sessions[0], store);
      assert.equal(initial.appended, 3);

      // Re-import with the file unchanged: same session, nothing written.
      const repeat = await importCodexSession(first.sessions[0], store);
      assert.equal(repeat.sessionId, initial.sessionId);
      assert.equal(repeat.created, false);
      assert.equal(repeat.appended, 0);
      assert.equal(repeat.alreadyPresent, 3);
      assert.equal(repeat.diverged, false);

      // The user kept working in raw Codex; only the delta lands.
      await writeRollout(home, "2026-08-26", {
        ...options,
        turns: [...options.turns, { user: "second ask", assistant: "second answer" }],
      });
      const second = await discoverCodexSessions({ codexHome: home, nowMs: now });
      const grown = await importCodexSession(second.sessions[0], store);
      assert.equal(grown.sessionId, initial.sessionId);
      assert.equal(grown.created, false);
      assert.equal(grown.appended, 2);

      const rows = store.loadActiveMessages(initial.sessionId);
      assert.deepEqual(rows.map((row) => row.content), [
        rows[0].content,
        "first ask",
        "first answer",
        "second ask",
        "second answer",
      ]);
      const browsed = store.search({ limit: 20 });
      assert.equal(browsed.shape === "browse" ? browsed.sessions.length : -1, 1, "no duplicate session for the same thread id");
    });
  });
});

test("importCodexSession refuses to write when the stored transcript diverged", async (t) => {
  await withCodexHome(t, async (home) => {
    await withStore(t, async (store) => {
      const now = Date.UTC(2026, 7, 27, 12, 0, 0);
      await writeRollout(home, "2026-08-26", {
        threadId: "eeee5555-0000-0000-0000-000000000005",
        turns: [{ user: "ask", assistant: "answer" }],
        mtimeMs: now,
      });
      const { sessions } = await discoverCodexSessions({ codexHome: home, nowMs: now });
      const initial = await importCodexSession(sessions[0], store);

      // Something else rewrote history under us.
      store.appendMessage(initial.sessionId, "user", "not from the rollout");

      const rerun = await importCodexSession(sessions[0], store);
      assert.equal(rerun.diverged, true);
      assert.equal(rerun.appended, 0);
      assert.equal(store.loadActiveMessages(initial.sessionId).length, 4);
    });
  });
});

test("importCodexSession keeps separate sessions for two threads in one project", async (t) => {
  await withCodexHome(t, async (home) => {
    await withStore(t, async (store) => {
      const now = Date.UTC(2026, 7, 27, 12, 0, 0);
      await writeRollout(home, "2026-08-26", { threadId: "thread-one", cwd: "/Users/dhairya/Documents/muster", turns: [{ user: "one", assistant: "1" }], mtimeMs: now });
      await writeRollout(home, "2026-08-26", { threadId: "thread-two", cwd: "/Users/dhairya/Documents/muster", turns: [{ user: "two", assistant: "2" }], mtimeMs: now - 1000 });
      const { sessions } = await discoverCodexSessions({ codexHome: home, nowMs: now });

      const first = await importCodexSession(sessions[0], store);
      const second = await importCodexSession(sessions[1], store);

      assert.notEqual(first.sessionId, second.sessionId);
      assert.equal(first.created, true);
      assert.equal(second.created, true);
    });
  });
});

test("importCodexSession never mutates the rollout file", async (t) => {
  await withCodexHome(t, async (home) => {
    await withStore(t, async (store) => {
      const now = Date.UTC(2026, 7, 27, 12, 0, 0);
      const filePath = await writeRollout(home, "2026-08-26", {
        threadId: "ffff6666-0000-0000-0000-000000000006",
        turns: [{ user: "ask", assistant: "answer" }],
        mtimeMs: now,
      });
      const { readFile, stat } = await import("node:fs/promises");
      const before = await readFile(filePath, "utf8");
      const beforeStat = await stat(filePath);

      const { sessions } = await discoverCodexSessions({ codexHome: home, nowMs: now });
      await importCodexSession(sessions[0], store);

      assert.equal(await readFile(filePath, "utf8"), before);
      assert.equal((await stat(filePath)).mtimeMs, beforeStat.mtimeMs);
    });
  });
});

/* ---------- last activity: rollout truth over file mtime ---------- */

test("lastActivityAt comes from the rollout, not a re-touched file mtime", async (t) => {
  await withCodexHome(t, async (home) => {
    // The live bug: a day-old 45-turn thread listed as seconds old because
    // something other than Codex touched its rollout file.
    const now = Date.UTC(2026, 7, 27, 12, 0, 0);
    await writeRollout(home, "2026-08-26", {
      threadId: "aaaa1111-2222-3333-4444-555566667777",
      startedAt: "2026-08-26T10:00:00.000Z",
      turns: Array.from({ length: 3 }, (_unused, index) => ({ user: `ask ${index}`, assistant: `answer ${index}` })),
      mtimeMs: now - 1000,
    });

    const { sessions } = await discoverCodexSessions({ codexHome: home, nowMs: now });

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].lastActivitySource, "rollout");
    // Fixture turns are stamped 10:0N — a day before the freshened mtime.
    assert.ok(now - Date.parse(sessions[0].lastActivityAt) > 60 * 60 * 1000,
      `expected a day-old activity stamp, got ${sessions[0].lastActivityAt}`);
  });
});

test("a truncated head-window scan falls back to mtime and says so", async (t) => {
  await withCodexHome(t, async (home) => {
    const now = Date.UTC(2026, 7, 27, 12, 0, 0);
    const filePath = await writeRollout(home, "2026-08-26", {
      threadId: "bbbb1111-2222-3333-4444-555566667777",
      turns: Array.from({ length: 6 }, (_unused, index) => ({ user: `ask ${index}`, assistant: `answer ${index}` })),
      mtimeMs: now - 5000,
    });

    // A byte budget that clears session_meta but not the tail forces the
    // truncated path — exactly what a 1 GB rollout does in the wild.
    const { size } = await (await import("node:fs/promises")).stat(filePath);
    const { sessions } = await discoverCodexSessions({ codexHome: home, nowMs: now, maxBytes: Math.floor(size / 2) });

    assert.equal(sessions[0].lastActivitySource, "mtime");
    assert.equal(sessions[0].lastActivityAt, new Date(now - 5000).toISOString());
  });
});

/* ---------- prompt preview ---------- */

test("summarizeCodexPrompt strips manifest noise and returns the first human sentence", () => {
  const raw = [
    "---",
    "name: redis-automation",
    "plugins:",
    "  - id: shard_tool",
    "model: gpt-5.6-sol",
    "---",
    "",
    "Double the redis shards for the staging cluster. Then report the new topology.",
    "```yaml",
    "cluster: staging",
    "```",
  ].join("\n");

  assert.equal(summarizeCodexPrompt(raw), "Double the redis shards for the staging cluster.");
});

test("summarizeCodexPrompt collapses whitespace, drops tags, and clamps width", () => {
  assert.equal(summarizeCodexPrompt("  <ide_context></ide_context>\n\n  fix   the\n  auth bug  "), "fix the auth bug");
  assert.equal(summarizeCodexPrompt(""), "");
  // Nothing but a config paste: no human sentence exists, so show the paste
  // rather than pretending the thread had no prompt.
  assert.equal(summarizeCodexPrompt("---\nname: x\n"), "name: x");
  assert.equal(summarizeCodexPrompt("can you access [@chrome](plugin://chrome@openai-bundled)"), "can you access chrome");
  // A short leading fragment is not a "sentence" worth truncating to.
  assert.equal(summarizeCodexPrompt("hi. now do the real work"), "hi. now do the real work");
  assert.equal(summarizeCodexPrompt("x".repeat(50), 10), `${"x".repeat(9)}…`);
});

/* ---------- fork lineage ordering ---------- */

test("orderCodexSessionsByLineage nests forks under the thread they came from", () => {
  const summary = (threadId: string, forkedFromId?: string): CodexSessionSummary => ({
    threadId,
    cwd: "/repo",
    startedAt: "2026-08-26T10:00:00.000Z",
    ...(forkedFromId ? { forkedFromId } : {}),
    filePath: `/tmp/${threadId}.jsonl`,
    turnCount: 1,
    turnCountExact: true,
    messageCount: 2,
    firstUserMessage: "ask",
    lastActivityAt: "2026-08-26T10:05:00.000Z",
    lastActivitySource: "rollout",
    sizeBytes: 10,
  });
  const rows = orderCodexSessionsByLineage([
    summary("fork-b", "root-a"),
    summary("root-a"),
    summary("fork-of-fork", "fork-b"),
    summary("orphan", "not-listed"),
  ]);

  assert.deepEqual(rows.map((row) => [row.session.threadId, row.depth]), [
    ["root-a", 0],
    ["fork-b", 1],
    ["fork-of-fork", 2],
    ["orphan", 0],
  ]);
});

test("orderCodexSessionsByLineage survives a fork cycle without hanging or dropping rows", () => {
  const summary = (threadId: string, forkedFromId: string): CodexSessionSummary => ({
    threadId,
    forkedFromId,
    cwd: "/repo",
    startedAt: "2026-08-26T10:00:00.000Z",
    filePath: `/tmp/${threadId}.jsonl`,
    turnCount: 1,
    turnCountExact: true,
    messageCount: 2,
    firstUserMessage: "ask",
    lastActivityAt: "2026-08-26T10:05:00.000Z",
    lastActivitySource: "rollout",
    sizeBytes: 10,
  });
  const rows = orderCodexSessionsByLineage([summary("a", "b"), summary("b", "a")]);

  assert.equal(rows.length, 2);
  assert.deepEqual([...rows.map((row) => row.session.threadId)].sort(), ["a", "b"]);
});
