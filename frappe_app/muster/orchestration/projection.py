from __future__ import annotations

import json
import re
from collections import Counter
from typing import Any

import frappe
from frappe import _
from frappe.utils import get_datetime, now_datetime

from muster.adapters.client import GatewayBinding

MAX_EVENT_PAYLOAD_BYTES = 64 * 1024
MAX_SNAPSHOT_EVENTS = 2_000
_SECRET_KEY = re.compile(
    r"(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|private[_-]?key|chain[_-]?of[_-]?thought|reasoning)",
    re.IGNORECASE,
)
_BEARER = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]+", re.IGNORECASE)
_EVENT_TYPES = {
    "mission_started",
    "node_started",
    "lease_claimed",
    "lease_heartbeat",
    "effect_started",
    "effect_committed",
    "node_completed",
    "node_failed",
    "pause_requested",
    "paused",
    "resumed",
    "steered",
    "cancellation_requested",
    "cancelling",
    "cancelled",
    "compensation_started",
    "compensation_completed",
    "compensation_failed",
    "mission_failed",
    "mission_completed",
}
_MISSION_STATUS = {
    "pending": "Queued",
    "running": "Running",
    "pause_requested": "Running",
    "paused": "Paused",
    "cancel_requested": "Running",
    "cancelling": "Running",
    "cancelled": "Cancelled",
    "compensation_running": "Running",
    "compensated": "Cancelled",
    "needs_intervention": "Needs Intervention",
    "failed": "Failed",
    "completed": "Completed",
}
_RUN_STATUS = {
    "pending": "Queued",
    "running": "Running",
    "pause_requested": "Waiting",
    "paused": "Waiting",
    "cancel_requested": "Running",
    "cancelling": "Running",
    "cancelled": "Cancelled",
    "compensation_running": "Running",
    "compensated": "Cancelled",
    "needs_intervention": "Needs Intervention",
    "failed": "Failed",
    "completed": "Succeeded",
}


class ProjectionError(frappe.ValidationError):
    pass


def project_gateway_snapshot(
    mission_name: str,
    snapshot: dict[str, Any],
    binding: GatewayBinding,
    *,
    poll_path: str | None = None,
) -> dict[str, Any]:
    """Project one fully validated authoritative snapshot into native Frappe records."""
    mission = frappe.get_doc("Muster Mission", mission_name)
    normalized = _validate_snapshot(mission, snapshot, binding)
    events = normalized["events"]
    attempt_counts = Counter()
    attempt_numbers: dict[tuple[str, str], int] = {}
    for event in events:
        if event["type"] != "node_started":
            continue
        node_id = event["nodeId"]
        attempt_counts[node_id] += 1
        if event.get("attemptId"):
            attempt_numbers[(node_id, event["attemptId"])] = attempt_counts[node_id]
    units: dict[str, str] = {}
    for event in events:
        node_id = event.get("nodeId")
        if node_id and node_id not in units:
            name = frappe.db.get_value(
                "Muster Work Unit",
                {"mission": mission.name, "external_node_id": node_id},
                "name",
            )
            if name:
                units[node_id] = name
        if event["type"] == "node_started":
            units[node_id] = _ensure_work_unit(mission, event, units)

    for event in events:
        _project_event(mission, event, units, attempt_counts, attempt_numbers)

    status = _MISSION_STATUS[normalized["status"]]
    completed_nodes = sum(1 for node in normalized["nodes"] if node["status"] == "completed")
    node_count = max(len(normalized["nodes"]), 1)
    progress = 100 if status in {"Completed", "Cancelled"} else min(95, 5 + round(90 * completed_nodes / node_count))
    updates: dict[str, Any] = {
        "status": status,
        "progress": progress,
        "root_run_id": normalized["rootRunId"],
    }
    latest = events[-1] if events else None
    if status == "Completed":
        updates.update(completed_at=get_datetime(latest["at"]), result_summary=latest["summary"][:4000])
    elif status in {"Failed", "Needs Intervention"}:
        updates["failure_summary"] = latest["summary"][:4000]
    frappe.db.set_value("Muster Mission", mission.name, updates, update_modified=True)
    root_run = _ensure_root_run(mission, normalized, poll_path)
    frappe.publish_realtime(
        "muster_mission_changed",
        {"mission": mission.name, "status": status, "progress": progress},
        after_commit=True,
        user=mission.requested_by,
    )
    return {
        "mission": mission.name,
        "status": status,
        "root_run": root_run,
        "cursor": normalized["nextSequence"] - 1,
        "events": len(events),
        "work_units": len(units),
    }


