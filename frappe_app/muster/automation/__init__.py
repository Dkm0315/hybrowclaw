"""Governed, declarative builders for native Frappe artifacts.

The public surface deliberately separates planning from effects.  Callers first
create an :class:`ArtifactChangeSet`, inspect ``preview`` and obtain any required
approval, then pass the unchanged plan to ``apply``.
"""

from muster.automation.engine import apply, preview, rollback
from muster.automation.models import (
    ApprovalEvidence,
    ArtifactChangeSet,
    ArtifactManifest,
    ExecutionEvidence,
    GovernanceContext,
    Plan,
)

__all__ = [
    "ApprovalEvidence",
    "ArtifactChangeSet",
    "ArtifactManifest",
    "ExecutionEvidence",
    "GovernanceContext",
    "Plan",
    "apply",
    "preview",
    "rollback",
]
