from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import patch

try:
    from muster.spa_shell import (
        MAX_HTML_BYTES,
        SHELL_VERSION,
        inject_authenticated_spa_shell,
    )
except ModuleNotFoundError as exc:
    if exc.name != "frappe":
        raise
    module_path = Path(__file__).parents[1] / "spa_shell.py"
    spec = importlib.util.spec_from_file_location("muster_spa_shell_standalone", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    with patch.dict(sys.modules, {"frappe": ModuleType("frappe")}):
        spec.loader.exec_module(module)
    MAX_HTML_BYTES = module.MAX_HTML_BYTES
    SHELL_VERSION = module.SHELL_VERSION
    inject_authenticated_spa_shell = module.inject_authenticated_spa_shell


class Response:
    def __init__(self, body=b"<html><body><main>CRM</main></body></html>", **values):
        self.body = body
        self.status_code = values.pop("status_code", 200)
        self.is_streamed = values.pop("is_streamed", False)
        self.direct_passthrough = values.pop("direct_passthrough", False)
        self.headers = {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Length": str(len(body)),
            **values.pop("headers", {}),
        }

    def get_data(self):
        return self.body

    def set_data(self, value):
        self.body = value

    def calculate_content_length(self):
        return len(self.body)


def request(path="/crm", method="GET"):
    return SimpleNamespace(path=path, method=method)


class TestSpaShell(unittest.TestCase):
    def test_injects_versioned_same_origin_scripts_before_body_and_repairs_headers(self):
        response = Response(headers={
            "ETag": '"old"',
            "Content-MD5": "old",
            "Last-Modified": "yesterday",
            "Accept-Ranges": "bytes",
            "Content-Security-Policy": "script-src 'self'",
        })
        self.assertTrue(inject_authenticated_spa_shell(
            response, request("/crm/leads/LEAD-1"), user="owner@example.test",
        ))
        text = response.body.decode()
        adapter = f'/assets/muster/js/surface_adapters.js?v={SHELL_VERSION}'
        assistant = f'/assets/muster/js/spa_assistant.js?v={SHELL_VERSION}'
        self.assertLess(text.index(adapter), text.index(assistant))
        self.assertLess(text.index(assistant), text.lower().index("</body>"))
        self.assertEqual(text.count("data-muster-spa-shell="), 2)
        self.assertEqual(response.headers["Content-Length"], str(len(response.body)))
        self.assertEqual(response.headers["Content-Security-Policy"], "script-src 'self'")
        for header in ("ETag", "Content-MD5", "Last-Modified", "Accept-Ranges"):
            self.assertNotIn(header, response.headers)

    def test_allows_only_authenticated_get_200_html_on_explicit_routes(self):
        cases = (
            ("Guest", request("/crm"), Response()),
            ("", request("/crm"), Response()),
            ("user@example.test", request("/crm", "POST"), Response()),
            ("user@example.test", request("/crm"), Response(status_code=302)),
            ("user@example.test", request("/desk"), Response()),
            ("user@example.test", request("/support"), Response()),
            ("user@example.test", request("/crm-malicious"), Response()),
            ("user@example.test", request("/crm\n"), Response()),
            (
                "user@example.test",
                request("/helpdesk"),
                Response(headers={"Content-Type": "application/json"}),
            ),
        )
        for user, current_request, response in cases:
            original = response.body
            original_headers = dict(response.headers)
            with self.subTest(user=user, path=current_request.path):
                self.assertFalse(inject_authenticated_spa_shell(
                    response, current_request, user=user,
                ))
                self.assertEqual(response.body, original)
                self.assertEqual(response.headers, original_headers)

    def test_fail_closed_for_streams_compression_attachments_missing_body_and_duplicates(self):
        cases = (
            Response(is_streamed=True),
            Response(direct_passthrough=True),
            Response(headers={"Content-Encoding": "gzip"}),
            Response(headers={"Transfer-Encoding": "chunked"}),
            Response(headers={"Cache-Control": "public, max-age=300"}),
            Response(headers={"Content-Length": "invalid"}),
            Response(headers={"Content-Disposition": "attachment; filename=page.html"}),
            Response(body=b"<html><main>No body close</main></html>"),
            Response(
                body=b'<html><body><script data-muster-spa-shell="old"></script></body></html>'
            ),
            Response(body=b"<html><body>" + b"A" * MAX_HTML_BYTES + b"</body></html>"),
        )
        for response in cases:
            original = response.body
            original_headers = dict(response.headers)
            with self.subTest(headers=response.headers):
                self.assertFalse(inject_authenticated_spa_shell(
                    response, request("/helpdesk/tickets"), user="user@example.test",
                ))
                self.assertEqual(response.body, original)
                self.assertEqual(response.headers, original_headers)

    def test_byte_insertion_does_not_decode_or_reencode_host_html(self):
        original = b"<html><body>\xff\xfe host bytes</BODY></html>"
        response = Response(body=original)
        self.assertTrue(inject_authenticated_spa_shell(
            response, request("/helpdesk"), user="user@example.test",
        ))
        self.assertIn(b"\xff\xfe host bytes", response.body)
        self.assertTrue(response.body.endswith(b"</BODY></html>"))

    def test_does_not_reload_existing_assets_and_can_add_only_the_missing_asset(self):
        both = Response(body=(
            b'<html><body><script src="/assets/muster/js/surface_adapters.js"></script>'
            b'<script src="/assets/muster/js/spa_assistant.js?v=old"></script></body></html>'
        ))
        original = both.body
        self.assertFalse(inject_authenticated_spa_shell(
            both, request("/crm"), user="user@example.test",
        ))
        self.assertEqual(both.body, original)

        one = Response(body=(
            b'<html><body><script src="/assets/muster/js/surface_adapters.js"></script>'
            b"</body></html>"
        ))
        self.assertTrue(inject_authenticated_spa_shell(
            one, request("/crm"), user="user@example.test",
        ))
        self.assertEqual(one.body.count(b"surface_adapters.js"), 1)
        self.assertEqual(one.body.count(b"spa_assistant.js"), 1)

    def test_frappe_after_request_hook_is_registered_without_host_app_overrides(self):
        hooks = (Path(__file__).parents[1] / "hooks.py").read_text()
        self.assertIn(
            'after_request = ["muster.spa_shell.inject_muster_spa_shell"]',
            hooks,
        )
        self.assertNotIn("override_whitelisted_methods", hooks)

    def test_custom_spa_injection_requires_a_valid_muster_owned_site_manifest(self):
        globals_ = inject_authenticated_spa_shell.__globals__
        original = globals_["_configured_custom_path"]
        try:
            globals_["_configured_custom_path"] = lambda path: path.startswith("/operations/")
            allowed = Response()
            self.assertTrue(inject_authenticated_spa_shell(
                allowed, request("/operations/visits"), user="user@example.test",
            ))
            denied = Response()
            self.assertFalse(inject_authenticated_spa_shell(
                denied, request("/unconfigured/visits"), user="user@example.test",
            ))
        finally:
            globals_["_configured_custom_path"] = original


if __name__ == "__main__":
    unittest.main()
