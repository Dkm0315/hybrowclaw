from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from hashlib import sha256
from types import MappingProxyType
from typing import Any, Mapping


SCHEMA_VERSION = "1.0"
APPROVAL_CLASSES = ("None", "Standard", "Sensitive", "Privileged Code", "Destructive")
ARTIFACT_KINDS = frozenset({
    "custom_field", "property_setter", "doctype", "page", "workspace", "query_report",
    "script_report", "print_format", "web_page", "web_form", "notification",
    "assignment_rule", "client_script", "server_script", "email_template",
    "office_artifact",
})
_KEY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:/-]{5,139}$")
_NAME = re.compile(r"^[^\x00-\x1f]{1,140}$")
_HASH = re.compile(r"^[a-f0-9]{64}$")
_REQUIREMENT_ID = re.compile(r"^R[0-9]{3}$")


class AutomationValidationError(ValueError):
    pass


class AutomationConflictError(RuntimeError):
    pass


class AutomationPermissionError(PermissionError):
    pass


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False)


def digest(value: Any) -> str:
    return sha256(canonical_json(value).encode("utf-8")).hexdigest()


def _plain_json(value: Any, label: str) -> Any:
    try:
        encoded = canonical_json(value)
        decoded = json.loads(encoded)
    except (TypeError, ValueError) as exc:
        raise AutomationValidationError(f"{label} must contain only JSON values") from exc
    if len(encoded.encode("utf-8")) > 256_000:
        raise AutomationValidationError(f"{label} exceeds 256 KB")
    return decoded


@dataclass(frozen=True)
class SourceCitation:
    file_id: str
    requirement_id: str
    locator: str
    quote_hash: str

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "SourceCitation":
        if not isinstance(value, Mapping) or set(value) != {
            "file_id", "requirement_id", "locator", "quote_hash"
        }:
            raise AutomationValidationError("source citation has unknown or missing fields")
        result = cls(*(str(value[key] or "") for key in (
            "file_id", "requirement_id", "locator", "quote_hash"
        )))
        result.validate()
        return result

    def validate(self) -> None:
        if not _NAME.fullmatch(self.file_id):
            raise AutomationValidationError("source citation file_id is invalid")
        if not _REQUIREMENT_ID.fullmatch(self.requirement_id):
            raise AutomationValidationError("source citation requirement_id is invalid")
        if (not self.locator or len(self.locator) > 160
                or any(ord(character) < 32 for character in self.locator)):
            raise AutomationValidationError("source citation locator is invalid")
        if not _HASH.fullmatch(self.quote_hash):
            raise AutomationValidationError("source citation quote_hash is invalid")

    def as_dict(self) -> dict[str, str]:
        return asdict(self)


@dataclass(frozen=True)
class SourceEvidenceBinding:
    file_id: str
    file_name: str
    file_hash: str
    requirements_hash: str
    evidence_hash: str

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "SourceEvidenceBinding":
        if not isinstance(value, Mapping) or set(value) != {
            "file_id", "file_name", "file_hash", "requirements_hash", "evidence_hash"
        }:
            raise AutomationValidationError("source evidence has unknown or missing fields")
        result = cls(*(str(value[key] or "") for key in (
            "file_id", "file_name", "file_hash", "requirements_hash", "evidence_hash"
        )))
        result.validate()
        return result

    def validate(self) -> None:
        if not _NAME.fullmatch(self.file_id):
            raise AutomationValidationError("source evidence file_id is invalid")
        if (not self.file_name or len(self.file_name) > 255
                or any(ord(character) < 32 for character in self.file_name)):
            raise AutomationValidationError("source evidence file_name is invalid")
        if any(not _HASH.fullmatch(value) for value in (
            self.file_hash, self.requirements_hash, self.evidence_hash
        )):
            raise AutomationValidationError("source evidence hashes are invalid")

    def as_dict(self) -> dict[str, str]:
        return asdict(self)


