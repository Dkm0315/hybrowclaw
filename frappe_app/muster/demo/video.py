from __future__ import annotations

from typing import Any
from urllib.parse import quote

import frappe
from frappe import _
from frappe.sessions import clear_sessions
from frappe.utils import cint, getdate
from frappe.utils.password import delete_all_passwords_for, update_password

from muster.demo.plan import stable_id
from muster.demo.video_plan import build_video_plan

VIDEO_PREFIX = "[Muster Video]"
MINIMUM_TEMPORARY_PASSWORD_LENGTH = 16
VIDEO_TRANSACTION_DATE = "2026-07-01"
VIDEO_REQUESTED_AT = "2026-07-01 09:00:00"

ROUTE_PREFIXES = {
    "Muster Mission": "/app/muster-mission/",
    "Muster Approval": "/app/muster-approval/",
    "Customer": "/app/customer/",
    "Supplier": "/app/supplier/",
    "Sales Order": "/app/sales-order/",
    "Purchase Order": "/app/purchase-order/",
    "Employee": "/app/employee/",
    "CRM Organization": "/crm/organizations/",
    "CRM Lead": "/crm/leads/",
    "CRM Deal": "/crm/deals/",
}


def _require_administrator(confirm: bool | int | str) -> None:
    if frappe.session.user != "Administrator":
        frappe.throw(
            _("Only Administrator may manage video evidence accounts"),
            frappe.PermissionError,
        )
    if not cint(confirm):
        frappe.throw(_("Explicit confirmation is required"), frappe.ValidationError)


def _require_apps(required_apps: list[str]) -> None:
    installed = set(frappe.get_installed_apps())
    missing = sorted(set(required_apps) - installed)
    if missing:
        frappe.throw(
            _("Install the required apps before seeding video evidence: {0}").format(
                ", ".join(missing)
            ),
            frappe.ValidationError,
        )


def _existing(doctype: str, filters: dict[str, Any]) -> str | None:
    return frappe.db.get_value(doctype, filters, "name")


def _ensure_doc(doctype: str, filters: dict[str, Any], values: dict[str, Any]) -> tuple[Any, bool]:
    if name := _existing(doctype, filters):
        return frappe.get_doc(doctype, name), False
    return frappe.get_doc({"doctype": doctype, **values}).insert(), True


def _first(doctype: str, filters: dict[str, Any] | None = None) -> str | None:
    if not frappe.db.table_exists(doctype):
        return None
    return frappe.db.get_value(doctype, filters or {}, "name")


def _ensure_price_list(name: str, currency: str, *, buying: int = 0, selling: int = 0):
    if frappe.db.exists("Price List", name):
        return frappe.get_doc("Price List", name)
    doc = frappe.get_doc(
        {
            "doctype": "Price List",
            "price_list_name": name,
            "currency": currency,
            "buying": buying,
            "selling": selling,
            "enabled": 1,
        }
    )
    try:
        return doc.insert()
    except Exception as exc:
        # ERPNext v16's Price List hook uses MariaDB's NOW() even on SQLite.
        # The new record is already inserted before that no-op Item Price update runs.
        if (
            frappe.db.db_type == "sqlite"
            and "no such function: NOW" in str(exc)
            and frappe.db.exists("Price List", name)
        ):
            frappe.clear_cache(doctype="Price List")
            return frappe.get_doc("Price List", name)
        raise


def _ensure_personas(plan: dict[str, Any]) -> dict[str, str]:
    users: dict[str, str] = {}
    for persona in plan["personas"]:
        missing_roles = [role for role in persona["roles"] if not frappe.db.exists("Role", role)]
        if missing_roles:
            frappe.throw(
                _("Persona {0} requires missing roles: {1}").format(
                    persona["name"], ", ".join(missing_roles)
                ),
                frappe.ValidationError,
            )
        first_name, *remaining_names = persona["name"].split(" ")
        user, _created = _ensure_doc(
            "User",
            {"name": persona["user"]},
            {
                "email": persona["user"],
                "first_name": first_name,
                "last_name": " ".join(remaining_names),
                "enabled": 0,
                "send_welcome_email": 0,
                "user_type": "System User",
                "bio": f"{VIDEO_PREFIX} {persona['title']}",
                "roles": [{"role": role} for role in persona["roles"]],
            },
        )
        user.enabled = 0
        user.api_key = None
        user.send_welcome_email = 0
        user.set("roles", [{"role": role} for role in persona["roles"]])
        user.save()
        delete_all_passwords_for("User", user.name)
        clear_sessions(user=user.name, keep_current=False, force=True)
        users[persona["key"]] = user.name
    return users


