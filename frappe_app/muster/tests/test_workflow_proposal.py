from __future__ import annotations

import copy
import json
from hashlib import sha256
from uuid import uuid4
from unittest.mock import Mock, patch

import frappe
from frappe.tests import IntegrationTestCase

from muster.adapters.client import GatewayClientError
from muster.orchestration.workflow_proposal import (
    WorkflowProposalClarification,
    WorkflowProposalError,
    validate_compiled_graph,
    validate_workflow_descriptor,
)
from muster.orchestration.workflow_proposal import request_workflow_proposal
from muster.orchestration.workflow_proposal import publish_approved_proposal
from muster.orchestration.workflow_proposal import start_published_proposal_mission
from muster.orchestration.workflow_proposal import (
    _clarified_attended_values,
    _clarified_labeled_attended_values,
    _merge_explicit_attended_values,
    _normalize_explicit_attended_value,
    _objective_labeled_attended_values,
    _materialize_attended_crud_bundle,
    _host_attended_browser_plan,
)
from muster.orchestration.workflow_proposal import _host_structural_attended_values
from muster.orchestration.workflow_proposal import _exact_attended_catalog
from muster.orchestration.workflow_proposal import _attended_form_catalogs
from muster.orchestration.workflow_proposal import _attended_preview_projection
from muster.orchestration.workflow_proposal import assert_attended_update_revision
from muster.orchestration.workflow_proposal import preflight_attended_proposal_save
from muster.orchestration.workflow_proposal import verify_attended_proposal_record
from muster.orchestration.workflow_proposal import assert_attended_delete_revision
from muster.orchestration.workflow_proposal import assert_destructive_reviewer
from muster.orchestration.workflow_proposal import assert_attended_reviewer
from muster.orchestration.workflow_proposal import _destructive_proof_value
from muster.orchestration.workflow_proposal import _canonical_requested_scope


def descriptor():
    return {
        "schemaVersion": 1,
        "id": "invoice.followup.proposal",
        "version": "0.1.0-proposal",
        "meta": {
            "name": "Invoice follow-up",
            "description": "Review-only proposal",
            "phases": [{"title": "Review"}, {"title": "Verify"}],
        },
        "goal": "Review overdue invoices",
        "resultSchema": {"type": "object"},
        "budget": {"runtimeMs": 1000, "toolCalls": 4, "modelCalls": 2, "tokens": 1000, "costMicros": 100, "artifactBytes": 1000},
        "limits": {"maxDepth": 4, "maxChildrenPerNode": 4, "maxActiveNodes": 8, "maxRetries": 2, "maxParallelism": 2, "maxPhases": 4, "maxSteps": 12},
        "steps": [
            {
                "kind": "parallel", "label": "Inspect", "maxConcurrency": 2,
                "branches": [
                    {"kind": "agent", "label": "Analyst", "prompt": "Read invoices", "capabilities": ["frappe.invoice.read"],
                     "subagents": [{"kind": "agent", "label": "RBAC", "prompt": "Test denied records", "capabilities": ["frappe.invoice.read"]}]},
                    {"kind": "agent", "label": "Reporter", "prompt": "Summarize", "capabilities": ["frappe.invoice.read"]},
                ],
            },
            {"kind": "approval", "label": "Review", "prompt": "Approve publication", "requiredRoles": ["Muster Automation Manager"]},
            {"kind": "verification", "label": "Verify", "criteria": "Evidence is complete"},
        ],
    }


def compiled_graph():
    return {
        "schemaVersion": 1,
        "id": "invoice.followup.proposal",
        "version": "0.1.0-proposal",
        "entryNodeId": "n1-inspect",
        "nodes": [
            {"id": "n1-inspect", "kind": "parallel_map", "retryLimit": 2},
            {"id": "n2-analyst", "kind": "agent", "requestedCapabilities": ["frappe.invoice.read"], "retryLimit": 2},
            {"id": "n3-rbac", "kind": "agent", "requestedCapabilities": ["frappe.invoice.read"], "retryLimit": 2},
            {"id": "n4-reporter", "kind": "agent", "requestedCapabilities": ["frappe.invoice.read"], "retryLimit": 2},
            {"id": "n5-inspect-join", "kind": "transform", "retryLimit": 2},
            {"id": "n6-review", "kind": "approval", "retryLimit": 2},
            {"id": "n7-verify", "kind": "verification", "retryLimit": 2},
        ],
        "edges": [
            {"from": "n2-analyst", "to": "n3-rbac"},
            {"from": "n1-inspect", "to": "n2-analyst"},
            {"from": "n3-rbac", "to": "n5-inspect-join"},
            {"from": "n1-inspect", "to": "n4-reporter"},
            {"from": "n4-reporter", "to": "n5-inspect-join"},
            {"from": "n5-inspect-join", "to": "n6-review"},
            {"from": "n6-review", "to": "n7-verify"},
        ],
        "budget": descriptor()["budget"],
        "limits": {"maxDepth": 4, "maxChildrenPerNode": 4, "maxActiveNodes": 8, "maxRetries": 2},
    }


