/**
 * Adversarial verification for the memory module: named-field validation on
 * every exported entry point, porter-stemmed recall, cross-tenant containment,
 * and in-place migration of a pre-porter (schema v1) derived index.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  addMemory,
  findMemory,
  formatMemoryScope,
  inspectMemoryStore,
  isVisibleInScopes,
  listMemory,
  memoryDbPath,
  memoryPath,
  parseMemoryScope,
  probeMemorySearchLatency,
  promoteMemory,
  rebuildMemoryIndex,
  searchMemory,
  searchMemoryWithReceipts,
} from "../src/memory.js";
import type { ContextObject } from "../src/types.js";

async function makeCwd(): Promise<string> {
  return mkdtemp(join(tmpdir(), "muster-memory-fuzz-"));
}

const SCOPES = [parseMemoryScope("user:dhairya")];

/* ---------- entry-point fuzz: zero raw TypeErrors, every failure names the field ---------- */

interface FuzzCase {
  readonly label: string;
  readonly run: (cwd: string) => Promise<unknown>;
  /** Every rejection message must contain this token (the field or entry point at fault). */
  readonly names: RegExp;
}

const FUZZ_CASES: readonly FuzzCase[] = [
  { label: "addMemory(undefined)", run: (cwd) => addMemory(undefined as never, cwd), names: /addMemory requires an input object/ },
  { label: "addMemory(null)", run: (cwd) => addMemory(null as never, cwd), names: /addMemory requires an input object/ },
  { label: "addMemory([])", run: (cwd) => addMemory([] as never, cwd), names: /addMemory requires an input object/ },
  { label: "addMemory(42)", run: (cwd) => addMemory(42 as never, cwd), names: /addMemory requires an input object/ },
  { label: "addMemory('fact')", run: (cwd) => addMemory("fact" as never, cwd), names: /addMemory requires an input object/ },
  { label: "addMemory({})", run: (cwd) => addMemory({} as never, cwd), names: /addMemory requires/ },
  { label: "addMemory summary wrong type", run: (cwd) => addMemory({ summary: 42, provenance: ["x"], scopes: SCOPES } as never, cwd), names: /summary/ },
  { label: "addMemory summary empty", run: (cwd) => addMemory({ summary: "   ", provenance: ["x"], scopes: SCOPES } as never, cwd), names: /summary/ },
  { label: "addMemory provenance string", run: (cwd) => addMemory({ summary: "s", provenance: "x", scopes: SCOPES } as never, cwd), names: /provenance/ },
  { label: "addMemory provenance [42]", run: (cwd) => addMemory({ summary: "s", provenance: [42], scopes: SCOPES } as never, cwd), names: /provenance/ },
  { label: "addMemory provenance []", run: (cwd) => addMemory({ summary: "s", provenance: [], scopes: SCOPES } as never, cwd), names: /provenance/ },
  { label: "addMemory scopes missing", run: (cwd) => addMemory({ summary: "s", provenance: ["x"] } as never, cwd), names: /scopes/ },
  { label: "addMemory scopes null", run: (cwd) => addMemory({ summary: "s", provenance: ["x"], scopes: null } as never, cwd), names: /scopes/ },
  { label: "addMemory scopes []", run: (cwd) => addMemory({ summary: "s", provenance: ["x"], scopes: [] } as never, cwd), names: /scopes/ },
  { label: "addMemory scopes [null]", run: (cwd) => addMemory({ summary: "s", provenance: ["x"], scopes: [null] } as never, cwd), names: /scope/ },
  { label: "addMemory scopes [{}]", run: (cwd) => addMemory({ summary: "s", provenance: ["x"], scopes: [{}] } as never, cwd), names: /scope/ },
  { label: "addMemory scope kind bogus", run: (cwd) => addMemory({ summary: "s", provenance: ["x"], scopes: [{ kind: "bogus", id: "x" }] } as never, cwd), names: /scope kind/ },
  { label: "addMemory scope id blank", run: (cwd) => addMemory({ summary: "s", provenance: ["x"], scopes: [{ kind: "user", id: "  " }] } as never, cwd), names: /id/ },
  { label: "addMemory confidence NaN", run: (cwd) => addMemory({ summary: "s", provenance: ["x"], scopes: SCOPES, confidence: NaN } as never, cwd), names: /confidence/ },
  { label: "addMemory confidence string", run: (cwd) => addMemory({ summary: "s", provenance: ["x"], scopes: SCOPES, confidence: "high" } as never, cwd), names: /confidence/ },
  { label: "addMemory confidence 2", run: (cwd) => addMemory({ summary: "s", provenance: ["x"], scopes: SCOPES, confidence: 2 } as never, cwd), names: /confidence/ },
  { label: "addMemory observedAt garbage", run: (cwd) => addMemory({ summary: "s", provenance: ["x"], scopes: SCOPES, observedAt: "yesterday" } as never, cwd), names: /observedAt/ },
  { label: "addMemory observedAt number", run: (cwd) => addMemory({ summary: "s", provenance: ["x"], scopes: SCOPES, observedAt: 42 } as never, cwd), names: /observedAt/ },
  { label: "addMemory links number", run: (cwd) => addMemory({ summary: "s", provenance: ["x"], scopes: SCOPES, links: 42 } as never, cwd), names: /links/ },
  { label: "addMemory links [42]", run: (cwd) => addMemory({ summary: "s", provenance: ["x"], scopes: SCOPES, links: [42] } as never, cwd), names: /links/ },
  { label: "addMemory redactionState bogus", run: (cwd) => addMemory({ summary: "s", provenance: ["x"], scopes: SCOPES, redactionState: "wat" } as never, cwd), names: /redactionState/ },
  { label: "addMemory kind number", run: (cwd) => addMemory({ summary: "s", provenance: ["x"], scopes: SCOPES, kind: 9 } as never, cwd), names: /kind/ },
  { label: "addMemory sourceUri number", run: (cwd) => addMemory({ summary: "s", provenance: ["x"], scopes: SCOPES, sourceUri: 9 } as never, cwd), names: /sourceUri/ },

  { label: "searchMemory(undefined)", run: (cwd) => searchMemory(undefined as never, cwd), names: /searchMemory requires an input object/ },
  { label: "searchMemory(null)", run: (cwd) => searchMemory(null as never, cwd), names: /searchMemory requires an input object/ },
  { label: "searchMemory('query')", run: (cwd) => searchMemory("query" as never, cwd), names: /searchMemory requires an input object/ },
  { label: "searchMemory({})", run: (cwd) => searchMemory({} as never, cwd), names: /scopes/ },
  { label: "searchMemory scopes []", run: (cwd) => searchMemory({ scopes: [] } as never, cwd), names: /scopes/ },
  { label: "searchMemory scopes string", run: (cwd) => searchMemory({ scopes: "user:x" } as never, cwd), names: /scopes/ },
  { label: "searchMemory query number", run: (cwd) => searchMemory({ scopes: SCOPES, query: 42 } as never, cwd), names: /query/ },
  { label: "searchMemory limit string", run: (cwd) => searchMemory({ scopes: SCOPES, limit: "5" } as never, cwd), names: /limit/ },
  { label: "searchMemory limit NaN", run: (cwd) => searchMemory({ scopes: SCOPES, limit: NaN } as never, cwd), names: /limit/ },
  { label: "searchMemory limit Infinity", run: (cwd) => searchMemory({ scopes: SCOPES, limit: Infinity } as never, cwd), names: /limit/ },
  { label: "searchMemory match bogus", run: (cwd) => searchMemory({ scopes: SCOPES, match: "fuzzy" } as never, cwd), names: /match/ },
  { label: "searchMemory includeGlobal string", run: (cwd) => searchMemory({ scopes: SCOPES, includeGlobal: "yes" } as never, cwd), names: /includeGlobal/ },

  { label: "searchMemoryWithReceipts(undefined)", run: (cwd) => searchMemoryWithReceipts(undefined as never, cwd), names: /searchMemoryWithReceipts requires an input object/ },
  { label: "searchMemoryWithReceipts scopes missing", run: (cwd) => searchMemoryWithReceipts({ query: "x" } as never, cwd), names: /scopes/ },
  { label: "searchMemoryWithReceipts candidateLimit string", run: (cwd) => searchMemoryWithReceipts({ scopes: SCOPES, candidateLimit: "9" } as never, cwd), names: /candidateLimit/ },
  { label: "searchMemoryWithReceipts minScore Infinity", run: (cwd) => searchMemoryWithReceipts({ scopes: SCOPES, minScore: Infinity } as never, cwd), names: /minScore/ },
  { label: "searchMemoryWithReceipts expandLinked number", run: (cwd) => searchMemoryWithReceipts({ scopes: SCOPES, expandLinked: 1 } as never, cwd), names: /expandLinked/ },
  { label: "searchMemoryWithReceipts graphNeighborLimit string", run: (cwd) => searchMemoryWithReceipts({ scopes: SCOPES, graphNeighborLimit: "x" } as never, cwd), names: /graphNeighborLimit/ },

  { label: "promoteMemory(undefined)", run: (cwd) => promoteMemory(undefined as never, cwd), names: /promoteMemory requires an input object/ },
  { label: "promoteMemory(null)", run: (cwd) => promoteMemory(null as never, cwd), names: /promoteMemory requires an input object/ },
  { label: "promoteMemory({})", run: (cwd) => promoteMemory({} as never, cwd), names: /id/ },
  { label: "promoteMemory id number", run: (cwd) => promoteMemory({ id: 42, targetScopes: SCOPES } as never, cwd), names: /id/ },
  { label: "promoteMemory id empty", run: (cwd) => promoteMemory({ id: "", targetScopes: SCOPES } as never, cwd), names: /id/ },
  { label: "promoteMemory targetScopes missing", run: (cwd) => promoteMemory({ id: "mem_x" } as never, cwd), names: /targetScopes/ },
  { label: "promoteMemory targetScopes []", run: (cwd) => promoteMemory({ id: "mem_x", targetScopes: [] } as never, cwd), names: /targetScopes/ },
  { label: "promoteMemory targetScopes string", run: (cwd) => promoteMemory({ id: "mem_x", targetScopes: "global" } as never, cwd), names: /targetScopes/ },
  { label: "promoteMemory allowGlobal string", run: (cwd) => promoteMemory({ id: "mem_x", targetScopes: SCOPES, allowGlobal: "yes" } as never, cwd), names: /allowGlobal/ },

  { label: "findMemory(undefined)", run: (cwd) => findMemory(undefined as never, cwd), names: /id/ },
  { label: "findMemory(null)", run: (cwd) => findMemory(null as never, cwd), names: /id/ },
  { label: "findMemory(42)", run: (cwd) => findMemory(42 as never, cwd), names: /id/ },
  { label: "findMemory('')", run: (cwd) => findMemory("", cwd), names: /id/ },
  { label: "findMemory({})", run: (cwd) => findMemory({} as never, cwd), names: /id/ },

  { label: "probeMemorySearchLatency(undefined)", run: (cwd) => probeMemorySearchLatency(undefined as never, cwd), names: /probeMemorySearchLatency requires an input object/ },
  { label: "probeMemorySearchLatency runs string", run: (cwd) => probeMemorySearchLatency({ scopes: SCOPES, runs: "5" } as never, cwd), names: /runs/ },
  { label: "probeMemorySearchLatency runs NaN", run: (cwd) => probeMemorySearchLatency({ scopes: SCOPES, runs: NaN } as never, cwd), names: /runs/ },
  { label: "probeMemorySearchLatency scopes [42]", run: (cwd) => probeMemorySearchLatency({ scopes: [42] } as never, cwd), names: /scope/ },
];

