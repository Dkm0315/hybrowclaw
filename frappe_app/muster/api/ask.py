from __future__ import annotations

import json
import re
import secrets
from hashlib import sha256
from typing import Any
from urllib.parse import quote

import frappe
from frappe import _
from frappe.utils import add_to_date, cint, get_datetime, now_datetime
from frappe.utils.password import set_encrypted_password

from muster.adapters.client import GatewayClient, trusted_binding
from muster.adapters.context import permission_filtered_context
from muster.adapters.identity import frappe_identity
from muster.adapters.run_authority import run_authority_headers
from muster.orchestration.read_plan import (
    READ_PLANS_PATH,
    build_read_catalog,
    deterministic_count_catalog,
    deterministic_count_plan,
    execute_read_plan,
    merge_read_evidence,
)
from muster.orchestration.form_schema import effective_form_schema

ASYNC_PATH = "/v1/integrations/frappe/messages/async"
ASYNC_RUNS_PATH = "/v1/integrations/frappe/messages/runs"
ASK_INTENTS_PATH = "/v1/integrations/frappe/ask-intents"
RUN_ID = re.compile(r"^msg_[A-Za-z0-9-]+$")
CONVERSATION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,199}$")
MAX_PROMPT_CHARS = 100_000
MAX_CLARIFICATION_REPLY_CHARS = 4_000
MAX_MERGED_OBJECTIVE_CHARS = 100_000
MAX_EXACT_RECORD_CANDIDATES = 1
CLARIFICATION_TTL_MINUTES = 15
CLARIFICATION_TOKEN = re.compile(r"^[A-Za-z0-9_-]{32,128}$")
SHA256_HEX = re.compile(r"^[a-f0-9]{64}$")
_LIVE_READ_REQUEST = re.compile(
    r"\b(?:how many|count|total|sum|average|list|show me|find|which|overdue|pending|outstanding|latest|recent|current status)\b",
    re.IGNORECASE,
)
_FORM_SCHEMA_REQUEST = re.compile(
    r"\b(?:how\s+(?:do|can|would)\s+(?:i|we|you)\s+(?:create|make|prepare|raise)|"
    r"create|make|prepare|raise|train|teach|guide|forms?|fields?|custom fields?|property setters?|"
    r"customi[sz]|mandatory|required|read[ -]?only|hidden|workflows?|client scripts?|layouts?)\b",
    re.IGNORECASE,
)
_INSTRUCTIONAL_FORM_REQUEST = re.compile(
    r"\b(?:how\s+(?:do|can|would)\s+(?:i|we|you)|teach\s+me|train\s+me|"
    r"show\s+me\s+how|explain\s+how|guide\s+me\s+through)\b",
    re.IGNORECASE,
)
_EXPLICIT_FORM_CONTINUATION = re.compile(
    r"\b(?:open|fill|populate|save|submit)\s+(?:the\s+)?(?:live\s+)?form\b|"
    r"\b(?:use|validate)\s+(?:these|the)\s+details\b",
    re.IGNORECASE,
)
_ATTENDED_FORM_CHANGE = re.compile(
    r"\b(?:create|make|prepare|update|change|edit)\b",
    re.IGNORECASE,
)
_BUYING_TRAINING_REQUEST = re.compile(
    r"\b(?:train|teach|guide|walk)\b.*\b(?:buying|procure(?:ment)?|purchase)\b|"
    r"\b(?:buying|procure(?:ment)?|purchase)\b.*\b(?:workflow|module|end[ -]?to[ -]?end)\b",
    re.IGNORECASE,
)
_ASK_OUTCOMES = {
    "answer", "live_read", "artifact", "governed_change",
    "durable_workflow", "attended_browser", "development_workflow",
}
_HANDOFF_LABELS = {
    "governed_change": _("Start guided review"),
    "durable_workflow": _("Create a reusable workflow proposal"),
    "attended_browser": _("Start guided review"),
    "development_workflow": _("Prepare a reviewed development workflow"),
}
_EFFECTFUL_OUTCOMES = {
    "governed_change", "durable_workflow", "attended_browser", "development_workflow",
}
_TOOL_CALL_KINDS = {"tool", "mcp"}
_TOOL_CALL_STATUSES = {"queued", "running", "completed", "failed", "denied"}
_INTERNAL_PRESENTATION = re.compile(
    r"(?:\b(?:provider|model|backend|stack|trace|sha-?256|checksum|token|secret|runtime id|request id)\b"
    r"|(?:/home|/srv|/tmp|localhost|127\.0\.0\.1)"
    r"|\b[a-f0-9]{40,}\b)",
    re.IGNORECASE,
)
_DIAGNOSTIC_LINE = re.compile(
    r"^\s*(?:[-*]\s*)?(?:provider|model|backend|runtime|request|trace|traceback|stack|"
    r"tool[_ -]?call|raw[_ -]?(?:request|response|arguments?))\s*(?::|=|\{)",
    re.IGNORECASE,
)
_INTERNAL_FENCE = re.compile(
    r"```[^\n]*\n(?:(?!```).)*(?:provider|backend|traceback|stack trace|request[_ -]?id|"
    r"runtime[_ -]?id|tool[_ -]?calls?|/srv/|/tmp/|localhost|127\.0\.0\.1)(?:(?!```).)*```",
    re.IGNORECASE | re.DOTALL,
)
_INTERNAL_ARTIFACT = re.compile(
    r"(?:/home/|/srv/|/tmp/|localhost|127\.0\.0\.1|\b[a-f0-9]{40,}\b|"
    r"\b(?:token|secret|request[_ -]?id|runtime[_ -]?id)\s*[:=])",
    re.IGNORECASE,
)


def _effectful_fast_reply(outcomes: list[str]) -> dict[str, str] | None:
    """Keep proposed work out of the provider narration lane."""
    if not _EFFECTFUL_OUTCOMES.intersection(outcomes):
        return None
    return {
        "text": _(
            "I have the details. I’ll open the form and guide you through each field, child table, and available action. I’ll pause only when your approval is required before a change such as Save or Submit."
        )
    }


def _instructional_intent(text: str, form_doctype: str | None) -> bool:
    """Keep requests for guidance in the answer lane until action is explicit."""
    return bool(
        form_doctype
        and _INSTRUCTIONAL_FORM_REQUEST.search(text)
        and not _EXPLICIT_FORM_CONTINUATION.search(text)
    )


def _explicit_attended_form_intent(text: str, form_doctype: str | None) -> bool:
    """Route an explicit live-form continuation without another model guess."""
    return bool(
        form_doctype
        and _ATTENDED_FORM_CHANGE.search(text)
        and _EXPLICIT_FORM_CONTINUATION.search(text)
    )


def _instructional_form_fast_reply(schema: dict[str, Any]) -> dict[str, str]:
    """Describe the live create form without spending a provider turn."""
    doctype = str(schema.get("doctype") or _("this record")).strip()
    authority = schema.get("authority") if isinstance(schema.get("authority"), dict) else {}
    if not authority.get("create"):
        return {"text": _(
            "You can review {0}, but your current Frappe access does not allow creating one. "
            "I can still explain the fields and workflow available to you."
        ).format(doctype)}
    required = []
    child_groups = []
    for field in schema.get("fields") or []:
        if not isinstance(field, dict) or not field.get("create_writable"):
            continue
        label = str(field.get("label") or field.get("fieldname") or "").strip()
        if not label:
            continue
        if field.get("fieldtype") in {"Table", "Table MultiSelect"}:
            child_required = [
                str(child.get("label") or child.get("fieldname") or "").strip()
                for child in field.get("child_fields") or []
                if isinstance(child, dict) and child.get("required") and child.get("writable")
                and not child.get("has_default")
            ][:12]
            if child_required:
                child_groups.append((label, child_required))
            continue
        if field.get("required") and not field.get("has_default"):
            required.append(label)
    lines = [
        _("To create a {0}, open {0}, choose New, and complete the fields required by the live form.").format(doctype),
        "",
        _("Before I open it with you, I’ll ask for:"),
    ]
    lines.extend(f"- {label}" for label in required[:16])
    for label, child_required in child_groups[:4]:
        lines.append(_("- {0}: {1}").format(label, ", ".join(child_required)))
    if len(lines) == 3:
        lines.append(_("- The business details required by the current form rules"))
    lines.extend([
        "",
        _("Once those details are complete, I’ll open the native form and guide you through every field, child row, and available action. I’ll pause only when your approval is required before a change such as Save or Submit."),
    ])
    return {"text": "\n".join(lines)}


