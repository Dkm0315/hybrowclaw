# Muster for Frappe

Muster is a standalone Frappe v16 app that exposes governed, durable AI missions in Desk.
It stores the business projection of missions, nested work, approvals, typed change sets and
evidence while the universal Muster runtime remains the execution authority.

## Compatibility

- Frappe v16
- Python 3.14
- Node 24
- ERPNext v16 is optional; the app must install on Frappe alone.

Install with the normal Bench workflow, then open `/desk/muster-control`. Never install this
development tree over an existing customer app with the same package name.

## Security model

Every mutation is POST-only, permission checked at execution time, tied to an idempotency key,
and represented as a typed change set. Secrets remain in Password fields and are never included
in boot info. External identity mappings do not grant Frappe permissions by themselves.

## Deterministic proof data

Demo data is never created during install or migration. On an isolated proof site, invoke the
app command with explicit confirmation:

```console
bench --site muster.local seed-demo --scale tiny --without-erpnext --yes
```

The supported scales are `tiny`, `small`, `medium`, `large`, and `acceptance`. The
`acceptance` profile is the release-gate dataset: 30 principals, 20 agents, 12 workflows,
10,000 missions, 30,000 work units/runs, and 100,000 activities. Run the same command separately
for each proof site to demonstrate database-per-site tenant isolation. Reruns converge on stable
site-scoped identifiers and report before/after/create counts. If ERPNext is installed, omit
`--without-erpnext` to create namespaced Customers through ordinary ERPNext document APIs.

The seeder never enables Muster, marks a site binding trusted, stores a channel credential, or
runs a proposed change. It requires the Administrator session and `--yes`; other users are denied.
