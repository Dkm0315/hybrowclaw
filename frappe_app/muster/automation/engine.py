from __future__ import annotations

from contextlib import ExitStack, nullcontext
from datetime import datetime, timezone
from fnmatch import fnmatchcase
from typing import Any, ContextManager, Mapping, Protocol

from muster.automation.builders import ArtifactDefinition, TrustedResolver, build
from muster.automation.models import (
    APPROVAL_CLASSES,
    ApprovalEvidence,
    ArtifactChangeSet,
    AutomationConflictError,
    AutomationPermissionError,
    AutomationValidationError,
    ExecutionEvidence,
    GovernanceContext,
    NativeChange,
    Plan,
    digest,
)


APPROVER_ROLES = frozenset({"Muster Approver", "Muster Administrator", "System Manager"})


def _expected_matches(actual: Any, expected: Any) -> bool:
    """Match reviewed business values while ignoring Frappe child-row bookkeeping."""
    if isinstance(expected, Mapping):
        return isinstance(actual, Mapping) and all(
            key in actual and _expected_matches(actual[key], value)
            for key, value in expected.items()
        )
    if isinstance(expected, (list, tuple)):
        return isinstance(actual, (list, tuple)) and len(actual) == len(expected) and all(
            _expected_matches(actual_row, expected_row)
            for actual_row, expected_row in zip(actual, expected)
        )
    return actual == expected


class NativeBackend(TrustedResolver, Protocol):
    @property
    def site(self) -> str: ...
    def actor_enabled(self, actor: str) -> bool: ...
    def has_permission(self, actor: str, doctype: str, permission: str, name: str | None = None) -> bool: ...
    def snapshot(self, doctype: str, name: str, fields: tuple[str, ...]) -> tuple[dict[str, Any] | None, str | None]: ...
    def insert(self, doctype: str, name: str, values: Mapping[str, Any]) -> str: ...
    def update(self, doctype: str, name: str, values: Mapping[str, Any]) -> None: ...
    def delete(self, doctype: str, name: str) -> None: ...
    def lock(self, key: str) -> ContextManager[Any]: ...
    def find_receipt(self, idempotency_key: str) -> Mapping[str, Any] | None: ...
    def begin_execution(self, plan: Plan) -> str: ...
    def record_receipt(self, execution_id: str, change: NativeChange, receipt: Mapping[str, Any]) -> None: ...
    def finish_execution(self, execution_id: str, status: str, *, inverses: list[dict[str, Any]],
                         evidence: Mapping[str, Any], repairs: list[dict[str, Any]] | None = None) -> None: ...


def _matches(value: str | None, patterns: frozenset[str]) -> bool:
    if not value:
        return True
    return any(pattern == "*" or fnmatchcase(value, pattern) for pattern in patterns)


def _capability_allowed(requested: str, context: GovernanceContext) -> bool:
    if any(item == "*" or fnmatchcase(requested, item) for item in context.denied_capabilities):
        return False
    return any(item == "*" or fnmatchcase(requested, item) for item in context.capabilities)


def _approval_max(*values: str) -> str:
    return max(values, key=APPROVAL_CLASSES.index)


def _govern(definition: ArtifactDefinition, manifest, change_set: ArtifactChangeSet,
            context: GovernanceContext, backend: NativeBackend, action: str) -> None:
    if not _capability_allowed(definition.capability, context):
        raise AutomationPermissionError(f"capability not granted: {definition.capability}")
    if not _matches(manifest.module, context.allowed_modules):
        raise AutomationPermissionError(f"module scope does not allow {manifest.module}")
    for governed, governed_permission in definition.governed_permissions:
        if not _matches(governed, context.allowed_doctypes):
            raise AutomationPermissionError(f"DocType scope does not allow {governed}")
        if not backend.has_permission(change_set.actor, governed, governed_permission):
            raise AutomationPermissionError(
                f"Frappe {governed_permission} permission denied on governed DocType {governed}"
            )
    permission = "create" if action == "create" else "write"
    name = None if permission == "create" else definition.name
    if not backend.has_permission(change_set.actor, definition.doctype, permission, name):
        raise AutomationPermissionError(
            f"Frappe {permission} permission denied on {definition.doctype}"
        )


