import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { applyRosterActivationPlan, applyRosterMcpActivationPlan, buildRosterEntryFromPack, buildRosterIndexFromPacks, buildRosterProjectionCatalog, buildRosterSupportMatrix, createRosterLockEntry, installRosterCapability, loadRosterIndex, materializeRosterCapability, planRosterActivation, planRosterBuiltinProjection, planRosterLockProjection, planRosterMcpActivation, readRosterLock, rosterMcpConfigFromCatalogEntry, summarizeRosterIndex, summarizeRosterVerification, verifyRosterCapability, verifyRosterIndex, verifyRosterLock, verifyRosterLockedCapability } from "../src/index.js";

const execFileAsync = promisify(execFile);

async function writePack(root: string): Promise<{ dir: string; digest: string }> {
  const dir = join(root, "packs", "demo");
  await mkdir(join(dir, "src"), { recursive: true });
  await mkdir(join(dir, "evals"), { recursive: true });
  const entrypoint = "export const tools = { ping: async () => ({ ok: true }) };\n";
  const digest = `sha256:${createHash("sha256").update(entrypoint).digest("hex")}`;
  await writeFile(join(dir, "src", "index.js"), entrypoint, "utf8");
  await writeFile(join(dir, "evals", "ping.json"), "{\"cases\":[]}\n", "utf8");
  await writeFile(
    join(dir, "manifest.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      id: "demo-pack",
      name: "Demo Pack",
      version: "0.1.0",
      kind: "tool",
      entrypoint: "src/index.js",
      permissions: ["network"],
      sandbox: "network_limited",
      evals: ["evals/ping.json"],
      implementedTools: ["ping"],
      digest,
      readiness: {
        level: "verified",
        status: "beta",
        actionability: "local_tool",
        owner: "muster-core",
        surfaces: ["cli"],
        setup: { urls: ["https://example.test/demo"], requiredEnv: [], requiredAnyEnv: [], credentialStorage: "none" },
        diagnostics: { doctorCommand: "muster capability doctor demo-pack", smokeCommand: "muster capability test demo-pack", latencyBudgetMs: 250, requiresLiveCredentials: false },
        safety: { risk: "medium", permissionMode: "ask", mutationApproval: "never", resultCapBytes: 4096, secretRedaction: true },
        evidence: { unitTests: ["packages/core/test/roster.test.ts"], qaSuites: ["pack_readiness"], liveArtifacts: [], docs: ["README.md"] },
      },
    }, null, 2)}\n`,
    "utf8",
  );
  return { dir, digest };
}

test("verifyRosterCapability proves local pack depth before creating a lock entry", async () => {
  const root = join(tmpdir(), `muster-roster-ok-${Date.now()}`);
  const pack = await writePack(root);

  const verification = await verifyRosterCapability({
    schemaVersion: 1,
    id: "demo-pack",
    version: "0.1.0",
    kind: "tool",
    source: { type: "local", path: pack.dir },
    digest: pack.digest,
    compatibility: { muster: ">=0.1.0" },
    actionability: "local_tool",
    risk: "medium",
  }, { musterVersion: "0.1.9" });

  assert.equal(verification.status, "ready");
  assert.deepEqual(verification.gates.map((gate) => `${gate.id}:${gate.status}`), [
    "source:passed",
    "compatibility:passed",
    "manifest:passed",
    "digest:passed",
    "readiness:passed",
    "metadata:passed",
    "evals:passed",
    "diagnostics:passed",
  ]);

  const lock = createRosterLockEntry(verification);
  assert.equal(lock.id, "demo-pack");
  assert.equal(lock.version, "0.1.0");
  assert.equal(lock.digest, pack.digest);
  assert.equal(lock.source.type, "local");
  assert.equal(lock.readiness.level, "verified");
  assert.equal(lock.actionability, "local_tool");
});

test("verifyRosterCapability blocks registry drift before install or activation", async () => {
  const root = join(tmpdir(), `muster-roster-drift-${Date.now()}`);
  const pack = await writePack(root);

  const verification = await verifyRosterCapability({
    schemaVersion: 1,
    id: "demo-pack",
    version: "0.1.0",
    kind: "tool",
    source: { type: "local", path: pack.dir },
    digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    compatibility: { muster: ">=9.0.0" },
    actionability: "local_tool",
    risk: "medium",
  }, { musterVersion: "0.1.9" });

  assert.equal(verification.status, "blocked");
  assert.equal(verification.gates.find((gate) => gate.id === "compatibility")?.status, "blocked");
  assert.equal(verification.gates.find((gate) => gate.id === "digest")?.status, "blocked");
  assert.throws(() => createRosterLockEntry(verification), /blocked/);
});

test("verifyRosterCapability blocks stale index metadata before lock creation", async () => {
  const root = join(tmpdir(), `muster-roster-metadata-drift-${Date.now()}`);
  const pack = await writePack(root);
  const draft = await buildRosterEntryFromPack(pack.dir, {
    source: { type: "local", path: pack.dir },
    musterCompatibility: ">=0.1.0",
    musterVersion: "0.1.9",
  });

  const verification = await verifyRosterCapability({
    ...draft.entry,
    metadata: draft.entry.metadata && {
      ...draft.entry.metadata,
      diagnostics: {
        ...draft.entry.metadata.diagnostics,
        latencyBudgetMs: 9999,
      },
    },
  }, { musterVersion: "0.1.9" });

  assert.equal(verification.status, "blocked");
  assert.equal(verification.gates.find((gate) => gate.id === "metadata")?.status, "blocked");
  assert.match(verification.gates.find((gate) => gate.id === "metadata")?.summary ?? "", /does not match/);
  assert.throws(() => createRosterLockEntry(verification), /metadata:/);
});

test("verifyRosterCapability can require index metadata for registry publication", async () => {
  const root = join(tmpdir(), `muster-roster-require-metadata-${Date.now()}`);
  const pack = await writePack(root);
  const entry = {
    schemaVersion: 1 as const,
    id: "demo-pack",
    version: "0.1.0",
    kind: "tool" as const,
    source: { type: "local" as const, path: pack.dir },
    digest: pack.digest,
    compatibility: { muster: ">=0.1.0" },
    actionability: "local_tool" as const,
    risk: "medium" as const,
  };

  const legacy = await verifyRosterCapability(entry, { musterVersion: "0.1.9" });
  const strict = await verifyRosterCapability(entry, { musterVersion: "0.1.9", requireMetadata: true });

  assert.equal(legacy.status, "ready");
  assert.equal(legacy.gates.find((gate) => gate.id === "metadata")?.status, "passed");
  assert.equal(strict.status, "blocked");
  assert.equal(strict.gates.find((gate) => gate.id === "metadata")?.status, "blocked");
  assert.match(strict.gates.find((gate) => gate.id === "metadata")?.summary ?? "", /required/);
});

test("verifyRosterCapability can enforce a minimum readiness level", async () => {
  const root = join(tmpdir(), `muster-roster-min-readiness-${Date.now()}`);
  const pack = await writePack(root);
  const draft = await buildRosterEntryFromPack(pack.dir, {
    source: { type: "local", path: pack.dir },
    musterCompatibility: ">=0.1.0",
    musterVersion: "0.1.9",
  });

  const verifiedMinimum = await verifyRosterCapability(draft.entry, { musterVersion: "0.1.9", minReadinessLevel: "verified" });
  const releaseMinimum = await verifyRosterCapability(draft.entry, { musterVersion: "0.1.9", minReadinessLevel: "release_ready" });
  const releaseReport = await verifyRosterIndex({ schemaVersion: 1, entries: [draft.entry] }, { musterVersion: "0.1.9", minReadinessLevel: "release_ready" });
  const releaseSummary = summarizeRosterVerification(releaseReport);

  assert.equal(verifiedMinimum.status, "ready");
  assert.equal(verifiedMinimum.gates.find((gate) => gate.id === "readiness")?.status, "passed");
  assert.equal(releaseMinimum.status, "blocked");
  assert.equal(releaseMinimum.gates.find((gate) => gate.id === "readiness")?.status, "blocked");
  assert.match(releaseMinimum.gates.find((gate) => gate.id === "readiness")?.summary ?? "", /does not satisfy required minimum release_ready/);
  assert.equal(releaseSummary.repairs.some((repair) => repair.gate === "readiness" && repair.command === `muster qa run pack_readiness --evidence ${pack.dir}`), true);
  assert.equal(releaseSummary.repairs.some((repair) => repair.gate === "readiness" && repair.command === `muster roster index ${pack.dir} --dry-run`), true);
  assert.equal(releaseSummary.repairs.some((repair) => repair.gate === "readiness" && /add readiness metadata/.test(repair.command)), false);
});

test("installRosterCapability verifies an index entry and preserves a deterministic lockfile", async () => {
  const root = join(tmpdir(), `muster-roster-install-${Date.now()}`);
  const pack = await writePack(root);
  const indexPath = join(root, "roster.index.json");
  const lockPath = join(root, "roster.lock.json");
  await writeFile(lockPath, `${JSON.stringify({
    schemaVersion: 1,
    generatedBy: "muster-roster",
    entries: {
      existing: {
        id: "existing",
        version: "0.0.1",
        kind: "tool",
        source: { type: "local", path: "/tmp/existing" },
        digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        actionability: "metadata",
        risk: "low",
        readiness: {
          level: "listed",
          status: "stable",
          actionability: "metadata",
          owner: "muster-core",
          surfaces: ["cli"],
          setup: { urls: ["https://example.test/existing"], requiredEnv: [], requiredAnyEnv: [], credentialStorage: "none" },
          diagnostics: { requiresLiveCredentials: false },
          safety: { risk: "low", permissionMode: "deny_by_default", mutationApproval: "never", resultCapBytes: 1, secretRedaction: true },
          evidence: { unitTests: ["existing.test.ts"], qaSuites: ["pack_readiness"], liveArtifacts: [], docs: ["README.md"] },
        },
        compatibility: { muster: ">=0.1.0" },
        lockedAt: "2026-01-01T00:00:00.000Z",
      },
    },
  }, null, 2)}\n`, "utf8");
  await writeFile(indexPath, `${JSON.stringify({
    schemaVersion: 1,
    generatedAt: "2026-07-05T00:00:00.000Z",
    entries: [{
      schemaVersion: 1,
      id: "demo-pack",
      version: "0.1.0",
      kind: "tool",
      source: { type: "local", path: pack.dir },
      digest: pack.digest,
      compatibility: { muster: ">=0.1.0" },
      actionability: "local_tool",
      risk: "medium",
    }],
  }, null, 2)}\n`, "utf8");

  const index = await loadRosterIndex(indexPath);
  const result = await installRosterCapability(index, "demo-pack", {
    lockPath,
    musterVersion: "0.1.9",
    lockedAt: "2026-07-05T12:00:00.000Z",
  });

  assert.equal(result.verification.status, "ready");
  assert.equal(result.lock.entries["demo-pack"].digest, pack.digest);
  assert.equal(result.lock.entries.existing.version, "0.0.1");
  const persisted = await readRosterLock(lockPath);
  assert.deepEqual(Object.keys(persisted.entries), ["demo-pack", "existing"]);
  assert.match(await readFile(lockPath, "utf8"), /"generatedBy": "muster-roster"/);
});

test("planRosterActivation turns a locked local capability into a plugin policy patch", async () => {
  const root = join(tmpdir(), `muster-roster-activate-${Date.now()}`);
  const pack = await writePack(root);
  const verification = await verifyRosterCapability({
    schemaVersion: 1,
    id: "demo-pack",
    version: "0.1.0",
    kind: "tool",
    source: { type: "local", path: pack.dir },
    digest: pack.digest,
    compatibility: { muster: ">=0.1.0" },
    actionability: "local_tool",
    risk: "medium",
  }, { musterVersion: "0.1.9" });
  const lockEntry = createRosterLockEntry(verification, "2026-07-05T12:00:00.000Z");

  const plan = planRosterActivation({
    schemaVersion: 1,
    generatedBy: "muster-roster",
    entries: { "demo-pack": lockEntry },
  }, "demo-pack");
  const policy = applyRosterActivationPlan({
    allow: ["existing"],
    load: { paths: ["/tmp/existing"] },
    entries: { existing: { enabled: true } },
  }, plan);

  assert.equal(plan.status, "ready");
  assert.deepEqual(policy.allow, ["existing", "demo-pack"]);
  assert.deepEqual(policy.load?.paths, ["/tmp/existing", pack.dir]);
  assert.equal(policy.entries?.["demo-pack"]?.enabled, true);
  assert.equal(policy.entries?.existing?.enabled, true);
});

test("verifyRosterLockedCapability rechecks a lock before activation", async () => {
  const root = join(tmpdir(), `muster-roster-activate-verify-${Date.now()}`);
  const pack = await writePack(root);
  const verification = await verifyRosterCapability({
    schemaVersion: 1,
    id: "demo-pack",
    version: "0.1.0",
    kind: "tool",
    source: { type: "local", path: pack.dir },
    digest: pack.digest,
    compatibility: { muster: ">=0.1.0" },
    actionability: "local_tool",
    risk: "medium",
  }, { musterVersion: "0.1.9" });
  const lock = {
    schemaVersion: 1 as const,
    generatedBy: "muster-roster" as const,
    entries: { "demo-pack": createRosterLockEntry(verification, "2026-07-05T12:00:00.000Z") },
  };

  const before = await verifyRosterLockedCapability(lock, "demo-pack", { musterVersion: "0.1.9" });
  assert.equal(before.status, "ready");
  assert.equal(before.gates.find((gate) => gate.id === "lock")?.status, "passed");

  const manifestPath = join(pack.dir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  await writeFile(manifestPath, `${JSON.stringify({ ...manifest, digest: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" }, null, 2)}\n`, "utf8");

  const after = await verifyRosterLockedCapability(lock, "demo-pack", { musterVersion: "0.1.9" });
  assert.equal(after.status, "blocked");
  assert.equal(after.gates.find((gate) => gate.id === "digest")?.status, "blocked");
});

test("verifyRosterLockedCapability blocks lock readiness drift even when digest still matches", async () => {
  const root = join(tmpdir(), `muster-roster-lock-drift-${Date.now()}`);
  const pack = await writePack(root);
  const verification = await verifyRosterCapability({
    schemaVersion: 1,
    id: "demo-pack",
    version: "0.1.0",
    kind: "tool",
    source: { type: "local", path: pack.dir },
    digest: pack.digest,
    compatibility: { muster: ">=0.1.0" },
    actionability: "local_tool",
    risk: "medium",
  }, { musterVersion: "0.1.9" });
  const lock = {
    schemaVersion: 1 as const,
    generatedBy: "muster-roster" as const,
    entries: { "demo-pack": createRosterLockEntry(verification, "2026-07-05T12:00:00.000Z") },
  };
  const manifestPath = join(pack.dir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    readiness: { safety: Record<string, unknown>; [key: string]: unknown };
    [key: string]: unknown;
  };
  await writeFile(manifestPath, `${JSON.stringify({
    ...manifest,
    readiness: {
      ...manifest.readiness,
      safety: { ...manifest.readiness.safety, risk: "high" },
    },
  }, null, 2)}\n`, "utf8");

  const drift = await verifyRosterLockedCapability(lock, "demo-pack", { musterVersion: "0.1.9" });
  assert.equal(drift.status, "blocked");
  assert.equal(drift.gates.find((gate) => gate.id === "digest")?.status, "passed");
  assert.equal(drift.gates.find((gate) => gate.id === "lock")?.status, "blocked");
  assert.match(drift.gates.find((gate) => gate.id === "lock")?.summary ?? "", /readiness/);
});

test("verifyRosterLock audits every locked entry with lock-specific gates", async () => {
  const root = join(tmpdir(), `muster-roster-lock-audit-${Date.now()}`);
  const pack = await writePack(root);
  const verification = await verifyRosterCapability({
    schemaVersion: 1,
    id: "demo-pack",
    version: "0.1.0",
    kind: "tool",
    source: { type: "local", path: pack.dir },
    digest: pack.digest,
    compatibility: { muster: ">=0.1.0" },
    actionability: "local_tool",
    risk: "medium",
  }, { musterVersion: "0.1.9" });
  const lock = {
    schemaVersion: 1 as const,
    generatedBy: "muster-roster" as const,
    entries: { "demo-pack": createRosterLockEntry(verification, "2026-07-05T12:00:00.000Z") },
  };

  const report = await verifyRosterLock(lock, { musterVersion: "0.1.9" });
  assert.equal(report.status, "ready");
  assert.equal(report.readyCount, 1);
  assert.equal(report.results[0]?.gates.some((gate) => gate.id === "lock" && gate.status === "passed"), true);

  const manifestPath = join(pack.dir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    readiness: { safety: Record<string, unknown>; [key: string]: unknown };
    [key: string]: unknown;
  };
  await writeFile(manifestPath, `${JSON.stringify({
    ...manifest,
    readiness: {
      ...manifest.readiness,
      safety: { ...manifest.readiness.safety, risk: "high" },
    },
  }, null, 2)}\n`, "utf8");

  const drift = await verifyRosterLock(lock, { musterVersion: "0.1.9" });
  const summary = summarizeRosterVerification(drift);
  assert.equal(drift.status, "blocked");
  assert.deepEqual(summary.gateTotals.lock, { passed: 0, blocked: 1 });
  assert.deepEqual(summary.blockedEntries, ["demo-pack@0.1.0"]);
  assert.equal(summary.repairs.some((repair) => repair.gate === "lock" && /muster roster activate demo-pack --dry-run/.test(repair.command)), true);
});

test("planRosterActivation blocks unresolved remote lock entries", () => {
  const lock = {
    schemaVersion: 1 as const,
    generatedBy: "muster-roster" as const,
    entries: {
      "remote-pack": {
        id: "remote-pack",
        version: "0.1.0",
        kind: "tool" as const,
        source: { type: "git" as const, url: "https://example.test/repo.git", ref: "main" },
        digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        actionability: "local_tool" as const,
        risk: "medium" as const,
        readiness: {
          level: "verified" as const,
          status: "beta" as const,
          actionability: "local_tool" as const,
          owner: "muster-core",
          surfaces: ["cli" as const],
          setup: { urls: ["https://example.test/remote"], requiredEnv: [], requiredAnyEnv: [], credentialStorage: "none" as const },
          diagnostics: { doctorCommand: "muster capability doctor remote-pack", smokeCommand: "muster capability test remote-pack", requiresLiveCredentials: false },
          safety: { risk: "medium" as const, permissionMode: "ask" as const, mutationApproval: "never" as const, resultCapBytes: 4096, secretRedaction: true as const },
          evidence: { unitTests: ["packages/core/test/roster.test.ts"], qaSuites: ["pack_readiness"], liveArtifacts: [], docs: ["README.md"] },
        },
        compatibility: { muster: ">=0.1.0" },
        lockedAt: "2026-07-05T12:00:00.000Z",
      },
    },
  };

  const plan = planRosterActivation(lock, "remote-pack");

  assert.equal(plan.status, "blocked");
  assert.match(plan.blockers.join("\n"), /materialized to a local path/);
  assert.throws(() => applyRosterActivationPlan(undefined, plan), /blocked roster capability/);
});

test("materializeRosterCapability clones a pinned git source, verifies it, and updates the lock for activation", async () => {
  const root = join(tmpdir(), `muster-roster-materialize-${Date.now()}`);
  const repo = join(root, "repo");
  const cacheDir = join(root, "cache");
  const lockPath = join(root, "roster.lock.json");
  const pack = await writePack(repo);
  await execFileAsync("git", ["init"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "muster@example.test"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "Muster Test"], { cwd: repo });
  await execFileAsync("git", ["add", "."], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", "seed demo pack"], { cwd: repo });
  const { stdout: commit } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo });
  const ref = commit.trim();

  const result = await materializeRosterCapability({
    schemaVersion: 1,
    entries: [{
      schemaVersion: 1,
      id: "demo-pack",
      version: "0.1.0",
      kind: "tool",
      source: { type: "git", url: repo, ref, path: "packs/demo" },
      digest: pack.digest,
      compatibility: { muster: ">=0.1.0" },
      actionability: "local_tool",
      risk: "medium",
    }],
  }, "demo-pack", {
    cacheDir,
    lockPath,
    musterVersion: "0.1.9",
    lockedAt: "2026-07-05T12:00:00.000Z",
  });

  assert.equal(result.verification.status, "ready");
  assert.equal(result.lockEntry.source.type, "git");
  assert.equal(result.lockEntry.resolvedPath, result.materializedPath);
  assert.match(result.materializedPath, /demo-pack\/0\.1\.0/);
  assert.equal(result.lock.entries["demo-pack"].digest, pack.digest);

  const activation = planRosterActivation(result.lock, "demo-pack");
  assert.equal(activation.status, "ready");
  assert.deepEqual(activation.pluginPolicy.load?.paths, [result.materializedPath]);
});

