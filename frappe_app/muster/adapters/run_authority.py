from __future__ import annotations

import hmac
import json
import secrets
from hashlib import sha256

from muster.adapters.client import GatewayBinding


def run_authority_headers(
    binding: GatewayBinding, user: str, csrf_token: str | None = None
) -> tuple[dict[str, str], str]:
    """Create the HMAC-bound tenant/site/user lane expected by the gateway."""
    token = csrf_token or secrets.token_urlsafe(32)
    normalized_user = user.strip().lower()
    material = json.dumps(
        [token, binding.tenant_id, binding.site_id or "", normalized_user],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    proof = hmac.new(binding.hmac_secret.encode(), material.encode(), sha256).hexdigest()
    return (
        {
            "X-Frappe-Tenant-Id": binding.tenant_id,
            "X-Frappe-Site-Id": binding.site_id,
            "X-Frappe-User-Id": normalized_user,
            "X-Frappe-CSRF-Token": token,
            "X-Muster-CSRF-Proof": proof,
        },
        token,
    )
