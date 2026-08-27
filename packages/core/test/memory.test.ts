import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { addMemory, findMemory, formatMemoryScope, inspectMemoryStore, isVisibleInScopes, memoryDbPath, memoryPath, parseMemoryScope, probeMemorySearchLatency, promoteMemory, rebuildMemoryIndex, recallMemory, searchMemory, searchMemoryWithReceipts } from "../src/index.js";

test("searchMemory only returns objects visible to every required scope", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-memory-"));
  await addMemory(
    {
      summary: "Dhairya prefers concise CTO-style architecture notes.",
      provenance: ["manual:test"],
      scopes: [parseMemoryScope("tenant:hybrow"), parseMemoryScope("user:dhairya")]
    },
    cwd
  );
  await addMemory(
    {
      summary: "Another user prefers verbose tutorials.",
      provenance: ["manual:test"],
      scopes: [parseMemoryScope("tenant:hybrow"), parseMemoryScope("user:someone-else")]
    },
    cwd
  );

  const dhairyaVisible = await searchMemory(
    { scopes: [parseMemoryScope("tenant:hybrow"), parseMemoryScope("user:dhairya")], query: "architecture" },
    cwd
  );
  const globalVisible = await searchMemory({ scopes: [parseMemoryScope("global:global")], query: "Dhairya" }, cwd);

  assert.equal(dhairyaVisible.length, 1);
  assert.match(dhairyaVisible[0]?.summary ?? "", /CTO-style/);
  assert.equal(globalVisible.length, 0);
});

test("searchMemory can include global memories without exposing private memories globally", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-memory-"));
  await addMemory(
    {
      summary: "Use evidence-aware answers by default.",
      provenance: ["manual:test"],
      scopes: [parseMemoryScope("global:global")]
    },
    cwd
  );
  await addMemory(
    {
      summary: "Session-only Redis debug context.",
      provenance: ["manual:test"],
      scopes: [parseMemoryScope("session:redis-debug")]
    },
    cwd
  );

  const scoped = await searchMemory({ scopes: [parseMemoryScope("session:redis-debug")], includeGlobal: true }, cwd);
  const globalOnly = await searchMemory({ scopes: [parseMemoryScope("global:global")] }, cwd);

  assert.equal(scoped.length, 2);
  assert.equal(globalOnly.length, 1);
  assert.match(globalOnly[0]?.summary ?? "", /evidence-aware/);
});

test("searchMemory builds and reuses a SQLite index from the JSONL memory log", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-memory-index-"));
  const legacy = {
    id: "mem_legacy",
    kind: "note",
    summary: "Legacy indexed memory contains the retrieval needle.",
    observedAt: "2026-06-22T10:00:00.000Z",
    confidence: 0.9,
    provenance: ["legacy:test"],
    scopes: [parseMemoryScope("tenant:hybrow"), parseMemoryScope("user:dhairya")],
    redactionState: "none" as const,
    links: [],
  };
  await mkdir(join(cwd, ".muster", "data"), { recursive: true });
  await appendFile(memoryPath(cwd), `${JSON.stringify(legacy)}\n`, "utf8");

  const first = await searchMemory({ scopes: [parseMemoryScope("tenant:hybrow"), parseMemoryScope("user:dhairya")], query: "retrieval needle" }, cwd);
  assert.deepEqual(first.map((object) => object.id), ["mem_legacy"]);
  assert.ok((await stat(memoryDbPath(cwd))).size > 0);

  const added = await addMemory({
    summary: "Fresh indexed memory contains another retrieval needle.",
    provenance: ["fresh:test"],
    scopes: [parseMemoryScope("tenant:hybrow"), parseMemoryScope("user:dhairya")],
  }, cwd);
  const second = await searchMemory({ scopes: [parseMemoryScope("tenant:hybrow"), parseMemoryScope("user:dhairya")], query: "retrieval needle" }, cwd);
  assert.deepEqual(second.map((object) => object.id).sort(), [added.id, "mem_legacy"].sort());
});