def _buying_training_fast_reply(user: str) -> dict[str, str]:
    """Build a live, permission-aware Buying curriculum without a provider turn."""
    stages = [
        ("Item", _("Define what can be requested and purchased.")),
        ("Supplier", _("Maintain the party that can quote, supply, and be paid.")),
        ("Material Request", _("Record and review the internal need before sourcing.")),
        ("Request for Quotation", _("Invite permitted suppliers to quote against the requirement.")),
        ("Supplier Quotation", _("Capture a supplier's commercial offer for comparison.")),
        ("Purchase Order", _("Commit the approved quantity, price, schedule, taxes, and terms.")),
        ("Purchase Receipt", _("Record what physically arrived and what was accepted.")),
        ("Purchase Invoice", _("Book the supplier liability against received or ordered goods.")),
        ("Payment Entry", _("Settle the approved payable and retain the accounting trail.")),
    ]
    visible = []
    for doctype, purpose in stages:
        if not frappe.db.exists("DocType", doctype) or not frappe.has_permission(doctype, "read", user=user):
            continue
        schema = effective_form_schema(doctype, user=user)
        authority = schema.get("authority") if isinstance(schema.get("authority"), dict) else {}
        required = []
        for field in schema.get("fields") or []:
            if not isinstance(field, dict) or not field.get("create_writable"):
                continue
            label = str(field.get("label") or field.get("fieldname") or "").strip()
            if field.get("required") and not field.get("has_default") and label:
                required.append(label)
        workflow = schema.get("workflow") if isinstance(schema.get("workflow"), dict) else None
        approval = _("Human review before Submit; Muster never approves its own work.")
        if workflow and workflow.get("transitions"):
            roles = sorted({
                str(row.get("allowed") or "").strip()
                for row in workflow["transitions"]
                if isinstance(row, dict) and str(row.get("allowed") or "").strip()
            })
            if roles:
                approval = _("Human workflow approval by: {0}.").format(", ".join(roles[:6]))
        visible.append({
            "doctype": doctype,
            "purpose": purpose,
            "required": required[:6],
            "can_create": bool(authority.get("create")),
            "approval": approval,
        })
    if not visible:
        return {"text": _("The Buying module is not available under your current Frappe permissions.")}
    lines = [
        _("Buying training: from business need to supplier payment"),
        "",
        _("I’ll teach this in the order the business evidence is created. Every screen uses your live Frappe permissions and current form rules."),
        "",
    ]
    for index, stage in enumerate(visible, 1):
        access = _("You can prepare this record") if stage["can_create"] else _("Review-only under your current access")
        lines.extend([
            _("{0}. {1}").format(index, stage["doctype"]),
            _("   Why: {0}").format(stage["purpose"]),
            _("   Access: {0}.").format(access),
            _("   Key details: {0}.").format(", ".join(stage["required"]) if stage["required"] else _("the fields required by the live form")),
            _("   Approval boundary: {0}").format(stage["approval"]),
            _("   Find it in Desk: {0}.").format(stage["doctype"]),
            "",
        ])
    lines.extend([
        _("Human-in-the-loop rule"),
        _("Muster may explain, validate, and fill a reviewed draft. A person remains responsible for Save, Submit, workflow approval, receipt acceptance, invoice posting, and payment authorization according to their Frappe role."),
        "",
        _("Start with the first stage you are allowed to create, and I’ll open the real screen, explain each field, and pause before any irreversible action."),
    ])
    return {"text": "\n".join(lines)}


def _request_form_doctype(text: str, selected_doctype: str, user: str) -> str | None:
    """Keep a module curriculum broader than form names mentioned inside it."""
    if _BUYING_TRAINING_REQUEST.search(text):
        return None
    return _prompt_form_doctype(text, selected_doctype, user)


def _presentable_tool_calls(value: Any) -> list[dict[str, Any]]:
    """Keep host-issued tool evidence useful without exposing runtime internals."""
    if not isinstance(value, list):
        return []
    result = []
    for row in value[:24]:
        if not isinstance(row, dict) or row.get("kind") not in _TOOL_CALL_KINDS or row.get("status") not in _TOOL_CALL_STATUSES:
            continue
        status = row["status"]
        label = str(row.get("label") or "").strip()[:160]
        summary = str(row.get("summary") or "").strip()[:500]
        if not label or not summary:
            continue
        if _INTERNAL_PRESENTATION.search(label):
            label = _("Muster step")
        if status == "failed":
            summary = _("This step could not be completed. Nothing was changed.")
        elif status == "denied":
            summary = _("This step is not permitted for your current access. Nothing was changed.")
        elif _INTERNAL_PRESENTATION.search(summary):
            summary = {
                "queued": _("This permitted step is waiting to start."),
                "running": _("This permitted step is in progress."),
                "completed": _("This permitted step completed."),
            }.get(status, _("This step was checked."))
        details = row.get("details") if isinstance(row.get("details"), dict) else {}
        public_details = {
            key: str(details[key]).strip()[:500]
            for key in ("purpose", "scope", "outcome")
            if isinstance(details.get(key), str) and details[key].strip()
            and not _INTERNAL_PRESENTATION.search(details[key])
        }
        result.append({
            "kind": row["kind"], "status": status,
            "label": label, "summary": summary,
            **({"details": public_details} if public_details else {}),
        })
    return result


def _presentable_answer(value: str) -> str:
    """Remove runtime diagnostics while preserving ordinary business prose."""
    text = _INTERNAL_FENCE.sub("", value[:64_000])
    public_lines = []
    for line in text.splitlines():
        if _DIAGNOSTIC_LINE.search(line) or _INTERNAL_ARTIFACT.search(line):
            continue
        public_lines.append(line.rstrip())
    public = re.sub(r"\n{3,}", "\n\n", "\n".join(public_lines)).strip()
    return public or _("Muster completed the request. No additional details are available.")


def _require_user() -> str:
    user = (frappe.session.user or "").strip()
    if not user or user.lower() == "guest":
        frappe.throw(_("Sign in to ask Muster"), frappe.PermissionError)
    if not cint(frappe.db.get_value("User", user, "enabled")):
        frappe.throw(_("This user is not active"), frappe.PermissionError)
    return user


def _require_post() -> None:
    if frappe.request and frappe.request.method != "POST":
        frappe.throw(_("This endpoint only accepts POST requests"), frappe.PermissionError)


def _scope(value: str | dict | None) -> dict[str, Any]:
    try:
        parsed = json.loads(value) if isinstance(value, str) and value else (value or {})
    except (TypeError, ValueError) as error:
        frappe.throw(_("Ask context must be valid JSON"), frappe.ValidationError)
        raise error
    if not isinstance(parsed, dict):
        frappe.throw(_("Ask context must be a JSON object"), frappe.ValidationError)
    return parsed


def _run_id(value: str) -> str:
    run_id = (value or "").strip()
    if not RUN_ID.fullmatch(run_id):
        frappe.throw(_("Invalid Muster answer identifier"), frappe.ValidationError)
    return run_id


def _conversation(value: str | None) -> str:
    conversation = (value or "").strip()
    if not CONVERSATION_ID.fullmatch(conversation):
        frappe.throw(_("Invalid Muster conversation identifier"), frappe.ValidationError)
    return conversation


def _idempotency_key(value: str | None) -> str:
    request = getattr(frappe.local, "request", None)
    header = frappe.get_request_header("Idempotency-Key") if request is not None else None
    key = (header or value or "").strip()
    if not key or len(key) > 140:
        frappe.throw(_("A valid Idempotency-Key is required"), frappe.ValidationError)
    return key


