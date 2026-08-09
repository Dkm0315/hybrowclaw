import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repo = path.resolve(import.meta.dirname, "../../..");
const fixture = JSON.parse(fs.readFileSync(path.join(
  repo, "frappe_app/muster/demo/fixtures/frappeverse_lifecycle_orm_jinja_scenario.json",
), "utf8"));
const helper = fs.readFileSync(path.join(
  repo, "frappe_app/muster/demo/customization_ladder_live.py",
), "utf8");

test("lifecycle scenario binds one fixed hook, ORM boundary and escaped Jinja artifact", () => {
  assert.equal(fixture.scenario_id, "CODE-LIFECYCLE-ORM-JINJA-01");
  assert.equal(fixture.registered_app, "field_ops_demo");
  assert.deepEqual(fixture.source_citations, ["CL002", "CL003", "CL006", "CL007"]);
  assert.deepEqual(fixture.doc_event, {
    doctype: "Service Visit",
    event: "on_update",
    handler: "field_ops_demo.automation.service_visit.update_customer_snapshot",
  });
  assert.equal(fixture.orm_contract.no_raw_sql, true);
  assert.match(fixture.orm_contract.read, /permission filtering/);
  assert.match(fixture.orm_contract.write, /frappe\.db\.set_value/);
  assert.equal(fixture.jinja_contract.surface, "Print Format");
  assert.equal(fixture.jinja_contract.escaping, "Jinja | e filter");
  assert.equal(fixture.jinja_contract.unsafe_globals, false);
});

test("generated patch is constrained to five registered-app paths and disposable names", () => {
  assert.equal(fixture.request_id, "track3-live-lifecycle-orm-jinja-v5");
  assert.deepEqual(fixture.allowed_paths, [
    "field_ops_demo/hooks.py",
    "field_ops_demo/automation/__init__.py",
    "field_ops_demo/automation/service_visit.py",
    "field_ops_demo/fixtures/muster_demo_service_visit_brief.json",
    "field_ops_demo/tests/test_service_visit_automation.py",
  ]);
  for (const allowed of fixture.allowed_paths) {
    assert.equal(path.isAbsolute(allowed), false);
    assert.equal(allowed.split("/").includes(".."), false);
  }
  assert.match(fixture.disposable.customer_prefix, /^Muster Demo/);
  assert.match(fixture.disposable.visit_prefix, /^Muster Demo/);
  assert.equal(fixture.disposable.print_format, "Muster Demo Service Visit Brief");
  assert.doesNotMatch(JSON.stringify(fixture), /erpnext\/|crm\/|helpdesk\//);
});

test("preparation emits review and rollback evidence without applying or deploying", () => {
  assert.match(helper, /def prepare_lifecycle_orm_jinja_case/);
  assert.match(helper, /generate_reviewed_patch\([\s\S]*LIFECYCLE_ALLOWED/);
  assert.match(helper, /"kind": "registered_app_customization_review"/);
  assert.match(helper, /"effects_executed": False/);
  assert.match(helper, /receipt_hash/);
  assert.match(helper, /"rollback_status": "Not Requested"/);
  assert.match(helper, /"deployment_status": "Not Requested"/);
  assert.doesNotMatch(helper, /subprocess|bench migrate|bench build|bench restart/);
  assert.doesNotMatch(helper, /"outcomes_json": "\[\]"/);
  assert.equal((helper.match(/"outcomes_json": '\["development_workflow"\]'/g) || []).length, 2);
  assert.match(helper, /development_scope_json = json\.dumps\([\s\S]*?sort_keys=True, separators=\(",", ":"\)/);
  assert.match(helper, /scope_json = json\.dumps\(scope, sort_keys=True, separators=\(",", ":"\)\)/);
  assert.match(helper, /def _ensure_development_authority\(\)/);
  assert.equal((helper.match(/checker = _ensure_development_authority\(\)/g) || []).length, 3);
  assert.match(helper, /merged = set\(filter\(None,[\s\S]*?\| required/);
  assert.doesNotMatch(helper, /if set\(\(binding\.capabilities or ""\)\.splitlines\(\)\) != set\(CAPABILITIES\)/);
  assert.deepEqual(Object.values(fixture.rollback).slice(0, 3), [
    "muster.api.development.request_rollback",
    "muster.api.development.review_rollback",
    "muster.api.development.rollback",
  ]);
});

test("fixed generated implementation covers idempotency, ORM reread and Jinja escaping", () => {
  assert.match(helper, /\(automation \/ "__init__\.py"\)\.write_text\("", encoding="utf-8"\)/);
  assert.match(helper, /frappe\.get_list\(/);
  assert.match(helper, /fields=\[\\"customer_name\\"\], limit=1/);
  assert.doesNotMatch(helper, /limit_page_length/);
  assert.match(helper, /filters=\{\\"name\\": doc\.customer\}/);
  assert.match(helper, /frappe\.db\.set_value\(/);
  assert.match(helper, /getattr\(doc\.flags, \\"in_insert\\", False\)/);
  assert.match(helper, /assertNotIn\(MARKER_PREFIX, inserted\)/);
  assert.match(helper, /not line\.startswith\(MARKER_PREFIX\)/);
  assert.match(helper, /first\.count\(MARKER_PREFIX\), 1/);
  assert.match(helper, /second\.count\(MARKER_PREFIX\), 1/);
  assert.match(helper, /doc\.notes or ""\) \| e/);
  assert.equal(helper.includes('\\"customer_group\\": \\"Frappeverse Customers\\"'), true);
  assert.match(helper, /assertNotIn\(\\"<b>\\", rendered\)/);
  assert.match(helper, /assertIn\(\\"&lt;b&gt;Muster Evidence&lt;\/b&gt;\\", rendered\)/);
});
