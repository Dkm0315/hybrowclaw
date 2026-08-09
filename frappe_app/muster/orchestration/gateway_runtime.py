from __future__ import annotations

import json
import time
from fnmatch import fnmatchcase
from hashlib import sha256
from typing import Any, Iterable

import frappe
from frappe import _
from frappe.utils import get_datetime, now_datetime

from muster.adapters.client import GatewayBinding, GatewayClient, trusted_binding
from muster.adapters.context import permission_filtered_context
from muster.adapters.identity import frappe_identity
from muster.adapters.run_authority import run_authority_headers
from muster.orchestration.projection import project_gateway_snapshot
from muster.orchestration.workflow_graph import canonical_execution_manifest, compile_legacy_snapshot

MISSIONS_PATH = "/v1/integrations/frappe/missions"
RUN_EVENTS_PATH = "/v1/integrations/frappe/run-events"
_CAPABILITY_LIMIT = 256
_MAX_AUTHORITY_CAPABILITIES = 1_024


class MissionDispatchError(frappe.ValidationError):
    """A safe, operator-facing failure before or during trusted dispatch."""


def dispatch_mission_to_gateway(
    mission_name: str,
    *,
    client: GatewayClient | None = None,
    binding: GatewayBinding | None = None,
) -> dict[str, Any]:
    """Admit a published graph and project its first durable gateway snapshot.

    All values in ``identity`` and ``authority`` are recomputed from live Frappe
    state. Nothing supplied by the browser is allowed to expand a capability.
    """
    mission = frappe.get_doc("Muster Mission", mission_name)
    if mission.status not in {"Queued", "Planning", "Ready to Dispatch", "Running"}:
        raise MissionDispatchError(_("This mission cannot be dispatched from its current state"))
    binding = binding or trusted_binding()
    client = client or GatewayClient(binding)
    envelope = build_dispatch_envelope(mission, binding)
    headers, _csrf_token = run_authority_headers(binding, mission.requested_by)
    admission = client.request(
        "POST",
        MISSIONS_PATH,
        payload=envelope,
        idempotency_key=envelope["idempotencyKey"],
        headers=headers,
    )
    poll_path = _validate_admission(admission, mission.name, envelope["rootRunId"])
    frappe.db.set_value(
        "Muster Mission",
        mission.name,
        {
            "status": "Running",
            "root_run_id": envelope["rootRunId"],
            "workflow_version": _published_version(mission).name,
        },
        update_modified=True,
    )
    return poll_and_project(
        mission.name,
        poll_path=poll_path,
        client=client,
        binding=binding,
        authority_user=mission.requested_by,
    )


def poll_and_project(
    mission_name: str,
    *,
    poll_path: str | None = None,
    client: GatewayClient | None = None,
    binding: GatewayBinding | None = None,
    authority_user: str | None = None,
) -> dict[str, Any]:
    mission = frappe.get_doc("Muster Mission", mission_name)
    if not mission.has_permission("read") and frappe.session.user != mission.requested_by:
        frappe.throw(_("Not permitted"), frappe.PermissionError)
    binding = binding or trusted_binding()
    client = client or GatewayClient(binding)
    authority_user = authority_user or mission.requested_by
    headers, _csrf_token = run_authority_headers(binding, authority_user)
    path = poll_path or _stored_poll_path(mission)
    snapshot = client.request("GET", path, headers=headers)
    return project_gateway_snapshot(mission.name, snapshot, binding, poll_path=path)


def dispatch_and_follow(
    mission_name: str,
    *,
    burst_polls: int = 3,
    poll_interval: float = 1.0,
) -> dict[str, Any]:
    """Admit once, project a short burst, then yield the worker fairly."""
    result = dispatch_mission_to_gateway(mission_name)
    return follow_mission_projection(
        mission_name,
        initial_result=result,
        burst_polls=burst_polls,
        poll_interval=poll_interval,
        generation=1,
    )