def _client_for_user(user: str) -> tuple[GatewayClient, dict[str, str], Any]:
    binding = trusted_binding()
    headers, _csrf = run_authority_headers(binding, user)
    return GatewayClient(binding), headers, binding


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _hash_text(value: str) -> str:
    return sha256(value.encode()).hexdigest()


def _validated_intent(response: dict[str, Any], request_id: str) -> dict[str, Any]:
    if set(response) != {"schemaVersion", "requestId", "status", "intent"}:
        frappe.throw(_("The gateway returned an invalid Ask routing result"), frappe.ValidationError)
    intent = response.get("intent")
    if response.get("schemaVersion") != 1 or response.get("requestId") != request_id or response.get("status") != "classified" or not isinstance(intent, dict):
        frappe.throw(_("The gateway returned an invalid Ask routing result"), frappe.ValidationError)
    allowed = {"schemaVersion", "requestId", "requestedOutcomes", "requiresClarification", "clarification"}
    if set(intent) - allowed or intent.get("schemaVersion") != 1 or intent.get("requestId") != request_id:
        frappe.throw(_("The gateway returned an invalid Ask routing result"), frappe.ValidationError)
    outcomes = intent.get("requestedOutcomes")
    if not isinstance(outcomes, list) or not outcomes or len(outcomes) > len(_ASK_OUTCOMES) or any(item not in _ASK_OUTCOMES for item in outcomes) or len(set(outcomes)) != len(outcomes):
        frappe.throw(_("The gateway returned an invalid Ask routing result"), frappe.ValidationError)
    requires = intent.get("requiresClarification")
    clarification = intent.get("clarification")
    if not isinstance(requires, bool) or requires != bool(isinstance(clarification, str) and clarification.strip()):
        frappe.throw(_("The gateway returned an invalid Ask routing result"), frappe.ValidationError)
    return {"outcomes": outcomes, "clarification": clarification.strip() if requires else None}


def _handoffs(outcomes: list[str], request_id: str) -> list[dict[str, str]]:
    handoffs = []
    emitted = set()
    for outcome in outcomes:
        label = _HANDOFF_LABELS.get(outcome)
        if not label:
            continue
        # A one-off record mutation is always shown in its real Frappe form.
        # "governed_change" remains a useful classifier outcome, but it is not
        # a separate user journey: create/update/delete all use the attended
        # browser review boundary.
        kind = (
            "attended_browser" if outcome == "governed_change"
            else "workflow_proposal" if outcome in {"artifact", "durable_workflow"}
            else outcome
        )
        if kind in emitted:
            continue
        emitted.add(kind)
        handoffs.append({
            "id": f"handoff-{sha256(f'{request_id}:{kind}'.encode()).hexdigest()[:20]}",
            "kind": kind,
            "label": label,
            "state": "offered",
            "requires": "explicit_confirmation",
        })
    return handoffs


def _exact_record_continuation_intent(parent, request_id: str) -> dict[str, Any] | None:
    """Reuse an already-governed route after Frappe verifies one exact record.

    The classifier cannot grant authority, and asking it to classify the merged
    prose again can reopen the exact-record question indefinitely.  The parent
    route is safe to inherit only when its persisted outcomes and handoffs still
    exactly match the deterministic evidence created for that parent turn.
    """
    if not parent or parent.clarification_kind != "exact_record":
        return None
    try:
        outcomes = json.loads(parent.outcomes_json or "[]")
        stored_handoffs = json.loads(parent.handoffs_json or "[]")
    except (TypeError, ValueError):
        frappe.throw(_("The parent Ask routing evidence is invalid"), frappe.ValidationError)
    if (
        not isinstance(outcomes, list) or not outcomes or len(outcomes) > len(_ASK_OUTCOMES)
        or any(item not in _ASK_OUTCOMES for item in outcomes)
        or len(set(outcomes)) != len(outcomes)
    ):
        frappe.throw(_("The parent Ask routing evidence is invalid"), frappe.ValidationError)
    parent_request_id = f"intent-{sha256(f'{parent.requested_by}:{parent.conversation_id}:{parent.request_id}'.encode()).hexdigest()[:32]}"
    expected_parent_handoffs = _handoffs(outcomes, parent_request_id)
    selected = next(
        (item for item in expected_parent_handoffs if item.get("id") == parent.clarification_handoff_id),
        None,
    )
    clarification_source_is_valid = parent.clarification_handoff_id == "intent" or bool(selected)
    if stored_handoffs != expected_parent_handoffs or not expected_parent_handoffs or not clarification_source_is_valid:
        frappe.throw(_("The parent Ask routing evidence is invalid"), frappe.ValidationError)
    return {
        "outcomes": outcomes,
        "clarification": None,
        "handoffs": _handoffs(outcomes, request_id),
    }


def _ask_turn(
    user: str, conversation: str, key: str, prompt: str, scope: dict[str, Any],
    outcomes: list[str], handoffs: list[dict[str, str]], clarification: str | None = None,
    lineage: dict[str, str] | None = None,
):
    prompt_hash = _hash_text(prompt)
    scope_json = _canonical(scope)
    scope_hash = _hash_text(scope_json)
    existing_name = frappe.db.get_value("Muster Ask Turn", {"request_id": key}, "name")
    if existing_name:
        existing = frappe.get_doc("Muster Ask Turn", existing_name)
        if (
            existing.requested_by != user or existing.conversation_id != conversation
            or existing.prompt_hash != prompt_hash or existing.scope_hash != scope_hash
            or json.loads(existing.outcomes_json or "[]") != outcomes
            or json.loads(existing.handoffs_json or "[]") != handoffs
            or (existing.clarification or None) != clarification
            or (existing.parent_ask_turn or None) != ((lineage or {}).get("parent_turn_id") or None)
            or (existing.parent_handoff_id or None) != ((lineage or {}).get("handoff_id") or None)
            or (existing.clarification_reply_hash or None) != ((lineage or {}).get("reply_hash") or None)
            or (existing.verified_target_doctype or None) != ((lineage or {}).get("verified_target_doctype") or None)
            or (existing.verified_target_name or None) != ((lineage or {}).get("verified_target_name") or None)
            or (existing.verified_target_action or None) != ((lineage or {}).get("verified_target_action") or None)
            or (str(existing.verified_target_at) if existing.verified_target_at else None) != ((lineage or {}).get("verified_target_at") or None)
            or (existing.verified_target_evidence_hash or None) != ((lineage or {}).get("verified_target_evidence_hash") or None)
        ):
            frappe.throw(_("This Ask idempotency key was already used for another request"), frappe.ValidationError)
        return existing
    doc = frappe.get_doc({
        "doctype": "Muster Ask Turn",
        "requested_by": user,
        "conversation_id": conversation,
        "request_id": key,
        "status": "Offered",
        "expires_at": add_to_date(now_datetime(), hours=24),
        "prompt_secret": prompt,
        "prompt_hash": prompt_hash,
        "scope_json": scope_json,
        "scope_hash": scope_hash,
        "outcomes_json": _canonical(outcomes),
        "handoffs_json": _canonical(handoffs),
        "clarification": clarification,
        "parent_ask_turn": (lineage or {}).get("parent_turn_id"),
        "parent_handoff_id": (lineage or {}).get("handoff_id"),
        "clarification_reply_hash": (lineage or {}).get("reply_hash"),
        "verified_target_doctype": (lineage or {}).get("verified_target_doctype"),
        "verified_target_name": (lineage or {}).get("verified_target_name"),
        "verified_target_action": (lineage or {}).get("verified_target_action"),
        "verified_target_evidence_hash": (lineage or {}).get("verified_target_evidence_hash"),
        "verified_target_at": (lineage or {}).get("verified_target_at"),
    })
    doc.insert()
    return doc


def _safe_clarification_reason(value: Any) -> str:
    reason = value.strip() if isinstance(value, str) else ""
    if not reason or len(reason) > 500 or _INTERNAL_PRESENTATION.search(reason):
        frappe.throw(_("Muster could not safely present the requested clarification"), frappe.ValidationError)
    return reason


