import unittest
from datetime import datetime, timezone
from uuid import uuid4

try:
    import frappe
    from frappe.tests.utils import FrappeTestCase
    from frappe.utils import now_datetime

    from muster.api.native_builder import _approval_time, apply, prepare_attended, preview
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Frappe integration tests require an installed test site") from exc


class TestNativeBuilderAPI(FrappeTestCase):
    def setUp(self):
        super().setUp()
        self.original_user = frappe.session.user
        frappe.set_user("Administrator")
        self.suffix = uuid4().hex[:10]
        self.mission = frappe.get_doc(
            {
                "doctype": "Muster Mission",
                "objective": "Prove that native artifact plans remain preview-only until approval",
                "status": "Queued",
                "requested_by": "Administrator",
                "requested_at": now_datetime(),
                "idempotency_key": f"native-api-{self.suffix}",
            }
        ).insert().name

    def tearDown(self):
        frappe.set_user(self.original_user)
        super().tearDown()

    def _intent(self):
        return {
            "schema_version": "1.0",
            "mission": self.mission,
            "artifacts": [
                {
                    "artifact_id": f"field-{self.suffix}",
                    "kind": "custom_field",
                    "target_name": f"muster_test_{self.suffix}",
                    "target_doctype": "Muster Mission",
                    "idempotency_key": f"native-api-field-{self.suffix}",
                    "values": {"label": "Muster Test Evidence", "fieldtype": "Data"},
                }
            ],
        }

    def _grant_preview(self):
        frappe.get_doc(
            {
                "doctype": "Muster Role Binding",
                "subject_type": "User",
                "subject": "Administrator",
                "scope_type": "Site",
                "scope_value": frappe.local.site,
                "status": "Active",
                "capabilities": "artifact.custom_field.write",
            }
        ).insert()
        return frappe.get_doc(
            {
                "doctype": "Muster Policy",
                "policy_name": f"Native API Preview {self.suffix}",
                "enabled": 1,
                "priority": 10,
                "rules": [
                    {
                        "effect": "Allow",
                        "capability": "artifact.custom_field.write",
                        "action": "propose",
                        "resource_type": "Site",
                        "resource_pattern": frappe.local.site,
                        "approval_class": "Standard",
                    },
                    {
                        "effect": "Allow",
                        "capability": "artifact.custom_field.write",
                        "action": "apply",
                        "resource_type": "Site",
                        "resource_pattern": frappe.local.site,
                        "approval_class": "Standard",
                    },
                ],
            }
        ).insert()

    def test_site_local_approval_time_is_serialized_with_timezone(self):
        serialized = _approval_time(now_datetime())
        parsed = datetime.fromisoformat(serialized)
        self.assertIsNotNone(parsed.tzinfo)
        self.assertLess(abs((datetime.now(timezone.utc) - parsed.astimezone(timezone.utc)).total_seconds()), 10)

    def test_preview_uses_live_actor_and_creates_no_native_effect(self):
        self._grant_preview()
        result = preview(self._intent())
        self.assertEqual(result["approval_class"], "Standard")
        self.assertTrue(frappe.db.exists("Muster Change Set", result["change_set"]))
        self.assertFalse(
            frappe.db.exists(
                "Custom Field", f"Muster Mission-muster_test_{self.suffix}"
            )
        )
        attended = prepare_attended(result["change_set"], confirmed=1)
        self.assertEqual(attended["artifact_kind"], "custom_field")
        self.assertEqual(attended["doctype"], "Custom Field")
        self.assertFalse(attended["apply_authorized"])
        self.assertFalse(attended["executed"])
        self.assertIn("fieldname", {row["fieldname"] for row in attended["fields"]})
        with self.assertRaises(frappe.PermissionError):
            apply(result["change_set"])
        self.assertFalse(
            frappe.db.exists(
                "Custom Field", f"Muster Mission-muster_test_{self.suffix}"
            )
        )

    def test_caller_cannot_inject_actor_site_or_authority(self):
        intent = self._intent()
        intent["actor"] = "Guest"
        before = frappe.db.count("Muster Change Set", {"mission": self.mission})
        with self.assertRaises(frappe.ValidationError):
            preview(intent)
        self.assertEqual(
            frappe.db.count("Muster Change Set", {"mission": self.mission}), before
        )

    def test_default_deny_has_zero_change_set_or_native_effect(self):
        before = frappe.db.count("Muster Change Set", {"mission": self.mission})
        with self.assertRaises(frappe.PermissionError):
            preview(self._intent())
        self.assertEqual(
            frappe.db.count("Muster Change Set", {"mission": self.mission}), before
        )
        self.assertFalse(
            frappe.db.exists(
                "Custom Field", f"Muster Mission-muster_test_{self.suffix}"
            )
        )
