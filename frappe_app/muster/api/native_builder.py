from __future__ import annotations

import json
import re
from functools import wraps
from typing import Any, Mapping
from zoneinfo import ZoneInfo

import frappe
from frappe import _
from frappe.utils import get_datetime, get_system_timezone, now_datetime

from muster.automation.authority import authorize_change_set
from muster.automation.engine import _expected_matches
from muster.automation.engine import apply as apply_plan
from muster.automation.engine import preview as preview_plan
from muster.automation.engine import rollback as rollback_plan
from muster.automation.frappe_backend import FrappeNativeBackend
from muster.automation.models import (
    ApprovalEvidence,
    ArtifactChangeSet,
    AutomationConflictError,
    AutomationPermissionError,
    AutomationValidationError,
    execution_from_dict,
    plan_from_dict,
)
from muster.change_ir.security import permission_epoch, schema_revision
from muster.automation.source_provenance import bind_artifact_citations, source_binding
from muster.orchestration.source_ingestion import ingest_frappe_file


def _require_post() -> None:
    if frappe.request and frappe.request.method != "POST":
        frappe.throw(_("This endpoint only accepts POST requests"), frappe.PermissionError)


def _api_errors(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        try:
            return function(*args, **kwargs)
        except AutomationPermissionError as exc:
            frappe.throw(str(exc), frappe.PermissionError)
        except (AutomationValidationError, AutomationConflictError) as exc:
            frappe.throw(str(exc), frappe.ValidationError)
    return wrapped


def _actor() -> str:
    actor = frappe.session.user
    if not actor or actor == "Guest":
        frappe.throw(_("Authentication is required"), frappe.AuthenticationError)
    if not frappe.db.get_value("User", actor, "enabled"):
        frappe.throw(_("The current Frappe user is disabled"), frappe.PermissionError)
    return actor


def _object(value: dict | str, label: str) -> dict[str, Any]:
    try:
        payload = json.loads(value) if isinstance(value, str) else value
    except (TypeError, ValueError) as exc:
        raise AutomationValidationError(f"{label} must be valid JSON") from exc
    if not isinstance(payload, dict):
        raise AutomationValidationError(f"{label} must be a JSON object")
    return payload


def _source_from_intent(intent: dict | str, actor: str) -> ArtifactChangeSet:
    payload = _object(intent, "artifact intent")
    allowed = {"schema_version", "mission", "artifacts", "source_file"}
    if set(payload) - allowed:
        raise AutomationValidationError(
            "artifact intent cannot supply actor, target site, authority, approval, or plan state"
        )
    artifacts = payload.get("artifacts")
    evidence = None
    if payload.get("source_file"):
        evidence = ingest_frappe_file(str(payload["source_file"]), user=actor)
        artifacts = bind_artifact_citations(artifacts, evidence)
    return ArtifactChangeSet.from_dict({
        "schema_version": payload.get("schema_version") or "1.0",
        "target_site": frappe.local.site,
        "actor": actor,
        "mission": payload.get("mission"),
        "artifacts": artifacts,
        **({"source_evidence": source_binding(evidence).as_dict()} if evidence else {}),
    })


def _check_control_permissions(source: ArtifactChangeSet, *, create: bool) -> None:
    mission = frappe.get_doc("Muster Mission", source.mission)
    if not mission.has_permission("read", user=source.actor):
        frappe.throw(_("Not permitted to use this Mission"), frappe.PermissionError)
    if create and not frappe.has_permission("Muster Change Set", "create", user=source.actor):
        frappe.throw(_("Not permitted to create governed Change Sets"), frappe.PermissionError)


def _load_plan(change_set_name: str, actor: str, *, enforce_schema: bool = True):
    if not isinstance(change_set_name, str) or not change_set_name or len(change_set_name) > 140:
        raise AutomationValidationError("change_set must be a valid name")
    doc = frappe.get_doc("Muster Change Set", change_set_name)
    if not doc.has_permission("write", user=actor):
        frappe.throw(_("Not permitted to apply this Change Set"), frappe.PermissionError)
    if doc.actor != actor or doc.target_site != frappe.local.site:
        frappe.throw(_("Change Set authority does not match the current session"), frappe.PermissionError)
    if doc.permission_epoch != permission_epoch(actor):
        frappe.throw(_("Frappe permissions changed after preview; preview again"), frappe.PermissionError)
    if enforce_schema and doc.schema_revision != schema_revision():
        frappe.throw(_("Frappe metadata changed after preview; preview again"), frappe.ValidationError)
    try:
        envelope = json.loads(doc.evidence_json or "{}")
    except (TypeError, ValueError) as exc:
        raise AutomationValidationError("stored native artifact plan evidence is invalid") from exc
    if not isinstance(envelope, Mapping) or set(envelope) != {"kind", "plan"} or \
            envelope.get("kind") != "native_artifact_plan":
        raise AutomationValidationError("Change Set is not a native artifact plan")
    plan = plan_from_dict(envelope["plan"])
    if plan.plan_hash != doc.plan_hash or plan.source.mission != doc.mission:
        raise AutomationValidationError("stored native artifact plan is not bound to its Change Set")
    if plan.source.source_evidence:
        FrappeNativeBackend().validate_change_set_source(plan.source)
    return doc, plan


def _load_approval(doc, plan, required_class: str | None = None) -> ApprovalEvidence | None:
    required = required_class or plan.approval_class
    if required == "None":
        return None
    approvals = frappe.get_all(
        "Muster Approval",
        filters={"change_set": doc.name, "status": "Approved",
                 "action_hash": plan.plan_hash, "approval_class": required,
                 "requested_by": plan.source.actor},
        fields=["requested_by", "decided_by", "decided_at", "expires_at"],
        order_by="decided_at desc", limit_page_length=20,
    )
    now = now_datetime()
    for row in approvals:
        if not row.decided_by or row.decided_by == row.requested_by or not row.decided_at:
            continue
        if get_datetime(row.decided_at) > now or not row.expires_at or get_datetime(row.expires_at) <= now:
            continue
        roles = frozenset(frappe.get_roles(row.decided_by))
        if not roles.intersection({"Muster Approver", "Muster Administrator", "System Manager"}):
            continue
        return ApprovalEvidence(
            plan_hash=plan.plan_hash, approval_class=required,
            requested_by=row.requested_by, decided_by=row.decided_by,
            decided_at=_approval_time(row.decided_at), expires_at=_approval_time(row.expires_at),
            approver_roles=roles,
        )
    frappe.throw(_("A current independent {0} approval for this exact plan is required").format(
        required), frappe.PermissionError)


def _approval_time(value: Any) -> str:
    """Serialize Frappe's site-local naive timestamps with their real timezone."""
    parsed = get_datetime(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=ZoneInfo(get_system_timezone()))
    return parsed.isoformat()


@frappe.whitelist()
@_api_errors
def preview(intent: dict | str) -> dict[str, Any]:
    """Persist an immutable, reviewable plan; caller identity is never accepted."""
    _require_post()
    actor = _actor()
    source = _source_from_intent(intent, actor)
    _check_control_permissions(source, create=True)
    backend = FrappeNativeBackend()
    effective, _propose_governance = authorize_change_set(source, backend, stage="propose")
    # Bind apply-time policy and its approval floor into the immutable preview,
    # avoiding a lower propose-only approval that can never be safely applied.
    effective, governance = authorize_change_set(effective, backend, stage="apply")
    plan = preview_plan(effective, backend, governance)
    change_set_name = backend.persist_preview(plan)
    return {
        "change_set": change_set_name, "plan_hash": plan.plan_hash,
        "approval_class": plan.approval_class,
        "changes": [{
            **change.as_dict(),
            **({"source_citations": [
                citation.as_dict() for citation in plan.source.artifacts[index].source_citations
            ]} if plan.source.artifacts[index].source_citations else {}),
        } for index, change in enumerate(plan.changes)],
        **({"source_evidence": plan.source.source_evidence.as_dict()}
           if plan.source.source_evidence else {}),
    }


@frappe.whitelist()
@_api_errors
def apply(change_set: str) -> dict[str, Any]:
    """Apply only a server-persisted preview after re-deriving all live authority."""
    _require_post()
    actor = _actor()
    already_verified = frappe.db.get_value("Muster Change Set", change_set, "status") == "Verified"
    doc, stored = _load_plan(change_set, actor, enforce_schema=not already_verified)
    if doc.status not in {"Preflighted", "Awaiting Approval", "Approved", "Verified"}:
        frappe.throw(_("Change Set is not in an applicable state"), frappe.ValidationError)
    backend = FrappeNativeBackend()
    effective, governance = authorize_change_set(stored.source, backend, stage="apply")
    if doc.status == "Verified":
        execution = execution_from_dict(json.loads(doc.verification_json or "{}"))
        return {**execution.as_dict(), "replayed": True}
    fresh = preview_plan(effective, backend, governance)
    if fresh.plan_hash != stored.plan_hash:
        frappe.throw(_("Artifact state or live policy changed after preview; preview again"),
                     frappe.ValidationError)
    evidence = apply_plan(stored, backend, governance, _load_approval(doc, stored))
    return evidence.as_dict()


def validate_gateway_bound(change_set: str, intent: dict, actor: str):
    """Validate that an existing native preview is exactly the gateway's typed intent."""
    doc, stored = _load_plan(change_set, actor)
    expected = _source_from_intent(intent, actor)
    if stored.source.as_dict() != expected.as_dict():
        frappe.throw(_("The native Change Set is bound to another effect intent"), frappe.PermissionError)
    if doc.status not in {"Preflighted", "Awaiting Approval", "Approved", "Verified"}:
        frappe.throw(_("The native Change Set is not applicable"), frappe.ValidationError)
    return doc, stored


def apply_gateway_bound(change_set: str, intent: dict, gateway_plan_hash: str, receipt_name: str) -> dict[str, Any]:
    """Apply through the native engine using an independently checked gateway-bound approval."""
    actor = _actor()
    doc, stored = validate_gateway_bound(change_set, intent, actor)
    if doc.status == "Verified":
        execution = execution_from_dict(json.loads(doc.verification_json or "{}"))
        return {**execution.as_dict(), "replayed": True}
    receipt = frappe.get_doc("Muster Approval", receipt_name)
    if receipt.change_set != doc.name or receipt.status != "Approved" or receipt.action_hash != gateway_plan_hash or receipt.requested_by != actor:
        frappe.throw(_("The approval is not bound to this gateway plan and native Change Set"), frappe.PermissionError)
    if not receipt.decided_by or receipt.decided_by == actor or not receipt.decided_at or not receipt.expires_at or get_datetime(receipt.expires_at) <= now_datetime():
        frappe.throw(_("The gateway-bound native approval is not current and independent"), frappe.PermissionError)
    roles = frozenset(frappe.get_roles(receipt.decided_by))
    if not roles.intersection({"Muster Approver", "Muster Administrator", "System Manager"}):
        frappe.throw(_("The native approver no longer has approval authority"), frappe.PermissionError)
    backend = FrappeNativeBackend()
    effective, governance = authorize_change_set(stored.source, backend, stage="apply")
    fresh = preview_plan(effective, backend, governance)
    if fresh.plan_hash != stored.plan_hash:
        frappe.throw(_("Artifact state or live policy changed after preview; preview again"), frappe.ValidationError)
    approval = ApprovalEvidence(
        plan_hash=stored.plan_hash, approval_class=stored.approval_class,
        requested_by=actor, decided_by=receipt.decided_by,
        decided_at=_approval_time(receipt.decided_at), expires_at=_approval_time(receipt.expires_at),
        approver_roles=roles,
    ) if stored.approval_class != "None" else None
    return apply_plan(stored, backend, governance, approval).as_dict()


def observe_gateway_bound(change_set: str, intent: dict, actor: str) -> dict[str, Any]:
    """Independently reread every typed artifact; never trust the apply receipt."""
    doc, stored = validate_gateway_bound(change_set, intent, actor)
    backend = FrappeNativeBackend()
    artifacts = []
    verified = doc.status == "Verified"
    for index, change in enumerate(stored.changes):
        fields = tuple(sorted(set(change.after) - {"doctype", "modified"}))
        observed, revision = backend.snapshot(change.target_doctype, change.target_name, fields)
        matches = observed is not None and _expected_matches(observed, change.after)
        verified = verified and matches
        artifacts.append({
            "artifactId": change.artifact_id, "doctype": change.target_doctype,
            "name": change.target_name, "revision": revision or "", "verified": matches,
            **({"sourceCitations": [
                citation.as_dict() for citation in stored.source.artifacts[index].source_citations
            ]} if stored.source.artifacts[index].source_citations else {}),
        })
    return {
        "status": doc.status, "change_set": doc.name, "nativePlanHash": stored.plan_hash,
        "verified": verified, "artifactCount": len(artifacts), "artifacts": artifacts,
        **({"sourceEvidenceHash": stored.source.source_evidence.evidence_hash}
           if stored.source.source_evidence else {}),
    }


@frappe.whitelist()
@_api_errors
def rollback(change_set: str) -> dict[str, Any]:
    """Compensate a verified execution using stored inverses and a live destructive approval."""
    _require_post()
    actor = _actor()
    doc, plan = _load_plan(change_set, actor, enforce_schema=False)
    if doc.status != "Verified":
        frappe.throw(_("Only a verified native artifact execution can be rolled back"),
                     frappe.ValidationError)
    backend = FrappeNativeBackend()
    _effective, governance = authorize_change_set(plan.source, backend, stage="rollback")
    try:
        serialized = json.loads(doc.verification_json or "{}")
    except (TypeError, ValueError) as exc:
        raise AutomationValidationError("stored native artifact execution evidence is invalid") from exc
    execution = execution_from_dict(serialized)
    approval = _load_approval(doc, plan, "Destructive")
    result = rollback_plan(plan, execution, backend, governance, approval)
    return result.as_dict()


_ATTENDED_NATIVE_KINDS = {
    "custom_field", "property_setter", "doctype", "query_report", "script_report",
    "print_format", "page", "web_page",
    "client_script", "server_script", "email_template",
}
_ATTENDED_FORBIDDEN_FIELD = re.compile(
    r"password|passwd|secret|api.?key|token|authorization|cookie|private.?key", re.I
)


def _attended_native_projection(doc, plan, *, rollback_review: bool = False) -> dict[str, Any]:
    if len(plan.changes) != 1 or plan.changes[0].kind not in _ATTENDED_NATIVE_KINDS:
        raise AutomationValidationError(
            "attended native customization requires exactly one supported artifact"
        )
    change = plan.changes[0]
    manifest = plan.source.artifacts[0]
    if change.action not in {"create", "update"}:
        raise AutomationValidationError("attended native customization has no form mutation to review")
    meta = frappe.get_meta(change.target_doctype)
    fields = []
    if not rollback_review:
        for fieldname, value in change.after.items():
            if fieldname in {"name", "doctype", "modified"} or _ATTENDED_FORBIDDEN_FIELD.search(fieldname):
                continue
            field = meta.get_field(fieldname)
            if not field or field.fieldtype in {"Password", "Attach", "Attach Image", "HTML", "Button"}:
                continue
            fields.append({
                "fieldname": fieldname, "label": str(field.label or fieldname)[:140],
                "fieldtype": str(field.fieldtype), "value": value,
            })
        if not fields:
            raise AutomationValidationError("native artifact has no attended form fields")
    required = "Destructive" if rollback_review else plan.approval_class
    authorized = False
    try:
        _load_approval(doc, plan, required)
        authorized = True
    except frappe.PermissionError:
        authorized = False
    source = plan.source.source_evidence
    return {
        "schema_version": 1, "change_set": doc.name, "plan_hash": plan.plan_hash,
        "operation": "rollback" if rollback_review else change.action,
        "artifact_kind": change.kind, "doctype": change.target_doctype,
        "document_name": change.target_name, "approval_class": required,
        "apply_authorized": authorized, "executed": False,
        "fields": fields,
        "source_citations": [citation.as_dict() for citation in manifest.source_citations],
        **({"source_evidence_hash": source.evidence_hash} if source else {}),
    }


@frappe.whitelist()
@_api_errors
def prepare_attended(change_set: str, confirmed: int | str = 0) -> dict[str, Any]:
    """Return one stored, source-bound native form projection without applying it."""
    _require_post()
    if str(confirmed) not in {"1", "True", "true"}:
        raise AutomationValidationError("explicit attended review confirmation is required")
    actor = _actor()
    doc, plan = _load_plan(change_set, actor)
    if doc.status not in {"Preflighted", "Awaiting Approval", "Approved"}:
        raise AutomationValidationError("native Change Set is not awaiting attended application")
    return _attended_native_projection(doc, plan)


@frappe.whitelist()
@_api_errors
def apply_attended(change_set: str, confirmed: int | str = 0) -> dict[str, Any]:
    """Apply the exact attended plan through the existing native execution engine."""
    _require_post()
    if str(confirmed) not in {"1", "True", "true"}:
        raise AutomationValidationError("explicit attended apply confirmation is required")
    actor = _actor()
    doc, plan = _load_plan(change_set, actor)
    projection = _attended_native_projection(doc, plan)
    if not projection["apply_authorized"]:
        raise AutomationPermissionError("a current independent approval is required")
    return apply(change_set)


@frappe.whitelist()
@_api_errors
def verify_attended(change_set: str) -> dict[str, Any]:
    """Independently reread a stored attended native result."""
    _require_post()
    actor = _actor()
    doc, plan = _load_plan(change_set, actor, enforce_schema=False)
    if doc.status != "Verified":
        raise AutomationValidationError("native Change Set is not verified")
    backend = FrappeNativeBackend()
    artifacts = []
    verified = True
    for index, change in enumerate(plan.changes):
        fields = tuple(sorted(set(change.after) - {"doctype", "modified"}))
        observed, revision = backend.snapshot(change.target_doctype, change.target_name, fields)
        matches = observed is not None and _expected_matches(observed, change.after)
        verified = verified and matches
        artifacts.append({
            "doctype": change.target_doctype, "name": change.target_name,
            "revision": revision or "", "verified": matches,
            "source_citations": [
                citation.as_dict() for citation in plan.source.artifacts[index].source_citations
            ],
        })
    return {"change_set": doc.name, "verified": verified, "artifacts": artifacts}


@frappe.whitelist()
@_api_errors
def prepare_attended_rollback(change_set: str, confirmed: int | str = 0) -> dict[str, Any]:
    _require_post()
    if str(confirmed) not in {"1", "True", "true"}:
        raise AutomationValidationError("explicit rollback review confirmation is required")
    actor = _actor()
    doc, plan = _load_plan(change_set, actor, enforce_schema=False)
    if doc.status != "Verified":
        raise AutomationValidationError("only a verified native Change Set can be reviewed for rollback")
    return _attended_native_projection(doc, plan, rollback_review=True)


@frappe.whitelist()
@_api_errors
def rollback_attended(change_set: str, confirmed: int | str = 0) -> dict[str, Any]:
    _require_post()
    if str(confirmed) not in {"1", "True", "true"}:
        raise AutomationValidationError("explicit attended rollback confirmation is required")
    actor = _actor()
    doc, plan = _load_plan(change_set, actor, enforce_schema=False)
    projection = _attended_native_projection(doc, plan, rollback_review=True)
    if not projection["apply_authorized"]:
        raise AutomationPermissionError("a current Destructive approval is required")
    return rollback(change_set)


@frappe.whitelist()
@_api_errors
def verify_attended_rollback(change_set: str) -> dict[str, Any]:
    _require_post()
    actor = _actor()
    doc, plan = _load_plan(change_set, actor, enforce_schema=False)
    if doc.status != "Repaired":
        raise AutomationValidationError("native Change Set rollback is not complete")
    backend = FrappeNativeBackend()
    artifacts = []
    verified = True
    for change in plan.changes:
        fields = tuple(sorted(set(change.after) - {"doctype", "modified"}))
        observed, revision = backend.snapshot(change.target_doctype, change.target_name, fields)
        matches = observed is None if change.before is None else (
            observed is not None and _expected_matches(observed, change.before)
        )
        verified = verified and matches
        artifacts.append({
            "doctype": change.target_doctype, "name": change.target_name,
            "revision": revision or "", "verified": matches,
        })
    return {"change_set": doc.name, "verified": verified, "artifacts": artifacts}
