"""Reversible Vinman demo fixture for the generic Muster Frappe pack.

Run inside a bench console as Administrator. The script never updates a record
outside the MUSTER-DEMO namespace and does not bypass Frappe permissions.
Set MUSTER_DEMO_SCENARIO to engineering_revision, guided_workflow,
customization_repair, v16_migration, or all. Set MUSTER_DEMO_ACTION to setup,
fault, validate, correct, status, or reset.
"""

from __future__ import annotations

import json
import os
import hashlib

import frappe


NAMESPACE = "MUSTER-DEMO-"
STATE_KEY = "muster_demo_vinman_engineering_v1"
ACTION = os.environ.get("MUSTER_DEMO_ACTION", "status").strip().lower()
SCENARIO = os.environ.get("MUSTER_DEMO_SCENARIO", "engineering_revision").strip().lower().replace("-", "_")
CLAIM_EXISTING = os.environ.get("MUSTER_DEMO_CLAIM_EXISTING") == "yes"

GUIDED_WORKFLOW_STATE_KEY = "muster_demo_vinman_guided_workflow_v1"
CUSTOMIZATION_REPAIR_STATE_KEY = "muster_demo_vinman_customization_repair_v1"
V16_MIGRATION_STATE_KEY = "muster_demo_vinman_v16_migration_v1"


def _allowed(doctype: str, values: dict) -> dict:
    fields = {field.fieldname for field in frappe.get_meta(doctype).fields}
    unknown = sorted(set(values) - fields)
    if unknown:
        raise frappe.ValidationError(
            f"Demo profile does not match {doctype}: unknown fields {', '.join(unknown)}"
        )
    return values


def _apply_values(doc, values: dict) -> None:
    """Converge scalar and child-table values to the declared demo baseline."""
    allowed = _allowed(doc.doctype, values)
    for fieldname, value in allowed.items():
        doc.set(fieldname, value)


def _ensure(doctype: str, name: str, values: dict, receipt_key: str = STATE_KEY):
    if not name.startswith(NAMESPACE):
        raise ValueError(f"Refusing non-demo record name: {doctype} {name}")
    if frappe.db.exists(doctype, name):
        _assert_receipt_owns(doctype, name, receipt_key)
        doc = frappe.get_doc(doctype, name)
        _apply_values(doc, values)
        doc.save()
        return doc
    doc = frappe.get_doc({"doctype": doctype, **_allowed(doctype, values)})
    doc.insert(set_name=name)
    return doc


def _set_demo_values(
    doctype: str,
    name: str,
    values: dict,
    receipt_key: str = STATE_KEY,
) -> None:
    if not name.startswith(NAMESPACE) or not frappe.db.exists(doctype, name):
        raise ValueError(f"Refusing update outside an existing demo record: {doctype} {name}")
    _assert_receipt_owns(doctype, name, receipt_key)
    doc = frappe.get_doc(doctype, name)
    _apply_values(doc, values)
    doc.save()


def _required_site_value(doctype: str, fieldname: str):
    """Reuse a valid site value for mandatory deployment-specific metadata."""
    rows = frappe.get_all(
        doctype,
        filters={fieldname: ["is", "set"]},
        fields=[fieldname],
        order_by=f"{fieldname} asc",
        limit=1,
    )
    value = rows[0].get(fieldname) if rows else None
    if not value:
        raise frappe.ValidationError(
            f"Cannot create demo records: {doctype}.{fieldname} has no valid site value"
        )
    return value


def _state() -> dict:
    return {
        "item": f"{NAMESPACE}ITEM-001",
        "component": f"{NAMESPACE}COMPONENT-001",
        "tool": f"{NAMESPACE}TOOL-001",
        "customer": f"{NAMESPACE}CUSTOMER-001",
        "drawing_review": f"{NAMESPACE}DR-001",
        "apqp": f"{NAMESPACE}APQP-001",
        "control_plan": f"{NAMESPACE}CP-002",
        "process_flow": f"{NAMESPACE}PF-001",
        "ppfmea": f"{NAMESPACE}PPFMEA-001",
        "routing": f"{NAMESPACE}ROUTING-001",
        "bom": f"{NAMESPACE}BOM-001",
        "ppap": f"{NAMESPACE}PPAP-001",
    }


