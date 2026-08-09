import frappe
from frappe import _
from frappe.model.document import Document


class MusterAttendedDeleteAuthorization(Document):
    def validate(self):
        if not self.is_new():
            frappe.throw(
                _("Attended delete authorization records are server-managed"),
                frappe.PermissionError,
            )
