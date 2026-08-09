import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
from uuid import uuid4

try:
    import frappe
    from frappe.tests.utils import FrappeTestCase

    from muster.api.ask import _buying_training_fast_reply, _explicit_attended_form_intent, _handoffs, _instructional_form_fast_reply, _instructional_intent, _presentable_answer, _presentable_tool_calls, _prompt_form_doctype, _request_form_doctype, _require_user, _issue_clarification, _verified_exact_record, accept_handoff, poll, submit
    from muster.api.catalog import _commands, _named_runtime_items, _personas
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Frappe integration tests require an installed test site") from exc


class TestAskAPI(FrappeTestCase):
    def setUp(self):
        super().setUp()
        self.original_user = frappe.session.user
        self.user = frappe.get_doc({
            "doctype": "User",
            "email": f"ask-{uuid4().hex[:10]}@example.test",
            "first_name": "Ask Test",
            "enabled": 1,
            "send_welcome_email": 0,
            "roles": [{"role": "Muster Viewer"}],
        }).insert(ignore_permissions=True).name
        self.binding = SimpleNamespace(site_origin="https://erp.example.test", site_id="site-a")

    def tearDown(self):
        frappe.set_user(self.original_user)
        super().tearDown()

    def test_submit_uses_current_user_and_permission_filtered_context(self):
        gateway = Mock()
        acknowledgement = {
            "runId": "msg_11111111-1111-4111-8111-111111111111",
            "pollUrl": "/v1/integrations/frappe/messages/runs/msg_11111111-1111-4111-8111-111111111111",
            "status": "queued",
            "replayed": False,
        }
        frappe.set_user(self.user)
        with (
            patch("muster.api.ask._require_post"),
            patch("muster.api.ask._client_for_user", return_value=(gateway, {"X-Signed": "yes"}, self.binding)) as client_for_user,
            patch("muster.api.ask.build_read_catalog", return_value=[{"doctype": "User", "fields": ["name"]}]),
            patch("muster.api.ask.frappe_identity", return_value={
                "site": "local.invalid", "user": self.user, "roles": ["Muster Viewer"], "authMode": "frappe_session",
            }),
        ):
            def request(method, path, **kwargs):
                if path.endswith("/ask-intents"):
                    request_id = kwargs["payload"]["requestId"]
                    return {
                        "schemaVersion": 1, "requestId": request_id, "status": "classified",
                        "intent": {"schemaVersion": 1, "requestId": request_id, "requestedOutcomes": ["answer"], "requiresClarification": False},
                    }
                if path.endswith("/read-plans"):
                    request_id = kwargs["payload"]["requestId"]
                    return {
                        "schemaVersion": 1, "requestId": request_id, "status": "planned",
                        "plan": {"schemaVersion": 1, "requestId": request_id, "disposition": "unsupported", "reason": "No live records required.", "queries": []},
                    }
                return acknowledgement
            gateway.request.side_effect = request
            result = submit(
                "Explain what I can do on this site.",
                "desk-session-1",
                '{"route":"/app/home","page_type":"Workspace","page_name":"Home"}',
                "ask-request-1",
            )
        self.assertEqual(result["status"], "queued")
        client_for_user.assert_called_once_with(self.user)
        _, kwargs = gateway.request.call_args_list[-1]
        self.assertEqual(kwargs["payload"]["message"]["senderId"], self.user)
        self.assertEqual(kwargs["payload"]["identity"]["site"], "https://erp.example.test")
        self.assertEqual(kwargs["payload"]["context"]["route"], "/app/home")
        self.assertIn("frappe", kwargs["payload"]["context"]["installedApps"])
        self.assertNotIn("bearer", result)
        self.assertNotIn("pollUrl", result)
        self.assertEqual(result["handoffs"], [])
        self.assertTrue(result["turn_id"].startswith("MST-ASK-"))

    def test_builtin_administrator_keeps_exact_local_identity(self):
        frappe.set_user("Administrator")
        self.assertEqual(_require_user(), "Administrator")

    def test_poll_is_bound_to_current_user_and_filters_reasoning_and_untrusted_artifacts(self):
        gateway = Mock()
        run_id = "msg_22222222-2222-4222-8222-222222222222"
        gateway.request.return_value = {
            "runId": run_id,
            "status": "completed",
            "partialText": "I will inspect the control plane and call an internal action.",
            "reasoningText": "private provider reasoning",
            "reply": {
                "text": "Here is the permitted answer.",
                "artifacts": [
                    {"name": "safe.pdf", "mime": "application/pdf", "path": f"/v1/integrations/frappe/messages/runs/{run_id}/artifacts/0"},
                    {"name": "remote.txt", "mime": "text/plain", "path": "https://evil.example/steal"},
                ],
            },
        }
        frappe.set_user(self.user)
        with patch("muster.api.ask._client_for_user", return_value=(gateway, {"X-Signed": "yes"}, self.binding)) as client_for_user:
            result = poll(run_id)
        client_for_user.assert_called_once_with(self.user)
        self.assertEqual(result["answer"], "Here is the permitted answer.")
        self.assertNotIn("reasoningText", result)
        self.assertNotIn("reasoning_text", result)
        self.assertNotIn("partialText", result)
        self.assertNotIn("partial_text", result)
        self.assertEqual([row["name"] for row in result["artifacts"]], ["safe.pdf"])
        self.assertNotIn("path", result["artifacts"][0])

    def test_tool_call_presentation_drops_backend_diagnostics(self):
        calls = _presentable_tool_calls([
            {
                "kind": "mcp", "status": "completed", "label": "Customer form",
                "summary": "Checked permitted fields.",
                "details": {
                    "purpose": "Prepare the form", "scope": "Customer",
                    "outcome": "Ready", "rawArguments": {"token": "secret"},
                    "stack": "/srv/private/runtime.py:10",
                },
            },
            {
                "kind": "tool", "status": "failed", "label": "provider backend trace",
                "summary": "model call failed at /srv/private with sha256 " + "a" * 64,
                "details": {"outcome": "stack trace at localhost"},
            },
            {"kind": "provider_trace", "status": "completed", "label": "Trace", "summary": "internal"},
        ])
        self.assertEqual(len(calls), 2)
        self.assertEqual(set(calls[0]["details"]), {"purpose", "scope", "outcome"})
        self.assertEqual(calls[1]["label"], "Muster step")
        self.assertEqual(calls[1]["summary"], "This step could not be completed. Nothing was changed.")
        self.assertNotIn("details", calls[1])
        self.assertNotIn("rawArguments", str(calls))
        self.assertNotIn("stack", str(calls))
        self.assertNotIn("sha256", str(calls))

    def test_answer_presentation_removes_runtime_diagnostics(self):
        answer = _presentable_answer(
            "Three invoices are overdue.\n\n"
            "Provider: private-model\nRequest ID: req-123\n"
            "```json\n{\"backend\": \"http://localhost:9000\", \"tool_calls\": []}\n```\n"
            "Review them before sending reminders."
        )
        self.assertEqual(answer, "Three invoices are overdue.\n\nReview them before sending reminders.")
        self.assertNotIn("Provider", answer)
        self.assertNotIn("localhost", answer)

    def test_palette_catalog_is_permission_filtered_and_bounded(self):
        remote = [
            {"name": "help", "label": "Help", "description": "Available help", "surfaces": ["*"]},
            {"name": "audit", "label": "Audit", "description": "Sensitive audit", "surfaces": ["*"], "minimum_role": "manager"},
            {"name": "pair", "label": "Pair", "description": "Wrong surface", "surfaces": ["telegram"]},
        ]
        viewer = _commands(remote, {"Muster Viewer"})
        self.assertEqual([row["id"] for row in viewer], ["help"])
        manager = _commands(remote, {"Muster Automation Manager"})
        self.assertEqual([row["id"] for row in manager], ["help", "audit"])
        skills = _named_runtime_items([{"name": "pdf", "label": "PDF", "description": "Build PDFs", "transport": {"secret": "hidden"}}], "skill")
        self.assertEqual(skills, [{"kind": "skill", "id": "pdf", "label": "PDF", "description": "Available to governed workflows; access is checked again when used", "token": "@skill:pdf"}])
        agents = _personas({"native": {"label": "General", "description": "runtime using provider secret-provider"}})
        self.assertEqual(agents[0]["description"], "Use this governed Muster agent")
        self.assertNotIn("provider", str(agents).lower())

    def test_live_aggregate_gets_fresh_filtered_evidence_before_answer_provider(self):
        gateway = Mock()
        acknowledgement = {
            "runId": "msg_44444444-4444-4444-8444-444444444444",
            "pollUrl": "/v1/integrations/frappe/messages/runs/msg_44444444-4444-4444-8444-444444444444",
            "status": "queued",
            "replayed": False,
        }
        frappe.set_user(self.user)
        with (
            patch("muster.api.ask._require_post"),
            patch("muster.api.ask._client_for_user", return_value=(gateway, {"X-Signed": "yes"}, self.binding)),
            patch("muster.api.ask.build_read_catalog", return_value=[{"doctype": "Sales Invoice", "fields": ["name"]}]),
            patch("muster.api.ask.execute_read_plan", return_value={"kind": "fresh_permission_filtered_frappe_evidence", "permissionFiltered": True}) as execute,
        ):
            # Let the dynamically generated request identity pass exact echo validation.
            def request(method, path, **kwargs):
                if path.endswith("/ask-intents"):
                    request_id = kwargs["payload"]["requestId"]
                    return {
                        "schemaVersion": 1, "requestId": request_id, "status": "classified",
                        "intent": {"schemaVersion": 1, "requestId": request_id, "requestedOutcomes": ["live_read"], "requiresClarification": False},
                    }
                if path.endswith("/read-plans"):
                    request_id = kwargs["payload"]["requestId"]
                    return {
                        "schemaVersion": 1, "requestId": request_id, "status": "planned",
                        "plan": {"schemaVersion": 1, "requestId": request_id, "disposition": "query", "reason": "Fresh evidence", "queries": []},
                    }
                return acknowledgement
            gateway.request.side_effect = request
            result = submit(
                "How many overdue invoices are outstanding?",
                "desk-session-2",
                '{"route":"/app/home"}',
                "ask-request-live-read",
            )
        self.assertEqual(result["status"], "queued")
        execute.assert_called_once()
        self.assertEqual(gateway.request.call_count, 3)
        answer_payload = gateway.request.call_args_list[2].kwargs["payload"]
        self.assertIn("fresh_permission_filtered_frappe_evidence", answer_payload["context"]["summary"])

    def test_exact_customer_count_skips_model_read_planning(self):
        gateway = Mock()
        acknowledgement = {
            "runId": "msg_45454545-4545-4545-8545-454545454545",
            "pollUrl": "/v1/integrations/frappe/messages/runs/msg_45454545-4545-4545-8545-454545454545",
            "status": "queued", "replayed": False,
        }
        frappe.set_user(self.user)
        with (
            patch("muster.api.ask._require_post"),
            patch("muster.api.ask._client_for_user", return_value=(gateway, {"X-Signed": "yes"}, self.binding)),
            patch("muster.api.ask.deterministic_count_catalog", return_value=[{"doctype": "Customer", "fields": ["name"]}]),
            patch("muster.api.ask.execute_read_plan", return_value={
                "kind": "fresh_permission_filtered_frappe_evidence", "permissionFiltered": True,
                "queries": [{"doctype": "Customer", "mode": "aggregate", "aggregate": "count", "value": 24}],
            }) as execute,
        ):
            def request(method, path, **kwargs):
                self.assertFalse(path.endswith("/ask-intents"))
                self.assertFalse(path.endswith("/read-plans"))
                return acknowledgement
            gateway.request.side_effect = request
            result = submit(
                "How many Customers are in this site?", "desk-count-fast",
                '{"route":"/desk/muster-control"}', "ask-count-fast",
            )
        self.assertEqual(result["status"], "queued")
        self.assertEqual(gateway.request.call_count, 1)
        execute.assert_called_once()
        plan = execute.call_args.args[0]
        self.assertEqual(plan["queries"][0]["doctype"], "Customer")
        self.assertEqual(plan["queries"][0]["aggregate"], {"function": "count"})
        self.assertEqual(gateway.request.call_args.kwargs["payload"]["context"]["fastReply"], {
            "text": "There are 24 Customer records visible under your current access. "
                    "I checked the live Customer records using your current Frappe permissions."
        })

    def test_effectful_ask_returns_only_an_explicit_inert_handoff(self):
        gateway = Mock()
        acknowledgement = {
            "runId": "msg_55555555-5555-4555-8555-555555555555",
            "pollUrl": "/v1/integrations/frappe/messages/runs/msg_55555555-5555-4555-8555-555555555555",
            "status": "queued", "replayed": False,
        }
        frappe.set_user(self.user)
        with (
            patch("muster.api.ask._require_post"),
            patch("muster.api.ask._client_for_user", return_value=(gateway, {"X-Signed": "yes"}, self.binding)),
        ):
            def request(method, path, **kwargs):
                if path.endswith("/ask-intents"):
                    request_id = kwargs["payload"]["requestId"]
                    return {
                        "schemaVersion": 1, "requestId": request_id, "status": "classified",
                        "intent": {"schemaVersion": 1, "requestId": request_id, "requestedOutcomes": ["governed_change", "attended_browser"], "requiresClarification": False},
                    }
                return acknowledgement
            gateway.request.side_effect = request
            result = submit("Create a customer and show every Desk step.", "desk-session-3", {"route": "/desk"}, "ask-effect-offer")
        self.assertEqual(result["status"], "queued")
        self.assertEqual([row["kind"] for row in result["handoffs"]], ["attended_browser"])
        self.assertEqual(result["handoffs"][0]["label"], "Open the form and review changes")
        self.assertTrue(all(row["requires"] == "explicit_confirmation" for row in result["handoffs"]))
        answer_context = gateway.request.call_args_list[-1].kwargs["payload"]["context"]
        self.assertEqual(answer_context["fastReply"], {
            "text": "I’ve gathered the details needed for the next step. Open the form to review them in Frappe. "
                    "I’ll fill the fields and leave the document unsaved."
        })
        turn = frappe.get_doc("Muster Ask Turn", result["turn_id"])
        self.assertEqual(turn.status, "Offered")
        self.assertFalse(turn.workflow_proposal)
        self.assertFalse(frappe.db.exists("Muster Mission", {"objective": "Create a customer and show every Desk step."}))

    def test_form_question_identifies_custom_fields_and_property_setters_as_data(self):
        gateway = Mock()
        acknowledgement = {
            "runId": "msg_66666666-6666-4666-8666-666666666666",
            "pollUrl": "/v1/integrations/frappe/messages/runs/msg_66666666-6666-4666-8666-666666666666",
            "status": "queued", "replayed": False,
        }
        frappe.set_user(self.user)
        snapshot = {
            "doctype": "Customer", "authority": {"read": True, "create": False, "write": False},
            "fields": [{
                "fieldname": "custom_tier", "label": "Tier", "fieldtype": "Select", "required": True,
                "read_only": False, "hidden": False, "writable": False,
                "provenance": {"source": "custom_field", "custom_field": "Customer-custom_tier", "property_setters": [{"name": "PS-1", "property": "reqd", "value": "1"}]},
            }],
            "doctype_property_setters": [], "workflow": None,
            "client_scripts": [{"name": "Customer Form", "view": "Form", "modified": "2026-07-19"}],
            "schema_hash": "a" * 64, "revision": "b" * 64,
        }
        with (
            patch("muster.api.ask._require_post"),
            patch("muster.api.ask._client_for_user", return_value=(gateway, {"X-Signed": "yes"}, self.binding)),
            patch("muster.api.ask.effective_form_schema", return_value=snapshot),
        ):
            def request(method, path, **kwargs):
                if path.endswith("/ask-intents"):
                    request_id = kwargs["payload"]["requestId"]
                    return {"schemaVersion": 1, "requestId": request_id, "status": "classified", "intent": {
                        "schemaVersion": 1, "requestId": request_id, "requestedOutcomes": ["live_read"], "requiresClarification": False,
                    }}
                return acknowledgement
            gateway.request.side_effect = request
            result = submit("Which custom fields and property setters changed this form?", "desk-form", {"doctype": "Customer", "scope_mode": "context"}, "ask-form-evidence")
        self.assertEqual(result["status"], "queued")
        self.assertEqual(gateway.request.call_count, 2)
        context = gateway.request.call_args_list[-1].kwargs["payload"]["context"]["summary"]
        self.assertIn("custom_tier", context)
        self.assertIn("property_setters", context)
        self.assertNotIn("script source", context.lower())

    def test_home_prompt_resolves_one_explicit_form_target_and_includes_writable_fields(self):
        readable = SimpleNamespace(get_can_read=lambda: ["Customer", "Custom Field", "Property Setter"])
        with (
            patch.object(frappe, "get_user", return_value=readable),
            patch.object(frappe.db, "exists", return_value=True),
            patch.object(frappe, "has_permission", return_value=True),
        ):
            target = _prompt_form_doctype(
                "What custom fields and property setters currently affect Customer, and which fields can I write?",
                "", self.user,
            )
        self.assertEqual(target, "Customer")

        context = __import__("muster.api.ask", fromlist=["_merge_form_evidence"])._merge_form_evidence({}, {
            "doctype": "Customer", "authority": {"read": True, "write": True},
            "fields": [
                {"fieldname": "customer_name", "label": "Customer Name", "fieldtype": "Data", "permlevel": 0, "required": True, "writable": True, "provenance": {"source": "doctype_field", "property_setters": []}},
                {"fieldname": "tax_id", "label": "Tax ID", "fieldtype": "Data", "permlevel": 0, "required": False, "writable": False, "provenance": {"source": "doctype_field", "property_setters": []}},
            ],
            "doctype_property_setters": [], "workflow": None, "client_scripts": [], "schema_hash": "a" * 64, "revision": "b" * 64,
        })["summary"]
        self.assertIn('"writable_fields":[{"fieldname":"customer_name"', context)
        self.assertNotIn('"fieldname":"tax_id","fieldtype"', context)

    def test_large_form_evidence_is_compacted_without_losing_required_fields(self):
        merge = __import__("muster.api.ask", fromlist=["_merge_form_evidence"])._merge_form_evidence
        child_fields = [
            {
                "fieldname": f"child_{index}", "label": f"Child Field {index}",
                "fieldtype": "Data", "required": index < 3, "has_default": False,
                "writable": True,
            }
            for index in range(80)
        ]
        fields = [
            {
                "fieldname": "items", "label": "Items", "fieldtype": "Table",
                "required": True, "writable": True, "child_doctype": "Large Item",
                "child_fields": child_fields,
            },
            *[
                {
                    "fieldname": f"optional_{index}", "label": f"Optional Field {index}",
                    "fieldtype": "Data", "required": False, "writable": True,
                }
                for index in range(160)
            ],
        ]
        summary = merge({}, {
            "doctype": "Large Form", "authority": {"read": True, "create": True},
            "fields": fields, "doctype_property_setters": [], "workflow": None,
            "client_scripts": [], "schema_hash": "a" * 64, "revision": "b" * 64,
        })["summary"]
        parsed = json.loads(summary)["effectiveFormSchema"]
        self.assertLessEqual(len(summary.encode()), 32_000)
        self.assertEqual(parsed["writable_fields"][0]["fieldname"], "items")
        self.assertEqual(
            [row["fieldname"] for row in parsed["writable_fields"][0]["child_fields"][:3]],
            ["child_0", "child_1", "child_2"],
        )
        self.assertGreater(parsed["omitted_optional_fields"], 0)
        self.assertGreater(parsed["omitted_optional_child_fields"], 0)

    def test_active_agent_profile_resolves_an_ambiguous_business_acronym(self):
        readable = SimpleNamespace(get_can_read=lambda: ["Payment Order", "Purchase Order"])
        with (
            patch.object(frappe, "get_user", return_value=readable),
            patch.object(frappe.db, "exists", return_value=True),
            patch.object(frappe, "get_all", return_value=[{"doctype_scope": "Purchase Order"}]),
        ):
            target = _prompt_form_doctype(
                "How do I create a PO? Teach me step by step.", "", self.user,
            )
            self.assertEqual(target, "Purchase Order")

    def test_explicit_form_target_prefers_the_longest_readable_name(self):
        readable = SimpleNamespace(get_can_read=lambda: ["Supplier", "Supplier Quotation"])
        with (
            patch.object(frappe, "get_user", return_value=readable),
            patch.object(frappe, "get_all") as configured,
        ):
            target = _prompt_form_doctype(
                "How do I create a Supplier Quotation?", "", self.user,
            )
        self.assertEqual(target, "Supplier Quotation")
        configured.assert_not_called()

    def test_form_guidance_does_not_become_an_execution_request(self):
        self.assertTrue(_instructional_intent("How do I create a PO?", "Purchase Order"))
        self.assertTrue(_instructional_intent("Teach me how to prepare a purchase order", "Purchase Order"))

    def test_form_guidance_is_derived_from_the_effective_required_schema(self):
        reply = _instructional_form_fast_reply({
            "doctype": "Purchase Order", "authority": {"create": True},
            "fields": [
                {"label": "Supplier", "fieldtype": "Link", "required": True, "has_default": False, "create_writable": True},
                {"label": "Company", "fieldtype": "Link", "required": True, "has_default": True, "create_writable": True},
                {"label": "Items", "fieldtype": "Table", "create_writable": True, "child_fields": [
                    {"label": "Item", "required": True, "has_default": False, "writable": True},
                    {"label": "Description", "required": False, "has_default": False, "writable": True},
                ]},
            ],
        })["text"]
        self.assertIn("Supplier", reply)
        self.assertIn("Items: Item", reply)
        self.assertNotIn("Company", reply)
        self.assertNotIn("Description", reply)
        self.assertIn("pause only when your approval is required", reply)

    def test_buying_training_is_permission_aware_and_names_human_approval(self):
        schemas = {
            "Item": {
                "doctype": "Item", "authority": {"create": True},
                "fields": [{"label": "Item Code", "required": True, "has_default": False, "create_writable": True}],
                "workflow": None,
            },
            "Purchase Order": {
                "doctype": "Purchase Order", "authority": {"create": True},
                "fields": [{"label": "Supplier", "required": True, "has_default": False, "create_writable": True}],
                "workflow": {"transitions": [{"allowed": "Purchase Manager"}]},
            },
        }
        with (
            patch("muster.api.ask.frappe.db.exists", side_effect=lambda dt, name: name in schemas),
            patch("muster.api.ask.frappe.has_permission", return_value=True),
            patch("muster.api.ask.effective_form_schema", side_effect=lambda dt, user=None: schemas[dt]),
        ):
            text = _buying_training_fast_reply(self.user)["text"]
        self.assertIn("Item Code", text)
        self.assertIn("Supplier", text)
        self.assertIn("Human workflow approval by: Purchase Manager", text)
        self.assertIn("Muster never approves its own work", text)
        self.assertIn("Find it in Desk: Purchase Order", text)

    def test_buying_curriculum_is_not_collapsed_to_supplier_form(self):
        prompt = "Train me through the complete Buying module from a business need to supplier payment."
        with patch("muster.api.ask._prompt_form_doctype") as matcher:
            self.assertIsNone(_request_form_doctype(prompt, "", self.user))
        matcher.assert_not_called()

    def test_explicit_form_continuation_is_not_treated_as_guidance(self):
        self.assertFalse(_instructional_intent(
            "Validate these details and open the live form.", "Purchase Order",
        ))
        self.assertFalse(_instructional_intent(
            "How do I create a PO? Open the form with these details.", "Purchase Order",
        ))
        self.assertTrue(_explicit_attended_form_intent(
            "Create a Purchase Order. Open the live form and fill the reviewed values.",
            "Purchase Order",
        ))
        self.assertFalse(_explicit_attended_form_intent(
            "Explain how to create a Purchase Order.", "Purchase Order",
        ))
        self.assertFalse(_explicit_attended_form_intent(
            "Delete this Purchase Order from the live form.", "Purchase Order",
        ))

    def test_handoff_requires_confirmation_and_creates_only_a_proposal(self):
        frappe.set_user(self.user)
        turn = frappe.get_doc({
            "doctype": "Muster Ask Turn", "requested_by": self.user,
            "conversation_id": "desk-handoff", "request_id": f"handoff-{uuid4().hex}", "status": "Offered",
            "expires_at": frappe.utils.add_to_date(frappe.utils.now_datetime(), hours=1),
            "prompt_secret": "Create a customer visibly", "prompt_hash": __import__("hashlib").sha256(b"Create a customer visibly").hexdigest(),
            "scope_json": "{}", "scope_hash": __import__("hashlib").sha256(b"{}").hexdigest(),
            "outcomes_json": '["governed_change"]',
            "handoffs_json": '[{"id":"handoff-test","kind":"governed_change","label":"Prepare","state":"offered","requires":"explicit_confirmation"}]',
        }).insert()
        with patch("muster.api.ask._require_post"):
            with self.assertRaises(frappe.ValidationError):
                accept_handoff(turn.name, "handoff-test", 0, "accept-no")
            with patch("muster.orchestration.workflow_proposal.request_workflow_proposal", return_value={"proposal": "MST-WFP-TEST", "status": "Proposed"}) as request:
                result = accept_handoff(turn.name, "handoff-test", 1, "accept-yes")
        self.assertFalse(result["executed"])
        self.assertEqual(result["proposal"], "MST-WFP-TEST")
        request.assert_called_once()

    def test_attended_handoff_returns_one_clarification_without_accepting_or_linking(self):
        frappe.set_user(self.user)
        prompt = "Update the customer"
        digest = __import__("hashlib").sha256
        turn = frappe.get_doc({
            "doctype": "Muster Ask Turn", "requested_by": self.user,
            "conversation_id": "desk-clarify", "request_id": f"clarify-{uuid4().hex}", "status": "Offered",
            "expires_at": frappe.utils.add_to_date(frappe.utils.now_datetime(), hours=1),
            "prompt_secret": prompt, "prompt_hash": digest(prompt.encode()).hexdigest(),
            "scope_json": "{}", "scope_hash": digest(b"{}").hexdigest(),
            "outcomes_json": '["attended_browser"]',
            "handoffs_json": '[{"id":"handoff-clarify","kind":"attended_browser","label":"Open form","state":"offered","requires":"explicit_confirmation"}]',
        }).insert()
        with (
            patch("muster.api.ask._require_post"),
            patch("muster.orchestration.workflow_proposal.request_workflow_proposal", return_value={
                "status": "clarification", "reason": "What value should I use for First Name?",
                "replayed": False, "executed": False,
            }),
        ):
            result = accept_handoff(turn.name, "handoff-clarify", 1, "accept-clarify")
        self.assertEqual(result["turn_id"], turn.name)
        self.assertEqual(result["handoff_id"], "handoff-clarify")
        self.assertEqual(result["status"], "clarification")
        self.assertEqual(result["reason"], "What value should I use for First Name?")
        self.assertFalse(result["replayed"])
        self.assertFalse(result["executed"])
        self.assertEqual(result["continuation"]["conversation_id"], "desk-clarify")
        self.assertEqual(result["continuation"]["prompt_hash"], turn.prompt_hash)
        self.assertEqual(result["continuation"]["bound_scope"], {})
        self.assertGreaterEqual(len(result["continuation"]["token"]), 32)
        turn.reload()
        self.assertEqual(turn.status, "Offered")
        self.assertFalse(turn.workflow_proposal)
        self.assertFalse(turn.clarification_consumed_at)

        gateway = Mock()
        acknowledgement = {
            "runId": "msg_66666666-6666-4666-8666-666666666666",
            "pollUrl": "/v1/integrations/frappe/messages/runs/msg_66666666-6666-4666-8666-666666666666",
            "status": "queued", "replayed": False,
        }
        gateway.request.side_effect = lambda method, path, **kwargs: ({
            "schemaVersion": 1, "requestId": kwargs["payload"]["requestId"],
            "status": "classified", "intent": {
                "schemaVersion": 1, "requestId": kwargs["payload"]["requestId"],
                "requestedOutcomes": ["attended_browser"], "requiresClarification": False,
            },
        } if path.endswith("/ask-intents") else acknowledgement)
        with (
            patch("muster.api.ask._require_post"),
            patch("muster.api.ask._client_for_user", return_value=(gateway, {"X-Signed": "yes"}, self.binding)),
        ):
            clarified = submit(
                "Aarav Rain Proof", "desk-clarify", {}, f"clarify-answer-{uuid4().hex}",
                turn.name, "handoff-clarify", result["continuation"]["token"], turn.prompt_hash,
            )
        self.assertEqual(
            clarified["merged_objective"],
            "Update the customer\n\nClarification requested by Muster:\n"
            "What value should I use for First Name?\n\n"
            "User's answer to that clarification:\nAarav Rain Proof",
        )
        self.assertTrue(any(call.args[1].endswith("/ask-intents") for call in gateway.request.call_args_list))

    def test_clarification_reply_is_lineage_bound_transparent_and_single_use(self):
        frappe.set_user(self.user)
        prompt = "Update the customer"
        digest = __import__("hashlib").sha256
        scope = {"source": "desk-dock", "route": "/desk/muster-control", "scope_mode": "context"}
        scope_json = __import__("json").dumps(scope, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        parent_request_key = f"lineage-{uuid4().hex}"
        parent_intent_request_id = f"intent-{digest(f'{self.user}:desk-lineage:{parent_request_key}'.encode()).hexdigest()[:32]}"
        parent_handoffs = _handoffs(["attended_browser"], parent_intent_request_id)
        parent_handoff_id = "intent"
        turn = frappe.get_doc({
            "doctype": "Muster Ask Turn", "requested_by": self.user,
            "conversation_id": "desk-lineage", "request_id": parent_request_key, "status": "Offered",
            "expires_at": frappe.utils.add_to_date(frappe.utils.now_datetime(), hours=1),
            "prompt_secret": prompt, "prompt_hash": digest(prompt.encode()).hexdigest(),
            "scope_json": scope_json, "scope_hash": digest(scope_json.encode()).hexdigest(),
            "outcomes_json": '["attended_browser"]',
            "handoffs_json": __import__("json").dumps(parent_handoffs, ensure_ascii=False, separators=(",", ":"), sort_keys=True),
        }).insert()
        readable = SimpleNamespace(get_can_read=lambda: ["Customer"])
        with (
            patch.object(frappe, "get_user", return_value=readable),
            patch.object(frappe.db, "exists", return_value=True),
        ):
            clarification = _issue_clarification(
                turn, parent_handoff_id, "Which exact record should I update?",
            )
        turn.reload()
        self.assertEqual(turn.clarification_kind, "exact_record")
        continuation = clarification

        with patch("muster.api.ask._require_post"):
            with self.assertRaises(frappe.PermissionError):
                submit("CUST-0001", "another-conversation", scope, "wrong-conversation", turn.name, parent_handoff_id, continuation["token"], turn.prompt_hash)
            with self.assertRaises(frappe.ValidationError):
                submit("CUST-0001", "desk-lineage", {**scope, "docname": "CUST-OTHER"}, "wrong-scope", turn.name, parent_handoff_id, continuation["token"], turn.prompt_hash)
            with self.assertRaises(frappe.ValidationError):
                submit("CUST-0001", "desk-lineage", scope, "wrong-token", turn.name, parent_handoff_id, "x" * 43, turn.prompt_hash)
            turn.db_set("clarification_expires_at", frappe.utils.add_to_date(frappe.utils.now_datetime(), minutes=-1), update_modified=False)
            with self.assertRaises(frappe.ValidationError):
                submit("CUST-0001", "desk-lineage", scope, "expired-token", turn.name, parent_handoff_id, continuation["token"], turn.prompt_hash)
            turn.db_set("clarification_expires_at", frappe.utils.add_to_date(frappe.utils.now_datetime(), minutes=15), update_modified=False)
            frappe.set_user("Administrator")
            with self.assertRaises(frappe.PermissionError):
                submit("CUST-0001", "desk-lineage", scope, "wrong-user", turn.name, parent_handoff_id, continuation["token"], turn.prompt_hash)
            frappe.set_user(self.user)

        gateway = Mock()
        acknowledgement = {
            "runId": "msg_77777777-7777-4777-8777-777777777777",
            "pollUrl": "/v1/integrations/frappe/messages/runs/msg_77777777-7777-4777-8777-777777777777",
            "status": "queued", "replayed": False,
        }
        def request(method, path, **kwargs):
            if path.endswith("/ask-intents"):
                request_id = kwargs["payload"]["requestId"]
                return {"schemaVersion": 1, "requestId": request_id, "status": "classified", "intent": {
                    "schemaVersion": 1, "requestId": request_id, "requestedOutcomes": ["attended_browser"], "requiresClarification": False,
                }}
            return acknowledgement
        gateway.request.side_effect = request
        with (
            patch("muster.api.ask._require_post"),
            patch("muster.api.ask._client_for_user", return_value=(gateway, {"X-Signed": "yes"}, self.binding)),
            patch.object(frappe.db, "exists", side_effect=lambda doctype, name=None: (doctype == "DocType" and name == "Customer") or (doctype == "Customer" and name == "CUST-0001")),
            patch.object(frappe, "has_permission", return_value=True),
        ):
            result = submit(
                "CUST-0001", "desk-lineage", scope, "clarified-request",
                turn.name, parent_handoff_id, continuation["token"], turn.prompt_hash,
            )
        self.assertEqual(result["merged_objective"], "Update the customer\n\nClarification supplied by the user:\nCUST-0001")
        child = frappe.get_doc("Muster Ask Turn", result["turn_id"])
        self.assertEqual(child.parent_ask_turn, turn.name)
        self.assertEqual(child.parent_handoff_id, parent_handoff_id)
        self.assertEqual(child.clarification_reply_hash, digest(b"CUST-0001").hexdigest())
        self.assertEqual(child.verified_target_doctype, "Customer")
        self.assertEqual(child.verified_target_name, "CUST-0001")
        self.assertEqual(child.verified_target_action, "update")
        self.assertFalse(any(call.args[1].endswith("/ask-intents") for call in gateway.request.call_args_list))
        child_handoff = __import__("json").loads(child.handoffs_json)[0]["id"]
        with (
            patch("muster.api.ask._require_post"),
            patch.object(frappe.db, "exists", side_effect=lambda doctype, name=None: (doctype == "DocType" and name == "Customer") or (doctype == "Customer" and name == "CUST-0001")),
            patch.object(frappe, "has_permission", return_value=True),
            patch("muster.orchestration.workflow_proposal.request_workflow_proposal", return_value={
                "proposal": "MST-WFP-VERIFIED", "status": "Proposed", "replayed": False, "executed": False,
            }) as request_proposal,
        ):
            accepted = accept_handoff(child.name, child_handoff, 1, "accept-verified-child")
        self.assertEqual(accepted["proposal"], "MST-WFP-VERIFIED")
        self.assertEqual(request_proposal.call_args.kwargs["verified_record_identity"], {
            "doctype": "Customer", "record_name": "CUST-0001", "action": "update",
            "evidence_hash": child.verified_target_evidence_hash,
        })
        turn.reload()
        self.assertEqual(turn.clarification_child_turn, child.name)
        self.assertTrue(turn.clarification_consumed_at)
        self.assertFalse(turn.workflow_proposal)
        with (
            patch("muster.api.ask._require_post"),
            patch("muster.api.ask._client_for_user", return_value=(gateway, {"X-Signed": "yes"}, self.binding)),
            patch.object(frappe.db, "exists", side_effect=lambda doctype, name=None: (doctype == "DocType" and name == "Customer") or (doctype == "Customer" and name == "CUST-0001")),
            patch.object(frappe, "has_permission", return_value=True),
        ):
            replay = submit(
                "CUST-0001", "desk-lineage", scope, "clarified-request",
                turn.name, parent_handoff_id, continuation["token"], turn.prompt_hash,
            )
        self.assertEqual(replay["turn_id"], child.name)
        self.assertEqual(replay["merged_objective"], result["merged_objective"])
        turn.db_set("outcomes_json", '["answer"]', update_modified=False)
        with (
            patch("muster.api.ask._require_post"),
            patch.object(frappe.db, "exists", return_value=True),
            patch.object(frappe, "has_permission", return_value=True),
        ):
            with self.assertRaisesRegex(frappe.ValidationError, "parent Ask routing evidence"):
                submit(
                    "CUST-0001", "desk-lineage", scope, "clarified-request",
                    turn.name, parent_handoff_id, continuation["token"], turn.prompt_hash,
                )
        turn.db_set("outcomes_json", '["attended_browser"]', update_modified=False)
        with patch("muster.api.ask._require_post"):
            with self.assertRaises(frappe.ValidationError):
                submit(
                    "CUST-9999", "desk-lineage", scope, "replay-injection",
                    turn.name, parent_handoff_id, continuation["token"], turn.prompt_hash,
                )

    def test_exact_record_resolver_supports_delete_and_fails_closed(self):
        frappe.set_user(self.user)
        digest = __import__("hashlib").sha256
        scope = {"doctype": "Customer", "scope_mode": "context"}
        scope_json = __import__("json").dumps(scope, ensure_ascii=False, separators=(",", ":"), sort_keys=True)

        def parent(prompt="Delete the Customer", documents=None):
            value = dict(scope)
            if documents is not None:
                value["documents"] = documents
            encoded = __import__("json").dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
            return frappe.get_doc({
                "doctype": "Muster Ask Turn", "requested_by": self.user,
                "conversation_id": "desk-delete-resolver", "request_id": f"delete-resolver-{uuid4().hex}", "status": "Offered",
                "expires_at": frappe.utils.add_to_date(frappe.utils.now_datetime(), hours=1),
                "prompt_secret": prompt, "prompt_hash": digest(prompt.encode()).hexdigest(),
                "scope_json": encoded, "scope_hash": digest(encoded.encode()).hexdigest(),
                "outcomes_json": '["attended_browser"]',
                "handoffs_json": '[{"id":"handoff-delete","kind":"attended_browser","label":"Open form","state":"offered","requires":"explicit_confirmation"}]',
            }).insert()

        turn = parent()
        receipt = _issue_clarification(turn, "handoff-delete", "Which exact Customer record should I delete?")
        turn.reload()
        self.assertEqual(receipt["handoff_id"], "handoff-delete")
        self.assertEqual(turn.clarification_kind, "exact_record")
        with (
            patch.object(frappe.db, "exists", side_effect=lambda doctype, name=None: (doctype == "DocType" and name == "Customer") or (doctype == "Customer" and name == "ACME")),
            patch.object(frappe, "has_permission", return_value=True) as permission,
        ):
            verified = _verified_exact_record(turn, "ACME", self.user, "desk-delete-resolver")
        self.assertEqual(verified["verified_target_action"], "delete")
        self.assertEqual(verified["verified_target_name"], "ACME")
        permission.assert_any_call("Customer", "read", doc="ACME", user=self.user)
        permission.assert_any_call("Customer", "delete", doc="ACME", user=self.user)

        with patch.object(frappe.db, "exists", return_value=False):
            with self.assertRaises(frappe.PermissionError):
                _verified_exact_record(turn, "MISSING", self.user, "desk-delete-resolver")
        with self.assertRaisesRegex(frappe.ValidationError, "one exact record ID"):
            _verified_exact_record(turn, "ACME\nBETA", self.user, "desk-delete-resolver")
        with patch.object(frappe.db, "exists", return_value=True), patch.object(frappe, "has_permission", return_value=False):
            with self.assertRaises(frappe.PermissionError):
                _verified_exact_record(turn, "PRIVATE", self.user, "desk-delete-resolver")

        cross = parent(documents=[
            {"doctype": "Customer", "name": "ACME"},
            {"doctype": "Supplier", "name": "SUP-1"},
        ])
        _issue_clarification(cross, "handoff-delete", "Which exact Customer record should I delete?")
        cross.reload()
        with self.assertRaisesRegex(frappe.ValidationError, "one permitted record type"):
            _verified_exact_record(cross, "ACME", self.user, "desk-delete-resolver")

        ambiguous = parent(prompt="Update or delete the Customer")
        _issue_clarification(ambiguous, "handoff-delete", "Which exact Customer record should I delete?")
        ambiguous.reload()
        self.assertEqual(ambiguous.clarification_kind, "missing_detail")
        self.assertIsNone(_verified_exact_record(ambiguous, "ACME", self.user, "desk-delete-resolver"))

    def test_development_handoff_creates_only_source_bound_development_proposal(self):
        frappe.set_user(self.user)
        prompt = "Implement a tested custom app report"
        digest = __import__("hashlib").sha256
        turn = frappe.get_doc({
            "doctype": "Muster Ask Turn", "requested_by": self.user,
            "conversation_id": "desk-development", "request_id": f"development-{uuid4().hex}", "status": "Offered",
            "expires_at": frappe.utils.add_to_date(frappe.utils.now_datetime(), hours=1),
            "prompt_secret": prompt, "prompt_hash": digest(prompt.encode()).hexdigest(),
            "scope_json": "{}", "scope_hash": digest(b"{}").hexdigest(),
            "outcomes_json": '["development_workflow"]',
            "handoffs_json": '[{"id":"handoff-development","kind":"development_workflow","label":"Prepare development","state":"offered","requires":"explicit_confirmation"}]',
        }).insert()
        with (
            patch("muster.api.ask._require_post"),
            patch("muster.api.development.create_from_ask_turn", return_value={
                "proposal": "MST-DEV-TEST", "status": "Proposed", "replayed": False, "executed": False,
            }) as create,
            patch("muster.orchestration.workflow_proposal.request_workflow_proposal") as workflow,
        ):
            result = accept_handoff(
                turn.name, "handoff-development", 1, "accept-development",
                development_app="custom_app", policy="Development Policy",
            )
        self.assertEqual(result["proposal"], "MST-DEV-TEST")
        self.assertEqual(result["proposal_doctype"], "Muster Development Proposal")
        self.assertFalse(result["executed"])
        create.assert_called_once()
        workflow.assert_not_called()

    def test_guest_cannot_submit_or_poll(self):
        frappe.set_user("Guest")
        with patch("muster.api.ask._require_post"):
            with self.assertRaises(frappe.PermissionError):
                submit("Tell me about the site", "guest-session", {}, "guest-key")
        with self.assertRaises(frappe.PermissionError):
            poll("msg_33333333-3333-4333-8333-333333333333")


if __name__ == "__main__":
    unittest.main()
