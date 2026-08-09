from __future__ import annotations

import hmac
import json
import secrets
from hashlib import sha256
from typing import Any

import frappe
from frappe import _
from frappe.utils import add_to_date, get_datetime, now_datetime

from muster.orchestration.workflow_proposal import (
    WorkflowProposalError,
    trusted_attended_delete_snapshot,
)


AUTHORIZATION_TTL_MINUTES = 5
VERIFICATION_TTL_MINUTES = 5


def _digest(value: str) -> str:
    return sha256(value.encode()).hexdigest()


def _canonical(value: dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True, default=str)


def _site() -> str:
    site = str(getattr(frappe.local, "site", "") or "")
    if not site:
        raise WorkflowProposalError(_("The current site identity is unavailable"))
    return site


def _bounded(value: str, label: str, maximum: int) -> str:
    value = str(value or "")
    if not value or len(value) > maximum:
        raise WorkflowProposalError(_("A valid {0} is required").format(label))
    return value


def _lock(name: str):
    suffix = "" if frappe.db.db_type == "sqlite" else " for update"
    rows = frappe.db.sql(
        f"select name from `tabMuster Attended Delete Authorization` where name=%s{suffix}",
        name,
    )
    if not rows:
        frappe.throw(_("Delete authorization is unavailable"), frappe.PermissionError)
    return frappe.get_doc("Muster Attended Delete Authorization", name)


def _same(left: str, right: str) -> bool:
    return bool(left and right and hmac.compare_digest(str(left), str(right)))


def _assert_binding(authorization, actor: str, snapshot: dict[str, Any]) -> None:
    if authorization.site != _site() or authorization.actor != actor:
        frappe.throw(_("Delete authorization does not belong to this site and user"), frappe.PermissionError)
    expected = {
        "proposal": snapshot["proposal"],
        "target_doctype": snapshot["doctype"],
        "record_name": snapshot["record_name"],
        "record_revision": snapshot["record_revision"],
        "plan_hash": snapshot["plan_hash"],
        "approval_proof": snapshot["approval_proof"],
    }
    for fieldname, value in expected.items():
        if not _same(str(authorization.get(fieldname) or ""), str(value or "")):
            raise WorkflowProposalError(_("The record, permission, approval, or plan changed; prepare another delete review"))


def issue_attended_delete_authorization(
    proposal_name: str,
    actor: str,
    typed_record_name: str,
    issue_key: str,
) -> dict[str, Any]:
    """Mint one short-lived capability after exact-name confirmation."""
    proposal_name = _bounded(proposal_name, "proposal", 140)
    typed_record_name = _bounded(typed_record_name, "record name", 500)
    issue_key = _bounded(issue_key, "idempotency key", 140)
    if actor == "Guest":
        frappe.throw(_("Not permitted"), frappe.PermissionError)
    if frappe.db.exists("Muster Attended Delete Authorization", {"issue_key": issue_key}):
        raise WorkflowProposalError(_("This delete confirmation was already used; start a new review"))

    snapshot = trusted_attended_delete_snapshot(proposal_name, actor)
    if not _same(typed_record_name, snapshot["record_name"]):
        raise WorkflowProposalError(_("Type the exact record name to authorize deletion"))
    token = secrets.token_urlsafe(32)
    expires_at = add_to_date(now_datetime(), minutes=AUTHORIZATION_TTL_MINUTES, as_datetime=True)
    try:
        authorization = frappe.get_doc({
            "doctype": "Muster Attended Delete Authorization",
            "status": "Issued",
            "proposal": proposal_name,
            "actor": actor,
            "site": _site(),
            "target_doctype": snapshot["doctype"],
            "record_name": snapshot["record_name"],
            "record_revision": snapshot["record_revision"],
            "plan_hash": snapshot["plan_hash"],
            "approval_proof": snapshot["approval_proof"],
            "issue_key": issue_key,
            "token_hash": _digest(token),
            "expires_at": expires_at,
        }).insert(ignore_permissions=True)
    except frappe.DuplicateEntryError as error:
        raise WorkflowProposalError(
            _("This delete confirmation was already used; start a new review")
        ) from error
    return {
        "authorization": authorization.name,
        "authorization_token": token,
        "proposal": proposal_name,
        "doctype": snapshot["doctype"],
        "record_name": snapshot["record_name"],
        "expires_at": str(expires_at),
        "issued": True,
        "executed": False,
    }


