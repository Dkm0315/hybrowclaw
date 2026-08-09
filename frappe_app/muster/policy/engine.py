from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable


@dataclass(frozen=True)
class Decision:
    allowed: bool
    reason: str
    approval_required: bool = False


def evaluate(
    *,
    capabilities: Iterable[str],
    requested: str,
    frappe_allowed: bool,
    explicitly_denied: Iterable[str] = (),
) -> Decision:
    """A pure, testable deny-by-default intersection; DB policy loading stays outside."""
    capabilities = set(capabilities)
    denied = set(explicitly_denied)
    if requested in denied or "*" in denied:
        return Decision(False, "explicitly-denied")
    if not frappe_allowed:
        return Decision(False, "frappe-permission-denied")
    if requested not in capabilities and "*" not in capabilities:
        return Decision(False, "capability-not-granted")
    return Decision(True, "granted")
