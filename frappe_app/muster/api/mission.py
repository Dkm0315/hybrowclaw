from __future__ import annotations

import json
from typing import Any

import frappe
from frappe import _
from frappe.utils import cint

from muster.change_ir.executor import apply_document, preflight as preflight_change_set
from muster.change_ir.schema import ChangeSet
from muster.orchestration.service import create_mission, request_control
from muster.orchestration.delete_authorization import (
    consume_attended_delete_authorization,
    issue_attended_delete_authorization,
    verify_attended_delete,
)
from muster.orchestration.workflow_proposal import (
    assert_attended_delete_revision,
    assert_attended_update_revision,
    assert_destructive_reviewer,
    assert_attended_reviewer,
    attended_proposal_preview,
    issue_destructive_approval_evidence,
    preflight_attended_proposal_save,
    publish_approved_proposal,
    proposal_attended_operation,
    request_workflow_proposal,
    start_published_proposal_mission,
    validate_workflow_descriptor,
    verify_attended_proposal_record,
)


def _require_post() -> None:
    if frappe.request and frappe.request.method != "POST":
        frappe.throw(_("This endpoint only accepts POST requests"), frappe.PermissionError)


def _idempotency_key() -> str:
    key = frappe.get_request_header("Idempotency-Key") or frappe.form_dict.get("idempotency_key")
    if not key or len(key) > 140:
        frappe.throw(_("A valid Idempotency-Key is required"), frappe.ValidationError)
    return key


@frappe.whitelist()
def start(objective: str, workflow: str | None = None, scope: str | None = None) -> dict[str, Any]:
    _require_post()
    return create_mission(
        objective=objective,
        workflow=workflow,
        scope=json.loads(scope) if isinstance(scope, str) and scope else (scope or {}),
        idempotency_key=_idempotency_key(),
    )


@frappe.whitelist()
def plan(objective: str, scope: str | dict | None = None) -> dict[str, Any]:
    """Ask the trusted gateway for an inert, reviewable workflow proposal."""
    _require_post()
    try:
        parsed_scope = json.loads(scope) if isinstance(scope, str) and scope else (scope or {})
    except (TypeError, ValueError) as error:
        frappe.throw(_("Planning scope must be valid JSON"), frappe.ValidationError)
        raise error  # unreachable; keeps type checkers precise
    return request_workflow_proposal(objective, parsed_scope, _idempotency_key())


@frappe.whitelist()
def review_proposal(proposal: str, action: str) -> dict[str, Any]:
    """Record review only. Approval deliberately does not publish or execute."""
    _require_post()
    _idempotency_key()
    roles = set(frappe.get_roles())
    if frappe.session.user != "Administrator" and not roles.intersection(
        {"System Manager", "Muster Administrator", "Muster Automation Manager", "Muster Approver"}
    ):
        frappe.throw(_("Not permitted"), frappe.PermissionError)
    if action not in {"approve", "reject"}:
        frappe.throw(_("Review action must be approve or reject"), frappe.ValidationError)
    doc = frappe.get_doc("Muster Workflow Proposal", proposal)
    if not doc.has_permission("write"):
        frappe.throw(_("Not permitted"), frappe.PermissionError)
    if doc.status != "Proposed":
        frappe.throw(_("Only a proposed workflow can be reviewed"), frappe.ValidationError)
    # Re-validate the immutable snapshot and original maximum authority at the
    # decision boundary. Publication will perform live authority checks again.
    validate_workflow_descriptor(json.loads(doc.descriptor_json), json.loads(doc.capabilities_json))
    reviewed_at = frappe.utils.now_datetime()
    update = {
        "status": "Approved" if action == "approve" else "Rejected",
        "reviewed_by": frappe.session.user,
        "reviewed_at": reviewed_at,
    }
    if action == "approve":
        assert_attended_reviewer(doc, frappe.session.user)
        if proposal_attended_operation(doc) == "delete":
            evidence = issue_destructive_approval_evidence(doc, frappe.session.user, reviewed_at)
            update.update({
                "destructive_record_revision": evidence["record_revision"],
                "destructive_approval_proof": evidence["approval_proof"],
            })
    doc.db_set(update, update_modified=True)
    return {"proposal": doc.name, "status": doc.status, "executed": False}


@frappe.whitelist()
def publish_proposal(proposal: str, root_agent: str, policy: str) -> dict[str, Any]:
    """Create and publish a native, versioned workflow from approved inert IR."""
    _require_post()
    return publish_approved_proposal(
        proposal, root_agent, policy, _idempotency_key()
    )


@frappe.whitelist()
def start_proposal(proposal: str, confirmed: int | str = 0) -> dict[str, Any]:
    """Explicitly start a Mission pinned to a published proposal snapshot."""
    _require_post()
    return start_published_proposal_mission(
        proposal, _idempotency_key(), confirmed=confirmed
    )


@frappe.whitelist()
def prepare_attended_preview(proposal: str, confirmed: int | str = 0) -> dict[str, Any]:
    """Stage reviewed values in the requester's real Desk form without saving."""
    _require_post()
    _idempotency_key()
    if not cint(confirmed):
        frappe.throw(_("Confirm before Muster takes you to the form"), frappe.ValidationError)
    return attended_proposal_preview(proposal, frappe.session.user)