def follow_mission_projection(
    mission_name: str,
    *,
    initial_result: dict[str, Any] | None = None,
    burst_polls: int = 10,
    poll_interval: float = 1.0,
    generation: int = 1,
) -> dict[str, Any]:
    """Project a bounded burst and enqueue the next replay-safe continuation.

    A mission never occupies one worker for its full runtime. Generation-scoped
    job IDs also make duplicate continuation scheduling observable and harmless.
    """
    result = initial_result or poll_and_project(mission_name)
    for _index in range(max(0, min(int(burst_polls), 60))):
        mission = frappe.get_doc("Muster Mission", mission_name)
        if mission.status in {"Completed", "Failed", "Cancelled", "Needs Intervention"}:
            return result
        if poll_interval:
            time.sleep(max(0.05, min(float(poll_interval), 30.0)))
        result = poll_and_project(mission_name, authority_user=mission.requested_by)
        frappe.db.commit()
    mission = frappe.get_doc("Muster Mission", mission_name)
    if mission.status not in {"Completed", "Failed", "Cancelled", "Needs Intervention"}:
        next_generation = max(1, int(generation)) + 1
        frappe.enqueue(
            "muster.orchestration.worker.continue_mission_projection",
            queue="default",
            mission=mission.name,
            generation=next_generation,
            job_id=f"muster-poll-{mission.name}-{next_generation}",
            deduplicate=True,
        )
    return result


def dispatch_control_command(
    mission_name: str,
    action: str,
    note: str | None,
    idempotency_key: str,
    *,
    client: GatewayClient | None = None,
    binding: GatewayBinding | None = None,
) -> dict[str, Any]:
    mission = frappe.get_doc("Muster Mission", mission_name)
    if not mission.has_permission("write"):
        frappe.throw(_("Not permitted"), frappe.PermissionError)
    # The gateway mission lane is bound to the original requester. Acting as
    # another user would make the durable audit claim the wrong controller.
    if frappe.session.user.lower() != mission.requested_by.lower():
        frappe.throw(_("Only the mission requester can control this gateway run"), frappe.PermissionError)
    if not mission.root_run_id:
        raise MissionDispatchError(_("The mission has not been admitted by the gateway"))
    binding = binding or trusted_binding()
    client = client or GatewayClient(binding)
    headers, csrf_token = run_authority_headers(binding, mission.requested_by)
    safe_key = _stable_id("control", mission.name, idempotency_key)
    command = {
        "schemaVersion": 1,
        "commandId": _stable_id("command", mission.name, idempotency_key),
        "action": action,
        "missionId": mission.name,
        "rootRunId": mission.root_run_id,
        "tenantId": binding.tenant_id,
        **({"siteId": binding.site_id} if binding.site_id else {}),
        "userId": mission.requested_by.lower(),
        # The gateway fingerprint includes issuedAt (but deliberately excludes
        # the CSRF nonce). Minute bucketing keeps immediate HTTP/job retries
        # byte-identical while remaining well inside its five-minute freshness gate.
        "issuedAt": now_datetime().replace(second=0, microsecond=0).isoformat(),
        "idempotencyKey": safe_key,
        "csrfToken": csrf_token,
        **({"payload": {"instruction": note.strip()}} if action == "steer" and note else {}),
    }
    response = client.request(
        "POST",
        f"{RUN_EVENTS_PATH}/missions/{mission.name}/commands",
        payload=command,
        idempotency_key=safe_key,
        headers=headers,
    )
    if response.get("status") not in {"claimed", "replay"} or response.get("dispatched") is not True:
        raise MissionDispatchError(_("The gateway returned an invalid control acknowledgement"))
    projection = poll_and_project(
        mission.name,
        client=client,
        binding=binding,
        authority_user=mission.requested_by,
    )
    return {
        "mission": mission.name,
        "action": action,
        "replayed": response["status"] == "replay",
        "status": projection["status"],
        "cursor": projection["cursor"],
    }


