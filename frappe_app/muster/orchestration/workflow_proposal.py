from __future__ import annotations

import json
import hmac
import re
from collections import Counter
from datetime import date
from hashlib import sha256
from html import unescape
from typing import Any
from urllib.parse import quote

import frappe
from frappe import _
from frappe.utils import getdate, now_datetime, nowdate, strip_html_tags

from muster.adapters.client import GatewayBinding, GatewayClient, trusted_binding
from muster.adapters.context import permission_filtered_context
from muster.adapters.run_authority import run_authority_headers
from muster.orchestration.gateway_runtime import _caller_capabilities
from muster.orchestration.gateway_runtime import _capability_authority
from muster.orchestration.form_schema import (
    MusterFormSchemaError,
    assert_form_schema_binding,
    effective_form_schema,
)
from muster.orchestration.studio import publish_workflow
from muster.orchestration.workflow_graph import (
    browser_action_plan,
    compile_legacy_snapshot,
    effect_intent,
)

WORKFLOW_PROPOSALS_PATH = "/v1/integrations/frappe/workflow-proposals"
MAX_DESCRIPTOR_BYTES = 1_000_000
MAX_SCOPE_BYTES = 30_000
MAX_SCOPE_DOCUMENTS = 20
MAX_STEPS = 64
MAX_DEPTH = 8
WORKFLOW_BUDGET_CEILINGS = {"runtimeMs": 900_000, "toolCalls": 100, "modelCalls": 32, "tokens": 200_000, "costMicros": 5_000_000, "artifactBytes": 100_000_000}
WORKFLOW_LIMIT_CEILINGS = {"maxDepth": 8, "maxChildrenPerNode": 8, "maxActiveNodes": 64, "maxRetries": 3, "maxParallelism": 8, "maxPhases": 16, "maxSteps": 64}
CAPABILITY_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_.:-]{0,255}$")
GRAPH_ID_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_.:-]{0,255}$")
GRAPH_NODE_KINDS = {
    "plan", "agent", "subworkflow", "command", "transform", "condition",
    "parallel_map", "approval", "wait", "artifact", "verification",
    "compensation", "loop",
}
SCHEMA_KEYS = {
    "type", "title", "description", "default", "enum", "const", "properties", "required",
    "additionalProperties", "items", "minItems", "maxItems", "minimum", "maximum",
    "minLength", "maxLength", "pattern", "format", "oneOf", "anyOf", "allOf",
}
DESTRUCTIVE_REVIEW_ROLES = {"System Manager", "Muster Administrator", "Muster Approver"}


class WorkflowProposalError(frappe.ValidationError):
    pass


class WorkflowProposalClarification(WorkflowProposalError):
    """Safe, user-actionable missing information; never an execution failure."""

    pass


def _attended_persisted_value(fieldtype: str, value: Any) -> str:
    """Compare semantic editor text while keeping ordinary fields byte-exact."""
    rendered = str(value if value is not None else "")
    if fieldtype == "Text Editor":
        return unescape(strip_html_tags(rendered))
    return rendered


def _attended_field_retained(fieldtype: str, actual: Any, planned: Any) -> tuple[bool, bool]:
    """Accept exact values, or a visible server-added line on multiline text.

    Frappe ``validate``/``on_update`` hooks commonly enrich a Text field in the
    same native Save transaction.  The reviewed value must remain byte-for-byte
    at the start of the field; only a new line may follow it.  Data, Link,
    Select and every other scalar remain exact, so this cannot turn a changed
    identifier or business state into a successful verification.
    """
    if isinstance(actual, (dict, list, tuple)):
        return False, False
    persisted = _attended_persisted_value(fieldtype, actual)
    reviewed = _attended_persisted_value(fieldtype, planned)
    if persisted == reviewed:
        return True, False
    if fieldtype in {"Text", "Small Text", "Long Text", "Code"} and persisted.startswith(f"{reviewed}\n"):
        return True, True
    return False, False


def _attended_submit_requested(objective: str, doctype: str) -> bool:
    """Recognize an explicit submit request without turning Save into Submit.

    Submission remains a separate native Frappe action.  This flag only lets
    the attended controller offer that second, visibly confirmed boundary.
    """
    text = str(objective or "")
    if not re.search(r"\bsubmit(?:ted|ting)?\b", text, re.IGNORECASE):
        return False
    if re.search(
        r"\b(?:do\s+not|don't|dont|never|without)\b[^.!?]{0,80}\bsubmit(?:ted|ting)?\b",
        text,
        re.IGNORECASE,
    ):
        return False
    return bool(getattr(frappe.get_meta(doctype, cached=False), "is_submittable", False))


