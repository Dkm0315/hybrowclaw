from __future__ import annotations

import hashlib
import json
import re
import time
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

import frappe
from frappe import _
from frappe.model import get_permitted_fields

READ_PLANS_PATH = "/v1/integrations/frappe/read-plans"
MAX_CATALOG_DOCTYPES = 24
MAX_FIELDS = 12
MAX_FILTERS = 12
MAX_ROWS = 100
MAX_EVIDENCE_BYTES = 24_000
MAX_QUERY_SECONDS = 5.0
_FIELD = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,139}$")
_SECRET = re.compile(r"(?:password|passwd|secret|api[_-]?key|token|authorization|cookie|private[_-]?key|salt)", re.I)
_EXECUTABLE = re.compile(r"(?:^|_)(?:script|javascript|query|template|condition)(?:$|_)", re.I)
_OPERATORS = {"=", "!=", "<", "<=", ">", ">=", "in", "not in", "between", "like", "is"}
_AGGREGATES = {"count", "sum", "avg", "min", "max"}
_STRUCTURAL = {"Button", "Column Break", "Fold", "Heading", "HTML", "Section Break", "Tab Break", "Table", "Table MultiSelect"}
_NUMERIC = {"Currency", "Float", "Int", "Percent", "Duration"}
_COUNT_REQUEST = re.compile(r"\b(?:how many|count(?:\s+of)?|number of|total number of)\b", re.I)
_QUESTION_STOP_WORDS = {
    "affected", "and", "are", "before", "but", "can", "changed", "check", "continue",
    "correction", "could", "demo", "fix", "for", "from",
    "happened", "has", "have", "how", "last", "not", "old", "please", "showing",
    "records", "still", "that", "the", "this", "was", "week", "what", "when", "where", "which",
    "why", "with", "would", "you", "your",
}


class FrappeReadPlanError(frappe.ValidationError):
    pass


def build_read_catalog(question: str, scope: dict[str, Any], user: str) -> list[dict[str, Any]]:
    """Expose only schema the current user can read; never rows or permission internals."""
    if (frappe.session.user or "").lower() != user.lower():
        raise FrappeReadPlanError(_("Read catalog actor does not match the current session"))
    words = {
        word.lower() for word in re.findall(r"[A-Za-z0-9]+", question)
        if len(word) >= 3 and word.lower() not in _QUESTION_STOP_WORDS
    }
    selected = str(scope.get("doctype") or "").strip()
    # Frappe v16's get_user() is deliberately session-bound and accepts no
    # username argument. The explicit equality check above prevents a caller
    # from using this catalog as a cross-user permission oracle.
    readable = set(frappe.get_user().get_can_read() or [])
    candidates: list[tuple[int, str]] = []
    for doctype in readable:
        if not isinstance(doctype, str) or len(doctype) > 140 or not frappe.db.exists("DocType", doctype):
            continue
        # Harness control records have dedicated commands and dashboards. They
        # must not crowd business retrieval merely because a customer record
        # identifier happens to contain the word "Muster".
        if doctype.startswith("Muster "):
            continue
        meta = frappe.get_meta(doctype)
        if meta.istable:
            continue
        tokens = {word.lower() for word in re.findall(r"[A-Za-z0-9]+", f"{doctype} {meta.module or ''}") if len(word) >= 3}
        field_tokens = {
            word.lower()
            for field in meta.fields
            if field.fieldtype not in {"Password", "Code"} and not _SECRET.search(field.fieldname or "")
            for word in re.findall(r"[A-Za-z0-9]+", f"{field.fieldname or ''} {field.label or ''}")
            if len(word) >= 3
        }
        score = (100 if doctype == selected else 0) + 10 * len(words & tokens) + 3 * len(words & field_tokens)
        if score:
            candidates.append((score, doctype))
    candidates.sort(key=lambda row: (-row[0], row[1]))
    catalog: list[dict[str, Any]] = []
    for _score, doctype in candidates[:MAX_CATALOG_DOCTYPES]:
        permitted = set(get_permitted_fields(doctype, user=user, permission_type="read"))
        permitted.add("name")
        meta = frappe.get_meta(doctype)
        fields: list[tuple[int, str]] = []
        for fieldname in sorted(permitted):
            if not _FIELD.fullmatch(fieldname) or _SECRET.search(fieldname) or _EXECUTABLE.search(fieldname):
                continue
            field = meta.get_field(fieldname)
            if field and (field.fieldtype in _STRUCTURAL or field.fieldtype in {"Password", "Code"}):
                continue
            field_tokens = {word.lower() for word in re.findall(r"[A-Za-z0-9]+", f"{fieldname} {getattr(field, 'label', '') if field else ''}") if len(word) >= 3}
            common = fieldname in {"name", "title", "subject", "status", "company", "customer", "supplier", "employee", "posting_date", "transaction_date", "due_date", "modified"}
            fields.append((10 * len(words & field_tokens) + (5 if common else 0), fieldname))
        if fields:
            fields.sort(key=lambda row: (-row[0], row[1]))
            catalog.append({"doctype": doctype, "fields": [fieldname for _score, fieldname in fields[:24]]})
    return catalog


