import assert from "node:assert/strict";
import path from "node:path";
import {spawnSync} from "node:child_process";
import test from "node:test";

const repo = path.resolve(import.meta.dirname, "../../..");
const checker = path.join(repo, "scripts/evidence/frappe-customization-ladder.mjs");

test("customization and coding ladder contract is executable and complete", () => {
  const result = spawnSync(process.execPath, [checker], {encoding: "utf8"});
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.nativeCases, 11);
  assert.deepEqual(report.nativeKinds, [
    "custom_field", "property_setter", "doctype", "query_report", "script_report",
    "print_format", "page", "web_page", "client_script", "server_script", "email_template",
  ]);
  assert.deepEqual(report.codingLevels, [
    {id: "CODE-BEGINNER-01", level: "beginner", paths: 5},
    {id: "CODE-DOC-EVENTS-01", level: "intermediate", paths: 4},
    {id: "CODE-ORM-01", level: "advanced", paths: 3},
    {id: "CODE-JS-01", level: "advanced", paths: 4},
    {id: "CODE-MIGRATION-JOB-01", level: "advanced", paths: 6},
  ]);
  assert.deepEqual(report.negativeProbes, [
    "NEG-AUTHORITY", "NEG-PATH", "NEG-SECRET", "NEG-DRIFT",
    "NEG-INJECTION", "NEG-PERMISSION", "NEG-DEPLOY",
  ]);
  assert.equal(report.liveVisualProofRequired.length, 4);
});
