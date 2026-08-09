from __future__ import annotations

import json
import os
import tempfile
from hashlib import sha256
from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from muster.demo.native_desk_rbac_evidence import (
    EVIDENCE_CAPABILITIES,
    EVIDENCE_ROLES,
    EVIDENCE_USERS,
    _clear_evidence_customer_permissions,
    _proposal_evidence,
    _proposal_request_id,
    activate,
    capture,
    revoke,
)
from muster.orchestration.workflow_proposal import WorkflowProposalError


class TestNativeDeskRbacEvidence(IntegrationTestCase):
    def test_delete_fixture_clears_only_evidence_customer_permission_links(self):
        with (
            patch(
                "muster.demo.native_desk_rbac_evidence.frappe.get_all",
                return_value=["UP-1", "UP-2"],
            ) as get_all,
            patch("muster.demo.native_desk_rbac_evidence.frappe.delete_doc") as delete_doc,
            patch("muster.demo.native_desk_rbac_evidence.frappe.clear_cache") as clear_cache,
        ):
            _clear_evidence_customer_permissions(EVIDENCE_USERS["maker"])
        get_all.assert_called_once_with(
            "User Permission",
            filters={"user": EVIDENCE_USERS["maker"], "allow": "Customer"},
            pluck="name",
        )
        self.assertEqual(
            [call.args for call in delete_doc.call_args_list],
            [("User Permission", "UP-1"), ("User Permission", "UP-2")],
        )
        self.assertTrue(all(call.kwargs["ignore_permissions"] for call in delete_doc.call_args_list))
        clear_cache.assert_called_once_with(user=EVIDENCE_USERS["maker"])

    def test_fixture_request_id_rotates_only_when_record_or_form_binding_changes(self):
        current = {"schema_hash": "a" * 64, "revision": "b" * 64}
        same = _proposal_request_id("update", "ACME", current)
        self.assertEqual(same, _proposal_request_id("update", "ACME", dict(current)))
        self.assertNotEqual(
            same,
            _proposal_request_id("update", "ACME", {**current, "revision": "c" * 64}),
        )
        self.assertNotEqual(same, _proposal_request_id("update", "BETA", current))
        self.assertNotEqual(same, _proposal_request_id("delete", "ACME", current))

    def test_activate_reads_owner_only_password_file_without_returning_secret(self):
        password = "owner-file-runtime-password-123"
        with tempfile.NamedTemporaryFile() as password_file:
            password_file.write(f"{password}\n".encode())
            password_file.flush()
            os.chmod(password_file.name, 0o600)
            with (
                patch(
                    "muster.demo.native_desk_rbac_evidence.frappe.session",
                    frappe._dict(user="Administrator"),
                ),
                patch(
                    "muster.demo.native_desk_rbac_evidence._ensure_evidence_user",
                    side_effect=list(EVIDENCE_USERS.values()),
                ),
                patch("frappe.utils.password.update_password") as update_password,
                patch("muster.demo.native_desk_rbac_evidence.frappe.db.set_value"),
                patch("muster.demo.native_desk_rbac_evidence.frappe.db.commit"),
                patch("muster.demo.native_desk_rbac_evidence.frappe.clear_cache"),
            ):
                result = activate(password_file=password_file.name, confirm=True)
        self.assertEqual(result["activated"], len(EVIDENCE_USERS))
        self.assertFalse(result["password_returned"])
        self.assertNotIn(password, repr(result))
        self.assertEqual(update_password.call_count, len(EVIDENCE_USERS))
        for call in update_password.call_args_list:
            self.assertEqual(call.args[1], password)
            self.assertTrue(call.kwargs["logout_all_sessions"])

    def test_activate_rejects_non_owner_only_mode_and_wrong_owner(self):
        with tempfile.NamedTemporaryFile() as password_file:
            password_file.write(b"owner-file-runtime-password-123")
            password_file.flush()
            os.chmod(password_file.name, 0o640)
            with (
                patch(
                    "muster.demo.native_desk_rbac_evidence.frappe.session",
                    frappe._dict(user="Administrator"),
                ),
                self.assertRaisesRegex(frappe.ValidationError, "mode 0600"),
            ):
                activate(password_file=password_file.name, confirm=True)

            os.chmod(password_file.name, 0o600)
            with (
                patch(
                    "muster.demo.native_desk_rbac_evidence.frappe.session",
                    frappe._dict(user="Administrator"),
                ),
                patch(
                    "muster.demo.native_desk_rbac_evidence.os.geteuid",
                    return_value=os.geteuid() + 1,
                ),
                self.assertRaisesRegex(frappe.ValidationError, "owner-owned"),
            ):
                activate(password_file=password_file.name, confirm=True)

    def test_activate_rejects_symlink_short_and_multiple_password_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            target = os.path.join(directory, "password")
            link = os.path.join(directory, "password-link")
            descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                os.write(descriptor, b"too-short")
            finally:
                os.close(descriptor)
            os.symlink(target, link)
            with patch(
                "muster.demo.native_desk_rbac_evidence.frappe.session",
                frappe._dict(user="Administrator"),
            ):
                with self.assertRaisesRegex(frappe.ValidationError, "opened securely"):
                    activate(password_file=link, confirm=True)
                with self.assertRaisesRegex(frappe.ValidationError, "between 20 and 1024"):
                    activate(password_file=target, confirm=True)
                with self.assertRaisesRegex(frappe.ValidationError, "exactly one"):
                    activate(
                        temporary_password="argument-runtime-password-123",
                        password_file=target,
                        confirm=True,
                    )

    def test_activate_checks_confirmation_before_opening_password_file(self):
        with (
            patch(
                "muster.demo.native_desk_rbac_evidence.frappe.session",
                frappe._dict(user="Administrator"),
            ),
            patch("muster.demo.native_desk_rbac_evidence.os.open") as open_file,
            self.assertRaisesRegex(frappe.ValidationError, "Explicit confirmation"),
        ):
            activate(password_file="/private/runtime-secret", confirm=False)
        open_file.assert_not_called()

    def test_activate_preserves_direct_password_compatibility(self):
        password = "argument-runtime-password-123"
        with (
            patch(
                "muster.demo.native_desk_rbac_evidence.frappe.session",
                frappe._dict(user="Administrator"),
            ),
            patch(
                "muster.demo.native_desk_rbac_evidence._ensure_evidence_user",
                side_effect=list(EVIDENCE_USERS.values()),
            ),
            patch("frappe.utils.password.update_password") as update_password,
            patch("muster.demo.native_desk_rbac_evidence.frappe.db.set_value"),
            patch("muster.demo.native_desk_rbac_evidence.frappe.db.commit"),
            patch("muster.demo.native_desk_rbac_evidence.frappe.clear_cache"),
        ):
            result = activate(temporary_password=password, confirm=True)
        self.assertEqual(result["activated"], len(EVIDENCE_USERS))
        self.assertTrue(all(call.args[1] == password for call in update_password.call_args_list))

    def test_revoke_behavior_remains_disable_delete_credentials_and_clear_sessions(self):
        with (
            patch(
                "muster.demo.native_desk_rbac_evidence.frappe.session",
                frappe._dict(user="Administrator"),
            ),
            patch("muster.demo.native_desk_rbac_evidence.frappe.db.exists", return_value=True),
            patch("muster.demo.native_desk_rbac_evidence.frappe.db.set_value") as set_value,
            patch("muster.demo.native_desk_rbac_evidence.frappe.db.commit") as commit,
            patch("frappe.utils.password.delete_all_passwords_for") as delete_passwords,
            patch("frappe.sessions.clear_sessions") as clear_sessions,
            patch("muster.demo.native_desk_rbac_evidence.frappe.clear_cache"),
        ):
            result = revoke(confirm=True)
        self.assertEqual(result["revoked"], len(EVIDENCE_USERS))
        self.assertTrue(result["credentials_removed"])
        self.assertEqual(set_value.call_count, len(EVIDENCE_USERS))
        self.assertEqual(delete_passwords.call_count, len(EVIDENCE_USERS))
        self.assertEqual(clear_sessions.call_count, len(EVIDENCE_USERS))
        commit.assert_called_once_with()

    def test_maker_uses_ordinary_erpnext_authority_not_system_manager(self):
        self.assertEqual(
            set(EVIDENCE_ROLES["maker"]),
            {"Muster Operator", "Sales User", "Sales Manager", "Sales Master Manager"},
        )
        self.assertNotIn("System Manager", EVIDENCE_ROLES["maker"])
        self.assertIn("frappe.record.update", EVIDENCE_CAPABILITIES["maker"])
        self.assertIn("frappe.record.delete", EVIDENCE_CAPABILITIES["maker"])
        self.assertNotIn("frappe.record.update", EVIDENCE_CAPABILITIES["checker"])
        self.assertNotIn("frappe.record.delete", EVIDENCE_CAPABILITIES["checker"])
        self.assertNotIn("frappe.record.update", EVIDENCE_CAPABILITIES["denied"])
        self.assertNotIn("frappe.record.delete", EVIDENCE_CAPABILITIES["denied"])

    def test_capture_is_read_only_and_server_sealed(self):
        cases = [
            {"proposal": "MST-WFP-U", "operation": "update", "executed": False},
            {"proposal": "MST-WFP-D", "operation": "delete", "executed": False},
        ]
        with (
            patch("muster.demo.native_desk_rbac_evidence.frappe.session", frappe._dict(user="Administrator")),
            patch("muster.demo.native_desk_rbac_evidence._proposal_evidence", side_effect=cases) as evidence,
        ):
            result = capture("MST-WFP-U", "MST-WFP-D", "auditor@example.test", True)
        evidence.assert_any_call("MST-WFP-U", "update", "auditor@example.test")
        evidence.assert_any_call("MST-WFP-D", "delete", "auditor@example.test")
        self.assertTrue(result["read_only"])
        self.assertTrue(all(item["executed"] is False for item in result["cases"]))
        seal = result.pop("evidence_sha256")
        canonical = json.dumps(result, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        self.assertEqual(seal, sha256(canonical.encode()).hexdigest())

    def test_capture_requires_administrator_and_explicit_confirmation(self):
        with patch("muster.demo.native_desk_rbac_evidence.frappe.session", frappe._dict(user="maker@example.test")):
            with self.assertRaises(frappe.PermissionError):
                capture("MST-WFP-U", "MST-WFP-D", confirm=True)
        with patch("muster.demo.native_desk_rbac_evidence.frappe.session", frappe._dict(user="Administrator")):
            with self.assertRaises(frappe.ValidationError):
                capture("MST-WFP-U", "MST-WFP-D", confirm=False)

    def test_update_probe_requires_distinct_identities_and_rejects_stale_revision(self):
        proposal = frappe._dict(
            name="MST-WFP-U", status="Approved", requested_by="maker@example.test",
            reviewed_by="checker@example.test", descriptor_hash="a" * 64,
            compiled_graph_hash="b" * 64,
        )
        preview = {
            "proposal": proposal.name, "operation": "update", "doctype": "Customer",
            "record_name": "DISPOSABLE-U", "record_revision": "rev-1",
        }
        current = {
            **preview, "current": True, "executed": False,
            "fields": [{"fieldname": "customer_name", "label": "Customer Name", "control": "fill", "value": "Acme"}],
        }

        def reviewer(_proposal, user):
            if user == "maker@example.test":
                raise frappe.PermissionError("different reviewer required")

        def preview_for(_name, user):
            if user != "maker@example.test":
                raise frappe.PermissionError("requester only")
            return preview

        def preflight(_name, _user, _record, revision):
            if revision != "rev-1":
                raise WorkflowProposalError("stale")
            return current

        with (
            patch("muster.demo.native_desk_rbac_evidence.frappe.get_doc", return_value=proposal),
            patch("muster.demo.native_desk_rbac_evidence.proposal_attended_operation", return_value="update"),
            patch("muster.demo.native_desk_rbac_evidence.assert_attended_reviewer", side_effect=reviewer),
            patch("muster.demo.native_desk_rbac_evidence.attended_proposal_preview", side_effect=preview_for),
            patch("muster.demo.native_desk_rbac_evidence.preflight_attended_proposal_save", side_effect=preflight),
        ):
            result = _proposal_evidence(proposal.name, "update", None)
        self.assertTrue(result["maker_self_approval_denied"])
        self.assertTrue(result["checker_preview_denied"])
        self.assertTrue(result["stale_revision_denied"])
        self.assertEqual(result["reviewed_field_names"], ["customer_name"])
        self.assertFalse(result["executed"])

    def test_delete_probe_rejects_stale_approval_binding_without_execution(self):
        proposal = frappe._dict(
            name="MST-WFP-D", status="Approved", requested_by="maker@example.test",
            reviewed_by="checker@example.test", descriptor_hash="a" * 64,
            compiled_graph_hash="b" * 64,
        )
        preview = {
            "proposal": proposal.name, "operation": "delete", "doctype": "Customer",
            "record_name": "DISPOSABLE-D", "record_revision": "rev-1", "approval_proof": "c" * 64,
        }

        def reviewer(_proposal, user):
            if user == "maker@example.test":
                raise frappe.PermissionError("different reviewer required")

        def preview_for(_name, user):
            if user != "maker@example.test":
                raise frappe.PermissionError("requester only")
            return preview

        def delete_revision(_name, _user, _record, revision, _proof):
            if revision != "rev-1":
                raise WorkflowProposalError("stale")
            return {"current": True, "executed": False}

        with (
            patch("muster.demo.native_desk_rbac_evidence.frappe.get_doc", return_value=proposal),
            patch("muster.demo.native_desk_rbac_evidence.proposal_attended_operation", return_value="delete"),
            patch("muster.demo.native_desk_rbac_evidence.assert_attended_reviewer", side_effect=reviewer),
            patch("muster.demo.native_desk_rbac_evidence.attended_proposal_preview", side_effect=preview_for),
            patch("muster.demo.native_desk_rbac_evidence.assert_attended_delete_revision", side_effect=delete_revision),
        ):
            result = _proposal_evidence(proposal.name, "delete", None)
        self.assertTrue(result["stale_revision_denied"])
        self.assertIsNone(result["reviewed_values_sha256"])
        self.assertFalse(result["executed"])
