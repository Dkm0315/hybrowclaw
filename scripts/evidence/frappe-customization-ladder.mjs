#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const repo = path.resolve(import.meta.dirname, "../..");
const fixtures = path.join(repo, "frappe_app/muster/demo/fixtures");

function load(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtures, name), "utf8"));
}

function fail(message) {
  throw new Error(`customization ladder contract failed: ${message}`);
}

function equalSet(actual, expected, label) {
  const left = [...new Set(actual)].sort();
  const right = [...new Set(expected)].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) fail(`${label}: ${JSON.stringify(left)}`);
}

function verifyCitations(documentName, rows) {
  const lines = fs.readFileSync(path.join(fixtures, documentName), "utf8").split(/\r?\n/);
  for (const row of rows) {
    const match = /^line:(\d+)$/.exec(row.locator);
    if (!match || !lines[Number(match[1]) - 1]?.trim()) fail(`invalid citation ${row.id}`);
  }
  return lines.length;
}

const native = load("attended_native_customization_matrix.json");
const service = load("frappeverse_service_intake_scenarios.json");
const ladder = load("frappeverse_coding_ladder_scenario.json");
const lifecycle = load("frappeverse_lifecycle_orm_jinja_scenario.json");

equalSet(native.cases.map((row) => row.artifact.kind), [
  "custom_field", "property_setter", "doctype", "query_report", "script_report",
  "print_format", "page", "web_page", "client_script", "server_script", "email_template",
], "attended native kinds");
equalSet(ladder.levels.map((row) => row.level), ["beginner", "intermediate", "advanced"], "coding levels");
for (const endpoint of ["prepare", "review", "generate", "apply", "request_rollback", "review_rollback", "rollback", "deployment_review"]) {
  if (!ladder.contract[endpoint]?.startsWith("muster.api.development.")) fail(`development endpoint missing ${endpoint}`);
}

for (const row of native.cases) {
  if (row.artifact.source_citations?.length !== 1 || row.artifact.source_citations[0] !== row.citation) {
    fail(`native citation mismatch ${row.id}`);
  }
  if (!row.expected_form_fields?.length) fail(`native form projection missing ${row.id}`);
}
for (const level of ladder.levels) {
  if (!level.allowed_paths?.length || !level.source_citations?.length) fail(`incomplete coding level ${level.id}`);
  for (const citation of level.source_citations) {
    if (!ladder.requirements.some((row) => row.id === citation)) fail(`unknown citation ${citation}`);
  }
  if (!level.verify?.length || !level.rollback) fail(`missing lifecycle evidence ${level.id}`);
  for (const allowed of level.allowed_paths) {
    if (allowed.startsWith("/") || allowed.split("/").includes("..")) fail(`unsafe allowed path ${allowed}`);
  }
}

const serviceLines = verifyCitations(service.source_file, service.requirements);
const ladderLines = verifyCitations(ladder.source_file, ladder.requirements);
const authority = ladder.requirements.find((row) => row.id === "CL008");
if (!authority?.must_be_rejected_as_authority) fail("negative authority instruction is not rejected");
if (!ladder.negative_probes.some((row) => row.id === "NEG-DRIFT")) fail("post-apply drift probe missing");
if (!ladder.negative_probes.some((row) => row.id === "NEG-DEPLOY")) fail("deployment fail-closed probe missing");

const scriptReport = native.cases.find((row) => row.artifact.kind === "script_report");
if (scriptReport?.artifact.values.implementation_key !== "customer-service-coverage-v1") {
  fail("Script Report does not select the installed trusted key");
}
const hooks = fs.readFileSync(path.join(repo, "frappe_app/muster/hooks.py"), "utf8");
if (!hooks.includes("script_report.customer-service-coverage-v1")) fail("trusted Script Report hook missing");

if (lifecycle.registered_app !== "field_ops_demo") fail("lifecycle app boundary changed");
equalSet(lifecycle.source_citations, ["CL002", "CL003", "CL006", "CL007"], "lifecycle citations");
equalSet(lifecycle.allowed_paths, [
  "field_ops_demo/hooks.py",
  "field_ops_demo/automation/__init__.py",
  "field_ops_demo/automation/service_visit.py",
  "field_ops_demo/fixtures/muster_demo_service_visit_brief.json",
  "field_ops_demo/tests/test_service_visit_automation.py",
], "lifecycle allowed paths");
if (lifecycle.doc_event.event !== "on_update" || !lifecycle.doc_event.handler.startsWith("field_ops_demo.")) {
  fail("bounded lifecycle hook missing");
}
if (!lifecycle.orm_contract.no_raw_sql || lifecycle.jinja_contract.unsafe_globals) fail("unsafe lifecycle contract");
for (const endpoint of ["request", "review", "execute"]) {
  if (!lifecycle.rollback[endpoint]?.startsWith("muster.api.development.")) fail(`rollback endpoint missing ${endpoint}`);
}

const report = {
  ok: true,
  contract: "frappeverse-customization-coding-ladder-v1",
  nativeCases: native.cases.length,
  nativeKinds: native.cases.map((row) => row.artifact.kind),
  codingLevels: ladder.levels.map((row) => ({id: row.id, level: row.level, paths: row.allowed_paths.length})),
  citations: {service: service.requirements.length, serviceLines, coding: ladder.requirements.length, ladderLines},
  negativeProbes: ladder.negative_probes.map((row) => row.id),
  lifecycleOrmJinja: {
    scenarioId: lifecycle.scenario_id,
    app: lifecycle.registered_app,
    docEvent: lifecycle.doc_event,
    allowedPaths: lifecycle.allowed_paths,
    printFormat: lifecycle.disposable.print_format,
    orm: lifecycle.orm_contract,
    rollback: lifecycle.rollback,
    preparationReceipt: "private registered_app_customization_review JSON; effects_executed=false",
  },
  liveVisualProofRequired: [
    "continuous labelled cursor on every native form",
    "unsaved pause then approved apply and independent reread",
    "rendered Query and Script Reports, Print Format, Desk Page and Web Page",
    "isolated patch review, source apply, drift refusal and exact rollback",
  ],
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