@dataclass(frozen=True)
class ArtifactManifest:
    artifact_id: str
    kind: str
    target_name: str
    idempotency_key: str
    values: Mapping[str, Any] = field(default_factory=dict)
    target_doctype: str | None = None
    module: str | None = None
    expected_revision: str | None = None
    requested_approval_class: str | None = None
    source_citations: tuple[SourceCitation, ...] = ()

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "ArtifactManifest":
        if not isinstance(value, Mapping):
            raise AutomationValidationError("each artifact manifest must be an object")
        allowed = {
            "artifact_id", "kind", "target_name", "idempotency_key", "values",
            "target_doctype", "module", "expected_revision", "requested_approval_class",
            "source_citations",
        }
        unknown = set(value) - allowed
        if unknown:
            raise AutomationValidationError(f"unknown manifest keys: {', '.join(sorted(unknown))}")
        manifest = cls(
            artifact_id=str(value.get("artifact_id") or ""),
            kind=str(value.get("kind") or ""),
            target_name=str(value.get("target_name") or ""),
            idempotency_key=str(value.get("idempotency_key") or ""),
            values=MappingProxyType(_plain_json(value.get("values") or {}, "manifest values")),
            target_doctype=str(value["target_doctype"]) if value.get("target_doctype") else None,
            module=str(value["module"]) if value.get("module") else None,
            expected_revision=str(value["expected_revision"]) if value.get("expected_revision") else None,
            requested_approval_class=(
                str(value["requested_approval_class"])
                if value.get("requested_approval_class") is not None else None
            ),
            source_citations=tuple(
                SourceCitation.from_dict(item) for item in value.get("source_citations") or ()
            ),
        )
        manifest.validate()
        return manifest

    def validate(self) -> None:
        if not _KEY.fullmatch(self.artifact_id):
            raise AutomationValidationError("artifact_id must be a stable 6-140 character key")
        if self.kind not in ARTIFACT_KINDS:
            raise AutomationValidationError(f"unsupported artifact kind: {self.kind}")
        if not _NAME.fullmatch(self.target_name):
            raise AutomationValidationError("target_name is invalid")
        if not _KEY.fullmatch(self.idempotency_key):
            raise AutomationValidationError("idempotency_key must be a stable 6-140 character key")
        if self.target_doctype and not _NAME.fullmatch(self.target_doctype):
            raise AutomationValidationError("target_doctype is invalid")
        if self.module and not _NAME.fullmatch(self.module):
            raise AutomationValidationError("module is invalid")
        if self.requested_approval_class not in {None, *APPROVAL_CLASSES}:
            raise AutomationValidationError("requested_approval_class is invalid")
        if len(self.source_citations) > 20:
            raise AutomationValidationError("an artifact may cite at most 20 source passages")
        citation_ids = [(item.file_id, item.requirement_id) for item in self.source_citations]
        if len(citation_ids) != len(set(citation_ids)):
            raise AutomationValidationError("artifact source citations must be unique")

    def as_dict(self) -> dict[str, Any]:
        result = {
            "artifact_id": self.artifact_id, "kind": self.kind,
            "target_name": self.target_name, "idempotency_key": self.idempotency_key,
            "values": dict(self.values), "target_doctype": self.target_doctype,
            "module": self.module, "expected_revision": self.expected_revision,
            "requested_approval_class": self.requested_approval_class,
        }
        if self.source_citations:
            result["source_citations"] = [item.as_dict() for item in self.source_citations]
        return result


