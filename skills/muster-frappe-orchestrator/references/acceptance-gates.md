# Acceptance gates

A production milestone passes only when all applicable gates have machine-readable evidence.

1. Architecture: documented ownership, versioned contracts, upgrade strategy, rollback, and threat model.
2. Function: happy paths and partial-failure paths complete through the UI and supported APIs.
3. Security: deny-by-default authorization, tenant isolation, field-level controls, secret redaction, and adversarial tests.
4. Durability: idempotency, retries, cancellation, resume after worker restart, and duplicate-event handling.
5. Experience: desktop and narrow mobile layouts, keyboard access, readable progress, approvals, diffs, and undo guidance.
6. Frappe depth: DocTypes, custom fields, property setters, workflows, reports, print formats, web pages, background jobs, and installed-app extension points are exercised where in scope.
7. Scale: realistic users, roles, companies, records, concurrent runs, rate limits, and queue pressure.
8. Operations: health checks, structured logs, metrics, traces, backups, migrations, and recovery rehearsal.
9. Compatibility: clean install, upgrade, uninstall where supported, and Frappe v16 migration validation.
10. Proof: reproducible commands, test reports, screenshots, browser recordings, artifact hashes, and a release manifest.

Negative verification must include unauthorized cross-tenant access, privilege escalation, prompt/tool injection, stale approvals, replay, duplicated commands, worker death, network loss, malformed metadata, concurrent edits, and rollback failure.
