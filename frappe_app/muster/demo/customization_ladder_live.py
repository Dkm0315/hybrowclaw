from __future__ import annotations

import json
import hashlib
from pathlib import Path
from typing import Any

import frappe
from frappe.utils import add_days, now_datetime, random_string
from frappe.utils.file_manager import save_file

from muster.api.native_builder import preview
from muster.api.development import create_from_ask_turn
from muster.orchestration.development import generate_reviewed_patch, source_snapshot


POLICY = "[Track3 Live] Native Customization"
MISSION_KEY = "track3-live-customization-v1"
CHECKER = "muster.customization.checker@muster.invalid"
CAPABILITIES = (
    "artifact.custom_field.write",
    "artifact.property_setter.write",
    "artifact.doctype.write",
    "artifact.report.write",
    "artifact.report.script.write",
    "artifact.print_format.write",
    "artifact.page.write",
    "artifact.web_page.write",
    "artifact.client_script.write",
    "artifact.server_script.write",
    "artifact.server_script.doctype.write",
    "artifact.server_script.api.write",
    "artifact.server_script.scheduler.write",
    "artifact.email_template.write",
)
DEVELOPMENT_APP = "field_ops_demo"
# Patch the source that the clean Bench actually imports. The staging checkout
# remains an immutable bootstrap source; registering it would produce valid
# review receipts without changing the running application.
DEVELOPMENT_ROOT = "/home/goblin/frappeverse/frappeverse-demo-v16/apps/field_ops_demo"
DEVELOPMENT_ALLOWED = ["field_ops_demo/muster_service_playbook.py"]
DEVELOPMENT_REQUEST = "track3-live-reviewed-code-patch-v1"
LIFECYCLE_SCENARIO = "frappeverse_lifecycle_orm_jinja_scenario.json"
LIFECYCLE_REQUEST = "track3-live-lifecycle-orm-jinja-v5"
LIFECYCLE_PRINT_FORMAT = "Muster Demo Service Visit Brief"
LIFECYCLE_ALLOWED = [
    "field_ops_demo/hooks.py",
    "field_ops_demo/automation/__init__.py",
    "field_ops_demo/automation/service_visit.py",
    "field_ops_demo/fixtures/muster_demo_service_visit_brief.json",
    "field_ops_demo/tests/test_service_visit_automation.py",
]
DEVELOPMENT_REGISTRY_ALLOWED = list(dict.fromkeys([*DEVELOPMENT_ALLOWED, *LIFECYCLE_ALLOWED]))


def _require(confirm: bool | int | str) -> None:
    if frappe.session.user != "Administrator":
        frappe.throw("Track 3 live setup requires Administrator")
    if str(confirm).lower() not in {"1", "true"}:
        frappe.throw("Track 3 live setup requires explicit confirmation")


def _fixture(name: str) -> Path:
    return Path(__file__).resolve().parent / "fixtures" / name


def _ensure_mission() -> str:
    existing = frappe.db.get_value("Muster Mission", {"idempotency_key": MISSION_KEY}, "name")
    if existing:
        return str(existing)
    return frappe.get_doc({
        "doctype": "Muster Mission",
        "objective": "Live source-bound native customization evidence for Frappeverse",
        "status": "Draft",
        "requested_by": "Administrator",
        "requested_at": now_datetime(),
        "idempotency_key": MISSION_KEY,
        "scope_json": json.dumps({"site": frappe.local.site, "disposable": True}, sort_keys=True),
        "budget_json": "{}",
        "usage_json": "{}",
    }).insert().name


def _ensure_source_file() -> str:
    source = _fixture("frappeverse_service_intake_prd.md")
    filename = "track3-live-frappeverse-service-intake-prd.md"
    existing = frappe.db.get_value("File", {"file_name": filename, "is_private": 1}, "name")
    if existing:
        return str(existing)
    return save_file(filename, source.read_bytes(), None, None, is_private=1).name


def _ensure_coding_source_file() -> str:
    source = _fixture("frappeverse_coding_ladder_prd.md")
    filename = "track3-live-frappeverse-coding-ladder-prd.md"
    existing = frappe.db.get_value("File", {"file_name": filename, "is_private": 1}, "name")
    if existing:
        return str(existing)
    return save_file(filename, source.read_bytes(), None, None, is_private=1).name


