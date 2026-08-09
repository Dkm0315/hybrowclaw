"""Inject Muster-owned assets into explicitly supported authenticated SPA shells."""

from __future__ import annotations

from typing import Any

import frappe


SHELL_VERSION = "20260720-25"
MAX_HTML_BYTES = 5_000_000
_ALLOWED_PATHS = ("/crm", "/helpdesk")
_DUPLICATE_MARKER = b"data-muster-spa-shell="
_BODY_CLOSE = b"</body>"
_ASSETS = (
    "/assets/muster/js/surface_adapters.js",
    "/assets/muster/js/spa_assistant.js",
)


def inject_muster_spa_shell(response: Any, request: Any) -> None:
    """Frappe ``after_request`` hook; unsupported responses remain untouched."""
    try:
        user = str(getattr(frappe.session, "user", "") or "")
        inject_authenticated_spa_shell(response, request, user=user)
    except Exception:
        # Injection is optional. Never replace or expose details from the host response.
        return


def inject_authenticated_spa_shell(response: Any, request: Any, *, user: str) -> bool:
    """Mutate an eligible buffered HTML response and report whether it changed."""
    try:
        if not _eligible(response, request, user=user):
            return False
        declared_length = _content_length(response)
        if declared_length is None or declared_length > MAX_HTML_BYTES:
            return False
        body = response.get_data()
        if not isinstance(body, bytes) or len(body) > MAX_HTML_BYTES:
            return False
        lowered = body.lower()
        if _DUPLICATE_MARKER in lowered:
            return False
        missing_assets = [asset for asset in _ASSETS if asset.encode("ascii") not in lowered]
        if not missing_assets:
            return False
        closing = lowered.rfind(_BODY_CLOSE)
        if closing < 0:
            return False
        tags = "".join(
            f'\n<script defer src="{asset}?v={SHELL_VERSION}" '
            f'data-muster-spa-shell="{SHELL_VERSION}"></script>'
            for asset in missing_assets
        ).encode("ascii") + b"\n"
        injected = body[:closing] + tags + body[closing:]
        response.set_data(injected)
        response.headers["Content-Length"] = str(len(injected))
        for header in ("ETag", "Content-MD5", "Last-Modified", "Accept-Ranges"):
            response.headers.pop(header, None)
        return True
    except Exception:
        return False


def _eligible(response: Any, request: Any, *, user: str) -> bool:
    if user in {"", "Guest"} or getattr(request, "method", "") != "GET":
        return False
    path = str(getattr(request, "path", "") or "")
    if (
        len(path) > 2_048
        or any(ord(character) < 32 or ord(character) == 127 for character in path)
        or not (
            any(path == base or path.startswith(f"{base}/") for base in _ALLOWED_PATHS)
            or _configured_custom_path(path)
        )
    ):
        return False
    if getattr(response, "status_code", None) != 200:
        return False
    if getattr(response, "is_streamed", False) or getattr(response, "direct_passthrough", False):
        return False
    content_type = str(response.headers.get("Content-Type", "") or "")
    if content_type.split(";", 1)[0].strip().lower() != "text/html":
        return False
    content_encoding = str(response.headers.get("Content-Encoding", "") or "").strip().lower()
    if content_encoding not in {"", "identity"}:
        return False
    if response.headers.get("Transfer-Encoding"):
        return False
    cache_control = str(response.headers.get("Cache-Control", "") or "").lower()
    if "public" in {directive.strip().split("=", 1)[0] for directive in cache_control.split(",")}:
        return False
    disposition = str(response.headers.get("Content-Disposition", "") or "").strip().lower()
    return not disposition.startswith("attachment")


def _configured_custom_path(path: str) -> bool:
    try:
        from muster.api.surface import is_configured_spa_route

        return is_configured_spa_route(path)
    except Exception:
        return False


def _content_length(response: Any) -> int | None:
    raw = response.headers.get("Content-Length")
    if raw not in (None, ""):
        try:
            length = int(raw)
        except (TypeError, ValueError):
            return None
        return length if length >= 0 else None
    calculated = response.calculate_content_length()
    return calculated if isinstance(calculated, int) and calculated >= 0 else None
