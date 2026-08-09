# Video evidence index

This directory owns the cryptographic index for the Frappeverse presentation. It does not
claim that a scenario exists until a real recording and its supporting files are supplied.

Create a draft, add explicit clip metadata and artifact paths, then generate and validate:

```sh
node scripts/evidence/video-evidence.mjs init --out output/evidence/video-draft.json
node scripts/evidence/video-evidence.mjs generate \
  --input output/evidence/video-draft.json \
  --out output/evidence/video-manifest.json
node scripts/evidence/video-evidence.mjs validate \
  --manifest output/evidence/video-manifest.json \
  --report output/evidence/video-validation.json
```

Generation computes file sizes, SHA-256 hashes, media type, exact ffprobe duration, and encoded
viewport dimensions. Validation re-probes those values, checks ordered runbook chapters, and
counts only explicit `coverage_cells`; the clip filename and top-level outcome do not grant
coverage. It verifies a WebM or ISO media container signature before writing the index. Output files are created with
exclusive-create semantics so an existing evidence index is never overwritten silently.

A complete manifest needs allow and deny clips for Muster, ERPNext, HRMS, CRM, Helpdesk,
and one custom Frappe application on both
desktop and mobile. Every clip also needs hashed screenshot, trace, and test-receipt links.
Desktop clips must be 1440x900 and mobile clips 390x844. Every clip must identify the exact
captured site revision. Empty or partial manifests remain useful collection indexes but
intentionally fail release validation. Failed, idle, zero-byte, and smoke takes belong in an
explicit exclusion inventory rather than the release manifest.

## Native Desk update/delete RBAC evidence

On an isolated demo site, create deterministic disabled/passwordless maker, checker and denied
personas plus two disposable exact-record proposals. The setup compiles through the host-owned
schema/graph validators and invokes the governed review API as the checker:

```sh
bench --site demo.example.test execute muster.demo.native_desk_rbac_evidence.setup \
  --kwargs '{"confirm": True}'
```

Then capture the live fail-closed checks without executing either mutation:

```sh
node scripts/evidence/native-desk-rbac-evidence.mjs \
  --bench /absolute/path/to/frappe-bench \
  --site demo.example.test \
  --update MST-WFP-UPDATE \
  --delete MST-WFP-DELETE \
  --denied auditor@example.test
```

The command invokes Bench without a shell, requires Administrator on the local Bench execution,
and writes `output/evidence/native-desk-rbac-live.json` with exclusive-create permissions. It
proves different maker/checker identities, maker self-approval denial, requester-only preview,
current-revision acceptance, stale-revision denial, optional denied-user RBAC, and `executed: false`.
It does not click Save/Delete or change either record. Use new proposal identifiers and a new
output path for each take rather than overwriting earlier evidence.

`native-surface-browser-scenarios.json` is the machine-readable recording contract for the
Muster-owned Desk, CRM, Helpdesk, and configured custom-SPA adapters. It fixes the route,
viewport, operation, native pause boundary, independent before/after read, mobile cursor
check, and fail-closed cases. Run `pnpm test:evidence` before recording. These definitions
do not count as proof until the continuous browser clips and independent reads are captured.
