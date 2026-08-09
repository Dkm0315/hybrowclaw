from __future__ import annotations

import hashlib
import json
from typing import Any

import frappe
from frappe import _


class MusterFormSchemaError(frappe.PermissionError):
    pass


_DATA_FIELD_TYPES = {
    "Attach", "Attach Image", "Autocomplete", "Barcode", "Check", "Color", "Currency",
    "Data", "Date", "Datetime", "Duration", "Dynamic Link", "Float", "Geolocation",
    "HTML Editor", "Int", "JSON", "Link", "Long Text", "Markdown Editor", "Percent",
    "Phone", "Rating", "Read Only", "Select", "Signature", "Small Text", "Text",
    "Text Editor", "Time", "Table", "Table MultiSelect",
}


def effective_form_schema(doctype: str, *, user: str | None = None) -> dict[str, Any]:
    """Return a deterministic, data-only view of the form the live actor may use.

    Frappe's effective Meta is authoritative for Custom Field and Property Setter
    application. Raw customization rows are used only for provenance; Client Script
    source is intentionally never read or returned.
    """
    actor = user or frappe.session.user
    if not isinstance(doctype, str) or not doctype.strip() or len(doctype) > 140:
        raise MusterFormSchemaError(_("The form DocType is invalid"))
    doctype = doctype.strip()
    if not frappe.db.exists("DocType", doctype):
        raise MusterFormSchemaError(_("The form DocType is unavailable"))
    if not frappe.has_permission(doctype, "read", user=actor):
        raise MusterFormSchemaError(_("The form is not available to this user"))

    meta = frappe.get_meta(doctype, cached=False)
    roles = set(frappe.get_roles(actor))
    read_levels = _permission_levels(meta, roles, "read", actor)
    create_levels = _permission_levels(meta, roles, "create", actor)
    write_levels = _permission_levels(meta, roles, "write", actor)
    can_create = bool(frappe.has_permission(doctype, "create", user=actor))
    can_write = bool(frappe.has_permission(doctype, "write", user=actor))
    can_delete = bool(frappe.has_permission(doctype, "delete", user=actor))
    new_doc_defaults: dict[str, Any] = {}
    if can_create:
        template = frappe.new_doc(doctype)
        new_doc_defaults = {
            field.fieldname: template.get(field.fieldname)
            for field in meta.fields if field.fieldname
        }

    custom_fields = _rows(
        "Custom Field", {"dt": doctype},
        ["name", "fieldname", "fieldtype", "insert_after", "modified"],
    )
    custom_by_name = {row["fieldname"]: row for row in custom_fields if row.get("fieldname")}
    setters = _rows(
        "Property Setter", {"doc_type": doctype},
        ["name", "field_name", "property", "value", "property_type", "modified"],
    )
    custom_permissions = _rows(
        "Custom DocPerm", {"parent": doctype},
        ["name", "role", "permlevel", "read", "write", "create", "submit", "cancel", "delete", "modified"],
    )
    server_scripts = _rows(
        "Server Script", {"reference_doctype": doctype, "disabled": 0},
        ["name", "script_type", "modified"],
    )
    setters_by_field: dict[str, list[dict[str, Any]]] = {}
    doctype_setters: list[dict[str, Any]] = []
    for row in setters:
        item = {
            "name": row.get("name"),
            "property": row.get("property"),
            "value": row.get("value"),
            "property_type": row.get("property_type"),
        }
        fieldname = row.get("field_name")
        (setters_by_field.setdefault(fieldname, []) if fieldname else doctype_setters).append(item)

    fields: list[dict[str, Any]] = []
    for field in meta.fields:
        if field.fieldtype not in _DATA_FIELD_TYPES:
            continue
        permlevel = int(field.permlevel or 0)
        readable = permlevel in read_levels
        create_writable = bool(can_create and permlevel in create_levels and not field.read_only and not field.hidden)
        update_writable = bool(can_write and permlevel in write_levels and not field.read_only and not field.hidden)
        writable = create_writable or update_writable
        if not readable:
            continue
        custom = custom_by_name.get(field.fieldname)
        item = {
            "fieldname": field.fieldname,
            "label": field.label or field.fieldname,
            "fieldtype": field.fieldtype,
            "options": _safe_options(field.options),
            "permlevel": permlevel,
            "required": bool(field.reqd),
            "has_default": _has_effective_default(field.default) or _has_effective_default(new_doc_defaults.get(field.fieldname)),
            "read_only": bool(field.read_only),
            "hidden": bool(field.hidden),
            "readable": True,
            "writable": writable,
            "create_writable": create_writable,
            "update_writable": update_writable,
            "provenance": {
                "source": "custom_field" if custom else "doctype_field",
                **({"custom_field": custom.get("name")} if custom else {}),
                "property_setters": sorted(setters_by_field.get(field.fieldname, []), key=lambda item: str(item.get("name") or "")),
            },
        }
        if field.fieldtype in {"Table", "Table MultiSelect"} and field.options and frappe.db.exists("DocType", field.options):
            child_meta = frappe.get_meta(field.options, cached=False)
            item["child_doctype"] = field.options
            item["child_fields"] = [{
                "fieldname": child.fieldname,
                "label": child.label or child.fieldname,
                "fieldtype": child.fieldtype,
                "options": _safe_options(child.options),
                "required": bool(child.reqd),
                "has_default": _has_effective_default(child.default),
                "read_only": bool(child.read_only),
                "writable": bool(writable and not child.read_only and not child.hidden),
            } for child in child_meta.fields if child.fieldtype in _DATA_FIELD_TYPES and child.fieldtype not in {"Table", "Table MultiSelect"} and not child.hidden][:80]
        fields.append(item)

    workflow = _active_workflow(doctype)
    scripts = _client_script_metadata(doctype)
    unsigned = {
        "schema_version": 1,
        "doctype": doctype,
        "actor": actor,
        "authority": {"read": True, "create": can_create, "write": can_write, "delete": can_delete},
        # Effective Meta order is execution-relevant: dependency-driving header
        # fields must be handled before child tables and downstream totals.
        "fields": fields,
        "doctype_property_setters": sorted(doctype_setters, key=lambda item: str(item.get("name") or "")),
        "workflow": workflow,
        # Identification only. Source, conditions and JavaScript are excluded so
        # hostile Client Script text can never become planning instructions.
        "client_scripts": scripts,
        "custom_permissions": custom_permissions,
        # Metadata only; executable Server Script source is never selected.
        "server_scripts": server_scripts,
        "form_extensions": {
            "action_count": len(getattr(meta, "actions", None) or []),
            "link_count": len(getattr(meta, "links", None) or []),
        },
    }
    revision_inputs = {
        "doctype_modified": str(frappe.db.get_value("DocType", doctype, "modified") or ""),
        "custom_fields": [(row.get("name"), str(row.get("modified") or "")) for row in custom_fields],
        "property_setters": [(row.get("name"), str(row.get("modified") or "")) for row in setters],
        "workflow": workflow,
        "client_scripts": scripts,
        "custom_permissions": [(row.get("name"), str(row.get("modified") or "")) for row in custom_permissions],
        "server_scripts": [(row.get("name"), str(row.get("modified") or "")) for row in server_scripts],
        "form_extensions": unsigned["form_extensions"],
    }
    unsigned["revision"] = _digest(revision_inputs)
    unsigned["schema_hash"] = _digest(unsigned)
    return unsigned