def _one_permission_filtered_prompt_doctype(prompt: str, user: str) -> str | None:
    """Resolve one explicit DocType name without trusting provider output."""
    if frappe.session.user != user:
        return None
    matches = []
    for doctype in frappe.get_user().get_can_read() or []:
        if (
            isinstance(doctype, str) and doctype and len(doctype) <= 140
            and frappe.db.exists("DocType", doctype)
            and re.search(rf"(?<!\w){re.escape(doctype)}(?!\w)", prompt, re.IGNORECASE)
        ):
            matches.append(doctype)
    return matches[0] if len(matches) == 1 else None


def _record_clarification_target(turn, reason: str) -> dict[str, str] | None:
    try:
        scope = json.loads(turn.scope_json or "{}")
    except (TypeError, ValueError):
        return None
    prompt = turn.get_password("prompt_secret")
    doctype = scope.get("doctype") if isinstance(scope, dict) else None
    if not isinstance(doctype, str) or not doctype.strip():
        doctype = _one_permission_filtered_prompt_doctype(prompt, turn.requested_by)
    actions = [
        action for action, pattern in (
            ("update", r"\b(?:change|edit|modify|rename|set|update)\b"),
            ("delete", r"\b(?:delete|remove|erase)\b"),
        ) if re.search(pattern, prompt, re.IGNORECASE)
    ]
    if not isinstance(doctype, str) or not doctype.strip() or len(actions) != 1:
        return None
    doctype = doctype.strip()
    expected = {
        _("Which exact {0} record should I {1}?").format(doctype, actions[0]),
        _("Which exact record should I {0}?").format(actions[0]),
    }
    return {"doctype": doctype, "action": actions[0]} if reason in expected else None


def _issue_clarification(turn, handoff_id: str, reason: Any) -> dict[str, Any]:
    """Issue a one-purpose bearer that can add facts, never authority, to this turn."""
    safe_reason = _safe_clarification_reason(reason)
    target = _record_clarification_target(turn, safe_reason)
    if turn.clarification_consumed_at:
        frappe.throw(_("This clarification was already answered"), frappe.ValidationError)
    active = bool(turn.clarification_token_hash and turn.clarification_expires_at)
    if active:
        if turn.clarification_handoff_id != handoff_id or turn.clarification_reason != safe_reason:
            frappe.throw(_("The pending clarification no longer matches this request"), frappe.ValidationError)
        if bool(target) != bool(turn.clarification_kind == "exact_record"):
            frappe.throw(_("The pending clarification target no longer matches this request"), frappe.ValidationError)
        token = turn.get_password("clarification_token_secret")
    else:
        token = secrets.token_urlsafe(32)
        set_encrypted_password("Muster Ask Turn", turn.name, token, "clarification_token_secret")
        turn.db_set({
            "clarification_handoff_id": handoff_id,
            "clarification_reason": safe_reason,
            "clarification_kind": "exact_record" if target else "missing_detail",
            "clarification_target_doctype": (target or {}).get("doctype"),
            "clarification_target_action": (target or {}).get("action"),
            "clarification_token_hash": _hash_text(token),
            "clarification_issued_at": now_datetime(),
            "clarification_expires_at": add_to_date(now_datetime(), minutes=CLARIFICATION_TTL_MINUTES),
        }, update_modified=False)
    return {
        "turn_id": turn.name,
        "handoff_id": handoff_id,
        "token": token,
        "conversation_id": turn.conversation_id,
        "prompt_hash": turn.prompt_hash,
        "expires_at": str(turn.clarification_expires_at),
        "bound_scope": json.loads(turn.scope_json or "{}"),
    }


def _verified_exact_record(
    parent, reply: str, user: str, conversation: str,
) -> dict[str, str] | None:
    if parent.clarification_kind != "exact_record":
        return None
    candidates = [line.strip() for line in reply.replace("\r", "\n").split("\n") if line.strip()]
    if len(candidates) != MAX_EXACT_RECORD_CANDIDATES or len(candidates[0]) > 500:
        frappe.throw(_("Provide one exact record ID only"), frappe.ValidationError)
    candidate = candidates[0]
    if parent.clarification_consumed_at and parent.clarification_child_turn:
        child = frappe.get_doc("Muster Ask Turn", parent.clarification_child_turn)
        if child.verified_target_name != candidate:
            frappe.throw(_("This clarification reply was already used"), frappe.ValidationError)
        _verified_turn_record_identity(child, user)
        return {
            "verified_target_doctype": child.verified_target_doctype,
            "verified_target_name": child.verified_target_name,
            "verified_target_action": child.verified_target_action,
            "verified_target_at": str(child.verified_target_at),
            "verified_target_evidence_hash": child.verified_target_evidence_hash,
        }
    scope = json.loads(parent.scope_json or "{}")
    selected = scope.get("doctype") if isinstance(scope, dict) else None
    if not selected:
        selected = parent.clarification_target_doctype
    referenced_doctypes = {
        row.get("doctype") for row in (scope.get("documents") or [])
        if isinstance(row, dict) and isinstance(row.get("doctype"), str)
    }
    scoped_names = {
        str(row.get("name") or row.get("docname")) for row in (scope.get("documents") or [])
        if isinstance(row, dict) and row.get("doctype") == selected and (row.get("name") or row.get("docname"))
    }
    if scope.get("docname"):
        scoped_names.add(str(scope["docname"]))
    if (
        not isinstance(selected, str) or not selected
        or selected != parent.clarification_target_doctype
        or any(doctype != selected for doctype in referenced_doctypes)
        or parent.clarification_target_action not in {"update", "delete"}
        or (scoped_names and candidate not in scoped_names)
    ):
        frappe.throw(_("This clarification does not identify one permitted record type"), frappe.ValidationError)
    permission = "write" if parent.clarification_target_action == "update" else "delete"
    if (
        not frappe.db.exists("DocType", selected)
        or not frappe.db.exists(selected, candidate)
        or not frappe.has_permission(selected, "read", doc=candidate, user=user)
        or not frappe.has_permission(selected, permission, doc=candidate, user=user)
    ):
        frappe.throw(_("I could not verify one permitted record with that exact ID"), frappe.PermissionError)
    verified_at = str(now_datetime())
    evidence = {
        "schema_version": 1, "parent_turn_id": parent.name,
        "parent_prompt_hash": parent.prompt_hash, "reply_hash": _hash_text(candidate),
        "user": user, "conversation_id": conversation,
        "action": parent.clarification_target_action, "doctype": selected,
        "record_name": candidate, "verified_at": verified_at,
    }
    return {
        "verified_target_doctype": selected,
        "verified_target_name": candidate,
        "verified_target_action": parent.clarification_target_action,
        "verified_target_at": verified_at,
        "verified_target_evidence_hash": _hash_text(_canonical(evidence)),
    }


