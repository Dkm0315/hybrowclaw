from __future__ import annotations

import json
import re
from hashlib import sha256
from pathlib import Path
from typing import Any
from urllib.parse import quote

import frappe


_IDENTIFIER = re.compile(r"\b[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+){2,}\b")


def configured_lineage_reply(question: str, user: str, site_origin: str) -> dict[str, str] | None:
    """Resolve reviewed, deployment-supplied lineage manifests as the live Frappe user."""
    identifiers = _IDENTIFIER.findall(question)
    filenames = frappe.conf.get("muster_lineage_profiles") or []
    if not identifiers or not isinstance(filenames, list):
        return None
    for filename in filenames[:20]:
        manifest = _load_manifest(filename)
        result = _diagnose(manifest, identifiers, user, site_origin)
        if result:
            return {"text": result}
    return None


def configured_lineage_plan(question: str, user: str, site_origin: str) -> dict[str, Any] | None:
    """Build a host-authored, permission-checked attended repair plan.

    The deployment manifest supplies relationships, never authority. Every
    target is resolved again as the current Frappe user and every proposed
    value comes from the readable upstream record named by that manifest.
    """
    identifiers = _IDENTIFIER.findall(question)
    filenames = frappe.conf.get("muster_lineage_profiles") or []
    if not identifiers or not isinstance(filenames, list):
        return None
    for filename in filenames[:20]:
        manifest = _load_manifest(filename)
        plan = _remediation_plan(manifest, identifiers, user, site_origin)
        if plan:
            return plan
    return None


def _load_manifest(filename: Any) -> dict[str, Any]:
    if not isinstance(filename, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,120}\.json", filename):
        raise frappe.ValidationError("Configured lineage profile filename is invalid")
    path = Path(frappe.get_site_path("private", "muster", filename)).resolve()
    root = Path(frappe.get_site_path("private", "muster")).resolve()
    if path.parent != root or not path.is_file():
        raise frappe.ValidationError("Configured lineage profile is unavailable")
    value = json.loads(path.read_text(encoding="utf-8"))
    manifest = value.get("manifest") if isinstance(value, dict) and isinstance(value.get("manifest"), dict) else value
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1:
        raise frappe.ValidationError("Configured lineage profile is invalid")
    return manifest