def _record_pairs(state: dict):
    return [
        ("drawing_review", "Drawing Review"), ("apqp", "APQP Timing chart"),
        ("control_plan", "Control Plan"), ("process_flow", "Process Flow"),
        ("ppfmea", "PPFMEA"), ("routing", "Routing"), ("bom", "BOM"),
        ("ppap", "Part Submission Warrant"), ("tool", "Item"),
        ("component", "Item"), ("item", "Item"), ("customer", "Customer"),
    ]


def _load_receipt(state_key: str = STATE_KEY):
    raw = frappe.db.get_default(state_key)
    if not raw:
        return None
    try:
        receipt = json.loads(raw)
    except Exception as error:
        raise frappe.ValidationError("The Muster demo ownership receipt is unreadable") from error
    if receipt.get("schema_version") != 1 or receipt.get("namespace") != NAMESPACE:
        raise frappe.ValidationError("The Muster demo ownership receipt is invalid")
    unsigned = {key: value for key, value in receipt.items() if key != "digest"}
    supplied_digest = receipt.get("digest", "")
    expected_digest = hashlib.sha256(json.dumps(unsigned, sort_keys=True).encode()).hexdigest()
    if supplied_digest != expected_digest:
        raise frappe.ValidationError("The Muster demo ownership receipt digest does not match")
    return receipt


def _receipt_scope(receipt: dict, state: dict, record_pairs, state_key: str | None = None) -> set[tuple[str, str]]:
    if state_key and receipt.get("fixture") != state_key:
        raise frappe.PermissionError("Fixture receipt belongs to a different demo fixture")
    allowed = {(doctype, state[key]) for key, doctype in record_pairs}
    for record in receipt["records"]:
        identity = (record.get("doctype"), record.get("name"))
        if identity not in allowed or not str(identity[1]).startswith(NAMESPACE):
            raise frappe.PermissionError(
                f"Fixture receipt contains an unrelated record: {identity[0]} {identity[1]}"
            )
    return allowed


def _receipt_record(doctype: str, name: str) -> dict:
    if not frappe.db.exists(doctype, name):
        raise frappe.ValidationError(f"Cannot receipt missing demo record: {doctype} {name}")
    return {
        "doctype": doctype,
        "name": name,
        "creation": str(frappe.db.get_value(doctype, name, "creation") or ""),
        "owner": str(frappe.db.get_value(doctype, name, "owner") or ""),
    }


def _assert_receipt_record_is_current(record: dict) -> None:
    doctype, name = record["doctype"], record["name"]
    if (
        str(frappe.db.get_value(doctype, name, "creation") or "") != record["creation"]
        or str(frappe.db.get_value(doctype, name, "owner") or "") != record["owner"]
    ):
        raise frappe.PermissionError(f"Fixture ownership changed for {doctype} {name}")


def _write_receipt(
    state: dict,
    record_pairs=None,
    state_key: str = STATE_KEY,
) -> None:
    pairs = list(record_pairs or _record_pairs(state))
    previous = _load_receipt(state_key)
    if previous:
        _receipt_scope(previous, state, pairs, state_key)
        for record in previous["records"]:
            if frappe.db.exists(record["doctype"], record["name"]):
                _assert_receipt_record_is_current(record)
    records_by_identity = {
        (record["doctype"], record["name"]): record
        for record in (previous["records"] if previous else [])
    }
    for key, doctype in pairs:
        name = state[key]
        if frappe.db.exists(doctype, name):
            record = _receipt_record(doctype, name)
            previous_record = records_by_identity.get((doctype, name))
            if previous_record:
                _assert_receipt_record_is_current(previous_record)
            records_by_identity[(doctype, name)] = record
    records = list(records_by_identity.values())
    payload = {
        "schema_version": 1,
        "namespace": NAMESPACE,
        "fixture": state_key,
        "records": records,
    }
    payload["digest"] = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    frappe.db.set_default(state_key, json.dumps(payload, sort_keys=True))


def _assert_receipt_owns(
    doctype: str,
    name: str,
    state_key: str = STATE_KEY,
) -> None:
    receipt = _load_receipt(state_key)
    if not receipt:
        raise frappe.PermissionError(
            f"Refusing to overwrite unreceipted demo record: {doctype} {name}. "
            "Use MUSTER_DEMO_CLAIM_EXISTING=yes once after independently reviewing the isolated records."
        )
    match = next((row for row in receipt["records"] if row["doctype"] == doctype and row["name"] == name), None)
    if not match:
        raise frappe.PermissionError(f"Fixture receipt does not own {doctype} {name}")
    _assert_receipt_record_is_current(match)