@dataclass(frozen=True)
class ArtifactChangeSet:
    target_site: str
    actor: str
    mission: str
    artifacts: tuple[ArtifactManifest, ...]
    schema_version: str = SCHEMA_VERSION
    source_evidence: SourceEvidenceBinding | None = None

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "ArtifactChangeSet":
        if set(value) - {"schema_version", "target_site", "actor", "mission", "artifacts", "source_evidence"}:
            raise AutomationValidationError("change set contains unknown keys")
        result = cls(
            schema_version=str(value.get("schema_version") or ""),
            target_site=str(value.get("target_site") or ""),
            actor=str(value.get("actor") or ""),
            mission=str(value.get("mission") or ""),
            artifacts=tuple(ArtifactManifest.from_dict(item) for item in value.get("artifacts") or ()),
            source_evidence=(
                SourceEvidenceBinding.from_dict(value["source_evidence"])
                if value.get("source_evidence") else None
            ),
        )
        result.validate()
        return result

    def validate(self) -> None:
        if self.schema_version != SCHEMA_VERSION:
            raise AutomationValidationError("unsupported automation manifest schema version")
        if not self.target_site or len(self.target_site) > 140:
            raise AutomationValidationError("target_site is required")
        if not self.actor or len(self.actor) > 140:
            raise AutomationValidationError("actor is required")
        if not self.mission or len(self.mission) > 140:
            raise AutomationValidationError("mission is required for durable audit evidence")
        if not self.artifacts or len(self.artifacts) > 50:
            raise AutomationValidationError("a change set requires 1-50 artifacts")
        ids = [item.artifact_id for item in self.artifacts]
        keys = [item.idempotency_key for item in self.artifacts]
        if len(ids) != len(set(ids)):
            raise AutomationValidationError("artifact_id values must be unique")
        if len(keys) != len(set(keys)):
            raise AutomationValidationError("idempotency_key values must be unique")
        cited = [item for artifact in self.artifacts for item in artifact.source_citations]
        if self.source_evidence:
            if any(not artifact.source_citations for artifact in self.artifacts):
                raise AutomationValidationError("every source-driven artifact requires a citation")
            if any(item.file_id != self.source_evidence.file_id for item in cited):
                raise AutomationValidationError("source citation refers to another file")
        elif cited:
            raise AutomationValidationError("source citations require immutable source evidence")

    def as_dict(self) -> dict[str, Any]:
        result = {
            "schema_version": self.schema_version, "target_site": self.target_site,
            "actor": self.actor, "mission": self.mission,
            "artifacts": [item.as_dict() for item in self.artifacts],
        }
        if self.source_evidence:
            result["source_evidence"] = self.source_evidence.as_dict()
        return result


@dataclass(frozen=True)
class GovernanceContext:
    capabilities: frozenset[str]
    denied_capabilities: frozenset[str] = frozenset()
    allowed_modules: frozenset[str] = frozenset({"*"})
    allowed_doctypes: frozenset[str] = frozenset({"*"})

    @classmethod
    def from_values(
        cls, capabilities: set[str] | list[str] | tuple[str, ...], *,
        denied_capabilities: set[str] | list[str] | tuple[str, ...] = (),
        allowed_modules: set[str] | list[str] | tuple[str, ...] = ("*",),
        allowed_doctypes: set[str] | list[str] | tuple[str, ...] = ("*",),
    ) -> "GovernanceContext":
        return cls(frozenset(capabilities), frozenset(denied_capabilities),
                   frozenset(allowed_modules), frozenset(allowed_doctypes))


@dataclass(frozen=True)
class NativeChange:
    artifact_id: str
    kind: str
    capability: str
    target_doctype: str
    target_name: str
    action: str
    approval_class: str
    before: Mapping[str, Any] | None
    after: Mapping[str, Any]
    before_revision: str | None
    idempotency_key: str
    governed_permissions: tuple[tuple[str, str], ...] = ()

    def as_dict(self) -> dict[str, Any]:
        return {**asdict(self), "before": self.before, "after": self.after}


@dataclass(frozen=True)
class Plan:
    source: ArtifactChangeSet
    changes: tuple[NativeChange, ...]
    approval_class: str
    plan_hash: str

    def unsigned_dict(self) -> dict[str, Any]:
        return {"source": self.source.as_dict(), "changes": [c.as_dict() for c in self.changes],
                "approval_class": self.approval_class}

    def as_dict(self) -> dict[str, Any]:
        return {**self.unsigned_dict(), "plan_hash": self.plan_hash}


@dataclass(frozen=True)
class ApprovalEvidence:
    plan_hash: str
    approval_class: str
    requested_by: str
    decided_by: str
    decided_at: str
    expires_at: str
    approver_roles: frozenset[str]


@dataclass(frozen=True)
class ExecutionEvidence:
    execution_id: str
    plan_hash: str
    status: str
    receipts: tuple[Mapping[str, Any], ...]
    inverses: tuple[Mapping[str, Any], ...]
    evidence_hash: str
    repairs: tuple[Mapping[str, Any], ...] = ()

    def as_dict(self) -> dict[str, Any]:
        return {**asdict(self), "receipts": list(self.receipts), "inverses": list(self.inverses),
                "repairs": list(self.repairs)}