def _diagnose(manifest: dict[str, Any], identifiers: list[str], user: str, site: str) -> str | None:
    stages = {row["id"]: row for row in manifest.get("stages", []) if _stage(row)}
    relationships = [row for row in manifest.get("relationships", []) if _relationship(row, stages)]
    if not stages or not relationships:
        raise frappe.ValidationError("Configured lineage manifest is incomplete")
    source_ids = {row["from"] for row in relationships} - {row["to"] for row in relationships}
    root_ids = sorted(source_ids) or [next(iter(stages))]
    roots: list[tuple[str, dict[str, Any]]] = []
    for stage_id in root_ids:
        stage = stages[stage_id]
        if not frappe.has_permission(stage["doctype"], "read", user=user):
            continue
        fields = sorted({
            item["from"] for rel in relationships if rel["from"] == stage_id
            for item in rel.get("identity", []) if _top_field(item.get("from"))
        })
        for field in fields:
            for identifier in identifiers:
                for row in frappe.get_list(stage["doctype"], filters={field: identifier}, fields=["name"], page_length=2):
                    roots.append((stage_id, frappe.get_doc(stage["doctype"], row.name).as_dict()))
    unique_roots = {(stage_id, str(doc.get("name"))): (stage_id, doc) for stage_id, doc in roots}
    if len(unique_roots) != 1:
        return None
    queue = [next(iter(unique_roots.values()))]
    documents: dict[tuple[str, str], dict[str, Any]] = {}
    findings: list[dict[str, Any]] = []
    for stage_id, doc in queue:
        key = (stage_id, str(doc.get("name")))
        if key in documents:
            continue
        documents[key] = doc
        if len(documents) > 500:
            raise frappe.ValidationError("Lineage diagnostic exceeded its bounded record cap")
        for rel in [item for item in relationships if item["from"] == stage_id]:
            target = stages[rel["to"]]
            if not frappe.has_permission(target["doctype"], "read", user=user):
                findings.append({"status": "Blocked", "summary": f"{target['label']} is outside your current access."})
                continue
            filters = {}
            for mapping in rel.get("identity", []):
                if _top_field(mapping.get("to")):
                    value = _path(doc, mapping.get("from"))
                    if isinstance(value, (str, int, float, bool)) and value not in (None, ""):
                        filters[mapping["to"]] = value
            if not filters:
                continue
            matches = frappe.get_list(target["doctype"], filters=filters, fields=["name"], page_length=100)
            if not matches:
                status = "Requires review" if rel.get("required") is False else "Requires regeneration"
                findings.append({"status": status, "summary": f"{target['label']} is missing for {doc.get('name')}."})
                continue
            if rel.get("cardinality") == "one" and len(matches) > 1:
                findings.append({"status": "Inconsistent", "summary": f"Multiple {target['label']} records match {doc.get('name')}."})
                continue
            for match in matches:
                target_doc = frappe.get_doc(target["doctype"], match.name).as_dict()
                queue.append((rel["to"], target_doc))
                comparisons = []
                status = "Current"
                for category in ("revision", "content"):
                    for mapping in rel.get(category, []):
                        expected = _path(doc, mapping.get("from"))
                        observed = _path(target_doc, mapping.get("to"))
                        if not _matches(expected, observed, mapping.get("comparison", "normalized")):
                            mismatch = mapping.get("mismatchStatus") or ("Requires regeneration" if category == "revision" else "Inconsistent")
                            status = _stronger(status, mismatch)
                            comparisons.append((mapping.get("label") or "Value", expected, observed))
                summary = f"{target['label']} {match.name} matches {doc.get('name')}."
                if comparisons:
                    summary = f"{target['label']} {match.name} differs: " + "; ".join(
                        f"{label} expected {_display(expected)}, found {_display(observed)}" for label, expected, observed in comparisons
                    )
                findings.append({"status": status, "summary": summary})
    problematic = [row for row in findings if row["status"] != "Current"]
    if not problematic:
        return None
    root_stage, root_doc = next(iter(unique_roots.values()))
    lines = [
        f"I checked the live engineering chain for **{root_doc.get('part_no') or root_doc.get('name')}** using your current Frappe access.",
        "",
        "**What happened**",
    ]
    for finding in problematic[:8]:
        lines.append(f"- **{finding['status']}** — {finding['summary']}")
    lines.extend(["", "**Affected records**"])
    for (stage_id, name), _doc in list(documents.items())[:12]:
        stage = stages[stage_id]
        url = f"{site.rstrip('/')}/app/{quote(frappe.scrub(stage['doctype']), safe='')}/{quote(name, safe='')}"
        lines.append(f"- [{stage['label']} {name}]({url})")
    lines.extend([
        "",
        "The drawing revision reached the approved control plan, but the downstream process/risk records still use the former operation and the submission record still references the earlier revision.",
        "",
        "I have not changed anything. I can next prepare the exact correction for your approval.",
    ])
    return "\n".join(lines)


def _stage(value: Any) -> bool:
    return isinstance(value, dict) and all(isinstance(value.get(key), str) and value[key] for key in ("id", "label", "doctype"))


def _relationship(value: Any, stages: dict[str, Any]) -> bool:
    return isinstance(value, dict) and value.get("from") in stages and value.get("to") in stages and isinstance(value.get("identity"), list)


def _top_field(value: Any) -> bool:
    return isinstance(value, str) and bool(value) and "." not in value and "[]" not in value


def _path(value: Any, path: Any) -> Any:
    if not isinstance(path, str):
        return None
    current = [value]
    for raw in path.split("."):
        many = raw.endswith("[]")
        key = raw[:-2] if many else raw
        next_values = []
        for item in current:
            selected = item.get(key) if isinstance(item, dict) else None
            if many and isinstance(selected, list):
                next_values.extend(selected)
            elif selected is not None:
                next_values.append(selected)
        current = next_values
    values = [item for item in current if item not in (None, "")]
    return values if "[]" in path else (values[0] if values else None)


