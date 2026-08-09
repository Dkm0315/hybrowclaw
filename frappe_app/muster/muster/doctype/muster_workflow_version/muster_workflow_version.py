from frappe.model.document import Document


class MusterWorkflowVersion(Document):
    def before_update_after_submit(self):
        raise RuntimeError("Published workflow versions are immutable")