def _validate_snapshot(mission, snapshot: dict[str, Any], binding: GatewayBinding) -> dict[str, Any]:
    if not isinstance(snapshot, dict):
        raise ProjectionError(_("Gateway mission snapshot must be an object"))
    mission_id = snapshot.get("missionId")
    root_run_id = snapshot.get("rootRunId")
    status = snapshot.get("status")
    events = snapshot.get("events")
    nodes = snapshot.get("nodes")
    if mission_id != mission.name or not isinstance(root_run_id, str) or not root_run_id:
        raise ProjectionError(_("Gateway mission authority does not match the Frappe mission"))
    if mission.root_run_id and mission.root_run_id != root_run_id:
        raise ProjectionError(_("Gateway root run changed after mission admission"))
    if status not in _MISSION_STATUS or not isinstance(events, list) or not isinstance(nodes, list):
        raise ProjectionError(_("Gateway mission snapshot has an invalid state"))
    if len(events) > MAX_SNAPSHOT_EVENTS:
        raise ProjectionError(_("Gateway mission snapshot exceeds the projection event limit"))
    expected_sequence = 1
    seen_ids: set[str] = set()
    for event in events:
        _validate_event(event, mission.name, root_run_id, binding, expected_sequence)
        if event["id"] in seen_ids:
            raise ProjectionError(_("Gateway mission snapshot contains a duplicate event"))
        seen_ids.add(event["id"])
        expected_sequence += 1
    next_sequence = snapshot.get("nextSequence")
    if next_sequence != expected_sequence:
        raise ProjectionError(_("Gateway mission event cursor is inconsistent"))
    for node in nodes:
        if (
            not isinstance(node, dict)
            or not isinstance(node.get("nodeId"), str)
            or node.get("status") not in {"running", "completed", "failed"}
        ):
            raise ProjectionError(_("Gateway mission node projection is invalid"))
    return snapshot


def _validate_event(
    event: Any,
    mission: str,
    root_run_id: str,
    binding: GatewayBinding,
    expected_sequence: int,
) -> None:
    if not isinstance(event, dict) or event.get("schemaVersion") != 1:
        raise ProjectionError(_("Gateway run event schema is invalid"))
    required = ("id", "missionId", "rootRunId", "tenantId", "sequence", "type", "at", "actorId", "summary")
    if any(field not in event for field in required):
        raise ProjectionError(_("Gateway run event is incomplete"))
    if (
        event["missionId"] != mission
        or event["rootRunId"] != root_run_id
        or event["tenantId"] != binding.tenant_id
        or event.get("siteId") != (binding.site_id or None)
        or event["sequence"] != expected_sequence
        or event["type"] not in _EVENT_TYPES
    ):
        raise ProjectionError(_("Gateway run event authority or sequence is invalid"))
    if not all(isinstance(event[field], str) and event[field] for field in ("id", "actorId", "summary", "at")):
        raise ProjectionError(_("Gateway run event text fields are invalid"))
    try:
        get_datetime(event["at"])
    except Exception as error:
        raise ProjectionError(_("Gateway run event time is invalid")) from error
    if _BEARER.search(event["summary"]) or _contains_secret_key(event.get("payload")):
        raise ProjectionError(_("Gateway run event failed secret-redaction validation"))
    payload_bytes = len(json.dumps(event.get("payload") or {}, default=str).encode())
    if payload_bytes > MAX_EVENT_PAYLOAD_BYTES:
        raise ProjectionError(_("Gateway run event payload exceeds the projection limit"))


def _contains_secret_key(value: Any) -> bool:
    if isinstance(value, list):
        return any(_contains_secret_key(item) for item in value)
    if isinstance(value, dict):
        return any(_SECRET_KEY.search(str(key)) or _contains_secret_key(item) for key, item in value.items())
    return isinstance(value, str) and bool(_BEARER.search(value))


def _ensure_work_unit(mission, event: dict[str, Any], units: dict[str, str]) -> str:
    node_id = event["nodeId"]
    existing = units.get(node_id)
    payload = event.get("payload") or {}
    parent_ids = [item for item in payload.get("parentNodeIds", []) if isinstance(item, str)]
    values = {
        "title": event["summary"][:140],
        "status": "Running",
        "external_node_id": node_id,
        "node_kind": str(payload.get("nodeKind") or "agent")[:140],
        "parent_work_unit": units.get(parent_ids[0]) if parent_ids else None,
        "tree_path": f"/{mission.name}/{node_id}"[:140],
        "depth": max(0, min(int(payload.get("depth") or 0), 32)),
        "agent": event.get("agentId") if frappe.db.exists("Muster Agent", event.get("agentId")) else None,
        "dependencies_json": frappe.as_json(parent_ids),
        "attempt_id": event.get("attemptId"),
        "started_at": get_datetime(event["at"]),
    }
    if existing:
        frappe.db.set_value("Muster Work Unit", existing, values, update_modified=False)
        return existing
    return frappe.get_doc({"doctype": "Muster Work Unit", "mission": mission.name, **values}).insert(ignore_permissions=True).name


