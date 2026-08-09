import json
import unittest

from muster.orchestration.workflow_graph import (
    GraphLimits,
    WorkflowGraphError,
    canonical_execution_manifest,
    canonical_snapshot,
    compile_legacy_snapshot,
    validate_graph,
)


def node(node_id, node_type="Agent", agent="Agent A", **values):
    return {
        "node_id": node_id,
        "label": node_id.title(),
        "node_type": node_type,
        "agent": agent if node_type == "Agent" else None,
        "approval_class": "Standard",
        "retry_limit": 1,
        "timeout_seconds": 60,
        "configuration_json": "{}",
        **values,
    }


class TestWorkflowGraph(unittest.TestCase):
    def test_valid_dag_analysis(self):
        analysis = validate_graph(
            [node("plan"), node("left"), node("right")],
            [
                {"source_node": "plan", "target_node": "left"},
                {"source_node": "plan", "target_node": "right"},
            ],
        )
        self.assertEqual(analysis.root, "plan")
        self.assertEqual(analysis.maximum_fan_out, 2)
        self.assertEqual(analysis.depth, 2)

    def test_cycle_is_rejected(self):
        with self.assertRaisesRegex(WorkflowGraphError, "cycles"):
            validate_graph(
                [node("one"), node("two")],
                [
                    {"source_node": "one", "target_node": "two"},
                    {"source_node": "two", "target_node": "one"},
                ],
            )

    def test_fan_out_and_depth_are_bounded(self):
        nodes = [node("root"), node("a"), node("b")]
        edges = [
            {"source_node": "root", "target_node": "a"},
            {"source_node": "root", "target_node": "b"},
        ]
        with self.assertRaisesRegex(WorkflowGraphError, "fan-out"):
            validate_graph(nodes, edges, GraphLimits(max_fan_out=1))
        with self.assertRaisesRegex(WorkflowGraphError, "depth"):
            validate_graph(
                [node("root"), node("a"), node("b")],
                [
                    {"source_node": "root", "target_node": "a"},
                    {"source_node": "a", "target_node": "b"},
                ],
                GraphLimits(max_depth=1),
            )

    def test_bounded_loop_requires_cap_and_progress(self):
        loop = node(
            "loop",
            node_type="Bounded Loop",
            configuration_json=json.dumps({"max_iterations": 4}),
        )
        with self.assertRaisesRegex(WorkflowGraphError, "progress_predicate"):
            validate_graph([loop], [])

    def test_canonical_snapshot_is_order_independent(self):
        workflow = {
            "name": "W",
            "workflow_name": "W",
            "version": 3,
            "max_duration_minutes": 60,
        }
        nodes = [node("root"), node("finish")]
        edges = [{"source_node": "root", "target_node": "finish", "priority": 1}]
        first = canonical_snapshot(workflow, nodes, edges)
        second = canonical_snapshot(workflow, list(reversed(nodes)), edges)
        self.assertEqual(first, second)
        payload = json.loads(first[0])
        self.assertEqual(
            set(payload),
            {
                "schemaVersion", "id", "version", "entryNodeId", "nodes", "edges",
                "budget", "limits",
            },
        )
        self.assertEqual(payload["schemaVersion"], 1)
        self.assertEqual(payload["nodes"][0]["kind"], "agent")

    def test_legacy_demo_snapshot_compiles_without_mutating_source(self):
        legacy = {
            "schema_version": "1.0",
            "workflow": "Legacy Demo",
            "nodes": [node("plan")],
            "edges": [],
        }
        original = json.dumps(legacy, sort_keys=True)
        compiled = compile_legacy_snapshot(legacy)
        self.assertEqual(compiled["schemaVersion"], 1)
        self.assertEqual(compiled["entryNodeId"], "plan")
        self.assertEqual(json.dumps(legacy, sort_keys=True), original)

    def test_browser_plan_compiles_to_snapshot_bound_resource_manifest(self):
        browser_node = node(
            "work",
            configuration_json=json.dumps(
                {
                    "requested_capabilities": ["frappe.browser.fill"],
                    "browser_action_plan": {
                        "schemaVersion": 1,
                        "actionBudget": 1,
                        "actions": [
                            {
                                "kind": "fill",
                                "route": "/desk/sales-invoice/new-sales-invoice",
                                "doctype": "Sales Invoice",
                                "target": {"kind": "label", "name": "Customer"},
                                "field": "customer",
                                "value": "ACME",
                                "postcondition": {
                                    "kind": "target",
                                    "target": {"kind": "role", "role": "button", "name": "Save"},
                                    "state": "visible",
                                },
                            }
                        ],
                    },
                }
            ),
        )
        raw, evidence_hash = canonical_execution_manifest([browser_node], "a" * 64)
        manifest = json.loads(raw)
        self.assertEqual(manifest["workflowSnapshotHash"], "a" * 64)
        self.assertEqual(manifest["nodePlans"]["work"]["resourceScope"]["doctypes"], ["Sales Invoice"])
        self.assertEqual(manifest["nodePlans"]["work"]["resourceScope"]["fields"], ["customer"])
        self.assertEqual(len(evidence_hash), 64)

    def test_browser_plan_denies_missing_capability_and_secret_field(self):
        action = {
            "kind": "fill",
            "route": "/desk/user/me",
            "doctype": "User",
            "target": {"kind": "label", "name": "Password"},
            "field": "new_password",
            "value": "must-not-appear",
            "postcondition": {"kind": "route", "route": "/desk/user/me"},
        }
        configuration = {
            "requested_capabilities": [],
            "browser_action_plan": {"schemaVersion": 1, "actionBudget": 1, "actions": [action]},
        }
        with self.assertRaises(WorkflowGraphError) as failure:
            validate_graph([node("work", configuration_json=json.dumps(configuration))], [])
        self.assertNotIn("must-not-appear", str(failure.exception))

    def test_static_server_effect_compiles_without_runtime_authority(self):
        intent = {
            "schemaVersion": 1,
            "capability": "frappe.record.create",
            "operation": {"kind": "record", "action": "create", "doctype": "ToDo",
                          "values": {"description": "Call customer"}},
            "postconditions": [{"path": "$.description", "operator": "equals",
                                "expected": "Call customer"}],
            "approvalClass": "single",
        }
        effect_node = node("write", configuration_json=json.dumps({
            "requested_capabilities": ["frappe.record.create"], "effect_intent": intent,
        }))
        raw, _evidence_hash = canonical_execution_manifest([effect_node], "b" * 64)
        entry = json.loads(raw)["nodePlans"]["write"]
        self.assertEqual(entry["surface"], "server_effect")
        self.assertEqual(entry["resourceScope"], {
            "routes": [], "doctypes": ["ToDo"], "recordNames": [], "fields": ["description"],
        })
        self.assertNotIn("authority", entry["plan"])
        self.assertNotIn("approval", entry["plan"])

    def test_static_server_effect_rejects_scope_and_capability_injection(self):
        intent = {
            "schemaVersion": 1, "capability": "frappe.record.create",
            "operation": {"kind": "record", "action": "create", "doctype": "ToDo",
                          "values": {}, "url": "https://evil.test"},
            "postconditions": [{"path": "$.name", "operator": "exists"}],
            "approvalClass": "single",
        }
        with self.assertRaises(WorkflowGraphError):
            canonical_execution_manifest([node("write", configuration_json=json.dumps({
                "requested_capabilities": ["frappe.record.update"], "effect_intent": intent,
            }))], "c" * 64)

    def test_record_delete_intent_is_value_free_dual_control_and_identity_bound(self):
        intent = {
            "schemaVersion": 1, "capability": "frappe.record.delete",
            "operation": {"kind": "record", "action": "delete", "doctype": "ToDo", "docname": "TODO-1"},
            "postconditions": [{"path": "$.deleted", "operator": "equals", "expected": True}],
            "approvalClass": "dual_control",
        }
        raw, _ = canonical_execution_manifest([node("delete", configuration_json=json.dumps({
            "requested_capabilities": ["frappe.record.delete"], "effect_intent": intent,
        }))], "d" * 64)
        entry = json.loads(raw)["nodePlans"]["delete"]
        self.assertEqual(entry["resourceScope"], {
            "routes": [], "doctypes": ["ToDo"], "recordNames": ["TODO-1"], "fields": [],
        })
        for mutation in (
            {**intent, "approvalClass": "single"},
            {**intent, "operation": {**intent["operation"], "values": {"name": "smuggled"}}},
            {**intent, "operation": {"kind": "record", "action": "delete", "doctype": "ToDo"}},
        ):
            with self.assertRaises(WorkflowGraphError):
                canonical_execution_manifest([node("delete", configuration_json=json.dumps({
                    "requested_capabilities": ["frappe.record.delete"], "effect_intent": mutation,
                }))], "d" * 64)

    def test_static_native_effect_compiles_typed_diff_and_rejects_kind_or_code_escape(self):
        intent = {
            "schemaVersion": 1, "capability": "frappe.metadata.custom_field.create",
            "operation": {"kind": "native_artifact", "artifactType": "custom_field", "intent": {
                "schema_version": "1.0", "artifacts": [{
                    "artifact_id": "custom-priority-note", "kind": "custom_field",
                    "target_name": "priority_note", "target_doctype": "ToDo",
                    "idempotency_key": "custom-priority-note-v1",
                    "values": {"label": "Priority Note", "fieldtype": "Small Text"},
                }],
            }},
            "postconditions": [
                {"path": "$.status", "operator": "equals", "expected": "Verified"},
                {"path": "$.verified", "operator": "equals", "expected": True},
            ], "approvalClass": "single",
        }
        raw, _ = canonical_execution_manifest([node("customize", configuration_json=json.dumps({
            "requested_capabilities": ["frappe.metadata.custom_field.create"],
            "effect_intent": intent,
        }))], "d" * 64)
        entry = json.loads(raw)["nodePlans"]["customize"]
        self.assertEqual(entry["surface"], "server_effect")
        self.assertEqual(entry["resourceScope"]["doctypes"], ["ToDo"])
        escaped = json.loads(json.dumps(intent))
        escaped["operation"]["intent"]["artifacts"][0]["kind"] = "script_report"
        with self.assertRaises(WorkflowGraphError):
            canonical_execution_manifest([node("customize", configuration_json=json.dumps({
                "requested_capabilities": ["frappe.metadata.custom_field.create"],
                "effect_intent": escaped,
            }))], "e" * 64)

        privileged = json.loads(json.dumps(intent))
        privileged["capability"] = "frappe.metadata.print_format.create"
        privileged["operation"] = {"kind": "native_artifact", "artifactType": "print_format", "intent": {
            "schema_version": "1.0", "artifacts": [{
                "artifact_id": "unsafe-print-format", "kind": "print_format",
                "target_name": "Unsafe Format", "idempotency_key": "unsafe-print-format-v1",
                "module": "Muster", "values": {"doc_type": "ToDo", "trusted_template_key": "installed.code"},
            }],
        }}
        with self.assertRaises(WorkflowGraphError):
            canonical_execution_manifest([node("format", configuration_json=json.dumps({
                "requested_capabilities": ["frappe.metadata.print_format.create"],
                "effect_intent": privileged,
            }))], "f" * 64)

    def test_all_governed_customization_effects_use_the_typed_native_path(self):
        surfaces = {
            "frappe.metadata.doctype.create": "doctype",
            "frappe.metadata.page.create": "page",
            "frappe.metadata.workspace.create": "workspace",
            "frappe.metadata.report.create": "query_report",
            "frappe.metadata.script_report.create": "script_report",
            "frappe.metadata.web_form.create": "web_form",
            "frappe.automation.notification.create": "notification",
            "frappe.automation.assignment_rule.create": "assignment_rule",
            "frappe.metadata.client_script.create": "client_script",
            "frappe.metadata.server_script.create": "server_script",
            "frappe.metadata.email_template.create": "email_template",
        }
        for capability, kind in surfaces.items():
            artifact_type = "report" if kind == "query_report" else kind
            intent = {
                "schemaVersion": 1, "capability": capability,
                "operation": {"kind": "native_artifact", "artifactType": artifact_type,
                              "intent": {"schema_version": "1.0", "artifacts": [{
                                  "artifact_id": f"artifact-{kind}", "kind": kind,
                                  "target_name": f"Disposable {kind}",
                                  "idempotency_key": f"disposable-{kind}-v1", "values": {},
                              }]}},
                "postconditions": [
                    {"path": "$.status", "operator": "equals", "expected": "Verified"},
                    {"path": "$.verified", "operator": "equals", "expected": True},
                ], "approvalClass": "dual_control",
            }
            raw, _ = canonical_execution_manifest([node(kind, configuration_json=json.dumps({
                "requested_capabilities": [capability], "effect_intent": intent,
            }))], "a" * 64)
            self.assertEqual(
                json.loads(raw)["nodePlans"][kind]["plan"]["operation"]["artifactType"],
                artifact_type,
            )
            single = {**intent, "approvalClass": "single"}
            with self.assertRaises(WorkflowGraphError):
                canonical_execution_manifest([node(kind, configuration_json=json.dumps({
                    "requested_capabilities": [capability], "effect_intent": single,
                }))], "b" * 64)

    def test_source_file_and_citation_selectors_are_bound_into_native_effect_manifest(self):
        def intent(file_id="FILE-SOURCE-1", requirement="R001"):
            return {
                "schemaVersion": 1, "capability": "frappe.metadata.custom_field.create",
                "operation": {"kind": "native_artifact", "artifactType": "custom_field",
                              "intent": {"schema_version": "1.0", "source_file": file_id,
                                         "artifacts": [{
                                             "artifact_id": "source-field", "kind": "custom_field",
                                             "target_name": "source_field", "target_doctype": "Customer",
                                             "idempotency_key": "source-field-v1",
                                             "source_citations": [requirement],
                                             "values": {"label": "Source", "fieldtype": "Data"},
                                         }]}},
                "postconditions": [
                    {"path": "$.status", "operator": "equals", "expected": "Verified"},
                    {"path": "$.verified", "operator": "equals", "expected": True},
                ], "approvalClass": "single",
            }

        raw, first_hash = canonical_execution_manifest([node("source", configuration_json=json.dumps({
            "requested_capabilities": ["frappe.metadata.custom_field.create"],
            "effect_intent": intent(),
        }))], "c" * 64)
        plan = json.loads(raw)["nodePlans"]["source"]["plan"]
        self.assertEqual(plan["operation"]["intent"]["source_file"], "FILE-SOURCE-1")
        _raw, changed_hash = canonical_execution_manifest([node("source", configuration_json=json.dumps({
            "requested_capabilities": ["frappe.metadata.custom_field.create"],
            "effect_intent": intent(requirement="R002"),
        }))], "c" * 64)
        self.assertNotEqual(first_hash, changed_hash)