def _ensure_policy() -> str:
    existing = frappe.db.exists("Muster Policy", POLICY)
    if existing:
        policy = frappe.get_doc("Muster Policy", existing)
        actual = {(row.effect, row.capability, row.action, row.resource_type,
                   row.resource_pattern, row.approval_class) for row in policy.rules}
        expected = {("Allow", capability, "*", "Site", frappe.local.site, "None")
                    for capability in CAPABILITIES}
        if not policy.enabled:
            frappe.throw("Existing Track 3 policy is disabled")
        if actual != expected:
            policy.set("rules", [{
                "effect": "Allow", "capability": capability, "action": "*",
                "resource_type": "Site", "resource_pattern": frappe.local.site,
                "approval_class": "None",
            } for capability in CAPABILITIES])
            policy.save()
        return policy.name
    return frappe.get_doc({
        "doctype": "Muster Policy", "policy_name": POLICY, "enabled": 1,
        "priority": 40, "description": "Disposable Frappeverse native customization evidence only.",
        "rules": [{
            "effect": "Allow", "capability": capability, "action": "*",
            "resource_type": "Site", "resource_pattern": frappe.local.site,
            "approval_class": "None",
        } for capability in CAPABILITIES],
    }).insert().name


def _ensure_binding() -> str:
    filters = {
        "subject_type": "User", "subject": "Administrator", "status": "Active",
        "scope_type": "Site", "scope_value": frappe.local.site,
    }
    existing = frappe.db.get_value("Muster Role Binding", filters, "name")
    required = set(CAPABILITIES)
    if existing:
        binding = frappe.get_doc("Muster Role Binding", existing)
        merged = set(filter(None, (binding.capabilities or "").splitlines())) | required
        if merged != set(filter(None, (binding.capabilities or "").splitlines())):
            binding.capabilities = "\n".join(sorted(merged))
            binding.save()
        return binding.name
    return frappe.get_doc({"doctype": "Muster Role Binding", **filters,
                           "capabilities": "\n".join(sorted(required))}).insert().name


def _ensure_checker() -> dict[str, Any]:
    """Enable one narrowly scoped approver with a server-only runtime credential."""
    if not frappe.db.exists("User", CHECKER):
        user = frappe.get_doc({
            "doctype": "User", "email": CHECKER,
            "first_name": "Muster Customization", "last_name": "Checker",
            "send_welcome_email": 0, "enabled": 0,
        }).insert(ignore_permissions=True)
        user.add_roles("Muster Approver")
    user = frappe.get_doc("User", CHECKER)
    explicit_roles = {row.role for row in user.roles}
    if explicit_roles != {"Muster Approver"}:
        frappe.throw("The customization checker must have only the Muster Approver role")
    user.enabled = 1
    user.api_key = random_string(20)
    user.api_secret = random_string(40)
    user.save(ignore_permissions=True)
    return {
        "checker": CHECKER,
        "explicit_roles": sorted(explicit_roles),
        "effective_roles": sorted(frappe.get_roles(CHECKER)),
        "has_system_manager": "System Manager" in frappe.get_roles(CHECKER),
        "runtime_credential_issued": True,
        "credential_exposed": False,
    }


def _ensure_development_authority() -> dict[str, Any]:
    """Converge policy and additive site authority before creating proposals."""
    checker = _ensure_checker()
    return {"policy": _ensure_policy(), "binding": _ensure_binding(), **checker}


def revoke_checker(*, confirm: bool | int | str = False) -> dict[str, Any]:
    """Revoke the evidence user's API material and return it to disabled state."""
    _require(confirm)
    user = frappe.get_doc("User", CHECKER)
    user.enabled = 0
    user.api_key = None
    user.api_secret = None
    user.save(ignore_permissions=True)
    frappe.db.commit()
    return {
        "checker": CHECKER, "enabled": False,
        "api_key_present": bool(user.api_key), "api_secret_present": bool(user.api_secret),
        "explicit_roles": sorted(row.role for row in user.roles),
    }


