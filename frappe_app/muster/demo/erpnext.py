from __future__ import annotations

from collections.abc import Callable
from typing import Any

import frappe
from frappe.utils import add_days

from muster.demo.plan import BusinessScaleProfile, short_id

LOOKUP_CHUNK_SIZE = 400


def _first(doctype: str, filters: dict[str, Any] | None = None) -> str | None:
    if not frappe.db.table_exists(doctype):
        return None
    return frappe.db.get_value(doctype, filters or {}, "name")


def _supported_values(doctype: str, values: dict[str, Any]) -> dict[str, Any]:
    meta = frappe.get_meta(doctype)
    return {
        field: value
        for field, value in values.items()
        if field == "doctype" or meta.has_field(field)
    }


def _existing_identity_values(doctype: str, identities: list[dict[str, Any]]) -> set[Any] | None:
    """Batch-load a uniform single-field natural key, or signal scalar fallback."""
    if not identities:
        return set()
    fields = {tuple(identity) for identity in identities}
    if len(fields) != 1 or len(fields.pop()) != 1:
        return None
    field = next(iter(identities[0]))
    values = [identity[field] for identity in identities]
    existing: set[Any] = set()
    for start in range(0, len(values), LOOKUP_CHUNK_SIZE):
        existing.update(
            frappe.get_all(
                doctype,
                filters={field: ["in", values[start : start + LOOKUP_CHUNK_SIZE]]},
                pluck=field,
                order_by=None,
            )
        )
    return existing


def _seed_entity(
    *,
    key: str,
    doctype: str,
    target: int,
    identity: Callable[[int], dict[str, Any]],
    values: Callable[[int], dict[str, Any]],
) -> dict[str, Any]:
    result = {
        "key": key,
        "doctype": doctype,
        "target": target,
        "created": 0,
        "existing": 0,
        "skipped": 0,
        "count_after": 0,
        "exact": False,
        "errors": [],
    }
    if not frappe.db.table_exists(doctype):
        result["skipped"] = target
        result["errors"].append(f"{doctype} is unavailable")
        return result

    identities = [identity(index) for index in range(target)]
    existing_values = _existing_identity_values(doctype, identities)
    identity_field = (
        next(iter(identities[0])) if identities and existing_values is not None else None
    )
    for index, filters in enumerate(identities):
        already_exists = (
            filters[identity_field] in existing_values
            if identity_field
            else bool(frappe.db.exists(doctype, filters))
        )
        if already_exists:
            result["existing"] += 1
            continue
        savepoint = f"muster_demo_{key}_{index}"
        frappe.db.savepoint(savepoint)
        try:
            frappe.get_doc(
                _supported_values(doctype, {"doctype": doctype, **values(index)})
            ).insert()
            frappe.db.release_savepoint(savepoint)
            result["created"] += 1
        except Exception as exc:
            frappe.db.rollback(save_point=savepoint)
            result["skipped"] += 1
            if len(result["errors"]) < 10:
                result["errors"].append(f"record {index + 1}: {type(exc).__name__}")

    after_values = _existing_identity_values(doctype, identities)
    if identity_field and after_values is not None:
        result["count_after"] = sum(
            int(filters[identity_field] in after_values) for filters in identities
        )
    else:
        result["count_after"] = sum(
            int(bool(frappe.db.exists(doctype, filters))) for filters in identities
        )
    result["exact"] = result["count_after"] == target
    return result


