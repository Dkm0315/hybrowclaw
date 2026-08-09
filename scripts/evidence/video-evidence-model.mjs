import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

export const SCHEMA_VERSION = "1.1";
export const MANIFEST_KIND = "muster-frappeverse-video-evidence";
export const PRODUCTS = Object.freeze(["muster", "erpnext", "hrms", "crm", "helpdesk", "custom_app"]);
export const OUTCOMES = Object.freeze(["allow", "deny"]);
export const CLIP_OUTCOMES = Object.freeze([...OUTCOMES, "paired"]);
export const VIEWPORTS = Object.freeze(["desktop", "mobile"]);

const SHA256 = /^[a-f0-9]{64}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const SCENARIO_ID = /^[a-z0-9][a-z0-9._-]{2,79}$/;
const REVISION = /^[a-f0-9]{7,64}$/;
const VIDEO_TYPES = Object.freeze({
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
});
const ROOT_KEYS = new Set(["schema_version", "kind", "generated_at", "clips"]);
const CLIP_KEYS = new Set([
  "scenario_id", "product", "outcome", "claim", "actor", "site", "build_revision",
  "routes", "expected_result", "viewport", "timestamps", "video", "screenshots",
  "traces", "test_receipts", "duration_seconds", "chapters", "coverage_cells",
]);
const ACTOR_KEYS = new Set(["id", "roles"]);
const SITE_KEYS = new Set(["id", "revision"]);
const VIEWPORT_KEYS = new Set(["class", "width", "height"]);
const TIMESTAMP_KEYS = new Set(["started_at", "finished_at", "basis"]);
const CHAPTER_KEYS = new Set(["runbook_id", "title", "start_seconds", "end_seconds", "claim"]);
const COVERAGE_KEYS = new Set(["product", "viewport", "outcome"]);
const ARTIFACT_KEYS = new Set(["path", "sha256", "bytes"]);
const VIDEO_KEYS = new Set(["path", "sha256", "bytes", "media_type"]);
const execFileAsync = promisify(execFile);

function issue(errors, code, location, message) {
  errors.push({ code, path: location, message });
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function strictKeys(value, allowed, location, errors) {
  if (!plainObject(value)) {
    issue(errors, "invalid_type", location, "must be an object");
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issue(errors, "unknown_field", `${location}.${key}`, "is not allowed by the evidence schema");
  }
  return true;
}

function requiredString(value, location, errors, minimum = 1, maximum = 2000) {
  if (typeof value !== "string" || value.trim().length < minimum || value.length > maximum) {
    issue(errors, "invalid_string", location, `must be a string between ${minimum} and ${maximum} characters`);
    return false;
  }
  return true;
}

function validDate(value, location, errors) {
  if (typeof value !== "string" || !RFC3339.test(value) || Number.isNaN(Date.parse(value))) {
    issue(errors, "invalid_timestamp", location, "must be an RFC 3339 timestamp");
    return undefined;
  }
  return Date.parse(value);
}

function normalizeRelativePath(value, location, errors) {
  if (typeof value !== "string" || !value || value.includes("\\") || path.isAbsolute(value)) {
    issue(errors, "unsafe_path", location, "must be a non-empty repository-relative POSIX path");
    return undefined;
  }
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized !== value) {
    issue(errors, "unsafe_path", location, "must be normalized and stay inside the repository");
    return undefined;
  }
  return normalized;
}