def _assert_no_unreceipted_collisions(
    state: dict,
    record_pairs,
    state_key: str,
) -> None:
    if _load_receipt(state_key) or CLAIM_EXISTING:
        return
    collisions = [
        f"{doctype} {state[key]}"
        for key, doctype in record_pairs
        if frappe.db.exists(doctype, state[key])
    ]
    if collisions:
        raise frappe.PermissionError(
            "Refusing to claim existing demo records without explicit review: "
            + ", ".join(collisions)
        )


def _reset_records(state: dict, record_pairs, state_key: str) -> dict:
    receipt = _load_receipt(state_key)
    if not receipt:
        existing = [
            f"{doctype} {state[key]}"
            for key, doctype in record_pairs
            if frappe.db.exists(doctype, state[key])
        ]
        if existing:
            raise frappe.PermissionError(
                "Refusing reset without a fixture ownership receipt: " + ", ".join(existing)
            )
        return {"state": "absent", "receipted": False, "records": []}
    _receipt_scope(receipt, state, record_pairs, state_key)
    for record in reversed(receipt["records"]):
        doctype, name = record["doctype"], record["name"]
        if not frappe.db.exists(doctype, name):
            continue
        _assert_receipt_owns(doctype, name, state_key)
        doc = frappe.get_doc(doctype, name)
        if doctype == "BOM" and doc.docstatus != 0:
            raise frappe.PermissionError(
                f"Refusing to delete non-draft BOM {name}; the demo never submits or cancels BOMs"
            )
        if doctype != "BOM" and doc.docstatus == 1:
            doc.cancel()
        frappe.delete_doc(doctype, name)
    frappe.db.set_default(state_key, None)
    return {"state": "absent", "receipted": False, "records": []}


def _validation_result(scenario: str, findings: list[dict], records: list[dict]) -> dict:
    return {
        "scenario": scenario,
        "verdict": "PASS" if not findings else "FAIL",
        "findings": findings,
        "records": records,
    }


def _bom_values(state: dict) -> dict:
    """Build a draft BOM without feeding restored optional hooks live references."""
    values = {
        "company": "VINMAN ENGINEERING PVT LTD", "item": state["item"], "quantity": 1,
        "currency": "INR", "conversion_rate": 1,
        # Keep optional inputs inert: restored BOM hooks must not follow
        # references or trigger costing/work-order behavior during the demo.
        "routing": None, "custom_control_plan": None, "transfer_material_against": "Work Order",
        "items": [{"item_code": state["component"], "qty": 1, "uom": "Nos", "rate": 1}],
        "operations": [{"sequence_id": 1, "operation": "Bending", "workstation": "Sub Contracted", "time_in_mins": 10}],
    }
    if frappe.get_meta("BOM").has_field("custom_costing_sheet"):
        values["custom_costing_sheet"] = None
    return values


