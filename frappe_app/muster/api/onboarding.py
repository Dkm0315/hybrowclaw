from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from typing import Any
from urllib.parse import urlencode
from uuid import NAMESPACE_URL, uuid5

import frappe
import requests
from frappe import _
from frappe.utils import get_url, now_datetime

from muster.adapters.client import MAX_RESPONSE_BYTES, GatewayClientError, normalized_https_origin

BOOTSTRAP_TTL_SECONDS = 600
API_FALLBACK_LIMIT = 5
API_FALLBACK_WINDOW_SECONDS = 900
AUTHORIZE_PATH = "/v1/frappe/site-bindings/authorize"
EXCHANGE_PATH = "/v1/frappe/site-bindings/exchange"
VERIFY_PATH = "/v1/frappe/site-bindings/verify"
API_CREDENTIAL_PATH = "/v1/frappe/site-bindings/api-credentials"
CAPABILITIES = (
    "frappe.identity.live",
    "frappe.permissions.live",
    "frappe.change_set.v1",
    "frappe.run_events.v1",
    "frappe.workflow_graph.v1",
)


class MusterOnboardingError(frappe.ValidationError):
    pass


def _administrator_required() -> None:
    user = frappe.session.user
    if user == "Guest":
        frappe.throw(_("Authentication required"), frappe.AuthenticationError)
    if user != "Administrator" and "System Manager" not in set(frappe.get_roles(user)):
        frappe.throw(
            _("Only Administrator or a System Manager can connect Muster"),
            frappe.PermissionError,
        )


def _site_origin(value: str | None = None) -> str:
    return normalized_https_origin(value or get_url(), "Public Site Origin")


def _request_origin() -> str:
    origin = (frappe.get_request_header("Origin") or "").strip()
    if not origin:
        referer = (frappe.get_request_header("Referer") or "").strip()
        if referer:
            parts = requests.utils.urlparse(referer)
            origin = f"{parts.scheme}://{parts.netloc}"
    if not origin:
        raise MusterOnboardingError(_("A same-origin browser request is required"))
    return normalized_https_origin(origin, "Request Origin")


def _assert_browser_origin(site_origin: str) -> None:
    if not hmac.compare_digest(_request_origin(), site_origin):
        raise MusterOnboardingError(_("The onboarding request origin does not match this site"))


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _signing_key() -> bytes:
    key = str(frappe.local.conf.get("encryption_key") or "").encode()
    if len(key) < 16:
        raise MusterOnboardingError(_("This site has no usable encryption key"))
    return hashlib.sha256(b"muster-site-bootstrap-v1\0" + key).digest()


def _state_cache_key(nonce: str) -> str:
    return f"muster:onboarding:state:{hashlib.sha256(nonce.encode()).hexdigest()}"


def _signed_state(payload: dict[str, Any]) -> str:
    body = _b64(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode())
    signature = _b64(hmac.new(_signing_key(), body.encode(), hashlib.sha256).digest())
    return f"{body}.{signature}"


