from __future__ import annotations

from contextlib import contextmanager
from unittest.mock import Mock, patch

import frappe
from frappe.tests import IntegrationTestCase

from muster.api import customization_repair as api
from muster.orchestration import client_script_repair as repair


ACTOR = "customization-admin@example.test"
SCRIPT_NAME = "Reviewed Order Guidance"
TARGET = "Purchase Order"
BEFORE = "frappe.ui.form.on('Purchase Order', { refresh(frm) { frm.set_intro('Old'); } });\n"
AFTER = "frappe.ui.form.on('Purchase Order', { refresh(frm) { frm.set_intro('Reviewed'); } });\n"


class FakeCache:
    def __init__(self):
        self.values: dict[str, str] = {}

    def set_value(self, key, value, expires_in_sec=None):
        del expires_in_sec
        self.values[key] = value

    def get_value(self, key):
        return self.values.get(key)

    def delete_value(self, key):
        self.values.pop(key, None)

    @contextmanager
    def lock(self, key, **kwargs):
        del key, kwargs
        yield


class ScriptDocument(frappe._dict):
    def __init__(self, script=BEFORE):
        super().__init__(
            name=SCRIPT_NAME,
            dt=TARGET,
            view="Form",
            enabled=1,
            modified="2026-08-16 10:00:00.000001",
            script=script,
        )
        self.saved = 0
        self.permissions = {"read": True, "write": True}

    def has_permission(self, permission, user=None):
        del user
        return self.permissions.get(permission, False)

    def save(self):
        self.saved += 1
        self.modified = f"2026-08-16 10:00:0{self.saved}.000001"
        return self


def schema(**changes):
    value = {
        "doctype": TARGET,
        "schema_hash": "a" * 64,
        "revision": "b" * 64,
        "field_count": 42,
        "required_fields": [{"fieldname": "supplier", "label": "Supplier"}],
        "custom_field_count": 3,
        "property_setter_count": 2,
        "workflow": None,
    }
    value.update(changes)
    return value


