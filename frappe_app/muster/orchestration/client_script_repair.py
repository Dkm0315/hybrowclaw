from __future__ import annotations

import difflib
import hmac
import json
import re
import secrets
from hashlib import sha256
from typing import Any

import frappe
from frappe import _

from muster.change_ir.security import permission_epoch
from muster.orchestration.form_schema import effective_form_schema


PREVIEW_TTL_SECONDS = 15 * 60
AUTHORIZATION_TTL_SECONDS = 5 * 60
RECEIPT_TTL_SECONDS = 24 * 60 * 60
MAX_SCRIPT_BYTES = 128_000
MAX_EXPLANATION_CHARS = 2_000
MAX_VERSION_SCAN = 50
MAX_CLIENT_SCRIPT_CANDIDATES = 50
PRIVILEGED_ROLES = {
    "System Manager",
    "Muster Administrator",
    "Muster Automation Manager",
}
_OPAQUE_ID = re.compile(r"^[A-Za-z0-9_-]{40,256}$")
_FORM_TARGET = re.compile(
    r"frappe\.ui\.form\.on\s*\(\s*['\"]([^'\"]{1,140})['\"]",
    re.MULTILINE,
)


class ClientScriptRepairError(frappe.ValidationError):
    pass


def _canonical(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        default=str,
        separators=(",", ":"),
        sort_keys=True,
    )


def _digest(value: str) -> str:
    return sha256(value.encode("utf-8")).hexdigest()


def _constant(left: Any, right: Any) -> bool:
    return (
        isinstance(left, str)
        and isinstance(right, str)
        and len(left) == len(right)
        and hmac.compare_digest(left, right)
    )


def _site() -> str:
    value = str(getattr(frappe.local, "site", "") or "").strip()
    if not value:
        raise ClientScriptRepairError(_("The current Frappe site is unavailable"))
    return value


def _actor() -> str:
    actor = str(frappe.session.user or "").strip()
    if not actor or actor.lower() == "guest":
        frappe.throw(_("Sign in before reviewing a customization repair"), frappe.PermissionError)
    if not bool(frappe.db.get_value("User", actor, "enabled")):
        frappe.throw(_("This user is not active"), frappe.PermissionError)
    roles = set(frappe.get_roles(actor))
    if actor != "Administrator" and not roles.intersection(PRIVILEGED_ROLES):
        frappe.throw(
            _("Client Script repair requires a privileged customization role"),
            frappe.PermissionError,
        )
    return actor


def _script(value: Any) -> str:
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        raise ClientScriptRepairError(_("The reviewed Client Script is invalid"))
    if len(value.encode("utf-8")) > MAX_SCRIPT_BYTES:
        raise ClientScriptRepairError(_("The reviewed Client Script is too large"))
    return value


def _explanation(value: Any) -> str:
    if value is None:
        return ""
    if not isinstance(value, str) or len(value) > MAX_EXPLANATION_CHARS:
        raise ClientScriptRepairError(_("The business explanation is invalid"))
    cleaned = " ".join(value.split())
    if any(ord(character) < 32 or ord(character) == 127 for character in cleaned):
        raise ClientScriptRepairError(_("The business explanation is invalid"))
    return cleaned


def _opaque(value: Any, label: str) -> str:
    if not isinstance(value, str) or not _OPAQUE_ID.fullmatch(value):
        raise ClientScriptRepairError(_("The {0} is invalid or expired").format(label))
    return value


def _cache_key(kind: str, identifier: str) -> str:
    return f"muster:client-script-repair:{kind}:{_digest(identifier)}"


def _store(kind: str, value: dict[str, Any], ttl: int) -> str:
    identifier = secrets.token_urlsafe(48)
    frappe.cache.set_value(
        _cache_key(kind, identifier),
        # Promotion from preview to authorization carries the prior envelope.
        # The new state discriminator must therefore be written last.
        _canonical({**value, "kind": kind}),
        expires_in_sec=ttl,
    )
    return identifier