def _verified_state(token: str) -> dict[str, Any]:
    try:
        body, supplied = token.split(".", 1)
        expected = _b64(hmac.new(_signing_key(), body.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(supplied, expected):
            raise ValueError
        payload = json.loads(_unb64(body))
        if payload.get("v") != 1 or int(payload.get("exp", 0)) < int(time.time()):
            raise ValueError
        if not isinstance(payload.get("nonce"), str) or len(payload["nonce"]) < 32:
            raise ValueError
        return payload
    except (TypeError, ValueError, KeyError, json.JSONDecodeError) as error:
        raise MusterOnboardingError(
            _("The Muster connection state is invalid or expired")
        ) from error


def _consume_pending(state: str) -> dict[str, Any]:
    payload = _verified_state(state)
    key = _state_cache_key(payload["nonce"])
    lock = frappe.cache.lock(f"{key}:lock", timeout=5, blocking_timeout=2)
    with lock:
        raw = frappe.cache.get_value(key)
        frappe.cache.delete_value(key)
    if not raw:
        raise MusterOnboardingError(_("The Muster connection state was already used or expired"))
    pending = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(pending, dict) or pending.get("nonce") != payload["nonce"]:
        raise MusterOnboardingError(_("The Muster connection state is invalid"))
    return pending


def _required_text(payload: dict[str, Any], key: str, maximum: int = 512) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise MusterOnboardingError(_("The gateway returned an invalid trust response"))
    return value.strip()


def _request_json(
    method: str,
    url: str,
    *,
    payload: dict[str, Any],
    bearer: str | None = None,
) -> dict[str, Any]:
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if bearer:
        headers["Authorization"] = f"Bearer {bearer}"
    session = requests.Session()
    session.trust_env = False
    try:
        response = session.request(
            method,
            url,
            json=payload,
            headers=headers,
            timeout=(3.05, 20),
            allow_redirects=False,
            verify=True,
            stream=True,
        )
    except requests.RequestException as error:
        session.close()
        raise MusterOnboardingError(_("The Muster gateway is unavailable")) from error
    try:
        declared = response.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > MAX_RESPONSE_BYTES:
            raise MusterOnboardingError(_("The gateway response exceeded the safe size limit"))
        if response.status_code < 200 or response.status_code >= 300:
            message = _("The Muster gateway rejected the connection (HTTP {0})").format(
                response.status_code
            )
            raise MusterOnboardingError(message)
        content = bytearray()
        for chunk in response.iter_content(chunk_size=65_536):
            content.extend(chunk)
            if len(content) > MAX_RESPONSE_BYTES:
                raise MusterOnboardingError(_("The gateway response exceeded the safe size limit"))
    finally:
        response.close()
        session.close()
    try:
        result = json.loads(bytes(content) or b"{}")
    except (TypeError, ValueError) as error:
        raise MusterOnboardingError(_("The gateway returned an invalid response")) from error
    if not isinstance(result, dict):
        raise MusterOnboardingError(_("The gateway returned an invalid response"))
    return result


def _site_uuid(site_origin: str) -> str:
    return str(uuid5(NAMESPACE_URL, f"muster-frappe-site:{site_origin}"))


def _exchange_and_verify(
    gateway_origin: str,
    site_origin: str,
    site_challenge: str,
    exchange_payload: dict[str, Any],
    path: str,
) -> dict[str, Any]:
    exchanged = _request_json("POST", f"{gateway_origin}{path}", payload=exchange_payload)
    bearer = _required_text(exchanged, "access_token", 4096)
    gateway_challenge = _required_text(exchanged, "gateway_challenge", 256)
    tenant_id = _required_text(exchanged, "tenant_id", 256)
    fingerprint = _required_text(exchanged, "trust_fingerprint", 256)
    binding_id = _required_text(exchanged, "binding_id", 256)
    site_id = _site_uuid(site_origin)
    verified = _request_json(
        "POST",
        f"{gateway_origin}{VERIFY_PATH}",
        bearer=bearer,
        payload={
            "binding_id": binding_id,
            "tenant_id": tenant_id,
            "site_uuid": site_id,
            "site_origin": site_origin,
            "site_challenge": site_challenge,
            "gateway_challenge": gateway_challenge,
        },
    )
    comparisons = {
        "site_challenge": site_challenge,
        "gateway_challenge": gateway_challenge,
        "tenant_id": tenant_id,
        "binding_id": binding_id,
        "trust_fingerprint": fingerprint,
    }
    if verified.get("verified") is not True or any(
        not isinstance(verified.get(key), str)
        or not hmac.compare_digest(verified[key], expected)
        for key, expected in comparisons.items()
    ):
        raise MusterOnboardingError(_("The gateway failed reciprocal trust verification"))
    return {**exchanged, **comparisons, "access_token": bearer, "site_uuid": site_id}


def _persist_verified_trust(
    gateway_origin: str, site_origin: str, trust: dict[str, Any]
) -> dict[str, Any]:
    site_id = _required_text(trust, "site_uuid", 64)
    tenant_id = _required_text(trust, "tenant_id", 256)
    fingerprint = _required_text(trust, "trust_fingerprint", 256)
    bearer = _required_text(trust, "access_token", 4096)
    existing = frappe.db.exists("Muster Site Binding", {"site_uuid": site_id})
    binding = (
        frappe.get_doc("Muster Site Binding", existing)
        if existing
        else frappe.new_doc("Muster Site Binding")
    )
    binding.update(
        {
            "site_uuid": site_id,
            "site_label": frappe.local.site,
            "site_origin": site_origin,
            "gateway_tenant": tenant_id,
            "gateway_binding_id": _required_text(trust, "binding_id", 256),
            "status": "Trusted",
            "trust_fingerprint": fingerprint,
            "bound_at": now_datetime(),
            "revoked_at": None,
            "frappe_version": getattr(frappe, "__version__", "unknown"),
            "muster_version": frappe.get_attr("muster.__version__"),
            "capabilities_json": json.dumps(CAPABILITIES),
            "last_seen_at": now_datetime(),
            "health_status": "Trust verified",
        }
    )
    binding.save(ignore_permissions=True)

    settings = frappe.get_single("Muster Settings")
    settings.gateway_url = gateway_origin
    settings.site_binding = binding.name
    settings.binding_status = "Trusted"
    settings.enabled = 1
    settings.gateway_bearer_token = bearer
    settings.run_event_hmac_secret = _required_text(trust, "hmac_secret", 4096)
    settings.webhook_secret = _required_text(trust, "webhook_secret", 4096)
    settings.oauth_client_id = str(trust.get("oauth_client_id") or "")[:512]
    oauth_secret = trust.get("oauth_client_secret")
    if oauth_secret is not None:
        if not isinstance(oauth_secret, str) or not oauth_secret or len(oauth_secret) > 4096:
            raise MusterOnboardingError(_("The gateway returned an invalid trust response"))
    settings.oauth_client_secret = oauth_secret or ""
    settings.last_health_check = now_datetime()
    settings.last_health_status = "Connected and reciprocally verified"
    settings.save(ignore_permissions=True)
    return {
        "connected": True,
        "binding_status": "Trusted",
        "site_binding": binding.name,
        "gateway_url": gateway_origin,
    }


@frappe.whitelist(allow_guest=True, methods=["GET"])
def discovery() -> dict[str, Any]:
    """Non-secret capability discovery; trust and tenant identifiers are intentionally absent."""
    try:
        origin = _site_origin()
    except (GatewayClientError, MusterOnboardingError):
        origin = None
    settings = frappe.get_single("Muster Settings")
    binding_status = (
        frappe.db.get_value("Muster Site Binding", settings.site_binding, "status")
        if settings.site_binding
        else None
    )
    connected = bool(
        settings.enabled
        and settings.binding_status == "Trusted"
        and settings.gateway_url
        and settings.site_binding
        and binding_status == "Trusted"
        and settings.get_password("gateway_bearer_token", raise_exception=False)
        and settings.get_password("run_event_hmac_secret", raise_exception=False)
    )
    return {
        "product": "Muster for Frappe",
        "protocol_version": "1.0",
        "muster_version": frappe.get_attr("muster.__version__"),
        "frappe_version": getattr(frappe, "__version__", "unknown"),
        "site_origin": origin,
        "https_required": True,
        # A state label is safe to expose and lets the CLI detect asymmetric
        # trust instead of trusting a stale gateway-side binding.
        "connection_state": "trusted" if connected else "setup_required",
        "flows": ["oauth_pkce", "api_credentials"],
        "capabilities": list(CAPABILITIES),
    }


@frappe.whitelist(methods=["POST"])
def begin(gateway_url: str, site_url: str | None = None) -> dict[str, Any]:
    _administrator_required()
    gateway_origin = normalized_https_origin(gateway_url)
    site_origin = _site_origin(site_url)
    _assert_browser_origin(site_origin)
    now = int(time.time())
    nonce = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)
    site_challenge = secrets.token_urlsafe(32)
    payload = {"v": 1, "nonce": nonce, "iat": now, "exp": now + BOOTSTRAP_TTL_SECONDS}
    state = _signed_state(payload)
    pending = {
        "nonce": nonce,
        "gateway_origin": gateway_origin,
        "site_origin": site_origin,
        "requested_by": frappe.session.user,
        "code_verifier": verifier,
        "site_challenge": site_challenge,
    }
    frappe.cache.set_value(
        _state_cache_key(nonce), json.dumps(pending), expires_in_sec=BOOTSTRAP_TTL_SECONDS
    )
    challenge = _b64(hashlib.sha256(verifier.encode()).digest())
    callback = f"{site_origin}/muster-connect"
    authorization_url = f"{gateway_origin}{AUTHORIZE_PATH}?{urlencode({
        'response_type': 'code',
        'client_id': 'frappe-site-bootstrap',
        'redirect_uri': callback,
        'state': state,
        'code_challenge': challenge,
        'code_challenge_method': 'S256',
        'site_origin': site_origin,
    })}"
    return {
        "status": "authorization_required",
        "authorization_url": authorization_url,
        "expires_in": BOOTSTRAP_TTL_SECONDS,
    }


