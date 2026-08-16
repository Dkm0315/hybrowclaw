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

## Clip 1: Repair an engineering revision escape

**Target length:** 18-25 seconds

**Fault:** Drawing and Control Plan are at the revised specification while Process Flow or PPFMEA still carries the previous operation/tolerance.

**Prompt:** `drawing changed but job card and inspection still old. why this happening? please fix`

**Shot sequence:**

1. Show the revised component and ask the question.
2. Muster streams short progress in business language while comparing the connected engineering, production, and inspection records.
3. The interface moves to the first divergent record and highlights expected versus observed values.
4. Muster explains the operational impact in business language.
5. Choose the reviewed correction and approve it.
6. Muster continues without another prompt, updates only the approved demo record, re-reads the chain, and shows `Verified` with linked evidence.

**End frame:** `Revision B is now consistent through Process Flow and PPFMEA. Production release checks pass.`

## Clip 2: Teach the customized workflow

**Target length:** 15-22 seconds

**Fault:** A valid demo record has not completed the next customer-specific business step.

**Prompt:** `this is not moving ahead. what i have to do?`

**Shot sequence:**

1. Begin on the record at the point where the user is unsure what comes next.
2. Muster explains the current stage and highlights the next required business field or action.
3. It explains what belongs there and why, then waits long enough for the user to read.
4. The user approves the meaningful action on screen.
5. Muster continues through the customized path and verifies the resulting state without another prompt.

**End frame:** The user sees the completed business step and understands the same path for future work.

## Clip 3: Permission-aware customization repair

**Target length:** 15-20 seconds

**Fault:** A namespaced validation script incorrectly rejects a valid revised operation.

**Prompt:** `why this error coming? i did everything correctly. please check and fix`

**Shot sequence:**

1. Show the blocked action and its business message.
2. Muster proves that the entered business information and user sequence are correct.
3. It explains the outdated rule in business language; technical detail is shown only to an authorized role.
4. Muster previews the smallest script correction and expected effect.
5. The authorized user approves it; Muster applies, retries, and verifies the original workflow.

**End frame:** The transition succeeds, the user is not blamed for a system defect, and the audit receipt identifies the approving role.

## Clip 4: v15-to-v16 migration support handoff

**Target length:** 18-25 seconds

**Fault:** A `MUSTER-DEMO-*` script or report references a schema surface removed or renamed in v16.

**Prompt:** `after update this page not opening. check what happened and send to support`

**Shot sequence:**

1. Show the failing migrated screen or report.
2. Muster compares the installed app/schema version with the script/report dependency graph.
3. It identifies the stale reference and shows the affected UI behavior without exposing source secrets.
4. Muster prepares an API-led Helpdesk draft containing business impact, affected links, versions, reproduction, sanitized errors, and validation evidence.
5. Show customer `Vinman Engineering Private Limited`, subject, and evidence summary; nothing has been sent yet.
6. Human approves `Approve & send to support`.
7. Muster creates and rereads the ticket through the configured Helpdesk OAuth connection; a parallel existing tab shows the new ticket arriving.

**End frame:** The verified ticket link is open with enough evidence for support to continue without re-interviewing the user.

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