test("searchMemory hot path does not rescan stale JSONL after SQLite index is initialized", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-memory-no-jsonl-hotpath-"));
  const scopes = [parseMemoryScope("tenant:hybrow"), parseMemoryScope("user:dhairya")];
  const indexed = await addMemory({
    summary: "SQLite hot path should answer this recall without reading JSONL.",
    provenance: ["hotpath:test"],
    scopes,
  }, cwd);

  const first = await searchMemory({ scopes, query: "SQLite hot path" }, cwd);
  assert.deepEqual(first.map((object) => object.id), [indexed.id]);
  await appendFile(memoryPath(cwd), "{not valid jsonl and must not be read by search}\n", "utf8");

  const second = await searchMemory({ scopes, query: "SQLite hot path" }, cwd);
  const receipt = await searchMemoryWithReceipts({ scopes, query: "SQLite hot path", limit: 3 }, cwd);

  assert.deepEqual(second.map((object) => object.id), [indexed.id]);
  assert.equal(receipt.backend, "sqlite-fts5");
  assert.equal(receipt.receipts[0]?.memory.id, indexed.id);
});

test("addMemory updates SQLite without rescanning stale JSONL after index is initialized", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-memory-write-no-jsonl-rescan-"));
  const scopes = [parseMemoryScope("tenant:hybrow"), parseMemoryScope("user:dhairya")];
  await addMemory({
    summary: "Existing indexed memory keeps the DB initialized.",
    provenance: ["write-hotpath:test"],
    scopes,
  }, cwd);
  await searchMemory({ scopes, query: "Existing indexed memory" }, cwd);
  await appendFile(memoryPath(cwd), "{not valid jsonl and must not be read before upsert}\n", "utf8");

  const added = await addMemory({
    summary: "Fresh write still reaches SQLite after stale JSONL corruption.",
    provenance: ["write-hotpath:test"],
    scopes,
  }, cwd);
  const results = await searchMemory({ scopes, query: "Fresh write still reaches SQLite" }, cwd);

  assert.deepEqual(results.map((object) => object.id), [added.id]);
});

test("searchMemory applies SQL-level limits before returning memory summaries", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-memory-limit-"));
  const scopes = [parseMemoryScope("tenant:hybrow"), parseMemoryScope("user:dhairya")];
  for (let index = 0; index < 25; index += 1) {
    await addMemory({
      summary: `limited indexed recall candidate ${index}`,
      provenance: [`limit:${index}`],
      scopes,
    }, cwd);
  }

  const results = await searchMemory({ scopes, query: "limited indexed recall", limit: 7 }, cwd);
  assert.equal(results.length, 7);
});

test("malformed zero-scope legacy rows are not visible to scoped search", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-memory-empty-scope-"));
  const malformed = {
    id: "mem_malformed",
    kind: "note",
    summary: "This malformed zero scope memory must not leak.",
    observedAt: "2026-06-22T10:00:00.000Z",
    confidence: 0.9,
    provenance: ["legacy:test"],
    scopes: [],
    redactionState: "none" as const,
    links: [],
  };
  await mkdir(join(cwd, ".muster", "data"), { recursive: true });
  await appendFile(memoryPath(cwd), `${JSON.stringify(malformed)}\n`, "utf8");

  const results = await searchMemory({ scopes: [parseMemoryScope("user:dhairya")], query: "malformed zero scope" }, cwd);
  assert.equal(results.length, 0);
});

test("indexed memory retrieval stays scoped and accurate across larger stores", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-memory-scale-"));
  const expected: string[] = [];
  for (let index = 0; index < 500; index += 1) {
    const target = index % 97 === 0;
    const other = index % 13 === 0;
    const object = await addMemory({
      summary: target ? `retrieval benchmark target ${index} scoped answer` : `background note ${index} for plugins and sessions`,
      provenance: [`scale:${index}`],
      scopes: [parseMemoryScope("tenant:hybrow"), parseMemoryScope(other ? "user:someone-else" : "user:dhairya")],
    }, cwd);
    if (target && !other) expected.push(object.id);
  }

  const results = await searchMemory({ scopes: [parseMemoryScope("tenant:hybrow"), parseMemoryScope("user:dhairya")], query: "retrieval benchmark target" }, cwd);
  assert.deepEqual(results.map((object) => object.id).sort(), expected.sort());
  assert.ok(results.every((object) => object.scopes.map(formatMemoryScope).includes("user:dhairya")));
});