def _ensure_development_app() -> str:
    snapshot = source_snapshot(DEVELOPMENT_APP, DEVELOPMENT_ROOT)
    allowed = json.dumps(DEVELOPMENT_REGISTRY_ALLOWED, separators=(",", ":"))
    if frappe.db.exists("Muster Development App", DEVELOPMENT_APP):
        app = frappe.get_doc("Muster Development App", DEVELOPMENT_APP)
        if (not app.enabled or app.registered_revision != snapshot.revision
                or app.registered_status_hash != snapshot.status_hash):
            frappe.throw("The registered Field Ops Demo source boundary changed")
        if json.loads(app.allowed_paths_json) != DEVELOPMENT_REGISTRY_ALLOWED:
            app.allowed_paths_json = allowed
            app.save(ignore_permissions=True)
        return app.name
    return frappe.get_doc({
        "doctype": "Muster Development App", "app_name": DEVELOPMENT_APP,
        "enabled": 1, "source_root_secret": DEVELOPMENT_ROOT,
        "allowed_paths_json": allowed,
    }).insert().name


def refresh_development_app_registration(*, confirm: bool | int | str = False) -> dict[str, Any]:
    """Re-attest the fixed Field Ops source after a separately reviewed commit."""
    _require(confirm)
    app = frappe.get_doc("Muster Development App", DEVELOPMENT_APP)
    app.save(ignore_permissions=True)
    frappe.db.commit()
    return {
        "app": app.name,
        "registered_revision": app.registered_revision,
        "registered_status_hash": app.registered_status_hash,
        "registered_by": app.registered_by,
    }


def _development_runner(workspace: Path, _prompt: str) -> None:
    target = workspace / DEVELOPMENT_ALLOWED[0]
    target.write_text(
        '"""Reviewed service-intake rule generated from the cited Track 3 PRD."""\n\n'
        "SERVICE_REGIONS = (\"North\", \"South\", \"East\", \"West\")\n\n"
        "def normalize_service_region(value: str) -> str:\n"
        "    normalized = (value or \"\").strip().title()\n"
        "    if normalized not in SERVICE_REGIONS:\n"
        "        raise ValueError(\"Unsupported service region\")\n"
        "    return normalized\n",
        encoding="utf-8",
    )