def _load(kind: str, identifier: str, *, consume: bool = False) -> dict[str, Any]:
    identifier = _opaque(identifier, kind.replace("_", " "))
    key = _cache_key(kind, identifier)
    if consume:
        with frappe.cache.lock(f"{key}:lock", timeout=5, blocking_timeout=2):
            raw = frappe.cache.get_value(key)
            frappe.cache.delete_value(key)
    else:
        raw = frappe.cache.get_value(key)
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8")
    try:
        value = json.loads(raw) if isinstance(raw, str) else None
    except (TypeError, ValueError) as error:
        raise ClientScriptRepairError(
            _("The {0} is invalid or expired").format(kind.replace("_", " "))
        ) from error
    if not isinstance(value, dict) or value.get("kind") != kind:
        raise ClientScriptRepairError(
            _("The {0} is invalid or expired").format(kind.replace("_", " "))
        )
    return value


def _client_script(name: str, actor: str):
    if not isinstance(name, str) or not name.strip() or len(name) > 140:
        raise ClientScriptRepairError(_("A valid Client Script name is required"))
    doc = frappe.get_doc("Client Script", name.strip())
    if not doc.has_permission("read", user=actor) or not doc.has_permission("write", user=actor):
        frappe.throw(_("You cannot review and update this Client Script"), frappe.PermissionError)
    target = str(doc.dt or "").strip()
    if not target or not frappe.db.exists("DocType", target):
        raise ClientScriptRepairError(_("The Client Script target DocType is unavailable"))
    if not frappe.has_permission(target, "read", user=actor):
        frappe.throw(_("You cannot inspect the affected business form"), frappe.PermissionError)
    return doc


def _schema_evidence(target: str, actor: str) -> dict[str, Any]:
    snapshot = effective_form_schema(target, user=actor)
    fields = snapshot.get("fields") or []
    return {
        "doctype": target,
        "schema_hash": snapshot["schema_hash"],
        "revision": snapshot["revision"],
        "field_count": len(fields),
        "required_fields": [
            {"fieldname": row["fieldname"], "label": row["label"]}
            for row in fields
            if row.get("required")
        ][:100],
        "custom_field_count": sum(
            1 for row in fields if row.get("provenance", {}).get("source") == "custom_field"
        ),
        "property_setter_count": sum(
            len(row.get("provenance", {}).get("property_setters") or []) for row in fields
        ) + len(snapshot.get("doctype_property_setters") or []),
        "workflow": snapshot.get("workflow"),
    }


def _record_binding(doc) -> dict[str, Any]:
    script = str(doc.script or "")
    return {
        "name": str(doc.name),
        "target_doctype": str(doc.dt or ""),
        "view": str(doc.view or "Form"),
        "enabled": bool(doc.enabled),
        "modified": str(doc.modified or ""),
        "script_hash": _digest(script),
    }


def _assert_context(value: dict[str, Any], actor: str) -> None:
    if (
        not _constant(str(value.get("site") or ""), _site())
        or not _constant(str(value.get("actor") or ""), actor)
        or not _constant(
            str(value.get("permission_epoch") or ""), permission_epoch(actor)
        )
    ):
        frappe.throw(
            _("The site, user, or permissions changed after review; review the repair again"),
            frappe.PermissionError,
        )


def _assert_live_binding(value: dict[str, Any], actor: str):
    _assert_context(value, actor)
    doc = _client_script(str(value.get("client_script") or ""), actor)
    live = _record_binding(doc)
    expected = value.get("before")
    if not isinstance(expected, dict) or any(
        not _constant(str(expected.get(key) or ""), str(live.get(key) or ""))
        for key in ("name", "target_doctype", "view", "modified", "script_hash")
    ) or bool(expected.get("enabled")) != live["enabled"]:
        raise ClientScriptRepairError(
            _("The Client Script changed after review; prepare another repair preview")
        )
    schema = _schema_evidence(live["target_doctype"], actor)
    expected_schema = value.get("schema")
    if not isinstance(expected_schema, dict) or not _constant(
        str(expected_schema.get("schema_hash") or ""), schema["schema_hash"]
    ) or not _constant(str(expected_schema.get("revision") or ""), schema["revision"]):
        raise ClientScriptRepairError(
            _("The affected form customization changed after review; review the repair again")
        )
    return doc, live, schema


def _diff(before: str, after: str) -> str:
    return "".join(
        difflib.unified_diff(
            before.splitlines(keepends=True),
            after.splitlines(keepends=True),
            fromfile="current Client Script",
            tofile="reviewed Client Script",
            n=3,
        )
    )