def _ensure_master_records(site: str, users: dict[str, str]) -> dict[str, Any]:
    records: dict[str, Any] = {}
    company = frappe.defaults.get_global_default("company") or _first("Company")
    customer_group = _first("Customer Group", {"is_group": 0})
    territory = _first("Territory", {"is_group": 0})
    supplier_group = _first("Supplier Group", {"is_group": 0})
    item_group = _first("Item Group", {"is_group": 0})
    stock_uom = _first("UOM")
    gender = _first("Gender")
    company_currency = frappe.db.get_value("Company", company, "default_currency") if company else None
    if not all(
        (
            company,
            customer_group,
            territory,
            supplier_group,
            item_group,
            stock_uom,
            gender,
            company_currency,
        )
    ):
        frappe.throw(
            _("ERPNext/HRMS setup masters are incomplete for the video scenario"),
            frappe.ValidationError,
        )
    selling_price_list = _ensure_price_list(
        f"{VIDEO_PREFIX} Selling", company_currency, selling=1
    )
    buying_price_list = _ensure_price_list(
        f"{VIDEO_PREFIX} Buying", company_currency, buying=1
    )
    records["company"] = frappe.get_doc("Company", company)

    for region in ("east", "west"):
        customer_name = f"{VIDEO_PREFIX} {region.title()} Retail Cooperative"
        records[f"customer_{region}"], _created = _ensure_doc(
            "Customer",
            {"customer_name": customer_name},
            {
                "customer_name": customer_name,
                "customer_type": "Company",
                "customer_group": customer_group,
                "territory": territory,
                "disabled": 0,
            },
        )
        supplier_name = f"{VIDEO_PREFIX} {region.title()} Components Partner"
        records[f"supplier_{region}"], _created = _ensure_doc(
            "Supplier",
            {"supplier_name": supplier_name},
            {
                "supplier_name": supplier_name,
                "supplier_type": "Company",
                "supplier_group": supplier_group,
                "disabled": 0,
            },
        )

    delete_customer_name = f"{VIDEO_PREFIX} Disposable Delete Review Target"
    records["customer_delete_target"], _created = _ensure_doc(
        "Customer",
        {"customer_name": delete_customer_name},
        {
            "customer_name": delete_customer_name,
            "customer_type": "Company",
            "customer_group": customer_group,
            "territory": territory,
            "disabled": 0,
        },
    )

    parent_department = _first("Department", {"is_group": 1, "company": company})
    for region in ("east", "west"):
        department_name = f"{VIDEO_PREFIX} {region.title()} Operations"
        records[f"department_{region}"], _created = _ensure_doc(
            "Department",
            {"department_name": department_name, "company": company},
            {
                "department_name": department_name,
                "company": company,
                "parent_department": parent_department,
                "is_group": 0,
            },
        )
        employee_last_name = f"{region.title()} Field Coordinator"
        records[f"employee_{region}"], _created = _ensure_doc(
            "Employee",
            {
                "first_name": "Muster Video",
                "last_name": employee_last_name,
            },
            {
                "first_name": "Muster Video",
                "last_name": employee_last_name,
                "gender": gender,
                "date_of_birth": "1990-01-15",
                "date_of_joining": "2024-01-15",
                "company": company,
                "department": records[f"department_{region}"].name,
                "status": "Active",
            },
        )

    item_code = "MUSTER-VIDEO-SERVICE-KIT"
    records["item"], _created = _ensure_doc(
        "Item",
        {"item_code": item_code},
        {
            "item_code": item_code,
            "item_name": f"{VIDEO_PREFIX} Field Service Kit",
            "item_group": item_group,
            "stock_uom": stock_uom,
            "is_stock_item": 0,
            "include_item_in_manufacturing": 0,
        },
    )

    sales_marker = f"{VIDEO_PREFIX} East sales submission proof"
    records["sales_order_east"], _created = _ensure_doc(
        "Sales Order",
        {"customer": records["customer_east"].name, "company": company},
        {
            "customer": records["customer_east"].name,
            "company": company,
            "transaction_date": getdate(VIDEO_TRANSACTION_DATE),
            "delivery_date": "2026-07-15",
            "currency": company_currency,
            "conversion_rate": 1,
            "selling_price_list": selling_price_list.name,
            "price_list_currency": company_currency,
            "plc_conversion_rate": 1,
            "remarks": sales_marker,
            "items": [
                {
                    "item_code": records["item"].name,
                    "qty": 12,
                    "rate": 1250,
                    "delivery_date": "2026-07-15",
                }
            ],
        },
    )
    purchase_marker = f"{VIDEO_PREFIX} East purchase submission proof"
    records["purchase_order_east"], _created = _ensure_doc(
        "Purchase Order",
        {"supplier": records["supplier_east"].name, "company": company},
        {
            "supplier": records["supplier_east"].name,
            "company": company,
            "transaction_date": getdate(VIDEO_TRANSACTION_DATE),
            "schedule_date": "2026-07-11",
            "currency": company_currency,
            "conversion_rate": 1,
            "buying_price_list": buying_price_list.name,
            "price_list_currency": company_currency,
            "plc_conversion_rate": 1,
            "remarks": purchase_marker,
            "items": [
                {
                    "item_code": records["item"].name,
                    "qty": 20,
                    "rate": 800,
                    "schedule_date": "2026-07-11",
                }
            ],
        },
    )

    lead_status = (
        frappe.db.get_value("CRM Lead Status", "New", "name")
        or _first("CRM Lead Status", {"type": "Open"})
        or _first("CRM Lead Status", {"type": "Ongoing"})
    )
    deal_status = (
        frappe.db.get_value("CRM Deal Status", "Qualification", "name")
        or _first("CRM Deal Status", {"name": ["not in", ["Lost", "Won"]]})
    )
    if not lead_status or not deal_status:
        frappe.throw(_("CRM status masters are incomplete"), frappe.ValidationError)
    for region, owner in (
        ("east", users["crm_operator"]),
        ("west", users["sales_approver"]),
    ):
        organization_name = f"{VIDEO_PREFIX} {region.title()} Growth Account"
        records[f"crm_organization_{region}"], _created = _ensure_doc(
            "CRM Organization",
            {"organization_name": organization_name},
            {
                "organization_name": organization_name,
                "website": f"https://{region}.muster-video.example",
                "no_of_employees": "51-200",
            },
        )
        lead_email = f"video.{region}.{stable_id(site, 'video', 'lead', region)[:8]}@example.com"
        records[f"crm_lead_{region}"], _created = _ensure_doc(
            "CRM Lead",
            {"email": lead_email},
            {
                "first_name": region.title(),
                "last_name": "Growth Contact",
                "email": lead_email,
                "status": lead_status,
                "organization": organization_name,
            },
        )
        # A prior attended-browser recording may have deliberately edited this
        # disposable record. Re-seeding must restore the exact scenario rather
        # than preserve demo drift from an earlier take.
        frappe.db.set_value(
            "CRM Lead",
            records[f"crm_lead_{region}"].name,
            {
                "first_name": region.title(),
                "last_name": "Growth Contact",
                "lead_name": f"{region.title()} Growth Contact",
                "status": lead_status,
                "organization": organization_name,
                "lead_owner": owner,
            },
        )
        records[f"crm_lead_{region}"].reload()
        deal_marker = f"{VIDEO_PREFIX} {region.title()} discovery review"
        records[f"crm_deal_{region}"], _created = _ensure_doc(
            "CRM Deal",
            {"next_step": deal_marker},
            {
                "organization": records[f"crm_organization_{region}"].name,
                "status": deal_status,
                "next_step": deal_marker,
                "deal_value": 250000 if region == "east" else 400000,
                "probability": 60 if region == "east" else 35,
                "expected_closure_date": "2026-07-31",
            },
        )
        frappe.db.set_value("CRM Deal", records[f"crm_deal_{region}"].name, "deal_owner", owner)
        records[f"crm_deal_{region}"].reload()
    return records


