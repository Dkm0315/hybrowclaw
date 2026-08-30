from __future__ import annotations

from typing import Any

import frappe
from frappe import _
from frappe.utils import cint

from muster.orchestration import client_script_repair


def _require_post() -> None:
    if frappe.request and frappe.request.method != "POST":
        frappe.throw(_("This endpoint only accepts POST requests"), frappe.PermissionError)


def _confirmed(value: int | str, action: str) -> None:
    if not cint(value):
        frappe.throw(
            _("Explicit confirmation is required to {0}").format(action),
            frappe.ValidationError,
        )


@frappe.whitelist(methods=["POST"])
def diagnose_client_script(
    client_script: str,
    proposed_script: str,
    business_reason: str = "",
) -> dict[str, Any]:
    """Create an inert repair preview from live code and effective form metadata."""
    _require_post()
    return client_script_repair.diagnose(client_script, proposed_script, business_reason)


@frappe.whitelist(methods=["POST"])
def diagnose_previous_client_script_version(
    client_script: str,
    business_reason: str = "",
    version: str = "",
) -> dict[str, Any]:
    """Prepare an exact repair from proven Frappe Version history, never generated source."""
    _require_post()
    return client_script_repair.diagnose_previous_version(
        client_script, business_reason, version
    )


@frappe.whitelist(methods=["POST"])
def authorize_client_script_repair(
    preview: str,
    reviewed_before_hash: str,
    reviewed_after_hash: str,
    confirmed: int | str = 0,
) -> dict[str, Any]:
    """Issue one short-lived, one-use apply capability for the exact reviewed hashes."""
    _require_post()
    _confirmed(confirmed, "authorize this exact Client Script repair")
    return client_script_repair.authorize(
        preview, reviewed_before_hash, reviewed_after_hash
    )


@frappe.whitelist(methods=["POST"])
def apply_client_script_repair(
    authorization: str,
    authorization_token: str,
    confirmed: int | str = 0,
) -> dict[str, Any]:
    """Consume one authorization, apply the exact script, and reread-verify it."""
    _require_post()
    _confirmed(confirmed, "apply this exact Client Script repair")
    return client_script_repair.apply(authorization, authorization_token)


@frappe.whitelist(methods=["POST"])
def prepare_client_script_rollback(receipt: str) -> dict[str, Any]:
    """Return an inert restoration preview only while the repaired script is unchanged."""
    _require_post()
    return client_script_repair.prepare_rollback(receipt)


@frappe.whitelist(methods=["POST"])
def authorize_client_script_rollback(
    rollback_preview: str,
    reviewed_current_hash: str,
    reviewed_restore_hash: str,
    confirmed: int | str = 0,
) -> dict[str, Any]:
    """Issue one short-lived, one-use rollback capability for the reviewed hashes."""
    _require_post()
    _confirmed(confirmed, "authorize this exact Client Script restoration")
    return client_script_repair.authorize_rollback(
        rollback_preview, reviewed_current_hash, reviewed_restore_hash
    )


@frappe.whitelist(methods=["POST"])
def rollback_client_script_repair(
    authorization: str,
    authorization_token: str,
    confirmed: int | str = 0,
) -> dict[str, Any]:
    """Consume one rollback authorization, restore the original script, and verify it."""
    _require_post()
    _confirmed(confirmed, "restore this exact Client Script version")
    return client_script_repair.rollback(authorization, authorization_token)