def _business_explanation(
    target: str, view: str, before: str, after: str, reason: str
) -> dict[str, Any]:
    before_targets = sorted(set(_FORM_TARGET.findall(before)))
    after_targets = sorted(set(_FORM_TARGET.findall(after)))
    return {
        "summary": (
            f"This reviewed repair changes the browser behavior of the {target} {view.lower()} "
            "without changing its database schema. It takes effect for users only after the "
            "Client Script is saved and their form assets are refreshed."
        ),
        "reason": reason
        or "The existing browser behavior does not match the reviewed business flow.",
        "affected_form": target,
        "affected_view": view,
        "before_form_references": before_targets,
        "after_form_references": after_targets,
        "schema_change": False,
        "requires_browser_refresh": True,
    }


def diagnose(
    client_script: str,
    proposed_script: str,
    business_reason: str = "",
) -> dict[str, Any]:
    """Inspect live code and effective schema, then create an inert exact repair preview."""
    actor = _actor()
    doc = _client_script(client_script, actor)
    before_script = str(doc.script or "")
    after_script = _script(proposed_script)
    if _constant(_digest(before_script), _digest(after_script)):
        raise ClientScriptRepairError(_("The reviewed repair does not change the Client Script"))
    before = _record_binding(doc)
    schema = _schema_evidence(before["target_doctype"], actor)
    reason = _explanation(business_reason)
    explanation = _business_explanation(
        before["target_doctype"], before["view"], before_script, after_script, reason
    )
    stored = {
        "schema_version": 1,
        "site": _site(),
        "actor": actor,
        "permission_epoch": permission_epoch(actor),
        "client_script": doc.name,
        "before": before,
        "before_script": before_script,
        "after_script": after_script,
        "after_hash": _digest(after_script),
        "schema": schema,
        "business_explanation": explanation,
    }
    preview = _store("preview", stored, PREVIEW_TTL_SECONDS)
    return {
        "schema_version": 1,
        "preview": preview,
        "client_script": doc.name,
        "target_doctype": before["target_doctype"],
        "view": before["view"],
        "enabled": before["enabled"],
        "before_hash": before["script_hash"],
        "after_hash": stored["after_hash"],
        "before_script": before_script,
        "after_script": after_script,
        "diff": _diff(before_script, after_script),
        "schema": schema,
        "business_explanation": explanation,
        "executed": False,
        "approval_required": True,
    }


def authorize(
    preview: str,
    reviewed_before_hash: str,
    reviewed_after_hash: str,
) -> dict[str, Any]:
    """Consume one preview and mint a separate one-use apply capability."""
    actor = _actor()
    stored = _load("preview", preview, consume=True)
    if not _constant(reviewed_before_hash, str(stored.get("before", {}).get("script_hash") or "")):
        raise ClientScriptRepairError(_("The reviewed current-script hash does not match"))
    if not _constant(reviewed_after_hash, str(stored.get("after_hash") or "")):
        raise ClientScriptRepairError(_("The reviewed repaired-script hash does not match"))
    _assert_live_binding(stored, actor)
    token = secrets.token_urlsafe(32)
    authorization = _store(
        "apply_authorization",
        {**stored, "token_hash": _digest(token)},
        AUTHORIZATION_TTL_SECONDS,
    )
    return {
        "schema_version": 1,
        "authorization": authorization,
        "authorization_token": token,
        "client_script": stored["client_script"],
        "before_hash": stored["before"]["script_hash"],
        "after_hash": stored["after_hash"],
        "authorized": True,
        "executed": False,
        "one_use": True,
    }


def _consume_authorization(kind: str, authorization: str, token: str) -> dict[str, Any]:
    actor = _actor()
    stored = _load(kind, authorization, consume=True)
    if not isinstance(token, str) or not _constant(
        str(stored.get("token_hash") or ""), _digest(token)
    ):
        frappe.throw(_("The one-use repair authorization is invalid"), frappe.PermissionError)
    _assert_context(stored, actor)
    return stored


def _lock_name(name: str):
    key = f"muster:client-script-repair:document:{_digest(name)}"
    return frappe.cache.lock(key, timeout=120, blocking_timeout=10)


def _latest_version(name: str) -> str | None:
    if not frappe.db.exists("DocType", "Version"):
        return None
    return frappe.db.get_value(
        "Version",
        {"ref_doctype": "Client Script", "docname": name},
        "name",
        order_by="creation desc",
    )


