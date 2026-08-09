#!/usr/bin/env node

import {createHash} from "node:crypto";
import {existsSync, mkdirSync, writeFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {spawnSync} from "node:child_process";

const KIND = "muster.native_desk.exact_record_rbac";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function usage() {
  return [
    "Usage:",
    "  node scripts/evidence/native-desk-rbac-evidence.mjs \\",
    "    --bench /absolute/path/to/frappe-bench --site site.example.test \\",
    "    --update MST-WFP-UPDATE --delete MST-WFP-DELETE [--denied user@example.test] \\",
    "    [--out output/evidence/native-desk-rbac-live.json]",
    "",
    "The command is read-only: it verifies live Frappe RBAC, maker/checker separation,",
    "and stale-revision rejection for two already-approved exact-record proposals.",
  ].join("\n");
}

export function parseArgs(argv) {
  const allowed = new Set(["bench", "site", "update", "delete", "denied", "out"]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const token = argv[index];
    const value = argv[index + 1];
    if (!token?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Invalid argument sequence near ${token || "<end>"}\n\n${usage()}`);
    }
    const key = token.slice(2);
    if (!allowed.has(key) || Object.hasOwn(values, key)) {
      throw new Error(`Unknown or repeated argument: ${token}\n\n${usage()}`);
    }
    values[key] = value;
  }
  for (const required of ["bench", "site", "update", "delete"]) {
    if (!values[required]) throw new Error(`Missing --${required}\n\n${usage()}`);
  }
  return {
    bench: resolve(values.bench),
    site: values.site,
    update: values.update,
    delete: values.delete,
    denied: values.denied || null,
    out: resolve(values.out || "output/evidence/native-desk-rbac-live.json"),
  };
}

export function parseBenchEvidence(stdout) {
  const candidates = String(stdout).trim().split(/\r?\n/).reverse();
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      const evidence = value?.message?.kind === KIND ? value.message : value;
      if (evidence?.kind === KIND && Array.isArray(evidence.cases)) return evidence;
    } catch {
      // Bench may emit bounded informational lines before its final JSON value.
    }
  }
  throw new Error("Bench did not return a native Desk RBAC evidence payload");
}

export function validateEvidence(evidence) {
  if (evidence?.kind !== KIND || evidence.read_only !== true || evidence.cases?.length !== 2) {
    throw new Error("Evidence payload has the wrong kind, mutation flag, or case count");
  }
  const operations = new Set();
  for (const item of evidence.cases) {
    operations.add(item?.operation);
    if (!item?.proposal || !item?.doctype || !item?.record_name || !item?.record_revision
      || !item?.maker || !item?.checker || item.maker.toLowerCase() === item.checker.toLowerCase()
      || item.maker_checker_distinct !== true || item.maker_self_approval_denied !== true
      || item.checker_preview_denied !== true || item.stale_revision_denied !== true
      || item.executed !== false) {
      throw new Error(`Incomplete fail-closed evidence for ${item?.operation || "unknown"}`);
    }
    if (item.denied_user_blocked !== null && item.denied_user_blocked !== true) {
      throw new Error(`Denied user retained authority for ${item.operation}`);
    }
  }
  if (operations.size !== 2 || !operations.has("update") || !operations.has("delete")) {
    throw new Error("Evidence must contain one exact-record update and one delete case");
  }
  if (!/^[a-f0-9]{64}$/.test(evidence.evidence_sha256 || "")) {
    throw new Error("Evidence payload is missing its server-side SHA-256 seal");
  }
  const sealed = {...evidence};
  delete sealed.evidence_sha256;
  const expected = createHash("sha256").update(canonicalJson(sealed)).digest("hex");
  if (expected !== evidence.evidence_sha256) {
    throw new Error("Evidence payload does not match its server-side SHA-256 seal");
  }
  return evidence;
}

export function benchKwargs(options) {
  return {
    update_proposal: options.update,
    delete_proposal: options.delete,
    ...(options.denied ? {denied_user: options.denied} : {}),
    // Bench currently evaluates --kwargs as a Python literal. JSON integers
    // remain safe and portable; JSON true/null do not.
    confirm: 1,
  };
}

export function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!existsSync(options.bench)) throw new Error(`Bench directory does not exist: ${options.bench}`);
  const kwargs = benchKwargs(options);
  const args = [
    "--site", options.site, "execute", "muster.demo.native_desk_rbac_evidence.capture",
    "--kwargs", JSON.stringify(kwargs),
  ];
  const result = spawnSync("bench", args, {
    cwd: options.bench,
    encoding: "utf8",
    shell: false,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const diagnostic = String(result.stderr).trim() || String(result.stdout).trim();
    throw new Error(`Bench evidence capture failed (${result.status}): ${diagnostic.slice(-4000)}`);
  }
  const evidence = validateEvidence(parseBenchEvidence(result.stdout));
  const artifact = {
    ...evidence,
    capture_command: {
      executable: "bench",
      arguments: args,
      cwd: options.bench,
      stdout_sha256: createHash("sha256").update(result.stdout).digest("hex"),
      stderr_sha256: createHash("sha256").update(result.stderr).digest("hex"),
      exit_status: result.status,
    },
  };
  mkdirSync(dirname(options.out), {recursive: true});
  writeFileSync(options.out, `${JSON.stringify(artifact, null, 2)}\n`, {flag: "wx", mode: 0o600});
  return options.out;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  try {
    process.stdout.write(`${run()}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