def assert_form_schema_binding(binding: dict[str, Any], *, user: str | None = None) -> dict[str, Any]:
    if not isinstance(binding, dict) or set(binding) != {"doctype", "schema_hash", "revision", "operation", "fields", "record_name"}:
        raise MusterFormSchemaError(_("The attended form schema binding is invalid"))
    if binding.get("operation") not in {"create", "read", "update", "delete"}:
        raise MusterFormSchemaError(_("Submit and cancel are not supported by attended CRUD"))
    snapshot = effective_form_schema(binding.get("doctype"), user=user)
    if not _constant(snapshot["schema_hash"], binding.get("schema_hash")) or not _constant(snapshot["revision"], binding.get("revision")):
        raise MusterFormSchemaError(_("The form customization changed after review"))
    requested = binding.get("fields")
    if not isinstance(requested, list) or len(requested) > 100 or any(not isinstance(item, str) for item in requested):
        raise MusterFormSchemaError(_("The attended form fields are invalid"))
    available = {field["fieldname"]: field for field in snapshot["fields"]}
    operation = binding["operation"]
    if operation == "delete" and requested:
        raise MusterFormSchemaError(_("Delete review cannot bind editable fields"))
    for name in requested:
        field = available.get(name)
        allowed = field and (
            (operation == "create" and field.get("create_writable", field["writable"]))
            or (operation == "update" and field.get("update_writable", field["writable"]))
            or operation not in {"create", "update"}
        )
        if not allowed:
            raise MusterFormSchemaError(_("A planned form field is no longer available"))
    if operation == "create" and not snapshot["authority"]["create"]:
        raise MusterFormSchemaError(_("Create permission is no longer available"))
    if operation == "update" and not snapshot["authority"]["write"]:
        raise MusterFormSchemaError(_("Write permission is no longer available"))
    if operation == "delete" and not snapshot["authority"]["delete"]:
        raise MusterFormSchemaError(_("Delete permission is no longer available"))
    record_name = binding.get("record_name")
    if operation in {"update", "delete"}:
        permission = "write" if operation == "update" else "delete"
        if not isinstance(record_name, str) or not record_name or not frappe.has_permission(snapshot["doctype"], permission, doc=record_name, user=user or frappe.session.user):
            raise MusterFormSchemaError(_("The record is no longer available for this action"))
    elif operation == "read" and record_name is not None:
        if not isinstance(record_name, str) or not record_name or not frappe.has_permission(snapshot["doctype"], "read", doc=record_name, user=user or frappe.session.user):
            raise MusterFormSchemaError(_("The record is no longer readable"))
    elif record_name is not None:
        raise MusterFormSchemaError(_("The attended form record binding is invalid"))
    return snapshot


