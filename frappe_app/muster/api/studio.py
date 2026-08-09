from __future__ import annotations

import json
from typing import Any

import frappe
from frappe import _

from muster.orchestration import studio


def _require_post() -> None:
    if frappe.request and frappe.request.method != "POST":
        frappe.throw(_("This endpoint only accepts POST requests"), frappe.PermissionError)


def _object(value: dict | str) -> dict[str, Any]:
    payload = json.loads(value) if isinstance(value, str) else value
    if not isinstance(payload, dict):
        frappe.throw(_("Payload must be a JSON object"), frappe.ValidationError)
    return payload


def _idempotency_key(value: str | None) -> str:
    key = value or frappe.get_request_header("Idempotency-Key")
    if not key or len(key) > 140:
        frappe.throw(_("A valid Idempotency-Key is required"), frappe.ValidationError)
    return key


@frappe.whitelist()
def context() -> dict[str, Any]:
    if not frappe.has_permission("Muster Workflow", "read"):
        frappe.throw(_("Not permitted to open Muster Studio"), frappe.PermissionError)
    from muster.muster.doctype.muster_workflow.muster_workflow import _graph_limits

    limits = _graph_limits()
    return {
        "limits": {
            "maxDepth": limits.max_depth,
            "maxChildrenPerNode": limits.max_fan_out,
            "maxActiveNodes": limits.max_active_nodes,
            "maxRetries": limits.max_retries,
        },
        "can_create_agent": frappe.has_permission("Muster Agent", "create"),
        "can_create_workflow": frappe.has_permission("Muster Workflow", "create"),
        "can_publish": frappe.has_permission("Muster Workflow Version", "create"),
    }


@frappe.whitelist()
def get_agent(name: str) -> dict[str, Any]:
    doc = frappe.get_doc("Muster Agent", name)
    if not doc.has_permission("read"):
        frappe.throw(_("Not permitted"), frappe.PermissionError)
    return studio._agent_response(doc)


@frappe.whitelist()
def get_workflow(name: str) -> dict[str, Any]:
    doc = frappe.get_doc("Muster Workflow", name)
    if not doc.has_permission("read"):
        frappe.throw(_("Not permitted"), frappe.PermissionError)
    return studio._workflow_response(doc)


@frappe.whitelist()
def save_agent(payload: dict | str) -> dict[str, Any]:
    _require_post()
    return studio.save_agent(_object(payload))


@frappe.whitelist()
def save_workflow(payload: dict | str) -> dict[str, Any]:
    _require_post()
    return studio.save_workflow_draft(_object(payload))


@frappe.whitelist()
def validate_workflow(payload: dict | str) -> dict[str, Any]:
    _require_post()
    return studio.validate_workflow_payload(_object(payload))


@frappe.whitelist()
def publish_workflow(
    workflow: str,
    expected_modified: str,
    idempotency_key: str | None = None,
) -> dict[str, Any]:
    _require_post()
    return studio.publish_workflow(
        workflow, expected_modified, _idempotency_key(idempotency_key)
    )


@frappe.whitelist()
def compiled_version(version: str) -> dict[str, Any]:
    return studio.compiled_version(version)

