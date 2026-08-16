"""Reversible Vinman demo fixture for the generic Muster Frappe pack.

Run inside a bench console as Administrator. The script never updates a record
outside the MUSTER-DEMO namespace and does not bypass Frappe permissions.
Set MUSTER_DEMO_ACTION to setup, fault, correct, status, or reset.
"""

from __future__ import annotations

import json
import os
import hashlib

import frappe


NAMESPACE = "MUSTER-DEMO-"
STATE_KEY = "muster_demo_vinman_engineering_v1"
ACTION = os.environ.get("MUSTER_DEMO_ACTION", "status").strip().lower()
CLAIM_EXISTING = os.environ.get("MUSTER_DEMO_CLAIM_EXISTING") == "yes"


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


def _ensure(doctype: str, name: str, values: dict):
    if not name.startswith(NAMESPACE):
        raise ValueError(f"Refusing non-demo record name: {doctype} {name}")
    if frappe.db.exists(doctype, name):
        _assert_receipt_owns(doctype, name)
        doc = frappe.get_doc(doctype, name)
        _apply_values(doc, values)
        doc.save()
        return doc
    doc = frappe.get_doc({"doctype": doctype, **_allowed(doctype, values)})
    doc.insert(set_name=name)
    return doc


def _set_demo_values(doctype: str, name: str, values: dict) -> None:
    if not name.startswith(NAMESPACE) or not frappe.db.exists(doctype, name):
        raise ValueError(f"Refusing update outside an existing demo record: {doctype} {name}")
    _assert_receipt_owns(doctype, name)
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


def _load_receipt():
    raw = frappe.db.get_default(STATE_KEY)
    if not raw:
        return None
    try:
        receipt = json.loads(raw)
    except Exception as error:
        raise frappe.ValidationError("The Muster demo ownership receipt is unreadable") from error
    if receipt.get("schema_version") != 1 or receipt.get("namespace") != NAMESPACE:
        raise frappe.ValidationError("The Muster demo ownership receipt is invalid")
    supplied_digest = receipt.pop("digest", "")
    expected_digest = hashlib.sha256(json.dumps(receipt, sort_keys=True).encode()).hexdigest()
    receipt["digest"] = supplied_digest
    if supplied_digest != expected_digest:
        raise frappe.ValidationError("The Muster demo ownership receipt digest does not match")
    return receipt


def _write_receipt(state: dict) -> None:
    records = []
    for key, doctype in _record_pairs(state):
        name = state[key]
        if not frappe.db.exists(doctype, name):
            raise frappe.ValidationError(f"Cannot receipt missing demo record: {doctype} {name}")
        records.append({
            "doctype": doctype,
            "name": name,
            "creation": str(frappe.db.get_value(doctype, name, "creation") or ""),
            "owner": str(frappe.db.get_value(doctype, name, "owner") or ""),
        })
    payload = {
        "schema_version": 1,
        "namespace": NAMESPACE,
        "fixture": STATE_KEY,
        "records": records,
    }
    payload["digest"] = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    frappe.db.set_default(STATE_KEY, json.dumps(payload, sort_keys=True))


def _assert_receipt_owns(doctype: str, name: str) -> None:
    receipt = _load_receipt()
    if not receipt:
        if CLAIM_EXISTING and name.startswith(NAMESPACE):
            return
        raise frappe.PermissionError(
            f"Refusing to overwrite unreceipted demo record: {doctype} {name}. "
            "Use MUSTER_DEMO_CLAIM_EXISTING=yes once after independently reviewing the isolated records."
        )
    match = next((row for row in receipt["records"] if row["doctype"] == doctype and row["name"] == name), None)
    if not match:
        raise frappe.PermissionError(f"Fixture receipt does not own {doctype} {name}")
    if str(frappe.db.get_value(doctype, name, "creation") or "") != match["creation"]:
        raise frappe.PermissionError(f"Fixture ownership changed for {doctype} {name}")


def setup() -> dict:
    state = _state()
    if not _load_receipt() and not CLAIM_EXISTING:
        collisions = [
            f"{doctype} {state[key]}" for key, doctype in _record_pairs(state)
            if frappe.db.exists(doctype, state[key])
        ]
        if collisions:
            raise frappe.PermissionError(
                "Refusing to claim existing demo records without explicit review: " + ", ".join(collisions)
            )
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
    bom_values = {
        "company": "VINMAN ENGINEERING PVT LTD", "item": state["item"], "quantity": 1,
        "currency": "INR", "conversion_rate": 1, "routing": state["routing"],
        "custom_control_plan": state["control_plan"], "transfer_material_against": "Job Card",
        "items": [{"item_code": state["component"], "qty": 1, "uom": "Nos", "rate": 1}],
        "operations": [{"sequence_id": 1, "operation": "Bending", "workstation": "Sub Contracted", "time_in_mins": 10}],
    }
    if frappe.get_meta("BOM").has_field("custom_costing_sheet"):
        bom_values["custom_costing_sheet"] = None
    _ensure("BOM", state["bom"], bom_values)
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
    fixture_state = "absent" if not any(row["exists"] for row in rows) else (
        "baseline" if revisions == {"B"} else "faulted" if "A" in revisions else "invalid"
    )
    return {"namespace": NAMESPACE, "state": fixture_state, "receipted": bool(_load_receipt()), "critical": critical, "records": rows}


def reset() -> dict:
    state = _state()
    receipt = _load_receipt()
    if not receipt:
        raise frappe.PermissionError("Refusing reset without a fixture ownership receipt")
    for key, doctype in [
        ("ppap", "Part Submission Warrant"), ("bom", "BOM"), ("routing", "Routing"),
        ("ppfmea", "PPFMEA"), ("process_flow", "Process Flow"), ("control_plan", "Control Plan"),
        ("apqp", "APQP Timing chart"), ("drawing_review", "Drawing Review"),
        ("tool", "Item"), ("component", "Item"), ("item", "Item"), ("customer", "Customer"),
    ]:
        name = state[key]
        if frappe.db.exists(doctype, name):
            _assert_receipt_owns(doctype, name)
            doc = frappe.get_doc(doctype, name)
            if doc.docstatus == 1:
                doc.cancel()
            frappe.delete_doc(doctype, name)
    frappe.db.set_default(STATE_KEY, None)
    return status()


if ACTION not in {"setup", "fault", "correct", "status", "reset"}:
    raise ValueError(f"Unsupported MUSTER_DEMO_ACTION: {ACTION}")

actions = {"setup": setup, "fault": fault, "correct": correct, "status": status, "reset": reset}
if frappe.session.user != "Administrator":
    raise frappe.PermissionError("Run this demo fixture from an Administrator bench console")

try:
    result = actions[ACTION]()
    frappe.db.commit()
except Exception:
    frappe.db.rollback()
    raise

print(json.dumps(result, indent=2, default=str))