test("memory entry points reject malformed input with named errors, never raw TypeErrors", async () => {
  const cwd = await makeCwd();
  for (const fuzz of FUZZ_CASES) {
    await assert.rejects(
      fuzz.run(cwd),
      (error: unknown) => {
        assert.ok(error instanceof Error, `${fuzz.label}: rejected with a non-Error: ${String(error)}`);
        assert.ok(!(error instanceof TypeError), `${fuzz.label}: leaked a raw TypeError: ${error.message}`);
        assert.ok(
          !/Cannot read properties|is not a function|is not iterable|undefined is not/.test(error.message),
          `${fuzz.label}: message looks like an internal crash: ${error.message}`,
        );
        assert.match(error.message, fuzz.names, `${fuzz.label}: failure does not name the field: ${error.message}`);
        return true;
      },
      fuzz.label,
    );
  }
  // The fuzz barrage must not have persisted anything.
  assert.equal((await listMemory(cwd)).length, 0);
});

test("no-input entry points tolerate an empty store without throwing", async () => {
  const cwd = await makeCwd();
  assert.deepEqual(await listMemory(cwd), []);
  const rebuild = await rebuildMemoryIndex(cwd);
  assert.equal(rebuild.rebuilt, true);
  assert.equal(rebuild.removedExisting, false);
  const again = await rebuildMemoryIndex(cwd);
  assert.equal(again.removedExisting, true);
  assert.equal(await findMemory("mem_missing", cwd), undefined);
});

