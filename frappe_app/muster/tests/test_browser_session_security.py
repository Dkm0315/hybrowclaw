from __future__ import annotations

import json
import time
import unittest
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import Mock, patch

try:
    import frappe
    from frappe.tests.utils import FrappeTestCase

    from muster.api import browser_session
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Frappe integration tests require an installed test site") from exc


class _Cache:
    def __init__(self):
        self.values = {}

    @contextmanager
    def lock(self, *_args, **_kwargs):
        yield

    def get_value(self, key):
        return self.values.get(key)

    def set_value(self, key, value, **_kwargs):
        self.values[key] = value

    def delete_value(self, key):
        self.values.pop(key, None)


class TestBrowserSessionSecurity(FrappeTestCase):
    def test_issue_returns_only_short_lived_actor_bound_one_use_material(self):
        challenge = "c" * 43
        envelope = {
            "schema_version": 1,
            "binding_id": "binding-1",
            "tenant_id": "tenant-1",
            "site_id": "site-1",
            "site_origin": "https://erp.example.test",
            "mission_id": "MST-MSN-1",
            "root_run_id": "run-1",
            "node_id": "work",
            "actor": "sales@example.test",
            "permission_epoch": "epoch-1",
            "browser_challenge": challenge,
            "form_schema_binding": None,
        }
        binding = SimpleNamespace(
            gateway_binding_id="binding-1", gateway_tenant="tenant-1", site_uuid="site-1",
            site_origin="https://erp.example.test", db_set=Mock(),
        )
        mission = SimpleNamespace(name="MST-MSN-1", root_run_id="run-1", status="Running")
        cache = _Cache()
        with (
            patch.object(browser_session, "_raw_request", return_value=({"envelope": envelope}, b"signed-body")),
            patch.object(browser_session, "_trusted_binding", return_value=(SimpleNamespace(), binding)),
            patch.object(browser_session, "_authenticate"),
            patch.object(browser_session, "_execution", return_value=(mission, "sales@example.test")),
            patch.object(browser_session, "permission_epoch", return_value="epoch-1"),
            patch.object(frappe, "cache", cache),
        ):
            issued = browser_session.issue()
        self.assertEqual(issued["browser_challenge"], challenge)
        self.assertEqual(issued["actor_id"], "sales@example.test")
        self.assertLessEqual(
            frappe.utils.get_datetime(issued["expires_at"]).timestamp() - time.time(),
            browser_session.BOOTSTRAP_TTL_SECONDS + 2,
        )
        serialized = json.dumps(issued).lower()
        for forbidden in ("password", "api_key", "api_secret", "cookie", "authorization"):
            self.assertNotIn(forbidden, serialized)
        self.assertIn(browser_session._ticket_key(issued["ticket"]), cache.values)

    def test_attended_crud_is_bound_to_effective_customizations_and_stale_schema_fails_closed(self):
        challenge = "c" * 43
        form_binding = {
            "doctype": "Customer", "schema_hash": "a" * 64, "revision": "b" * 64,
            "operation": "update", "fields": ["custom_service_tier"], "record_name": "ACME",
        }
        envelope = {
            "schema_version": 1, "binding_id": "binding-1", "tenant_id": "tenant-1",
            "site_id": "site-1", "site_origin": "https://erp.example.test", "mission_id": "MST-MSN-1",
            "root_run_id": "run-1", "node_id": "work", "actor": "sales@example.test",
            "permission_epoch": "epoch-1", "browser_challenge": challenge, "form_schema_binding": form_binding,
        }
        binding = SimpleNamespace(gateway_binding_id="binding-1", gateway_tenant="tenant-1", site_uuid="site-1", site_origin="https://erp.example.test", db_set=Mock())
        mission = SimpleNamespace(name="MST-MSN-1", root_run_id="run-1", status="Running")
        snapshot = {
            "doctype": "Customer", "schema_hash": "a" * 64, "revision": "b" * 64,
            "fields": [{"fieldname": "custom_service_tier", "label": "Service Tier", "provenance": {"source": "custom_field", "property_setters": [{"name": "mandatory-tier"}]}}],
            "doctype_property_setters": [], "workflow": None,
            "client_scripts": [{"name": "Customer-Form", "view": "Form", "modified": "2026-07-19"}],
            "custom_permissions": [{"name": "Customer-Sales User"}], "server_scripts": [{"name": "Customer Validate"}],
            "form_extensions": {"action_count": 2, "link_count": 3},
        }
        cache = _Cache()
        with (
            patch.object(browser_session, "_raw_request", return_value=({"envelope": envelope}, b"signed-body")),
            patch.object(browser_session, "_trusted_binding", return_value=(SimpleNamespace(), binding)),
            patch.object(browser_session, "_authenticate"),
            patch.object(browser_session, "_execution", return_value=(mission, "sales@example.test")),
            patch.object(browser_session, "permission_epoch", return_value="epoch-1"),
            patch.object(browser_session, "assert_form_schema_binding", return_value=snapshot) as verify,
            patch.object(frappe, "cache", cache),
        ):
            issued = browser_session.issue()
        verify.assert_called_once_with(form_binding, user="sales@example.test")
        self.assertEqual(issued["form_schema"]["customized_fields"][0]["source"], "custom_field")
        self.assertEqual(issued["form_schema"]["customized_fields"][0]["property_setter_count"], 1)
        # Script identities/counts are legitimate customization provenance, but
        # executable source must never cross the attended-browser boundary.
        self.assertNotIn("script_source", json.dumps(issued["form_schema"]).lower())
        self.assertTrue(all(set(row) == {"name", "view", "modified"} for row in issued["form_schema"]["client_scripts"]))

        with (
            patch.object(browser_session, "_raw_request", return_value=({"envelope": envelope}, b"signed-body")),
            patch.object(browser_session, "_trusted_binding", return_value=(SimpleNamespace(), binding)),
            patch.object(browser_session, "_authenticate"),
            patch.object(browser_session, "_execution", return_value=(mission, "sales@example.test")),
            patch.object(browser_session, "permission_epoch", return_value="epoch-1"),
            patch.object(browser_session, "assert_form_schema_binding", side_effect=browser_session.MusterBrowserSessionError("changed")),
            patch.object(frappe, "cache", _Cache()),
        ):
            with self.assertRaisesRegex(browser_session.MusterBrowserSessionError, "changed"):
                browser_session.issue()

    def test_consume_is_post_body_only_one_shot_and_logs_in_exact_actor(self):
        ticket = "t" * 64
        challenge = "c" * 43
        bootstrap_id = "browser-bootstrap-1"
        stored = {
            "schema_version": 1,
            "bootstrap_id": bootstrap_id,
            "mission_id": "MST-MSN-1",
            "root_run_id": "run-1",
            "node_id": "work",
            "actor": "sales@example.test",
            "permission_epoch": "epoch-1",
            "browser_challenge": challenge,
            "binding_id": "binding-1",
            "site_id": "site-1",
            "tenant_id": "tenant-1",
            "site_origin": "https://erp.example.test",
            "expires_at": int(time.time()) + 60,
        }
        cache = _Cache()
        cache.set_value(browser_session._ticket_key(ticket), json.dumps(stored))
        login = Mock()
        frappe.local.login_manager = SimpleNamespace(login_as=login)
        body = {"ticket": ticket, "browser_challenge": challenge, "bootstrap_id": bootstrap_id}
        with (
            patch.object(browser_session, "_exact_json_body", return_value=(body, b"post-body")),
            patch.object(browser_session, "_trusted_binding"),
            patch.object(browser_session, "_current_mission", return_value=(SimpleNamespace(), "sales@example.test")),
            patch.object(frappe, "cache", cache),
        ):
            result = browser_session.consume()
            with self.assertRaisesRegex(browser_session.MusterBrowserSessionError, "invalid or expired"):
                browser_session.consume()
        login.assert_called_once_with("sales@example.test")
        self.assertTrue(result["authenticated"])
        self.assertEqual(result["route"], "/desk")
        self.assertNotIn(ticket, json.dumps(result))

    def test_wrong_browser_challenge_consumes_ticket_and_never_logs_in(self):
        ticket = "t" * 64
        stored = {
            "bootstrap_id": "browser-bootstrap-1", "browser_challenge": "c" * 43,
            "expires_at": int(time.time()) + 60,
        }
        cache = _Cache()
        cache.set_value(browser_session._ticket_key(ticket), json.dumps(stored))
        login = Mock()
        frappe.local.login_manager = SimpleNamespace(login_as=login)
        body = {"ticket": ticket, "browser_challenge": "x" * 43, "bootstrap_id": "browser-bootstrap-1"}
        with patch.object(browser_session, "_exact_json_body", return_value=(body, b"post-body")), patch.object(frappe, "cache", cache):
            with self.assertRaisesRegex(browser_session.MusterBrowserSessionError, "invalid or expired"):
                browser_session.consume()
        login.assert_not_called()
        self.assertIsNone(cache.get_value(browser_session._ticket_key(ticket)))
