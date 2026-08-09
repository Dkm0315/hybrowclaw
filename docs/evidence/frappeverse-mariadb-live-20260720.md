# Frappeverse clean MariaDB site — live deployment evidence

> **Superseded:** This bench and its dedicated database were deleted and rebuilt on
> 2026-07-20 at the user's request. Do not use this record as current deployment
> evidence. The replacement checkpoint is documented in
> `frappeverse-clean-reset-erpnext-first-20260720.md`.

Date: 2026-07-20  
Host: Frappe-2  
Bench: `/home/goblin/frappeverse/frappeverse-demo-v16`  
Site: `frappeverse.local`

## Result

A clean Frappe v16 site was created with Bench against a dedicated, non-root, localhost-only MariaDB instance. This replaces the earlier “MariaDB root access required” blocker without using SQLite, Docker privileges, or the host's system MariaDB administrator account.

## Database boundary

- Server: MariaDB `10.11.13-MariaDB-0ubuntu0.24.04.1`
- Bind: `127.0.0.1:13306`
- Character set: `utf8mb4`
- Collation: `utf8mb4_unicode_ci`
- Data directory: `/home/goblin/frappeverse/mariadb-user/data`
- Configuration: `/home/goblin/frappeverse/mariadb-user/my.cnf`
- Root and site credentials are stored only in owner-readable server files/site configuration and are never included in this evidence.

The generated site database credential appeared in an installation traceback when Redis Queue was initially unavailable. Redis was started, ERPNext initialization and migration were repaired, and the site database credential was then rotated. `bench --site frappeverse.local list-apps` succeeded after the rotation, proving the site configuration and database account agree.

## Installed application revisions

| App | Version | Branch/revision |
| --- | --- | --- |
| Frappe | 16.27.1 | `version-16` / `f33ac3f` |
| ERPNext | 16.9.1 | `version-16` / `99a81db` |
| HRMS | 16.4.3 | `version-16` / `d9154fe` |
| CRM | 1.78.2 | `main` / `9a212f4` |
| Helpdesk | 1.27.0 | `HEAD` / `6b423f8` |
| Telephony | 0.0.1 | `develop` / `d4ee5b4` |
| Field Ops Demo | 1.0.0 | `master` / `fb1a228` |
| Muster | 0.1.0 | `main` / `51afafb` |

## Repair and verification sequence

1. Initialized a user-owned MariaDB data directory with `mariadb-install-db`.
2. Started MariaDB using the checked-in localhost-only configuration.
3. Secured both local root login identities without printing credential values.
4. Created `frappeverse.local` with `bench new-site --db-type mariadb`.
5. Started the Bench Redis Cache and Queue processes after ERPNext's post-install hook correctly failed closed when Queue was absent.
6. Installed ERPNext, HRMS, Telephony, CRM, Helpdesk, Field Ops Demo, and Muster in dependency order.
7. Reran `erpnext.setup.install.after_install` with Queue available.
8. Completed `bench --site frappeverse.local migrate`, including all application DocType syncs, fixtures, customizations, jobs, dashboards, orphan cleanup, and `after_migrate` hooks.
9. Rotated the generated site database password and independently reconnected through Bench.
10. Started the clean web process on port 8200 and received `{"message":"pong"}` using the `frappeverse.local` host header.

## Clean business baseline

The baseline seeder was run twice after repairing two clean-site assumptions discovered live: Bench's `execute --kwargs` expects Python literals (`True`, not JSON `true`), and an app-only ERPNext installation does not necessarily contain setup-wizard masters such as `Gender: Male` and `Warehouse Type: Transit`. The seeder now converges only the exact missing standard masters instead of rerunning the full, noisy setup fixture set.

The second run was quiet and idempotent. It verified:

- 6 named role-specific demo users
- 1 demo company
- 24 Customers
- 8 Suppliers
- 40 Items
- 12 Leads
- 5 Employees
- zero records before and after in every Muster Mission, Run, Work Unit, Activity, Approval, Artifact, Ask Turn, Evidence Clip, Workflow Proposal, Development Proposal, and Change Set table

Therefore business context is seeded, but none of the AI outcomes intended for the continuous demonstration have been pre-created.

## Browser proof

A fresh 1440×900 Chrome session authenticated as Administrator through the local SSH tunnel and was redirected by Frappe to its still-uncompleted native setup wizard. The screenshot at `output/evidence/frappeverse-mariadb-live-20260720/clean-mariadb-setup-wizard-with-ask-muster.png` proves both facts in one frame: the site is genuinely at the clean Frappe onboarding boundary, and the global **Ask Muster** surface is already available without navigating into a Muster application page. The browser script also verified a non-Guest `sid` cookie and reported `setupWizard=true` and `askMusterVisible=true`.

This is development evidence, not the final public recording: it uses an SSH-local origin, and the setup wizard has not yet been completed in the attended final-demo flow.

## What this proves—and does not prove

This proves a real MariaDB-backed Frappe v16 ecosystem site can be created and migrated with the current application sources on Frappe-2. It does not yet prove final stable DNS/TLS, production process supervision, high-volume seed performance, browser acceptance, or the continuous video scenario. Those remain separate release gates.
