from __future__ import annotations

import json
import re
from contextlib import contextmanager
from hashlib import sha256
from typing import Any, Iterator

import frappe
from frappe import _
from frappe.utils import get_datetime, now_datetime

from muster.change_ir.schema import CODE_BEARING_OPERATIONS, ChangeOperation, ChangeSet
from muster.change_ir.security import permission_epoch, schema_revision


SURFACE_DOCTYPES = {
    "create_workflow": "Workflow",
    "create_workspace": "Workspace",
    "create_page": "Page",
    "create_web_page": "Web Page",
    "create_web_form": "Web Form",
    "create_report": "Report",
    "create_print_format": "Print Format",
    "create_dashboard": "Dashboard",
    "create_chart": "Dashboard Chart",
    "create_number_card": "Number Card",
    "create_notification": "Notification",
    "create_assignment_rule": "Assignment Rule",
    "create_webhook": "Webhook",
    "create_email_template": "Email Template",
    "create_letter_head": "Letter Head",
    "create_client_script": "Client Script",
    "create_server_script": "Server Script",
}

PERMISSION_BY_KIND = {
    "create_record": "create",
    "update_record": "write",
    "delete_record": "delete",
    "submit_record": "submit",
    "cancel_record": "cancel",
    "apply_workflow": "write",
}

UNSAFE_CODE = re.compile(
    r"(?is)(?:<script\b|javascript\s*:|\beval\s*\(|\bexec\s*\(|\b__import__\s*\(|"
    r"\bsubprocess\b|\bos\.system\b|\bfrappe\.db\.sql\b|\bfrappe\.get_all\s*\([^)]*ignore_permissions)"
)


class ChangeExecutionError(frappe.ValidationError):
    pass


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def _hash(value: Any) -> str:
    return sha256(_canonical(value).encode()).hexdigest()


@contextmanager
def _as_user(user: str) -> Iterator[None]:
    previous = frappe.session.user
    frappe.set_user(user)
    try:
        yield
    finally:
        frappe.set_user(previous)


def _ensure_actor(actor: str) -> None:
    enabled = frappe.db.get_value("User", actor, "enabled")
    if not enabled:
        raise ChangeExecutionError(_("The execution principal is missing or disabled"))


def _target_for(operation: ChangeOperation) -> tuple[str, str | None, dict[str, Any]]:
    values = dict(operation.values)
    if operation.kind == "create_custom_field":
        values.setdefault("dt", operation.target_doctype)
        if operation.target_name:
            values.setdefault("fieldname", operation.target_name)
        name = values.get("name")
        if not name and values.get("dt") and values.get("fieldname"):
            name = f"{values['dt']}-{values['fieldname']}"
        return "Custom Field", name, values
    if operation.kind == "set_property":
        values.setdefault("doc_type", operation.target_doctype)
        values.setdefault("field_name", operation.target_name)
        return "Property Setter", values.get("name"), values
    if operation.kind in SURFACE_DOCTYPES:
        return SURFACE_DOCTYPES[operation.kind], operation.target_name, values
    return operation.target_doctype, operation.target_name, values


def _validate_code(operation: ChangeOperation) -> None:
    if operation.kind not in CODE_BEARING_OPERATIONS:
        return
    for fieldname, value in operation.values.items():
        if isinstance(value, str) and UNSAFE_CODE.search(value):
            raise ChangeExecutionError(
                _("Unsafe construct found in code-bearing field {0}").format(fieldname)
            )


def _check_concurrency(doctype: str, name: str | None, expected: str | None) -> None:
    if not expected or not name:
        return
    modified = frappe.db.get_value(doctype, name, "modified")
    actual = _hash({"doctype": doctype, "name": name, "modified": str(modified)})
    if expected not in {str(modified), actual}:
        raise ChangeExecutionError(_("The target changed after this operation was planned"))


def _has_permission(operation: ChangeOperation, actor: str) -> bool:
    doctype, name, _values = _target_for(operation)
    permission = PERMISSION_BY_KIND.get(operation.kind, "create")
    if name and permission != "create" and frappe.db.exists(doctype, name):
        return bool(frappe.get_doc(doctype, name).has_permission(permission, user=actor))
    return bool(frappe.has_permission(doctype, permission, user=actor))


