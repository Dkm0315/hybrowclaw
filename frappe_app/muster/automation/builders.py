from __future__ import annotations

import ast
import html
import json
import re
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Protocol

from muster.automation.models import ArtifactManifest, AutomationValidationError


_IDENTIFIER = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")
_FIELDNAME = re.compile(r"^[a-z][a-z0-9_]{0,139}$")
_DOCTYPE_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9 _-]{0,139}$")
_SCRIPTISH = re.compile(
    r"(?is)<\s*script\b|javascript\s*:|\bon[a-z]+\s*=|<\s*(?:iframe|object|embed|link|meta)\b"
)
_JINJA = re.compile(r"{{\s*doc\.([a-z][a-z0-9_]*)\s*}}")
_ANY_TEMPLATE = re.compile(r"({[{%#].*?[}%#]})", re.S)


@dataclass(frozen=True)
class ArtifactDefinition:
    doctype: str
    name: str
    values: dict[str, Any]
    capability: str
    approval_class: str
    governed_permissions: tuple[tuple[str, str], ...] = ()
    verify_only: bool = False


class TrustedResolver(Protocol):
    def resolve_trusted_artifact(self, kind: str, key: str) -> Mapping[str, Any]: ...


def _only(values: Mapping[str, Any], allowed: set[str], kind: str) -> None:
    unknown = set(values) - allowed
    if unknown:
        raise AutomationValidationError(
            f"{kind} contains unsupported fields: {', '.join(sorted(unknown))}"
        )
    if any(str(key).startswith("_") for key in values):
        raise AutomationValidationError(f"{kind} contains a reserved field")


def _required(values: Mapping[str, Any], *names: str) -> None:
    missing = [name for name in names if values.get(name) in (None, "", [])]
    if missing:
        raise AutomationValidationError(f"required values are missing: {', '.join(missing)}")


def _flag(value: Any, label: str) -> int:
    if value in (0, 1, False, True):
        return int(bool(value))
    raise AutomationValidationError(f"{label} must be a boolean")


def _safe_static_html(value: str, *, allow_doc_fields: bool = False) -> str:
    if len(value.encode("utf-8")) > 128_000:
        raise AutomationValidationError("HTML exceeds 128 KB")
    if _SCRIPTISH.search(value):
        raise AutomationValidationError("active HTML content is not permitted")
    if allow_doc_fields:
        for match in _JINJA.finditer(value):
            if value.rfind("<", 0, match.start()) > value.rfind(">", 0, match.start()):
                raise AutomationValidationError("document placeholders are not permitted in HTML tags")
        without_safe_fields = _JINJA.sub("", value)
        if _ANY_TEMPLATE.search(without_safe_fields):
            raise AutomationValidationError("only simple {{ doc.fieldname }} placeholders are permitted")
    elif _ANY_TEMPLATE.search(value):
        raise AutomationValidationError("template expressions are not permitted on this surface")
    return value


def _route(value: Any) -> str:
    route = str(value)
    if (len(route) > 140 or not re.fullmatch(r"[a-z0-9][a-z0-9_/-]*", route)
            or "//" in route or ".." in route):
        raise AutomationValidationError("route is invalid")
    return route


def _roles(value: Any) -> list[dict[str, str]]:
    roles = value or []
    if (not isinstance(roles, list) or len(roles) > 50 or
            any(not isinstance(row, dict) or set(row) != {"role"} or
                not isinstance(row["role"], str) or not row["role"] for row in roles)):
        raise AutomationValidationError("roles must be [{\"role\": \"Role Name\"}]")
    return [dict(row) for row in roles]


def _safe_expression(value: Any, label: str, *, required: bool = False) -> str:
    expression = str(value or "").strip()
    if not expression:
        if required:
            raise AutomationValidationError(f"{label} is required")
        return ""
    if len(expression) > 2_000:
        raise AutomationValidationError(f"{label} exceeds 2 KB")
    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError as exc:
        raise AutomationValidationError(f"{label} is not a valid expression") from exc
    allowed = (
        ast.Expression, ast.BoolOp, ast.And, ast.Or, ast.UnaryOp, ast.Not,
        ast.Compare, ast.Eq, ast.NotEq, ast.Gt, ast.GtE, ast.Lt, ast.LtE,
        ast.In, ast.NotIn, ast.Is, ast.IsNot, ast.Name, ast.Load,
        ast.Constant, ast.List, ast.Tuple, ast.Set,
    )
    for node in ast.walk(tree):
        if not isinstance(node, allowed):
            raise AutomationValidationError(
                f"{label} permits only field comparisons and boolean operators"
            )
        if isinstance(node, ast.Name) and not _FIELDNAME.fullmatch(node.id):
            raise AutomationValidationError(f"{label} contains an invalid fieldname")
    return expression