def _lifecycle_orm_jinja_runner(workspace: Path, _prompt: str) -> None:
    """Generate one fixed registered-app patch; prompt text is never executable input."""
    package = workspace / "field_ops_demo"
    hooks = package / "hooks.py"
    current_hooks = hooks.read_text(encoding="utf-8")
    marker = "# Muster disposable lifecycle/ORM/Jinja scenario"
    if marker not in current_hooks:
        hooks.write_text(
            current_hooks.rstrip() + "\n\n" + marker + "\n"
            "doc_events = {\n"
            "    \"Service Visit\": {\n"
            "        \"on_update\": \"field_ops_demo.automation.service_visit.update_customer_snapshot\",\n"
            "    },\n"
            "}\n\n"
            "fixtures = [\n"
            "    {\"dt\": \"Print Format\", \"filters\": [[\"name\", \"=\", "
            f"\"{LIFECYCLE_PRINT_FORMAT}\"]]}},\n"
            "]\n",
            encoding="utf-8",
        )

    automation = package / "automation"
    automation.mkdir(parents=True, exist_ok=True)
    (automation / "__init__.py").write_text("", encoding="utf-8")
    (automation / "service_visit.py").write_text(
        '"""Fixed, reviewed Service Visit automation for disposable Frappeverse evidence."""\n\n'
        "import frappe\n\n"
        'MARKER_PREFIX = "[Muster Demo Customer Snapshot]"\n\n\n'
        "def update_customer_snapshot(doc, method=None):\n"
        "    if getattr(doc.flags, \"in_insert\", False):\n"
        "        return\n"
        "    rows = frappe.get_list(\n"
        "        \"Customer\", filters={\"name\": doc.customer},\n"
        "        fields=[\"customer_name\"], limit=1,\n"
        "    )\n"
        "    if not rows:\n"
        "        return\n"
        "    notes = doc.notes or \"\"\n"
        "    retained = [line for line in notes.splitlines() if not line.startswith(MARKER_PREFIX)]\n"
        "    marker = f\"{MARKER_PREFIX} {rows[0].customer_name}\"\n"
        "    updated = \"\\n\".join([*retained, marker]).strip()\n"
        "    if updated != notes:\n"
        "        frappe.db.set_value(\"Service Visit\", doc.name, \"notes\", updated, update_modified=False)\n",
        encoding="utf-8",
    )

    fixtures = package / "fixtures"
    fixtures.mkdir(parents=True, exist_ok=True)
    print_format = [{
        "doctype": "Print Format", "name": LIFECYCLE_PRINT_FORMAT,
        "doc_type": "Service Visit", "module": "Field Ops Demo", "standard": "No",
        "custom_format": 1, "disabled": 0, "print_format_type": "Jinja", "raw_printing": 0,
        "html": (
            '<h1>{{ _("Service Visit") }}</h1>'
            '<p>{{ _("Visit") }}: {{ doc.name | e }}</p>'
            '<p>{{ _("Customer") }}: {{ doc.customer | e }}</p>'
            '<p>{{ _("Status") }}: {{ doc.status | e }}</p>'
            '<p>{{ _("Notes") }}: {{ (doc.notes or "") | e }}</p>'
        ),
    }]
    (fixtures / "muster_demo_service_visit_brief.json").write_text(
        json.dumps(print_format, indent=2, sort_keys=True) + "\n", encoding="utf-8",
    )

    tests = package / "tests"
    tests.mkdir(parents=True, exist_ok=True)
    (tests / "test_service_visit_automation.py").write_text(
        "import frappe\n"
        "from frappe.tests.utils import FrappeTestCase\n\n"
        "from field_ops_demo.automation.service_visit import MARKER_PREFIX\n\n\n"
        "class TestServiceVisitAutomation(FrappeTestCase):\n"
        "    def setUp(self):\n"
        "        suffix = frappe.generate_hash(length=8)\n"
        "        self.customer = frappe.get_doc({\n"
        "            \"doctype\": \"Customer\", \"customer_name\": f\"Muster Demo Hook Customer {suffix}\",\n"
        "            \"customer_type\": \"Company\", \"customer_group\": \"Frappeverse Customers\",\n"
        "            \"territory\": \"All Territories\",\n"
        "        }).insert()\n"
        "        self.visit = frappe.get_doc({\n"
        "            \"doctype\": \"Service Visit\", \"customer\": self.customer.name,\n"
        "            \"scheduled_on\": frappe.utils.today(), \"status\": \"Planned\",\n"
        "            \"notes\": \"<b>Muster Evidence</b>\",\n"
        "        }).insert()\n\n"
        "    def tearDown(self):\n"
        "        frappe.delete_doc(\"Service Visit\", self.visit.name, force=True)\n"
        "        frappe.delete_doc(\"Customer\", self.customer.name, force=True)\n\n"
        "    def test_hook_orm_write_is_idempotent_and_jinja_is_escaped(self):\n"
        "        inserted = frappe.db.get_value(\"Service Visit\", self.visit.name, \"notes\")\n"
        "        self.assertNotIn(MARKER_PREFIX, inserted)\n"
        "        self.visit.save()\n"
        "        first = frappe.db.get_value(\"Service Visit\", self.visit.name, \"notes\")\n"
        "        self.assertEqual(first.count(MARKER_PREFIX), 1)\n"
        "        self.visit.reload()\n"
        "        self.visit.save()\n"
        "        second = frappe.db.get_value(\"Service Visit\", self.visit.name, \"notes\")\n"
        "        self.assertEqual(second.count(MARKER_PREFIX), 1)\n"
        f"        template = frappe.get_doc(\"Print Format\", \"{LIFECYCLE_PRINT_FORMAT}\").html\n"
        "        rendered = frappe.render_template(template, {\"doc\": self.visit.reload()})\n"
        "        self.assertNotIn(\"<b>\", rendered)\n"
        "        self.assertIn(\"&lt;b&gt;Muster Evidence&lt;/b&gt;\", rendered)\n",
        encoding="utf-8",
    )