def deterministic_count_plan(
    question: str, catalog: list[dict[str, Any]], request_id: str,
) -> dict[str, Any] | None:
    """Compile an unambiguous count locally from the host-filtered catalog.

    This avoids spending a model turn on the common ``how many Customers``
    case. Only a filter-free whole-site grammar is admitted; qualifiers or a
    second requested action fall back to the governed planner.
    """
    if not isinstance(question, str) or not _COUNT_REQUEST.search(question):
        return None

    doctypes = [row.get("doctype") for row in catalog if isinstance(row, dict)]
    selected = _exact_count_doctypes(question, doctypes)
    if len(selected) != 1:
        return None
    return {
        "schemaVersion": 1,
        "requestId": request_id,
        "disposition": "query",
        "reason": _("A fresh permission-filtered count is required."),
        "queries": [{
            "doctype": selected[0], "fields": [], "filters": [],
            "aggregate": {"function": "count"}, "orderBy": [], "limit": 1,
        }],
    }


def deterministic_count_catalog(question: str, user: str) -> list[dict[str, Any]]:
    """Resolve one exact count target without materializing the broad catalog."""
    if (frappe.session.user or "").lower() != user.lower():
        raise FrappeReadPlanError(_("Read catalog actor does not match the current session"))
    selected = _exact_count_doctypes(question, frappe.get_user().get_can_read() or [])
    if len(selected) != 1:
        return []
    doctype = selected[0]
    if (
        not frappe.db.exists("DocType", doctype)
        or frappe.get_meta(doctype).istable
        or not frappe.has_permission(doctype, "read", user=user)
    ):
        return []
    return [{"doctype": doctype, "fields": ["name"]}]


def _exact_count_doctypes(question: str, doctypes: Any) -> list[str]:
    if not isinstance(question, str) or not _COUNT_REQUEST.search(question):
        return []
    normalized = re.sub(r"\s+", " ", question.strip())
    candidates = []
    for doctype in doctypes:
        if not isinstance(doctype, str) or not doctype or len(doctype) > 140:
            continue
        noun = re.escape(doctype).replace(r"\ ", r"\s+") + "s?"
        pattern = re.compile(
            rf"^(?:how many\s+{noun}(?:\s+(?:are\s+)?(?:there|in (?:this|the) site)|\s+does (?:this|the) site have)?"
            rf"|(?:count(?:\s+of)?|number of|total number of)\s+{noun})"
            rf"[?.]?(?:\s+Answer with the count and what you checked[?.]?)?$",
            re.I,
        )
        if pattern.fullmatch(normalized):
            candidates.append(doctype)
    return sorted(set(candidates))


def execute_read_plan(plan: Any, request_id: str, user: str) -> dict[str, Any]:
    """Independently admit and execute a provider-authored Read IR as the live actor.

    `frappe.get_list` is intentional: unlike `get_all` or raw SQL it applies
    permission query conditions, shares, and user permissions for this session.
    """
    value = _exact(plan, {"schemaVersion", "requestId", "disposition", "reason", "queries"}, "read plan")
    if value["schemaVersion"] != 1 or value["requestId"] != request_id:
        raise FrappeReadPlanError(_("Read plan identity does not match this request"))
    if value["disposition"] != "query" or not isinstance(value["reason"], str) or not value["reason"].strip() or len(value["reason"]) > 500:
        raise FrappeReadPlanError(_("Read plan disposition is invalid"))
    queries = value["queries"]
    if not isinstance(queries, list) or not 1 <= len(queries) <= 4:
        raise FrappeReadPlanError(_("Read plan query count is invalid"))
    if (frappe.session.user or "").lower() != user.lower():
        raise FrappeReadPlanError(_("Read plan actor does not match the current session"))
    started = time.monotonic()
    evidence = [_execute_query(query, user) for query in queries]
    elapsed_ms = round((time.monotonic() - started) * 1000)
    if elapsed_ms > MAX_QUERY_SECONDS * 1000:
        raise FrappeReadPlanError(_("The permission-filtered read exceeded its safe time budget"))
    result = {
        "schemaVersion": 1,
        "kind": "fresh_permission_filtered_frappe_evidence",
        "requestId": request_id,
        "actor": user,
        "executedAt": datetime.now(UTC).isoformat(),
        "permissionFiltered": True,
        "queryHash": _hash(value),
        "elapsedMs": elapsed_ms,
        "queries": evidence,
    }
    encoded = _canonical(result).encode()
    while len(encoded) > MAX_EVIDENCE_BYTES:
        row_query = next((item for item in reversed(evidence) if item.get("rows")), None)
        if not row_query:
            raise FrappeReadPlanError(_("Permission-filtered evidence exceeded its safe size limit"))
        row_query["rows"].pop()
        row_query["returnedRows"] = len(row_query["rows"])
        row_query["truncated"] = True
        encoded = _canonical(result).encode()
    return result


