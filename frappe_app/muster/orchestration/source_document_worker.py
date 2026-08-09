"""Isolated, bounded text extraction for untrusted PDF and DOCX sources.

This module is executed as a child process. Its stdout is a small JSON protocol;
it never opens URLs, resolves OOXML relationships, executes macros, or writes files.
"""

from __future__ import annotations

import io
import json
import os
import socket
import sys
import zipfile
from pathlib import PurePosixPath
from typing import Any
from xml.etree import ElementTree


MAX_INPUT_BYTES = 5_000_000
MAX_OUTPUT_CHARS = 250_000
MAX_BLOCKS = 2_000
MAX_PDF_PAGES = 100
MAX_ZIP_ENTRIES = 512
MAX_ZIP_ENTRY_BYTES = 5_000_000
MAX_ZIP_EXPANDED_BYTES = 20_000_000
MAX_ZIP_RATIO = 100

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
CONTENT_TYPE_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
W = f"{{{W_NS}}}"


class ExtractionFailure(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def _set_limits() -> None:
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_CPU, (5, 5))
        resource.setrlimit(resource.RLIMIT_AS, (384 * 1024 * 1024, 384 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
        resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
        if hasattr(resource, "RLIMIT_NPROC"):
            resource.setrlimit(resource.RLIMIT_NPROC, (0, 0))
    except (ImportError, OSError, ValueError):
        # The parent still enforces input/output caps and a wall-clock timeout.
        pass


def _disable_network() -> None:
    def denied(*_args: Any, **_kwargs: Any) -> None:
        raise OSError("network disabled")

    socket.socket = denied  # type: ignore[assignment]
    socket.create_connection = denied  # type: ignore[assignment]


def _safe_xml(data: bytes) -> ElementTree.Element:
    if b"\x00" in data or data.startswith((b"\xff\xfe", b"\xfe\xff")):
        raise ExtractionFailure("unsafe_xml")
    probe = data.upper()
    if b"<!DOCTYPE" in probe or b"<!ENTITY" in probe:
        raise ExtractionFailure("unsafe_xml")
    try:
        # DTD/entity declarations and non-UTF-8 encodings are rejected above.
        return ElementTree.fromstring(data)  # noqa: S314
    except ElementTree.ParseError as error:
        raise ExtractionFailure("invalid_document") from error


def _normal_text(value: str) -> str:
    return " ".join(value.replace("\x00", " ").split())


def _pdf_blocks(data: bytes) -> list[dict[str, Any]]:
    if not data.startswith(b"%PDF-"):
        raise ExtractionFailure("magic_mismatch")
    try:
        from pypdf import PdfReader
    except ImportError as error:
        raise ExtractionFailure("parser_unavailable") from error
    try:
        reader = PdfReader(io.BytesIO(data), strict=True)
        if reader.is_encrypted:
            raise ExtractionFailure("encrypted")
        if len(reader.pages) > MAX_PDF_PAGES:
            raise ExtractionFailure("too_many_pages")
        root = reader.trailer.get("/Root") or {}
        if hasattr(root, "get_object"):
            root = root.get_object()
        if any(key in root for key in ("/OpenAction", "/AA", "/AcroForm")):
            raise ExtractionFailure("active_content")
        names = root.get("/Names") or {}
        if hasattr(names, "get_object"):
            names = names.get_object()
        if any(key in names for key in ("/JavaScript", "/EmbeddedFiles")):
            raise ExtractionFailure("active_content")

        blocks: list[dict[str, Any]] = []
        total_chars = 0
        for page_number, page in enumerate(reader.pages, start=1):
            if "/AA" in page:
                raise ExtractionFailure("active_content")
            for annotation_ref in page.get("/Annots", ()) or ():
                annotation = annotation_ref.get_object()
                if any(key in annotation for key in ("/A", "/AA")) or annotation.get("/Subtype") in {
                    "/FileAttachment", "/RichMedia", "/Movie", "/Sound",
                }:
                    raise ExtractionFailure("active_content")
            page_text = page.extract_text() or ""
            for raw_line in page_text.splitlines():
                line = _normal_text(raw_line)
                if not line:
                    continue
                total_chars += len(line)
                if total_chars > MAX_OUTPUT_CHARS or len(blocks) >= MAX_BLOCKS:
                    raise ExtractionFailure("excessive_text")
                blocks.append({
                    "locator": f"page:{page_number}",
                    "section": f"Page {page_number}",
                    "text": line,
                })
        if not blocks:
            raise ExtractionFailure("no_text")
        return blocks
    except ExtractionFailure:
        raise
    except Exception as error:
        raise ExtractionFailure("invalid_document") from error


def _validated_zip(data: bytes) -> tuple[zipfile.ZipFile, dict[str, zipfile.ZipInfo]]:
    if not data.startswith(b"PK\x03\x04"):
        raise ExtractionFailure("magic_mismatch")
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
        infos = archive.infolist()
    except (zipfile.BadZipFile, OSError) as error:
        raise ExtractionFailure("invalid_document") from error
    try:
        if not infos or len(infos) > MAX_ZIP_ENTRIES:
            raise ExtractionFailure("unsafe_archive")
        by_name: dict[str, zipfile.ZipInfo] = {}
        expanded = 0
        for info in infos:
            name = info.filename
            path = PurePosixPath(name)
            mode = info.external_attr >> 16
            if (
                not name
                or "\\" in name
                or "\x00" in name
                or path.is_absolute()
                or ".." in path.parts
                or name in by_name
                or (mode & 0o170000) == 0o120000
                or info.flag_bits & 0x1
            ):
                raise ExtractionFailure("unsafe_archive")
            expanded += info.file_size
            if info.file_size > MAX_ZIP_ENTRY_BYTES or expanded > MAX_ZIP_EXPANDED_BYTES:
                raise ExtractionFailure("unsafe_archive")
            if info.file_size and (
                not info.compress_size or info.file_size / info.compress_size > MAX_ZIP_RATIO
            ):
                raise ExtractionFailure("unsafe_archive")
            by_name[name] = info
    except Exception:
        archive.close()
        raise
    return archive, by_name


def _read_part(archive: zipfile.ZipFile, info: zipfile.ZipInfo) -> bytes:
    try:
        data = archive.read(info)
    except (OSError, RuntimeError, zipfile.BadZipFile) as error:
        raise ExtractionFailure("invalid_document") from error
    if len(data) != info.file_size or len(data) > MAX_ZIP_ENTRY_BYTES:
        raise ExtractionFailure("unsafe_archive")
    return data


def _reject_docx_active_content(
    archive: zipfile.ZipFile, by_name: dict[str, zipfile.ZipInfo]
) -> None:
    lowered = {name.lower() for name in by_name}
    forbidden_fragments = (
        "vbaproject", "activex", "embeddings/", "customui/", "oleobject", "attachedtemplate",
    )
    if any(any(fragment in name for fragment in forbidden_fragments) for name in lowered):
        raise ExtractionFailure("active_content")
    content_types = _safe_xml(_read_part(archive, by_name["[Content_Types].xml"]))
    main_document_types = {
        str(element.attrib.get("ContentType", "")).lower()
        for element in content_types.findall(f"{{{CONTENT_TYPE_NS}}}Override")
        if element.attrib.get("PartName") == "/word/document.xml"
    }
    if main_document_types != {
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
    }:
        raise ExtractionFailure("invalid_document")
    for element in content_types.findall(f"{{{CONTENT_TYPE_NS}}}Override") + content_types.findall(
        f"{{{CONTENT_TYPE_NS}}}Default"
    ):
        content_type = str(element.attrib.get("ContentType", "")).lower()
        if any(token in content_type for token in ("macroenabled", "vba", "activex", "oleobject")):
            raise ExtractionFailure("active_content")
    for name, info in by_name.items():
        if not name.endswith(".rels"):
            continue
        relationships = _safe_xml(_read_part(archive, info))
        for relationship in relationships.findall(f"{{{PKG_REL_NS}}}Relationship"):
            if str(relationship.attrib.get("TargetMode", "")).lower() == "external":
                raise ExtractionFailure("external_relationship")
            relationship_type = str(relationship.attrib.get("Type", "")).lower()
            if any(token in relationship_type for token in (
                "attachedtemplate", "oleobject", "package", "control", "vbaproject",
            )):
                raise ExtractionFailure("active_content")


def _paragraph_text(paragraph: ElementTree.Element) -> str:
    parts: list[str] = []
    for node in paragraph.iter():
        if node.tag == f"{W}t":
            parts.append(node.text or "")
        elif node.tag == f"{W}tab":
            parts.append("\t")
        elif node.tag in {f"{W}br", f"{W}cr"}:
            parts.append("\n")
    return _normal_text("".join(parts))


def _docx_blocks(data: bytes) -> list[dict[str, Any]]:
    archive, by_name = _validated_zip(data)
    required = {"[Content_Types].xml", "_rels/.rels", "word/document.xml"}
    if not required.issubset(by_name):
        archive.close()
        raise ExtractionFailure("invalid_document")
    try:
        _reject_docx_active_content(archive, by_name)
        root = _safe_xml(_read_part(archive, by_name["word/document.xml"]))
    finally:
        archive.close()
    if root.tag != f"{W}document":
        raise ExtractionFailure("invalid_document")
    body = root.find(f"{W}body")
    if body is None:
        raise ExtractionFailure("invalid_document")

    blocks: list[dict[str, Any]] = []
    paragraph_number = 0
    table_number = 0
    total_chars = 0
    section = "Document"

    def append(
        locator: str,
        text: str,
        *,
        candidate: bool = False,
        block_section: str | None = None,
    ) -> None:
        nonlocal total_chars
        if not text:
            return
        total_chars += len(text)
        if total_chars > MAX_OUTPUT_CHARS or len(blocks) >= MAX_BLOCKS:
            raise ExtractionFailure("excessive_text")
        blocks.append({
            "locator": locator,
            "section": (block_section or section)[:160],
            "text": text,
            "candidate": candidate,
        })

    for child in body:
        if child.tag == f"{W}p":
            paragraph_number += 1
            text = _paragraph_text(child)
            properties = child.find(f"{W}pPr")
            style = properties.find(f"{W}pStyle") if properties is not None else None
            style_name = str(style.attrib.get(f"{W}val", "")) if style is not None else ""
            is_heading = style_name.lower().startswith("heading")
            is_list = properties is not None and properties.find(f"{W}numPr") is not None
            if is_heading and text:
                section = text
            else:
                append(f"paragraph:{paragraph_number}", text, candidate=is_list)
        elif child.tag == f"{W}tbl":
            table_number += 1
            for row_number, row in enumerate(child.findall(f"{W}tr"), start=1):
                for cell_number, cell in enumerate(row.findall(f"{W}tc"), start=1):
                    text = _normal_text(" ".join(
                        _paragraph_text(paragraph) for paragraph in cell.findall(f".//{W}p")
                    ))
                    append(
                        f"table:{table_number}/row:{row_number}/cell:{cell_number}",
                        text,
                        candidate=True,
                        block_section=f"Table {table_number}",
                    )
    if not blocks:
        raise ExtractionFailure("no_text")
    return blocks


def main() -> int:
    _set_limits()
    _disable_network()
    kind = sys.argv[1] if len(sys.argv) == 2 else ""
    data = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(data) > MAX_INPUT_BYTES:
        result: dict[str, Any] = {"status": "error", "code": "file_too_large"}
    else:
        try:
            if kind == "pdf":
                blocks = _pdf_blocks(data)
            elif kind == "docx":
                blocks = _docx_blocks(data)
            else:
                raise ExtractionFailure("unsupported_type")
            result = {"status": "ok", "blocks": blocks}
        except ExtractionFailure as error:
            result = {"status": "error", "code": error.code}
    encoded = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode()
    if len(encoded) > 1_500_000:
        encoded = b'{"status":"error","code":"excessive_text"}'
    sys.stdout.buffer.write(encoded)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
