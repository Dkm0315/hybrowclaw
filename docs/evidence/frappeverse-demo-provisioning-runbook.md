# Frappeverse clean-room demo on Frappe-2

This runbook provisions a new, isolated Frappe v16 demo bench. It is intentionally separate from customer benches and from the current development site. The script is checked in but must not be run until the app lock, DNS, TLS, backup target, and operator window are reviewed.

## Fixed identities

Use these names consistently in the process manager, reverse proxy, monitoring, recorder, and evidence index:

| Purpose | Stable name |
|---|---|
| Bench directory basename | `frappeverse-demo-v16` |
| Primary site | `frappeverse-demo.local` |
| Restore-only site | `frappeverse-restore.local` |
| Web | `frappeverse-demo-web` |
| Socket.IO | `frappeverse-demo-socketio` |
| Workers | `frappeverse-demo-workers` |
| Scheduler | `frappeverse-demo-scheduler` |
| Muster gateway | `frappeverse-demo-muster-gateway` |

The default isolated port block is web `8200`, Socket.IO `9200`, Redis cache/queue/socketio `13200`–`13202`, and Muster gateway `7200`. Review it against `ss -ltn` on Frappe-2. A new bench refuses any occupied or duplicate port. Reruns converge the same Bench global configuration and regenerate Redis/Procfile configuration.

The script writes these logical names to `services.env`. Process-manager units are created in a separately reviewed operations step because `bench setup production` invokes privileged host changes and must not be hidden inside an application provisioning script.

## 1. Prepare immutable inputs

1. On Frappe-2, create a dedicated OS user and an empty parent directory owned by that user. Do not reuse an existing Bench directory.
2. Copy `scripts/frappeverse-demo-apps.lock.example.tsv` to an operations-owned path outside the repository. Review each bootstrap branch; it is used only for the initial Bench clone.
3. Replace every placeholder with the reviewed 40-character commit. The script detaches each checkout at that commit and then rebuilds requirements. Confirm Frappe and ERPNext are v16-compatible at those commits. Confirm CRM and Helpdesk are major v1 because the current Muster SPA adapters fail closed for other majors.
4. Confirm the Muster row points at the dedicated installable Frappe app repository—not this monorepo unless that repository exposes the Frappe app at its root.
5. Review every repository origin before provisioning. The script refuses origin drift on reruns.
6. Allocate stable DNS/TLS origins, for example `https://frappeverse-demo.company.example` and `https://muster-demo.company.example`. Final recording rejects Cloudflare Quick Tunnels, ngrok, localtunnel, localhost, loopback, and `.example.invalid`.

The required app lock includes Muster, ERPNext, HRMS, CRM, Helpdesk, Payments, Insights, Builder, Drive, and LMS. A missing or incompatible daily-use app is a release blocker; do not silently remove its row.

## 2. Secrets

`bench new-site` is intentionally interactive. Enter the MariaDB root password and Administrator password only at Bench's hidden prompts. Never add `--db-root-password` or `--admin-password` to a command, shell history, recording script, or CI log.

Optional demo-user passwords use a JSON file on Frappe-2:

Generate that file on an operator-owned machine without printing any password:

```bash
scripts/frappeverse-generate-demo-user-passwords.sh /absolute/private/demo-users.json
```

```json
{
  "demo.owner@frappeverse.invalid": "GENERATE-A-UNIQUE-16+-CHARACTER-PASSWORD",
  "demo.sales@frappeverse.invalid": "GENERATE-A-DIFFERENT-16+-CHARACTER-PASSWORD"
}
```

Set mode `0600`, keep it outside the repository and artifact directory, and destroy it through the approved secrets process after credentials are transferred. The script passes only its path to the seeder; password contents are never command arguments or result JSON.

## 3. Read-only plan and inspection

Export configuration in a fresh shell. The first invocation is read-only:

```console
export BENCH_DIR=/srv/frappe/frappeverse-demo-v16
export SITE_NAME=frappeverse-demo.local
export RESTORE_SITE=frappeverse-restore.local
export APPS_LOCK_FILE=/srv/frappe/locks/frappeverse-demo-apps.lock.tsv
export ARTIFACT_DIR=/srv/frappe/evidence/frappeverse-demo-provision
export FRAPPE_REF=<PINNED_FRAPPE_V16_40_CHAR_SHA>
export FRAPPE_BRANCH=version-16
export PUBLIC_ORIGIN=https://frappeverse-demo.company.example
export MUSTER_PUBLIC_ORIGIN=https://muster-demo.company.example
export SERVICE_PREFIX=frappeverse-demo
export WEB_PORT=8200 SOCKETIO_PORT=9200
export REDIS_CACHE_PORT=13200 REDIS_QUEUE_PORT=13201 REDIS_SOCKETIO_PORT=13202
export MUSTER_GATEWAY_PORT=7200
export RECORDING_MODE=rehearsal
bash scripts/frappeverse-demo-provision.sh plan
```

