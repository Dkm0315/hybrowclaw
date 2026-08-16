# Frappeverse Demo Video Plan

## Recording principles

- Record the real restored Frappe site and the real Muster side panel. Do not synthesize screens or results.
- Use only `MUSTER-DEMO-*` records and reversible faults. Never alter restored customer records for a shot.
- Keep each mission continuous. One user request starts diagnosis, navigation, approved action, re-read, and verification.
- Show concise public progress from the provider and verified actions. Do not expose hidden reasoning, local paths, credentials, or server details.
- Pause long enough to read the business problem, the key finding, and the verified result.
- Show human approval immediately before a write, script change, submission, or support-ticket creation.
- Capture three clean rehearsals before recording the accepted take.

## Shared setup

1. Open the affected `MUSTER-DEMO-*` component in Frappe.
2. Keep the Muster panel open so page context and progress remain visible.
3. Confirm the intended fault is active and the deterministic validator fails for the expected relationship.
4. Confirm the logged-in demo user has only the permissions required for the scenario.
5. Clear the prior mission transcript, not the indexed site context.
6. Start screen recording before the prompt is entered.

## Clip 1: Engineering revision escape

**Target length:** 18-25 seconds

**Fault:** Drawing and Control Plan are at the revised specification while Process Flow or PPFMEA still carries the previous operation/tolerance.

**Prompt:** `This component was revised last week. Why are production and inspection still following the old specification?`

**Shot sequence:**

1. Show the revised component and ask the question.
2. Muster streams short progress: mapping the engineering chain, comparing revisions, checking production and inspection dependencies.
3. The interface moves to the first divergent record and highlights expected versus observed values.
4. Muster explains the operational impact in business language.
5. Choose the reviewed correction and approve it.
6. Muster continues without another prompt, updates only the approved demo record, re-reads the chain, and shows `Verified` with linked evidence.

**End frame:** `Revision B is now consistent through Process Flow and PPFMEA. Production release checks pass.`

## Clip 2: Investigation and support handoff

**Target length:** 15-22 seconds

**Fault:** An enabled namespaced customization causes a repeatable mismatch and Error Log entry.

**Prompt:** `Report this issue to support with enough evidence that I do not have to explain it again.`

**Shot sequence:**

1. Begin on the failing record with the error visible.
2. Muster correlates the record, customization, schema/app versions, and relevant sanitized error evidence.
3. Show the ticket preview: business impact, expected/observed state, affected links, likely code/configuration area, reproduction, and validation plan.
4. Human approves ticket creation.
5. Muster creates the ticket in the configured Helpdesk and opens the real ticket link.

**End frame:** The Helpdesk ticket contains complete evidence and a continuation reference for support/development.

## Clip 3: Customization-aware guidance

**Target length:** 15-20 seconds

**Fault:** A namespaced validation rule blocks a workflow transition with a customer-specific message.

**Prompt:** `Why can I not move this forward, and what do I need to correct?`

**Shot sequence:**

1. Show the blocked action and its business message.
2. Muster identifies the effective mandatory fields, Property Setter, workflow transition, and governing customization from live metadata.
3. The cursor moves to each missing business field while Muster explains the expected value in user language.
4. The user supplies or selects the missing value.
5. Muster retries the reviewed transition and verifies the resulting workflow state.

**End frame:** The transition succeeds with a concise explanation of what changed and a link to the record.

## Clip 4: v15-to-v16 migration diagnosis

**Target length:** 18-25 seconds

**Fault:** A `MUSTER-DEMO-*` script or report references a schema surface removed or renamed in v16.

**Prompt:** `This customization stopped working after the upgrade. Diagnose it and prepare a safe correction.`

**Shot sequence:**

1. Show the failing migrated screen or report.
2. Muster compares the installed app/schema version with the script/report dependency graph.
3. It identifies the stale reference and shows the affected UI behavior without exposing source secrets.
4. Show the correction preview and deterministic validation plan.
5. Human approves the namespaced demo correction.
6. Muster applies it, reloads the affected route, and verifies the behavior and regression checks.

**End frame:** `Migration correction verified on v16` with the affected route and evidence receipt.

## Acceptance gate

Do not record a final take unless:

- the same mission completes without a second user prompt;
- visible progress remains alive throughout long work;
- every write has an approval boundary;
- the result matches direct database/API validation;
- the mission stops on missing input, permission denial, stale revision, or failed verification;
- the fault can be restored for another take;
- the flow passes three consecutive rehearsals;
- the resulting ticket or record link opens successfully;
- no customer data, credentials, local paths, or private provider reasoning appears.

## Final edit

- Export one clean clip per scenario plus one 60-90 second stitched story.
- Use direct cuts and restrained callouts; do not accelerate typing or evidence screens beyond readability.
- Keep the Muster and Vinman visual identity unchanged.
- Add captions for the user prompt, finding, approval, and verified outcome.
- Retain the unedited recording as QA evidence.
