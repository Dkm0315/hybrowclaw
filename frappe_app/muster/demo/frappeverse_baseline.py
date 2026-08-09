from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from typing import Any

import frappe
from frappe import _


SCENARIO = "frappeverse-clean-v1"
COMPANY = "Muster Frappeverse Demo"
CUSTOMER_GROUP = "Frappeverse Customers"
SUPPLIER_GROUP = "Frappeverse Suppliers"
ITEM_GROUP = "Frappeverse Items"
TERRITORY = "Frappeverse Territory"
DEMO_CHECKER = "demo.checker@frappeverse.invalid"
USERS = {
    "demo.owner@frappeverse.invalid": ("Demo", "Owner", ("System Manager", "Muster Administrator")),
    DEMO_CHECKER: ("Morgan", "Checker", ("Muster Approver", "Muster Automation Manager")),
    "demo.sales@frappeverse.invalid": ("Sam", "Sales", ("Sales User", "CRM User", "Muster Operator")),
    "demo.hr@frappeverse.invalid": ("Harper", "HR", ("HR User", "Employee", "Muster Operator")),
    "demo.support@frappeverse.invalid": ("Casey", "Support", ("Support Team", "Agent", "Muster Operator")),
    "demo.finance@frappeverse.invalid": ("Finley", "Finance", ("Accounts User", "Muster Operator")),
    "demo.auditor@frappeverse.invalid": ("Avery", "Audit", ("Auditor", "Muster Auditor", "Muster Viewer")),
}
EMPLOYEE_USERS = (
    "demo.sales@frappeverse.invalid", "demo.hr@frappeverse.invalid",
    "demo.support@frappeverse.invalid", "demo.finance@frappeverse.invalid",
    "demo.auditor@frappeverse.invalid",
)
ATTENDED_BROWSER_CAPABILITIES = (
    "frappe.browser.navigate", "frappe.browser.click", "frappe.browser.fill",
    "frappe.browser.select", "frappe.browser.read_visible",
)
CHECKER_CAPABILITIES = (
    "approval.read", "approval.decide", "mission.read", "artifact.read",
    "frappe.browser.navigate", "frappe.browser.click", "frappe.browser.read_visible",
)
DEMO_CAPABILITIES = {
    # Administrator is included explicitly for the presenter session.  This is
    # still a normal persisted binding, not an implicit Administrator bypass.
    "Administrator": (
        "frappe.record.create", "frappe.record.update", "frappe.record.delete",
        *ATTENDED_BROWSER_CAPABILITIES,
        "configuration.read", "policy.manage", "agent.manage", "workflow.manage",
        "mission.manage", "mission.create", "mission.control", "mission.read",
        "approval.read", "approval.decide", "audit.read", "evidence.export",
        "artifact.read",
    ),
    "demo.owner@frappeverse.invalid": (
        "frappe.record.create", "frappe.record.update", "frappe.record.delete",
        *ATTENDED_BROWSER_CAPABILITIES,
        "configuration.read", "policy.manage", "agent.manage", "workflow.manage",
        "mission.manage", "mission.create", "mission.control", "mission.read",
        "approval.read", "approval.decide", "audit.read", "evidence.export",
        "artifact.read",
    ),
    DEMO_CHECKER: CHECKER_CAPABILITIES,
    "demo.sales@frappeverse.invalid": (
        "frappe.record.create", "frappe.record.update", *ATTENDED_BROWSER_CAPABILITIES,
        "mission.create", "mission.control", "mission.read", "artifact.read",
    ),
    "demo.hr@frappeverse.invalid": (
        "frappe.record.create", "frappe.record.update", *ATTENDED_BROWSER_CAPABILITIES,
        "mission.create", "mission.control", "mission.read", "artifact.read",
    ),
    "demo.support@frappeverse.invalid": (
        "frappe.record.create", "frappe.record.update", *ATTENDED_BROWSER_CAPABILITIES,
        "mission.create", "mission.control", "mission.read", "artifact.read",
    ),
    "demo.finance@frappeverse.invalid": (
        "frappe.record.create", "frappe.record.update", *ATTENDED_BROWSER_CAPABILITIES,
        "mission.create", "mission.control", "mission.read", "artifact.read",
    ),
    "demo.auditor@frappeverse.invalid": (
        "mission.read", "artifact.read", "audit.read", "evidence.export",
        "frappe.browser.navigate", "frappe.browser.read_visible",
    ),
}
OUTCOME_DOCTYPES = (
    "Muster Mission", "Muster Run", "Muster Work Unit", "Muster Activity",
    "Muster Approval", "Muster Artifact", "Muster Ask Turn", "Muster Evidence Clip",
    "Muster Workflow Proposal", "Muster Development Proposal", "Muster Change Set",
)


