import frappe
from frappe import _
from frappe.model.document import Document

from muster.adapters.client import normalized_https_origin


class MusterSiteBinding(Document):
    def validate(self):
        if self.site_origin:
            self.site_origin = normalized_https_origin(self.site_origin, "Public Site Origin")
        if not (self.gateway_tenant or "").strip():
            frappe.throw(_("Gateway tenant is required"))
        if self.status == "Trusted":
            if not self.site_origin:
                frappe.throw(_("A public HTTPS site origin is required before trusting the binding"))
            if not self.trust_fingerprint or not self.bound_at:
                frappe.throw(_("A trust fingerprint and binding time are required before trusting the binding"))
