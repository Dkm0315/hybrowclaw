from __future__ import annotations

import io
import sys
import types
import unittest
import warnings
import zipfile
from unittest.mock import patch

from muster.orchestration.source_document_worker import (
    ExtractionFailure,
    _docx_blocks,
    _pdf_blocks,
)


CONTENT_TYPES = b"""<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Override PartName="/word/document.xml"
 ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""
ROOT_RELS = b"""<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="r1" Type="officeDocument" Target="word/document.xml"/>
</Relationships>"""
DOCUMENT = b"""<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Orders</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>Users approve orders.</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Orders must retain evidence.</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>"""


def make_docx(*, document=DOCUMENT, extras=None, duplicate=None) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", CONTENT_TYPES)
        archive.writestr("_rels/.rels", ROOT_RELS)
        archive.writestr("word/document.xml", document)
        for name, value in (extras or {}).items():
            archive.writestr(name, value)
        if duplicate:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                archive.writestr(duplicate, b"duplicate")
    return output.getvalue()


class TestSourceDocumentWorker(unittest.TestCase):
    def test_extracts_stable_docx_paragraph_and_table_blocks(self):
        self.assertEqual(_docx_blocks(make_docx()), [
            {
                "locator": "paragraph:2",
                "section": "Orders",
                "text": "Users approve orders.",
                "candidate": True,
            },
            {
                "locator": "table:1/row:1/cell:1",
                "section": "Table 1",
                "text": "Orders must retain evidence.",
                "candidate": True,
            },
        ])

    def test_rejects_external_relationship_macro_and_unsafe_xml(self):
        external = b"""<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="r2" Type="hyperlink" Target="https://example.invalid"
         TargetMode="External"/></Relationships>"""
        cases = (
            (make_docx(extras={"word/_rels/document.xml.rels": external}), "external_relationship"),
            (make_docx(extras={"word/vbaProject.bin": b"macro"}), "active_content"),
            (make_docx(document=b'<!DOCTYPE x [<!ENTITY e "x">]><x/>'), "unsafe_xml"),
        )
        for data, code in cases:
            with self.subTest(code=code), self.assertRaises(ExtractionFailure) as raised:
                _docx_blocks(data)
            self.assertEqual(raised.exception.code, code)

    def test_rejects_zip_bomb_traversal_and_duplicate_members(self):
        cases = (
            make_docx(extras={"word/media/repetitive.bin": b"A" * 1_000_000}),
            make_docx(extras={"../escape": b"bad"}),
            make_docx(duplicate="word/document.xml"),
        )
        for data in cases:
            with self.assertRaises(ExtractionFailure) as raised:
                _docx_blocks(data)
            self.assertEqual(raised.exception.code, "unsafe_archive")

    def test_pdf_magic_is_checked_before_parser_loading(self):
        with self.assertRaises(ExtractionFailure) as raised:
            _pdf_blocks(b"not a pdf")
        self.assertEqual(raised.exception.code, "magic_mismatch")

    def test_pdf_page_citations_and_encrypted_scanned_active_failures(self):
        class Page(dict):
            def __init__(self, text="", **values):
                super().__init__(values)
                self.text = text

            def extract_text(self):
                return self.text

        class Reader:
            def __init__(self, *, encrypted=False, pages=None, root=None):
                self.is_encrypted = encrypted
                self.pages = pages or []
                self.trailer = {"/Root": root or {}}

        module = types.ModuleType("pypdf")
        pdf = b"%PDF-1.7\nfixture"
        cases = (
            (Reader(encrypted=True), "encrypted"),
            (Reader(pages=[Page()]), "no_text"),
            (Reader(pages=[Page("Must work")], root={"/OpenAction": {}}), "active_content"),
        )
        for reader, code in cases:
            module.PdfReader = lambda *_args, selected=reader, **_kwargs: selected
            with (
                self.subTest(code=code),
                patch.dict(sys.modules, {"pypdf": module}),
                self.assertRaises(ExtractionFailure) as raised,
            ):
                _pdf_blocks(pdf)
            self.assertEqual(raised.exception.code, code)

        module.PdfReader = lambda *_args, **_kwargs: Reader(
            pages=[Page("Orders must be approved.\nBackground"), Page("Evidence shall be retained.")]
        )
        with patch.dict(sys.modules, {"pypdf": module}):
            blocks = _pdf_blocks(pdf)
        self.assertEqual([block["locator"] for block in blocks], ["page:1", "page:1", "page:2"])


if __name__ == "__main__":
    unittest.main()
