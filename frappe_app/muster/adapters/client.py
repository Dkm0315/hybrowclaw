from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import frappe
import requests
from frappe import _

MAX_RESPONSE_BYTES = 1_048_576
MAX_ARTIFACT_BYTES = 25 * 1_048_576


class GatewayClientError(frappe.ValidationError):
    pass


def normalized_https_origin(value: str, label: str = "Gateway URL") -> str:
    parsed = urlsplit((value or "").strip())
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        raise GatewayClientError(_("{0} must be an exact HTTPS origin").format(label))
    try:
        parsed_port = parsed.port
    except ValueError as error:
        raise GatewayClientError(_("{0} must be an exact HTTPS origin").format(label)) from error
    port = f":{parsed_port}" if parsed_port else ""
    return f"https://{parsed.hostname.lower()}{port}"


@dataclass(frozen=True)
class GatewayBinding:
    origin: str
    bearer: str
    tenant_id: str
    site_id: str
    site_origin: str
    hmac_secret: str


@dataclass(frozen=True)
class GatewayBinary:
    content: bytes
    content_type: str
    content_disposition: str


def trusted_binding() -> GatewayBinding:
    settings = frappe.get_single("Muster Settings")
    if not settings.enabled or settings.binding_status != "Trusted":
        raise GatewayClientError(_("Muster gateway trust is not active"))
    if not settings.site_binding:
        raise GatewayClientError(_("A trusted site binding is required"))
    binding = frappe.get_doc("Muster Site Binding", settings.site_binding)
    if binding.status != "Trusted" or not binding.trust_fingerprint:
        raise GatewayClientError(_("The selected site binding is not trusted"))
    if not binding.site_origin:
        raise GatewayClientError(_("The trusted site needs an exact public HTTPS origin"))
    bearer = settings.get_password("gateway_bearer_token", raise_exception=False) or ""
    if not bearer:
        raise GatewayClientError(_("Gateway authentication is not configured"))
    hmac_secret = settings.get_password("run_event_hmac_secret", raise_exception=False) or ""
    if not hmac_secret:
        raise GatewayClientError(_("Gateway authority proof is not configured"))
    return GatewayBinding(
        origin=normalized_https_origin(settings.gateway_url),
        bearer=bearer,
        tenant_id=(binding.gateway_tenant or "").strip(),
        site_id=(binding.site_uuid or "").strip(),
        site_origin=normalized_https_origin(binding.site_origin, "Public Site Origin"),
        hmac_secret=hmac_secret,
    )


