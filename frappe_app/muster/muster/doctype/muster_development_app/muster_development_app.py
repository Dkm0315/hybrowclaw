from __future__ import annotations

import json

import frappe
from frappe.model.document import Document
from frappe.utils import now_datetime

from muster.orchestration.development import source_snapshot, validate_allowed_paths


class MusterDevelopmentApp(Document):
    def validate(self):
        roles = set(frappe.get_roles())
        if frappe.session.user != "Administrator" and not roles.intersection({"System Manager", "Muster Administrator"}):
            frappe.throw("Only Muster administrators can register development source roots", frappe.PermissionError)
        try:
            allowed = json.loads(self.allowed_paths_json or "[]")
        except (TypeError, ValueError) as error:
            frappe.throw("Allowed development paths must be valid JSON", frappe.ValidationError)
            raise error
        if not isinstance(allowed, list):
            frappe.throw("Allowed development paths must be a JSON list", frappe.ValidationError)
        self.allowed_paths_json = json.dumps(validate_allowed_paths(allowed), separators=(",", ":"))
        root = self.source_root_secret if self.is_new() else self.get_password("source_root_secret", raise_exception=False)
        snapshot = source_snapshot(self.app_name, root)
        self.registered_revision = snapshot.revision
        self.registered_status_hash = snapshot.status_hash
        self.registered_by = frappe.session.user
        self.registered_at = now_datetime()

