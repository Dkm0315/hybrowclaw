import frappe
from frappe import _
from frappe.model.document import Document


class MusterAgent(Document):
    def validate(self):
        if self.max_depth < 0 or self.max_fan_out < 0:
            frappe.throw(_("Delegation limits cannot be negative"))
        if self.max_tool_calls < 0:
            frappe.throw(_("Tool-call limit cannot be negative"))
        if self.run_as_user and "Muster Service User" not in frappe.get_roles(self.run_as_user):
            frappe.throw(_("Agent service users must have the Muster Service User role"))
        capabilities = [row.capability for row in self.capabilities]
        if len(capabilities) != len(set(capabilities)):
            frappe.throw(_("Agent capabilities must be unique"))
        delegates = [row.delegate_agent for row in self.delegations]
        if self.name and self.name in delegates:
            frappe.throw(_("An agent cannot delegate to itself"))
        if len(delegates) != len(set(delegates)):
            frappe.throw(_("Agent delegation targets must be unique"))
        for delegation in self.delegations:
            if delegation.max_depth < 0 or delegation.max_fan_out < 0:
                frappe.throw(_("Delegation limits cannot be negative"))
            if delegation.max_depth > self.max_depth or delegation.max_fan_out > self.max_fan_out:
                frappe.throw(_("A delegation cannot exceed its parent agent limits"))
            requested = {
                item.strip()
                for item in (delegation.allowed_capabilities or "").splitlines()
                if item.strip()
            }
            if "*" not in capabilities and not requested.issubset(set(capabilities)):
                frappe.throw(
                    _("Delegated capabilities must be a subset of agent capabilities")
                )