def setup() -> dict:
    state = _state()
    pairs = _record_pairs(state)
    _assert_no_unreceipted_collisions(state, pairs, STATE_KEY)
    if not _load_receipt() and CLAIM_EXISTING:
        _write_receipt(state, pairs, STATE_KEY)
    item_defaults = {
        "item_group": "Aluminum",
        "stock_uom": "Nos",
        "is_stock_item": 1,
        "gst_hsn_code": _required_site_value("Item", "gst_hsn_code"),
    }
    _ensure("Item", state["item"], {"item_code": state["item"], "item_name": "Muster Demo Revised Component", **item_defaults})
    _ensure("Item", state["component"], {"item_code": state["component"], "item_name": "Muster Demo Raw Component", **item_defaults})
    _ensure("Item", state["tool"], {
        "item_code": state["tool"],
        "item_name": "Muster Demo Inspection Fixture",
        "item_group": "BENDING Tools",
        "stock_uom": "Nos",
        "is_stock_item": 0,
        "gst_hsn_code": item_defaults["gst_hsn_code"],
    })
    _ensure("Customer", state["customer"], {
        "customer_name": state["customer"], "customer_type": "Company", "customer_group": "Commercial",
        "territory": "India", "gst_category": "Unregistered",
    })
    _ensure("Drawing Review", state["drawing_review"], {"part_no": state["item"], "customer": state["customer"]})
    _ensure("APQP Timing chart", state["apqp"], {
        "naming_series": "APQP-.#####", "customer": state["customer"], "part_no": state["item"],
        "part_name": "Muster Demo Revised Component", "revised_from": "A", "rev_no": 2,
    })
    _ensure("Control Plan", state["control_plan"], {
        "naming_series": "CP-.#####", "part_no": state["item"], "customer": state["customer"],
        "drawing_rev_no": "B", "custom_control_plan_rev_number": 2,
        "vinman_control_plan_no": "MUSTER-DEMO-VE-CP-002",
        "process_table": [{
            "process_no": "20", "process_name": "Bending", "machine": state["tool"],
            "productprocessspecificationtolerance": "12.00 +/- 0.05 mm",
            "sample_size": "5 Pieces", "sample_frequency": "Each Lot", "tool": state["tool"],
            "nature_of_change": "Revision B: tighter tolerance and revised inspection fixture",
        }],
    })
    _ensure("Process Flow", state["process_flow"], {
        "naming_series": "PF-.#####", "control_plan": state["control_plan"], "part_no": state["item"],
        "customer": state["customer"], "drawing_review_no": "B",
        "process_table": [{
            "process_no": "20", "process_name": "Bending", "process_specification": "12.00 +/- 0.05 mm",
            "nature_of_change": "Revision B: tighter tolerance and revised inspection fixture",
        }],
    })
    _ensure("PPFMEA", state["ppfmea"], {
        "naming_series": "PPFMEA-.#####", "control_plan": state["control_plan"], "part_no": state["item"],
        "customer": state["customer"], "drawing_review_no": "B",
        "ppfmea_child_table": [{
            "process_no": "20", "process_name": "Bending", "product_specification": "12.00 +/- 0.05 mm",
            "nature_of_change": "Revision B: tighter tolerance and revised inspection fixture",
        }],
    })
    _ensure("Routing", state["routing"], {
        "routing_name": state["routing"],
        "operations": [{"sequence_id": 1, "operation": "Bending", "workstation": "Sub Contracted", "time_in_mins": 10}],
    })
    _ensure("BOM", state["bom"], _bom_values(state))
    _ensure("Part Submission Warrant", state["ppap"], {
        "naming_series": "PSW-.#####", "part_no": state["item"], "part_name": "Muster Demo Revised Component",
        "customer_name": state["customer"], "eng_change_level": "B", "engineering_change": 1,
    })
    _write_receipt(state)
    return status()


def fault() -> dict:
    setup()
    state = _state()
    _set_demo_values("Process Flow", state["process_flow"], {
        "drawing_review_no": "A",
        "process_table": [{"process_no": "10", "process_name": "Shearing", "process_specification": "Legacy 12.00 +/- 0.20 mm", "nature_of_change": "Previous revision"}],
    })
    _set_demo_values("PPFMEA", state["ppfmea"], {
        "drawing_review_no": "A",
        "ppfmea_child_table": [{"process_no": "10", "process_name": "Shearing", "product_specification": "Legacy tolerance", "nature_of_change": "Previous revision"}],
    })
    _set_demo_values("Part Submission Warrant", state["ppap"], {"eng_change_level": "A"})
    return status()


def correct() -> dict:
    state = _state()
    _set_demo_values("Process Flow", state["process_flow"], {
        "drawing_review_no": "B",
        "process_table": [{"process_no": "20", "process_name": "Bending", "process_specification": "12.00 +/- 0.05 mm", "nature_of_change": "Revision B: tighter tolerance and revised inspection fixture"}],
    })
    _set_demo_values("PPFMEA", state["ppfmea"], {
        "drawing_review_no": "B",
        "ppfmea_child_table": [{"process_no": "20", "process_name": "Bending", "product_specification": "12.00 +/- 0.05 mm", "nature_of_change": "Revision B: tighter tolerance and revised inspection fixture"}],
    })
    _set_demo_values("Part Submission Warrant", state["ppap"], {"eng_change_level": "B"})
    return status()


