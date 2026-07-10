import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import {
  clearSkillCatalogSnapshots,
  getSkillCatalogSnapshotMetrics,
  listSkills,
  writeBundledSkill,
} from "../src/skills.js";

async function createSyntheticSkills(cwd: string, count: number): Promise<void> {
  const root = join(cwd, "skills", "synthetic");
  for (let offset = 0; offset < count; offset += 50) {
    await Promise.all(Array.from({ length: Math.min(50, count - offset) }, async (_, index) => {
      const sequence = offset + index;
      const name = `skill-${String(sequence).padStart(4, "0")}`;
      const dir = join(root, name);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: Synthetic skill ${sequence}\n---\n\nUse synthetic workflow ${sequence}.\n`,
        "utf8",
      );
    }));
  }
}

function ioCounters(metrics: ReturnType<typeof getSkillCatalogSnapshotMetrics>): Record<string, number> {
  return {
    recursiveWalks: metrics.recursiveWalks,
    directoryReads: metrics.directoryReads,
    fileReads: metrics.fileReads,
    hashOperations: metrics.hashOperations,
    refreshes: metrics.refreshes,
  };
}

for (const fixture of [
  { count: 100, iterations: 100, maxWarmMs: 250 },
  { count: 1_000, iterations: 100, maxWarmMs: 500 },
] as const) {
  test(`warm skill discovery performs zero filesystem work with ${fixture.count} synthetic skills`, async (context) => {
    const cwd = await mkdtemp(join(tmpdir(), `muster-skills-cache-${fixture.count}-`));
    await writeBundledSkill({
      name: "indexed-skill",
      description: "Indexed digest verification fixture",
      body: "Verify this skill on a cold catalog load.",
    }, cwd);
    await createSyntheticSkills(cwd, fixture.count);
    clearSkillCatalogSnapshots();

    const coldStartedAt = performance.now();
    const cold = await listSkills(cwd);
    const coldElapsedMs = performance.now() - coldStartedAt;
    assert.equal(cold.length, fixture.count + 1);

    const beforeWarm = getSkillCatalogSnapshotMetrics(cwd);
    assert.equal(beforeWarm.refreshes, 1);
    assert.ok(beforeWarm.recursiveWalks > 0);
    assert.ok(beforeWarm.directoryReads > 0);
    assert.ok(beforeWarm.fileReads >= fixture.count + 1);
    assert.ok(beforeWarm.hashOperations >= 1, "the indexed skill must be digest verified on cold load");

    const warmStartedAt = performance.now();
    for (let iteration = 0; iteration < fixture.iterations; iteration += 1) {
      assert.equal((await listSkills(cwd)).length, fixture.count + 1);
    }
    const warmElapsedMs = performance.now() - warmStartedAt;
    const afterWarm = getSkillCatalogSnapshotMetrics(cwd);

    assert.deepEqual(ioCounters(afterWarm), ioCounters(beforeWarm), "warm turns must not walk, stat, read, hash, or refresh");
    assert.equal(afterWarm.cacheHits - beforeWarm.cacheHits, fixture.iterations);
    assert.ok(
      warmElapsedMs < fixture.maxWarmMs,
      `${fixture.iterations} warm discoveries took ${warmElapsedMs.toFixed(2)}ms (budget ${fixture.maxWarmMs}ms)`,
    );
    context.diagnostic(JSON.stringify({
      skills: fixture.count + 1,
      coldElapsedMs: Number(coldElapsedMs.toFixed(2)),
      warmCalls: fixture.iterations,
      warmElapsedMs: Number(warmElapsedMs.toFixed(2)),
      warmAverageMs: Number((warmElapsedMs / fixture.iterations).toFixed(4)),
    }));
  });
}

test("skill catalog discovery has no per-file stat validation pass", async () => {
  const source = await readFile(new URL("../src/skills.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bstat\b/, "a stat pass would restore catalog-size-dependent warm I/O");
});

test("expired skill snapshots refresh external mutations within the configured bound", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-skills-cache-ttl-"));
  const path = join(cwd, "skills", "live", "ttl-skill", "SKILL.md");
  const discovery = { snapshotTtlMs: 25 } as const;
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "---\nname: ttl-skill\ndescription: Before TTL\n---\n\nBefore.\n", "utf8");
  clearSkillCatalogSnapshots();

  assert.equal((await listSkills(cwd, ["active"], discovery))[0]?.description, "Before TTL");
  await writeFile(path, "---\nname: ttl-skill\ndescription: After TTL\n---\n\nAfter.\n", "utf8");
  await delay(40);

  assert.equal((await listSkills(cwd, ["active"], discovery))[0]?.description, "After TTL");
  assert.equal(getSkillCatalogSnapshotMetrics(cwd, discovery).refreshes, 2);
});

test("concurrent cold callers share one coherent catalog refresh", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-skills-cache-concurrent-"));
  await createSyntheticSkills(cwd, 100);
  clearSkillCatalogSnapshots();

  const results = await Promise.all(Array.from({ length: 32 }, () => listSkills(cwd)));
  assert.ok(results.every((skills) => skills.length === 100));
  const metrics = getSkillCatalogSnapshotMetrics(cwd);
  assert.equal(metrics.refreshes, 1);
  assert.equal(metrics.cacheHits, 0, "joined cold callers await the same refresh instead of pretending to be warm hits");
});

test("recursive discovery does not follow directory symlinks outside a configured root", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-skills-cache-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "muster-skills-outside-"));
  await mkdir(join(outside, "outside-skill"), { recursive: true });
  await writeFile(
    join(outside, "outside-skill", "SKILL.md"),
    "---\nname: outside-skill\ndescription: Must not cross a symlink boundary\n---\n\nOutside.\n",
    "utf8",
  );
  await mkdir(join(cwd, "skills"), { recursive: true });
  await symlink(outside, join(cwd, "skills", "linked-outside"), "dir");
  clearSkillCatalogSnapshots();

  assert.deepEqual(await listSkills(cwd), []);
});
