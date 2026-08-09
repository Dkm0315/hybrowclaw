import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  PRODUCTS,
  OUTCOMES,
  VIEWPORTS,
  generateManifest,
  validateManifest,
} from "../video-evidence-model.mjs";

const acceptsFixtureVideo = async () => true;
const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("../video-evidence.mjs", import.meta.url));

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "muster-video-evidence-"));
  await mkdir(path.join(root, "artifacts"));
  await writeFile(path.join(root, "artifacts", "clip.webm"), Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02]));
  await writeFile(path.join(root, "artifacts", "screen.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]));
  await writeFile(path.join(root, "artifacts", "trace.zip"), Buffer.from("trace bytes"));
  await writeFile(path.join(root, "artifacts", "receipt.json"), Buffer.from('{"passed":true}\n'));
  return root;
}

function draft() {
  const clips = [];
  for (const product of PRODUCTS) {
    for (const viewport of VIEWPORTS) {
      for (const outcome of OUTCOMES) {
        clips.push({
          scenario_id: `${product}-${viewport}-${outcome}`,
          product,
          outcome,
          claim: `${product} ${outcome} behavior is visibly enforced for this role`,
          actor: { id: `${outcome}-${product}@example.test`, roles: [outcome === "allow" ? "Operator" : "Viewer"] },
          site: { id: "muster.test", revision: "site-seed-2026-07-19" },
          build_revision: "abcdef0123456789",
          routes: [`/desk/${product}`],
          expected_result: outcome === "allow" ? "The authorized operation completes visibly." : "The unauthorized operation is denied without side effects.",
          viewport: { class: viewport, width: viewport === "mobile" ? 390 : 1440, height: viewport === "mobile" ? 844 : 900 },
          timestamps: { started_at: "2026-07-19T10:00:00.000Z", finished_at: "2026-07-19T10:00:20.000Z", basis: "filesystem_mtime_minus_ffprobe_duration" },
          duration_seconds: 20,
          chapters: [{
            runbook_id: product === "muster" ? "MUS-01" : product === "erpnext" ? "ERP-01" : product === "hrms" ? "HRM-01" : "CRM-01",
            title: `${product} ${outcome} proof`,
            start_seconds: 0,
            end_seconds: 20,
            claim: `${product} visibly demonstrates the ${outcome} outcome`,
          }],
          coverage_cells: [{ product, viewport, outcome }],
          video: { path: "artifacts/clip.webm" },
          screenshots: [{ path: "artifacts/screen.png" }],
          traces: [{ path: "artifacts/trace.zip" }],
          test_receipts: [{ path: "artifacts/receipt.json" }],
        });
      }
    }
  }
  return { clips };
}

test("generator hashes only explicit clips and complete allow/deny desktop/mobile coverage validates", async () => {
  const root = await fixture();
  try {
    const manifest = await generateManifest(draft(), { repoRoot: root, generatedAt: "2026-07-19T11:00:00.000Z", videoProbe: acceptsFixtureVideo });
    const result = await validateManifest(manifest, { repoRoot: root, videoProbe: acceptsFixtureVideo });
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    assert.equal(manifest.clips.length, PRODUCTS.length * 4);
    assert.match(manifest.clips[0].video.sha256, /^[a-f0-9]{64}$/);
    assert.equal(manifest.clips[0].video.media_type, "video/webm");
    assert.ok(manifest.clips[0].screenshots[0].bytes > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("empty generation never fabricates clips and fails release coverage", async () => {
  const root = await fixture();
  try {
    const manifest = await generateManifest({ clips: [] }, { repoRoot: root, videoProbe: acceptsFixtureVideo });
    assert.deepEqual(manifest.clips, []);
    const result = await validateManifest(manifest, { repoRoot: root, videoProbe: acceptsFixtureVideo });
    assert.equal(result.valid, false);
    assert.equal(result.errors.filter((item) => item.code === "coverage_missing").length, PRODUCTS.length * 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing hashes, unknown fields, and missing an allow/deny coverage cell fail closed", async () => {
  const root = await fixture();
  try {
    const manifest = await generateManifest(draft(), { repoRoot: root, videoProbe: acceptsFixtureVideo });
    delete manifest.clips[0].video.sha256;
    manifest.clips[1].unexpected = true;
    manifest.clips.pop();
    const result = await validateManifest(manifest, { repoRoot: root, videoProbe: acceptsFixtureVideo });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((item) => item.code === "missing_hash"));
    assert.ok(result.errors.some((item) => item.code === "unknown_field"));
    assert.ok(result.errors.some((item) => item.code === "coverage_missing"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("renamed non-video input is rejected before a manifest can claim it", async () => {
  const root = await fixture();
  try {
    await writeFile(path.join(root, "artifacts", "fake.mp4"), Buffer.from("not a video"));
    const value = draft();
    value.clips[0].video.path = "artifacts/fake.mp4";
    await assert.rejects(
      () => generateManifest(value, { repoRoot: root, videoProbe: acceptsFixtureVideo }),
      /file signature is not a supported video container/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact mutation after generation is detected by hash and size verification", async () => {
  const root = await fixture();
  try {
    const manifest = await generateManifest(draft(), { repoRoot: root, videoProbe: acceptsFixtureVideo });
    await writeFile(path.join(root, "artifacts", "screen.png"), Buffer.from("tampered screenshot"));
    const result = await validateManifest(manifest, { repoRoot: root, videoProbe: acceptsFixtureVideo });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((item) => item.code === "hash_mismatch"));
    assert.ok(result.errors.some((item) => item.code === "size_mismatch"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a container signature without a decodable video stream is rejected", async () => {
  const root = await fixture();
  try {
    const manifest = await generateManifest(draft(), { repoRoot: root, videoProbe: acceptsFixtureVideo });
    const result = await validateManifest(manifest, { repoRoot: root, videoProbe: async () => false });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((item) => item.code === "non_video_evidence"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ffprobe metadata is authoritative for generated duration and dimensions", async () => {
  const root = await fixture();
  try {
    const value = draft();
    const manifest = await generateManifest(value, {
      repoRoot: root,
      videoProbe: async () => ({ width: 1440, height: 900, duration_seconds: 19.75 }),
    });
    assert.equal(manifest.clips[0].duration_seconds, 19.75);
    assert.deepEqual(manifest.clips[0].viewport, { class: "desktop", width: 1440, height: 900 });
    const result = await validateManifest(manifest, {
      repoRoot: root,
      requireCoverage: false,
      videoProbe: async () => ({ width: 1280, height: 720, duration_seconds: 18 }),
    });
    assert.ok(result.errors.some((item) => item.code === "viewport_mismatch"));
    assert.ok(result.errors.some((item) => item.code === "duration_mismatch"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coverage is counted only from explicit cells and paired claims require both outcomes", async () => {
  const root = await fixture();
  try {
    const manifest = await generateManifest(draft(), { repoRoot: root, videoProbe: acceptsFixtureVideo });
    manifest.clips[0].outcome = "paired";
    const result = await validateManifest(manifest, { repoRoot: root, videoProbe: acceptsFixtureVideo });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((item) => item.code === "unproven_paired_outcome"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("timestamps require strict RFC 3339 intervals", async () => {
  const root = await fixture();
  try {
    const manifest = await generateManifest(draft(), { repoRoot: root, videoProbe: acceptsFixtureVideo });
    manifest.generated_at = "July 19, 2026";
    manifest.clips[0].timestamps.finished_at = manifest.clips[0].timestamps.started_at;
    const result = await validateManifest(manifest, { repoRoot: root, videoProbe: acceptsFixtureVideo });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((item) => item.code === "invalid_timestamp"));
    assert.ok(result.errors.some((item) => item.code === "invalid_interval"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("paths outside the repository are rejected during generation", async () => {
  const root = await fixture();
  try {
    const value = draft();
    value.clips[0].video.path = "../outside.webm";
    await assert.rejects(() => generateManifest(value, { repoRoot: root, videoProbe: acceptsFixtureVideo }), /stay inside the repository/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI init and generate preserve an explicit empty draft without inventing video evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "muster-video-cli-"));
  const draftPath = path.join(root, "draft.json");
  const manifestPath = path.join(root, "manifest.json");
  try {
    const initialized = await execFileAsync(process.execPath, [cli, "init", "--out", draftPath], { encoding: "utf8" });
    assert.match(initialized.stdout, /No clips were fabricated/);
    await assert.rejects(
      () => execFileAsync(process.execPath, [
        cli, "generate", "--input", draftPath, "--out", manifestPath, "--repo-root", root,
      ], { encoding: "utf8" }),
      (error) => error.code === 1,
    );
    const generated = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.deepEqual(generated.clips, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
