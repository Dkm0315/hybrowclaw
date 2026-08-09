from __future__ import annotations

import json
import re
from urllib.parse import urlsplit
from dataclasses import dataclass
from hashlib import sha256
from typing import Any, Iterable, Mapping

NODE_ID_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_.:-]{0,63}$")
NODE_TYPES = {
    "Agent",
    "Tool",
    "Approval",
    "Condition",
    "Parallel",
    "Join",
    "Bounded Loop",
    "Artifact",
}
APPROVAL_CLASSES = {
    "None",
    "Standard",
    "Sensitive",
    "Privileged Code",
    "Destructive",
}
_BROWSER_CAPABILITIES = {
    "navigate": "frappe.browser.navigate",
    "click": "frappe.browser.click",
    "fill": "frappe.browser.fill",
    "select": "frappe.browser.select",
    "upload": "frappe.browser.upload",
    "screenshot": "frappe.browser.screenshot",
    "read_visible": "frappe.browser.read_visible",
}
_BROWSER_ROLES = {"button", "link", "textbox", "combobox", "checkbox", "tab"}
_SECRET_FIELD = re.compile(
    r"password|passwd|secret|api.?key|token|authorization|cookie|private.?key", re.I
)
_SAFE_BROWSER_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_ATTENDED_FORM_ROUTE = "@attended-form"
_EFFECT_CAPABILITIES = {
    "frappe.record.create": ("record", "create"),
    "frappe.record.update": ("record", "update"),
    "frappe.record.delete": ("record", "delete"),
    "frappe.metadata.custom_field.create": ("native_artifact", "custom_field"),
    "frappe.metadata.property_setter.create": ("native_artifact", "property_setter"),
    "frappe.metadata.doctype.create": ("native_artifact", "doctype"),
    "frappe.metadata.page.create": ("native_artifact", "page"),
    "frappe.metadata.workspace.create": ("native_artifact", "workspace"),
    "frappe.metadata.report.create": ("native_artifact", "report"),
    "frappe.metadata.script_report.create": ("native_artifact", "script_report"),
    "frappe.metadata.print_format.create": ("native_artifact", "print_format"),
    "frappe.metadata.web_page.create": ("native_artifact", "web_page"),
    "frappe.metadata.web_form.create": ("native_artifact", "web_form"),
    "frappe.metadata.client_script.create": ("native_artifact", "client_script"),
    "frappe.metadata.server_script.create": ("native_artifact", "server_script"),
    "frappe.metadata.email_template.create": ("native_artifact", "email_template"),
    "frappe.automation.notification.create": ("native_artifact", "notification"),
    "frappe.automation.assignment_rule.create": ("native_artifact", "assignment_rule"),
}


class WorkflowGraphError(ValueError):
    def __init__(self, code: str, message: str, path: str = "graph"):
        super().__init__(message)
        self.code = code
        self.path = path

    def as_dict(self) -> dict[str, str]:
        return {"code": self.code, "message": str(self), "path": self.path}


@dataclass(frozen=True)
class GraphLimits:
    max_depth: int = 3
    max_fan_out: int = 8
    max_active_nodes: int = 32
    max_retries: int = 3

    def validate(self) -> None:
        values = (
            self.max_depth,
            self.max_fan_out,
            self.max_active_nodes,
            self.max_retries,
        )
        if any(not isinstance(value, int) or value < 1 for value in values):
            raise WorkflowGraphError("invalid_limits", "Graph limits must be positive integers")


@dataclass(frozen=True)
class GraphAnalysis:
    root: str
    node_count: int
    edge_count: int
    depth: int
    maximum_fan_out: int
    topological_order: tuple[str, ...]

    def as_dict(self) -> dict[str, Any]:
        return {
            "root": self.root,
            "node_count": self.node_count,
            "edge_count": self.edge_count,
            "depth": self.depth,
            "maximum_fan_out": self.maximum_fan_out,
            "topological_order": list(self.topological_order),
        }


def _value(row: Any, key: str, default: Any = None) -> Any:
    if isinstance(row, Mapping):
        return row.get(key, default)
    return getattr(row, key, default)


def _configuration(row: Any, index: int) -> dict[str, Any]:
    raw = _value(row, "configuration_json") or {}
    if isinstance(raw, dict):
        return raw
    try:
        parsed = json.loads(raw)
    except (TypeError, json.JSONDecodeError) as exc:
        raise WorkflowGraphError(
            "invalid_configuration",
            "Node configuration must be a JSON object",
            f"nodes[{index}].configuration_json",
        ) from exc
    if not isinstance(parsed, dict):
        raise WorkflowGraphError(
            "invalid_configuration",
            "Node configuration must be a JSON object",
            f"nodes[{index}].configuration_json",
        )
    return parsed


def _exact_keys(value: Mapping[str, Any], allowed: set[str], path: str) -> None:
    if set(value) != allowed:
        raise WorkflowGraphError(
            "invalid_browser_plan", "Browser action plan has unknown or missing fields", path
        )


