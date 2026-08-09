from __future__ import annotations

import json
from typing import Any

import frappe
from frappe import _
from frappe.utils import now_datetime

from muster.muster.doctype.muster_workflow.muster_workflow import _graph_limits
from muster.orchestration.workflow_graph import (
    WorkflowGraphError,
    canonical_execution_manifest,
    canonical_snapshot,
    compile_legacy_snapshot,
    portable_definition,
    validate_graph,
)

AGENT_FIELDS = (
    "agent_name",
    "status",
    "agent_type",
    "description",
    "run_as_user",
    "module_scope",
    "doctype_scope",
    "policy",
    "instructions",
    "model_profile",
    "max_depth",
    "max_fan_out",
    "max_tool_calls",
)
CAPABILITY_FIELDS = (
    "capability",
    "resource_pattern",
    "risk_class",
    "requires_approval",
)
DELEGATION_FIELDS = (
    "delegate_agent",
    "allowed_capabilities",
    "max_depth",
    "max_fan_out",
    "requires_approval",
)
WORKFLOW_FIELDS = (
    "workflow_name",
    "description",
    "root_agent",
    "policy",
    "max_duration_minutes",
    "max_tool_calls",
    "max_model_calls",
    "max_tokens",
    "max_cost",
    "max_artifact_bytes",
)
NODE_FIELDS = (
    "node_id",
    "label",
    "node_type",
    "agent",
    "configuration_json",
    "approval_class",
    "timeout_seconds",
    "retry_limit",
)
EDGE_FIELDS = ("source_node", "target_node", "condition_expression", "priority")


def _pick(payload: dict[str, Any], fields: tuple[str, ...]) -> dict[str, Any]:
    return {field: payload.get(field) for field in fields if field in payload}


def _children(rows: list[dict[str, Any]] | None, fields: tuple[str, ...]) -> list[dict]:
    return [_pick(row, fields) for row in (rows or [])]


def _check_modified(doc, expected_modified: str | None) -> None:
    if not expected_modified:
        frappe.throw(_("Expected modified timestamp is required"), frappe.TimestampMismatchError)
    if str(doc.modified) != str(expected_modified):
        frappe.throw(
            _("This draft changed in another session. Reload it before saving."),
            frappe.TimestampMismatchError,
        )


def save_agent(payload: dict[str, Any]) -> dict[str, Any]:
    name = payload.get("name") or payload.get("agent_name")
    existing = frappe.db.exists("Muster Agent", name) if name else None
    if existing:
        doc = frappe.get_doc("Muster Agent", existing)
        if not doc.has_permission("write"):
            frappe.throw(_("Not permitted to edit this agent"), frappe.PermissionError)
        _check_modified(doc, payload.get("expected_modified"))
        if payload.get("agent_name") != doc.agent_name:
            frappe.throw(_("Agent names cannot be changed in Studio"), frappe.ValidationError)
    else:
        if not frappe.has_permission("Muster Agent", "create"):
            frappe.throw(_("Not permitted to create agents"), frappe.PermissionError)
        doc = frappe.new_doc("Muster Agent")

    doc.update(_pick(payload, AGENT_FIELDS))
    doc.set("capabilities", _children(payload.get("capabilities"), CAPABILITY_FIELDS))
    doc.set("delegations", _children(payload.get("delegations"), DELEGATION_FIELDS))
    doc.save()
    return _agent_response(doc)


def _agent_response(doc) -> dict[str, Any]:
    return {
        "name": doc.name,
        "agent_name": doc.agent_name,
        "status": doc.status,
        "agent_type": doc.agent_type,
        "description": doc.description,
        "run_as_user": doc.run_as_user,
        "module_scope": doc.module_scope,
        "doctype_scope": doc.doctype_scope,
        "policy": doc.policy,
        "instructions": doc.instructions,
        "model_profile": doc.model_profile,
        "max_depth": doc.max_depth,
        "max_fan_out": doc.max_fan_out,
        "max_tool_calls": doc.max_tool_calls,
        "capabilities": [_pick(row.as_dict(), CAPABILITY_FIELDS) for row in doc.capabilities],
        "delegations": [_pick(row.as_dict(), DELEGATION_FIELDS) for row in doc.delegations],
        "modified": str(doc.modified),
    }