def proposal_attended_operation(proposal) -> str | None:
    """Read one immutable attended operation without granting execution authority."""
    try:
        graph = json.loads(proposal.compiled_graph_json)
    except (TypeError, ValueError) as error:
        raise WorkflowProposalError(_("Stored workflow proposal evidence is invalid")) from error
    canonical = json.dumps(graph, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    if sha256(canonical.encode()).hexdigest() != proposal.compiled_graph_hash:
        raise WorkflowProposalError(_("Stored compiled graph hash does not match"))
    operations = []
    for node in graph.get("nodes", []):
        execution = node.get("executionIntent") if isinstance(node, dict) else None
        if not isinstance(execution, dict):
            continue
        if execution.get("surface") == "server_effect":
            plan = effect_intent(execution.get("plan"), "workflow proposal review")
            if plan.get("capability") == "frappe.record.delete":
                operations.append("delete")
            continue
        if execution.get("surface") != "browser":
            continue
        plan = browser_action_plan(execution.get("plan"), "workflow proposal review")
        binding = plan.get("attendedCrud")
        if binding:
            operations.append(binding["operation"])
    if "delete" in operations and operations != ["delete"]:
        raise WorkflowProposalError(_("Record deletion must be the proposal's only attended action"))
    return operations[0] if len(operations) == 1 else None


def assert_destructive_reviewer(proposal, reviewer: str) -> None:
    """Require a live, independent checker for attended record deletion."""
    if proposal_attended_operation(proposal) != "delete":
        return
    if not reviewer or reviewer == "Guest" or reviewer.lower() == str(proposal.requested_by).lower():
        frappe.throw(_("Record deletion requires approval from a different user"), frappe.PermissionError)
    if reviewer != "Administrator" and not DESTRUCTIVE_REVIEW_ROLES.intersection(frappe.get_roles(reviewer)):
        frappe.throw(_("Record deletion requires a Muster Approver or administrator"), frappe.PermissionError)


def assert_attended_reviewer(proposal, reviewer: str) -> None:
    """Require separation of duties for exact-record update and delete proposals."""
    operation = proposal_attended_operation(proposal)
    if operation not in {"update", "delete"}:
        return
    if not reviewer or reviewer == "Guest" or reviewer.lower() == str(proposal.requested_by).lower():
        frappe.throw(_("Exact-record changes require approval from a different user"), frappe.PermissionError)
    if operation == "delete":
        assert_destructive_reviewer(proposal, reviewer)
        return
    roles = set(frappe.get_roles(reviewer))
    if reviewer != "Administrator" and not roles.intersection(
        {"System Manager", "Muster Administrator", "Muster Automation Manager", "Muster Approver"}
    ):
        frappe.throw(_("Record updates require an authorized Muster reviewer"), frappe.PermissionError)


def issue_destructive_approval_evidence(proposal, reviewer: str, reviewed_at) -> dict[str, str]:
    """Bind checker approval to the exact live record revision and requester RBAC."""
    assert_destructive_reviewer(proposal, reviewer)
    _verified_proposal_snapshot(proposal, proposal.requested_by)
    _verified_requested_scope(proposal)
    graph = json.loads(proposal.compiled_graph_json)
    plans = [
        node["executionIntent"]["plan"] for node in graph.get("nodes", [])
        if isinstance(node, dict) and isinstance(node.get("executionIntent"), dict)
        and node["executionIntent"].get("surface") == "browser"
    ]
    if len(plans) != 1:
        raise WorkflowProposalError(_("This proposal does not contain one attended Desk action"))
    plan = browser_action_plan(plans[0], "destructive proposal approval")
    binding = plan.get("attendedCrud")
    if not isinstance(binding, dict) or binding.get("operation") != "delete":
        raise WorkflowProposalError(_("This proposal is not an attended delete review"))
    assert_form_schema_binding(binding, user=proposal.requested_by)
    expected_plan = _host_attended_delete_plan({
        "doctype": binding["doctype"], "record_name": binding["record_name"],
        "schema_hash": binding["schema_hash"], "revision": binding["revision"],
    })
    if plan != expected_plan:
        raise WorkflowProposalError(_("The delete review plan is not the host-authored safe sequence"))
    record_revision = str(frappe.db.get_value(binding["doctype"], binding["record_name"], "modified") or "")
    if not record_revision:
        raise WorkflowProposalError(_("The reviewed record is no longer available"))
    proof = _destructive_proof_value(
        proposal, binding, record_revision, reviewer=reviewer, reviewed_at=reviewed_at,
    )
    return {"record_revision": record_revision, "approval_proof": proof}


def request_workflow_proposal(
    objective: str,
    scope: dict[str, Any],
    idempotency_key: str,
    *,
    client: GatewayClient | None = None,
    binding: GatewayBinding | None = None,
    preferred_handoff_kind: str | None = None,
    verified_record_identity: dict[str, str] | None = None,
) -> dict[str, Any]:
    objective = _bounded_text(objective, "objective", 10_000)
    if not isinstance(scope, dict):
        raise WorkflowProposalError(_("Planning scope must be a JSON object"))
    user = frappe.session.user
    if user == "Guest" or not frappe.has_permission("Muster Workflow Proposal", "create"):
        frappe.throw(_("Not permitted"), frappe.PermissionError)
    prior = frappe.db.get_value(
        "Muster Workflow Proposal", {"request_id": idempotency_key},
        ["name", "objective", "status"], as_dict=True,
    )
    if prior:
        if prior.objective != objective:
            raise WorkflowProposalError(_("Idempotency key was already used for another goal"))
        return {"proposal": prior.name, "status": prior.status, "replayed": True}

    binding = binding or trusted_binding()
    client = client or GatewayClient(binding)
    reviewed_scope = _canonical_requested_scope(scope)
    context = permission_filtered_context(reviewed_scope, user)
    attended_catalogs = _attended_form_catalogs(
        reviewed_scope, user, objective, verified_record_identity=verified_record_identity,
    )
    if preferred_handoff_kind in {"governed_change", "attended_browser"}:
        clarification = _attended_preflight_clarification(objective, attended_catalogs)
        if clarification:
            return {
                "status": "clarification", "reason": clarification,
                "replayed": False, "executed": False,
            }
    if attended_catalogs:
        context = {**context, "attended_form_catalog": [{
            "doctype": catalog["doctype"], "actions": catalog["actions"],
            "record_name": catalog["record_name"], "fields": [{
                "fieldname": field["fieldname"], "label": field["label"],
                "fieldtype": field["fieldtype"], "writable": field["writable"],
                **({"child_fields": [{
                    "fieldname": child["fieldname"], "label": child["label"],
                    "fieldtype": child["fieldtype"], "required": child["required"],
                    "writable": child["writable"],
                } for child in (field.get("child_fields") or [])]} if field.get("child_fields") else {}),
            } for field in catalog["fields"]],
            "authority": catalog["authority"],
        } for catalog in attended_catalogs]}
    allowed_capabilities = _caller_capabilities(user, "*")
    encoded_context = json.dumps(context, ensure_ascii=False, separators=(",", ":"))
    if len(encoded_context) > 64_000:
        raise WorkflowProposalError(
            _("The permission-filtered planning context is too large ({0} characters)").format(len(encoded_context))
        )
    if len(allowed_capabilities) > 256:
        raise WorkflowProposalError(
            _("The planning authority contains too many capabilities ({0})").format(len(allowed_capabilities))
        )
    request_id = _stable_request_id(idempotency_key, user)
    headers, _csrf_token = run_authority_headers(binding, user)
    response = client.request(
        "POST",
        WORKFLOW_PROPOSALS_PATH,
        payload={
            "schemaVersion": 1,
            "requestId": request_id,
            "objective": objective,
            "context": context,
            "allowedCapabilities": allowed_capabilities,
        },
        idempotency_key=idempotency_key,
        headers=headers,
        read_timeout=180,
    )
    if response.get("schemaVersion") != 1 or response.get("requestId") != request_id or response.get("status") != "proposed":
        raise WorkflowProposalError(_("The gateway returned an invalid planning acknowledgement"))
    raw_descriptor, raw_graph = response.get("proposal"), response.get("graph")
    if preferred_handoff_kind in {"governed_change", "attended_browser"}:
        try:
            raw_descriptor, raw_graph = _materialize_attended_crud_bundle(
                raw_descriptor, raw_graph, attended_catalogs, allowed_capabilities,
                requested_kind=preferred_handoff_kind, objective=objective,
            )
        except WorkflowProposalClarification as clarification:
            return {
                "status": "clarification", "reason": str(clarification),
                "replayed": False, "executed": False,
            }
    descriptor = validate_workflow_descriptor(raw_descriptor, allowed_capabilities)
    graph = validate_compiled_graph(raw_graph, descriptor, allowed_capabilities)
    run_metadata = validate_run_metadata(response.get("run"))
    canonical = json.dumps(descriptor, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    canonical_graph = json.dumps(graph, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    canonical_scope = json.dumps(reviewed_scope, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    doc = frappe.get_doc({
        "doctype": "Muster Workflow Proposal",
        "objective": objective,
        "status": "Proposed",
        "requested_by": user,
        "requested_at": now_datetime(),
        "request_id": idempotency_key,
        "gateway_request_id": request_id,
        "context_json": json.dumps(context, ensure_ascii=False, indent=2, sort_keys=True),
        "requested_scope_json": json.dumps(reviewed_scope, ensure_ascii=False, indent=2, sort_keys=True),
        "requested_scope_hash": sha256(canonical_scope.encode()).hexdigest(),
        "descriptor_json": json.dumps(descriptor, ensure_ascii=False, indent=2, sort_keys=True),
        "descriptor_hash": sha256(canonical.encode()).hexdigest(),
        "compiled_graph_json": json.dumps(graph, ensure_ascii=False, indent=2, sort_keys=True),
        "compiled_graph_hash": sha256(canonical_graph.encode()).hexdigest(),
        "capabilities_json": json.dumps(allowed_capabilities, ensure_ascii=False, indent=2),
        "run_metadata_json": json.dumps(run_metadata, ensure_ascii=False, indent=2, sort_keys=True) if run_metadata else None,
    })
    doc.insert()
    return {"proposal": doc.name, "status": doc.status, "replayed": False}


def publish_approved_proposal(
    proposal_name: str, root_agent: str, policy: str, idempotency_key: str
) -> dict[str, Any]:
    """Materialize reviewed IR into a native draft and immutable publication.

    This boundary performs no model call. It rechecks the requester's live
    authority and converts only the already admitted portable graph.
    """
    _bounded_text(proposal_name, "proposal", 140)
    _bounded_text(root_agent, "root agent", 140)
    _bounded_text(policy, "policy", 140)
    _bounded_text(idempotency_key, "idempotency key", 140)
    if frappe.db.db_type == "sqlite":
        frappe.db.sql("select name from `tabMuster Workflow Proposal` where name=%s", proposal_name)
    else:
        frappe.db.sql("select name from `tabMuster Workflow Proposal` where name=%s for update", proposal_name)
    proposal = frappe.get_doc("Muster Workflow Proposal", proposal_name)
    if not proposal.has_permission("write") or not frappe.has_permission("Muster Workflow", "create"):
        frappe.throw(_("Not permitted"), frappe.PermissionError)
    if proposal.status == "Published":
        return {
            "proposal": proposal.name,
            "workflow": proposal.published_workflow,
            "version": proposal.published_version,
            "status": proposal.status,
            "replayed": True,
            "executed": False,
        }
    if proposal.status != "Approved":
        raise WorkflowProposalError(_("Only an approved workflow proposal can be published"))
    agent = frappe.get_doc("Muster Agent", root_agent)
    if not agent.has_permission("read") or agent.status != "Active":
        raise WorkflowProposalError(_("Select an active root agent you can read"))
    policy_doc = frappe.get_doc("Muster Policy", policy)
    if not policy_doc.has_permission("read") or not policy_doc.enabled:
        raise WorkflowProposalError(_("Select an enabled policy you can read"))

    descriptor = json.loads(proposal.descriptor_json)
    # Stored maximum authority is evidence, not a permanent grant. The
    # original requester's current roles/bindings must still allow the plan.
    live_authority = _caller_capabilities(proposal.requested_by, "*")
    descriptor = validate_workflow_descriptor(descriptor, live_authority)
    graph = validate_compiled_graph(
        json.loads(proposal.compiled_graph_json), descriptor, live_authority
    )
    nodes, edges = _native_rows(graph, root_agent)
    workflow_name = _unique_workflow_name(descriptor["meta"]["name"], proposal.name)
    budget = descriptor["budget"]
    workflow = frappe.get_doc({
        "doctype": "Muster Workflow",
        "workflow_name": workflow_name,
        "status": "Draft",
        "version": 1,
        "description": descriptor["meta"]["description"],
        "root_agent": root_agent,
        "policy": policy,
        "max_duration_minutes": max(1, (int(budget["runtimeMs"]) + 59_999) // 60_000),
        "max_tool_calls": int(budget["toolCalls"]),
        "max_model_calls": int(budget["modelCalls"]),
        "max_tokens": int(budget["tokens"]),
        "max_cost": float(budget["costMicros"]) / 1_000_000,
        "max_artifact_bytes": int(budget["artifactBytes"]),
        "nodes": nodes,
        "edges": edges,
    }).insert()
    publication = publish_workflow(
        workflow.name, str(workflow.modified), f"proposal:{proposal.name}:{idempotency_key}"
    )
    proposal.db_set({
        "status": "Published",
        "published_workflow": workflow.name,
        "published_version": publication["version"],
    }, update_modified=True)
    return {
        "proposal": proposal.name,
        "workflow": workflow.name,
        "version": publication["version"],
        "snapshot_hash": publication["snapshot_hash"],
        "status": "Published",
        "replayed": False,
        "executed": False,
    }


def start_published_proposal_mission(
    proposal_name: str,
    idempotency_key: str,
    *,
    confirmed: bool | int | str,
) -> dict[str, Any]:
    """Queue one explicitly confirmed Mission from an immutable publication.

    Publication and execution intentionally remain separate boundaries. Only
    the original requester may cross this boundary, and every authority input
    is recomputed from current Frappe state before a Mission is inserted.
    """
    _bounded_text(proposal_name, "proposal", 140)
    _bounded_text(idempotency_key, "idempotency key", 140)
    if confirmed not in {True, 1, "1"}:
        raise WorkflowProposalError(_("Explicit Start confirmation is required"))
    actor = frappe.session.user
    if actor == "Guest":
        frappe.throw(_("Not permitted"), frappe.PermissionError)

    if frappe.db.db_type == "sqlite":
        frappe.db.sql("select name from `tabMuster Workflow Proposal` where name=%s", proposal_name)
    else:
        frappe.db.sql("select name from `tabMuster Workflow Proposal` where name=%s for update", proposal_name)
    proposal = frappe.get_doc("Muster Workflow Proposal", proposal_name)
    if actor != proposal.requested_by or not proposal.has_permission("read"):
        frappe.throw(_("Only the original requester can start this workflow"), frappe.PermissionError)
    user = frappe.get_cached_doc("User", actor)
    if not user.enabled or not frappe.has_permission("Muster Mission", "create"):
        frappe.throw(_("The original requester cannot create missions"), frappe.PermissionError)
    if proposal.status != "Published" or not proposal.published_workflow or not proposal.published_version:
        raise WorkflowProposalError(_("Publish this proposal before starting a mission"))

    descriptor = _verified_proposal_snapshot(proposal, actor)
    requested_scope = _verified_requested_scope(proposal)
    workflow = frappe.get_doc("Muster Workflow", proposal.published_workflow)
    if workflow.status != "Published" or workflow.published_version != proposal.published_version:
        raise WorkflowProposalError(_("The proposal publication is no longer active"))
    if not workflow.has_permission("read", user=actor):
        frappe.throw(_("The original requester cannot read the published workflow"), frappe.PermissionError)
    policy = frappe.get_doc("Muster Policy", workflow.policy)
    if not policy.enabled:
        raise WorkflowProposalError(_("The published workflow policy is not currently active"))
    agent = frappe.get_doc("Muster Agent", workflow.root_agent)
    if agent.status != "Active" or not agent.has_permission("read", user=actor):
        raise WorkflowProposalError(_("The published workflow root agent is not currently available"))

    version = frappe.get_doc("Muster Workflow Version", proposal.published_version)
    if version.docstatus != 1 or version.workflow != workflow.name:
        raise WorkflowProposalError(_("The proposal does not reference a valid published version"))
    if not version.has_permission("read", user=actor):
        frappe.throw(_("The original requester cannot read the published version"), frappe.PermissionError)
    if (
        not isinstance(version.graph_json, str)
        or not version.snapshot_hash
        or sha256(version.graph_json.encode()).hexdigest() != version.snapshot_hash
    ):
        raise WorkflowProposalError(_("The published workflow evidence hash does not match"))

    # Validate the exact portable publication against current policy, role
    # bindings, agent declarations, and requested scope before queueing work.
    published_graph = compile_legacy_snapshot(version.graph_json)
    mission_shape = frappe._dict({
        "requested_by": actor,
        "scope_json": json.dumps(requested_scope, ensure_ascii=False, sort_keys=True),
    })
    _capability_authority(mission_shape, workflow, published_graph)

    existing = frappe.db.get_value(
        "Muster Mission", {"idempotency_key": idempotency_key},
        ["name", "status", "requested_by", "source_proposal", "workflow", "workflow_version"],
        as_dict=True,
    )
    if existing:
        if (
            existing.requested_by != actor
            or existing.source_proposal != proposal.name
            or existing.workflow != workflow.name
            or existing.workflow_version != version.name
        ):
            raise WorkflowProposalError(_("Idempotency key is already bound to another mission"))
        return {"mission": existing.name, "status": existing.status, "replayed": True}

    budget = descriptor["budget"]
    mission = frappe.get_doc({
        "doctype": "Muster Mission",
        "objective": proposal.objective,
        "workflow": workflow.name,
        "workflow_version": version.name,
        "root_agent": workflow.root_agent,
        "source_proposal": proposal.name,
        "scope_json": json.dumps(requested_scope, ensure_ascii=False, sort_keys=True),
        "requested_by": actor,
        "status": "Queued",
        "idempotency_key": idempotency_key,
        "requested_at": now_datetime(),
        "budget_json": json.dumps(budget, ensure_ascii=False, sort_keys=True),
    }).insert()
    frappe.enqueue(
        "muster.orchestration.worker.dispatch_mission",
        queue="long",
        enqueue_after_commit=True,
        mission=mission.name,
        job_id=f"muster-mission-{mission.name}",
    )
    return {"mission": mission.name, "status": mission.status, "replayed": False}


def attended_proposal_preview(proposal_name: str, actor: str) -> dict[str, Any]:
    """Return a host-shaped, non-saving Desk preview for one attended proposal.

    The portable graph remains the authoritative evidence.  This projection
    deliberately omits routes, selectors, capabilities and hashes from the
    browser-facing response; the Desk controller receives only the exact form
    identity and scalar values it is allowed to stage before a separate Save
    confirmation.
    """
    _bounded_text(proposal_name, "proposal", 140)
    if actor == "Guest":
        frappe.throw(_("Not permitted"), frappe.PermissionError)
    proposal = frappe.get_doc("Muster Workflow Proposal", proposal_name)
    if proposal.requested_by != actor or not proposal.has_permission("read", user=actor):
        frappe.throw(_("Only the original requester can preview this work"), frappe.PermissionError)
    if proposal.status not in {"Proposed", "Approved"}:
        raise WorkflowProposalError(_("This proposal is no longer available for an attended preview"))

    _verified_proposal_snapshot(proposal, actor)
    _verified_requested_scope(proposal)
    graph = json.loads(proposal.compiled_graph_json)
    plans = [
        node["executionIntent"]["plan"]
        for node in graph.get("nodes", [])
        if isinstance(node, dict)
        and isinstance(node.get("executionIntent"), dict)
        and node["executionIntent"].get("surface") == "browser"
    ]
    if len(plans) != 1:
        raise WorkflowProposalError(_("This proposal does not contain one attended Desk action"))
    plan = browser_action_plan(plans[0], "attended proposal preview")
    return _attended_preview_projection(plan, actor, proposal)


def verify_attended_proposal_record(
    proposal_name: str, actor: str, record_name: str
) -> dict[str, Any]:
    """Reread the saved record and bind it to the reviewed attended values."""
    preview = attended_proposal_preview(proposal_name, actor)
    if preview["operation"] not in {"create", "update"}:
        raise WorkflowProposalError(_("This attended work does not save a record"))
    if not preview["save_authorized"]:
        raise WorkflowProposalError(_("Approve this proposal before Muster verifies a Save"))
    _bounded_text(record_name, "record name", 500)
    if preview.get("record_name") and preview["record_name"] != record_name:
        raise WorkflowProposalError(_("The saved record does not match the reviewed target"))
    doc = frappe.get_doc(preview["doctype"], record_name)
    if not doc.has_permission("read", user=actor):
        frappe.throw(_("The saved record is not readable by this user"), frappe.PermissionError)
    expected = {field["fieldname"]: field["value"] for field in preview["fields"]}
    server_adjustments = []
    for fieldname, planned in expected.items():
        actual = doc.get(fieldname)
        fieldtype = str(getattr(doc.meta.get_field(fieldname), "fieldtype", "") or "")
        retained, adjusted = _attended_field_retained(fieldtype, actual, planned)
        if not retained:
            raise WorkflowProposalError(_("The saved record did not retain every reviewed field value"))
        if adjusted:
            server_adjustments.append({
                "fieldname": fieldname,
                "value_hash": sha256(str(actual).encode()).hexdigest(),
            })
    proof = sha256(json.dumps({
        "proposal": proposal_name,
        "doctype": preview["doctype"],
        "record_name": record_name,
        "expected": expected,
        "server_adjustments": server_adjustments,
    }, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()
    return {
        "proposal": proposal_name,
        "doctype": preview["doctype"],
        "record_name": record_name,
        "verified": True,
        "proof_hash": proof,
        "server_adjusted_fields": [row["fieldname"] for row in server_adjustments],
    }


def preflight_attended_proposal_submit(
    proposal_name: str, actor: str, record_name: str, expected_revision: str,
) -> dict[str, Any]:
    """Recheck a verified draft immediately before native Frappe Submit."""
    _bounded_text(record_name, "record name", 500)
    _bounded_text(expected_revision, "record revision", 100)
    preview = attended_proposal_preview(proposal_name, actor)
    if not preview.get("submit_requested") or not preview.get("submit_authorized"):
        raise WorkflowProposalError(_("This proposal does not authorize a submitted document"))
    # This also proves that every reviewed value survived the native Save.
    verify_attended_proposal_record(proposal_name, actor, record_name)
    doc = frappe.get_doc(preview["doctype"], record_name)
    if doc.docstatus != 0:
        raise WorkflowProposalError(_("Only the reviewed draft can be submitted"))
    if str(doc.modified or "") != expected_revision:
        raise WorkflowProposalError(_("The draft changed after review; inspect it before submitting"))
    if not doc.has_permission("submit", user=actor):
        frappe.throw(_("You are not permitted to submit this document"), frappe.PermissionError)
    return {
        "proposal": proposal_name,
        "doctype": preview["doctype"],
        "record_name": record_name,
        "record_revision": expected_revision,
        "current": True,
        "docstatus": 0,
        "executed": False,
    }


def verify_attended_proposal_submit(
    proposal_name: str, actor: str, record_name: str,
) -> dict[str, Any]:
    """Seal evidence only after the native Frappe lifecycle submitted it."""
    _bounded_text(record_name, "record name", 500)
    preview = attended_proposal_preview(proposal_name, actor)
    if not preview.get("submit_requested") or not preview.get("submit_authorized"):
        raise WorkflowProposalError(_("This proposal does not authorize a submitted document"))
    doc = frappe.get_doc(preview["doctype"], record_name)
    if not doc.has_permission("read", user=actor):
        frappe.throw(_("The submitted record is not readable by this user"), frappe.PermissionError)
    if doc.docstatus != 1:
        raise WorkflowProposalError(_("Frappe has not submitted this document"))
    proof = sha256(json.dumps({
        "proposal": proposal_name,
        "doctype": preview["doctype"],
        "record_name": record_name,
        "docstatus": 1,
        "modified": str(doc.modified or ""),
        "modified_by": str(doc.modified_by or ""),
    }, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {
        "proposal": proposal_name,
        "doctype": preview["doctype"],
        "record_name": record_name,
        "docstatus": 1,
        "verified": True,
        "proof_hash": proof,
    }


def assert_attended_update_revision(
    proposal_name: str, actor: str, record_name: str, expected_revision: str
) -> dict[str, Any]:
    """Recheck an attended update immediately before its visible Save."""
    _bounded_text(record_name, "record name", 500)
    _bounded_text(expected_revision, "record revision", 100)
    preview = attended_proposal_preview(proposal_name, actor)
    if preview["operation"] != "update" or preview.get("record_name") != record_name:
        raise WorkflowProposalError(_("The update target no longer matches the reviewed proposal"))
    if preview.get("record_revision") != expected_revision:
        raise WorkflowProposalError(_("The record changed after review; reload it before preparing another update"))
    return {
        "proposal": proposal_name,
        "doctype": preview["doctype"],
        "record_name": record_name,
        "record_revision": expected_revision,
        "current": True,
        "executed": False,
    }


def preflight_attended_proposal_save(
    proposal_name: str,
    actor: str,
    record_name: str = "",
    expected_revision: str = "",
) -> dict[str, Any]:
    """Rebuild schema, proposal and live RBAC immediately before native Save.

    This boundary is read-only. The browser must visibly click the host
    application's native Create/Save control and then seal the saved values via
    ``verify_attended_proposal_record``.
    """
    preview = attended_proposal_preview(proposal_name, actor)
    if preview["operation"] not in {"create", "update"}:
        raise WorkflowProposalError(_("This attended work does not save a record"))
    if not preview.get("save_authorized"):
        raise WorkflowProposalError(_("Approve this proposal before saving the reviewed form"))
    if preview["operation"] == "create":
        if record_name or expected_revision:
            raise WorkflowProposalError(_("A create confirmation cannot reuse an existing record binding"))
    else:
        _bounded_text(record_name, "record name", 500)
        _bounded_text(expected_revision, "record revision", 100)
        if preview.get("record_name") != record_name:
            raise WorkflowProposalError(_("The update target no longer matches the reviewed proposal"))
        if preview.get("record_revision") != expected_revision:
            raise WorkflowProposalError(_("The record changed after review; reload it before preparing another update"))
    return {
        "proposal": proposal_name,
        "operation": preview["operation"],
        "doctype": preview["doctype"],
        "record_name": preview.get("record_name"),
        "record_revision": preview.get("record_revision"),
        "fields": preview["fields"],
        "current": True,
        "executed": False,
    }


def assert_attended_delete_revision(
    proposal_name: str, actor: str, record_name: str, expected_revision: str,
    expected_approval_proof: str,
) -> dict[str, Any]:
    """Recheck record identity, delete RBAC and independent approval before menu reveal."""
    _bounded_text(record_name, "record name", 500)
    _bounded_text(expected_revision, "record revision", 100)
    _bounded_text(expected_approval_proof, "approval proof", 64)
    preview = attended_proposal_preview(proposal_name, actor)
    if preview["operation"] != "delete" or preview.get("record_name") != record_name:
        raise WorkflowProposalError(_("The delete target no longer matches the reviewed proposal"))
    if not preview.get("delete_authorized") or preview.get("record_revision") != expected_revision:
        raise WorkflowProposalError(_("The record or destructive approval changed; prepare another delete review"))
    actual_proof = preview.get("approval_proof")
    if not isinstance(actual_proof, str) or not hmac.compare_digest(actual_proof, expected_approval_proof):
        raise WorkflowProposalError(_("The destructive approval evidence no longer matches"))
    return {
        "proposal": proposal_name, "doctype": preview["doctype"], "record_name": record_name,
        "record_revision": expected_revision, "approval_proof": actual_proof,
        "current": True, "executed": False,
    }


def trusted_attended_delete_snapshot(proposal_name: str, actor: str) -> dict[str, Any]:
    """Return server-only evidence for a final attended delete authorization.

    Unlike ``attended_proposal_preview`` this includes the hash of the exact
    host-authored browser plan.  It must never be returned directly to Desk.
    """
    preview = attended_proposal_preview(proposal_name, actor)
    if preview.get("operation") != "delete" or not preview.get("delete_authorized"):
        raise WorkflowProposalError(_("This proposal has no approved attended deletion"))
    proposal = frappe.get_doc("Muster Workflow Proposal", proposal_name)
    graph = json.loads(proposal.compiled_graph_json)
    plans = [
        node["executionIntent"]["plan"]
        for node in graph.get("nodes", [])
        if isinstance(node, dict)
        and isinstance(node.get("executionIntent"), dict)
        and node["executionIntent"].get("surface") == "browser"
    ]
    if len(plans) != 1:
        raise WorkflowProposalError(_("This proposal does not contain one attended Desk action"))
    plan = browser_action_plan(plans[0], "attended delete authorization")
    canonical = json.dumps(plan, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return {**preview, "plan_hash": sha256(canonical.encode()).hexdigest()}


def _attended_preview_projection(plan: dict[str, Any], actor: str, proposal) -> dict[str, Any]:
    binding = plan.get("attendedCrud")
    if not isinstance(binding, dict) or binding.get("operation") not in {"create", "update", "delete"}:
        raise WorkflowProposalError(_("This proposal is not an attended form change"))
    snapshot = assert_form_schema_binding(binding, user=actor)
    operation = binding["operation"]
    if operation == "delete":
        expected_plan = _host_attended_delete_plan({
            "doctype": binding["doctype"], "record_name": binding["record_name"],
            "schema_hash": binding["schema_hash"], "revision": binding["revision"],
        })
        if plan != expected_plan:
            raise WorkflowProposalError(_("The delete review plan is not the host-authored safe sequence"))
        record_revision = str(frappe.db.get_value(binding["doctype"], binding["record_name"], "modified") or "")
        if not record_revision:
            raise WorkflowProposalError(_("The reviewed record is no longer available"))
        approval_proof = _destructive_approval_proof(proposal, binding, record_revision)
        return {
            "proposal": proposal.name, "objective": proposal.objective, "operation": "delete",
            "doctype": binding["doctype"], "record_name": binding["record_name"],
            "record_revision": record_revision, "approval_proof": approval_proof,
            "fields": [], "delete_requires_confirmation": True,
            "delete_authorized": approval_proof is not None, "executed": False,
        }
    save_indexes = [
        index for index, action in enumerate(plan["actions"])
        if action.get("kind") == "click"
        and action.get("target", {}).get("kind") == "role"
        and action.get("target", {}).get("role") == "button"
        and action.get("target", {}).get("name", "").lower() == "save"
    ]
    if save_indexes != [len(plan["actions"]) - 1]:
        raise WorkflowProposalError(_("The attended plan must pause at one final Save action"))
    values: dict[str, dict[str, Any]] = {}
    for action in plan["actions"][:-1]:
        if action.get("kind") not in {"fill", "select"}:
            continue
        fieldname = action.get("field")
        if fieldname in values:
            raise WorkflowProposalError(_("The attended plan changes a field more than once"))
        live_field = next((field for field in snapshot["fields"] if field["fieldname"] == fieldname), None)
        raw_value = action["value"] if action["kind"] == "fill" else action["option"]
        projected: dict[str, Any] = {
            "fieldname": fieldname,
            "control": action["kind"],
            "value": raw_value,
        }
        if live_field and live_field.get("fieldtype") in {"Table", "Table MultiSelect"}:
            try:
                rows = json.loads(raw_value)
            except (TypeError, ValueError) as error:
                raise WorkflowProposalError(_("The reviewed child rows are invalid")) from error
            child_fields = {
                child["fieldname"]: child for child in (live_field.get("child_fields") or [])
                if isinstance(child, dict) and child.get("fieldname")
            }
            if not isinstance(rows, list) or not rows or len(rows) > 20:
                raise WorkflowProposalError(_("The reviewed child rows are invalid"))
            projected_rows = []
            for row in rows:
                if not isinstance(row, dict) or not row or len(row) > 40:
                    raise WorkflowProposalError(_("The reviewed child rows are invalid"))
                projected_row = []
                for child_name, child_value in row.items():
                    child = child_fields.get(child_name)
                    if not child or not child.get("writable") or isinstance(child_value, (dict, list)) or child_value is None:
                        raise WorkflowProposalError(_("A reviewed child field is no longer writable"))
                    projected_row.append({
                        "fieldname": child_name, "label": child["label"],
                        "control": "select" if child["fieldtype"] == "Select" else "fill",
                        "value": str(child_value),
                    })
                projected_rows.append(projected_row)
            projected = {
                "fieldname": fieldname, "control": "table", "rows": projected_rows,
                "child_doctype": live_field.get("child_doctype"),
            }
        values[fieldname] = projected
    if sorted(values) != binding["fields"]:
        raise WorkflowProposalError(_("The attended plan fields do not match its reviewed form binding"))
    live_fields = {field["fieldname"]: field for field in snapshot["fields"]}
    projected_fields = []
    for fieldname in binding["fields"]:
        field = live_fields.get(fieldname)
        operation_writable = field and field.get(
            "create_writable" if operation == "create" else "update_writable", field["writable"]
        )
        if not field or not operation_writable:
            raise WorkflowProposalError(_("A reviewed field is no longer writable"))
        projected_fields.append({
            **values[fieldname],
            "label": field["label"],
        })
    record_revision = None
    if operation == "update":
        record_revision = str(frappe.db.get_value(binding["doctype"], binding["record_name"], "modified") or "")
        if not record_revision:
            raise WorkflowProposalError(_("The reviewed record is no longer available"))
    submit_requested = operation in {"create", "update"} and _attended_submit_requested(
        proposal.objective, binding["doctype"]
    )
    return {
        "proposal": proposal.name,
        "objective": proposal.objective,
        "operation": operation,
        "doctype": binding["doctype"],
        "record_name": binding.get("record_name"),
        "record_revision": record_revision,
        "fields": projected_fields,
        "save_requires_confirmation": True,
        "save_authorized": proposal.status == "Approved",
        "submit_requested": submit_requested,
        "submit_requires_confirmation": submit_requested,
        "submit_authorized": submit_requested and proposal.status == "Approved",
        "executed": False,
    }


def _destructive_approval_proof(proposal, binding: dict[str, Any], record_revision: str) -> str | None:
    if proposal.status != "Approved":
        return None
    assert_destructive_reviewer(proposal, str(proposal.reviewed_by or ""))
    stored_revision = str(proposal.destructive_record_revision or "")
    stored_proof = str(proposal.destructive_approval_proof or "")
    if not proposal.reviewed_at or not stored_revision or not stored_proof:
        raise WorkflowProposalError(_("Destructive approval evidence is incomplete"))
    if record_revision != stored_revision:
        raise WorkflowProposalError(_("The record changed after destructive approval; prepare and approve another proposal"))
    expected = _destructive_proof_value(proposal, binding, record_revision)
    if len(stored_proof) != 64 or not hmac.compare_digest(expected, stored_proof):
        raise WorkflowProposalError(_("Destructive approval evidence does not match the reviewed proposal"))
    return stored_proof


def _destructive_proof_value(
    proposal, binding: dict[str, Any], record_revision: str, *,
    reviewer: str | None = None, reviewed_at=None,
) -> str:
    evidence = {
        "schema_version": 1, "proposal": proposal.name,
        "requester": proposal.requested_by, "reviewer": reviewer or proposal.reviewed_by,
        "reviewed_at": str(reviewed_at or proposal.reviewed_at),
        "descriptor_hash": proposal.descriptor_hash, "compiled_graph_hash": proposal.compiled_graph_hash,
        "doctype": binding["doctype"], "record_name": binding["record_name"],
        "record_revision": record_revision,
    }
    return sha256(json.dumps(evidence, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()).hexdigest()


def _verified_proposal_snapshot(proposal, actor: str) -> dict[str, Any]:
    try:
        descriptor = json.loads(proposal.descriptor_json)
        compiled_graph = json.loads(proposal.compiled_graph_json)
    except (TypeError, ValueError) as error:
        raise WorkflowProposalError(_("Stored workflow proposal evidence is invalid")) from error
    canonical_descriptor = json.dumps(
        descriptor, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    )
    canonical_graph = json.dumps(
        compiled_graph, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    )
    if sha256(canonical_descriptor.encode()).hexdigest() != proposal.descriptor_hash:
        raise WorkflowProposalError(_("Stored workflow descriptor hash does not match"))
    if sha256(canonical_graph.encode()).hexdigest() != proposal.compiled_graph_hash:
        raise WorkflowProposalError(_("Stored compiled graph hash does not match"))
    live_authority = _caller_capabilities(actor, "*")
    descriptor = validate_workflow_descriptor(descriptor, live_authority)
    validate_compiled_graph(compiled_graph, descriptor, live_authority)
    return descriptor


def _verified_requested_scope(proposal) -> dict[str, Any]:
    """Return only the immutable, reviewed resource scope attached at planning."""
    raw = proposal.requested_scope_json or "{}"
    try:
        value = json.loads(raw)
    except (TypeError, ValueError) as error:
        raise WorkflowProposalError(_("Stored workflow scope evidence is invalid")) from error
    normalized = _canonical_requested_scope(value)
    canonical = json.dumps(normalized, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    expected = proposal.requested_scope_hash
    if not expected or sha256(canonical.encode()).hexdigest() != expected:
        raise WorkflowProposalError(_("Stored workflow scope hash does not match"))
    return normalized


def _attended_form_catalogs(
    scope: dict[str, Any], user: str, objective: str, *,
    verified_record_identity: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    """Build a bounded permission-filtered candidate catalog from page hint + prompt terms."""
    selected = scope.get("doctype")
    verified_name = None
    if verified_record_identity is not None:
        verified_doctype = (
            verified_record_identity.get("doctype")
            if isinstance(verified_record_identity, dict)
            else None
        )
        if (
            not isinstance(verified_record_identity, dict)
            or set(verified_record_identity) != {"doctype", "record_name", "action", "evidence_hash"}
            or not isinstance(verified_doctype, str)
            or not verified_doctype
            or (selected is not None and verified_doctype != selected)
            or verified_record_identity.get("action") not in {"update", "delete"}
            or not isinstance(verified_record_identity.get("record_name"), str)
            or not verified_record_identity["record_name"]
            or not isinstance(verified_record_identity.get("evidence_hash"), str)
            or len(verified_record_identity["evidence_hash"]) != 64
        ):
            raise WorkflowProposalError(_("Verified record identity evidence is invalid"))
        # On a generic Mission Control route there is intentionally no DocType
        # in the page scope.  The exact-record continuation is host-verified
        # against live metadata, record existence and the caller's RBAC before
        # reaching this function, so it becomes the authority ceiling.  A
        # concrete page DocType remains stricter and must match exactly.
        if selected is None:
            selected = verified_doctype
        verified_name = verified_record_identity["record_name"]
    tokens = {
        token.lower() for token in re.findall(r"[A-Za-z][A-Za-z0-9_-]{2,}", objective)
        if token.lower() not in {"the", "and", "for", "with", "from", "into", "this", "that", "create", "update", "delete", "remove", "change", "edit", "read", "show", "open", "record", "document", "new"}
    }
    # A DocType resolved by the native Desk/SPA surface is an authority ceiling,
    # not merely a ranking hint.  Prompt discovery is useful on a generic home
    # page, but allowing it here lets similarly named DocTypes (for example CRM
    # Lead and ERPNext Lead) escape the form the user is actually viewing.
    names: set[str] = {selected} if selected else set()
    if not selected and tokens:
        # Resolve exact DocType phrases before fuzzy token discovery. A merged
        # clarification can mention many business nouns (Customer, Status,
        # Date, and so on); an alphabetical fuzzy-result limit must never evict
        # the explicitly named target such as ``Service Visit``.
        words = re.findall(r"[A-Za-z][A-Za-z0-9_-]*", objective)[:120]
        phrases: list[str] = []
        seen_phrases: set[str] = set()
        for size in range(1, 7):
            for index in range(0, len(words) - size + 1):
                phrase = " ".join(words[index:index + size])
                if len(phrase) > 140 or phrase.lower() in seen_phrases:
                    continue
                seen_phrases.add(phrase.lower())
                phrases.append(phrase)
                if len(phrases) >= 600:
                    break
            if len(phrases) >= 600:
                break
        if phrases:
            exact_rows = frappe.get_all(
                "DocType", filters={"istable": 0, "name": ["in", phrases]},
                fields=["name"], order_by="name asc", limit_page_length=50,
            )
            names.update(
                str(row.name if hasattr(row, "name") else row.get("name"))
                for row in exact_rows
                if (row.name if hasattr(row, "name") else row.get("name"))
            )
        rows = frappe.get_all(
            "DocType", filters={"istable": 0},
            or_filters=[["name", "like", f"%{token}%"] for token in sorted(tokens)],
            fields=["name"], order_by="name asc", limit_page_length=50,
        )
        names.update(str(row.name if hasattr(row, "name") else row.get("name")) for row in rows if (row.name if hasattr(row, "name") else row.get("name")))
    normalized_objective = re.sub(r"[^a-z0-9]+", " ", objective.lower()).strip()
    ranked = sorted(names, key=lambda name: (
        0 if name == selected else 1,
        -(20 if re.sub(r"[^a-z0-9]+", " ", name.lower()).strip() in normalized_objective else 0)
        - len(set(re.findall(r"[a-z0-9]+", name.lower())) & tokens),
        name.lower(),
    ))[:6]
    catalogs = []
    for doctype in ranked:
        try:
            record_names = []
            if doctype == selected and verified_name:
                record_names.append(verified_name)
            if not verified_name and doctype == selected and scope.get("docname"):
                record_names.append(str(scope["docname"]))
            if not verified_name:
                record_names.extend(
                    str(row["name"])
                    for row in (scope.get("documents") or [])
                    if isinstance(row, dict) and row.get("doctype") == doctype and row.get("name")
                )
            unique_names = list(dict.fromkeys(record_names))
            identity_state = "unique" if len(unique_names) == 1 else "ambiguous" if unique_names else "missing"
            catalogs.append(_attended_form_catalog(
                doctype, unique_names[0] if len(unique_names) == 1 else None, user,
                record_identity_state=identity_state,
            ))
        except (frappe.PermissionError, MusterFormSchemaError):
            continue
    exact = _exact_attended_catalog(catalogs, objective)
    return [exact] if exact else catalogs


def _exact_attended_catalog(
    catalogs: list[dict[str, Any]], objective: str,
) -> dict[str, Any] | None:
    """Resolve one longest explicitly named live DocType from the request."""
    normalized = f" {re.sub(r'[^a-z0-9]+', ' ', objective.casefold()).strip()} "
    matches = [
        catalog for catalog in catalogs
        if isinstance(catalog, dict)
        and isinstance(catalog.get("doctype"), str)
        and f" {re.sub(r'[^a-z0-9]+', ' ', catalog['doctype'].casefold()).strip()} " in normalized
    ]
    if not matches:
        return None
    longest = max(len(str(catalog["doctype"])) for catalog in matches)
    winners = [catalog for catalog in matches if len(str(catalog["doctype"])) == longest]
    return winners[0] if len(winners) == 1 else None


def _attended_form_catalog(
    doctype: str, record_name: str | None, user: str, *, record_identity_state: str = "missing",
) -> dict[str, Any]:
    snapshot = effective_form_schema(doctype, user=user)
    fields = [
        {
            "fieldname": field["fieldname"], "label": field["label"],
            "fieldtype": field["fieldtype"], "required": field["required"],
            "options": field.get("options"),
            "has_default": field["has_default"], "writable": field["writable"],
            "create_writable": field.get("create_writable", field["writable"]),
            "update_writable": field.get("update_writable", field["writable"]),
            "source": (field.get("provenance") or {}).get("source", "doctype_field"),
            "property_setter_count": len((field.get("provenance") or {}).get("property_setters") or []),
            **({
                "child_doctype": field.get("child_doctype"),
                "child_fields": [{
                    key: child.get(key) for key in (
                        "fieldname", "label", "fieldtype", "options", "required", "has_default", "read_only", "writable",
                    )
                } for child in (field.get("child_fields") or [])[:80]],
            } if field.get("fieldtype") in {"Table", "Table MultiSelect"} else {}),
        }
        for field in snapshot["fields"][:120]
    ]
    if record_name and (
        not frappe.db.exists(doctype, record_name)
        or not frappe.has_permission(doctype, "read", doc=record_name, user=user)
    ):
        record_name = None
        record_identity_state = "unavailable"
    actions = ["read"]
    if snapshot["authority"]["create"]:
        actions.append("create")
    if record_name and snapshot["authority"]["write"]:
        if frappe.has_permission(doctype, "write", doc=record_name, user=user):
            actions.append("update")
    if record_name and snapshot["authority"].get("delete"):
        if frappe.has_permission(doctype, "delete", doc=record_name, user=user):
            actions.append("delete")
    return {
        "doctype": doctype, "record_name": record_name, "actions": actions,
        "record_identity_state": record_identity_state,
        "authority": snapshot["authority"], "fields": fields,
        "doctype_property_setter_count": len(snapshot.get("doctype_property_setters") or []),
        "schema_hash": snapshot["schema_hash"], "revision": snapshot["revision"],
    }


def _materialize_attended_crud_bundle(
    descriptor_value: Any, graph_value: Any, catalogs: list[dict[str, Any]] | dict[str, Any] | None,
    allowed_capabilities: list[str], *, requested_kind: str = "governed_change",
    objective: str | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Replace a model-selected record intent with a host-authored Desk plan.

    The provider may choose create/update/delete and bounded values only from the
    supplied catalog. Routes, labels, semantic actions, schema hashes and
    revision evidence are authored here and never accepted from model output.
    """
    if isinstance(catalogs, dict):
        catalogs = [catalogs]
    if not catalogs:
        raise WorkflowProposalError(_("Name a live-readable DocType before preparing this attended change"))
    try:
        descriptor = json.loads(json.dumps(descriptor_value, ensure_ascii=False, allow_nan=False))
        graph = json.loads(json.dumps(graph_value, ensure_ascii=False, allow_nan=False))
    except (TypeError, ValueError) as error:
        raise WorkflowProposalError(_("The attended workflow proposal is not valid JSON")) from error
    available = set(allowed_capabilities)
    converted = 0
    requested_action = _requested_attended_action(objective or "")

    def convert(execution: Any, capabilities: Any) -> tuple[dict[str, Any], list[str], bool]:
        if not isinstance(execution, dict) or not isinstance(execution.get("plan"), dict):
            return execution, capabilities, False
        if execution.get("surface") == "browser":
            if requested_kind != "attended_browser":
                raise WorkflowProposalError(_("A governed change must select values through the host form catalog"))
            if requested_action in {"create", "update", "delete"}:
                raise WorkflowProposalClarification(
                    _("What form details should I use for this {0}?").format(requested_action)
                )
            raw_actions = execution["plan"].get("actions")
            if not isinstance(raw_actions, list) or any(not isinstance(item, dict) or item.get("kind") not in {"navigate", "read_visible"} for item in raw_actions):
                raise WorkflowProposalError(_("An attended read may not smuggle model-authored form mutations"))
            model_doctypes = {item.get("doctype") for item in raw_actions if isinstance(item.get("doctype"), str)}
            candidates = [catalog for catalog in catalogs if catalog["doctype"] in model_doctypes] if model_doctypes else catalogs
            if len(candidates) != 1:
                raise WorkflowProposalError(_("The attended read target is ambiguous; name one permitted DocType"))
            plan = _host_attended_read_plan(candidates[0])
            required = _browser_plan_capabilities(plan)
            if "*" not in available and not required.issubset(available):
                raise WorkflowProposalError(_("The live actor lacks an attended browser capability"))
            return {"surface": "browser", "plan": plan}, sorted(required), True
        if execution.get("surface") != "server_effect":
            return execution, capabilities, False
        intent = execution["plan"]
        operation = intent.get("operation")
        if intent.get("capability") not in {"frappe.record.create", "frappe.record.update", "frappe.record.delete"} or not isinstance(operation, dict):
            return execution, capabilities, False
        action = operation.get("action")
        catalog = next((item for item in catalogs if item["doctype"] == operation.get("doctype")), None)
        if not catalog or operation.get("kind") != "record" or action not in {"create", "update", "delete"}:
            raise WorkflowProposalError(_("The change selected a DocType or action outside the live form catalog"))
        if requested_action and action != requested_action:
            raise WorkflowProposalClarification(
                _("Should I create, update, or delete a record?")
            )
        if action in {"update", "delete"} and catalog.get("record_identity_state", "unique" if catalog.get("record_name") else "missing") != "unique":
            raise WorkflowProposalClarification(
                _("Which exact {0} record should I {1}?").format(catalog["doctype"], action)
            )
        if action not in catalog["actions"]:
            raise WorkflowProposalError(_("The live actor cannot perform this form action"))
        values = operation.get("values")
        if action == "delete":
            if values is not None or intent.get("approvalClass") != "dual_control":
                raise WorkflowProposalError(_("Attended deletion requires a value-free dual-control intent"))
            plan = _host_attended_delete_plan(catalog)
        else:
            if not isinstance(values, dict) or not values or len(values) > 100:
                raise WorkflowProposalError(_("The attended change requires bounded form values"))
            # A clarification reply is authoritative for the one field that
            # Frappe itself asked the user to resolve.  The model still sees
            # the full, transparent merged request and can therefore repeat
            # the superseded value from the original sentence.  Resolve that
            # conflict at the host boundary before compiling the browser plan.
            # The override is deliberately narrow: it must match one visible
            # catalog label and is then subjected to the ordinary Link/Select,
            # RBAC, schema and grounding checks below.
            explicit_values, explicit_rows = _objective_labeled_attended_values(objective, catalog)
            values = {
                **values,
                **explicit_values,
                **_clarified_attended_values(objective, catalog),
            }
            for table_field, explicit_row in explicit_rows.items():
                existing_rows = values.get(table_field)
                if isinstance(existing_rows, list) and len(existing_rows) == 1 and isinstance(existing_rows[0], dict):
                    values[table_field] = [{**existing_rows[0], **explicit_row}]
                else:
                    values[table_field] = [explicit_row]
            plan = _host_attended_browser_plan(action, values, catalog, objective=objective)
        required = _browser_plan_capabilities(plan)
        if "*" not in available and not required.issubset(available):
            raise WorkflowProposalError(_("The live actor lacks an attended browser capability"))
        return {"surface": "browser", "plan": plan}, sorted(required), True

    def walk_steps(steps: Any) -> None:
        nonlocal converted
        if not isinstance(steps, list):
            return
        for step in steps:
            if not isinstance(step, dict):
                continue
            if step.get("kind") == "execution":
                execution, capabilities, changed = convert(step.get("execution"), step.get("capabilities"))
                if changed:
                    step["execution"], step["capabilities"] = execution, capabilities
                    converted += 1
            for key in ("steps", "branches", "subagents"):
                walk_steps(step.get(key))

    walk_steps(descriptor.get("steps") if isinstance(descriptor, dict) else None)
    graph_converted = 0
    for node in graph.get("nodes", []) if isinstance(graph, dict) else []:
        execution, capabilities, changed = convert(node.get("executionIntent"), node.get("requestedCapabilities"))
        if changed:
            node["executionIntent"], node["requestedCapabilities"] = execution, capabilities
            graph_converted += 1
    if converted < 1 or converted != graph_converted:
        raise WorkflowProposalError(_("The governed change did not compile to one matching attended CRUD plan"))
    return descriptor, graph


def _clarified_attended_values(
    objective: str | None, catalog: dict[str, Any],
) -> dict[str, str]:
    """Recover field answers from Muster's signed clarification transcript.

    Ask stores a transparent merged objective so the user and audit record can
    see both the original request and the answer.  That transcript is not an
    instruction to keep an earlier invalid field value: the final answer must
    replace the single field named by Muster's clarification.  Only an exact,
    unique live form label is admitted here; validation remains the job of
    ``_host_attended_browser_plan``.
    """
    if not isinstance(objective, str):
        return {}
    marker = "\n\nClarification requested by Muster:\n"
    answer_marker = "\n\nUser's answer to that clarification:\n"
    if marker not in objective or answer_marker not in objective:
        return {}
    recovered: dict[str, str] = {}
    for transcript in objective.split(marker)[1:]:
        if answer_marker not in transcript:
            continue
        question, remainder = transcript.split(answer_marker, 1)
        answer = remainder.split(marker, 1)[0].strip()
        question = re.sub(r"\s+", " ", question).strip()
        if not answer or len(answer) > 500 or "\n" in answer or "\r" in answer:
            continue
        label = None
        for pattern in (
            r"Which existing permitted value should I use for (.+?)\?",
            r"What value should I use for (.+?)\?",
            r"Choose an available value for (.+?):(?:\s.*)?",
        ):
            match = re.fullmatch(pattern, question, flags=re.IGNORECASE)
            if match:
                label = match.group(1).strip()
                break
        if not label:
            continue
        matches = [
            field for field in catalog.get("fields", [])
            if isinstance(field, dict) and str(field.get("label") or "").casefold() == label.casefold()
        ]
        if len(matches) == 1 and matches[0].get("fieldname"):
            recovered[str(matches[0]["fieldname"])] = answer
    return recovered


def _clarified_labeled_attended_values(
    objective: str | None, catalog: dict[str, Any],
) -> tuple[dict[str, str], dict[str, dict[str, str]]]:
    if not isinstance(objective, str):
        return {}, {}
    marker = "\n\nClarification requested by Muster:\n"
    answer_marker = "\n\nUser's answer to that clarification:\n"
    parent: dict[str, str] = {}
    children: dict[str, dict[str, str]] = {}
    for transcript in objective.split(marker)[1:]:
        if answer_marker not in transcript:
            continue
        answer = transcript.split(answer_marker, 1)[1].split(marker, 1)[0].strip()
        if not answer or len(answer) > 500:
            continue
        answer_parent, answer_children = _objective_labeled_attended_values(answer, catalog)
        if not answer_parent and not answer_children:
            question = transcript.split(answer_marker, 1)[0].strip()
            label_match = re.fullmatch(
                r"(?:Which existing permitted value should I use for|What value should I use for) (.+?)\?",
                re.sub(r"\s+", " ", question), flags=re.IGNORECASE,
            )
            label = label_match.group(1).strip() if label_match else ""
            matches: list[tuple[str | None, dict[str, Any]]] = []
            for field in catalog.get("fields", []):
                if not isinstance(field, dict):
                    continue
                if str(field.get("label") or "").casefold() == label.casefold() and field.get("writable"):
                    matches.append((None, field))
                if field.get("fieldtype") not in {"Table", "Table MultiSelect"}:
                    continue
                for child in field.get("child_fields") or []:
                    if (
                        isinstance(child, dict) and child.get("writable")
                        and str(child.get("label") or "").casefold() == label.casefold()
                    ):
                        matches.append((str(field.get("fieldname") or ""), child))
            if len(matches) == 1:
                table, field = matches[0]
                normalized = _normalize_explicit_attended_value(str(field.get("fieldtype") or ""), answer)
                if normalized is not None and field.get("fieldname"):
                    if table:
                        answer_children = {table: {str(field["fieldname"]): normalized}}
                    else:
                        answer_parent = {str(field["fieldname"]): normalized}
        parent.update(answer_parent)
        for table, row in answer_children.items():
            children.setdefault(table, {}).update(row)
    return parent, children


def _objective_labeled_attended_values(
    objective: str | None, catalog: dict[str, Any],
) -> tuple[dict[str, str], dict[str, dict[str, str]]]:
    """Recover explicit ``Label: value`` pairs from the user's original request.

    Labels and field-name aliases come only from the effective live schema. An
    alias is admitted only when it identifies exactly one writable parent or
    child field, so provider field-mapping mistakes cannot replace an explicit
    user value or cross table boundaries.
    """
    if not isinstance(objective, str):
        return {}, {}
    original = objective.split("\n\nClarification requested by Muster:\n", 1)[0]
    candidates: list[tuple[str | None, str, str, bool, str]] = []
    for field in catalog.get("fields", []):
        if not isinstance(field, dict) or not field.get("fieldname"):
            continue
        fieldname = str(field["fieldname"])
        fieldtype = str(field.get("fieldtype") or "")
        required = bool(field.get("required"))
        candidates.append((None, fieldname, fieldtype, required, str(field.get("label") or fieldname)))
        candidates.append((None, fieldname, fieldtype, required, fieldname.replace("_", " ")))
        if field.get("fieldtype") not in {"Table", "Table MultiSelect"}:
            continue
        for child in field.get("child_fields") or []:
            if not isinstance(child, dict) or not child.get("fieldname") or not child.get("writable"):
                continue
            child_name = str(child["fieldname"])
            child_type = str(child.get("fieldtype") or "")
            required = bool(child.get("required"))
            child_label = str(child.get("label") or child_name)
            candidates.append((fieldname, child_name, child_type, required, child_label))
            candidates.append((fieldname, child_name, child_type, required, child_name.replace("_", " ")))
            if child_type == "Link" and required:
                short_label = re.sub(r"(?i)\s+(?:code|id)$", "", child_label).strip()
                if short_label != child_label:
                    candidates.append((fieldname, child_name, child_type, required, short_label))

    aliases: dict[str, list[tuple[str | None, str, str, bool]]] = {}
    display: dict[str, str] = {}
    for table, fieldname, fieldtype, required, raw_alias in candidates:
        alias = re.sub(r"\s+", " ", raw_alias).strip()
        if len(alias) < 2:
            continue
        key = alias.casefold()
        aliases.setdefault(key, []).append((table, fieldname, fieldtype, required))
        display[key] = alias
    resolved: dict[str, tuple[str | None, str, str, bool] | None] = {}
    alternatives: dict[str, list[tuple[str | None, str, str, bool]]] = {}
    for key, rows in aliases.items():
        distinct = list(dict.fromkeys(rows))
        alternatives[key] = distinct
        if len(distinct) == 1:
            resolved[key] = distinct[0]
            continue
        required_links = [row for row in distinct if row[2] == "Link" and row[3]]
        parent = [row for row in distinct if row[0] is None]
        same_field = len({row[1] for row in distinct}) == 1 and len({row[2] for row in distinct}) == 1
        resolved[key] = (
            required_links[0] if len(required_links) == 1
            else parent[0] if same_field and len(parent) == 1
            else None
        )
    if not resolved:
        return {}, {}
    pattern = re.compile(
        r"(?:^|[:,.;]\s+)(?:add\s+|use\s+|set\s+)?(" + "|".join(
            re.escape(display[key]) for key in sorted(resolved, key=lambda item: (-len(display[item]), item))
        ) + r")\b\s*(?::|=|\bis\b|\bto\b)?\s*",
        flags=re.IGNORECASE,
    )
    matches = list(pattern.finditer(original))
    parsed: list[tuple[str, str]] = []
    for index, match in enumerate(matches):
        value_end = matches[index + 1].start() if index + 1 < len(matches) else len(original)
        value = original[match.end():value_end].strip(" \t\r\n,;.")
        value = re.split(r"[.!?]\s+", value, maxsplit=1)[0].strip(" \t\r\n,;.")
        if not value or len(value) > 500 or "\n" in value or "\r" in value:
            continue
        parsed.append((re.sub(r"\s+", " ", match.group(1)).strip().casefold(), value))

    parent: dict[str, str] = {}
    child_rows: dict[str, dict[str, str]] = {}

    def admit(target: tuple[str | None, str, str, bool], raw_value: str) -> None:
        table, fieldname, fieldtype, _required = target
        if fieldtype in {
            "Link", "Date", "Datetime", "Time", "Select", "Autocomplete",
        }:
            raw_value = raw_value.split(",", 1)[0].strip()
        normalized = _normalize_explicit_attended_value(fieldtype, raw_value)
        if normalized is None:
            return
        if table is None:
            parent[fieldname] = normalized
        else:
            child_rows.setdefault(table, {})[fieldname] = normalized

    for key, value in parsed:
        target = resolved.get(key)
        if target:
            admit(target, value)

    table_evidence = {table: len(row) for table, row in child_rows.items()}
    for key, value in parsed:
        if resolved.get(key):
            continue
        candidates = [row for row in alternatives.get(key, []) if row[0] is not None]
        if not candidates:
            continue
        best = max((table_evidence.get(row[0], 0) for row in candidates), default=0)
        winners = [row for row in candidates if best > 0 and table_evidence.get(row[0], 0) == best]
        if len(winners) == 1:
            admit(winners[0], value)
    return parent, child_rows


def _normalize_explicit_attended_value(fieldtype: str, value: str) -> str | None:
    if fieldtype in {"Int", "Float", "Currency", "Percent"}:
        numeric = re.sub(r"(?i)^[A-Z]{3}\s+", "", value).replace(",", "").strip()
        if not re.fullmatch(r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)", numeric):
            return None
        if fieldtype == "Int" and not re.fullmatch(r"[-+]?\d+", numeric):
            return None
        return numeric
    if fieldtype == "Date":
        if value.casefold() == "today":
            return nowdate()
        try:
            return str(getdate(value))
        except Exception:
            return None
    return value


def _merge_explicit_attended_values(
    values: dict[str, Any],
    parent: dict[str, str],
    child_rows: dict[str, dict[str, str]],
) -> dict[str, Any]:
    """Prefer schema-resolved user values over provider field mapping hints."""
    merged = dict(values)
    merged.update(parent)
    for table_field, explicit_row in child_rows.items():
        if not explicit_row:
            continue
        current = merged.get(table_field)
        if isinstance(current, list) and current and isinstance(current[0], dict):
            rows = [dict(row) if isinstance(row, dict) else row for row in current]
            rows[0].update(explicit_row)
            merged[table_field] = rows
        else:
            merged[table_field] = [dict(explicit_row)]
    return merged


def _browser_plan_capabilities(plan: dict[str, Any]) -> set[str]:
    mapping = {
        "navigate": "frappe.browser.navigate", "click": "frappe.browser.click",
        "fill": "frappe.browser.fill", "select": "frappe.browser.select",
        "read_visible": "frappe.browser.read_visible",
    }
    return {mapping[action["kind"]] for action in plan["actions"]}


def _host_structural_attended_values(
    action: str, catalog: dict[str, Any], objective: str | None,
) -> dict[str, str]:
    """Recover one unambiguous Link + Date phrase at the host trust boundary.

    Provider values remain hints.  This deliberately narrow parser only acts
    when the live form exposes one writable Customer/Client identity and one
    writable Date field, and the user's objective contains exactly one valid
    ISO date.  Ambiguous prompts continue through normal clarification.
    """
    if action not in {"create", "update"} or not isinstance(objective, str):
        return {}
    fields = [field for field in catalog.get("fields", []) if isinstance(field, dict)]

    def writable(field: dict[str, Any]) -> bool:
        return bool(field.get(
            "create_writable" if action == "create" else "update_writable",
            field.get("writable"),
        ))

    date_fields = [field for field in fields if writable(field) and field.get("fieldtype") == "Date"]
    identity_fields = [
        field for field in fields
        if writable(field)
        and field.get("fieldtype") == "Link"
        and (
            str(field.get("options") or "").casefold() in {"customer", "client"}
            or str(field.get("label") or "").casefold() in {"customer", "client"}
            or str(field.get("fieldname") or "").casefold() in {"customer", "client"}
        )
    ]
    if len(date_fields) != 1 or len(identity_fields) != 1:
        return {}
    dates = re.findall(r"(?<!\d)(\d{4}-\d{2}-\d{2})(?!\d)", objective)
    if len(dates) != 1:
        return {}
    try:
        date.fromisoformat(dates[0])
    except ValueError:
        return {}

    date_value = dates[0]
    identity_field = identity_fields[0]
    date_field = date_fields[0]
    identity_label = re.escape(str(identity_field.get("label") or ""))
    date_label = re.escape(str(date_field.get("label") or ""))
    escaped_date = re.escape(date_value)
    patterns = [
        # Here the field labels are grammatical connectors, not part of the value.
        rf"\bfor\s+{identity_label}\s+(.+?)\s+with\s+{date_label}\s+{escaped_date}(?=\b|\s|[.,;])",
        rf"\bfor\s+(.+?)\s+scheduled\s+on\s+{escaped_date}(?=\b|\s|[.,;])",
        rf"\bfor\s+(.+?)\s+on\s+{escaped_date}(?=\b|\s|[.,;])",
    ]
    for pattern in patterns:
        match = re.search(pattern, objective, flags=re.IGNORECASE | re.DOTALL)
        if not match:
            continue
        identity = re.sub(r"\s+", " ", match.group(1)).strip(" \t\r\n,;:.")
        if identity and len(identity) <= 500:
            return {
                str(identity_field["fieldname"]): identity,
                str(date_field["fieldname"]): date_value,
            }
    return {}


def _host_attended_browser_plan(
    action: str, values: dict[str, Any], catalog: dict[str, Any], *, objective: str | None = None,
) -> dict[str, Any]:
    values = dict(values)
    fields = {field["fieldname"]: field for field in catalog["fields"]}
    labels = [field["label"] for field in catalog["fields"]]
    unknown_fields = sorted(set(values) - set(fields))

    def actionable_parent_values(source: dict[str, str]) -> dict[str, str]:
        admitted: dict[str, str] = {}
        for fieldname, value in source.items():
            field = fields.get(fieldname)
            if not field or labels.count(field.get("label")) != 1:
                continue
            operation_writable = field.get(
                "create_writable" if action == "create" else "update_writable", field.get("writable")
            )
            if operation_writable and field.get("fieldtype") not in {"Table", "Table MultiSelect"}:
                admitted[fieldname] = value
        return admitted

    explicit_parent, explicit_children = _objective_labeled_attended_values(objective, catalog)
    explicit_parent = actionable_parent_values(explicit_parent)
    values = _merge_explicit_attended_values(values, explicit_parent, explicit_children)
    clarified_parent, clarified_children = _clarified_labeled_attended_values(objective, catalog)
    clarified_parent = actionable_parent_values(clarified_parent)
    if unknown_fields and not (clarified_parent or clarified_children):
        raise WorkflowProposalError(
            _("Selected form field {0} is unavailable").format(unknown_fields[0])
        )
    values = {fieldname: value for fieldname, value in values.items() if fieldname in fields}
    values = _merge_explicit_attended_values(values, clarified_parent, clarified_children)
    # Resolve the live parent identity before inferring child rows. Otherwise a
    # sentence that names both an assembly and a component presents two valid
    # Item links to the child-table resolver, even though one is already the
    # parent record. This ordering is schema-driven and applies equally to any
    # Frappe form with parent and child links to the same DocType.
    structural_values = actionable_parent_values(
        _host_structural_attended_values(action, catalog, objective)
    )
    values.update(structural_values)
    grounded_parent_values = {**explicit_parent, **clarified_parent, **structural_values}
    for fieldname, value in values.items():
        field = fields.get(fieldname)
        if (
            field
            and field.get("fieldtype") == "Link"
            and field.get("required")
            and not isinstance(value, (dict, list))
            and _objective_contains_scalar(objective or "", value)
        ):
            grounded_parent_values[fieldname] = value
    inferred_children = _objective_linked_child_rows(
        objective or "",
        catalog,
        grounded_parent_values,
    )
    for table_name, rows in inferred_children.items():
        if table_name not in explicit_children and table_name not in clarified_children:
            values[table_name] = rows
    grounded_table_fields = set(explicit_children) | set(clarified_children) | set(inferred_children)
    # A provider may map a scalar such as "Amount" onto an unrelated table
    # that happens to expose the same label (for example, purchase taxes). A
    # child row is writable only when the user's request or a signed
    # clarification grounds at least one field in that exact live table.
    values = {
        fieldname: value for fieldname, value in values.items()
        if (fields.get(fieldname) or {}).get("fieldtype") not in {"Table", "Table MultiSelect"}
        or fieldname in grounded_table_fields
    }
    clarified_values = actionable_parent_values(_clarified_attended_values(objective, catalog))
    values.update(clarified_values)
    # Provider-selected values are hints, never schema authority. A model may
    # map a child-row label such as Supplier onto a non-existent parent field;
    # retain only fields present in the effective live form before applying
    # the host-parsed, schema-grounded parent and child values above.
    values = {fieldname: value for fieldname, value in values.items() if fieldname in fields}
    host_resolved_fields: set[str] = set(structural_values)
    host_resolved_fields.update(clarified_values)
    host_resolved_fields.update(clarified_parent)
    host_resolved_fields.update(
        fieldname for fieldname, value in explicit_parent.items()
        if str(values.get(fieldname)) == str(value)
    )
    for fieldname in list(values):
        field = fields[fieldname]
        operation_writable = field.get(
            "create_writable" if action == "create" else "update_writable", field.get("writable")
        )
        if (
            not operation_writable
            or labels.count(field.get("label")) != 1
        ) and fieldname not in host_resolved_fields:
            values.pop(fieldname)
    if objective is not None:
        for fieldname in list(values):
            field = fields.get(fieldname)
            if (
                field
                and fieldname not in host_resolved_fields
                and field.get("fieldtype") not in {"Table", "Table MultiSelect"}
                and (field.get("has_default") or not _requires_explicit_attended_input(field))
                and not _objective_contains_scalar(objective, values[fieldname])
            ):
                values.pop(fieldname)
    table_grounding: dict[str, list[Any]] = {}
    for fieldname, value in values.items():
        field = fields.get(fieldname)
        operation_writable = field and field.get(
            "create_writable" if action == "create" else "update_writable", field["writable"]
        )
        if not field or not operation_writable or labels.count(field["label"]) != 1:
            raise WorkflowProposalError(
                _("Selected form field {0} is ambiguous, hidden, read-only, or denied by permlevel").format(fieldname)
            )
        if field["fieldtype"] in {"Table", "Table MultiSelect"}:
            if not isinstance(value, list) or not value or len(value) > 20:
                raise WorkflowProposalClarification(
                    _("Add at least one bounded row for {0}.").format(field["label"])
                )
            child_fields = {
                child["fieldname"]: child for child in (field.get("child_fields") or [])
                if isinstance(child, dict) and child.get("fieldname")
            }
            if not field.get("child_doctype") or not child_fields:
                raise WorkflowProposalError(_("The live child-table schema is unavailable"))
            normalized_rows: list[dict[str, Any]] = []
            grounded: list[Any] = []
            for row in value:
                if not isinstance(row, dict) or not row or len(row) > 40:
                    raise WorkflowProposalError(_("Each attended child row must contain bounded visible fields"))
                normalized_row: dict[str, Any] = {}
                for child_name, child_value in row.items():
                    child = child_fields.get(child_name)
                    if not child or not child.get("writable"):
                        raise WorkflowProposalError(_("A selected child field is unavailable, hidden, read-only, or denied"))
                    if isinstance(child_value, (dict, list)) or child_value is None:
                        raise WorkflowProposalError(_("Attended child fields accept scalar visible values only"))
                    if child["fieldtype"] not in {"Data", "Small Text", "Text", "Long Text", "Text Editor", "Link", "Date", "Datetime", "Time", "Int", "Float", "Currency", "Percent", "Phone", "Select", "Autocomplete"}:
                        raise WorkflowProposalError(_("A selected child field type is not safely supported"))
                    rendered_child = str(child_value)
                    inferred_row = (inferred_children.get(fieldname) or [{}])[0]
                    child_host_grounded = (
                        str(explicit_children.get(fieldname, {}).get(child_name)) == rendered_child
                        or str(inferred_row.get(child_name)) == rendered_child
                    )
                    if child["fieldtype"] == "Date":
                        normalized_date = _normalize_explicit_attended_value("Date", rendered_child)
                        if normalized_date is None:
                            raise WorkflowProposalClarification(
                                _("What date should I use for {0}?").format(child["label"])
                            )
                        if normalized_date != rendered_child:
                            child_host_grounded = bool(
                                objective is not None and _objective_contains_scalar(objective, rendered_child)
                            )
                            rendered_child = normalized_date
                            child_value = normalized_date
                    if child["fieldtype"] == "Select":
                        allowed = [item.strip() for item in str(child.get("options") or "").splitlines() if item.strip()]
                        if not allowed or rendered_child not in allowed:
                            raise WorkflowProposalClarification(
                                _("Choose an available value for {0}: {1}").format(child["label"], ", ".join(allowed[:12]))
                            )
                    if child["fieldtype"] == "Link":
                        linked_doctype = child.get("options")
                        if (
                            not isinstance(linked_doctype, str) or not linked_doctype
                            or not frappe.db.exists("DocType", linked_doctype)
                            or not frappe.db.exists(linked_doctype, rendered_child)
                            or not frappe.has_permission(linked_doctype, "read", doc=rendered_child, user=frappe.session.user)
                        ):
                            raise WorkflowProposalClarification(
                                _("Which existing permitted value should I use for {0}?").format(child["label"])
                            )
                    normalized_row[child_name] = child_value
                    if not child_host_grounded:
                        grounded.append(child_value)
                for child_name, child in child_fields.items():
                    if child_name in normalized_row or child.get("fieldtype") != "Data":
                        continue
                    for link_name, link_value in normalized_row.items():
                        link_field = child_fields.get(link_name) or {}
                        linked_doctype = link_field.get("options") if link_field.get("fieldtype") == "Link" else None
                        if not isinstance(linked_doctype, str) or not linked_doctype:
                            continue
                        linked_meta = frappe.get_meta(linked_doctype, cached=False)
                        if str(getattr(linked_meta, "title_field", None) or "") != child_name:
                            continue
                        derived = frappe.db.get_value(linked_doctype, str(link_value), child_name)
                        if not _missing_scalar(derived):
                            normalized_row[child_name] = derived
                            break
                for child_name, child in child_fields.items():
                    inherited = values.get(child_name)
                    if (
                        child_name not in normalized_row
                        and child.get("required")
                        and not isinstance(inherited, (dict, list))
                        and not _missing_scalar(inherited)
                    ):
                        normalized_row[child_name] = inherited
                        if str(explicit_parent.get(child_name)) != str(inherited):
                            grounded.append(inherited)
                missing_child = [
                    child["label"] for child in child_fields.values()
                    if child.get("required") and child.get("writable") and not child.get("has_default")
                    and _requires_explicit_attended_input(child)
                    and (child["fieldname"] not in normalized_row or _missing_scalar(normalized_row[child["fieldname"]]))
                ]
                if missing_child:
                    raise WorkflowProposalClarification(
                        _("What value should I use for {0}?").format(", ".join(missing_child[:10]))
                    )
                normalized_rows.append(normalized_row)
            values[fieldname] = json.dumps(normalized_rows, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
            table_grounding[fieldname] = grounded
            continue
        if isinstance(value, (dict, list)) or value is None:
            raise WorkflowProposalError(_("Attended CRUD v1 accepts scalar visible form values only"))
        if field["fieldtype"] not in {"Data", "Small Text", "Text", "Long Text", "Text Editor", "Link", "Dynamic Link", "Date", "Datetime", "Time", "Int", "Float", "Currency", "Percent", "Phone", "Select", "Autocomplete"}:
            raise WorkflowProposalError(_("A selected field type is not safely supported by attended CRUD v1"))
        rendered = str(value)
        if field["fieldtype"] == "Date":
            normalized_date = _normalize_explicit_attended_value("Date", rendered)
            if normalized_date is None:
                raise WorkflowProposalClarification(
                    _("What date should I use for {0}?").format(field["label"])
                )
            if normalized_date != rendered:
                if objective is not None and _objective_contains_scalar(objective, rendered):
                    host_resolved_fields.add(fieldname)
                values[fieldname] = normalized_date
                rendered = normalized_date
        if field["fieldtype"] == "Select":
            allowed = [item.strip() for item in str(field.get("options") or "").splitlines() if item.strip()]
            if not allowed or rendered not in allowed:
                raise WorkflowProposalClarification(
                    _("Choose an available value for {0}: {1}").format(field["label"], ", ".join(allowed[:12]))
                )
        if field["fieldtype"] == "Link":
            linked_doctype = field.get("options")
            link_is_valid = not (
                not isinstance(linked_doctype, str)
                or not linked_doctype
                or not frappe.db.exists("DocType", linked_doctype)
                or not frappe.db.exists(linked_doctype, rendered)
                or not frappe.has_permission(linked_doctype, "read", doc=rendered, user=frappe.session.user)
            )
            if not link_is_valid and action == "create" and _redundant_link_alias(
                rendered, field, catalog
            ):
                resolved = _configured_link_default(field, catalog)
                if resolved:
                    values[fieldname] = resolved
                    rendered = resolved
                    host_resolved_fields.add(fieldname)
                    link_is_valid = True
            if not link_is_valid:
                raise WorkflowProposalClarification(
                    _("Which existing permitted value should I use for {0}?").format(field["label"])
                )
        if field["fieldtype"] == "Dynamic Link":
            selector_name = field.get("options")
            selector = fields.get(selector_name) if isinstance(selector_name, str) else None
            linked_doctype = values.get(selector_name) if selector else None
            if (
                not selector
                or selector.get("fieldtype") not in {"Link", "Select", "Autocomplete"}
                or not isinstance(linked_doctype, str)
                or not linked_doctype
                or not frappe.db.exists("DocType", linked_doctype)
                or not frappe.db.exists(linked_doctype, rendered)
                or not frappe.has_permission(
                    linked_doctype, "read", doc=rendered, user=frappe.session.user
                )
            ):
                raise WorkflowProposalClarification(
                    _("Which existing permitted value should I use for {0} after choosing {1}?").format(
                        field["label"], selector.get("label") if selector else _("its type")
                    )
                )
    if objective is not None:
        ungrounded = [
            fields[fieldname]["label"] for fieldname, value in values.items()
            if fieldname not in host_resolved_fields and (
                (fieldname in table_grounding and not all(_objective_contains_scalar(objective, item) for item in table_grounding[fieldname]))
                or (fieldname not in table_grounding and not _objective_contains_scalar(objective, value))
            )
        ]
        if ungrounded:
            raise WorkflowProposalClarification(
                _("What value should I use for {0}?").format(", ".join(ungrounded[:10]))
            )
    if action == "create":
        try:
            new_record = frappe.new_doc(catalog["doctype"])
        except Exception:
            new_record = None

        def has_runtime_default(field: dict[str, Any]) -> bool:
            return bool(
                field.get("has_default")
                or (new_record is not None and not _missing_scalar(new_record.get(field["fieldname"])))
            )

        # Required read-only fields can be populated by browser controllers,
        # naming rules, workflows, or server hooks after the native form opens.
        # The user cannot resolve them in chat, so leave them to Frappe's own
        # visible form and Save validation instead of asking an impossible
        # clarification or inventing a value.
        missing = [
            field["label"] for field in catalog["fields"]
            if field["required"] and field.get("create_writable", field["writable"])
            and not has_runtime_default(field)
            and _requires_explicit_attended_input(field)
            and (field["fieldname"] not in values or _missing_scalar(values[field["fieldname"]]))
        ]
        if missing:
            raise WorkflowProposalClarification(
                _("What value should I use for {0}?").format(", ".join(missing[:10]))
            )
    record_name = catalog["record_name"] if action == "update" else None
    if action == "update" and not record_name:
        raise WorkflowProposalError(_("Select an exact permitted record before preparing an attended update"))
    doctype_slug = frappe.scrub(catalog["doctype"]).replace("_", "-")
    list_route = f"/desk/{doctype_slug}"
    form_route = f"{list_route}/{quote(record_name, safe='')}" if record_name else "@attended-form"
    actions: list[dict[str, Any]] = []
    if action == "create":
        actions.extend([
            {"kind": "navigate", "route": list_route, "doctype": catalog["doctype"]},
            {"kind": "click", "route": list_route, "doctype": catalog["doctype"], "target": {"kind": "role", "role": "button", "name": "New"}, "postcondition": {"kind": "bind_route", "token": "attended_form", "doctype": catalog["doctype"]}},
        ])
    else:
        actions.append({"kind": "navigate", "route": form_route, "doctype": catalog["doctype"], "recordName": record_name})
    catalog_order = {
        field["fieldname"]: index for index, field in enumerate(catalog["fields"])
    }
    dynamic_link_selectors = {
        field.get("options") for field in catalog["fields"]
        if field.get("fieldtype") == "Dynamic Link" and isinstance(field.get("options"), str)
    }

    def form_dependency_order(fieldname: str) -> tuple[int, int]:
        field = fields[fieldname]
        # Frappe transaction forms derive currencies, accounts, parties, and
        # child-row defaults from Company. Dynamic Link values similarly depend
        # on their selector. Set those live form contexts before dependent fields.
        if fieldname == "company":
            priority = 0
        elif fieldname in dynamic_link_selectors:
            priority = 1
        elif field.get("fieldtype") == "Dynamic Link":
            priority = 2
        elif field.get("fieldtype") == "Table":
            priority = 4
        else:
            priority = 3
        return priority, catalog_order.get(fieldname, len(catalog_order))

    ordered_fieldnames = sorted(values, key=form_dependency_order)
    for fieldname in ordered_fieldnames:
        field = fields[fieldname]
        target = {"kind": "label", "name": field["label"]}
        common = {"route": form_route, "doctype": catalog["doctype"], **({"recordName": record_name} if record_name else {}), "target": target, "field": fieldname, "postcondition": {"kind": "target", "target": target, "state": "visible"}}
        if field["fieldtype"] == "Select":
            actions.append({"kind": "select", **common, "option": str(values[fieldname])})
        else:
            actions.append({"kind": "fill", **common, "value": str(values[fieldname])})
    actions.append({
        "kind": "click", "route": form_route, "doctype": catalog["doctype"],
        **({"recordName": record_name} if record_name else {}),
        "target": {"kind": "role", "role": "button", "name": "Save"},
        "postcondition": {"kind": "record_saved", "doctype": catalog["doctype"], "recordName": record_name},
    })
    return browser_action_plan({
        "schemaVersion": 1, "actionBudget": len(actions), "actions": actions,
        "attendedCrud": {
            "operation": action, "doctype": catalog["doctype"], "record_name": record_name,
            "fields": sorted(values), "schema_hash": catalog["schema_hash"], "revision": catalog["revision"],
        },
    })


def _host_attended_delete_plan(catalog: dict[str, Any]) -> dict[str, Any]:
    """Author the non-executing destructive review path entirely on the host."""
    record_name = catalog.get("record_name")
    if not record_name:
        raise WorkflowProposalError(_("Select an exact permitted record before preparing a delete review"))
    doctype_slug = frappe.scrub(catalog["doctype"]).replace("_", "-")
    form_route = f"/desk/{doctype_slug}/{quote(record_name, safe='')}"
    delete_target = {"kind": "role", "role": "button", "name": "Delete"}
    plan = {
        "schemaVersion": 1,
        "actionBudget": 3,
        "actions": [
            {"kind": "navigate", "route": form_route, "doctype": catalog["doctype"], "recordName": record_name},
            {
                "kind": "click", "route": form_route, "doctype": catalog["doctype"], "recordName": record_name,
                "target": {"kind": "role", "role": "button", "name": "Menu"},
                "postcondition": {"kind": "target", "target": delete_target, "state": "visible"},
            },
            {
                "kind": "read_visible", "route": form_route, "doctype": catalog["doctype"],
                "recordName": record_name, "target": delete_target, "maxChars": 100,
            },
        ],
        "attendedCrud": {
            "operation": "delete", "doctype": catalog["doctype"], "record_name": record_name,
            "fields": [], "schema_hash": catalog["schema_hash"], "revision": catalog["revision"],
        },
    }
    return browser_action_plan(plan)


def _words(value: Any) -> list[str]:
    return re.findall(r"[a-z0-9]+", str(value or "").lower())


def _redundant_link_alias(value: str, field: dict[str, Any], catalog: dict[str, Any]) -> bool:
    """Recognize a record-type noun mistakenly repeated as a create-time Link value.

    For example, users commonly say ``Create a CRM Lead ... Status Lead``. ``Lead``
    identifies the record type, not a configured ``CRM Lead Status`` row. This
    narrow check authorizes only host-side default resolution; it never admits an
    arbitrary model value or selects a record identity.
    """
    supplied = _words(value)
    target = _words(catalog.get("doctype"))
    linked = _words(field.get("options"))
    if not supplied or not target or not linked:
        return False
    return supplied == target or (
        len(supplied) == 1 and supplied[0] == target[-1] and supplied[0] in linked
    )


def _configured_link_default(field: dict[str, Any], catalog: dict[str, Any]) -> str | None:
    """Resolve a create default from live Frappe metadata and permission-filtered rows.

    The provider cannot nominate this value. An effective field default wins. If
    none exists, only linked masters with an explicit ``position`` field may
    contribute their first caller-visible row. Masters without an ordering
    contract remain ambiguous and still trigger clarification.
    """
    linked_doctype = field.get("options")
    if not isinstance(linked_doctype, str) or not frappe.db.exists("DocType", linked_doctype):
        return None
    parent_meta = frappe.get_meta(catalog["doctype"], cached=False)
    parent_field = parent_meta.get_field(field["fieldname"])
    raw_default = getattr(parent_field, "default", "")
    effective_default = raw_default.strip() if isinstance(raw_default, str) else ""
    if (
        effective_default
        and frappe.db.exists(linked_doctype, effective_default)
        and frappe.has_permission(
            linked_doctype, "read", doc=effective_default, user=frappe.session.user
        )
    ):
        return effective_default
    linked_meta = frappe.get_meta(linked_doctype, cached=False)
    if not linked_meta.has_field("position"):
        return None
    rows = frappe.get_list(
        linked_doctype,
        fields=["name"],
        order_by="position asc, name asc",
        limit_page_length=12,
    )
    for row in rows:
        name = str(row.name if hasattr(row, "name") else row.get("name") or "").strip()
        if name:
            return name
    return None


def _missing_scalar(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def _requires_explicit_attended_input(field: dict[str, Any]) -> bool:
    return field.get("fieldtype") in {
        "Data", "Small Text", "Text", "Long Text", "Text Editor", "Link",
        "Date", "Datetime", "Time", "Select", "Autocomplete", "Table", "Table MultiSelect",
    }


def _requested_attended_action(objective: str) -> str | None:
    matches = [
        action for action, pattern in (
            ("create", r"\b(?:add|create|make|new|register)\b"),
            ("update", r"\b(?:change(?:d)?|edit(?:ed)?|fix(?:ed)?|repair(?:ed)?|correct(?:ed)?|modify|modified|rename|set|update(?:d)?)\b"),
            ("delete", r"\b(?:delete|remove|erase)\b"),
        )
        if re.search(pattern, objective, re.IGNORECASE)
    ]
    return matches[0] if len(matches) == 1 else None


def _attended_preflight_clarification(objective: str, catalogs: list[dict[str, Any]]) -> str | None:
    action = _requested_attended_action(objective)
    if action not in {"update", "delete"}:
        return None
    identified = [
        catalog for catalog in catalogs
        if catalog.get("record_identity_state") == "unique" and catalog.get("record_name")
    ]
    if len(identified) == 1:
        return None
    if len(catalogs) == 1:
        catalog = catalogs[0]
        return _("Which exact {0} record should I {1}?").format(catalog["doctype"], action)
    return _("Which exact record should I {0}?").format(action)


def _objective_contains_scalar(objective: str, value: Any) -> bool:
    if _missing_scalar(value) or isinstance(value, (dict, list)):
        return False
    objective_words = re.sub(r"[^a-z0-9]+", " ", objective.lower()).strip()
    value_words = re.sub(r"[^a-z0-9]+", " ", str(value).lower()).strip()
    return bool(value_words and f" {value_words} " in f" {objective_words} ")


def _objective_linked_child_rows(
    objective: str, catalog: dict[str, Any], parent_values: dict[str, Any],
) -> dict[str, list[dict[str, Any]]]:
    """Ground child rows from exact permitted Link records named by the user.

    This is schema-driven rather than DocType-specific: a request such as
    "using one RAW-PART and the Bending operation" can populate two different
    live child tables without teaching Muster what a BOM is.  Values already
    selected as parent Links are excluded, preventing the assembly item from
    being mistaken for a component row.
    """
    excluded = {str(value) for value in parent_values.values() if not isinstance(value, (dict, list))}
    inferred: dict[str, list[dict[str, Any]]] = {}
    claimed_links: set[tuple[str, str]] = set()
    words = [
        token.rstrip(".")
        for token in re.findall(r"[A-Za-z0-9][A-Za-z0-9_.-]*", objective)[:100]
        if token.rstrip(".")
    ]
    objective_candidates: list[str] = []
    for size in range(1, 5):
        for index in range(0, len(words) - size + 1):
            candidate = " ".join(words[index:index + size])
            if candidate not in objective_candidates:
                objective_candidates.append(candidate)
            if len(objective_candidates) >= 300:
                break
        if len(objective_candidates) >= 300:
            break
    for table in catalog.get("fields") or []:
        if table.get("fieldtype") not in {"Table", "Table MultiSelect"} or not table.get("writable"):
            continue
        row: dict[str, Any] = {}
        matched_names: list[str] = []
        linked_sources: list[tuple[str, str]] = []
        for child in table.get("child_fields") or []:
            linked_doctype = child.get("options") if child.get("fieldtype") == "Link" else None
            if not child.get("writable") or not isinstance(linked_doctype, str) or not linked_doctype:
                continue
            matches = []
            for candidate in objective_candidates:
                if candidate in excluded or (linked_doctype, candidate) in claimed_links:
                    continue
                try:
                    exists = frappe.db.exists(linked_doctype, candidate)
                    permitted = exists and frappe.has_permission(
                        linked_doctype, "read", doc=candidate, user=frappe.session.user
                    )
                except Exception:
                    permitted = False
                if permitted:
                    matches.append(candidate)
            matches = list(dict.fromkeys(matches))
            if len(matches) == 1:
                row[child["fieldname"]] = matches[0]
                matched_names.append(matches[0])
                linked_sources.append((linked_doctype, matches[0]))
        if not row:
            continue
        quantity_fields = [
            child for child in (table.get("child_fields") or [])
            if child.get("writable") and child.get("fieldtype") in {"Int", "Float", "Currency"}
            and re.search(r"(?:^|_)(?:qty|quantity)(?:$|_)", str(child.get("fieldname") or ""), re.IGNORECASE)
        ]
        canonical_quantity_fields = [
            child for child in quantity_fields
            if str(child.get("fieldname") or "").lower() in {"qty", "quantity"}
        ]
        if len(canonical_quantity_fields) == 1:
            quantity_fields = canonical_quantity_fields
        if len(quantity_fields) == 1:
            quantity = None
            for name in matched_names:
                match = re.search(
                    rf"\b(one|two|three|four|five|\d+(?:\.\d+)?)\s+(?:of\s+)?{re.escape(name)}\b",
                    objective,
                    re.IGNORECASE,
                )
                if match:
                    words = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5}
                    quantity = words.get(match.group(1).lower(), match.group(1))
                    break
            if quantity is not None:
                row[quantity_fields[0]["fieldname"]] = quantity
        for child in table.get("child_fields") or []:
            fieldname = str(child.get("fieldname") or "")
            if fieldname in row or not child.get("required") or not child.get("writable"):
                continue
            derived_values = []
            for linked_doctype, linked_name in linked_sources:
                linked_slug = frappe.scrub(linked_doctype)
                if child.get("fieldtype") == "Data" and fieldname == f"{linked_slug}_code":
                    derived_values.append(linked_name)
                    continue
                try:
                    source_meta = frappe.get_meta(linked_doctype, cached=False)
                except Exception:
                    continue
                source_names = [
                    source.fieldname for source in source_meta.fields
                    if source.fieldname == fieldname or source.fieldname.endswith(f"_{fieldname}")
                ]
                for source_name in source_names:
                    source_value = frappe.db.get_value(linked_doctype, linked_name, source_name)
                    if not _missing_scalar(source_value):
                        derived_values.append(source_value)
            unique = {str(value): value for value in derived_values}
            if len(unique) == 1:
                row[fieldname] = next(iter(unique.values()))
        inferred[table["fieldname"]] = [row]
        claimed_links.update(linked_sources)
    return inferred


def _host_attended_read_plan(catalog: dict[str, Any]) -> dict[str, Any]:
    encoded_doctype = frappe.scrub(catalog["doctype"]).replace("_", "-")
    record_name = catalog.get("record_name")
    route = f"/desk/{encoded_doctype}" + (f"/{quote(record_name, safe='')}" if record_name else "")
    return browser_action_plan({
        "schemaVersion": 1, "actionBudget": 2,
        "actions": [
            {"kind": "navigate", "route": route, "doctype": catalog["doctype"], **({"recordName": record_name} if record_name else {})},
            {"kind": "read_visible", "route": route, "doctype": catalog["doctype"], **({"recordName": record_name} if record_name else {}), "maxChars": 10_000},
        ],
        "attendedCrud": {"operation": "read", "doctype": catalog["doctype"], "record_name": record_name, "fields": [], "schema_hash": catalog["schema_hash"], "revision": catalog["revision"]},
    })


def _canonical_requested_scope(value: Any) -> dict[str, Any]:
    """Admit a small resource selector; never persist arbitrary prompt payloads.

    Permission-filtered record contents belong in ``context_json``. This value
    contains only route/resource identities used to re-check policy at Start
    and dispatch boundaries.
    """
    if not isinstance(value, dict):
        raise WorkflowProposalError(_("Planning scope must be a JSON object"))
    scalar_fields = {
        "source": 80, "route": 500, "page_type": 140, "page_name": 140,
        "doctype": 140, "docname": 500, "locale": 40, "timezone": 80,
        "scope_mode": 20,
    }
    allowed = {*scalar_fields, "documents", "fields"}
    if set(value) - allowed:
        raise WorkflowProposalError(_("Planning scope contains unsupported fields"))
    normalized: dict[str, Any] = {}
    for field, maximum in scalar_fields.items():
        if value.get(field) is not None:
            normalized[field] = _bounded_text(value[field], field, maximum)
    if normalized.get("scope_mode") not in {None, "context", "site", "doctype", "record"}:
        raise WorkflowProposalError(_("Planning scope mode is invalid"))
    if "docname" in normalized and "doctype" not in normalized:
        raise WorkflowProposalError(_("Planning scope document name requires a DocType"))
    fields = value.get("fields") or []
    if not isinstance(fields, list) or len(fields) > 256:
        raise WorkflowProposalError(_("Planning scope fields are invalid or excessive"))
    admitted_fields: list[str] = []
    for item in fields:
        field = _bounded_text(item, "field", 140)
        if field not in admitted_fields:
            admitted_fields.append(field)
    if admitted_fields:
        normalized["fields"] = admitted_fields
    documents = value.get("documents") or []
    if not isinstance(documents, list) or len(documents) > MAX_SCOPE_DOCUMENTS:
        raise WorkflowProposalError(_("Planning scope documents are invalid or excessive"))
    admitted_documents: list[dict[str, str]] = []
    for row in documents:
        if not isinstance(row, dict) or set(row) - {"doctype", "name", "docname", "fields"}:
            raise WorkflowProposalError(_("Each planning scope document must be an exact resource reference"))
        doctype = _bounded_text(row.get("doctype"), "DocType", 140)
        name = _bounded_text(row.get("name") or row.get("docname"), "document name", 500)
        row_fields = row.get("fields") or []
        if not isinstance(row_fields, list) or len(row_fields) > 256:
            raise WorkflowProposalError(_("Planning scope document fields are invalid or excessive"))
        normalized_row_fields: list[str] = []
        for item in row_fields:
            field = _bounded_text(item, "document field", 140)
            if field not in normalized_row_fields:
                normalized_row_fields.append(field)
        reference = {
            "doctype": doctype,
            "name": name,
            **({"fields": normalized_row_fields} if normalized_row_fields else {}),
        }
        if reference not in admitted_documents:
            admitted_documents.append(reference)
    if admitted_documents:
        normalized["documents"] = admitted_documents
    encoded = json.dumps(normalized, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    if len(encoded.encode()) > MAX_SCOPE_BYTES:
        raise WorkflowProposalError(_("Planning scope exceeds the safe size limit"))
    return normalized


def _native_rows(graph: dict[str, Any], root_agent: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    node_type = {
        "agent": "Agent", "approval": "Approval", "parallel_map": "Parallel",
        "transform": "Join", "condition": "Condition", "loop": "Bounded Loop",
        "artifact": "Artifact",
    }
    nodes = []
    for raw in graph["nodes"]:
        assigned_agent = raw.get("agentId") if raw["kind"] == "agent" else None
        if assigned_agent:
            if not frappe.db.exists("Muster Agent", assigned_agent) or frappe.db.get_value("Muster Agent", assigned_agent, "status") != "Active":
                raise WorkflowProposalError(_("The proposal references an unavailable agent: {0}").format(assigned_agent))
        elif raw["kind"] == "agent":
            assigned_agent = root_agent
        configuration = {
            "core_kind": raw["kind"],
            "requested_capabilities": raw.get("requestedCapabilities") or [],
        }
        if raw.get("compensationNodeId"):
            configuration["compensation_node_id"] = raw["compensationNodeId"]
        if raw.get("loop"):
            configuration.update({
                "max_iterations": raw["loop"]["maxIterations"],
                "progress_predicate": raw["loop"]["progressPredicate"],
                "budget": raw["loop"]["budget"],
            })
        execution = raw.get("executionIntent")
        if execution:
            if not isinstance(execution, dict) or set(execution) != {"surface", "plan"}:
                raise WorkflowProposalError(_("The proposal execution intent is invalid"))
            if execution["surface"] == "server_effect":
                configuration["effect_intent"] = effect_intent(execution["plan"])
            elif execution["surface"] == "browser":
                configuration["browser_action_plan"] = browser_action_plan(execution["plan"])
            else:
                raise WorkflowProposalError(_("The proposal execution surface is unsupported"))
        nodes.append({
            "node_id": raw["id"],
            "label": _graph_node_label(raw["id"]),
            "node_type": node_type.get(raw["kind"], "Tool"),
            "agent": assigned_agent,
            "configuration_json": json.dumps(configuration, ensure_ascii=False, sort_keys=True),
            "approval_class": "Standard",
            "timeout_seconds": 600,
            "retry_limit": int(raw.get("retryLimit") or 0),
        })
    edges = [
        {
            "source_node": edge["from"], "target_node": edge["to"],
            "condition_expression": edge.get("when"), "priority": 100,
        }
        for edge in graph["edges"]
    ]
    return nodes, edges


def _graph_node_label(node_id: str) -> str:
    stem = node_id.split("-", 1)[1] if "-" in node_id else node_id
    return re.sub(r"[-_]+", " ", stem).strip().title()[:140] or node_id


def _unique_workflow_name(label: str, proposal_name: str) -> str:
    base = re.sub(r"\s+", " ", label).strip()[:100] or "Muster workflow"
    if not frappe.db.exists("Muster Workflow", base):
        return base
    suffix = re.sub(r"[^A-Za-z0-9-]+", "-", proposal_name).strip("-")[-24:]
    candidate = f"{base[:110]} · {suffix}"
    if frappe.db.exists("Muster Workflow", candidate):
        raise WorkflowProposalError(_("This proposal already conflicts with an existing workflow name"))
    return candidate


def validate_workflow_descriptor(value: Any, allowed_capabilities: list[str]) -> dict[str, Any]:
    """Independent Frappe-side admission gate for untrusted planner output.

    The TypeScript gateway is the canonical compiler. This second boundary is
    intentionally redundant so a compromised/misconfigured gateway cannot
    persist source code or expand the caller's live Frappe authority.
    """
    if isinstance(value, str):
        raise WorkflowProposalError(_("Workflow source is forbidden; the proposal must be strict JSON data"))
    if not isinstance(value, dict):
        raise WorkflowProposalError(_("Workflow proposal must be a JSON object"))
    try:
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    except (TypeError, ValueError) as error:
        raise WorkflowProposalError(_("Workflow proposal contains a non-JSON value")) from error
    if len(encoded.encode()) > MAX_DESCRIPTOR_BYTES:
        raise WorkflowProposalError(_("Workflow proposal exceeds the safe size limit"))
    _exact_keys(value, {"schemaVersion", "id", "version", "meta", "goal", "inputSchema", "resultSchema", "budget", "limits", "steps"}, "proposal")
    if value.get("schemaVersion") != 1:
        raise WorkflowProposalError(_("Workflow proposal schemaVersion must be 1"))
    for field in ("id", "version", "goal"):
        _bounded_text(value.get(field), field, 10_000)
    meta = value.get("meta")
    if not isinstance(meta, dict):
        raise WorkflowProposalError(_("Workflow proposal meta must be an object"))
    _exact_keys(meta, {"name", "description", "phases"}, "meta")
    _bounded_text(meta.get("name"), "meta.name", 500)
    _bounded_text(meta.get("description"), "meta.description", 4_000)
    if not isinstance(meta.get("phases"), list) or len(meta["phases"]) > 16:
        raise WorkflowProposalError(_("Workflow proposal phases are invalid"))
    for phase in meta["phases"]:
        if not isinstance(phase, dict):
            raise WorkflowProposalError(_("Workflow proposal phase must be an object"))
        _exact_keys(phase, {"title", "detail"}, "meta.phases")
        _bounded_text(phase.get("title"), "phase title", 500)
        if phase.get("detail") is not None:
            _bounded_text(phase.get("detail"), "phase detail", 4_000)
    _validate_budget(value.get("budget"), WORKFLOW_BUDGET_CEILINGS)
    limits = value.get("limits")
    if not isinstance(limits, dict):
        raise WorkflowProposalError(_("Workflow proposal limits must be an object"))
    _exact_keys(limits, {"maxDepth", "maxChildrenPerNode", "maxActiveNodes", "maxRetries", "maxParallelism", "maxPhases", "maxSteps"}, "limits")
    for key, ceiling in limits.items():
        if not isinstance(ceiling, int) or isinstance(ceiling, bool) or ceiling < 1 or ceiling > WORKFLOW_LIMIT_CEILINGS[key]:
            raise WorkflowProposalError(_("Workflow proposal limit {0} is invalid").format(key))
    authority = set(_validate_capabilities(allowed_capabilities))
    state = {"count": 0}
    _validate_steps(value.get("steps"), authority, state, 1, value["budget"])
    if state["count"] > min(MAX_STEPS, int(limits.get("maxSteps", MAX_STEPS))):
        raise WorkflowProposalError(_("Workflow proposal contains too many steps"))
    if value.get("inputSchema") is not None:
        _validate_schema(value["inputSchema"], "inputSchema")
    _validate_schema(value.get("resultSchema"), "resultSchema")
    return json.loads(encoded)


def validate_compiled_graph(
    value: Any, descriptor: dict[str, Any], allowed_capabilities: list[str]
) -> dict[str, Any]:
    """Admit the gateway compiler output as bounded data, independently in Frappe."""
    if not isinstance(value, dict):
        raise WorkflowProposalError(_("Compiled workflow graph must be a JSON object"))
    try:
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    except (TypeError, ValueError) as error:
        raise WorkflowProposalError(_("Compiled workflow graph contains a non-JSON value")) from error
    if len(encoded.encode()) > MAX_DESCRIPTOR_BYTES:
        raise WorkflowProposalError(_("Compiled workflow graph exceeds the safe size limit"))
    _exact_keys(value, {"schemaVersion", "id", "version", "entryNodeId", "nodes", "edges", "budget", "limits"}, "compiled graph")
    if value.get("schemaVersion") != 1 or value.get("id") != descriptor.get("id") or value.get("version") != descriptor.get("version"):
        raise WorkflowProposalError(_("Compiled workflow graph identity does not match its proposal"))
    _validate_budget(value.get("budget"), descriptor.get("budget"))
    limits = value.get("limits")
    if not isinstance(limits, dict):
        raise WorkflowProposalError(_("Compiled workflow graph limits are invalid"))
    _exact_keys(limits, {"maxDepth", "maxChildrenPerNode", "maxActiveNodes", "maxRetries"}, "compiled graph limits")
    for key, graph_limit in limits.items():
        descriptor_limit = descriptor.get("limits", {}).get(key)
        if not isinstance(graph_limit, int) or isinstance(graph_limit, bool) or graph_limit < 1 or graph_limit != descriptor_limit:
            raise WorkflowProposalError(_("Compiled workflow graph limits do not match its proposal"))

    nodes = value.get("nodes")
    edges = value.get("edges")
    if not isinstance(nodes, list) or not nodes or len(nodes) > min(MAX_STEPS * 2, limits.get("maxActiveNodes", MAX_STEPS * 2)):
        raise WorkflowProposalError(_("Compiled workflow graph nodes are invalid"))
    if not isinstance(edges, list) or len(edges) > MAX_STEPS * MAX_STEPS:
        raise WorkflowProposalError(_("Compiled workflow graph edges are invalid"))
    authority = set(_validate_capabilities(allowed_capabilities))
    node_ids: set[str] = set()
    adjacency: dict[str, list[str]] = {}
    graph_capabilities: Counter[str] = Counter()
    graph_executions: Counter[str] = Counter()
    for node in nodes:
        if not isinstance(node, dict):
            raise WorkflowProposalError(_("Compiled workflow graph node must be an object"))
        _exact_keys(node, {"id", "kind", "agentId", "requestedCapabilities", "retryLimit", "compensationNodeId", "loop", "executionIntent"}, "compiled graph node")
        node_id = node.get("id")
        if not isinstance(node_id, str) or not GRAPH_ID_PATTERN.fullmatch(node_id) or node_id in node_ids:
            raise WorkflowProposalError(_("Compiled workflow graph node id is invalid"))
        node_ids.add(node_id)
        adjacency[node_id] = []
        if node.get("kind") not in GRAPH_NODE_KINDS:
            raise WorkflowProposalError(_("Compiled workflow graph node kind is invalid"))
        if node.get("agentId") is not None and (
            not isinstance(node["agentId"], str) or not GRAPH_ID_PATTERN.fullmatch(node["agentId"])
        ):
            raise WorkflowProposalError(_("Compiled workflow graph agent id is invalid"))
        retry = node.get("retryLimit", 0)
        if not isinstance(retry, int) or isinstance(retry, bool) or retry < 0 or retry > limits["maxRetries"]:
            raise WorkflowProposalError(_("Compiled workflow graph retry limit is invalid"))
        requested = _validate_capabilities(node.get("requestedCapabilities") or [])
        if any("*" not in authority and capability not in authority for capability in requested):
            raise WorkflowProposalError(_("Compiled workflow graph exceeds caller capability authority"))
        graph_capabilities.update(requested)
        execution = node.get("executionIntent")
        if execution is not None:
            if node.get("kind") != "command" or not isinstance(execution, dict) or set(execution) != {"surface", "plan"}:
                raise WorkflowProposalError(_("Compiled workflow execution intent is invalid"))
            if execution.get("surface") == "server_effect":
                admitted = effect_intent(execution.get("plan"), "compiled graph execution intent")
                if requested != [admitted["capability"]]:
                    raise WorkflowProposalError(_("Compiled effect capability does not match its authority"))
            elif execution.get("surface") == "browser":
                plan = browser_action_plan(execution.get("plan"), "compiled graph browser plan")
                required = {
                    {
                        "navigate": "frappe.browser.navigate", "click": "frappe.browser.click",
                        "fill": "frappe.browser.fill", "select": "frappe.browser.select",
                        "upload": "frappe.browser.upload", "screenshot": "frappe.browser.screenshot",
                        "read_visible": "frappe.browser.read_visible",
                    }[action["kind"]]
                    for action in plan["actions"]
                }
                if not required.issubset(set(requested)):
                    raise WorkflowProposalError(_("Compiled browser plan exceeds its capability authority"))
            else:
                raise WorkflowProposalError(_("Compiled workflow execution surface is unsupported"))
            graph_executions.update([json.dumps(execution, ensure_ascii=False, sort_keys=True, separators=(",", ":"))])
        loop = node.get("loop")
        if node.get("kind") == "loop":
            if not isinstance(loop, dict):
                raise WorkflowProposalError(_("Compiled workflow loop controls are missing"))
            _exact_keys(loop, {"maxIterations", "progressPredicate", "cancellationCheckpoint", "budget"}, "compiled graph loop")
            if not isinstance(loop.get("maxIterations"), int) or not 1 <= loop["maxIterations"] <= 100 or loop.get("cancellationCheckpoint") is not True:
                raise WorkflowProposalError(_("Compiled workflow loop is not safely bounded"))
            _bounded_text(loop.get("progressPredicate"), "compiled loop progress predicate", 10_000)
            _validate_budget(loop.get("budget"), descriptor.get("budget"))
        elif loop is not None:
            raise WorkflowProposalError(_("Only compiled loop nodes may declare loop controls"))

    entry = value.get("entryNodeId")
    if entry not in node_ids:
        raise WorkflowProposalError(_("Compiled workflow graph entry node is invalid"))
    seen_edges: set[tuple[str, str, str]] = set()
    for edge in edges:
        if not isinstance(edge, dict):
            raise WorkflowProposalError(_("Compiled workflow graph edge must be an object"))
        _exact_keys(edge, {"from", "to", "when"}, "compiled graph edge")
        source, target = edge.get("from"), edge.get("to")
        if source not in node_ids or target not in node_ids or source == target:
            raise WorkflowProposalError(_("Compiled workflow graph edge is invalid"))
        when = edge.get("when") or ""
        if not isinstance(when, str) or len(when) > 10_000 or (source, target, when) in seen_edges:
            raise WorkflowProposalError(_("Compiled workflow graph edge is invalid"))
        seen_edges.add((source, target, when))
        adjacency[source].append(target)
    if any(len(children) > limits["maxChildrenPerNode"] for children in adjacency.values()):
        raise WorkflowProposalError(_("Compiled workflow graph fan-out exceeds its limit"))
    visiting: set[str] = set()
    visited: set[str] = set()
    def walk(node_id: str) -> None:
        if node_id in visiting:
            raise WorkflowProposalError(_("Compiled workflow graph contains a raw cycle"))
        if node_id in visited:
            return
        visiting.add(node_id)
        for child in adjacency[node_id]:
            walk(child)
        visiting.remove(node_id)
        visited.add(node_id)
    walk(entry)
    if visited != node_ids:
        raise WorkflowProposalError(_("Compiled workflow graph contains an unreachable node"))

    descriptor_capabilities: Counter[str] = Counter()
    descriptor_executions: Counter[str] = Counter()
    def collect(steps: list[dict[str, Any]]) -> None:
        for step in steps:
            descriptor_capabilities.update(step.get("capabilities") or [])
            if step.get("kind") == "execution":
                descriptor_executions.update([json.dumps(step.get("execution"), ensure_ascii=False, sort_keys=True, separators=(",", ":"))])
            for key in ("steps", "branches", "subagents"):
                if isinstance(step.get(key), list):
                    collect(step[key])
    collect(descriptor["steps"])
    if graph_capabilities != descriptor_capabilities:
        raise WorkflowProposalError(_("Compiled workflow graph capability evidence does not match its proposal"))
    if graph_executions != descriptor_executions:
        raise WorkflowProposalError(_("Compiled workflow execution evidence does not match its proposal"))
    return json.loads(encoded)


def _validate_steps(steps: Any, authority: set[str], state: dict[str, int], depth: int, workflow_budget: dict[str, Any]) -> None:
    if depth > MAX_DEPTH or not isinstance(steps, list) or not steps:
        raise WorkflowProposalError(_("Workflow proposal step structure is invalid"))
    for step in steps:
        state["count"] += 1
        if not isinstance(step, dict):
            raise WorkflowProposalError(_("Workflow proposal step must be an object"))
        kind = step.get("kind")
        if kind not in {"agent", "subworkflow", "phase", "parallel", "approval", "verification", "compensation", "repeat", "execution"}:
            raise WorkflowProposalError(_("Workflow proposal contains an unsupported step"))
        allowed = {"kind", "label", "description", "capabilities", "retryLimit", "resultSchema", "compensation"}
        allowed.update({
            "agent": {"prompt", "agentId", "agentType", "subagents"},
            "subworkflow": {"workflowId", "goal", "steps"},
            "phase": {"detail", "steps"},
            "parallel": {"maxConcurrency", "branches"},
            "approval": {"prompt", "requiredRoles"},
            "verification": {"criteria"},
            "compensation": {"action"},
            "repeat": {"maxIterations", "progressPredicate", "cancellationCheckpoint", "budget", "steps"},
            "execution": {"execution"},
        }[kind])
        _exact_keys(step, allowed, "step")
        _bounded_text(step.get("label"), "step label", 500)
        if step.get("description") is not None:
            _bounded_text(step["description"], "step description", 10_000)
        if step.get("retryLimit") is not None and (
            not isinstance(step["retryLimit"], int) or isinstance(step["retryLimit"], bool) or step["retryLimit"] < 0
        ):
            raise WorkflowProposalError(_("Workflow proposal retry limit is invalid"))
        if step.get("resultSchema") is not None:
            _validate_schema(step["resultSchema"], "step.resultSchema")
        requested = _validate_capabilities(step.get("capabilities") or [])
        escalated = [capability for capability in requested if "*" not in authority and capability not in authority]
        if escalated:
            raise WorkflowProposalError(_("Workflow proposal exceeds caller capability authority"))
        if kind == "repeat":
            if not isinstance(step.get("maxIterations"), int) or step["maxIterations"] < 1 or step.get("cancellationCheckpoint") is not True:
                raise WorkflowProposalError(_("Workflow repeat step is not safely bounded"))
            _bounded_text(step.get("progressPredicate"), "repeat progress predicate", 10_000)
            _validate_budget(step.get("budget"), workflow_budget)
            _validate_steps(step.get("steps"), authority, state, depth + 1, workflow_budget)
        elif kind == "phase":
            _validate_steps(step.get("steps"), authority, state, depth + 1, workflow_budget)
        elif kind == "parallel":
            if not isinstance(step.get("maxConcurrency"), int) or step["maxConcurrency"] < 1:
                raise WorkflowProposalError(_("Parallel step concurrency is invalid"))
            _validate_steps(step.get("branches"), authority, state, depth + 1, workflow_budget)
        elif kind == "agent":
            _bounded_text(step.get("prompt"), "agent prompt", 50_000)
            if step.get("subagents") is not None:
                _validate_steps(step["subagents"], authority, state, depth + 1, workflow_budget)
        elif kind == "subworkflow":
            _bounded_text(step.get("workflowId"), "workflow id", 500)
            _bounded_text(step.get("goal"), "subworkflow goal", 10_000)
            if step.get("steps") is not None:
                _validate_steps(step["steps"], authority, state, depth + 1, workflow_budget)
        elif kind == "approval":
            _bounded_text(step.get("prompt"), "approval prompt", 10_000)
            roles = step.get("requiredRoles")
            if roles is not None and (not isinstance(roles, list) or any(not isinstance(role, str) or not role.strip() for role in roles)):
                raise WorkflowProposalError(_("Workflow approval roles are invalid"))
        elif kind == "verification":
            _bounded_text(step.get("criteria"), "verification criteria", 10_000)
        elif kind == "compensation":
            _bounded_text(step.get("action"), "compensation action", 10_000)
        elif kind == "execution":
            execution = step.get("execution")
            if not isinstance(execution, dict) or set(execution) != {"surface", "plan"}:
                raise WorkflowProposalError(_("Workflow execution step is invalid"))
            if execution.get("surface") == "server_effect":
                admitted = effect_intent(execution.get("plan"), "step.execution.plan")
                if requested != [admitted["capability"]]:
                    raise WorkflowProposalError(_("Workflow effect capability does not exactly match authority"))
            elif execution.get("surface") == "browser":
                plan = browser_action_plan(execution.get("plan"), "step.execution.plan")
                required = {
                    {
                        "navigate": "frappe.browser.navigate", "click": "frappe.browser.click",
                        "fill": "frappe.browser.fill", "select": "frappe.browser.select",
                        "upload": "frappe.browser.upload", "screenshot": "frappe.browser.screenshot",
                        "read_visible": "frappe.browser.read_visible",
                    }[action["kind"]]
                    for action in plan["actions"]
                }
                if not required.issubset(set(requested)):
                    raise WorkflowProposalError(_("Workflow browser plan exceeds capability authority"))
            else:
                raise WorkflowProposalError(_("Workflow execution surface is unsupported"))


def _validate_budget(value: Any, value_ceiling: dict[str, int] | None = WORKFLOW_BUDGET_CEILINGS) -> None:
    fields = {"runtimeMs", "toolCalls", "modelCalls", "tokens", "costMicros", "artifactBytes"}
    if not isinstance(value, dict):
        raise WorkflowProposalError(_("Workflow proposal budget must be an object"))
    _exact_keys(value, fields, "budget")
    if set(value) != fields or any(not isinstance(item, int | float) or isinstance(item, bool) or item < 0 for item in value.values()):
        raise WorkflowProposalError(_("Workflow proposal budget is invalid"))
    if value_ceiling and any(value[field] > value_ceiling[field] for field in fields):
        raise WorkflowProposalError(_("Workflow proposal budget exceeds the safe planning ceiling"))


def _validate_capabilities(value: Any) -> list[str]:
    if not isinstance(value, list) or len(value) > 256:
        raise WorkflowProposalError(_("Workflow capabilities are invalid"))
    result = []
    for capability in value:
        if not isinstance(capability, str) or not CAPABILITY_PATTERN.fullmatch(capability):
            raise WorkflowProposalError(_("Workflow capabilities are invalid"))
        if capability not in result:
            result.append(capability)
    return result


def validate_run_metadata(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise WorkflowProposalError(_("Workflow planner run metadata is invalid"))
    _exact_keys(value, {"runId", "providerId", "model", "runtimeId", "durationMs", "inputTokens", "outputTokens", "executionBoundary"}, "run metadata")
    for field in ("runId", "providerId", "model", "runtimeId"):
        _bounded_text(value.get(field), field, 500)
    if value.get("executionBoundary") != "read-only-offline-provider":
        raise WorkflowProposalError(_("Workflow planner execution boundary is invalid"))
    for field in ("durationMs", "inputTokens", "outputTokens"):
        item = value.get(field)
        if item is not None and (not isinstance(item, int | float) or isinstance(item, bool) or item < 0):
            raise WorkflowProposalError(_("Workflow planner run metadata is invalid"))
    return value


def _validate_schema(value: Any, label: str, depth: int = 0) -> None:
    if depth > 12 or not isinstance(value, dict):
        raise WorkflowProposalError(_("Workflow {0} is invalid").format(label))
    _exact_keys(value, SCHEMA_KEYS, label)
    properties = value.get("properties")
    if properties is not None:
        if not isinstance(properties, dict) or len(properties) > 256:
            raise WorkflowProposalError(_("Workflow {0} properties are invalid").format(label))
        for name, schema in properties.items():
            if not isinstance(name, str) or not name or len(name) > 500:
                raise WorkflowProposalError(_("Workflow {0} property name is invalid").format(label))
            _validate_schema(schema, f"{label}.properties", depth + 1)
    items = value.get("items")
    if items is not None:
        _validate_schema(items, f"{label}.items", depth + 1)
    additional = value.get("additionalProperties")
    if additional is not None and not isinstance(additional, bool):
        _validate_schema(additional, f"{label}.additionalProperties", depth + 1)
    for composition in ("oneOf", "anyOf", "allOf"):
        schemas = value.get(composition)
        if schemas is not None:
            if not isinstance(schemas, list) or not schemas or len(schemas) > 32:
                raise WorkflowProposalError(_("Workflow {0}.{1} is invalid").format(label, composition))
            for schema in schemas:
                _validate_schema(schema, f"{label}.{composition}", depth + 1)


def _exact_keys(value: dict[str, Any], allowed: set[str], label: str) -> None:
    if set(value) - allowed:
        raise WorkflowProposalError(_("{0} contains an unknown field").format(label))


def _bounded_text(value: Any, label: str, maximum: int) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise WorkflowProposalError(_("{0} is invalid").format(label))
    return value.strip()


def _stable_request_id(idempotency_key: str, user: str) -> str:
    digest = sha256(f"{frappe.local.site}\0{user.lower()}\0{idempotency_key}".encode()).hexdigest()
    return f"frappe-plan-{digest[:40]}"
