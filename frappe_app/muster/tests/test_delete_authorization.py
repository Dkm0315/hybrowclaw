from __future__ import annotations

from unittest.mock import Mock, patch

import frappe
from frappe.tests import IntegrationTestCase

from muster.orchestration.delete_authorization import (
    consume_attended_delete_authorization,
    issue_attended_delete_authorization,
    verify_attended_delete,
)
from muster.orchestration.workflow_proposal import WorkflowProposalError


ACTOR = "delete-maker@example.test"
PROPOSAL = "MST-WFP-DISPOSABLE-DELETE"
RECORD = "MST-DISPOSABLE-DELETE-1"


def snapshot(**changes):
    value = {
        "proposal": PROPOSAL,
        "operation": "delete",
        "doctype": "Customer",
        "record_name": RECORD,
        "record_revision": "2026-07-20 10:11:12.123456",
        "approval_proof": "a" * 64,
        "plan_hash": "b" * 64,
        "delete_authorized": True,
    }
    value.update(changes)
    return value


class Authorization(frappe._dict):
    def db_set(self, values, value=None, **_kwargs):
        if isinstance(values, dict):
            self.update(values)
        else:
            self[values] = value


def authorization(**changes):
    value = Authorization(
        name="MST-ADA-DISPOSABLE-1",
        status="Issued",
        proposal=PROPOSAL,
        actor=ACTOR,
        site="test.local",
        target_doctype="Customer",
        record_name=RECORD,
        record_revision="2026-07-20 10:11:12.123456",
        plan_hash="b" * 64,
        approval_proof="a" * 64,
        token_hash="",
        expires_at="2099-01-01 00:00:00",
        consumed_at=None,
        verification_token_hash="",
        verification_expires_at="2099-01-01 00:00:00",
    )
    value.update(changes)
    return value