class TestClientScriptRepair(IntegrationTestCase):
    def setUp(self):
        self.cache = FakeCache()
        self.doc = ScriptDocument()
        self.patches = [
            patch.object(repair.frappe, "cache", self.cache),
            patch.object(repair, "_actor", return_value=ACTOR),
            patch.object(repair, "_site", return_value="test.local"),
            patch.object(repair, "permission_epoch", return_value="epoch-1"),
            patch.object(repair, "_client_script", side_effect=lambda _name, _actor: self.doc),
            patch.object(repair, "_schema_evidence", side_effect=lambda _target, _actor: schema()),
            patch.object(repair, "_latest_version", return_value="VER-0001"),
        ]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()

    def _preview(self):
        return repair.diagnose(
            SCRIPT_NAME,
            AFTER,
            "Keep the purchasing team on the reviewed business path.",
        )

    def _authorization(self):
        preview = self._preview()
        return repair.authorize(
            preview["preview"], preview["before_hash"], preview["after_hash"]
        )

    def _apply(self):
        authorization = self._authorization()
        return repair.apply(
            authorization["authorization"], authorization["authorization_token"]
        )

    def test_preview_is_inert_exact_and_uses_live_target_and_schema(self):
        result = self._preview()

        self.assertFalse(result["executed"])
        self.assertTrue(result["approval_required"])
        self.assertEqual(self.doc.saved, 0)
        self.assertEqual(self.doc.script, BEFORE)
        self.assertEqual(result["client_script"], SCRIPT_NAME)
        self.assertEqual(result["target_doctype"], TARGET)
        self.assertEqual(result["before_script"], BEFORE)
        self.assertEqual(result["after_script"], AFTER)
        self.assertEqual(result["before_hash"], repair._digest(BEFORE))
        self.assertEqual(result["after_hash"], repair._digest(AFTER))
        self.assertIn("-frappe.ui.form.on", result["diff"])
        self.assertEqual(result["schema"]["custom_field_count"], 3)
        self.assertFalse(result["business_explanation"]["schema_change"])
        self.assertEqual(
            result["business_explanation"]["after_form_references"], [TARGET]
        )

    def test_authorization_is_bound_to_exact_reviewed_hashes_and_consumes_preview(self):
        preview = self._preview()
        with self.assertRaisesRegex(repair.ClientScriptRepairError, "current-script hash"):
            repair.authorize(preview["preview"], "0" * 64, preview["after_hash"])
        with self.assertRaisesRegex(repair.ClientScriptRepairError, "invalid or expired"):
            repair.authorize(
                preview["preview"], preview["before_hash"], preview["after_hash"]
            )

    def test_live_script_drift_fails_closed(self):
        preview = self._preview()
        self.doc.script = f"{BEFORE}// drift\n"
        with self.assertRaisesRegex(repair.ClientScriptRepairError, "changed after review"):
            repair.authorize(
                preview["preview"], preview["before_hash"], preview["after_hash"]
            )

    def test_live_schema_drift_fails_closed(self):
        preview = self._preview()
        with patch.object(
            repair,
            "_schema_evidence",
            side_effect=lambda _target, _actor: schema(schema_hash="c" * 64),
        ):
            with self.assertRaisesRegex(
                repair.ClientScriptRepairError, "form customization changed"
            ):
                repair.authorize(
                    preview["preview"], preview["before_hash"], preview["after_hash"]
                )

    def test_permission_epoch_drift_fails_closed(self):
        preview = self._preview()
        with patch.object(repair, "permission_epoch", return_value="epoch-2"):
            with self.assertRaises(frappe.PermissionError):
                repair.authorize(
                    preview["preview"], preview["before_hash"], preview["after_hash"]
                )

    def test_apply_consumes_one_use_capability_saves_exact_source_and_returns_restoration(self):
        authorization = self._authorization()
        result = repair.apply(
            authorization["authorization"], authorization["authorization_token"]
        )

        self.assertEqual(self.doc.script, AFTER)
        self.assertEqual(self.doc.saved, 1)
        self.assertTrue(result["verified"])
        self.assertTrue(result["executed"])
        self.assertEqual(result["observed_after_hash"], repair._digest(AFTER))
        self.assertEqual(result["before_hash"], repair._digest(BEFORE))
        self.assertTrue(result["restoration"]["available"])
        self.assertEqual(result["restoration"]["action"], "prepare_rollback")
        self.assertEqual(result["version_record"], "VER-0001")
        with self.assertRaisesRegex(repair.ClientScriptRepairError, "invalid or expired"):
            repair.apply(
                authorization["authorization"], authorization["authorization_token"]
            )

    def test_wrong_apply_token_is_consumed_without_mutation(self):
        authorization = self._authorization()
        with self.assertRaises(frappe.PermissionError):
            repair.apply(authorization["authorization"], "wrong-token")
        self.assertEqual(self.doc.script, BEFORE)
        self.assertEqual(self.doc.saved, 0)
        with self.assertRaisesRegex(repair.ClientScriptRepairError, "invalid or expired"):
            repair.apply(
                authorization["authorization"], authorization["authorization_token"]
            )

    def test_verification_failure_rolls_back_transaction_and_returns_no_receipt(self):
        authorization = self._authorization()
        rereads = [self.doc, ScriptDocument(script="unexpected")]
        with (
            patch.object(repair, "_client_script", side_effect=rereads),
            patch.object(repair.frappe.db, "rollback") as rollback,
        ):
            with self.assertRaisesRegex(
                repair.ClientScriptRepairError, "transaction was rolled back"
            ):
                repair.apply(
                    authorization["authorization"], authorization["authorization_token"]
                )
        rollback.assert_called_once_with()

    def test_rollback_requires_fresh_review_then_restores_and_verifies_exact_source(self):
        applied = self._apply()
        preview = repair.prepare_rollback(applied["receipt"])
        self.assertFalse(preview["executed"])
        self.assertEqual(preview["current_hash"], repair._digest(AFTER))
        self.assertEqual(preview["restore_hash"], repair._digest(BEFORE))
        authorization = repair.authorize_rollback(
            preview["rollback_preview"],
            preview["current_hash"],
            preview["restore_hash"],
        )
        result = repair.rollback(
            authorization["authorization"], authorization["authorization_token"]
        )

        self.assertEqual(self.doc.script, BEFORE)
        self.assertEqual(self.doc.saved, 2)
        self.assertTrue(result["verified"])
        self.assertTrue(result["restored"])
        self.assertEqual(result["observed_restore_hash"], repair._digest(BEFORE))
        self.assertTrue(result["rollback_receipt"])

    def test_rollback_refuses_post_repair_drift(self):
        applied = self._apply()
        self.doc.script = f"{AFTER}// another administrator changed this\n"
        with self.assertRaisesRegex(repair.ClientScriptRepairError, "automatic rollback is unsafe"):
            repair.prepare_rollback(applied["receipt"])

    def test_previous_version_uses_only_transition_that_proves_live_source(self):
        version = frappe._dict(
            name="VERSION-0001",
            ref_doctype="Client Script",
            docname=SCRIPT_NAME,
            data=frappe.as_json({"changed": [["script", BEFORE, AFTER]]}),
        )
        version.has_permission = Mock(return_value=True)
        self.doc.script = AFTER
        with (
            patch.object(repair.frappe, "get_meta", return_value=frappe._dict(track_changes=1)),
            patch.object(repair.frappe.db, "exists", return_value=True),
            patch.object(repair.frappe, "has_permission", return_value=True),
            patch.object(repair.frappe, "get_list", return_value=[version.name]),
            patch.object(repair.frappe, "get_doc", return_value=version),
        ):
            result = repair._prior_version_source(SCRIPT_NAME, "", ACTOR)

        self.assertEqual(result["version"], version.name)
        self.assertEqual(result["prior_script"], BEFORE)
        self.assertEqual(result["prior_hash"], repair._digest(BEFORE))
        self.assertEqual(result["live_hash"], repair._digest(AFTER))

    def test_selected_previous_version_fails_when_its_new_source_is_not_live(self):
        version = frappe._dict(
            name="VERSION-STALE",
            ref_doctype="Client Script",
            docname=SCRIPT_NAME,
            data=frappe.as_json({"changed": [["script", "older", BEFORE]]}),
        )
        version.has_permission = Mock(return_value=True)
        self.doc.script = AFTER
        with (
            patch.object(repair.frappe, "get_meta", return_value=frappe._dict(track_changes=1)),
            patch.object(repair.frappe.db, "exists", return_value=True),
            patch.object(repair.frappe, "has_permission", return_value=True),
            patch.object(repair.frappe, "get_doc", return_value=version),
        ):
            with self.assertRaisesRegex(
                repair.ClientScriptRepairError, "no longer matches the live Client Script"
            ):
                repair._prior_version_source(SCRIPT_NAME, version.name, ACTOR)

    def test_previous_version_reports_when_client_script_tracking_is_unavailable(self):
        with patch.object(
            repair.frappe, "get_meta", return_value=frappe._dict(track_changes=0)
        ):
            with self.assertRaisesRegex(
                repair.ClientScriptRepairError, "change tracking is disabled"
            ):
                repair._prior_version_source(SCRIPT_NAME, "", ACTOR)

    def test_live_form_resolver_returns_one_permission_filtered_version_backed_script(self):
        source = {
            "version": "VERSION-0001",
            "prior_hash": "1" * 64,
            "live_hash": "2" * 64,
        }
        with (
            patch.object(repair.frappe.db, "exists", return_value=True),
            patch.object(repair.frappe, "has_permission", return_value=True),
            patch.object(repair.frappe, "get_list", return_value=[SCRIPT_NAME]),
            patch.object(repair, "_prior_version_source", return_value=source),
        ):
            result = repair.resolve_previous_version_candidate(TARGET, ACTOR)

        self.assertEqual(result["client_script"], SCRIPT_NAME)
        self.assertEqual(result["target_doctype"], TARGET)
        self.assertEqual(result["version"], "VERSION-0001")
        self.assertTrue(result["current_source_verified"])
        self.assertFalse(result["generated_source"])

    def test_live_form_resolver_uses_pluck_without_conflicting_fields(self):
        source = {
            "version": "VERSION-0001",
            "prior_hash": "1" * 64,
            "live_hash": "2" * 64,
        }
        with (
            patch.object(repair.frappe.db, "exists", return_value=True),
            patch.object(repair.frappe, "has_permission", return_value=True),
            patch.object(repair.frappe, "get_list", return_value=[SCRIPT_NAME]) as get_list,
            patch.object(repair, "_prior_version_source", return_value=source),
        ):
            repair.resolve_previous_version_candidate(TARGET, ACTOR)

        self.assertEqual(get_list.call_args.kwargs["pluck"], "name")
        self.assertNotIn("fields", get_list.call_args.kwargs)

    def test_live_form_resolver_refuses_ambiguous_version_backed_scripts(self):
        with (
            patch.object(repair.frappe.db, "exists", return_value=True),
            patch.object(repair.frappe, "has_permission", return_value=True),
            patch.object(repair.frappe, "get_list", return_value=["SCRIPT-A", "SCRIPT-B"]),
            patch.object(repair, "_prior_version_source", return_value={
                "version": "VERSION-0001", "prior_hash": "1" * 64, "live_hash": "2" * 64,
            }),
        ):
            self.assertIsNone(repair.resolve_previous_version_candidate(TARGET, ACTOR))

    def test_live_form_resolver_uses_visible_error_words_to_disambiguate(self):
        scripts = {
            "SCRIPT-A": ScriptDocument(script="frappe.throw('Only revision A is permitted for this operation.');"),
            "SCRIPT-B": ScriptDocument(script="frappe.throw('Supplier approval is missing.');"),
        }
        with (
            patch.object(repair.frappe.db, "exists", return_value=True),
            patch.object(repair.frappe, "has_permission", return_value=True),
            patch.object(repair.frappe, "get_list", return_value=list(scripts)),
            patch.object(repair, "_prior_version_source", return_value={
                "version": "VERSION-0001", "prior_hash": "1" * 64, "live_hash": "2" * 64,
            }),
            patch.object(repair, "_client_script", side_effect=lambda name, _actor: scripts[name]),
        ):
            result = repair.resolve_previous_version_candidate(
                TARGET, ACTOR, "It says only revision A is permitted; please fix it."
            )

        self.assertEqual(result["client_script"], "SCRIPT-A")


