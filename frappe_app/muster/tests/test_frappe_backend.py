from __future__ import annotations

from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

import frappe

from muster.automation.frappe_backend import FrappeNativeBackend, _same_persisted_plan


class TestPersistedNativePlanEvidence(TestCase):
    def test_json_round_trip_lists_match_immutable_model_tuples(self):
        persisted = {
            "capabilities": ["artifact.custom_field.write"],
            "citations": [{"lines": [3, 4]}],
        }
        current = {
            "capabilities": ("artifact.custom_field.write",),
            "citations": ({"lines": (3, 4)},),
        }

        self.assertTrue(_same_persisted_plan(persisted, current))

    def test_material_plan_drift_is_rejected(self):
        persisted = {"target": "Customer-service_region", "required": False}
        current = {"target": "Customer-service_region", "required": True}

        self.assertFalse(_same_persisted_plan(persisted, current))

    def test_server_script_is_preflight_blocked_when_site_feature_is_disabled(self):
        backend = FrappeNativeBackend()
        definition = SimpleNamespace(doctype="Server Script")
        with (
            patch.object(frappe, "conf", frappe._dict(server_script_enabled=False)),
            self.assertRaisesRegex(frappe.ValidationError, "disabled for this site"),
        ):
            backend.validate_definition(definition, None)

    def test_server_script_preflight_allows_explicitly_enabled_site(self):
        backend = FrappeNativeBackend()
        definition = SimpleNamespace(doctype="Server Script")
        with patch.object(frappe, "conf", frappe._dict(server_script_enabled=True)):
            self.assertIsNone(backend.validate_definition(definition, None))

    def test_insert_preserves_the_exact_reviewed_target_name(self):
        backend = FrappeNativeBackend()
        inserted = SimpleNamespace(name="reviewed-route")
        document = SimpleNamespace(
            flags=SimpleNamespace(name_set=False),
            insert=lambda: inserted,
        )

        with patch.object(frappe, "get_doc", return_value=document) as get_doc:
            name = backend.insert(
                "Web Page", "reviewed-route", {"name": "untrusted-name", "title": "Reviewed"}
            )

        self.assertEqual(name, "reviewed-route")
        self.assertTrue(document.flags.name_set)
        self.assertEqual(get_doc.call_args.args[0]["name"], "reviewed-route")
