from __future__ import annotations

import json
from hashlib import sha256
from typing import Any

import frappe


PERMISSION_FIELDS = (
    "role", "parent", "permlevel", "read", "write", "create", "delete", "submit",
    "cancel", "amend", "report", "export", "import", "share", "print", "email",
    "if_owner", "select",
)


def _rows(doctype: str, *, filters: dict[str, Any] | None = None, fields: list[str]) -> list[dict]:
    if not frappe.db.exists("DocType", doctype):
        return []
    return frappe.get_all(doctype, filters=filters or {}, fields=fields, order_by="name asc")


def permission_snapshot(user: str) -> dict[str, Any]:
    """Return the live, stable inputs that authorize a Frappe principal.

    The snapshot is intentionally composed from ordinary permission metadata rather than a
    cached role label. Effects still perform a fresh `has_permission` check; the epoch closes
    the plan/approval/execution race when roles, user permissions, or shares change.
    """
    user_doc = frappe.get_cached_doc("User", user)
    roles = sorted(set(frappe.get_roles(user)))
    role_filters = {"role": ["in", roles]} if roles else {"role": "__no_role__"}
    share_filters: list[list[Any]] = [
        ["user", "in", [user, ""]],
    ]
    return {
        "site": frappe.local.site,
        "user": user,
        "enabled": int(user_doc.enabled or 0),
        "user_type": user_doc.user_type,
        "role_profile_name": user_doc.role_profile_name,
        "roles": roles,
        "user_permissions": _rows(
            "User Permission",
            filters={"user": user},
            fields=["name", "allow", "for_value", "applicable_for", "is_default", "hide_descendants"],
        ),
        "doc_permissions": _rows("DocPerm", filters=role_filters, fields=["name", *PERMISSION_FIELDS]),
        "custom_doc_permissions": _rows(
            "Custom DocPerm", filters=role_filters, fields=["name", *PERMISSION_FIELDS]
        ),
        "shares": _rows(
            "DocShare",
            filters=share_filters,
            fields=["name", "share_doctype", "share_name", "user", "read", "write", "share", "submit"],
        ),
    }


def permission_epoch(user: str) -> str:
    payload = json.dumps(permission_snapshot(user), sort_keys=True, separators=(",", ":"), default=str)
    return sha256(payload.encode()).hexdigest()


def schema_revision() -> str:
    """Hash installed applications and the current metadata modification frontier."""
    def latest(doctype: str) -> str:
        rows = frappe.get_all(doctype, fields=["modified"], order_by="modified desc", limit=1)
        return str(rows[0].modified) if rows else ""

    apps = sorted(frappe.get_installed_apps())
    payload = json.dumps(
        [apps, latest("DocType"), latest("Custom Field"), latest("Property Setter"),
         latest("Page"), latest("Report"), latest("Print Format"), latest("Web Page")],
        separators=(",", ":"),
    )
    return sha256(payload.encode()).hexdigest()