test("synchronous scope helpers reject malformed values with named errors", () => {
  for (const bad of [undefined, null, 42, "", "  ", "userdhairya", "user:", ":dhairya", "bogus:x"]) {
    assert.throws(
      () => parseMemoryScope(bad as never),
      (error: unknown) => error instanceof Error && !(error instanceof TypeError) && /scope|value/.test(error.message),
      `parseMemoryScope(${String(bad)})`,
    );
  }
  for (const bad of [undefined, null, 42, "user:x", {}, { kind: 1, id: 2 }]) {
    assert.throws(
      () => formatMemoryScope(bad as never),
      (error: unknown) => error instanceof Error && !(error instanceof TypeError) && /scope/.test(error.message),
      `formatMemoryScope(${String(bad)})`,
    );
  }
  assert.throws(() => isVisibleInScopes(null as never, SCOPES), /isVisibleInScopes/);
  assert.throws(() => isVisibleInScopes({ scopes: "nope" } as never, SCOPES), /object\.scopes/);
  assert.throws(() => isVisibleInScopes({ scopes: SCOPES } as ContextObject, [] as never), /allowedScopes/);
});

/* ---------- porter stemming ---------- */

test("porter stemming recalls 'deploys' and 'deploying' summaries from a 'deploy' query in scope", async () => {
  const cwd = await makeCwd();
  await addMemory({ summary: "The team deploys the gateway every Friday", provenance: ["manual:test"], scopes: SCOPES }, cwd);
  await addMemory({ summary: "Deploying requires a signed release ticket", provenance: ["manual:test"], scopes: SCOPES }, cwd);
  await addMemory({ summary: "Unrelated note about lunch menus", provenance: ["manual:test"], scopes: SCOPES }, cwd);

  const hits = await searchMemory({ scopes: SCOPES, query: "deploy", match: "any" }, cwd);
  assert.equal(hits.length, 2, `expected both deploy* memories, got: ${hits.map((hit) => hit.summary).join(" | ")}`);

  const receipts = await searchMemoryWithReceipts({ scopes: SCOPES, query: "deploy" }, cwd);
  assert.equal(receipts.backend, "sqlite-fts5");
  assert.ok(receipts.receipts.some((receipt) => /deploys the gateway/.test(receipt.memory.summary)));

  // Reverse direction: an inflected query still reaches the base form.
  const inflected = await searchMemory({ scopes: SCOPES, query: "deployed", match: "any" }, cwd);
  assert.ok(inflected.length >= 1, "inflected query found nothing");
});

