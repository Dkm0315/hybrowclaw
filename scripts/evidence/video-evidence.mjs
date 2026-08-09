#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { emptyDraft, generateManifest, validateManifest } from "./video-evidence-model.mjs";

function usage() {
  return `Usage:
  node scripts/evidence/video-evidence.mjs init --out <draft.json>
  node scripts/evidence/video-evidence.mjs generate --input <draft.json> --out <manifest.json> [--repo-root <dir>]
  node scripts/evidence/video-evidence.mjs validate --manifest <manifest.json> [--repo-root <dir>] [--report <report.json>]
`;
}

function argumentsFor(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    if (!rest[index]?.startsWith("--") || rest[index + 1] === undefined) throw new Error(`Invalid argument: ${rest[index] ?? "(missing)"}`);
    options[rest[index].slice(2)] = rest[index + 1];
  }
  return { command, options };
}

async function jsonFile(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

async function writeJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

function required(options, name) {
  if (!options[name]) throw new Error(`--${name} is required`);
  return options[name];
}

try {
  const { command, options } = argumentsFor(process.argv.slice(2));
  const repoRoot = path.resolve(options["repo-root"] ?? process.cwd());
  if (command === "init") {
    const output = path.resolve(required(options, "out"));
    await writeJson(output, emptyDraft());
    process.stdout.write(`Empty evidence draft created: ${output}\nNo clips were fabricated.\n`);
  } else if (command === "generate") {
    const input = path.resolve(required(options, "input"));
    const output = path.resolve(required(options, "out"));
    const manifest = await generateManifest(await jsonFile(input), { repoRoot });
    await writeJson(output, manifest);
    const result = await validateManifest(manifest, { repoRoot });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\nManifest created: ${output}\n`);
    process.exitCode = result.valid ? 0 : 1;
  } else if (command === "validate") {
    const manifestPath = path.resolve(required(options, "manifest"));
    const result = await validateManifest(await jsonFile(manifestPath), { repoRoot });
    if (options.report) await writeJson(path.resolve(options.report), result);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.valid ? 0 : 1;
  } else {
    process.stderr.write(usage());
    process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usage()}`);
  process.exitCode = 2;
}
