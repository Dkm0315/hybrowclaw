import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  declare_artifact,
  document_generation_workflow,
  docx_document,
  markdown_report,
  office_artifact_workflow,
  pdf_document,
  pptx_presentation,
  validate_artifact_file,
  xlsx_workbook,
  type ArtifactDeclaration,
  type ChannelDeliveryStatus,
} from "../src/artifacts.js";

async function writeArtifact(dir: string, name: string, base64: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, Buffer.from(base64, "base64"));
  return path;
}

function zipEntries(bytes: Buffer): Map<string, string> {
  const entries = new Map<string, string>();
  let offset = 0;
  while (offset + 30 < bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    const name = bytes.subarray(nameStart, nameStart + nameLength).toString("utf8");
    entries.set(name, bytes.subarray(dataStart, dataEnd).toString("utf8"));
    offset = dataEnd;
  }
  return entries;
}

function count(text: string, pattern: RegExp): number {
  return Array.from(text.matchAll(pattern)).length;
}

test("artifact registry declarations validate real files and preserve delivery provenance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-artifact-registry-"));
  const docx = await docx_document({
    title: "Implementation Brief",
    summary: "Provider-authored implementation narrative.",
    sections: [{ heading: "Evidence", content: "The file exists, is non-empty, and carries delivery provenance." }],
    filename: "implementation-brief",
  });
  const localPath = await writeArtifact(dir, docx.filename, docx.base64);

  const declared = await declare_artifact({
    type: "docx",
    title: "Implementation Brief",
    localPath,
    sourceChannel: "slack",
    sourcePrompt: "Generate a DOCX implementation brief for the CTO.",
    providerRunId: "run-provider-123",
    tokenLedgerId: "ledger-456",
    deliveryStatus: "artifact_uploaded",
  });

  assert.deepEqual(declared satisfies ArtifactDeclaration, {
    type: "docx",
    title: "Implementation Brief",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    localPath,
    hostedUrl: undefined,
    sizeBytes: docx.bytes,
    sourceChannel: "slack",
    sourcePrompt: "Generate a DOCX implementation brief for the CTO.",
    providerRunId: "run-provider-123",
    tokenLedgerId: "ledger-456",
    deliveryStatus: "artifact_uploaded" satisfies ChannelDeliveryStatus,
    failureReason: undefined,
    validationStatus: "valid",
    validationIssues: [],
  });

  const missing = await declare_artifact({
    type: "pdf",
    title: "Missing PDF",
    localPath: join(dir, "missing.pdf"),
    sourceChannel: "telegram",
    sourcePrompt: "Generate a PDF summary.",
    deliveryStatus: "artifact_local_only",
  });
  assert.equal(missing.validationStatus, "invalid");
  assert.match(missing.failureReason ?? "", /does not exist/);
});