@frappe.whitelist(allow_guest=True, methods=["POST"])
def complete(code: str, state: str) -> dict[str, Any]:
    pending = _consume_pending(state)
    gateway_origin = normalized_https_origin(pending["gateway_origin"])
    site_origin = _site_origin(pending["site_origin"])
    if not isinstance(code, str) or not code.strip() or len(code) > 2048:
        raise MusterOnboardingError(_("The gateway authorization code is invalid"))
    trust = _exchange_and_verify(
        gateway_origin,
        site_origin,
        pending["site_challenge"],
        {
            "grant_type": "authorization_code",
            "code": code.strip(),
            "code_verifier": pending["code_verifier"],
            "redirect_uri": f"{site_origin}/muster-connect",
            "site_origin": site_origin,
            "site_uuid": _site_uuid(site_origin),
            "site_challenge": pending["site_challenge"],
        },
        EXCHANGE_PATH,
    )
    return _persist_verified_trust(gateway_origin, site_origin, trust)


def _consume_fallback_nonce(nonce: str, user: str) -> None:
    if not isinstance(nonce, str) or len(nonce) < 32 or len(nonce) > 256:
        raise MusterOnboardingError(_("A fresh connection nonce is required"))
    rate_key = f"muster:onboarding:fallback-rate:{hashlib.sha256(user.encode()).hexdigest()}"
    count = int(frappe.cache.get_value(rate_key) or 0) + 1
    frappe.cache.set_value(rate_key, count, expires_in_sec=API_FALLBACK_WINDOW_SECONDS)
    if count > API_FALLBACK_LIMIT:
        raise MusterOnboardingError(_("Too many connection attempts; try again later"))
    replay_key = f"muster:onboarding:fallback-nonce:{hashlib.sha256(nonce.encode()).hexdigest()}"
    lock = frappe.cache.lock(f"{replay_key}:lock", timeout=5, blocking_timeout=2)
    with lock:
        if frappe.cache.get_value(replay_key):
            raise MusterOnboardingError(_("This connection request was already used"))
        frappe.cache.set_value(replay_key, "used", expires_in_sec=API_FALLBACK_WINDOW_SECONDS)