def plan_from_dict(value: Mapping[str, Any]) -> Plan:
    if not isinstance(value, Mapping) or set(value) != {
        "source", "changes", "approval_class", "plan_hash"
    }:
        raise AutomationValidationError("serialized native artifact plan is invalid")
    source = ArtifactChangeSet.from_dict(value["source"])
    if value["approval_class"] not in APPROVAL_CLASSES:
        raise AutomationValidationError("serialized plan approval class is invalid")
    if not isinstance(value["changes"], list) or len(value["changes"]) != len(source.artifacts):
        raise AutomationValidationError("serialized plan changes do not match its manifests")
    fields = {
        "artifact_id", "kind", "capability", "target_doctype", "target_name", "action",
        "approval_class", "before", "after", "before_revision", "idempotency_key",
        "governed_permissions",
    }
    changes = []
    for index, row in enumerate(value["changes"]):
        if not isinstance(row, Mapping) or set(row) != fields:
            raise AutomationValidationError("serialized native artifact change is invalid")
        manifest = source.artifacts[index]
        if row["artifact_id"] != manifest.artifact_id or row["idempotency_key"] != manifest.idempotency_key:
            raise AutomationValidationError("serialized change identity does not match its manifest")
        if row["kind"] != manifest.kind or row["action"] not in {"create", "update", "noop", "verify"}:
            raise AutomationValidationError("serialized native artifact action is invalid")
        if row["approval_class"] not in APPROVAL_CLASSES:
            raise AutomationValidationError("serialized change approval class is invalid")
        if row["before"] is not None and not isinstance(row["before"], Mapping):
            raise AutomationValidationError("serialized before state is invalid")
        if not isinstance(row["after"], Mapping):
            raise AutomationValidationError("serialized after state is invalid")
        governed = row["governed_permissions"]
        if (not isinstance(governed, (list, tuple)) or
                any(not isinstance(item, (list, tuple)) or len(item) != 2 for item in governed)):
            raise AutomationValidationError("serialized governed permissions are invalid")
        changes.append(NativeChange(
            artifact_id=row["artifact_id"], kind=row["kind"], capability=row["capability"],
            target_doctype=row["target_doctype"], target_name=row["target_name"],
            action=row["action"], approval_class=row["approval_class"],
            before=dict(row["before"]) if row["before"] is not None else None,
            after=dict(row["after"]), before_revision=row["before_revision"],
            idempotency_key=row["idempotency_key"],
            governed_permissions=tuple((str(item[0]), str(item[1])) for item in governed),
        ))
    plan = Plan(source, tuple(changes), str(value["approval_class"]), str(value["plan_hash"]))
    if digest(plan.unsigned_dict()) != plan.plan_hash:
        raise AutomationValidationError("serialized plan hash does not match its contents")
    return plan


def execution_from_dict(value: Mapping[str, Any]) -> ExecutionEvidence:
    required = {"execution_id", "plan_hash", "status", "receipts", "inverses", "evidence_hash", "repairs"}
    if not isinstance(value, Mapping) or set(value) - required or not required.issubset(value):
        raise AutomationValidationError("serialized native artifact execution is invalid")
    if not all(isinstance(value.get(name), list) for name in ("receipts", "inverses", "repairs")):
        raise AutomationValidationError("serialized execution collections are invalid")
    result = ExecutionEvidence(
        str(value["execution_id"]), str(value["plan_hash"]), str(value["status"]),
        tuple(dict(item) for item in value["receipts"]),
        tuple(dict(item) for item in value["inverses"]), str(value["evidence_hash"]),
        tuple(dict(item) for item in value["repairs"]),
    )
    if result.status != "Verified":
        raise AutomationValidationError("only verified execution evidence can be loaded for rollback")
    unsigned = {"execution_id": result.execution_id, "plan_hash": result.plan_hash,
                "status": result.status, "receipts": list(result.receipts),
                "inverses": list(result.inverses)}
    if result.repairs:
        unsigned["repairs"] = list(result.repairs)
    if digest(unsigned) != result.evidence_hash:
        raise AutomationValidationError("serialized execution evidence hash is invalid")
    return result