def _ensure_muster_records(site: str, users: dict[str, str], records: dict[str, Any]) -> None:
    for key, requester, status in (
        ("mission_sales", "sales_operator", "Waiting for Approval"),
        ("mission_crm", "crm_operator", "Running"),
    ):
        idempotency_key = stable_id(site, "frappeverse-video", key, 0)
        records[key], _created = _ensure_doc(
            "Muster Mission",
            {"idempotency_key": idempotency_key},
            {
                "objective": f"{VIDEO_PREFIX} Governed {key.replace('_', ' ')} proof",
                "status": status,
                "progress": 55 if status == "Waiting for Approval" else 35,
                "requested_by": users[requester],
                "assigned_to": users[requester],
                "requested_at": VIDEO_REQUESTED_AT,
                "scope_json": frappe.as_json(
                    {"site": site, "scenario": "frappeverse-video", "demo": True}
                ),
                "idempotency_key": idempotency_key,
            },
        )

    from muster.demo.seed import _ensure_change_and_approval

    _ensure_change_and_approval(
        site,
        "frappeverse-video",
        records["mission_sales"],
        0,
        users["sales_operator"],
        users["sales_approver"],
    )
    approval_name = frappe.db.get_value(
        "Muster Approval", {"mission": records["mission_sales"].name}, "name"
    )
    records["approval_sales"] = frappe.get_doc("Muster Approval", approval_name)


