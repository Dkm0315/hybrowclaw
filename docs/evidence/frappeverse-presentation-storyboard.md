# Muster for Frappeverse — presentation storyboard

Status: content-complete, media-release-gated. The deck may be rendered before the master video exists, but it must not be called final or distributed with a placeholder video.

Audience outcome: Frappe builders and business operators should leave believing that AI can safely operate and extend their existing Frappe estate because Muster works through native surfaces, current Frappe authority, reviewable workflows, and visible evidence.

Talk shape: problem → failure of wrappers → solution → trust → live proof video → proof interpretation → architecture → hard cases → impact → invitation.

## 1. Muster: AI that operates Frappe in front of you

- On-slide thesis: **Ask in plain language. Watch native Frappe work happen. Keep Frappe in control.**
- Visual: Muster mark, one labeled cursor path entering a native Frappe form, generous white space.
- Speaker note: Open with the visible outcome, not the architecture. Muster is an operating layer, not a replacement ERP and not a chat widget glued to REST endpoints.

## 2. Frappe automation still stops at the last mile

- On-slide statement: People still translate intent into forms, metadata, scripts, reports, migrations, approvals, and verification by hand.
- Visual: intent on the left; seven human translation steps in the middle; business outcome on the right.
- Speaker note: The hard part is not generating text. It is correctly changing a live, customized, permissioned system and proving what happened.

## 3. A chatbot or API wrapper cannot own the workflow

- On-slide comparison:
  - Wrapper: guessed schema, hidden authority, one-shot calls, weak recovery, output as proof.
  - Operating layer: live metadata, exact actor authority, durable workflow, compensation, independent reread.
- Visual: two-column comparison with the wrapper path visibly breaking at RBAC, native UI, and recovery.
- Speaker note: Do not criticize APIs; explain that APIs are one capability inside a larger governed operating loop.

## 4. Muster turns intent into governed, visible work

- On-slide flow: **Ask → understand → propose → review → operate → verify → remember**.
- Supporting line: Questions, CRUD, workflows, customization, coding, and artifacts share one control plane.
- Visual: seven-stage horizontal process with approval and compensation loops.
- Speaker note: A question can stay read-only. An effect becomes a typed proposal. Risk and authority determine the interaction, not a magic phrase from the user.

## 5. It works with the Frappe estate you already have

- On-slide estate: Desk · ERPNext · HRMS · CRM · Helpdesk · custom Vue/React apps.
- Supporting line: Native routers and forms; no target-app fork.
- Visual: Frappe at the center, existing applications around it, Muster as the operating plane crossing them.
- Speaker note: Call out that CRM and Helpdesk keep their own UI. The Field Ops demo is intentionally untouched to prove adapter-based operation.

## 6. Frappe remains the source of authority

- On-slide trust stack:
  1. Current actor, roles, User Permissions, and document permissions.
  2. Effective metadata: Custom Fields, Property Setters, workflows, and app version.
  3. Exact revision, scoped approval, idempotency, postcondition reread.
  4. Immutable evidence and compensation.
- Visual: layered authority stack with Frappe at the base, not Muster.
- Speaker note: Muster never invents access. Permission changes during a run invalidate stale authority.

## 7. One continuous take answers the real question

- On-slide question: **Can AI install, connect, understand, operate, customize, recover, and prove—all on a real Frappe v16 estate?**
- Proof contract: normal speed · readable cursor · no hidden effects · no seeded outcomes presented as live · secrets redacted.
- Visual: chapter timeline from terminal onboarding through Telegram and evidence closure.
- Speaker note: Set the audience’s verification criteria before playing the video.

## 8. Continuous demonstration

- Primary content: embedded final master MP4, full-bleed inside a thin black frame.
- Minimal chrome: chapter title and a small “normal speed / continuous take” label.
- Playback fallbacks: embedded local media, stable link, and QR code. The slide is incomplete until all three resolve to the approved final master.
- Speaker note: Let the video breathe. Narrate only transitions and the trust boundary currently visible.

## 9. What the demonstration proved

- Evidence rows:
  - Clean terminal onboarding → reciprocal binding receipt.
  - Native CRUD and denial → exact actor, revision, and independent reread.
  - CRM, Helpdesk, custom app → native router and untouched-source proof.
  - SOP/customization/coding → cited requirement-to-artifact trace and rollback.
  - Recovery and Telegram → durable run identity and channel-linked authority.
- Visual: compact evidence table keyed to video timestamps and receipt IDs.
- Speaker note: Only include rows whose final video timestamp and evidence manifest are present.

## 10. Agents coordinate; workflows recover

- On-slide architecture: goal interpreter → business/module specialists → bounded subagents → approval join → capability executor → verifier/evidence.
- State controls: pause · steer · resume · cancel · retry · compensate.
- Visual: one small fan-out/join graph with a durable run ledger below it.
- Speaker note: Workflows are reviewable JS/JSON artifacts, but source text is parsed as data and never treated as arbitrary executable code.

## 11. The hard cases are the product

- Cases:
  - Half-specified update/delete and exact-record clarification loops.
  - Frappe v16 DocType “Create & Continue” persisting a skeleton record.
  - Child-table bookkeeping versus meaningful business drift.
  - Cache/app-version drift across native SPAs.
  - Permission revocation during an attended run.
- Visual: five failure cards, each ending in the system invariant that now contains it.
- Speaker note: This is the credibility slide. Show discovered failures, not a polished fiction in which nothing ever breaks.

## 12. One operating layer changes how Frappe is implemented

- Administrator: guided configuration with native review and rollback.
- Developer: governed app code, ORM, Jinja, hooks, patches, tests, and migrations.
- Partner: repeatable SOP-to-solution delivery with evidence.
- Business user: ask about the site or request work without learning implementation vocabulary.
- Visual: four-column role impact matrix.
- Speaker note: Faster is valuable; faster while preserving authority and recoverability is the product.

## 13. Build the operating layer with us

- Near-term milestones: production deployment, ecosystem adapters, performance evidence, community capability packs.
- Invitation: bring one difficult Frappe workflow, one customized estate, and one permission boundary.
- Closing line: **If Muster can make that work visible, governed, and recoverable, it belongs in the platform.**
- Visual: sparse closing slide with Muster mark and repository/demo contact locations once stable.
- Speaker note: End with a concrete invitation, not a generic thank-you.

## Final-deck release checks

- The master video is embedded and its stable link and QR fallback resolve.
- Every evidence row maps to an exact timestamp, actor, site/app revision, receipt, and independent verification.
- Every slide has presenter notes and a timed talk-track allocation.
- No internal endpoint, credential, raw prompt, chain-of-thought, private fixture, or unsupported production claim appears.
- PPTX and PDF are rendered and inspected slide by slide at 1280×720 or 16:9 equivalent.
- The venue copy works offline; fonts, video codec, links, and QR code are tested on a second machine.
