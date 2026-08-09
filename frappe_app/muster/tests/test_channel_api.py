import unittest
from unittest.mock import Mock, patch
from uuid import uuid4

try:
    import frappe
    from frappe.tests.utils import FrappeTestCase

    from muster.adapters.client import GatewayBinding
    from muster.api.channel import issue_telegram_link
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Frappe integration tests require an installed test site") from exc


class TestTelegramLinking(FrappeTestCase):
    def setUp(self):
        super().setUp()
        self.original_user = frappe.session.user
        suffix = uuid4().hex[:10]
        self.operator = self._make_user(f"channel-{suffix}@example.test", "Muster Operator")
        frappe.set_user("Administrator")
        self.binding = frappe.get_doc(
            {
                "doctype": "Muster Site Binding",
                "site_label": f"Channel Test {suffix}",
                "site_uuid": f"channel-{suffix}",
                "gateway_tenant": f"tenant-{suffix}",
                "status": "Pending",
            }
        ).insert()
        self.account = frappe.get_doc(
            {
                "doctype": "Muster Channel Account",
                "account_name": f"Telegram Test {suffix}",
                "provider": "Telegram",
                "status": "Active",
                "site_binding": self.binding.name,
                "allowed_scopes": "frappe:read\nfrappe:write\nfrappe:approve",
            }
        ).insert()

    def tearDown(self):
        frappe.set_user(self.original_user)
        super().tearDown()

    def _make_user(self, email, role):
        return frappe.get_doc(
            {
                "doctype": "User",
                "email": email,
                "first_name": "Channel Test",
                "enabled": 1,
                "send_welcome_email": 0,
                "roles": [{"role": role}],
            }
        ).insert(ignore_permissions=True).name

    def test_issue_is_idempotent_and_forwards_authority(self):
        trusted = GatewayBinding(
            origin="https://gateway.example.test",
            bearer="secret",
            tenant_id=self.binding.gateway_tenant,
            site_id=self.binding.site_uuid,
            site_origin="https://erp.example.test",
            hmac_secret="hmac-secret",
        )
        gateway = Mock()
        gateway.request.return_value = {
            "linkId": f"link-{uuid4().hex}",
            "startUrl": "https://t.me/muster_test_bot?start=opaque-token",
            "expiresAt": "2099-01-01T00:00:00Z",
        }
        frappe.set_user(self.operator)
        with (
            patch("muster.api.channel._require_post"),
            patch("muster.api.channel._idempotency_key", return_value="request-1"),
            patch("muster.api.channel._account", return_value=(self.account, trusted, ["frappe:read", "frappe:write"])),
            patch("muster.api.channel.permission_epoch", return_value="epoch-1"),
            patch("muster.api.channel.GatewayClient", return_value=gateway),
        ):
            first = issue_telegram_link(self.account.name)
            replay = issue_telegram_link(self.account.name)

        self.assertFalse(first["replayed"])
        self.assertTrue(replay["replayed"])
        self.assertEqual(first["identity"], replay["identity"])
        self.assertEqual(first["start_url"], replay["start_url"])
        gateway.request.assert_called_once()
        _, kwargs = gateway.request.call_args
        self.assertEqual(kwargs["idempotency_key"], "request-1")
        self.assertEqual(kwargs["payload"]["permissionEpoch"], "epoch-1")
        self.assertEqual(kwargs["payload"]["scopes"], ["frappe:read", "frappe:write"])

    def test_non_global_user_cannot_list_another_users_identity(self):
        frappe.set_user("Administrator")
        identity = frappe.get_doc(
            {
                "doctype": "Muster Channel Identity",
                "channel_account": self.account.name,
                "user": self.operator,
                "status": "Pending",
                "external_subject": f"pending:{uuid4().hex}",
                "provider_link_id": f"link-{uuid4().hex}",
                "permission_epoch": "epoch-test",
            }
        ).insert()
        other = self._make_user(f"other-{uuid4().hex[:10]}@example.test", "Muster Viewer")
        frappe.set_user(other)
        self.assertEqual(
            frappe.get_list(
                "Muster Channel Identity", filters={"name": identity.name}, pluck="name"
            ),
            [],
        )
        self.assertFalse(identity.has_permission("read", user=other))


if __name__ == "__main__":
    unittest.main()