test("recallMemory uses indexed candidates without losing scoped prompt relevance", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-memory-recall-indexed-"));
  const scopes = [parseMemoryScope("tenant:hybrow"), parseMemoryScope("user:dhairya")];
  const expected = await addMemory({
    summary: "Production deploy target is uat-erp.example.com for Frappe testing.",
    provenance: ["recall:test"],
    scopes,
  }, cwd);
  for (let index = 0; index < 300; index += 1) {
    await addMemory({
      summary: `Background framework note ${index} about plugins and sessions.`,
      provenance: [`recall:${index}`],
      scopes,
    }, cwd);
  }

  const recalled = await recallMemory("where is the production deploy target for frappe?", scopes, 3, cwd);
  assert.equal(recalled[0]?.id, expected.id);
});

test("searchMemoryWithReceipts explains matched terms without filling query recall with recent unrelated memories", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-memory-receipts-"));
  const scopes = [parseMemoryScope("tenant:hybrow"), parseMemoryScope("user:dhairya")];
  const expected = await addMemory({
    summary: "The Frappe production endpoint is uat-erp.example.com.",
    provenance: ["receipt:test"],
    scopes,
  }, cwd);
  for (let index = 0; index < 80; index += 1) {
    await addMemory({
      summary: `Generic production note ${index} without relevant target wording.`,
      provenance: [`receipt:${index}`],
      scopes,
    }, cwd);
  }

  const result = await searchMemoryWithReceipts({
    query: "where is the frappe endpoint",
    scopes,
    limit: 3,
    candidateLimit: 10,
    match: "any",
  }, cwd);

  assert.equal(result.receipts[0]?.memory.id, expected.id);
  assert.equal(result.fallbackUsed, false);
  assert.match(result.receipts[0]?.reason ?? "", /matched/);
  assert.ok(result.receipts[0]?.matchedTerms.includes("frappe"));

  const unrelated = await searchMemoryWithReceipts({
    query: "Reply with exactly ok",
    scopes,
    limit: 3,
    candidateLimit: 10,
    match: "any",
  }, cwd);

  assert.equal(unrelated.receipts.length, 0);
  assert.equal(unrelated.fallbackUsed, false);
});

test("inspectMemoryStore reports source/index health without throwing on malformed JSONL", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-memory-inspect-"));
  await addMemory({
    summary: "Muster memory doctor should explain scoped index state.",
    provenance: ["memory-inspect:test"],
    scopes: [parseMemoryScope("tenant:f2"), parseMemoryScope("user:goblin")],
  }, cwd);

  const healthy = await inspectMemoryStore(cwd);
  assert.equal(healthy.jsonl.valid, true);
  assert.equal(healthy.jsonl.objectCount, 1);
  assert.equal(healthy.index.exists, true);
  assert.equal(healthy.index.readable, true);
  assert.equal(healthy.index.fresh, true);
  assert.ok(healthy.scopes.some((entry) => entry.scope === "tenant:f2" && entry.count === 1));
  assert.equal(healthy.checks.find((check) => check.label === "jsonl_valid")?.status, "passed");

  await appendFile(memoryPath(cwd), "{bad json\n", "utf8");
  const corrupt = await inspectMemoryStore(cwd);
  assert.equal(corrupt.jsonl.valid, false);
  assert.match(corrupt.jsonl.error ?? "", /Invalid JSONL/);
  assert.equal(corrupt.checks.find((check) => check.label === "jsonl_valid")?.status, "failed");
});

test("rebuildMemoryIndex repairs corrupt derived SQLite index without rewriting JSONL", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-memory-rebuild-"));
  const scopes = [parseMemoryScope("tenant:f2"), parseMemoryScope("user:goblin")];
  const memory = await addMemory({
    summary: "Corrupt derived index should rebuild from JSONL.",
    provenance: ["memory-rebuild:test"],
    scopes,
  }, cwd);
  await writeFile(memoryDbPath(cwd), "not sqlite", "utf8");

  const corrupt = await inspectMemoryStore(cwd);
  assert.equal(corrupt.index.exists, true);
  assert.equal(corrupt.index.readable, false);

  const rebuilt = await rebuildMemoryIndex(cwd);
  assert.equal(rebuilt.rebuilt, true);
  assert.equal(rebuilt.removedExisting, true);
  assert.equal(rebuilt.inspection.index.readable, true);
  assert.equal(rebuilt.inspection.index.fresh, true);
  const results = await searchMemory({ query: "derived index", scopes }, cwd);
  assert.deepEqual(results.map((object) => object.id), [memory.id]);
});