def build_dispatch_envelope(mission, binding: GatewayBinding) -> dict[str, Any]:
    version = _published_version(mission)
    graph = compile_legacy_snapshot(version.graph_json)
    workflow = frappe.get_doc("Muster Workflow", version.workflow)
    if workflow.status != "Published":
        raise MissionDispatchError(_("The selected workflow is not active for dispatch"))
    if not workflow.has_permission("read", user=mission.requested_by):
        raise MissionDispatchError(_("The mission requester cannot access the selected workflow"))
    if not frappe.get_cached_doc("User", mission.requested_by).enabled:
        raise MissionDispatchError(_("The mission requester is disabled"))
    identity = frappe_identity(mission.requested_by)
    authority = _capability_authority(mission, workflow, graph)
    root_run_id = _stable_id("run", mission.name, mission.idempotency_key)
    submitted_at = get_datetime(mission.requested_at).isoformat()
    scope = _json_object(mission.scope_json, _("Mission scope is invalid"))
    execution_manifest = _published_execution_manifest(version, workflow, scope, mission=mission, binding=binding)
    return {
        "schemaVersion": 1,
        "missionId": mission.name,
        "rootRunId": root_run_id,
        "idempotencyKey": _stable_id("mission", mission.name, mission.idempotency_key),
        "submittedAt": submitted_at,
        "objective": mission.objective,
        "workflow": graph,
        "identity": {
            "tenantId": binding.tenant_id,
            **({"siteId": binding.site_id} if binding.site_id else {}),
            "userId": mission.requested_by.lower(),
            "permissionEpoch": identity["permissionHash"],
            "rolesHash": identity["rolesHash"],
        },
        "authority": authority,
        "executionManifest": execution_manifest,
        "context": permission_filtered_context(scope, mission.requested_by),
    }


def _published_execution_manifest(version, workflow, mission_scope: dict[str, Any], *, mission=None, binding=None) -> dict[str, Any]:
    """Read only the submitted publication evidence; draft node edits cannot affect dispatch."""
    raw = getattr(version, "execution_manifest_json", None)
    stored_hash = getattr(version, "execution_manifest_hash", None)
    if not raw or not stored_hash:
        # Safe compatibility for pre-manifest versions: they can never select a
        # browser executor because their immutable manifest contains no plans.
        raw, stored_hash = canonical_execution_manifest([], version.snapshot_hash)
    if not isinstance(raw, str) or sha256(raw.encode()).hexdigest() != stored_hash:
        raise MissionDispatchError(_("The published execution manifest evidence hash does not match"))
    try:
        manifest = json.loads(raw)
    except (TypeError, ValueError) as error:
        raise MissionDispatchError(_("The published execution manifest is invalid")) from error
    if (
        not isinstance(manifest, dict)
        or set(manifest) != {"schemaVersion", "workflowSnapshotHash", "nodePlans"}
        or manifest.get("schemaVersion") != 1
        or manifest.get("workflowSnapshotHash") != version.snapshot_hash
        or not isinstance(manifest.get("nodePlans"), dict)
    ):
        raise MissionDispatchError(_("The published execution manifest is invalid"))
    graph_nodes = {node.get("id") for node in compile_legacy_snapshot(version.graph_json).get("nodes", [])}
    if not set(manifest["nodePlans"]).issubset(graph_nodes):
        raise MissionDispatchError(_("The published execution manifest references an unknown node"))
    _assert_browser_manifest_scope(manifest, mission_scope)
    if any(entry.get("surface") == "server_effect" for entry in manifest["nodePlans"].values() if isinstance(entry, dict)):
        if mission is None or binding is None:
            raise MissionDispatchError(_("Server-effect manifest requires mission-time preparation"))
        from muster.orchestration.effect_lifecycle import prepare_mission_execution_manifest
        return prepare_mission_execution_manifest(manifest, mission, binding)
    return {**manifest, "manifestHash": stored_hash}


