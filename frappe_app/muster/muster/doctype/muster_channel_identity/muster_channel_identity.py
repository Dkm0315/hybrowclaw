import frappe
from frappe import _
from frappe.model.document import Document


class MusterChannelIdentity(Document):
    def validate(self):
        previous = self.get_doc_before_save() if not self.is_new() else None
        if previous and (previous.user != self.user or previous.channel_account != self.channel_account):
            frappe.throw(_("Channel account and Frappe user are immutable"))
        if self.is_new() and frappe.session.user != "Administrator":
            if self.user != frappe.session.user or self.status != "Pending":
                frappe.throw(_("Users may only create their own pending channel link"))
            if not (self.external_subject or "").startswith("pending:") or not self.provider_link_id:
                frappe.throw(_("Pending channel links must be issued by Muster"))
        if previous and previous.status != self.status and not self.flags.muster_channel_transition:
            frappe.throw(_("Channel status transitions must use the Muster linking workflow"))