test("probeMemorySearchLatency reports p50 and p95 scoped retrieval timings", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-memory-probe-"));
  const scopes = [parseMemoryScope("tenant:f2"), parseMemoryScope("user:goblin")];
  await addMemory({
    summary: "Latency probe target should be recalled quickly.",
    provenance: ["memory-probe:test"],
    scopes,
  }, cwd);

  const probe = await probeMemorySearchLatency({ query: "latency probe target", scopes, runs: 5, limit: 3, match: "any" }, cwd);
  assert.equal(probe.runs, 5);
  assert.equal(probe.recalledCount, 1);
  assert.ok(probe.p50Ms >= 0);
  assert.ok(probe.p95Ms >= probe.p50Ms);
  assert.match(probe.backend, /sqlite-/);
});

test("searchMemoryWithReceipts expands linked graph memories without crossing scopes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-memory-graph-"));
  const scopes = [parseMemoryScope("tenant:f2"), parseMemoryScope("user:goblin")];
  const otherScopes = [parseMemoryScope("tenant:f2"), parseMemoryScope("user:alice")];
  const child = await addMemory({
    summary: "Child table field amount is Currency.",
    provenance: ["memory-graph:test"],
    scopes,
  }, cwd);
  const forbidden = await addMemory({
    summary: "Forbidden linked memory should not cross into goblin scope.",
    provenance: ["memory-graph:test"],
    scopes: otherScopes,
  }, cwd);
  await addMemory({
    summary: "Employee DocType stores structured details through child rows.",
    provenance: ["memory-graph:test"],
    scopes,
    links: [child.id, forbidden.id],
  }, cwd);

  const plain = await searchMemoryWithReceipts({ query: "employee structured details", scopes, limit: 5, match: "any" }, cwd);
  assert.ok(!plain.receipts.some((receipt) => receipt.memory.id === child.id));

  const expanded = await searchMemoryWithReceipts({ query: "employee structured details", scopes, limit: 5, match: "any", expandLinked: true }, cwd);
  assert.ok(expanded.receipts.some((receipt) => receipt.memory.id === child.id));
  assert.ok(!expanded.receipts.some((receipt) => receipt.memory.id === forbidden.id));
  assert.equal(expanded.linkedCandidateCount, 1);
});

test("promoteMemory refuses global promotion unless explicitly allowed", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-memory-"));
  const source = await addMemory(
    {
      summary: "Verified tenant runbook preference.",
      provenance: ["manual:test"],
      scopes: [parseMemoryScope("session:runbook")]
    },
    cwd
  );

  await assert.rejects(
    () => promoteMemory({ id: source.id, targetScopes: [parseMemoryScope("global:global")] }, cwd),
    /requires allowGlobal/
  );

  const promoted = await promoteMemory(
    { id: source.id, targetScopes: [parseMemoryScope("tenant:hybrow")], allowGlobal: false },
    cwd
  );

  assert.notEqual(promoted.id, source.id);
  assert.deepEqual(promoted.scopes.map(formatMemoryScope), ["tenant:hybrow"]);
  assert.ok(promoted.provenance.includes(`promoted-from:${source.id}`));
});

test("promoteMemory eagerly updates the SQLite index", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-memory-promote-index-"));
  const source = await addMemory({
    summary: "Session-only release note that should become tenant searchable.",
    provenance: ["manual:test"],
    scopes: [parseMemoryScope("session:release")]
  }, cwd);

  const promoted = await promoteMemory({ id: source.id, targetScopes: [parseMemoryScope("tenant:hybrow")] }, cwd);
  const results = await searchMemory({ scopes: [parseMemoryScope("tenant:hybrow")], query: "tenant searchable" }, cwd);

  assert.deepEqual(results.map((object) => object.id), [promoted.id]);
});