class GatewayClient:
    def __init__(self, binding: GatewayBinding | None = None, session: requests.Session | None = None):
        self.binding = binding or trusted_binding()
        self.session = session or requests.Session()
        self.session.trust_env = False

    def request(
        self,
        method: str,
        path: str,
        *,
        payload: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
        idempotency_key: str | None = None,
        headers: dict[str, str] | None = None,
        read_timeout: float = 30,
    ) -> dict[str, Any]:
        if (
            not path.startswith("/")
            or path.startswith("//")
            or "\\" in path
            or "?" in path
            or "#" in path
        ):
            raise GatewayClientError(_("Invalid gateway route"))
        forbidden_headers = {"authorization", "host", "content-length", "transfer-encoding"}
        if any(name.lower() in forbidden_headers for name in (headers or {})):
            raise GatewayClientError(_("A protected gateway header cannot be overridden"))
        if not isinstance(read_timeout, (int, float)) or isinstance(read_timeout, bool) or read_timeout < 1 or read_timeout > 300:
            raise GatewayClientError(_("Gateway read timeout is outside the safe range"))
        request_headers = {
            "Authorization": f"Bearer {self.binding.bearer}",
            "Accept": "application/json",
            "Content-Type": "application/json",
            **(headers or {}),
        }
        if idempotency_key:
            request_headers["Idempotency-Key"] = idempotency_key
        try:
            response = self.session.request(
                method.upper(),
                f"{self.binding.origin}{path}",
                json=payload,
                params=params,
                headers=request_headers,
                timeout=(3.05, read_timeout),
                allow_redirects=False,
                verify=True,
                stream=True,
            )
        except requests.RequestException as error:
            raise GatewayClientError(_("The trusted Muster gateway is unavailable")) from error
        try:
            declared = response.headers.get("content-length")
            if declared and declared.isdigit() and int(declared) > MAX_RESPONSE_BYTES:
                raise GatewayClientError(_("The gateway response exceeded the safe size limit"))
            if response.status_code < 200 or response.status_code >= 300:
                detail = ""
                try:
                    error_payload = response.json()
                    if isinstance(error_payload, dict):
                        for key in ("error", "message", "detail", "title"):
                            if isinstance(error_payload.get(key), str) and error_payload[key].strip():
                                detail = error_payload[key].strip()[:500]
                                break
                        if not detail:
                            detail = json.dumps(error_payload, ensure_ascii=True, separators=(",", ":"))[:500]
                except (TypeError, ValueError):
                    detail = (response.text or "").strip()[:500]
                raise GatewayClientError(
                    _("The gateway rejected the request (HTTP {0}){1}").format(
                        response.status_code,
                        f": {detail}" if detail else "",
                    )
                )
            content_buffer = bytearray()
            for chunk in response.iter_content(chunk_size=65_536):
                if not chunk:
                    continue
                content_buffer.extend(chunk)
                if len(content_buffer) > MAX_RESPONSE_BYTES:
                    raise GatewayClientError(_("The gateway response exceeded the safe size limit"))
            content = bytes(content_buffer)
        finally:
            response.close()
        try:
            value = json.loads(content or b"{}")
        except (TypeError, ValueError) as error:
            raise GatewayClientError(_("The gateway returned an invalid response")) from error
        if not isinstance(value, dict):
            raise GatewayClientError(_("The gateway returned an invalid response"))
        return value

    def request_bytes(
        self,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> GatewayBinary:
        """Fetch a bounded authenticated artifact without exposing site credentials."""
        if (
            not path.startswith("/")
            or path.startswith("//")
            or "\\" in path
            or "?" in path
            or "#" in path
        ):
            raise GatewayClientError(_("Invalid gateway route"))
        forbidden_headers = {"authorization", "host", "content-length", "transfer-encoding"}
        if any(name.lower() in forbidden_headers for name in (headers or {})):
            raise GatewayClientError(_("A protected gateway header cannot be overridden"))
        request_headers = {
            "Authorization": f"Bearer {self.binding.bearer}",
            "Accept": "application/octet-stream,*/*",
            **(headers or {}),
        }
        try:
            response = self.session.request(
                "GET",
                f"{self.binding.origin}{path}",
                params=params,
                headers=request_headers,
                timeout=(3.05, 30),
                allow_redirects=False,
                verify=True,
                stream=True,
            )
        except requests.RequestException as error:
            raise GatewayClientError(_("The trusted Muster gateway is unavailable")) from error
        try:
            declared = response.headers.get("content-length")
            if declared and declared.isdigit() and int(declared) > MAX_ARTIFACT_BYTES:
                raise GatewayClientError(_("The gateway artifact exceeded the safe size limit"))
            if response.status_code < 200 or response.status_code >= 300:
                raise GatewayClientError(
                    _("The gateway rejected the artifact request (HTTP {0})").format(response.status_code)
                )
            content_buffer = bytearray()
            for chunk in response.iter_content(chunk_size=65_536):
                if not chunk:
                    continue
                content_buffer.extend(chunk)
                if len(content_buffer) > MAX_ARTIFACT_BYTES:
                    raise GatewayClientError(_("The gateway artifact exceeded the safe size limit"))
            return GatewayBinary(
                content=bytes(content_buffer),
                content_type=(response.headers.get("content-type") or "application/octet-stream")[:255],
                content_disposition=(response.headers.get("content-disposition") or "")[:1000],
            )
        finally:
            response.close()