def _safe_browser_text(value: Any, path: str, maximum: int = 256) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > maximum
        or any(ord(character) < 32 for character in value)
    ):
        raise WorkflowGraphError("invalid_browser_plan", "Browser action text is invalid", path)
    return value


def _browser_target(value: Any, path: str) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise WorkflowGraphError("invalid_browser_plan", "Browser target is invalid", path)
    kind = value.get("kind")
    if kind in {"label", "test_id"}:
        _exact_keys(value, {"kind", "name"}, path)
        return {"kind": kind, "name": _safe_browser_text(value.get("name"), f"{path}.name")}
    if kind == "role":
        _exact_keys(value, {"kind", "role", "name"}, path)
        if value.get("role") not in _BROWSER_ROLES:
            raise WorkflowGraphError("invalid_browser_plan", "Browser target role is invalid", path)
        return {
            "kind": "role",
            "role": value["role"],
            "name": _safe_browser_text(value.get("name"), f"{path}.name"),
        }
    raise WorkflowGraphError(
        "invalid_browser_plan", "Only semantic browser targets are supported", path
    )


def _browser_postcondition(value: Any, path: str) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise WorkflowGraphError("invalid_browser_plan", "Browser postcondition is invalid", path)
    if value.get("kind") == "route":
        _exact_keys(value, {"kind", "route"}, path)
        route = _safe_browser_text(value.get("route"), f"{path}.route", 500)
        parsed = urlsplit(route)
        if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment or not parsed.path.startswith("/desk"):
            raise WorkflowGraphError("invalid_browser_plan", "Browser postcondition route is invalid", path)
        return {"kind": "route", "route": route}
    if value.get("kind") == "target":
        _exact_keys(value, {"kind", "target", "state"}, path)
        if value.get("state") not in {"visible", "hidden"}:
            raise WorkflowGraphError("invalid_browser_plan", "Browser postcondition state is invalid", path)
        return {
            "kind": "target",
            "target": _browser_target(value.get("target"), f"{path}.target"),
            "state": value["state"],
        }
    if value.get("kind") == "record_saved":
        _exact_keys(value, {"kind", "doctype", "recordName"}, path)
        record_name = value.get("recordName")
        if record_name is not None:
            record_name = _safe_browser_text(record_name, f"{path}.recordName", 500)
        return {"kind": "record_saved", "doctype": _safe_browser_text(value.get("doctype"), f"{path}.doctype", 140), "recordName": record_name}
    if value.get("kind") == "bind_route":
        _exact_keys(value, {"kind", "token", "doctype"}, path)
        if value.get("token") != "attended_form":
            raise WorkflowGraphError("invalid_browser_plan", "Browser route binding token is invalid", path)
        return {"kind": "bind_route", "token": "attended_form", "doctype": _safe_browser_text(value.get("doctype"), f"{path}.doctype", 140)}
    raise WorkflowGraphError("invalid_browser_plan", "Browser postcondition kind is invalid", path)


def _browser_action(value: Any, path: str) -> dict[str, Any]:
    if not isinstance(value, Mapping) or value.get("kind") not in _BROWSER_CAPABILITIES:
        raise WorkflowGraphError("invalid_browser_plan", "Browser action is invalid", path)
    kind = value["kind"]
    base_keys = {"kind", "route"} | ({"doctype"} if "doctype" in value else set()) | (
        {"recordName"} if "recordName" in value else set()
    )
    route = _safe_browser_text(value.get("route"), f"{path}.route", 500)
    parsed = urlsplit(route)
    if (
        route != _ATTENDED_FORM_ROUTE and (parsed.scheme
        or parsed.netloc
        or parsed.query
        or parsed.fragment
        or not parsed.path.startswith("/desk")
        or "\\" in route
        or "\x00" in route)
    ):
        raise WorkflowGraphError(
            "invalid_browser_plan", "Browser routes must stay inside Frappe Desk", f"{path}.route"
        )
    result: dict[str, Any] = {"kind": kind, "route": route}
    for key in ("doctype", "recordName"):
        if key in value:
            result[key] = _safe_browser_text(value[key], f"{path}.{key}")
    if kind in {"click", "fill", "select", "upload"} and not result.get("doctype"):
        raise WorkflowGraphError(
            "invalid_browser_plan",
            "Mutating browser actions require an explicit DocType scope",
            path,
        )
    if kind == "navigate":
        _exact_keys(value, base_keys, path)
    elif kind == "click":
        _exact_keys(value, base_keys | {"target", "postcondition"}, path)
        result["target"] = _browser_target(value.get("target"), f"{path}.target")
        result["postcondition"] = _browser_postcondition(value.get("postcondition"), f"{path}.postcondition")
    elif kind in {"fill", "select", "upload"}:
        terminal = {"fill": "value", "select": "option", "upload": "artifactId"}[kind]
        _exact_keys(value, base_keys | {"target", "field", terminal, "postcondition"}, path)
        result["target"] = _browser_target(value.get("target"), f"{path}.target")
        result["postcondition"] = _browser_postcondition(value.get("postcondition"), f"{path}.postcondition")
        field = _safe_browser_text(value.get("field"), f"{path}.field")
        if _SECRET_FIELD.search(field):
            raise WorkflowGraphError("invalid_browser_plan", "Secret browser fields are forbidden", path)
        result["field"] = field
        result[terminal] = _safe_browser_text(
            value.get(terminal), f"{path}.{terminal}", 10_000 if kind == "fill" else 256
        )
        if kind == "upload" and not _SAFE_BROWSER_ID.fullmatch(result[terminal]):
            raise WorkflowGraphError(
                "invalid_browser_plan", "Uploads require a governed artifact id", path
            )
    elif kind == "screenshot":
        _exact_keys(value, base_keys | {"scope", "redactFields"}, path)
        fields = value.get("redactFields")
        if (
            value.get("scope") != "viewport_redacted"
            or not isinstance(fields, list)
            or not 1 <= len(fields) <= 50
        ):
            raise WorkflowGraphError(
                "invalid_browser_plan", "Screenshots require explicit bounded redaction fields", path
            )
        result.update(
            scope="viewport_redacted",
            redactFields=[
                _safe_browser_text(item, f"{path}.redactFields") for item in fields
            ],
        )
    else:
        optional_target = {"target"} if "target" in value else set()
        _exact_keys(value, base_keys | {"maxChars"} | optional_target, path)
        maximum = value.get("maxChars")
        if not isinstance(maximum, int) or isinstance(maximum, bool) or not 1 <= maximum <= 10_000:
            raise WorkflowGraphError("invalid_browser_plan", "Visible read limit is invalid", path)
        result["maxChars"] = maximum
        if "target" in value:
            result["target"] = _browser_target(value["target"], f"{path}.target")
    return result


