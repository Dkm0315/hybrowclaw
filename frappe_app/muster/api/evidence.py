from __future__ import annotations

from typing import Any

import frappe
from frappe import _
from frappe.utils import cint


LIST_FIELDS = [
    "name", "scenario", "claim", "actor", "actor_role", "module", "mission",
    "change_set", "video", "video_mime_type", "video_sha256", "duration_seconds",
    "viewport_width", "viewport_height", "build_revision", "status", "verified_by",
    "verified_at", "modified",
]


def _authenticated() -> None:
    if not frappe.session.user or frappe.session.user == "Guest":
        frappe.throw(_("Authentication is required"), frappe.AuthenticationError)


@frappe.whitelist()
def list_clips(mission: str | None = None, module: str | None = None,
               status: str | None = "Verified", limit: int = 50) -> dict[str, Any]:
    """Read-only registry listing; Frappe permission query conditions enforce visibility."""
    _authenticated()
    limit = cint(limit)
    if not 1 <= limit <= 100:
        frappe.throw(_("Limit must be between 1 and 100"), frappe.ValidationError)
    filters = {}
    if mission:
        filters["mission"] = mission
    if module:
        filters["module"] = module
    if status:
        if status not in {"Draft", "Ready", "Verified", "Rejected"}:
            frappe.throw(_("Invalid evidence status"), frappe.ValidationError)
        filters["status"] = status
    rows = frappe.get_list(
        "Muster Evidence Clip", filters=filters, fields=LIST_FIELDS,
        order_by="modified desc", limit=limit,
    )
    return {"clips": rows, "count": len(rows)}


@frappe.whitelist()
def get_clip(name: str) -> dict[str, Any]:
    """Return one authorized proof record including its bounded test receipt."""
    _authenticated()
    if not isinstance(name, str) or not name or len(name) > 140:
        frappe.throw(_("Invalid evidence clip name"), frappe.ValidationError)
    doc = frappe.get_doc("Muster Evidence Clip", name)
    if not doc.has_permission("read"):
        frappe.throw(_("Not permitted to read this evidence clip"), frappe.PermissionError)
    result = {field: doc.get(field) for field in LIST_FIELDS}
    result["test_receipt_json"] = doc.test_receipt_json
    return result
