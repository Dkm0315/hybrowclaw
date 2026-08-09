import unittest
from unittest.mock import Mock

try:
    import frappe
    from frappe.tests.utils import FrappeTestCase

    from muster.adapters.client import (
        MAX_RESPONSE_BYTES,
        GatewayBinding,
        GatewayClient,
        GatewayClientError,
        normalized_https_origin,
    )
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Frappe integration tests require an installed test site") from exc


class _Response:
    def __init__(self, status=200, chunks=(b'{}',), headers=None):
        self.status_code = status
        self._chunks = chunks
        self.headers = headers or {}
        self.closed = False

    def iter_content(self, chunk_size):
        del chunk_size
        yield from self._chunks

    def close(self):
        self.closed = True


class TestGatewayClient(unittest.TestCase):
    def setUp(self):
        self.binding = GatewayBinding(
            origin="https://gateway.example.test",
            bearer="test-secret",
            tenant_id="tenant-a",
            site_id="site-a",
            site_origin="https://erp.example.test",
            hmac_secret="hmac-secret",
        )

    def test_origin_parser_accepts_only_exact_https_origin(self):
        self.assertEqual(
            normalized_https_origin(" HTTPS://Gateway.Example.Test:8443/ "),
            "https://gateway.example.test:8443",
        )
        for invalid in (
            "http://gateway.example.test",
            "https://user:pass@gateway.example.test",
            "https://gateway.example.test/path",
            "https://gateway.example.test?redirect=x",
            "https://gateway.example.test:bad",
            "//gateway.example.test",
        ):
            with self.subTest(invalid=invalid), self.assertRaises(GatewayClientError):
                normalized_https_origin(invalid)

    def test_request_pins_transport_and_does_not_leak_secret_in_errors(self):
        response = _Response(chunks=(b'{"ok":', b'true}'))
        session = Mock()
        session.trust_env = True
        session.request.return_value = response
        client = GatewayClient(self.binding, session=session)

        self.assertEqual(client.request("post", "/v1/test", payload={"a": 1}), {"ok": True})
        _, kwargs = session.request.call_args
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer test-secret")
        self.assertTrue(kwargs["verify"])
        self.assertFalse(kwargs["allow_redirects"])
        self.assertTrue(kwargs["stream"])
        self.assertFalse(session.trust_env)
        self.assertTrue(response.closed)

    def test_binary_request_is_bounded_and_uses_only_the_server_held_bearer(self):
        response = _Response(
            chunks=(b"artifact",),
            headers={"content-type": "application/pdf", "content-length": "8"},
        )
        session = Mock()
        session.request.return_value = response
        value = GatewayClient(self.binding, session=session).request_bytes(
            "/v1/integrations/frappe/messages/runs/msg_1/artifacts/0",
            headers={"X-Frappe-User-Id": "employee@example.test"},
        )
        self.assertEqual(value.content, b"artifact")
        self.assertEqual(value.content_type, "application/pdf")
        _, kwargs = session.request.call_args
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer test-secret")
        self.assertTrue(response.closed)

        with self.assertRaises(GatewayClientError):
            GatewayClient(self.binding, session=Mock()).request_bytes(
                "/v1/integrations/frappe/messages/runs/msg_1/artifacts/0",
                headers={"Authorization": "Bearer browser-secret"},
            )

        rejected = _Response(status=401)
        session.request.return_value = rejected
        with self.assertRaises(GatewayClientError) as raised:
            GatewayClient(self.binding, session=session).request("POST", "/v1/test")
        self.assertNotIn("test-secret", str(raised.exception))
        self.assertTrue(rejected.closed)

    def test_request_rejects_route_and_credential_header_override(self):
        client = GatewayClient(self.binding, session=Mock())
        for route in ("https://evil.test", "//evil.test", "/ok?next=evil", "/ok#fragment", "/a\\b"):
            with self.subTest(route=route), self.assertRaises(GatewayClientError):
                client.request("GET", route)
        with self.assertRaises(GatewayClientError):
            client.request("GET", "/v1/test", headers={"authorization": "Bearer attacker"})

    def test_request_accepts_only_a_bounded_internal_read_timeout(self):
        response = _Response(chunks=(b'{"ok":true}',))
        session = Mock()
        session.request.return_value = response
        client = GatewayClient(self.binding, session=session)
        self.assertEqual(client.request("GET", "/v1/test", read_timeout=180), {"ok": True})
        self.assertEqual(session.request.call_args.kwargs["timeout"], (3.05, 180))
        for invalid in (0, 301, True, "30"):
            with self.subTest(invalid=invalid), self.assertRaises(GatewayClientError):
                client.request("GET", "/v1/test", read_timeout=invalid)

    def test_response_body_is_bounded_while_streaming(self):
        response = _Response(chunks=(b"a" * MAX_RESPONSE_BYTES, b"b"))
        session = Mock()
        session.request.return_value = response
        with self.assertRaises(GatewayClientError):
            GatewayClient(self.binding, session=session).request("GET", "/v1/test")
        self.assertTrue(response.closed)


class TestTrustedBindingValidation(FrappeTestCase):
    def test_site_binding_requires_complete_trust_evidence(self):
        binding = frappe.get_doc(
            {
                "doctype": "Muster Site Binding",
                "site_label": "Validation Test",
                "site_uuid": "validation-test",
                "gateway_tenant": "tenant-a",
                "status": "Trusted",
                "site_origin": "https://ERP.Example.Test/",
            }
        )
        with self.assertRaises(frappe.ValidationError):
            binding.run_method("validate")
        binding.trust_fingerprint = "sha256:test"
        binding.bound_at = frappe.utils.now_datetime()
        binding.run_method("validate")
        self.assertEqual(binding.site_origin, "https://erp.example.test")

    def test_site_binding_always_requires_tenant(self):
        binding = frappe.get_doc(
            {
                "doctype": "Muster Site Binding",
                "site_label": "No Tenant",
                "site_uuid": "no-tenant",
                "status": "Pending",
            }
        )
        with self.assertRaises(frappe.ValidationError):
            binding.run_method("validate")


if __name__ == "__main__":
    unittest.main()