def _require_clean_site() -> None:
    if frappe.session.user != "Administrator":
        frappe.throw(_("Only Administrator may seed the Frappeverse baseline"), frappe.PermissionError)
    installed = set(frappe.get_installed_apps())
    required = {"muster", "erpnext", "hrms", "crm", "helpdesk"}
    missing = sorted(required - installed)
    if missing:
        frappe.throw(_("Required demo apps are missing: {0}").format(", ".join(missing)))


def _ensure_erpnext_setup_fixtures() -> None:
    """Converge setup-wizard masters needed by ordinary ERPNext document hooks.

    Installing ERPNext as an app does not run the ERPNext setup wizard. In v16,
    inserting the first Company immediately creates a Goods In Transit warehouse
    linked to the standard ``Transit`` Warehouse Type, so a clean Bench site must
    install the supported ERPNext fixture set before Company creation.
    """
    required = (
        ("Gender", "Male", {"gender": "Male"}),
        ("Warehouse Type", "Transit", {"name": "Transit"}),
        (
            "Customer Group",
            "All Customer Groups",
            {"customer_group_name": "All Customer Groups", "is_group": 1, "parent_customer_group": ""},
        ),
        (
            "Supplier Group",
            "All Supplier Groups",
            {"supplier_group_name": "All Supplier Groups", "is_group": 1, "parent_supplier_group": ""},
        ),
        (
            "Item Group",
            "All Item Groups",
            {"item_group_name": "All Item Groups", "is_group": 1, "parent_item_group": ""},
        ),
        (
            "Territory",
            "All Territories",
            {"territory_name": "All Territories", "is_group": 1, "parent_territory": ""},
        ),
        (
            "Customer Group",
            CUSTOMER_GROUP,
            {"customer_group_name": CUSTOMER_GROUP, "is_group": 0, "parent_customer_group": "All Customer Groups"},
        ),
        (
            "Supplier Group",
            SUPPLIER_GROUP,
            {"supplier_group_name": SUPPLIER_GROUP, "is_group": 0, "parent_supplier_group": "All Supplier Groups"},
        ),
        (
            "Item Group",
            ITEM_GROUP,
            {"item_group_name": ITEM_GROUP, "is_group": 0, "parent_item_group": "All Item Groups"},
        ),
        (
            "Territory",
            TERRITORY,
            {"territory_name": TERRITORY, "is_group": 0, "parent_territory": "All Territories"},
        ),
        (
            "Party Type",
            "Supplier",
            {"party_type": "Supplier", "account_type": "Payable"},
        ),
        ("UOM", "Nos", {"uom_name": "Nos", "must_be_whole_number": 1}),
    )
    for doctype, name, values in required:
        if frappe.db.exists(doctype, name):
            continue
        frappe.get_doc({"doctype": doctype, **values}).insert(
            ignore_permissions=True,
            ignore_if_duplicate=True,
        )
    missing = [
        f"{doctype}: {name}"
        for doctype, name, _values in required
        if not frappe.db.exists(doctype, name)
    ]
    if missing:
        raise frappe.ValidationError(
            _("ERPNext setup fixtures are incomplete: {0}").format(", ".join(missing))
        )


def _outcome_counts() -> dict[str, int]:
    return {doctype: frappe.db.count(doctype) for doctype in OUTCOME_DOCTYPES if frappe.db.exists("DocType", doctype)}


