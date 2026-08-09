# Video evidence status

Inventory cutoff: `2026-07-19T12:18:34.074Z` (the finish timestamp of the newest indexed recording).

The generated index contains 13 completed clips, 36,240,258 video bytes, 1,081.92 seconds
of video, and 22 hashed screenshot links. Every indexed video was independently decoded with
`ffprobe`; its SHA-256, byte size, duration, and encoded viewport are in
`output/evidence/video-index.json`. Timestamps disclose their basis as
`filesystem_mtime_minus_ffprobe_duration`; they are metadata-derived capture bounds, not a
native recorder clock claim.

Each clip now also links a scenario replay trace and a scenario-specific receipt derived from
the successful live Frappe Bench permission suite. The captured site is pinned to Muster
`51afafb4c0dbcc05e16176943bca82c4e41e89bb`, Frappe `f33ac3f`, ERPNext `99a81db`,
HRMS `d9154fe`, CRM `9a212f4`, and configuration digest `06a8bb63`.

Seven excluded takes are recorded separately in `output/evidence/video-exclusions.json`:
one idle take, one modal-blocked take, one zero-byte take, and the one-second recorder smoke
test, plus three completed 800x450 originals superseded by standard 1440x900 retakes. The
screenshot and trace associated with the zero-byte Company User Permission take are listed as
orphaned support and are not linked to another scenario. All 20 WebM files at the cutoff are
accounted for: 13 indexed and seven excluded.

## Explicit coverage

Only `coverage_cells` explicitly asserted by a reviewed clip are counted. Configuration clips
do not count as allow/deny business proof.

| Product | Desktop allow | Desktop deny | Mobile allow | Mobile deny |
| --- | --- | --- | --- | --- |
| Muster | Covered | Covered | Covered | Covered |
| ERPNext | Covered | Covered | Covered | Covered |
| HRMS | Covered | Covered | Covered | Covered |
| CRM | Covered | Covered | Covered | Covered |

Coverage is 16 of 16 cells. The ERPNext mobile recording proves both the one-row allowed East
Customer list and the denied direct West Customer route.

## Video evidence release gate

Strict validation now passes with zero errors:

- 13 of 13 clips have an exact site/app revision.
- 13 of 13 clips have a hashed scenario replay trace and scenario-specific test receipt.
- All 16 required product, viewport, and outcome cells are explicitly covered.
- The evidence validator test suite passes 11 of 11 tests, including mutation, renamed-file,
  container-signature, viewport, timestamp, path-traversal, and fail-closed coverage checks.

The machine-readable validator result is `output/evidence/video-index-validation.json`.
This closes the video-evidence gate only; MariaDB migration, TLS/DNS, recovery rehearsal, and
production performance gates remain separate and must not be inferred from this report.