def _replace_user_permissions(
    plan: dict[str, Any], users: dict[str, str], records: dict[str, Any]
) -> dict[str, list[dict[str, str]]]:
    resolved: dict[str, list[dict[str, str]]] = {}
    for persona in plan["personas"]:
        user = users[persona["key"]]
        for name in frappe.get_all("User Permission", filters={"user": user}, pluck="name"):
            frappe.delete_doc("User Permission", name)
        resolved[persona["key"]] = []
        for permission in persona["permissions"]:
            for_value = records[permission["record"]].name
            frappe.get_doc(
                {
                    "doctype": "User Permission",
                    "user": user,
                    "allow": permission["allow"],
                    "for_value": for_value,
                    "apply_to_all_doctypes": 1,
                }
            ).insert()
            resolved[persona["key"]].append({"allow": permission["allow"], "for_value": for_value})
        # Seeding is deliberately idempotent and may follow a revoke in the same
        # process. Evict role and user-permission caches only after the complete
        # replacement, otherwise permission checks can observe the revoked state.
        frappe.clear_cache(user=user)
    return resolved


def _route(doctype: str, name: str) -> str:
    return ROUTE_PREFIXES.get(doctype, f"/app/{frappe.scrub(doctype).replace('_', '-')}/") + quote(
        name, safe=""
    )


def _manifest(
    plan: dict[str, Any],
    users: dict[str, str],
    records: dict[str, Any],
    permissions: dict[str, list[dict[str, str]]],
) -> dict[str, Any]:
    record_manifest = {
        alias: {
            "doctype": doc.doctype,
            "name": doc.name,
            "title": doc.get("title")
            or doc.get("customer_name")
            or doc.get("supplier_name")
            or doc.get("lead_name")
            or doc.get("employee_name")
            or doc.name,
            "route": _route(doc.doctype, doc.name),
        }
        for alias, doc in records.items()
    }
    cases: list[dict[str, Any]] = []
    for case in plan["cases"]:
        resolved_case = dict(case)
        if alias := case.get("record"):
            resolved_case.update(record_manifest[alias])
        else:
            resolved_case["route"] = (
                ROUTE_PREFIXES.get(case["doctype"])
                or f"/app/{frappe.scrub(case['doctype']).replace('_', '-')}"
            )
        if case["expected"] == "hidden":
            resolved_case["expected_list_membership"] = False
            resolved_case["expected_ui"] = "record absent from filtered list"
        elif case["action"] == "direct_url" and case["expected"] == "deny":
            resolved_case["expected_http_status"] = 403
            resolved_case["expected_ui"] = "permission denied"
        elif case["expected"] == "allow":
            resolved_case["expected_http_status"] = 200
            resolved_case["expected_ui"] = "action available"
        else:
            resolved_case["expected_ui"] = "action unavailable"
        cases.append(resolved_case)

    personas = []
    for persona in plan["personas"]:
        persona_cases = [case for case in cases if case["persona"] == persona["key"]]
        visible = sorted(
            {
                case["name"]
                for case in persona_cases
                if case["expected"] == "allow" and case.get("name")
            }
        )
        hidden = sorted(
            {
                case["name"]
                for case in persona_cases
                if case["expected"] in {"deny", "hidden"} and case.get("name")
            }
        )
        visible_routes = sorted(
            {
                case["route"]
                for case in persona_cases
                if case["expected"] == "allow" and case.get("name")
            }
        )
        hidden_routes = sorted(
            {
                case["route"]
                for case in persona_cases
                if case["expected"] in {"deny", "hidden"} and case.get("name")
            }
        )
        personas.append(
            {
                **persona,
                "user": users[persona["key"]],
                "enabled": bool(frappe.db.get_value("User", users[persona["key"]], "enabled")),
                "user_permissions": permissions[persona["key"]],
                "expected_visible_record_names": visible,
                "expected_hidden_record_names": hidden,
                "expected_visible_routes": visible_routes,
                "expected_hidden_routes": hidden_routes,
                "routes": [case["route"] for case in persona_cases],
            }
        )
    return {
        **{key: plan[key] for key in ("schema_version", "scenario", "title", "site")},
        "credential_policy": {
            "stored_in_fixture": False,
            "accounts_enabled_by_seed": False,
            "rotation_required": True,
            "minimum_length": MINIMUM_TEMPORARY_PASSWORD_LENGTH,
        },
        "personas": personas,
        "records": record_manifest,
        "cases": cases,
    }


