# Release evidence schema

The release manifest is JSON with `schema_version`, `release_id`, immutable code/app revisions, environment id, Frappe/ERPNext/Python/Node/database/Redis versions, site fingerprint, seed version, creation time, thresholds, required case ids, results, artifacts, exceptions, and overall status.

Each result includes `case_id`, `claim_id`, category, actor and roles, tenant/company scope, fixture ids, expected and actual outcome, start/end time, status, retry/flaky count, side-effect assertions, redacted diagnostics, and artifact references with SHA-256 hashes. Browser evidence adds viewport/browser; load evidence adds sample size and p50/p95/p99; video evidence maps claim ids to timestamps.

Use deterministic synthetic data only. Seed and cleanup are idempotent and restricted to a named test namespace. Any customer PII, secret, token, browser storage value, unredacted network/log output, missing hash, stale revision, skipped/flaky blocking case, tenant leak, critical/high security issue, lost/duplicated effect, or failed restore makes the release fail.