def _version_script_transition(doc) -> tuple[str, str]:
    try:
        payload = json.loads(str(doc.data or ""))
    except (TypeError, ValueError) as error:
        raise ClientScriptRepairError(
            _("The selected Client Script Version evidence is unreadable")
        ) from error
    changed = payload.get("changed") if isinstance(payload, dict) else None
    if not isinstance(changed, list):
        raise ClientScriptRepairError(
            _("The selected Version does not record a Client Script source change")
        )
    for row in reversed(changed):
        if (
            isinstance(row, (list, tuple))
            and len(row) >= 3
            and str(row[0] or "").strip() == "script"
            and isinstance(row[1], str)
            and isinstance(row[2], str)
        ):
            return _script(row[1]), _script(row[2])
    raise ClientScriptRepairError(
        _("The selected Version does not record a Client Script source change")
    )


def _prior_version_source(client_script: str, version: str, actor: str) -> dict[str, str]:
    doc = _client_script(client_script, actor)
    meta = frappe.get_meta("Client Script")
    if not bool(getattr(meta, "track_changes", False)):
        raise ClientScriptRepairError(
            _("Client Script change tracking is disabled; no prior source can be proven")
        )
    if not frappe.db.exists("DocType", "Version"):
        raise ClientScriptRepairError(
            _("Frappe Version evidence is unavailable on this site")
        )
    if actor != "Administrator" and not frappe.has_permission("Version", "read", user=actor):
        frappe.throw(_("You cannot inspect Client Script Version evidence"), frappe.PermissionError)

    selected = str(version or "").strip()
    if selected:
        names = [selected]
    else:
        names = frappe.get_list(
            "Version",
            filters={"ref_doctype": "Client Script", "docname": doc.name},
            fields=["name"],
            order_by="creation desc",
            limit_page_length=MAX_VERSION_SCAN,
            pluck="name",
        )
    if not names:
        raise ClientScriptRepairError(
            _("No Client Script Version evidence is available for this customization")
        )

    live_script = str(doc.script or "")
    live_hash = _digest(live_script)
    mismatch_seen = False
    for name in names:
        evidence = frappe.get_doc("Version", name)
        if (
            str(evidence.ref_doctype or "") != "Client Script"
            or str(evidence.docname or "") != str(doc.name)
        ):
            if selected:
                raise ClientScriptRepairError(
                    _("The selected Version does not belong to this Client Script")
                )
            continue
        if actor != "Administrator" and not evidence.has_permission("read", user=actor):
            frappe.throw(_("You cannot inspect this Client Script Version"), frappe.PermissionError)
        try:
            prior_script, version_current_script = _version_script_transition(evidence)
        except ClientScriptRepairError:
            if selected:
                raise
            continue
        if not _constant(_digest(version_current_script), live_hash):
            mismatch_seen = True
            if selected:
                raise ClientScriptRepairError(
                    _("The selected Version no longer matches the live Client Script")
                )
            continue
        if _constant(_digest(prior_script), live_hash):
            continue
        return {
            "version": str(evidence.name),
            "prior_script": prior_script,
            "prior_hash": _digest(prior_script),
            "version_current_hash": _digest(version_current_script),
            "live_hash": live_hash,
        }
    if mismatch_seen:
        raise ClientScriptRepairError(
            _("Client Script Version history exists, but none proves the current live source")
        )
    raise ClientScriptRepairError(
        _("No prior Client Script source transition is available for safe restoration")
    )


def diagnose_previous_version(
    client_script: str,
    business_reason: str = "",
    version: str = "",
) -> dict[str, Any]:
    """Diagnose an exact restoration to a prior Frappe Version without generated code."""
    actor = _actor()
    source = _prior_version_source(client_script, version, actor)
    result = diagnose(client_script, source["prior_script"], business_reason)
    if result["before_hash"] != source["live_hash"] or result["after_hash"] != source["prior_hash"]:
        raise ClientScriptRepairError(
            _("The live Client Script changed while its prior Version was being prepared")
        )
    return {
        **result,
        "launch_receipt": {
            "schema_version": 1,
            "source": "Frappe Version",
            "version": source["version"],
            "client_script": result["client_script"],
            "live_hash": source["live_hash"],
            "proposed_hash": source["prior_hash"],
            "version_current_hash": source["version_current_hash"],
            "current_source_verified": True,
            "generated_source": False,
        },
    }


