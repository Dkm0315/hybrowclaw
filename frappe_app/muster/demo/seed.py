from __future__ import annotations

import json
from hashlib import sha256
from typing import Any

import frappe
from frappe import _
from frappe.utils import add_days, now_datetime

from muster.demo.plan import (
    ROLE_CYCLE,
    ScaleProfile,
    agent_name,
    build_manifest,
    mission_state,
    principal_email,
    scenario_fixture,
    short_id,
    stable_id,
    workflow_name,
)

DEMO_PREFIX = "[Muster Demo]"


def _require_explicit_admin(confirm: bool) -> None:
    if not confirm:
        frappe.throw(_("Demo seeding requires explicit confirmation"), frappe.ValidationError)
    if frappe.session.user != "Administrator":
        frappe.throw(_("Only Administrator may run the demo seeder"), frappe.PermissionError)


def _existing(doctype: str, filters: dict[str, Any]) -> str | None:
    return frappe.db.get_value(doctype, filters, "name")


def _ensure_doc(
    doctype: str,
    filters: dict[str, Any],
    values: dict[str, Any],
) -> tuple[Any, bool]:
    name = _existing(doctype, filters)
    if name:
        return frappe.get_doc(doctype, name), False
    return frappe.get_doc({"doctype": doctype, **values}).insert(), True


def _ensure_users(site: str, scenario: str, profile: ScaleProfile) -> tuple[list[str], int]:
    users: list[str] = []
    created = 0
    for index in range(profile.principals):
        email = principal_email(site, scenario, index)
        role = ROLE_CYCLE[index % len(ROLE_CYCLE)]
        user, was_created = _ensure_doc(
            "User",
            {"name": email},
            {
                "email": email,
                "first_name": "Muster Demo",
                "last_name": f"Principal {index + 1:04d}",
                "enabled": 1,
                "send_welcome_email": 0,
                "user_type": "System User",
                "roles": [{"role": role}],
            },
        )
        if role not in {row.role for row in user.roles}:
            user.append("roles", {"role": role})
            user.save()
        users.append(user.name)
        created += int(was_created)
    return users, created


def _ensure_service_user(site: str, scenario: str) -> tuple[str, int]:
    site_key = "".join(character for character in site.lower() if character.isalnum())[:18]
    email = f"muster.demo.service.{scenario}.{site_key}@example.com"
    user, created = _ensure_doc(
        "User",
        {"name": email},
        {
            "email": email,
            "first_name": "Muster Demo Service",
            "enabled": 1,
            "send_welcome_email": 0,
            "user_type": "System User",
            "roles": [{"role": "Muster Service User"}],
        },
    )
    if "Muster Service User" not in {row.role for row in user.roles}:
        user.append("roles", {"role": "Muster Service User"})
        user.save()
    return user.name, int(created)


def _ensure_binding(site: str, scenario: str) -> tuple[Any, int]:
    site_uuid = stable_id(site, scenario, "tenant", 0)
    binding, created = _ensure_doc(
        "Muster Site Binding",
        {"site_uuid": site_uuid},
        {
            "site_uuid": site_uuid,
            "site_label": f"{DEMO_PREFIX} {site}",
            "gateway_tenant": f"demo-{short_id(site, scenario, 'tenant', 0)}",
            "status": "Pending",
            "frappe_version": frappe.__version__,
            "muster_version": frappe.get_attr("muster.__version__"),
            "capabilities_json": frappe.as_json(
                {"demo": True, "effects_enabled": False, "schema_version": "1.0"}
            ),
            "health_status": "Demo binding; no external trust granted",
        },
    )
    return binding, int(created)