test("materializeRosterCapability refuses symbolic git refs before cloning", async () => {
  const root = join(tmpdir(), `muster-roster-materialize-ref-${Date.now()}`);
  const lockPath = join(root, "roster.lock.json");

  await assert.rejects(
    materializeRosterCapability({
      schemaVersion: 1,
      entries: [{
        schemaVersion: 1,
        id: "demo-pack",
        version: "0.1.0",
        kind: "tool",
        source: { type: "git", url: "https://example.test/repo.git", ref: "main", path: "packs/demo" },
        digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        compatibility: { muster: ">=0.1.0" },
        actionability: "local_tool",
        risk: "medium",
      }],
    }, "demo-pack", {
      cacheDir: join(root, "cache"),
      lockPath,
      musterVersion: "0.1.9",
    }),
    /pinned 40-character git commit/,
  );
});

test("buildRosterEntryFromPack derives publish metadata from a verified pack", async () => {
  const root = join(tmpdir(), `muster-roster-publish-${Date.now()}`);
  const pack = await writePack(root);

  const result = await buildRosterEntryFromPack(pack.dir, {
    source: { type: "local", path: pack.dir },
    musterCompatibility: ">=0.1.0",
    musterVersion: "0.1.9",
  });

  assert.equal(result.verification.status, "ready");
  const { metadata, ...entry } = result.entry;
  assert.deepEqual(entry, {
    schemaVersion: 1,
    id: "demo-pack",
    version: "0.1.0",
    kind: "tool",
    source: { type: "local", path: pack.dir },
    digest: pack.digest,
    compatibility: { muster: ">=0.1.0" },
    actionability: "local_tool",
    risk: "medium",
  });
  assert.equal(metadata?.readiness.level, "verified");
  assert.equal(metadata?.setup.credentialStorage, "none");
  assert.equal(metadata?.diagnostics.latencyBudgetMs, 250);
  assert.deepEqual(metadata?.evals, ["evals/ping.json"]);
  assert.deepEqual(metadata?.implementedTools, ["ping"]);
});