def _clarification_lineage(
    *, user: str, conversation: str, key: str, reply: str, submitted_scope: dict[str, Any],
    turn_id: str | None, handoff_id: str | None, token: str | None, prompt_hash: str | None,
) -> tuple[str, dict[str, Any], dict[str, str], Any] | None:
    supplied = [turn_id, handoff_id, token, prompt_hash]
    if not any(value is not None for value in supplied):
        return None
    if not all(isinstance(value, str) for value in supplied):
        frappe.throw(_("The clarification reference is incomplete"), frappe.ValidationError)
    if (
        not turn_id or len(turn_id) > 140 or len(handoff_id) > 140
        or not CLARIFICATION_TOKEN.fullmatch(token) or not SHA256_HEX.fullmatch(prompt_hash)
    ):
        frappe.throw(_("The clarification reference is invalid"), frappe.ValidationError)
    if not reply or len(reply) > MAX_CLARIFICATION_REPLY_CHARS:
        frappe.throw(_("A clarification reply must be at most {0} characters").format(MAX_CLARIFICATION_REPLY_CHARS), frappe.ValidationError)
    if frappe.db.db_type == "sqlite":
        frappe.db.sql("select name from `tabMuster Ask Turn` where name=%s", turn_id)
    else:
        frappe.db.sql("select name from `tabMuster Ask Turn` where name=%s for update", turn_id)
    parent = frappe.get_doc("Muster Ask Turn", turn_id)
    if parent.requested_by != user or parent.conversation_id != conversation or not parent.has_permission("read"):
        frappe.throw(_("This clarification is unavailable"), frappe.PermissionError)
    if parent.status != "Offered" or now_datetime() >= get_datetime(parent.expires_at):
        frappe.throw(_("This clarification has expired"), frappe.ValidationError)
    if (
        not parent.clarification_token_hash or not parent.clarification_expires_at
        or now_datetime() >= get_datetime(parent.clarification_expires_at)
        or parent.clarification_handoff_id != handoff_id
        or parent.prompt_hash != prompt_hash
        or not secrets.compare_digest(parent.clarification_token_hash, _hash_text(token))
    ):
        frappe.throw(_("This clarification is unavailable or has expired"), frappe.ValidationError)
    original = parent.get_password("prompt_secret")
    original_scope = json.loads(parent.scope_json or "{}")
    if _hash_text(original) != parent.prompt_hash or _hash_text(_canonical(original_scope)) != parent.scope_hash:
        frappe.throw(_("The original Ask request no longer matches its evidence"), frappe.ValidationError)
    if _canonical(submitted_scope) != _canonical(original_scope):
        frappe.throw(_("The clarification must keep the original visible page context"), frappe.ValidationError)
    if parent.clarification_kind == "missing_detail":
        question = _safe_clarification_reason(parent.clarification_reason)
        merged = (
            f"{original}\n\nClarification requested by Muster:\n{question}"
            f"\n\nUser's answer to that clarification:\n{reply}"
        )
    else:
        merged = f"{original}\n\nClarification supplied by the user:\n{reply}"
    if len(merged) > MAX_MERGED_OBJECTIVE_CHARS:
        frappe.throw(_("The clarified request exceeds Muster's safe size limit"), frappe.ValidationError)
    lineage = {
        "parent_turn_id": parent.name,
        "handoff_id": handoff_id,
        "reply_hash": _hash_text(reply),
    }
    verified_target = _verified_exact_record(parent, reply, user, conversation)
    if verified_target:
        lineage.update(verified_target)
    if parent.clarification_consumed_at:
        child = frappe.get_doc("Muster Ask Turn", parent.clarification_child_turn) if parent.clarification_child_turn else None
        if (
            not child or child.request_id != key or child.requested_by != user
            or child.conversation_id != conversation or child.prompt_hash != _hash_text(merged)
            or child.parent_ask_turn != parent.name or child.parent_handoff_id != handoff_id
            or child.clarification_reply_hash != lineage["reply_hash"]
            or (child.verified_target_evidence_hash or None) != (lineage.get("verified_target_evidence_hash") or None)
        ):
            frappe.throw(_("This clarification reply was already used"), frappe.ValidationError)
    return merged, original_scope, lineage, parent


def _verified_turn_record_identity(turn, user: str) -> dict[str, str] | None:
    fields = [
        turn.verified_target_doctype, turn.verified_target_name,
        turn.verified_target_action, turn.verified_target_at,
        turn.verified_target_evidence_hash,
    ]
    if not any(fields):
        return None
    text_fields = [
        turn.verified_target_doctype, turn.verified_target_name,
        turn.verified_target_action, turn.verified_target_evidence_hash,
    ]
    if not all(isinstance(value, str) and value for value in text_fields) or not turn.verified_target_at or not turn.parent_ask_turn:
        frappe.throw(_("The verified record identity evidence is incomplete"), frappe.ValidationError)
    if turn.requested_by != user or turn.verified_target_action not in {"update", "delete"}:
        frappe.throw(_("The verified record identity is unavailable"), frappe.PermissionError)
    parent = frappe.get_doc("Muster Ask Turn", turn.parent_ask_turn)
    if _exact_record_continuation_intent(parent, f"intent-{'0' * 32}") is None:
        frappe.throw(_("The verified record identity no longer matches its Ask lineage"), frappe.ValidationError)
    if (
        parent.requested_by != user or parent.conversation_id != turn.conversation_id
        or parent.scope_hash != turn.scope_hash
        or turn.clarification_reply_hash != _hash_text(turn.verified_target_name)
    ):
        frappe.throw(_("The verified record identity no longer matches its Ask lineage"), frappe.ValidationError)
    evidence = {
        "schema_version": 1, "parent_turn_id": parent.name,
        "parent_prompt_hash": parent.prompt_hash, "reply_hash": turn.clarification_reply_hash,
        "user": user, "conversation_id": turn.conversation_id,
        "action": turn.verified_target_action, "doctype": turn.verified_target_doctype,
        "record_name": turn.verified_target_name, "verified_at": str(turn.verified_target_at),
    }
    if not secrets.compare_digest(turn.verified_target_evidence_hash, _hash_text(_canonical(evidence))):
        frappe.throw(_("The verified record identity evidence no longer matches"), frappe.ValidationError)
    permission = "write" if turn.verified_target_action == "update" else "delete"
    if (
        not frappe.db.exists("DocType", turn.verified_target_doctype)
        or not frappe.db.exists(turn.verified_target_doctype, turn.verified_target_name)
        or not frappe.has_permission(turn.verified_target_doctype, "read", doc=turn.verified_target_name, user=user)
        or not frappe.has_permission(turn.verified_target_doctype, permission, doc=turn.verified_target_name, user=user)
    ):
        frappe.throw(_("The verified record is no longer available for this action"), frappe.PermissionError)
    return {
        "doctype": turn.verified_target_doctype,
        "record_name": turn.verified_target_name,
        "action": turn.verified_target_action,
        "evidence_hash": turn.verified_target_evidence_hash,
    }


def _merge_form_evidence(context: dict[str, Any], snapshot: dict[str, Any]) -> dict[str, Any]:
    customized = []
    for field in snapshot.get("fields") or []:
        provenance = field.get("provenance") if isinstance(field, dict) else None
        if not isinstance(provenance, dict) or (provenance.get("source") != "custom_field" and not provenance.get("property_setters")):
            continue
        customized.append({key: field.get(key) for key in (
            "fieldname", "label", "fieldtype", "required", "read_only", "hidden", "writable", "provenance"
        )})
    writable_fields = []
    omitted_child_fields = 0
    for field in (snapshot.get("fields") or []):
        if not isinstance(field, dict) or not field.get("writable"):
            continue
        public = {key: field.get(key) for key in (
            "fieldname", "label", "fieldtype", "permlevel", "required", "options", "child_doctype"
        )}
        children = []
        for child in field.get("child_fields") or []:
            if not isinstance(child, dict) or not child.get("writable"):
                continue
            if len(children) >= 16 and not child.get("required"):
                omitted_child_fields += 1
                continue
            children.append({key: child.get(key) for key in (
                "fieldname", "label", "fieldtype", "required", "options", "has_default"
            )})
        if children:
            public["child_fields"] = children
        writable_fields.append(public)
    evidence = {
        "kind": "fresh_permission_filtered_effective_form_schema",
        "doctype": snapshot.get("doctype"),
        "authority": snapshot.get("authority"),
        "customized_fields": customized[:100],
        "writable_fields": writable_fields[:100],
        "doctype_property_setters": (snapshot.get("doctype_property_setters") or [])[:100],
        "workflow": snapshot.get("workflow"),
        "client_scripts": (snapshot.get("client_scripts") or [])[:100],
        "schema_hash": snapshot.get("schema_hash"),
        "revision": snapshot.get("revision"),
        "omitted_optional_fields": max(0, len(writable_fields) - 100),
        "omitted_optional_child_fields": omitted_child_fields,
        "permissionFiltered": True,
    }
    existing = {}
    if context.get("summary"):
        try:
            parsed = json.loads(context["summary"])
            if isinstance(parsed, dict):
                existing = parsed
        except (TypeError, ValueError):
            pass
    payload = {**existing, "effectiveFormSchema": evidence}
    summary = _canonical(payload)
    while len(summary.encode()) > 32_000:
        optional_child = next((
            field for field in reversed(evidence["writable_fields"])
            if any(not child.get("required") for child in field.get("child_fields") or [])
        ), None)
        if optional_child:
            children = optional_child["child_fields"]
            index = next(index for index in range(len(children) - 1, -1, -1) if not children[index].get("required"))
            children.pop(index)
            evidence["omitted_optional_child_fields"] += 1
        else:
            optional_field = next((
                field for field in reversed(evidence["writable_fields"])
                if not field.get("required") and field.get("fieldtype") not in {"Table", "Table MultiSelect"}
            ), None)
            if optional_field:
                evidence["writable_fields"].remove(optional_field)
                evidence["omitted_optional_fields"] += 1
            elif evidence["client_scripts"]:
                evidence["client_scripts"].pop()
            elif evidence["doctype_property_setters"]:
                evidence["doctype_property_setters"].pop()
            elif evidence["customized_fields"]:
                evidence["customized_fields"].pop()
            else:
                frappe.throw(_("The permission-filtered form evidence exceeded its safe size limit"), frappe.ValidationError)
        summary = _canonical(payload)
    return {**context, "summary": summary}


