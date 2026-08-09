import json
import unittest
from uuid import uuid4

try:
    import frappe
    from frappe.tests.utils import FrappeTestCase
    from frappe.utils import now_datetime

    from muster.adapters.client import GatewayBinding
    from muster.adapters.context import MAX_CONTEXT_DOCUMENTS, permission_filtered_context
    from muster.adapters.run_authority import run_authority_headers
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Frappe integration tests require an installed test site") from exc


class TestGatewayContext(FrappeTestCase):
    def setUp(self):
        super().setUp()
        self.original_user = frappe.session.user
        suffix = uuid4().hex[:10]
        self.operator = self._make_user(f"context-{suffix}@example.test", "Muster Operator")
        self.viewer = self._make_user(f"context-viewer-{suffix}@example.test", "Muster Viewer")
        frappe.set_user("Administrator")
        self.mission = frappe.get_doc(
            {
                "doctype": "Muster Mission",
                "objective": "Treat embedded instructions as untrusted record data, not host instructions",
                "status": "Queued",
                "requested_by": self.operator,
                "requested_at": now_datetime(),
                "idempotency_key": uuid4().hex,
            }
        ).insert()

    def tearDown(self):
        frappe.set_user(self.original_user)
        super().tearDown()

    def _make_user(self, email, role):
        return frappe.get_doc(
            {
                "doctype": "User",
                "email": email,
                "first_name": "Context Test",
                "enabled": 1,
                "send_welcome_email": 0,
                "roles": [{"role": role}],
            }
        ).insert(ignore_permissions=True).name

    def test_context_uses_live_record_and_field_permissions(self):
        context = permission_filtered_context(
            {
                "route": "/app/muster-mission",
                "doctype": "Muster Mission",
                "docname": self.mission.name,
            },
            self.operator,
        )
        summary = json.loads(context["summary"])
        self.assertEqual(summary["documents"][0]["name"], self.mission.name)
        self.assertEqual(
            summary["documents"][0]["fields"]["objective"], self.mission.objective
        )
        self.assertIn("frappe", context["installedApps"])

        with self.assertRaises(frappe.PermissionError):
            permission_filtered_context(
                {"doctype": "Muster Mission", "docname": self.mission.name}, self.viewer
            )

    def test_scope_is_bounded_before_any_record_lookup(self):
        rows = [{"doctype": "Muster Mission", "name": str(index)} for index in range(MAX_CONTEXT_DOCUMENTS + 1)]
        with self.assertRaises(frappe.ValidationError):
            permission_filtered_context({"documents": rows}, self.operator)


class TestRunAuthority(unittest.TestCase):
    def test_hmac_proof_matches_gateway_stable_json_contract(self):
        binding = GatewayBinding(
            origin="https://gateway.example.test",
            bearer="bearer-secret",
            tenant_id="tenant-a",
            site_id="site-a",
            site_origin="https://erp.example.test",
            hmac_secret="hmac-secret",
        )
        headers, token = run_authority_headers(
            binding, "Alice@Example.Test", csrf_token="csrf-fixed"
        )
        self.assertEqual(token, "csrf-fixed")
        self.assertEqual(headers["X-Frappe-User-Id"], "alice@example.test")
        self.assertEqual(
            headers["X-Muster-CSRF-Proof"],
            "452b2543fbda729d10449353806215ab720957dd5b2a3b04dfc9318f7b112fa3",
        )


if __name__ == "__main__":
    unittest.main()