test("buildRosterIndexFromPacks creates a sorted verified local registry", async () => {
  const root = join(tmpdir(), `muster-roster-index-build-${Date.now()}`);
  const pack = await writePack(root);

  const index = await buildRosterIndexFromPacks([pack.dir], {
    musterCompatibility: ">=0.1.0",
    musterVersion: "0.1.9",
    generatedAt: "2026-07-05T00:00:00.000Z",
  });

  assert.equal(index.schemaVersion, 1);
  assert.equal(index.generatedAt, "2026-07-05T00:00:00.000Z");
  assert.deepEqual(index.entries.map((entry) => `${entry.id}@${entry.version}:${entry.source.type}`), [
    "demo-pack@0.1.0:local",
  ]);
  assert.equal(index.entries[0]?.source.type, "local");
  assert.equal(index.entries[0]?.metadata?.readiness.status, "beta");
  assert.equal(index.entries[0]?.metadata?.safety.permissionMode, "ask");
  assert.deepEqual(index.entries[0]?.metadata?.evidence.qaSuites, ["pack_readiness"]);
  assert.deepEqual(summarizeRosterIndex(index), {
    total: 1,
    withMetadata: 1,
    missingMetadata: 0,
    requiresLiveCredentials: 0,
    withDiagnostics: 1,
    withEvalFixtures: 1,
    implementedTools: ["ping"],
    byKind: { tool: 1 },
    byActionability: { local_tool: 1 },
    byRisk: { medium: 1 },
    byReadinessLevel: { verified: 1 },
    byReadinessStatus: { beta: 1 },
    bySurface: { cli: 1 },
    byCredentialStorage: { none: 1 },
  });
});