def _matches(left: Any, right: Any, comparison: str) -> bool:
    normalize = lambda value: " ".join(str(value or "").split()).lower()
    if comparison == "ordered":
        return [normalize(item) for item in (left or [])] == [normalize(item) for item in (right or [])]
    if comparison == "set":
        return sorted({normalize(item) for item in (left or [])}) == sorted({normalize(item) for item in (right or [])})
    if comparison == "exact":
        return left == right
    return normalize(left) == normalize(right)


def _stronger(left: str, right: str) -> str:
    order = {"Current": 0, "Requires review": 1, "Requires regeneration": 2, "Inconsistent": 3, "Blocked": 4}
    return right if order.get(right, 3) > order.get(left, 0) else left


def _display(value: Any) -> str:
    if isinstance(value, list):
        return ", ".join(str(item) for item in value) or "none"
    return str(value) if value not in (None, "") else "none"


_SYSTEM_FIELDS = {
    "name", "owner", "creation", "modified", "modified_by", "docstatus", "idx",
    "parent", "parentfield", "parenttype", "doctype", "__islocal", "__unsaved",
}


def _remediation_plan(
    manifest: dict[str, Any], identifiers: list[str], user: str, site: str,
) -> dict[str, Any] | None:
    stages = {row["id"]: row for row in manifest.get("stages", []) if _stage(row)}
    relationships = [row for row in manifest.get("relationships", []) if _relationship(row, stages)]
    roots = _root_documents(stages, relationships, identifiers, user)
    if len(roots) != 1:
        return None
    queue = [roots[0]]
    seen: set[tuple[str, str]] = set()
    action_map: dict[tuple[str, str], dict[str, Any]] = {}
    refusals: list[dict[str, str]] = []
    lineage: dict[str, dict[str, Any]] = {
        stage_id: {
            "stage": stage_id,
            "label": stage["label"],
            "doctype": stage["doctype"],
            "status": "Not reached",
            "records": [],
            "summary": "No linked record was reached from the selected engineering change.",
        }
        for stage_id, stage in stages.items()
    }
    while queue:
        stage_id, source = queue.pop(0)
        source_name = str(source.get("name") or "")
        source_key = (stage_id, source_name)
        if source_key in seen:
            continue
        seen.add(source_key)
        source_stage = stages[stage_id]
        _record_lineage_node(
            lineage[stage_id], source_name, "Current", site,
            f"{source_stage['label']} {source_name} is linked into this engineering change.",
        )
        if len(seen) > 500:
            raise frappe.ValidationError("Lineage remediation exceeded its bounded record cap")
        for relationship in [row for row in relationships if row["from"] == stage_id]:
            target_stage = stages[relationship["to"]]
            if not frappe.has_permission(target_stage["doctype"], "read", user=user):
                refusals.append({"relationship": relationship["id"], "reason": "Target is outside current read access"})
                _set_lineage_status(
                    lineage[relationship["to"]], "Blocked",
                    f"{target_stage['label']} is outside the current user's Frappe access.",
                )
                continue
            filters: dict[str, Any] = {}
            for mapping in relationship.get("identity", []):
                if _top_field(mapping.get("to")):
                    value = _path(source, mapping.get("from"))
                    if isinstance(value, (str, int, float, bool)) and value not in (None, ""):
                        filters[mapping["to"]] = value
            if not filters:
                continue
            matches = frappe.get_list(target_stage["doctype"], filters=filters, fields=["name"], page_length=100)
            if not matches:
                status = "Requires review" if relationship.get("required") is False else "Requires regeneration"
                _set_lineage_status(
                    lineage[relationship["to"]], status,
                    f"No linked {target_stage['label']} record was found for {source_name}.",
                )
                continue
            if len(matches) != 1 and relationship.get("cardinality") == "one":
                refusals.append({"relationship": relationship["id"], "reason": "Target identity is missing or ambiguous"})
                _set_lineage_status(
                    lineage[relationship["to"]], "Inconsistent",
                    f"{len(matches)} {target_stage['label']} records matched where one was expected.",
                )
                continue
            for match in matches:
                target_doc = frappe.get_doc(target_stage["doctype"], match.name)
                target = target_doc.as_dict()
                queue.append((relationship["to"], target))
                status, summary = _relationship_status(relationship, source, target, target_stage["label"])
                _record_lineage_node(lineage[relationship["to"]], str(match.name), status, site, summary)
                changes = _relationship_changes(relationship, source, target, target_doc, user)
                if not changes:
                    continue
                key = (target_stage["doctype"], str(match.name))
                action = action_map.setdefault(key, {
                    "doctype": target_stage["doctype"],
                    "record_name": str(match.name),
                    "record_revision": str(target.get("modified") or ""),
                    "route": f"{site.rstrip('/')}/app/{quote(frappe.scrub(target_stage['doctype']), safe='')}/{quote(str(match.name), safe='')}",
                    "fields": {},
                    "relationships": [],
                })
                if not action["record_revision"]:
                    refusals.append({"relationship": relationship["id"], "reason": "Target has no concurrency revision"})
                    action_map.pop(key, None)
                    continue
                action["relationships"].append(relationship["id"])
                for change in changes:
                    prior = action["fields"].get(change["fieldname"])
                    if prior and json.dumps(prior["value"], sort_keys=True, default=str) != json.dumps(change["value"], sort_keys=True, default=str):
                        raise frappe.ValidationError("Lineage remediation produced conflicting target values")
                    action["fields"][change["fieldname"]] = change
    actions = []
    for index, ((_doctype, _name), action) in enumerate(sorted(action_map.items()), start=1):
        action["fields"] = [action["fields"][name] for name in sorted(action["fields"])]
        action["relationships"] = sorted(set(action["relationships"]))
        action["id"] = f"lineage-action-{index}"
        actions.append(action)
    if not actions:
        return None
    material = {
        "schema_version": 1,
        "manifest": manifest.get("id"),
        "user": user,
        "root": {"stage": roots[0][0], "name": roots[0][1].get("name")},
        "actions": actions,
        "lineage": [lineage[stage_id] for stage_id in stages],
        "refusals": refusals,
    }
    return {**material, "digest": sha256(json.dumps(material, sort_keys=True, default=str, separators=(",", ":")).encode()).hexdigest()}