def merge_read_evidence(context: dict[str, Any], evidence: dict[str, Any]) -> dict[str, Any]:
    existing: dict[str, Any] = {}
    if context.get("summary"):
        try:
            parsed = json.loads(context["summary"])
            if isinstance(parsed, dict):
                existing = parsed
        except (TypeError, ValueError):
            existing = {}
    summary = _canonical({**existing, "readEvidence": evidence})
    if len(summary.encode()) > 32_000:
        raise FrappeReadPlanError(_("Permission-filtered answer context exceeded its safe size limit"))
    return {**context, "summary": summary}


def _execute_query(value: Any, user: str) -> dict[str, Any]:
    query = _exact(value, {"doctype", "fields", "filters", "aggregate", "orderBy", "limit"}, "read query", optional={"aggregate"})
    doctype = _text(query["doctype"], "DocType", 140)
    if not frappe.db.exists("DocType", doctype):
        raise FrappeReadPlanError(_("Requested information is unavailable"))
    meta = frappe.get_meta(doctype)
    if meta.istable or not frappe.has_permission(doctype, "read", user=user):
        raise frappe.PermissionError(_("Requested information is unavailable under your current access"))
    permitted = set(get_permitted_fields(doctype, user=user, permission_type="read"))
    permitted.add("name")
    fields = _fields(query["fields"], permitted, meta)
    filters = _filters(query["filters"], permitted, meta)
    order_by = _order_by(query["orderBy"], permitted, meta)
    limit = query["limit"]
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= MAX_ROWS:
        raise FrappeReadPlanError(_("Read row limit is invalid"))
    aggregate = query.get("aggregate")
    if meta.issingle:
        if filters:
            raise FrappeReadPlanError(_("Single-value settings cannot use list filters"))
        if aggregate is not None:
            fn, fieldname = _aggregate(aggregate, permitted, meta)
            if fn != "count" or fieldname:
                raise FrappeReadPlanError(_("Single-value settings support only a record count"))
            return {
                "doctype": doctype,
                "mode": "aggregate",
                "aggregate": "count",
                "value": 1,
                "returnedRows": 1,
                "truncated": False,
            }
        if not fields:
            raise FrappeReadPlanError(_("A settings read requires at least one permitted field"))
        document = frappe.get_single(doctype)
        document.check_permission("read")
        row = {
            field: _scalar(doctype if field == "name" else document.get(field))
            for field in fields
            if field == "name" or document.get(field) is not None
        }
        return {
            "doctype": doctype,
            "mode": "list",
            "fields": fields,
            "rows": [row],
            "returnedRows": 1,
            "truncated": False,
        }
    if aggregate is not None:
        estimator = getattr(frappe.db, "estimate_count", None)
        estimated_rows = estimator(doctype) if callable(estimator) else None
        if not filters and isinstance(estimated_rows, int | float) and estimated_rows > 100_000:
            raise FrappeReadPlanError(_("This unfiltered aggregate would scan too many records; add a business filter"))
        fn, fieldname = _aggregate(aggregate, permitted, meta)
        # Frappe v16 rejects SQL functions embedded in strings.  The structured
        # function form is both parser-safe and forward-compatible with the
        # query builder while preserving permission query conditions applied by
        # ``frappe.get_list``.
        expression = {fn.upper(): fieldname or "name", "as": "value"}
        rows = frappe.get_list(doctype, fields=[expression], filters=filters, page_length=1)
        scalar = rows[0].get("value") if rows else None
        return {
            "doctype": doctype,
            "mode": "aggregate",
            "aggregate": fn,
            **({"field": fieldname} if fieldname else {}),
            "value": _scalar(scalar),
            "returnedRows": 1 if rows else 0,
            "truncated": False,
        }
    if not fields:
        raise FrappeReadPlanError(_("A list read requires at least one permitted field"))
    rows = frappe.get_list(
        doctype,
        fields=fields,
        filters=filters,
        order_by=order_by or None,
        start=0,
        page_length=limit,
    )
    safe_rows = [{field: _scalar(row.get(field)) for field in fields if row.get(field) is not None} for row in rows]
    return {
        "doctype": doctype,
        "mode": "list",
        "fields": fields,
        "rows": safe_rows,
        "returnedRows": len(safe_rows),
        "truncated": len(safe_rows) == limit,
    }