test("verifyRosterIndex reports aggregate readiness across every entry", async () => {
  const root = join(tmpdir(), `muster-roster-index-${Date.now()}`);
  const pack = await writePack(root);
  const index = {
    schemaVersion: 1 as const,
    entries: [
      {
        schemaVersion: 1 as const,
        id: "demo-pack",
        version: "0.1.0",
        kind: "tool" as const,
        source: { type: "local" as const, path: pack.dir },
        digest: pack.digest,
        compatibility: { muster: ">=0.1.0" },
        actionability: "local_tool" as const,
        risk: "medium" as const,
      },
      {
        schemaVersion: 1 as const,
        id: "demo-pack",
        version: "0.2.0",
        kind: "tool" as const,
        source: { type: "local" as const, path: pack.dir },
        digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        compatibility: { muster: ">=9.0.0" },
        actionability: "local_tool" as const,
        risk: "medium" as const,
      },
    ],
  };

  const report = await verifyRosterIndex(index, { musterVersion: "0.1.9" });

  assert.equal(report.status, "blocked");
  assert.equal(report.readyCount, 1);
  assert.equal(report.blockedCount, 1);
  assert.equal(report.results[0].status, "ready");
  assert.equal(report.results[1].status, "blocked");
  assert.deepEqual(summarizeRosterVerification(report), {
    total: 2,
    ready: 1,
    blocked: 1,
    gateTotals: {
      compatibility: { passed: 1, blocked: 1 },
      diagnostics: { passed: 2, blocked: 0 },
      digest: { passed: 1, blocked: 1 },
      evals: { passed: 2, blocked: 0 },
      manifest: { passed: 2, blocked: 0 },
      metadata: { passed: 2, blocked: 0 },
      readiness: { passed: 2, blocked: 0 },
      source: { passed: 2, blocked: 0 },
    },
    blockedEntries: ["demo-pack@0.2.0"],
    blockersByGate: {
      compatibility: ["demo-pack@0.2.0: muster 0.1.9 does not satisfy >=9.0.0"],
      digest: ["demo-pack@0.2.0: registry identity demo-pack@0.2.0/tool does not match manifest demo-pack@0.1.0/tool"],
    },
    repairs: [
      {
        entry: "demo-pack@0.2.0",
        gate: "compatibility",
        reason: "muster 0.1.9 does not satisfy >=9.0.0",
        command: "review compatibility.muster for demo-pack@0.2.0 or upgrade Muster",
      },
      {
        entry: "demo-pack@0.2.0",
        gate: "digest",
        reason: "registry identity demo-pack@0.2.0/tool does not match manifest demo-pack@0.1.0/tool",
        command: `muster capability digest ${pack.dir} --write`,
      },
      {
        entry: "demo-pack@0.2.0",
        gate: "digest",
        reason: "registry identity demo-pack@0.2.0/tool does not match manifest demo-pack@0.1.0/tool",
        command: `muster roster index ${pack.dir} --dry-run`,
      },
    ],
  });
});