async function loadArtifact(reference, location, repoRoot, errors, { video = false, videoProbe = probeVideoFile, expectedVideo } = {}) {
  const keys = video ? VIDEO_KEYS : ARTIFACT_KEYS;
  if (!strictKeys(reference, keys, location, errors)) return undefined;
  const relative = normalizeRelativePath(reference.path, `${location}.path`, errors);
  if (!SHA256.test(reference.sha256 ?? "")) issue(errors, "missing_hash", `${location}.sha256`, "must contain a lowercase SHA-256 digest");
  if (!Number.isSafeInteger(reference.bytes) || reference.bytes < 1) issue(errors, "invalid_size", `${location}.bytes`, "must be a positive integer");
  if (video && !Object.values(VIDEO_TYPES).includes(reference.media_type)) {
    issue(errors, "invalid_video_type", `${location}.media_type`, "must be an approved video media type");
  }
  if (!relative) return undefined;
  const absolute = path.resolve(repoRoot, relative);
  try {
    const [rootReal, fileReal, stat] = await Promise.all([realpath(repoRoot), realpath(absolute), lstat(absolute)]);
    if (stat.isSymbolicLink() || !stat.isFile() || !(fileReal === rootReal || fileReal.startsWith(`${rootReal}${path.sep}`))) {
      issue(errors, "unsafe_artifact", location, "must resolve to a regular file inside the repository");
      return undefined;
    }
    const bytes = await readFile(fileReal);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== reference.sha256) issue(errors, "hash_mismatch", `${location}.sha256`, "does not match the artifact bytes");
    if (bytes.length !== reference.bytes) issue(errors, "size_mismatch", `${location}.bytes`, "does not match the artifact size");
    if (video) {
      const signatureErrors = [];
      validateVideoSignature(bytes, relative, reference.media_type, location, signatureErrors);
      errors.push(...signatureErrors);
      if (signatureErrors.length === 0) {
        try {
          const probe = await videoProbe(fileReal);
          if (!probe) issue(errors, "non_video_evidence", location, "ffprobe found no decodable video stream");
          else if (plainObject(probe) && expectedVideo) {
            if (probe.width !== expectedVideo.viewport?.width || probe.height !== expectedVideo.viewport?.height) {
              issue(errors, "viewport_mismatch", `${location}.viewport`, `indexed ${expectedVideo.viewport?.width}x${expectedVideo.viewport?.height} but video is ${probe.width}x${probe.height}`);
            }
            if (!Number.isFinite(expectedVideo.duration_seconds) || Math.abs(probe.duration_seconds - expectedVideo.duration_seconds) > 0.001) {
              issue(errors, "duration_mismatch", `${location}.duration_seconds`, `indexed ${expectedVideo.duration_seconds} seconds but video is ${probe.duration_seconds} seconds`);
            }
          }
        } catch (error) {
          issue(errors, "video_probe_failed", location, `cannot verify video stream: ${error.code ?? error.message}`);
        }
      }
    }
    return { relative, bytes, digest };
  } catch (error) {
    issue(errors, "artifact_unavailable", location, `cannot read artifact: ${error.code ?? error.message}`);
    return undefined;
  }
}

function validateVideoSignature(bytes, relative, mediaType, location, errors) {
  const extension = path.extname(relative).toLowerCase();
  if (!Object.hasOwn(VIDEO_TYPES, extension) || VIDEO_TYPES[extension] !== mediaType) {
    issue(errors, "non_video_evidence", location, "video extension and media_type must be a supported matching pair");
    return;
  }
  const isWebm = bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  const isIsoMedia = bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp";
  if ((mediaType === "video/webm" && !isWebm) || (mediaType !== "video/webm" && !isIsoMedia)) {
    issue(errors, "non_video_evidence", location, "file signature is not a supported video container");
  }
}

