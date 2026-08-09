from __future__ import annotations

import json
import unittest
from contextlib import nullcontext
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path

from muster.automation import (
    ApprovalEvidence,
    ArtifactChangeSet,
    GovernanceContext,
    apply,
    preview,
    rollback,
)
from muster.automation.models import (
    AutomationConflictError,
    AutomationPermissionError,
    AutomationValidationError,
    plan_from_dict,
)
from muster.automation.engine import _expected_matches
from muster.automation.trusted_artifacts import (
    customer_service_region_client_v1,
    service_daily_scheduler_v1,
    service_health_api_v1,
    service_request_email_v1,
    service_request_guard_server_v1,
)


class TestFrappePostconditionProjection(unittest.TestCase):
    def test_child_row_bookkeeping_is_ignored_but_business_drift_is_not(self):
        actual = [{
            "role": "Sales User", "doctype": "Has Role", "name": "new-row-1",
            "parent": "Muster Demo Customer Coverage", "idx": 1,
        }]
        self.assertTrue(_expected_matches(actual, [{"role": "Sales User"}]))
        self.assertFalse(_expected_matches(actual, [{"role": "System Manager"}]))


class MemoryBackend:
    site = "test.local"

    def __init__(self):
        self.records = {}
        self.revisions = {}
        self.receipts = {}
        self.executions = {}
        self.enabled = {"agent@example.com"}
        self.fail_on = None

    def actor_enabled(self, actor):
        return actor in self.enabled

    def has_permission(self, actor, doctype, permission, name=None):
        return actor in self.enabled

    def snapshot(self, doctype, name, fields):
        record = self.records.get((doctype, name))
        if record is None:
            return None, None
        return {field: deepcopy(record.get(field)) for field in fields}, str(self.revisions[(doctype, name)])

    def insert(self, doctype, name, values):
        if self.fail_on == name:
            raise RuntimeError("injected failure")
        if (doctype, name) in self.records:
            raise RuntimeError("duplicate")
        self.records[(doctype, name)] = deepcopy(dict(values))
        self.revisions[(doctype, name)] = 1
        return name

    def update(self, doctype, name, values):
        if self.fail_on == name:
            raise RuntimeError("injected failure")
        self.records[(doctype, name)].update(deepcopy(dict(values)))
        self.revisions[(doctype, name)] += 1

    def delete(self, doctype, name):
        self.records.pop((doctype, name), None)
        self.revisions.pop((doctype, name), None)

    def lock(self, key):
        return nullcontext()

    def find_receipt(self, key):
        receipt = self.receipts.get(key)
        if not receipt or self.executions[receipt["execution_id"]]["status"] != "Verified":
            return None
        return deepcopy(receipt)

    def begin_execution(self, plan):
        name = f"execution-{len(self.executions) + 1}"
        self.executions[name] = {"status": "Applying", "plan": plan}
        return name

    def record_receipt(self, execution_id, change, receipt):
        self.receipts[change.idempotency_key] = deepcopy(dict(receipt))

    def finish_execution(self, execution_id, status, *, inverses, evidence, repairs=None):
        self.executions[execution_id].update({"status": status, "inverses": deepcopy(inverses),
                                              "evidence": deepcopy(dict(evidence)),
                                              "repairs": deepcopy(repairs)})

    def resolve_trusted_artifact(self, kind, key):
        definitions = {
            ("script_report", "sales-safe-v1"): {
                "report_script": "result = trusted_execute(filters)", "module": "Muster"
            },
            ("script_report", "customer-service-coverage-v1"): {
                "report_script": "result = trusted_execute(filters)", "module": "Muster"
            },
            ("print_format", "invoice-safe-v1"): {"html": "<h1>{{ doc.name }}</h1>"},
            ("client_script", "customer-ui-v1"): {
                "script": "frappe.ui.form.on('Customer', {refresh(frm) { frm.refresh(); }});",
                "module": "Muster", "allowed_doctypes": ["Customer"],
                "allowed_views": ["Form"],
            },
            ("server_script", "issue-guard-v1"): {
                "script": "if not doc.subject: frappe.throw('Subject required')",
                "script_type": "DocType Event", "reference_doctype": "Issue",
                "doctype_event": "Before Save", "module": "Muster", "allow_guest": 0,
            },
            ("server_script", "health-api-v1"): {
                "script": "frappe.response['message'] = {'ok': True}",
                "script_type": "API", "api_method": "muster_health", "module": "Muster",
                "allow_guest": 0, "enable_rate_limit": 1,
                "rate_limit_count": 20, "rate_limit_seconds": 60,
            },
            ("server_script", "daily-metrics-v1"): {
                "script": "frappe.enqueue('muster.jobs.daily')",
                "script_type": "Scheduler Event", "event_frequency": "Daily",
                "module": "Muster", "allow_guest": 0,
            },
            ("server_script", "guest-api-v1"): {
                "script": "frappe.response['message'] = 'unsafe'",
                "script_type": "API", "api_method": "guest_health", "module": "Muster",
                "allow_guest": 1, "enable_rate_limit": 1,
                "rate_limit_count": 20, "rate_limit_seconds": 60,
            },
            ("server_script", "bad-cron-v1"): {
                "script": "frappe.enqueue('muster.jobs.daily')",
                "script_type": "Scheduler Event", "event_frequency": "Cron",
                "cron_format": "* * * * *\n*", "module": "Muster", "allow_guest": 0,
            },
            ("email_template", "issue-email-v1"): {
                "subject": "Issue {{ doc.name }}", "use_html": 1,
                "response_html": "<h2>Issue {{ doc.name }}</h2><p>{{ doc.status }}</p>",
                "module": "Muster",
            },
            ("client_script", "customer-service-region-v1"): customer_service_region_client_v1(),
            ("server_script", "service-request-guard-v1"): service_request_guard_server_v1(),
            ("server_script", "service-health-api-v1"): service_health_api_v1(),
            ("server_script", "service-daily-scheduler-v1"): service_daily_scheduler_v1(),
            ("email_template", "service-request-v1"): service_request_email_v1(),
        }
        if (kind, key) not in definitions:
            raise AutomationValidationError("not installed")
        return definitions[(kind, key)]


