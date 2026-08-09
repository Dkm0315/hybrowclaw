from __future__ import annotations

import frappe

HUMAN_ROLES = (
    "Muster Administrator",
    "Muster Automation Manager",
    "Muster Operator",
    "Muster Approver",
    "Muster Auditor",
    "Muster Viewer",
)
SERVICE_ROLE = "Muster Service User"


def _ensure_roles() -> None:
    for role_name in (*HUMAN_ROLES, SERVICE_ROLE):
        if frappe.db.exists("Role", role_name):
            continue
        role = frappe.new_doc("Role")
        role.role_name = role_name
        role.desk_access = 1
        role.is_custom = 0
        role.insert(ignore_permissions=True)


def _ensure_security_indexes() -> None:
    """Create constraints separately so existing SQLite sites can migrate safely."""
    if frappe.db.table_exists("Muster Channel Identity") and frappe.db.has_column(
        "Muster Channel Identity", "idempotency_fingerprint"
    ):
        frappe.db.add_unique(
            "Muster Channel Identity",
            ["idempotency_fingerprint"],
            constraint_name="unique_muster_channel_issue_idempotency",
        )
    if frappe.db.table_exists("Muster Workflow Version") and frappe.db.has_column(
        "Muster Workflow Version", "idempotency_key"
    ):
        frappe.db.add_unique(
            "Muster Workflow Version",
            ["idempotency_key"],
            constraint_name="unique_muster_workflow_publication_idempotency",
        )


def after_install() -> None:
    _ensure_roles()
    _ensure_security_indexes()


def after_migrate() -> None:
    _ensure_roles()
    _ensure_security_indexes()