def _review_receipt(snapshot, generated, scenario: dict[str, Any]) -> tuple[str, str]:
    receipt = {
        "schema_version": 1, "kind": "registered_app_customization_review",
        "scenario_id": scenario["scenario_id"], "app": DEVELOPMENT_APP,
        "source_revision": snapshot.revision, "source_status_hash": snapshot.status_hash,
        "patch_hash": generated.patch_hash, "changed_files": list(generated.changed_files),
        "disposable": scenario["disposable"], "effects_executed": False,
        "rollback": scenario["rollback"],
    }
    encoded = json.dumps(receipt, sort_keys=True, separators=(",", ":")).encode()
    return encoded.decode(), hashlib.sha256(encoded).hexdigest()


def prepare_development_case(*, confirm: bool | int | str = False) -> dict[str, Any]:
    """Create a real reviewed patch for a clean registered app; never apply it here."""
    _require(confirm)
    checker = _ensure_development_authority()
    app_name = _ensure_development_app()
    existing = frappe.db.get_value(
        "Muster Development Proposal", {"request_id": DEVELOPMENT_REQUEST}, "name"
    )
    if existing:
        proposal = frappe.get_doc("Muster Development Proposal", existing)
        return {
            "proposal": proposal.name, "status": proposal.status,
            "app": app_name, **checker, "effects_executed": proposal.status in {"Applied", "Rolled Back"},
        }
    objective = (
        "Implement a small, testable service-region normalization module in the registered "
        "Field Ops Demo app, constrained to the reviewed path and cited Track 3 PRD."
    )
    prompt_hash = hashlib.sha256(objective.encode()).hexdigest()
    development_scope_json = json.dumps(
        {"site": frappe.local.site, "app": DEVELOPMENT_APP},
        sort_keys=True, separators=(",", ":"),
    )
    ask = frappe.get_doc({
        "doctype": "Muster Ask Turn", "requested_by": "Administrator",
        "conversation_id": "track3-live-development", "request_id": DEVELOPMENT_REQUEST,
        "status": "Accepted", "expires_at": add_days(now_datetime(), 1),
        "prompt_secret": objective, "prompt_hash": prompt_hash,
        "scope_json": development_scope_json,
        "scope_hash": hashlib.sha256(development_scope_json.encode()).hexdigest(),
        "outcomes_json": '["development_workflow"]', "handoffs_json": "[]",
    }).insert()
    created = create_from_ask_turn(
        ask, app_name, POLICY, DEVELOPMENT_REQUEST, source_file=_ensure_source_file(),
    )
    proposal = frappe.get_doc("Muster Development Proposal", created["proposal"])
    snapshot = source_snapshot(DEVELOPMENT_APP, DEVELOPMENT_ROOT)
    generated = generate_reviewed_patch(
        snapshot, objective, DEVELOPMENT_ALLOWED, _development_runner,
    )
    patch_file = save_file(
        f"{proposal.name}.patch", generated.patch,
        "Muster Development Proposal", proposal.name, is_private=1,
    )
    manifest_file = save_file(
        f"{proposal.name}-tests.json", generated.test_manifest,
        "Muster Development Proposal", proposal.name, is_private=1,
    )
    proposal.db_set({
        "status": "Ready", "reviewed_by": CHECKER, "reviewed_at": now_datetime(),
        "patch_file": patch_file.file_url, "patch_hash": generated.patch_hash,
        "test_manifest_file": manifest_file.file_url,
        "changed_files_json": json.dumps(list(generated.changed_files), separators=(",", ":")),
        "generated_at": now_datetime(), "deployment_status": "Not Requested",
        "rollback_status": "Not Requested",
    }, update_modified=True)
    frappe.db.commit()
    return {
        "proposal": proposal.name, "status": "Ready", "app": app_name,
        "patch_hash": generated.patch_hash, "changed_files": list(generated.changed_files),
        "reviewed_by": CHECKER, **checker, "effects_executed": False,
    }