def _secret_passwords(path: str | None) -> dict[str, str]:
    if not path:
        return {}
    secret_path = Path(path).expanduser().resolve()
    mode = secret_path.stat().st_mode & 0o777
    if mode & 0o077:
        raise frappe.ValidationError("The demo password file must be owner-readable only (chmod 600)")
    values = json.loads(secret_path.read_text(encoding="utf-8"))
    if not isinstance(values, dict) or set(values) - set(USERS):
        raise frappe.ValidationError("The demo password file contains unknown users")
    for user, password in values.items():
        if not isinstance(password, str) or len(password) < 16 or password.lower() == user.lower():
            raise frappe.ValidationError("Every demo password must be at least 16 characters")
    return values


def _ensure_user(email: str, first_name: str, last_name: str, requested_roles: tuple[str, ...]) -> tuple[str, list[str]]:
    existing_roles = [role for role in requested_roles if frappe.db.exists("Role", role)]
    if not frappe.db.exists("User", email):
        frappe.get_doc({
            "doctype": "User", "email": email, "first_name": first_name,
            "last_name": last_name, "enabled": 1, "send_welcome_email": 0,
            "roles": [{"role": role} for role in existing_roles],
        }).insert(ignore_permissions=True)
        state = "created"
    else:
        user = frappe.get_doc("User", email)
        for role in existing_roles:
            if role not in {row.role for row in user.roles}:
                user.append("roles", {"role": role})
        user.enabled = 1
        user.save(ignore_permissions=True)
        state = "existing"
    return state, existing_roles


def _ensure_muster_role_binding(user: str, capabilities: tuple[str, ...]) -> tuple[str, str]:
    """Converge explicit site-scoped Muster authority for one demo identity.

    A binding never grants Frappe access.  Runtime admission still requires the
    same live user's DocType, field, record and workflow permissions, so this is
    the Muster half of the RBAC intersection rather than a permission bypass.
    """
    filters = {
        "subject_type": "User", "subject": user,
        "scope_type": "Site", "scope_value": frappe.local.site,
    }
    encoded = "\n".join(sorted(set(capabilities)))
    if name := frappe.db.exists("Muster Role Binding", filters):
        binding = frappe.get_doc("Muster Role Binding", name)
        changed = binding.status != "Active" or binding.capabilities != encoded
        if changed:
            binding.status = "Active"
            binding.capabilities = encoded
            binding.save(ignore_permissions=True)
        return str(name), "updated" if changed else "existing"
    binding = frappe.get_doc({
        "doctype": "Muster Role Binding", **filters,
        "status": "Active", "capabilities": encoded,
    }).insert(ignore_permissions=True)
    return binding.name, "created"


def _ensure(doctype: str, filters: dict[str, Any], values: dict[str, Any]) -> str:
    existing = frappe.db.exists(doctype, filters)
    if existing:
        return str(existing)
    doc = frappe.get_doc({"doctype": doctype, **values})
    doc.insert(ignore_permissions=True)
    return doc.name


def _converge_desk_setup_state() -> None:
    """Finish the supported setup state after users and Company exist.

    ``Installed Applications.update_versions`` is the Frappe v16 source of truth
    for deciding whether the Frappe and ERPNext setup wizards are complete.  A
    programmatically seeded site otherwise keeps the installer-era
    ``desktop:home_page=setup-wizard`` default in cache and can route a valid
    Administrator session to ``/undefined``.
    """
    installed_applications = frappe.get_single("Installed Applications")
    installed_applications.update_versions()
    setup_rows = frappe.get_all(
        "Installed Application",
        filters={"app_name": ("in", ("frappe", "erpnext"))},
        fields=["app_name", "is_setup_complete"],
    )
    setup_state = {row.app_name: bool(row.is_setup_complete) for row in setup_rows}
    incomplete = [app for app in ("frappe", "erpnext") if not setup_state.get(app)]
    if incomplete:
        raise frappe.ValidationError(
            _("Frappe setup state is incomplete for: {0}").format(", ".join(incomplete))
        )

    frappe.db.set_default("desktop:home_page", "workspace")
    frappe.db.set_single_value("System Settings", "setup_complete", 1)
    frappe.clear_cache()


