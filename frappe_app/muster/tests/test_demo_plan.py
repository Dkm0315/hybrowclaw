import unittest

from muster.demo.plan import (
    ROLE_CYCLE,
    BusinessScaleProfile,
    ScaleProfile,
    build_manifest,
    principal_email,
    principal_role,
    rbac_proof_cases,
    stable_id,
)


class TestDemoPlan(unittest.TestCase):
    def test_manifest_is_deterministic(self):
        first = build_manifest("tenant-a.test", "frappeverse", "tiny")
        second = build_manifest("tenant-a.test", "frappeverse", "tiny")
        self.assertEqual(first, second)

    def test_sites_have_disjoint_tenant_and_principal_ids(self):
        first = build_manifest("tenant-a.test", "frappeverse", "tiny")
        second = build_manifest("tenant-b.test", "frappeverse", "tiny")
        self.assertNotEqual(first["tenant_id"], second["tenant_id"])
        self.assertTrue(set(first["principal_ids"]).isdisjoint(second["principal_ids"]))
        self.assertTrue(set(first["mission_ids"]).isdisjoint(second["mission_ids"]))

    def test_volume_counts_are_exact(self):
        for scale in ("tiny", "small", "medium", "large", "acceptance"):
            profile = ScaleProfile.named(scale)
            counts = profile.expected_counts()
            self.assertEqual(
                counts["work_units"], profile.missions * profile.work_units_per_mission
            )
            self.assertEqual(
                counts["activities"], profile.missions * profile.activities_per_mission
            )
            self.assertEqual(counts["artifacts"], profile.missions * profile.artifacts_per_mission)

    def test_identifiers_do_not_depend_on_process_randomness(self):
        identifier = stable_id("tenant-a.test", "frappeverse", "mission", 17)
        self.assertEqual(identifier, "f6e90b4e-fc2c-5799-8284-a4d6baa049d0")
        self.assertEqual(
            principal_email("Tenant A.test", "frappeverse", 2),
            "muster.demo.frappeverse.tenantatest.0002@example.com",
        )

    def test_unknown_scale_is_rejected(self):
        with self.assertRaises(ValueError):
            ScaleProfile.named("unbounded")

    def test_acceptance_profile_meets_declared_scale_gate(self):
        counts = ScaleProfile.named("acceptance").expected_counts()
        self.assertEqual(counts["principals"], 30)
        self.assertEqual(counts["agents"], 20)
        self.assertEqual(counts["workflows"], 12)
        self.assertEqual(counts["missions"], 10_000)
        self.assertEqual(counts["activities"], 100_000)

    def test_acceptance_business_volume_is_exact_and_cross_app(self):
        profile = BusinessScaleProfile.named("acceptance")
        self.assertEqual(
            profile.expected_counts(),
            {
                "companies": 4,
                "customers": 1_000,
                "suppliers": 500,
                "employees": 300,
                "crm_organizations": 500,
                "crm_leads": 1_500,
                "crm_deals": 750,
            },
        )
        self.assertEqual(profile.total, 4_554)

    def test_acceptance_principals_are_distinct_and_roles_are_balanced(self):
        manifest = build_manifest("tenant-a.test", "frappeverse", "acceptance")
        self.assertEqual(len(manifest["principal_ids"]), 30)
        self.assertEqual(len(set(manifest["principal_ids"])), 30)
        self.assertEqual(set(manifest["principal_roles"].values()), set(ROLE_CYCLE))
        self.assertEqual(manifest["role_distribution"], {role: 5 for role in ROLE_CYCLE})
        for index, principal in enumerate(manifest["principal_ids"]):
            self.assertEqual(manifest["principal_roles"][principal], principal_role(index))

    def test_rbac_proof_matrix_has_positive_and_negative_cases(self):
        cases = rbac_proof_cases("tenant-a.test", "frappeverse", 30)
        self.assertEqual(
            {case["expected"] for case in cases},
            {"allowed", "denied", "read-only"},
        )
        self.assertEqual(len({case["actor"] for case in cases}), len(cases))
        self.assertEqual(len({case["role"] for case in cases}), len(cases))

    def test_rbac_proof_rejects_profiles_without_every_role(self):
        with self.assertRaises(ValueError):
            rbac_proof_cases("tenant-a.test", "frappeverse", len(ROLE_CYCLE) - 1)