@frappe.whitelist()
def verify_attended_save(
    proposal: str, record_name: str, confirmed: int | str = 0
) -> dict[str, Any]:
    """Verify a separately approved visible Save against the reviewed values."""
    _require_post()
    _idempotency_key()
    if not cint(confirmed):
        frappe.throw(_("Save verification requires explicit confirmation"), frappe.ValidationError)
    return verify_attended_proposal_record(proposal, frappe.session.user, record_name)


@frappe.whitelist()
def preflight_attended_save(
    proposal: str,
    record_name: str = "",
    record_revision: str = "",
    confirmed: int | str = 0,
) -> dict[str, Any]:
    """Read-only final authority check immediately before native Create/Save."""
    _require_post()
    _idempotency_key()
    if not cint(confirmed):
        frappe.throw(_("Save confirmation requires explicit confirmation"), frappe.ValidationError)
    return preflight_attended_proposal_save(
        proposal, frappe.session.user, record_name, record_revision
    )


@frappe.whitelist()
def recheck_attended_update(
    proposal: str,
    record_name: str,
    record_revision: str,
    confirmed: int | str = 0,
) -> dict[str, Any]:
    """Fail closed when an attended update changed since its visible review."""
    _require_post()
    _idempotency_key()
    if not cint(confirmed):
        frappe.throw(_("Update recheck requires explicit confirmation"), frappe.ValidationError)
    return assert_attended_update_revision(
        proposal, frappe.session.user, record_name, record_revision
    )


@frappe.whitelist()
def recheck_attended_delete(
    proposal: str,
    record_name: str,
    record_revision: str,
    approval_proof: str,
    confirmed: int | str = 0,
) -> dict[str, Any]:
    """Recheck destructive dual control and live delete RBAC before menu reveal."""
    _require_post()
    _idempotency_key()
    if not cint(confirmed):
        frappe.throw(_("Delete review recheck requires explicit confirmation"), frappe.ValidationError)
    return assert_attended_delete_revision(
        proposal, frappe.session.user, record_name, record_revision, approval_proof
    )


@frappe.whitelist()
def issue_attended_delete(
    proposal: str, typed_record_name: str, confirmed: int | str = 0,
) -> dict[str, Any]:
    """Issue a one-use capability after exact-name destructive confirmation."""
    _require_post()
    if not cint(confirmed):
        frappe.throw(_("Exact-name delete confirmation is required"), frappe.ValidationError)
    return issue_attended_delete_authorization(
        proposal, frappe.session.user, typed_record_name, _idempotency_key()
    )


@frappe.whitelist()
def consume_attended_delete(
    authorization: str, authorization_token: str, confirmed: int | str = 0,
) -> dict[str, Any]:
    """Consume authorization just before the browser clicks native confirmation."""
    _require_post()
    _idempotency_key()
    if not cint(confirmed):
        frappe.throw(_("Native delete confirmation is required"), frappe.ValidationError)
    return consume_attended_delete_authorization(
        authorization, authorization_token, frappe.session.user
    )


@frappe.whitelist()
def verify_attended_delete_result(
    authorization: str, verification_token: str, confirmed: int | str = 0,
) -> dict[str, Any]:
    """Seal an evidence receipt only after Frappe proves the record is absent."""
    _require_post()
    _idempotency_key()
    if not cint(confirmed):
        frappe.throw(_("Delete verification confirmation is required"), frappe.ValidationError)
    return verify_attended_delete(
        authorization, verification_token, frappe.session.user
    )


@frappe.whitelist()
def control(mission: str, action: str, note: str | None = None) -> dict[str, Any]:
    _require_post()
    return request_control(mission, action, note, _idempotency_key())


@frappe.whitelist()
def preflight(change_set: dict | str) -> dict[str, Any]:
    _require_post()
    payload = json.loads(change_set) if isinstance(change_set, str) else change_set
    compiled = ChangeSet.from_dict(payload)
    return preflight_change_set(compiled)


@frappe.whitelist()
def apply(change_set: str) -> dict[str, Any]:
    _require_post()
    _idempotency_key()
    return apply_document(change_set)


@frappe.whitelist()
def activities(mission: str, after_sequence: int = 0, limit: int = 100) -> list[dict[str, Any]]:
    if not frappe.has_permission("Muster Mission", "read", mission):
        frappe.throw(_("Not permitted"), frappe.PermissionError)
    limit = min(max(cint(limit), 1), 200)
    return frappe.get_all(
        "Muster Activity",
        filters={"mission": mission, "sequence": [">", cint(after_sequence)]},
        fields=[
            "name", "sequence", "event_type", "state", "summary",
            "actor", "agent", "reference_doctype", "reference_name",
            "payload_json", "creation",
        ],
        order_by="sequence asc",
        limit=limit,
    )


@frappe.whitelist()
def sync(mission: str) -> dict[str, Any]:
    """Fetch and durably project the authenticated gateway mission snapshot."""
    from muster.orchestration.gateway_runtime import poll_and_project

    return poll_and_project(mission)
