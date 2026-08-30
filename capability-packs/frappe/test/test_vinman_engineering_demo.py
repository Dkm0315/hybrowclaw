from __future__ import annotations

import contextlib
import io
import json
import os
import runpy
import sys
import types
import unittest
from pathlib import Path


FIXTURE = Path(__file__).parents[1] / "demo" / "vinman_engineering_demo.py"


class FakeDocument:
    def __init__(self, frappe, values):
        self._frappe = frappe
        self._values = dict(values)
        self.doctype = self._values["doctype"]
        self.name = self._values.get("name")
        self.docstatus = self._values.get("docstatus", 0)
        self.cancel_calls = 0

    def get(self, fieldname):
        return self._values.get(fieldname)

    def set(self, fieldname, value):
        self._values[fieldname] = value

    def insert(self, set_name=None):
        self.name = set_name or self._values.get("name")
        self._values.update({
            "name": self.name,
            "creation": self._values.get("creation", "2026-08-16 00:00:00"),
            "owner": self._values.get("owner", "Administrator"),
            "docstatus": self.docstatus,
        })
        self._frappe._records[(self.doctype, self.name)] = self
        return self

    def save(self):
        self._frappe._records[(self.doctype, self.name)] = self
        return self

    def cancel(self):
        self.cancel_calls += 1
        self.docstatus = 2
        self._values["docstatus"] = 2


class FakeMeta:
    def __init__(self, fields):
        self.fields = [types.SimpleNamespace(fieldname=fieldname) for fieldname in fields]

    def has_field(self, fieldname):
        return any(field.fieldname == fieldname for field in self.fields)


class FakeDB:
    def __init__(self, frappe):
        self._frappe = frappe
        self._defaults = {}

    def exists(self, doctype, name):
        return (doctype, name) in self._frappe._records

    def get_default(self, key):
        return self._defaults.get(key)

    def set_default(self, key, value):
        if value is None:
            self._defaults.pop(key, None)
        else:
            self._defaults[key] = value

    def get_value(self, doctype, name, fieldname):
        doc = self._frappe._records.get((doctype, name))
        return doc.get(fieldname) if doc else None

    def commit(self):
        return None

    def rollback(self):
        return None


class FakeFrappe(types.ModuleType):
    def __init__(self):
        super().__init__("frappe")
        self._records = {}
        self.db = FakeDB(self)
        self.session = types.SimpleNamespace(user="Administrator")
        self.ValidationError = type("ValidationError", (Exception,), {})
        self.PermissionError = type("PermissionError", (Exception,), {})
        self._fields = {
            "BOM": {
                "company", "item", "quantity", "currency", "conversion_rate", "routing",
                "custom_control_plan", "transfer_material_against", "items", "operations",
                "custom_costing_sheet",
            },
            "ToDo": {"description", "status", "priority", "reference_type", "reference_name"},
            "Client Script": {"dt", "view", "enabled", "script", "module"},
            "Report": {
                "report_name", "ref_doctype", "report_type", "is_standard",
                "disabled", "json", "query", "module",
            },
        }

    def get_meta(self, doctype):
        return FakeMeta(self._fields[doctype])

    def get_doc(self, doctype_or_values, name=None):
        if isinstance(doctype_or_values, dict):
            return FakeDocument(self, doctype_or_values)
        return self._records[(doctype_or_values, name)]

    def delete_doc(self, doctype, name):
        del self._records[(doctype, name)]


