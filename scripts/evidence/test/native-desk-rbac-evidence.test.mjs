import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import test from "node:test";

import {benchKwargs, parseArgs, parseBenchEvidence, validateEvidence} from "../native-desk-rbac-evidence.mjs";

function evidence(overrides = {}) {
  const item = (operation) => ({
    proposal: `MST-WFP-${operation.toUpperCase()}`,
    operation,
    doctype: "Customer",
    record_name: `DISPOSABLE-${operation.toUpperCase()}`,
    record_revision: "2026-07-20 10:11:12.123456",
    maker: "maker@example.test",
    checker: "checker@example.test",
    maker_checker_distinct: true,
    maker_self_approval_denied: true,
    checker_preview_denied: true,
    stale_revision_denied: true,
    denied_user_blocked: true,
    executed: false,
  });
  const result = {
    schema_version: 1,
    kind: "muster.native_desk.exact_record_rbac",
    site: "demo.test",
    captured_at: "2026-07-20 10:11:12.123456",
    read_only: true,
    cases: [item("update"), item("delete")],
    ...overrides,
  };
  const canonical = (value) => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
    return JSON.stringify(value);
  };
  result.evidence_sha256 = createHash("sha256").update(canonical(result)).digest("hex");
  return result;
}

test("parses an injection-safe explicit bench evidence invocation", () => {
  const result = parseArgs([
    "--bench", "/tmp/frappe-bench", "--site", "demo.test",
    "--update", "MST-WFP-U", "--delete", "MST-WFP-D", "--denied", "auditor@example.test",
  ]);
  assert.equal(result.bench, "/tmp/frappe-bench");
  assert.equal(result.site, "demo.test");
  assert.equal(result.denied, "auditor@example.test");
  assert.throws(() => parseArgs(["--bench", "/tmp", "--site", "demo.test"]), /Missing --update/);
  assert.throws(() => parseArgs(["--bench", "/tmp", "--bench", "/other"]), /repeated/);
  assert.deepEqual(benchKwargs(result), {
    update_proposal: "MST-WFP-U", delete_proposal: "MST-WFP-D",
    denied_user: "auditor@example.test", confirm: 1,
  });
  assert.equal(JSON.stringify(benchKwargs({...result, denied: null})).includes("null"), false);
  assert.equal(JSON.stringify(benchKwargs({...result, denied: null})).includes("true"), false);
});

test("extracts either direct or Frappe-wrapped JSON after bounded bench logs", () => {
  const value = evidence();
  assert.deepEqual(parseBenchEvidence(`informational line\n${JSON.stringify(value)}\n`), value);
  assert.deepEqual(parseBenchEvidence(JSON.stringify({message: value})), value);
  assert.throws(() => parseBenchEvidence("not evidence"), /did not return/);
});

test("rejects mutable, same-person, stale-accepting, or incomplete evidence", () => {
  assert.equal(validateEvidence(evidence()).read_only, true);
  assert.throws(() => validateEvidence(evidence({read_only: false})), /wrong kind/);
  const samePerson = evidence();
  samePerson.cases[0].checker = samePerson.cases[0].maker;
  assert.throws(() => validateEvidence(samePerson), /Incomplete fail-closed/);
  const acceptsStale = evidence();
  acceptsStale.cases[1].stale_revision_denied = false;
  assert.throws(() => validateEvidence(acceptsStale), /Incomplete fail-closed/);
  const deniedAllowed = evidence();
  deniedAllowed.cases[0].denied_user_blocked = false;
  assert.throws(() => validateEvidence(deniedAllowed), /retained authority/);
  const tampered = evidence();
  tampered.site = "other.test";
  assert.throws(() => validateEvidence(tampered), /does not match/);
});