test("parseMemoryScope rejects malformed scopes", () => {
  assert.throws(() => parseMemoryScope("user"), /Invalid memory scope/);
  assert.throws(() => parseMemoryScope("unknown:1"), /Invalid memory scope/);
});

test("FTS recall stems query terms so singular queries match plural summaries", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-memory-stemming-"));
  const scopes = [parseMemoryScope("tenant:hybrow"), parseMemoryScope("user:dhairya")];
  const deploys = await addMemory({
    summary: "Tenant A deploys to erp-a.example.com",
    provenance: ["stemming:test"],
    scopes,
  }, cwd);
  const runs = await addMemory({
    summary: "Backup job runs nightly at 02:00 UTC.",
    provenance: ["stemming:test"],
    scopes,
  }, cwd);
  const deployment = await addMemory({
    summary: "Deployment window opens on Friday.",
    provenance: ["stemming:test"],
    scopes,
  }, cwd);

  assert.deepEqual((await searchMemory({ scopes, query: "deploy" }, cwd)).map((object) => object.id), [deploys.id]);
  assert.deepEqual((await searchMemory({ scopes, query: "deploys" }, cwd)).map((object) => object.id), [deploys.id]);
  // Porter folds -s/-ing to a shared stem, so "running", "runs", and "run" are one term.
  assert.deepEqual((await searchMemory({ scopes, query: "running" }, cwd)).map((object) => object.id), [runs.id]);
  assert.deepEqual((await searchMemory({ scopes, query: "run" }, cwd)).map((object) => object.id), [runs.id]);
  // Boundary: SQLite's porter tokenizer does not fold -ment, so "deploy" never reaches "deployment".
  assert.ok(!(await searchMemory({ scopes, query: "deploy" }, cwd)).some((object) => object.id === deployment.id));

  const receipts = await searchMemoryWithReceipts({ scopes, query: "where does tenant a deploy", limit: 3, match: "any" }, cwd);
  assert.equal(receipts.backend, "sqlite-fts5");
  assert.ok(receipts.receipts.some((receipt) => receipt.memory.id === deploys.id));
});

test("stemmed recall still blocks cross-scope leakage", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-memory-stemming-leak-"));
  const mine = [parseMemoryScope("tenant:hybrow"), parseMemoryScope("user:dhairya")];
  const theirs = [parseMemoryScope("tenant:hybrow"), parseMemoryScope("user:someone-else")];
  const own = await addMemory({ summary: "Tenant A deploys to erp-a.example.com", provenance: ["leak:test"], scopes: mine }, cwd);
  const forbidden = await addMemory({ summary: "Tenant B deploys to erp-b.example.com", provenance: ["leak:test"], scopes: theirs }, cwd);

  const rebuilt = await rebuildMemoryIndex(cwd);
  assert.equal(rebuilt.inspection.index.readable, true);

  const visible = await searchMemory({ scopes: mine, query: "deploy" }, cwd);
  assert.deepEqual(visible.map((object) => object.id), [own.id]);
  const globalView = await searchMemory({ scopes: [parseMemoryScope("global:global")], query: "deploy" }, cwd);
  assert.equal(globalView.length, 0);
  assert.equal(isVisibleInScopes(await findMemory(forbidden.id, cwd) ?? own, mine), false);
});

test("legacy default-tokenizer index auto-migrates to the stemming schema on open", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-memory-index-migration-"));
  const scopes = [parseMemoryScope("tenant:hybrow"), parseMemoryScope("user:dhairya")];
  const memory = await addMemory({
    summary: "Tenant A deploys to erp-a.example.com",
    provenance: ["migration:test"],
    scopes,
  }, cwd);
  downgradeMemoryIndexToDefaultTokenizer(cwd);

  // The pre-porter index really cannot answer the singular query.
  assert.equal(ftsMatchCount(cwd, "deploy"), 0);
  assert.equal(ftsMatchCount(cwd, "deploys"), 1);
  const stale = await inspectMemoryStore(cwd);
  assert.equal(stale.index.schema, undefined);
  assert.equal(stale.checks.find((check) => check.label === "index_schema")?.status, "warning");

  const migrated = await searchMemory({ scopes, query: "deploy" }, cwd);
  assert.deepEqual(migrated.map((object) => object.id), [memory.id]);

  const healthy = await inspectMemoryStore(cwd);
  assert.match(healthy.index.schema ?? "", /porter unicode61/);
  assert.equal(healthy.checks.find((check) => check.label === "index_schema")?.status, "passed");
  assert.equal(healthy.index.fresh, true);
  assert.equal(ftsMatchCount(cwd, "deploy"), 1);
});