def preview(change_set: ArtifactChangeSet | Mapping[str, Any], backend: NativeBackend,
            governance: GovernanceContext) -> Plan:
    if not isinstance(change_set, ArtifactChangeSet):
        change_set = ArtifactChangeSet.from_dict(change_set)
    change_set.validate()
    if backend.site != change_set.target_site:
        raise AutomationValidationError("manifest site does not match the active Frappe site")
    if not backend.actor_enabled(change_set.actor):
        raise AutomationPermissionError("execution actor is missing or disabled")
    source_validator = getattr(backend, "validate_change_set_source", None)
    if source_validator:
        source_validator(change_set)

    changes: list[NativeChange] = []
    overall = "None"
    for manifest in change_set.artifacts:
        definition = build(manifest, backend)
        validator = getattr(backend, "validate_definition", None)
        if validator:
            validator(definition, change_set)
        if manifest.kind == "office_artifact" and definition.values.get("mission") != change_set.mission:
            raise AutomationValidationError("office artifact mission must match its change set")
        fields = tuple(sorted(set(definition.values) - {"doctype", "modified"}))
        before, revision = backend.snapshot(definition.doctype, definition.name, fields)
        if definition.verify_only:
            action = "verify"
        elif before is None:
            action = "create"
        elif all(before.get(key) == value for key, value in definition.values.items()):
            action = "noop"
        else:
            action = "update"
        if manifest.expected_revision and manifest.expected_revision != revision:
            raise AutomationConflictError(f"expected revision mismatch for {manifest.artifact_id}")
        _govern(definition, manifest, change_set, governance, backend, action)
        requested = manifest.requested_approval_class or definition.approval_class
        if APPROVAL_CLASSES.index(requested) < APPROVAL_CLASSES.index(definition.approval_class):
            raise AutomationValidationError(
                f"{manifest.artifact_id} cannot lower required approval below {definition.approval_class}"
            )
        approval = _approval_max(requested, definition.approval_class)
        overall = _approval_max(overall, approval)
        changes.append(NativeChange(
            artifact_id=manifest.artifact_id, kind=manifest.kind,
            capability=definition.capability, target_doctype=definition.doctype,
            target_name=definition.name, action=action, approval_class=approval,
            before=before, after=definition.values, before_revision=revision,
            idempotency_key=manifest.idempotency_key,
            governed_permissions=definition.governed_permissions,
        ))
    unsigned = {"source": change_set.as_dict(), "changes": [item.as_dict() for item in changes],
                "approval_class": overall}
    return Plan(change_set, tuple(changes), overall, digest(unsigned))