def browser_action_plan(value: Any, path: str = "browser_action_plan") -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise WorkflowGraphError("invalid_browser_plan", "Browser action plan must be an object", path)
    keys = {"schemaVersion", "actionBudget", "actions"} | ({"attendedCrud"} if "attendedCrud" in value else set())
    _exact_keys(value, keys, path)
    budget = value.get("actionBudget")
    actions = value.get("actions")
    if (
        value.get("schemaVersion") != 1
        or not isinstance(budget, int)
        or isinstance(budget, bool)
        or not 1 <= budget <= 100
        or not isinstance(actions, list)
        or not 1 <= len(actions) <= budget
    ):
        raise WorkflowGraphError("invalid_browser_plan", "Browser action plan budget is invalid", path)
    normalized = {
        "schemaVersion": 1,
        "actionBudget": budget,
        "actions": [_browser_action(action, f"{path}.actions[{index}]") for index, action in enumerate(actions)],
    }
    if "attendedCrud" in value:
        binding = value.get("attendedCrud")
        if not isinstance(binding, Mapping):
            raise WorkflowGraphError("invalid_browser_plan", "Attended CRUD binding is invalid", path)
        _exact_keys(binding, {"operation", "doctype", "record_name", "fields", "schema_hash", "revision"}, f"{path}.attendedCrud")
        operation = binding.get("operation")
        record_name = binding.get("record_name")
        fields = binding.get("fields")
        has_record = isinstance(record_name, str) and bool(record_name)
        if operation not in {"create", "read", "update", "delete"} or (operation in {"update", "delete"} and not has_record) or (operation == "create" and record_name is not None) or (operation == "read" and record_name is not None and not has_record):
            raise WorkflowGraphError("invalid_browser_plan", "Attended CRUD lifecycle is invalid or unsupported", path)
        if not isinstance(fields, list) or len(fields) > 100 or len(set(fields)) != len(fields):
            raise WorkflowGraphError("invalid_browser_plan", "Attended CRUD fields are invalid", path)
        normalized_fields = [_safe_browser_text(field, f"{path}.attendedCrud.fields") for field in fields]
        if not _SHA256.fullmatch(str(binding.get("schema_hash") or "")) or not _SHA256.fullmatch(str(binding.get("revision") or "")):
            raise WorkflowGraphError("invalid_browser_plan", "Attended CRUD schema evidence is invalid", path)
        normalized["attendedCrud"] = {
            "operation": operation,
            "doctype": _safe_browser_text(binding.get("doctype"), f"{path}.attendedCrud.doctype", 140),
            "record_name": record_name,
            "fields": sorted(normalized_fields),
            "schema_hash": binding["schema_hash"],
            "revision": binding["revision"],
        }
        used = sorted({action["field"] for action in normalized["actions"] if "field" in action})
        if used != normalized["attendedCrud"]["fields"]:
            raise WorkflowGraphError("invalid_browser_plan", "Attended CRUD fields do not match its actions", path)
        if any(action.get("doctype") not in {None, normalized["attendedCrud"]["doctype"]} for action in normalized["actions"]):
            raise WorkflowGraphError("invalid_browser_plan", "Attended CRUD DocType does not match its actions", path)
        bound = False
        for action in normalized["actions"]:
            if action["route"] == _ATTENDED_FORM_ROUTE and not bound:
                raise WorkflowGraphError("invalid_browser_plan", "Attended form route token was used before binding", path)
            postcondition = action.get("postcondition") or {}
            if postcondition.get("kind") == "bind_route":
                if normalized["attendedCrud"]["operation"] != "create" or bound or action["route"] == _ATTENDED_FORM_ROUTE or postcondition["doctype"] != normalized["attendedCrud"]["doctype"]:
                    raise WorkflowGraphError("invalid_browser_plan", "Attended form route binding is invalid", path)
                bound = True
    elif any(action["route"] == _ATTENDED_FORM_ROUTE for action in normalized["actions"]):
        raise WorkflowGraphError("invalid_browser_plan", "Only attended CRUD may bind a form route", path)
    return normalized


