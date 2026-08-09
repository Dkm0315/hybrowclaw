import unittest
from uuid import uuid4

try:
    import frappe
    from frappe.tests.utils import FrappeTestCase
    from frappe.utils import add_to_date, now_datetime
except ModuleNotFoundError as exc:  # Pure package checks run without a Bench environment.
    raise unittest.SkipTest("Frappe integration tests require an installed test site") from exc


class TestMusterSecurity(FrappeTestCase):
    def setUp(self):
        super().setUp()
        self.original_user = frappe.session.user
        suffix = uuid4().hex[:10]
        self.operator = self._make_user(f"operator-{suffix}@example.test", "Muster Operator")
        self.viewer = self._make_user(f"viewer-{suffix}@example.test", "Muster Viewer")
        self.auditor = self._make_user(f"auditor-{suffix}@example.test", "Muster Auditor")
        self.approver = self._make_user(f"approver-{suffix}@example.test", "Muster Approver")

    def tearDown(self):
        frappe.set_user(self.original_user)
        super().tearDown()

    def _make_user(self, email: str, role: str) -> str:
        user = frappe.get_doc(
            {
                "doctype": "User",
                "email": email,
                "first_name": "Muster Test",
                "enabled": 1,
                "send_welcome_email": 0,
                "roles": [{"role": role}],
            }
        )
        user.insert(ignore_permissions=True)
        return user.name

    def test_cross_user_mission_is_denied(self):
        frappe.set_user(self.operator)
        mission = frappe.get_doc(
            {
                "doctype": "Muster Mission",
                "objective": "Verify that another tenant principal cannot inspect this mission",
                "status": "Queued",
                "requested_by": self.operator,
                "requested_at": now_datetime(),
                "idempotency_key": uuid4().hex,
            }
        ).insert()

        self.assertTrue(mission.has_permission("read", user=self.operator))
        self.assertFalse(mission.has_permission("read", user=self.viewer))
        frappe.set_user(self.viewer)
        visible = frappe.get_list(
            "Muster Mission", filters={"name": mission.name}, pluck="name"
        )
        self.assertEqual(visible, [])

    def test_auditor_can_read_but_cannot_mutate_mission(self):
        frappe.set_user("Administrator")
        mission = frappe.get_doc(
            {
                "doctype": "Muster Mission",
                "objective": "Prove that the audit role remains read-only for mission records",
                "status": "Queued",
                "requested_by": self.operator,
                "requested_at": now_datetime(),
                "idempotency_key": uuid4().hex,
            }
        ).insert()

        self.assertTrue(mission.has_permission("read", user=self.auditor))
        self.assertFalse(mission.has_permission("write", user=self.auditor))
        self.assertFalse(mission.has_permission("delete", user=self.auditor))

    def test_approver_cannot_self_approve(self):
        frappe.set_user("Administrator")
        change_set = frappe.get_doc(
            {
                "doctype": "Muster Change Set",
                "mission": self._make_mission(),
                "status": "Awaiting Approval",
                "risk_class": "High",
                "approval_class": "Sensitive",
                "target_site": frappe.local.site,
                "actor": self.operator,
                "permission_epoch": "test-epoch",
                "plan_hash": "0" * 64,
                "operations": [
                    {
                        "operation_id": "op-1",
                        "operation_type": "update_record",
                        "target_doctype": "ToDo",
                        "idempotency_key": uuid4().hex,
                    }
                ],
            }
        ).insert(ignore_permissions=True)
        approval = frappe.get_doc(
            {
                "doctype": "Muster Approval",
                "mission": change_set.mission,
                "change_set": change_set.name,
                "status": "Approved",
                "approval_class": "Sensitive",
                "requested_by": self.operator,
                "requested_from": self.operator,
                "action_hash": "0" * 64,
            }
        )
        frappe.set_user(self.operator)
        with self.assertRaises(frappe.ValidationError):
            approval.insert(ignore_permissions=True)

    def test_destructive_approval_does_not_regress_verified_change_set(self):
        frappe.set_user("Administrator")
        change_set = frappe.get_doc({
            "doctype": "Muster Change Set", "mission": self._make_mission(),
            "status": "Verified", "risk_class": "Critical",
            "approval_class": "Sensitive", "target_site": frappe.local.site,
            "actor": self.operator, "permission_epoch": "test-epoch",
            "plan_hash": "1" * 64,
            "operations": [{
                "operation_id": "verified-op-1",
                "operation_type": "update_record",
                "target_doctype": "ToDo",
                "idempotency_key": uuid4().hex,
            }],
        }).insert(ignore_permissions=True)
        approval = frappe.get_doc({
            "doctype": "Muster Approval", "mission": change_set.mission,
            "change_set": change_set.name, "status": "Pending",
            "approval_class": "Destructive", "requested_by": self.operator,
            "requested_from": self.approver, "action_hash": "1" * 64,
            "expires_at": add_to_date(now_datetime(), minutes=10),
        }).insert(ignore_permissions=True)
        frappe.set_user(self.approver)
        approval.status = "Approved"
        approval.save(ignore_permissions=True)

        self.assertEqual(frappe.db.get_value("Muster Change Set", change_set.name, "status"), "Verified")

    def _make_mission(self) -> str:
        return frappe.get_doc(
            {
                "doctype": "Muster Mission",
                "objective": "Prepare an approval test without executing any business effect",
                "status": "Waiting for Approval",
                "requested_by": self.operator,
                "requested_at": now_datetime(),
                "idempotency_key": uuid4().hex,
            }
        ).insert(ignore_permissions=True).name
