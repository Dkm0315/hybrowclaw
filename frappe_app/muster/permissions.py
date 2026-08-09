from __future__ import annotations

import frappe
from frappe.utils import cint

MUSTER_ROLES = {
    "Muster Administrator",
    "Muster Automation Manager",
    "Muster Operator",
    "Muster Approver",
    "Muster Auditor",
    "Muster Viewer",
}
ADMIN_ROLES = {"System Manager", "Muster Administrator"}
GLOBAL_READ_ROLES = ADMIN_ROLES | {"Muster Automation Manager", "Muster Auditor"}
MISSION_CREATOR_ROLES = ADMIN_ROLES | {"Muster Automation Manager", "Muster Operator"}


def has_any_muster_role(user: str | None = None) -> bool:
    user = user or frappe.session.user
    return bool(set(frappe.get_roles(user)) & MUSTER_ROLES)


def has_app_permission() -> bool:
    return has_any_muster_role() or "System Manager" in frappe.get_roles()


def _escape(value: str) -> str:
    return frappe.db.escape(value)


def _mission_visibility(user: str) -> str:
    if set(frappe.get_roles(user)) & GLOBAL_READ_ROLES:
        return ""
    escaped = _escape(user)
    return (
        f"(`tabMuster Mission`.`requested_by` = {escaped} "
        f"or `tabMuster Mission`.`owner` = {escaped} "
        f"or `tabMuster Mission`.`assigned_to` = {escaped})"
    )


def mission_query(user: str | None = None) -> str:
    return _mission_visibility(user or frappe.session.user)


def workflow_proposal_query(user: str | None = None) -> str:
    user = user or frappe.session.user
    if set(frappe.get_roles(user)) & (GLOBAL_READ_ROLES | {"Muster Approver"}):
        return ""
    return f"`tabMuster Workflow Proposal`.`requested_by` = {_escape(user)}"


def ask_turn_query(user: str | None = None) -> str:
    user = user or frappe.session.user
    if set(frappe.get_roles(user)) & GLOBAL_READ_ROLES:
        return ""
    return f"`tabMuster Ask Turn`.`requested_by` = {_escape(user)}"


def development_proposal_query(user: str | None = None) -> str:
    user = user or frappe.session.user
    if set(frappe.get_roles(user)) & GLOBAL_READ_ROLES:
        return ""
    return f"`tabMuster Development Proposal`.`requested_by` = {_escape(user)}"


def _child_query(table: str, mission_field: str, user: str) -> str:
    if set(frappe.get_roles(user)) & GLOBAL_READ_ROLES:
        return ""
    escaped = _escape(user)
    return (
        f"exists (select 1 from `tabMuster Mission` m where m.name = `{table}`.`{mission_field}` "
        f"and (m.requested_by = {escaped} or m.owner = {escaped} or m.assigned_to = {escaped}))"
    )


def work_unit_query(user=None):
    return _child_query("tabMuster Work Unit", "mission", user or frappe.session.user)


def run_query(user=None):
    return _child_query("tabMuster Run", "mission", user or frappe.session.user)


def activity_query(user=None):
    return _child_query("tabMuster Activity", "mission", user or frappe.session.user)


def artifact_query(user=None):
    return _child_query("tabMuster Artifact", "mission", user or frappe.session.user)


def evidence_clip_query(user=None):
    return _child_query("tabMuster Evidence Clip", "mission", user or frappe.session.user)


def approval_query(user=None):
    user = user or frappe.session.user
    if set(frappe.get_roles(user)) & GLOBAL_READ_ROLES:
        return ""
    escaped = _escape(user)
    return (
        f"(`tabMuster Approval`.`requested_from` = {escaped} or "
        f"`tabMuster Approval`.`requested_by` = {escaped})"
    )


def channel_identity_query(user=None):
    user = user or frappe.session.user
    roles = set(frappe.get_roles(user))
    if roles & GLOBAL_READ_ROLES:
        return ""
    return f"`tabMuster Channel Identity`.`user` = {_escape(user)}"


def mission_has_permission(doc, user=None, ptype=None, debug=False):
    user = user or frappe.session.user
    roles = set(frappe.get_roles(user))
    permission_type = ptype or "read"
    if roles & ADMIN_ROLES:
        return True
    if permission_type == "create":
        requested_by = getattr(doc, "requested_by", None) if doc else None
        return bool(roles & MISSION_CREATOR_ROLES) and requested_by in {None, "", user}
    if "Muster Auditor" in roles:
        return permission_type in {"read", "select", "report", "export", "print"}
    if "Muster Automation Manager" in roles:
        return permission_type in {"read", "select", "write", "report", "export", "print"}
    if doc is None:
        return False
    if permission_type in {"read", "select"}:
        return user in {doc.owner, doc.requested_by, doc.assigned_to}
    if permission_type in {"write", "cancel"}:
        return user in {doc.requested_by, doc.assigned_to} and doc.status not in {
            "Completed",
            "Cancelled",
        }
    return False