def _assert_browser_manifest_scope(manifest: dict[str, Any], mission_scope: dict[str, Any]) -> None:
    """Narrow immutable reviewed resources by the user-approved mission scope."""
    scoped_doctypes: set[str] = set()
    scoped_records: set[str] = set()
    scoped_fields: set[str] = set()
    if mission_scope.get("scope_mode") == "context":
        # Desk auto-context helps reasoning but never silently narrows a
        # universal prompt. Live caller/workflow/agent policy remains binding.
        return
    if isinstance(mission_scope.get("doctype"), str):
        scoped_doctypes.add(mission_scope["doctype"])
    if isinstance(mission_scope.get("docname"), str):
        scoped_records.add(mission_scope["docname"])
    if isinstance(mission_scope.get("fields"), list):
        scoped_fields.update(item for item in mission_scope["fields"] if isinstance(item, str))
    for row in mission_scope.get("documents") or []:
        if not isinstance(row, dict):
            continue
        if isinstance(row.get("doctype"), str):
            scoped_doctypes.add(row["doctype"])
        name = row.get("name") or row.get("docname")
        if isinstance(name, str):
            scoped_records.add(name)
        if isinstance(row.get("fields"), list):
            scoped_fields.update(item for item in row["fields"] if isinstance(item, str))
    for entry in manifest["nodePlans"].values():
        if (
            not isinstance(entry, dict)
            or set(entry) != {"surface", "plan", "resourceScope"}
            or entry.get("surface") not in {"browser", "server_effect"}
        ):
            raise MissionDispatchError(_("The published execution resource scope is invalid"))
        resources = entry.get("resourceScope")
        if not isinstance(resources, dict) or set(resources) != {"routes", "doctypes", "recordNames", "fields"}:
            raise MissionDispatchError(_("The published browser resource scope is invalid"))
        for key in ("routes", "doctypes", "recordNames", "fields"):
            if not isinstance(resources[key], list) or any(not isinstance(item, str) for item in resources[key]):
                raise MissionDispatchError(_("The published browser resource scope is invalid"))
        label = "Browser" if entry["surface"] == "browser" else "Server effect"
        if scoped_doctypes and not set(resources["doctypes"]).issubset(scoped_doctypes):
            raise MissionDispatchError(_("{0} plan DocType is outside the approved mission scope").format(label))
        if scoped_records and not set(resources["recordNames"]).issubset(scoped_records):
            raise MissionDispatchError(_("{0} plan record is outside the approved mission scope").format(label))
        if scoped_fields and not set(resources["fields"]).issubset(scoped_fields):
            raise MissionDispatchError(_("{0} plan field is outside the approved mission scope").format(label))


def _published_version(mission):
    version_name = mission.workflow_version
    if not version_name:
        if not mission.workflow:
            raise MissionDispatchError(_("Select a published workflow before dispatch"))
        version_name = frappe.db.get_value("Muster Workflow", mission.workflow, "published_version")
    if not version_name:
        raise MissionDispatchError(_("The selected workflow has no published version"))
    version = frappe.get_doc("Muster Workflow Version", version_name)
    if version.docstatus != 1 or (mission.workflow and version.workflow != mission.workflow):
        raise MissionDispatchError(_("The selected workflow version is not a valid publication"))
    if (
        not isinstance(version.graph_json, str)
        or not version.snapshot_hash
        or sha256(version.graph_json.encode()).hexdigest() != version.snapshot_hash
    ):
        raise MissionDispatchError(_("The published workflow evidence hash does not match"))
    if version.contract and version.contract not in {"AgentGraphDefinition", "Legacy Frappe Workflow Graph"}:
        raise MissionDispatchError(_("The workflow version uses an unsupported execution contract"))
    return version