def manifest(kind, name, values, *, target_doctype=None, module="Muster", suffix=None):
    suffix = suffix or name.lower().replace(" ", "-")
    return {
        "artifact_id": f"artifact-{suffix}", "kind": kind, "target_name": name,
        "idempotency_key": f"idempotency-{suffix}", "target_doctype": target_doctype,
        "module": module, "values": values,
    }


def changeset(*artifacts):
    return ArtifactChangeSet.from_dict({
        "schema_version": "1.0", "target_site": "test.local",
        "actor": "agent@example.com", "mission": "MST-MSN-00001",
        "artifacts": list(artifacts),
    })


def sourced_changeset(*artifacts, file_id="FILE-SOURCE-1"):
    rows = []
    for index, artifact in enumerate(artifacts, start=1):
        rows.append({**artifact, "source_citations": [{
            "file_id": file_id, "requirement_id": f"R{index:03d}",
            "locator": f"line:{index}", "quote_hash": f"{index:064x}",
        }]})
    return ArtifactChangeSet.from_dict({
        "schema_version": "1.0", "target_site": "test.local",
        "actor": "agent@example.com", "mission": "MST-MSN-00001",
        "source_evidence": {
            "file_id": "FILE-SOURCE-1", "file_name": "requirements.md",
            "file_hash": "a" * 64, "requirements_hash": "b" * 64,
            "evidence_hash": "c" * 64,
        },
        "artifacts": rows,
    })


def approval(plan, approval_class=None):
    now = datetime.now(timezone.utc)
    return ApprovalEvidence(
        plan_hash=plan.plan_hash, approval_class=approval_class or plan.approval_class,
        requested_by="agent@example.com", decided_by="approver@example.com",
        decided_at=(now - timedelta(minutes=1)).isoformat(),
        expires_at=(now + timedelta(hours=1)).isoformat(),
        approver_roles=frozenset({"Muster Approver"}),
    )


