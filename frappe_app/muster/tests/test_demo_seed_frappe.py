import unittest
from uuid import uuid4

try:
    import frappe
    from frappe.tests.utils import FrappeTestCase
    from frappe.utils import now_datetime
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Frappe integration tests require an installed test site") from exc

from muster.demo.plan import ROLE_CYCLE, ScaleProfile, build_manifest, short_id
from muster.demo.seed import seed_demo


class TestDemoSeed(FrappeTestCase):
    def setUp(self):
        super().setUp()
        self.original_user = frappe.session.user
        frappe.set_user("Administrator")

    def tearDown(self):
        frappe.set_user(self.original_user)
        super().tearDown()

    def test_seed_is_idempotent_and_matches_profile(self):
        first = seed_demo(scale="tiny", scenario="frappeverse", confirm=True, with_erpnext=False)
        second = seed_demo(scale="tiny", scenario="frappeverse", confirm=True, with_erpnext=False)
        expected = ScaleProfile.named("tiny").expected_counts()
        for key in (
            "principals",
            "agents",
            "workflows",
            "missions",
            "work_units",
            "runs",
            "activities",
            "approvals",
            "change_sets",
            "artifacts",
        ):
            self.assertEqual(first["counts_after"][key], expected[key])
            self.assertEqual(second["counts_after"][key], expected[key])
            created_key = "users" if key == "principals" else key
            self.assertEqual(second["created_this_run"][created_key], 0)
        self.assertTrue(first["verification"]["core_counts_exact"])
        self.assertTrue(first["verification"]["roles_exact"])
        self.assertTrue(first["verification"]["rbac_exact"])
        self.assertTrue(all(check["passed"] for check in first["verification"]["rbac_checks"]))
        self.assertEqual(first["verification"]["core_count_mismatches"], {})
        self.assertIsNone(first["verification"]["business_counts_exact"])

    def test_cross_principal_visibility_and_normal_create_are_denied(self):
        seed_demo(scale="tiny", scenario="frappeverse", confirm=True, with_erpnext=False)
        manifest = build_manifest(frappe.local.site, "frappeverse", "tiny")
        viewer = manifest["principal_ids"][5]
        mission = frappe.db.get_value(
            "Muster Mission",
            {"idempotency_key": manifest["mission_ids"][0]},
            "name",
        )
        frappe.set_user(viewer)
        self.assertFalse(frappe.has_permission("Muster Mission", "read", mission))
        self.assertEqual(
            frappe.get_list("Muster Mission", filters={"name": mission}, pluck="name"),
            [],
        )
        unauthorized = frappe.get_doc(
            {
                "doctype": "Muster Mission",
                "objective": "Unauthorized principal attempts to create a hidden mission",
                "status": "Queued",
                "requested_by": viewer,
                "requested_at": now_datetime(),
                "idempotency_key": uuid4().hex,
            }
        )
        with self.assertRaises(frappe.PermissionError):
            unauthorized.insert()

    def test_bulk_projection_has_deterministic_names_and_hierarchy(self):
        seed_demo(scale="tiny", scenario="frappeverse", confirm=True, with_erpnext=False)
        manifest = build_manifest(frappe.local.site, "frappeverse", "tiny")
        mission = frappe.db.get_value(
            "Muster Mission",
            {"idempotency_key": manifest["mission_ids"][0]},
            "name",
        )
        units = frappe.get_all(
            "Muster Work Unit",
            filters={"mission": mission},
            fields=["name", "parent_work_unit", "depth"],
            order_by="depth asc",
        )
        self.assertEqual(len(units), 3)
        for index, unit in enumerate(units):
            self.assertEqual(
                unit.name,
                "muster-demo-unit-"
                + short_id(frappe.local.site, "frappeverse", "work-unit", f"0:{index}"),
            )
            self.assertEqual(
                unit.parent_work_unit,
                units[index - 1].name if index else None,
            )
        self.assertEqual(
            frappe.db.count("Muster Activity", {"mission": mission}),
            ScaleProfile.named("tiny").activities_per_mission,
        )

    def test_role_distribution_bindings_and_live_visibility_matrix(self):
        seed_demo(scale="tiny", scenario="frappeverse", confirm=True, with_erpnext=False)
        manifest = build_manifest(frappe.local.site, "frappeverse", "tiny")
        self.assertEqual(set(manifest["principal_roles"].values()), set(ROLE_CYCLE))

        for user, expected_role in manifest["principal_roles"].items():
            self.assertIn(expected_role, frappe.get_roles(user))
            binding = frappe.db.get_value(
                "Muster Role Binding",
                {
                    "subject_type": "User",
                    "subject": user,
                    "scope_type": "Site",
                    "scope_value": frappe.local.site,
                },
                ["name", "status", "capabilities"],
                as_dict=True,
            )
            self.assertIsNotNone(binding)
            self.assertEqual(binding.status, "Active")
            self.assertTrue(binding.capabilities)

        operator = manifest["principal_ids"][2]
        auditor = manifest["principal_ids"][4]
        viewer = manifest["principal_ids"][5]
        assigned_mission = frappe.get_doc(
            "Muster Mission",
            frappe.db.get_value(
                "Muster Mission",
                {"idempotency_key": manifest["mission_ids"][0]},
                "name",
            ),
        )
        self.assertEqual(assigned_mission.assigned_to, operator)
        self.assertTrue(assigned_mission.has_permission("read", user=operator))
        self.assertTrue(assigned_mission.has_permission("write", user=operator))
        self.assertTrue(assigned_mission.has_permission("read", user=auditor))
        self.assertFalse(assigned_mission.has_permission("write", user=auditor))
        self.assertFalse(assigned_mission.has_permission("read", user=viewer))

    def test_site_specific_manifest_does_not_resolve_foreign_tenant_ids(self):
        seed_demo(scale="tiny", scenario="frappeverse", confirm=True, with_erpnext=False)
        local_manifest = build_manifest(frappe.local.site, "frappeverse", "tiny")
        foreign_manifest = build_manifest("foreign-tenant.invalid", "frappeverse", "tiny")
        self.assertNotEqual(local_manifest["tenant_id"], foreign_manifest["tenant_id"])
        self.assertEqual(
            frappe.db.count(
                "Muster Mission",
                {"idempotency_key": ["in", foreign_manifest["mission_ids"]]},
            ),
            0,
        )

    def test_passive_bulk_path_rejects_controller_bearing_doctypes(self):
        from muster.demo.bulk import _bulk_insert

        with self.assertRaises(ValueError):
            _bulk_insert("Customer", [{"name": "must-never-be-inserted"}])

    def test_seeder_refuses_non_administrator(self):
        seed_demo(scale="tiny", scenario="frappeverse", confirm=True, with_erpnext=False)
        manifest = build_manifest(frappe.local.site, "frappeverse", "tiny")
        frappe.set_user(manifest["principal_ids"][2])
        with self.assertRaises(frappe.PermissionError):
            seed_demo(
                scale="tiny",
                scenario="frappeverse",
                confirm=True,
                with_erpnext=False,
            )