def save_workflow_draft(payload: dict[str, Any]) -> dict[str, Any]:
    name = payload.get("name") or payload.get("workflow_name")
    existing = frappe.db.exists("Muster Workflow", name) if name else None
    if existing:
        doc = frappe.get_doc("Muster Workflow", existing)
        if not doc.has_permission("write"):
            frappe.throw(_("Not permitted to edit this workflow"), frappe.PermissionError)
        if doc.status == "Retired":
            frappe.throw(_("Retired workflows cannot be edited"), frappe.ValidationError)
        _check_modified(doc, payload.get("expected_modified"))
        if payload.get("workflow_name") != doc.workflow_name:
            frappe.throw(_("Workflow names cannot be changed in Studio"), frappe.ValidationError)
        doc.version = int(doc.version or 0) + 1
    else:
        if not frappe.has_permission("Muster Workflow", "create"):
            frappe.throw(_("Not permitted to create workflows"), frappe.PermissionError)
        doc = frappe.new_doc("Muster Workflow")
        doc.version = 1

    doc.update(_pick(payload, WORKFLOW_FIELDS))
    doc.status = "Draft"
    doc.set("nodes", _children(payload.get("nodes"), NODE_FIELDS))
    doc.set("edges", _children(payload.get("edges"), EDGE_FIELDS))
    doc.save()
    return _workflow_response(doc)


def validate_workflow_payload(payload: dict[str, Any]) -> dict[str, Any]:
    limits = _graph_limits()
    try:
        analysis = validate_graph(payload.get("nodes") or [], payload.get("edges") or [], limits)
        preview = portable_definition(
            payload,
            payload.get("nodes") or [],
            payload.get("edges") or [],
            limits,
            version=str(payload.get("version") or "draft"),
        )
        root = next(
            node for node in payload.get("nodes") or [] if node.get("node_id") == analysis.root
        )
        if root.get("agent") and root.get("agent") != payload.get("root_agent"):
            raise WorkflowGraphError(
                "root_agent_mismatch",
                "Root Agent must match the agent assigned to the graph entry node",
                "root_agent",
            )
    except WorkflowGraphError as exc:
        return {"valid": False, "issues": [exc.as_dict()]}
    return {"valid": True, "issues": [], "analysis": analysis.as_dict(), "graph": preview}


