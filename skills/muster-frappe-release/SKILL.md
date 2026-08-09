---
name: muster-frappe-release
description: Build, seed, deploy, break, measure, and prove a Muster Frappe release. Use for bench or site setup, migrations, realistic ERPNext data, role matrices, browser/mobile QA, performance and recovery tests, release evidence, Frappeverse demos, or normal-speed presentation video.
---

# Muster Frappe Release

Release through an isolated, reproducible Frappe bench and an artifact-backed quality gate. A polished demo is evidence of a verified system, not a substitute for tests.

## Environment Workflow

1. Load `frappe-agent:frappe-bench` and inspect versions, installed apps, sites, ports, services, disk, backups, and dirty repositories.
2. Use a dedicated bench/site and unused ports for Muster. Do not modify customer benches unless explicitly scoped.
3. Pin Frappe, ERPNext, Python, Node, app revisions, and dependency locks. Record commands without secrets.
4. Validate clean install, migrate, restart, upgrade from the prior schema, backup/restore, and safe uninstall where supported.
5. Publish health, version, migration, queue, scheduler, websocket, and gateway checks.

## Data and Test Matrix

Seed deterministic but realistic companies, departments, users, roles, customers, suppliers, items, transactions, projects, tickets, HR records, custom DocTypes, metadata, agents, workflows, runs, approvals, and artifacts. Include sparse, malformed, high-volume, multilingual, long-text, attachment, and boundary data.

Run unit, schema, integration, permission, migration, queue/realtime, browser, narrow-mobile, accessibility, concurrency, load, soak, chaos, backup/restore, and security-negative suites. Preserve logs and results with timestamps, versions, hashes, and environment identity.

Each case writes one JSON result with `schema_version`, `case_id`, `claim_id`, `environment_id`, code and app revisions, site, actor and roles, tenant/company scope, fixture ids, start/end timestamps, expected outcome, actual outcome, status, side-effect assertions, artifact paths and hashes, and redacted diagnostics. A release manifest enumerates required cases and thresholds; missing, skipped, flaky, unhashed, or stale results fail the gate.

Set measurable thresholds before the run: zero authorization or tenant-isolation failures, zero lost/duplicated committed effects, zero unresolved high/critical security findings, all migration/restore cases passing, and agreed p95 UI/API/queue targets under the seeded load. Record lower-severity exceptions with owner and expiry.

## Live Proof

Demonstrate several deep scenarios: business workflow, metadata creation and rollback, report/print/web artifact generation, hierarchical agents, approval and denial, background continuation while the user works elsewhere, reconnect/recovery, mobile control, and Telegram-originated work.

Record at normal speed with readable cursor movement and pauses. Show setup and outcomes, not secrets or hidden prompts. Provide a reproducible evidence index connecting each claim to tests, screenshots, traces, records, and video timestamps.

Never claim production readiness while a required gate is skipped, flaky, manually inferred, or only demonstrated with Administrator.

Cut over only from a tested immutable revision after backup and restore rehearsal. Define traffic drain, scheduler/worker ordering, migration timeout, health gates, smoke actors, and observation window. Automatically abort or roll forward on failed schema migrations; restore only when schema/data compatibility is proven. Record the exact rollback decision and post-rollback integrity checks.

Validate results against [release-evidence-schema.md](references/release-evidence-schema.md).