/* ---------- cross-tenant containment ---------- */

test("cross-tenant queries stay blocked across every search surface", async () => {
  const cwd = await makeCwd();
  const secret = await addMemory(
    { summary: "tenant-a confidential pricing sheet", provenance: ["manual:test"], scopes: [parseMemoryScope("tenant:a")] },
    cwd,
  );
  await addMemory(
    { summary: "tenant-a pricing shared globally", provenance: ["manual:test"], scopes: [parseMemoryScope("global:global")] },
    cwd,
  );

  const otherTenant = [parseMemoryScope("tenant:b")];
  assert.equal((await searchMemory({ scopes: otherTenant, query: "pricing" }, cwd)).length, 0);
  assert.equal((await searchMemory({ scopes: otherTenant, query: "pricing", includeGlobal: false }, cwd)).length, 0);

  const withGlobal = await searchMemory({ scopes: otherTenant, query: "pricing", includeGlobal: true }, cwd);
  assert.equal(withGlobal.length, 1);
  assert.match(withGlobal[0]?.summary ?? "", /shared globally/);

  const receipts = await searchMemoryWithReceipts({ scopes: otherTenant, query: "confidential pricing" }, cwd);
  assert.equal(receipts.receipts.length, 0);

  // Graph lane cannot tunnel across tenants: a visible seed linking to a
  // foreign-tenant memory must not surface it.
  const bridge = await addMemory(
    { summary: "tenant-b pricing discussion notes", provenance: ["manual:test"], scopes: otherTenant, links: [secret.id] },
    cwd,
  );
  const expanded = await searchMemoryWithReceipts({ scopes: otherTenant, query: "pricing", expandLinked: true }, cwd);
  assert.ok(expanded.receipts.some((receipt) => receipt.memory.id === bridge.id));
  assert.ok(!expanded.receipts.some((receipt) => receipt.memory.id === secret.id), "linked expansion leaked a cross-tenant memory");

  // Latency probe reuses the same visibility path.
  const probe = await probeMemorySearchLatency({ scopes: otherTenant, query: "confidential", runs: 2 }, cwd);
  assert.equal(probe.recalledCount, 0);
});