class TestAttendedDeleteAuthorization(IntegrationTestCase):
    def test_issue_binds_exact_identity_and_stores_only_token_hash(self):
        inserted = {}

        def get_doc(value):
            inserted.update(value)
            doc = Authorization(name="MST-ADA-DISPOSABLE-1", **value)
            doc.insert = Mock(return_value=doc)
            return doc

        with (
            patch("muster.orchestration.delete_authorization.frappe.db.exists", return_value=False),
            patch("muster.orchestration.delete_authorization.frappe.get_doc", side_effect=get_doc),
            patch("muster.orchestration.delete_authorization.trusted_attended_delete_snapshot", return_value=snapshot()),
            patch("muster.orchestration.delete_authorization._site", return_value="test.local"),
        ):
            result = issue_attended_delete_authorization(PROPOSAL, ACTOR, RECORD, "issue-disposable-1")
        self.assertTrue(result["issued"])
        self.assertNotEqual(inserted["token_hash"], result["authorization_token"])
        self.assertEqual(len(inserted["token_hash"]), 64)
        self.assertEqual(inserted["site"], "test.local")
        self.assertEqual(inserted["plan_hash"], "b" * 64)
        self.assertNotIn("authorization_token", inserted)

    def test_issue_replay_and_wrong_typed_name_fail_closed(self):
        with patch("muster.orchestration.delete_authorization.frappe.db.exists", return_value=True):
            with self.assertRaisesRegex(WorkflowProposalError, "already used"):
                issue_attended_delete_authorization(PROPOSAL, ACTOR, RECORD, "replayed-key")
        with (
            patch("muster.orchestration.delete_authorization.frappe.db.exists", return_value=False),
            patch("muster.orchestration.delete_authorization.trusted_attended_delete_snapshot", return_value=snapshot()),
        ):
            with self.assertRaisesRegex(WorkflowProposalError, "exact record name"):
                issue_attended_delete_authorization(PROPOSAL, ACTOR, "WRONG", "fresh-key")

    def test_consume_is_single_use_and_rechecks_all_live_evidence(self):
        from muster.orchestration.delete_authorization import _digest

        auth = authorization(token_hash=_digest("one-use-token"))
        with (
            patch("muster.orchestration.delete_authorization._lock", return_value=auth),
            patch("muster.orchestration.delete_authorization._site", return_value="test.local"),
            patch("muster.orchestration.delete_authorization.trusted_attended_delete_snapshot", return_value=snapshot()) as recheck,
        ):
            result = consume_attended_delete_authorization(auth.name, "one-use-token", ACTOR)
            self.assertTrue(result["consumed"])
            self.assertEqual(auth.status, "Consumed")
            self.assertEqual(len(auth.verification_token_hash), 64)
            recheck.assert_called_once_with(PROPOSAL, ACTOR)
            with self.assertRaisesRegex(WorkflowProposalError, "already been used"):
                consume_attended_delete_authorization(auth.name, "one-use-token", ACTOR)

    def test_consume_rejects_wrong_user_site_stale_revision_and_plan(self):
        from muster.orchestration.delete_authorization import _digest

        cases = [
            (authorization(actor="other@example.test", token_hash=_digest("token")), "test.local", snapshot()),
            (authorization(token_hash=_digest("token")), "other.local", snapshot()),
            (authorization(proposal="MST-WFP-WRONG", token_hash=_digest("token")), "test.local", snapshot()),
            (authorization(target_doctype="Supplier", token_hash=_digest("token")), "test.local", snapshot()),
            (authorization(record_name="MST-DISPOSABLE-WRONG", token_hash=_digest("token")), "test.local", snapshot()),
            (authorization(token_hash=_digest("token")), "test.local", snapshot(record_revision="stale")),
            (authorization(token_hash=_digest("token")), "test.local", snapshot(plan_hash="c" * 64)),
            (authorization(token_hash=_digest("token")), "test.local", snapshot(approval_proof="c" * 64)),
        ]
        for auth, site, live in cases:
            with self.subTest(site=site, revision=live["record_revision"], plan=live["plan_hash"][:1]):
                with (
                    patch("muster.orchestration.delete_authorization._lock", return_value=auth),
                    patch("muster.orchestration.delete_authorization._site", return_value=site),
                    patch("muster.orchestration.delete_authorization.trusted_attended_delete_snapshot", return_value=live),
                ):
                    with self.assertRaises((WorkflowProposalError, frappe.PermissionError)):
                        consume_attended_delete_authorization(auth.name, "token", ACTOR)
                    self.assertEqual(auth.status, "Issued")

    def test_revoked_role_or_delete_permission_stops_before_consumption(self):
        from muster.orchestration.delete_authorization import _digest

        auth = authorization(token_hash=_digest("token"))
        with (
            patch("muster.orchestration.delete_authorization._lock", return_value=auth),
            patch("muster.orchestration.delete_authorization._site", return_value="test.local"),
            patch(
                "muster.orchestration.delete_authorization.trusted_attended_delete_snapshot",
                side_effect=frappe.PermissionError("revoked"),
            ),
        ):
            with self.assertRaises(frappe.PermissionError):
                consume_attended_delete_authorization(auth.name, "token", ACTOR)
        self.assertEqual(auth.status, "Issued")

    def test_verify_absence_seals_receipt_and_replay_fails(self):
        from muster.orchestration.delete_authorization import _digest

        auth = authorization(
            status="Consumed", verification_token_hash=_digest("verify-token"),
            consumed_at="2026-07-20 10:12:00",
        )
        with (
            patch("muster.orchestration.delete_authorization._lock", return_value=auth),
            patch("muster.orchestration.delete_authorization._site", return_value="test.local"),
            patch("muster.orchestration.delete_authorization.frappe.db.exists", return_value=False),
        ):
            result = verify_attended_delete(auth.name, "verify-token", ACTOR)
            self.assertTrue(result["verified"])
            self.assertEqual(auth.status, "Verified")
            self.assertEqual(len(auth.receipt_hash), 64)
            self.assertNotIn("verify-token", auth.evidence_json)
            with self.assertRaisesRegex(WorkflowProposalError, "already been completed"):
                verify_attended_delete(auth.name, "verify-token", ACTOR)

    def test_post_delete_verification_failure_is_persistently_evidenced(self):
        from muster.orchestration.delete_authorization import _digest

        auth = authorization(
            status="Consumed", verification_token_hash=_digest("verify-token"),
            consumed_at="2026-07-20 10:12:00",
        )
        with (
            patch("muster.orchestration.delete_authorization._lock", return_value=auth),
            patch("muster.orchestration.delete_authorization._site", return_value="test.local"),
            patch("muster.orchestration.delete_authorization.frappe.db.exists", return_value=True),
        ):
            result = verify_attended_delete(auth.name, "verify-token", ACTOR)
        self.assertFalse(result["verified"])
        self.assertTrue(result["needs_attention"])
        self.assertEqual(auth.status, "Failed")
        self.assertIn("verification_failed_record_present", auth.evidence_json)
