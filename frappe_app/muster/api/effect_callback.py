from __future__ import annotations

import hashlib
import hmac
import json
import re
import time
from contextlib import contextmanager
from typing import Any, Iterator

import frappe
from frappe import _
from frappe.utils import get_datetime, now_datetime

from muster.adapters.client import normalized_https_origin
from muster.adapters.identity import frappe_identity
from muster.change_ir.executor import _effect, _verify, preflight
from muster.change_ir.schema import ChangeOperation, ChangeSet
from muster.change_ir.security import schema_revision

MAX_BODY_BYTES = 1_048_576
MAX_CLOCK_SKEW_SECONDS = 300
NONCE_TTL_SECONDS = 600
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$")
HASH = re.compile(r"^(?:sha256:)?[a-f0-9]{64}$", re.I)
BASE_KEYS = {
    "schema_version", "phase", "binding_id", "tenant_id", "site_id", "site_origin",
    "mission_id", "root_run_id", "node_id", "actor",
}
PHASE_KEYS = {
    "resolve": {"authority", "operation"},
    "plan": {"plan"},
    "apply": {"plan", "proposal", "fencing_token"},
    "observe": {"plan", "application"},
    "compensate": {"plan", "application", "fencing_token"},
}
CAPABILITIES = {
    "frappe.record.create": ("record", "create"),
    "frappe.record.update": ("record", "update"),
    "frappe.record.submit": ("record", "submit"),
    "frappe.record.apply_workflow": ("record", "apply_workflow"),
    "frappe.record.delete": ("record", "delete"),
    "frappe.metadata.custom_field.create": ("native_artifact", "custom_field"),
    "frappe.metadata.property_setter.create": ("native_artifact", "property_setter"),
    "frappe.metadata.doctype.create": ("native_artifact", "doctype"),
    "frappe.metadata.page.create": ("native_artifact", "page"),
    "frappe.metadata.workspace.create": ("native_artifact", "workspace"),
    "frappe.metadata.report.create": ("native_artifact", "report"),
    "frappe.metadata.script_report.create": ("native_artifact", "script_report"),
    "frappe.metadata.print_format.create": ("native_artifact", "print_format"),
    "frappe.metadata.web_page.create": ("native_artifact", "web_page"),
    "frappe.metadata.web_form.create": ("native_artifact", "web_form"),
    "frappe.automation.notification.create": ("native_artifact", "notification"),
    "frappe.automation.assignment_rule.create": ("native_artifact", "assignment_rule"),
}


class MusterEffectCallbackError(frappe.PermissionError):
    pass


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def _hash(value: Any) -> str:
    return hashlib.sha256(_canonical(value).encode()).hexdigest()