@frappe.whitelist(methods=["POST"])
def seed_video_evidence(*, confirm: bool | int | str = False) -> dict[str, Any]:
    """Create recording data and disabled, passwordless personas."""
    _require_administrator(confirm)
    site = frappe.local.site
    plan = build_video_plan(site)
    _require_apps(plan["required_apps"])
    users = _ensure_personas(plan)
    records = _ensure_master_records(site, users)
    _ensure_muster_records(site, users, records)
    permissions = _replace_user_permissions(plan, users, records)
    return _manifest(plan, users, records, permissions)


@frappe.whitelist(methods=["POST"])
def rotate_video_passwords(
    temporary_password: str, *, confirm: bool | int | str = False
) -> dict[str, Any]:
    """Enable personas with one runtime-only temporary secret; never return the secret."""
    _require_administrator(confirm)
    if not isinstance(temporary_password, str) or len(temporary_password) < 16:
        frappe.throw(
            _("Temporary password must contain at least {0} characters").format(
                MINIMUM_TEMPORARY_PASSWORD_LENGTH
            ),
            frappe.ValidationError,
        )
    plan = build_video_plan(frappe.local.site)
    users = [persona["user"] for persona in plan["personas"]]
    missing = [user for user in users if not frappe.db.exists("User", user)]
    if missing:
        frappe.throw(
            _("Seed the video evidence scenario before rotating credentials"),
            frappe.ValidationError,
        )
    personas_by_user = {persona["user"]: persona for persona in plan["personas"]}
    for user in users:
        actual_roles = {row.role for row in frappe.get_doc("User", user).roles}
        if actual_roles != set(personas_by_user[user]["roles"]):
            frappe.throw(
                _("Reseed the video scenario before enabling revoked persona {0}").format(user),
                frappe.ValidationError,
            )
    for user in users:
        update_password(user, temporary_password, logout_all_sessions=True)
        frappe.db.set_value("User", user, "enabled", 1)
        frappe.clear_cache(user=user)
    return {"rotated": len(users), "enabled": len(users), "users": users}


@frappe.whitelist(methods=["POST"])
def revoke_video_access(*, confirm: bool | int | str = False) -> dict[str, Any]:
    """Immediately disable personas, remove login/API secrets, and terminate sessions."""
    _require_administrator(confirm)
    plan = build_video_plan(frappe.local.site)
    users = [persona["user"] for persona in plan["personas"]]
    existing_users = [user for user in users if frappe.db.exists("User", user)]
    revoked = 0
    removed_permissions = 0
    removed_roles = 0
    # Revoke authentication first for every persona; role/permission cleanup follows.
    for user in existing_users:
        frappe.db.set_value("User", user, {"enabled": 0, "api_key": None})
        delete_all_passwords_for("User", user)
        frappe.clear_cache(user=user)
    for user in existing_users:
        clear_sessions(user=user, keep_current=False, force=True)
    for user in existing_users:
        user_doc = frappe.get_doc("User", user)
        removed_roles += len(user_doc.roles)
        user_doc.set("roles", [])
        user_doc.save()
        permissions = frappe.get_all("User Permission", filters={"user": user}, pluck="name")
        for permission in permissions:
            frappe.delete_doc("User Permission", permission)
        removed_permissions += len(permissions)
        revoked += 1
    return {
        "revoked": revoked,
        "disabled": revoked,
        "removed_roles": removed_roles,
        "removed_user_permissions": removed_permissions,
        "users": users,
    }