def _workspace_content(value: Any) -> str:
    if not isinstance(value, list) or len(value) > 100:
        raise AutomationValidationError("workspace content must be a list with at most 100 blocks")
    allowed_types = {"header", "card", "shortcut", "chart", "number_card", "spacer", "quick_list", "onboarding"}
    for index, block in enumerate(value):
        if not isinstance(block, dict) or set(block) - {"id", "type", "data", "width"}:
            raise AutomationValidationError(f"workspace content block {index} is invalid")
        if block.get("type") not in allowed_types:
            raise AutomationValidationError(f"workspace content block {index} has an unsupported type")
        if not isinstance(block.get("id"), str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", block["id"]):
            raise AutomationValidationError(f"workspace content block {index} has an invalid id")
        if "width" in block and (not isinstance(block["width"], int) or not 1 <= block["width"] <= 12):
            raise AutomationValidationError(f"workspace content block {index} has an invalid width")
        if not isinstance(block.get("data", {}), dict) or len(block.get("data", {})) > 30:
            raise AutomationValidationError(f"workspace content block {index} has invalid data")
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    if len(encoded.encode("utf-8")) > 128_000 or _SCRIPTISH.search(encoded) or _ANY_TEMPLATE.search(encoded):
        raise AutomationValidationError("workspace content contains active or oversized data")
    return encoded


def _custom_field(m: ArtifactManifest, _resolver: TrustedResolver) -> ArtifactDefinition:
    if not m.target_doctype:
        raise AutomationValidationError("custom_field requires target_doctype")
    values = dict(m.values)
    _only(values, {
        "label", "fieldtype", "options", "insert_after", "description", "default",
        "reqd", "unique", "read_only", "hidden", "in_list_view", "in_standard_filter",
        "allow_on_submit", "depends_on", "mandatory_depends_on", "read_only_depends_on",
        "collapsible", "collapsible_depends_on", "width", "precision", "length",
        "fetch_from", "fetch_if_empty", "translatable", "no_copy",
    }, m.kind)
    if not _FIELDNAME.fullmatch(m.target_name):
        raise AutomationValidationError("custom field target_name must be a snake_case fieldname")
    _required(values, "label", "fieldtype")
    fieldtype = str(values["fieldtype"])
    if fieldtype in {"Password", "Code"}:
        raise AutomationValidationError("Password and executable Code custom fields require app code review")
    for name in {"reqd", "unique", "read_only", "hidden", "in_list_view", "in_standard_filter",
                 "allow_on_submit", "fetch_if_empty", "translatable", "no_copy"} & set(values):
        values[name] = _flag(values[name], name)
    for dependency_name in {"depends_on", "mandatory_depends_on", "read_only_depends_on"} & set(values):
        dependency = str(values[dependency_name])
        if dependency.startswith("eval:") or not _FIELDNAME.fullmatch(dependency):
            raise AutomationValidationError("executable custom field dependencies are not permitted")
    values.update({"dt": m.target_doctype, "fieldname": m.target_name})
    return ArtifactDefinition("Custom Field", f"{m.target_doctype}-{m.target_name}", values,
                              "artifact.custom_field.write", "Standard", ((m.target_doctype, "write"),))


def _property_setter(m: ArtifactManifest, _resolver: TrustedResolver) -> ArtifactDefinition:
    if not m.target_doctype:
        raise AutomationValidationError("property_setter requires target_doctype")
    values = dict(m.values)
    _only(values, {"field_name", "property", "value", "property_type", "doctype_or_field"}, m.kind)
    _required(values, "property", "value", "property_type")
    if isinstance(values["value"], (dict, list)):
        raise AutomationValidationError("Property Setter value must be a scalar")
    if values["property_type"] not in {"Data", "Check", "Int", "Float", "Text", "Select"}:
        raise AutomationValidationError("Property Setter property_type is not allowed")
    field_name = str(values.get("field_name") or "")
    if field_name and not _FIELDNAME.fullmatch(field_name):
        raise AutomationValidationError("field_name is invalid")
    property_name = str(values["property"])
    if not _FIELDNAME.fullmatch(property_name):
        raise AutomationValidationError("property is invalid")
    field_properties = {
        "label", "reqd", "hidden", "read_only", "in_list_view", "in_standard_filter",
        "allow_on_submit", "no_copy", "precision", "length", "width", "translatable",
        "unique", "search_index", "bold", "print_hide",
    }
    doctype_properties = {"title_field", "search_fields", "sort_field", "sort_order", "track_changes"}
    expected_surface = "DocField" if field_name else "DocType"
    if property_name not in (field_properties if field_name else doctype_properties):
        raise AutomationValidationError("property is not allowed on the governed metadata path")
    if values.get("doctype_or_field") not in {None, expected_surface}:
        raise AutomationValidationError("doctype_or_field does not match field_name")
    if property_name in {"depends_on", "mandatory_depends_on", "read_only_depends_on"}:
        dependency = str(values["value"])
        if dependency.startswith("eval:") or not re.fullmatch(r"[a-z][a-z0-9_]*", dependency):
            raise AutomationValidationError("executable property dependencies are not permitted")
    values.update({
        "doc_type": m.target_doctype, "field_name": field_name,
        "doctype_or_field": expected_surface,
    })
    name = "-".join(part for part in (m.target_doctype, field_name, property_name) if part)
    return ArtifactDefinition("Property Setter", name, values, "artifact.property_setter.write",
                              "Sensitive", ((m.target_doctype, "write"),))


_DOCFIELD_KEYS = {
    "fieldname", "label", "fieldtype", "options", "reqd", "unique", "read_only", "hidden",
    "in_list_view", "in_standard_filter", "description", "default", "insert_after", "depends_on",
    "mandatory_depends_on", "read_only_depends_on", "allow_on_submit", "no_copy", "precision",
    "length", "width", "collapsible", "collapsible_depends_on", "fetch_from", "fetch_if_empty",
}


def _doctype(m: ArtifactManifest, _resolver: TrustedResolver) -> ArtifactDefinition:
    values = dict(m.values)
    _only(values, {"fields", "permissions", "istable", "issingle", "is_submittable", "track_changes",
                   "autoname", "title_field", "search_fields", "sort_field", "sort_order", "description"}, m.kind)
    if not m.module:
        raise AutomationValidationError("doctype requires module")
    fields = values.get("fields") or []
    if not isinstance(fields, list) or not fields or len(fields) > 200:
        raise AutomationValidationError("doctype fields must contain 1-200 field definitions")
    seen: set[str] = set()
    clean_fields = []
    for index, field in enumerate(fields):
        if not isinstance(field, dict):
            raise AutomationValidationError(f"fields[{index}] must be an object")
        _only(field, _DOCFIELD_KEYS, f"fields[{index}]")
        _required(field, "fieldname", "label", "fieldtype")
        fieldname = str(field["fieldname"])
        if not _FIELDNAME.fullmatch(fieldname) or fieldname in seen:
            raise AutomationValidationError(f"fields[{index}].fieldname is invalid or duplicated")
        if field["fieldtype"] in {"Code", "Password"}:
            raise AutomationValidationError("Code and Password fields require app-level review")
        seen.add(fieldname)
        for dependency_name in {"depends_on", "mandatory_depends_on", "read_only_depends_on"}:
            if dependency_name in field:
                dependency = str(field[dependency_name])
                if dependency.startswith("eval:") or not re.fullmatch(r"[a-z][a-z0-9_]*", dependency):
                    raise AutomationValidationError("executable field dependencies are not permitted")
        clean_fields.append(dict(field))
    permissions = values.get("permissions") or []
    if not isinstance(permissions, list) or len(permissions) > 50:
        raise AutomationValidationError("permissions must be a list with at most 50 rows")
    allowed_perm = {"role", "read", "write", "create", "delete", "submit", "cancel", "amend", "report", "export", "print", "email", "share", "if_owner", "permlevel"}
    clean_permissions = []
    for row in permissions:
        if not isinstance(row, dict):
            raise AutomationValidationError("permission rows must be objects")
        _only(row, allowed_perm, "doctype permission")
        _required(row, "role")
        clean_permissions.append(dict(row))
    for flag in {"istable", "issingle", "is_submittable", "track_changes"} & set(values):
        values[flag] = _flag(values[flag], flag)
    values.update({"name": m.target_name, "module": m.module, "custom": 1,
                   "fields": clean_fields, "permissions": clean_permissions})
    return ArtifactDefinition("DocType", m.target_name, values, "artifact.doctype.write", "Sensitive")


def _page(m: ArtifactManifest, _resolver: TrustedResolver) -> ArtifactDefinition:
    values = dict(m.values)
    _only(values, {"title", "icon", "restrict_to_domain", "roles"}, m.kind)
    if not m.module:
        raise AutomationValidationError("page requires module")
    roles = _roles(values.get("roles"))
    values.update({"page_name": m.target_name, "name": m.target_name, "module": m.module,
                   "title": values.get("title") or m.target_name, "standard": "No", "roles": roles})
    return ArtifactDefinition("Page", m.target_name, values, "artifact.page.write", "Sensitive")


def _workspace(m: ArtifactManifest, _resolver: TrustedResolver) -> ArtifactDefinition:
    values = dict(m.values)
    _only(values, {
        "title", "icon", "public", "is_hidden", "hide_custom", "content", "roles",
        "parent_page", "restrict_to_domain", "indicator_color", "sequence_id",
    }, m.kind)
    if not m.module:
        raise AutomationValidationError("workspace requires module")
    title = str(values.get("title") or m.target_name).strip()
    if (not title or len(title) > 140 or "<" in title or ">" in title
            or any(ord(character) < 32 for character in title)):
        raise AutomationValidationError("workspace title is invalid")
    indicator = values.get("indicator_color")
    if indicator not in {None, "green", "cyan", "blue", "orange", "yellow", "gray", "grey", "red", "pink", "darkgrey", "purple", "light-blue"}:
        raise AutomationValidationError("workspace indicator_color is invalid")
    sequence = float(values.get("sequence_id") or 0)
    if not 0 <= sequence <= 100_000:
        raise AutomationValidationError("workspace sequence_id is invalid")
    payload = {
        "name": m.target_name, "label": m.target_name, "title": title, "module": m.module,
        "icon": str(values.get("icon") or "folder-normal"),
        "public": _flag(values.get("public", 0), "public"),
        "is_hidden": _flag(values.get("is_hidden", 0), "is_hidden"),
        "hide_custom": _flag(values.get("hide_custom", 0), "hide_custom"),
        "content": _workspace_content(values.get("content") or []),
        "roles": _roles(values.get("roles")), "sequence_id": sequence,
    }
    for key in ("parent_page", "restrict_to_domain", "indicator_color"):
        if values.get(key):
            payload[key] = str(values[key])
    return ArtifactDefinition("Workspace", m.target_name, payload,
                              "artifact.workspace.write", "Sensitive")


def _query_report(m: ArtifactManifest, _resolver: TrustedResolver) -> ArtifactDefinition:
    values = dict(m.values)
    _only(values, {"source_doctype", "fields", "filters", "order_by", "limit", "roles", "disabled"}, m.kind)
    source = str(values.get("source_doctype") or m.target_doctype or "")
    if not source or not _DOCTYPE_NAME.fullmatch(source):
        raise AutomationValidationError("query_report requires a safe source_doctype")
    if not m.module:
        raise AutomationValidationError("query_report requires module")
    fields = values.get("fields") or []
    if not isinstance(fields, list) or not fields or len(fields) > 50:
        raise AutomationValidationError("query_report fields must contain 1-50 fieldnames")
    if any(not isinstance(item, str) or not _FIELDNAME.fullmatch(item) for item in fields):
        raise AutomationValidationError("query_report fields must be safe fieldnames")
    filters = values.get("filters") or []
    if not isinstance(filters, list) or len(filters) > 20:
        raise AutomationValidationError("query_report filters must be a list with at most 20 entries")
    where = []
    for row in filters:
        if not isinstance(row, dict) or set(row) - {"fieldname", "operator", "parameter"}:
            raise AutomationValidationError("query_report filter rows are invalid")
        _required(row, "fieldname", "operator", "parameter")
        if not _FIELDNAME.fullmatch(str(row["fieldname"])) or not _IDENTIFIER.fullmatch(str(row["parameter"])):
            raise AutomationValidationError("query_report filter identifier is invalid")
        operator = str(row["operator"]).upper()
        if operator not in {"=", "!=", ">", ">=", "<", "<=", "LIKE"}:
            raise AutomationValidationError("query_report filter operator is not allowed")
        where.append(f"`{row['fieldname']}` {operator} %({row['parameter']})s")
    order_by = values.get("order_by") or []
    if not isinstance(order_by, list) or len(order_by) > 5:
        raise AutomationValidationError("order_by must be a list with at most 5 rows")
    order = []
    for row in order_by:
        if not isinstance(row, dict) or set(row) != {"fieldname", "direction"}:
            raise AutomationValidationError("order_by rows require fieldname and direction")
        if not _FIELDNAME.fullmatch(str(row["fieldname"])) or str(row["direction"]).upper() not in {"ASC", "DESC"}:
            raise AutomationValidationError("order_by row is invalid")
        order.append(f"`{row['fieldname']}` {str(row['direction']).upper()}")
    limit = int(values.get("limit") or 500)
    if not 1 <= limit <= 5000:
        raise AutomationValidationError("query_report limit must be between 1 and 5000")
    query = f"SELECT {', '.join(f'`{item}`' for item in fields)} FROM `tab{source}`"
    if where:
        query += " WHERE " + " AND ".join(where)
    if order:
        query += " ORDER BY " + ", ".join(order)
    query += f" LIMIT {limit}"
    payload = {"report_name": m.target_name, "name": m.target_name, "ref_doctype": source,
               "report_type": "Query Report", "is_standard": "No", "query": query,
               "module": m.module, "roles": _roles(values.get("roles")),
               "disabled": _flag(values.get("disabled", 0), "disabled")}
    return ArtifactDefinition("Report", m.target_name, payload, "artifact.report.write",
                              "Sensitive", ((source, "report"),))


def _script_report(m: ArtifactManifest, resolver: TrustedResolver) -> ArtifactDefinition:
    values = dict(m.values)
    _only(values, {"implementation_key", "ref_doctype", "roles", "disabled"}, m.kind)
    _required(values, "implementation_key", "ref_doctype")
    trusted = dict(resolver.resolve_trusted_artifact("script_report", str(values["implementation_key"])))
    if set(trusted) - {"report_script", "module"} or not trusted.get("report_script"):
        raise AutomationValidationError("trusted Script Report resolver returned an invalid definition")
    payload = {"report_name": m.target_name, "name": m.target_name,
               "ref_doctype": values["ref_doctype"], "report_type": "Script Report",
               "is_standard": "No", "report_script": trusted["report_script"],
               "module": trusted.get("module") or m.module, "roles": _roles(values.get("roles")),
               "disabled": _flag(values.get("disabled", 0), "disabled")}
    return ArtifactDefinition("Report", m.target_name, payload, "artifact.report.script.write",
                              "Privileged Code", ((str(values["ref_doctype"]), "report"),))


def _print_format(m: ArtifactManifest, resolver: TrustedResolver) -> ArtifactDefinition:
    values = dict(m.values)
    _only(values, {"doc_type", "html", "trusted_template_key", "disabled", "print_format_type", "raw_printing"}, m.kind)
    _required(values, "doc_type")
    if not m.module:
        raise AutomationValidationError("print_format requires module")
    if bool(values.get("html")) == bool(values.get("trusted_template_key")):
        raise AutomationValidationError("provide exactly one of html or trusted_template_key")
    approval = "Sensitive"
    if values.get("trusted_template_key"):
        trusted = dict(resolver.resolve_trusted_artifact("print_format", str(values["trusted_template_key"])))
        content = str(trusted.get("html") or "")
        if not content:
            raise AutomationValidationError("trusted Print Format resolver returned no HTML")
        approval = "Privileged Code"
    else:
        content = _safe_static_html(str(values["html"]), allow_doc_fields=True)
    payload = {"name": m.target_name, "doc_type": values["doc_type"], "module": m.module,
               "standard": "No", "custom_format": 1, "html": content,
               "disabled": _flag(values.get("disabled", 0), "disabled"),
               "print_format_type": values.get("print_format_type") or "Jinja",
               "raw_printing": _flag(values.get("raw_printing", 0), "raw_printing")}
    return ArtifactDefinition("Print Format", m.target_name, payload, "artifact.print_format.write",
                              approval, ((str(values["doc_type"]), "print"),))


def _web_page(m: ArtifactManifest, _resolver: TrustedResolver) -> ArtifactDefinition:
    values = dict(m.values)
    _only(values, {"title", "route", "main_section", "published", "dynamic_route", "insert_style"}, m.kind)
    _required(values, "title", "route", "main_section")
    payload = {"name": m.target_name, "title": values["title"], "route": _route(values["route"]),
               "main_section": _safe_static_html(str(values["main_section"])),
               "published": _flag(values.get("published", 0), "published"),
               "dynamic_route": _flag(values.get("dynamic_route", 0), "dynamic_route")}
    if values.get("insert_style"):
        style = str(values["insert_style"])
        if any(token in style.lower() for token in ("@import", "url(", "expression(", "behavior:")):
            raise AutomationValidationError("external CSS imports and URLs are not permitted")
        payload["insert_style"] = style
    return ArtifactDefinition("Web Page", m.target_name, payload, "artifact.web_page.write", "Sensitive")


def _web_form(m: ArtifactManifest, _resolver: TrustedResolver) -> ArtifactDefinition:
    values = dict(m.values)
    _only(values, {"doc_type", "title", "route", "web_form_fields", "published", "login_required",
                   "allow_edit", "allow_multiple", "show_attachments", "success_message"}, m.kind)
    _required(values, "doc_type", "title", "route", "web_form_fields")
    rows = values["web_form_fields"]
    allowed = {"fieldname", "fieldtype", "label", "reqd", "options", "read_only", "show_in_filter",
               "max_length", "default"}
    if not isinstance(rows, list) or not rows or len(rows) > 100:
        raise AutomationValidationError("web_form_fields must contain 1-100 rows")
    cleaned = []
    for row in rows:
        if not isinstance(row, dict):
            raise AutomationValidationError("web form field rows must be objects")
        _only(row, allowed, "web form field")
        _required(row, "fieldname")
        if not _FIELDNAME.fullmatch(str(row["fieldname"])):
            raise AutomationValidationError("web form fieldname is invalid")
        cleaned.append(dict(row))
    payload = {"name": m.target_name, "doc_type": values["doc_type"], "title": values["title"],
               "route": _route(values["route"]), "web_form_fields": cleaned,
               "published": _flag(values.get("published", 0), "published"),
               "login_required": _flag(values.get("login_required", 1), "login_required"),
               "allow_edit": _flag(values.get("allow_edit", 0), "allow_edit"),
               "allow_multiple": _flag(values.get("allow_multiple", 0), "allow_multiple"),
               "show_attachments": _flag(values.get("show_attachments", 0), "show_attachments"),
               "success_message": html.escape(str(values.get("success_message") or "Submitted"))}
    return ArtifactDefinition("Web Form", m.target_name, payload, "artifact.web_form.write",
                              "Sensitive", ((str(values["doc_type"]), "create"),))


def _client_script(m: ArtifactManifest, resolver: TrustedResolver) -> ArtifactDefinition:
    values = dict(m.values)
    _only(values, {"implementation_key", "dt", "view", "enabled"}, m.kind)
    _required(values, "implementation_key")
    doctype = str(values.get("dt") or m.target_doctype or "")
    if not _DOCTYPE_NAME.fullmatch(doctype):
        raise AutomationValidationError("client_script requires a safe dt")
    view = str(values.get("view") or "Form")
    if view not in {"Form", "List"}:
        raise AutomationValidationError("client_script view must be Form or List")
    trusted = dict(resolver.resolve_trusted_artifact(
        "client_script", str(values["implementation_key"])
    ))
    allowed = {"script", "module", "allowed_doctypes", "allowed_views"}
    if (set(trusted) - allowed or not isinstance(trusted.get("script"), str)
            or not trusted["script"] or len(trusted["script"].encode("utf-8")) > 128_000):
        raise AutomationValidationError("trusted Client Script resolver returned an invalid definition")
    allowed_doctypes = trusted.get("allowed_doctypes")
    allowed_views = trusted.get("allowed_views")
    if (not isinstance(allowed_doctypes, list) or not allowed_doctypes
            or any(not isinstance(item, str) for item in allowed_doctypes)
            or doctype not in allowed_doctypes):
        raise AutomationValidationError("trusted Client Script is not installed for this DocType")
    if (not isinstance(allowed_views, list) or not allowed_views
            or any(item not in {"Form", "List"} for item in allowed_views)
            or view not in allowed_views):
        raise AutomationValidationError("trusted Client Script is not installed for this view")
    module = str(trusted.get("module") or m.module or "")
    if not module or not _DOCTYPE_NAME.fullmatch(module):
        raise AutomationValidationError("client_script requires an installed module")
    payload = {
        "name": m.target_name, "dt": doctype, "view": view, "module": module,
        "enabled": _flag(values.get("enabled", 1), "enabled"), "script": trusted["script"],
    }
    return ArtifactDefinition("Client Script", m.target_name, payload,
                              "artifact.client_script.write", "Privileged Code",
                              ((doctype, "write"),))


def _server_script(m: ArtifactManifest, resolver: TrustedResolver) -> ArtifactDefinition:
    values = dict(m.values)
    # A prompt selects one installed implementation and may disable it. Trigger,
    # guest, scheduler and rate-limit authority remain part of installed code.
    _only(values, {"implementation_key", "disabled"}, m.kind)
    _required(values, "implementation_key")
    trusted = dict(resolver.resolve_trusted_artifact(
        "server_script", str(values["implementation_key"])
    ))
    allowed = {
        "script", "script_type", "reference_doctype", "event_frequency", "cron_format",
        "doctype_event", "api_method", "allow_guest", "module", "disabled",
        "enable_rate_limit", "rate_limit_count", "rate_limit_seconds",
    }
    if (set(trusted) - allowed or not isinstance(trusted.get("script"), str)
            or not trusted["script"] or len(trusted["script"].encode("utf-8")) > 128_000):
        raise AutomationValidationError("trusted Server Script resolver returned an invalid definition")
    script_type = str(trusted.get("script_type") or "")
    if script_type not in {"DocType Event", "API", "Scheduler Event"}:
        raise AutomationValidationError("trusted Server Script has an invalid script_type")
    if trusted.get("allow_guest") not in {None, 0, False}:
        raise AutomationValidationError("guest Server Scripts are not permitted")
    module = str(trusted.get("module") or m.module or "")
    if not module or not _DOCTYPE_NAME.fullmatch(module):
        raise AutomationValidationError("server_script requires an installed module")
    payload = {
        "name": m.target_name, "script_type": script_type, "module": module,
        "disabled": _flag(values.get("disabled", trusted.get("disabled", 0)), "disabled"),
        "allow_guest": 0, "script": trusted["script"],
    }
    governed: tuple[tuple[str, str], ...] = ()
    capability = "artifact.server_script.write"
    if script_type == "DocType Event":
        reference = str(trusted.get("reference_doctype") or "")
        event = str(trusted.get("doctype_event") or "")
        if not _DOCTYPE_NAME.fullmatch(reference) or event not in {
            "Before Insert", "Before Save", "After Save", "Before Submit", "After Submit",
            "Before Cancel", "After Cancel", "Before Delete", "After Delete",
        }:
            raise AutomationValidationError("trusted DocType Event Server Script trigger is invalid")
        payload.update({"reference_doctype": reference, "doctype_event": event})
        governed = ((reference, "write"),)
        capability = "artifact.server_script.doctype.write"
    elif script_type == "API":
        method = str(trusted.get("api_method") or "")
        if not re.fullmatch(r"[a-z][a-z0-9_]{2,139}", method):
            raise AutomationValidationError("trusted API Server Script method is invalid")
        if trusted.get("enable_rate_limit") not in {1, True}:
            raise AutomationValidationError("trusted API Server Script must enable rate limiting")
        count = int(trusted.get("rate_limit_count") or 0)
        seconds = int(trusted.get("rate_limit_seconds") or 0)
        if not 1 <= count <= 1_000 or not 1 <= seconds <= 86_400:
            raise AutomationValidationError("trusted API Server Script rate limits are invalid")
        payload.update({
            "api_method": method, "enable_rate_limit": 1,
            "rate_limit_count": count, "rate_limit_seconds": seconds,
        })
        capability = "artifact.server_script.api.write"
    else:
        frequency = str(trusted.get("event_frequency") or "")
        if frequency not in {"Hourly", "Daily", "Weekly", "Monthly", "Cron"}:
            raise AutomationValidationError("trusted Scheduler Server Script frequency is invalid")
        payload["event_frequency"] = frequency
        if frequency == "Cron":
            cron = str(trusted.get("cron_format") or "")
            if (not 5 <= len(cron) <= 100 or "\n" in cron or "\r" in cron
                    or len(cron.split()) != 5):
                raise AutomationValidationError("trusted Scheduler Server Script cron_format is invalid")
            payload["cron_format"] = cron
        elif trusted.get("cron_format"):
            raise AutomationValidationError("cron_format is only valid for trusted Cron Server Scripts")
        capability = "artifact.server_script.scheduler.write"
    return ArtifactDefinition("Server Script", m.target_name, payload, capability,
                              "Privileged Code", governed)


def _email_template(m: ArtifactManifest, resolver: TrustedResolver) -> ArtifactDefinition:
    values = dict(m.values)
    _only(values, {"subject", "use_html", "response_html", "response", "trusted_template_key"}, m.kind)
    trusted_key = values.get("trusted_template_key")
    direct_body = values.get("response_html") or values.get("response")
    if bool(trusted_key) == bool(direct_body):
        raise AutomationValidationError(
            "provide exactly one safe Email Template body or trusted_template_key"
        )
    approval = "Sensitive"
    if trusted_key:
        if set(values) - {"trusted_template_key"}:
            raise AutomationValidationError(
                "trusted Email Templates cannot be combined with prompt-authored template fields"
            )
        source = dict(resolver.resolve_trusted_artifact("email_template", str(trusted_key)))
        if set(source) - {"subject", "use_html", "response_html", "response", "module"}:
            raise AutomationValidationError("trusted Email Template resolver returned unknown fields")
        approval = "Privileged Code"
    else:
        source = values
    _required(source, "subject")
    use_html = _flag(source.get("use_html", 1 if source.get("response_html") else 0), "use_html")
    if use_html:
        if not source.get("response_html") or source.get("response"):
            raise AutomationValidationError("HTML Email Template requires only response_html")
        body_field = "response_html"
    else:
        if not source.get("response") or source.get("response_html"):
            raise AutomationValidationError("plain Email Template requires only response")
        body_field = "response"
    if trusted_key:
        subject = str(source["subject"])
        body = str(source[body_field])
        if (not subject or len(subject.encode("utf-8")) > 4_000
                or any(ord(character) < 32 for character in subject)
                or len(body.encode("utf-8")) > 128_000 or _SCRIPTISH.search(body)):
            raise AutomationValidationError("trusted Email Template content is invalid")
    else:
        subject = _safe_static_html(str(source["subject"]), allow_doc_fields=True)
        body = _safe_static_html(str(source[body_field]), allow_doc_fields=True)
    if "<" in subject or ">" in subject:
        raise AutomationValidationError("Email Template subject must be plain text")
    if not use_html and ("<" in body or ">" in body):
        raise AutomationValidationError("plain Email Template response must be plain text")
    payload = {
        "name": m.target_name, "subject": subject, "use_html": use_html,
        body_field: body,
    }
    return ArtifactDefinition("Email Template", m.target_name, payload,
                              "artifact.email_template.write", approval)


def _notification(m: ArtifactManifest, _resolver: TrustedResolver) -> ArtifactDefinition:
    values = dict(m.values)
    _only(values, {
        "document_type", "event", "channel", "subject", "message", "recipients",
        "enabled", "send_system_notification",
    }, m.kind)
    _required(values, "document_type", "event", "channel", "subject", "message", "recipients")
    event = str(values["event"])
    channel = str(values["channel"])
    if event not in {"New", "Save", "Submit", "Cancel"}:
        raise AutomationValidationError("notification event is not allowed on the no-code path")
    if channel not in {"Email", "System Notification"}:
        raise AutomationValidationError("notification channel is not allowed on the no-code path")
    subject = _safe_static_html(str(values["subject"]), allow_doc_fields=True)
    if "<" in subject or ">" in subject:
        raise AutomationValidationError("notification subject must be plain text")
    message = _safe_static_html(str(values["message"]), allow_doc_fields=True)
    recipients = values["recipients"]
    if not isinstance(recipients, list) or not 1 <= len(recipients) <= 50:
        raise AutomationValidationError("notification recipients must contain 1-50 rows")
    clean_recipients = []
    for row in recipients:
        if not isinstance(row, dict):
            raise AutomationValidationError("notification recipient rows must be objects")
        _only(row, {"receiver_by_role", "receiver_by_document_field"}, "notification recipient")
        selected = [key for key in row if row.get(key)]
        if len(selected) != 1 or not isinstance(row[selected[0]], str) or len(row[selected[0]]) > 140:
            raise AutomationValidationError("notification recipients require exactly one safe selector")
        if selected[0] == "receiver_by_document_field" and not _FIELDNAME.fullmatch(row[selected[0]]):
            raise AutomationValidationError("notification recipient document field is invalid")
        if any(ord(character) < 32 for character in row[selected[0]]):
            raise AutomationValidationError("notification recipient selector is invalid")
        clean_recipients.append(dict(row))
    doctype = str(values["document_type"])
    payload = {
        "name": m.target_name, "document_type": doctype, "event": event, "channel": channel,
        "subject": subject, "message": message, "recipients": clean_recipients,
        "enabled": _flag(values.get("enabled", 1), "enabled"), "is_standard": 0,
        "send_system_notification": _flag(
            values.get("send_system_notification", channel == "Email"), "send_system_notification"
        ),
    }
    return ArtifactDefinition("Notification", m.target_name, payload,
                              "artifact.notification.write", "Sensitive", ((doctype, "read"),))


def _assignment_rule(m: ArtifactManifest, _resolver: TrustedResolver) -> ArtifactDefinition:
    values = dict(m.values)
    _only(values, {
        "document_type", "description", "assign_condition", "unassign_condition",
        "close_condition", "rule", "users", "assignment_days", "priority", "disabled",
        "field", "due_date_based_on",
    }, m.kind)
    _required(values, "document_type", "description", "assign_condition", "rule", "assignment_days")
    rule = str(values["rule"])
    if rule not in {"Round Robin", "Load Balancing", "Based on Field"}:
        raise AutomationValidationError("assignment rule strategy is invalid")
    users = values.get("users") or []
    if not isinstance(users, list) or len(users) > 50 or any(
        not isinstance(row, dict) or set(row) != {"user"} or not isinstance(row["user"], str)
        or not row["user"] or len(row["user"]) > 140 for row in users
    ):
        raise AutomationValidationError("assignment rule users must be [{\"user\": \"user@example.com\"}]")
    field = str(values.get("field") or "")
    if rule == "Based on Field":
        if not _FIELDNAME.fullmatch(field) or users:
            raise AutomationValidationError("field-based assignment requires one field and no user list")
    elif not users:
        raise AutomationValidationError("round-robin and load-balancing assignment require users")
    days = values["assignment_days"]
    valid_days = {"Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"}
    if not isinstance(days, list) or not 1 <= len(days) <= 7 or any(
        not isinstance(row, dict) or set(row) != {"day"} or row["day"] not in valid_days for row in days
    ) or len({row["day"] for row in days}) != len(days):
        raise AutomationValidationError("assignment_days must contain unique weekdays")
    priority = int(values.get("priority") or 0)
    if not 0 <= priority <= 1_000:
        raise AutomationValidationError("assignment rule priority is invalid")
    doctype = str(values["document_type"])
    payload = {
        "name": m.target_name, "document_type": doctype,
        "description": html.escape(_safe_static_html(str(values["description"]))[:500]), "rule": rule,
        "assign_condition": _safe_expression(values["assign_condition"], "assign_condition", required=True),
        "unassign_condition": _safe_expression(values.get("unassign_condition"), "unassign_condition"),
        "close_condition": _safe_expression(values.get("close_condition"), "close_condition"),
        "users": [dict(row) for row in users], "assignment_days": [dict(row) for row in days],
        "priority": priority, "disabled": _flag(values.get("disabled", 0), "disabled"),
    }
    if field:
        payload["field"] = field
    if values.get("due_date_based_on"):
        payload["due_date_based_on"] = str(values["due_date_based_on"])
    return ArtifactDefinition("Assignment Rule", m.target_name, payload,
                              "artifact.assignment_rule.write", "Privileged Code",
                              ((doctype, "write"),))


_OFFICE_MIMES = {
    "application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.oasis.opendocument.text", "application/vnd.oasis.opendocument.spreadsheet",
    "application/vnd.oasis.opendocument.presentation",
}


def _office_artifact(m: ArtifactManifest, _resolver: TrustedResolver) -> ArtifactDefinition:
    values = dict(m.values)
    _only(values, {"mission", "work_unit", "file_url", "mime_type", "size_bytes", "checksum",
                   "title", "visibility"}, m.kind)
    _required(values, "mission", "file_url", "mime_type", "size_bytes", "checksum")
    if not str(values["file_url"]).startswith("/private/files/"):
        raise AutomationValidationError("office artifacts must reference an existing private Frappe File")
    if values["mime_type"] not in _OFFICE_MIMES:
        raise AutomationValidationError("office artifact MIME type is not allowed")
    size = int(values["size_bytes"])
    if not 0 < size <= 100 * 1024 * 1024:
        raise AutomationValidationError("office artifact size must be between 1 byte and 100 MB")
    checksum = str(values["checksum"])
    if not re.fullmatch(r"[a-f0-9]{64}", checksum):
        raise AutomationValidationError("office artifact checksum must be lowercase SHA-256")
    if values.get("visibility") not in {None, "Private", "Participants", "Auditors"}:
        raise AutomationValidationError("office artifact visibility is invalid")
    kind = {
        "application/pdf": "PDF",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Spreadsheet",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation": "Presentation",
    }.get(str(values["mime_type"]), "Other")
    payload = {"name": m.target_name, "title": values.get("title") or m.target_name,
               "mission": values["mission"], "work_unit": values.get("work_unit"), "kind": kind,
               "visibility": values.get("visibility") or "Private", "is_public": 0,
               "file": values["file_url"], "mime_type": values["mime_type"], "size_bytes": size,
               "checksum": checksum, "verification_status": "Pending"}
    return ArtifactDefinition("Muster Artifact", m.target_name, payload,
                              "artifact.office.write", "Standard",
                              (("Muster Mission", "read"), ("File", "read")))


BUILDERS: dict[str, Callable[[ArtifactManifest, TrustedResolver], ArtifactDefinition]] = {
    "custom_field": _custom_field, "property_setter": _property_setter, "doctype": _doctype,
    "page": _page, "workspace": _workspace,
    "query_report": _query_report, "script_report": _script_report,
    "print_format": _print_format, "web_page": _web_page, "web_form": _web_form,
    "client_script": _client_script, "server_script": _server_script,
    "email_template": _email_template,
    "notification": _notification, "assignment_rule": _assignment_rule,
    "office_artifact": _office_artifact,
}


def build(manifest: ArtifactManifest, resolver: TrustedResolver) -> ArtifactDefinition:
    return BUILDERS[manifest.kind](manifest, resolver)