def status() -> dict:
    state = _state()
    rows = []
    for key, doctype in [
        ("drawing_review", "Drawing Review"), ("apqp", "APQP Timing chart"), ("control_plan", "Control Plan"),
        ("process_flow", "Process Flow"), ("ppfmea", "PPFMEA"), ("routing", "Routing"),
        ("bom", "BOM"), ("ppap", "Part Submission Warrant"),
    ]:
        name = state[key]
        rows.append({"stage": key, "doctype": doctype, "name": name, "exists": bool(frappe.db.exists(doctype, name))})
    critical = {}
    if frappe.db.exists("Process Flow", state["process_flow"]):
        doc = frappe.get_doc("Process Flow", state["process_flow"])
        critical["process_flow"] = {
            "revision": doc.get("drawing_review_no"),
            "process": doc.get("process_table")[0].get("process_name") if doc.get("process_table") else None,
        }
    if frappe.db.exists("PPFMEA", state["ppfmea"]):
        doc = frappe.get_doc("PPFMEA", state["ppfmea"])
        critical["ppfmea"] = {
            "revision": doc.get("drawing_review_no"),
            "process": doc.get("ppfmea_child_table")[0].get("process_name") if doc.get("ppfmea_child_table") else None,
        }
    if frappe.db.exists("Part Submission Warrant", state["ppap"]):
        critical["ppap_revision"] = frappe.db.get_value(
            "Part Submission Warrant", state["ppap"], "eng_change_level"
        )
    revisions = {
        critical.get("process_flow", {}).get("revision"),
        critical.get("ppfmea", {}).get("revision"),
        critical.get("ppap_revision"),
    } - {None}
    receipt = _load_receipt()
    expected_critical = {
        "process_flow": {"revision": "B", "process": "Bending"},
        "ppfmea": {"revision": "B", "process": "Bending"},
        "ppap_revision": "B",
    }
    declared_records = {(doctype, state[key]) for key, doctype in _record_pairs(state)}
    receipted_records = {
        (record["doctype"], record["name"]) for record in receipt["records"]
    } if receipt else set()
    if receipt:
        _receipt_scope(receipt, state, _record_pairs(state), STATE_KEY)
    complete = all(frappe.db.exists(doctype, state[key]) for key, doctype in _record_pairs(state))
    bom_docstatus = frappe.db.get_value("BOM", state["bom"], "docstatus")
    bom_is_draft = bom_docstatus is not None and int(bom_docstatus) == 0
    baseline = (
        complete
        and bom_is_draft
        and declared_records <= receipted_records
        and critical == expected_critical
    )
    receipted = bool(receipt)
    fixture_state = "absent" if not any(row["exists"] for row in rows) else (
        "baseline" if baseline else "faulted" if "A" in revisions else "invalid"
    )
    return {"namespace": NAMESPACE, "state": fixture_state, "receipted": receipted, "critical": critical, "records": rows}


def validate() -> dict:
    current = status()
    findings = []
    expected = {
        "process_flow": {"revision": "B", "process": "Bending"},
        "ppfmea": {"revision": "B", "process": "Bending"},
        "ppap_revision": "B",
    }
    if current["state"] == "absent":
        findings.append({"code": "ENGINEERING_FIXTURE_ABSENT", "observed": "absent", "expected": "baseline"})
    elif current["state"] != "baseline":
        findings.append({
            "code": "ENGINEERING_FIXTURE_NOT_BASELINE",
            "observed": current["state"],
            "expected": "baseline",
        })
    for key, expected_value in expected.items():
        observed = current["critical"].get(key)
        if observed != expected_value:
            findings.append({
                "code": f"ENGINEERING_{key.upper()}_MISMATCH",
                "observed": observed,
                "expected": expected_value,
            })
    return _validation_result("engineering_revision", findings, current["records"])


def reset() -> dict:
    state = _state()
    pairs = [
        ("customer", "Customer"), ("item", "Item"), ("component", "Item"),
        ("tool", "Item"), ("drawing_review", "Drawing Review"),
        ("apqp", "APQP Timing chart"), ("control_plan", "Control Plan"),
        ("process_flow", "Process Flow"), ("ppfmea", "PPFMEA"),
        ("routing", "Routing"), ("bom", "BOM"),
        ("ppap", "Part Submission Warrant"),
    ]
    _reset_records(state, pairs, STATE_KEY)
    return status()


def _guided_workflow_values(*, complete: bool) -> dict:
    return {
        "description": (
            "Muster demo engineering release review completed. The approved revision may move to production."
            if complete
            else "Muster demo engineering review is waiting for the required release confirmation."
        ),
        "status": "Closed" if complete else "Open",
        "priority": "Medium",
        # Reference the installed customization schema, not another scenario's
        # disposable record. This keeps the guided fixture independently
        # reversible while preserving useful form context for the demo.
        "reference_type": "DocType",
        "reference_name": "Control Plan",
    }


