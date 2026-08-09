from __future__ import annotations

import hashlib
import hmac
import json
import re
import secrets
import time
from datetime import UTC, datetime
from typing import Any

import frappe
from frappe import _
from frappe.auth import LoginManager

from muster.api.effect_callback import _authenticate, _execution, _raw_request, _trusted_binding
from muster.change_ir.security import permission_epoch
from muster.orchestration.form_schema import assert_form_schema_binding

BOOTSTRAP_TTL_SECONDS = 90
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$")
CHALLENGE = re.compile(r"^[A-Za-z0-9_-]{40,128}$")
ISSUE_KEYS = {
    "schema_version", "binding_id", "tenant_id", "site_id", "site_origin",
    "mission_id", "root_run_id", "node_id", "actor", "permission_epoch",
    "browser_challenge", "form_schema_binding",
}


class MusterBrowserSessionError(frappe.PermissionError):
    pass


def _ticket_key(ticket: str) -> str:
    return f"muster:browser-bootstrap:{hashlib.sha256(ticket.encode()).hexdigest()}"


def _required_id(value: Any, label: str) -> str:
    if not isinstance(value, str) or not SAFE_ID.fullmatch(value):
        raise MusterBrowserSessionError(_("The browser session {0} is invalid").format(label))
    return value


def _exact_json_body(keys: set[str]) -> tuple[dict[str, Any], bytes]:
    if not frappe.request or frappe.request.method != "POST":
        raise MusterBrowserSessionError(_("The browser session endpoint accepts POST only"))
    raw = frappe.request.get_data(cache=True) or b""
    if not raw or len(raw) > 65_536:
        raise MusterBrowserSessionError(_("The browser session request is invalid"))
    try:
        value = json.loads(raw)
    except (TypeError, ValueError) as error:
        raise MusterBrowserSessionError(_("The browser session request is invalid")) from error
    if not isinstance(value, dict) or set(value) != keys:
        raise MusterBrowserSessionError(_("The browser session request is invalid"))
    return value, raw


def _current_mission(ticket: dict[str, Any]):
    mission_id = _required_id(ticket.get("mission_id"), "mission")
    if not frappe.db.exists("Muster Mission", mission_id):
        raise MusterBrowserSessionError(_("The browser session mission is unavailable"))
    mission = frappe.get_doc("Muster Mission", mission_id)
    actor = _required_id(ticket.get("actor"), "actor")
    if (
        mission.requested_by.lower() != actor.lower()
        or not mission.root_run_id
        or not hmac.compare_digest(mission.root_run_id, str(ticket.get("root_run_id") or ""))
        or mission.status != "Running"
        or not frappe.db.get_value("User", actor, "enabled")
    ):
        raise MusterBrowserSessionError(_("The browser session mission authority is no longer active"))
    if not hmac.compare_digest(permission_epoch(actor), str(ticket.get("permission_epoch") or "")):
        raise MusterBrowserSessionError(_("The browser session permissions changed after authorization"))
    return mission, actor