class VinmanScenarioLifecycleTest(unittest.TestCase):
    def setUp(self):
        self.frappe = FakeFrappe()
        self.previous_frappe = sys.modules.get("frappe")
        sys.modules["frappe"] = self.frappe

    def tearDown(self):
        if self.previous_frappe is None:
            sys.modules.pop("frappe", None)
        else:
            sys.modules["frappe"] = self.previous_frappe
        os.environ.pop("MUSTER_DEMO_SCENARIO", None)
        os.environ.pop("MUSTER_DEMO_ACTION", None)
        os.environ.pop("MUSTER_DEMO_CLAIM_EXISTING", None)

    def run_fixture(self, scenario, action):
        _namespace, result = self.run_fixture_namespace(scenario, action)
        return result

    def run_fixture_namespace(self, scenario, action):
        os.environ["MUSTER_DEMO_SCENARIO"] = scenario
        os.environ["MUSTER_DEMO_ACTION"] = action
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            namespace = runpy.run_path(str(FIXTURE), run_name="__main__")
        return namespace, json.loads(output.getvalue())

    def assert_reversible(self, scenario, finding_code):
        self.assertEqual(self.run_fixture(scenario, "reset")["state"], "absent")
        self.assertEqual(self.run_fixture(scenario, "setup")["state"], "baseline")
        self.assertEqual(self.run_fixture(scenario, "validate")["verdict"], "PASS")

        self.assertEqual(self.run_fixture(scenario, "fault")["state"], "faulted")
        fault_validation = self.run_fixture(scenario, "validate")
        self.assertEqual(fault_validation["verdict"], "FAIL")
        self.assertEqual([finding["code"] for finding in fault_validation["findings"]], [finding_code])

        self.assertEqual(self.run_fixture(scenario, "fault")["state"], "faulted")
        self.assertEqual(self.run_fixture(scenario, "correct")["state"], "baseline")
        self.assertEqual(self.run_fixture(scenario, "validate")["verdict"], "PASS")

        reset = self.run_fixture(scenario, "reset")
        self.assertEqual(reset["state"], "absent")
        self.assertFalse(reset["receipted"])
        self.assertFalse(any(record["exists"] for record in reset["records"]))
        self.assertEqual(self.run_fixture(scenario, "reset")["state"], "absent")

    def test_guided_workflow_is_reversible(self):
        self.assert_reversible("guided_workflow", "GUIDED_WORKFLOW_STEP_INCOMPLETE")
        baseline = self.run_fixture("guided_workflow", "setup")
        observed = baseline["observed"]["task"]
        self.assertEqual(observed["reference_type"], "DocType")
        self.assertEqual(observed["reference_name"], "Control Plan")
        self.run_fixture("guided_workflow", "reset")

    def test_authorized_customization_repair_is_reversible(self):
        self.assert_reversible(
            "authorized_customization_repair",
            "CUSTOMIZATION_RULE_REJECTS_VALID_REVISION",
        )

    def test_v15_to_v16_migration_is_reversible(self):
        self.assert_reversible("v15_to_v16_migration", "V16_REPORT_SCHEMA_REFERENCE_STALE")

    def test_setup_refuses_an_unreceipted_collision(self):
        FakeDocument(self.frappe, {
            "doctype": "Client Script",
            "dt": "Control Plan",
            "view": "Form",
            "enabled": 1,
            "script": "unrelated",
        }).insert(set_name="MUSTER-DEMO-VALIDATE-REVISED-OPERATION")
        with self.assertRaisesRegex(self.frappe.PermissionError, "Refusing to claim"):
            self.run_fixture("customization_repair", "setup")

    def test_persistent_receipt_rejects_owner_drift(self):
        self.run_fixture("customization_repair", "setup")
        record = self.frappe._records[("Client Script", "MUSTER-DEMO-VALIDATE-REVISED-OPERATION")]
        record._values["owner"] = "someone-else@example.test"
        with self.assertRaisesRegex(self.frappe.PermissionError, "ownership changed"):
            self.run_fixture("customization_repair", "setup")

    def test_reset_preserves_unrelated_namespaced_record(self):
        self.run_fixture("customization_repair", "setup")
        unrelated = FakeDocument(self.frappe, {
            "doctype": "Client Script",
            "dt": "Control Plan",
            "view": "Form",
            "enabled": 1,
            "script": "unrelated",
        }).insert(set_name="MUSTER-DEMO-UNRELATED-001")

        self.run_fixture("customization_repair", "reset")

        self.assertIn(("Client Script", unrelated.name), self.frappe._records)

    def test_reset_leaves_declared_record_without_receipt(self):
        namespace, _status = self.run_fixture_namespace("engineering_revision", "status")
        state = namespace["_state"]()
        bom = FakeDocument(self.frappe, {"doctype": "BOM"}).insert(set_name=state["bom"])
        unreceipted_item = FakeDocument(self.frappe, {"doctype": "Item"}).insert(
            set_name=state["item"]
        )
        namespace["_write_receipt"](state, [("bom", "BOM")], namespace["STATE_KEY"])

        namespace["_reset_records"](
            state,
            [("bom", "BOM"), ("item", "Item")],
            namespace["STATE_KEY"],
        )

        self.assertNotIn(("BOM", bom.name), self.frappe._records)
        self.assertIn(("Item", unreceipted_item.name), self.frappe._records)

    def test_receipt_does_not_authorize_unrelated_namespaced_record(self):
        namespace, _baseline = self.run_fixture_namespace("customization_repair", "setup")
        unrelated = FakeDocument(self.frappe, {
            "doctype": "Client Script",
            "dt": "Control Plan",
            "view": "Form",
            "enabled": 1,
            "script": "unrelated",
        }).insert(set_name="MUSTER-DEMO-UNRELATED-002")

        with self.assertRaisesRegex(self.frappe.PermissionError, "does not own"):
            namespace["_set_demo_values"](
                "Client Script",
                unrelated.name,
                {"script": "must not change"},
                namespace["CUSTOMIZATION_REPAIR_STATE_KEY"],
            )

    def test_bom_inputs_use_the_v16_lifecycle_without_live_custom_links(self):
        namespace, _status = self.run_fixture_namespace("engineering_revision", "status")
        state = namespace["_state"]()
        values = namespace["_bom_values"](state)
        self.assertIsNone(values["routing"])
        self.assertIsNone(values["custom_control_plan"])
        self.assertEqual(values["transfer_material_against"], "Work Order")
        self.assertIsNone(values["custom_costing_sheet"])

        bom = FakeDocument(self.frappe, {
            "doctype": "BOM",
            "docstatus": 1,
        }).insert(set_name=state["bom"])
        namespace["_write_receipt"](state, [("bom", "BOM")], namespace["STATE_KEY"])

        with self.assertRaisesRegex(self.frappe.PermissionError, "never submits or cancels BOMs"):
            namespace["_reset_records"](state, [("bom", "BOM")], namespace["STATE_KEY"])
        self.assertEqual(bom.cancel_calls, 0)
        self.assertIn(("BOM", state["bom"]), self.frappe._records)

    def test_three_revision_values_do_not_make_partial_fixture_baseline(self):
        namespace, _status = self.run_fixture_namespace("engineering_revision", "status")
        state = namespace["_state"]()
        FakeDocument(self.frappe, {
            "doctype": "Process Flow",
            "drawing_review_no": "B",
            "process_table": [{"process_name": "Bending"}],
        }).insert(set_name=state["process_flow"])
        FakeDocument(self.frappe, {
            "doctype": "PPFMEA",
            "drawing_review_no": "B",
            "ppfmea_child_table": [{"process_name": "Bending"}],
        }).insert(set_name=state["ppfmea"])
        FakeDocument(self.frappe, {
            "doctype": "Part Submission Warrant",
            "eng_change_level": "B",
        }).insert(set_name=state["ppap"])

        observed = namespace["status"]()

        self.assertEqual(observed["state"], "invalid")
        self.assertFalse(observed["receipted"])


if __name__ == "__main__":
    unittest.main()