def seed(password_file: str | None = None, confirm: bool | int | str = False) -> dict[str, Any]:
    """Converge a clean Frappeverse business baseline without AI outcomes."""
    if str(confirm).lower() not in {"1", "true", "yes"}:
        frappe.throw(_("Pass confirm=true to seed the isolated demo site"), frappe.ValidationError)
    _require_clean_site()
    _ensure_erpnext_setup_fixtures()
    before = _outcome_counts()
    passwords = _secret_passwords(password_file)

    user_result = {}
    for email, (first_name, last_name, roles) in USERS.items():
        state, assigned = _ensure_user(email, first_name, last_name, roles)
        user_result[email] = {"state": state, "roles": assigned}
    binding_result = {}
    for email, capabilities in DEMO_CAPABILITIES.items():
        name, state = _ensure_muster_role_binding(email, capabilities)
        binding_result[email] = {
            "name": name, "state": state, "capability_count": len(set(capabilities)),
        }
    if passwords:
        from frappe.utils.password import update_password
        for email, password in passwords.items():
            update_password(email, password)

    company = _ensure("Company", {"company_name": COMPANY}, {
        "company_name": COMPANY, "abbr": "MFD", "default_currency": "USD", "country": "United States",
    })
    _converge_desk_setup_state()
    fiscal_year = _ensure("Fiscal Year", {"year": "2026"}, {
        "year": "2026", "year_start_date": date(2026, 1, 1),
        "year_end_date": date(2026, 12, 31), "companies": [{"company": company}],
    })
    fiscal_year_doc = frappe.get_doc("Fiscal Year", fiscal_year)
    if company not in {row.company for row in fiscal_year_doc.companies}:
        fiscal_year_doc.append("companies", {"company": company})
        fiscal_year_doc.save(ignore_permissions=True)
    customers = [
        _ensure("Customer", {"customer_name": f"Frappeverse Customer {index:03d}"}, {
            "customer_name": f"Frappeverse Customer {index:03d}", "customer_type": "Company",
            "customer_group": CUSTOMER_GROUP, "territory": TERRITORY,
        }) for index in range(1, 25)
    ]
    suppliers = [
        _ensure("Supplier", {"supplier_name": f"Frappeverse Supplier {index:03d}"}, {
            "supplier_name": f"Frappeverse Supplier {index:03d}", "supplier_group": SUPPLIER_GROUP,
        }) for index in range(1, 9)
    ]
    items = [
        _ensure("Item", {"item_code": f"MFD-ITEM-{index:03d}"}, {
            "item_code": f"MFD-ITEM-{index:03d}", "item_name": f"Frappeverse Item {index:03d}",
            "item_group": ITEM_GROUP, "stock_uom": "Nos", "is_stock_item": 1,
        }) for index in range(1, 41)
    ]
    leads = [
        _ensure("Lead", {"email_id": f"lead-{index:03d}@frappeverse.invalid"}, {
            "lead_name": f"Frappeverse Lead {index:03d}", "company_name": f"Prospect Company {index:03d}",
            "email_id": f"lead-{index:03d}@frappeverse.invalid", "status": "Lead",
        }) for index in range(1, 13)
    ]

    gender = frappe.db.get_value("Gender", {}, "name")
    if not gender:
        raise frappe.ValidationError("ERPNext Gender master is missing")
    employees = []
    for index, email in enumerate(EMPLOYEE_USERS, start=1):
        employees.append(_ensure("Employee", {"user_id": email, "company": company}, {
            "first_name": USERS[email][0], "last_name": USERS[email][1], "user_id": email,
            "company": company, "gender": gender, "date_of_birth": date(1990, 1, index),
            "date_of_joining": date(2025, 1, index), "status": "Active",
        }))

    after = _outcome_counts()
    if after != before:
        frappe.db.rollback()
        raise frappe.ValidationError("Baseline seeding attempted to create a Muster outcome")
    frappe.db.commit()
    return {
        "schema_version": 1, "scenario": SCENARIO, "site": frappe.local.site,
        "company": company, "users": user_result,
        "muster_role_bindings": binding_result,
        "counts": {"customers": len(customers), "suppliers": len(suppliers), "items": len(items), "leads": len(leads), "employees": len(employees)},
        "muster_outcomes_before": before, "muster_outcomes_after": after,
        "passwords_applied": sorted(passwords),
    }