test("buildRosterSupportMatrix explains ownership, reuse, install, and auth without adding adapters", () => {
  const matrix = buildRosterSupportMatrix({
    hostConnectors: [
      { provider: "codex", kind: "app", id: "figma", auth: "host_oauth", source: "codex-test/.app.json" },
      { provider: "codex", kind: "mcp", id: "figma", auth: "oauth", transport: "http", source: "codex-test/.mcp.json" },
      { provider: "claude", kind: "mcp", id: "figma", auth: "oauth", transport: "http", source: "claude-test/.mcp.json" },
      { provider: "codex", kind: "mcp", id: "notion", auth: "oauth", transport: "http", source: "codex-notion/.mcp.json" },
      { provider: "codex", kind: "app", id: "slack", auth: "host_oauth", source: "codex-slack/.app.json" },
      { provider: "codex", kind: "mcp", id: "dataAnalyticsWidgets", auth: "local", transport: "stdio", source: "codex-data/.mcp.json" },
      { provider: "hermes", kind: "skill", id: "systematic-debugging", auth: "local", source: "hermes/skills/systematic-debugging/SKILL.md" },
    ],
  });
  const byId = new Map(matrix.entries.map((entry) => [entry.id, entry]));

  assert.deepEqual(byId.get("frappe-federated-bridge"), {
    id: "frappe-federated-bridge",
    kind: "plugin",
    source: "muster",
    category: "business-apps",
    support: ["owned_pack"],
    risk: "high",
    auth: ["oauth"],
    packPath: "capability-packs/frappe",
    mcpServers: [],
    channels: [],
    hosts: [],
  });
  assert.deepEqual(byId.get("slack")?.support, ["owned_pack", "channel_adapter", "host_reuse"]);
  assert.deepEqual(byId.get("slack")?.auth, ["host_oauth"]);
  assert.deepEqual(byId.get("slack")?.hosts, ["codex:app:host_oauth"]);
  assert.deepEqual(byId.get("figma")?.support, ["mcp_installable", "host_reuse"]);
  assert.deepEqual(byId.get("figma")?.auth, ["oauth", "host_oauth"]);
  assert.deepEqual(byId.get("figma")?.hosts, ["codex:app:host_oauth", "codex:mcp:oauth", "claude:mcp:oauth"]);
  assert.deepEqual(byId.get("notion")?.support, ["owned_pack", "mcp_installable", "host_reuse"]);
  assert.deepEqual(byId.get("mcp:figma")?.support, ["mcp_installable", "host_reuse"]);
	  assert.deepEqual(byId.get("mcp:data-analytics-widgets")?.support, ["host_reuse"]);
	  assert.deepEqual(byId.get("skill:systematic-debugging")?.support, ["skill_guidance", "host_reuse"]);
	  assert.deepEqual(byId.get("skill:systematic-debugging")?.hosts, ["hermes:skill:local"]);
	  assert.equal(matrix.summary.total, matrix.entries.length);
	  assert.equal(matrix.summary.hostReuse, matrix.entries.filter((entry) => entry.support.includes("host_reuse")).length);
	  assert.equal(matrix.summary.ownedPacks, matrix.entries.filter((entry) => entry.support.includes("owned_pack")).length);
	  assert.equal(matrix.summary.channelAdapters, matrix.entries.filter((entry) => entry.support.includes("channel_adapter")).length);
	  assert.ok(matrix.summary.byAuth.oauth >= 2);
	  assert.ok(matrix.summary.byAuth.host_oauth >= 1);
	});

