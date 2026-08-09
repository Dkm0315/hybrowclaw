from __future__ import annotations

import frappe


def _expected_dispatch_errors():
    from muster.adapters.client import GatewayClientError
    from muster.orchestration.gateway_runtime import MissionDispatchError
    from muster.orchestration.projection import ProjectionError
    from muster.orchestration.workflow_graph import WorkflowGraphError

    return (MissionDispatchError, GatewayClientError, ProjectionError, WorkflowGraphError)


def _record_dispatch_failure(mission: str, error: Exception) -> None:
    frappe.db.set_value(
        "Muster Mission",
        mission,
        {
            "status": "Needs Intervention",
            "failure_summary": "Trusted Muster dispatch stopped before a verified completion.",
        },
        update_modified=True,
    )
    frappe.log_error(
        title=f"Muster mission dispatch stopped: {mission}",
        message=f"{type(error).__name__}: {error}",
    )


def dispatch_mission(mission: str) -> None:
    doc = frappe.get_doc("Muster Mission", mission)
    if doc.status != "Queued":
        return
    doc.db_set("status", "Planning", update_modified=True)
    from muster.orchestration.gateway_runtime import dispatch_and_follow

    try:
        dispatch_and_follow(mission)
    except _awaiting_approval_error():
        # Preparation persisted the exact Change Set and approval request. This
        # is a normal durable wait; the Approval controller resumes it once.
        return
    except _expected_dispatch_errors() as error:
        _record_dispatch_failure(mission, error)


def _awaiting_approval_error():
    from muster.orchestration.effect_lifecycle import MissionAwaitingEffectApproval
    return MissionAwaitingEffectApproval


def continue_mission_projection(mission: str, generation: int = 1) -> None:
    from muster.orchestration.gateway_runtime import follow_mission_projection

    try:
        follow_mission_projection(mission, generation=generation)
    except _expected_dispatch_errors() as error:
        _record_dispatch_failure(mission, error)
