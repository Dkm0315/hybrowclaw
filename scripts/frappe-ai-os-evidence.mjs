#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const outputDir = path.resolve(root, process.env.MUSTER_EVIDENCE_DIR ?? "output/evidence");
const startedAt = new Date().toISOString();

const gates = [
  {
    id: "core-tests",
    command: ["pnpm", "--filter", "@musterhq/core", "test"],
    blocking: true,
  },
  {
    id: "gateway-tests",
    command: ["pnpm", "--filter", "@musterhq/gateway", "test"],
    blocking: true,
  },
  {
    id: "frappe-portable-tests",
    command: [
      "python3",
      "-m",
      "unittest",
      "muster.tests.test_change_ir",
      "muster.tests.test_workflow_graph",
      "muster.tests.test_demo_plan",
      "muster.tests.test_native_artifact_builders",
    ],
    env: { PYTHONPATH: "frappe_app" },
    blocking: true,
  },
  {
    id: "frappe-python-compile",
    command: ["python3", "-m", "compileall", "-q", "frappe_app/muster"],
    blocking: true,
  },
];

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const { env: extraEnv = {}, ...spawnOptions } = options;
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
      ...spawnOptions,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", (error) => resolve({ exitCode: null, stdout, stderr, error: error.message }));
    child.on("close", (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr }));
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function gitEvidence() {
  const revision = await run("git", ["rev-parse", "HEAD"], { stdio: ["ignore", "pipe", "pipe"] });
  const status = await run("git", ["status", "--porcelain=v1"], { stdio: ["ignore", "pipe", "pipe"] });
  return {
    revision: revision.stdout.trim() || null,
    dirty: Boolean(status.stdout.trim()),
    status_sha256: sha256(status.stdout),
  };
}

async function sourceHashes() {
  const targets = [
    "docs/superpowers/specs/2026-07-19-muster-frappe-ai-os-acceptance.md",
    "frappe_app/muster/demo/fixtures/scales.json",
    "frappe_app/muster/orchestration/workflow_graph.py",
    "packages/gateway/src/frappe-mission-bridge.ts",
  ];
  const hashes = {};
  for (const relativePath of targets) {
    try {
      hashes[relativePath] = sha256(await readFile(path.resolve(root, relativePath)));
    } catch (error) {
      hashes[relativePath] = { error: error.code ?? error.message };
    }
  }
  return hashes;
}

await mkdir(outputDir, { recursive: true });
const results = [];
for (const gate of gates) {
  const gateStartedAt = new Date().toISOString();
  process.stdout.write(`\n[${gate.id}] ${gate.command.join(" ")}\n`);
  const result = await run(gate.command[0], gate.command.slice(1), { env: gate.env });
  results.push({
    ...gate,
    started_at: gateStartedAt,
    finished_at: new Date().toISOString(),
    status: result.exitCode === 0 ? "passed" : "failed",
    exit_code: result.exitCode,
    signal: result.signal ?? null,
    error: result.error ?? null,
    stdout_sha256: sha256(result.stdout),
    stderr_sha256: sha256(result.stderr),
    stdout_tail: result.stdout.slice(-4000),
    stderr_tail: result.stderr.slice(-4000),
  });
}

const blockingFailures = results.filter((result) => result.blocking && result.status !== "passed");
const manifest = {
  schema_version: "1.0",
  suite: "muster-frappe-ai-os",
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  status: blockingFailures.length === 0 ? "passed" : "failed",
  policy: {
    skipped_blocking_gates_allowed: false,
    blocking_failures_allowed: 0,
  },
  environment: {
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
  },
  git: await gitEvidence(),
  source_hashes: await sourceHashes(),
  gates: results,
  blocking_failures: blockingFailures.map(({ id, exit_code, error }) => ({ id, exit_code, error })),
};

const timestamp = startedAt.replaceAll(":", "-").replace(".", "-");
const manifestPath = path.join(outputDir, `acceptance-${timestamp}.json`);
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
await writeFile(path.join(outputDir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`\nEvidence manifest: ${manifestPath}\nStatus: ${manifest.status}\n`);
process.exitCode = manifest.status === "passed" ? 0 : 1;