def _capability_authority(mission, workflow, graph: dict[str, Any]) -> dict[str, Any]:
    scope = _json_object(mission.scope_json, _("Mission scope is invalid"))
    resources = _scope_resources(scope, workflow.name)
    requested_by_agent: dict[str, set[str]] = {}
    requested_all: set[str] = set()
    for node in graph.get("nodes", []):
        requested = _bounded_capabilities(node.get("requestedCapabilities") or [])
        requested_all.update(requested)
        if node.get("agentId"):
            requested_by_agent.setdefault(node["agentId"], set()).update(requested)

    caller = _caller_capabilities(mission.requested_by, workflow.name)
    workflow_grant = _policy_capabilities(workflow.policy, resources)
    agent_grants: dict[str, list[str]] = {}
    for agent_name, requested in requested_by_agent.items():
        if not frappe.db.exists("Muster Agent", agent_name):
            raise MissionDispatchError(_("Workflow references an unavailable agent"))
        agent = frappe.get_doc("Muster Agent", agent_name)
        if agent.status != "Active":
            raise MissionDispatchError(_("Workflow references an inactive agent"))
        declared = _bounded_capabilities(
            row.capability
            for row in agent.capabilities
            if _resource_pattern_matches(row.resource_pattern, resources)
        )
        policy = _policy_capabilities(
            agent.policy, {**resources, "Agent": {agent.name}}
        )
        agent_grants[agent_name] = _intersect_grants(declared, policy)

    missing: dict[str, list[str]] = {}
    for capability in sorted(requested_all):
        if not _grants(caller, capability) or not _grants(workflow_grant, capability):
            missing.setdefault("workflow", []).append(capability)
    for agent_name, requested in requested_by_agent.items():
        for capability in sorted(requested):
            if not _grants(agent_grants.get(agent_name, []), capability):
                missing.setdefault(agent_name, []).append(capability)
    if missing:
        detail = "; ".join(f"{owner}: {', '.join(values)}" for owner, values in missing.items())
        raise MissionDispatchError(_("Workflow capability authority denied: {0}").format(detail))
    return {
        "callerCapabilities": sorted(caller),
        "workflowCapabilities": sorted(workflow_grant),
        "agentCapabilities": agent_grants,
    }


def _caller_capabilities(user: str, workflow: str) -> list[str]:
    roles = set(frappe.get_roles(user))
    now = now_datetime()
    rows = frappe.get_all(
        "Muster Role Binding",
        filters={"status": "Active"},
        fields=[
            "subject_type", "subject", "scope_type", "scope_value", "capabilities",
            "valid_from", "valid_until",
        ],
        limit_page_length=10_000,
    )
    result: set[str] = set()
    for row in rows:
        if row.subject_type == "User":
            if row.subject.lower() != user.lower():
                continue
        elif row.subject_type == "Role":
            if row.subject not in roles:
                continue
        else:
            continue
        if row.valid_from and get_datetime(row.valid_from) > now:
            continue
        if row.valid_until and get_datetime(row.valid_until) < now:
            continue
        if row.scope_type == "Site" and row.scope_value not in {frappe.local.site, "*"}:
            continue
        if row.scope_type == "Workflow" and row.scope_value not in {workflow, "*"}:
            continue
        if row.scope_type not in {"Site", "Workflow"}:
            continue
        result.update(_bounded_capabilities((row.capabilities or "").splitlines()))
    return _bounded_capabilities(result)


def _policy_capabilities(
    policy_name: str | None, resources: dict[str, set[str]]
) -> list[str]:
    if not policy_name:
        return []
    policy = frappe.get_doc("Muster Policy", policy_name)
    if not policy.enabled:
        return []
    allowed = {
        row.capability.strip()
        for row in policy.rules
        if row.effect == "Allow"
        and row.capability
        and row.capability.strip()
        and _rule_matches(row, resources)
    }
    denied = {
        row.capability.strip()
        for row in policy.rules
        if row.effect == "Deny"
        and row.capability
        and row.capability.strip()
        and _rule_matches(row, resources)
    }
    allowed = set(_bounded_capabilities(allowed))
    denied = set(_bounded_capabilities(denied))
    if "*" in denied:
        return []
    # A wildcard cannot encode "everything except X" in the gateway contract.
    # When a policy mixes wildcard allow with a specific deny, drop the wildcard
    # and retain only any separately enumerated allows.
    if denied:
        allowed.discard("*")
    return sorted(
        capability
        for capability in allowed
        if not any(fnmatchcase(capability, pattern) for pattern in denied)
    )