/* ---------- pre-porter index migration ---------- */

async function writePrePorterIndex(cwd: string, objects: readonly ContextObject[]): Promise<void> {
  const jsonlPath = memoryPath(cwd);
  await mkdir(dirname(jsonlPath), { recursive: true });
  await writeFile(jsonlPath, objects.map((object) => JSON.stringify(object)).join("\n") + "\n", "utf8");
  const sourceStats = await stat(jsonlPath);

  // The exact derived schema that shipped before the porter tokenizer landed:
  // default fts5 tokenizer, no index_schema marker in memory_meta.
  const db = new DatabaseSync(memoryDbPath(cwd));
  db.exec(`
    CREATE TABLE memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE memory (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      source_uri TEXT,
      observed_at TEXT NOT NULL,
      confidence REAL NOT NULL,
      provenance_json TEXT NOT NULL,
      scopes_json TEXT NOT NULL,
      redaction_state TEXT NOT NULL,
      links_json TEXT NOT NULL,
      searchable_text TEXT NOT NULL
    );
    CREATE TABLE memory_scope (
      memory_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      PRIMARY KEY (memory_id, scope)
    );
    CREATE INDEX idx_memory_observed ON memory(observed_at DESC);
    CREATE INDEX idx_memory_scope_lookup ON memory_scope(scope, memory_id);
    CREATE VIRTUAL TABLE memory_fts USING fts5(searchable_text, content='memory', content_rowid='rowid');
    CREATE TRIGGER memory_ai AFTER INSERT ON memory BEGIN
      INSERT INTO memory_fts(rowid, searchable_text) VALUES (new.rowid, new.searchable_text);
    END;
    CREATE TRIGGER memory_ad AFTER DELETE ON memory BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, searchable_text) VALUES('delete', old.rowid, old.searchable_text);
    END;
    CREATE TRIGGER memory_au AFTER UPDATE ON memory BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, searchable_text) VALUES('delete', old.rowid, old.searchable_text);
      INSERT INTO memory_fts(rowid, searchable_text) VALUES (new.rowid, new.searchable_text);
    END;
  `);
  const insert = db.prepare(
    "INSERT INTO memory (id, kind, summary, source_uri, observed_at, confidence, provenance_json, scopes_json, redaction_state, links_json, searchable_text) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  );
  const insertScope = db.prepare("INSERT INTO memory_scope (memory_id, scope, kind, scope_id) VALUES (?,?,?,?)");
  for (const object of objects) {
    const searchable = [object.kind, object.summary, object.provenance.join(" "), object.scopes.map(formatMemoryScope).join(" ")]
      .join(" ")
      .toLowerCase();
    insert.run(
      object.id,
      object.kind,
      object.summary,
      object.sourceUri ?? null,
      object.observedAt,
      object.confidence,
      JSON.stringify(object.provenance),
      JSON.stringify(object.scopes),
      object.redactionState,
      JSON.stringify(object.links ?? []),
      searchable,
    );
    for (const scope of object.scopes) insertScope.run(object.id, formatMemoryScope(scope), scope.kind, scope.id);
  }
  // Mark the index fresh against the JSONL so only the schema (not staleness) can trigger work.
  db.prepare("INSERT INTO memory_meta (key, value) VALUES (?, ?)").run("source_size", String(sourceStats.size));
  db.prepare("INSERT INTO memory_meta (key, value) VALUES (?, ?)").run("source_mtime_ms", String(sourceStats.mtimeMs));
  db.close();
}

test("a hand-written pre-porter index is detected and re-derived in place, enabling stemmed search", async () => {
  const cwd = await makeCwd();
  const object: ContextObject = {
    id: "mem_legacy_1",
    kind: "note",
    summary: "The release crew deploys hotfixes on Fridays",
    observedAt: "2026-01-05T00:00:00.000Z",
    confidence: 0.8,
    provenance: ["manual:legacy"],
    scopes: [{ kind: "user", id: "dhairya" }],
    redactionState: "none",
    links: [],
  };
  await writePrePorterIndex(cwd, [object]);

  const before = await inspectMemoryStore(cwd);
  assert.equal(before.index.exists, true);
  assert.equal(before.index.readable, true);
  assert.notEqual(before.index.schema, "2:porter unicode61", "pre-porter index should not carry the current marker");
  const schemaCheck = before.checks.find((check) => check.label === "index_schema");
  assert.equal(schemaCheck?.status, "warning", "inspection must flag the stale schema");

  // The old tokenizer cannot stem: a direct MATCH against the untouched legacy
  // index misses. This proves the later hit comes from the migration.
  {
    const legacy = new DatabaseSync(memoryDbPath(cwd));
    const rows = legacy.prepare("SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?").all('"deploy"');
    legacy.close();
    assert.equal(rows.length, 0, "legacy default tokenizer unexpectedly stemmed");
  }

  // First open through the public API migrates in place.
  const hits = await searchMemory({ scopes: [parseMemoryScope("user:dhairya")], query: "deploy" }, cwd);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.id, "mem_legacy_1");

  const after = await inspectMemoryStore(cwd);
  assert.equal(after.index.schema, "2:porter unicode61");
  assert.equal(after.checks.find((check) => check.label === "index_schema")?.status, "passed");
  assert.equal(after.index.objectCount, 1, "migration must preserve indexed rows");
  assert.equal(after.jsonl.objectCount, 1);

  // Scope containment survives the migration.
  assert.equal((await searchMemory({ scopes: [parseMemoryScope("user:intruder")], query: "deploy" }, cwd)).length, 0);
});

