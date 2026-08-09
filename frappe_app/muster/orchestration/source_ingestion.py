from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

import frappe
from frappe import _


MAX_SOURCE_BYTES = 5_000_000
MAX_TEXT_CHARS = 250_000
MAX_REQUIREMENTS = 100
MAX_REQUIREMENT_CHARS = 500
_ALLOWED_MIME = {
    ".txt": {"text/plain"},
    ".md": {"text/markdown", "text/plain"},
    ".json": {"application/json", "text/json", "text/plain"},
    ".pdf": {"application/pdf"},
    ".docx": {"application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
}
_REQUIREMENT_WORDS = re.compile(r"\b(?:acceptance|must|need(?:s|ed)?|require(?:s|d)?|shall|should|user can)\b", re.IGNORECASE)
_LIST_MARKER = re.compile(r"^\s*(?:[-*+] |\d{1,3}[.)]\s+)(.+)$")
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_AUTHORITY_INSTRUCTION = re.compile(
    r"\b(?:ignore|bypass|disable|skip|override)\b.{0,80}\b(?:approval|policy|permission|security|control|guardrail)\b|"
    r"\b(?:grant|elevate|escalate)\b.{0,60}\b(?:role|permission|access|authority)\b|"
    r"\b(?:run|execute)\b.{0,60}\b(?:sql|database command|shell command|bench command)\b|"
    r"\b(?:system|developer)\s+instruction\b",
    re.IGNORECASE,
)


class SourceIngestionError(frappe.ValidationError):
    pass


class SourceIngestionClarification(SourceIngestionError):
    pass


def requirement_is_authority_instruction(value: Any) -> bool:
    """Classify document text that attempts to grant or bypass execution authority."""
    return bool(_AUTHORITY_INSTRUCTION.search(str(value or "")))


def ingest_frappe_file(file_name: str, *, user: str) -> dict[str, Any]:
    """Read one actor-visible Frappe File and produce cited, inert requirements."""
    if not isinstance(file_name, str) or not file_name.strip() or len(file_name) > 140:
        raise SourceIngestionClarification(_("Which source file should I use?"))
    file_doc = frappe.get_doc("File", file_name.strip())
    if not file_doc.has_permission("read", user=user):
        frappe.throw(_("This source file is not available to your account"), frappe.PermissionError)
    if getattr(file_doc, "is_folder", 0):
        raise SourceIngestionClarification(_("Please choose a file rather than a folder."))
    file_url = str(getattr(file_doc, "file_url", "") or "")
    if file_url and (
        not file_url.startswith(("/files/", "/private/files/"))
        or ".." in file_url.split("/")
    ):
        raise SourceIngestionClarification(_("Please attach the source directly to this Frappe site."))
    filename = str(file_doc.file_name or "").strip()
    suffix = Path(filename).suffix.lower()
    allowed_mime = _ALLOWED_MIME.get(suffix)
    declared_type = str(getattr(file_doc, "content_type", "") or "").split(";", 1)[0].strip().lower()
    inferred_type = str(mimetypes.guess_type(filename)[0] or "").lower()
    content_type = declared_type or inferred_type
    if not allowed_mime or content_type not in allowed_mime:
        raise SourceIngestionClarification(_("Please attach a PDF, DOCX, UTF-8 Markdown, text, or JSON source file."))
    declared_size = int(getattr(file_doc, "file_size", 0) or 0)
    if declared_size < 0 or declared_size > MAX_SOURCE_BYTES:
        raise SourceIngestionClarification(_("Please use a source file smaller than 5 MB."))
    content = file_doc.get_content()
    data = content if isinstance(content, bytes) else str(content).encode("utf-8")
    if len(data) > MAX_SOURCE_BYTES or (declared_size and declared_size != len(data)):
        raise SourceIngestionError(_("The source file size changed while it was being read."))
    _verify_magic(data, suffix)
    if suffix in {".pdf", ".docx"}:
        requirements = _document_requirements(data, filename=filename, kind=suffix)
    else:
        try:
            text = data.decode("utf-8", errors="strict")
        except UnicodeDecodeError as error:
            raise SourceIngestionClarification(_("Please save the source as UTF-8 text and attach it again.")) from error
        if len(text) > MAX_TEXT_CHARS or _CONTROL.search(text):
            raise SourceIngestionClarification(_("The source contains unsupported or excessive text."))
        requirements = extract_cited_requirements(text, filename=filename, kind=suffix)
    conflicts = requirement_conflicts(requirements)
    if conflicts:
        conflict = conflicts[0]
        raise SourceIngestionClarification(
            _("The source conflicts at {0} and {1}. Which requirement should apply?").format(
                conflict["left"], conflict["right"],
            )
        )
    if not requirements:
        raise SourceIngestionClarification(_("I could not find a clear requirement in this file. Which outcome should the proposal implement?"))
    requirements_json = _canonical(requirements)
    requirements_hash = _sha256(requirements_json.encode())
    evidence = {
        "site": frappe.local.site,
        "user": user,
        "file": file_doc.name,
        "file_name": filename[:255],
        "mime_type": content_type,
        "size_bytes": len(data),
        "sha256": _sha256(data),
        "requirements_json": requirements_json,
        "requirements_hash": requirements_hash,
    }
    evidence["evidence_hash"] = _sha256(_canonical(evidence).encode())
    return evidence


def extract_cited_requirements(text: str, *, filename: str, kind: str) -> list[dict[str, Any]]:
    if kind == ".json":
        return _json_requirements(text, filename)
    requirements = []
    section = "Document"
    for line_number, raw in enumerate(text.replace("\r\n", "\n").replace("\r", "\n").split("\n"), start=1):
        line = re.sub(r"\s+", " ", raw).strip()
        if not line:
            continue
        if len(line) <= 160 and (line.startswith("#") or line.endswith(":")):
            section = line.lstrip("# ").rstrip(":").strip() or section
            continue
        marker = _LIST_MARKER.match(line)
        requirement = marker.group(1).strip() if marker else line
        if not marker and not _REQUIREMENT_WORDS.search(requirement):
            continue
        requirement = requirement[:MAX_REQUIREMENT_CHARS]
        requirements.append({
            "id": f"R{len(requirements) + 1:03d}",
            "requirement": requirement,
            "untrusted_authority_instruction": requirement_is_authority_instruction(requirement),
            "citation": {
                "file": filename[:255], "locator": f"line:{line_number}",
                "section": section[:160], "quote": line[:MAX_REQUIREMENT_CHARS],
            },
        })
        if len(requirements) >= MAX_REQUIREMENTS:
            break
    return requirements


def requirement_conflicts(requirements: list[dict[str, Any]]) -> list[dict[str, str]]:
    seen: dict[str, tuple[bool, str]] = {}
    conflicts = []
    for row in requirements:
        text = str(row.get("requirement") or "")
        negated = bool(re.search(r"\b(?:must|shall|should)\s+not\b|\bnever\b", text, re.IGNORECASE))
        base = re.sub(r"\b(?:must|shall|should|not|never)\b", " ", text.lower())
        base = re.sub(r"[^a-z0-9]+", " ", base).strip()
        if not base:
            continue
        locator = str((row.get("citation") or {}).get("locator") or "source")
        previous = seen.get(base)
        if previous and previous[0] != negated:
            conflicts.append({"left": previous[1], "right": locator})
        else:
            seen[base] = (negated, locator)
    return conflicts


def _verify_magic(data: bytes, suffix: str) -> None:
    binary_signatures = (b"%PDF-", b"PK\x03\x04", b"\x7fELF", b"MZ")
    if suffix == ".pdf" and not data.startswith(b"%PDF-"):
        raise SourceIngestionClarification(_("This file is not a valid PDF. Please export it again."))
    if suffix == ".docx" and not data.startswith(b"PK\x03\x04"):
        raise SourceIngestionClarification(_("This file is not a valid DOCX. Please export it again."))
    if suffix in {".txt", ".md", ".json"} and data.startswith(binary_signatures):
        raise SourceIngestionClarification(_("The file contents do not match its file type."))


def _document_requirements(data: bytes, *, filename: str, kind: str) -> list[dict[str, Any]]:
    result = _run_document_worker(data, kind=kind.lstrip("."))
    if result.get("status") != "ok":
        code = str(result.get("code") or "invalid_document")
        messages = {
            "active_content": _("This document contains active or embedded content. Please export a clean, flattened copy."),
            "encrypted": _("This PDF is encrypted. Please attach an unencrypted copy."),
            "excessive_text": _("The document contains too much text to process safely."),
            "external_relationship": _("This DOCX links to external content. Please remove external links and attach it again."),
            "magic_mismatch": _("The file contents do not match its file type."),
            "no_text": _("No selectable text was found. OCR is not configured; please attach a text-based copy."),
            "parser_unavailable": _("PDF extraction is unavailable on this site. Ask an administrator to install the configured PDF parser."),
            "too_many_pages": _("Please use a PDF with no more than 100 pages."),
            "unsafe_archive": _("This DOCX archive cannot be processed safely. Please export a fresh copy."),
            "unsafe_xml": _("This DOCX contains unsupported XML declarations. Please export a fresh copy."),
        }
        raise SourceIngestionClarification(messages.get(code, _("This document could not be read safely. Please export a fresh copy.")))
    blocks = result.get("blocks")
    if not isinstance(blocks, list):
        raise SourceIngestionError(_("The document extractor returned an invalid response."))
    requirements = []
    for block in blocks:
        if not isinstance(block, dict):
            raise SourceIngestionError(_("The document extractor returned an invalid response."))
        text = re.sub(r"\s+", " ", str(block.get("text") or "")).strip()
        marker = _LIST_MARKER.match(text)
        requirement = marker.group(1).strip() if marker else text
        if not requirement or (
            not marker and not block.get("candidate") and not _REQUIREMENT_WORDS.search(requirement)
        ):
            continue
        locator = str(block.get("locator") or "")[:160]
        section = str(block.get("section") or "Document")[:160]
        if not locator:
            raise SourceIngestionError(_("The document extractor returned an invalid citation."))
        requirements.append({
            "id": f"R{len(requirements) + 1:03d}",
            "requirement": requirement[:MAX_REQUIREMENT_CHARS],
            "untrusted_authority_instruction": requirement_is_authority_instruction(requirement),
            "citation": {
                "file": filename[:255], "locator": locator, "section": section,
                "quote": text[:MAX_REQUIREMENT_CHARS],
            },
        })
        if len(requirements) >= MAX_REQUIREMENTS:
            break
    return requirements


def _run_document_worker(data: bytes, *, kind: str) -> dict[str, Any]:
    worker = Path(__file__).with_name("source_document_worker.py")
    environment = {
        "LANG": "C.UTF-8",
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "PYTHONHASHSEED": "0",
        "PYTHONNOUSERSITE": "1",
    }
    try:
        process = subprocess.run(  # noqa: S603
            [sys.executable, str(worker), kind],
            input=data,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=10,
            check=False,
            env=environment,
            start_new_session=True,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise SourceIngestionClarification(_("This document took too long to read safely. Please simplify it and try again.")) from error
    if process.returncode != 0 or len(process.stdout) > 1_500_000:
        raise SourceIngestionClarification(_("This document could not be read safely. Please export a fresh copy."))
    try:
        result = json.loads(process.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SourceIngestionError(_("The document extractor returned an invalid response.")) from error
    if not isinstance(result, dict):
        raise SourceIngestionError(_("The document extractor returned an invalid response."))
    return result


def verify_source_evidence(proposal) -> None:
    if not getattr(proposal, "source_file", None):
        return
    evidence = ingest_frappe_file(proposal.source_file, user=proposal.requested_by)
    expected = {
        "source_site": evidence["site"], "source_file_name": evidence["file_name"],
        "source_mime_type": evidence["mime_type"], "source_size_bytes": evidence["size_bytes"],
        "source_file_hash": evidence["sha256"], "source_requirements_hash": evidence["requirements_hash"],
        "source_evidence_hash": evidence["evidence_hash"],
    }
    if any(str(getattr(proposal, field, "") or "") != str(value) for field, value in expected.items()):
        raise SourceIngestionError(_("The cited source file changed; create a new proposal."))


def _json_requirements(text: str, filename: str) -> list[dict[str, Any]]:
    def unique_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise SourceIngestionClarification(_("The JSON source contains a duplicate key. Please resolve it and attach the file again."))
            result[key] = value
        return result

    try:
        value = json.loads(text, object_pairs_hook=unique_pairs)
    except json.JSONDecodeError as error:
        raise SourceIngestionClarification(_("The JSON source is invalid. Please correct it and attach it again.")) from error
    rows = []

    def walk(item: Any, pointer: str) -> None:
        if len(rows) >= MAX_REQUIREMENTS:
            return
        if isinstance(item, dict):
            for key, child in item.items():
                walk(child, f"{pointer}/{str(key).replace('~', '~0').replace('/', '~1')}")
        elif isinstance(item, list):
            for index, child in enumerate(item[:MAX_REQUIREMENTS]):
                walk(child, f"{pointer}/{index}")
        elif item is not None:
            rendered = json.dumps(item, ensure_ascii=False, separators=(",", ":"))
            requirement = f"{pointer or '/'} = {rendered}"[:MAX_REQUIREMENT_CHARS]
            rows.append({
                "id": f"R{len(rows) + 1:03d}", "requirement": requirement,
                "untrusted_authority_instruction": requirement_is_authority_instruction(requirement),
                "citation": {"file": filename[:255], "locator": f"json:{pointer or '/'}", "section": "JSON", "quote": rendered[:MAX_REQUIREMENT_CHARS]},
            })

    walk(value, "")
    return rows


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()