def _ensure_principals_and_bindings(
    site: str,
    scenario: str,
    users: list[str],
    site_binding: str,
) -> dict[str, int]:
    counts = {"principal_links": 0, "role_bindings": 0}
    for index, user in enumerate(users):
        subject = stable_id(site, scenario, "principal", index)
        _, created = _ensure_doc(
            "Muster Principal Link",
            {"provider_subject": subject},
            {
                "user": user,
                "status": "Pending",
                "provider": "muster-demo",
                "provider_subject": subject,
                "site_binding": site_binding,
                "scopes_json": frappe.as_json(
                    {"demo": True, "note": "Claims do not grant Frappe permissions"}
                ),
            },
        )
        counts["principal_links"] += int(created)
        role = ROLE_CYCLE[index % len(ROLE_CYCLE)]
        filters = {
            "subject_type": "User",
            "subject": user,
            "scope_type": "Site",
            "scope_value": site,
        }
        _, created = _ensure_doc(
            "Muster Role Binding",
            filters,
            {
                **filters,
                "status": "Active",
                "capabilities": _capabilities_for_role(role),
            },
        )
        counts["role_bindings"] += int(created)
    return counts


def _capabilities_for_role(role: str) -> str:
    capabilities = {
        "Muster Administrator": "configuration.read\npolicy.manage\naudit.read",
        "Muster Automation Manager": "agent.manage\nworkflow.manage\nmission.manage",
        "Muster Operator": "mission.create\nmission.control\nrecord.read",
        "Muster Approver": "approval.read\napproval.decide",
        "Muster Auditor": "audit.read\nevidence.export",
        "Muster Viewer": "mission.read\nartifact.read",
    }
    return capabilities[role]


def _ensure_policy(site: str, scenario: str) -> tuple[Any, int]:
    policy_name = f"{DEMO_PREFIX} {site} Governed Automation"
    policy, created = _ensure_doc(
        "Muster Policy",
        {"policy_name": policy_name},
        {
            "policy_name": policy_name,
            "enabled": 1,
            "priority": 100,
            "description": "Default-deny demo policy with explicit destructive and code controls.",
            "rules": [
                {
                    "effect": "Deny",
                    "capability": "arbitrary.execute",
                    "action": "*",
                    "resource_type": "Site",
                    "resource_pattern": site,
                    "approval_class": "Destructive",
                },
                {
                    "effect": "Deny",
                    "capability": "metadata.write",
                    "action": "execute_unreviewed_code",
                    "resource_type": "Site",
                    "resource_pattern": site,
                    "approval_class": "Privileged Code",
                },
                {
                    "effect": "Allow",
                    "capability": "record.read",
                    "action": "read",
                    "resource_type": "Site",
                    "resource_pattern": site,
                    "approval_class": "None",
                },
                {
                    "effect": "Allow",
                    "capability": "record.write",
                    "action": "propose",
                    "resource_type": "Site",
                    "resource_pattern": site,
                    "approval_class": "Standard",
                },
            ],
        },
    )
    return policy, int(created)


def _ensure_agents(
    site: str,
    scenario: str,
    profile: ScaleProfile,
    fixture: dict[str, Any],
    policy: str,
    service_user: str,
) -> tuple[list[str], int]:
    names: list[str] = []
    created = 0
    archetypes = fixture["agent_archetypes"]
    for index in range(profile.agents):
        _, agent_type, purpose = archetypes[index % len(archetypes)]
        name = agent_name(fixture, index)
        agent, was_created = _ensure_doc(
            "Muster Agent",
            {"agent_name": name},
            {
                "agent_name": name,
                "status": "Active",
                "agent_type": agent_type,
                "description": purpose,
                "run_as_user": service_user,
                "policy": policy,
                "instructions": (
                    "Act only inside the compiled change-set plan. Never infer extra rights "
                    "from these instructions. Stop when live Frappe permission is denied."
                ),
                "max_depth": min(3, profile.work_units_per_mission),
                "max_fan_out": min(8, profile.agents),
                "max_tool_calls": 50,
                "capabilities": [
                    {
                        "capability": "record.read",
                        "resource_pattern": site,
                        "risk_class": "Low",
                        "requires_approval": 0,
                    },
                    {
                        "capability": "record.write",
                        "resource_pattern": site,
                        "risk_class": "Moderate",
                        "requires_approval": 1,
                    },
                ],
            },
        )
        names.append(agent.name)
        created += int(was_created)

    supervisor = frappe.get_doc("Muster Agent", names[0])
    existing_delegates = {row.delegate_agent for row in supervisor.delegations}
    changed = False
    if len(names) > 1:
        for delegate in names[1 : min(len(names), 9)]:
            if delegate in existing_delegates:
                continue
            supervisor.append(
                "delegations",
                {
                    "delegate_agent": delegate,
                    "allowed_capabilities": "record.read\nrecord.write",
                    "max_depth": 2,
                    "max_fan_out": 4,
                    "requires_approval": 0,
                },
            )
            changed = True
    if changed:
        supervisor.save()
    return names, created