def _prompt_form_doctype(text: str, selected: str, user: str) -> str | None:
    """Resolve one explicit form target from trusted Meta, never from model output."""
    if selected:
        # The page value remains only a target hint. effective_form_schema performs
        # the authoritative existence and live actor permission checks.
        return selected
    if not _FORM_SCHEMA_REQUEST.search(text):
        return None
    readable = frappe.get_user().get_can_read() or []
    ranked: list[tuple[int, int, str]] = []
    normalized = re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()
    words = set(normalized.split())
    for doctype in readable:
        if not isinstance(doctype, str) or not doctype or len(doctype) > 140:
            continue
        escaped = re.escape(doctype)
        exact = bool(re.search(rf"(?<!\w){escaped}(?!\w)", text, re.IGNORECASE))
        acronym = "".join(part[0] for part in re.findall(r"[A-Za-z0-9]+", doctype) if part).lower()
        if not exact and (len(acronym) < 2 or acronym not in words):
            continue
        score = 20 if exact else 10
        if exact and re.search(rf"[`\"']{escaped}[`\"']", text, re.IGNORECASE):
            score = 80
        elif exact and re.search(rf"\b(?:for|on|of|affect(?:s|ing)?|customi[sz](?:e|es|ing|ed)?)\s+(?:the\s+)?{escaped}(?!\w)", text, re.IGNORECASE):
            score = 60
        ranked.append((score, len(doctype), doctype))
    if not ranked:
        return None
    ranked.sort(reverse=True)
    best_score = ranked[0][0]
    best = [row for row in ranked if row[0] == best_score]
    longest = max(row[1] for row in best)
    most_specific = [row for row in best if row[1] == longest]
    if len(most_specific) == 1:
        return most_specific[0][2]
    candidates = [row[2] for row in most_specific]
    configured = frappe.get_all(
        "Muster Agent",
        filters={"status": "Active", "doctype_scope": ["in", candidates]},
        fields=["doctype_scope"],
        limit_page_length=len(candidates),
    )
    preferred = list(dict.fromkeys(
        str(row.doctype_scope if hasattr(row, "doctype_scope") else row.get("doctype_scope"))
        for row in configured
        if (row.doctype_scope if hasattr(row, "doctype_scope") else row.get("doctype_scope")) in candidates
    ))
    return preferred[0] if len(preferred) == 1 else None


def _conversation_form_doctype(user: str, conversation: str, text: str) -> str | None:
    """Recover the latest verified form topic for a form-oriented follow-up."""
    if not _FORM_SCHEMA_REQUEST.search(text):
        return None
    rows = frappe.get_all(
        "Muster Ask Turn",
        filters={"requested_by": user, "conversation_id": conversation},
        fields=["name"],
        order_by="creation desc",
        limit_page_length=3,
    )
    for row in rows:
        name = str(row.name if hasattr(row, "name") else row.get("name") or "")
        if not name:
            continue
        prior = frappe.get_doc("Muster Ask Turn", name)
        target = _prompt_form_doctype(prior.get_password("prompt_secret"), "", user)
        if target:
            return target
    return None


