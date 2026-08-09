from __future__ import annotations

import json
from importlib.resources import files
from typing import Any

from muster.demo.plan import short_id

ALLOWED_EXPECTATIONS = frozenset({"allow", "deny", "hidden"})
ALLOWED_ACTIONS = frozenset({"read", "list", "direct_url", "create", "update", "delete", "submit", "approve"})
KNOWN_RECORD_ALIASES = frozenset(
    {
        "company",
        "customer_east",
        "customer_west",
        "customer_delete_target",
        "supplier_east",
        "supplier_west",
        "department_east",
        "department_west",
        "employee_east",
        "employee_west",
        "sales_order_east",
        "purchase_order_east",
        "crm_organization_east",
        "crm_organization_west",
        "crm_lead_east",
        "crm_lead_west",
        "crm_deal_east",
        "crm_deal_west",
        "mission_sales",
        "mission_crm",
        "approval_sales",
    }
)


def load_video_catalog() -> dict[str, Any]:
    path = files("muster.demo.fixtures").joinpath("video_evidence.json")
    catalog = json.loads(path.read_text(encoding="utf-8"))
    validate_video_catalog(catalog)
    return catalog


def video_user_email(site: str, persona_key: str) -> str:
    site_key = "".join(character for character in site.lower() if character.isalnum())[:18]
    suffix = short_id(site, "frappeverse-video", "persona", persona_key)[:8]
    return f"muster.video.{persona_key}.{site_key}.{suffix}@example.com"


def validate_video_catalog(catalog: dict[str, Any]) -> None:
    encoded = json.dumps(catalog, sort_keys=True).lower()
    if '"password"' in encoded or '"passwd"' in encoded or '"pwd"' in encoded:
        raise ValueError("video catalog must never contain password material")
    personas = catalog.get("personas") or []
    if not 8 <= len(personas) <= 12:
        raise ValueError("video catalog must define 8 to 12 personas")
    persona_keys = [persona.get("key") for persona in personas]
    if len(set(persona_keys)) != len(persona_keys) or None in persona_keys:
        raise ValueError("video persona keys must be present and unique")
    if any(not persona.get("roles") for persona in personas):
        raise ValueError("every video persona requires explicit roles")
    for persona in personas:
        for permission in persona.get("permissions") or []:
            if permission.get("record") not in KNOWN_RECORD_ALIASES:
                raise ValueError(f"unknown User Permission record for {persona['key']}")

    cases = catalog.get("cases") or []
    case_ids = [case.get("id") for case in cases]
    if len(case_ids) != len(set(case_ids)) or None in case_ids:
        raise ValueError("video case IDs must be present and unique")
    for case in cases:
        if case.get("persona") not in persona_keys:
            raise ValueError(f"unknown persona in case {case.get('id')}")
        if case.get("action") not in ALLOWED_ACTIONS:
            raise ValueError(f"unsupported action in case {case.get('id')}")
        if case.get("expected") not in ALLOWED_EXPECTATIONS:
            raise ValueError(f"unsupported expectation in case {case.get('id')}")
        if not case.get("record") and not case.get("doctype"):
            raise ValueError(f"case {case.get('id')} needs a record or doctype")
        if case.get("record") and case["record"] not in KNOWN_RECORD_ALIASES:
            raise ValueError(f"unknown record alias in case {case.get('id')}")
    represented_personas = {case["persona"] for case in cases}
    if represented_personas != set(persona_keys):
        raise ValueError("every video persona must be represented in the evidence cases")

    required_apps = set(catalog.get("required_apps") or [])
    if {case["app"] for case in cases} != required_apps:
        raise ValueError("every required app must be represented in the evidence cases")
    actions = {case["action"] for case in cases}
    required_actions = {"create", "update", "delete", "submit", "approve", "list", "direct_url"}
    if not required_actions.issubset(actions):
        raise ValueError("video cases do not cover the full separation-of-duties matrix")
    by_id = {case["id"]: case for case in cases}
    required_attended = {
        "destructive-maker-desk-update-allow": ("destructive_maker", "update", "allow"),
        "destructive-maker-desk-delete-allow": ("destructive_maker", "delete", "allow"),
        "muster-approver-approve-allow": ("sales_approver", "approve", "allow"),
        "auditor-desk-delete-deny": ("auditor", "delete", "deny"),
        "crm-own-lead-update": ("crm_operator", "update", "allow"),
        "crm-other-lead-update-deny": ("crm_operator", "update", "deny"),
    }
    for case_id, expected in required_attended.items():
        case = by_id.get(case_id) or {}
        actual = (case.get("persona"), case.get("action"), case.get("expected"))
        if actual != expected:
            raise ValueError(f"attended RBAC evidence case {case_id} is missing or malformed")


def build_video_plan(site: str) -> dict[str, Any]:
    catalog = load_video_catalog()
    return {
        "schema_version": catalog["schema_version"],
        "scenario": catalog["key"],
        "title": catalog["title"],
        "site": site,
        "required_apps": catalog["required_apps"],
        "personas": [
            {
                **persona,
                "user": video_user_email(site, persona["key"]),
                "credential_state": "disabled-until-runtime-rotation",
            }
            for persona in catalog["personas"]
        ],
        "cases": catalog["cases"],
    }