def _project_event(mission, event, units, attempt_counts, attempt_numbers) -> None:
    inserted = not frappe.db.exists("Muster Activity", {"idempotency_key": event["id"]})
    if inserted:
        reference = units.get(event.get("nodeId"))
        frappe.get_doc(
            {
                "doctype": "Muster Activity",
                "mission": mission.name,
                "sequence": event["sequence"],
                "event_type": event["type"],
                "state": event["type"].replace("_", " ").title(),
                "summary": event["summary"][:240],
                "visibility": "Participants",
                "actor": event["actorId"] if frappe.db.exists("User", event["actorId"]) else None,
                "agent": event.get("agentId") if frappe.db.exists("Muster Agent", event.get("agentId")) else None,
                "reference_doctype": "Muster Work Unit" if reference else None,
                "reference_name": reference,
                "idempotency_key": event["id"],
                "payload_json": frappe.as_json(event.get("payload") or {}),
            }
        ).insert(ignore_permissions=True)

    node_id = event.get("nodeId")
    unit_name = units.get(node_id)
    if unit_name:
        updates: dict[str, Any] = {"attempt_count": attempt_counts[node_id]}
        if event.get("attemptId"):
            updates["attempt_id"] = event["attemptId"]
        if event.get("fencingToken") is not None:
            updates["fencing_token"] = str(event["fencingToken"])
        lease = (event.get("payload") or {}).get("leaseExpiresAt")
        if lease:
            updates["lease_expires_at"] = get_datetime(lease)
        if event["type"] == "node_started":
            updates.update(status="Running", completed_at=None)
        elif event["type"] == "node_completed":
            updates.update(status="Succeeded", completed_at=get_datetime(event["at"]))
        elif event["type"] == "node_failed":
            updates.update(status="Failed", completed_at=get_datetime(event["at"]))
        frappe.db.set_value("Muster Work Unit", unit_name, updates, update_modified=False)
        attempt_number = attempt_numbers.get(
            (node_id, event.get("attemptId")), attempt_counts[node_id]
        )
        _project_attempt_run(mission, event, unit_name, attempt_number)
    if inserted:
        frappe.publish_realtime(
            "muster_activity",
            {
                "mission": mission.name,
                "sequence": event["sequence"],
                "event_type": event["type"],
                "summary": event["summary"][:240],
            },
            after_commit=True,
            user=mission.requested_by,
        )


def _project_attempt_run(mission, event, unit_name, attempt_number) -> None:
    attempt_id = event.get("attemptId")
    if not attempt_id:
        return
    external_id = f"{event['rootRunId']}/{attempt_id}"
    name = frappe.db.get_value("Muster Run", {"external_run_id": external_id}, "name")
    if not name and event["type"] == "node_started":
        frappe.get_doc(
            {
                "doctype": "Muster Run",
                "external_run_id": external_id,
                "mission": mission.name,
                "work_unit": unit_name,
                "attempt": max(1, attempt_number),
                "status": "Running",
                "execution_user": mission.requested_by,
                "started_at": get_datetime(event["at"]),
                "heartbeat_at": get_datetime(event["at"]),
            }
        ).insert(ignore_permissions=True)
        return
    if not name:
        return
    updates = {"heartbeat_at": get_datetime(event["at"]), "cursor": event["sequence"]}
    if event["type"] == "node_completed":
        updates.update(status="Succeeded", completed_at=get_datetime(event["at"]), result_json=frappe.as_json({"summary": event["summary"]}))
    elif event["type"] == "node_failed":
        updates.update(status="Failed", completed_at=get_datetime(event["at"]), error_summary=event["summary"][:4000])
    frappe.db.set_value("Muster Run", name, updates, update_modified=False)


def _ensure_root_run(mission, snapshot, poll_path) -> str:
    external_id = snapshot["rootRunId"]
    name = frappe.db.get_value("Muster Run", {"external_run_id": external_id}, "name")
    values = {
        "status": _RUN_STATUS[snapshot["status"]],
        "cursor": snapshot["nextSequence"] - 1,
        "heartbeat_at": now_datetime(),
        "result_json": frappe.as_json({"status": snapshot["status"], "node_count": len(snapshot["nodes"])}),
    }
    if poll_path:
        values["gateway_poll_path"] = poll_path
    if values["status"] in {"Succeeded", "Failed", "Cancelled", "Needs Intervention"}:
        values["completed_at"] = now_datetime()
    if name:
        frappe.db.set_value("Muster Run", name, values, update_modified=False)
        return name
    return frappe.get_doc(
        {
            "doctype": "Muster Run",
            "external_run_id": external_id,
            "mission": mission.name,
            "attempt": 1,
            "execution_user": mission.requested_by,
            "started_at": now_datetime(),
            **values,
        }
    ).insert(ignore_permissions=True).name