def _permission_levels(meta: Any, roles: set[str], permission: str, actor: str) -> set[int]:
    levels = {int(row.permlevel or 0) for row in meta.permissions if row.role in roles and int(row.get(permission) or 0)}
    if actor == "Administrator":
        levels.update(int(field.permlevel or 0) for field in meta.fields)
    elif "System Manager" in roles:
        levels.add(0)
    return levels


def _rows(doctype: str, filters: dict[str, Any], fields: list[str]) -> list[dict[str, Any]]:
    if not frappe.db.exists("DocType", doctype):
        return []
    return list(frappe.get_all(doctype, filters=filters, fields=fields, order_by="name asc", limit_page_length=500))


def _active_workflow(doctype: str) -> dict[str, Any] | None:
    if not frappe.db.exists("DocType", "Workflow"):
        return None
    name = frappe.db.get_value("Workflow", {"document_type": doctype, "is_active": 1}, "name")
    if not name:
        return None
    doc = frappe.get_doc("Workflow", name)
    return {
        "name": doc.name,
        "state_field": doc.workflow_state_field,
        "states": sorted({str(row.state) for row in doc.states if row.state}),
        "transitions": sorted([
            {"state": str(row.state), "action": str(row.action), "next_state": str(row.next_state), "allowed": str(row.allowed)}
            for row in doc.transitions
        ], key=lambda item: (item["state"], item["action"], item["next_state"], item["allowed"])),
        "modified": str(doc.modified or ""),
    }


def _client_script_metadata(doctype: str) -> list[dict[str, Any]]:
    if not frappe.db.exists("DocType", "Client Script"):
        return []
    # Never select the `script` column.
    rows = frappe.get_all("Client Script", filters={"dt": doctype, "enabled": 1}, fields=["name", "view", "modified"], order_by="name asc", limit_page_length=100)
    return [{"name": row.name, "view": row.view, "modified": str(row.modified or "")} for row in rows]


def _safe_options(value: Any) -> str | None:
    if not isinstance(value, str) or len(value) > 4000:
        return None
    return value


def _has_effective_default(value: Any) -> bool:
    """An empty textual default does not satisfy a mandatory form field."""
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    return True


def _digest(value: Any) -> str:
    canonical = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)
    return hashlib.sha256(canonical.encode()).hexdigest()


def _constant(left: str, right: Any) -> bool:
    return isinstance(right, str) and len(right) == 64 and hmac_compare(left, right)


def hmac_compare(left: str, right: str) -> bool:
    import hmac
    return hmac.compare_digest(left, right)
