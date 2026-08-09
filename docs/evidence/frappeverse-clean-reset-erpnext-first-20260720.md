# Frappeverse clean reset — ERPNext-first runnable evidence

Date: 2026-07-20  
Host: `Frappe-2`  
Bench: `/home/goblin/frappeverse/frappeverse-demo-v16`  
Site: `frappeverse.local`

## Result

The previous clean demo bench and its dedicated MariaDB data directory were
stopped and deleted. The separate development bench at
`/home/goblin/personal/muster-frappe-bench` was preserved.

A replacement Frappe v16 bench and isolated MariaDB site were created from
scratch. ERPNext was fetched and installed before any other application.

## Verified application order

Both `sites/apps.txt` and `bench --site frappeverse.local list-apps` contained
exactly:

1. `frappe` — 16.27.1, `version-16`
2. `erpnext` — 16.28.0, `version-16`

No HRMS, CRM, Helpdesk, Muster, or other app had been fetched or installed at
this proof gate. Both repositories resolve to the official Frappe GitHub
remotes, named `upstream` by this Bench installation.

## Runnable checks

- Full `bench --site frappeverse.local migrate` completed, including DocType
  synchronization, fixtures, dashboards, customizations, orphan cleanup, and
  `after_migrate` hooks.
- The regenerated Procfile launches the clean web process on port 8200 and
  Socket.IO on port 9200.
- `GET /api/method/ping` on the clean site returned `{"message":"pong"}`.
- `GET /api/method/ping` on the preserved development site at port 8005 also
  returned `{"message":"pong"}`.
- MariaDB listens only on `127.0.0.1:13306`; the clean Bench Redis services
  listen only on `127.0.0.1:13200` and `127.0.0.1:13201`.
- The provisioning guard rejects a lock file unless ERPNext is the first app
  after Frappe; all 11 provisioning checks pass.

This is the clean post-reset checkpoint. Later apps must be installed only
after this evidence boundary and in an explicitly reviewed dependency order.

## Post-boundary ecosystem checkpoint

After preserving the ERPNext-first boundary above, the clean site was extended
in dependency-safe order with HRMS, Telephony, CRM, Helpdesk, and Muster. The
resulting installed stack is Frappe 16.27.1, ERPNext 16.28.0, HRMS 16.13.0,
Telephony 0.0.1, CRM 1.79.0, Helpdesk 1.27.0, and Muster 0.1.0.

Muster was matched byte-for-byte against all 251 tracked files in pushed commit
`ce2f0bf84d726e770efe0213939dfdfdd94c9b6b` before the clean checkout was
attached to that revision. The staged tree and release tree both resolved to
`10f351a21dbbd7b9188348d6eca4b71d02e50b15`; no tracked differences remained.
The app assets rebuilt, the complete site migration finished, and `allow_tests`
was restored to `false`.

The restarted clean site returned HTTP 200 with `{"message":"pong"}` on port
8200, while the preserved development site continued returning the same result
on port 8005. Unauthenticated route probes produced the expected boundaries:
Desk and Muster Control redirected to login, CRM denied an unauthenticated shell,
and Helpdesk and HRMS served their native application shells.