def _customization_script(*, faulted: bool) -> str:
    if faulted:
        return """frappe.ui.form.on(\"Control Plan\", {
  validate(frm) {
    if (frm.doc.drawing_rev_no === \"B\") {
      frappe.throw(__(\"Only revision A is permitted for this operation.\"));
    }
  }
});"""
    return """frappe.ui.form.on(\"Control Plan\", {
  validate(frm) {
    if (frm.doc.drawing_rev_no === \"B\") {
      frappe.show_alert({ message: __(\"Revision B is ready for review.\"), indicator: \"green\" });
    }
  }
});"""


def _v16_report_query(*, faulted: bool) -> str:
    columns = "name AS item_code, item_name, modified"
    if faulted:
        columns = "name AS item_code, legacy_drawing_revision, old_operation_sequence"
    return (
        f"SELECT {columns} FROM `tabItem` "
        f"WHERE name LIKE '{NAMESPACE}%%' ORDER BY modified DESC"
    )


def _additional_scenario_specs() -> dict:
    return {
        "guided_workflow": {
            "state_key": GUIDED_WORKFLOW_STATE_KEY,
            "finding_code": "GUIDED_WORKFLOW_STEP_INCOMPLETE",
            "records": [{
                "key": "task", "doctype": "ToDo",
                "name": f"{NAMESPACE}GUIDED-WORKFLOW-001",
                "baseline": _guided_workflow_values(complete=True),
                "fault": _guided_workflow_values(complete=False),
                "compare": ["description", "status", "priority", "reference_type", "reference_name"],
            }],
        },
        "customization_repair": {
            "state_key": CUSTOMIZATION_REPAIR_STATE_KEY,
            "finding_code": "CUSTOMIZATION_RULE_REJECTS_VALID_REVISION",
            "records": [{
                "key": "client_script", "doctype": "Client Script",
                "name": f"{NAMESPACE}VALIDATE-REVISED-OPERATION",
                "baseline": {
                    "dt": "Control Plan", "view": "Form", "enabled": 1,
                    "script": _customization_script(faulted=False),
                },
                "fault": {"enabled": 1, "script": _customization_script(faulted=True)},
                "compare": ["dt", "view", "enabled", "script"],
                "integer_fields": ["enabled"],
            }],
        },
        "v15_to_v16_migration": {
            "state_key": V16_MIGRATION_STATE_KEY,
            "finding_code": "V16_REPORT_SCHEMA_REFERENCE_STALE",
            "records": [{
                "key": "report", "doctype": "Report",
                "name": f"{NAMESPACE}V16-ENGINEERING-READINESS",
                "baseline": {
                    "report_name": f"{NAMESPACE}V16-ENGINEERING-READINESS",
                    "ref_doctype": "Item", "report_type": "Query Report",
                    "is_standard": "No", "disabled": 0,
                    "query": _v16_report_query(faulted=False),
                },
                "fault": {"disabled": 0, "query": _v16_report_query(faulted=True)},
                "compare": ["ref_doctype", "report_type", "is_standard", "disabled", "query"],
                "integer_fields": ["disabled"],
            }],
        },
    }


def _scenario_parts(scenario: str):
    spec = _additional_scenario_specs()[scenario]
    state = {record["key"]: record["name"] for record in spec["records"]}
    pairs = [(record["key"], record["doctype"]) for record in spec["records"]]
    return spec, state, pairs


def _scenario_observed(record: dict, doc) -> dict:
    integer_fields = set(record.get("integer_fields", []))
    return {
        fieldname: int(doc.get(fieldname) or 0) if fieldname in integer_fields else doc.get(fieldname)
        for fieldname in record["compare"]
    }


def _scenario_expected(record: dict) -> dict:
    return {
        fieldname: record["baseline"].get(fieldname)
        for fieldname in record["compare"]
    }


def additional_scenario_setup(scenario: str) -> dict:
    spec, state, pairs = _scenario_parts(scenario)
    _assert_no_unreceipted_collisions(state, pairs, spec["state_key"])
    if not _load_receipt(spec["state_key"]) and CLAIM_EXISTING:
        _write_receipt(state, pairs, spec["state_key"])
    for record in spec["records"]:
        _ensure(record["doctype"], record["name"], record["baseline"], spec["state_key"])
    _write_receipt(state, pairs, spec["state_key"])
    return additional_scenario_status(scenario)


