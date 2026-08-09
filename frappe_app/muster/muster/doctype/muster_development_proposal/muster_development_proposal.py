from __future__ import annotations

import hashlib
import json

import frappe
from frappe.model.document import Document


class MusterDevelopmentProposal(Document):
    def validate(self):
        immutable = (
            "ask_turn", "app", "policy", "requested_by", "requested_at", "request_id",
            "objective_hash", "source_revision", "source_status_hash", "allowed_paths_json",
            "allowed_paths_hash", "policy_revision_hash",
            "source_ingestion_status", "source_file", "source_file_name", "source_mime_type",
            "source_size_bytes", "source_requirements_json", "source_file_hash",
            "source_requirements_hash", "source_evidence_hash", "source_site",
            "rollback_requested_by", "rollback_requested_at", "rollback_approved_by",
            "rollback_approved_at", "rolled_back_by", "rolled_back_at",
            "rollback_evidence_hash",
        )
        if not self.is_new() and any(self.has_value_changed(field) for field in immutable):
            frappe.throw("Reviewed development proposal evidence is immutable")
        try:
            paths = json.loads(self.allowed_paths_json or "[]")
        except (TypeError, ValueError) as error:
            frappe.throw("Reviewed development paths are invalid", frappe.ValidationError)
            raise error
        canonical = json.dumps(paths, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        if not isinstance(paths, list) or hashlib.sha256(canonical.encode()).hexdigest() != self.allowed_paths_hash:
            frappe.throw("Reviewed development path evidence does not match", frappe.ValidationError)
        objective = self.objective_secret if self.is_new() else self.get_password("objective_secret", raise_exception=False)
        if not objective or hashlib.sha256(objective.encode()).hexdigest() != self.objective_hash:
            frappe.throw("Reviewed development objective evidence does not match", frappe.ValidationError)
        if self.source_ingestion_status == "Cited":
            required = (
                "source_file", "source_file_name", "source_mime_type", "source_size_bytes",
                "source_requirements_json", "source_file_hash", "source_requirements_hash",
                "source_evidence_hash", "source_site",
            )
            if any(not getattr(self, field, None) for field in required):
                frappe.throw("Cited source evidence is incomplete", frappe.ValidationError)
            try:
                requirements = json.loads(self.source_requirements_json)
            except (TypeError, ValueError) as error:
                frappe.throw("Cited source requirements are invalid", frappe.ValidationError)
                raise error
            requirements_json = json.dumps(requirements, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            if not isinstance(requirements, list) or hashlib.sha256(requirements_json.encode()).hexdigest() != self.source_requirements_hash:
                frappe.throw("Cited source requirements do not match", frappe.ValidationError)
            evidence = {
                "site": self.source_site, "user": self.requested_by, "file": self.source_file,
                "file_name": self.source_file_name, "mime_type": self.source_mime_type,
                "size_bytes": self.source_size_bytes, "sha256": self.source_file_hash,
                "requirements_json": requirements_json, "requirements_hash": self.source_requirements_hash,
            }
            canonical_evidence = json.dumps(evidence, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            if hashlib.sha256(canonical_evidence.encode()).hexdigest() != self.source_evidence_hash:
                frappe.throw("Cited source evidence does not match", frappe.ValidationError)
        elif self.source_ingestion_status != "Not Provided" or any((
            self.source_file, self.source_requirements_json, self.source_evidence_hash,
        )):
            frappe.throw("Development source status is invalid", frappe.ValidationError)
