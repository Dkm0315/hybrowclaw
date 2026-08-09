from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import frappe
from frappe import _
from frappe.utils import cint


IMPORT_DIRECTORY = "muster-evidence-import"


def _require_administrator(confirm: bool | int | str) -> None:
    if frappe.session.user != "Administrator":
        frappe.throw(_("Only Administrator can import the evidence index"), frappe.PermissionError)
    if not cint(confirm):
        frappe.throw(_("Explicit confirmation is required"), frappe.ValidationError)


def _import_root() -> Path:
    root = Path(frappe.get_site_path("private", "files", IMPORT_DIRECTORY)).resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def _inside_import_root(relative_name: str) -> Path:
    if not isinstance(relative_name, str) or not relative_name:
        frappe.throw(_("Evidence import filename is required"), frappe.ValidationError)
    root = _import_root()
    candidate = (root / relative_name).resolve()
    if root not in candidate.parents or not candidate.is_file():
        frappe.throw(_("Evidence import file must exist inside the private import directory"),
                     frappe.ValidationError)
    return candidate


def _private_file(source: Path):
    file_url = f"/private/files/{IMPORT_DIRECTORY}/{source.name}"
    name = frappe.db.get_value("File", {"file_url": file_url}, "name")
    if name:
        file_doc = frappe.get_doc("File", name)
        if not cint(file_doc.is_private):
            frappe.throw(_("Existing evidence File must remain private"), frappe.ValidationError)
        return file_doc
    return frappe.get_doc({
        "doctype": "File",
        "file_name": source.name,
        "file_url": file_url,
        "is_private": 1,
        "folder": "Home/Attachments",
        "file_size": source.stat().st_size,
    }).insert(ignore_permissions=True)


def _receipt(clip: dict[str, Any], index_filename: str) -> str:
    traces = clip.get("traces") or []
    receipts = clip.get("test_receipts") or []
    return json.dumps({
        "scenario_id": clip["scenario_id"],
        "index_file": index_filename,
        "video_sha256": clip["video"]["sha256"],
        "trace_sha256": traces[0]["sha256"] if traces else None,
        "test_receipt_sha256": receipts[0]["sha256"] if receipts else None,
        "index_validation": "passed",
    }, sort_keys=True, separators=(",", ":"))


def import_video_index(
    index_filename: str,
    mission: str,
    *,
    confirm: bool | int | str = False,
    status: str = "Verified",
) -> dict[str, Any]:
    """Bench-only deterministic importer for a validated, privately staged evidence index."""
    _require_administrator(confirm)
    if status not in {"Ready", "Verified"}:
        frappe.throw(_("Imported evidence must be Ready or Verified"), frappe.ValidationError)
    if not frappe.db.exists("Muster Mission", mission):
        frappe.throw(_("Evidence Mission does not exist"), frappe.ValidationError)

    index_path = _inside_import_root(index_filename)
    try:
        manifest = json.loads(index_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        frappe.throw(_("Evidence index must be readable JSON"), frappe.ValidationError)
    clips = manifest.get("clips") if isinstance(manifest, dict) else None
    if not isinstance(clips, list) or not clips:
        frappe.throw(_("Evidence index must contain at least one clip"), frappe.ValidationError)

    created: list[str] = []
    unchanged: list[str] = []
    for clip in clips:
        scenario = clip.get("scenario_id")
        if not isinstance(scenario, str) or not scenario:
            frappe.throw(_("Every evidence clip requires a scenario id"), frappe.ValidationError)
        existing = frappe.db.get_value(
            "Muster Evidence Clip", {"scenario": scenario}, ["name", "video_sha256"], as_dict=True
        )
        if existing:
            if existing.video_sha256 != clip.get("video", {}).get("sha256"):
                frappe.throw(_("Existing evidence hash differs for scenario {0}").format(scenario),
                             frappe.ValidationError)
            unchanged.append(existing.name)
            continue

        video_source = _inside_import_root(Path(clip["video"]["path"]).name)
        file_doc = _private_file(video_source)
        actor = clip["actor"]["id"]
        actor_roles = clip["actor"].get("roles") or []
        actor_role = actor_roles[0] if actor_roles else None
        evidence = frappe.get_doc({
            "doctype": "Muster Evidence Clip",
            "scenario": scenario,
            "status": status,
            "claim": clip["claim"],
            "actor": actor,
            "actor_role": actor_role,
            "module": "Muster",
            "mission": mission,
            "video": file_doc.file_url,
            "duration_seconds": clip["duration_seconds"],
            "viewport_width": clip["viewport"]["width"],
            "viewport_height": clip["viewport"]["height"],
            "build_revision": clip["build_revision"],
            "test_receipt_json": _receipt(clip, index_filename),
        }).insert()
        if evidence.video_sha256 != clip["video"]["sha256"]:
            frappe.throw(_("Imported video hash differs for scenario {0}").format(scenario),
                         frappe.ValidationError)
        created.append(evidence.name)

    frappe.db.commit()
    return {"created": created, "unchanged": unchanged, "total": len(clips), "status": status}