def publish_workflow(
    workflow_name: str, expected_modified: str, idempotency_key: str
) -> dict[str, Any]:
    existing_version = frappe.db.get_value(
        "Muster Workflow Version", {"idempotency_key": idempotency_key}, "name"
    )
    if existing_version:
        version_doc = frappe.get_doc("Muster Workflow Version", existing_version)
        if version_doc.workflow != workflow_name:
            frappe.throw(_("Idempotency key is already bound"), frappe.DuplicateEntryError)
        workflow = frappe.get_doc("Muster Workflow", workflow_name)
        if not workflow.has_permission("write"):
            frappe.throw(_("Not permitted to publish this workflow"), frappe.PermissionError)
        return _publication_response(version_doc, replayed=True)

    _lock_workflow(workflow_name)
    workflow = frappe.get_doc("Muster Workflow", workflow_name)
    if not workflow.has_permission("write"):
        frappe.throw(_("Not permitted to publish this workflow"), frappe.PermissionError)
    existing_version = frappe.db.get_value(
        "Muster Workflow Version", {"idempotency_key": idempotency_key}, "name"
    )
    if existing_version:
        version_doc = frappe.get_doc("Muster Workflow Version", existing_version)
        if version_doc.workflow != workflow_name:
            frappe.throw(_("Idempotency key is already bound"), frappe.DuplicateEntryError)
        return _publication_response(version_doc, replayed=True)
    if not frappe.has_permission("Muster Workflow Version", "create"):
        frappe.throw(_("Not permitted to publish workflow versions"), frappe.PermissionError)
    if workflow.status == "Retired":
        frappe.throw(_("Retired workflows cannot be published"), frappe.ValidationError)
    _check_modified(workflow, expected_modified)
    limits = _graph_limits()
    analysis = validate_graph(workflow.nodes, workflow.edges, limits)
    versions = frappe.get_all(
        "Muster Workflow Version",
        filters={"workflow": workflow.name},
        fields=["name", "version", "snapshot_hash", "docstatus"],
        order_by="version desc",
        limit_page_length=1,
    )
    next_version = int(versions[0].version if versions else 0) + 1
    graph_json, snapshot_hash = canonical_snapshot(
        workflow.as_dict(),
        workflow.nodes,
        workflow.edges,
        limits,
        version=str(next_version),
    )
    execution_manifest_json, execution_manifest_hash = canonical_execution_manifest(
        workflow.nodes, snapshot_hash
    )
    same_snapshot = frappe.db.get_value(
        "Muster Workflow Version",
        {
            "workflow": workflow.name,
            "snapshot_hash": snapshot_hash,
            "execution_manifest_hash": execution_manifest_hash,
            "docstatus": 1,
        },
        "name",
    )
    if same_snapshot:
        return _publication_response(
            frappe.get_doc("Muster Workflow Version", same_snapshot), replayed=True
        )
    version_doc = frappe.get_doc(
        {
            "doctype": "Muster Workflow Version",
            "workflow": workflow.name,
            "version": next_version,
            "schema_version": "1",
            "contract": "AgentGraphDefinition",
            "idempotency_key": idempotency_key,
            "published_by": frappe.session.user,
            "published_at": now_datetime(),
            "graph_json": graph_json,
            "snapshot_hash": snapshot_hash,
            "execution_manifest_json": execution_manifest_json,
            "execution_manifest_hash": execution_manifest_hash,
        }
    ).insert()
    version_doc.submit()
    workflow.status = "Published"
    workflow.published_version = version_doc.name
    workflow.published_at = version_doc.published_at
    workflow.save()
    response = _publication_response(version_doc, replayed=False)
    response["analysis"] = analysis.as_dict()
    return response


def _lock_workflow(name: str) -> None:
    if frappe.db.db_type == "sqlite":
        frappe.db.sql("select name from `tabMuster Workflow` where name=%s", name)
    else:
        frappe.db.sql(
            "select name from `tabMuster Workflow` where name=%s for update", name
        )


def _publication_response(doc, *, replayed: bool) -> dict[str, Any]:
    return {
        "workflow": doc.workflow,
        "version": doc.name,
        "version_number": doc.version,
        "snapshot_hash": doc.snapshot_hash,
        "contract": doc.contract or "Legacy Frappe Workflow Graph",
        "replayed": replayed,
        "published_at": str(doc.published_at),
    }


def compiled_version(version_name: str) -> dict[str, Any]:
    doc = frappe.get_doc("Muster Workflow Version", version_name)
    if not doc.has_permission("read"):
        frappe.throw(_("Not permitted to read this version"), frappe.PermissionError)
    return {
        "version": doc.name,
        "stored_hash": doc.snapshot_hash,
        "stored_contract": doc.contract or "Legacy Frappe Workflow Graph",
        "graph": compile_legacy_snapshot(doc.graph_json),
    }


def _workflow_response(doc) -> dict[str, Any]:
    return {
        **_pick(doc.as_dict(), WORKFLOW_FIELDS),
        "name": doc.name,
        "status": doc.status,
        "version": doc.version,
        "published_version": doc.published_version,
        "published_at": str(doc.published_at) if doc.published_at else None,
        "modified": str(doc.modified),
        "nodes": [_pick(row.as_dict(), NODE_FIELDS) for row in doc.nodes],
        "edges": [_pick(row.as_dict(), EDGE_FIELDS) for row in doc.edges],
    }
