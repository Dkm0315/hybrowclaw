"""Explicit, revocable director account for the public Frappeverse demo."""

from __future__ import annotations

import frappe
from frappe import _
from frappe.utils import cint
from frappe.utils.password import update_password


DIRECTOR_USER = "director.demo@frappeverse.invalid"
REQUIRED_DIRECTOR_ROLES = (
    "System Manager",
    "Sales Manager",
    "HR Manager",
    "Agent Manager",
    "Support Team",
    "Muster Administrator",
    "Muster Approver",
)


def _director_roles() -> tuple[str, ...]:
    """Return every enabled assignable role on the installed demo estate."""
    roles = frappe.get_all("Role", filters={"disabled": 0}, pluck="name", order_by="name asc")
    return tuple(role for role in roles if role not in {"All", "Guest", "Desk User"})


def activate(password: str, confirm: bool | int | str = False) -> dict[str, object]:
    """Create or rotate one intentionally powerful, clearly labeled demo user."""
    if not cint(confirm):
        frappe.throw(_("Explicit confirmation is required"), frappe.ValidationError)
    if not isinstance(password, str) or len(password) < 20:
        frappe.throw(_("The director demo password must contain at least 20 characters"), frappe.ValidationError)
    missing_roles = [role for role in REQUIRED_DIRECTOR_ROLES if not frappe.db.exists("Role", role)]
    if missing_roles:
        frappe.throw(_("Required demo roles are unavailable: {0}").format(", ".join(missing_roles)))

    if frappe.db.exists("User", DIRECTOR_USER):
        user = frappe.get_doc("User", DIRECTOR_USER)
    else:
        user = frappe.get_doc({
            "doctype": "User",
            "email": DIRECTOR_USER,
            "first_name": "Frappeverse",
            "last_name": "Director Demo",
            "send_welcome_email": 0,
            "user_type": "System User",
        }).insert(ignore_permissions=True)
    user.enabled = 1
    user.user_type = "System User"
    roles = _director_roles()
    existing = {row.role for row in user.roles}
    for role in roles:
        if role not in existing:
            user.append("roles", {"role": role})
    user.save(ignore_permissions=True)
    update_password(DIRECTOR_USER, password, logout_all_sessions=True)
    frappe.clear_cache(user=DIRECTOR_USER)
    frappe.db.commit()
    return {
        "user": DIRECTOR_USER,
        "enabled": True,
        "system_manager": "System Manager" in frappe.get_roles(DIRECTOR_USER),
        "role_count": len(roles),
        "required_roles": list(REQUIRED_DIRECTOR_ROLES),
        "password_returned": False,
    }