def prepare_lifecycle_orm_jinja_case(*, confirm: bool | int | str = False) -> dict[str, Any]:
    """Prepare the bounded Doc Event/ORM/Jinja patch; never apply or deploy it here."""
    _require(confirm)
    checker = _ensure_development_authority()
    app_name = _ensure_development_app()
    scenario = json.loads(_fixture(LIFECYCLE_SCENARIO).read_text(encoding="utf-8"))
    if scenario.get("request_id") != LIFECYCLE_REQUEST:
        frappe.throw("The lifecycle scenario request identity changed")
    if scenario.get("registered_app") != DEVELOPMENT_APP:
        frappe.throw("The lifecycle scenario is not bound to Field Ops Demo")
    if scenario.get("allowed_paths") != LIFECYCLE_ALLOWED:
        frappe.throw("The lifecycle scenario allowed paths changed")

    existing = frappe.db.get_value(
        "Muster Development Proposal", {"request_id": LIFECYCLE_REQUEST}, "name"
    )
    if existing:
        proposal = frappe.get_doc("Muster Development Proposal", existing)
        return {
            "proposal": proposal.name, "status": proposal.status, "app": app_name,
            "scenario_id": scenario["scenario_id"], **checker,
            "effects_executed": proposal.status in {"Applied", "Rolled Back"},
        }

    objective = scenario["objective"]
    scope = {"site": frappe.local.site, "app": DEVELOPMENT_APP,
             "scenario": scenario["scenario_id"]}
    scope_json = json.dumps(scope, sort_keys=True, separators=(",", ":"))
    ask = frappe.get_doc({
        "doctype": "Muster Ask Turn", "requested_by": "Administrator",
        "conversation_id": "track3-live-lifecycle-orm-jinja",
        "request_id": LIFECYCLE_REQUEST, "status": "Accepted",
        "expires_at": add_days(now_datetime(), 1), "prompt_secret": objective,
        "prompt_hash": hashlib.sha256(objective.encode()).hexdigest(),
        "scope_json": scope_json,
        "scope_hash": hashlib.sha256(scope_json.encode()).hexdigest(),
        "outcomes_json": '["development_workflow"]', "handoffs_json": "[]",
    }).insert()
    created = create_from_ask_turn(
        ask, app_name, POLICY, LIFECYCLE_REQUEST,
        source_file=_ensure_coding_source_file(),
    )
    proposal = frappe.get_doc("Muster Development Proposal", created["proposal"])
    snapshot = source_snapshot(DEVELOPMENT_APP, DEVELOPMENT_ROOT)
    generated = generate_reviewed_patch(
        snapshot, objective, LIFECYCLE_ALLOWED, _lifecycle_orm_jinja_runner,
    )
    patch_file = save_file(
        f"{proposal.name}.patch", generated.patch,
        "Muster Development Proposal", proposal.name, is_private=1,
    )
    manifest_file = save_file(
        f"{proposal.name}-tests.json", generated.test_manifest,
        "Muster Development Proposal", proposal.name, is_private=1,
    )
    receipt_json, receipt_hash = _review_receipt(snapshot, generated, scenario)
    receipt_file = save_file(
        f"{proposal.name}-rollback-contract.json", receipt_json.encode(),
        "Muster Development Proposal", proposal.name, is_private=1,
    )
    proposal.db_set({
        "status": "Ready", "reviewed_by": CHECKER, "reviewed_at": now_datetime(),
        "patch_file": patch_file.file_url, "patch_hash": generated.patch_hash,
        "test_manifest_file": manifest_file.file_url,
        "changed_files_json": json.dumps(list(generated.changed_files), separators=(",", ":")),
        "generated_at": now_datetime(), "deployment_status": "Not Requested",
        "rollback_status": "Not Requested",
    }, update_modified=True)
    frappe.db.commit()
    return {
        "proposal": proposal.name, "status": "Ready", "app": app_name,
        "scenario_id": scenario["scenario_id"], "patch_hash": generated.patch_hash,
        "changed_files": list(generated.changed_files), "reviewed_by": CHECKER,
        "receipt_file": receipt_file.file_url, "receipt_hash": receipt_hash,
        "rollback_gate": scenario["rollback"]["guard"],
        **checker, "effects_executed": False,
    }


def prepare(*, confirm: bool | int | str = False) -> dict[str, Any]:
    """Create deterministic inputs and authority, never an artifact outcome."""
    _require(confirm)
    checker = _ensure_development_authority()
    result = {
        "mission": _ensure_mission(), "source_file": _ensure_source_file(),
        **checker, "effects_executed": False,
    }
    frappe.db.commit()
    return result


