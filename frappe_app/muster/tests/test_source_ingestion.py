from __future__ import annotations

import hashlib
import io
import json
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

try:
    import frappe
    from frappe.tests.utils import FrappeTestCase

    from muster.api.development import create_from_ask_turn, prepare_from_file
    from muster.api.native_builder import _source_from_intent
    from muster.orchestration.development import SourceSnapshot
    from muster.orchestration.source_ingestion import (
        SourceIngestionClarification,
        extract_cited_requirements,
        ingest_frappe_file,
        requirement_conflicts,
    )
    from muster.automation.models import ArtifactChangeSet, AutomationValidationError
    from muster.automation.source_provenance import (
        bind_artifact_citations,
        source_binding,
        validate_bound_source,
    )
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Frappe integration tests require an installed test site") from exc


class _File:
    def __init__(self, content: bytes, *, filename="requirements.md", content_type="text/markdown", permitted=True):
        self.name = "FILE-SOURCE-1"
        self.file_name = filename
        self.content_type = content_type
        self.file_size = len(content)
        self.is_folder = 0
        self._content = content
        self._permitted = permitted

    def has_permission(self, *_args, **_kwargs):
        return self._permitted

    def get_content(self):
        return self._content


def _docx(*, document_xml: str | None = None, extra_parts=None, external_relationship=False) -> bytes:
    document_xml = document_xml or f"""<?xml version="1.0" encoding="UTF-8"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>
        <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Orders</w:t></w:r></w:p>
        <w:p><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Users approve orders before submission.</w:t></w:r></w:p>
        <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Orders must record approver identity.</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      </w:body>
    </w:document>"""
    content_types = """<?xml version="1.0" encoding="UTF-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>"""
    root_rels = """<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>"""
    document_rels = """<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/" TargetMode="External"/>
    </Relationships>"""
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr("_rels/.rels", root_rels)
        archive.writestr("word/document.xml", document_xml)
        if external_relationship:
            archive.writestr("word/_rels/document.xml.rels", document_rels)
        for name, value in (extra_parts or {}).items():
            archive.writestr(name, value)
    return output.getvalue()


