from __future__ import annotations

import json
from hashlib import sha256
from typing import Any

import frappe
from frappe import _
from frappe.utils import get_datetime, now_datetime

from muster.adapters.identity import frappe_identity
from muster.change_ir.security import schema_revision
from muster.orchestration.workflow_graph import effect_intent


class MissionAwaitingEffectApproval(frappe.ValidationError):
    """A normal durable wait state, not a failed dispatch."""


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":"))


def _hash(value: Any) -> str:
    return sha256(_canonical(value).encode()).hexdigest()


def _data_revision(operation: dict[str, Any]) -> str:
    if operation["kind"] == "native_artifact":
        return schema_revision()
    if operation["action"] == "create":
        modified = None
    else:
        modified = frappe.db.get_value(operation["doctype"], operation["docname"], "modified")
    return _hash({"doctype": operation["doctype"], "name": operation.get("docname"),
                  "modified": str(modified or ""), "exists": bool(modified)})


def _approver(actor: str) -> str:
    candidates = frappe.get_all(
        "Has Role", filters={"parenttype": "User", "role": ["in", ["Muster Approver", "Muster Administrator", "System Manager"]]},
        fields=["parent"], order_by="parent asc", limit_page_length=200,
    )
    for row in candidates:
        user = row.parent
        if user.lower() != actor.lower() and frappe.db.get_value("User", user, "enabled"):
            return user
    raise frappe.PermissionError(_("No independent enabled Muster approver is available"))


def _record_plan(intent: dict[str, Any], mission, binding, node_id: str) -> tuple[dict[str, Any], Any]:
    actor = mission.requested_by
    operation = dict(intent["operation"])
    if _contains_placeholder(operation["values"]):
        raise frappe.ValidationError(_("Effect values contain unresolved template placeholders"))
    doctype = operation["doctype"]
    permission = "create" if operation["action"] == "create" else "write"
    name = operation.get("docname")
    if not frappe.db.exists("DocType", doctype):
        raise frappe.ValidationError(_("Effect DocType does not exist"))
    if name and not frappe.db.exists(doctype, name):
        raise frappe.DoesNotExistError(_("Effect target record does not exist"))
    if name:
        allowed = frappe.get_doc(doctype, name).has_permission(permission, user=actor)
    else:
        allowed = frappe.has_permission(doctype, permission, user=actor)
    if not allowed:
        raise frappe.PermissionError(_("The mission requester lacks live permission for this effect"))
    meta = frappe.get_meta(doctype)
    for fieldname in operation["values"]:
        field = meta.get_field(fieldname)
        if not field or field.fieldtype in {"Password", "Attach", "Attach Image", "HTML", "Button"}:
            raise frappe.ValidationError(_("Effect values contain an unresolved or unsupported field"))
    if operation["action"] == "update":
        operation["expectedModified"] = str(frappe.db.get_value(doctype, name, "modified"))
    identity = frappe_identity(actor)
    authority = {
        "tenantId": binding.tenant_id, "siteId": binding.site_id,
        "siteOrigin": binding.site_origin, "userId": actor.lower(),
        "permissionEpoch": identity["permissionHash"], "rolesHash": identity["rolesHash"],
        "schemaRevision": schema_revision(), "dataRevision": _data_revision(operation),
    }
    base = {
        "schemaVersion": 1, "capability": intent["capability"], "authority": authority,
        "operation": operation, "idempotencyKey": _stable_effect_id(mission.name, node_id),
        "postconditions": intent["postconditions"],
    }
    plan_hash = _hash(base)
    change_set = _change_set(mission, node_id, intent, base, plan_hash)
    return {**base, "planHash": plan_hash}, change_set