test("buildRosterSupportMatrix does not invent host reuse when no host scan is supplied", () => {
  const matrix = buildRosterSupportMatrix();
  const byId = new Map(matrix.entries.map((entry) => [entry.id, entry]));

  assert.deepEqual(byId.get("slack")?.support, ["owned_pack", "channel_adapter"]);
  assert.deepEqual(byId.get("slack")?.hosts, []);
	  assert.deepEqual(byId.get("figma")?.support, ["mcp_installable"]);
	  assert.deepEqual(byId.get("figma")?.hosts, []);
	  assert.deepEqual(byId.get("mcp:figma")?.support, ["mcp_installable"]);
	  assert.deepEqual(byId.get("skill:systematic-debugging")?.support, ["skill_guidance"]);
	  assert.deepEqual(byId.get("skill:systematic-debugging")?.hosts, []);
	  assert.equal(matrix.summary.hostReuse, 0);
	  assert.equal(matrix.summary.setupPlanOnly, matrix.entries.filter((entry) => entry.support.length === 1 && entry.support[0] === "setup_plan").length);
	});

test("planRosterBuiltinProjection routes capabilities to their runtime owners", () => {
  const connectors = [
    { provider: "codex", kind: "app" as const, id: "figma", auth: "host_oauth", source: "codex-test/.app.json" },
    { provider: "codex", kind: "mcp" as const, id: "figma", auth: "oauth", transport: "http", source: "codex-test/.mcp.json" },
    { provider: "codex", kind: "app" as const, id: "slack", auth: "host_oauth", source: "codex-slack/.app.json" },
  ];

  const slack = planRosterBuiltinProjection("slack", { hostConnectors: connectors });
  assert.equal(slack.status, "ready");
  assert.deepEqual(slack.targets.map((target) => `${target.kind}:${target.owner}:${target.id}:${target.status}`), [
    "capability_pack:muster:slack:ready",
    "channel_adapter:gateway:slack:needs_credentials",
    "host_connector:host:slack:ready",
  ]);
  assert.equal(slack.depth.level, "partial_runtime");
  assert.ok(slack.depth.capabilities.includes("owned_runtime:channel_adapter"));
  assert.ok(slack.depth.capabilities.includes("host_reuse"));
  assert.ok(slack.depth.evidence.includes("explicit_host_scan"));
  assert.equal(slack.depth.speed.hotPath, "explicit_host_scan");
  assert.equal(slack.depth.speed.cache, "host_scan_cacheable");
  assert.deepEqual(slack.gates.map((gate) => `${gate.id}:${gate.status}`), [
    "target:passed",
    "ownership:passed",
    "mutation_boundary:passed",
    "credentials:needs_action",
    "diagnostics:needs_action",
    "host_evidence:passed",
  ]);

  const figma = planRosterBuiltinProjection("figma", { hostConnectors: connectors });
  assert.deepEqual(figma.targets.map((target) => `${target.kind}:${target.owner}:${target.id}:${target.status}:${target.command}`), [
    "mcp_server:mcp:figma:needs_credentials:muster mcp install figma && muster mcp oauth setup figma",
    "host_connector:host:figma:ready:muster plugins reuse codex",
    "host_connector:host:figma:ready:muster plugins reuse codex",
  ]);
  assert.equal(figma.depth.level, "host_evidence_only");
  assert.ok(figma.depth.gaps.some((gap) => gap.includes("mcp_server:figma:needs_credentials")));
  assert.match(figma.notes.join("\n"), /must not copy opaque host secrets/);

  const frappe = planRosterBuiltinProjection("frappe-federated-bridge");
  assert.deepEqual(frappe.targets.map((target) => `${target.kind}:${target.owner}:${target.id}`), [
    "capability_pack:muster:frappe-federated-bridge",
    "setup_plan:muster:frappe-federated-bridge",
  ]);
  assert.match(frappe.gates.map((gate) => `${gate.id}:${gate.status}:${gate.summary}`).join("\n"), /credentials:needs_action:setup_plan:frappe-federated-bridge requires oauth/);

  const unknown = planRosterBuiltinProjection("does-not-exist");
  assert.equal(unknown.status, "blocked");
  assert.deepEqual(unknown.gates.map((gate) => `${gate.id}:${gate.status}`), ["target:blocked"]);

  const googleDrive = planRosterBuiltinProjection("mcp:google-drive");
  assert.equal(googleDrive.status, "setup_only");
  assert.equal(googleDrive.depth.level, "setup_only");
  assert.ok(googleDrive.depth.capabilities.includes("setup_plan"));
  assert.equal(googleDrive.depth.speed.hotPath, "pure_projection");
  assert.deepEqual(googleDrive.gates.map((gate) => `${gate.id}:${gate.status}`), [
    "target:passed",
    "ownership:passed",
    "mutation_boundary:passed",
    "credentials:passed",
    "host_evidence:needs_action",
  ]);
  assert.match(googleDrive.gates.map((gate) => gate.summary).join("\n"), /manual MCP setup remains available/);

  const linear = planRosterBuiltinProjection("mcp:linear");
  assert.equal(linear.status, "needs_credentials");
  assert.equal(linear.depth.level, "credentials_required");
  assert.ok(linear.targets.some((target) => target.kind === "mcp_server" && target.status === "needs_credentials" && target.command === "muster mcp install linear && muster mcp oauth setup linear"));
  assert.ok(linear.gates.some((gate) => gate.id === "credentials" && gate.status === "needs_action" && gate.summary.includes("oauth")));

  const skill = planRosterBuiltinProjection("skill:systematic-debugging");
  assert.equal(skill.kind, "builtin_skill");
  assert.equal(skill.status, "ready");
  assert.equal(skill.depth.level, "verified_runtime");
  assert.ok(skill.depth.capabilities.includes("skill:systematic-debugging"));
  assert.ok(skill.depth.capabilities.includes("skill_guidance"));
  assert.deepEqual(skill.targets.map((target) => `${target.kind}:${target.owner}:${target.id}:${target.status}:${target.command}`), [
    "skill:skill:systematic-debugging:ready:muster skills enable systematic-debugging",
  ]);
  assert.ok(skill.gates.some((gate) => gate.id === "mutation_boundary" && gate.status === "passed" && gate.summary.includes("profile skill file")));
});