@frappe.whitelist()
def submit(
    prompt: str,
    conversation_id: str,
    scope: str | dict | None = None,
    idempotency_key: str | None = None,
    clarification_turn_id: str | None = None,
    clarification_handoff_id: str | None = None,
    clarification_token: str | None = None,
    clarification_prompt_hash: str | None = None,
) -> dict[str, Any]:
    """Queue a universal, read-safe Muster turn under the live Frappe user."""
    _require_post()
    user = _require_user()
    text = (prompt or "").strip()
    if not text or len(text) > MAX_PROMPT_CHARS:
        frappe.throw(_("Ask Muster requires a prompt of at most {0} characters").format(MAX_PROMPT_CHARS), frappe.ValidationError)
    conversation = _conversation(conversation_id)
    key = _idempotency_key(idempotency_key)
    requested_scope = _scope(scope)
    continuation = _clarification_lineage(
        user=user, conversation=conversation, key=key, reply=text,
        submitted_scope=requested_scope, turn_id=clarification_turn_id,
        handoff_id=clarification_handoff_id, token=clarification_token,
        prompt_hash=clarification_prompt_hash,
    )
    lineage = None
    parent_turn = None
    if continuation:
        text, requested_scope, lineage, parent_turn = continuation
    selected_doctype = str(requested_scope.get("doctype") or "").strip()
    buying_training_request = bool(_BUYING_TRAINING_REQUEST.search(text))
    form_doctype = _request_form_doctype(text, selected_doctype, user)
    if not buying_training_request and not form_doctype and not selected_doctype:
        form_doctype = _conversation_form_doctype(user, conversation, text)
    if form_doctype and not selected_doctype:
        requested_scope = {
            **requested_scope,
            "doctype": form_doctype,
            "page_type": "Form",
            "page_name": form_doctype,
        }
    client, headers, binding = _client_for_user(user)
    context = permission_filtered_context(requested_scope, user)
    intent_request_id = f"intent-{sha256(f'{user}:{conversation}:{key}'.encode()).hexdigest()[:32]}"
    preplanned_read_catalog = None
    preplanned_read_plan = None
    verified_fast_reply = None
    instructional_fast_reply = None
    buying_training_fast_reply = None
    prior_name = frappe.db.get_value("Muster Ask Turn", {"request_id": key}, "name")
    if prior_name:
        turn = frappe.get_doc("Muster Ask Turn", prior_name)
        prompt_hash = _hash_text(text)
        scope_hash = _hash_text(_canonical(requested_scope))
        if turn.requested_by != user or turn.conversation_id != conversation or turn.prompt_hash != prompt_hash or turn.scope_hash != scope_hash:
            frappe.throw(_("This Ask idempotency key was already used for another request"), frappe.ValidationError)
        if (
            (turn.parent_ask_turn or None) != ((lineage or {}).get("parent_turn_id") or None)
            or (turn.parent_handoff_id or None) != ((lineage or {}).get("handoff_id") or None)
            or (turn.clarification_reply_hash or None) != ((lineage or {}).get("reply_hash") or None)
            or (turn.verified_target_doctype or None) != ((lineage or {}).get("verified_target_doctype") or None)
            or (turn.verified_target_name or None) != ((lineage or {}).get("verified_target_name") or None)
            or (turn.verified_target_action or None) != ((lineage or {}).get("verified_target_action") or None)
            or (str(turn.verified_target_at) if turn.verified_target_at else None) != ((lineage or {}).get("verified_target_at") or None)
            or (turn.verified_target_evidence_hash or None) != ((lineage or {}).get("verified_target_evidence_hash") or None)
        ):
            frappe.throw(_("This Ask idempotency key does not match the clarification lineage"), frappe.ValidationError)
        outcomes = json.loads(turn.outcomes_json or "[]")
        handoffs = json.loads(turn.handoffs_json or "[]")
        if (
            not isinstance(outcomes, list) or not outcomes or len(outcomes) > len(_ASK_OUTCOMES)
            or any(item not in _ASK_OUTCOMES for item in outcomes) or len(set(outcomes)) != len(outcomes)
            or handoffs != _handoffs(outcomes, intent_request_id)
            or (turn.clarification and len(turn.clarification) > 500)
        ):
            frappe.throw(_("Stored Ask routing evidence is invalid"), frappe.ValidationError)
        intent = {"outcomes": outcomes, "clarification": turn.clarification or None}
    else:
        inherited = _exact_record_continuation_intent(parent_turn, intent_request_id)
        if inherited:
            intent = {"outcomes": inherited["outcomes"], "clarification": None}
            handoffs = inherited["handoffs"]
        else:
            read_request_id = f"read-{sha256(f'{user}:{conversation}:{key}'.encode()).hexdigest()[:32]}"
            if _LIVE_READ_REQUEST.search(text):
                preplanned_read_catalog = deterministic_count_catalog(text, user)
                preplanned_read_plan = deterministic_count_plan(text, preplanned_read_catalog, read_request_id)
            if _explicit_attended_form_intent(text, form_doctype):
                intent = {"outcomes": ["attended_browser"], "clarification": None}
            elif buying_training_request:
                intent = {"outcomes": ["answer"], "clarification": None}
                buying_training_fast_reply = _buying_training_fast_reply(user)
            elif _instructional_intent(text, form_doctype):
                intent = {"outcomes": ["answer"], "clarification": None}
            elif preplanned_read_plan is not None:
                intent = {"outcomes": ["live_read"], "clarification": None}
            else:
                classified = client.request(
                    "POST",
                    ASK_INTENTS_PATH,
                    payload={
                        "schemaVersion": 1,
                        "requestId": intent_request_id,
                        "prompt": text,
                        "context": {key: value for key, value in context.items() if key != "summary"},
                    },
                    idempotency_key=f"{intent_request_id}-route",
                    headers=headers,
                )
                intent = _validated_intent(classified, intent_request_id)
            handoffs = _handoffs(intent["outcomes"], intent_request_id)
        turn = _ask_turn(
            user, conversation, key, text, requested_scope, intent["outcomes"], handoffs,
            intent["clarification"], lineage=lineage,
        )
    if parent_turn and not parent_turn.clarification_consumed_at:
        parent_turn.db_set({
            "clarification_consumed_at": now_datetime(),
            "clarification_child_turn": turn.name,
        }, update_modified=False)
    if intent["clarification"]:
        clarification = _issue_clarification(turn, "intent", intent["clarification"])
        return {
            "status": "clarification",
            "reason": _safe_clarification_reason(intent["clarification"]),
            "turn_id": turn.name,
            "handoffs": [],
            "continuation": clarification,
            **({"merged_objective": text} if lineage else {}),
        }
    form_evidence = False
    if form_doctype and _FORM_SCHEMA_REQUEST.search(text):
        form_schema = effective_form_schema(form_doctype, user=user)
        context = _merge_form_evidence(context, form_schema)
        if _instructional_intent(text, form_doctype):
            instructional_fast_reply = _instructional_form_fast_reply(form_schema)
        agent = frappe.db.get_value("Muster Agent", {
            "status": "Active", "doctype_scope": form_doctype,
        }, ["name", "description", "instructions", "model_profile"], as_dict=True)
        if agent:
            context["agentProfile"] = {
                "name": agent.name,
                "purpose": agent.description,
                "instructions": agent.instructions,
                "modelProfile": agent.model_profile,
            }
        form_evidence = True
    # Broad live-data questions use two separate trust stages: the gateway may
    # propose only a bounded data IR, then Frappe independently revalidates and
    # executes it as this session user. The provider never receives credentials
    # and never gets a SQL/method/URL escape hatch.
    if not form_evidence and ("live_read" in intent["outcomes"] or _LIVE_READ_REQUEST.search(text)):
        read_request_id = f"read-{sha256(f'{user}:{conversation}:{key}'.encode()).hexdigest()[:32]}"
        catalog = preplanned_read_catalog or build_read_catalog(text, requested_scope, user)
        if not catalog:
            return {
                "status": "needs_read_plan",
                "reason": _("No permission-filtered business records are available to answer this question. No live value was guessed."),
            }
        read_plan = preplanned_read_plan or deterministic_count_plan(text, catalog, read_request_id)
        if read_plan is None:
            planned = client.request(
                "POST",
                READ_PLANS_PATH,
                payload={
                    "schemaVersion": 1,
                    "requestId": read_request_id,
                    "question": text,
                    "catalog": catalog,
                    "context": {key: value for key, value in context.items() if key != "summary"},
                },
                idempotency_key=f"{read_request_id}-plan",
                headers=headers,
            )
            if (
                planned.get("schemaVersion") != 1
                or planned.get("requestId") != read_request_id
                or planned.get("status") != "planned"
            ):
                frappe.throw(_("The gateway returned an invalid permission-filtered read plan"), frappe.ValidationError)
            read_plan = planned.get("plan")
            if not isinstance(read_plan, dict):
                frappe.throw(_("The gateway returned an invalid permission-filtered read plan"), frappe.ValidationError)
        disposition = read_plan.get("disposition")
        if disposition == "query":
            evidence = execute_read_plan(read_plan, read_request_id, user)
            context = merge_read_evidence(context, evidence)
            if preplanned_read_plan is not None and len(evidence.get("queries") or []) == 1:
                checked = evidence["queries"][0]
                if checked.get("mode") == "aggregate" and checked.get("aggregate") == "count":
                    verified_fast_reply = {
                        "text": _(
                            "There are {0} {1} records visible under your current access. "
                            "I checked the live {1} records using your current Frappe permissions."
                        ).format(checked.get("value"), checked.get("doctype"))
                    }
        elif disposition not in {"unsupported", "action_needed"} or read_plan.get("queries") != []:
            frappe.throw(_("The gateway returned an invalid permission-filtered read disposition"), frappe.ValidationError)
    identity = frappe_identity(user)
    # The public HTTPS origin is the gateway's reciprocal identity. Local bench
    # site names are deliberately never sent as an authority claim.
    identity["site"] = binding.site_origin
    context = {**context, "ask": {
        "schemaVersion": 1,
        "requestId": intent_request_id,
        "requestedOutcomes": intent["outcomes"],
    }}
    fast_reply = _effectful_fast_reply(intent["outcomes"])
    if fast_reply:
        context["fastReply"] = fast_reply
    elif verified_fast_reply:
        context["fastReply"] = verified_fast_reply
    elif buying_training_fast_reply:
        context["fastReply"] = buying_training_fast_reply
    elif instructional_fast_reply:
        context["fastReply"] = instructional_fast_reply
    response = client.request(
        "POST",
        ASYNC_PATH,
        payload={
            "message": {
                "surfaceId": f"frappe:{binding.site_id}",
                "conversationId": conversation,
                # The gateway protocol uses a lower-case canonical identity,
                # while local Frappe permission checks and ownership retain
                # the exact User name (notably the built-in Administrator).
                "senderId": identity["user"],
                "text": text,
            },
            "identity": identity,
            "context": context,
        },
        idempotency_key=key,
        headers=headers,
    )
    run_id = _run_id(str(response.get("runId") or ""))
    expected_poll = f"{ASYNC_RUNS_PATH}/{run_id}"
    if response.get("pollUrl") != expected_poll or response.get("status") not in {"queued", "running", "completed"}:
        frappe.throw(_("The gateway returned an invalid Ask Muster acknowledgement"), frappe.ValidationError)
    return {
        "run_id": run_id,
        "status": response["status"],
        "replayed": bool(response.get("replayed")),
        "turn_id": turn.name,
        "handoffs": handoffs,
        **({"context_target": {"doctype": form_doctype}} if form_doctype else {}),
        **({"merged_objective": text} if lineage else {}),
    }


