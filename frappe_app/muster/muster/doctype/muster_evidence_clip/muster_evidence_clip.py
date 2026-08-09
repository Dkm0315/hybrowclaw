from __future__ import annotations

import json
import mimetypes
import re
from hashlib import sha256
from pathlib import Path
from typing import Any

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint, flt, now_datetime


MAX_VIDEO_BYTES = 1_073_741_824
MAX_RECEIPT_BYTES = 256_000
SECRET_KEYS = {"authorization", "cookie", "password", "secret", "token", "api_key", "api_secret"}


def _contains_secret(value: Any) -> bool:
    if isinstance(value, dict):
        return any(str(key).lower() in SECRET_KEYS or _contains_secret(item)
                   for key, item in value.items())
    if isinstance(value, list):
        return any(_contains_secret(item) for item in value)
    return False


def _validate_receipt(value: str) -> str:
    if not value or len(value.encode("utf-8")) > MAX_RECEIPT_BYTES:
        frappe.throw(_("Test receipt must be valid JSON no larger than 256 KB"))
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        frappe.throw(_("Test receipt must be valid JSON"))
    if not isinstance(parsed, (dict, list)):
        frappe.throw(_("Test receipt must be a JSON object or array"))
    if _contains_secret(parsed):
        frappe.throw(_("Test receipt contains a forbidden secret-bearing field"))
    return json.dumps(parsed, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _hash_file(path: str) -> tuple[str, int]:
    digest = sha256()
    size = 0
    with Path(path).open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_VIDEO_BYTES:
                frappe.throw(_("Evidence videos cannot exceed 1 GB"))
            digest.update(chunk)
    return digest.hexdigest(), size


def _has_video_signature(path: str, mime_type: str) -> bool:
    """Reject renamed text/binary files; extension-derived MIME is not evidence."""
    with Path(path).open("rb") as stream:
        header = stream.read(4096)
    if mime_type in {"video/mp4", "video/quicktime"}:
        return len(header) >= 12 and header[4:8] == b"ftyp"
    if mime_type in {"video/webm", "video/x-matroska"}:
        return header.startswith(b"\x1a\x45\xdf\xa3") and (
            mime_type == "video/x-matroska" or b"webm" in header.lower()
        )
    if mime_type == "video/ogg":
        return header.startswith(b"OggS")
    if mime_type in {"video/x-msvideo", "video/avi"}:
        return len(header) >= 12 and header.startswith(b"RIFF") and header[8:12] == b"AVI "
    return False


class MusterEvidenceClip(Document):
    def validate(self):
        previous = self.get_doc_before_save() if not self.is_new() else None
        if previous and previous.status == "Verified":
            frappe.throw(_("Verified evidence clips are immutable"))
        if flt(self.duration_seconds) <= 0 or flt(self.duration_seconds) > 86_400:
            frappe.throw(_("Duration must be between 0 and 86,400 seconds"))
        if not 1 <= cint(self.viewport_width) <= 16_384 or not 1 <= cint(self.viewport_height) <= 16_384:
            frappe.throw(_("Viewport dimensions must be between 1 and 16,384 pixels"))
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]{6,139}", self.build_revision or ""):
            frappe.throw(_("Build revision must be a stable 7-140 character identifier"))
        if self.actor_role not in frappe.get_roles(self.actor):
            frappe.throw(_("Actor role must be assigned to the recorded actor"))
        if self.change_set and frappe.db.get_value("Muster Change Set", self.change_set, "mission") != self.mission:
            frappe.throw(_("Change Set must belong to the recorded Mission"))
        self.test_receipt_json = _validate_receipt(self.test_receipt_json)
        self._validate_video()
        if self.status == "Verified":
            roles = set(frappe.get_roles(frappe.session.user))
            if frappe.session.user != "Administrator" and not roles.intersection(
                    {"Muster Administrator", "Muster Automation Manager"}):
                frappe.throw(_("Only a Muster administrator or automation manager can verify evidence"),
                             frappe.PermissionError)
            self.verified_by = frappe.session.user
            self.verified_at = now_datetime()
        else:
            self.verified_by = None
            self.verified_at = None

    def _validate_video(self):
        file_name = frappe.db.get_value("File", {"file_url": self.video}, "name")
        if not file_name:
            frappe.throw(_("Evidence video must reference an existing Frappe File"))
        file_doc = frappe.get_doc("File", file_name)
        if not cint(file_doc.is_private) or not str(file_doc.file_url or "").startswith("/private/files/"):
            frappe.throw(_("Evidence videos must be private; public files are forbidden"))
        if not file_doc.has_permission("read", user=frappe.session.user):
            frappe.throw(_("You cannot read the selected evidence video"), frappe.PermissionError)
        attached_type = file_doc.attached_to_doctype
        attached_name = file_doc.attached_to_name
        if attached_type and (attached_type != self.doctype or (attached_name and attached_name != self.name)):
            frappe.throw(_("Evidence video is already attached to another record"))
        mime_type = mimetypes.guess_type(file_doc.file_name or file_doc.file_url)[0] or ""
        if not mime_type.startswith("video/"):
            frappe.throw(_("Evidence File MIME type must be video/*"))
        full_path = file_doc.get_full_path()
        if not _has_video_signature(full_path, mime_type):
            frappe.throw(_("Evidence File content must match its declared video MIME type"))
        content_hash, size = _hash_file(full_path)
        if not size:
            frappe.throw(_("Evidence video cannot be empty"))
        self.video_mime_type = mime_type
        self.video_sha256 = content_hash

    def after_insert(self):
        file_name = frappe.db.get_value("File", {"file_url": self.video}, "name")
        if file_name:
            frappe.db.set_value("File", file_name, {
                "attached_to_doctype": self.doctype,
                "attached_to_name": self.name,
                "attached_to_field": "video",
            }, update_modified=False)

    def on_trash(self):
        if self.status == "Verified":
            frappe.throw(_("Verified evidence clips cannot be deleted"))