class TestClientScriptRepairApi(IntegrationTestCase):
    def test_mutating_endpoints_require_explicit_confirmation(self):
        with (
            patch.object(api, "_require_post"),
            patch.object(api.client_script_repair, "authorize") as authorize,
            patch.object(api.client_script_repair, "apply") as apply,
            patch.object(api.client_script_repair, "authorize_rollback") as authorize_rollback,
            patch.object(api.client_script_repair, "rollback") as rollback,
        ):
            calls = (
                lambda: api.authorize_client_script_repair("p" * 48, "a" * 64, "b" * 64),
                lambda: api.apply_client_script_repair("a" * 48, "t" * 48),
                lambda: api.authorize_client_script_rollback("p" * 48, "a" * 64, "b" * 64),
                lambda: api.rollback_client_script_repair("a" * 48, "t" * 48),
            )
            for call in calls:
                with self.assertRaises(frappe.ValidationError):
                    call()
            authorize.assert_not_called()
            apply.assert_not_called()
            authorize_rollback.assert_not_called()
            rollback.assert_not_called()

    def test_post_is_required_and_confirmed_values_are_forwarded(self):
        with (
            patch.object(api, "_require_post") as require_post,
            patch.object(
                api.client_script_repair,
                "authorize",
                return_value={"authorized": True},
            ) as authorize,
        ):
            result = api.authorize_client_script_repair(
                "p" * 48, "a" * 64, "b" * 64, confirmed=1
            )
        require_post.assert_called_once_with()
        authorize.assert_called_once_with("p" * 48, "a" * 64, "b" * 64)
        self.assertTrue(result["authorized"])


