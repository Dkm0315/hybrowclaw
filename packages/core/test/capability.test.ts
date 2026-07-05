import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { computeCapabilityEntrypointDigest, inspectCapabilityManifest, inspectCapabilityPack } from "../src/index.js";

test("inspectCapabilityManifest accepts a safe read-only skill manifest", () => {
  const result = inspectCapabilityManifest("/tmp/example", {
    schemaVersion: 1,
    id: "redis-runbook",
    name: "Redis Runbook",
    version: "0.1.0",
    kind: "skill",
    entrypoint: "SKILL.md",
    permissions: ["filesystem:read"],
    sandbox: "read_only",
    evals: ["evals/redis-runbook.jsonl"],
    digest: "sha256:test"
  });

  assert.equal(result.status, "ready");
  assert.equal(result.risk, "low");
  assert.equal(result.manifest?.id, "redis-runbook");
});

test("inspectCapabilityManifest blocks shell without write/full-trust sandbox", () => {
  const result = inspectCapabilityManifest("/tmp/example", {
    schemaVersion: 1,
    id: "shell-helper",
    name: "Shell Helper",
    version: "0.1.0",
    kind: "tool",
    entrypoint: "index.ts",
    permissions: ["shell"],
    sandbox: "read_only"
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.risk, "high");
  assert.match(result.blockers.join("\n"), /shell permission/);
});

test("inspectCapabilityManifest requires declared secret names for secret access", () => {
  const result = inspectCapabilityManifest("/tmp/example", {
    schemaVersion: 1,
    id: "aws-reader",
    name: "AWS Reader",
    version: "0.1.0",
    kind: "tool",
    entrypoint: "index.ts",
    permissions: ["secrets"],
    sandbox: "workspace_write",
    secrets: []
  });

  assert.equal(result.status, "blocked");
  assert.match(result.blockers.join("\n"), /secrets permission/);
});

test("capability manifest accepts readiness metadata", () => {
  const inspection = inspectCapabilityManifest("/packs/demo", {
    schemaVersion: 1,
    id: "demo-pack",
    name: "Demo Pack",
    version: "0.1.0",
    kind: "tool",
    entrypoint: "src/index.ts",
    permissions: ["network"],
    sandbox: "network_limited",
    readiness: {
      level: "executable",
      status: "beta",
      actionability: "local_tool",
      owner: "muster",
      surfaces: ["cli", "tui"],
      setup: {
        urls: ["https://example.test/setup"],
        requiredEnv: ["DEMO_TOKEN"],
        requiredAnyEnv: [],
        credentialStorage: "env",
      },
      diagnostics: {
        doctorCommand: "muster plugins check demo-pack",
        smokeCommand: "muster plugins test demo-pack",
        latencyBudgetMs: 500,
        requiresLiveCredentials: true,
      },
      safety: {
        risk: "medium",
        permissionMode: "ask",
        mutationApproval: "required",
        resultCapBytes: 65536,
        secretRedaction: true,
      },
      evidence: {
        unitTests: ["packages/core/test/demo.test.ts"],
        qaSuites: ["pack_readiness"],
        liveArtifacts: [],
        docs: ["docs/demo.md"],
      },
    },
  });

  assert.equal(inspection.status, "ready");
  assert.equal(inspection.manifest?.readiness?.level, "executable");
  assert.equal(inspection.manifest?.readiness?.setup.requiredEnv[0], "DEMO_TOKEN");
});

test("capability readiness rejects unknown levels and unsafe secret redaction", () => {
  const inspection = inspectCapabilityManifest("/packs/demo", {
    schemaVersion: 1,
    id: "demo-pack",
    name: "Demo Pack",
    version: "0.1.0",
    kind: "tool",
    entrypoint: "src/index.ts",
    permissions: ["network"],
    sandbox: "network_limited",
    readiness: {
      level: "pretend_ready",
      status: "stable",
      actionability: "local_tool",
      owner: "muster",
      surfaces: ["cli"],
      setup: { urls: [], requiredEnv: [], requiredAnyEnv: [], credentialStorage: "env" },
      diagnostics: { requiresLiveCredentials: false },
      safety: {
        risk: "low",
        permissionMode: "ask",
        mutationApproval: "never",
        resultCapBytes: 1000,
        secretRedaction: false,
      },
      evidence: { unitTests: [], qaSuites: [], liveArtifacts: [], docs: [] },
    },
  });

  assert.equal(inspection.status, "blocked");
  assert.match(inspection.blockers.join("\n"), /readiness.level/);
  assert.match(inspection.blockers.join("\n"), /secretRedaction/);
});

test("inspectCapabilityPack blocks a manifest whose entrypoint digest does not match", async () => {
  const dir = join(tmpdir(), `muster-capability-digest-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const entrypoint = "export const tools = { noop: async () => ({ ok: true }) };\n";
  await writeFile(join(dir, "index.js"), entrypoint, "utf8");
  await writeFile(
    join(dir, "muster.capability.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      id: "digest-check",
      name: "Digest Check",
      version: "0.1.0",
      kind: "tool",
      entrypoint: "index.js",
      permissions: ["filesystem:read"],
      sandbox: "read_only",
      evals: ["evals/noop.jsonl"],
      digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    }, null, 2)}\n`,
    "utf8",
  );

  const result = await inspectCapabilityPack(dir);

  assert.equal(result.status, "blocked");
  assert.match(result.blockers.join("\n"), /digest mismatch/);
  assert.equal(await computeCapabilityEntrypointDigest(dir, { entrypoint: "index.js" }), `sha256:${createHash("sha256").update(entrypoint).digest("hex")}`);
});