/* ---------- LIKE fallback correctness (escapeLike) ---------- */

/**
 * Force the MATCH -> LIKE fallback on an FTS5-capable build: swap memory_fts
 * for a plain table of the same name (the schema marker stays valid, so the
 * open path keeps it), which makes every MATCH throw and exercises
 * runLikeSearch with a real query.
 */
async function forceLikeFallback(cwd: string): Promise<void> {
  const db = new DatabaseSync(memoryDbPath(cwd));
  db.exec(`
    DROP TRIGGER IF EXISTS memory_ai;
    DROP TRIGGER IF EXISTS memory_ad;
    DROP TRIGGER IF EXISTS memory_au;
    DROP TABLE IF EXISTS memory_fts;
    CREATE TABLE memory_fts (searchable_text TEXT);
  `);
  db.close();
}

test("LIKE fallback finds literal backslashes and does not mistranslate them into wildcards", async () => {
  const cwd = await makeCwd();
  const scopes = [parseMemoryScope("user:dhairya")];
  await addMemory({ summary: "profile lives at C:\\Users\\dhairya on the desktop", provenance: ["manual:test"], scopes }, cwd);
  await addMemory({ summary: "discount code takes 50% off all plans", provenance: ["manual:test"], scopes }, cwd);
  await forceLikeFallback(cwd);

  const backslash = await searchMemory({ scopes, query: "C:\\Users" }, cwd);
  assert.equal(backslash.length, 1, "literal-backslash query missed on the LIKE path");
  assert.match(backslash[0]?.summary ?? "", /desktop/);

  // A lone backslash must not decay into an escaped '%' that matches percent signs.
  const lone = await searchMemory({ scopes, query: "\\" }, cwd);
  assert.ok(!lone.some((hit) => /50% off/.test(hit.summary)), "backslash query wrongly matched a percent sign");

  // And LIKE wildcards stay literal.
  const percent = await searchMemory({ scopes, query: "50% off" }, cwd);
  assert.equal(percent.length, 1);
  const underscore = await searchMemory({ scopes, query: "_____" }, cwd);
  assert.equal(underscore.length, 0, "underscore treated as a wildcard on the LIKE path");
});
