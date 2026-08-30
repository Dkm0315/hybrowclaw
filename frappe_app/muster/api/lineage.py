from __future__ import annotations

import json
import secrets
from datetime import timedelta
from hashlib import sha256
from typing import Any

import frappe
from frappe import _
from frappe.utils import now_datetime

from muster.orchestration.lineage_diagnostic import configured_lineage_plan


TTL_SECONDS = 15 * 60


def _require_post() -> None:
    if frappe.request and frappe.request.method != "POST":
        frappe.throw(_("This action requires POST"), frappe.PermissionError)


def _actor() -> str:
    if frappe.session.user == "Guest":
        frappe.throw(_("Not permitted"), frappe.PermissionError)
    return frappe.session.user


def _cache_key(plan_id: str) -> str:
    if not isinstance(plan_id, str) or len(plan_id) != 43 or not all(char.isalnum() or char in "-_" for char in plan_id):
        frappe.throw(_("This reviewed correction is unavailable"), frappe.PermissionError)
    return f"muster:lineage-remediation:{sha256(plan_id.encode()).hexdigest()}"


def _load(plan_id: str, actor: str) -> dict[str, Any]:
    raw = frappe.cache.get_value(_cache_key(plan_id))
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8")
    try:
        plan = json.loads(raw) if isinstance(raw, str) else None
    except ValueError:
        plan = None
    if not isinstance(plan, dict) or plan.get("user") != actor or now_datetime().isoformat() >= str(plan.get("expires_at") or ""):
        frappe.throw(_("This reviewed correction is unavailable or has expired"), frappe.PermissionError)
    return plan


def _store(plan_id: str, plan: dict[str, Any]) -> None:
    frappe.cache.set_value(
        _cache_key(plan_id),
        json.dumps(plan, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str),
        expires_in_sec=TTL_SECONDS,
    )


def prepare_from_turn(turn, site_origin: str) -> dict[str, Any]:
    actor = _actor()
    if turn.requested_by != actor or not turn.has_permission("read"):
        frappe.throw(_("This reviewed correction is unavailable"), frappe.PermissionError)
    turn_key = f"muster:lineage-turn:{turn.name}:{actor}"
    existing = frappe.cache.get_value(turn_key)
    if isinstance(existing, bytes):
        existing = existing.decode("utf-8")
    if isinstance(existing, str):
        plan = _load(existing, actor)
        return _public(existing, plan, replayed=True)
    objective = turn.get_password("prompt_secret")
    plan = configured_lineage_plan(objective, actor, site_origin)
    if not plan:
        frappe.throw(_("I could not prepare one safe correction set from the live lineage"), frappe.ValidationError)
    plan_id = secrets.token_urlsafe(32)
    expires_at = (now_datetime() + timedelta(seconds=TTL_SECONDS)).isoformat()
    stored = {
        **plan,
        "user": actor,
        "turn": turn.name,
        "authorized": False,
        "authorized_at": None,
        "completed": [],
        "expires_at": expires_at,
    }
    _store(plan_id, stored)
    frappe.cache.set_value(turn_key, plan_id, expires_in_sec=TTL_SECONDS)
    return _public(plan_id, stored, replayed=False)


def _public(plan_id: str, plan: dict[str, Any], *, replayed: bool) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "plan_id": plan_id,
        "digest": plan["digest"],
        "actions": plan["actions"],
        "lineage": plan.get("lineage") or [],
        "refusals": plan.get("refusals") or [],
        "expires_at": plan["expires_at"],
        "replayed": replayed,
        "executed": False,
    }


@frappe.whitelist()
def authorize(plan_id: str, confirmed: int | str = 0) -> dict[str, Any]:
    """Bind one explicit approval to the already reviewed correction set."""
    _require_post()
    actor = _actor()
    if str(confirmed) != "1":
        frappe.throw(_("Confirm the reviewed correction before saving"), frappe.ValidationError)
    plan = _load(plan_id, actor)
    if plan.get("completed"):
        frappe.throw(_("A partially completed correction cannot be authorized again"), frappe.ValidationError)
    plan["authorized"] = True
    plan["authorized_at"] = now_datetime().isoformat()
    _store(plan_id, plan)
    return {"plan_id": plan_id, "authorized": True, "action_count": len(plan["actions"])}


def _action(plan: dict[str, Any], action_id: str) -> dict[str, Any]:
    action = next((row for row in plan.get("actions", []) if row.get("id") == action_id), None)
    if not action:
        frappe.throw(_("This correction step is unavailable"), frappe.PermissionError)
    return action


@frappe.whitelist()
def preflight(plan_id: str, action_id: str) -> dict[str, Any]:
    """Recheck exact record identity, revision and write authority before Save."""
    _require_post()
    actor = _actor()
    plan = _load(plan_id, actor)
    if not plan.get("authorized"):
        frappe.throw(_("Approve the reviewed correction before saving"), frappe.PermissionError)
    action = _action(plan, action_id)
    if action_id in plan.get("completed", []):
        frappe.throw(_("This correction step was already completed"), frappe.ValidationError)
    doctype, name = action["doctype"], action["record_name"]
    doc = frappe.get_doc(doctype, name)
    if not doc.has_permission("read", user=actor) or not doc.has_permission("write", user=actor):
        frappe.throw(_("You no longer have permission to update this record"), frappe.PermissionError)
    if str(doc.modified) != action["record_revision"]:
        frappe.throw(_("This record changed after review. Prepare the correction again."), frappe.ValidationError)
    return {"plan_id": plan_id, "action_id": action_id, "current": True, "executed": False}


@frappe.whitelist()
def verify(plan_id: str, action_id: str) -> dict[str, Any]:
    """Reread the native Save and seal the reviewed values as evidence."""
    _require_post()
    actor = _actor()
    plan = _load(plan_id, actor)
    action = _action(plan, action_id)
    doc = frappe.get_doc(action["doctype"], action["record_name"])
    if not doc.has_permission("read", user=actor):
        frappe.throw(_("The saved record is no longer readable"), frappe.PermissionError)
    for field in action["fields"]:
        actual = doc.get(field["fieldname"])
        expected = field["value"]
        if field["control"] == "table":
            actual_rows = [
                {key: row.get(key) for key in expected[index]}
                for index, row in enumerate(actual or []) if index < len(expected)
            ]
            if actual_rows != expected:
                frappe.throw(_("The saved child rows do not match the reviewed correction"), frappe.ValidationError)
        elif str(actual or "") != str(expected or ""):
            frappe.throw(_("The saved record does not match the reviewed correction"), frappe.ValidationError)
    completed = list(plan.get("completed") or [])
    if action_id not in completed:
        completed.append(action_id)
    plan["completed"] = completed
    _store(plan_id, plan)
    proof = sha256(json.dumps({
        "plan": plan["digest"], "action": action_id, "record": action["record_name"],
        "modified": str(doc.modified),
    }, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {
        "plan_id": plan_id,
        "action_id": action_id,
        "verified": True,
        "proof_hash": proof,
        "completed": len(completed),
        "total": len(plan["actions"]),
        "done": len(completed) == len(plan["actions"]),
    }