test("planRosterMcpActivation produces a bounded MCP config patch without copying OAuth tokens", () => {
  const plan = planRosterMcpActivation("mcp:linear");
  assert.equal(plan.status, "ready");
  assert.equal(plan.mutationBoundary, "tools.mcp.servers only");
  assert.deepEqual(plan.postInstallCommands, ["muster mcp oauth setup linear"]);
  assert.equal(plan.mcpPolicy.servers.linear?.transport.kind, "http");
  assert.equal(plan.mcpPolicy.servers.linear?.auth, "oauth");
  assert.equal(plan.mcpPolicy.servers.linear?.oauth?.setupUrl, "https://linear.app/docs/mcp");

  const next = applyRosterMcpActivationPlan({ deny: ["dangerous_tool"] }, plan);
  assert.deepEqual(next.deny, ["dangerous_tool"]);
  assert.equal(next.mcp?.servers?.linear?.auth, "oauth");
  assert.equal(next.mcp?.servers?.linear?.transport.kind, "http");

	  const unknown = planRosterMcpActivation("mcp:does-not-exist");
	  assert.equal(unknown.status, "blocked");
	  assert.throws(() => applyRosterMcpActivationPlan(undefined, unknown), /blocked roster MCP/);

	  const github = planRosterMcpActivation("mcp:github", { env: { GITHUB_TOKEN: "ghp_secret_token" } });
	  assert.equal(github.status, "ready");
	  assert.deepEqual(github.mcpPolicy.servers.github?.transport.kind === "stdio" ? github.mcpPolicy.servers.github.transport.env : undefined, {
	    GITHUB_PERSONAL_ACCESS_TOKEN: "GITHUB_PERSONAL_ACCESS_TOKEN|GITHUB_TOKEN",
	  });
	  assert.doesNotMatch(JSON.stringify(github.mcpPolicy), /ghp_secret_token/);
	});

