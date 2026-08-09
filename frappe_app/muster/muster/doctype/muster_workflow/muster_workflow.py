import frappe
from frappe import _
from frappe.model.document import Document

from muster.orchestration.workflow_graph import GraphLimits, WorkflowGraphError, validate_graph


class MusterWorkflow(Document):
    def validate(self):
        for field in (
            "max_duration_minutes",
            "max_tool_calls",
            "max_model_calls",
            "max_tokens",
            "max_artifact_bytes",
        ):
            if int(self.get(field) or 0) < 0:
                frappe.throw(_("Workflow budgets cannot be negative"))
        try:
            analysis = validate_graph(self.nodes, self.edges, _graph_limits())
        except WorkflowGraphError as exc:
            frappe.throw(_(str(exc)), title=_("Invalid Muster workflow"))
        root = next(row for row in self.nodes if row.node_id == analysis.root)
        if root.agent and root.agent != self.root_agent:
            frappe.throw(
                _("Root Agent must match the agent assigned to the graph entry node"),
                title=_("Invalid Muster workflow"),
            )


def _graph_limits() -> GraphLimits:
    defaults = GraphLimits()
    values = {
        "max_depth": frappe.db.get_single_value("Muster Settings", "max_depth"),
        "max_fan_out": frappe.db.get_single_value("Muster Settings", "max_fan_out"),
        "max_active_nodes": frappe.db.get_single_value(
            "Muster Settings", "max_active_nodes"
        ),
        "max_retries": frappe.db.get_single_value("Muster Settings", "max_retries"),
    }
    return GraphLimits(
        **{
            field: int(value if value is not None else getattr(defaults, field))
            for field, value in values.items()
        }
    )
