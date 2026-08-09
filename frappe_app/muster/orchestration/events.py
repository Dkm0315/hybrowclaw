from __future__ import annotations

import frappe


def append_activity(
    mission: str,
    *,
    event_type: str,
    state: str,
    summary: str,
    idempotency_key: str | None = None,
    payload: dict | None = None,
):
    """Append under a DB lock so each mission has a monotonic sequence."""
    # Lock the stable parent row first. Aggregates do not reliably lock an empty event range.
    if frappe.db.db_type == "sqlite":
        frappe.db.sql("select name from `tabMuster Mission` where name=%s", mission)
    else:
        frappe.db.sql(
            "select name from `tabMuster Mission` where name=%s for update", mission
        )
    sequence = frappe.db.sql(
        "select coalesce(max(sequence), 0) + 1 from `tabMuster Activity` where mission=%s",
        mission,
    )[0][0]
    activity = frappe.get_doc(
        {
            "doctype": "Muster Activity",
            "mission": mission,
            "sequence": sequence,
            "event_type": event_type,
            "state": state,
            "summary": summary,
            "idempotency_key": idempotency_key,
            "payload_json": frappe.as_json(payload or {}),
            "visibility": "Participants",
        }
    ).insert(ignore_permissions=True)
    frappe.publish_realtime(
        "muster_activity",
        {"mission": mission, "sequence": sequence, "event_type": event_type, "summary": summary},
        after_commit=True,
        user=frappe.session.user,
    )
    return activity


def publish_mission_projection(doc, method=None):
    frappe.publish_realtime(
        "muster_mission_changed",
        {"mission": doc.name, "status": doc.status, "progress": doc.progress},
        after_commit=True,
        user=doc.requested_by,
    )
