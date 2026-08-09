from __future__ import annotations

import re
from typing import Any

import frappe
from frappe import _

from muster.api.ask import _client_for_user, _require_user


_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$")
_MANAGER_ROLES = {"System Manager", "Muster Administrator", "Muster Automation Manager"}
_SYSTEM_ROLES = {"System Manager", "Muster Administrator"}
_VIEWER_COMMANDS = {
    "help", "start", "status", "whoami", "reports", "artifacts", "sessions",
    "settings", "tokens", "usage", "limits", "approvals", "memory", "new",
    "reset", "stop", "skills", "agents", "mcp", "tools",
}


def _text(value: Any, fallback: str = "") -> str:
    return str(value or fallback).strip()[:240]


def _command_visible(row: dict[str, Any], roles: set[str]) -> bool:
    minimum = row.get("minimum_role")
    if minimum == "system":
        return bool(roles & _SYSTEM_ROLES)
    if minimum == "manager":
        return bool(roles & _MANAGER_ROLES)
    # The gateway remains authoritative at dispatch. For ordinary Frappe users,
    # expose only read/control commands whose results are identity-filtered.
    return bool(roles & _MANAGER_ROLES) or row.get("name") in _VIEWER_COMMANDS


def _commands(value: Any, roles: set[str]) -> list[dict[str, str]]:
    result = []
    if not isinstance(value, list):
        return result
    for row in value[:160]:
        if not isinstance(row, dict) or not _command_visible(row, roles):
            continue
        name = _text(row.get("name")).lower()
        if not _IDENTIFIER.fullmatch(name):
            continue
        surfaces = row.get("surfaces")
        if isinstance(surfaces, list) and not any(
            surface == "*" or str(surface).startswith("frappe") for surface in surfaces
        ):
            continue
        result.append({
            "kind": "command", "id": name, "label": _text(row.get("label"), name),
            "description": _text(row.get("description"), _("Muster command")),
            "token": f"/{name}",
        })
    return result


def _personas(value: Any) -> list[dict[str, str]]:
    result = []
    if not isinstance(value, dict):
        return result
    for name, row in list(value.items())[:80]:
        if not isinstance(name, str) or not _IDENTIFIER.fullmatch(name) or not isinstance(row, dict):
            continue
        result.append({
            "kind": "agent", "id": name, "label": _text(row.get("label"), name),
            # Provider/runtime topology is deliberately not a Desk concern.
            "description": _("Use this governed Muster agent"),
            "token": f"@agent:{name}",
        })
    return result


def _named_runtime_items(value: Any, kind: str) -> list[dict[str, str]]:
    result = []
    if not isinstance(value, list):
        return result
    for row in value[:160]:
        if not isinstance(row, dict):
            continue
        name = _text(row.get("name") or row.get("id"))
        if not _IDENTIFIER.fullmatch(name):
            continue
        result.append({
            "kind": kind, "id": name, "label": _text(row.get("label"), name),
            "description": _("Available to governed workflows; access is checked again when used"),
            "token": f"@{kind}:{name}",
        })
    return result


def _workflows() -> list[dict[str, str]]:
    if not frappe.has_permission("Muster Workflow", "read"):
        return []
    rows = frappe.get_list(
        "Muster Workflow",
        filters={"status": "Published"},
        fields=["name", "workflow_name", "description"],
        order_by="modified desc",
        limit_page_length=80,
    )
    result = []
    for row in rows:
        name = _text(row.name)
        if not name or any(ord(char) < 32 for char in name):
            continue
        mention = name.replace("[", "").replace("]", "").strip()[:155]
        if not mention:
            continue
        result.append({
            "kind": "workflow", "id": name,
            "label": _text(row.workflow_name, row.name),
            "description": _text(row.description, _("Published Muster workflow")),
            "token": f"@workflow[{mention}]",
        })
    return result


@frappe.whitelist()
def get_palette() -> dict[str, Any]:
    """Return a bounded, user-visible catalog; invocation is still re-authorized."""
    user = _require_user()
    roles = set(frappe.get_roles(user))
    client, headers, _binding = _client_for_user(user)
    remote = client.request("GET", "/v1/integrations/frappe/catalog", headers=headers)
    if remote.get("source") != "muster_native_http":
        frappe.throw(_("The Muster command catalog is unavailable"), frappe.ValidationError)
    items = [
        *_commands(remote.get("commands"), roles),
        *_personas(remote.get("personas")),
        *_named_runtime_items(remote.get("skills"), "skill"),
        *_named_runtime_items(remote.get("mcp_servers"), "mcp"),
        *_workflows(),
    ]
    return {"schema_version": 1, "items": items[:320]}