def _native_plan(intent: dict[str, Any], mission, binding, node_id: str) -> tuple[dict[str, Any], Any]:
    from muster.api.native_builder import _check_control_permissions, _source_from_intent
    from muster.automation.authority import authorize_change_set
    from muster.automation.engine import preview as preview_plan
    from muster.automation.frappe_backend import FrappeNativeBackend

    actor = mission.requested_by
    static = intent["operation"]["intent"]
    if (set(static) - {"schema_version", "artifacts", "source_file"}
            or not isinstance(static.get("artifacts"), list)):
        raise frappe.ValidationError(_("Native effect intent contains unsupported source or artifact fields"))
    runtime_intent = {**static, "mission": mission.name}
    source = _source_from_intent(runtime_intent, actor)
    _check_control_permissions(source, create=True)
    backend = FrappeNativeBackend()
    effective, _ = authorize_change_set(source, backend, stage="propose")
    effective, governance = authorize_change_set(effective, backend, stage="apply")
    native_plan = preview_plan(effective, backend, governance)
    expected_native_capability = {
        "custom_field": "artifact.custom_field.write",
        "property_setter": "artifact.property_setter.write",
        "doctype": "artifact.doctype.write",
        "page": "artifact.page.write",
        "workspace": "artifact.workspace.write",
        "report": "artifact.report.write",
        "script_report": "artifact.report.script.write",
        "print_format": "artifact.print_format.write",
        "web_page": "artifact.web_page.write",
        "web_form": "artifact.web_form.write",
        "notification": "artifact.notification.write",
        "assignment_rule": "artifact.assignment_rule.write",
    }[intent["operation"]["artifactType"]]
    if any(change.capability != expected_native_capability for change in native_plan.changes):
        raise frappe.PermissionError(_("Native builder capability does not match the reviewed effect"))
    change_set_name = backend.persist_preview(native_plan)
    change_set = frappe.get_doc("Muster Change Set", change_set_name)
    operation = {**intent["operation"], "intent": runtime_intent}
    identity = frappe_identity(actor)
    authority = {
        "tenantId": binding.tenant_id, "siteId": binding.site_id,
        "siteOrigin": binding.site_origin, "userId": actor.lower(),
        "permissionEpoch": identity["permissionHash"], "rolesHash": identity["rolesHash"],
        "schemaRevision": schema_revision(), "dataRevision": schema_revision(),
    }
    base = {
        "schemaVersion": 1, "capability": intent["capability"], "authority": authority,
        "operation": operation, "idempotencyKey": _stable_effect_id(mission.name, node_id),
        "postconditions": intent["postconditions"],
    }
    plan_hash = _hash(base)
    evidence = json.loads(change_set.evidence_json or "{}")
    if evidence.get("kind") != "native_artifact_plan" or evidence.get("plan", {}).get("plan_hash") != native_plan.plan_hash:
        raise frappe.ValidationError(_("Native Change Set evidence does not match its preflight"))
    return {**base, "planHash": plan_hash}, change_set


def _contains_placeholder(value: Any) -> bool:
    if isinstance(value, str):
        return "{{" in value or "${" in value
    if isinstance(value, list):
        return any(_contains_placeholder(item) for item in value)
    if isinstance(value, dict):
        return any(_contains_placeholder(item) for item in value.values())
    return False


def _stable_effect_id(mission: str, node_id: str) -> str:
    return f"effect-{sha256(f'{mission}\0{node_id}'.encode()).hexdigest()[:40]}"


def _change_set(mission, node_id: str, intent: dict[str, Any], base: dict[str, Any], plan_hash: str):
    existing = frappe.get_all(
        "Muster Change Set", filters={"mission": mission.name, "plan_hash": plan_hash},
        fields=["name"], order_by="creation asc", limit_page_length=1,
    )
    if existing:
        doc = frappe.get_doc("Muster Change Set", existing[0].name)
        evidence = json.loads(doc.evidence_json or "{}")
        if evidence != {"kind": "server_effect_plan", "node_id": node_id, "plan": base}:
            raise frappe.ValidationError(_("Persisted effect review evidence has drifted"))
        return doc
    operation = base["operation"]
    approval_class = "Sensitive" if intent["approvalClass"] == "dual_control" else "Standard"
    return frappe.get_doc({
        "doctype": "Muster Change Set", "mission": mission.name, "status": "Awaiting Approval",
        "risk_class": "High" if intent["approvalClass"] == "dual_control" else "Moderate",
        "approval_class": approval_class, "target_site": frappe.local.site,
        "actor": mission.requested_by, "permission_epoch": base["authority"]["permissionEpoch"],
        "schema_revision": base["authority"]["schemaRevision"], "plan_hash": plan_hash,
        "evidence_json": _canonical({"kind": "server_effect_plan", "node_id": node_id, "plan": base}),
        "operations": [{
            "operation_id": node_id, "operation_type": f"record_{operation['action']}",
            "target_doctype": operation["doctype"], "target_name": operation.get("docname"),
            "approval_class": approval_class, "before_json": "{}",
            "after_json": _canonical(operation["values"]),
            "concurrency_token": operation.get("expectedModified"),
            "idempotency_key": base["idempotencyKey"],
            "postcondition_json": _canonical({"rules": base["postconditions"]}),
        }],
    }).insert(ignore_permissions=True)


