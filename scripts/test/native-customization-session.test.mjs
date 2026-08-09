import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../../frappe_app/muster/public/js/native_customization_session.js", import.meta.url),
  "utf8",
);
const context = {window: {}, console, setTimeout, clearTimeout};
vm.createContext(context);
vm.runInContext(source, context);
const {projection, projectedValue, requiresFullFormBypass, SUPPORTED} = context.window.MusterNativeCustomizationModel;

function receipt(kind = "custom_field") {
  return {
    schema_version: 1,
    change_set: "MST-CHG-2026-00001",
    plan_hash: "a".repeat(64),
    operation: "create",
    artifact_kind: kind,
    doctype: "Custom Field",
    document_name: "Customer-muster_service_region",
    approval_class: "Sensitive",
    apply_authorized: true,
    executed: false,
    source_evidence_hash: "b".repeat(64),
    source_citations: [{
      file_id: "FILE-SOURCE-1", requirement_id: "R001", locator: "line:3",
      quote_hash: "c".repeat(64),
    }],
    fields: [{fieldname: "label", label: "Label", fieldtype: "Data", value: "Service Region"}],
  };
}

test("all attended native customization kinds accept one source-bound real-form projection", () => {
  for (const kind of SUPPORTED) {
    const result = projection(receipt(kind));
    assert.equal(result.kind, kind);
    assert.equal(result.citations[0].requirement_id, "R001");
    assert.equal(result.fields[0].value, "Service Region");
  }
});

test("projection rejects unsupported surfaces, invalid citations, secrets, and empty mutations", () => {
  assert.throws(() => projection({...receipt(), artifact_kind: "workspace"}));
  assert.throws(() => projection({...receipt(), source_citations: [{
    ...receipt().source_citations[0], file_id: "FILE-OTHER", requirement_id: "not-stable",
  }]}));
  assert.throws(() => projection({...receipt(), fields: []}));
  assert.throws(() => projection({...receipt(), fields: [{
    fieldname: "password", label: "Password", fieldtype: "Password", value: "secret",
  }]}));
});

test("table verification ignores Frappe child-row bookkeeping but detects business drift", () => {
  const field = {
    fieldname: "roles", label: "Roles", fieldtype: "Table",
    value: [{role: "System Manager"}],
  };
  assert.deepEqual(
    JSON.parse(JSON.stringify(projectedValue(field, [{role: "System Manager", name: "new-row-1", idx: 1}]))),
    [{role: "System Manager"}],
  );
  assert.notDeepEqual(
    JSON.parse(JSON.stringify(projectedValue(field, [{role: "Sales User", name: "new-row-1"}]))),
    field.value,
  );
});

test("rollback projection carries citations but no mutable form fields", () => {
  const value = receipt("print_format");
  value.operation = "rollback";
  value.fields = [];
  value.approval_class = "Destructive";
  const result = projection(value, "rollback");
  assert.equal(result.operation, "rollback");
  assert.equal(result.citations[0].locator, "line:3");
});

test("DocType creation bypasses Quick Entry while other native kinds keep normal new-doc routing", () => {
  assert.equal(requiresFullFormBypass("doctype", "DocType"), true);
  assert.equal(requiresFullFormBypass("doctype", "Unexpected projection label"), true);
  assert.equal(requiresFullFormBypass("custom_field", "Custom Field"), false);
  assert.equal(requiresFullFormBypass("property_setter", "Property Setter"), false);
});

test("native form review is a direct top-level action, not an inert grouped dropdown", () => {
  const changeSetSource = readFileSync(
    new URL("../../frappe_app/muster/muster/doctype/muster_change_set/muster_change_set.js", import.meta.url),
    "utf8",
  );
  let handlers;
  const buttons = [];
  const changeSetContext = {
    window: {musterNativeCustomization: {start() { return Promise.resolve(); }}},
    __: (value) => value,
    frappe: {
      session: {user: "Administrator"},
      ui: {form: {on(_doctype, value) { handlers = value; }}},
    },
  };
  vm.createContext(changeSetContext);
  vm.runInContext(changeSetSource, changeSetContext);
  handlers.refresh({
    is_new: () => false,
    doc: {actor: "Administrator", status: "Approved"},
    add_custom_button(...args) { buttons.push(args); },
  });
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0][0], "Open native form review");
  assert.equal(buttons[0].length, 2);
});
