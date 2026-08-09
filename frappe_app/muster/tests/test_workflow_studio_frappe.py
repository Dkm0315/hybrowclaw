import json
import unittest
from uuid import uuid4

try:
    import frappe
    from frappe.tests.utils import FrappeTestCase
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Frappe integration tests require an installed test site") from exc

from muster.orchestration.studio import publish_workflow


class TestWorkflowStudioPublication(FrappeTestCase):
    def setUp(self):
        super().setUp()
        self.original_user = frappe.session.user
        frappe.set_user("Administrator")
        self.suffix = uuid4().hex[:10]
        self.policy = self._policy()
        self.agent = self._agent()
        self.workflow = self._workflow()

    def tearDown(self):
        frappe.set_user(self.original_user)
        super().tearDown()

    def _policy(self):
        return frappe.get_doc(
            {
                "doctype": "Muster Policy",
                "policy_name": f"Studio Policy {self.suffix}",
                "enabled": 1,
                "rules": [
                    {
                        "effect": "Allow",
                        "capability": "record.read",
                        "action": "read",
                        "resource_type": "Site",
                        "resource_pattern": frappe.local.site,
                        "approval_class": "None",
                    }
                ],
            }
        ).insert()

    def _agent(self):
        return frappe.get_doc(
            {
                "doctype": "Muster Agent",
                "agent_name": f"Studio Agent {self.suffix}",
                "status": "Active",
                "agent_type": "Specialist",
                "description": "Exercise portable workflow publication",
                "policy": self.policy.name,
                "instructions": "Read only inside the approved workflow scope.",
                "max_depth": 3,
                "max_fan_out": 8,
                "max_tool_calls": 20,
            }
        ).insert()

    def _workflow(self):
        return frappe.get_doc(
            {
                "doctype": "Muster Workflow",
                "workflow_name": f"Studio Workflow {self.suffix}",
                "status": "Draft",
                "description": "Publish one portable agent graph",
                "root_agent": self.agent.name,
                "policy": self.policy.name,
                "max_duration_minutes": 15,
                "max_tool_calls": 10,
                "max_model_calls": 5,
                "max_tokens": 10000,
                "max_cost": 1,
                "max_artifact_bytes": 100000,
                "nodes": [
                    {
                        "node_id": "plan",
                        "label": "Plan",
                        "node_type": "Agent",
                        "agent": self.agent.name,
                        "configuration_json": json.dumps(
                            {
                                "core_kind": "plan",
                                "requested_capabilities": ["record.read"],
                            }
                        ),
                        "approval_class": "None",
                        "retry_limit": 1,
                        "timeout_seconds": 60,
                    }
                ],
            }
        ).insert()

    def test_publish_is_idempotent_and_uses_portable_contract(self):
        key = uuid4().hex
        first = publish_workflow(self.workflow.name, str(self.workflow.modified), key)
        second = publish_workflow(self.workflow.name, str(self.workflow.modified), key)
        self.assertFalse(first["replayed"])
        self.assertTrue(second["replayed"])
        self.assertEqual(first["version"], second["version"])
        version = frappe.get_doc("Muster Workflow Version", first["version"])
        graph = json.loads(version.graph_json)
        self.assertEqual(
            set(graph),
            {
                "schemaVersion", "id", "version", "entryNodeId", "nodes", "edges",
                "budget", "limits",
            },
        )
        self.assertEqual(graph["schemaVersion"], 1)
        self.assertEqual(graph["entryNodeId"], "plan")
        self.assertEqual(graph["nodes"][0]["kind"], "plan")
        self.assertEqual(graph["nodes"][0]["requestedCapabilities"], ["record.read"])

    def test_viewer_cannot_publish(self):
        email = f"studio-viewer-{self.suffix}@example.com"
        frappe.get_doc(
            {
                "doctype": "User",
                "email": email,
                "first_name": "Studio Viewer",
                "enabled": 1,
                "send_welcome_email": 0,
                "roles": [{"role": "Muster Viewer"}],
            }
        ).insert()
        frappe.set_user(email)
        with self.assertRaises(frappe.PermissionError):
            publish_workflow(
                self.workflow.name, str(self.workflow.modified), uuid4().hex
            )