def additional_scenario_fault(scenario: str) -> dict:
    additional_scenario_setup(scenario)
    spec, _state, _pairs = _scenario_parts(scenario)
    for record in spec["records"]:
        _set_demo_values(record["doctype"], record["name"], record["fault"], spec["state_key"])
    return additional_scenario_status(scenario)


def additional_scenario_correct(scenario: str) -> dict:
    spec, _state, _pairs = _scenario_parts(scenario)
    for record in spec["records"]:
        _set_demo_values(record["doctype"], record["name"], record["baseline"], spec["state_key"])
    return additional_scenario_status(scenario)


def additional_scenario_status(scenario: str) -> dict:
    spec, _state, _pairs = _scenario_parts(scenario)
    records = []
    observed = {}
    expected = {}
    for record in spec["records"]:
        exists = bool(frappe.db.exists(record["doctype"], record["name"]))
        records.append({"doctype": record["doctype"], "name": record["name"], "exists": exists})
        expected[record["key"]] = _scenario_expected(record)
        if exists:
            observed[record["key"]] = _scenario_observed(
                record, frappe.get_doc(record["doctype"], record["name"])
            )
    return {
        "scenario": scenario,
        "state": "absent" if not any(row["exists"] for row in records)
        else "baseline" if observed == expected else "faulted",
        "receipted": bool(_load_receipt(spec["state_key"])),
        "observed": observed,
        "records": records,
    }


def additional_scenario_validate(scenario: str) -> dict:
    spec, _state, _pairs = _scenario_parts(scenario)
    current = additional_scenario_status(scenario)
    expected = {record["key"]: _scenario_expected(record) for record in spec["records"]}
    findings = [] if current["observed"] == expected else [{
        "code": spec["finding_code"], "observed": current["observed"], "expected": expected,
    }]
    return _validation_result(scenario, findings, current["records"])


def additional_scenario_reset(scenario: str) -> dict:
    spec, state, pairs = _scenario_parts(scenario)
    _reset_records(state, pairs, spec["state_key"])
    return additional_scenario_status(scenario)


def _additional_action_map(scenario: str) -> dict:
    return {
        "setup": lambda: additional_scenario_setup(scenario),
        "fault": lambda: additional_scenario_fault(scenario),
        "validate": lambda: additional_scenario_validate(scenario),
        "correct": lambda: additional_scenario_correct(scenario),
        "status": lambda: additional_scenario_status(scenario),
        "reset": lambda: additional_scenario_reset(scenario),
    }


SCENARIO_ACTIONS = {
    "engineering_revision": {
        "setup": setup, "fault": fault, "validate": validate,
        "correct": correct, "status": status, "reset": reset,
    },
    "guided_workflow": _additional_action_map("guided_workflow"),
    "customization_repair": _additional_action_map("customization_repair"),
    "v15_to_v16_migration": _additional_action_map("v15_to_v16_migration"),
}
SCENARIO_ALIASES = {
    "engineering": "engineering_revision",
    "revision_escape": "engineering_revision",
    "workflow": "guided_workflow",
    "authorized_customization_repair": "customization_repair",
    "v16_migration": "v15_to_v16_migration",
    "migration": "v15_to_v16_migration",
}

if ACTION not in {"setup", "fault", "validate", "correct", "status", "reset"}:
    raise ValueError(f"Unsupported MUSTER_DEMO_ACTION: {ACTION}")
if frappe.session.user != "Administrator":
    raise frappe.PermissionError("Run this demo fixture from an Administrator bench console")

try:
    selected = SCENARIO_ALIASES.get(SCENARIO, SCENARIO)
    if selected == "all":
        ordered = list(SCENARIO_ACTIONS)
        if ACTION == "reset":
            ordered.reverse()
        result = {
            "scenario": "all",
            "action": ACTION,
            "results": {name: SCENARIO_ACTIONS[name][ACTION]() for name in ordered},
        }
    else:
        if selected not in SCENARIO_ACTIONS:
            choices = ", ".join([*SCENARIO_ACTIONS, "all"])
            raise ValueError(f"Unsupported MUSTER_DEMO_SCENARIO: {SCENARIO}. Choose {choices}")
        result = SCENARIO_ACTIONS[selected][ACTION]()
    frappe.db.commit()
except Exception:
    frappe.db.rollback()
    raise

print(json.dumps(result, indent=2, default=str))