def preflight(change_set: ChangeSet) -> dict[str, Any]:
    change_set.validate()
    if change_set.target_site != frappe.local.site:
        raise ChangeExecutionError(_("Change set site does not match the active Frappe site"))
    _ensure_actor(change_set.actor)
    live_epoch = permission_epoch(change_set.actor)
    if change_set.permission_epoch != live_epoch:
        raise ChangeExecutionError(_("Execution permissions changed after planning"))

    checks = []
    for operation in change_set.topological_operations():
        doctype, name, _values = _target_for(operation)
        if operation.kind == "create_custom_field" and not _values.get("fieldname"):
            raise ChangeExecutionError(_("Custom Field operations require a fieldname"))
        if operation.kind == "set_property" and not _values.get("property"):
            raise ChangeExecutionError(_("Property Setter operations require a property"))
        if not frappe.db.exists("DocType", doctype):
            raise ChangeExecutionError(_("Target DocType {0} is not installed").format(doctype))
        _validate_code(operation)
        _check_concurrency(doctype, name, operation.concurrency_token)
        allowed = _has_permission(operation, change_set.actor)
        if not allowed:
            raise frappe.PermissionError(
                _("{0} is not permitted to perform {1} on {2}").format(
                    change_set.actor, operation.kind, doctype
                )
            )
        checks.append({
            "operation_id": operation.operation_id,
            "kind": operation.kind,
            "target_doctype": doctype,
            "target_name": name,
            "allowed": True,
        })
    return {
        **change_set.safe_summary(),
        "permission_epoch": live_epoch,
        "schema_revision": schema_revision(),
        "checks": checks,
    }


def _approved(change_set_doc, plan_hash: str) -> bool:
    if change_set_doc.approval_class == "None":
        return True
    approvals = frappe.get_all(
        "Muster Approval",
        filters={
            "change_set": change_set_doc.name,
            "status": "Approved",
            "action_hash": plan_hash,
        },
        fields=["name", "requested_by", "decided_by", "expires_at", "approval_class"],
        order_by="decided_at desc",
    )
    required = change_set_doc.approval_class
    for approval in approvals:
        if approval.requested_by == approval.decided_by or not approval.decided_by:
            continue
        if approval.expires_at and get_datetime(approval.expires_at) <= now_datetime():
            continue
        roles = set(frappe.get_roles(approval.decided_by))
        if not roles.intersection({"Muster Approver", "Muster Administrator", "System Manager"}):
            continue
        if approval.approval_class == required:
            return True
    return False


def _create(doctype: str, name: str | None, values: dict[str, Any]):
    payload = {"doctype": doctype, **values}
    if name:
        payload.setdefault("name", name)
    return frappe.get_doc(payload).insert()


def _effect(operation: ChangeOperation) -> tuple[dict[str, Any], dict[str, Any] | None]:
    doctype, name, values = _target_for(operation)
    _check_concurrency(doctype, name, operation.concurrency_token)

    if operation.kind in {"create_record", "create_custom_field", *SURFACE_DOCTYPES.keys()}:
        if name and frappe.db.exists(doctype, name):
            existing = frappe.get_doc(doctype, name)
            if all(existing.get(key) == value for key, value in values.items()):
                return {"doctype": doctype, "name": existing.name, "idempotent": True}, None
            raise ChangeExecutionError(_("A different record already occupies the planned name"))
        doc = _create(doctype, name, values)
        return {"doctype": doctype, "name": doc.name}, {
            "kind": "delete_record", "doctype": doctype, "name": doc.name
        }

    if operation.kind == "set_property":
        doc = _create(doctype, name, values)
        return {"doctype": doctype, "name": doc.name}, {
            "kind": "delete_record", "doctype": doctype, "name": doc.name
        }

    doc = frappe.get_doc(doctype, name)
    before = {fieldname: doc.get(fieldname) for fieldname in values}
    if operation.kind == "update_record":
        doc.update(values)
        doc.save()
        return {"doctype": doctype, "name": doc.name}, {
            "kind": "update_record", "doctype": doctype, "name": doc.name, "values": before
        }
    if operation.kind == "delete_record":
        snapshot = doc.as_dict(no_nulls=False)
        doc.delete()
        return {"doctype": doctype, "name": name}, {
            "kind": "create_record", "doctype": doctype, "name": name, "values": snapshot
        }
    if operation.kind == "submit_record":
        doc.submit()
        return {"doctype": doctype, "name": doc.name, "docstatus": 1}, {
            "kind": "cancel_record", "doctype": doctype, "name": doc.name
        }
    if operation.kind == "cancel_record":
        doc.cancel()
        return {"doctype": doctype, "name": doc.name, "docstatus": 2}, None
    if operation.kind == "apply_workflow":
        from frappe.model.workflow import apply_workflow

        action = values.get("workflow_action")
        if not isinstance(action, str) or not action:
            raise ChangeExecutionError(_("Workflow operations require a fixed workflow action"))
        applied = apply_workflow(doc, action)
        return {"doctype": doctype, "name": applied.name, "workflow_action": action}, None
    raise ChangeExecutionError(_("No executor exists for operation {0}").format(operation.kind))


def _verify(operation: ChangeOperation, receipt: dict[str, Any]) -> None:
    doctype = receipt["doctype"]
    name = receipt["name"]
    if operation.kind == "delete_record":
        if frappe.db.exists(doctype, name):
            raise ChangeExecutionError(_("Delete postcondition failed"))
        return
    if not frappe.db.exists(doctype, name):
        raise ChangeExecutionError(_("Created or updated record is missing"))
    if operation.kind == "apply_workflow":
        return
    if operation.kind in {"create_record", "update_record", "create_custom_field", "set_property", *SURFACE_DOCTYPES.keys()}:
        doc = frappe.get_doc(doctype, name)
        _resolved_doctype, _resolved_name, values = _target_for(operation)
        for fieldname, expected in values.items():
            if doc.get(fieldname) != expected:
                raise ChangeExecutionError(
                    _("Postcondition failed for {0}.{1}").format(doctype, fieldname)
                )