def _bounded_capabilities(values: Iterable[str]) -> list[str]:
    result: set[str] = set()
    for value in values:
        if not isinstance(value, str) or not value.strip() or len(value.strip()) > _CAPABILITY_LIMIT:
            raise MissionDispatchError(_("Capability authority contains an invalid value"))
        result.add(value.strip())
        if len(result) > _MAX_AUTHORITY_CAPABILITIES:
            raise MissionDispatchError(_("Capability authority exceeds the safe size limit"))
    return sorted(result)


def _grants(grants: Iterable[str], capability: str) -> bool:
    values = set(grants)
    return "*" in values or capability in values


def _intersect_grants(left: Iterable[str], right: Iterable[str]) -> list[str]:
    left_set = set(left)
    right_set = set(right)
    if "*" in left_set and "*" in right_set:
        return ["*"]
    if "*" in left_set:
        return sorted(right_set)
    if "*" in right_set:
        return sorted(left_set)
    return sorted(left_set.intersection(right_set))


def _scope_resources(scope: dict[str, Any], workflow: str) -> dict[str, set[str]]:
    resources: dict[str, set[str]] = {
        "Site": {frappe.local.site},
        "Workflow": {workflow},
    }
    if scope.get("scope_mode") == "context":
        return resources
    if isinstance(scope.get("doctype"), str):
        resources.setdefault("DocType", set()).add(scope["doctype"])
    if isinstance(scope.get("docname"), str):
        resources.setdefault("Document", set()).add(scope["docname"])
    for row in scope.get("documents") or []:
        if not isinstance(row, dict):
            continue
        if isinstance(row.get("doctype"), str):
            resources.setdefault("DocType", set()).add(row["doctype"])
        name = row.get("name") or row.get("docname")
        if isinstance(name, str):
            resources.setdefault("Document", set()).add(name)
    return resources


def _rule_matches(row, resources: dict[str, set[str]]) -> bool:
    if not isinstance(row.resource_pattern, str) or not row.resource_pattern.strip():
        return False
    values = resources.get(row.resource_type, set())
    return any(fnmatchcase(value, row.resource_pattern.strip()) for value in values)


def _resource_pattern_matches(
    pattern: str | None, resources: dict[str, set[str]]
) -> bool:
    if not pattern:
        return False
    return any(
        fnmatchcase(value, pattern)
        for values in resources.values()
        for value in values
    )


def _validate_admission(response: dict[str, Any], mission: str, root_run_id: str) -> str:
    expected_path = f"{MISSIONS_PATH}/{mission}"
    if (
        response.get("missionId") != mission
        or response.get("rootRunId") != root_run_id
        or response.get("status") not in {
            "pending", "running", "pause_requested", "paused", "cancel_requested",
            "cancelling", "cancelled", "compensation_running", "compensated",
            "needs_intervention", "failed", "completed",
        }
        or response.get("pollPath") != expected_path
    ):
        raise MissionDispatchError(_("The gateway returned an invalid mission admission"))
    return expected_path


def _stored_poll_path(mission) -> str:
    path = frappe.db.get_value(
        "Muster Run",
        {"mission": mission.name, "work_unit": ["is", "not set"]},
        "gateway_poll_path",
    )
    expected = f"{MISSIONS_PATH}/{mission.name}"
    if path and path != expected:
        raise MissionDispatchError(_("Stored gateway mission route is invalid"))
    return path or expected


def _stable_id(prefix: str, *parts: Any) -> str:
    material = json.dumps(parts, ensure_ascii=False, separators=(",", ":"), default=str)
    return f"{prefix}-{sha256(material.encode()).hexdigest()}"


def _json_object(value: Any, message: str) -> dict[str, Any]:
    try:
        parsed = json.loads(value) if isinstance(value, str) and value else (value or {})
    except (TypeError, ValueError) as error:
        raise MissionDispatchError(message) from error
    if not isinstance(parsed, dict):
        raise MissionDispatchError(message)
    return parsed
