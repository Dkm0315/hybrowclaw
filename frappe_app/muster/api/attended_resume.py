from __future__ import annotations

import hashlib
import json
import re
import secrets
import time
from typing import Any
from urllib.parse import urlsplit

import frappe
from frappe import _
from frappe.utils import cint

from muster.api.surface import attended_surface_for_route, attended_target_for
from muster.orchestration.workflow_proposal import attended_proposal_preview


RESUME_TTL_SECONDS = 90
_TICKET = re.compile(r"^[A-Za-z0-9_-]{48,512}$")


class MusterAttendedResumeError(frappe.PermissionError):
    pass


def _ticket_key(ticket: str) -> str:
    return f"muster:attended-resume:{hashlib.sha256(ticket.encode()).hexdigest()}"


def _require_post() -> None:
    if frappe.request and frappe.request.method != "POST":
        raise MusterAttendedResumeError(_("The attended resume endpoint accepts POST only"))


def _idempotency_key() -> str:
    value = frappe.get_request_header("Idempotency-Key") or frappe.form_dict.get("idempotency_key")
    if not isinstance(value, str) or not value or len(value) > 140:
        raise MusterAttendedResumeError(_("The attended resume request is invalid"))
    return value


def _actor() -> str:
    actor = str(frappe.session.user or "").strip()
    if not actor or actor.lower() == "guest" or not cint(frappe.db.get_value("User", actor, "enabled")):
        raise MusterAttendedResumeError(_("Sign in to resume attended work"))
    return actor


def _site_id() -> str:
    site = str(getattr(frappe.local, "site", "") or "").strip()
    if not site:
        raise MusterAttendedResumeError(_("The attended resume site is unavailable"))
    return site


def _request_route() -> str:
    referer = str(frappe.get_request_header("Referer") or "")
    host = str(frappe.get_request_header("Host") or "").lower()
    try:
        parsed = urlsplit(referer)
    except ValueError as error:
        raise MusterAttendedResumeError(_("The attended resume route is invalid")) from error
    if parsed.scheme not in {"http", "https"} or not host or parsed.netloc.lower() != host or not parsed.path.startswith("/"):
        raise MusterAttendedResumeError(_("The attended resume route is invalid"))
    if any(ord(character) < 32 or ord(character) == 127 for character in parsed.path) or len(parsed.path) > 2_048:
        raise MusterAttendedResumeError(_("The attended resume route is invalid"))
    return parsed.path


@frappe.whitelist(methods=["POST"])
def issue(proposal: str, confirmed: int | str = 0) -> dict[str, Any]:
    """Return local=true or mint one opaque cross-surface navigation ticket."""
    _require_post()
    _idempotency_key()
    if not cint(confirmed):
        raise MusterAttendedResumeError(_("Confirm before Muster changes application surfaces"))
    actor = _actor()
    site = _site_id()
    preview = attended_proposal_preview(proposal, actor)
    target = attended_target_for(preview["doctype"], preview["operation"], preview.get("record_name"))
    current_route = _request_route()
    current_surface = attended_surface_for_route(current_route)
    if current_surface == target["surface"]:
        return {"schema_version": 1, "proposal": proposal, "navigate_required": False}

    ticket = secrets.token_urlsafe(48)
    expires_at = int(time.time()) + RESUME_TTL_SECONDS
    stored = {
        "schema_version": 1,
        "actor": actor,
        "site": site,
        "proposal": proposal,
        "target_surface": target["surface"],
        "target_route": target["route"],
        "expires_at": expires_at,
    }
    frappe.cache.set_value(_ticket_key(ticket), json.dumps(stored), expires_in_sec=RESUME_TTL_SECONDS)
    return {
        "schema_version": 1,
        "proposal": proposal,
        "navigate_required": True,
        "target_surface": target["surface"],
        "target_route": target["route"],
        "expires_at": expires_at,
        "url": f"{target['route']}#muster-attended-resume={ticket}",
    }


@frappe.whitelist(methods=["POST"])
def consume(ticket: str, confirmed: int | str = 0) -> dict[str, Any]:
    """Consume before validation, then return a fresh reviewed receipt to the local adapter."""
    _require_post()
    _idempotency_key()
    if not cint(confirmed) or not isinstance(ticket, str) or not _TICKET.fullmatch(ticket):
        raise MusterAttendedResumeError(_("The attended resume ticket is invalid or expired"))
    key = _ticket_key(ticket)
    with frappe.cache.lock(f"{key}:lock", timeout=5, blocking_timeout=2):
        raw = frappe.cache.get_value(key)
        frappe.cache.delete_value(key)
    if not raw:
        raise MusterAttendedResumeError(_("The attended resume ticket is invalid or expired"))
    try:
        stored = json.loads(raw) if isinstance(raw, str) else raw
    except (TypeError, ValueError) as error:
        raise MusterAttendedResumeError(_("The attended resume ticket is invalid or expired")) from error
    actor = _actor()
    site = _site_id()
    route = _request_route()
    if (
        not isinstance(stored, dict)
        or stored.get("schema_version") != 1
        or int(stored.get("expires_at", 0)) <= int(time.time())
        or not secrets.compare_digest(str(stored.get("actor") or ""), actor)
        or not secrets.compare_digest(str(stored.get("site") or ""), site)
        or not secrets.compare_digest(str(stored.get("target_route") or ""), route)
        or attended_surface_for_route(route) != stored.get("target_surface")
    ):
        raise MusterAttendedResumeError(_("The attended resume ticket is invalid or expired"))
    proposal = str(stored.get("proposal") or "")
    preview = attended_proposal_preview(proposal, actor)
    current_target = attended_target_for(preview["doctype"], preview["operation"], preview.get("record_name"))
    if current_target != {"surface": stored.get("target_surface"), "route": stored.get("target_route")}:
        raise MusterAttendedResumeError(_("The attended resume target changed after issuance"))
    return preview
