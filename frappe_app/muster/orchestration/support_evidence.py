from __future__ import annotations

import re
from typing import Any

import frappe


_UNKNOWN_COLUMN = re.compile(r"Unknown column ['`]?([^'`\s]+)", re.IGNORECASE)
_SECRET_LINE = re.compile(
    r"(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie)",
    re.IGNORECASE,
)


def build_support_evidence(
    scope: dict[str, Any],
    user: str,
    prompt: str,
    target_doctype: str | None = None,
) -> dict[str, Any] | None:
    """Build bounded support evidence from records the current user may read.

    The browser supplies only page context and an observed UI error. Frappe
    resolves the governing customization or report and verifies schema facts.
    """
    if not isinstance(scope, dict):
        return None
    error = _recent_error(scope)
    report = _report_evidence(scope, user, error)
    if report:
        return report
    customization = _client_script_evidence(
        target_doctype or str(scope.get("doctype") or "").strip(),
        str(scope.get("docname") or "").strip(),
        user,
        f"{prompt} {error}".strip(),
        error,
    )
    return customization


def _client_script_evidence(
    doctype: str,
    docname: str,
    user: str,
    reported_text: str,
    error: str,
) -> dict[str, Any] | None:
    if not doctype or not frappe.db.exists("DocType", doctype):
        return None
    from muster.orchestration.client_script_repair import resolve_previous_version_candidate

    candidate = resolve_previous_version_candidate(doctype, user, reported_text)
    if not candidate:
        return None
    script_name = str(candidate.get("client_script") or "").strip()
    if not script_name or not frappe.db.exists("Client Script", script_name):
        return None
    script = frappe.get_doc("Client Script", script_name)
    if not script.has_permission("read", user=user):
        return None
    source = str(script.script or "")
    line_no, line = _matching_line(source, error, ("frappe.throw", "throw new Error"))
    location = f"Client Script {script.name}"
    if line:
        location += f", line {line_no}: {line}"
    affected = [{"label": doctype, "doctype": doctype, "name": docname}] if docname else []
    affected.append({"label": "Active form validation", "doctype": "Client Script", "name": script.name})
    observed = error or f"The active validation in {script.name} blocked the reported Save."
    return {
        "expected": f"The approved {doctype} business state saves under the user's current Frappe permissions.",
        "observed": observed,
        "businessImpact": f"The {doctype} workflow is blocked even though the user reached an otherwise permitted business state.",
        "likelyLocations": [location],
        "affectedRecords": affected,
        "reproduction": [
            f"Open {doctype} {docname}." if docname else f"Open the affected {doctype} record.",
            "Repeat the same Save under the reporter's own permissions.",
            f"Observe the validation error: {observed}",
        ],
        "validation": [
            f"Frappe verified that Client Script {script.name} is enabled for the {doctype} form.",
            "The script and affected record were read under the reporting user's permissions.",
        ],
        "errorEvidence": [
            observed,
            *( [f"{script.name} line {line_no}: {line}"] if line else [] ),
        ],
        "evidenceIds": [
            f"client-script:{script.name}",
            f"client-script-version:{candidate.get('version')}",
            f"client-script-live-hash:{candidate.get('live_hash')}",
        ],
    }


def _report_evidence(scope: dict[str, Any], user: str, error: str) -> dict[str, Any] | None:
    name = _report_name(scope)
    if not name or not frappe.db.exists("Report", name):
        return None
    report = frappe.get_doc("Report", name)
    if not report.has_permission("read", user=user):
        return None
    source = str(report.get("query") or report.get("javascript") or "")
    column = _unknown_column(error)
    hints = tuple(value for value in (column, "legacy_", "old_") if value)
    line_no, line = _matching_line(source, error, hints)
    location = f"Report {report.name}"
    if line:
        location += f", query line {line_no}: {line}"
    field_absent = bool(column and not frappe.get_meta(report.ref_doctype).has_field(column))
    observed = error or f"The report query references {column or 'a field'} that the current schema cannot resolve."
    validation = [
        f"Frappe read Report {report.name} and its query under the reporting user's permissions.",
        f"The report is a {report.report_type} for {report.ref_doctype}.",
    ]
    if column:
        validation.append(
            f"Field {column} is absent from the live {report.ref_doctype} schema."
            if field_absent else
            f"Field {column} exists in the live schema; support must inspect the query execution boundary."
        )
    return {
        "expected": f"Report {report.name} opens against the live {report.ref_doctype} schema after migration.",
        "observed": observed,
        "businessImpact": "The engineering readiness report cannot be used after the application migration.",
        "likelyLocations": [location, f"Report target schema: {report.ref_doctype}"],
        "affectedRecords": [{"label": "Affected report", "doctype": "Report", "name": report.name}],
        "reproduction": [
            f"Open query report {report.name} under the reporter's own permissions.",
            "Run the report without changing its filters.",
            f"Observe the database error: {observed}",
        ],
        "validation": validation,
        "errorEvidence": [
            observed,
            *( [f"{report.name} query line {line_no}: {line}"] if line else [] ),
        ],
        "evidenceIds": [f"report:{report.name}", f"schema:{report.ref_doctype}:{column or 'unresolved-field'}"],
    }


def _report_name(scope: dict[str, Any]) -> str:
    if str(scope.get("doctype") or "").strip() == "Report":
        return str(scope.get("docname") or "").strip()
    route = str(scope.get("route") or "").strip()
    page_type = str(scope.get("page_type") or "").strip().casefold()
    page_name = str(scope.get("page_name") or "").strip()
    if page_type in {"query-report", "report"}:
        return page_name
    marker = "query-report/"
    return route.split(marker, 1)[1].split("/", 1)[0] if marker in route else ""


def _recent_error(scope: dict[str, Any]) -> str:
    row = scope.get("recent_ui_error")
    if not isinstance(row, dict):
        return ""
    title = str(row.get("title") or "").strip()
    message = str(row.get("message") or "").strip()
    value = " ".join(part for part in (title, message) if part)
    return value[:1_000]


def _unknown_column(error: str) -> str:
    match = _UNKNOWN_COLUMN.search(error)
    if not match:
        return ""
    return match.group(1).split(".")[-1].strip("`'")[:140]


def _matching_line(source: str, error: str, hints: tuple[str, ...]) -> tuple[int, str]:
    error_tokens = {token for token in re.findall(r"[a-z0-9_]+", error.casefold()) if len(token) >= 5}
    best: tuple[int, str, int] | None = None
    for index, raw in enumerate(source.splitlines(), start=1):
        line = raw.strip()
        if not line or _SECRET_LINE.search(line):
            continue
        score = sum(4 for hint in hints if hint and hint.casefold() in line.casefold())
        score += len(error_tokens & set(re.findall(r"[a-z0-9_]+", line.casefold())))
        if best is None or score > best[2]:
            best = (index, line[:500], score)
    return (best[0], best[1]) if best and best[2] > 0 else (0, "")
