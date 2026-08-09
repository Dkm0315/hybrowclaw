from __future__ import annotations

import hashlib
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

try:
    import frappe
    from frappe.tests.utils import FrappeTestCase
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Frappe integration tests require an installed test site") from exc

from muster.api import onboarding
from muster.www import muster_connect


class TestMusterOnboarding(FrappeTestCase):
    gateway = "https://gateway.example.test"
    site = "https://erp.example.test"

    def setUp(self):
        super().setUp()
        self.original_user = frappe.session.user
        self.original_form_dict = frappe.form_dict
        frappe.set_user("Administrator")

    def tearDown(self):
        rate_key = (
            "muster:onboarding:fallback-rate:"
            + hashlib.sha256("Administrator".encode()).hexdigest()
        )
        frappe.cache.delete_value(rate_key)
        frappe.form_dict = self.original_form_dict
        frappe.set_user(self.original_user)
        super().tearDown()

    @staticmethod
    def _trust(site: str) -> dict:
        return {
            "site_uuid": onboarding._site_uuid(site),
            "tenant_id": "tenant-test",
            "binding_id": "binding-test",
            "trust_fingerprint": "sha256:test-fingerprint",
            "access_token": "issued-access-token",
            "hmac_secret": "issued-hmac-secret",
            "webhook_secret": "issued-webhook-secret",
            "oauth_client_id": "frappe-test",
            "oauth_client_secret": "issued-oauth-secret",
        }

    def _begin_state(self, site: str | None = None) -> str:
        site = site or self.site
        with patch.object(onboarding, "_assert_browser_origin"):
            result = onboarding.begin(self.gateway, site)
        authorization = urlsplit(result["authorization_url"])
        self.assertEqual(f"{authorization.scheme}://{authorization.netloc}", self.gateway)
        query = parse_qs(authorization.query)
        self.assertEqual(query["code_challenge_method"], ["S256"])
        self.assertEqual(query["redirect_uri"], [f"{site}/muster-connect"])
        self.assertNotIn("code_verifier", query)
        return query["state"][0]

    def test_discovery_is_minimal_and_contains_no_secrets(self):
        with patch.object(onboarding, "get_url", return_value=self.site):
            result = onboarding.discovery()
        self.assertEqual(result["protocol_version"], "1.0")
        serialized = str(result).lower()
        for forbidden in ("token", "secret", "tenant_id", "site_uuid", "fingerprint"):
            self.assertNotIn(forbidden, serialized)

    def test_begin_rejects_guest_insecure_gateway_and_cross_origin_request(self):
        frappe.set_user("Guest")
        with self.assertRaises(frappe.AuthenticationError):
            onboarding.begin(self.gateway, self.site)
        frappe.set_user("Administrator")
        with self.assertRaises(onboarding.GatewayClientError):
            onboarding.begin("http://gateway.example.test", self.site)
        with patch.object(
            onboarding, "_request_origin", return_value="https://other.example.test"
        ):
            with self.assertRaises(onboarding.MusterOnboardingError):
                onboarding.begin(self.gateway, self.site)

    def test_oauth_state_is_pkce_bound_one_shot_and_persists_only_verified_trust(self):
        state = self._begin_state()
        trust = self._trust(self.site)
        with patch.object(onboarding, "_exchange_and_verify", return_value=trust):
            result = onboarding.complete("single-use-code", state)
        self.assertEqual(result["binding_status"], "Trusted")
        self.assertNotIn("access_token", result)
        self.assertNotIn("secret", str(result).lower())
        settings = frappe.get_single("Muster Settings")
        self.assertEqual(settings.get_password("gateway_bearer_token"), "issued-access-token")
        self.assertEqual(settings.get_password("run_event_hmac_secret"), "issued-hmac-secret")
        self.assertEqual(settings.get_password("webhook_secret"), "issued-webhook-secret")
        self.assertEqual(settings.get_password("oauth_client_secret"), "issued-oauth-secret")
        with self.assertRaises(onboarding.MusterOnboardingError):
            onboarding.complete("replayed-code", state)

    def test_tampered_or_failed_exchange_never_creates_trust(self):
        site = f"https://erp-{uuid4().hex}.example.test"
        state = self._begin_state(site)
        with self.assertRaises(onboarding.MusterOnboardingError):
            onboarding.complete("code", f"{state[:-1]}x")
        # Tampering does not consume the authentic state; a real callback may still arrive.
        with patch.object(
            onboarding,
            "_exchange_and_verify",
            side_effect=onboarding.MusterOnboardingError("challenge mismatch"),
        ):
            with self.assertRaises(onboarding.MusterOnboardingError):
                onboarding.complete("code", state)
        site_id = onboarding._site_uuid(site)
        self.assertFalse(frappe.db.exists("Muster Site Binding", {"site_uuid": site_id}))

    def test_api_fallback_requires_fresh_nonce_and_never_stores_input_credentials(self):
        nonce = uuid4().hex + uuid4().hex
        captured = {}

        def exchange(gateway, site, challenge, payload, path):
            captured.update(payload)
            return self._trust(site)

        with (
            patch.object(onboarding, "_assert_browser_origin"),
            patch.object(onboarding, "_exchange_and_verify", side_effect=exchange),
        ):
            result = onboarding.connect_with_api_credentials(
                self.gateway, "input-key", "input-secret", nonce, self.site
            )
            self.assertTrue(result["connected"])
            with self.assertRaises(onboarding.MusterOnboardingError):
                onboarding.connect_with_api_credentials(
                    self.gateway, "input-key", "input-secret", nonce, self.site
                )
        self.assertEqual(captured["api_secret"], "input-secret")
        settings = frappe.get_single("Muster Settings")
        for fieldname in (
            "gateway_bearer_token",
            "run_event_hmac_secret",
            "oauth_client_secret",
            "webhook_secret",
        ):
            self.assertEqual(settings.meta.get_field(fieldname).fieldtype, "Password")
        self.assertNotEqual(settings.get_password("gateway_bearer_token"), "input-secret")

    def test_reciprocal_verification_rejects_mismatched_challenge(self):
        exchange = {
            "access_token": "token",
            "gateway_challenge": "gateway-challenge",
            "tenant_id": "tenant",
            "binding_id": "binding",
            "trust_fingerprint": "fingerprint",
            "hmac_secret": "hmac",
            "webhook_secret": "webhook",
        }
        mismatch = {
            "verified": True,
            "site_challenge": "wrong",
            "gateway_challenge": "gateway-challenge",
            "tenant_id": "tenant",
            "binding_id": "binding",
            "trust_fingerprint": "fingerprint",
        }
        with patch.object(onboarding, "_request_json", side_effect=[exchange, mismatch]):
            with self.assertRaises(onboarding.MusterOnboardingError):
                onboarding._exchange_and_verify(
                    self.gateway,
                    self.site,
                    "site-challenge",
                    {"code": "code"},
                    onboarding.EXCHANGE_PATH,
                )

    def test_cli_route_renders_native_consent_before_callback(self):
        frappe.form_dict = frappe._dict({"gateway_url": self.gateway})
        context = frappe._dict()
        with patch.object(muster_connect, "_site_origin", return_value=self.site):
            muster_connect.get_context(context)
        self.assertEqual(context.mode, "consent")
        self.assertTrue(context.consent_ready)
        self.assertEqual(context.gateway_url, self.gateway)
        self.assertEqual(context.site_url, self.site)
        self.assertFalse(context.success)

    def test_cli_route_requires_frappe_sign_in_without_consuming_callback_state(self):
        frappe.set_user("Guest")
        frappe.form_dict = frappe._dict({"gateway_url": self.gateway})
        context = frappe._dict()
        with patch.object(muster_connect, "_consume_pending") as consume:
            muster_connect.get_context(context)
        self.assertEqual(context.mode, "consent")
        self.assertTrue(context.requires_login)
        self.assertIn("redirect-to=", context.login_url)
        consume.assert_not_called()

    def test_callback_page_commits_verified_trust(self):
        frappe.form_dict = frappe._dict({"code": "verified-code", "state": "signed-state"})
        context = frappe._dict()
        with (
            patch.object(muster_connect, "complete", return_value={"connected": True}),
            patch.object(frappe.db, "commit") as commit,
            patch.object(frappe.db, "rollback") as rollback,
        ):
            muster_connect.get_context(context)
        self.assertTrue(context.success)
        commit.assert_called_once_with()
        rollback.assert_not_called()

    def test_callback_page_rolls_back_failed_trust(self):
        frappe.form_dict = frappe._dict({"code": "bad-code", "state": "signed-state"})
        context = frappe._dict()
        with (
            patch.object(
                muster_connect,
                "complete",
                side_effect=onboarding.MusterOnboardingError("verification failed"),
            ),
            patch.object(frappe.db, "commit") as commit,
            patch.object(frappe.db, "rollback") as rollback,
        ):
            muster_connect.get_context(context)
        self.assertFalse(context.success)
        self.assertIn("No trust was created", context.error)
        commit.assert_not_called()
        rollback.assert_called_once_with()
