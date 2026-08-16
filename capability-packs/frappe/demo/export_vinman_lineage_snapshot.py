"""Export the isolated Vinman demo lineage through Frappe's document API.

Run from an Administrator bench console after setup, fault, or correction.
The output contains only MUSTER-DEMO records and fields used by the generic
lineage profile; it never reads customer records or raw script source.
"""

from __future__ import annotations

import json
import hashlib

import frappe


NAMESPACE = "MUSTER-DEMO-"
RECORDS = (
    ("Drawing Review", "MUSTER-DEMO-DR-001"),
    ("APQP Timing chart", "MUSTER-DEMO-APQP-001"),
    ("Control Plan", "MUSTER-DEMO-CP-002"),
    ("Process Flow", "MUSTER-DEMO-PF-001"),
    ("PPFMEA", "MUSTER-DEMO-PPFMEA-001"),
    ("Routing", "MUSTER-DEMO-ROUTING-001"),
    ("BOM", "MUSTER-DEMO-BOM-001"),
    ("Part Submission Warrant", "MUSTER-DEMO-PPAP-001"),
)

STAGES = {
    "Drawing Review": "drawing-review",
    "APQP Timing chart": "apqp",
    "Control Plan": "control-plan",
    "Process Flow": "process-flow",
    "PPFMEA": "ppfmea",
    "Routing": "routing",
    "BOM": "bom",
    "Part Submission Warrant": "ppap",
}

# This is the reviewed evidence contract, not a general document serializer.
# Sensitive values, script source, comments, attachments, and unrelated customer
# fields cannot enter the snapshot.
FIELDS = {
    "Drawing Review": {"name", "part_no", "customer"},
    "APQP Timing chart": {"name", "part_no", "customer", "rev_no"},
    "Control Plan": {"name", "part_no", "customer", "drawing_rev_no", "custom_control_plan_rev_number", "process_table"},
    "Process Flow": {"name", "control_plan", "part_no", "drawing_review_no", "process_table"},
    "PPFMEA": {"name", "control_plan", "part_no", "drawing_review_no", "ppfmea_child_table"},
    "Routing": {"name", "operations"},
    "BOM": {"name", "item", "routing", "custom_control_plan", "operations"},
    "Part Submission Warrant": {"name", "part_no", "eng_change_level"},
}

CHILD_FIELDS = {
    "process_table": {
        "process_no", "process_name", "product", "productprocessspecificationtolerance",
        "process_specification", "sample_size", "sample_frequency", "tool", "machine",
        "nature_of_change",
    },
    "ppfmea_child_table": {"process_no", "process_name", "product", "product_specification", "nature_of_change"},
    "operations": {"sequence_id", "operation", "workstation", "time_in_mins"},
}


def serializable(value, allowed=None):
    if isinstance(value, list):
        return [serializable(item, allowed) for item in value]
    if isinstance(value, dict):
        return {
            key: serializable(item)
            for key, item in value.items()
            if allowed is None or key in allowed
        }
    if hasattr(value, "as_dict"):
        return serializable(value.as_dict(no_nulls=False), allowed)
    return value


def projected_values(document):
    result = {}
    for fieldname in sorted(FIELDS[document.doctype]):
        value = document.get(fieldname)
        if isinstance(value, list):
            result[fieldname] = serializable(value, CHILD_FIELDS.get(fieldname, set()))
        else:
            result[fieldname] = serializable(value)
    return result


if frappe.session.user != "Administrator":
    raise frappe.PermissionError("Run this snapshot exporter from an Administrator bench console")

documents = []
for doctype, name in RECORDS:
    if not name.startswith(NAMESPACE):
        raise ValueError(f"Refusing non-demo record: {doctype} {name}")
    if frappe.db.exists(doctype, name):
        document = frappe.get_doc(doctype, name)
        documents.append({
            "stage": STAGES[doctype],
            "doctype": doctype,
            "name": name,
            "readable": True,
            "modified": str(document.modified),
            "route": f"/app/{doctype.lower().replace(' ', '-').replace('/', '-')}/{name}",
            "values": projected_values(document),
        })

roles = sorted(frappe.get_roles(frappe.session.user))
permission_epoch = hashlib.sha256(json.dumps({
    "user_modified": frappe.db.get_value("User", frappe.session.user, "modified"),
    "roles": roles,
}, sort_keys=True, default=str).encode()).hexdigest()
schema_revision = max(
    str(frappe.db.get_value("DocType", doctype, "modified") or "")
    for doctype, _name in RECORDS
)
data_revision = max(str(document["modified"] or "") for document in documents)
observed_at = frappe.utils.now_datetime().isoformat()
for index, document in enumerate(documents):
    document["provenance"] = {
        "site": frappe.local.site,
        "principal": frappe.session.user,
        "permissionEpoch": permission_epoch,
        "schemaRevision": schema_revision,
        "dataRevision": data_revision,
        "observedAt": observed_at,
        "evidenceId": f"frappe-document:{document['doctype']}:{document['name']}:{index}",
    }

print("MUSTER_SNAPSHOT_BEGIN")
print(json.dumps({"documents": documents}, indent=2, default=str))
print("MUSTER_SNAPSHOT_END")
