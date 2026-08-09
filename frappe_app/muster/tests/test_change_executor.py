import json
import unittest
from uuid import uuid4

try:
    import frappe
    from frappe.tests.utils import FrappeTestCase
    from frappe.utils import now_datetime
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Frappe integration tests require an installed test site") from exc

from muster.change_ir.executor import apply_document, preflight
from muster.change_ir.schema import ChangeSet
from muster.change_ir.security import permission_epoch, schema_revision


class TestGovernedChangeExecutor(FrappeTestCase):
    def setUp(self):
        super().setUp()
        self.original_user = frappe.session.user
        frappe.set_user("Administrator")

    def tearDown(self):
        frappe.set_user(self.original_user)
        super().tearDown()

    def _mission(self, requested_by="Administrator"):
        return frappe.get_doc({
            "doctype": "Muster Mission",
            "objective": "Exercise the governed change executor with reversible evidence",
            "status": "Running",
            "requested_by": requested_by,
            "requested_at": now_datetime(),
            "idempotency_key": uuid4().hex,
        }).insert().name

    def _change_set(self, payload, mission):
        compiled = ChangeSet.from_dict(payload)
        plan_hash = compiled.canonical_hash()
        return frappe.get_doc({
            "doctype": "Muster Change Set",
            "mission": mission,
            "status": "Preflighted",
            "risk_class": "Low",
            "approval_class": "None",
            "target_site": frappe.local.site,
            "actor": payload["actor"],
            "permission_epoch": payload["permission_epoch"],
            "schema_revision": schema_revision(),
            "plan_hash": plan_hash,
            "operations": [{
                "operation_id": operation["operation_id"],
                "operation_type": operation["kind"],
                "target_doctype": operation["target_doctype"],
                "target_name": operation.get("target_name"),
                "approval_class": operation.get("approval_class", "None"),
                "after_json": json.dumps(operation.get("values") or {}),
                "concurrency_token": operation.get("concurrency_token"),
                "idempotency_key": operation["idempotency_key"],
                "postcondition_json": json.dumps({"depends_on": operation.get("depends_on", [])}),
            } for operation in payload["operations"]],
        }).insert()

    def test_record_update_is_preflighted_applied_verified_and_idempotent(self):
        todo = frappe.get_doc({"doctype": "ToDo", "description": "Muster executor proof"}).insert()
        payload = {
            "schema_version": "1.0",
            "target_site": frappe.local.site,
            "actor": "Administrator",
            "permission_epoch": permission_epoch("Administrator"),
            "operations": [{
                "operation_id": "close-todo",
                "kind": "update_record",
                "target_doctype": "ToDo",
                "target_name": todo.name,
                "values": {"status": "Closed"},
                "concurrency_token": str(todo.modified),
                "idempotency_key": uuid4().hex,
                "approval_class": "None",
            }],
        }
        evidence = preflight(ChangeSet.from_dict(payload))
        self.assertTrue(evidence["checks"][0]["allowed"])
        change_set = self._change_set(payload, self._mission())
        result = apply_document(change_set.name)
        self.assertEqual(result["status"], "Verified")
        self.assertEqual(frappe.db.get_value("ToDo", todo.name, "status"), "Closed")
        self.assertEqual(apply_document(change_set.name)["receipts"], result["receipts"])

    def test_permission_epoch_change_fails_before_effect(self):
        suffix = uuid4().hex[:8]
        user = frappe.get_doc({
            "doctype": "User", "email": f"viewer-{suffix}@example.test",
            "first_name": "Muster Viewer", "enabled": 1, "send_welcome_email": 0,
            "roles": [{"role": "Muster Viewer"}],
        }).insert()
        payload = {
            "schema_version": "1.0", "target_site": frappe.local.site, "actor": user.name,
            "permission_epoch": permission_epoch(user.name),
            "operations": [{
                "operation_id": "forbidden-user", "kind": "create_record",
                "target_doctype": "User", "values": {"email": f"blocked-{suffix}@example.test"},
                "idempotency_key": uuid4().hex, "approval_class": "None",
            }],
        }
        user.add_roles("Muster Operator")
        with self.assertRaisesRegex(Exception, "permissions changed"):
            preflight(ChangeSet.from_dict(payload))
        self.assertFalse(frappe.db.exists("User", f"blocked-{suffix}@example.test"))
