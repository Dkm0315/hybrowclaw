from __future__ import annotations

from typing import Any

import frappe
from frappe import _
from frappe.utils import now_datetime

CONTROL_ACTIONS = {"pause", "resume", "cancel", "steer"}


def create_mission(
    *, objective: str, workflow: str | None, scope: dict, idempotency_key: str
) -> dict[str, Any]:
    if not frappe.has_permission("Muster Mission", "create"):
        frappe.throw(_("Not permitted to create missions"), frappe.PermissionError)
    objective = (objective or "").strip()
    if len(objective) < 8 or len(objective) > 4000:
        frappe.throw(_("Objective must be between 8 and 4000 characters"), frappe.ValidationError)
    existing = frappe.db.get_value(
        "Muster Mission",
        {"requested_by": frappe.session.user, "idempotency_key": idempotency_key},
        ["name", "status"],
        as_dict=True,
    )
    if existing:
        return {"mission": existing.name, "status": existing.status, "replayed": True}
    mission = frappe.get_doc(
        {
            "doctype": "Muster Mission",
            "objective": objective,
            "workflow": workflow,
            "scope_json": frappe.as_json(scope),
            "requested_by": frappe.session.user,
            "status": "Queued",
            "idempotency_key": idempotency_key,
            "requested_at": now_datetime(),
        }
    ).insert()
    frappe.enqueue(
        "muster.orchestration.worker.dispatch_mission",
        queue="long",
        enqueue_after_commit=True,
        mission=mission.name,
        job_id=f"muster-mission-{mission.name}",
    )
    return {"mission": mission.name, "status": mission.status, "replayed": False}


def request_control(
    mission_name: str, action: str, note: str | None, idempotency_key: str
) -> dict[str, Any]:
    if action not in CONTROL_ACTIONS:
        frappe.throw(_("Unsupported control action"), frappe.ValidationError)
    mission = frappe.get_doc("Muster Mission", mission_name)
    if not mission.has_permission("write"):
        frappe.throw(_("Not permitted"), frappe.PermissionError)
    if action == "steer" and (not note or not note.strip()):
        frappe.throw(_("Steer requires a non-empty instruction"), frappe.ValidationError)
    if note and len(note.strip()) > 4000:
        frappe.throw(_("Control guidance cannot exceed 4000 characters"), frappe.ValidationError)
    from muster.orchestration.gateway_runtime import dispatch_control_command

    return dispatch_control_command(mission.name, action, note, idempotency_key)
