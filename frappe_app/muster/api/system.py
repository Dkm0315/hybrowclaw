from __future__ import annotations

import frappe
from frappe import _


@frappe.whitelist()
def health() -> dict:
    if frappe.session.user == "Guest":
        frappe.throw(_("Authentication required"), frappe.AuthenticationError)
    roles = set(frappe.get_roles())
    if not roles.intersection({"Muster Administrator", "System Manager"}):
        frappe.throw(_("Not permitted"), frappe.PermissionError)
    settings = frappe.get_single("Muster Settings")
    return {
        "enabled": bool(settings.enabled),
        "binding_status": settings.binding_status,
        "event_schema_version": "1.0",
        "app_version": frappe.get_attr("muster.__version__"),
    }

