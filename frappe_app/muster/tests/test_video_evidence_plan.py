import ast
import json
import secrets
import unittest
from pathlib import Path

from muster.demo.video_plan import (
    ALLOWED_ACTIONS,
    build_video_plan,
    load_video_catalog,
    validate_video_catalog,
)

PACKAGE_ROOT = Path(__file__).resolve().parents[1]


class TestVideoEvidencePlan(unittest.TestCase):
    def test_catalog_has_realistic_personas_and_full_action_matrix(self):
        catalog = load_video_catalog()
        self.assertEqual(len(catalog["personas"]), 11)
        self.assertEqual(
            {case["app"] for case in catalog["cases"]},
            {"muster", "erpnext", "hrms", "crm"},
        )
        actions = {case["action"] for case in catalog["cases"]}
        self.assertTrue({"create", "update", "delete", "submit", "approve", "list", "direct_url"} <= actions)
        self.assertTrue(actions <= ALLOWED_ACTIONS)
        self.assertEqual(
            {case["expected"] for case in catalog["cases"]},
            {"allow", "deny", "hidden"},
        )
        self.assertEqual(
            {case["persona"] for case in catalog["cases"]},
            {persona["key"] for persona in catalog["personas"]},
        )

    def test_plan_is_deterministic_and_sites_have_distinct_users(self):
        first = build_video_plan("tenant-a.test")
        second = build_video_plan("tenant-a.test")
        foreign = build_video_plan("tenant-b.test")
        self.assertEqual(first, second)
        first_users = {persona["user"] for persona in first["personas"]}
        foreign_users = {persona["user"] for persona in foreign["personas"]}
        self.assertEqual(len(first_users), 11)
        self.assertTrue(first_users.isdisjoint(foreign_users))

    def test_catalog_contains_no_password_material(self):
        catalog = load_video_catalog()
        fixture = (PACKAGE_ROOT / "demo/fixtures/video_evidence.json").read_text(
            encoding="utf-8"
        )
        encoded = json.dumps(catalog, sort_keys=True).lower()
        for forbidden in ('"password"', '"passwd"', '"pwd"'):
            self.assertNotIn(forbidden, encoded)
            self.assertNotIn(forbidden, fixture.lower())

    def test_validator_rejects_credential_fields(self):
        catalog = load_video_catalog()
        catalog["personas"][0]["password"] = secrets.token_urlsafe(24)
        with self.assertRaisesRegex(ValueError, "password material"):
            validate_video_catalog(catalog)

    def test_password_rotation_uses_only_the_runtime_argument(self):
        source = (PACKAGE_ROOT / "demo/video.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        calls = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "update_password"
        ]
        self.assertEqual(len(calls), 1)
        self.assertIsInstance(calls[0].args[1], ast.Name)
        self.assertEqual(calls[0].args[1].id, "temporary_password")

    def test_every_persona_has_exact_explicit_roles_and_unique_cases(self):
        catalog = load_video_catalog()
        for persona in catalog["personas"]:
            self.assertEqual(len(persona["roles"]), len(set(persona["roles"])))
            self.assertGreater(len(persona["roles"]), 0)
        case_ids = [case["id"] for case in catalog["cases"]]
        self.assertEqual(len(case_ids), len(set(case_ids)))

    def test_attended_update_delete_matrix_has_distinct_maker_checker_and_denied_user(self):
        catalog = load_video_catalog()
        personas = {persona["key"]: persona for persona in catalog["personas"]}
        cases = {case["id"]: case for case in catalog["cases"]}
        self.assertNotEqual("destructive_maker", "sales_approver")
        self.assertIn("Muster Operator", personas["destructive_maker"]["roles"])
        self.assertIn("Muster Approver", personas["sales_approver"]["roles"])
        self.assertEqual(cases["destructive-maker-desk-update-allow"]["expected"], "allow")
        self.assertEqual(cases["destructive-maker-desk-delete-allow"]["expected"], "allow")
        self.assertEqual(cases["auditor-desk-delete-deny"]["expected"], "deny")
        self.assertEqual(cases["crm-own-lead-update"]["expected"], "allow")
        self.assertEqual(cases["crm-other-lead-update-deny"]["expected"], "deny")
