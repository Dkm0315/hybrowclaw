from __future__ import annotations

from hashlib import sha256
from typing import Any

import frappe
from frappe import _
from frappe.utils import convert_utc_to_system_timezone, get_datetime, now_datetime

from muster.adapters.client import GatewayClient, trusted_binding
from muster.adapters.identity import allowed_channel_scopes, frappe_identity
from muster.change_ir.security import permission_epoch


def _require_post() -> None:
    if frappe.request and frappe.request.method != "POST":
        frappe.throw(_("This endpoint only accepts POST requests"), frappe.PermissionError)


def _idempotency_key() -> str:
    key = frappe.get_request_header("Idempotency-Key") or frappe.form_dict.get("idempotency_key")
    if not key or len(key) > 140:
        frappe.throw(_("A valid Idempotency-Key is required"), frappe.ValidationError)
    return key


def _account(name: str):
    account = frappe.get_doc("Muster Channel Account", name)
    if not account.has_permission("read"):
        frappe.throw(_("Not permitted"), frappe.PermissionError)
    if account.provider != "Telegram" or account.status != "Active":
        frappe.throw(_("An active Telegram channel account is required"), frappe.ValidationError)
    binding = trusted_binding()
    if account.site_binding != frappe.get_single("Muster Settings").site_binding:
        frappe.throw(_("The Telegram account is not attached to this trusted site"), frappe.PermissionError)
    scopes = allowed_channel_scopes(frappe.session.user, account.allowed_scopes)
    if not scopes:
        frappe.throw(_("No permitted Telegram scopes remain for this user"), frappe.PermissionError)
    return account, binding, scopes


def _idempotency_fingerprint(action: str, key: str, *parts: str) -> str:
    material = "\x1f".join((action, frappe.session.user.lower(), *parts, key))
    return sha256(material.encode()).hexdigest()


def _owned_identity(name: str):
    identity = frappe.get_doc("Muster Channel Identity", name)
    roles = set(frappe.get_roles())
    if identity.user != frappe.session.user and not roles.intersection({"System Manager", "Muster Administrator"}):
        frappe.throw(_("Not permitted"), frappe.PermissionError)
    return identity


def _database_datetime(value: str):
    """Convert an RFC 3339 gateway timestamp to Frappe's naive system time.

    MariaDB ``Datetime`` columns reject offset-bearing values. Frappe compares
    stored datetimes with ``now_datetime()``, which is also naive system time,
    so normalize once at the trust boundary instead of discarding the offset.
    """
    parsed = get_datetime(value)
    if parsed.tzinfo is not None:
        parsed = convert_utc_to_system_timezone(parsed).replace(tzinfo=None)
    return parsed


@frappe.whitelist()
def issue_telegram_link(channel_account: str) -> dict[str, Any]:
    _require_post()
    request_key = _idempotency_key()
    account, binding, scopes = _account(channel_account)
    fingerprint = _idempotency_fingerprint("issue", request_key, account.name)
    existing_name = frappe.db.get_value(
        "Muster Channel Identity", {"idempotency_fingerprint": fingerprint}, "name"
    )
    if existing_name:
        existing = _owned_identity(existing_name)
        start_url = existing.get_password("pending_start_url", raise_exception=False) or None
        return {
            "identity": existing.name,
            "status": existing.status,
            "start_url": start_url,
            "expires_at": str(existing.expires_at) if existing.expires_at else None,
            "scopes": scopes,
            "replayed": True,
        }
    epoch = permission_epoch(frappe.session.user)
    response = GatewayClient(binding).request(
        "POST",
        "/v1/frappe/telegram-links",
        payload={
            "action": "issue",
            "tenantId": binding.tenant_id,
            "site": binding.site_origin,
            "user": frappe.session.user.lower(),
            "permissionEpoch": epoch,
            "scopes": scopes,
            "allowedChatTypes": ["private"],
        },
        idempotency_key=request_key,
    )
    link_id = response.get("linkId")
    start_url = response.get("startUrl")
    expires_at = response.get("expiresAt")
    if not all(isinstance(value, str) and value for value in (link_id, start_url, expires_at)):
        frappe.throw(_("The gateway did not return a usable Telegram link"), frappe.ValidationError)
    identity = frappe.get_doc({
        "doctype": "Muster Channel Identity",
        "channel_account": account.name,
        "user": frappe.session.user,
        "status": "Pending",
        "external_subject": f"pending:{link_id}",
        "provider_link_id": link_id,
        "permission_epoch": epoch,
        "idempotency_fingerprint": fingerprint,
        "pending_start_url": start_url,
        "expires_at": _database_datetime(expires_at),
    }).insert()
    return {
        "identity": identity.name,
        "start_url": start_url,
        "expires_at": str(identity.expires_at),
        "scopes": scopes,
        "replayed": False,
    }