def _time(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise AutomationPermissionError("approval timestamp is invalid") from exc
    if not parsed.tzinfo:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _check_approval(plan: Plan, approval: ApprovalEvidence | None, required: str | None = None) -> None:
    required = required or plan.approval_class
    if required == "None":
        return
    if approval is None or approval.plan_hash != plan.plan_hash:
        raise AutomationPermissionError("a current approval bound to this exact plan is required")
    if approval.requested_by != plan.source.actor or approval.decided_by == plan.source.actor:
        raise AutomationPermissionError("approval violates separation of duties")
    if approval.approval_class != required:
        raise AutomationPermissionError(f"{required} approval is required")
    now = datetime.now(timezone.utc)
    if _time(approval.decided_at) > now or _time(approval.expires_at) <= now:
        raise AutomationPermissionError("approval is not current")
    if not approval.approver_roles.intersection(APPROVER_ROLES):
        raise AutomationPermissionError("decision maker does not hold an approver role")


def _current_matches(change: NativeChange, backend: NativeBackend) -> bool:
    fields = tuple(sorted(set(change.after) - {"doctype", "modified"}))
    current, revision = backend.snapshot(change.target_doctype, change.target_name, fields)
    return current == change.before and revision == change.before_revision


def _receipt(plan: Plan, change: NativeChange, inverse: Mapping[str, Any] | None,
             *, replayed: bool = False) -> dict[str, Any]:
    effect = {"doctype": change.target_doctype, "name": change.target_name,
              "action": change.action, "after_hash": digest(change.after)}
    manifest = next(item for item in plan.source.artifacts if item.artifact_id == change.artifact_id)
    provenance = ({
        "source_evidence_hash": plan.source.source_evidence.evidence_hash,
        "source_citations": [item.as_dict() for item in manifest.source_citations],
    } if plan.source.source_evidence else {})
    return {**effect, "artifact_id": change.artifact_id, "idempotency_key": change.idempotency_key,
            "plan_hash": plan.plan_hash, "effect_hash": digest(effect), "inverse": inverse,
            "replayed": replayed, **provenance}


def _compensate(backend: NativeBackend, inverse: Mapping[str, Any]) -> dict[str, Any]:
    try:
        kind, doctype, name = inverse["kind"], inverse["doctype"], inverse["name"]
        fields = tuple((inverse.get("values") or {}).keys())
        current, _revision = backend.snapshot(doctype, name, fields)
        if kind == "delete" and current is not None:
            backend.delete(doctype, name)
        elif kind == "restore" and current is None:
            backend.insert(doctype, name, inverse["values"])
        elif kind == "restore":
            backend.update(doctype, name, inverse["values"])
        return {**inverse, "status": "Repaired"}
    except Exception as exc:  # repair evidence must survive the original failure
        return {**inverse, "status": "Failed", "error": str(exc)[:500]}


def apply(plan: Plan, backend: NativeBackend, governance: GovernanceContext,
          approval: ApprovalEvidence | None = None) -> ExecutionEvidence:
    if backend.site != plan.source.target_site or not backend.actor_enabled(plan.source.actor):
        raise AutomationPermissionError("execution site or actor is no longer valid")
    replay_receipts = []
    for change in plan.changes:
        if not _capability_allowed(change.capability, governance):
            raise AutomationPermissionError(f"capability not granted: {change.capability}")
        existing = backend.find_receipt(change.idempotency_key)
        if not existing:
            replay_receipts = []
            break
        if existing.get("plan_hash") != plan.plan_hash or existing.get("artifact_id") != change.artifact_id:
            raise AutomationConflictError("an idempotency key is already bound to a different effect")
        replay_receipts.append({**existing, "replayed": True})
    if replay_receipts:
        replay_inverses = [dict(row["inverse"]) for row in replay_receipts if row.get("inverse")]
        payload = {"plan_hash": plan.plan_hash, "status": "Verified",
                   "receipts": replay_receipts, "inverses": replay_inverses}
        return ExecutionEvidence(str(replay_receipts[0].get("execution_id") or "replay"),
                                 plan.plan_hash, "Verified", tuple(replay_receipts),
                                 tuple(replay_inverses), digest(payload))
    fresh = preview(plan.source, backend, governance)
    if fresh.plan_hash != plan.plan_hash:
        raise AutomationConflictError("the target or policy-visible plan changed after preview")
    _check_approval(plan, approval)
    with ExitStack() as locks:
        # Lock each key rather than the plan hash: overlapping plans cannot race the
        # same idempotency key, and sorted acquisition prevents deadlocks.
        for key in sorted(change.idempotency_key for change in plan.changes):
            locks.enter_context(backend.lock(f"muster-native-artifact:{key}") or nullcontext())
        execution_id = backend.begin_execution(plan)
        receipts: list[dict[str, Any]] = []
        inverses: list[dict[str, Any]] = []
        try:
            for change in plan.changes:
                existing = backend.find_receipt(change.idempotency_key)
                if existing:
                    if existing.get("plan_hash") != plan.plan_hash or existing.get("artifact_id") != change.artifact_id:
                        raise AutomationConflictError("an idempotency key is already bound to another effect")
                    receipts.append({**existing, "replayed": True})
                    continue
                if not _current_matches(change, backend):
                    raise AutomationConflictError(f"concurrent change detected for {change.artifact_id}")
                inverse = None
                if change.action == "create":
                    actual_name = backend.insert(change.target_doctype, change.target_name, change.after)
                    # Register compensation before validating the framework's
                    # returned name. Otherwise a DocType autoname override can
                    # persist an orphan while the Change Set reports Repaired.
                    inverse = {"kind": "delete", "doctype": change.target_doctype,
                               "name": actual_name, "after_hash": digest(change.after)}
                    inverses.append(inverse)
                    if actual_name != change.target_name:
                        raise AutomationConflictError("Frappe generated an unexpected artifact name")
                elif change.action == "update":
                    backend.update(change.target_doctype, change.target_name, change.after)
                    inverse = {"kind": "restore", "doctype": change.target_doctype,
                               "name": change.target_name, "values": dict(change.before or {}),
                               "after_hash": digest(change.after)}
                    inverses.append(inverse)
                elif change.action == "verify":
                    if change.before is None:
                        raise AutomationConflictError("the referenced native artifact does not exist")
                receipt = _receipt(plan, change, inverse)
                fields = tuple(sorted(set(change.after) - {"doctype", "modified"}))
                observed, _revision = backend.snapshot(change.target_doctype, change.target_name, fields)
                if observed is None or not _expected_matches(observed, change.after):
                    raise AutomationConflictError(f"postcondition failed for {change.artifact_id}")
                receipt["execution_id"] = execution_id
                backend.record_receipt(execution_id, change, receipt)
                receipts.append(receipt)
            payload = {"execution_id": execution_id, "plan_hash": plan.plan_hash,
                       "status": "Verified", "receipts": receipts, "inverses": inverses}
            evidence = ExecutionEvidence(execution_id, plan.plan_hash, "Verified", tuple(receipts),
                                         tuple(inverses), digest(payload))
            backend.finish_execution(execution_id, "Verified", inverses=inverses,
                                     evidence=evidence.as_dict())
            return evidence
        except Exception as exc:
            repairs = [_compensate(backend, inverse) for inverse in reversed(inverses)]
            status = "Needs Intervention" if any(item["status"] == "Failed" for item in repairs) else "Repaired"
            payload = {"execution_id": execution_id, "plan_hash": plan.plan_hash, "status": status,
                       "receipts": receipts, "inverses": inverses, "repairs": repairs,
                       "failure": {"type": type(exc).__name__, "message": str(exc)[:500]}}
            evidence = ExecutionEvidence(execution_id, plan.plan_hash, status, tuple(receipts),
                                         tuple(inverses), digest(payload), tuple(repairs))
            backend.finish_execution(execution_id, status, inverses=inverses,
                                     evidence={**evidence.as_dict(), "failure": payload["failure"]},
                                     repairs=repairs)
            return evidence


def rollback(plan: Plan, execution: ExecutionEvidence, backend: NativeBackend,
             governance: GovernanceContext, approval: ApprovalEvidence) -> ExecutionEvidence:
    if execution.plan_hash != plan.plan_hash or execution.status != "Verified":
        raise AutomationValidationError("only a verified execution of this exact plan can be rolled back")
    fresh = preview(plan.source, backend, governance)
    # A rollback is expected to see the applied state, so only policy is re-evaluated above.
    if fresh.source.as_dict() != plan.source.as_dict():
        raise AutomationConflictError("rollback source no longer matches")
    _check_approval(plan, approval, "Destructive")
    repairs = []
    with (backend.lock(f"muster-native-rollback:{execution.execution_id}") or nullcontext()):
        for inverse in reversed(execution.inverses):
            matched = next((change for change in plan.changes
                            if change.target_doctype == inverse["doctype"] and
                            change.target_name == inverse["name"]), None)
            fields = tuple((inverse.get("values") or {}).keys())
            if not fields:
                fields = tuple(matched.after) if matched else ()
            current, _ = backend.snapshot(inverse["doctype"], inverse["name"], tuple(fields))
            expected = inverse.get("after_hash")
            if current is not None and expected:
                # Frappe expands child rows with framework-owned bookkeeping
                # (name, parent, idx, doctype, ...).  Apply verification already
                # compares the reviewed business projection, so rollback must use
                # the same fail-closed projection instead of hashing those
                # generated fields.  Any reviewed business-field drift still
                # blocks compensation.
                unchanged = (
                    _expected_matches(current, matched.after)
                    if matched else digest(current) == expected
                )
                if not unchanged:
                    raise AutomationConflictError(
                        "artifact changed after apply; rollback would clobber user work"
                    )
            repair = _compensate(backend, inverse)
            repairs.append(repair)
            if repair["status"] == "Failed":
                break
    status = "Rolled Back" if repairs and all(item["status"] == "Repaired" for item in repairs) else "Needs Intervention"
    payload = {"execution_id": execution.execution_id, "plan_hash": plan.plan_hash, "status": status,
               "receipts": list(execution.receipts), "inverses": list(execution.inverses), "repairs": repairs}
    result = ExecutionEvidence(execution.execution_id, plan.plan_hash, status, execution.receipts,
                               execution.inverses, digest(payload), tuple(repairs))
    backend.finish_execution(execution.execution_id, status, inverses=list(execution.inverses),
                             evidence=result.as_dict(), repairs=repairs)
    return result
