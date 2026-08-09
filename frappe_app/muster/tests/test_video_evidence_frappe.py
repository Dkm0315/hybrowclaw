import secrets
import unittest
import json
from hashlib import sha256

try:
    import frappe
    from frappe.tests.utils import FrappeTestCase
    from frappe.utils.password import check_password
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Frappe integration tests require an installed test site") from exc

from muster.demo.video import (
    revoke_video_access,
    rotate_video_passwords,
    seed_video_evidence,
)


class TestVideoEvidenceFrappe(FrappeTestCase):
    def setUp(self):
        super().setUp()
        self.original_user = frappe.session.user
        frappe.set_user("Administrator")

    def tearDown(self):
        frappe.set_user(self.original_user)
        super().tearDown()

    def test_seed_is_disabled_passwordless_and_permissions_are_exact(self):
        manifest = seed_video_evidence(confirm=True)
        self.assertEqual(len(manifest["personas"]), 11)
        self.assertFalse(manifest["credential_policy"]["stored_in_fixture"])
        self.assertFalse(manifest["credential_policy"]["accounts_enabled_by_seed"])
        for persona in manifest["personas"]:
            user = frappe.get_doc("User", persona["user"])
            self.assertFalse(user.enabled)
            self.assertEqual({row.role for row in user.roles}, set(persona["roles"]))
            actual_permissions = {
                (row.allow, row.for_value)
                for row in frappe.get_all(
                    "User Permission",
                    filters={"user": user.name},
                    fields=["allow", "for_value"],
                )
            }
            expected_permissions = {
                (row["allow"], row["for_value"]) for row in persona["user_permissions"]
            }
            self.assertEqual(actual_permissions, expected_permissions)

    def test_seed_manifest_is_idempotent_and_deterministic(self):
        first = seed_video_evidence(confirm=True)
        second = seed_video_evidence(confirm=True)
        self.assertEqual(first, second)

    def test_seed_repairs_disposable_crm_record_drift_from_prior_take(self):
        manifest = seed_video_evidence(confirm=True)
        lead = manifest["records"]["crm_lead_east"]["name"]
        frappe.db.set_value(
            "CRM Lead", lead,
            {"first_name": "Edited", "last_name": "By Prior Recording"},
        )
        repaired = seed_video_evidence(confirm=True)
        self.assertEqual(repaired["records"]["crm_lead_east"]["title"], "East Growth Contact")
        self.assertEqual(
            frappe.db.get_value("CRM Lead", lead, ["first_name", "last_name"]),
            ("East", "Growth Contact"),
        )

    def test_manifest_resolves_routes_and_visible_hidden_names(self):
        manifest = seed_video_evidence(confirm=True)
        self.assertTrue(manifest["records"])
        for record in manifest["records"].values():
            self.assertTrue(record["name"])
            self.assertTrue(record["route"].startswith("/"))
        for case in manifest["cases"]:
            self.assertTrue(case["expected_ui"])
            if case["action"] == "direct_url" and case["expected"] == "deny":
                self.assertEqual(case["expected_http_status"], 403)
            if case["expected"] == "hidden":
                self.assertFalse(case["expected_list_membership"])
        by_key = {persona["key"]: persona for persona in manifest["personas"]}
        self.assertIn(
            manifest["records"]["customer_east"]["name"],
            by_key["sales_operator"]["expected_visible_record_names"],
        )
        self.assertIn(
            manifest["records"]["customer_west"]["name"],
            by_key["sales_operator"]["expected_hidden_record_names"],
        )
        self.assertIn(
            manifest["records"]["customer_east"]["route"],
            by_key["sales_operator"]["expected_visible_routes"],
        )
        self.assertIn(
            manifest["records"]["customer_west"]["route"],
            by_key["sales_operator"]["expected_hidden_routes"],
        )

    def test_live_allow_hidden_direct_deny_and_separation_cases(self):
        manifest = seed_video_evidence(confirm=True)
        rotate_video_passwords(secrets.token_urlsafe(24), confirm=True)
        users = {persona["key"]: persona["user"] for persona in manifest["personas"]}
        for case in manifest["cases"]:
            user = users[case["persona"]]
            action = case["action"]
            if action == "create":
                actual = bool(frappe.has_permission(case["doctype"], "create", user=user))
            else:
                doc = frappe.get_doc(case["doctype"], case["name"])
                if action in {"read", "direct_url"}:
                    actual = bool(doc.has_permission("read", user=user))
                elif action == "update":
                    actual = bool(doc.has_permission("write", user=user))
                elif action == "delete":
                    actual = bool(doc.has_permission("delete", user=user))
                elif action == "submit":
                    actual = bool(doc.has_permission("submit", user=user))
                elif action == "approve":
                    actual = bool(doc.has_permission("write", user=user))
                elif action == "list":
                    previous_user = frappe.session.user
                    try:
                        frappe.set_user(user)
                        actual = bool(
                            frappe.get_list(
                                case["doctype"],
                                filters={"name": case["name"]},
                                pluck="name",
                            )
                        )
                    finally:
                        frappe.set_user(previous_user)
                else:  # pragma: no cover - catalog validation prevents this
                    self.fail(f"unhandled action {action}")
            expected = case["expected"] == "allow"
            self.assertEqual(actual, expected, case["id"])

    def test_attended_update_delete_has_live_maker_checker_and_denied_user(self):
        from muster.orchestration.workflow_proposal import assert_destructive_reviewer

        manifest = seed_video_evidence(confirm=True)
        rotate_video_passwords(secrets.token_urlsafe(24), confirm=True)
        users = {persona["key"]: persona["user"] for persona in manifest["personas"]}
        records = manifest["records"]
        maker = users["destructive_maker"]
        checker = users["sales_approver"]
        denied = users["auditor"]
        target = frappe.get_doc("Customer", records["customer_delete_target"]["name"])
        own_lead = frappe.get_doc("CRM Lead", records["crm_lead_east"]["name"])
        other_lead = frappe.get_doc("CRM Lead", records["crm_lead_west"]["name"])

        self.assertNotEqual(maker, checker)
        self.assertTrue(target.has_permission("write", user=maker))
        self.assertTrue(target.has_permission("delete", user=maker))
        self.assertFalse(target.has_permission("write", user=denied))
        self.assertFalse(target.has_permission("delete", user=denied))
        self.assertTrue(own_lead.has_permission("write", user=users["crm_operator"]))
        self.assertFalse(other_lead.has_permission("write", user=users["crm_operator"]))
        self.assertFalse(own_lead.has_permission("write", user=denied))

        graph = {"nodes": [{"executionIntent": {"surface": "browser", "plan": {
            "schemaVersion": 1,
            "actionBudget": 1,
            "actions": [{"kind": "navigate", "route": f"/desk/customer/{target.name}", "doctype": "Customer", "recordName": target.name}],
            "attendedCrud": {"operation": "delete", "doctype": "Customer", "record_name": target.name, "fields": [], "schema_hash": "a" * 64, "revision": "b" * 64},
        }}}]}
        compiled_graph_json = json.dumps(
            graph, ensure_ascii=False, separators=(",", ":"), sort_keys=True
        )
        proposal = frappe._dict(
            requested_by=maker,
            compiled_graph_json=compiled_graph_json,
            compiled_graph_hash=sha256(compiled_graph_json.encode()).hexdigest(),
        )
        with self.assertRaises(frappe.PermissionError):
            assert_destructive_reviewer(proposal, maker)
        assert_destructive_reviewer(proposal, checker)
        with self.assertRaises(frappe.PermissionError):
            assert_destructive_reviewer(proposal, denied)

    def test_runtime_rotation_and_immediate_revoke(self):
        manifest = seed_video_evidence(confirm=True)
        runtime_secret = secrets.token_urlsafe(24)
        rotated = rotate_video_passwords(runtime_secret, confirm=True)
        self.assertEqual(rotated["rotated"], len(manifest["personas"]))
        self.assertNotIn(runtime_secret, frappe.as_json(rotated))
        user = manifest["personas"][0]["user"]
        self.assertTrue(frappe.db.get_value("User", user, "enabled"))
        self.assertEqual(check_password(user, runtime_secret), user)

        revoked = revoke_video_access(confirm=True)
        self.assertEqual(revoked["revoked"], len(manifest["personas"]))
        self.assertFalse(frappe.db.get_value("User", user, "enabled"))
        self.assertEqual(frappe.get_doc("User", user).roles, [])
        self.assertEqual(frappe.db.count("User Permission", {"user": user}), 0)
        with self.assertRaises(frappe.AuthenticationError):
            check_password(user, runtime_secret)
        with self.assertRaises(frappe.ValidationError):
            rotate_video_passwords(secrets.token_urlsafe(24), confirm=True)
        reseeded = seed_video_evidence(confirm=True)
        self.assertFalse(frappe.db.get_value("User", user, "enabled"))
        expected_roles = set(reseeded["personas"][0]["roles"])
        self.assertEqual({row.role for row in frappe.get_doc("User", user).roles}, expected_roles)

    def test_account_management_is_administrator_only(self):
        manifest = seed_video_evidence(confirm=True)
        frappe.set_user(manifest["personas"][2]["user"])
        with self.assertRaises(frappe.PermissionError):
            seed_video_evidence(confirm=True)
        with self.assertRaises(frappe.PermissionError):
            rotate_video_passwords(secrets.token_urlsafe(24), confirm=True)
        with self.assertRaises(frappe.PermissionError):
            revoke_video_access(confirm=True)

    def test_explicit_confirmation_and_minimum_runtime_secret_are_enforced(self):
        with self.assertRaises(frappe.ValidationError):
            seed_video_evidence(confirm=False)
        seed_video_evidence(confirm=True)
        with self.assertRaises(frappe.ValidationError):
            rotate_video_passwords(secrets.token_urlsafe(4), confirm=True)
        with self.assertRaises(frappe.ValidationError):
            revoke_video_access(confirm=False)
