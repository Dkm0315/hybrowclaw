from __future__ import annotations

import hashlib
import json
from typing import Any, Mapping

from muster.automation.models import (
    ArtifactChangeSet,
    AutomationValidationError,
    SourceEvidenceBinding,
)
from muster.orchestration.source_ingestion import requirement_is_authority_instruction


def _requirements(evidence: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    try:
        rows = json.loads(str(evidence.get("requirements_json") or ""))
    except (TypeError, ValueError) as exc:
        raise AutomationValidationError("source requirements evidence is invalid") from exc
    if not isinstance(rows, list) or not rows:
        raise AutomationValidationError("source requirements evidence is empty")
    result = {}
    for row in rows:
        citation = row.get("citation") if isinstance(row, dict) else None
        identifier = row.get("id") if isinstance(row, dict) else None
        if (
            not isinstance(identifier, str) or identifier in result
            or not isinstance(citation, dict)
            or not isinstance(citation.get("locator"), str)
            or not isinstance(citation.get("quote"), str)
        ):
            raise AutomationValidationError("source requirements evidence contains an invalid citation")
        result[identifier] = row
    return result


def source_binding(evidence: Mapping[str, Any]) -> SourceEvidenceBinding:
    return SourceEvidenceBinding.from_dict({
        "file_id": evidence.get("file"),
        "file_name": evidence.get("file_name"),
        "file_hash": evidence.get("sha256"),
        "requirements_hash": evidence.get("requirements_hash"),
        "evidence_hash": evidence.get("evidence_hash"),
    })


def _citation(evidence: Mapping[str, Any], requirement: Mapping[str, Any]) -> dict[str, str]:
    citation = requirement["citation"]
    return {
        "file_id": str(evidence["file"]),
        "requirement_id": str(requirement["id"]),
        "locator": str(citation["locator"]),
        "quote_hash": hashlib.sha256(str(citation["quote"]).encode("utf-8")).hexdigest(),
    }


def bind_artifact_citations(
    artifacts: Any, evidence: Mapping[str, Any]
) -> list[dict[str, Any]]:
    """Normalize caller-selected requirement IDs to server-derived immutable citations."""
    if not isinstance(artifacts, list) or not artifacts:
        raise AutomationValidationError("source-driven artifacts are required")
    requirements = _requirements(evidence)
    normalized = []
    for artifact in artifacts:
        if not isinstance(artifact, dict):
            raise AutomationValidationError("source-driven artifact manifest is invalid")
        raw = artifact.get("source_citations")
        if not isinstance(raw, list) or not 1 <= len(raw) <= 20:
            raise AutomationValidationError("every source-driven artifact requires 1-20 citations")
        citations = []
        seen = set()
        for supplied in raw:
            if isinstance(supplied, str):
                requirement_id = supplied
                supplied_full = None
            elif isinstance(supplied, dict):
                if set(supplied) != {"file_id", "requirement_id", "locator", "quote_hash"}:
                    raise AutomationValidationError("source citation has unknown or missing fields")
                requirement_id = supplied.get("requirement_id")
                supplied_full = supplied
            else:
                raise AutomationValidationError("source citation must select a requirement")
            requirement = requirements.get(requirement_id)
            if not requirement:
                raise AutomationValidationError("source citation does not exist in extracted evidence")
            if requirement_id in seen:
                raise AutomationValidationError("artifact source citations must be unique")
            seen.add(requirement_id)
            if requirement.get("untrusted_authority_instruction") or requirement_is_authority_instruction(
                requirement.get("requirement")
            ):
                raise AutomationValidationError(
                    "document-borne authority instructions cannot authorize an artifact"
                )
            expected = _citation(evidence, requirement)
            if supplied_full is not None and supplied_full != expected:
                if supplied_full.get("file_id") != expected["file_id"]:
                    raise AutomationValidationError("source citation refers to another file")
                raise AutomationValidationError("source citation does not match extracted evidence")
            citations.append(expected)
        normalized.append({**artifact, "source_citations": citations})
    return normalized


def validate_bound_source(change_set: ArtifactChangeSet, evidence: Mapping[str, Any]) -> None:
    binding = change_set.source_evidence
    if not binding:
        if any(artifact.source_citations for artifact in change_set.artifacts):
            raise AutomationValidationError("source citations require immutable source evidence")
        return
    if source_binding(evidence) != binding:
        raise AutomationValidationError("the cited source file or extracted evidence changed")
    requirements = _requirements(evidence)
    for artifact in change_set.artifacts:
        if not artifact.source_citations:
            raise AutomationValidationError("every source-driven artifact requires a citation")
        for citation in artifact.source_citations:
            requirement = requirements.get(citation.requirement_id)
            if not requirement:
                raise AutomationValidationError("source citation is missing from extracted evidence")
            if requirement.get("untrusted_authority_instruction") or requirement_is_authority_instruction(
                requirement.get("requirement")
            ):
                raise AutomationValidationError(
                    "document-borne authority instructions cannot authorize an artifact"
                )
            expected = _citation(evidence, requirement)
            if citation.as_dict() != expected:
                if citation.file_id != binding.file_id:
                    raise AutomationValidationError("source citation refers to another file")
                raise AutomationValidationError("source citation does not match extracted evidence")
