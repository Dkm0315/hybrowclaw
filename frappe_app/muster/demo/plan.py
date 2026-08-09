from __future__ import annotations

import json
from collections import Counter
from dataclasses import dataclass
from importlib.resources import files
from typing import Any
from uuid import UUID, uuid5

DEMO_NAMESPACE = UUID("b496ab27-2e3f-44ce-8227-429ba223d5c2")
ROLE_CYCLE = (
    "Muster Administrator",
    "Muster Automation Manager",
    "Muster Operator",
    "Muster Approver",
    "Muster Auditor",
    "Muster Viewer",
)
MISSION_STATES = (
    "Running",
    "Waiting for Approval",
    "Completed",
    "Failed",
    "Paused",
    "Needs Intervention",
)


def _fixture(name: str) -> dict[str, Any]:
    path = files("muster.demo.fixtures").joinpath(name)
    return json.loads(path.read_text(encoding="utf-8"))


@dataclass(frozen=True)
class ScaleProfile:
    principals: int
    agents: int
    workflows: int
    missions: int
    work_units_per_mission: int
    activities_per_mission: int
    artifacts_per_mission: int

    @classmethod
    def named(cls, name: str) -> ScaleProfile:
        scales = _fixture("scales.json")
        if name not in scales:
            raise ValueError(f"unknown demo scale: {name}")
        values = {key: value for key, value in scales[name].items() if key != "business"}
        return cls(**values)

    def expected_counts(self) -> dict[str, int]:
        approvals = sum(
            1 for index in range(self.missions) if mission_state(index) == "Waiting for Approval"
        )
        return {
            "principals": self.principals,
            "agents": self.agents,
            "workflows": self.workflows,
            "missions": self.missions,
            "work_units": self.missions * self.work_units_per_mission,
            "runs": self.missions * self.work_units_per_mission,
            "activities": self.missions * self.activities_per_mission,
            "approvals": approvals,
            "change_sets": approvals,
            "artifacts": self.missions * self.artifacts_per_mission,
        }


@dataclass(frozen=True)
class BusinessScaleProfile:
    companies: int
    customers: int
    suppliers: int
    employees: int
    crm_organizations: int
    crm_leads: int
    crm_deals: int

    @classmethod
    def named(cls, name: str) -> BusinessScaleProfile:
        scales = _fixture("scales.json")
        if name not in scales:
            raise ValueError(f"unknown demo scale: {name}")
        return cls(**scales[name]["business"])

    def expected_counts(self) -> dict[str, int]:
        return {
            "companies": self.companies,
            "customers": self.customers,
            "suppliers": self.suppliers,
            "employees": self.employees,
            "crm_organizations": self.crm_organizations,
            "crm_leads": self.crm_leads,
            "crm_deals": self.crm_deals,
        }

    @property
    def total(self) -> int:
        return sum(self.expected_counts().values())


def stable_id(site: str, scenario: str, kind: str, index: int | str) -> str:
    return str(uuid5(DEMO_NAMESPACE, f"{site}|{scenario}|{kind}|{index}"))


def short_id(site: str, scenario: str, kind: str, index: int | str) -> str:
    return stable_id(site, scenario, kind, index).replace("-", "")[:16]


def principal_email(site: str, scenario: str, index: int) -> str:
    site_key = "".join(character for character in site.lower() if character.isalnum())[:18]
    return f"muster.demo.{scenario}.{site_key}.{index:04d}@example.com"


def principal_role(index: int) -> str:
    return ROLE_CYCLE[index % len(ROLE_CYCLE)]


def role_distribution(principals: int) -> dict[str, int]:
    counts = Counter(principal_role(index) for index in range(principals))
    return {role: counts.get(role, 0) for role in ROLE_CYCLE}


def rbac_proof_cases(site: str, scenario: str, principals: int) -> list[dict[str, str]]:
    if principals < len(ROLE_CYCLE):
        raise ValueError("RBAC proof requires at least one principal for every Muster role")
    users = [principal_email(site, scenario, index) for index in range(principals)]
    return [
        {
            "case": "requester-can-read-own-mission",
            "actor": users[2],
            "role": principal_role(2),
            "target_idempotency_key": stable_id(site, scenario, "mission", 2),
            "expected": "allowed",
        },
        {
            "case": "unrelated-viewer-cannot-read-mission",
            "actor": users[5],
            "role": principal_role(5),
            "target_idempotency_key": stable_id(site, scenario, "mission", 0),
            "expected": "denied",
        },
        {
            "case": "auditor-can-read-but-cannot-write",
            "actor": users[4],
            "role": principal_role(4),
            "target_idempotency_key": stable_id(site, scenario, "mission", 0),
            "expected": "read-only",
        },
        {
            "case": "approver-cannot-self-approve",
            "actor": users[3],
            "role": principal_role(3),
            "expected": "denied",
        },
    ]


def mission_state(index: int) -> str:
    return MISSION_STATES[index % len(MISSION_STATES)]


def scenario_fixture(scenario: str) -> dict[str, Any]:
    if scenario != "frappeverse":
        raise ValueError(f"unknown demo scenario: {scenario}")
    return _fixture("frappeverse.json")


def agent_name(fixture: dict[str, Any], index: int) -> str:
    base_name = fixture["agent_archetypes"][index % len(fixture["agent_archetypes"])][0]
    return f"[Muster Demo] {base_name} {index + 1:02d}"


def workflow_name(fixture: dict[str, Any], index: int) -> str:
    base_name = fixture["workflow_archetypes"][index % len(fixture["workflow_archetypes"])]
    return f"[Muster Demo] {base_name} {index + 1:02d}"


def build_manifest(site: str, scenario: str, scale: str) -> dict[str, Any]:
    profile = ScaleProfile.named(scale)
    business = BusinessScaleProfile.named(scale)
    fixture = scenario_fixture(scenario)
    principal_ids = [principal_email(site, scenario, index) for index in range(profile.principals)]
    return {
        "schema_version": "1.0",
        "site": site,
        "tenant_id": stable_id(site, scenario, "tenant", 0),
        "scenario": fixture["key"],
        "scale": scale,
        "counts": profile.expected_counts(),
        "business_counts": business.expected_counts(),
        "business_total": business.total,
        "principal_ids": principal_ids,
        "principal_roles": {
            principal_ids[index]: principal_role(index) for index in range(profile.principals)
        },
        "role_distribution": role_distribution(profile.principals),
        "rbac_proof_cases": rbac_proof_cases(site, scenario, profile.principals),
        "mission_ids": [
            stable_id(site, scenario, "mission", index) for index in range(profile.missions)
        ],
        "agent_names": [agent_name(fixture, index) for index in range(profile.agents)],
        "workflow_names": [workflow_name(fixture, index) for index in range(profile.workflows)],
    }
