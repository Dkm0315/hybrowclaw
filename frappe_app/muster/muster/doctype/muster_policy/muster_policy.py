from frappe import _
from frappe.model.document import Document


class MusterPolicy(Document):
    def validate(self):
        if not self.rules:
            from frappe import throw
            throw(_("A policy must contain at least one rule"))

