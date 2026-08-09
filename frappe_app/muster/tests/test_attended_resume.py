from __future__ import annotations

import json
import time
from contextlib import contextmanager
from unittest.mock import patch

import frappe
from frappe.tests.utils import FrappeTestCase

from muster.api import attended_resume


class _Cache:
    def __init__(self):
        self.values: dict[str, str] = {}

    @contextmanager
    def lock(self, *_args, **_kwargs):
        yield

    def get_value(self, key):
        return self.values.get(key)

    def set_value(self, key, value, **_kwargs):
        self.values[key] = value

    def delete_value(self, key):
        self.values.pop(key, None)


class TestAttendedResume(FrappeTestCase):
    def setUp(self):
        super().setUp()
        self.original_method = getattr(frappe.request, "method", None) if frappe.request else None
        if frappe.request:
            frappe.request.method = "POST"

    def tearDown(self):
        if frappe.request:
            frappe.request.method = self.original_method
        super().tearDown()

    def test_issue_is_actor_site_and_exact_target_bound_without_url_data(self):
        cache = _Cache()
        preview = {"proposal": "MST-WFP-1", "doctype": "CRM Lead", "operation": "create", "record_name": None}
        target = {"surface": "crm", "route": "/crm/leads/view/list"}
        with (
            patch.object(attended_resume, "_idempotency_key", return_value="idem-1"),
            patch.object(attended_resume, "_actor", return_value="sales@example.test"),
            patch.object(attended_resume, "_site_id", return_value="site-a.local"),
            patch.object(attended_resume, "_request_route", return_value="/desk/customer"),
            patch.object(attended_resume, "attended_proposal_preview", return_value=preview),
            patch.object(attended_resume, "attended_target_for", return_value=target),
            patch.object(attended_resume, "attended_surface_for_route", return_value="desk"),
            patch.object(frappe, "cache", cache),
        ):
            issued = attended_resume.issue("MST-WFP-1", confirmed=1)
        self.assertTrue(issued["navigate_required"])
        self.assertTrue(issued["url"].startswith("/crm/leads/view/list#muster-attended-resume="))
        self.assertNotIn("MST-WFP-1", issued["url"])
        ticket = issued["url"].split("=", 1)[1]
        stored = json.loads(cache.get_value(attended_resume._ticket_key(ticket)))
        self.assertEqual(stored["actor"], "sales@example.test")
        self.assertEqual(stored["site"], "site-a.local")
        self.assertEqual(stored["target_surface"], "crm")
        self.assertEqual(stored["target_route"], "/crm/leads/view/list")
        self.assertLessEqual(stored["expires_at"] - int(time.time()), attended_resume.RESUME_TTL_SECONDS)

    def test_request_route_requires_same_host_referer_and_returns_only_path(self):
        headers = {"Referer": "https://erp.example.test/crm/leads?ui=1", "Host": "erp.example.test"}
        with patch.object(frappe, "get_request_header", side_effect=lambda name: headers.get(name)):
            self.assertEqual(attended_resume._request_route(), "/crm/leads")
        headers["Referer"] = "https://evil.example.test/crm/leads"
        with patch.object(frappe, "get_request_header", side_effect=lambda name: headers.get(name)):
            with self.assertRaises(attended_resume.MusterAttendedResumeError):
                attended_resume._request_route()

    def test_same_surface_returns_local_without_minting_ticket(self):
        cache = _Cache()
        preview = {"doctype": "CRM Lead", "operation": "create", "record_name": None}
        with (
            patch.object(attended_resume, "_idempotency_key", return_value="idem-local"),
            patch.object(attended_resume, "_actor", return_value="sales@example.test"),
            patch.object(attended_resume, "_site_id", return_value="site-a.local"),
            patch.object(attended_resume, "_request_route", return_value="/crm/leads"),
            patch.object(attended_resume, "attended_proposal_preview", return_value=preview),
            patch.object(attended_resume, "attended_target_for", return_value={"surface": "crm", "route": "/crm/leads/view/list"}),
            patch.object(attended_resume, "attended_surface_for_route", return_value="crm"),
            patch.object(frappe, "cache", cache),
        ):
            result = attended_resume.issue("MST-WFP-1", confirmed=1)
        self.assertEqual(result, {"schema_version": 1, "proposal": "MST-WFP-1", "navigate_required": False})
        self.assertEqual(cache.values, {})

    def _stored(self, *, actor="sales@example.test", site="site-a.local", route="/crm/leads/view/list", expires=None):
        return {
            "schema_version": 1, "actor": actor, "site": site, "proposal": "MST-WFP-1",
            "target_surface": "crm", "target_route": route,
            "expires_at": int(time.time()) + 60 if expires is None else expires,
        }

    def test_consume_is_single_use_and_rebuilds_fresh_preview(self):
        ticket = "t" * 64
        cache = _Cache()
        cache.set_value(attended_resume._ticket_key(ticket), json.dumps(self._stored()))
        preview = {"proposal": "MST-WFP-1", "doctype": "CRM Lead", "operation": "create", "record_name": None, "executed": False}
        with (
            patch.object(attended_resume, "_idempotency_key", return_value="idem-consume"),
            patch.object(attended_resume, "_actor", return_value="sales@example.test"),
            patch.object(attended_resume, "_site_id", return_value="site-a.local"),
            patch.object(attended_resume, "_request_route", return_value="/crm/leads/view/list"),
            patch.object(attended_resume, "attended_surface_for_route", return_value="crm"),
            patch.object(attended_resume, "attended_target_for", return_value={"surface": "crm", "route": "/crm/leads/view/list"}),
            patch.object(attended_resume, "attended_proposal_preview", return_value=preview) as fresh,
            patch.object(frappe, "cache", cache),
        ):
            self.assertEqual(attended_resume.consume(ticket, confirmed=1), preview)
            with self.assertRaises(attended_resume.MusterAttendedResumeError):
                attended_resume.consume(ticket, confirmed=1)
        fresh.assert_called_once_with("MST-WFP-1", "sales@example.test")
        self.assertIsNone(cache.get_value(attended_resume._ticket_key(ticket)))

    def test_actor_site_route_expiry_and_target_changes_consume_then_fail_closed(self):
        cases = [
            (self._stored(actor="other@example.test"), "sales@example.test", "site-a.local", "/crm/leads/view/list", {"surface": "crm", "route": "/crm/leads/view/list"}),
            (self._stored(site="site-b.local"), "sales@example.test", "site-a.local", "/crm/leads/view/list", {"surface": "crm", "route": "/crm/leads/view/list"}),
            (self._stored(route="/crm/deals"), "sales@example.test", "site-a.local", "/crm/leads/view/list", {"surface": "crm", "route": "/crm/leads/view/list"}),
            (self._stored(expires=int(time.time()) - 1), "sales@example.test", "site-a.local", "/crm/leads/view/list", {"surface": "crm", "route": "/crm/leads/view/list"}),
            (self._stored(), "sales@example.test", "site-a.local", "/crm/leads/view/list", {"surface": "desk", "route": "/desk"}),
        ]
        for index, (stored, actor, site, route, current_target) in enumerate(cases):
            with self.subTest(index=index):
                ticket = (str(index) + "x" * 63)[:64]
                cache = _Cache()
                cache.set_value(attended_resume._ticket_key(ticket), json.dumps(stored))
                preview = {"doctype": "CRM Lead", "operation": "create", "record_name": None}
                with (
                    patch.object(attended_resume, "_idempotency_key", return_value=f"idem-{index}"),
                    patch.object(attended_resume, "_actor", return_value=actor),
                    patch.object(attended_resume, "_site_id", return_value=site),
                    patch.object(attended_resume, "_request_route", return_value=route),
                    patch.object(attended_resume, "attended_surface_for_route", return_value="crm"),
                    patch.object(attended_resume, "attended_target_for", return_value=current_target),
                    patch.object(attended_resume, "attended_proposal_preview", return_value=preview),
                    patch.object(frappe, "cache", cache),
                ):
                    with self.assertRaises(attended_resume.MusterAttendedResumeError):
                        attended_resume.consume(ticket, confirmed=1)
                self.assertIsNone(cache.get_value(attended_resume._ticket_key(ticket)))