class TestClientScriptRepairPrivileges(IntegrationTestCase):
    def test_non_privileged_user_is_denied_before_code_is_read(self):
        original_session = repair.frappe.local.session
        repair.frappe.local.session = frappe._dict(user="employee@example.test")
        try:
            with (
                patch.object(repair.frappe.db, "get_value", return_value=1),
                patch.object(repair.frappe, "get_roles", return_value=["Employee"]),
            ):
                with self.assertRaises(frappe.PermissionError):
                    repair._actor()
        finally:
            repair.frappe.local.session = original_session

    def test_record_and_target_permissions_are_both_required(self):
        doc = ScriptDocument()
        doc.permissions["write"] = False
        with (
            patch.object(repair.frappe, "get_doc", return_value=doc),
            patch.object(repair.frappe.db, "exists", return_value=True),
            patch.object(repair.frappe, "has_permission", return_value=True),
        ):
            with self.assertRaises(frappe.PermissionError):
                repair._client_script(SCRIPT_NAME, ACTOR)

        doc.permissions["write"] = True
        with (
            patch.object(repair.frappe, "get_doc", return_value=doc),
            patch.object(repair.frappe.db, "exists", return_value=True),
            patch.object(repair.frappe, "has_permission", return_value=False),
        ):
            with self.assertRaises(frappe.PermissionError):
                repair._client_script(SCRIPT_NAME, ACTOR)