test("rosterMcpConfigFromCatalogEntry validates env templates without copying secret values", () => {
  const config = rosterMcpConfigFromCatalogEntry({
    id: "templated",
    category: "test",
    source: "muster",
	    description: "templated test MCP",
	    risk: "medium",
	    commandHint: "muster mcp install templated",
	    install: {
	      transport: {
	        kind: "stdio",
	        command: "node",
	        args: ["${CWD}", "${TOKEN}", "TOKEN|ALT_TOKEN", "PLAIN"],
	        env: { TOKEN: "${TOKEN}", ALT_TOKEN: "TOKEN|ALT_TOKEN" },
	      },
	    },
	  }, { cwd: "/tmp/muster-roster", env: { TOKEN: "secret-token" } });
	  assert.deepEqual(config, {
	    transport: {
	      kind: "stdio",
	      command: "node",
	      args: ["/tmp/muster-roster", "${TOKEN}", "TOKEN|ALT_TOKEN", "PLAIN"],
	      env: { TOKEN: "${TOKEN}", ALT_TOKEN: "TOKEN|ALT_TOKEN" },
	    },
	  });
	  assert.doesNotMatch(JSON.stringify(config), /secret-token/);

	  const unresolved = rosterMcpConfigFromCatalogEntry({
    id: "missing",
    category: "test",
    source: "muster",
    description: "missing template test MCP",
    risk: "medium",
    commandHint: "muster mcp install missing",
    install: {
      transport: { kind: "stdio", command: "node", args: ["${TOKEN}"] },
    },
  }, { cwd: "/tmp/muster-roster", env: {} });
  assert.equal(unresolved, undefined);
});

test("buildRosterProjectionCatalog summarizes every built-in and optional locked projection", async () => {
  const root = join(tmpdir(), `muster-roster-catalog-${Date.now()}`);
  const pack = await writePack(root);
  const verification = await verifyRosterCapability({
    schemaVersion: 1,
    id: "demo-pack",
    version: "0.1.0",
    kind: "tool",
    source: { type: "local", path: pack.dir },
    digest: pack.digest,
    compatibility: { muster: ">=0.1.0" },
    actionability: "local_tool",
    risk: "medium",
  }, { musterVersion: "0.1.9" });
  const lock = {
    schemaVersion: 1 as const,
    generatedBy: "muster-roster" as const,
    entries: { "demo-pack": createRosterLockEntry(verification, "2026-07-05T12:00:00.000Z") },
  };

  const catalog = buildRosterProjectionCatalog({
    lock,
    hostConnectors: [{ provider: "codex", kind: "app", id: "slack", auth: "host_oauth", source: "codex/.app.json" }],
  });
  const plans = new Map(catalog.plans.map((plan) => [plan.id, plan]));

  assert.equal(catalog.generatedBy, "muster-roster");
  assert.equal(catalog.summary.total, catalog.plans.length);
  assert.ok(catalog.summary.ready > 0);
  assert.equal(catalog.summary.blocked, 0);
  assert.ok(catalog.summary.depthLevels.partial_runtime > 0);
  assert.ok(catalog.summary.depthLevels.setup_only > 0);
  assert.ok(catalog.summary.depthLevels.credentials_required > 0);
  assert.equal(plans.get("demo-pack")?.kind, "locked_capability");
  assert.equal(plans.get("demo-pack")?.depth.level, "verified_runtime");
  assert.equal(plans.get("slack")?.targets.some((target) => target.kind === "host_connector" && target.owner === "host"), true);
  assert.equal(plans.get("skill:systematic-debugging")?.kind, "builtin_skill");
  assert.equal(plans.get("skill:systematic-debugging")?.targets.some((target) => target.kind === "skill" && target.owner === "skill"), true);
  assert.ok((catalog.summary.targetOwners["muster:capability_pack"] ?? 0) > 0);
  assert.ok((catalog.summary.targetOwners["gateway:channel_adapter"] ?? 0) > 0);
  assert.ok((catalog.summary.targetOwners["skill:skill"] ?? 0) > 0);
  assert.ok(catalog.nextActions.length > 0);
  assert.equal(catalog.nextActions.every((action, index, actions) => index === 0 || actions[index - 1]!.priority <= action.priority), true);
  assert.deepEqual(catalog.nextActions.filter((action) => action.planId === "slack").map((action) => `${action.reason}:${action.command}`).slice(0, 2), [
    "credentials:muster channels setup slack",
    "credentials:muster channels setup slack",
  ]);
  assert.ok(catalog.nextActions.some((action) => action.reason === "diagnostics" && action.command === "muster channels doctor slack"));
  assert.ok(catalog.nextActions.some((action) => action.planId === "mcp:linear" && action.reason === "credentials" && action.command === "muster mcp install linear && muster mcp oauth setup linear"));
  assert.equal(catalog.nextActions.some((action) => action.planId === "mcp:google-drive" && action.reason === "blocked"), false);
  assert.ok(catalog.nextActions.some((action) => action.planId === "mcp:google-drive" && action.reason === "host_evidence" && action.command === "muster mcp add-stdio google-drive <configured-google-drive-mcp-command>"));
});

test("planRosterLockProjection activates locked packs through plugin policy only", async () => {
  const root = join(tmpdir(), `muster-roster-projection-${Date.now()}`);
  const pack = await writePack(root);
  const verification = await verifyRosterCapability({
    schemaVersion: 1,
    id: "demo-pack",
    version: "0.1.0",
    kind: "tool",
    source: { type: "local", path: pack.dir },
    digest: pack.digest,
    compatibility: { muster: ">=0.1.0" },
    actionability: "local_tool",
    risk: "medium",
  }, { musterVersion: "0.1.9" });
  const lock = {
    schemaVersion: 1 as const,
    generatedBy: "muster-roster" as const,
    entries: { "demo-pack": createRosterLockEntry(verification, "2026-07-05T12:00:00.000Z") },
  };

  const plan = planRosterLockProjection(lock, "demo-pack");

  assert.equal(plan.status, "ready");
  assert.deepEqual(plan.targets.map((target) => `${target.kind}:${target.owner}:${target.status}`), [
    "capability_pack:muster:ready",
  ]);
  assert.deepEqual(plan.gates.map((gate) => `${gate.id}:${gate.status}`), [
    "target:passed",
    "diagnostics:passed",
    "mutation_boundary:passed",
    "credentials:passed",
  ]);
  assert.deepEqual(plan.blockers, []);
});
