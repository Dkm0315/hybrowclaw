from __future__ import annotations

import json
from hashlib import sha256

import frappe
from frappe.model.document import Document

from muster.orchestration.workflow_proposal import (
    _canonical_requested_scope,
    validate_compiled_graph,
    validate_run_metadata,
    validate_workflow_descriptor,
)


class MusterWorkflowProposal(Document):
    def validate(self):
        if not self.is_new() and any(
            self.has_value_changed(field)
            for field in (
                "status", "reviewed_by", "reviewed_at", "destructive_record_revision",
                "destructive_approval_proof", "published_workflow", "published_version",
            )
        ):
            frappe.throw("Proposal decisions may change only through the governed review and publication APIs")
        if not self.is_new() and any(
            self.has_value_changed(field)
            for field in (
                "objective", "requested_by", "requested_at", "request_id", "gateway_request_id",
                "requested_scope_json", "requested_scope_hash", "context_json", "run_metadata_json",
                "descriptor_json", "descriptor_hash", "compiled_graph_json", "compiled_graph_hash",
                "capabilities_json",
            )
        ):
            frappe.throw("The proposed workflow snapshots are immutable")
        if self.descriptor_json:
            scope = _canonical_requested_scope(json.loads(self.requested_scope_json or "{}"))
            canonical_scope = json.dumps(scope, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
            if sha256(canonical_scope.encode()).hexdigest() != self.requested_scope_hash:
                frappe.throw("The reviewed workflow scope hash does not match")
            parsed = json.loads(self.descriptor_json)
            capabilities = json.loads(self.capabilities_json or "[]")
            validate_workflow_descriptor(parsed, capabilities)
            graph = validate_compiled_graph(
                json.loads(self.compiled_graph_json or "{}"), parsed, capabilities
            )
            validate_run_metadata(json.loads(self.run_metadata_json) if self.run_metadata_json else None)
            canonical = json.dumps(parsed, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
            if sha256(canonical.encode()).hexdigest() != self.descriptor_hash:
                frappe.throw("The proposed workflow evidence hash does not match")
            canonical_graph = json.dumps(graph, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
            if sha256(canonical_graph.encode()).hexdigest() != self.compiled_graph_hash:
                frappe.throw("The compiled workflow evidence hash does not match")