def workflow_proposal_has_permission(doc, user=None, ptype=None, debug=False):
    user = user or frappe.session.user
    roles = set(frappe.get_roles(user))
    permission_type = ptype or "read"
    if roles & ADMIN_ROLES:
        return True
    if permission_type == "create":
        return bool(roles & MISSION_CREATOR_ROLES) and (not doc or doc.requested_by in {None, "", user})
    if "Muster Auditor" in roles:
        return permission_type in {"read", "select", "report", "export", "print"}
    if "Muster Automation Manager" in roles:
        return permission_type in {"read", "select", "write", "report", "export", "print"}
    if "Muster Approver" in roles:
        return permission_type in {"read", "select", "write", "report", "export", "print"}
    if not doc:
        return False
    return permission_type in {"read", "select"} and doc.requested_by == user


def ask_turn_has_permission(doc, user=None, ptype=None, debug=False):
    user = user or frappe.session.user
    roles = set(frappe.get_roles(user))
    permission_type = ptype or "read"
    if roles & ADMIN_ROLES:
        return True
    if permission_type == "create":
        return bool(user and user != "Guest") and (not doc or doc.requested_by in {None, "", user})
    if "Muster Auditor" in roles:
        return permission_type in {"read", "select", "report", "export", "print"}
    if not doc:
        return False
    if permission_type in {"read", "select"}:
        return doc.requested_by == user
    return False


def development_proposal_has_permission(doc, user=None, ptype=None, debug=False):
    user = user or frappe.session.user
    roles = set(frappe.get_roles(user))
    permission_type = ptype or "read"
    if roles & ADMIN_ROLES:
        return True
    if permission_type == "create":
        return bool(roles & {"Muster Automation Manager"}) and (not doc or doc.requested_by in {None, "", user})
    if "Muster Auditor" in roles:
        return permission_type in {"read", "select", "report", "export", "print"}
    if not doc:
        return False
    return permission_type in {"read", "select"} and doc.requested_by == user


def approval_has_permission(doc, user=None, ptype=None, debug=False):
    user = user or frappe.session.user
    roles = set(frappe.get_roles(user))
    permission_type = ptype or "read"
    if roles & ADMIN_ROLES:
        return True
    if "Muster Auditor" in roles:
        return permission_type in {"read", "select", "report", "export", "print"}
    if doc is None:
        return False
    if permission_type in {"read", "select"}:
        return user in {doc.requested_from, doc.requested_by}
    if permission_type == "write":
        return user == doc.requested_from and doc.status == "Pending"
    return False


def artifact_has_permission(doc, user=None, ptype=None, debug=False):
    permission_type = ptype or "read"
    if permission_type not in {"read", "select"}:
        return False
    if cint(doc.is_public) and doc.visibility == "Public":
        return True
    mission = frappe.get_cached_doc("Muster Mission", doc.mission)
    return mission_has_permission(mission, user, "read")


def evidence_clip_has_permission(doc, user=None, ptype=None, debug=False):
    user = user or frappe.session.user
    permission_type = ptype or "read"
    roles = set(frappe.get_roles(user))
    if user == "Administrator" or "Muster Administrator" in roles:
        return True
    if "Muster Automation Manager" in roles:
        return permission_type in {"read", "select", "write", "create", "delete", "report", "export", "print"}
    if "Muster Auditor" in roles:
        return permission_type in {"read", "select", "report", "export", "print"}
    if doc is None or permission_type not in {"read", "select"}:
        return False
    mission = frappe.get_cached_doc("Muster Mission", doc.mission)
    return mission_has_permission(mission, user, "read")


def channel_identity_has_permission(doc, user=None, ptype=None, debug=False):
    user = user or frappe.session.user
    permission_type = ptype or "read"
    roles = set(frappe.get_roles(user))
    if roles & ADMIN_ROLES:
        return True
    if "Muster Auditor" in roles:
        return permission_type in {"read", "select", "report", "export"}
    if permission_type == "create":
        return bool(doc) and doc.user == user and doc.status == "Pending"
    if not doc or doc.user != user:
        return False
    if permission_type in {"read", "select"}:
        return True
    if permission_type == "write":
        return doc.status in {"Pending", "Verified"}
    return False