export async function probeVideoFile(filename) {
  const { stdout } = await execFileAsync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", filename],
    { encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout || "{}");
  const stream = Array.isArray(parsed.streams) ? parsed.streams.find((item) => item?.codec_type === "video") : undefined;
  const durationSeconds = Number(parsed.format?.duration);
  if (!stream || !Number.isInteger(stream.width) || !Number.isInteger(stream.height) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return false;
  return { width: stream.width, height: stream.height, duration_seconds: durationSeconds };
}

function validateCoverage(clips, errors) {
  const cells = new Map();
  for (const clip of clips) {
    for (const cell of clip?.coverage_cells ?? []) {
      if (!PRODUCTS.includes(cell?.product) || !VIEWPORTS.includes(cell?.viewport) || !OUTCOMES.includes(cell?.outcome)) continue;
      const key = `${cell.product}:${cell.viewport}:${cell.outcome}`;
      cells.set(key, (cells.get(key) ?? 0) + 1);
    }
  }
  for (const product of PRODUCTS) {
    for (const viewport of VIEWPORTS) {
      for (const outcome of OUTCOMES) {
        const key = `${product}:${viewport}:${outcome}`;
        if (!cells.has(key)) issue(errors, "coverage_missing", "$.clips", `requires ${outcome} evidence for ${product} on ${viewport}`);
      }
    }
  }
}

export async function validateManifest(
  manifest,
  { repoRoot = process.cwd(), requireCoverage = true, videoProbe = probeVideoFile } = {},
) {
  const errors = [];
  if (!strictKeys(manifest, ROOT_KEYS, "$", errors)) return { valid: false, errors };
  if (manifest.schema_version !== SCHEMA_VERSION) issue(errors, "schema_version", "$.schema_version", `must equal ${SCHEMA_VERSION}`);
  if (manifest.kind !== MANIFEST_KIND) issue(errors, "manifest_kind", "$.kind", `must equal ${MANIFEST_KIND}`);
  validDate(manifest.generated_at, "$.generated_at", errors);
  if (!Array.isArray(manifest.clips)) {
    issue(errors, "invalid_type", "$.clips", "must be an array");
    return { valid: false, errors };
  }
  const scenarioIds = new Set();
  for (let index = 0; index < manifest.clips.length; index += 1) {
    const clip = manifest.clips[index];
    const base = `$.clips[${index}]`;
    if (!strictKeys(clip, CLIP_KEYS, base, errors)) continue;
    if (!SCENARIO_ID.test(clip.scenario_id ?? "")) issue(errors, "invalid_scenario_id", `${base}.scenario_id`, "must be a stable lowercase scenario id");
    else if (scenarioIds.has(clip.scenario_id)) issue(errors, "duplicate_scenario", `${base}.scenario_id`, "must be unique");
    else scenarioIds.add(clip.scenario_id);
    if (!PRODUCTS.includes(clip.product)) issue(errors, "invalid_product", `${base}.product`, `must be one of ${PRODUCTS.join(", ")}`);
    if (!CLIP_OUTCOMES.includes(clip.outcome)) issue(errors, "invalid_outcome", `${base}.outcome`, "must be allow, deny, or paired");
    requiredString(clip.claim, `${base}.claim`, errors, 8, 1000);
    if (strictKeys(clip.actor, ACTOR_KEYS, `${base}.actor`, errors)) {
      requiredString(clip.actor.id, `${base}.actor.id`, errors, 1, 254);
      if (!Array.isArray(clip.actor.roles) || clip.actor.roles.length === 0 || new Set(clip.actor.roles).size !== clip.actor.roles.length) {
        issue(errors, "invalid_roles", `${base}.actor.roles`, "must contain at least one unique role");
      } else clip.actor.roles.forEach((role, roleIndex) => requiredString(role, `${base}.actor.roles[${roleIndex}]`, errors, 1, 140));
    }
    if (strictKeys(clip.site, SITE_KEYS, `${base}.site`, errors)) {
      requiredString(clip.site.id, `${base}.site.id`, errors, 1, 140);
      if (requiredString(clip.site.revision, `${base}.site.revision`, errors, 1, 200) && /^(?:unknown|missing|unrecorded)(?:-|$)/i.test(clip.site.revision)) {
        issue(errors, "missing_site_revision", `${base}.site.revision`, "must identify the captured site's exact deployment/database revision");
      }
    }
    if (!REVISION.test(clip.build_revision ?? "")) issue(errors, "invalid_revision", `${base}.build_revision`, "must be a 7-64 character lowercase hexadecimal revision");
    if (!Array.isArray(clip.routes) || clip.routes.length === 0 || new Set(clip.routes).size !== clip.routes.length) {
      issue(errors, "invalid_routes", `${base}.routes`, "must contain at least one unique route");
    } else for (const [routeIndex, route] of clip.routes.entries()) {
      if (typeof route !== "string" || !route.startsWith("/") || /\s/.test(route) || route.length > 500) issue(errors, "invalid_route", `${base}.routes[${routeIndex}]`, "must be a bounded absolute application route");
    }
    requiredString(clip.expected_result, `${base}.expected_result`, errors, 8, 2000);
    if (strictKeys(clip.viewport, VIEWPORT_KEYS, `${base}.viewport`, errors)) {
      if (!VIEWPORTS.includes(clip.viewport.class)) issue(errors, "invalid_viewport", `${base}.viewport.class`, "must be desktop or mobile");
      for (const dimension of ["width", "height"]) if (!Number.isInteger(clip.viewport[dimension]) || clip.viewport[dimension] < 240 || clip.viewport[dimension] > 7680) issue(errors, "invalid_viewport", `${base}.viewport.${dimension}`, "must be an integer from 240 to 7680");
      const expected = clip.viewport.class === "desktop" ? [1440, 900] : [390, 844];
      if (clip.viewport.width !== expected[0] || clip.viewport.height !== expected[1]) issue(errors, "viewport_standard_mismatch", `${base}.viewport`, `runbook requires ${expected[0]}x${expected[1]} for ${clip.viewport.class}`);
    }
    if (strictKeys(clip.timestamps, TIMESTAMP_KEYS, `${base}.timestamps`, errors)) {
      const started = validDate(clip.timestamps.started_at, `${base}.timestamps.started_at`, errors);
      const finished = validDate(clip.timestamps.finished_at, `${base}.timestamps.finished_at`, errors);
      if (clip.timestamps.basis !== "filesystem_mtime_minus_ffprobe_duration") issue(errors, "invalid_timestamp_basis", `${base}.timestamps.basis`, "must disclose the supported capture-time derivation");
      if (started !== undefined && finished !== undefined && finished <= started) issue(errors, "invalid_interval", `${base}.timestamps`, "finished_at must be after started_at");
    }
    if (!Number.isFinite(clip.duration_seconds) || clip.duration_seconds <= 0) issue(errors, "invalid_duration", `${base}.duration_seconds`, "must be a positive finite number");
    if (!Array.isArray(clip.chapters) || clip.chapters.length === 0) issue(errors, "invalid_chapters", `${base}.chapters`, "must contain at least one runbook chapter");
    else {
      let priorEnd = 0;
      for (const [chapterIndex, chapter] of clip.chapters.entries()) {
        const chapterBase = `${base}.chapters[${chapterIndex}]`;
        if (!strictKeys(chapter, CHAPTER_KEYS, chapterBase, errors)) continue;
        if (!/^(?:CFG|MUS|ERP|HRM|CRM|HDK|CUS|SOP|DEV)-\d{2}$/.test(chapter.runbook_id ?? "")) issue(errors, "invalid_runbook_id", `${chapterBase}.runbook_id`, "must reference a runbook scenario ID");
        requiredString(chapter.title, `${chapterBase}.title`, errors, 3, 200);
        requiredString(chapter.claim, `${chapterBase}.claim`, errors, 8, 1000);
        if (!Number.isFinite(chapter.start_seconds) || !Number.isFinite(chapter.end_seconds) || chapter.start_seconds < priorEnd || chapter.end_seconds <= chapter.start_seconds || chapter.end_seconds > clip.duration_seconds + 0.001) {
          issue(errors, "invalid_chapter_interval", chapterBase, "must be ordered, non-overlapping, positive, and within the video duration");
        }
        priorEnd = chapter.end_seconds;
      }
    }
    if (!Array.isArray(clip.coverage_cells)) issue(errors, "invalid_coverage_cells", `${base}.coverage_cells`, "must be an explicit array, empty when the clip proves no release cell");
    else {
      const explicitCells = new Set();
      for (const [cellIndex, cell] of clip.coverage_cells.entries()) {
        const cellBase = `${base}.coverage_cells[${cellIndex}]`;
        if (!strictKeys(cell, COVERAGE_KEYS, cellBase, errors)) continue;
        if (!PRODUCTS.includes(cell.product)) issue(errors, "invalid_product", `${cellBase}.product`, `must be one of ${PRODUCTS.join(", ")}`);
        if (!VIEWPORTS.includes(cell.viewport)) issue(errors, "invalid_viewport", `${cellBase}.viewport`, "must be desktop or mobile");
        if (!OUTCOMES.includes(cell.outcome)) issue(errors, "invalid_outcome", `${cellBase}.outcome`, "must be allow or deny");
        if (cell.product !== clip.product || cell.viewport !== clip.viewport?.class) issue(errors, "coverage_claim_mismatch", cellBase, "must match the clip product and viewport");
        const key = `${cell.product}:${cell.viewport}:${cell.outcome}`;
        if (explicitCells.has(key)) issue(errors, "duplicate_coverage_cell", cellBase, "must be unique within a clip");
        explicitCells.add(key);
      }
      if (clip.outcome === "paired" && !(explicitCells.has(`${clip.product}:${clip.viewport?.class}:allow`) && explicitCells.has(`${clip.product}:${clip.viewport?.class}:deny`))) {
        issue(errors, "unproven_paired_outcome", `${base}.coverage_cells`, "paired clips must explicitly prove both allow and deny cells");
      }
    }
    await loadArtifact(clip.video, `${base}.video`, repoRoot, errors, { video: true, videoProbe, expectedVideo: clip });
    for (const field of ["screenshots", "traces", "test_receipts"]) {
      if (!Array.isArray(clip[field]) || clip[field].length === 0) {
        issue(errors, "missing_evidence", `${base}.${field}`, "must contain at least one hashed artifact link");
      } else {
        for (let artifactIndex = 0; artifactIndex < clip[field].length; artifactIndex += 1) {
          await loadArtifact(clip[field][artifactIndex], `${base}.${field}[${artifactIndex}]`, repoRoot, errors);
        }
      }
    }
  }
  if (requireCoverage) validateCoverage(manifest.clips, errors);
  return { valid: errors.length === 0, errors };
}

async function hashDraftArtifact(reference, repoRoot, { video = false, videoProbe = probeVideoFile } = {}) {
  if (!plainObject(reference) || typeof reference.path !== "string") throw new Error("Every draft artifact requires an explicit path.");
  const errors = [];
  const relative = normalizeRelativePath(reference.path, "artifact.path", errors);
  if (!relative || errors.length) throw new Error(errors[0].message);
  const absolute = path.resolve(repoRoot, relative);
  const [rootReal, fileReal, stat] = await Promise.all([realpath(repoRoot), realpath(absolute), lstat(absolute)]);
  if (stat.isSymbolicLink() || !stat.isFile() || !(fileReal === rootReal || fileReal.startsWith(`${rootReal}${path.sep}`))) throw new Error(`Unsafe artifact path: ${relative}`);
  const bytes = await readFile(fileReal);
  const output = { path: relative, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  if (video) {
    const extension = path.extname(relative).toLowerCase();
    const mediaType = VIDEO_TYPES[extension];
    if (!mediaType) throw new Error(`Unsupported video extension: ${extension || "(none)"}`);
    const signatureErrors = [];
    validateVideoSignature(bytes, relative, mediaType, "video", signatureErrors);
    if (signatureErrors.length) throw new Error(signatureErrors[0].message);
    const probe = await videoProbe(fileReal);
    if (!probe) throw new Error(`ffprobe found no decodable video stream: ${relative}`);
    return { ...output, media_type: mediaType, _probe: plainObject(probe) ? probe : undefined };
  }
  if (bytes.length === 0) throw new Error(`Artifact is empty: ${relative}`);
  return output;
}

export async function generateManifest(
  draft,
  { repoRoot = process.cwd(), generatedAt = new Date().toISOString(), videoProbe = probeVideoFile } = {},
) {
  if (!plainObject(draft) || !Array.isArray(draft.clips)) throw new Error("Draft must be an object with an explicit clips array.");
  const clips = [];
  for (const clip of draft.clips) {
    if (!plainObject(clip)) throw new Error("Every draft clip must be an object.");
    const generatedVideo = await hashDraftArtifact(clip.video, repoRoot, { video: true, videoProbe });
    const { _probe, ...video } = generatedVideo;
    clips.push({
      ...clip,
      duration_seconds: _probe?.duration_seconds ?? clip.duration_seconds,
      viewport: _probe ? { ...clip.viewport, width: _probe.width, height: _probe.height } : clip.viewport,
      video,
      screenshots: await Promise.all((clip.screenshots ?? []).map((item) => hashDraftArtifact(item, repoRoot))),
      traces: await Promise.all((clip.traces ?? []).map((item) => hashDraftArtifact(item, repoRoot))),
      test_receipts: await Promise.all((clip.test_receipts ?? []).map((item) => hashDraftArtifact(item, repoRoot))),
    });
  }
  return {
    schema_version: SCHEMA_VERSION,
    kind: MANIFEST_KIND,
    generated_at: generatedAt,
    clips,
  };
}

export function emptyDraft() {
  return { clips: [] };
}