@frappe.whitelist()
def confirm_telegram_link(identity: str) -> dict[str, Any]:
    _require_post()
    request_key = _idempotency_key()
    doc = _owned_identity(identity)
    if doc.status == "Verified":
        return {"identity": doc.name, "status": doc.status, "replayed": True}
    if doc.status != "Pending" or not doc.provider_link_id:
        frappe.throw(_("This Telegram link cannot be confirmed"), frappe.ValidationError)
    if doc.expires_at and get_datetime(doc.expires_at) <= now_datetime():
        doc.status = "Expired"
        doc.flags.muster_channel_transition = True
        doc.save()
        frappe.throw(_("This Telegram link expired; create a new one"), frappe.ValidationError)
    account, binding, scopes = _account(doc.channel_account)
    current_epoch = permission_epoch(doc.user)
    if current_epoch != doc.permission_epoch:
        frappe.throw(_("Permissions changed; create a new Telegram link"), frappe.PermissionError)
    identity_payload = frappe_identity(doc.user)
    identity_payload["site"] = binding.site_origin
    response = GatewayClient(binding).request(
        "POST",
        "/v1/frappe/telegram-links",
        payload={
            "action": "confirm",
            "linkId": doc.provider_link_id,
            "tenantId": binding.tenant_id,
            "site": binding.site_origin,
            "user": doc.user.lower(),
            "permissionEpoch": current_epoch,
            "scopes": scopes,
            "identity": identity_payload,
        },
        idempotency_key=request_key,
    )
    telegram_user = response.get("telegramUserId")
    if not isinstance(telegram_user, str) or not telegram_user.isdigit():
        frappe.throw(_("The gateway did not confirm a Telegram identity"), frappe.ValidationError)
    doc.external_subject = telegram_user
    doc.status = "Verified"
    doc.pending_start_url = ""
    doc.verified_by = frappe.session.user
    doc.verified_at = now_datetime()
    doc.flags.muster_channel_transition = True
    doc.save()
    return {"identity": doc.name, "status": doc.status, "replayed": False}


@frappe.whitelist()
def revoke_telegram_link(identity: str) -> dict[str, Any]:
    _require_post()
    request_key = _idempotency_key()
    doc = _owned_identity(identity)
    if doc.status == "Revoked":
        return {"identity": doc.name, "status": doc.status, "replayed": True}
    account, binding, scopes = _account(doc.channel_account)
    GatewayClient(binding).request(
        "POST",
        "/v1/frappe/telegram-links",
        payload={
            "action": "revoke",
            "linkId": doc.provider_link_id,
            "tenantId": binding.tenant_id,
            "site": binding.site_origin,
            "user": doc.user.lower(),
            "permissionEpoch": doc.permission_epoch,
            "scopes": scopes,
        },
        idempotency_key=request_key,
    )
    doc.status = "Revoked"
    doc.pending_start_url = ""
    doc.revoked_at = now_datetime()
    doc.flags.muster_channel_transition = True
    doc.save()
    return {"identity": doc.name, "status": doc.status, "replayed": False}