@frappe.whitelist(allow_guest=True, methods=["POST"])
def issue() -> dict[str, Any]:
    """Issue an opaque, one-use login bootstrap to the authenticated Muster gateway.

    This endpoint accepts no browser actions, URLs, passwords, API keys, or cookies.
    It reuses the effect callback's bearer + HMAC + nonce authentication and
    independently binds the live Frappe mission, actor, node, and permission epoch.
    """
    body, raw = _raw_request()
    envelope = body.get("envelope")
    if not isinstance(envelope, dict) or set(envelope) != ISSUE_KEYS:
        raise MusterBrowserSessionError(_("The browser bootstrap envelope is invalid"))
    if envelope.get("schema_version") != 1:
        raise MusterBrowserSessionError(_("The browser bootstrap protocol is unsupported"))
    settings, binding = _trusted_binding(envelope)
    _authenticate(raw, settings)
    mission, actor = _execution(envelope)
    if mission.status != "Running":
        raise MusterBrowserSessionError(_("The browser work session is not running"))
    live_epoch = permission_epoch(actor)
    supplied_epoch = envelope.get("permission_epoch")
    if not isinstance(supplied_epoch, str) or not hmac.compare_digest(live_epoch, supplied_epoch):
        raise MusterBrowserSessionError(_("The browser work session permission epoch is stale"))
    challenge = envelope.get("browser_challenge")
    if not isinstance(challenge, str) or not CHALLENGE.fullmatch(challenge):
        raise MusterBrowserSessionError(_("The browser work session challenge is invalid"))
    form_binding = envelope.get("form_schema_binding")
    form_schema = None
    if form_binding is not None:
        if not isinstance(form_binding, dict):
            raise MusterBrowserSessionError(_("The attended form schema binding is invalid"))
        form_schema = assert_form_schema_binding(form_binding, user=actor)

    ticket = secrets.token_urlsafe(48)
    bootstrap_id = f"browser-{secrets.token_hex(16)}"
    expires_at = int(time.time()) + BOOTSTRAP_TTL_SECONDS
    stored = {
        "schema_version": 1,
        "bootstrap_id": bootstrap_id,
        "mission_id": mission.name,
        "root_run_id": mission.root_run_id,
        "node_id": _required_id(envelope.get("node_id"), "node"),
        "actor": actor,
        "permission_epoch": live_epoch,
        "browser_challenge": challenge,
        "binding_id": binding.gateway_binding_id,
        "site_id": binding.site_uuid,
        "tenant_id": binding.gateway_tenant,
        "site_origin": binding.site_origin,
        "expires_at": expires_at,
        "form_schema_binding": form_binding,
    }
    frappe.cache.set_value(_ticket_key(ticket), json.dumps(stored), expires_in_sec=BOOTSTRAP_TTL_SECONDS)
    binding.db_set({"last_seen_at": frappe.utils.now_datetime(), "health_status": "Browser session bootstrap issued"}, update_modified=False)
    return {
        "ticket": ticket,
        "browser_challenge": challenge,
        "bootstrap_id": bootstrap_id,
        "expires_at": datetime.fromtimestamp(expires_at, UTC).isoformat(),
        "site_origin": binding.site_origin,
        "actor_id": actor,
        "permission_epoch": live_epoch,
        "form_schema": _public_form_schema(form_schema),
    }


@frappe.whitelist(allow_guest=True, methods=["POST"])
def consume() -> dict[str, Any]:
    """Consume a bootstrap in the isolated browser context and set its Frappe SID.

    The ticket is sent in a POST body, never in a URL. A per-browser challenge
    prevents a stolen ticket response from being consumed by another context.
    """
    body, _raw = _exact_json_body({"ticket", "browser_challenge", "bootstrap_id"})
    ticket = body.get("ticket")
    challenge = body.get("browser_challenge")
    bootstrap_id = body.get("bootstrap_id")
    if not isinstance(ticket, str) or len(ticket) < 48 or len(ticket) > 512 or not isinstance(challenge, str) or not CHALLENGE.fullmatch(challenge) or not isinstance(bootstrap_id, str) or not SAFE_ID.fullmatch(bootstrap_id):
        raise MusterBrowserSessionError(_("The browser bootstrap is invalid or expired"))
    key = _ticket_key(ticket)
    with frappe.cache.lock(f"{key}:lock", timeout=5, blocking_timeout=2):
        raw = frappe.cache.get_value(key)
        # Consume before validating to deny brute force, replay, and partial failures.
        frappe.cache.delete_value(key)
    if not raw:
        raise MusterBrowserSessionError(_("The browser bootstrap is invalid or expired"))
    try:
        stored = json.loads(raw) if isinstance(raw, str) else raw
    except (TypeError, ValueError) as error:
        raise MusterBrowserSessionError(_("The browser bootstrap is invalid or expired")) from error
    if (
        not isinstance(stored, dict)
        or int(stored.get("expires_at", 0)) < int(time.time())
        or not hmac.compare_digest(str(stored.get("browser_challenge") or ""), challenge)
        or not hmac.compare_digest(str(stored.get("bootstrap_id") or ""), bootstrap_id)
    ):
        raise MusterBrowserSessionError(_("The browser bootstrap is invalid or expired"))
    # Revalidate reciprocal site trust after consuming the ticket. Revocation
    # between issue and consume therefore fails closed.
    _trusted_binding(stored)
    _mission, actor = _current_mission(stored)
    form_binding = stored.get("form_schema_binding")
    form_schema = assert_form_schema_binding(form_binding, user=actor) if isinstance(form_binding, dict) else None

    # A dedicated browser context receives this SID. The human's Desk cookies
    # are never imported. The transport must call Frappe logout before closing.
    if not getattr(frappe.local, "login_manager", None):
        frappe.local.login_manager = LoginManager()
    frappe.local.login_manager.login_as(actor)
    session_fingerprint = hashlib.sha256(f"{bootstrap_id}\0{actor}\0{stored['mission_id']}".encode()).hexdigest()
    return {
        "authenticated": True,
        "bootstrap_id": bootstrap_id,
        "session_fingerprint": session_fingerprint,
        "actor_id": actor,
        "mission_id": stored["mission_id"],
        "route": "/desk",
        "form_schema": _public_form_schema(form_schema),
    }