def _workflow_graph(agent_names: list[str], index: int) -> tuple[list[dict], list[dict]]:
    selected = [agent_names[(index + offset) % len(agent_names)] for offset in range(3)]
    nodes = [
        {
            "node_id": "plan",
            "label": "Plan and preflight",
            "node_type": "Agent",
            "agent": selected[0],
            "approval_class": "None",
            "retry_limit": 2,
        },
        {
            "node_id": "delegate",
            "label": "Bounded specialist delegation",
            "node_type": "Agent",
            "agent": selected[1],
            "approval_class": "Standard",
            "retry_limit": 3,
        },
        {
            "node_id": "approval",
            "label": "Human approval",
            "node_type": "Approval",
            "agent": selected[2],
            "approval_class": "Sensitive",
            "retry_limit": 0,
        },
        {
            "node_id": "verify",
            "label": "Verify effects and evidence",
            "node_type": "Agent",
            "agent": selected[2],
            "approval_class": "None",
            "retry_limit": 2,
        },
    ]
    edges = [
        {"source_node": "plan", "target_node": "delegate", "priority": 10},
        {"source_node": "delegate", "target_node": "approval", "priority": 20},
        {"source_node": "approval", "target_node": "verify", "priority": 30},
    ]
    return nodes, edges


def _ensure_workflows(
    site: str,
    scenario: str,
    profile: ScaleProfile,
    fixture: dict[str, Any],
    policy: str,
    agents: list[str],
    run_as_user: str,
) -> tuple[list[tuple[str, str]], int]:
    workflows: list[tuple[str, str]] = []
    created = 0
    archetypes = fixture["workflow_archetypes"]
    for index in range(profile.workflows):
        base_name = archetypes[index % len(archetypes)]
        name = workflow_name(fixture, index)
        nodes, edges = _workflow_graph(agents, index)
        workflow, was_created = _ensure_doc(
            "Muster Workflow",
            {"workflow_name": name},
            {
                "workflow_name": name,
                "status": "Published",
                "description": f"{base_name} with visible planning, delegation and verification.",
                "root_agent": agents[index % len(agents)],
                "policy": policy,
                "max_duration_minutes": 90,
                "max_cost": 25,
                "nodes": nodes,
                "edges": edges,
            },
        )
        graph = {
            "schema_version": "1.0",
            "workflow": workflow.name,
            "nodes": nodes,
            "edges": edges,
        }
        graph_json = json.dumps(graph, sort_keys=True, separators=(",", ":"))
        snapshot_hash = sha256(graph_json.encode()).hexdigest()
        version_name = _existing(
            "Muster Workflow Version", {"workflow": workflow.name, "version": 1}
        )
        if not version_name:
            version = frappe.get_doc(
                {
                    "doctype": "Muster Workflow Version",
                    "workflow": workflow.name,
                    "version": 1,
                    "schema_version": "1.0",
                    "published_by": "Administrator",
                    "published_at": now_datetime(),
                    "graph_json": graph_json,
                    "snapshot_hash": snapshot_hash,
                }
            ).insert()
            version.submit()
            version_name = version.name
        else:
            version = frappe.get_doc("Muster Workflow Version", version_name)
            if version.docstatus == 0:
                version.submit()
        workflows.append((workflow.name, version_name))
        created += int(was_created)

        trigger_name = f"{DEMO_PREFIX} Manual {index + 1:02d}"
        _ensure_doc(
            "Muster Trigger",
            {"trigger_name": trigger_name},
            {
                "trigger_name": trigger_name,
                "enabled": 0,
                "trigger_type": "Manual",
                "workflow": workflow.name,
                "run_as_user": run_as_user,
                "dedupe_window_seconds": 300,
            },
        )
    return workflows, created


