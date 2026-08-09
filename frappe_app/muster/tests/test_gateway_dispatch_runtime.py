import json
import unittest
from datetime import timedelta
from types import SimpleNamespace
from uuid import uuid4

try:
    import frappe
    from frappe.tests.utils import FrappeTestCase
    from frappe.utils import now_datetime

    from muster.adapters.client import GatewayBinding
    from muster.orchestration.gateway_runtime import (
        MissionDispatchError,
        _assert_browser_manifest_scope,
        _rule_matches,
        _scope_resources,
        build_dispatch_envelope,
        dispatch_control_command,
        dispatch_mission_to_gateway,
    )
    from muster.orchestration.studio import publish_workflow
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Frappe integration tests require an installed test site") from exc


class RecordingGateway:
    def __init__(self):
        self.calls = []
        self.envelope = None
        self.control_calls = 0

    def request(self, method, path, **kwargs):
        self.calls.append((method, path, kwargs))
        if method == "POST" and path == "/v1/integrations/frappe/missions":
            self.envelope = kwargs["payload"]
            return {
                "missionId": self.envelope["missionId"],
                "rootRunId": self.envelope["rootRunId"],
                "status": "running",
                "replayed": len([call for call in self.calls if call[1] == path]) > 1,
                "pollPath": f"{path}/{self.envelope['missionId']}",
                "eventsPath": "/v1/integrations/frappe/run-events",
            }
        if method == "POST" and path.endswith("/commands"):
            self.control_calls += 1
            return {
                "status": "claimed" if self.control_calls == 1 else "replay",
                "command": kwargs["payload"],
                "dispatched": True,
            }
        if method == "GET" and self.envelope:
            return self.snapshot()
        raise AssertionError(f"Unexpected gateway request: {method} {path}")

    def snapshot(self):
        envelope = self.envelope
        events = [
            {
                "schemaVersion": 1,
                "id": f"evt-{envelope['rootRunId']}-1",
                "missionId": envelope["missionId"],
                "rootRunId": envelope["rootRunId"],
                "tenantId": envelope["identity"]["tenantId"],
                "siteId": envelope["identity"].get("siteId"),
                "sequence": 1,
                "type": "mission_started",
                "at": envelope["submittedAt"],
                "actorId": envelope["identity"]["userId"],
                "summary": envelope["objective"],
            }
        ]
        if self.control_calls:
            events.append(
                {
                    **events[0],
                    "id": f"evt-{envelope['rootRunId']}-2",
                    "sequence": 2,
                    "type": "pause_requested",
                    "at": str(now_datetime() + timedelta(seconds=1)),
                    "summary": "Pause requested by the Frappe user.",
                }
            )
        return {
            "missionId": envelope["missionId"],
            "rootRunId": envelope["rootRunId"],
            "status": "pause_requested" if self.control_calls else "running",
            "nextSequence": len(events) + 1,
            "nodes": [],
            "events": events,
        }