def _exact(value: Any, keys: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise MusterEffectCallbackError(_("{0} has unknown or missing fields").format(label))
    return value


def _safe_id(value: Any, label: str) -> str:
    if not isinstance(value, str) or not SAFE_ID.fullmatch(value):
        raise MusterEffectCallbackError(_("{0} is invalid").format(label))
    return value


def _safe_label(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 140 or any(ord(character) < 32 for character in value):
        raise MusterEffectCallbackError(_("{0} is invalid").format(label))
    return value


def _raw_request() -> tuple[dict[str, Any], bytes]:
    if not frappe.request or frappe.request.method != "POST":
        raise MusterEffectCallbackError(_("The effect callback accepts POST only"))
    raw = frappe.request.get_data(cache=True) or b""
    if not raw or len(raw) > MAX_BODY_BYTES:
        raise MusterEffectCallbackError(_("The effect callback body is invalid"))
    try:
        body = json.loads(raw)
    except (TypeError, ValueError) as error:
        raise MusterEffectCallbackError(_("The effect callback body is invalid")) from error
    return _exact(body, {"envelope"}, "callback body"), raw


def _trusted_binding(envelope: dict[str, Any]):
    settings = frappe.get_single("Muster Settings")
    if not settings.enabled or settings.binding_status != "Trusted" or not settings.site_binding:
        raise MusterEffectCallbackError(_("Muster site trust is not active"))
    binding = frappe.get_doc("Muster Site Binding", settings.site_binding)
    if binding.status != "Trusted" or binding.revoked_at or not binding.trust_fingerprint:
        raise MusterEffectCallbackError(_("Muster site trust is revoked or incomplete"))
    expected = {
        "binding_id": (binding.gateway_binding_id or "").strip(),
        "tenant_id": (binding.gateway_tenant or "").strip(),
        "site_id": (binding.site_uuid or "").strip(),
        "site_origin": normalized_https_origin(binding.site_origin, "Public Site Origin"),
    }
    for key, value in expected.items():
        supplied = envelope.get(key)
        if not isinstance(supplied, str) or not hmac.compare_digest(supplied, value):
            raise MusterEffectCallbackError(_("The effect callback binding does not match this site"))
    return settings, binding


def _authenticate(raw: bytes, settings) -> None:
    bearer = settings.get_password("gateway_bearer_token", raise_exception=False) or ""
    authorization = frappe.get_request_header("Authorization") or ""
    if not bearer or not authorization.startswith("Bearer ") or not hmac.compare_digest(authorization[7:], bearer):
        raise MusterEffectCallbackError(_("The effect callback bearer is invalid"))
    timestamp = frappe.get_request_header("X-Muster-Timestamp") or ""
    nonce = frappe.get_request_header("X-Muster-Nonce") or ""
    signature = frappe.get_request_header("X-Muster-Signature") or ""
    if not timestamp.isdigit() or abs(int(time.time()) - int(timestamp)) > MAX_CLOCK_SKEW_SECONDS:
        raise MusterEffectCallbackError(_("The effect callback timestamp is stale"))
    if len(nonce) < 24 or not SAFE_ID.fullmatch(nonce):
        raise MusterEffectCallbackError(_("The effect callback nonce is invalid"))
    secret = settings.get_password("run_event_hmac_secret", raise_exception=False) or ""
    if not secret:
        raise MusterEffectCallbackError(_("The effect callback signing secret is not configured"))
    digest = hashlib.sha256(raw).hexdigest()
    expected = hmac.new(secret.encode(), f"{timestamp}\n{nonce}\n{digest}".encode(), hashlib.sha256).hexdigest()
    if not signature.startswith("sha256=") or not hmac.compare_digest(signature[7:], expected):
        raise MusterEffectCallbackError(_("The effect callback signature is invalid"))
    key = f"muster:effect-callback:nonce:{hashlib.sha256(nonce.encode()).hexdigest()}"
    with frappe.cache.lock(f"{key}:lock", timeout=5, blocking_timeout=2):
        if frappe.cache.get_value(key):
            raise MusterEffectCallbackError(_("The effect callback nonce was already used"))
        frappe.cache.set_value(key, "1", expires_in_sec=NONCE_TTL_SECONDS)


def _execution(envelope: dict[str, Any]) -> tuple[Any, str]:
    mission_id = _safe_id(envelope.get("mission_id"), "mission_id")
    root_run_id = _safe_id(envelope.get("root_run_id"), "root_run_id")
    node_id = _safe_id(envelope.get("node_id"), "node_id")
    actor_input = _safe_id(envelope.get("actor"), "actor").lower()
    if not frappe.db.exists("Muster Mission", mission_id):
        raise MusterEffectCallbackError(_("The effect mission does not exist"))
    mission = frappe.get_doc("Muster Mission", mission_id)
    actor = frappe.db.get_value("User", {"name": actor_input}, "name") or actor_input
    if mission.requested_by.lower() != actor_input or not frappe.db.get_value("User", actor, "enabled"):
        raise MusterEffectCallbackError(_("The effect actor does not match the enabled mission principal"))
    if not mission.root_run_id or not hmac.compare_digest(mission.root_run_id, root_run_id):
        raise MusterEffectCallbackError(_("The effect root run does not match the mission"))
    version = mission.workflow_version or frappe.db.get_value("Muster Workflow", mission.workflow, "published_version")
    graph_json = frappe.db.get_value("Muster Workflow Version", version, "graph_json") if version else None
    try:
        graph = json.loads(graph_json or "{}")
    except (TypeError, ValueError) as error:
        raise MusterEffectCallbackError(_("The published mission workflow is invalid")) from error
    if node_id not in {row.get("id") for row in graph.get("nodes", []) if isinstance(row, dict)}:
        raise MusterEffectCallbackError(_("The effect node is not in the published mission workflow"))
    return mission, actor


def _data_revision(operation: dict[str, Any]) -> str:
    if operation.get("kind") != "record":
        return schema_revision()
    doctype, name = operation.get("doctype"), operation.get("docname")
    modified = frappe.db.get_value(doctype, name, "modified") if isinstance(doctype, str) and isinstance(name, str) else None
    return _hash({"doctype": doctype, "name": name, "modified": str(modified or ""), "exists": bool(modified)})


def _live_authority(authority: dict[str, Any], operation: dict[str, Any], actor: str) -> dict[str, Any]:
    identity = frappe_identity(actor)
    return {
        "tenantId": authority["tenantId"], "siteId": authority["siteId"],
        "siteOrigin": authority["siteOrigin"], "userId": actor.lower(),
        "permissionEpoch": identity["permissionHash"], "rolesHash": identity["rolesHash"],
        "schemaRevision": schema_revision(), "dataRevision": _data_revision(operation),
    }


def _authority(value: Any) -> dict[str, Any]:
    required = {"tenantId", "siteId", "siteOrigin", "userId", "permissionEpoch", "schemaRevision", "dataRevision"}
    if not isinstance(value, dict) or not required.issubset(value) or set(value) - (required | {"rolesHash"}):
        raise MusterEffectCallbackError(_("The effect authority is invalid"))
    for key in required - {"siteOrigin"}:
        _safe_id(value.get(key), f"authority.{key}")
    if "rolesHash" in value and not HASH.fullmatch(str(value["rolesHash"])):
        raise MusterEffectCallbackError(_("The effect authority roles hash is invalid"))
    if normalized_https_origin(value["siteOrigin"], "Authority Site Origin") != value["siteOrigin"]:
        raise MusterEffectCallbackError(_("The effect authority site origin is invalid"))
    return value


def _operation(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise MusterEffectCallbackError(_("The effect operation is invalid"))
    if value.get("kind") == "record":
        required = {"kind", "action", "doctype", "values"}
        optional = {"docname", "expectedModified", "workflowAction"}
        if not required.issubset(value) or set(value) - (required | optional):
            raise MusterEffectCallbackError(_("The record operation has unknown or missing fields"))
        _safe_label(value.get("doctype"), "record doctype")
        if not isinstance(value.get("values"), dict):
            raise MusterEffectCallbackError(_("Record values must be an object"))
        action = value.get("action")
        if action not in {"create", "update", "submit", "apply_workflow", "delete"}:
            raise MusterEffectCallbackError(_("The record operation is unsupported"))
        if action != "create" and not isinstance(value.get("docname"), str):
            raise MusterEffectCallbackError(_("Existing-record operations require a document name"))
        if action != "create" and not isinstance(value.get("expectedModified"), str):
            raise MusterEffectCallbackError(_("Existing-record operations require a live concurrency token"))
        if action == "apply_workflow" and not isinstance(value.get("workflowAction"), str):
            raise MusterEffectCallbackError(_("Workflow operations require a fixed action"))
        return value
    if value.get("kind") == "native_artifact":
        _exact(value, {"kind", "artifactType", "intent"}, "native artifact operation")
        if value.get("artifactType") not in {
            "custom_field", "property_setter", "doctype", "page", "workspace", "report",
            "script_report", "print_format", "web_page", "web_form", "notification",
            "assignment_rule",
        } or not isinstance(value.get("intent"), dict):
            raise MusterEffectCallbackError(_("The native artifact operation is unsupported"))
        return value
    raise MusterEffectCallbackError(_("The effect operation kind is unsupported"))


def _parse_plan(value: Any) -> dict[str, Any]:
    keys = {"schemaVersion", "capability", "authority", "operation", "idempotencyKey", "postconditions", "approval", "planHash"}
    plan = _exact(value, keys, "effect plan")
    if plan["schemaVersion"] != 1 or plan.get("capability") not in CAPABILITIES or not HASH.fullmatch(str(plan.get("planHash") or "")):
        raise MusterEffectCallbackError(_("The effect plan is unsupported"))
    authority = _authority(plan.get("authority"))
    operation = _operation(plan.get("operation"))
    _safe_id(plan.get("idempotencyKey"), "effect idempotency key")
    if not isinstance(plan.get("postconditions"), list) or not 1 <= len(plan["postconditions"]) <= 32:
        raise MusterEffectCallbackError(_("The effect postconditions are invalid"))
    for condition in plan["postconditions"]:
        if not isinstance(condition, dict) or not {"path", "operator"}.issubset(condition) or set(condition) - {"path", "operator", "expected"} or condition.get("operator") not in {"equals", "exists", "absent"}:
            raise MusterEffectCallbackError(_("An effect postcondition is invalid"))
    approval = plan.get("approval")
    approval_keys = {"receiptId", "planHash", "actor", "approvers", "approvedAt", "expiresAt", "scope", "approvalClass", "proof"}
    if not isinstance(approval, dict) or set(approval) != approval_keys or not isinstance(approval.get("proof"), dict):
        raise MusterEffectCallbackError(_("The effect approval structure is invalid"))
    if approval.get("approvalClass") not in {"single", "dual_control"} or not isinstance(approval.get("approvers"), list) or not approval["approvers"] or not isinstance(approval.get("scope"), list) or not approval["scope"]:
        raise MusterEffectCallbackError(_("The effect approval authority is invalid"))
    if not all(isinstance(item, str) and SAFE_ID.fullmatch(item) for item in [*approval["approvers"], *approval["scope"]]):
        raise MusterEffectCallbackError(_("The effect approval principals or scope are invalid"))
    if not isinstance(approval.get("approvedAt"), str) or not isinstance(approval.get("expiresAt"), str):
        raise MusterEffectCallbackError(_("The effect approval timestamps are invalid"))
    expected_proof = set() if operation["kind"] == "record" else {"changeSet"}
    if set(approval["proof"]) != expected_proof:
        raise MusterEffectCallbackError(_("The effect approval proof contains an unsupported selector"))
    discriminator = operation.get("action") if operation.get("kind") == "record" else operation.get("artifactType")
    if (operation.get("kind"), discriminator) != CAPABILITIES[plan["capability"]]:
        raise MusterEffectCallbackError(_("The capability does not match the typed operation"))
    plan["authority"], plan["operation"] = authority, operation
    intent = {key: plan[key] for key in ("schemaVersion", "capability", "authority", "operation", "idempotencyKey", "postconditions")}
    if not hmac.compare_digest(plan["planHash"].removeprefix("sha256:"), _hash(intent)):
        raise MusterEffectCallbackError(_("The effect plan hash has drifted"))
    return plan


def _proposal(value: Any, plan: dict[str, Any]) -> dict[str, Any]:
    proposal = _exact(value, {"planHash", "authority", "summary", "approvalBindingHash"}, "effect proposal")
    if proposal["planHash"] != plan["planHash"] or _hash(proposal["authority"]) != _hash(plan["authority"]) or proposal["approvalBindingHash"] != _hash(plan["approval"]):
        raise MusterEffectCallbackError(_("The effect proposal is bound to another plan, authority, or approval"))
    if not isinstance(proposal["summary"], str) or not proposal["summary"]:
        raise MusterEffectCallbackError(_("The effect proposal summary is invalid"))
    return proposal


def _application(value: Any) -> dict[str, Any]:
    keys = {"receiptId", "resultRef", "evidenceIds", "receiptSignature", "executionSurface"}
    application = _exact(value, keys, "effect application")
    if application.get("executionSurface") != "server_side" or not isinstance(application.get("resultRef"), dict) or not isinstance(application.get("evidenceIds"), list):
        raise MusterEffectCallbackError(_("The effect application receipt is invalid"))
    _safe_id(application.get("receiptId"), "effect receipt")
    if not HASH.fullmatch(str(application.get("receiptSignature") or "")):
        raise MusterEffectCallbackError(_("The effect receipt signature is invalid"))
    return application


def _approval(plan: dict[str, Any], mission, actor: str):
    value = plan.get("approval")
    if not isinstance(value, dict) or value.get("planHash") != plan["planHash"] or str(value.get("actor", "")).lower() != actor.lower():
        raise MusterEffectCallbackError(_("The approval is not bound to this plan and actor"))
    if plan["capability"] not in value.get("scope", []):
        raise MusterEffectCallbackError(_("The approval scope does not include this capability"))
    receipt_id = _safe_id(value.get("receiptId"), "approval receipt")
    if not frappe.db.exists("Muster Approval", receipt_id):
        raise MusterEffectCallbackError(_("The approval receipt does not exist"))
    receipt = frappe.get_doc("Muster Approval", receipt_id)
    expected_class = (
        frappe.db.get_value("Muster Change Set", value.get("proof", {}).get("changeSet"), "approval_class")
        if plan["operation"]["kind"] == "native_artifact"
        else ("Sensitive" if value.get("approvalClass") == "dual_control" else "Standard")
    )
    if (receipt.status != "Approved" or receipt.mission != mission.name
            or receipt.requested_by.lower() != actor.lower()
            or receipt.approval_class != expected_class
            or receipt.action_hash != plan["planHash"]):
        raise MusterEffectCallbackError(_("The approval receipt does not match the effect"))
    if (not receipt.decided_by or receipt.decided_by != receipt.requested_from
            or receipt.decided_by == receipt.requested_by or not receipt.decided_at
            or get_datetime(receipt.decided_at) > now_datetime() or not receipt.expires_at
            or get_datetime(receipt.expires_at) <= now_datetime()):
        raise MusterEffectCallbackError(_("The approval receipt is not current and independent"))
    if receipt.decided_by.lower() not in {str(item).lower() for item in value.get("approvers", [])}:
        raise MusterEffectCallbackError(_("The approving principal does not match the signed receipt"))
    if get_datetime(value.get("approvedAt")) != get_datetime(receipt.decided_at) or get_datetime(value.get("expiresAt")) != get_datetime(receipt.expires_at):
        raise MusterEffectCallbackError(_("The approval timestamps do not match the Frappe receipt"))
    if not set(frappe.get_roles(receipt.decided_by)).intersection({"Muster Approver", "Muster Administrator", "System Manager"}):
        raise MusterEffectCallbackError(_("The approver no longer has approval authority"))
    return receipt


@contextmanager
def _as_user(user: str) -> Iterator[None]:
    previous = frappe.session.user
    frappe.set_user(user)
    try:
        yield
    finally:
        frappe.set_user(previous)


def _record_change(plan: dict[str, Any], actor: str) -> tuple[ChangeSet, ChangeOperation]:
    operation = plan["operation"]
    kinds = {"create": "create_record", "update": "update_record", "submit": "submit_record", "apply_workflow": "apply_workflow", "delete": "delete_record"}
    if operation["action"] not in kinds:
        raise MusterEffectCallbackError(_("This record operation has no fixed Change IR executor"))
    item = ChangeOperation.from_dict({
        "operation_id": f"effect-{plan['idempotencyKey']}", "kind": kinds[operation["action"]],
        "target_doctype": operation["doctype"], "target_name": operation.get("docname"),
        "values": ({**(operation.get("values") or {}), **({"workflow_action": operation["workflowAction"]} if operation["action"] == "apply_workflow" else {})}), "idempotency_key": plan["idempotencyKey"],
        "concurrency_token": operation.get("expectedModified"), "approval_class": "Standard",
    })
    return ChangeSet("1.0", frappe.local.site, actor, plan["authority"]["permissionEpoch"], (item,)), item


def _observe(plan: dict[str, Any], application: dict[str, Any]) -> dict[str, Any]:
    operation = plan["operation"]
    if operation["kind"] != "record":
        change_set = (plan["approval"].get("proof") or {}).get("changeSet")
        if not isinstance(change_set, str):
            raise MusterEffectCallbackError(_("Native artifact observation requires its persisted Change Set"))
        from muster.api.native_builder import observe_gateway_bound
        return observe_gateway_bound(change_set, operation["intent"], actor=plan["authority"]["userId"])
    name = operation.get("docname") or (application.get("resultRef") or {}).get("name")
    if operation["action"] == "delete":
        return {"deleted": not frappe.db.exists(operation["doctype"], name)}
    if not isinstance(name, str) or not frappe.db.exists(operation["doctype"], name):
        raise MusterEffectCallbackError(_("The effected record is missing during independent reread"))
    return frappe.get_doc(operation["doctype"], name).as_dict(no_nulls=False)


def _effect_scope(plan: dict[str, Any], actor: str) -> str:
    return _hash({"tenant": plan["authority"]["tenantId"], "site": plan["authority"]["siteId"], "actor": actor.lower(), "idempotency": plan["idempotencyKey"]})


def _apply_once(plan: dict[str, Any], mission, actor: str, fencing: int, settings) -> dict[str, Any]:
    scope = _effect_scope(plan, actor)
    ledger_key = f"muster-effect:{scope}"
    with frappe.cache.lock(f"muster:effect:claim:{scope}", timeout=60, blocking_timeout=10):
        existing = frappe.db.get_value("Muster Activity", {"idempotency_key": ledger_key}, ["name", "payload_json"], as_dict=True)
        if existing:
            try:
                stored = json.loads(existing.payload_json)
            except (TypeError, ValueError) as error:
                raise MusterEffectCallbackError(_("The durable effect receipt is invalid")) from error
            if stored.get("plan_hash") != plan["planHash"] or stored.get("approval") != plan["approval"]["receiptId"]:
                raise MusterEffectCallbackError(_("The idempotency key is bound to another plan or approval"))
            if int(stored.get("fencing_token") or 0) > fencing:
                raise MusterEffectCallbackError(_("A stale fencing token cannot replay this effect"))
            return stored["application"]
        if plan["operation"]["kind"] == "record":
            change_set, item = _record_change(plan, actor)
            with _as_user(actor):
                preflight(change_set)
                receipt, inverse = _effect(item)
                _verify(item, receipt)
            receipt_id = f"effect-{_hash({'plan': plan['planHash'], 'receipt': receipt, 'fencing': fencing})[:48]}"
            result_ref = receipt
            inverse_data = inverse
        else:
            from muster.api.native_builder import apply_gateway_bound
            change_set_name = plan["approval"]["proof"]["changeSet"]
            with _as_user(actor):
                native = apply_gateway_bound(
                    change_set_name, plan["operation"]["intent"],
                    plan["planHash"], plan["approval"]["receiptId"],
                )
            if native.get("status") != "Verified":
                raise MusterEffectCallbackError(_("The native builder did not verify the effect"))
            receipt_id = f"native-{_hash(native)[:48]}"
            result_ref = {"change_set": change_set_name, "status": native["status"]}
            inverse_data = None
        secret = settings.get_password("run_event_hmac_secret", raise_exception=False) or settings.get_password("gateway_bearer_token")
        signed = hmac.new(secret.encode(), _canonical({"plan": plan["planHash"], "result": result_ref}).encode(), hashlib.sha256).hexdigest()
        application = {"receiptId": receipt_id, "resultRef": result_ref, "evidenceIds": [], "receiptSignature": signed, "executionSurface": "server_side"}
        sequence = int(frappe.db.get_value("Muster Activity", {"mission": mission.name}, "max(sequence)") or 0) + 1
        activity = frappe.get_doc({
            "doctype": "Muster Activity", "mission": mission.name, "sequence": sequence,
            "event_type": "effect_committed", "state": "Verified",
            "summary": f"Server-side {plan['capability']} effect independently verified",
            "visibility": "Auditors", "actor": actor, "idempotency_key": ledger_key,
            "payload_json": _canonical({"plan_hash": plan["planHash"], "approval": plan["approval"]["receiptId"], "fencing_token": fencing, "execution_surface": "server_side", "application": application, "inverse": inverse_data}),
        }).insert(ignore_permissions=True)
        application["evidenceIds"] = [activity.name]
        activity.db_set("payload_json", _canonical({"plan_hash": plan["planHash"], "approval": plan["approval"]["receiptId"], "fencing_token": fencing, "execution_surface": "server_side", "application": application, "inverse": inverse_data}), update_modified=False)
        return application


@frappe.whitelist(allow_guest=True, methods=["POST"])
def execute(envelope: dict | str | None = None) -> dict[str, Any]:
    """Sole gateway-to-site effect boundary; no caller-selected route, tool, or code."""
    body, raw = _raw_request()
    candidate = body["envelope"]
    if not isinstance(candidate, dict) or candidate.get("phase") not in PHASE_KEYS:
        raise MusterEffectCallbackError(_("The effect callback protocol is unsupported"))
    envelope = _exact(candidate, BASE_KEYS | PHASE_KEYS[candidate["phase"]], "effect callback envelope")
    if envelope.get("schema_version") != 1:
        raise MusterEffectCallbackError(_("The effect callback protocol is unsupported"))
    settings, binding = _trusted_binding(envelope)
    _authenticate(raw, settings)
    mission, actor = _execution(envelope)
    phase = envelope["phase"]
    if phase == "resolve":
        authority, operation = envelope["authority"], envelope["operation"]
        authority, operation = _authority(authority), _operation(operation)
        result = {"authority": _live_authority(authority, operation, actor)}
    else:
        plan = _parse_plan(envelope["plan"])
        authority = plan["authority"]
        comparisons = (("tenantId", "tenant_id"), ("siteId", "site_id"), ("siteOrigin", "site_origin"), ("userId", "actor"))
        if not isinstance(authority, dict) or any(not hmac.compare_digest(str(authority.get(left, "")).lower(), str(envelope[right]).lower()) for left, right in comparisons):
            raise MusterEffectCallbackError(_("The plan authority does not match the callback binding"))
        live = _live_authority(authority, plan["operation"], actor)
        stable_live = {key: value for key, value in live.items() if key != "dataRevision"}
        stable_planned = {key: value for key, value in authority.items() if key != "dataRevision"}
        drifted = _hash(live) != _hash(authority) if phase in {"plan", "apply"} else _hash(stable_live) != _hash(stable_planned)
        if drifted:
            raise MusterEffectCallbackError(_("Live permissions, schema, or data changed after planning"))
        _approval(plan, mission, actor)
        if phase == "plan":
            if plan["operation"]["kind"] == "record":
                change_set, _item = _record_change(plan, actor)
                with _as_user(actor):
                    preflight(change_set)
            else:
                from muster.api.native_builder import validate_gateway_bound
                change_set_name = (plan["approval"].get("proof") or {}).get("changeSet")
                if not isinstance(change_set_name, str):
                    raise MusterEffectCallbackError(_("Native artifacts require a pre-approved persisted Change Set"))
                with _as_user(actor):
                    validate_gateway_bound(change_set_name, plan["operation"]["intent"], actor)
            result = {"proposal": {"planHash": plan["planHash"], "authority": live, "summary": f"Governed {plan['capability']} effect", "approvalBindingHash": _hash(plan["approval"])}}
        elif phase == "apply":
            _proposal(envelope["proposal"], plan)
            fencing = envelope["fencing_token"]
            if not isinstance(fencing, int) or fencing < 1:
                raise MusterEffectCallbackError(_("The fencing token is invalid"))
            result = {"application": _apply_once(plan, mission, actor, fencing, settings)}
        elif phase == "observe":
            result = {"observation": _observe(plan, _application(envelope["application"]))}
        else:
            _application(envelope["application"])
            fencing = envelope["fencing_token"]
            if not isinstance(fencing, int) or fencing < 1:
                raise MusterEffectCallbackError(_("The compensation fencing token is invalid"))
            repaired = False
            ledger_key = f"muster-effect:{_effect_scope(plan, actor)}"
            raw_receipt = frappe.db.get_value("Muster Activity", {"idempotency_key": ledger_key}, "payload_json")
            stored = json.loads(raw_receipt) if raw_receipt else {}
            if stored and (stored.get("plan_hash") != plan["planHash"] or stored.get("approval") != plan["approval"]["receiptId"] or int(stored.get("fencing_token") or 0) > fencing):
                raise MusterEffectCallbackError(_("The compensation is not bound to the committed effect fence"))
            inverse = stored.get("inverse")
            if inverse and plan["operation"]["kind"] == "record":
                from muster.change_ir.executor import _rollback
                with _as_user(actor):
                    repaired = all(row.get("status") == "Repaired" for row in _rollback([inverse]))
            elif plan["operation"]["kind"] == "native_artifact":
                change_set = (plan["approval"].get("proof") or {}).get("changeSet")
                # Native apply performs immediate exact reread and forward repair
                # inside its fixed engine. A later rollback is destructive and
                # deliberately requires a separate Destructive approval.
                repaired = frappe.db.get_value("Muster Change Set", change_set, "status") == "Repaired"
            result = {"compensation": {"repaired": repaired, "evidenceIds": [mission.name] if repaired else []}}
    binding.db_set({"last_seen_at": now_datetime(), "health_status": "Authenticated effect callback"}, update_modified=False)
    return result
