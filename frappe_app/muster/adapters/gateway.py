from __future__ import annotations

import frappe


def dispatch(mission) -> None:
    settings = frappe.get_single("Muster Settings")
    if not settings.enabled or not settings.gateway_url:
        mission.db_set("status", "Needs Configuration")
        return
    # Network transport lands after OAuth/site binding. Keeping this fail-closed prevents
    # an untrusted URL from receiving mission or user data during setup.
    if settings.binding_status != "Trusted":
        mission.db_set("status", "Needs Configuration")
        return
    mission.db_set("status", "Ready to Dispatch")