def resolve_previous_version_candidate(
    target_doctype: str,
    user: str | None = None,
    reported_text: str = "",
) -> dict[str, Any] | None:
    """Resolve one permission-filtered, Version-backed Client Script for a live form.

    Ambiguous matches deliberately return no candidate. The caller must never
    guess which customization a vague business report refers to.
    """
    actor = _actor()
    requested_user = str(user or actor).strip()
    if not _constant(requested_user, actor):
        frappe.throw(
            _("Customization diagnosis must use the current Frappe identity"),
            frappe.PermissionError,
        )
    target = str(target_doctype or "").strip()
    if not target or len(target) > 140 or not frappe.db.exists("DocType", target):
        return None
    if not frappe.has_permission(target, "read", user=actor):
        return None
    rows = frappe.get_list(
        "Client Script",
        filters={"dt": target, "view": "Form"},
        order_by="modified desc",
        limit_page_length=MAX_CLIENT_SCRIPT_CANDIDATES,
        pluck="name",
    )
    report_tokens = {
        token for token in re.findall(r"[a-z0-9]+", str(reported_text).casefold())
        if len(token) >= 4 and token not in {
            "this", "that", "what", "when", "where", "which", "please",
            "check", "already", "saving", "approved",
        }
    }
    matches: list[dict[str, Any]] = []
    for name in rows:
        try:
            source = _prior_version_source(str(name), "", actor)
        except (ClientScriptRepairError, frappe.PermissionError):
            continue
        live_script = str(_client_script(str(name), actor).script or "")
        script_tokens = set(re.findall(r"[a-z0-9]+", live_script.casefold()))
        matches.append({
            "schema_version": 1,
            "client_script": str(name),
            "target_doctype": target,
            "version": source["version"],
            "live_hash": source["live_hash"],
            "proposed_hash": source["prior_hash"],
            "source": "Frappe Version",
            "current_source_verified": True,
            "generated_source": False,
            "_report_score": len(report_tokens & script_tokens),
        })
    if len(matches) == 1:
        return {key: value for key, value in matches[0].items() if key != "_report_score"}
    if not matches or not report_tokens:
        return None
    ranked = sorted(matches, key=lambda row: row["_report_score"], reverse=True)
    if ranked[0]["_report_score"] < 2 or ranked[0]["_report_score"] == ranked[1]["_report_score"]:
        return None
    return {key: value for key, value in ranked[0].items() if key != "_report_score"}


def apply(authorization: str, authorization_token: str) -> dict[str, Any]:
    """Apply the exact reviewed source, reread it, and return restoration evidence."""
    actor = _actor()
    stored = _consume_authorization(
        "apply_authorization", authorization, authorization_token
    )
    with _lock_name(stored["client_script"]):
        doc, live_before, live_schema = _assert_live_binding(stored, actor)
        doc.script = stored["after_script"]
        doc.save()
        observed = _client_script(doc.name, actor)
        observed_hash = _digest(str(observed.script or ""))
        if not _constant(observed_hash, stored["after_hash"]):
            frappe.db.rollback()
            raise ClientScriptRepairError(
                _(
                    "The Client Script could not be verified after saving; "
                    "the transaction was rolled back"
                )
            )
        applied = _record_binding(observed)
        evidence = {
            "schema_version": 1,
            "site": stored["site"],
            "actor": actor,
            "client_script": stored["client_script"],
            "target_doctype": applied["target_doctype"],
            "before_hash": live_before["script_hash"],
            "reviewed_after_hash": stored["after_hash"],
            "observed_after_hash": observed_hash,
            "before_revision": live_before["modified"],
            "applied_revision": applied["modified"],
            "schema_hash": live_schema["schema_hash"],
            "version_record": _latest_version(observed.name),
            "verified": True,
        }
        receipt_hash = _digest(_canonical(evidence))
        receipt = _store(
            "receipt",
            {
                **stored,
                "token_hash": None,
                "applied": applied,
                "evidence": evidence,
                "receipt_hash": receipt_hash,
            },
            RECEIPT_TTL_SECONDS,
        )
    return {
        **evidence,
        "receipt": receipt,
        "receipt_hash": receipt_hash,
        "executed": True,
        "restoration": {
            "available": True,
            "action": "prepare_rollback",
            "receipt": receipt,
            "current_hash": observed_hash,
            "restore_hash": live_before["script_hash"],
        },
    }