def effect_intent(value: Any, path: str = "effect_intent") -> dict[str, Any]:
    """Admit only reusable static intent; live authority/approval never belongs here."""
    if not isinstance(value, Mapping):
        raise WorkflowGraphError("invalid_effect_intent", "Effect intent must be an object", path)
    _effect_exact_keys(
        value, {"schemaVersion", "capability", "operation", "postconditions", "approvalClass"}, path
    )
    capability = value.get("capability")
    operation = value.get("operation")
    if value.get("schemaVersion") != 1 or capability not in _EFFECT_CAPABILITIES:
        raise WorkflowGraphError("invalid_effect_intent", "Effect capability is not supported", path)
    if value.get("approvalClass") not in {"single", "dual_control"} or not isinstance(operation, Mapping):
        raise WorkflowGraphError("invalid_effect_intent", "Effect approval or operation is invalid", path)
    family, action = _EFFECT_CAPABILITIES[capability]
    if family == "record":
        allowed = {"kind", "action", "doctype"}
        if action != "delete":
            allowed.add("values")
        if "docname" in operation:
            allowed.add("docname")
        _effect_exact_keys(operation, allowed, f"{path}.operation")
        if operation.get("kind") != "record" or operation.get("action") != action:
            raise WorkflowGraphError("invalid_effect_intent", "Record capability and action do not match", path)
        doctype = _effect_text(operation.get("doctype"), f"{path}.operation.doctype", 140)
        docname = operation.get("docname")
        if action in {"update", "delete"}:
            docname = _effect_text(docname, f"{path}.operation.docname", 500)
        elif docname is not None:
            raise WorkflowGraphError("invalid_effect_intent", "Record create cannot preselect a document name", path)
        values = {} if action == "delete" else _bounded_json_object(operation.get("values"), f"{path}.operation.values")
        if action == "delete" and value.get("approvalClass") != "dual_control":
            raise WorkflowGraphError("invalid_effect_intent", "Record deletion requires dual control", path)
        normalized_operation = {"kind": "record", "action": action, "doctype": doctype,
                                **({"docname": docname} if docname else {}),
                                **({"values": values} if action != "delete" else {})}
    else:
        _effect_exact_keys(operation, {"kind", "artifactType", "intent"}, f"{path}.operation")
        if operation.get("kind") != "native_artifact" or operation.get("artifactType") != action:
            raise WorkflowGraphError("invalid_effect_intent", "Native capability and artifact do not match", path)
        native_intent = _bounded_json_object(operation.get("intent"), f"{path}.operation.intent")
        if (set(native_intent) - {"schema_version", "artifacts", "source_file"}
                or not isinstance(native_intent.get("artifacts"), list)
                or not 1 <= len(native_intent["artifacts"]) <= 50):
            raise WorkflowGraphError("invalid_effect_intent", "Native intent must contain only bounded artifacts", path)
        if "source_file" in native_intent:
            native_intent["source_file"] = _effect_text(
                native_intent["source_file"], f"{path}.operation.intent.source_file", 140
            )
        expected_kind = {"report": "query_report"}.get(action, action)
        for artifact in native_intent["artifacts"]:
            if not isinstance(artifact, dict) or artifact.get("kind") != expected_kind:
                raise WorkflowGraphError("invalid_effect_intent", "Native artifact kind does not match its capability", path)
            if expected_kind == "print_format" and isinstance(artifact.get("values"), dict) and artifact["values"].get("trusted_template_key"):
                raise WorkflowGraphError("invalid_effect_intent", "Trusted executable templates require a separate privileged path", path)
        normalized_operation = {"kind": "native_artifact", "artifactType": action,
                                "intent": native_intent}
        if action in {
            "doctype", "page", "workspace", "report", "script_report", "print_format",
            "web_page", "web_form", "notification", "assignment_rule",
            "client_script", "server_script", "email_template",
        } and value.get("approvalClass") != "dual_control":
            raise WorkflowGraphError(
                "invalid_effect_intent", "Executable metadata requires dual control", path
            )
    rules = value.get("postconditions")
    if not isinstance(rules, list) or not 1 <= len(rules) <= 32:
        raise WorkflowGraphError("invalid_effect_intent", "Effect postconditions are invalid", path)
    normalized_rules = []
    for index, rule in enumerate(rules):
        if not isinstance(rule, Mapping):
            raise WorkflowGraphError("invalid_effect_intent", "Effect postcondition is invalid", path)
        allowed = {"path", "operator"} | ({"expected"} if "expected" in rule else set())
        _effect_exact_keys(rule, allowed, f"{path}.postconditions[{index}]")
        operator = rule.get("operator")
        rule_path = rule.get("path")
        if not isinstance(rule_path, str) or not re.fullmatch(r"\$?(?:\.[A-Za-z0-9_-]+)+", rule_path or "") or operator not in {"equals", "exists", "absent"}:
            raise WorkflowGraphError("invalid_effect_intent", "Effect postcondition is invalid", path)
        if operator == "equals" and "expected" not in rule:
            raise WorkflowGraphError("invalid_effect_intent", "Equals postcondition requires expected", path)
        if operator != "equals" and "expected" in rule:
            raise WorkflowGraphError("invalid_effect_intent", "Only equals may declare expected", path)
        normalized_rules.append({"path": rule_path, "operator": operator,
                                 **({"expected": rule["expected"]} if "expected" in rule else {})})
    if family == "native":
        required_rules = [
            {"path": "$.status", "operator": "equals", "expected": "Verified"},
            {"path": "$.verified", "operator": "equals", "expected": True},
        ]
        if any(rule not in normalized_rules for rule in required_rules):
            raise WorkflowGraphError(
                "invalid_effect_intent",
                "Native effects require status and independent reread postconditions",
                path,
            )
    return {"schemaVersion": 1, "capability": capability, "operation": normalized_operation,
            "postconditions": normalized_rules, "approvalClass": value["approvalClass"]}


