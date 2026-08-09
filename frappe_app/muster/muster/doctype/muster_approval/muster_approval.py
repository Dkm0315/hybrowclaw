import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import now_datetime


class MusterApproval(Document):
    def validate(self):
        previous = self.get_doc_before_save() if not self.is_new() else None
        if previous:
            immutable = (
                "mission", "change_set", "approval_class", "requested_by", "requested_from",
                "expires_at", "action_hash", "diff_json",
            )
            if any(previous.get(field) != self.get(field) for field in immutable):
                frappe.throw(_("Approval scope and proposed diff are immutable"))
        if self.status != "Pending" and not self.decided_by:
            self.decided_by = frappe.session.user
            self.decided_at = now_datetime()
        if self.status in {"Approved", "Rejected"} and (
            self.decided_by != frappe.session.user or self.decided_by != self.requested_from
        ):
            frappe.throw(_("Only the assigned approver may record this decision"), frappe.PermissionError)
        if self.requested_by and self.decided_by == self.requested_by:
            frappe.throw(_("Separation of duties prevents self-approval"))

    def on_update(self):
        previous = self.get_doc_before_save()
        # A Destructive decision authorizes compensation for an already
        # Verified effect. It must never regress or fail the forward Change Set;
        # rollback_attended owns the subsequent Repaired transition.
        if self.approval_class == "Destructive":
            return
        if self.status == "Rejected" and (not previous or previous.status != "Rejected"):
            frappe.db.set_value("Muster Change Set", self.change_set, "status", "Failed", update_modified=True)
            if frappe.db.get_value("Muster Mission", self.mission, "status") == "Waiting for Approval":
                frappe.db.set_value(
                    "Muster Mission", self.mission,
                    {"status": "Cancelled", "failure_summary": "The reviewed effect was rejected by its assigned approver."},
                    update_modified=True,
                )
            return
        if self.status != "Approved" or (previous and previous.status == "Approved"):
            return
        frappe.db.set_value("Muster Change Set", self.change_set, "status", "Approved", update_modified=True)
        if frappe.db.get_value("Muster Mission", self.mission, "status") != "Waiting for Approval":
            return
        frappe.db.set_value("Muster Mission", self.mission, "status", "Queued", update_modified=True)
        frappe.enqueue(
            "muster.orchestration.worker.dispatch_mission", queue="long", enqueue_after_commit=True,
            mission=self.mission, job_id=f"muster-effect-approval-{self.name}", deduplicate=True,
        )
