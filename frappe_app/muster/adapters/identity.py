from __future__ import annotations

import json
from hashlib import sha256

import frappe

from muster.change_ir.security import permission_epoch


def frappe_identity(user: str) -> dict:
    user_doc = frappe.get_cached_doc("User", user)
    roles = sorted(set(frappe.get_roles(user)))
    epoch = permission_epoch(user)
    return {
        "site": frappe.local.site,
        "user": user.lower(),
        "userName": user_doc.full_name,
        "roles": roles,
        "rolesHash": sha256(json.dumps(roles, separators=(",", ":")).encode()).hexdigest(),
        "permissionHash": epoch,
        "authMode": "frappe_session",
        "resolvedAt": str(frappe.utils.now_datetime()),
    }


def allowed_channel_scopes(user: str, configured: str) -> list[str]:
    requested = {line.strip() for line in (configured or "frappe:read").splitlines() if line.strip()}
    roles = set(frappe.get_roles(user))
    effective = {"frappe:read"}
    if roles.intersection({"System Manager", "Muster Administrator", "Muster Automation Manager", "Muster Operator"}):
        effective.add("frappe:write")
    if roles.intersection({"System Manager", "Muster Administrator", "Muster Approver"}):
        effective.add("frappe:approve")
    return sorted(requested.intersection(effective))
