import frappe
from frappe import _
from frappe.model.document import Document

from muster.adapters.client import normalized_https_origin


class MusterSettings(Document):
    def validate(self):
        if self.gateway_url:
            self.gateway_url = normalized_https_origin(self.gateway_url)
        limits = (self.max_depth, self.max_fan_out, self.max_active_nodes, self.max_retries)
        if any(value is None or value < 0 for value in limits):
            frappe.throw(_("Execution limits must be zero or greater"))
        if self.enabled and self.binding_status == "Trusted":
            if not self.gateway_url or not self.site_binding:
                frappe.throw(_("A gateway URL and trusted site binding are required"))
            if not self.get_password("gateway_bearer_token", raise_exception=False):
                frappe.throw(_("Gateway authentication is required before enabling trust"))
            if not self.get_password("run_event_hmac_secret", raise_exception=False):
                frappe.throw(_("A separate gateway signing secret is required before enabling trust"))