def _ensure_mission(
    site: str,
    scenario: str,
    index: int,
    fixture: dict[str, Any],
    users: list[str],
    agents: list[str],
    workflows: list[tuple[str, str]],
    existing_name: str | None = None,
) -> tuple[Any, bool]:
    idempotency_key = stable_id(site, scenario, "mission", index)
    if existing_name:
        return frappe.get_doc("Muster Mission", existing_name), False
    state = mission_state(index)
    base = fixture["mission_outcomes"][index % len(fixture["mission_outcomes"])]
    workflow, version = workflows[index % len(workflows)]
    progress = {
        "Running": 45,
        "Waiting for Approval": 55,
        "Completed": 100,
        "Failed": 68,
        "Paused": 35,
        "Needs Intervention": 72,
    }[state]
    return _ensure_doc(
        "Muster Mission",
        {"idempotency_key": idempotency_key},
        {
            "objective": f"{DEMO_PREFIX} {base} — case {index + 1:04d}",
            "status": state,
            "progress": progress,
            "requested_by": users[index % len(users)],
            "assigned_to": users[(index + 2) % len(users)],
            "requested_at": now_datetime(),
            "workflow": workflow,
            "workflow_version": version,
            "root_agent": agents[index % len(agents)],
            "scope_json": frappe.as_json({"site": site, "scenario": scenario, "demo": True}),
            "idempotency_key": idempotency_key,
            "budget_json": frappe.as_json(
                {"max_tool_calls": 50, "max_cost": 25, "max_minutes": 90}
            ),
            "usage_json": frappe.as_json(
                {"tool_calls": index % 17, "cost": round((index % 11) * 0.17, 2)}
            ),
            "result_summary": "Verified demo outcome" if state == "Completed" else "",
            "failure_summary": "Injected recoverable failure" if state == "Failed" else "",
        },
    )


def _ensure_work_units_and_runs(
    site: str,
    scenario: str,
    mission: Any,
    mission_index: int,
    profile: ScaleProfile,
    agents: list[str],
    execution_user: str,
) -> dict[str, int]:
    counts = {"work_units": 0, "runs": 0}
    parent_name = None
    for index in range(profile.work_units_per_mission):
        title = f"{DEMO_PREFIX} M{mission_index + 1:04d} Work {index + 1:02d}"
        unit, created = _ensure_doc(
            "Muster Work Unit",
            {"mission": mission.name, "title": title},
            {
                "title": title,
                "mission": mission.name,
                "status": "Succeeded" if mission.status == "Completed" else "Running",
                "parent_work_unit": parent_name,
                "tree_path": f"/{mission_index:04d}/{index:02d}",
                "depth": min(index, 3),
                "agent": agents[(mission_index + index) % len(agents)],
                "target_workspace": "Muster Mission Control",
                "dependencies_json": frappe.as_json([parent_name] if parent_name else []),
                "attempt_count": 1 + int(index % 7 == 0),
                "started_at": now_datetime(),
            },
        )
        counts["work_units"] += int(created)
        parent_name = unit.name
        external_id = stable_id(site, scenario, "run", f"{mission_index}:{index}")
        _, created = _ensure_doc(
            "Muster Run",
            {"external_run_id": external_id},
            {
                "external_run_id": external_id,
                "mission": mission.name,
                "work_unit": unit.name,
                "attempt": 1,
                "status": "Succeeded" if mission.status == "Completed" else "Running",
                "execution_user": execution_user,
                "job_id": f"muster-demo-{short_id(site, scenario, 'job', external_id)}",
                "started_at": now_datetime(),
                "heartbeat_at": now_datetime(),
                "cursor": index,
                "usage_json": frappe.as_json({"tool_calls": index % 5}),
                "result_json": frappe.as_json({"demo": True, "redacted": True}),
            },
        )
        counts["runs"] += int(created)
    return counts