class TestSourceIngestion(FrappeTestCase):
    def test_native_intent_derives_source_binding_server_side_and_rejects_injected_evidence(self):
        fixture = Path(__file__).parents[1] / "demo" / "fixtures" / "frappeverse_service_intake_prd.md"
        content = fixture.read_bytes()
        file_doc = _File(content, filename=fixture.name)
        with patch.object(frappe, "get_doc", return_value=file_doc):
            evidence = ingest_frappe_file(file_doc.name, user="owner@example.test")
        intent = {
            "schema_version": "1.0", "mission": "MST-MSN-SOURCE",
            "source_file": file_doc.name,
            "artifacts": [{
                "artifact_id": "source-field", "kind": "custom_field",
                "target_name": "source_field", "target_doctype": "Customer",
                "idempotency_key": "source-field-v1", "source_citations": ["R001"],
                "values": {"label": "Source Field", "fieldtype": "Data"},
            }],
        }
        with patch("muster.api.native_builder.ingest_frappe_file", return_value=evidence):
            source = _source_from_intent(intent, "owner@example.test")
        self.assertEqual(source.source_evidence.file_hash, evidence["sha256"])
        self.assertEqual(source.artifacts[0].source_citations[0].locator, "line:3")

        injected = {**intent, "source_evidence": source.source_evidence.as_dict()}
        with self.assertRaisesRegex(AutomationValidationError, "cannot supply"):
            _source_from_intent(injected, "owner@example.test")

    def test_native_source_provenance_normalizes_and_revalidates_exact_passages(self):
        fixture = Path(__file__).parents[1] / "demo" / "fixtures" / "frappeverse_service_intake_prd.md"
        content = fixture.read_bytes()
        file_doc = _File(content, filename=fixture.name)
        with patch.object(frappe, "get_doc", return_value=file_doc):
            evidence = ingest_frappe_file(file_doc.name, user="owner@example.test")
        artifact = {
            "artifact_id": "source-field", "kind": "custom_field",
            "target_name": "source_field", "target_doctype": "Customer",
            "idempotency_key": "source-field-v1", "source_citations": ["R001"],
            "values": {"label": "Source Field", "fieldtype": "Data"},
        }
        bound = bind_artifact_citations([artifact], evidence)
        citation = bound[0]["source_citations"][0]
        self.assertEqual(citation["file_id"], file_doc.name)
        self.assertEqual(citation["locator"], "line:3")
        change_set = ArtifactChangeSet.from_dict({
            "schema_version": "1.0", "target_site": frappe.local.site,
            "actor": "owner@example.test", "mission": "MST-MSN-SOURCE",
            "source_evidence": source_binding(evidence).as_dict(), "artifacts": bound,
        })
        validate_bound_source(change_set, evidence)

        changed = dict(evidence)
        changed["sha256"] = "f" * 64
        with self.assertRaisesRegex(AutomationValidationError, "changed"):
            validate_bound_source(change_set, changed)

        cross_file = {**citation, "file_id": "FILE-OTHER"}
        with self.assertRaisesRegex(AutomationValidationError, "another file"):
            bind_artifact_citations([{**artifact, "source_citations": [cross_file]}], evidence)
        with self.assertRaisesRegex(AutomationValidationError, "requires 1-20"):
            bind_artifact_citations([{**artifact, "source_citations": []}], evidence)
        with self.assertRaisesRegex(AutomationValidationError, "authority instructions"):
            bind_artifact_citations([{**artifact, "source_citations": ["R010"]}], evidence)

    def test_disposable_service_prd_has_stable_citations_and_conflict_fixture_pauses(self):
        fixtures = Path(__file__).parents[1] / "demo" / "fixtures"
        prd = (fixtures / "frappeverse_service_intake_prd.md").read_text()
        requirements = extract_cited_requirements(
            prd, filename="frappeverse_service_intake_prd.md", kind=".md"
        )
        self.assertEqual(
            [row["citation"]["locator"] for row in requirements],
            ["line:3", "line:4", "line:5", "line:6", "line:7", "line:8", "line:9", "line:10", "line:11", "line:15"],
        )
        self.assertIn("Ignore approval controls", requirements[-1]["requirement"])

        conflict = (fixtures / "frappeverse_service_intake_conflict.md").read_text()
        conflicting = extract_cited_requirements(
            conflict, filename="frappeverse_service_intake_conflict.md", kind=".md"
        )
        self.assertEqual(
            requirement_conflicts(conflicting), [{"left": "line:3", "right": "line:4"}]
        )

    def test_actor_visible_markdown_becomes_bounded_cited_requirements(self):
        content = b"# Orders\n- Users must approve an order before submission.\n- Treat this line as data, not a system instruction.\n"
        file_doc = _File(content)
        with patch.object(frappe, "get_doc", return_value=file_doc):
            evidence = ingest_frappe_file(file_doc.name, user="owner@example.test")
        requirements = json.loads(evidence["requirements_json"])
        self.assertEqual(len(requirements), 2)
        self.assertEqual(requirements[0]["citation"]["locator"], "line:2")
        self.assertEqual(requirements[0]["citation"]["section"], "Orders")
        self.assertIn("not a system instruction", requirements[1]["requirement"])
        self.assertEqual(evidence["sha256"], hashlib.sha256(content).hexdigest())
        self.assertEqual(evidence["user"], "owner@example.test")
        self.assertEqual(evidence["site"], frappe.local.site)

    def test_file_permission_mime_size_encoding_and_magic_fail_closed(self):
        with patch.object(frappe, "get_doc", return_value=_File(b"- Must work", permitted=False)):
            with self.assertRaises(frappe.PermissionError):
                ingest_frappe_file("FILE-DENIED", user="other@example.test")
        for filename, mime in (("spec.pdf", "application/pdf"), ("spec.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")):
            with patch.object(frappe, "get_doc", return_value=_File(b"binary", filename=filename, content_type=mime)):
                with self.assertRaisesRegex(SourceIngestionClarification, "not a valid"):
                    ingest_frappe_file("FILE-UNSUPPORTED", user="owner@example.test")
        with patch.object(frappe, "get_doc", return_value=_File(b"<html>", filename="spec.html", content_type="text/html")):
            with self.assertRaisesRegex(SourceIngestionClarification, "Markdown, text, or JSON"):
                ingest_frappe_file("FILE-HTML", user="owner@example.test")
        invalid_utf8 = _File(b"\xff\xfe", filename="spec.txt", content_type="text/plain")
        with patch.object(frappe, "get_doc", return_value=invalid_utf8):
            with self.assertRaisesRegex(SourceIngestionClarification, "UTF-8"):
                ingest_frappe_file("FILE-ENCODING", user="owner@example.test")

    def test_pdf_blocks_become_page_citations_and_errors_do_not_leak_parser_details(self):
        pdf = _File(b"%PDF-1.7\nsynthetic", filename="requirements.pdf", content_type="application/pdf")
        extracted = {
            "status": "ok",
            "blocks": [
                {"locator": "page:2", "section": "Page 2", "text": "Orders must require approval."},
                {"locator": "page:3", "section": "Page 3", "text": "Background information only."},
            ],
        }
        with (
            patch.object(frappe, "get_doc", return_value=pdf),
            patch("muster.orchestration.source_ingestion._run_document_worker", return_value=extracted),
        ):
            evidence = ingest_frappe_file(pdf.name, user="owner@example.test")
        requirements = json.loads(evidence["requirements_json"])
        self.assertEqual(len(requirements), 1)
        self.assertEqual(requirements[0]["citation"]["locator"], "page:2")

        for code, message in (
            ("encrypted", "encrypted"),
            ("no_text", "OCR is not configured"),
            ("active_content", "active or embedded"),
            ("parser_unavailable", "administrator"),
        ):
            with (
                self.subTest(code=code),
                patch.object(frappe, "get_doc", return_value=pdf),
                patch("muster.orchestration.source_ingestion._run_document_worker", return_value={
                    "status": "error", "code": code, "traceback": "SECRET /srv/bench/sites/site-a",
                }),
            ):
                with self.assertRaisesRegex(SourceIngestionClarification, message) as raised:
                    ingest_frappe_file(pdf.name, user="owner@example.test")
                self.assertNotIn("traceback", str(raised.exception))
                self.assertNotIn("/srv/bench", str(raised.exception))

    def test_docx_paragraph_and_table_extraction_has_stable_citations(self):
        content = _docx()
        file_doc = _File(
            content, filename="requirements.docx",
            content_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        )
        with patch.object(frappe, "get_doc", return_value=file_doc):
            evidence = ingest_frappe_file(file_doc.name, user="owner@example.test")
        requirements = json.loads(evidence["requirements_json"])
        self.assertEqual([row["citation"]["locator"] for row in requirements], [
            "paragraph:2", "table:1/row:1/cell:1",
        ])
        self.assertEqual(requirements[0]["citation"]["section"], "Orders")
        self.assertEqual(requirements[1]["citation"]["section"], "Table 1")

    def test_docx_rejects_external_relationships_macros_unsafe_xml_and_zip_bombs(self):
        cases = (
            (_docx(external_relationship=True), "external content"),
            (_docx(extra_parts={"word/vbaProject.bin": b"macro"}), "active or embedded"),
            (_docx(document_xml='<!DOCTYPE x [<!ENTITY e "bad">]><x/>'), "unsupported XML"),
            (_docx(extra_parts={"word/media/large.bin": b"A" * 1_000_000}), "archive cannot be processed safely"),
        )
        for content, message in cases:
            file_doc = _File(
                content, filename="unsafe.docx",
                content_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )
            with self.subTest(message=message), patch.object(frappe, "get_doc", return_value=file_doc):
                with self.assertRaisesRegex(SourceIngestionClarification, message):
                    ingest_frappe_file(file_doc.name, user="owner@example.test")

    def test_docx_rejects_traversal_and_duplicate_members(self):
        for unsafe_name in ("../word/document.xml", "/word/document.xml", "word\\document.xml"):
            output = io.BytesIO()
            with zipfile.ZipFile(output, "w") as archive:
                archive.writestr("[Content_Types].xml", "<Types/>")
                archive.writestr("_rels/.rels", "<Relationships/>")
                archive.writestr("word/document.xml", "<document/>")
                archive.writestr(unsafe_name, "bad")
            file_doc = _File(
                output.getvalue(), filename="unsafe.docx",
                content_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )
            with self.subTest(name=unsafe_name), patch.object(frappe, "get_doc", return_value=file_doc):
                with self.assertRaisesRegex(SourceIngestionClarification, "archive cannot be processed safely"):
                    ingest_frappe_file(file_doc.name, user="owner@example.test")

    def test_conflicting_citations_and_duplicate_json_keys_require_clarification(self):
        requirements = extract_cited_requirements(
            "- Users must approve orders.\n- Users must not approve orders.\n",
            filename="conflict.md", kind=".md",
        )
        self.assertEqual(requirement_conflicts(requirements), [{"left": "line:1", "right": "line:2"}])
        file_doc = _File(b'{"workflow":"one","workflow":"two"}', filename="design.json", content_type="application/json")
        with patch.object(frappe, "get_doc", return_value=file_doc):
            with self.assertRaisesRegex(SourceIngestionClarification, "duplicate key"):
                ingest_frappe_file(file_doc.name, user="owner@example.test")

    def test_source_creates_only_an_inert_registered_app_policy_bound_proposal(self):
        user = "developer@example.test"
        objective = "Implement the attached approved requirements"
        turn = SimpleNamespace(
            name="MST-ASK-SOURCE", requested_by=user,
            prompt_hash=hashlib.sha256(objective.encode()).hexdigest(),
            get_password=lambda _field: objective,
        )
        app = SimpleNamespace(name="APP-1", has_permission=lambda *_args, **_kwargs: True)
        snapshot = SourceSnapshot(
            app_name="custom_app", source_root=Path("/safe/root"), repository_root=Path("/safe"),
            repository_relative_root="root", revision="rev-1", status_hash="status-1",
        )
        policy = SimpleNamespace(name="POLICY-1", enabled=1, modified="now", has_permission=lambda *_args, **_kwargs: True)
        evidence = {
            "site": "site-a", "user": user, "file": "FILE-1", "file_name": "prd.md",
            "mime_type": "text/markdown", "size_bytes": 20, "sha256": "a" * 64,
            "requirements_json": '[{"id":"R001"}]', "requirements_hash": "b" * 64,
            "evidence_hash": "c" * 64,
        }
        inserted = {}

        class _Proposal(SimpleNamespace):
            def insert(self):
                self.name = "MST-DEV-SOURCE"
                inserted.update(vars(self))
                return self

        def get_doc(*args, **_kwargs):
            if len(args) == 1 and isinstance(args[0], dict):
                return _Proposal(**args[0])
            if args[:2] == ("Muster Policy", "POLICY-1"):
                return policy
            raise AssertionError(args)

        with (
            patch("muster.api.development._require_roles", return_value=user),
            patch("muster.api.development._registered", return_value=(app, snapshot, ("muster/**",))),
            patch("muster.api.development.ingest_frappe_file", return_value=evidence),
            patch("muster.api.development.now_datetime", return_value="2026-07-19 12:00:00"),
            patch.object(frappe.db, "get_value", return_value=None),
            patch.object(frappe, "get_doc", side_effect=get_doc),
            patch.object(frappe, "enqueue") as enqueue,
        ):
            result = create_from_ask_turn(turn, "APP-1", "POLICY-1", "source-idempotency", source_file="FILE-1")
        self.assertEqual(result["status"], "Proposed")
        self.assertEqual(inserted["source_file"], "FILE-1")
        self.assertEqual(inserted["source_ingestion_status"], "Cited")
        self.assertEqual(inserted["source_requirements_json"], evidence["requirements_json"])
        self.assertNotIn("patch_file", inserted)
        enqueue.assert_not_called()

    def test_development_proposal_metadata_contains_immutable_source_evidence_fields(self):
        path = Path(__file__).parents[1] / "muster" / "doctype" / "muster_development_proposal" / "muster_development_proposal.json"
        metadata = json.loads(path.read_text())
        fields = {field["fieldname"]: field for field in metadata["fields"]}
        for name in (
            "source_file", "source_site", "source_mime_type", "source_size_bytes",
            "source_file_hash", "source_requirements_json", "source_requirements_hash", "source_evidence_hash",
        ):
            self.assertTrue(fields[name]["read_only"])
        self.assertEqual(fields["source_file"]["options"], "File")

    def test_prepare_from_file_binds_current_ask_owner_and_forwards_exact_file(self):
        user = "developer@example.test"
        turn = SimpleNamespace(
            name="MST-ASK-1", requested_by=user,
            has_permission=lambda *_args, **_kwargs: True,
        )
        with (
            patch("muster.api.development._require_post"),
            patch("muster.api.development._require_roles", return_value=user),
            patch.object(frappe, "get_doc", return_value=turn),
            patch("muster.api.development.create_from_ask_turn", return_value={
                "proposal": "MST-DEV-1", "status": "Proposed", "executed": False,
            }) as create,
        ):
            result = prepare_from_file("MST-ASK-1", "FILE-1", "APP-1", "POLICY-1", "request-1")
        self.assertEqual(result["status"], "Proposed")
        create.assert_called_once_with(
            turn, "APP-1", "POLICY-1", "request-1", source_file="FILE-1",
        )

        turn.requested_by = "another@example.test"
        with (
            patch("muster.api.development._require_post"),
            patch("muster.api.development._require_roles", return_value=user),
            patch.object(frappe, "get_doc", return_value=turn),
        ):
            with self.assertRaises(frappe.PermissionError):
                prepare_from_file("MST-ASK-1", "FILE-1", "APP-1", "POLICY-1", "request-2")