test("local document builders emit inspectable rich structures instead of empty shells", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-artifact-rich-"));
  const markdown = await markdown_report({
    title: "Release Evidence Brief",
    summary: "Document generation hardening evidence for local and provider-led paths.",
    sections: [
      { heading: "Generation Path", content: "Provider-generated artifacts keep provider-authored content separate from delivery mechanics." },
      { heading: "Validation", content: "The harness validates structure, non-empty content, and channel delivery truth before declaring success." },
    ],
    evidence: [
      { claim: "PDF depth", evidence: "10+ pages with content streams", status: "verified" },
      { claim: "Office depth", evidence: "DOCX/PPTX/XLSX package parts inspected", status: "verified" },
    ],
  });
  assert.match(markdown.markdown, /^# Release Evidence Brief/m);
  assert.match(markdown.markdown, /^## Evidence/m);
  assert.match(markdown.markdown, /\| Claim \| Evidence \| Status \|/);
  assert.match(markdown.markdown, /\| PDF depth \| 10\+ pages with content streams \| verified \|/);
  const markdownPath = join(dir, "release-evidence.md");
  await writeFile(markdownPath, markdown.markdown);
  assert.deepEqual((await validate_artifact_file({ type: "markdown", localPath: markdownPath })).facts, {
    headings: 4,
    tableRows: 2,
    listItems: 0,
  });

  const docx = await docx_document({
    title: "Document Generation Hardening Brief",
    summary: "A structured implementation brief with enough paragraphs to inspect.",
    sections: Array.from({ length: 6 }, (_, index) => ({
      heading: `Hardening Area ${index + 1}`,
      content: [
        `Area ${index + 1} explains how Muster writes real document structure.`,
        "It preserves provider-led content ownership while validating local package output.",
        "It records evidence, delivery status, token ledger linkage, and failure reasons.",
      ].join("\n"),
    })),
    filename: "hardening-brief",
  });
  const docxEntries = zipEntries(Buffer.from(docx.base64, "base64"));
  const documentXml = docxEntries.get("word/document.xml") ?? "";
  assert.ok(docxEntries.has("docProps/core.xml"));
  assert.ok(docxEntries.has("docProps/app.xml"));
  assert.match(docxEntries.get("docProps/core.xml") ?? "", /Document Generation Hardening Brief/);
  assert.equal(count(documentXml, /w:pStyle w:val="Heading1"/g), 6);
  assert.equal(count(documentXml, /<w:p>/g) >= 20, true);
  assert.match(documentXml, /records evidence, delivery status, token ledger linkage/);
  const docxPath = await writeArtifact(dir, docx.filename, docx.base64);
  const docxFacts = (await validate_artifact_file({ type: "docx", localPath: docxPath })).facts;
  assert.equal(docxFacts.headings, 6);
  assert.equal(Number(docxFacts.paragraphs) >= 20, true);
  assert.equal(docxFacts.hasCoreProperties, true);

  const pptx = await pptx_presentation({
    title: "Artifact Pillar CTO Demo",
    filename: "artifact-pillar-demo",
    slides: Array.from({ length: 6 }, (_, index) => ({
      title: `Demo Scene ${index + 1}`,
      bullets: [
        "Provider-led generation",
        "Structural validation",
        "Truthful channel delivery",
        `Evidence checkpoint ${index + 1}`,
      ],
      notes: `Speaker note ${index + 1}: open the package parts and show the artifact declaration receipt.`,
    })),
  });
  const pptxEntries = zipEntries(Buffer.from(pptx.base64, "base64"));
  assert.ok(pptxEntries.has("docProps/core.xml"));
  assert.ok(pptxEntries.has("ppt/slides/_rels/slide1.xml.rels"));
  assert.ok(pptxEntries.has("ppt/notesSlides/notesSlide6.xml"));
  assert.match(pptxEntries.get("ppt/_rels/presentation.xml.rels") ?? "", /Target="slides\/slide6\.xml"/);
  assert.match(pptxEntries.get("ppt/slides/slide4.xml") ?? "", /Evidence checkpoint 4/);
  assert.match(pptxEntries.get("ppt/notesSlides/notesSlide6.xml") ?? "", /artifact declaration receipt/);
  const pptxPath = await writeArtifact(dir, pptx.filename, pptx.base64);
  const pptxFacts = (await validate_artifact_file({ type: "pptx", localPath: pptxPath })).facts;
  assert.equal(pptxFacts.slides, 6);
  assert.equal(pptxFacts.notes, 6);
  assert.equal(pptxFacts.slideRelationships, 6);

  const rows = Array.from({ length: 12 }, (_, index) => ({
    metric: `artifact_case_${index + 1}`,
    channel: index % 2 === 0 ? "slack" : "telegram",
    status: index % 3 === 0 ? "artifact_uploaded" : "artifact_created",
    evidence: `validated package row ${index + 1}`,
  }));
  const xlsx = await xlsx_workbook({
    filename: "artifact-evidence-workbook",
    sheets: [
      { name: "Run Ledger", columns: ["metric", "channel", "status", "evidence"], rows },
      { name: "Delivery", columns: ["channel", "status", "fix"], rows: [{ channel: "slack", status: "artifact_uploaded", fix: "files:write configured" }, { channel: "telegram", status: "artifact_local_only", fix: "gateway file read required" }] },
      { name: "Validation", columns: ["format", "fact", "value"], rows: [{ format: "pdf", fact: "pages", value: 12 }, { format: "pptx", fact: "slides", value: 6 }, { format: "xlsx", fact: "sheets", value: 3 }] },
    ],
  });
  const xlsxEntries = zipEntries(Buffer.from(xlsx.base64, "base64"));
  assert.ok(xlsxEntries.has("docProps/core.xml"));
  assert.ok(xlsxEntries.has("xl/sharedStrings.xml"));
  assert.match(xlsxEntries.get("xl/_rels/workbook.xml.rels") ?? "", /Target="worksheets\/sheet3\.xml"/);
  assert.match(xlsxEntries.get("xl/workbook.xml") ?? "", /Run Ledger/);
  assert.match(xlsxEntries.get("xl/sharedStrings.xml") ?? "", /artifact_case_12/);
  assert.equal(count(xlsxEntries.get("xl/worksheets/sheet1.xml") ?? "", /<row r="/g), 13);
  const xlsxPath = await writeArtifact(dir, xlsx.filename, xlsx.base64);
  const xlsxFacts = (await validate_artifact_file({ type: "xlsx", localPath: xlsxPath })).facts;
  assert.equal(xlsxFacts.sheets, 3);
  assert.equal(xlsxFacts.rows, 20);
  assert.equal(Number(xlsxFacts.sharedStrings) >= 30, true);

  const pdf = await pdf_document({
    title: "Artifact Pillar Long PDF",
    summary: "Readable long-form PDF output with multiple page objects and non-trivial content.",
    sections: Array.from({ length: 28 }, (_, index) => ({
      heading: `Chapter ${index + 1}`,
      content: Array.from({ length: 18 }, (__, line) => `Chapter ${index + 1} paragraph line ${line + 1} documents generation quality, validation facts, channel delivery receipts, provider-led semantics, and release evidence.`).join(" "),
    })),
    filename: "artifact-pillar-long",
  });
  const pdfText = Buffer.from(pdf.base64, "base64").toString("utf8");
  assert.match(pdfText, /^%PDF-1\.4/);
  assert.equal(count(pdfText, /\/Type\s*\/Page\b/g) >= 10, true);
  assert.match(pdfText, /Artifact Pillar Long PDF/);
  assert.match(pdfText, /provider-led semantics/);
  assert.equal(count(pdfText, /stream\nBT/g) >= 10, true);
  const pdfPath = await writeArtifact(dir, pdf.filename, pdf.base64);
  const pdfFacts = (await validate_artifact_file({ type: "pdf", localPath: pdfPath })).facts;
  assert.equal(Number(pdfFacts.pages) >= 10, true);
  assert.equal(Number(pdfFacts.contentStreams) >= 10, true);
  assert.equal(Number(pdfFacts.textOperators) > 250, true);
});

test("artifact builders validate markdown, 10+ page PDF, multi-sheet XLSX, DOCX, and noted PPTX", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-artifact-deep-"));

  const markdown = await markdown_report({
    title: "Muster Feature Evidence",
    summary: "Office artifact pillar evidence.",
    sections: [{ heading: "Delivery", content: "Slack and Telegram share delivery statuses." }],
  });
  const markdownPath = join(dir, "feature-evidence.md");
  await writeFile(markdownPath, markdown.markdown);
  assert.deepEqual(await validate_artifact_file({ type: "markdown", localPath: markdownPath }), {
    status: "valid",
    mimeType: "text/markdown",
    sizeBytes: Buffer.byteLength(markdown.markdown),
    issues: [],
    facts: { headings: 2, tableRows: 0, listItems: 0 },
  });

  const pdf = await pdf_document({
    title: "Muster Artifact Pillar",
    summary: "A long-form PDF describing Muster features and evidence.",
    sections: Array.from({ length: 26 }, (_, index) => ({
      heading: `Evidence Area ${index + 1}`,
      content: Array.from({ length: 16 }, (__, line) => `Muster validates provider-led artifact generation, registry receipts, token ledger linkage, channel delivery truth, and Office structure line ${line + 1}.`).join(" "),
    })),
    filename: "muster-artifact-pillar",
  });
  const pdfPath = await writeArtifact(dir, pdf.filename, pdf.base64);
  const pdfValidation = await validate_artifact_file({ type: "pdf", localPath: pdfPath });
  assert.equal(pdfValidation.status, "valid");
  assert.equal(pdfValidation.facts.pages >= 10, true);

  const xlsx = await xlsx_workbook({
    filename: "feature-battlecard",
    sheets: [
      { name: "Token Report", columns: ["model", "input", "output"], rows: [{ model: "provider", input: 42000, output: 2200 }] },
      { name: "Feature Battlecard", columns: ["feature", "status"], rows: [{ feature: "Artifacts", status: "pillar" }] },
      { name: "Delivery", columns: ["channel", "status"], rows: [{ channel: "telegram", status: "artifact_uploaded" }] },
    ],
  });
  const xlsxPath = await writeArtifact(dir, xlsx.filename, xlsx.base64);
  const xlsxText = (await readFile(xlsxPath)).toString("utf8");
  assert.match(xlsxText, /xl\/worksheets\/sheet3\.xml/);
  assert.match(xlsxText, /Feature Battlecard/);
  assert.equal((await validate_artifact_file({ type: "xlsx", localPath: xlsxPath })).facts.sheets, 3);

  const docx = await docx_document({
    title: "Implementation Brief",
    summary: "DOCX brief with real package content.",
    sections: [{ heading: "Scope", content: "Core artifact registry and validation." }],
    filename: "implementation-brief",
  });
  const docxPath = await writeArtifact(dir, docx.filename, docx.base64);
  assert.equal((await validate_artifact_file({ type: "docx", localPath: docxPath })).status, "valid");

  const pptx = await pptx_presentation({
    title: "CTO Demo",
    filename: "cto-demo",
    slides: Array.from({ length: 5 }, (_, index) => ({
      title: `Demo Moment ${index + 1}`,
      bullets: ["Provider route", "Registry receipt", "Truthful delivery"],
      notes: `Speaker note ${index + 1}: show the artifact receipt and delivery status.`,
    })),
  });
  const pptxPath = await writeArtifact(dir, pptx.filename, pptx.base64);
  const pptxText = (await readFile(pptxPath)).toString("utf8");
  assert.match(pptxText, /ppt\/slides\/slide5\.xml/);
  assert.match(pptxText, /ppt\/notesSlides\/notesSlide5\.xml/);
  assert.match(pptxText, /Speaker note 5/);
  assert.equal((await validate_artifact_file({ type: "pptx", localPath: pptxPath })).facts.slides, 5);
});

test("provider-led artifact workflows route rich content to the provider instead of faking heavy content locally", async () => {
  const workflow = await office_artifact_workflow({
    format: "pdf",
    destination: "slack",
    originMode: "provider-generated",
    sourceChannel: "slack",
    prompt: "Generate a 12-page PDF implementation brief with evidence and a CTO summary.",
    providerRunId: "run-provider-789",
    tokenLedgerId: "ledger-789",
  });

  assert.equal(workflow.mode, "provider-led-generation");
  assert.match(String(workflow.providerInstructions), /Generate a 12-page PDF implementation brief/);
  assert.match(String(workflow.providerInstructions), /Do not use delivery mechanics as document content/);
  assert.deepEqual(workflow.deliveryStatuses, [
    "acknowledged",
    "progress_started",
    "provider_running",
    "artifact_created",
    "artifact_uploaded",
    "artifact_hosted",
    "artifact_local_only",
    "completed",
    "failed",
  ]);
  assert.equal((workflow.registryDeclaration as ArtifactDeclaration).providerRunId, "run-provider-789");
  assert.equal((workflow.registryDeclaration as ArtifactDeclaration).tokenLedgerId, "ledger-789");
});

test("document_generation_workflow exposes a direct invocation contract for provider and local document creation", async () => {
  const local = await document_generation_workflow({
    format: "docx",
    originMode: "harness-created",
    title: "Implementation Brief",
    sourceChannel: "cli",
  });
  assert.equal(local.mode, "harness-created");
  assert.deepEqual(local.invokeSequence, ["docx_document", "declare_artifact"]);
  assert.deepEqual(local.requiredInputs, ["title", "summary", "sections"]);
  assert.equal(local.registry.type, "docx");
  assert.equal(local.registry.sourceChannel, "cli");

  const provider = await document_generation_workflow({
    format: "pdf",
    originMode: "provider-generated",
    title: "CTO Evidence PDF",
    sourceChannel: "slack",
    prompt: "Generate a 12-page CTO evidence PDF with implementation detail and proof.",
  });
  assert.equal(provider.mode, "provider-generated");
  assert.deepEqual(provider.invokeSequence, ["provider_run", "pdf_document", "declare_artifact"]);
  assert.match(String(provider.providerInstructions), /Generate a 12-page CTO evidence PDF/);
  assert.match(String(provider.providerInstructions), /Return structured sections/);
  assert.equal(provider.localBuilderRole, "write_provider_content_only");
});
