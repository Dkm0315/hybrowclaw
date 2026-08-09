from __future__ import annotations

import json
from hashlib import sha256

import frappe
from frappe.model.document import Document

_OUTCOMES = {"answer", "live_read", "artifact", "governed_change", "durable_workflow", "attended_browser", "development_workflow"}
_HANDOFF_KINDS = {"governed_change", "workflow_proposal", "attended_browser", "development_workflow"}


class MusterAskTurn(Document):
    def validate(self):
        if not self.is_new() and any(
            self.has_value_changed(field)
            for field in (
                "requested_by", "conversation_id", "request_id", "prompt_hash",
                "scope_json", "scope_hash", "outcomes_json", "handoffs_json", "clarification",
                "parent_ask_turn", "parent_handoff_id", "clarification_reply_hash",
                "verified_target_doctype", "verified_target_name", "verified_target_action",
                "verified_target_at", "verified_target_evidence_hash",
            )
        ):
            frappe.throw("The admitted Ask request and handoffs are immutable")
        scope = json.loads(self.scope_json or "{}")
        outcomes = json.loads(self.outcomes_json or "[]")
        handoffs = json.loads(self.handoffs_json or "[]")
        if not isinstance(scope, dict) or not isinstance(outcomes, list) or not isinstance(handoffs, list):
            frappe.throw("Ask turn evidence is invalid")
        if not outcomes or len(outcomes) > len(_OUTCOMES) or len(set(outcomes)) != len(outcomes) or any(item not in _OUTCOMES for item in outcomes):
            frappe.throw("Ask turn outcomes are invalid")
        for handoff in handoffs:
            if (
                not isinstance(handoff, dict)
                or set(handoff) != {"id", "kind", "label", "state", "requires"}
                or not isinstance(handoff.get("id"), str) or not handoff["id"].startswith("handoff-")
                or handoff.get("kind") not in _HANDOFF_KINDS
                or not isinstance(handoff.get("label"), str) or not handoff["label"]
                or handoff.get("state") != "offered"
                or handoff.get("requires") != "explicit_confirmation"
            ):
                frappe.throw("Ask turn handoff evidence is invalid")
        if self.clarification and len(self.clarification) > 500:
            frappe.throw("Ask turn clarification is invalid")
        lineage = [self.parent_ask_turn, self.parent_handoff_id, self.clarification_reply_hash]
        if any(lineage) and not all(lineage):
            frappe.throw("Ask turn clarification lineage is incomplete")
        if self.parent_ask_turn == self.name:
            frappe.throw("Ask turn cannot clarify itself")
        if self.clarification_reply_hash and (
            len(self.clarification_reply_hash) != 64
            or any(char not in "0123456789abcdef" for char in self.clarification_reply_hash)
        ):
            frappe.throw("Ask turn clarification reply evidence is invalid")
        verified = [
            self.verified_target_doctype, self.verified_target_name,
            self.verified_target_action, self.verified_target_at,
            self.verified_target_evidence_hash,
        ]
        if any(verified) and (not all(verified) or not all(lineage)):
            frappe.throw("Ask turn verified target evidence is incomplete")
        if self.verified_target_action and self.verified_target_action not in {"update", "delete"}:
            frappe.throw("Ask turn verified target action is invalid")
        if self.verified_target_evidence_hash and (
            len(self.verified_target_evidence_hash) != 64
            or any(char not in "0123456789abcdef" for char in self.verified_target_evidence_hash)
        ):
            frappe.throw("Ask turn verified target evidence hash is invalid")
        canonical_scope = json.dumps(scope, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        if sha256(canonical_scope.encode()).hexdigest() != self.scope_hash:
            frappe.throw("Ask turn scope evidence does not match")
        prompt = (self.prompt_secret or "") if self.is_new() else (self.get_password("prompt_secret", raise_exception=False) or "")
        if not prompt or sha256(prompt.encode()).hexdigest() != self.prompt_hash:
            frappe.throw("Ask turn prompt evidence does not match")