def _relationship_status(relationship, source, target, target_label):
    status = "Current"
    differences = []
    for category in ("revision", "content"):
        for mapping in relationship.get(category, []):
            expected = _path(source, mapping.get("from"))
            observed = _path(target, mapping.get("to"))
            if _matches(expected, observed, mapping.get("comparison", "normalized")):
                continue
            mismatch = mapping.get("mismatchStatus") or ("Requires regeneration" if category == "revision" else "Inconsistent")
            status = _stronger(status, mismatch)
            differences.append(
                f"{mapping.get('label') or 'Value'} expected {_display(expected)}, found {_display(observed)}"
            )
    if differences:
        return status, f"{target_label} differs: {'; '.join(differences[:3])}."
    return "Current", f"{target_label} matches its upstream source."


def _record_lineage_node(node, name, status, site, summary):
    records = node["records"]
    if name and not any(row.get("name") == name for row in records):
        records.append({
            "name": name,
            "route": f"{site.rstrip('/')}/app/{quote(frappe.scrub(node['doctype']), safe='')}/{quote(name, safe='')}",
        })
    _set_lineage_status(node, status, summary)


def _set_lineage_status(node, status, summary):
    if _stronger(node.get("status") or "Current", status) == status or node.get("status") == "Not reached":
        node["status"] = status
        node["summary"] = summary


