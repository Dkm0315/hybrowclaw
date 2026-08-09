from __future__ import annotations

import frappe
from frappe.utils import add_to_date, now_datetime


def reconcile_stale_runs() -> None:
    cutoff = add_to_date(now_datetime(), minutes=-10)
    stale = frappe.get_all(
        "Muster Run",
        filters={"status": "Running", "heartbeat_at": ["<", cutoff]},
        pluck="name",
    )
    for name in stale:
        frappe.db.set_value(
            "Muster Run", name, "status", "Needs Intervention", update_modified=False
        )


def prune_expired_links() -> None:
    frappe.db.set_value(
        "Muster Channel Identity",
        {"status": "Pending", "expires_at": ["<", now_datetime()]},
        "status",
        "Expired",
        update_modified=False,
    )