test("memory entry points reject missing or wrong-typed input with named-field errors", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-memory-negative-input-"));
  const scopes = [parseMemoryScope("user:dhairya")];
  const seeded = await addMemory({ summary: "Seeded fact for negative input checks.", provenance: ["negative:test"], scopes }, cwd);

  await rejectsNamedField(() => addMemory({ summary: "No provenance", scopes } as never, cwd), /addMemory requires provenance: at least one non-empty source/);
  await rejectsNamedField(() => addMemory({ summary: "Blank provenance", provenance: ["  "], scopes } as never, cwd), /addMemory requires provenance/);
  await rejectsNamedField(() => addMemory({ provenance: ["p"], scopes } as never, cwd), /addMemory requires summary/);
  await rejectsNamedField(() => addMemory({ summary: "   ", provenance: ["p"], scopes } as never, cwd), /addMemory requires summary/);
  await rejectsNamedField(() => addMemory({ summary: "No scopes", provenance: ["p"] } as never, cwd), /addMemory requires scopes/);
  await rejectsNamedField(() => addMemory({ summary: "Bad scopes", provenance: ["p"], scopes: "user:dhairya" } as never, cwd), /addMemory requires scopes/);
  await rejectsNamedField(() => addMemory({ summary: "Null scope entry", provenance: ["p"], scopes: [null] } as never, cwd), /Invalid memory scope entry/);
  await rejectsNamedField(() => addMemory({ summary: "Bad provenance entry", provenance: [7], scopes } as never, cwd), /addMemory requires provenance: every entry must be a string/);
  await rejectsNamedField(() => addMemory({ summary: "Bad confidence", provenance: ["p"], scopes, confidence: "high" } as never, cwd), /addMemory requires confidence/);
  await rejectsNamedField(() => addMemory({ summary: "Bad confidence", provenance: ["p"], scopes, confidence: 4 } as never, cwd), /addMemory requires confidence/);
  await rejectsNamedField(() => addMemory({ summary: "Bad observedAt", provenance: ["p"], scopes, observedAt: "not-a-date" } as never, cwd), /addMemory requires observedAt/);
  await rejectsNamedField(() => addMemory({ summary: "Bad redaction", provenance: ["p"], scopes, redactionState: "secret" } as never, cwd), /addMemory requires redactionState/);
  await rejectsNamedField(() => addMemory(undefined as never, cwd), /addMemory requires an input object/);

  await rejectsNamedField(() => searchMemory({ query: "anything" } as never, cwd), /searchMemory requires scopes/);
  await rejectsNamedField(() => searchMemory({ scopes: [] } as never, cwd), /searchMemory requires scopes/);
  await rejectsNamedField(() => searchMemory({ scopes, query: 42 } as never, cwd), /searchMemory requires query/);
  await rejectsNamedField(() => searchMemory({ scopes, limit: "ten" } as never, cwd), /searchMemory requires limit/);
  await rejectsNamedField(() => searchMemory({ scopes, match: "fuzzy" } as never, cwd), /searchMemory requires match/);
  await rejectsNamedField(() => searchMemory(null as never, cwd), /searchMemory requires an input object/);

  await rejectsNamedField(() => searchMemoryWithReceipts({ query: "anything" } as never, cwd), /searchMemoryWithReceipts requires scopes/);
  await rejectsNamedField(() => searchMemoryWithReceipts({ scopes, candidateLimit: "many" } as never, cwd), /searchMemoryWithReceipts requires candidateLimit/);
  await rejectsNamedField(() => searchMemoryWithReceipts({ scopes, minScore: "high" } as never, cwd), /searchMemoryWithReceipts requires minScore/);
  await rejectsNamedField(() => searchMemoryWithReceipts({ scopes, expandLinked: "yes" } as never, cwd), /searchMemoryWithReceipts requires expandLinked/);

  await rejectsNamedField(() => promoteMemory({ targetScopes: scopes } as never, cwd), /promoteMemory requires id/);
  await rejectsNamedField(() => promoteMemory({ id: seeded.id } as never, cwd), /promoteMemory requires targetScopes/);
  await rejectsNamedField(() => promoteMemory({ id: seeded.id, targetScopes: [] } as never, cwd), /promoteMemory requires targetScopes/);
  await rejectsNamedField(() => promoteMemory({ id: seeded.id, targetScopes: scopes, allowGlobal: "yes" } as never, cwd), /promoteMemory requires allowGlobal/);
  await rejectsNamedField(() => promoteMemory(undefined as never, cwd), /promoteMemory requires an input object/);

  await rejectsNamedField(() => findMemory(undefined as never, cwd), /findMemory requires id/);
  await rejectsNamedField(() => probeMemorySearchLatency({ scopes, runs: "five" } as never, cwd), /probeMemorySearchLatency requires runs/);
  await rejectsNamedField(() => probeMemorySearchLatency({ query: "x" } as never, cwd), /probeMemorySearchLatency requires scopes/);

  throwsNamedField(() => parseMemoryScope(undefined as never), /parseMemoryScope requires value/);
  throwsNamedField(() => formatMemoryScope(undefined as never), /formatMemoryScope requires scope/);
  throwsNamedField(() => isVisibleInScopes(undefined as never, scopes), /isVisibleInScopes requires an input object/);
  throwsNamedField(() => isVisibleInScopes({ ...seeded, scopes: undefined } as never, scopes), /isVisibleInScopes requires object.scopes/);
  throwsNamedField(() => isVisibleInScopes(seeded, undefined as never), /isVisibleInScopes requires allowedScopes/);
});