The inspection reports the bench/site presence, installed apps, repository origins and revisions, and relevant running processes. Resolve collisions before any mutation.

## 4. Provision, then seed clean inputs

Run each stage separately so failures have a clear boundary:

```console
bash scripts/frappeverse-demo-provision.sh provision
export SEED_PASSWORD_FILE=/srv/frappe/secrets/frappeverse-demo-users.json
bash scripts/frappeverse-demo-provision.sh seed
bash scripts/frappeverse-demo-provision.sh verify
```

Provisioning uses `bench init`, interactive `bench new-site --db-type mariadb`, `bench get-app`, `bench --site install-app`, `bench --site migrate`, and `bench build --production`. Reruns inspect and converge rather than creating another bench, site, app clone, or record.

The baseline seeder creates six named users with only roles that exist in the pinned build, one company, 24 customers, 8 suppliers, 40 stock items, 12 ERPNext leads, and 5 employees. Stable natural keys make reruns idempotent. It takes Muster outcome counts before and after and rolls back if any Mission, Run, Work Unit, Activity, Approval, Evidence, Proposal, Change Set, or Development Proposal was created. CRM records, Helpdesk tickets, workflows, reports, custom fields, property setters, pages, print formats, and AI outcomes must be created live during the demonstration.

Inspect `baseline-seed.json`; it contains names/counts but no passwords. Before recording, independently confirm the Muster outcome counts are zero on this new site.

## 5. Services and stable origin

Use the reviewed host automation to create units matching `services.env`. Configure the reverse proxy and TLS before recording. The Frappe site `host_name` is set to the stable public origin. Configure the Muster gateway's reciprocal origin through its secret manager, not site config or the repository.

The infrastructure handoff consists of `services.env`, the pinned app lock, Frappe SHA, DNS records, certificate identifiers, upstream port mapping, health-check paths, and the protected backup location. It contains no bearer tokens, database passwords, user passwords, or private keys.

Only after services are installed, verify:

- all named units are running under the dedicated OS user;
- the site and gateway certificates validate from the recording machine;
- WebSocket upgrade works at the stable origin;
- background workers and scheduler are healthy;
- the site redirects do not expose an internal host or port;
- CRM and Helpdesk load Muster-owned web assets from `/assets/muster/`.

## 6. Backup and restore proof

Create a pre-recording backup:

```console
bash scripts/frappeverse-demo-provision.sh backup
```

Copy the database, public files, private files, app lock, repository-SHA report, and `services.env` to the protected backup location. Record their SHA-256 checksums outside the bench.

Restore only into the reserved restore site—never over the primary site:

```console
export RESTORE_SQL=/absolute/protected/path/database.sql.gz
export RESTORE_PUBLIC_FILES=/absolute/protected/path/public-files.tar
export RESTORE_PRIVATE_FILES=/absolute/protected/path/private-files.tar
export ALLOW_RESTORE_REHEARSAL=YES
bash scripts/frappeverse-demo-provision.sh restore-rehearsal
```

On the first run, Bench securely prompts while creating the isolated restore site, then restores and migrates it. A rerun verifies the existing restore site without overwriting it. Compare `restore-apps.txt` and `restore-outcome-counts.json` with the primary evidence. Destruction of the restore site is a separate, explicitly approved operation and is not automated here.

## 7. Rollback boundary

Before any later app revision change, take another backup and capture every app SHA. If installation, migration, or verification fails:

1. Stop only the named Frappeverse demo services.
2. Preserve logs and the failed database; do not mutate the customer or development benches.
3. Point the reverse proxy at the last verified demo deployment or maintenance response.
4. Restore the last verified backup to a new isolated recovery site and check app SHAs and migrations.
5. Promote recovery only after the same verification and RBAC gates pass.

The provisioning script intentionally contains no `drop-site`, recursive deletion, database drop, forced reset, or automatic primary-site restore.

## 8. Final recording gate

Set `RECORDING_MODE=final` and rerun `plan`, `verify`, and `backup`. Final mode requires immutable Frappe/app commits and stable non-tunnel origins. Begin recording only when the clean baseline evidence, login matrix, service health, backup checksums, and restore rehearsal are present. Keep secrets out of the terminal scrollback and browser autofill overlays.
