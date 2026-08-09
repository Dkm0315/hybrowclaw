import hashlib
import hmac
import json
import time
import unittest
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import patch

try:
    import frappe
    from frappe.tests.utils import FrappeTestCase

    from muster.api.effect_callback import (
        MusterEffectCallbackError,
        _authenticate,
        _hash,
        _parse_plan,
    )
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


class TestEffectCallbackSecurity(FrappeTestCase):
    def _plan(self):
        authority = {
            "tenantId": "tenant-a", "siteId": "123e4567-e89b-42d3-a456-426614174000",
            "siteOrigin": "https://erp.example.test", "userId": "operator@example.test",
            "permissionEpoch": "a" * 64, "rolesHash": "b" * 64,
            "schemaRevision": "c" * 64, "dataRevision": "d" * 64,
        }
        intent = {
            "schemaVersion": 1, "capability": "frappe.record.create", "authority": authority,
            "operation": {"kind": "record", "action": "create", "doctype": "ToDo", "values": {"description": "Call customer"}},
            "idempotencyKey": "effect-1", "postconditions": [{"path": "$.description", "operator": "equals", "expected": "Call customer"}],
        }
        plan_hash = _hash(intent)
        return {**intent, "approval": {
            "receiptId": "MST-APR-2026-00001", "planHash": plan_hash,
            "actor": authority["userId"], "approvers": ["manager@example.test"],
            "approvedAt": "2026-07-19T10:00:00Z", "expiresAt": "2026-07-19T11:00:00Z",
            "scope": ["frappe.record.create"], "approvalClass": "single", "proof": {},
        }, "planHash": plan_hash}

    def test_plan_parser_rejects_plan_drift_unknown_surface_and_ssrf_fields(self):
        self.assertEqual(_parse_plan(self._plan())["capability"], "frappe.record.create")
        tampered = self._plan()
        tampered["operation"] = {**tampered["operation"], "url": "https://evil.example.test", "method": "DELETE"}
        with self.assertRaises(MusterEffectCallbackError):
            _parse_plan(tampered)
        unknown = self._plan()
        unknown["operation"] = {"kind": "raw_code", "script": "frappe.db.sql('drop table')"}
        with self.assertRaises(MusterEffectCallbackError):
            _parse_plan(unknown)
        drift = self._plan()
        drift["operation"]["values"]["description"] = "Changed after approval"
        with self.assertRaises(MusterEffectCallbackError):
            _parse_plan(drift)
        http = self._plan()
        http["authority"]["siteOrigin"] = "http://127.0.0.1:8000"
        with self.assertRaises(Exception):
            _parse_plan(http)

    def test_bearer_hmac_freshness_and_nonce_replay_fail_closed(self):
        raw = json.dumps({"envelope": {"schema_version": 1}}, separators=(",", ":")).encode()
        secret, bearer, nonce = "hmac-secret", "bearer-secret", "n" * 32
        timestamp = str(int(time.time()))
        signature = hmac.new(secret.encode(), f"{timestamp}\n{nonce}\n{hashlib.sha256(raw).hexdigest()}".encode(), hashlib.sha256).hexdigest()
        settings = SimpleNamespace(get_password=lambda field, **_kwargs: secret if field == "run_event_hmac_secret" else bearer)
        headers = {"Authorization": f"Bearer {bearer}", "X-Muster-Timestamp": timestamp, "X-Muster-Nonce": nonce, "X-Muster-Signature": f"sha256={signature}"}
        cache = _Cache()
        with patch.object(frappe, "get_request_header", side_effect=lambda name: headers.get(name)), patch.object(frappe, "cache", cache):
            _authenticate(raw, settings)
            with self.assertRaisesRegex(MusterEffectCallbackError, "already used"):
                _authenticate(raw, settings)
        for changed in (
            {"Authorization": "Bearer forged"},
            {"X-Muster-Signature": "sha256=" + "0" * 64},
            {"X-Muster-Timestamp": str(int(time.time()) - 301)},
        ):
            attempt = {**headers, **changed, "X-Muster-Nonce": "x" * 32}
            with patch.object(frappe, "get_request_header", side_effect=lambda name, values=attempt: values.get(name)), patch.object(frappe, "cache", _Cache()):
                with self.assertRaises(MusterEffectCallbackError):
                    _authenticate(raw, settings)