def _approved_plan(plan: dict[str, Any], change_set, mission, intent: dict[str, Any]) -> dict[str, Any]:
    approval_class = change_set.approval_class
    approvals = frappe.get_all(
        "Muster Approval", filters={"mission": mission.name, "change_set": change_set.name,
                                    "action_hash": plan["planHash"], "approval_class": approval_class,
                                    "status": "Approved"},
        fields=["name", "requested_by", "requested_from", "decided_by", "decided_at", "expires_at"],
        order_by="decided_at desc", limit_page_length=20,
    )
    now = now_datetime()
    for receipt in approvals:
        if (receipt.requested_by.lower() != mission.requested_by.lower()
                or not receipt.decided_by or receipt.decided_by != receipt.requested_from
                or receipt.decided_by.lower() == mission.requested_by.lower()
                or not receipt.decided_at or get_datetime(receipt.decided_at) > now
                or not receipt.expires_at or get_datetime(receipt.expires_at) <= now):
            continue
        if not set(frappe.get_roles(receipt.decided_by)).intersection(
                {"Muster Approver", "Muster Administrator", "System Manager"}):
            continue
        proof = {"changeSet": change_set.name} if plan["operation"]["kind"] == "native_artifact" else {}
        return {**plan, "approval": {
            "receiptId": receipt.name, "planHash": plan["planHash"],
            "actor": mission.requested_by.lower(), "approvers": [receipt.decided_by.lower()],
            "approvedAt": get_datetime(receipt.decided_at).isoformat(),
            "expiresAt": get_datetime(receipt.expires_at).isoformat(),
            "scope": [plan["capability"]], "approvalClass": intent["approvalClass"], "proof": proof,
        }}
    pending = frappe.get_all(
        "Muster Approval", filters={"mission": mission.name, "change_set": change_set.name,
                                    "action_hash": plan["planHash"], "approval_class": approval_class,
                                    "status": "Pending"},
        fields=["name", "expires_at"], limit_page_length=20,
    )
    current_pending = False
    for row in pending:
        if row.expires_at and get_datetime(row.expires_at) > now:
            current_pending = True
        else:
            frappe.db.set_value("Muster Approval", row.name, "status", "Expired", update_modified=True)
    if not current_pending:
        from frappe.utils import add_to_date
        typed_diff = [
            {
                "operationId": row.operation_id, "operationType": row.operation_type,
                "targetDoctype": row.target_doctype, "targetName": row.target_name,
                "before": json.loads(row.before_json or "{}"),
                "after": json.loads(row.after_json or "{}"),
                "concurrencyToken": row.concurrency_token,
            }
            for row in change_set.operations
        ]
        frappe.get_doc({
            "doctype": "Muster Approval", "mission": mission.name, "change_set": change_set.name,
            "status": "Pending", "approval_class": approval_class,
            "requested_by": mission.requested_by, "requested_from": _approver(mission.requested_by),
            "expires_at": add_to_date(now, hours=24), "action_hash": plan["planHash"],
            "diff_json": _canonical({"capability": plan["capability"], "typedDiff": typed_diff,
                                     "postconditions": plan["postconditions"]}),
        }).insert(ignore_permissions=True)
    mission.db_set("status", "Waiting for Approval", update_modified=True)
    raise MissionAwaitingEffectApproval(_("Mission is waiting for an independent approval"))


def prepare_mission_execution_manifest(static_manifest: dict[str, Any], mission, binding) -> dict[str, Any]:
    """Resolve static intents into per-mission plans only after current approval."""
    plans: dict[str, Any] = {}
    for node_id, entry in static_manifest["nodePlans"].items():
        if entry.get("surface") != "server_effect":
            plans[node_id] = entry
            continue
        intent = effect_intent(entry.get("plan"), f"nodePlans.{node_id}.plan")
        if intent["operation"]["kind"] == "record":
            plan, change_set = _record_plan(intent, mission, binding, node_id)
        else:
            plan, change_set = _native_plan(intent, mission, binding, node_id)
        plans[node_id] = {**entry, "plan": _approved_plan(plan, change_set, mission, intent)}
    unsigned = {"schemaVersion": 1, "workflowSnapshotHash": static_manifest["workflowSnapshotHash"],
                "nodePlans": dict(sorted(plans.items()))}
    return {**unsigned, "manifestHash": _hash(unsigned)}