class NativeArtifactBuilderTests(unittest.TestCase):
    def setUp(self):
        self.backend = MemoryBackend()
        self.governance = GovernanceContext.from_values({"artifact.*"})

    def test_all_native_surfaces_compile_to_a_deterministic_reviewable_plan(self):
        artifacts = [
            manifest("custom_field", "customer_tier", {"label": "Tier", "fieldtype": "Select", "options": "A\nB"}, target_doctype="Customer"),
            manifest("property_setter", "Customer-tier-hidden", {"field_name": "customer_tier", "property": "hidden", "value": "0", "property_type": "Check"}, target_doctype="Customer", suffix="setter"),
            manifest("doctype", "Muster Visit", {"fields": [{"fieldname": "subject", "label": "Subject", "fieldtype": "Data", "reqd": 1}], "permissions": [{"role": "System Manager", "read": 1}]}, suffix="doctype"),
            manifest("page", "muster-operations", {"title": "Operations", "roles": [{"role": "System Manager"}]}, suffix="page"),
            manifest("workspace", "Muster Operations", {"title": "Muster Operations", "roles": [{"role": "System Manager"}], "content": [{"id": "heading", "type": "header", "data": {"text": "Operations"}}]}, suffix="workspace"),
            manifest("query_report", "Open Opportunities", {"source_doctype": "Opportunity", "fields": ["name", "status"], "filters": [{"fieldname": "status", "operator": "=", "parameter": "status"}], "order_by": [{"fieldname": "name", "direction": "desc"}], "limit": 250}, target_doctype="Opportunity", suffix="query"),
            manifest("script_report", "Governed Sales", {"implementation_key": "sales-safe-v1", "ref_doctype": "Sales Order"}, target_doctype="Sales Order", suffix="script"),
            manifest("print_format", "Safe Invoice", {"doc_type": "Sales Invoice", "html": "<h1>{{ doc.name }}</h1>"}, target_doctype="Sales Invoice", suffix="print"),
            manifest("web_page", "muster-about", {"title": "About", "route": "muster/about", "main_section": "<h1>Safe</h1>", "published": 1}, suffix="webpage"),
            manifest("web_form", "muster-request", {"doc_type": "Issue", "title": "Request", "route": "request", "web_form_fields": [{"fieldname": "subject", "label": "Subject", "fieldtype": "Data", "reqd": 1}]}, target_doctype="Issue", suffix="webform"),
            manifest("notification", "New Issue Alert", {"document_type": "Issue", "event": "New", "channel": "System Notification", "subject": "New {{ doc.name }}", "message": "<p>Please review {{ doc.name }}</p>", "recipients": [{"receiver_by_role": "Support Team"}]}, target_doctype="Issue", suffix="notification"),
            manifest("assignment_rule", "Open Issue Rotation", {"document_type": "Issue", "description": "Rotate open issues", "assign_condition": "status == 'Open'", "rule": "Round Robin", "users": [{"user": "agent@example.com"}], "assignment_days": [{"day": "Monday"}]}, target_doctype="Issue", suffix="assignment"),
            manifest("client_script", "Customer UI Guard", {"implementation_key": "customer-service-region-v1", "dt": "Customer", "view": "Form"}, target_doctype="Customer", suffix="client-script"),
            manifest("server_script", "Service Request Guard", {"implementation_key": "service-request-guard-v1"}, target_doctype="Muster Demo Service Request", suffix="server-script"),
            manifest("email_template", "Issue Acknowledgement", {"subject": "Issue {{ doc.name }}", "use_html": 1, "response_html": "<p>Status: {{ doc.status }}</p>"}, suffix="email-template"),
            manifest("office_artifact", "artifact-file-1", {"mission": "MST-MSN-00001", "file_url": "/private/files/board-pack.pdf", "mime_type": "application/pdf", "size_bytes": 1200, "checksum": "a" * 64, "title": "Board pack"}, suffix="office"),
        ]
        plan = preview(changeset(*artifacts), self.backend, self.governance)
        self.assertEqual(len(plan.changes), 16)
        self.assertEqual(plan.approval_class, "Privileged Code")
        query = next(item for item in plan.changes if item.kind == "query_report")
        self.assertIn("FROM `tabOpportunity`", query.after["query"])
        self.assertNotIn("query", artifacts[4]["values"])
        self.assertEqual(preview(plan.source, self.backend, self.governance).plan_hash, plan.plan_hash)

    def test_disposable_sop_scenario_compiles_verifies_and_reverses_every_mapped_artifact(self):
        fixture = Path(__file__).parents[1] / "demo" / "fixtures" / "frappeverse_service_intake_scenarios.json"
        scenario = json.loads(fixture.read_text())
        source = Path(__file__).parents[1] / "demo" / "fixtures" / scenario["source_file"]
        lines = source.read_text().splitlines()
        requirements = {row["id"]: row for row in scenario["requirements"]}
        self.assertEqual(
            {lines[int(row["locator"].split(":")[1]) - 1].strip() for row in requirements.values()},
            {line.strip() for line in lines if line.strip().startswith("-")},
        )
        mapped = {
            artifact_id
            for row in requirements.values()
            for artifact_id in row.get("artifacts", [])
        }
        artifact_rows = scenario["artifact_intent"]["artifacts"]
        self.assertEqual(mapped, {row["artifact_id"] for row in artifact_rows})
        self.assertEqual(requirements["R010"]["classification"], "untrusted-instruction-negative")
        self.assertIn("live Frappe visual proof", scenario["current_product_gap"])

        source_change = ArtifactChangeSet.from_dict({
            "schema_version": scenario["artifact_intent"]["schema_version"],
            "artifacts": [
                {key: value for key, value in row.items() if key != "source_citations"}
                for row in artifact_rows
            ], "target_site": "test.local",
            "actor": "agent@example.com", "mission": "MST-MSN-00001",
        })
        plan = preview(source_change, self.backend, self.governance)
        self.assertEqual(len(plan.changes), 8)
        self.assertEqual(
            {change.target_doctype for change in plan.changes},
            {"Custom Field", "Property Setter", "Report", "Print Format", "Workspace", "Page", "Web Form"},
        )
        execution = apply(plan, self.backend, self.governance, approval(plan))
        self.assertEqual(execution.status, "Verified")
        reversed_execution = rollback(
            plan, execution, self.backend, self.governance, approval(plan, "Destructive")
        )
        self.assertEqual(reversed_execution.status, "Rolled Back")
        self.assertFalse(self.backend.records)

    def test_untrusted_code_and_active_html_are_rejected_before_permissions_or_effects(self):
        bad = manifest("web_page", "unsafe-page", {
            "title": "Unsafe", "route": "unsafe", "main_section": '<img src=x onerror="alert(1)">'
        }, suffix="unsafe")
        with self.assertRaisesRegex(AutomationValidationError, "active HTML"):
            preview(changeset(bad), self.backend, self.governance)
        raw_script = manifest("script_report", "raw-script", {
            "implementation_key": "missing-key", "ref_doctype": "User", "report_script": "frappe.db.sql('x')"
        }, target_doctype="User", suffix="raw-script")
        with self.assertRaisesRegex(AutomationValidationError, "unsupported fields"):
            preview(changeset(raw_script), self.backend, self.governance)

        unsafe_assignment = manifest("assignment_rule", "Unsafe Assignment", {
            "document_type": "Issue", "description": "Unsafe",
            "assign_condition": "frappe.db.sql('select 1')", "rule": "Round Robin",
            "users": [{"user": "agent@example.com"}],
            "assignment_days": [{"day": "Monday"}],
        }, target_doctype="Issue", suffix="unsafe-assignment")
        with self.assertRaisesRegex(AutomationValidationError, "field comparisons"):
            preview(changeset(unsafe_assignment), self.backend, self.governance)

        unsafe_notification = manifest("notification", "Unsafe Notification", {
            "document_type": "Issue", "event": "New", "channel": "System Notification",
            "subject": "Unsafe", "message": "{% set x = frappe.get_all('User') %}",
            "recipients": [{"receiver_by_role": "System Manager"}],
        }, target_doctype="Issue", suffix="unsafe-notification")
        with self.assertRaisesRegex(AutomationValidationError, "simple"):
            preview(changeset(unsafe_notification), self.backend, self.governance)

        unsafe_setter = manifest("property_setter", "Customer-customer_tier-options", {
            "field_name": "customer_tier", "property": "options",
            "value": "<script>alert(1)</script>", "property_type": "Text",
        }, target_doctype="Customer", suffix="unsafe-setter")
        with self.assertRaisesRegex(AutomationValidationError, "not allowed"):
            preview(changeset(unsafe_setter), self.backend, self.governance)

        unsafe_print = manifest("print_format", "Unsafe Attribute", {
            "doc_type": "Sales Invoice", "html": '<a href="{{ doc.customer }}">Open</a>',
        }, target_doctype="Sales Invoice", suffix="unsafe-print")
        with self.assertRaisesRegex(AutomationValidationError, "HTML tags"):
            preview(changeset(unsafe_print), self.backend, self.governance)

        for kind, values in (
            ("client_script", {"implementation_key": "customer-ui-v1", "dt": "Customer", "script": "frappe.call('/evil')"}),
            ("server_script", {"implementation_key": "issue-guard-v1", "script": "frappe.db.sql('drop table')"}),
        ):
            with self.subTest(kind=kind), self.assertRaisesRegex(
                AutomationValidationError, "unsupported fields"
            ):
                preview(changeset(manifest(kind, f"Unsafe {kind}", values, suffix=f"unsafe-{kind}")),
                        self.backend, self.governance)

        unsafe_email = manifest("email_template", "Unsafe Email", {
            "subject": "Unsafe", "use_html": 1,
            "response_html": "{% set users = frappe.get_all('User') %}",
        }, suffix="unsafe-email")
        with self.assertRaisesRegex(AutomationValidationError, "simple"):
            preview(changeset(unsafe_email), self.backend, self.governance)

    def test_server_script_guest_scheduler_and_trigger_authority_fail_closed(self):
        api = preview(changeset(manifest(
            "server_script", "Health API", {"implementation_key": "service-health-api-v1"},
            suffix="health-api",
        )), self.backend, self.governance).changes[0]
        self.assertEqual(api.capability, "artifact.server_script.api.write")
        self.assertEqual(
            {"script_type", "api_method", "allow_guest", "module", "disabled", "script",
             "enable_rate_limit", "rate_limit_count", "rate_limit_seconds"},
            set(api.after) - {"name"},
        )
        scheduler = preview(changeset(manifest(
            "server_script", "Daily Metrics", {"implementation_key": "service-daily-scheduler-v1"},
            suffix="daily-metrics",
        )), self.backend, self.governance).changes[0]
        self.assertEqual(scheduler.capability, "artifact.server_script.scheduler.write")
        self.assertEqual(scheduler.after["event_frequency"], "Daily")
        self.assertIn(
            "muster.orchestration.jobs.reconcile_stale_runs", scheduler.after["script"]
        )
        self.assertNotIn("cron_format", scheduler.after)
        guest = manifest("server_script", "Guest API", {"implementation_key": "guest-api-v1"}, suffix="guest-api")
        with self.assertRaisesRegex(AutomationValidationError, "guest"):
            preview(changeset(guest), self.backend, self.governance)
        bad_cron = manifest("server_script", "Bad Cron", {"implementation_key": "bad-cron-v1"}, suffix="bad-cron")
        with self.assertRaisesRegex(AutomationValidationError, "cron_format"):
            preview(changeset(bad_cron), self.backend, self.governance)
        prompt_scheduler = manifest("server_script", "Prompt Cron", {
            "implementation_key": "daily-metrics-v1", "event_frequency": "Cron",
            "cron_format": "* * * * *",
        }, suffix="prompt-cron")
        with self.assertRaisesRegex(AutomationValidationError, "unsupported fields"):
            preview(changeset(prompt_scheduler), self.backend, self.governance)

    def test_new_script_and_email_artifacts_verify_and_reverse_with_privilege_boundaries(self):
        items = [
            manifest("client_script", "Disposable Customer UI", {
                "implementation_key": "customer-service-region-v1", "dt": "Customer", "view": "Form",
            }, target_doctype="Customer", suffix="reversible-client"),
            manifest("server_script", "Disposable Issue Guard", {
                "implementation_key": "service-request-guard-v1",
            }, target_doctype="Muster Demo Service Request", suffix="reversible-server"),
            manifest("email_template", "Disposable Issue Email", {
                "trusted_template_key": "service-request-v1",
            }, suffix="reversible-email"),
        ]
        plan = preview(changeset(*items), self.backend, self.governance)
        self.assertEqual(plan.approval_class, "Privileged Code")
        self.assertEqual(
            {change.capability for change in plan.changes},
            {"artifact.client_script.write", "artifact.server_script.doctype.write", "artifact.email_template.write"},
        )
        trusted_email = next(change for change in plan.changes if change.kind == "email_template")
        self.assertIn("{% if doc.status %}", trusted_email.after["response_html"])
        with self.assertRaises(AutomationPermissionError):
            apply(plan, self.backend, self.governance)
        execution = apply(plan, self.backend, self.governance, approval(plan))
        self.assertEqual(execution.status, "Verified")
        self.assertEqual(
            {receipt["doctype"] for receipt in execution.receipts},
            {"Client Script", "Server Script", "Email Template"},
        )
        reversed_execution = rollback(
            plan, execution, self.backend, self.governance, approval(plan, "Destructive")
        )
        self.assertEqual(reversed_execution.status, "Rolled Back")
        self.assertFalse(self.backend.records)

    def test_new_artifact_capabilities_and_governed_doctype_permissions_are_independent(self):
        client = manifest("client_script", "Scoped Customer UI", {
            "implementation_key": "customer-service-region-v1", "dt": "Customer", "view": "Form",
        }, target_doctype="Customer", suffix="scoped-client")
        with self.assertRaisesRegex(AutomationPermissionError, "capability not granted"):
            preview(changeset(client), self.backend, GovernanceContext.from_values({
                "artifact.email_template.write"
            }))
        original = self.backend.has_permission
        self.backend.has_permission = lambda _actor, doctype, permission, name=None: not (
            doctype == "Customer" and permission == "write"
        )
        try:
            with self.assertRaisesRegex(
                AutomationPermissionError, "governed DocType Customer"
            ):
                preview(changeset(client), self.backend, self.governance)
        finally:
            self.backend.has_permission = original

        email = manifest("email_template", "Scoped Email", {
            "subject": "Issue {{ doc.name }}", "response": "Status: {{ doc.status }}",
            "use_html": 0,
        }, suffix="scoped-email")
        plan = preview(changeset(email), self.backend, GovernanceContext.from_values({
            "artifact.email_template.write"
        }))
        self.assertEqual(plan.approval_class, "Sensitive")
        self.assertEqual(plan.changes[0].governed_permissions, ())

    def test_workspace_notification_and_assignment_rule_are_verified_and_reversible(self):
        items = [
            manifest("workspace", "Disposable Operations", {
                "title": "Disposable Operations", "content": [
                    {"id": "heading", "type": "header", "data": {"text": "Disposable"}}
                ], "roles": [{"role": "System Manager"}],
            }, suffix="reversible-workspace"),
            manifest("notification", "Disposable Issue Alert", {
                "document_type": "Issue", "event": "New", "channel": "System Notification",
                "subject": "Issue {{ doc.name }}", "message": "<p>Review {{ doc.name }}</p>",
                "recipients": [{"receiver_by_role": "System Manager"}],
            }, target_doctype="Issue", suffix="reversible-notification"),
            manifest("assignment_rule", "Disposable Issue Rotation", {
                "document_type": "Issue", "description": "Rotate open issues",
                "assign_condition": "status == 'Open'", "rule": "Round Robin",
                "users": [{"user": "agent@example.com"}],
                "assignment_days": [{"day": "Monday"}, {"day": "Tuesday"}],
            }, target_doctype="Issue", suffix="reversible-assignment"),
        ]
        plan = preview(changeset(*items), self.backend, self.governance)
        execution = apply(plan, self.backend, self.governance, approval(plan))
        self.assertEqual(execution.status, "Verified")
        self.assertEqual(
            {receipt["doctype"] for receipt in execution.receipts},
            {"Workspace", "Notification", "Assignment Rule"},
        )
        reversed_execution = rollback(
            plan, execution, self.backend, self.governance, approval(plan, "Destructive")
        )
        self.assertEqual(reversed_execution.status, "Rolled Back")
        self.assertFalse(any(
            key[0] in {"Workspace", "Notification", "Assignment Rule"}
            for key in self.backend.records
        ))

    def test_policy_is_deny_by_default_and_intersects_frappe_permission(self):
        item = manifest("custom_field", "customer_tier", {"label": "Tier", "fieldtype": "Data"}, target_doctype="Customer")
        with self.assertRaisesRegex(AutomationPermissionError, "capability not granted"):
            preview(changeset(item), self.backend, GovernanceContext.from_values(set()))
        denied = GovernanceContext.from_values({"artifact.*"}, denied_capabilities={"artifact.custom_field.*"})
        with self.assertRaisesRegex(AutomationPermissionError, "capability not granted"):
            preview(changeset(item), self.backend, denied)
        self.backend.has_permission = lambda *args, **kwargs: False
        with self.assertRaisesRegex(AutomationPermissionError, "Frappe write permission denied"):
            preview(changeset(item), self.backend, self.governance)

    def test_apply_requires_bound_separated_approval_and_is_idempotent(self):
        item = manifest("custom_field", "customer_tier", {"label": "Tier", "fieldtype": "Data"}, target_doctype="Customer")
        plan = preview(changeset(item), self.backend, self.governance)
        with self.assertRaises(AutomationPermissionError):
            apply(plan, self.backend, self.governance)
        evidence = apply(plan, self.backend, self.governance, approval(plan))
        self.assertEqual(evidence.status, "Verified")
        self.assertIn(("Custom Field", "Customer-customer_tier"), self.backend.records)
        replay = apply(plan, self.backend, self.governance, approval(plan))
        self.assertTrue(replay.receipts[0]["replayed"])
        self.assertEqual(len(self.backend.executions), 1)

    def test_concurrency_conflict_is_detected_without_effect(self):
        key = ("Custom Field", "Customer-customer_tier")
        self.backend.records[key] = {"dt": "Customer", "fieldname": "customer_tier", "label": "Old", "fieldtype": "Data"}
        self.backend.revisions[key] = 1
        item = manifest("custom_field", "customer_tier", {"label": "New", "fieldtype": "Data"}, target_doctype="Customer")
        plan = preview(changeset(item), self.backend, self.governance)
        self.backend.records[key]["label"] = "User edit"
        self.backend.revisions[key] = 2
        with self.assertRaises(AutomationConflictError):
            apply(plan, self.backend, self.governance, approval(plan))
        self.assertEqual(self.backend.records[key]["label"], "User edit")

    def test_failed_change_set_compensates_prior_effect_and_records_repair(self):
        first = manifest("custom_field", "field_one", {"label": "One", "fieldtype": "Data"}, target_doctype="Customer", suffix="one")
        second = manifest("custom_field", "field_two", {"label": "Two", "fieldtype": "Data"}, target_doctype="Customer", suffix="two")
        plan = preview(changeset(first, second), self.backend, self.governance)
        self.backend.fail_on = "Customer-field_two"
        evidence = apply(plan, self.backend, self.governance, approval(plan))
        self.assertEqual(evidence.status, "Repaired")
        self.assertNotIn(("Custom Field", "Customer-field_one"), self.backend.records)
        execution = next(iter(self.backend.executions.values()))
        self.assertEqual(execution["status"], "Repaired")
        self.assertEqual(execution["repairs"][0]["status"], "Repaired")

    def test_framework_generated_wrong_name_is_compensated(self):
        item = manifest(
            "custom_field", "customer_tier", {"label": "Tier", "fieldtype": "Data"},
            target_doctype="Customer", suffix="wrong-name",
        )
        plan = preview(changeset(item), self.backend, self.governance)
        original_insert = self.backend.insert

        def insert_with_wrong_name(doctype, name, values):
            wrong_name = f"generated-{name}"
            original_insert(doctype, wrong_name, values)
            return wrong_name

        self.backend.insert = insert_with_wrong_name
        evidence = apply(plan, self.backend, self.governance, approval(plan))

        self.assertEqual(evidence.status, "Repaired")
        self.assertFalse(self.backend.records)
        self.assertEqual(evidence.repairs[0]["name"], "generated-Customer-customer_tier")
        self.assertEqual(evidence.repairs[0]["status"], "Repaired")

    def test_explicit_rollback_requires_destructive_approval_and_preserves_evidence(self):
        item = manifest("custom_field", "customer_tier", {"label": "Tier", "fieldtype": "Data"}, target_doctype="Customer")
        plan = preview(changeset(item), self.backend, self.governance)
        executed = apply(plan, self.backend, self.governance, approval(plan))
        with self.assertRaisesRegex(AutomationPermissionError, "Destructive"):
            rollback(plan, executed, self.backend, self.governance, approval(plan))
        destructive = approval(plan, "Destructive")
        result = rollback(plan, executed, self.backend, self.governance, destructive)
        self.assertEqual(result.status, "Rolled Back")
        self.assertNotIn(("Custom Field", "Customer-customer_tier"), self.backend.records)
        self.assertEqual(result.repairs[0]["status"], "Repaired")

    def test_rollback_ignores_only_frappe_child_row_bookkeeping(self):
        item = manifest(
            "query_report", "Customer Coverage",
            {"source_doctype": "Customer", "fields": ["name"],
             "roles": [{"role": "Sales User"}]},
            target_doctype="Customer", suffix="rollback-child-projection",
        )
        plan = preview(changeset(item), self.backend, self.governance)
        executed = apply(plan, self.backend, self.governance, approval(plan))
        key = ("Report", "Customer Coverage")
        self.backend.records[key]["roles"] = [{
            "role": "Sales User", "doctype": "Has Role", "name": "generated-row",
            "parent": "Customer Coverage", "parentfield": "roles", "idx": 1,
        }]
        result = rollback(
            plan, executed, self.backend, self.governance,
            approval(plan, "Destructive"),
        )
        self.assertEqual(result.status, "Rolled Back")
        self.assertNotIn(key, self.backend.records)

    def test_rollback_blocks_reviewed_child_row_business_drift(self):
        item = manifest(
            "query_report", "Customer Coverage",
            {"source_doctype": "Customer", "fields": ["name"],
             "roles": [{"role": "Sales User"}]},
            target_doctype="Customer", suffix="rollback-child-drift",
        )
        plan = preview(changeset(item), self.backend, self.governance)
        executed = apply(plan, self.backend, self.governance, approval(plan))
        key = ("Report", "Customer Coverage")
        self.backend.records[key]["roles"] = [{
            "role": "System Manager", "doctype": "Has Role", "name": "generated-row",
            "parent": "Customer Coverage", "parentfield": "roles", "idx": 1,
        }]
        with self.assertRaisesRegex(AutomationConflictError, "would clobber user work"):
            rollback(
                plan, executed, self.backend, self.governance,
                approval(plan, "Destructive"),
            )
        self.assertIn(key, self.backend.records)

    def test_manifest_rejects_duplicate_idempotency_keys(self):
        first = manifest("custom_field", "field_one", {"label": "One", "fieldtype": "Data"}, target_doctype="Customer", suffix="same")
        second = manifest("custom_field", "field_two", {"label": "Two", "fieldtype": "Data"}, target_doctype="Customer", suffix="same")
        second["artifact_id"] = "artifact-different"
        with self.assertRaisesRegex(AutomationValidationError, "idempotency_key values must be unique"):
            changeset(first, second)

    def test_serialized_plan_is_hash_bound_and_rejects_tampering(self):
        item = manifest("custom_field", "customer_tier", {"label": "Tier", "fieldtype": "Data"}, target_doctype="Customer")
        plan = preview(changeset(item), self.backend, self.governance)
        serialized = plan.as_dict()
        self.assertEqual(plan_from_dict(serialized).plan_hash, plan.plan_hash)
        serialized["changes"][0]["after"]["label"] = "Tampered"
        with self.assertRaisesRegex(AutomationValidationError, "plan hash"):
            plan_from_dict(serialized)

    def test_source_citations_are_plan_hashed_and_survive_verify_and_rollback_evidence(self):
        item = manifest("custom_field", "source_bound_note", {
            "label": "Source Bound Note", "fieldtype": "Data",
        }, target_doctype="Customer", suffix="source-bound")
        source = sourced_changeset(item)
        plan = preview(source, self.backend, self.governance)
        changed = source.as_dict()
        changed["artifacts"][0]["source_citations"][0]["locator"] = "line:99"
        changed_plan = preview(ArtifactChangeSet.from_dict(changed), self.backend, self.governance)
        self.assertNotEqual(plan.plan_hash, changed_plan.plan_hash)
        with self.assertRaises(AutomationPermissionError):
            apply(plan, self.backend, self.governance, approval(changed_plan))

        execution = apply(plan, self.backend, self.governance, approval(plan))
        receipt = execution.receipts[0]
        self.assertEqual(receipt["source_evidence_hash"], "c" * 64)
        self.assertEqual(receipt["source_citations"][0]["requirement_id"], "R001")
        reversed_execution = rollback(
            plan, execution, self.backend, self.governance, approval(plan, "Destructive")
        )
        self.assertEqual(reversed_execution.receipts[0]["source_citations"], receipt["source_citations"])

    def test_source_binding_rejects_missing_and_cross_file_citations(self):
        item = manifest("custom_field", "source_bound_note", {
            "label": "Source Bound Note", "fieldtype": "Data",
        }, target_doctype="Customer", suffix="source-bound-invalid")
        missing = sourced_changeset(item).as_dict()
        missing["artifacts"][0].pop("source_citations")
        with self.assertRaisesRegex(AutomationValidationError, "requires a citation"):
            ArtifactChangeSet.from_dict(missing)
        with self.assertRaisesRegex(AutomationValidationError, "another file"):
            sourced_changeset(item, file_id="FILE-OTHER")

        unsourced = item.copy()
        unsourced["source_citations"] = [{
            "file_id": "FILE-SOURCE-1", "requirement_id": "R001",
            "locator": "line:1", "quote_hash": "1" * 64,
        }]
        with self.assertRaisesRegex(AutomationValidationError, "immutable source evidence"):
            changeset(unsourced)

    def test_change_set_metadata_exposes_read_only_source_and_operation_citation_evidence(self):
        root = Path(__file__).parents[1] / "muster" / "doctype"
        change_set = json.loads((root / "muster_change_set" / "muster_change_set.json").read_text())
        change_fields = {row["fieldname"]: row for row in change_set["fields"]}
        for fieldname in (
            "source_file", "source_file_hash", "source_requirements_hash", "source_evidence_hash"
        ):
            self.assertTrue(change_fields[fieldname]["read_only"])
        self.assertEqual(change_fields["source_file"]["options"], "File")
        operation = json.loads(
            (root / "muster_change_operation" / "muster_change_operation.json").read_text()
        )
        operation_fields = {row["fieldname"]: row for row in operation["fields"]}
        self.assertEqual(operation_fields["source_citations_json"]["options"], "JSON")
        self.assertTrue(operation_fields["source_citations_json"]["read_only"])

    def test_attended_native_customization_matrix_compiles_verifies_and_reverses(self):
        fixture = (
            Path(__file__).parents[1] / "demo" / "fixtures"
            / "attended_native_customization_matrix.json"
        )
        matrix = json.loads(fixture.read_text())
        self.assertEqual(
            {row["artifact"]["kind"] for row in matrix["cases"]},
            {"custom_field", "property_setter", "doctype", "query_report", "script_report",
             "print_format", "page", "web_page", "client_script", "server_script",
             "email_template"},
        )
        self.assertEqual(matrix["contract"]["pause_label"], "Muster paused here")
        for case in matrix["cases"]:
            with self.subTest(case=case["id"]):
                artifact = {
                    key: value for key, value in case["artifact"].items()
                    if key != "source_citations"
                }
                self.assertEqual(case["artifact"]["source_citations"], [case["citation"]])
                plan = preview(changeset(artifact), self.backend, self.governance)
                change = plan.changes[0]
                self.assertEqual(change.target_doctype, case["native_doctype"])
                projected_fields = set(change.after) - {"name", "doctype", "modified"}
                self.assertEqual(projected_fields, set(case["expected_form_fields"]))
                execution = apply(plan, self.backend, self.governance, approval(plan))
                self.assertEqual(execution.status, "Verified")
                reversed_execution = rollback(
                    plan, execution, self.backend, self.governance,
                    approval(plan, "Destructive"),
                )
                self.assertEqual(reversed_execution.status, "Rolled Back")


if __name__ == "__main__":
    unittest.main()