class TestGatewayDispatchRuntime(FrappeTestCase):
    def setUp(self):
        super().setUp()
        self.original_user = frappe.session.user
        frappe.set_user("Administrator")
        self.suffix = uuid4().hex[:10]
        self.operator = self._operator()
        self.policy = self._policy()
        self.agent = self._agent()
        self.workflow = self._workflow()
        publication = publish_workflow(
            self.workflow.name, str(self.workflow.modified), uuid4().hex
        )
        self.workflow.reload()
        self.version = publication["version"]
        self.role_binding = frappe.get_doc(
            {
                "doctype": "Muster Role Binding",
                "subject_type": "User",
                "subject": self.operator,
                "status": "Active",
                "scope_type": "Workflow",
                "scope_value": self.workflow.name,
                "capabilities": "record.read\nfrappe.browser.navigate",
            }
        ).insert()
        self.mission = frappe.get_doc(
            {
                "doctype": "Muster Mission",
                "objective": "Read the governed record context and return verified evidence",
                "status": "Queued",
                "requested_by": self.operator,
                "requested_at": now_datetime(),
                "workflow": self.workflow.name,
                "scope_json": "{}",
                "idempotency_key": uuid4().hex,
            }
        ).insert()
        self.binding = GatewayBinding(
            origin="https://gateway.example.test",
            bearer="bearer-secret",
            tenant_id=f"tenant-{self.suffix}",
            site_id=f"site-{self.suffix}",
            site_origin="https://erp.example.test",
            hmac_secret="hmac-secret",
        )

    def tearDown(self):
        frappe.set_user(self.original_user)
        super().tearDown()

    def _operator(self):
        return frappe.get_doc(
            {
                "doctype": "User",
                "email": f"dispatch-{self.suffix}@example.test",
                "first_name": "Dispatch Test",
                "enabled": 1,
                "send_welcome_email": 0,
                "roles": [{"role": "Muster Operator"}],
            }
        ).insert(ignore_permissions=True).name

    def _policy(self):
        return frappe.get_doc(
            {
                "doctype": "Muster Policy",
                "policy_name": f"Dispatch Policy {self.suffix}",
                "enabled": 1,
                "rules": [
                    {
                        "effect": "Allow",
                        "capability": "record.read",
                        "action": "read",
                        "resource_type": "Site",
                        "resource_pattern": frappe.local.site,
                        "approval_class": "None",
                    },
                    {
                        "effect": "Allow",
                        "capability": "frappe.browser.navigate",
                        "action": "read",
                        "resource_type": "Site",
                        "resource_pattern": frappe.local.site,
                        "approval_class": "None",
                    },
                ],
            }
        ).insert()

    def _agent(self):
        return frappe.get_doc(
            {
                "doctype": "Muster Agent",
                "agent_name": f"Dispatch Agent {self.suffix}",
                "status": "Active",
                "agent_type": "Specialist",
                "description": "Read only dispatch agent",
                "policy": self.policy.name,
                "instructions": "Read only under live Frappe authority.",
                "max_depth": 3,
                "max_fan_out": 8,
                "max_tool_calls": 10,
                "capabilities": [
                    {
                        "capability": "record.read",
                        "resource_pattern": frappe.local.site,
                        "risk_class": "Low",
                        "requires_approval": 0,
                    },
                    {
                        "capability": "frappe.browser.navigate",
                        "resource_pattern": frappe.local.site,
                        "risk_class": "Low",
                        "requires_approval": 0,
                    },
                ],
            }
        ).insert()

    def _workflow(self):
        return frappe.get_doc(
            {
                "doctype": "Muster Workflow",
                "workflow_name": f"Dispatch Workflow {self.suffix}",
                "status": "Draft",
                "description": "One governed read node",
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
                        "node_id": "read",
                        "label": "Read",
                        "node_type": "Agent",
                        "agent": self.agent.name,
                        "configuration_json": json.dumps(
                            {
                                "core_kind": "agent",
                                "requested_capabilities": [
                                    "record.read",
                                    "frappe.browser.navigate",
                                ],
                                "browser_action_plan": {
                                    "schemaVersion": 1,
                                    "actionBudget": 1,
                                    "actions": [
                                        {
                                            "kind": "navigate",
                                            "route": "/desk/sales-invoice",
                                            "doctype": "Sales Invoice",
                                        }
                                    ],
                                },
                            }
                        ),
                        "approval_class": "None",
                        "retry_limit": 1,
                        "timeout_seconds": 60,
                    }
                ],
            }
        ).insert()

    def test_published_graph_dispatch_is_authority_bound_and_replay_safe(self):
        gateway = RecordingGateway()
        first = dispatch_mission_to_gateway(
            self.mission.name, client=gateway, binding=self.binding
        )
        second = dispatch_mission_to_gateway(
            self.mission.name, client=gateway, binding=self.binding
        )

        envelope = gateway.envelope
        self.assertEqual(first["status"], "Running")
        self.assertEqual(second["status"], "Running")
        self.assertEqual(envelope["workflow"]["schemaVersion"], 1)
        self.assertEqual(
            envelope["workflow"]["nodes"][0]["requestedCapabilities"],
            ["frappe.browser.navigate", "record.read"],
        )
        self.assertEqual(
            envelope["authority"]["callerCapabilities"],
            ["frappe.browser.navigate", "record.read"],
        )
        self.assertEqual(
            envelope["authority"]["workflowCapabilities"],
            ["frappe.browser.navigate", "record.read"],
        )
        self.assertEqual(
            envelope["executionManifest"]["nodePlans"]["read"]["plan"]["actions"][0]["route"],
            "/desk/sales-invoice",
        )
        self.assertEqual(envelope["identity"]["userId"], self.operator.lower())
        post_calls = [call for call in gateway.calls if call[0] == "POST"]
        self.assertEqual(post_calls[0][2]["idempotency_key"], post_calls[1][2]["idempotency_key"])
        self.assertIn("X-Muster-CSRF-Proof", post_calls[0][2]["headers"])
        self.assertEqual(frappe.db.count("Muster Activity", {"mission": self.mission.name}), 1)
        self.assertEqual(frappe.db.count("Muster Run", {"mission": self.mission.name}), 1)

    def test_published_browser_manifest_is_immutable_and_mission_scope_bound(self):
        node = self.workflow.nodes[0]
        changed = json.loads(node.configuration_json)
        changed["browser_action_plan"]["actions"][0]["route"] = "/desk/customer"
        node.configuration_json = json.dumps(changed)
        self.workflow.save()

        envelope = build_dispatch_envelope(self.mission, self.binding)
        action = envelope["executionManifest"]["nodePlans"]["read"]["plan"]["actions"][0]
        self.assertEqual(action["route"], "/desk/sales-invoice")
        self.assertEqual(action["doctype"], "Sales Invoice")

        _assert_browser_manifest_scope(
            envelope["executionManifest"],
            {"scope_mode": "context", "doctype": "Customer"},
        )
        self.assertNotIn(
            "DocType",
            _scope_resources(
                {"scope_mode": "context", "doctype": "Customer"}, self.workflow.name
            ),
        )

        self.mission.scope_json = json.dumps({"doctype": "Customer"})
        self.mission.save()
        with self.assertRaisesRegex(MissionDispatchError, "outside the approved mission scope"):
            build_dispatch_envelope(self.mission, self.binding)

    def test_missing_caller_grant_denies_before_network_or_projection(self):
        frappe.delete_doc("Muster Role Binding", self.role_binding.name, force=True)
        gateway = RecordingGateway()
        with self.assertRaises(MissionDispatchError):
            dispatch_mission_to_gateway(
                self.mission.name, client=gateway, binding=self.binding
            )
        self.assertEqual(gateway.calls, [])
        self.assertEqual(frappe.db.count("Muster Activity", {"mission": self.mission.name}), 0)
        self.mission.reload()
        self.assertEqual(self.mission.status, "Queued")

    def test_tampered_published_snapshot_denies_before_network(self):
        frappe.db.set_value(
            "Muster Workflow Version", self.version, "graph_json", '{"schemaVersion":1}'
        )
        gateway = RecordingGateway()
        with self.assertRaises(MissionDispatchError):
            dispatch_mission_to_gateway(
                self.mission.name, client=gateway, binding=self.binding
            )
        self.assertEqual(gateway.calls, [])
        self.assertEqual(frappe.db.count("Muster Activity", {"mission": self.mission.name}), 0)

    def test_wildcard_policy_deny_suppresses_matching_allow(self):
        self.policy.append(
            "rules",
            {
                "effect": "Deny",
                "capability": "record.*",
                "action": "*",
                "resource_type": "Site",
                "resource_pattern": frappe.local.site,
                "approval_class": "None",
            },
        )
        self.policy.save()
        gateway = RecordingGateway()
        with self.assertRaises(MissionDispatchError):
            dispatch_mission_to_gateway(
                self.mission.name, client=gateway, binding=self.binding
            )
        self.assertEqual(gateway.calls, [])

    def test_blank_policy_resource_pattern_fails_closed(self):
        row = SimpleNamespace(resource_type="Site", resource_pattern=None)
        self.assertFalse(_rule_matches(row, {"Site": {frappe.local.site}}))

    def test_control_is_csrf_bound_idempotent_and_projected(self):
        gateway = RecordingGateway()
        dispatch_mission_to_gateway(self.mission.name, client=gateway, binding=self.binding)
        frappe.set_user(self.operator)
        key = uuid4().hex
        first = dispatch_control_command(
            self.mission.name, "pause", None, key, client=gateway, binding=self.binding
        )
        second = dispatch_control_command(
            self.mission.name, "pause", None, key, client=gateway, binding=self.binding
        )

        control_calls = [call for call in gateway.calls if call[1].endswith("/commands")]
        command = control_calls[0][2]["payload"]
        self.assertFalse(first["replayed"])
        self.assertTrue(second["replayed"])
        self.assertEqual(command["csrfToken"], control_calls[0][2]["headers"]["X-Frappe-CSRF-Token"])
        self.assertEqual(control_calls[0][2]["idempotency_key"], control_calls[1][2]["idempotency_key"])
        self.assertEqual(frappe.db.count("Muster Activity", {"mission": self.mission.name}), 2)


if __name__ == "__main__":
    unittest.main()