@frappe.whitelist(methods=["POST"])
def verify_schema(binding: dict[str, Any] | str) -> dict[str, Any]:
    """Recheck customization and field authority inside the isolated actor SID.

    The browser transport calls this before attended mutations. It performs no
    CRUD and accepts no values, scripts, methods, selectors, or URLs.
    """
    if isinstance(binding, str):
        try:
            binding = json.loads(binding)
        except (TypeError, ValueError) as error:
            raise MusterBrowserSessionError(_("The attended form schema binding is invalid")) from error
    snapshot = assert_form_schema_binding(binding, user=frappe.session.user)
    return _public_form_schema(snapshot)


@frappe.whitelist(methods=["POST"])
def verify_record(binding: dict[str, Any] | str, record_name: str, expected: dict[str, Any] | str) -> dict[str, Any]:
    """Reread a visibly-saved record and prove the governed values persisted.

    This is verification only: it cannot create, update, submit, cancel or delete.
    """
    if isinstance(binding, str):
        binding = json.loads(binding)
    if isinstance(expected, str):
        expected = json.loads(expected)
    snapshot = assert_form_schema_binding(binding, user=frappe.session.user)
    if not isinstance(record_name, str) or not record_name or len(record_name) > 140 or any(ord(char) < 32 for char in record_name) or not isinstance(expected, dict) or len(expected) > 100:
        raise MusterBrowserSessionError(_("The attended record proof is invalid"))
    if set(expected) != set(binding["fields"]):
        raise MusterBrowserSessionError(_("The attended record proof fields do not match the reviewed form"))
    doc = frappe.get_doc(snapshot["doctype"], record_name)
    if not doc.has_permission("read"):
        raise MusterBrowserSessionError(_("The saved record is not readable by this user"))
    for fieldname, planned in expected.items():
        actual = doc.get(fieldname)
        # Browser controls serialize scalar values. Child tables and arbitrary
        # structures are outside the attended CRUD v1 field allow-list.
        if isinstance(actual, (dict, list, tuple)) or str(actual if actual is not None else "") != str(planned if planned is not None else ""):
            raise MusterBrowserSessionError(_("The saved record did not retain a reviewed field value"))
    proof = hashlib.sha256(json.dumps({
        "doctype": snapshot["doctype"], "record_name": record_name,
        "schema_hash": snapshot["schema_hash"], "expected": expected,
    }, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()
    return {"doctype": snapshot["doctype"], "record_name": record_name, "proof_hash": proof}


def _public_form_schema(snapshot: dict[str, Any] | None) -> dict[str, Any] | None:
    if snapshot is None:
        return None
    customized = [
        {
            "fieldname": field["fieldname"],
            "label": field["label"],
            "source": field["provenance"]["source"],
            "property_setter_count": len(field["provenance"]["property_setters"]),
        }
        for field in snapshot["fields"]
        if field["provenance"]["source"] == "custom_field" or field["provenance"]["property_setters"]
    ]
    return {
        "doctype": snapshot["doctype"],
        "schema_hash": snapshot["schema_hash"],
        "revision": snapshot["revision"],
        "customized_fields": customized,
        "doctype_property_setter_count": len(snapshot["doctype_property_setters"]),
        "workflow": snapshot["workflow"],
        "client_scripts": snapshot["client_scripts"],
        "custom_permission_count": len(snapshot["custom_permissions"]),
        "server_script_count": len(snapshot["server_scripts"]),
        "form_action_count": snapshot["form_extensions"]["action_count"],
        "form_link_count": snapshot["form_extensions"]["link_count"],
    }