def _rollback(inverses: list[dict[str, Any]]) -> list[dict[str, Any]]:
    results = []
    for inverse in reversed(inverses):
        try:
            if inverse["kind"] == "delete_record" and frappe.db.exists(inverse["doctype"], inverse["name"]):
                frappe.get_doc(inverse["doctype"], inverse["name"]).delete()
            elif inverse["kind"] == "update_record" and frappe.db.exists(inverse["doctype"], inverse["name"]):
                doc = frappe.get_doc(inverse["doctype"], inverse["name"])
                doc.update(inverse["values"])
                doc.save()
            elif inverse["kind"] == "create_record" and not frappe.db.exists(inverse["doctype"], inverse["name"]):
                values = dict(inverse["values"])
                values.pop("doctype", None)
                _create(inverse["doctype"], inverse["name"], values)
            elif inverse["kind"] == "cancel_record" and frappe.db.exists(inverse["doctype"], inverse["name"]):
                frappe.get_doc(inverse["doctype"], inverse["name"]).cancel()
            results.append({**inverse, "status": "Repaired"})
        except Exception as error:  # The caller records intervention instead of hiding partial repair.
            results.append({**inverse, "status": "Failed", "error": str(error)[:500]})
    return results


def from_document(doc) -> ChangeSet:
    operations = []
    for row in doc.operations:
        after = json.loads(row.after_json or "{}")
        operations.append({
            "operation_id": row.operation_id,
            "kind": row.operation_type,
            "target_doctype": row.target_doctype,
            "target_name": row.target_name,
            "values": after,
            "idempotency_key": row.idempotency_key,
            "concurrency_token": row.concurrency_token,
            "depends_on": json.loads(row.postcondition_json or "{}").get("depends_on", []),
            "approval_class": row.approval_class or doc.approval_class,
        })
    return ChangeSet.from_dict({
        "schema_version": "1.0",
        "target_site": doc.target_site,
        "actor": doc.actor,
        "permission_epoch": doc.permission_epoch,
        "operations": operations,
        "plan_hash": doc.plan_hash,
    })


def apply_document(name: str) -> dict[str, Any]:
    change_set_doc = frappe.get_doc("Muster Change Set", name)
    change_set_doc.check_permission("write")
    if change_set_doc.status == "Verified" and change_set_doc.verification_json:
        verification = json.loads(change_set_doc.verification_json)
        return {"change_set": name, "status": "Verified", "receipts": verification.get("receipts", [])}
    change_set = from_document(change_set_doc)
    evidence = preflight(change_set)
    if change_set_doc.schema_revision and change_set_doc.schema_revision != evidence["schema_revision"]:
        raise ChangeExecutionError(_("Frappe metadata changed after preflight"))
    if not _approved(change_set_doc, evidence["plan_hash"]):
        raise frappe.PermissionError(_("A current, matching approval is required"))

    change_set_doc.db_set("status", "Applying", update_modified=True)
    receipts: list[dict[str, Any]] = []
    inverses: list[dict[str, Any]] = []
    try:
        with _as_user(change_set.actor):
            for operation in change_set.topological_operations():
                if not _has_permission(operation, change_set.actor):
                    raise frappe.PermissionError(_("Permission changed before effect execution"))
                receipt, inverse = _effect(operation)
                _verify(operation, receipt)
                receipt.update({
                    "operation_id": operation.operation_id,
                    "idempotency_key": operation.idempotency_key,
                    "effect_hash": _hash(receipt),
                    "applied_at": str(now_datetime()),
                })
                receipts.append(receipt)
                if inverse:
                    inverses.append(inverse)
        change_set_doc.reload()
        for row in change_set_doc.operations:
            match = next(item for item in receipts if item["operation_id"] == row.operation_id)
            row.db_set("receipt_json", _canonical(match), update_modified=False)
        change_set_doc.db_set("inverse_json", _canonical(inverses), update_modified=False)
        change_set_doc.db_set("verification_json", _canonical({"status": "Verified", "receipts": receipts}), update_modified=False)
        change_set_doc.db_set("evidence_json", _canonical(evidence), update_modified=False)
        change_set_doc.db_set("status", "Verified", update_modified=True)
        return {"change_set": name, "status": "Verified", "receipts": receipts}
    except Exception:
        with _as_user(change_set.actor):
            repairs = _rollback(inverses)
        failed = any(item["status"] == "Failed" for item in repairs)
        change_set_doc.db_set("inverse_json", _canonical(inverses), update_modified=False)
        change_set_doc.db_set("repair_status", _canonical(repairs), update_modified=False)
        change_set_doc.db_set("status", "Needs Intervention" if failed else "Repaired", update_modified=True)
        raise
