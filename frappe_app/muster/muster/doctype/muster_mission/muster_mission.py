import frappe
from frappe import _
from frappe.model.document import Document


class MusterMission(Document):
    def validate(self):
        if self.progress is not None and not 0 <= self.progress <= 100:
            frappe.throw(_("Progress must be between 0 and 100"))
        if not self.is_new():
            previous = self.get_doc_before_save()
            if previous and (
                previous.requested_by != self.requested_by
                or previous.idempotency_key != self.idempotency_key
            ):
                frappe.throw(_("Mission requester and idempotency key are immutable"))
            if previous and previous.source_proposal and any(
                getattr(previous, field, None) != getattr(self, field, None)
                for field in (
                    "source_proposal",
                    "objective",
                    "workflow",
                    "workflow_version",
                    "root_agent",
                    "scope_json",
                    "budget_json",
                )
            ):
                frappe.throw(
                    _("A proposal-started Mission's reviewed plan is immutable"),
                    frappe.ValidationError,
                )