def _fields(value: Any, permitted: set[str], meta) -> list[str]:
    if not isinstance(value, list) or len(value) > MAX_FIELDS:
        raise FrappeReadPlanError(_("Read fields are invalid"))
    result = []
    for item in value:
        fieldname = _field(item, permitted, meta)
        if fieldname not in result:
            result.append(fieldname)
    return result


def _field(value: Any, permitted: set[str], meta) -> str:
    fieldname = _text(value, "field", 140)
    field = meta.get_field(fieldname)
    if not _FIELD.fullmatch(fieldname) or fieldname not in permitted or _SECRET.search(fieldname):
        raise frappe.PermissionError(_("Requested field is unavailable under your current access"))
    if field and (field.fieldtype in _STRUCTURAL or field.fieldtype == "Password"):
        raise frappe.PermissionError(_("Requested field is unavailable under your current access"))
    return fieldname


def _filters(value: Any, permitted: set[str], meta) -> list[list[Any]]:
    if not isinstance(value, list) or len(value) > MAX_FILTERS:
        raise FrappeReadPlanError(_("Read filters are invalid"))
    result = []
    for item in value:
        row = _exact(item, {"field", "operator", "value"}, "read filter")
        fieldname = _field(row["field"], permitted, meta)
        operator = row["operator"]
        if operator not in _OPERATORS:
            raise FrappeReadPlanError(_("Read filter operator is invalid"))
        filter_value = _filter_value(row["value"], operator)
        result.append([fieldname, operator, filter_value])
    return result


def _filter_value(value: Any, operator: str) -> Any:
    if isinstance(value, list):
        if operator not in {"in", "not in", "between"} or not 1 <= len(value) <= 50 or (operator == "between" and len(value) != 2):
            raise FrappeReadPlanError(_("Read filter value is invalid"))
        return [_bounded_scalar(item) for item in value]
    if operator in {"in", "not in", "between"}:
        raise FrappeReadPlanError(_("Read filter value is invalid"))
    scalar = _bounded_scalar(value, allow_none=True)
    if operator == "like" and (not isinstance(scalar, str) or scalar.startswith("%") or not scalar.endswith("%") or "%" in scalar[:-1]):
        raise FrappeReadPlanError(_("Text search is restricted to a prefix match"))
    if operator == "is" and str(scalar).lower() not in {"set", "not set"}:
        raise FrappeReadPlanError(_("The is operator only accepts set or not set"))
    return scalar


def _order_by(value: Any, permitted: set[str], meta) -> str:
    if not isinstance(value, list) or len(value) > 2:
        raise FrappeReadPlanError(_("Read ordering is invalid"))
    parts = []
    for item in value:
        row = _exact(item, {"field", "direction"}, "read ordering")
        fieldname = _field(row["field"], permitted, meta)
        if row["direction"] not in {"asc", "desc"}:
            raise FrappeReadPlanError(_("Read ordering direction is invalid"))
        parts.append(f"{fieldname} {row['direction']}")
    return ", ".join(parts)


def _aggregate(value: Any, permitted: set[str], meta) -> tuple[str, str | None]:
    row = _exact(value, {"function", "field"}, "read aggregate", optional={"field"})
    fn = row["function"]
    if fn not in _AGGREGATES:
        raise FrappeReadPlanError(_("Read aggregate is invalid"))
    fieldname = _field(row["field"], permitted, meta) if row.get("field") else None
    if fn != "count":
        field = meta.get_field(fieldname)
        if not field or field.fieldtype not in _NUMERIC:
            raise FrappeReadPlanError(_("This aggregate requires a permitted numeric field"))
    return fn, fieldname


def _exact(value: Any, keys: set[str], label: str, optional: set[str] | None = None) -> dict[str, Any]:
    optional = optional or set()
    if not isinstance(value, dict) or not (keys - optional).issubset(value) or not set(value).issubset(keys):
        raise FrappeReadPlanError(_("{0} has unknown or missing fields").format(label))
    return value


def _text(value: Any, label: str, maximum: int) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum or any(ord(char) < 32 for char in value):
        raise FrappeReadPlanError(_("{0} is invalid").format(label))
    return value.strip()


def _bounded_scalar(value: Any, allow_none: bool = False) -> Any:
    if value is None and allow_none:
        return None
    if isinstance(value, bool | int | float) and not isinstance(value, complex):
        return value
    if isinstance(value, str) and len(value) <= 500:
        return value
    raise FrappeReadPlanError(_("Read filter value is invalid"))


def _scalar(value: Any) -> Any:
    if value is None or isinstance(value, bool | int | float | str):
        return value if not isinstance(value, str) else value[:4_000]
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, datetime | date):
        return value.isoformat()
    return str(value)[:4_000]


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _hash(value: Any) -> str:
    return hashlib.sha256(_canonical(value).encode()).hexdigest()
