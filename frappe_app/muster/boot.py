from __future__ import annotations

import frappe
from frappe.utils import cint

from muster.permissions import has_app_permission


def boot_session(bootinfo) -> None:
    """Expose only non-secret capability flags required to render the Desk shell."""
    user = frappe.session.user
    if user == "Guest" or not has_app_permission():
        return
    settings = frappe.get_single("Muster Settings")
    binding_status = (
        frappe.db.get_value("Muster Site Binding", settings.site_binding, "status")
        if settings.site_binding else None
    )
    execution_enabled = bool(
        settings.enabled
        and settings.binding_status == "Trusted"
        and settings.gateway_url
        and settings.site_binding
        and binding_status == "Trusted"
        and settings.get_password("gateway_bearer_token", raise_exception=False)
        and settings.get_password("run_event_hmac_secret", raise_exception=False)
    )
    bootinfo.muster = {
        "available": True,
        # This means reciprocal site/gateway trust is usable, not merely that
        # an administrator ticked Enable Muster. Provider failures remain
        # fail-closed at the planning endpoint and are never reported as work.
        "execution_enabled": execution_enabled,
        "connection_state": "trusted" if execution_enabled else "setup_required",
        "control_route": "/desk/muster-control",
        "can_administer": bool(
            {"Muster Administrator", "System Manager"} & set(frappe.get_roles(user))
        ),
        "can_approve": "Muster Approver" in frappe.get_roles(user),
        "event_schema_version": "1.0",
        # Deterministic UI playback is deliberately impossible on a normal
        # site. It requires both developer mode and an explicit site_config
        # switch, and the browser adapter additionally requires Administrator.
        "test_mode": bool(cint(frappe.conf.get("developer_mode", 0)))
        and bool(cint(frappe.conf.get("muster_test_mode", 0))),
    }