class TestWorkflowProposalValidation(IntegrationTestCase):
    def test_native_surface_doctype_is_strict_scope_ceiling(self):
        snapshot = {
            "doctype": "CRM Lead", "schema_hash": "a" * 64, "revision": "b" * 64,
            "authority": {"read": True, "create": True, "write": True}, "fields": [],
        }
        with (
            patch("muster.orchestration.workflow_proposal.frappe.get_all") as discovery,
            patch("muster.orchestration.workflow_proposal.effective_form_schema", return_value=snapshot),
        ):
            catalogs = _attended_form_catalogs(
                {"source": "spa-assistant", "route": "/crm/leads/view/list", "doctype": "CRM Lead"},
                "sales@example.test",
                "Create a CRM Lead with First Name Ada and Status New",
            )
        self.assertEqual([catalog["doctype"] for catalog in catalogs], ["CRM Lead"])
        discovery.assert_not_called()

    def test_home_page_create_uses_bounded_host_discovery_not_current_page_as_scope_ceiling(self):
        snapshot = {"doctype": "Customer", "schema_hash": "a" * 64, "revision": "b" * 64, "authority": {"read": True, "create": True, "write": True}, "fields": [{"fieldname": "customer_name", "label": "Customer Name", "fieldtype": "Data", "required": True, "has_default": False, "writable": True}]}
        with (
            patch("muster.orchestration.workflow_proposal.frappe.get_all", return_value=[frappe._dict(name="Customer")]) as discovery,
            patch("muster.orchestration.workflow_proposal.effective_form_schema", return_value=snapshot),
        ):
            catalogs = _attended_form_catalogs({"source": "desk", "route": "/desk", "scope_mode": "context"}, "sales@example.test", "Create a customer called ACME")
        self.assertEqual([catalog["doctype"] for catalog in catalogs], ["Customer"])
        self.assertIn("create", catalogs[0]["actions"])
        self.assertLessEqual(discovery.call_args.kwargs["limit_page_length"], 50)

    def test_exact_doctype_phrase_survives_noisy_clarification_discovery(self):
        snapshot = {
            "doctype": "Service Visit", "schema_hash": "a" * 64, "revision": "b" * 64,
            "authority": {"read": True, "create": True, "write": True}, "fields": [],
        }
        distractors = [frappe._dict(name=f"Customer Status Distractor {index}") for index in range(50)]
        with (
            patch(
                "muster.orchestration.workflow_proposal.frappe.get_all",
                side_effect=[[frappe._dict(name="Service Visit")], distractors],
            ) as discovery,
            patch("muster.orchestration.workflow_proposal.effective_form_schema", return_value=snapshot),
        ):
            catalogs = _attended_form_catalogs(
                {"source": "spa-assistant", "route": "/operations/visits", "scope_mode": "context"},
                "sales@example.test",
                "Create a Service Visit. Clarification: Customer and Scheduled On. "
                "Answer: Customer ACME; Scheduled On 2026-07-20; Status Planned.",
            )
        self.assertEqual(catalogs[0]["doctype"], "Service Visit")
        self.assertEqual(discovery.call_count, 2)

    def test_catalog_preserves_effective_customization_evidence_and_rejects_ambiguous_record_scope(self):
        snapshot = {
            "doctype": "Customer", "schema_hash": "a" * 64, "revision": "b" * 64,
            "authority": {"read": True, "create": True, "write": True},
            "doctype_property_setters": [{"name": "Customer-autoname"}],
            "fields": [{
                "fieldname": "custom_service_tier", "label": "Service Tier", "fieldtype": "Select",
                "required": True, "has_default": False, "writable": True,
                "provenance": {"source": "custom_field", "property_setters": [{"name": "mandatory-tier"}]},
            }],
        }
        scope = {
            "doctype": "Customer", "documents": [
                {"doctype": "Customer", "name": "ACME"},
                {"doctype": "Customer", "name": "BETA"},
            ],
        }
        with (
            patch("muster.orchestration.workflow_proposal.frappe.get_all", return_value=[]),
            patch("muster.orchestration.workflow_proposal.effective_form_schema", return_value=snapshot),
        ):
            catalog = _attended_form_catalogs(scope, "sales@example.test", "Update the Customer")[0]
        self.assertEqual(catalog["record_identity_state"], "ambiguous")
        self.assertIsNone(catalog["record_name"])
        self.assertNotIn("update", catalog["actions"])
        self.assertEqual(catalog["doctype_property_setter_count"], 1)
        self.assertEqual(catalog["fields"][0]["source"], "custom_field")
        self.assertEqual(catalog["fields"][0]["property_setter_count"], 1)

    def test_prompt_record_name_cannot_silently_override_ambiguous_scope(self):
        snapshot = {
            "doctype": "Customer", "schema_hash": "a" * 64, "revision": "b" * 64,
            "authority": {"read": True, "create": True, "write": True, "delete": True},
            "fields": [],
        }
        scope = {
            "doctype": "Customer", "documents": [
                {"doctype": "Customer", "name": "ACME"},
                {"doctype": "Customer", "name": "BETA"},
            ],
        }
        with patch("muster.orchestration.workflow_proposal.effective_form_schema", return_value=snapshot):
            catalog = _attended_form_catalogs(
                scope, "sales@example.test", "Update the Customer. The missing record is ACME",
            )[0]
        self.assertEqual(catalog["record_identity_state"], "ambiguous")
        self.assertIsNone(catalog["record_name"])
        self.assertNotIn("update", catalog["actions"])

    def test_verified_exact_record_evidence_resolves_one_ambiguous_candidate(self):
        snapshot = {
            "doctype": "Customer", "schema_hash": "a" * 64, "revision": "b" * 64,
            "authority": {"read": True, "create": True, "write": True, "delete": True},
            "fields": [],
        }
        scope = {
            "doctype": "Customer", "documents": [
                {"doctype": "Customer", "name": "ACME"},
                {"doctype": "Customer", "name": "BETA"},
            ],
        }
        identity = {"doctype": "Customer", "record_name": "ACME", "action": "update", "evidence_hash": "c" * 64}
        with (
            patch("muster.orchestration.workflow_proposal.effective_form_schema", return_value=snapshot),
            patch("muster.orchestration.workflow_proposal.frappe.db.exists", return_value=True),
            patch("muster.orchestration.workflow_proposal.frappe.has_permission", return_value=True),
        ):
            catalog = _attended_form_catalogs(
                scope, "sales@example.test", "Update the Customer. Clarification supplied by the user: ACME",
                verified_record_identity=identity,
            )[0]
        self.assertEqual(catalog["record_identity_state"], "unique")
        self.assertEqual(catalog["record_name"], "ACME")
        self.assertIn("update", catalog["actions"])
        self.assertEqual(scope["documents"][1]["name"], "BETA", "the original bound scope remains unchanged")

    def test_verified_exact_record_from_mission_control_becomes_scope_ceiling(self):
        snapshot = {
            "doctype": "Customer", "schema_hash": "a" * 64, "revision": "b" * 64,
            "authority": {"read": True, "create": True, "write": True, "delete": True},
            "fields": [],
        }
        scope = {"source": "desk", "route": "/desk/muster-control", "scope_mode": "context"}
        identity = {
            "doctype": "Customer", "record_name": "CUST-0001",
            "action": "update", "evidence_hash": "c" * 64,
        }
        with (
            patch("muster.orchestration.workflow_proposal.effective_form_schema", return_value=snapshot),
            patch("muster.orchestration.workflow_proposal.frappe.db.exists", return_value=True),
            patch("muster.orchestration.workflow_proposal.frappe.has_permission", return_value=True),
            patch("muster.orchestration.workflow_proposal.frappe.get_all") as discovery,
        ):
            catalogs = _attended_form_catalogs(
                scope, "sales@example.test",
                "Update the customer. Clarification supplied by the user: CUST-0001",
                verified_record_identity=identity,
            )
        self.assertEqual(len(catalogs), 1)
        self.assertEqual(catalogs[0]["doctype"], "Customer")
        self.assertEqual(catalogs[0]["record_name"], "CUST-0001")
        self.assertEqual(catalogs[0]["record_identity_state"], "unique")
        self.assertIn("update", catalogs[0]["actions"])
        discovery.assert_not_called()
        self.assertNotIn("doctype", scope, "the immutable reviewed page scope is not rewritten")

    def test_verified_record_cannot_escape_a_concrete_page_doctype(self):
        identity = {
            "doctype": "Supplier", "record_name": "SUP-0001",
            "action": "update", "evidence_hash": "c" * 64,
        }
        with self.assertRaisesRegex(WorkflowProposalError, "Verified record identity evidence is invalid"):
            _attended_form_catalogs(
                {"source": "desk", "route": "/desk/customer", "doctype": "Customer"},
                "sales@example.test", "Update SUP-0001",
                verified_record_identity=identity,
            )

    def test_proposal_request_admits_verified_mission_control_record_before_planning(self):
        frappe.set_user("Administrator")
        snapshot = {
            "doctype": "Customer", "schema_hash": "a" * 64, "revision": "b" * 64,
            "authority": {"read": True, "create": True, "write": True, "delete": True},
            "fields": [],
        }
        scope = {"source": "desk", "route": "/desk/muster-control", "scope_mode": "context"}
        identity = {
            "doctype": "Customer", "record_name": "CUST-0001",
            "action": "update", "evidence_hash": "c" * 64,
        }
        client = Mock()
        client.request.return_value = {}
        with (
            patch("muster.orchestration.workflow_proposal.frappe.has_permission", return_value=True),
            patch("muster.orchestration.workflow_proposal.frappe.db.get_value", return_value=None),
            patch("muster.orchestration.workflow_proposal.frappe.db.exists", return_value=True),
            patch("muster.orchestration.workflow_proposal.permission_filtered_context", return_value={}),
            patch("muster.orchestration.workflow_proposal.effective_form_schema", return_value=snapshot),
            patch("muster.orchestration.workflow_proposal._caller_capabilities", return_value=["frappe.browser.navigate"]),
            patch("muster.orchestration.workflow_proposal.run_authority_headers", return_value=({}, "csrf")),
            self.assertRaisesRegex(WorkflowProposalError, "invalid planning acknowledgement"),
        ):
            request_workflow_proposal(
                "Update the Customer CUST-0001", scope, f"mission-control-{uuid4().hex}",
                client=client, binding=Mock(), preferred_handoff_kind="attended_browser",
                verified_record_identity=identity,
            )
        planning_context = client.request.call_args.kwargs["payload"]["context"]
        catalog = planning_context["attended_form_catalog"]
        self.assertEqual(catalog[0]["doctype"], "Customer")
        self.assertEqual(catalog[0]["record_name"], "CUST-0001")

    def test_proposal_request_rejects_verified_record_doctype_tampering_before_planning(self):
        frappe.set_user("Administrator")
        client = Mock()
        identity = {
            "doctype": "Supplier", "record_name": "SUP-0001",
            "action": "update", "evidence_hash": "c" * 64,
        }
        with (
            patch("muster.orchestration.workflow_proposal.frappe.has_permission", return_value=True),
            patch("muster.orchestration.workflow_proposal.frappe.db.get_value", return_value=None),
            patch("muster.orchestration.workflow_proposal.permission_filtered_context", return_value={}),
            self.assertRaisesRegex(WorkflowProposalError, "Verified record identity evidence is invalid"),
        ):
            request_workflow_proposal(
                "Update SUP-0001", {"doctype": "Customer"}, f"tampered-doctype-{uuid4().hex}",
                client=client, binding=Mock(), preferred_handoff_kind="attended_browser",
                verified_record_identity=identity,
            )
        client.request.assert_not_called()

    def test_scope_disambiguation_is_bounded_and_deduplicated(self):
        duplicate = [{"doctype": "Customer", "name": "ACME"}] * 20
        admitted = _canonical_requested_scope({"doctype": "Customer", "documents": duplicate})
        self.assertEqual(admitted["documents"], [{"doctype": "Customer", "name": "ACME"}])
        with self.assertRaisesRegex(WorkflowProposalError, "documents are invalid or excessive"):
            _canonical_requested_scope({
                "doctype": "Customer",
                "documents": [{"doctype": "Customer", "name": f"CUST-{index:05d}"} for index in range(21)],
            })

    def test_ambiguous_or_unmatched_home_target_fails_closed_before_proposal_materialization(self):
        with patch("muster.orchestration.workflow_proposal.frappe.get_all", return_value=[]):
            catalogs = _attended_form_catalogs({"source": "desk", "route": "/desk"}, "sales@example.test", "Create a new record")
        self.assertEqual(catalogs, [])
        with self.assertRaisesRegex(WorkflowProposalError, "Name a live-readable DocType"):
            _materialize_attended_crud_bundle(descriptor(), compiled_graph(), catalogs, ["frappe.browser.navigate"])

    def test_update_without_unique_live_record_clarifies_before_gateway_planning(self):
        frappe.set_user("Administrator")
        client = Mock()
        catalogs = [{
            "doctype": "Customer", "record_name": None, "record_identity_state": "ambiguous",
            "actions": ["read"], "authority": {"read": True, "create": True, "write": True},
            "fields": [], "schema_hash": "a" * 64, "revision": "b" * 64,
        }]
        key = f"clarify-{uuid4().hex}"
        with patch("muster.orchestration.workflow_proposal._attended_form_catalogs", return_value=catalogs):
            result = request_workflow_proposal(
                "Update the Customer", {"doctype": "Customer"}, key,
                client=client, binding=Mock(), preferred_handoff_kind="attended_browser",
            )
        self.assertEqual(result["status"], "clarification")
        self.assertEqual(result["reason"], "Which exact Customer record should I update?")
        self.assertFalse(result["executed"])
        client.request.assert_not_called()
        self.assertFalse(frappe.db.exists("Muster Workflow Proposal", {"request_id": key}))

    def test_delete_without_unique_live_record_clarifies_before_gateway_planning(self):
        frappe.set_user("Administrator")
        client = Mock()
        catalogs = [{
            "doctype": "Customer", "record_name": None, "record_identity_state": "ambiguous",
            "actions": ["read"], "authority": {"read": True, "delete": True},
            "fields": [], "schema_hash": "a" * 64, "revision": "b" * 64,
        }]
        key = f"clarify-delete-{uuid4().hex}"
        with patch("muster.orchestration.workflow_proposal._attended_form_catalogs", return_value=catalogs):
            result = request_workflow_proposal(
                "Delete the Customer", {"doctype": "Customer"}, key,
                client=client, binding=Mock(), preferred_handoff_kind="attended_browser",
            )
        self.assertEqual(result["status"], "clarification")
        self.assertEqual(result["reason"], "Which exact Customer record should I delete?")
        self.assertFalse(result["executed"])
        client.request.assert_not_called()
        self.assertFalse(frappe.db.exists("Muster Workflow Proposal", {"request_id": key}))

    def test_missing_create_information_returns_structured_clarification_without_proposal(self):
        frappe.set_user("Administrator")
        client = Mock()
        request_id = None

        def proposed(_method, _path, **kwargs):
            nonlocal request_id
            request_id = kwargs["payload"]["requestId"]
            return {
                "schemaVersion": 1, "requestId": request_id, "status": "proposed",
                "proposal": descriptor(), "graph": compiled_graph(), "run": None,
            }

        client.request.side_effect = proposed
        key = f"create-clarify-{uuid4().hex}"
        with (
            patch("muster.orchestration.workflow_proposal.permission_filtered_context", return_value={}),
            patch("muster.orchestration.workflow_proposal._attended_form_catalogs", return_value=[{
                "doctype": "Customer", "record_name": None, "record_identity_state": "missing",
                "actions": ["create"], "authority": {"read": True, "create": True, "write": True},
                "fields": [], "schema_hash": "a" * 64, "revision": "b" * 64,
            }]),
            patch("muster.orchestration.workflow_proposal._caller_capabilities", return_value=["frappe.browser.navigate"]),
            patch("muster.orchestration.workflow_proposal.run_authority_headers", return_value=({}, "csrf")),
            patch("muster.orchestration.workflow_proposal._materialize_attended_crud_bundle", side_effect=WorkflowProposalClarification("What value should I use for Customer Name?")),
        ):
            result = request_workflow_proposal(
                "Create a Customer", {"doctype": "Customer"}, key,
                client=client, binding=Mock(), preferred_handoff_kind="attended_browser",
            )
        self.assertEqual(result, {
            "status": "clarification", "reason": "What value should I use for Customer Name?",
            "replayed": False, "executed": False,
        })
        self.assertIsNotNone(request_id)
        self.assertFalse(frappe.db.exists("Muster Workflow Proposal", {"request_id": key}))

    def test_governed_record_change_compiles_to_host_bound_attended_crud(self):
        effect = {
            "schemaVersion": 1, "capability": "frappe.record.update",
            "operation": {"kind": "record", "action": "update", "doctype": "Customer", "docname": "ACME", "values": {"customer_name": "Acme Ltd", "custom_service_tier": "Gold"}},
            "postconditions": [{"path": "$.customer_name", "operator": "equals", "expected": "Acme Ltd"}],
            "approvalClass": "single",
        }
        proposal = descriptor()
        proposal["steps"] = [{"kind": "execution", "label": "Update customer", "capabilities": ["frappe.record.update"], "execution": {"surface": "server_effect", "plan": effect}}]
        graph = compiled_graph()
        graph["entryNodeId"] = "n1-change"
        graph["nodes"] = [{"id": "n1-change", "kind": "command", "requestedCapabilities": ["frappe.record.update"], "retryLimit": 0, "executionIntent": {"surface": "server_effect", "plan": effect}}]
        graph["edges"] = []
        catalog = {
            "doctype": "Customer", "record_name": "ACME", "actions": ["read", "update"],
            "authority": {"read": True, "create": False, "write": True},
            "schema_hash": "a" * 64, "revision": "b" * 64,
            "fields": [
                {"fieldname": "customer_name", "label": "Customer Name", "fieldtype": "Data", "required": True, "has_default": False, "writable": True},
                {"fieldname": "custom_service_tier", "label": "Service Tier", "fieldtype": "Select", "options": "Silver\nGold", "required": False, "has_default": False, "writable": True},
            ],
        }
        authority = ["frappe.record.update", "frappe.browser.navigate", "frappe.browser.fill", "frappe.browser.select", "frappe.browser.click"]
        admitted_proposal, admitted_graph = _materialize_attended_crud_bundle(proposal, graph, catalog, authority)
        validated_proposal = validate_workflow_descriptor(admitted_proposal, authority)
        validated_graph = validate_compiled_graph(admitted_graph, validated_proposal, authority)
        plan = validated_graph["nodes"][0]["executionIntent"]["plan"]
        self.assertEqual(validated_graph["nodes"][0]["executionIntent"]["surface"], "browser")
        self.assertEqual(plan["attendedCrud"]["schema_hash"], "a" * 64)
        self.assertEqual(plan["attendedCrud"]["revision"], "b" * 64)
        self.assertEqual(plan["attendedCrud"]["fields"], ["custom_service_tier", "customer_name"])
        self.assertEqual(plan["actions"][-1]["postcondition"]["kind"], "record_saved")
        self.assertFalse(any("schema_hash" in json.dumps(step.get("execution", {})) for step in proposal["steps"]), "provider output was not trusted to author hashes")

        live_snapshot = {
            "fields": [
                {"fieldname": "customer_name", "label": "Customer Name", "writable": True},
                {"fieldname": "custom_service_tier", "label": "Service Tier", "writable": True},
            ],
        }
        proposal_doc = frappe._dict(name="MST-WFP-PREVIEW", objective="Update the customer", status="Proposed")
        with (
            patch("muster.orchestration.workflow_proposal.assert_form_schema_binding", return_value=live_snapshot),
            patch("muster.orchestration.workflow_proposal.frappe.db.get_value", return_value="2026-07-20 10:11:12.123456"),
        ):
            preview = _attended_preview_projection(plan, "sales@example.test", proposal_doc)
        self.assertEqual(preview["doctype"], "Customer")
        self.assertEqual([field["label"] for field in preview["fields"]], ["Service Tier", "Customer Name"])
        self.assertTrue(preview["save_requires_confirmation"])
        self.assertEqual(preview["record_revision"], "2026-07-20 10:11:12.123456")
        self.assertFalse(preview["save_authorized"])
        self.assertFalse(preview["executed"])
        self.assertNotIn("schema_hash", preview)
        self.assertNotIn("actions", preview)

    def test_attended_compiler_rejects_model_fields_outside_live_catalog(self):
        effect = {
            "schemaVersion": 1, "capability": "frappe.record.update",
            "operation": {"kind": "record", "action": "update", "doctype": "Customer", "docname": "ACME", "values": {"harmless_alias": "injected"}},
            "postconditions": [{"path": "$.harmless_alias", "operator": "equals", "expected": "injected"}], "approvalClass": "single",
        }
        proposal = descriptor()
        proposal["steps"] = [{"kind": "execution", "label": "Unsafe", "capabilities": ["frappe.record.update"], "execution": {"surface": "server_effect", "plan": effect}}]
        graph = compiled_graph(); graph["entryNodeId"] = "n1"; graph["nodes"] = [{"id": "n1", "kind": "command", "requestedCapabilities": ["frappe.record.update"], "retryLimit": 0, "executionIntent": {"surface": "server_effect", "plan": effect}}]; graph["edges"] = []
        catalog = {"doctype": "Customer", "record_name": "ACME", "actions": ["update"], "authority": {"read": True, "create": False, "write": True}, "schema_hash": "a" * 64, "revision": "b" * 64, "fields": []}
        with self.assertRaisesRegex(WorkflowProposalError, "unavailable"):
            _materialize_attended_crud_bundle(proposal, graph, catalog, ["frappe.browser.navigate", "frappe.browser.fill", "frappe.browser.click"])

    def test_attended_update_revision_recheck_denies_concurrent_change(self):
        preview = {
            "proposal": "MST-WFP-UPDATE", "operation": "update", "doctype": "Customer",
            "record_name": "ACME", "record_revision": "2026-07-20 10:11:12.123456",
        }
        with patch("muster.orchestration.workflow_proposal.attended_proposal_preview", return_value=preview):
            current = assert_attended_update_revision(
                "MST-WFP-UPDATE", "sales@example.test", "ACME", "2026-07-20 10:11:12.123456"
            )
            self.assertTrue(current["current"])
            self.assertFalse(current["executed"])
            with self.assertRaisesRegex(WorkflowProposalError, "changed after review"):
                assert_attended_update_revision(
                    "MST-WFP-UPDATE", "sales@example.test", "ACME", "2026-07-20 09:00:00.000000"
                )

    def test_attended_save_preflight_is_authorized_read_only_and_bound_to_client_receipt(self):
        update = {
            "proposal": "MST-WFP-UPDATE", "operation": "update", "doctype": "Customer",
            "record_name": "ACME", "record_revision": "2026-07-20 10:11:12.123456",
            "save_authorized": True, "fields": [{"fieldname": "customer_name", "label": "Customer Name", "control": "fill", "value": "Acme Ltd"}],
        }
        with patch("muster.orchestration.workflow_proposal.attended_proposal_preview", return_value=update):
            result = preflight_attended_proposal_save(
                "MST-WFP-UPDATE", "maker@example.test", "ACME", update["record_revision"],
            )
            self.assertTrue(result["current"])
            self.assertFalse(result["executed"])
            self.assertEqual(result["fields"], update["fields"])
            with self.assertRaisesRegex(WorkflowProposalError, "changed after review"):
                preflight_attended_proposal_save(
                    "MST-WFP-UPDATE", "maker@example.test", "ACME", "stale",
                )
        create = {**update, "operation": "create", "record_name": None, "record_revision": None}
        with patch("muster.orchestration.workflow_proposal.attended_proposal_preview", return_value=create):
            self.assertTrue(preflight_attended_proposal_save("MST-WFP-CREATE", "maker@example.test")["current"])
            with self.assertRaisesRegex(WorkflowProposalError, "cannot reuse"):
                preflight_attended_proposal_save("MST-WFP-CREATE", "maker@example.test", "ACME", "revision")
        with patch("muster.orchestration.workflow_proposal.attended_proposal_preview", return_value={**update, "save_authorized": False}):
            with self.assertRaisesRegex(WorkflowProposalError, "Approve this proposal"):
                preflight_attended_proposal_save(
                    "MST-WFP-UPDATE", "maker@example.test", "ACME", update["record_revision"],
                )

    def test_attended_verifier_compares_text_editor_semantics_but_keeps_data_exact(self):
        preview = {
            "operation": "create", "save_authorized": True,
            "doctype": "HD Ticket", "record_name": None,
            "fields": [
                {"fieldname": "subject", "value": "Printer fault"},
                {"fieldname": "description", "value": "Pauses after every third page"},
            ],
        }
        values = {
            "subject": "Printer fault",
            "description": "<p>Pauses after every third page</p>",
        }
        doc = Mock()
        doc.has_permission.return_value = True
        doc.get.side_effect = values.get
        doc.meta.get_field.side_effect = lambda fieldname: frappe._dict(
            fieldtype="Text Editor" if fieldname == "description" else "Data",
        )
        with (
            patch("muster.orchestration.workflow_proposal.attended_proposal_preview", return_value=preview),
            patch("muster.orchestration.workflow_proposal.frappe.get_doc", return_value=doc),
        ):
            verified = verify_attended_proposal_record("MST-WFP-EDITOR", "maker@example.test", "0009")
            self.assertTrue(verified["verified"])
            self.assertEqual(len(verified["proof_hash"]), 64)
            values["description"] = "<p>Different visible text</p>"
            with self.assertRaisesRegex(WorkflowProposalError, "did not retain"):
                verify_attended_proposal_record("MST-WFP-EDITOR", "maker@example.test", "0009")
            values.update(subject="<p>Printer fault</p>", description="<p>Pauses after every third page</p>")
            with self.assertRaisesRegex(WorkflowProposalError, "did not retain"):
                verify_attended_proposal_record("MST-WFP-EDITOR", "maker@example.test", "0009")

    def test_attended_verifier_reports_bounded_multiline_lifecycle_adjustment(self):
        preview = {
            "operation": "update", "save_authorized": True,
            "doctype": "Service Visit", "record_name": "SV-0001",
            "fields": [
                {"fieldname": "status", "value": "In Progress"},
                {"fieldname": "notes", "value": "Reviewed instructions"},
            ],
        }
        values = {
            "status": "In Progress",
            "notes": "Reviewed instructions\n[Muster Demo Customer Snapshot] ACME",
        }
        doc = Mock()
        doc.has_permission.return_value = True
        doc.get.side_effect = values.get
        doc.meta.get_field.side_effect = lambda fieldname: frappe._dict(
            fieldtype="Small Text" if fieldname == "notes" else "Select",
        )
        with (
            patch("muster.orchestration.workflow_proposal.attended_proposal_preview", return_value=preview),
            patch("muster.orchestration.workflow_proposal.frappe.get_doc", return_value=doc),
        ):
            verified = verify_attended_proposal_record("MST-WFP-LIFECYCLE", "maker@example.test", "SV-0001")
            self.assertEqual(verified["server_adjusted_fields"], ["notes"])
            values["status"] = "Completed"
            with self.assertRaisesRegex(WorkflowProposalError, "did not retain"):
                verify_attended_proposal_record("MST-WFP-LIFECYCLE", "maker@example.test", "SV-0001")
            values.update(status="In Progress", notes="Server replaced the reviewed instructions")
            with self.assertRaisesRegex(WorkflowProposalError, "did not retain"):
                verify_attended_proposal_record("MST-WFP-LIFECYCLE", "maker@example.test", "SV-0001")

    def test_delete_compiles_to_host_review_and_requires_independent_live_proof(self):
        effect = {
            "schemaVersion": 1, "capability": "frappe.record.delete",
            "operation": {"kind": "record", "action": "delete", "doctype": "Customer", "docname": "ACME"},
            "postconditions": [{"path": "$.deleted", "operator": "equals", "expected": True}],
            "approvalClass": "dual_control",
        }
        proposal = descriptor()
        proposal["steps"] = [{"kind": "execution", "label": "Delete customer", "capabilities": ["frappe.record.delete"], "execution": {"surface": "server_effect", "plan": effect}}]
        graph = compiled_graph()
        graph["entryNodeId"] = "n1-delete"
        graph["nodes"] = [{"id": "n1-delete", "kind": "command", "requestedCapabilities": ["frappe.record.delete"], "retryLimit": 0, "executionIntent": {"surface": "server_effect", "plan": effect}}]
        graph["edges"] = []
        catalog = {
            "doctype": "Customer", "record_name": "ACME", "record_identity_state": "unique",
            "actions": ["read", "delete"], "authority": {"read": True, "create": False, "write": False, "delete": True},
            "schema_hash": "a" * 64, "revision": "b" * 64, "fields": [],
        }
        authority = ["frappe.record.delete", "frappe.browser.navigate", "frappe.browser.click", "frappe.browser.read_visible"]
        admitted, compiled = _materialize_attended_crud_bundle(
            proposal, graph, catalog, authority, objective="Delete Customer ACME",
        )
        admitted = validate_workflow_descriptor(admitted, authority)
        compiled = validate_compiled_graph(compiled, admitted, authority)
        plan = compiled["nodes"][0]["executionIntent"]["plan"]
        self.assertEqual(plan["attendedCrud"]["operation"], "delete")
        self.assertEqual(plan["attendedCrud"]["fields"], [])
        self.assertEqual([action["kind"] for action in plan["actions"]], ["navigate", "click", "read_visible"])
        self.assertEqual(plan["actions"][1]["target"]["name"], "Menu")
        self.assertEqual(plan["actions"][2]["target"]["name"], "Delete")

        canonical_graph = json.dumps(compiled, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        proposal_doc = frappe._dict(
            name="MST-WFP-DELETE", objective="Delete Customer ACME", status="Approved",
            requested_by="maker@example.test", reviewed_by="checker@example.test", reviewed_at="2026-07-20 12:00:00",
            descriptor_hash="c" * 64, compiled_graph_hash=sha256(canonical_graph.encode()).hexdigest(),
            compiled_graph_json=json.dumps(compiled),
        )
        proposal_doc.destructive_record_revision = "2026-07-20 10:11:12.123456"
        proposal_doc.destructive_approval_proof = _destructive_proof_value(
            proposal_doc, plan["attendedCrud"], proposal_doc.destructive_record_revision,
        )
        with (
            patch("muster.orchestration.workflow_proposal.assert_form_schema_binding", return_value={"fields": []}),
            patch("muster.orchestration.workflow_proposal.frappe.db.get_value", return_value="2026-07-20 10:11:12.123456"),
            patch("muster.orchestration.workflow_proposal.frappe.get_roles", return_value=["Muster Approver"]),
        ):
            preview = _attended_preview_projection(plan, "maker@example.test", proposal_doc)
        self.assertTrue(preview["delete_authorized"])
        self.assertTrue(preview["delete_requires_confirmation"])
        self.assertEqual(len(preview["approval_proof"]), 64)
        self.assertFalse(preview["executed"])
        self.assertNotIn("actions", preview)

        with patch("muster.orchestration.workflow_proposal.attended_proposal_preview", return_value=preview):
            current = assert_attended_delete_revision(
                proposal_doc.name, "maker@example.test", "ACME", preview["record_revision"], preview["approval_proof"],
            )
            self.assertTrue(current["current"])
            self.assertFalse(current["executed"])
            with self.assertRaisesRegex(WorkflowProposalError, "approval evidence"):
                assert_attended_delete_revision(
                    proposal_doc.name, "maker@example.test", "ACME", preview["record_revision"], "d" * 64,
                )

    def test_delete_maker_cannot_self_approve_and_manager_is_not_destructive_checker(self):
        graph = {"nodes": [{"executionIntent": {"surface": "browser", "plan": {
            "schemaVersion": 1, "actionBudget": 1,
            "actions": [{"kind": "navigate", "route": "/desk/customer/ACME", "doctype": "Customer", "recordName": "ACME"}],
            "attendedCrud": {"operation": "delete", "doctype": "Customer", "record_name": "ACME", "fields": [], "schema_hash": "a" * 64, "revision": "b" * 64},
        }}}]}
        canonical = json.dumps(graph, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        proposal = frappe._dict(requested_by="maker@example.test", compiled_graph_json=json.dumps(graph), compiled_graph_hash=sha256(canonical.encode()).hexdigest())
        with self.assertRaises(frappe.PermissionError):
            assert_destructive_reviewer(proposal, "maker@example.test")
        with patch("muster.orchestration.workflow_proposal.frappe.get_roles", return_value=["Muster Automation Manager"]):
            with self.assertRaises(frappe.PermissionError):
                assert_destructive_reviewer(proposal, "manager@example.test")
        with patch("muster.orchestration.workflow_proposal.frappe.get_roles", return_value=["Muster Approver"]):
            assert_destructive_reviewer(proposal, "checker@example.test")

    def test_exact_record_update_requires_a_different_authorized_checker(self):
        graph = {"nodes": [{"executionIntent": {"surface": "browser", "plan": {
            "schemaVersion": 1, "actionBudget": 1,
            "actions": [{"kind": "navigate", "route": "/desk/customer/ACME", "doctype": "Customer", "recordName": "ACME"}],
            "attendedCrud": {"operation": "update", "doctype": "Customer", "record_name": "ACME", "fields": [], "schema_hash": "a" * 64, "revision": "b" * 64},
        }}}]}
        canonical = json.dumps(graph, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        proposal = frappe._dict(
            requested_by="maker@example.test", compiled_graph_json=json.dumps(graph),
            compiled_graph_hash=sha256(canonical.encode()).hexdigest(),
        )
        with patch("muster.orchestration.workflow_proposal.frappe.get_roles", return_value=["Muster Approver"]):
            with self.assertRaises(frappe.PermissionError):
                assert_attended_reviewer(proposal, "maker@example.test")
            assert_attended_reviewer(proposal, "checker@example.test")
        with patch("muster.orchestration.workflow_proposal.frappe.get_roles", return_value=["Muster Viewer"]):
            with self.assertRaises(frappe.PermissionError):
                assert_attended_reviewer(proposal, "viewer@example.test")

    def test_attended_create_clarifies_missing_or_invented_required_values_and_accepts_live_default(self):
        def bundle(values):
            effect = {
                "schemaVersion": 1, "capability": "frappe.record.create",
                "operation": {"kind": "record", "action": "create", "doctype": "Customer", "values": values},
                "postconditions": [], "approvalClass": "single",
            }
            proposal = descriptor()
            proposal["steps"] = [{"kind": "execution", "label": "Create", "capabilities": ["frappe.record.create"], "execution": {"surface": "server_effect", "plan": effect}}]
            graph = compiled_graph(); graph["entryNodeId"] = "n1"; graph["nodes"] = [{"id": "n1", "kind": "command", "requestedCapabilities": ["frappe.record.create"], "retryLimit": 0, "executionIntent": {"surface": "server_effect", "plan": effect}}]; graph["edges"] = []
            return proposal, graph

        catalog = {
            "doctype": "Customer", "record_name": None, "record_identity_state": "missing",
            "actions": ["create"], "authority": {"read": True, "create": True, "write": True},
            "schema_hash": "a" * 64, "revision": "b" * 64,
            "fields": [
                {"fieldname": "customer_name", "label": "Customer Name", "fieldtype": "Data", "required": True, "has_default": False, "writable": True},
                {"fieldname": "customer_type", "label": "Customer Type", "fieldtype": "Select", "options": "Company\nIndividual", "required": True, "has_default": True, "writable": True},
                {"fieldname": "custom_service_tier", "label": "Service Tier", "fieldtype": "Select", "options": "Silver\nGold", "required": False, "has_default": False, "writable": True},
            ],
        }
        authority = ["frappe.browser.navigate", "frappe.browser.click", "frappe.browser.fill", "frappe.browser.select"]
        proposal, graph = bundle({"custom_service_tier": "Gold"})
        with self.assertRaisesRegex(WorkflowProposalClarification, r"What value should I use for Customer Name\?"):
            _materialize_attended_crud_bundle(proposal, graph, catalog, authority, objective="Create a Gold customer")

        proposal, graph = bundle({"customer_name": "Invented Corp"})
        with self.assertRaisesRegex(WorkflowProposalClarification, r"What value should I use for Customer Name\?"):
            _materialize_attended_crud_bundle(proposal, graph, catalog, authority, objective="Create a Customer")

        proposal, graph = bundle({"customer_name": "ACME"})
        admitted, compiled = _materialize_attended_crud_bundle(
            proposal, graph, catalog, authority, objective="Create a Customer called ACME",
        )
        self.assertEqual(compiled["nodes"][0]["executionIntent"]["plan"]["attendedCrud"]["fields"], ["customer_name"])
        self.assertNotIn("customer_type", json.dumps(compiled["nodes"][0]["executionIntent"]["plan"]["actions"]))

        proposal, graph = bundle({"customer_name": "ACME", "custom_service_tier": "Platinum"})
        with self.assertRaisesRegex(WorkflowProposalClarification, r"Choose an available value for Service Tier: Silver, Gold"):
            _materialize_attended_crud_bundle(
                proposal, graph, catalog, authority,
                objective="Create a Customer called ACME with Service Tier Platinum",
            )

    def test_attended_clarification_replaces_the_disputed_live_form_value(self):
        catalog = {
            "fields": [
                {"fieldname": "customer_group", "label": "Customer Group"},
                {"fieldname": "customer_name", "label": "Customer Name"},
            ],
        }
        objective = (
            "Create a Customer named Native Proof with Customer Group Commercial."
            "\n\nClarification requested by Muster:\n"
            "Which existing permitted value should I use for Customer Group?"
            "\n\nUser's answer to that clarification:\n"
            "Frappeverse Customers"
        )
        self.assertEqual(
            _clarified_attended_values(objective, catalog),
            {"customer_group": "Frappeverse Customers"},
        )
        self.assertEqual(
            _clarified_attended_values(
                objective.replace("Customer Group?", "Unknown Field?"), catalog,
            ),
            {},
        )

    def test_signed_clarification_wins_over_an_earlier_ambiguous_field_phrase(self):
        catalog = {
            "doctype": "Purchase Order", "record_name": None,
            "schema_hash": "a" * 64, "revision": "b" * 64,
            "fields": [{
                "fieldname": "supplier", "label": "Supplier", "fieldtype": "Link",
                "options": "Supplier", "required": True, "has_default": False,
                "writable": True, "create_writable": True,
            }, {
                "fieldname": "status", "label": "Status", "fieldtype": "Data",
                "required": False, "has_default": True,
                "writable": True, "create_writable": True,
            }, {
                "fieldname": "workflow_state", "label": "Status", "fieldtype": "Data",
                "required": False, "has_default": True,
                "writable": True, "create_writable": True,
            }],
        }
        objective = (
            "Create a Purchase Order, supplier Frappeverse Supplier 001, PO date today."
            "\n\nClarification requested by Muster:\n"
            "Which existing permitted value should I use for Supplier?"
            "\n\nUser's answer to that clarification:\n"
            "Frappeverse Supplier 001"
        )
        with (
            patch("muster.orchestration.workflow_proposal.frappe.db.exists", return_value=True),
            patch("muster.orchestration.workflow_proposal.frappe.has_permission", return_value=True),
        ):
            plan = _host_attended_browser_plan(
                "create", {
                    "supplier": "provider guess",
                    "status": "provider-generated draft state",
                    "supplier_name_hallucination": "must not cross the live schema boundary",
                }, catalog, objective=objective,
            )
        fill = next(action for action in plan["actions"] if action["kind"] == "fill")
        self.assertEqual(fill["value"], "Frappeverse Supplier 001")

    def test_required_read_only_create_field_is_left_to_native_form_validation(self):
        catalog = {
            "doctype": "Request for Quotation", "record_name": None,
            "schema_hash": "a" * 64, "revision": "b" * 64,
            "fields": [{
                "fieldname": "subject", "label": "Subject", "fieldtype": "Data",
                "required": True, "has_default": False,
                "writable": True, "create_writable": True,
            }, {
                "fieldname": "status", "label": "Status", "fieldtype": "Data",
                "required": True, "has_default": False,
                "writable": False, "create_writable": False,
            }],
        }
        plan = _host_attended_browser_plan(
            "create", {"subject": "Training quotation"}, catalog,
            objective="Create a Request for Quotation. Subject: Training quotation.",
        )
        self.assertTrue(any(action["kind"] == "fill" for action in plan["actions"]))

    def test_plain_english_link_value_stops_before_the_next_comma_clause(self):
        catalog = {"fields": [{
            "fieldname": "supplier", "label": "Supplier", "fieldtype": "Link",
            "required": True,
        }]}
        parent, children = _objective_labeled_attended_values(
            "Create a Purchase Order, supplier Frappeverse Supplier 001, PO date today.",
            catalog,
        )
        self.assertEqual(parent, {"supplier": "Frappeverse Supplier 001"})
        self.assertEqual(children, {})

    def test_plain_english_clarification_can_resolve_a_child_link_alias(self):
        catalog = {"fields": [{
            "fieldname": "items", "label": "Items", "fieldtype": "Table",
            "child_fields": [{
                "fieldname": "item_code", "label": "Item Code", "fieldtype": "Link",
                "required": True, "writable": True,
            }],
        }]}
        objective = (
            "Create a Purchase Order."
            "\n\nClarification requested by Muster:\n"
            "What value should I use for Item Code, Item Name?"
            "\n\nUser's answer to that clarification:\n"
            "Item MFD-ITEM-001"
        )
        parent, children = _clarified_labeled_attended_values(objective, catalog)
        self.assertEqual(parent, {})
        self.assertEqual(children, {"items": {"item_code": "MFD-ITEM-001"}})

    def test_plain_clarification_answer_binds_to_one_signed_child_field(self):
        catalog = {"fields": [{
            "fieldname": "items", "label": "Items", "fieldtype": "Table",
            "child_fields": [{
                "fieldname": "uom", "label": "UOM", "fieldtype": "Link",
                "required": True, "writable": True,
            }],
        }]}
        objective = (
            "Create a Request for Quotation."
            "\n\nClarification requested by Muster:\n"
            "Which existing permitted value should I use for UOM?"
            "\n\nUser's answer to that clarification:\n"
            "Nos"
        )
        parent, children = _clarified_labeled_attended_values(objective, catalog)
        self.assertEqual(parent, {})
        self.assertEqual(children, {"items": {"uom": "Nos"}})

    def test_plain_english_add_verb_can_introduce_a_child_link(self):
        catalog = {"fields": [{
            "fieldname": "items", "label": "Items", "fieldtype": "Table",
            "child_fields": [
                {"fieldname": "item_code", "label": "Item Code", "fieldtype": "Link", "required": True, "writable": True},
                {"fieldname": "qty", "label": "Quantity", "fieldtype": "Float", "required": True, "writable": True},
            ],
        }]}
        parent, children = _objective_labeled_attended_values(
            "Create a Purchase Order. Add item MFD-ITEM-001, quantity 2.", catalog,
        )
        self.assertEqual(parent, {})
        self.assertEqual(children, {"items": {"item_code": "MFD-ITEM-001", "qty": "2"}})

    def test_provider_cannot_introduce_an_unmentioned_child_table(self):
        catalog = {
            "doctype": "Purchase Invoice", "record_name": None,
            "schema_hash": "a" * 64, "revision": "b" * 64,
            "fields": [{
                "fieldname": "items", "label": "Items", "fieldtype": "Table",
                "required": True, "writable": True, "create_writable": True,
                "child_doctype": "Purchase Invoice Item", "child_fields": [{
                    "fieldname": "item_code", "label": "Item Code", "fieldtype": "Data",
                    "required": True, "writable": True,
                }],
            }, {
                "fieldname": "taxes", "label": "Taxes", "fieldtype": "Table",
                "required": False, "writable": True, "create_writable": True,
                "child_doctype": "Purchase Taxes and Charges", "child_fields": [{
                    "fieldname": "account_head", "label": "Account Head", "fieldtype": "Data",
                    "required": True, "writable": True,
                }, {
                    "fieldname": "description", "label": "Description", "fieldtype": "Data",
                    "required": True, "writable": True,
                }],
            }],
        }
        plan = _host_attended_browser_plan(
            "create",
            {
                "items": [{"item_code": "MFD-ITEM-040"}],
                "taxes": [{"account_head": "provider guess", "description": "provider guess"}],
            },
            catalog,
            objective="Create a Purchase Invoice. Item Code: MFD-ITEM-040.",
        )
        rendered = json.dumps(plan)
        self.assertIn("MFD-ITEM-040", rendered)
        self.assertNotIn("account_head", rendered)
        self.assertNotIn("provider guess", rendered)

    def test_dynamic_link_is_bound_to_the_live_grounded_selector(self):
        catalog = {
            "doctype": "Payment Entry", "record_name": None,
            "schema_hash": "a" * 64, "revision": "b" * 64,
            "fields": [{
                "fieldname": "party_type", "label": "Party Type", "fieldtype": "Link",
                "options": "DocType", "required": True, "writable": True, "create_writable": True,
            }, {
                "fieldname": "party", "label": "Party", "fieldtype": "Dynamic Link",
                "options": "party_type", "required": True, "writable": True, "create_writable": True,
            }],
        }
        objective = "Create a Payment Entry. Party Type: Supplier. Party: Frappeverse Supplier 001."
        with (
            patch("muster.orchestration.workflow_proposal.frappe.db.exists", return_value=True),
            patch("muster.orchestration.workflow_proposal.frappe.has_permission", return_value=True),
        ):
            plan = _host_attended_browser_plan(
                "create", {"party_type": "Supplier", "party": "Frappeverse Supplier 001"},
                catalog, objective=objective,
            )
        rendered = json.dumps(plan)
        self.assertIn("Frappeverse Supplier 001", rendered)
        self.assertIn("party_type", rendered)

    def test_dynamic_link_rejects_a_missing_selector(self):
        catalog = {
            "doctype": "Payment Entry", "record_name": None,
            "schema_hash": "a" * 64, "revision": "b" * 64,
            "fields": [{
                "fieldname": "party_type", "label": "Party Type", "fieldtype": "Link",
                "options": "DocType", "required": True, "writable": True, "create_writable": True,
            }, {
                "fieldname": "party", "label": "Party", "fieldtype": "Dynamic Link",
                "options": "party_type", "required": True, "writable": True, "create_writable": True,
            }],
        }
        with self.assertRaisesRegex(WorkflowProposalClarification, "after choosing Party Type"):
            _host_attended_browser_plan(
                "create", {"party": "Frappeverse Supplier 001"}, catalog,
                objective="Create a Payment Entry. Party: Frappeverse Supplier 001.",
            )

    def test_attended_clarification_retains_every_prior_field_answer(self):
        catalog = {"fields": [
            {"fieldname": "company", "label": "Company"},
            {"fieldname": "supplier", "label": "Supplier"},
        ]}
        objective = (
            "Create a Purchase Order."
            "\n\nClarification requested by Muster:\n"
            "Which existing permitted value should I use for Company?"
            "\n\nUser's answer to that clarification:\n"
            "Muster Frappeverse Demo"
            "\n\nClarification requested by Muster:\n"
            "Which existing permitted value should I use for Supplier?"
            "\n\nUser's answer to that clarification:\n"
            "Frappeverse Supplier 001"
        )
        self.assertEqual(_clarified_attended_values(objective, catalog), {
            "company": "Muster Frappeverse Demo",
            "supplier": "Frappeverse Supplier 001",
        })

    def test_explicit_live_labels_override_provider_mapping_for_parent_and_child_fields(self):
        catalog = {"fields": [
            {"fieldname": "company", "label": "Company", "fieldtype": "Link"},
            {"fieldname": "supplier", "label": "Supplier", "fieldtype": "Link"},
            {"fieldname": "currency", "label": "Currency", "fieldtype": "Link"},
            {"fieldname": "items", "label": "Items", "fieldtype": "Table", "child_fields": [
                {"fieldname": "qty", "label": "Quantity", "fieldtype": "Float", "writable": True},
                {"fieldname": "uom", "label": "UOM", "fieldtype": "Link", "writable": True},
                {"fieldname": "rate", "label": "Rate", "fieldtype": "Currency", "writable": True},
                {"fieldname": "warehouse", "label": "Target Warehouse", "fieldtype": "Link", "writable": True},
            ]},
        ]}
        objective = (
            "Create a Purchase Order. Company: Muster Frappeverse Demo. "
            "Supplier: Frappeverse Supplier 001. Quantity: 2, UOM: Nos, "
            "Rate: INR 1,250, warehouse: Stores - MFD. Currency: INR."
            "\n\nClarification requested by Muster:\nIgnore: this transcript"
        )
        parent, rows = _objective_labeled_attended_values(objective, catalog)
        self.assertEqual(parent, {
            "company": "Muster Frappeverse Demo",
            "supplier": "Frappeverse Supplier 001",
            "currency": "INR",
        })
        self.assertEqual(rows, {"items": {
            "qty": "2", "uom": "Nos", "rate": "1250", "warehouse": "Stores - MFD",
        }})

    def test_longest_exact_live_doctype_phrase_is_authoritative(self):
        catalogs = [
            {"doctype": "Order"},
            {"doctype": "Purchase Order"},
            {"doctype": "Material Request"},
        ]
        self.assertEqual(
            _exact_attended_catalog(catalogs, "Create a Purchase Order with one item"),
            {"doctype": "Purchase Order"},
        )
        self.assertIsNone(_exact_attended_catalog(catalogs, "Prepare a buying document"))

    def test_explicit_live_values_repair_missing_or_malformed_provider_rows(self):
        parent = {"supplier": "Frappeverse Supplier 001", "currency": "INR"}
        child = {"items": {
            "item_code": "MFD-ITEM-001", "qty": "2", "uom": "Nos",
            "rate": "1250", "warehouse": "Stores - MFD",
        }}
        expected_row = child["items"]

        missing = _merge_explicit_attended_values(
            {"supplier": "wrong", "items": "Items"}, parent, child,
        )
        self.assertEqual(missing["supplier"], "Frappeverse Supplier 001")
        self.assertEqual(missing["currency"], "INR")
        self.assertEqual(missing["items"], [expected_row])

        partial = _merge_explicit_attended_values(
            {"items": [{"item_code": "wrong", "description": "Keep provider detail"}]},
            parent,
            child,
        )
        self.assertEqual(partial["items"], [{
            **expected_row,
            "description": "Keep provider detail",
        }])

    def test_relative_date_is_normalized_before_native_form_execution(self):
        self.assertEqual(_normalize_explicit_attended_value("Date", "today"), frappe.utils.nowdate())
        self.assertEqual(_normalize_explicit_attended_value("Date", "15 August 2026"), "2026-08-15")
        self.assertIsNone(_normalize_explicit_attended_value("Date", "whenever the provider wants"))

    def test_host_corrects_one_customer_date_phrase_before_attended_plans_are_hashed(self):
        effect = {
            "schemaVersion": 1, "capability": "frappe.record.create",
            "operation": {
                "kind": "record", "action": "create", "doctype": "Service Visit",
                "values": {
                    "customer": "006 scheduled on 2026-07-26",
                    "scheduled_on": "2026-07-26", "status": "Planned",
                    "notes": "Host verified cryptographic proof",
                },
            },
            "postconditions": [], "approvalClass": "single",
        }
        proposal = descriptor()
        proposal["steps"] = [{
            "kind": "execution", "label": "Create", "capabilities": ["frappe.record.create"],
            "execution": {"surface": "server_effect", "plan": effect},
        }]
        graph = compiled_graph()
        graph["entryNodeId"] = "n1"
        graph["nodes"] = [{
            "id": "n1", "kind": "command", "requestedCapabilities": ["frappe.record.create"],
            "retryLimit": 0, "executionIntent": {"surface": "server_effect", "plan": effect},
        }]
        graph["edges"] = []
        catalog = {
            "doctype": "Service Visit", "record_name": None, "record_identity_state": "missing",
            "actions": ["create"], "authority": {"read": True, "create": True, "write": True},
            "schema_hash": "a" * 64, "revision": "b" * 64,
            "fields": [
                {"fieldname": "customer", "label": "Customer", "fieldtype": "Link", "options": "Customer", "required": True, "has_default": False, "writable": True},
                {"fieldname": "scheduled_on", "label": "Scheduled On", "fieldtype": "Date", "required": True, "has_default": False, "writable": True},
                {"fieldname": "status", "label": "Status", "fieldtype": "Select", "options": "Planned\nCompleted", "required": True, "has_default": False, "writable": True},
                {"fieldname": "notes", "label": "Notes", "fieldtype": "Small Text", "required": False, "has_default": False, "writable": True},
            ],
        }
        objective = (
            "Create a Service Visit for Frappeverse Customer 006 scheduled on 2026-07-26 "
            "with Status Planned and Notes Host verified cryptographic proof."
        )
        authority = [
            "frappe.browser.navigate", "frappe.browser.click", "frappe.browser.fill",
            "frappe.browser.select",
        ]
        with (
            patch("muster.orchestration.workflow_proposal.frappe.db.exists", return_value=True),
            patch("muster.orchestration.workflow_proposal.frappe.has_permission", return_value=True),
        ):
            admitted, compiled = _materialize_attended_crud_bundle(
                proposal, graph, catalog, authority,
                requested_kind="attended_browser", objective=objective,
            )
        descriptor_plan = admitted["steps"][0]["execution"]["plan"]
        graph_plan = compiled["nodes"][0]["executionIntent"]["plan"]
        for plan in (descriptor_plan, graph_plan):
            values = {action.get("field"): action.get("value") for action in plan["actions"] if action.get("field")}
            self.assertEqual(values["customer"], "Frappeverse Customer 006")
            self.assertEqual(values["scheduled_on"], "2026-07-26")
            self.assertNotIn("006 scheduled on", json.dumps(plan))
        self.assertEqual(
            effect["operation"]["values"]["customer"], "006 scheduled on 2026-07-26",
            "host compilation must not mutate the provider payload",
        )

    def test_host_structural_correction_refuses_ambiguous_or_invalid_dates(self):
        catalog = {"fields": [
            {"fieldname": "customer", "label": "Customer", "fieldtype": "Link", "options": "Customer", "writable": True},
            {"fieldname": "scheduled_on", "label": "Scheduled On", "fieldtype": "Date", "writable": True},
        ]}
        self.assertEqual(
            _host_structural_attended_values(
                "create", catalog,
                "Create for ACME scheduled on 2026-02-30",
            ),
            {},
        )
        self.assertEqual(
            _host_structural_attended_values(
                "create", catalog,
                "Create for ACME scheduled on 2026-07-26, or 2026-07-27",
            ),
            {},
        )

    def test_attended_create_resolves_redundant_record_noun_to_configured_link_default(self):
        effect = {
            "schemaVersion": 1, "capability": "frappe.record.create",
            "operation": {
                "kind": "record", "action": "create", "doctype": "CRM Lead",
                "values": {"first_name": "Native CRM Browser Proof Three 2026-07-19", "status": "Lead"},
            },
            "postconditions": [], "approvalClass": "single",
        }
        proposal = descriptor()
        proposal["steps"] = [{
            "kind": "execution", "label": "Create", "capabilities": ["frappe.record.create"],
            "execution": {"surface": "server_effect", "plan": effect},
        }]
        graph = compiled_graph()
        graph["entryNodeId"] = "n1"
        graph["nodes"] = [{
            "id": "n1", "kind": "command", "requestedCapabilities": ["frappe.record.create"],
            "retryLimit": 0, "executionIntent": {"surface": "server_effect", "plan": effect},
        }]
        graph["edges"] = []
        catalog = {
            "doctype": "CRM Lead", "record_name": None, "record_identity_state": "missing",
            "actions": ["create"], "authority": {"read": True, "create": True, "write": True},
            "schema_hash": "a" * 64, "revision": "b" * 64,
            "fields": [
                {"fieldname": "first_name", "label": "First Name", "fieldtype": "Data", "required": True, "has_default": False, "writable": True},
                {"fieldname": "status", "label": "Status", "fieldtype": "Link", "options": "CRM Lead Status", "required": False, "has_default": False, "writable": True},
            ],
        }
        parent_meta = Mock()
        parent_meta.get_field.return_value = frappe._dict(default=None)
        linked_meta = Mock()
        linked_meta.has_field.return_value = True

        def exists(doctype, name):
            if doctype == "CRM Lead Status" and name == "Lead":
                return False
            return True

        with (
            patch("muster.orchestration.workflow_proposal.frappe.db.exists", side_effect=exists),
            patch("muster.orchestration.workflow_proposal.frappe.get_meta", side_effect=[parent_meta, linked_meta, parent_meta, linked_meta]),
            patch("muster.orchestration.workflow_proposal.frappe.get_list", return_value=[frappe._dict(name="New")]) as listed,
        ):
            _admitted, compiled = _materialize_attended_crud_bundle(
                proposal, graph, catalog,
                ["frappe.browser.navigate", "frappe.browser.click", "frappe.browser.fill", "frappe.browser.select"],
                objective=(
                    "Create a CRM Lead with First Name Native CRM Browser Proof Three 2026-07-19 "
                    "and Status Lead"
                ),
            )
        plan = compiled["nodes"][0]["executionIntent"]["plan"]
        status_action = next(action for action in plan["actions"] if action.get("field") == "status")
        self.assertEqual(status_action["value"], "New")
        self.assertEqual(plan["attendedCrud"]["fields"], ["first_name", "status"])
        self.assertEqual(listed.call_args.kwargs["order_by"], "position asc, name asc")

    def test_attended_create_accepts_text_editor_as_scalar_but_rejects_html(self):
        def bundle(fieldtype):
            effect = {
                "schemaVersion": 1, "capability": "frappe.record.create",
                "operation": {
                    "kind": "record", "action": "create", "doctype": "HD Ticket",
                    "values": {"subject": "Checkout failure", "description": "Customer cannot complete checkout."},
                },
                "postconditions": [], "approvalClass": "single",
            }
            proposal = descriptor()
            proposal["steps"] = [{
                "kind": "execution", "label": "Create", "capabilities": ["frappe.record.create"],
                "execution": {"surface": "server_effect", "plan": effect},
            }]
            graph = compiled_graph()
            graph["entryNodeId"] = "n1"
            graph["nodes"] = [{
                "id": "n1", "kind": "command", "requestedCapabilities": ["frappe.record.create"],
                "retryLimit": 0, "executionIntent": {"surface": "server_effect", "plan": effect},
            }]
            graph["edges"] = []
            catalog = {
                "doctype": "HD Ticket", "record_name": None, "record_identity_state": "missing",
                "actions": ["create"], "authority": {"read": True, "create": True, "write": True},
                "schema_hash": "a" * 64, "revision": "b" * 64,
                "fields": [
                    {"fieldname": "subject", "label": "Subject", "fieldtype": "Data", "required": True, "has_default": False, "writable": True},
                    {"fieldname": "description", "label": "Description", "fieldtype": fieldtype, "required": True, "has_default": False, "writable": True},
                ],
            }
            return proposal, graph, catalog

        proposal, graph, catalog = bundle("Text Editor")
        _admitted, compiled = _materialize_attended_crud_bundle(
            proposal, graph, catalog,
            ["frappe.browser.navigate", "frappe.browser.click", "frappe.browser.fill"],
            requested_kind="attended_browser",
            objective="Create an HD Ticket with Subject Checkout failure and Description Customer cannot complete checkout.",
        )
        plan = compiled["nodes"][0]["executionIntent"]["plan"]
        self.assertEqual(plan["attendedCrud"]["fields"], ["description", "subject"])
        self.assertEqual([action["kind"] for action in plan["actions"]], ["navigate", "click", "fill", "fill", "click"])

        proposal, graph, catalog = bundle("HTML")
        with self.assertRaisesRegex(WorkflowProposalError, "field type is not safely supported"):
            _materialize_attended_crud_bundle(
                proposal, graph, catalog,
                ["frappe.browser.navigate", "frappe.browser.click", "frappe.browser.fill"],
                requested_kind="attended_browser",
                objective="Create an HD Ticket with Subject Checkout failure and Description Customer cannot complete checkout.",
            )

    def test_attended_update_requires_one_exact_record_identity(self):
        effect = {
            "schemaVersion": 1, "capability": "frappe.record.update",
            "operation": {"kind": "record", "action": "update", "doctype": "Customer", "docname": "MODEL-GUESS", "values": {"customer_name": "ACME"}},
            "postconditions": [], "approvalClass": "single",
        }
        proposal = descriptor(); proposal["steps"] = [{"kind": "execution", "label": "Update", "capabilities": ["frappe.record.update"], "execution": {"surface": "server_effect", "plan": effect}}]
        graph = compiled_graph(); graph["entryNodeId"] = "n1"; graph["nodes"] = [{"id": "n1", "kind": "command", "requestedCapabilities": ["frappe.record.update"], "retryLimit": 0, "executionIntent": {"surface": "server_effect", "plan": effect}}]; graph["edges"] = []
        catalog = {
            "doctype": "Customer", "record_name": None, "record_identity_state": "ambiguous",
            "actions": ["read"], "authority": {"read": True, "create": False, "write": True},
            "schema_hash": "a" * 64, "revision": "b" * 64,
            "fields": [{"fieldname": "customer_name", "label": "Customer Name", "fieldtype": "Data", "required": True, "has_default": False, "writable": True}],
        }
        with self.assertRaisesRegex(WorkflowProposalClarification, r"Which exact Customer record should I update\?"):
            _materialize_attended_crud_bundle(
                proposal, graph, catalog,
                ["frappe.browser.navigate", "frappe.browser.fill", "frappe.browser.click"],
                objective="Update Customer ACME",
            )

    def test_attended_read_discards_model_routes_and_uses_the_host_record_scope(self):
        untrusted = {"surface": "browser", "plan": {"schemaVersion": 1, "actionBudget": 1, "actions": [{"kind": "navigate", "route": "/desk/Evil"}]}}
        proposal = descriptor(); proposal["steps"] = [{"kind": "execution", "label": "Read customer", "capabilities": ["frappe.browser.navigate"], "execution": untrusted}]
        graph = compiled_graph(); graph["entryNodeId"] = "n1"; graph["nodes"] = [{"id": "n1", "kind": "command", "requestedCapabilities": ["frappe.browser.navigate"], "retryLimit": 0, "executionIntent": untrusted}]; graph["edges"] = []
        catalog = {"doctype": "Customer", "record_name": "ACME", "actions": ["read"], "authority": {"read": True, "create": False, "write": False}, "schema_hash": "a" * 64, "revision": "b" * 64, "fields": []}
        authority = ["frappe.browser.navigate", "frappe.browser.read_visible"]
        admitted, compiled = _materialize_attended_crud_bundle(proposal, graph, catalog, authority, requested_kind="attended_browser")
        validated = validate_compiled_graph(compiled, validate_workflow_descriptor(admitted, authority), authority)
        plan = validated["nodes"][0]["executionIntent"]["plan"]
        self.assertEqual(plan["attendedCrud"]["operation"], "read")
        self.assertEqual(plan["actions"][0]["route"], "/desk/customer/ACME")
        self.assertNotIn("Evil", json.dumps(plan))

    def test_accepts_inert_nested_descriptor(self):
        self.assertEqual(
            validate_workflow_descriptor(descriptor(), ["frappe.invoice.read"])["schemaVersion"], 1
        )

    def test_rejects_arbitrary_javascript(self):
        with self.assertRaisesRegex(WorkflowProposalError, "source is forbidden"):
            validate_workflow_descriptor("export default agent({})", [])

    def test_accepts_compiled_graph_bound_to_descriptor(self):
        self.assertEqual(
            validate_compiled_graph(
                compiled_graph(), descriptor(), ["frappe.invoice.read"]
            )["entryNodeId"],
            "n1-inspect",
        )

    def test_rejects_compiled_graph_capability_mismatch(self):
        unsafe = copy.deepcopy(compiled_graph())
        unsafe["nodes"][1]["requestedCapabilities"] = []
        with self.assertRaisesRegex(WorkflowProposalError, "capability evidence"):
            validate_compiled_graph(unsafe, descriptor(), ["frappe.invoice.read"])

    def test_rejects_compiled_graph_raw_cycle(self):
        unsafe = copy.deepcopy(compiled_graph())
        unsafe["edges"].append({"from": "n7-verify", "to": "n1-inspect"})
        with self.assertRaisesRegex(WorkflowProposalError, "raw cycle"):
            validate_compiled_graph(unsafe, descriptor(), ["frappe.invoice.read"])

    def test_rejects_capability_escalation(self):
        unsafe = copy.deepcopy(descriptor())
        unsafe["steps"][0]["branches"][0]["capabilities"] = ["frappe.invoice.write"]
        with self.assertRaisesRegex(WorkflowProposalError, "exceeds caller capability"):
            validate_workflow_descriptor(unsafe, ["frappe.invoice.read"])

    def test_rejects_oversized_descriptor(self):
        unsafe = copy.deepcopy(descriptor())
        unsafe["goal"] = "x" * 1_000_001
        with self.assertRaisesRegex(WorkflowProposalError, "safe size"):
            validate_workflow_descriptor(unsafe, ["frappe.invoice.read"])

    def test_rejects_unknown_fields(self):
        unsafe = copy.deepcopy(descriptor())
        unsafe["javascript"] = "process.exit()"
        with self.assertRaisesRegex(WorkflowProposalError, "unknown field"):
            validate_workflow_descriptor(unsafe, ["frappe.invoice.read"])

    def test_rejects_excessive_valid_budget(self):
        unsafe = copy.deepcopy(descriptor())
        unsafe["budget"]["runtimeMs"] = 999_999_999
        with self.assertRaisesRegex(WorkflowProposalError, "safe planning ceiling"):
            validate_workflow_descriptor(unsafe, ["frappe.invoice.read"])

    def test_untrusted_runtime_fails_before_planning_request(self):
        frappe.set_user("Administrator")
        with patch(
            "muster.orchestration.workflow_proposal.trusted_binding",
            side_effect=GatewayClientError("Muster gateway trust is not active"),
        ):
            with self.assertRaisesRegex(GatewayClientError, "trust is not active"):
                request_workflow_proposal(
                    "Review overdue invoices", {"route": "List/Sales Invoice"}, "untrusted-plan-idempotency"
                )

    def test_approved_proposal_materializes_and_publishes_without_execution(self):
        frappe.set_user("Administrator")
        suffix = uuid4().hex[:10]
        policy = frappe.get_doc({
            "doctype": "Muster Policy",
            "policy_name": f"Proposal policy {suffix}",
            "enabled": 1,
            "rules": [{
                "effect": "Allow", "capability": "frappe.invoice.read",
                "action": "read", "resource_type": "Site", "resource_pattern": "*",
                "approval_class": "None",
            }],
        }).insert()
        agent = frappe.get_doc({
            "doctype": "Muster Agent",
            "agent_name": f"Proposal supervisor {suffix}",
            "status": "Active", "agent_type": "Supervisor",
            "description": "Test proposal materialization", "policy": policy.name,
            "instructions": "Execute only the admitted workflow graph.",
            "max_depth": 4, "max_fan_out": 4, "max_tool_calls": 8,
            "capabilities": [{
                "capability": "frappe.invoice.read", "resource_pattern": "*",
                "risk_class": "Low", "requires_approval": 0,
            }],
        }).insert()
        proposal_ir = descriptor()
        graph = compiled_graph()
        descriptor_json = json.dumps(proposal_ir, ensure_ascii=False, indent=2, sort_keys=True)
        graph_json = json.dumps(graph, ensure_ascii=False, indent=2, sort_keys=True)
        proposal = frappe.get_doc({
            "doctype": "Muster Workflow Proposal",
            "objective": proposal_ir["goal"], "status": "Approved",
            "requested_by": "Administrator", "requested_at": frappe.utils.now_datetime(),
            "request_id": f"proposal-request-{suffix}",
            "gateway_request_id": f"gateway-request-{suffix}",
            "reviewed_by": "Administrator", "reviewed_at": frappe.utils.now_datetime(),
            "requested_scope_json": json.dumps({"doctype": "Muster Mission", "docname": "scope-proof"}),
            "requested_scope_hash": sha256(json.dumps({"doctype": "Muster Mission", "docname": "scope-proof"}, separators=(",", ":"), sort_keys=True).encode()).hexdigest(),
            "context_json": "{}", "capabilities_json": '["frappe.invoice.read"]',
            "descriptor_json": descriptor_json,
            "descriptor_hash": sha256(json.dumps(proposal_ir, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()).hexdigest(),
            "compiled_graph_json": graph_json,
            "compiled_graph_hash": sha256(json.dumps(graph, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()).hexdigest(),
        }).insert()
        with patch(
            "muster.orchestration.workflow_proposal._caller_capabilities",
            return_value=["frappe.invoice.read"],
        ):
            published = publish_approved_proposal(
                proposal.name, agent.name, policy.name, f"publish-{suffix}"
            )
        self.assertEqual(published["status"], "Published")
        self.assertFalse(published["executed"])
        version = frappe.get_doc("Muster Workflow Version", published["version"])
        self.assertEqual(version.docstatus, 1)
        compiled = json.loads(version.graph_json)
        self.assertEqual(compiled["entryNodeId"], "n1-inspect")
        self.assertTrue(all(
            node.get("agentId") == agent.name
            for node in compiled["nodes"] if node["kind"] == "agent"
        ))
        replayed = publish_approved_proposal(
            proposal.name, agent.name, policy.name, "different-key-is-still-replay"
        )
        self.assertTrue(replayed["replayed"])

        mission_key = f"start-proposal-{suffix}"
        with self.assertRaisesRegex(WorkflowProposalError, "Explicit Start confirmation"):
            start_published_proposal_mission(
                proposal.name, mission_key, confirmed=0
            )
        self.assertFalse(frappe.db.exists("Muster Mission", {"idempotency_key": mission_key}))

        with (
            patch(
                "muster.orchestration.gateway_runtime._caller_capabilities",
                return_value=["frappe.invoice.read"],
            ),
            patch(
                "muster.orchestration.workflow_proposal._caller_capabilities",
                return_value=["frappe.invoice.read"],
            ),
            patch("muster.orchestration.workflow_proposal.frappe.enqueue") as enqueue,
        ):
            started = start_published_proposal_mission(
                proposal.name, mission_key, confirmed=1
            )
            replayed_start = start_published_proposal_mission(
                proposal.name, mission_key, confirmed="1"
            )
        self.assertFalse(started["replayed"])
        self.assertTrue(replayed_start["replayed"])
        enqueue.assert_called_once()
        mission = frappe.get_doc("Muster Mission", started["mission"])
        self.assertEqual(mission.status, "Queued")
        self.assertEqual(mission.requested_by, "Administrator")
        self.assertEqual(mission.source_proposal, proposal.name)
        self.assertEqual(mission.workflow, published["workflow"])
        self.assertEqual(mission.workflow_version, published["version"])
        self.assertEqual(mission.root_agent, agent.name)
        self.assertEqual(json.loads(mission.scope_json), {"doctype": "Muster Mission", "docname": "scope-proof"})
        mission.workflow_version = None
        with self.assertRaisesRegex(frappe.ValidationError, "reviewed plan is immutable"):
            mission.save()
        mission.reload()

        original_hash = proposal.descriptor_hash
        proposal.db_set("descriptor_hash", "0" * 64, update_modified=False)
        with (
            patch(
                "muster.orchestration.workflow_proposal._caller_capabilities",
                return_value=["frappe.invoice.read"],
            ),
            self.assertRaisesRegex(WorkflowProposalError, "descriptor hash"),
        ):
            start_published_proposal_mission(
                proposal.name, f"tampered-{suffix}", confirmed=1
            )
        proposal.db_set("descriptor_hash", original_hash, update_modified=False)

        original_scope_hash = proposal.requested_scope_hash
        proposal.db_set("requested_scope_hash", "0" * 64, update_modified=False)
        with (
            patch(
                "muster.orchestration.workflow_proposal._caller_capabilities",
                return_value=["frappe.invoice.read"],
            ),
            self.assertRaisesRegex(WorkflowProposalError, "scope hash"),
        ):
            start_published_proposal_mission(
                proposal.name, f"tampered-scope-{suffix}", confirmed=1
            )
        proposal.db_set("requested_scope_hash", original_scope_hash, update_modified=False)

        policy.db_set("enabled", 0, update_modified=False)
        with (
            patch(
                "muster.orchestration.workflow_proposal._caller_capabilities",
                return_value=["frappe.invoice.read"],
            ),
            self.assertRaisesRegex(WorkflowProposalError, "policy is not currently active"),
        ):
            start_published_proposal_mission(
                proposal.name, f"disabled-policy-{suffix}", confirmed=1
            )
        policy.db_set("enabled", 1, update_modified=False)

        with (
            patch(
                "muster.orchestration.workflow_proposal._caller_capabilities",
                return_value=[],
            ),
            self.assertRaisesRegex(WorkflowProposalError, "exceeds caller capability"),
        ):
            start_published_proposal_mission(
                proposal.name, f"revoked-authority-{suffix}", confirmed=1
            )

        frappe.set_user("Guest")
        try:
            with self.assertRaises(frappe.PermissionError):
                start_published_proposal_mission(
                    proposal.name, f"wrong-actor-{suffix}", confirmed=1
                )
        finally:
            frappe.set_user("Administrator")
