# Muster Artifact Studio Contract

Muster treats Office, PDF, and Markdown outputs as governed artifacts, not as
extension-shaped strings. Rich document requests should be provider-led: the
provider creates the substantive report, brief, deck outline, workbook data, or
narrative; the harness writes, validates, declares, and delivers the resulting
file.

Harness-created artifacts are still valid for deterministic scorecards, token
reports, ledgers, QA evidence, and source-backed tables. They must be based on
provided data or runtime evidence rather than filler.

## Supported Formats

- `markdown`
- `pdf`
- `docx`
- `pptx`
- `xlsx`

Local builders must emit inspectable structure, not extension-shaped shells:

- Markdown includes headings, sections, and optional evidence tables.
- PDF includes a readable header, multiple page objects for long content, text
  streams, and page footers.
- DOCX includes document properties, title style, heading styles, paragraphs,
  and `word/document.xml`.
- PPTX includes document properties, multiple slide parts, speaker-note parts
  when notes are supplied, slide relationships, and presentation relationships.
- XLSX includes document properties, workbook relationships, multiple worksheet
  parts, `sharedStrings.xml`, header rows, and non-trivial row content.

`validate_artifact_file` checks that a local path exists, is a non-empty file,
has the expected container/header, and exposes structural facts:

- Markdown: `headings`, `tableRows`, `listItems`
- PDF: `pages`, `contentStreams`, `textOperators`
- DOCX: `documents`, `paragraphs`, `headings`, `hasCoreProperties`,
  `hasAppProperties`
- PPTX: `slides`, `notes`, `slideRelationships`, `hasCoreProperties`,
  `hasAppProperties`
- XLSX: `sheets`, `rows`, `sharedStrings`, `hasWorkbookRelationships`,
  `hasCoreProperties`, `hasAppProperties`

## Direct Generation Workflow

`document_generation_workflow` is the direct pack-level contract for document
creation. It returns:

- `format`
- `mode`
- `invokeSequence`
- `requiredInputs`
- `localBuilderRole`
- `providerInstructions` for provider-led requests
- `validation`
- `registry`

For provider-led requests, the invoke sequence starts with `provider_run`, then
uses the local builder only to write provider-created structured content before
validation and declaration. The local builder role is `write_provider_content_only`.

## Declaration Fields

`declare_artifact` returns the registry shape every channel and audit path can
share:

- `type`
- `title`
- `mimeType`
- `localPath`
- `hostedUrl`
- `sizeBytes`
- `sourceChannel`
- `sourcePrompt`
- `providerRunId`
- `tokenLedgerId`
- `deliveryStatus`
- `failureReason`
- `validationStatus`
- `validationIssues`

## Delivery Status

Channel delivery must use the shared status vocabulary:

- `acknowledged`
- `pairing_required`
- `progress_started`
- `provider_running`
- `artifact_created`
- `artifact_uploaded`
- `artifact_hosted`
- `artifact_local_only`
- `completed`
- `failed`

Slack and Telegram adapters should report native uploads, hosted URLs, local-only
fallbacks, missing scope failures, and unreadable local files truthfully against
this vocabulary.