def _effect_exact_keys(value: Mapping[str, Any], allowed: set[str], path: str) -> None:
    if set(value) != allowed:
        raise WorkflowGraphError("invalid_effect_intent", "Effect intent has unknown or missing fields", path)


def _effect_text(value: Any, path: str, maximum: int) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum or any(ord(char) < 32 for char in value):
        raise WorkflowGraphError("invalid_effect_intent", "Effect resource identity is invalid", path)
    return value


def _bounded_json_object(value: Any, path: str) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise WorkflowGraphError("invalid_effect_intent", "Effect data must be an object", path)
    try:
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=True)
    except (TypeError, ValueError) as error:
        raise WorkflowGraphError("invalid_effect_intent", "Effect data must be JSON", path) from error
    if len(encoded.encode()) > 250_000 or any(key in {"__proto__", "prototype", "constructor"} for key in value):
        raise WorkflowGraphError("invalid_effect_intent", "Effect data is unsafe or excessive", path)
    return json.loads(encoded)


def canonical_execution_manifest(
    nodes: Iterable[Any], workflow_snapshot_hash: str
) -> tuple[str, str]:
    """Compile host-reviewed closed execution intents separate from model context."""
    plans: dict[str, Any] = {}
    for index, node in enumerate(nodes):
        configuration = _configuration(node, index)
        node_id = (_value(node, "node_id") or "").strip()
        has_browser = "browser_action_plan" in configuration
        has_effect = "effect_intent" in configuration
        if not has_browser and not has_effect:
            continue
        if has_browser and has_effect:
            raise WorkflowGraphError("multiple_execution_surfaces", "A node may declare only one execution surface", f"nodes[{index}].configuration_json")
        requested = set(configuration.get("requested_capabilities") or [])
        if has_effect:
            plan = effect_intent(configuration["effect_intent"], f"nodes[{index}].configuration_json.effect_intent")
            if requested != {plan["capability"]}:
                raise WorkflowGraphError("effect_capability_mismatch", "Effect intent must exactly match its sole requested capability", f"nodes[{index}].configuration_json")
            operation = plan["operation"]
            if operation["kind"] == "record":
                doctypes = [operation["doctype"]]
                record_names = [operation["docname"]] if operation.get("docname") else []
                fields = sorted((operation.get("values") or {}).keys())
            else:
                artifacts = operation["intent"].get("artifacts") or []
                if not isinstance(artifacts, list) or any(not isinstance(item, dict) for item in artifacts):
                    raise WorkflowGraphError("invalid_effect_intent", "Native intent artifacts must be a list of objects", f"nodes[{index}].configuration_json.effect_intent")
                doctypes = sorted({item["target_doctype"] for item in artifacts if isinstance(item.get("target_doctype"), str)})
                record_names = sorted({item["target_name"] for item in artifacts if isinstance(item.get("target_name"), str)})
                fields = sorted({key for item in artifacts for key in (item.get("values") or {}) if isinstance(item.get("values"), dict)})
            plans[node_id] = {"surface": "server_effect", "plan": plan,
                              "resourceScope": {"routes": [], "doctypes": doctypes, "recordNames": record_names, "fields": fields}}
            continue
        plan = browser_action_plan(configuration["browser_action_plan"], f"nodes[{index}].configuration_json.browser_action_plan")
        required = {_BROWSER_CAPABILITIES[action["kind"]] for action in plan["actions"]}
        if not required.issubset(requested):
            missing = ", ".join(sorted(required - requested))
            raise WorkflowGraphError(
                "browser_capability_missing",
                f"Browser action plan requires requested capabilities: {missing}",
                f"nodes[{index}].configuration_json",
            )
        routes = sorted({action["route"] for action in plan["actions"]})
        doctypes = sorted(
            {action["doctype"] for action in plan["actions"] if action.get("doctype")}
        )
        record_names = sorted(
            {action["recordName"] for action in plan["actions"] if action.get("recordName")}
        )
        fields = sorted(
            {action["field"] for action in plan["actions"] if action.get("field")}
        )
        # The resource projection is redundantly recomputed by the gateway. It
        # makes the human-reviewed boundary explicit and leaves a closed slot
        # for transport-verified postconditions without accepting model text.
        plans[node_id] = {
            "surface": "browser",
            "plan": plan,
            "resourceScope": {
                "routes": routes,
                "doctypes": doctypes,
                "recordNames": record_names,
                "fields": fields,
            },
        }
    manifest = {
        "schemaVersion": 1,
        "workflowSnapshotHash": workflow_snapshot_hash,
        "nodePlans": dict(sorted(plans.items())),
    }
    serialized = json.dumps(
        manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    return serialized, sha256(serialized.encode()).hexdigest()


def validate_graph(
    nodes: Iterable[Any], edges: Iterable[Any], limits: GraphLimits | None = None
) -> GraphAnalysis:
    limits = limits or GraphLimits()
    limits.validate()
    nodes = list(nodes)
    edges = list(edges)
    if not nodes:
        raise WorkflowGraphError("empty_graph", "A workflow requires at least one node")
    if len(nodes) > limits.max_active_nodes:
        raise WorkflowGraphError(
            "node_limit",
            f"Workflow has {len(nodes)} nodes; the limit is {limits.max_active_nodes}",
        )

    node_by_id: dict[str, Any] = {}
    for index, node in enumerate(nodes):
        node_id = (_value(node, "node_id") or "").strip()
        if not NODE_ID_PATTERN.fullmatch(node_id):
            raise WorkflowGraphError(
                "invalid_node_id",
                "Node IDs must start with a letter and use only letters, numbers, _ or -",
                f"nodes[{index}].node_id",
            )
        if node_id in node_by_id:
            raise WorkflowGraphError(
                "duplicate_node", f"Duplicate node ID: {node_id}", f"nodes[{index}].node_id"
            )
        node_type = _value(node, "node_type")
        if node_type not in NODE_TYPES:
            raise WorkflowGraphError(
                "invalid_node_type", f"Unsupported node type: {node_type}", f"nodes[{index}]"
            )
        if node_type == "Agent" and not _value(node, "agent"):
            raise WorkflowGraphError(
                "missing_agent", "Agent nodes require an agent", f"nodes[{index}].agent"
            )
        approval_class = _value(node, "approval_class", "Standard") or "Standard"
        if approval_class not in APPROVAL_CLASSES:
            raise WorkflowGraphError(
                "invalid_approval_class",
                f"Unsupported approval class: {approval_class}",
                f"nodes[{index}].approval_class",
            )
        retry_limit = int(_value(node, "retry_limit", 0) or 0)
        if retry_limit < 0 or retry_limit > limits.max_retries:
            raise WorkflowGraphError(
                "retry_limit",
                f"Node retry limit must be between 0 and {limits.max_retries}",
                f"nodes[{index}].retry_limit",
            )
        timeout = int(_value(node, "timeout_seconds", 600) or 0)
        if timeout < 1 or timeout > 86_400:
            raise WorkflowGraphError(
                "timeout_limit",
                "Node timeout must be between 1 and 86400 seconds",
                f"nodes[{index}].timeout_seconds",
            )
        configuration = _configuration(node, index)
        core_kind = configuration.get("core_kind")
        if core_kind is not None and core_kind not in CORE_NODE_KINDS:
            raise WorkflowGraphError(
                "invalid_core_kind",
                f"Unsupported portable node kind: {core_kind}",
                f"nodes[{index}].configuration_json",
            )
        requested = configuration.get("requested_capabilities", [])
        if not isinstance(requested, list) or not all(
            isinstance(capability, str) and capability.strip() for capability in requested
        ):
            raise WorkflowGraphError(
                "invalid_capabilities",
                "requested_capabilities must be an array of non-empty strings",
                f"nodes[{index}].configuration_json",
            )
        if "browser_action_plan" in configuration:
            plan = browser_action_plan(
                configuration["browser_action_plan"],
                f"nodes[{index}].configuration_json.browser_action_plan",
            )
            required = {_BROWSER_CAPABILITIES[action["kind"]] for action in plan["actions"]}
            missing = required - set(requested)
            if missing:
                raise WorkflowGraphError(
                    "browser_capability_missing",
                    f"Browser action plan requires requested capabilities: {', '.join(sorted(missing))}",
                    f"nodes[{index}].configuration_json",
                )
        if "effect_intent" in configuration:
            if "browser_action_plan" in configuration:
                raise WorkflowGraphError(
                    "multiple_execution_surfaces", "A node may declare only one execution surface",
                    f"nodes[{index}].configuration_json",
                )
            intent = effect_intent(
                configuration["effect_intent"],
                f"nodes[{index}].configuration_json.effect_intent",
            )
            if set(requested) != {intent["capability"]}:
                raise WorkflowGraphError(
                    "effect_capability_mismatch",
                    "Effect intent must exactly match its sole requested capability",
                    f"nodes[{index}].configuration_json",
                )
        if node_type == "Bounded Loop":
            iterations = configuration.get("max_iterations")
            progress = configuration.get("progress_predicate")
            if not isinstance(iterations, int) or not 1 <= iterations <= 100 or not progress:
                raise WorkflowGraphError(
                    "unbounded_loop",
                    "Bounded Loop requires max_iterations 1..100 and a progress_predicate",
                    f"nodes[{index}].configuration_json",
                )
        node_by_id[node_id] = node

    incoming = {node_id: 0 for node_id in node_by_id}
    outgoing: dict[str, list[str]] = {node_id: [] for node_id in node_by_id}
    seen_edges: set[tuple[str, str]] = set()
    for index, edge in enumerate(edges):
        source = (_value(edge, "source_node") or "").strip()
        target = (_value(edge, "target_node") or "").strip()
        if source not in node_by_id or target not in node_by_id:
            raise WorkflowGraphError(
                "unknown_node",
                f"Edge {source or '?'} → {target or '?'} references an unknown node",
                f"edges[{index}]",
            )
        if source == target:
            raise WorkflowGraphError(
                "self_edge", "A node cannot connect to itself", f"edges[{index}]"
            )
        key = (source, target)
        if key in seen_edges:
            raise WorkflowGraphError(
                "duplicate_edge", f"Duplicate edge: {source} → {target}", f"edges[{index}]"
            )
        seen_edges.add(key)
        incoming[target] += 1
        outgoing[source].append(target)

    maximum_fan_out = max((len(targets) for targets in outgoing.values()), default=0)
    if maximum_fan_out > limits.max_fan_out:
        raise WorkflowGraphError(
            "fan_out_limit",
            f"Graph fan-out is {maximum_fan_out}; the limit is {limits.max_fan_out}",
        )
    roots = sorted(node_id for node_id, count in incoming.items() if count == 0)
    pending = dict(incoming)
    queue = list(roots)
    order: list[str] = []
    distance = {
        root: 1 if _value(node_by_id[root], "node_type") == "Agent" else 0
        for root in roots
    }
    while queue:
        current = queue.pop(0)
        order.append(current)
        for target in sorted(outgoing[current]):
            increment = int(_value(node_by_id[target], "node_type") == "Agent")
            distance[target] = max(
                distance.get(target, 0), distance[current] + increment
            )
            pending[target] -= 1
            if pending[target] == 0:
                queue.append(target)
                queue.sort()
    if len(order) != len(nodes):
        raise WorkflowGraphError(
            "cycle", "Raw graph cycles are not allowed; use a Bounded Loop node"
        )
    if len(roots) != 1:
        raise WorkflowGraphError(
            "root_count", f"A workflow requires exactly one root; found {len(roots)}"
        )
    depth = max(distance.values(), default=0)
    if depth > limits.max_depth:
        raise WorkflowGraphError(
            "depth_limit", f"Graph depth is {depth}; the limit is {limits.max_depth}"
        )
    return GraphAnalysis(
        root=roots[0],
        node_count=len(nodes),
        edge_count=len(edges),
        depth=depth,
        maximum_fan_out=maximum_fan_out,
        topological_order=tuple(order),
    )


NODE_KIND_MAP = {
    "Agent": "agent",
    "Tool": "command",
    "Approval": "approval",
    "Condition": "condition",
    "Parallel": "parallel_map",
    "Join": "transform",
    "Bounded Loop": "loop",
    "Artifact": "artifact",
}
CORE_NODE_KINDS = {
    "plan", "agent", "subworkflow", "command", "transform", "condition",
    "parallel_map", "approval", "wait", "artifact", "verification",
    "compensation", "loop",
}


def _portable_id(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9_.:-]+", "-", value).strip("-.:_")
    if not normalized or not normalized[0].isalpha():
        normalized = f"workflow-{normalized}"
    return normalized[:120]


def _budget(workflow: Mapping[str, Any]) -> dict[str, int]:
    return {
        "runtimeMs": max(0, int(workflow.get("max_duration_minutes") or 0) * 60_000),
        "toolCalls": max(0, int(workflow.get("max_tool_calls") or 100)),
        "modelCalls": max(0, int(workflow.get("max_model_calls") or 50)),
        "tokens": max(0, int(workflow.get("max_tokens") or 500_000)),
        "costMicros": max(0, int(float(workflow.get("max_cost") or 0) * 1_000_000)),
        "artifactBytes": max(
            0, int(workflow.get("max_artifact_bytes") or 104_857_600)
        ),
    }


def _portable_node(node: Any, graph_budget: dict[str, int]) -> dict[str, Any]:
    configuration = _configuration(node, 0)
    node_type = _value(node, "node_type")
    result: dict[str, Any] = {
        "id": _value(node, "node_id"),
        "kind": configuration.get("core_kind") or NODE_KIND_MAP[node_type],
    }
    if _value(node, "agent"):
        result["agentId"] = _value(node, "agent")
    requested = configuration.get("requested_capabilities") or []
    if requested:
        result["requestedCapabilities"] = sorted(set(requested))
    retry_limit = int(_value(node, "retry_limit", 0) or 0)
    result["retryLimit"] = retry_limit
    if configuration.get("compensation_node_id"):
        result["compensationNodeId"] = configuration["compensation_node_id"]
    if result["kind"] == "loop":
        loop_budget = configuration.get("budget") or graph_budget
        result["loop"] = {
            "maxIterations": configuration["max_iterations"],
            "progressPredicate": configuration["progress_predicate"],
            "cancellationCheckpoint": True,
            "budget": loop_budget,
        }
    return result


def portable_definition(
    workflow: Mapping[str, Any],
    nodes: Iterable[Any],
    edges: Iterable[Any],
    limits: GraphLimits | None = None,
    *,
    version: str | None = None,
) -> dict[str, Any]:
    limits = limits or GraphLimits()
    nodes = list(nodes)
    edges = list(edges)
    analysis = validate_graph(nodes, edges, limits)
    graph_budget = _budget(workflow)
    portable_nodes = [_portable_node(node, graph_budget) for node in nodes]
    portable_nodes.sort(key=lambda item: item["id"])
    portable_edges = [
        {
            "from": _value(edge, "source_node"),
            "to": _value(edge, "target_node"),
            **(
                {"when": _value(edge, "condition_expression")}
                if _value(edge, "condition_expression")
                else {}
            ),
        }
        for edge in edges
    ]
    portable_edges.sort(key=lambda item: (item["from"], item["to"], item.get("when", "")))
    return {
        "schemaVersion": 1,
        "id": _portable_id(str(workflow.get("name") or workflow.get("workflow_name"))),
        "version": str(version or workflow.get("version") or "1"),
        "entryNodeId": analysis.root,
        "nodes": portable_nodes,
        "edges": portable_edges,
        "budget": graph_budget,
        "limits": {
            "maxDepth": limits.max_depth,
            "maxChildrenPerNode": limits.max_fan_out,
            "maxActiveNodes": limits.max_active_nodes,
            "maxRetries": limits.max_retries,
        },
    }


def canonical_snapshot(
    workflow: Mapping[str, Any],
    nodes: Iterable[Any],
    edges: Iterable[Any],
    limits: GraphLimits | None = None,
    *,
    version: str | None = None,
) -> tuple[str, str]:
    snapshot = portable_definition(
        workflow, nodes, edges, limits, version=version
    )
    serialized = json.dumps(
        snapshot, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    return serialized, sha256(serialized.encode()).hexdigest()


def compile_legacy_snapshot(
    value: str | Mapping[str, Any],
    *,
    workflow: Mapping[str, Any] | None = None,
    limits: GraphLimits | None = None,
) -> dict[str, Any]:
    """Compile immutable pre-contract snapshots without mutating their stored evidence."""
    raw = json.loads(value) if isinstance(value, str) else dict(value)
    if raw.get("schemaVersion") == 1:
        return raw
    if raw.get("schema_version") not in {"1.0", 1, "1"}:
        raise WorkflowGraphError("unsupported_schema", "Unsupported workflow snapshot schema")
    legacy_workflow = raw.get("workflow")
    if not isinstance(legacy_workflow, Mapping):
        legacy_workflow = {
            "name": legacy_workflow,
            "workflow_name": legacy_workflow,
            "version": "1",
        }
    merged_workflow = {**legacy_workflow, **(workflow or {})}
    legacy_nodes = []
    for node in raw.get("nodes") or []:
        copied = dict(node) if isinstance(node, Mapping) else node
        if isinstance(copied, dict):
            configuration = dict(_configuration(copied, 0))
            node_id = copied.get("node_id")
            if "core_kind" not in configuration and node_id in {"plan", "verify"}:
                configuration["core_kind"] = (
                    "plan" if node_id == "plan" else "verification"
                )
            copied["configuration_json"] = configuration
        legacy_nodes.append(copied)
    return portable_definition(
        merged_workflow,
        legacy_nodes,
        raw.get("edges") or [],
        limits,
        version=str(merged_workflow.get("version") or "1"),
    )