def consume_attended_delete_authorization(
    authorization_name: str,
    token: str,
    actor: str,
) -> dict[str, Any]:
    """Consume exactly once immediately before the visible native confirmation."""
    authorization_name = _bounded(authorization_name, "authorization", 140)
    token = _bounded(token, "authorization token", 256)
    authorization = _lock(authorization_name)
    if authorization.status != "Issued":
        raise WorkflowProposalError(_("This delete authorization has already been used"))
    if get_datetime(authorization.expires_at) <= now_datetime():
        authorization.db_set("status", "Expired", update_modified=False)
        return {
            "authorization": authorization.name,
            "consumed": False,
            "executed": False,
            "expired": True,
        }
    if not _same(authorization.token_hash, _digest(token)):
        frappe.throw(_("Delete authorization is invalid"), frappe.PermissionError)

    # Rebuild all proposal, schema, reviewer, record revision and live RBAC
    # evidence under the original requester's current authority.
    snapshot = trusted_attended_delete_snapshot(authorization.proposal, actor)
    _assert_binding(authorization, actor, snapshot)

    verification_token = secrets.token_urlsafe(32)
    consumed_at = now_datetime()
    verification_expires_at = add_to_date(
        consumed_at, minutes=VERIFICATION_TTL_MINUTES, as_datetime=True
    )
    authorization.db_set({
        "status": "Consumed",
        "consumed_at": consumed_at,
        "verification_token_hash": _digest(verification_token),
        "verification_expires_at": verification_expires_at,
    }, update_modified=False)
    return {
        "authorization": authorization.name,
        "verification_token": verification_token,
        "proposal": authorization.proposal,
        "doctype": authorization.target_doctype,
        "record_name": authorization.record_name,
        "consumed": True,
        "executed": False,
    }


def verify_attended_delete(
    authorization_name: str,
    verification_token: str,
    actor: str,
) -> dict[str, Any]:
    """Prove absence and seal a sanitized receipt; never performs deletion."""
    authorization_name = _bounded(authorization_name, "authorization", 140)
    verification_token = _bounded(verification_token, "verification token", 256)
    authorization = _lock(authorization_name)
    if authorization.status != "Consumed":
        raise WorkflowProposalError(_("This delete verification has already been completed"))
    if authorization.site != _site() or authorization.actor != actor:
        frappe.throw(_("Delete verification does not belong to this site and user"), frappe.PermissionError)
    if get_datetime(authorization.verification_expires_at) <= now_datetime():
        checked_at = now_datetime()
        evidence = {
            "schema_version": 1,
            "authorization": authorization.name,
            "proposal": authorization.proposal,
            "actor": authorization.actor,
            "site": authorization.site,
            "target": {
                "doctype": authorization.target_doctype,
                "record_name": authorization.record_name,
                "record_revision": authorization.record_revision,
            },
            "plan_hash": authorization.plan_hash,
            "approval_proof": authorization.approval_proof,
            "consumed_at": str(authorization.consumed_at),
            "verified_at": str(checked_at),
            "result": "verification_expired_unknown",
        }
        evidence_json = _canonical(evidence)
        receipt_hash = _digest(evidence_json)
        authorization.db_set({
            "status": "Failed",
            "verified_at": checked_at,
            "receipt_hash": receipt_hash,
            "evidence_json": json.dumps(evidence, ensure_ascii=False, indent=2, sort_keys=True),
        }, update_modified=False)
        return {
            "authorization": authorization.name,
            "verified": False,
            "receipt_hash": receipt_hash,
            "executed": False,
            "expired": True,
            "needs_attention": True,
        }
    if not _same(authorization.verification_token_hash, _digest(verification_token)):
        frappe.throw(_("Delete verification is invalid"), frappe.PermissionError)

    absent = not frappe.db.exists(authorization.target_doctype, authorization.record_name)
    verified_at = now_datetime()
    receipt = {
        "schema_version": 1,
        "authorization": authorization.name,
        "proposal": authorization.proposal,
        "actor": authorization.actor,
        "site": authorization.site,
        "target": {
            "doctype": authorization.target_doctype,
            "record_name": authorization.record_name,
            "record_revision": authorization.record_revision,
        },
        "plan_hash": authorization.plan_hash,
        "approval_proof": authorization.approval_proof,
        "consumed_at": str(authorization.consumed_at),
        "verified_at": str(verified_at),
        "result": "deleted_and_absent" if absent else "verification_failed_record_present",
    }
    receipt_json = _canonical(receipt)
    receipt_hash = _digest(receipt_json)
    authorization.db_set({
        "status": "Verified" if absent else "Failed",
        "verified_at": verified_at,
        "receipt_hash": receipt_hash,
        "evidence_json": json.dumps(receipt, ensure_ascii=False, indent=2, sort_keys=True),
    }, update_modified=False)
    if not absent:
        return {
            "authorization": authorization.name,
            "proposal": authorization.proposal,
            "doctype": authorization.target_doctype,
            "record_name": authorization.record_name,
            "verified": False,
            "receipt_hash": receipt_hash,
            "executed": False,
            "needs_attention": True,
        }
    return {
        "authorization": authorization.name,
        "proposal": authorization.proposal,
        "doctype": authorization.target_doctype,
        "record_name": authorization.record_name,
        "verified": True,
        "receipt_hash": receipt_hash,
        "executed": True,
    }