@frappe.whitelist(methods=["POST"])
def connect_with_api_credentials(
    gateway_url: str,
    api_key: str,
    api_secret: str,
    nonce: str,
    site_url: str | None = None,
) -> dict[str, Any]:
    """Explicit fallback. Incoming credentials are exchanged in memory and are never persisted."""
    _administrator_required()
    gateway_origin = normalized_https_origin(gateway_url)
    site_origin = _site_origin(site_url)
    _assert_browser_origin(site_origin)
    _consume_fallback_nonce(nonce, frappe.session.user)
    if not isinstance(api_key, str) or not api_key.strip() or len(api_key) > 1024:
        raise MusterOnboardingError(_("API credentials are invalid"))
    if not isinstance(api_secret, str) or not api_secret or len(api_secret) > 4096:
        raise MusterOnboardingError(_("API credentials are invalid"))
    site_challenge = secrets.token_urlsafe(32)
    trust = _exchange_and_verify(
        gateway_origin,
        site_origin,
        site_challenge,
        {
            "grant_type": "api_credentials",
            "api_key": api_key.strip(),
            "api_secret": api_secret,
            "nonce": nonce,
            "site_origin": site_origin,
            "site_uuid": _site_uuid(site_origin),
            "site_challenge": site_challenge,
        },
        API_CREDENTIAL_PATH,
    )
    return _persist_verified_trust(gateway_origin, site_origin, trust)


@frappe.whitelist(methods=["GET"])
def status() -> dict[str, Any]:
    _administrator_required()
    settings = frappe.get_single("Muster Settings")
    return {
        "enabled": bool(settings.enabled),
        "binding_status": settings.binding_status,
        "gateway_url": settings.gateway_url or None,
        "site_binding": settings.site_binding or None,
        "connected": bool(settings.enabled and settings.binding_status == "Trusted"),
    }