def prepare_rollback(receipt: str) -> dict[str, Any]:
    """Create an inert rollback preview from a verified repair receipt."""
    actor = _actor()
    applied = _load("receipt", receipt)
    _assert_context(applied, actor)
    doc = _client_script(applied["client_script"], actor)
    current = _record_binding(doc)
    expected = applied.get("applied") or {}
    if not _constant(current["script_hash"], str(expected.get("script_hash") or "")):
        raise ClientScriptRepairError(
            _("The Client Script changed after repair; automatic rollback is unsafe")
        )
    schema = _schema_evidence(current["target_doctype"], actor)
    rollback_state = {
        "schema_version": 1,
        "site": applied["site"],
        "actor": actor,
        "permission_epoch": permission_epoch(actor),
        "receipt": receipt,
        "client_script": applied["client_script"],
        "before": current,
        "before_script": applied["after_script"],
        "after_script": applied["before_script"],
        "after_hash": applied["before"]["script_hash"],
        "schema": schema,
    }
    preview = _store("rollback_preview", rollback_state, PREVIEW_TTL_SECONDS)
    return {
        "schema_version": 1,
        "rollback_preview": preview,
        "client_script": applied["client_script"],
        "current_hash": current["script_hash"],
        "restore_hash": rollback_state["after_hash"],
        "current_script": rollback_state["before_script"],
        "restore_script": rollback_state["after_script"],
        "diff": _diff(rollback_state["before_script"], rollback_state["after_script"]),
        "executed": False,
        "approval_required": True,
    }


def authorize_rollback(
    rollback_preview: str,
    reviewed_current_hash: str,
    reviewed_restore_hash: str,
) -> dict[str, Any]:
    actor = _actor()
    stored = _load("rollback_preview", rollback_preview, consume=True)
    if not _constant(reviewed_current_hash, stored["before"]["script_hash"]):
        raise ClientScriptRepairError(_("The reviewed current-script hash does not match"))
    if not _constant(reviewed_restore_hash, stored["after_hash"]):
        raise ClientScriptRepairError(_("The reviewed restoration hash does not match"))
    _assert_live_binding(stored, actor)
    token = secrets.token_urlsafe(32)
    authorization = _store(
        "rollback_authorization",
        {**stored, "token_hash": _digest(token)},
        AUTHORIZATION_TTL_SECONDS,
    )
    return {
        "schema_version": 1,
        "authorization": authorization,
        "authorization_token": token,
        "client_script": stored["client_script"],
        "current_hash": stored["before"]["script_hash"],
        "restore_hash": stored["after_hash"],
        "authorized": True,
        "executed": False,
        "one_use": True,
    }


def rollback(authorization: str, authorization_token: str) -> dict[str, Any]:
    """Restore the exact pre-repair script and independently verify the result."""
    actor = _actor()
    stored = _consume_authorization(
        "rollback_authorization", authorization, authorization_token
    )
    with _lock_name(stored["client_script"]):
        doc, live_before, live_schema = _assert_live_binding(stored, actor)
        doc.script = stored["after_script"]
        doc.save()
        observed = _client_script(doc.name, actor)
        observed_hash = _digest(str(observed.script or ""))
        if not _constant(observed_hash, stored["after_hash"]):
            frappe.db.rollback()
            raise ClientScriptRepairError(
                _(
                    "The restored Client Script could not be verified; "
                    "the transaction was rolled back"
                )
            )
        restored = _record_binding(observed)
        evidence = {
            "schema_version": 1,
            "site": stored["site"],
            "actor": actor,
            "client_script": stored["client_script"],
            "target_doctype": restored["target_doctype"],
            "repaired_hash": live_before["script_hash"],
            "reviewed_restore_hash": stored["after_hash"],
            "observed_restore_hash": observed_hash,
            "repaired_revision": live_before["modified"],
            "restored_revision": restored["modified"],
            "schema_hash": live_schema["schema_hash"],
            "version_record": _latest_version(observed.name),
            "verified": True,
            "restored": True,
        }
        receipt_hash = _digest(_canonical(evidence))
        rollback_receipt = _store(
            "rollback_receipt",
            {"evidence": evidence, "receipt_hash": receipt_hash},
            RECEIPT_TTL_SECONDS,
        )
    return {
        **evidence,
        "rollback_receipt": rollback_receipt,
        "receipt_hash": receipt_hash,
        "executed": True,
    }