test("isVisibleInScopes hides malformed zero-scope memories from direct reads", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-memory-zero-scope-visibility-"));
  const memory = await addMemory({ summary: "Scoped fact.", provenance: ["zero:test"], scopes: [parseMemoryScope("user:dhairya")] }, cwd);

  assert.equal(isVisibleInScopes(memory, [parseMemoryScope("user:dhairya")]), true);
  assert.equal(isVisibleInScopes({ ...memory, scopes: [] }, [parseMemoryScope("user:dhairya")]), false);
});

function downgradeMemoryIndexToDefaultTokenizer(cwd: string): void {
  const db = new DatabaseSync(memoryDbPath(cwd));
  try {
    db.exec(`
      DROP TRIGGER IF EXISTS memory_ai;
      DROP TRIGGER IF EXISTS memory_ad;
      DROP TRIGGER IF EXISTS memory_au;
      DROP TABLE IF EXISTS memory_fts;
      CREATE VIRTUAL TABLE memory_fts USING fts5(searchable_text, content='memory', content_rowid='rowid');
      INSERT INTO memory_fts(memory_fts) VALUES('rebuild');
      DELETE FROM memory_meta WHERE key = 'index_schema';
    `);
  } finally {
    db.close();
  }
}

function ftsMatchCount(cwd: string, term: string): number {
  const db = new DatabaseSync(memoryDbPath(cwd));
  try {
    const row = db.prepare("SELECT COUNT(*) AS count FROM memory_fts WHERE memory_fts MATCH ?").get(`"${term}"`) as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  } finally {
    db.close();
  }
}

async function rejectsNamedField(run: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assertNamedFieldError(error, pattern);
    return true;
  });
}

function throwsNamedField(run: () => unknown, pattern: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assertNamedFieldError(error, pattern);
    return true;
  });
}

function assertNamedFieldError(error: unknown, pattern: RegExp): void {
  assert.ok(error instanceof Error, `expected an Error, received ${String(error)}`);
  assert.ok(!(error instanceof TypeError), `expected a named-field Error, received TypeError: ${error.message}`);
  assert.match(error.message, pattern);
}