def prepare_case(case_id: str, *, confirm: bool | int | str = False) -> dict[str, Any]:
    """Preview and independently approve one case; applying remains a browser action."""
    inputs = prepare(confirm=confirm)
    matrix = json.loads(_fixture("attended_native_customization_matrix.json").read_text())
    case = next((row for row in matrix["cases"] if row["id"] == case_id), None)
    if not case:
        frappe.throw("Unknown Track 3 live case")
    artifact = case["artifact"]
    target = {
        "property_setter": ("Property Setter", None),
        "doctype": ("DocType", artifact["target_name"]),
        "query_report": ("Report", artifact["target_name"]),
        "script_report": ("Report", artifact["target_name"]),
        "print_format": ("Print Format", artifact["target_name"]),
        "page": ("Page", artifact["target_name"]),
        "web_page": ("Web Page", artifact["target_name"]),
        "client_script": ("Client Script", artifact["target_name"]),
        "server_script": ("Server Script", artifact["target_name"]),
        "email_template": ("Email Template", artifact["target_name"]),
    }.get(artifact["kind"])
    if artifact["kind"] == "custom_field":
        target = ("Custom Field", f"{artifact['target_doctype']}-{artifact['target_name']}")
    if target is None:
        frappe.throw("Unsupported Track 3 live artifact kind")
    if target[1] and frappe.db.exists(target[0], target[1]):
        frappe.throw(f"Disposable target already exists: {target[0]} {target[1]}")
    result = preview({
        "schema_version": "1.0", "mission": inputs["mission"],
        "source_file": inputs["source_file"], "artifacts": [artifact],
    })
    approval = frappe.get_doc({
        "doctype": "Muster Approval", "mission": inputs["mission"],
        "change_set": result["change_set"], "status": "Pending",
        "approval_class": result["approval_class"], "requested_by": "Administrator",
        "requested_from": CHECKER, "expires_at": add_days(now_datetime(), 1),
        "action_hash": result["plan_hash"],
        "diff_json": json.dumps(result["changes"], sort_keys=True, default=str),
    }).insert()
    frappe.set_user(CHECKER)
    approval.status = "Approved"
    approval.decision_note = "Independent Track 3 disposable live-evidence approval"
    # Bench evidence setup has no HTTP permission resolver context. The
    # document controller still enforces that the session is the assigned,
    # different approver; ignore_permissions only bypasses the transport layer.
    approval.save(ignore_permissions=True)
    frappe.set_user("Administrator")
    frappe.db.commit()
    return {**result, "case_id": case_id, "approval": approval.name,
            "approved_by": CHECKER, "effects_executed": False}


def approve_rollback(change_set: str, *, confirm: bool | int | str = False) -> dict[str, Any]:
    """Create an independent destructive approval; rollback remains a browser action."""
    _require(confirm)
    checker = _ensure_checker()
    doc = frappe.get_doc("Muster Change Set", change_set)
    if doc.actor != "Administrator" or doc.status != "Verified":
        frappe.throw("Only a verified Track 3 Administrator Change Set can request rollback")
    existing = frappe.db.get_value("Muster Approval", {
        "change_set": doc.name, "approval_class": "Destructive", "status": "Approved",
        "action_hash": doc.plan_hash,
    }, "name")
    if existing:
        return {"change_set": doc.name, "approval": existing,
                **checker, "effects_executed": False}
    approval = frappe.get_doc({
        "doctype": "Muster Approval", "mission": doc.mission,
        "change_set": doc.name, "status": "Pending", "approval_class": "Destructive",
        "requested_by": "Administrator", "requested_from": CHECKER,
        "expires_at": add_days(now_datetime(), 1), "action_hash": doc.plan_hash,
        "diff_json": doc.evidence_json,
    }).insert()
    frappe.set_user(CHECKER)
    approval.status = "Approved"
    approval.decision_note = "Independent destructive approval for disposable Track 3 evidence"
    approval.save(ignore_permissions=True)
    frappe.set_user("Administrator")
    frappe.db.commit()
    return {"change_set": doc.name, "approval": approval.name,
            "approved_by": CHECKER, **checker, "effects_executed": False}