def _ensure_activities(
    site: str,
    scenario: str,
    mission: Any,
    mission_index: int,
    profile: ScaleProfile,
    actor: str,
) -> int:
    created_count = 0
    event_types = (
        "mission.planned",
        "work_unit.started",
        "tool.preflighted",
        "change.proposed",
        "approval.checked",
        "evidence.attached",
        "postcondition.verified",
        "mission.progressed",
    )
    for index in range(profile.activities_per_mission):
        idempotency_key = stable_id(site, scenario, "activity", f"{mission_index}:{index}")
        _, created = _ensure_doc(
            "Muster Activity",
            {"idempotency_key": idempotency_key},
            {
                "mission": mission.name,
                "sequence": index + 1,
                "event_type": event_types[index % len(event_types)],
                "state": mission.status,
                "summary": (
                    f"Demo evidence event {index + 1:02d}: permission-filtered "
                    "work remained inside the approved plan."
                ),
                "visibility": "Participants",
                "actor": actor,
                "idempotency_key": idempotency_key,
                "payload_json": frappe.as_json(
                    {
                        "demo": True,
                        "mission_index": mission_index,
                        "event_index": index,
                        "contains_secrets": False,
                    }
                ),
            },
        )
        created_count += int(created)
    return created_count


def _ensure_change_and_approval(
    site: str,
    scenario: str,
    mission: Any,
    mission_index: int,
    requester: str,
    approver: str,
) -> dict[str, int]:
    if mission.status != "Waiting for Approval":
        return {"change_sets": 0, "approvals": 0}
    operation_key = stable_id(site, scenario, "operation", mission_index)
    plan_payload = {
        "schema_version": "1.0",
        "mission": mission.name,
        "operation": "update_record",
        "target": "ToDo",
        "demo": True,
    }
    plan_hash = sha256(
        json.dumps(plan_payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    change_set, change_created = _ensure_doc(
        "Muster Change Set",
        {"mission": mission.name, "plan_hash": plan_hash},
        {
            "mission": mission.name,
            "status": "Awaiting Approval",
            "risk_class": "Moderate",
            "approval_class": "Sensitive",
            "target_site": site,
            "actor": requester,
            "permission_epoch": stable_id(site, scenario, "permission", mission_index),
            "schema_revision": "demo-v1",
            "plan_hash": plan_hash,
            "operations": [
                {
                    "operation_id": f"demo-op-{mission_index:04d}",
                    "operation_type": "update_record",
                    "target_doctype": "ToDo",
                    "target_name": f"DEMO-TODO-{mission_index:04d}",
                    "approval_class": "Sensitive",
                    "before_json": frappe.as_json({"status": "Open"}),
                    "after_json": frappe.as_json({"status": "Closed"}),
                    "idempotency_key": operation_key,
                    "postcondition_json": frappe.as_json({"status": "Closed"}),
                }
            ],
            "verification_json": frappe.as_json(
                {"method": "read_after_write", "expected": {"status": "Closed"}}
            ),
            "inverse_json": frappe.as_json(
                {"operation": "update_record", "values": {"status": "Open"}}
            ),
            "evidence_json": frappe.as_json({"demo": True, "executed": False}),
        },
    )
    action_hash = sha256(f"{plan_hash}|Sensitive".encode()).hexdigest()
    _, approval_created = _ensure_doc(
        "Muster Approval",
        {"change_set": change_set.name, "action_hash": action_hash},
        {
            "mission": mission.name,
            "change_set": change_set.name,
            "status": "Pending",
            "approval_class": "Sensitive",
            "requested_by": requester,
            "requested_from": approver,
            "expires_at": add_days(now_datetime(), 3),
            "action_hash": action_hash,
            "diff_json": frappe.as_json(
                {"before": {"status": "Open"}, "after": {"status": "Closed"}}
            ),
        },
    )
    return {
        "change_sets": int(change_created),
        "approvals": int(approval_created),
    }


def _ensure_artifacts(
    site: str,
    scenario: str,
    mission: Any,
    mission_index: int,
    profile: ScaleProfile,
) -> int:
    created_count = 0
    kinds = ("Report", "PDF", "Spreadsheet", "Presentation", "Receipt")
    for index in range(profile.artifacts_per_mission):
        checksum = sha256(
            f"{site}|{scenario}|artifact|{mission_index}|{index}".encode()
        ).hexdigest()
        title = f"{DEMO_PREFIX} Evidence {mission_index + 1:04d}-{index + 1:02d}"
        _, created = _ensure_doc(
            "Muster Artifact",
            {"mission": mission.name, "checksum": checksum},
            {
                "title": title,
                "mission": mission.name,
                "kind": kinds[index % len(kinds)],
                "visibility": "Participants",
                "is_public": 0,
                "reference_doctype": "Muster Mission",
                "reference_name": mission.name,
                "mime_type": "application/json",
                "size_bytes": 256 + index,
                "checksum": checksum,
                "verification_status": "Verified",
                "verified_at": now_datetime(),
            },
        )
        created_count += int(created)
    return created_count


def _ensure_channel_proof(
    site: str,
    scenario: str,
    site_binding: str,
    users: list[str],
) -> dict[str, int]:
    account_name = f"{DEMO_PREFIX} Telegram {site}"
    account, account_created = _ensure_doc(
        "Muster Channel Account",
        {"account_name": account_name},
        {
            "account_name": account_name,
            "provider": "Telegram",
            "status": "Disabled",
            "site_binding": site_binding,
            "bot_username": "muster_demo_disabled_bot",
            "allowed_updates": "message\ncallback_query",
            "health_status": "Disabled proof fixture; contains no credential",
        },
    )
    identities_created = 0
    for index, user in enumerate(users[: min(len(users), 12)]):
        subject = stable_id(site, scenario, "channel-principal", index)
        _, created = _ensure_doc(
            "Muster Channel Identity",
            {"external_subject": subject},
            {
                "channel_account": account.name,
                "user": user,
                "status": "Pending",
                "external_subject": subject,
                "external_username": f"demo_user_{index:04d}",
                "expires_at": add_days(now_datetime(), 1),
            },
        )
        identities_created += int(created)
    return {
        "channel_accounts": int(account_created),
        "channel_identities": identities_created,
    }


def seed_demo(
    *,
    scale: str = "tiny",
    scenario: str = "frappeverse",
    confirm: bool = False,
    with_erpnext: bool = True,
) -> dict[str, Any]:
    """Seed one site. Run independently on each site to prove hard tenant isolation."""
    _require_explicit_admin(confirm)
    site = frappe.local.site
    profile = ScaleProfile.named(scale)
    fixture = scenario_fixture(scenario)
    manifest = build_manifest(site, scenario, scale)
    before = _current_counts(manifest)

    users, users_created = _ensure_users(site, scenario, profile)
    service_user, service_user_created = _ensure_service_user(site, scenario)
    binding, binding_created = _ensure_binding(site, scenario)
    counts: dict[str, int] = {
        "users": users_created,
        "service_users": service_user_created,
        "site_bindings": binding_created,
    }
    counts.update(_ensure_principals_and_bindings(site, scenario, users, binding.name))
    policy, policy_created = _ensure_policy(site, scenario)
    counts["policies"] = policy_created
    agents, counts["agents"] = _ensure_agents(
        site, scenario, profile, fixture, policy.name, service_user
    )
    workflows, counts["workflows"] = _ensure_workflows(
        site, scenario, profile, fixture, policy.name, agents, users[2 % len(users)]
    )

    mission_counts = {
        "missions": 0,
        "work_units": 0,
        "runs": 0,
        "activities": 0,
        "change_sets": 0,
        "approvals": 0,
        "artifacts": 0,
    }
    approver = users[3 % len(users)]
    existing_missions = _mission_name_map(manifest["mission_ids"])
    passive_batch: list[tuple[int, Any]] = []

    def flush_passive_batch() -> None:
        if not passive_batch:
            return
        from muster.demo.bulk import seed_passive_projections

        projection = seed_passive_projections(
            site=site,
            scenario=scenario,
            indexed_missions=passive_batch,
            profile=profile,
            agents=agents,
            users=users,
        )
        for key, value in projection.items():
            mission_counts[key] += value
        passive_batch.clear()

    for index in range(profile.missions):
        mission, created = _ensure_mission(
            site,
            scenario,
            index,
            fixture,
            users,
            agents,
            workflows,
            existing_missions.get(manifest["mission_ids"][index]),
        )
        mission_counts["missions"] += int(created)
        passive_batch.append((index, mission))
        if len(passive_batch) >= 200:
            flush_passive_batch()
        approval = _ensure_change_and_approval(
            site,
            scenario,
            mission,
            index,
            users[index % len(users)],
            approver,
        )
        mission_counts["change_sets"] += approval["change_sets"]
        mission_counts["approvals"] += approval["approvals"]
    flush_passive_batch()
    counts.update(mission_counts)
    counts.update(_ensure_channel_proof(site, scenario, binding.name, users))

    erpnext = {"installed": False, "created": 0, "skipped": 0, "warnings": []}
    if with_erpnext:
        from muster.demo.erpnext import seed_erpnext_records

        erpnext = seed_erpnext_records(site=site, scenario=scenario, scale=scale)

    after = _current_counts(manifest)
    count_mismatches = {
        key: {"expected": expected, "actual": after.get(key, 0)}
        for key, expected in manifest["counts"].items()
        if after.get(key, 0) != expected
    }
    role_counts = {
        role: sum(int(role in frappe.get_roles(user)) for user in manifest["principal_ids"])
        for role in ROLE_CYCLE
    }
    rbac_checks = _live_rbac_checks(manifest)
    result = {
        **manifest,
        "created_this_run": counts,
        "counts_before": before,
        "counts_after": after,
        "erpnext": erpnext,
        "ecosystem": erpnext,
        "verification": {
            "core_counts_exact": not count_mismatches,
            "core_count_mismatches": count_mismatches,
            "roles_exact": role_counts == manifest["role_distribution"],
            "role_counts": role_counts,
            "rbac_exact": all(check["passed"] for check in rbac_checks),
            "rbac_checks": rbac_checks,
            "business_counts_exact": erpnext.get("exact") if with_erpnext else None,
            "tenant_id": manifest["tenant_id"],
            "site": site,
        },
        "adversarial_cases": _adversarial_cases(users, manifest),
    }
    if count_mismatches:
        frappe.throw(
            _("Demo seed did not reach its exact core counts: {0}").format(
                frappe.as_json(count_mismatches)
            ),
            frappe.ValidationError,
        )
    if not result["verification"]["roles_exact"] or not result["verification"]["rbac_exact"]:
        frappe.throw(
            _("Demo seed failed its live RBAC verification: {0}").format(
                frappe.as_json(result["verification"]["rbac_checks"])
            ),
            frappe.PermissionError,
        )
    frappe.logger("muster.demo").info("Muster demo seed complete: %s", frappe.as_json(result))
    return result


def _current_counts(manifest: dict[str, Any]) -> dict[str, int]:
    mission_ids = manifest["mission_ids"]
    setup_counts = {
        "principals": frappe.db.count("User", {"name": ["in", manifest["principal_ids"]]}),
        "agents": frappe.db.count("Muster Agent", {"name": ["in", manifest["agent_names"]]}),
        "workflows": frappe.db.count(
            "Muster Workflow", {"name": ["in", manifest["workflow_names"]]}
        ),
    }
    missions: list[str] = []
    for chunk in _chunks(mission_ids):
        missions.extend(
            frappe.get_all(
                "Muster Mission",
                filters={"idempotency_key": ["in", chunk]},
                pluck="name",
            )
        )
    if not missions:
        return setup_counts | {
            key: 0
            for key in (
                "missions",
                "work_units",
                "runs",
                "activities",
                "approvals",
                "change_sets",
                "artifacts",
            )
        }
    return setup_counts | {
        "missions": len(missions),
        "work_units": _count_for_missions("Muster Work Unit", missions),
        "runs": _count_for_missions("Muster Run", missions),
        "activities": _count_for_missions("Muster Activity", missions),
        "approvals": _count_for_missions("Muster Approval", missions),
        "change_sets": _count_for_missions("Muster Change Set", missions),
        "artifacts": _count_for_missions("Muster Artifact", missions),
    }


def _mission_name_map(mission_ids: list[str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for chunk in _chunks(mission_ids):
        for row in frappe.get_all(
            "Muster Mission",
            filters={"idempotency_key": ["in", chunk]},
            fields=["name", "idempotency_key"],
            order_by=None,
        ):
            result[row.idempotency_key] = row.name
    return result


def _live_rbac_checks(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    mission_names = _mission_name_map(manifest["mission_ids"][:3])
    mission_zero = frappe.get_doc("Muster Mission", mission_names[manifest["mission_ids"][0]])
    mission_two = frappe.get_doc("Muster Mission", mission_names[manifest["mission_ids"][2]])
    operator = manifest["principal_ids"][2]
    auditor = manifest["principal_ids"][4]
    viewer = manifest["principal_ids"][5]
    cases = (
        ("operator-reads-own-mission", True, mission_two.has_permission("read", user=operator)),
        (
            "operator-writes-assigned-running-mission",
            True,
            mission_zero.has_permission("write", user=operator),
        ),
        (
            "unrelated-viewer-cannot-read-mission",
            False,
            mission_zero.has_permission("read", user=viewer),
        ),
        ("auditor-reads-mission", True, mission_zero.has_permission("read", user=auditor)),
        (
            "auditor-cannot-write-mission",
            False,
            mission_zero.has_permission("write", user=auditor),
        ),
    )
    return [
        {
            "case": name,
            "expected": expected,
            "actual": bool(actual),
            "passed": bool(actual) is expected,
        }
        for name, expected, actual in cases
    ]


def _chunks(values: list[str], size: int = 400):
    for start in range(0, len(values), size):
        yield values[start : start + size]


def _count_for_missions(doctype: str, missions: list[str]) -> int:
    return sum(frappe.db.count(doctype, {"mission": ["in", chunk]}) for chunk in _chunks(missions))


def _adversarial_cases(users: list[str], manifest: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {
            "case": "cross-principal-mission-read",
            "actor": users[5 % len(users)],
            "target_idempotency_key": manifest["mission_ids"][0],
            "expected": "denied",
        },
        {
            "case": "self-approval",
            "actor": users[2 % len(users)],
            "expected": "denied",
        },
        {
            "case": "unreviewed-code-operation",
            "actor": users[1 % len(users)],
            "expected": "denied",
        },
        {
            "case": "stale-approval-replay",
            "actor": users[2 % len(users)],
            "expected": "denied-on-live-permission-recheck",
        },
    ]