@frappe.whitelist()
def accept_handoff(
    turn_id: str,
    handoff_id: str,
    confirmed: int | str = 0,
    idempotency_key: str | None = None,
    development_app: str | None = None,
    policy: str | None = None,
    source_file: str | None = None,
) -> dict[str, Any]:
    """Accept one inert next step; acceptance never publishes, starts, or executes it."""
    _require_post()
    user = _require_user()
    if not cint(confirmed):
        frappe.throw(_("Confirm this reviewed next step before creating it"), frappe.ValidationError)
    key = _idempotency_key(idempotency_key)
    if not turn_id or len(turn_id) > 140 or not handoff_id or len(handoff_id) > 140:
        frappe.throw(_("Invalid Ask handoff"), frappe.ValidationError)
    if frappe.db.db_type == "sqlite":
        frappe.db.sql("select name from `tabMuster Ask Turn` where name=%s", turn_id)
    else:
        frappe.db.sql("select name from `tabMuster Ask Turn` where name=%s for update", turn_id)
    turn = frappe.get_doc("Muster Ask Turn", turn_id)
    if turn.requested_by != user or not turn.has_permission("read"):
        frappe.throw(_("This Ask handoff is unavailable"), frappe.PermissionError)
    handoffs = json.loads(turn.handoffs_json or "[]")
    selected = next((item for item in handoffs if isinstance(item, dict) and item.get("id") == handoff_id), None)
    if not selected or selected.get("state") != "offered" or selected.get("requires") != "explicit_confirmation":
        frappe.throw(_("This Ask handoff is unavailable"), frappe.PermissionError)
    if turn.status == "Accepted":
        linked = turn.development_proposal if selected.get("kind") == "development_workflow" else turn.workflow_proposal
        if turn.accepted_handoff_id != handoff_id or not linked:
            frappe.throw(_("Another handoff from this Ask turn was already accepted"), frappe.ValidationError)
        return {
            "turn_id": turn.name, "handoff_id": handoff_id, "proposal": linked,
            "proposal_doctype": "Muster Development Proposal" if selected.get("kind") == "development_workflow" else "Muster Workflow Proposal",
            "status": "Proposed", "replayed": True, "executed": False,
        }
    if turn.clarification_consumed_at:
        frappe.throw(_("This Ask handoff was replaced by its clarified request"), frappe.ValidationError)
    if turn.status != "Offered" or now_datetime() >= get_datetime(turn.expires_at):
        if turn.status == "Offered":
            turn.db_set("status", "Expired", update_modified=False)
        frappe.throw(_("This Ask handoff has expired"), frappe.ValidationError)
    prompt = turn.get_password("prompt_secret")
    if _hash_text(prompt) != turn.prompt_hash:
        frappe.throw(_("The stored Ask request no longer matches its evidence"), frappe.ValidationError)
    requested_scope = json.loads(turn.scope_json or "{}")
    if _hash_text(_canonical(requested_scope)) != turn.scope_hash:
        frappe.throw(_("The stored Ask context no longer matches its evidence"), frappe.ValidationError)
    proposal_key = f"ask-{sha256(f'{turn.name}:{handoff_id}:{key}'.encode()).hexdigest()[:56]}"
    if selected.get("kind") == "development_workflow":
        if not development_app or not policy:
            frappe.throw(_("Select a registered app and enabled policy for this development proposal"), frappe.ValidationError)
        from muster.api.development import create_from_ask_turn
        proposal = create_from_ask_turn(
            turn, development_app, policy, proposal_key, source_file=source_file,
        )
        if proposal.get("status") == "clarification":
            clarification = _issue_clarification(turn, handoff_id, proposal["reason"])
            return {
                "turn_id": turn.name, "handoff_id": handoff_id,
                "status": "clarification", "reason": _safe_clarification_reason(proposal["reason"]),
                "continuation": clarification,
                "replayed": False, "executed": False,
            }
        link_field = "development_proposal"
        proposal_doctype = "Muster Development Proposal"
    else:
        from muster.orchestration.workflow_proposal import request_workflow_proposal
        verified_record_identity = _verified_turn_record_identity(turn, user)
        proposal = request_workflow_proposal(
            prompt, requested_scope, proposal_key,
            preferred_handoff_kind=selected.get("kind"),
            verified_record_identity=verified_record_identity,
        )
        if proposal.get("status") == "clarification":
            clarification = _issue_clarification(turn, handoff_id, proposal["reason"])
            return {
                "turn_id": turn.name, "handoff_id": handoff_id,
                "status": "clarification", "reason": _safe_clarification_reason(proposal["reason"]),
                "continuation": clarification,
                "replayed": False, "executed": False,
            }
        link_field = "workflow_proposal"
        proposal_doctype = "Muster Workflow Proposal"
    turn.db_set({
        "status": "Accepted", "accepted_handoff_id": handoff_id,
        "accepted_at": now_datetime(), link_field: proposal["proposal"],
    }, update_modified=False)
    return {
        "turn_id": turn.name, "handoff_id": handoff_id, "proposal": proposal["proposal"],
        "proposal_doctype": proposal_doctype, "status": proposal["status"],
        "replayed": False, "executed": False,
    }


@frappe.whitelist()
def poll(run_id: str, wait_ms: int | str = 0) -> dict[str, Any]:
    """Poll only a run owned by this site's current authenticated user."""
    user = _require_user()
    run_id = _run_id(run_id)
    wait = min(max(cint(wait_ms), 0), 20_000)
    client, headers, _binding = _client_for_user(user)
    response = client.request(
        "GET",
        f"{ASYNC_RUNS_PATH}/{run_id}",
        params={"waitMs": wait},
        headers=headers,
    )
    status = response.get("status")
    if status not in {"queued", "running", "completed", "failed"} or response.get("runId") != run_id:
        frappe.throw(_("The gateway returned an invalid Ask Muster status"), frappe.ValidationError)
    result: dict[str, Any] = {"run_id": run_id, "status": status}
    tool_calls = _presentable_tool_calls(response.get("toolCalls"))
    if tool_calls:
        result["tool_calls"] = tool_calls
    if status == "completed":
        reply = response.get("reply")
        if not isinstance(reply, dict) or not isinstance(reply.get("text"), str):
            frappe.throw(_("The gateway returned an invalid Ask Muster answer"), frappe.ValidationError)
        result["answer"] = _presentable_answer(reply["text"])
        artifacts = []
        for index, artifact in enumerate(reply.get("artifacts") or []):
            if not isinstance(artifact, dict):
                continue
            expected = f"{ASYNC_RUNS_PATH}/{run_id}/artifacts/{index}"
            if artifact.get("path") != expected:
                continue
            artifacts.append({
                "name": str(artifact.get("name") or _("Artifact"))[:255],
                "mime": str(artifact.get("mime") or "application/octet-stream")[:255],
                "download_url": (
                    "/api/method/muster.api.ask.artifact"
                    f"?run_id={quote(run_id)}&index={index}"
                ),
            })
        if artifacts:
            result["artifacts"] = artifacts
    elif status == "failed":
        # Provider/runtime diagnostics stay server-side; the deployment bearer,
        # paths, and provider topology must never reach a Desk user.
        result["error"] = _("Muster could not complete this answer. You can retry safely.")
    return result


@frappe.whitelist()
def artifact(run_id: str, index: int | str) -> None:
    """Proxy a bounded run artifact through Frappe's authenticated session."""
    user = _require_user()
    run_id = _run_id(run_id)
    artifact_index = cint(index)
    if artifact_index < 0 or artifact_index > 100:
        frappe.throw(_("Invalid Muster artifact"), frappe.ValidationError)
    client, headers, _binding = _client_for_user(user)
    value = client.request_bytes(
        f"{ASYNC_RUNS_PATH}/{run_id}/artifacts/{artifact_index}",
        headers=headers,
    )
    frappe.response["type"] = "binary"
    frappe.response["filecontent"] = value.content
    frappe.response["filename"] = f"muster-artifact-{artifact_index}"
    frappe.response["content_type"] = value.content_type
    frappe.response["display_content_as"] = "attachment"
