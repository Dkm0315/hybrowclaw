from __future__ import annotations

import json
from dataclasses import dataclass, replace
from fnmatch import fnmatchcase
from typing import Any, Iterable

import frappe
from frappe.utils import get_datetime, now_datetime

from muster.automation.builders import ArtifactDefinition, build
from muster.automation.models import (
    APPROVAL_CLASSES,
    ArtifactChangeSet,
    AutomationPermissionError,
    AutomationValidationError,
    GovernanceContext,
)


MAX_AUTHORITY_ROWS = 10_000
MAX_CAPABILITIES = 256


@dataclass(frozen=True)
class LiveBinding:
    subject_type: str
    subject: str
    scope_type: str
    scope_value: str
    capabilities: tuple[str, ...]


@dataclass(frozen=True)
class LiveRule:
    effect: str
    capability: str
    action: str
    resource_type: str
    resource_pattern: str
    approval_class: str
    constrained: bool = False


def _capabilities(value: str | None) -> tuple[str, ...]:
    result = []
    for item in (value or "").splitlines():
        capability = item.strip()
        if not capability:
            continue
        if len(capability) > 140 or any(character.isspace() for character in capability):
            raise AutomationValidationError("a live role binding contains an invalid capability")
        result.append(capability)
        if len(result) > MAX_CAPABILITIES:
            raise AutomationValidationError("live role binding authority exceeds the safe limit")
    return tuple(sorted(set(result)))


def load_live_bindings(actor: str) -> tuple[LiveBinding, ...]:
    roles = set(frappe.get_roles(actor))
    now = now_datetime()
    rows = frappe.get_all(
        "Muster Role Binding", filters={"status": "Active"},
        fields=["subject_type", "subject", "scope_type", "scope_value", "capabilities",
                "valid_from", "valid_until"],
        limit_page_length=MAX_AUTHORITY_ROWS,
    )
    result = []
    for row in rows:
        if row.subject_type == "User":
            if not row.subject or row.subject.lower() != actor.lower():
                continue
        elif row.subject_type == "Role":
            if row.subject not in roles:
                continue
        else:
            continue
        if row.valid_from and get_datetime(row.valid_from) > now:
            continue
        if row.valid_until and get_datetime(row.valid_until) <= now:
            continue
        result.append(LiveBinding(
            row.subject_type, row.subject, row.scope_type, row.scope_value or "",
            _capabilities(row.capabilities),
        ))
    return tuple(result)


def load_live_rules() -> tuple[LiveRule, ...]:
    policies = frappe.get_all(
        "Muster Policy", filters={"enabled": 1}, fields=["name"],
        order_by="priority asc, name asc", limit_page_length=MAX_AUTHORITY_ROWS,
    )
    result = []
    for row in policies:
        policy = frappe.get_doc("Muster Policy", row.name)
        for rule in policy.rules:
            capability = (rule.capability or "").strip()
            pattern = (rule.resource_pattern or "").strip()
            action = (rule.action or "").strip()
            if not capability or not pattern or not action:
                continue
            if len(capability) > 140 or len(pattern) > 140 or len(action) > 140:
                raise AutomationValidationError("a live Muster Policy rule exceeds safe limits")
            constrained = bool(rule.max_uses)
            if rule.constraints_json:
                try:
                    constraints = json.loads(rule.constraints_json)
                except (TypeError, ValueError) as exc:
                    raise AutomationValidationError("a live Muster Policy constraint is invalid") from exc
                if constraints not in ({}, None):
                    constrained = True
            result.append(LiveRule(
                rule.effect, capability, action, rule.resource_type, pattern,
                rule.approval_class or "Standard", constrained,
            ))
            if len(result) > MAX_AUTHORITY_ROWS:
                raise AutomationValidationError("live Muster Policy authority exceeds the safe limit")
    return tuple(result)


def _resources(definition: ArtifactDefinition, manifest, site: str) -> dict[str, set[str]]:
    doctypes = {definition.doctype, *(doctype for doctype, _permission in definition.governed_permissions)}
    return {
        "Site": {site},
        "Module": {manifest.module} if manifest.module else set(),
        "DocType": doctypes,
        "Document": {definition.name, f"{definition.doctype}:{definition.name}"},
    }


def _matches_capability(pattern: str, requested: str) -> bool:
    return pattern == "*" or fnmatchcase(requested, pattern)


def _binding_matches(binding: LiveBinding, capability: str,
                     resources: dict[str, set[str]]) -> bool:
    if not any(_matches_capability(pattern, capability) for pattern in binding.capabilities):
        return False
    values = resources.get(binding.scope_type, set())
    scope = binding.scope_value.strip()
    return bool(scope and any(fnmatchcase(value, scope) for value in values))


def _rule_matches(rule: LiveRule, capability: str, stage: str, action: str,
                  resources: dict[str, set[str]]) -> bool:
    if not _matches_capability(rule.capability, capability):
        return False
    if not any(fnmatchcase(candidate, rule.action) for candidate in
               (stage, action, f"{stage}:{action}")):
        return False
    return any(fnmatchcase(value, rule.resource_pattern)
               for value in resources.get(rule.resource_type, set()))


def authorize_change_set(change_set: ArtifactChangeSet, backend: Any, *,
                         stage: str) -> tuple[ArtifactChangeSet, GovernanceContext]:
    """Intersect live bindings and policies for every artifact; no unioned-scope shortcut."""
    if stage not in {"propose", "apply", "rollback"}:
        raise AutomationValidationError("invalid artifact authorization stage")
    bindings = load_live_bindings(change_set.actor)
    rules = load_live_rules()
    effective = []
    granted: set[str] = set()
    for manifest in change_set.artifacts:
        definition = build(manifest, backend)
        fields = tuple(sorted(set(definition.values) - {"doctype", "modified"}))
        before, _revision = backend.snapshot(definition.doctype, definition.name, fields)
        action = "create" if before is None else "update"
        resources = _resources(definition, manifest, change_set.target_site)
        if not any(_binding_matches(binding, definition.capability, resources)
                   for binding in bindings):
            raise AutomationPermissionError(
                f"no active scoped Muster Role Binding grants {definition.capability}"
            )
        matching = [rule for rule in rules if _rule_matches(
            rule, definition.capability, stage, action, resources
        )]
        # Constraints/max_uses cannot be safely inferred at this boundary.  A
        # constrained deny remains a deny; a constrained allow never grants.
        if any(rule.effect == "Deny" for rule in matching):
            raise AutomationPermissionError(f"a matching Muster Policy denies {definition.capability}")
        allows = [rule for rule in matching if rule.effect == "Allow" and not rule.constrained]
        if not allows:
            raise AutomationPermissionError(
                f"no unconstrained matching Muster Policy allows {definition.capability}"
            )
        approval = max(
            [definition.approval_class, *(rule.approval_class for rule in allows),
             manifest.requested_approval_class or "None"],
            key=APPROVAL_CLASSES.index,
        )
        effective.append(replace(manifest, requested_approval_class=approval))
        granted.add(definition.capability)
    return replace(change_set, artifacts=tuple(effective)), GovernanceContext.from_values(granted)
