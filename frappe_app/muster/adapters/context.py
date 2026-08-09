from __future__ import annotations

import json
import re
from typing import Any

import frappe
from frappe import _
from frappe.model import get_permitted_fields

MAX_CONTEXT_DOCUMENTS = 20
MAX_CONTEXT_BYTES = 30_000
MAX_FIELD_TEXT = 4_000
_SECRET_FIELD = re.compile(
    r"(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|private[_-]?key)",
    re.IGNORECASE,
)
_STRUCTURAL_FIELDS = {
    "Button",
    "Column Break",
    "Fold",
    "Heading",
    "HTML",
    "Section Break",
    "Tab Break",
    "Table",
    "Table MultiSelect",
}


def permission_filtered_context(scope: dict[str, Any] | None, user: str) -> dict[str, Any]:
    """Resolve requested record context under the recorded Frappe principal."""
    requested = scope or {}
    if not isinstance(requested, dict):
        frappe.throw(_("Mission scope must be a JSON object"), frappe.ValidationError)
    references = _document_references(requested)
    documents = [_permission_filtered_document(doctype, name, user) for doctype, name in references]
    summary = _bounded_summary({"documents": documents}) if documents else None
    return {
        **_optional_text_fields(requested),
        "installedApps": sorted(frappe.get_installed_apps())[:100],
        **({"summary": summary} if summary else {}),
    }


def _document_references(scope: dict[str, Any]) -> list[tuple[str, str]]:
    rows: list[Any] = []
    if scope.get("docname") and not scope.get("doctype"):
        frappe.throw(_("Mission scope document name requires a DocType"), frappe.ValidationError)
    if scope.get("doctype") and scope.get("docname"):
        rows.append({"doctype": scope.get("doctype"), "name": scope.get("docname")})
    requested_rows = scope.get("documents", [])
    if requested_rows is not None and not isinstance(requested_rows, list):
        frappe.throw(_("Mission scope documents must be a list"), frappe.ValidationError)
    rows.extend(requested_rows or [])
    if len(rows) > MAX_CONTEXT_DOCUMENTS:
        frappe.throw(
            _("A mission may attach at most {0} context documents").format(MAX_CONTEXT_DOCUMENTS),
            frappe.ValidationError,
        )
    references: list[tuple[str, str]] = []
    for row in rows:
        if not isinstance(row, dict):
            frappe.throw(_("Each context document must be an object"), frappe.ValidationError)
        doctype = _bounded_text(row.get("doctype"), "DocType", 140)
        name = _bounded_text(row.get("name") or row.get("docname"), "document name", 500)
        reference = (doctype, name)
        if reference not in references:
            references.append(reference)
    return references


def _permission_filtered_document(doctype: str, name: str, user: str) -> dict[str, Any]:
    if not frappe.db.exists("DocType", doctype):
        frappe.throw(_("Requested context is unavailable"), frappe.PermissionError)
    doc = frappe.get_doc(doctype, name)
    if not doc.has_permission("read", user=user):
        frappe.throw(_("Requested context is unavailable"), frappe.PermissionError)
    meta = frappe.get_meta(doctype)
    permitted = set(get_permitted_fields(doctype, user=user, permission_type="read"))
    fields: dict[str, Any] = {}
    for fieldname in sorted(permitted):
        if _SECRET_FIELD.search(fieldname):
            continue
        field = meta.get_field(fieldname)
        if field and (field.fieldtype in _STRUCTURAL_FIELDS or field.fieldtype == "Password"):
            continue
        value = doc.get(fieldname)
        normalized = _safe_scalar(value)
        if normalized is not None:
            fields[fieldname] = normalized
    return {"doctype": doctype, "name": name, "fields": fields}


def _safe_scalar(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, bool | int | float):
        return value
    if isinstance(value, str):
        return value[:MAX_FIELD_TEXT]
    if isinstance(value, (list, tuple, dict)):
        return None
    try:
        encoded = json.loads(frappe.as_json(value))
    except (TypeError, ValueError):
        return str(value)[:MAX_FIELD_TEXT]
    return encoded if isinstance(encoded, bool | int | float | str) else None


def _bounded_summary(payload: dict[str, Any]) -> str:
    documents = payload["documents"]
    omitted = 0
    while True:
        value = {"documents": documents, "omittedFields": omitted}
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        if len(encoded.encode()) <= MAX_CONTEXT_BYTES:
            return encoded
        candidate = next((doc for doc in reversed(documents) if doc["fields"]), None)
        if candidate is None:
            frappe.throw(_("Permission-filtered mission context is too large"), frappe.ValidationError)
        candidate["fields"].pop(next(reversed(candidate["fields"])))
        omitted += 1


def _optional_text_fields(scope: dict[str, Any]) -> dict[str, str]:
    output: dict[str, str] = {}
    for source, target in (
        ("route", "route"),
        ("page_type", "pageType"),
        ("page_name", "pageName"),
        ("doctype", "doctype"),
        ("docname", "docname"),
        ("locale", "locale"),
        ("timezone", "timezone"),
    ):
        if scope.get(source):
            output[target] = _bounded_text(scope[source], source, 500)
    return output


def _bounded_text(value: Any, label: str, maximum: int) -> str:
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > maximum:
        frappe.throw(_("Invalid {0} in mission scope").format(label), frappe.ValidationError)
    return value.strip()