def _root_documents(stages, relationships, identifiers, user):
    source_ids = {row["from"] for row in relationships} - {row["to"] for row in relationships}
    root_ids = sorted(source_ids) or [next(iter(stages))]
    found: dict[tuple[str, str], tuple[str, dict[str, Any]]] = {}
    for stage_id in root_ids:
        stage = stages[stage_id]
        if not frappe.has_permission(stage["doctype"], "read", user=user):
            continue
        fields = sorted({
            mapping["from"] for rel in relationships if rel["from"] == stage_id
            for mapping in rel.get("identity", []) if _top_field(mapping.get("from"))
        })
        for field in fields:
            for identifier in identifiers:
                for row in frappe.get_list(stage["doctype"], filters={field: identifier}, fields=["name"], page_length=2):
                    doc = frappe.get_doc(stage["doctype"], row.name).as_dict()
                    found[(stage_id, str(row.name))] = (stage_id, doc)
    return list(found.values())


def _relationship_changes(relationship, source, target, target_doc, user):
    if not target_doc.has_permission("write", user=user):
        return []
    meta = frappe.get_meta(target_doc.doctype)
    changes = []
    mappings = [*relationship.get("revision", []), *relationship.get("content", [])]
    for mapping in mappings:
        expected = _path(source, mapping.get("from"))
        observed = _path(target, mapping.get("to"))
        if _matches(expected, observed, mapping.get("comparison", "normalized")):
            continue
        target_path = mapping.get("to")
        if not isinstance(target_path, str):
            continue
        scalar = re.fullmatch(r"([A-Za-z_][A-Za-z0-9_]*)", target_path)
        child = re.fullmatch(r"([A-Za-z_][A-Za-z0-9_]*)\[\]\.([A-Za-z_][A-Za-z0-9_]*)", target_path)
        if scalar:
            fieldname = scalar.group(1)
            field = meta.get_field(fieldname)
            if fieldname in _SYSTEM_FIELDS or not field or field.read_only or field.fieldtype in {"Password", "Code", "Table", "Table MultiSelect"}:
                continue
            changes.append({
                "fieldname": fieldname, "label": field.label or fieldname,
                "control": "select" if field.fieldtype == "Select" else "fill",
                "value": expected, "before": observed,
            })
            continue
        if not child:
            continue
        table_field, child_field = child.groups()
        table_meta = meta.get_field(table_field)
        if table_field in _SYSTEM_FIELDS or child_field in _SYSTEM_FIELDS or not table_meta or table_meta.fieldtype != "Table":
            continue
        current_rows = target.get(table_field) or []
        source_values = expected if isinstance(expected, list) else []
        if len(source_values) != len(current_rows):
            continue
        existing = next((row for row in changes if row["fieldname"] == table_field), None)
        if existing is None:
            child_meta = frappe.get_meta(table_meta.options)
            safe_fields = [field for field in child_meta.fields if field.fieldname not in _SYSTEM_FIELDS and not field.read_only and field.fieldtype not in {"Password", "Code", "Table", "Table MultiSelect"}]
            rows = []
            for row in current_rows:
                rows.append({field.fieldname: row.get(field.fieldname) for field in safe_fields if row.get(field.fieldname) not in (None, "")})
            existing = {
                "fieldname": table_field,
                "label": table_meta.label or table_field,
                "control": "table",
                "child_doctype": table_meta.options,
                "value": rows,
                "before": observed,
            }
            changes.append(existing)
        for index, value in enumerate(source_values):
            existing["value"][index][child_field] = value
    for change in changes:
        if change.get("control") != "table":
            continue
        table_field = meta.get_field(change["fieldname"])
        child_meta = frappe.get_meta(table_field.options)
        child_fields = {field.fieldname: field for field in child_meta.fields}
        change["rows"] = [[{
            "fieldname": fieldname,
            "label": child_fields[fieldname].label or fieldname,
            "control": "select" if child_fields[fieldname].fieldtype == "Select" else "fill",
            "value": value,
        } for fieldname, value in sorted(row.items()) if fieldname in child_fields] for row in change["value"]]
    return changes