def seed_erpnext_records(*, site: str, scenario: str, scale: str) -> dict[str, Any]:
    """Seed deterministic ERPNext, HRMS and Frappe CRM business proof records.

    Business DocTypes retain their normal controllers and validations; unlike the passive
    Muster event projections they are intentionally not inserted through raw bulk SQL.
    The result reports each requested target and whether the target was reached exactly.
    """
    installed_apps = set(frappe.get_installed_apps())
    profile = BusinessScaleProfile.named(scale)
    result: dict[str, Any] = {
        "installed": "erpnext" in installed_apps,
        "installed_apps": {
            "erpnext": "erpnext" in installed_apps,
            "hrms": "hrms" in installed_apps,
            "crm": "crm" in installed_apps,
        },
        "targets": profile.expected_counts(),
        "entities": {},
        "created": 0,
        "skipped": 0,
        "exact": False,
        "warnings": [],
    }

    if "erpnext" not in installed_apps:
        result["warnings"].append(
            "ERPNext is not installed; ERPNext and HRMS business fixtures were skipped"
        )
    else:
        default_company = frappe.defaults.get_global_default("company") or _first("Company")
        inherited_currency = (
            frappe.db.get_value("Company", default_company, "default_currency")
            if default_company
            else None
        ) or frappe.defaults.get_global_default("currency") or "USD"
        inherited_country = (
            frappe.db.get_value("Company", default_company, "country")
            if default_company
            else None
        ) or _first("Country") or "United States"
        # HRMS v16 country fixtures are global, not company-scoped. Some regional
        # packs contain duplicate Salary Component labels and can make every later
        # Company insert fail after ERPNext has already built its chart. Use the
        # standard non-regional demo locale when available so each Company still
        # runs its real controller without replaying those broken global fixtures.
        demo_country = (
            "United States"
            if frappe.db.exists("Country", "United States")
            else inherited_country
        )
        demo_currency = "USD" if frappe.db.exists("Currency", "USD") else inherited_currency
        company_names = [
            "[Muster Demo] Company " + short_id(site, scenario, "company", index)
            for index in range(profile.companies)
        ]
        result["entities"]["companies"] = _seed_entity(
            key="companies",
            doctype="Company",
            target=profile.companies,
            identity=lambda index: {"name": company_names[index]},
            values=lambda index: {
                "company_name": company_names[index],
                "abbr": "M" + short_id(site, scenario, "company-abbr", index)[:4].upper(),
                "default_currency": demo_currency,
                "country": demo_country,
            },
        )

        customer_group = _first("Customer Group", {"is_group": 0}) or _first("Customer Group")
        territory = _first("Territory", {"is_group": 0}) or _first("Territory")
        supplier_group = _first("Supplier Group", {"is_group": 0}) or _first("Supplier Group")
        if customer_group and territory:
            result["entities"]["customers"] = _seed_entity(
                key="customers",
                doctype="Customer",
                target=profile.customers,
                identity=lambda index: {
                    "customer_name": (
                        "[Muster Demo] Customer " + short_id(site, scenario, "customer", index)
                    )
                },
                values=lambda index: {
                    "customer_name": (
                        "[Muster Demo] Customer " + short_id(site, scenario, "customer", index)
                    ),
                    "customer_type": "Company",
                    "customer_group": customer_group,
                    "territory": territory,
                    "disabled": 0,
                },
            )
        else:
            result["warnings"].append("ERPNext Customer Group or Territory masters are incomplete")
        if supplier_group:
            result["entities"]["suppliers"] = _seed_entity(
                key="suppliers",
                doctype="Supplier",
                target=profile.suppliers,
                identity=lambda index: {
                    "supplier_name": (
                        "[Muster Demo] Supplier " + short_id(site, scenario, "supplier", index)
                    )
                },
                values=lambda index: {
                    "supplier_name": (
                        "[Muster Demo] Supplier " + short_id(site, scenario, "supplier", index)
                    ),
                    "supplier_group": supplier_group,
                    "supplier_type": "Company",
                    "disabled": 0,
                },
            )
        else:
            result["warnings"].append("ERPNext Supplier Group master is incomplete")

        gender = _first("Gender")
        if company_names and gender:
            result["entities"]["employees"] = _seed_entity(
                key="employees",
                doctype="Employee",
                target=profile.employees,
                identity=lambda index: {
                    "last_name": "Employee " + short_id(site, scenario, "employee", index),
                },
                values=lambda index: {
                    "first_name": "Muster Demo",
                    "last_name": "Employee " + short_id(site, scenario, "employee", index),
                    "gender": gender,
                    "date_of_birth": add_days("1980-01-01", index % 5000),
                    "date_of_joining": add_days("2020-01-01", index % 1500),
                    "company": company_names[index % len(company_names)],
                    "status": "Active",
                },
            )
        else:
            result["warnings"].append(
                "Company or Gender master is incomplete; Employee fixtures skipped"
            )

    if "crm" not in installed_apps:
        result["warnings"].append("Frappe CRM is not installed; CRM fixtures were skipped")
    else:
        currency = frappe.defaults.get_global_default("currency") or _first("Currency")
        lead_status = _first("CRM Lead Status", {"name": "New"}) or _first(
            "CRM Lead Status", {"type": ["in", ["Open", "Ongoing"]]}
        )
        deal_status = _first("CRM Deal Status", {"name": "Qualification"}) or _first(
            "CRM Deal Status", {"type": ["in", ["Open", "Ongoing"]]}
        )

        organization_names = [
            "[Muster Demo] Organization " + short_id(site, scenario, "crm-organization", index)
            for index in range(profile.crm_organizations)
        ]
        result["entities"]["crm_organizations"] = _seed_entity(
            key="crm_organizations",
            doctype="CRM Organization",
            target=profile.crm_organizations,
            identity=lambda index: {"organization_name": organization_names[index]},
            values=lambda index: {
                "organization_name": organization_names[index],
                "website": f"https://demo-{short_id(site, scenario, 'crm-web', index)}.example",
                "no_of_employees": ("11-50", "51-200", "201-500")[index % 3],
                "annual_revenue": 1_000_000 + index * 25_000,
                "currency": currency,
                "exchange_rate": 1,
            },
        )

        lead_emails = [
            f"muster.demo.crm.{short_id(site, scenario, 'crm-lead', index)}@example.com"
            for index in range(profile.crm_leads)
        ]
        if lead_status:
            result["entities"]["crm_leads"] = _seed_entity(
                key="crm_leads",
                doctype="CRM Lead",
                target=profile.crm_leads,
                identity=lambda index: {"email": lead_emails[index]},
                values=lambda index: {
                    "first_name": "Muster",
                    "last_name": f"Lead {index + 1:05d}",
                    "email": lead_emails[index],
                    "status": lead_status,
                    "organization": organization_names[index % len(organization_names)],
                    "lead_owner": "Administrator",
                    "annual_revenue": 100_000 + index * 2_500,
                    "no_of_employees": ("1-10", "11-50", "51-200")[index % 3],
                },
            )
        else:
            result["warnings"].append("CRM Lead Status master is incomplete")

        if deal_status and organization_names and lead_emails:
            result["entities"]["crm_deals"] = _seed_entity(
                key="crm_deals",
                doctype="CRM Deal",
                target=profile.crm_deals,
                identity=lambda index: {
                    "next_step": "[Muster Demo] Deal proof "
                    + short_id(site, scenario, "crm-deal", index)
                },
                values=lambda index: {
                    "organization": organization_names[index % len(organization_names)],
                    "status": deal_status,
                    "deal_owner": "Administrator",
                    "next_step": "[Muster Demo] Deal proof "
                    + short_id(site, scenario, "crm-deal", index),
                    "deal_value": 25_000 + index * 1_000,
                    "probability": (20, 40, 60, 80)[index % 4],
                    "expected_closure_date": add_days("2026-01-01", index % 365),
                    "currency": currency,
                    "exchange_rate": 1,
                },
            )
        else:
            result["warnings"].append("CRM Deal Status master is incomplete")

    for entity in result["entities"].values():
        result["created"] += entity["created"]
        result["skipped"] += entity["skipped"]
        if entity["errors"]:
            result["warnings"].append(f"{entity['doctype']}: " + ", ".join(entity["errors"]))

    required_entities = {
        "companies",
        "customers",
        "suppliers",
        "employees",
        "crm_organizations",
        "crm_leads",
        "crm_deals",
    }
    result["exact"] = required_entities.issubset(result["entities"]) and all(
        result["entities"][key]["exact"] for key in required_entities
    )
    return result
