# Frappeverse customization and coding ladder evidence

This is the deterministic recording contract for deep native customization, PRD/SOP work, and beginner-to-advanced registered-app coding. It does not count fixtures or tests as live proof.

## Preflight and setup

Run against the separately provisioned Frappeverse bench only after its app lock and backup gate pass:

```console
cd /absolute/path/to/frappeverse-demo-v16
bench --site frappeverse-demo.local migrate
bench build --app muster
bench --site frappeverse-demo.local clear-cache
bench --site frappeverse-demo.local list-apps
```

The installed app list must include `frappe`, `erpnext`, `hrms`, `crm`, `helpdesk`, and `muster`. In Muster Development App, register only the disposable custom app's absolute clean Git root and the exact path patterns in `frappeverse_coding_ladder_scenario.json`. Never register the ERPNext, CRM, or Helpdesk repositories for this take. Configure requester and different reviewer users through normal Muster bindings and Frappe roles.

Validate the complete offline contract before opening the recorder:

```console
cd /absolute/path/to/muster
node scripts/evidence/frappe-customization-ladder.mjs
PYTHONPATH=frappe_app python3 -m unittest \
  frappe_app/muster/tests/test_native_artifact_builders.py \
  frappe_app/muster/tests/test_development_security.py \
  frappe_app/muster/tests/test_source_ingestion.py
node --test \
  scripts/test/native-customization-session.test.mjs \
  scripts/evidence/test/frappe-customization-ladder.test.mjs
```

On the demo bench, run the Frappe integration checks after migration:

```console
cd /absolute/path/to/frappeverse-demo-v16
bench --site frappeverse-demo.local run-tests --app muster --module muster.tests.test_native_builder_api_frappe
```

## Continuous live take

Start in Ask Muster. Upload `frappeverse_service_intake_prd.md`; do not pre-create outcomes. Ask in ordinary language to implement the attached PRD. Show R001-R010, with R010 retained as evidence but rejected as authority. For each of Custom Field, Property Setter, custom DocType, Query Report, trusted Script Report, Print Format, Page, and Web Page, record one uninterrupted sequence: Ask result, source-bound Change Set, real native form with “Muster has taken over”, every populated control, unsaved pause, different-user approval, apply, saved native route, independent reread, destructive review, and verified rollback. Run the report/print/page outputs, not just their metadata forms.

Then upload `frappeverse_coding_ladder_prd.md` and run the three levels as separate Development Proposals. Record the clean revision and allowlist hash; show generation happening in an isolated export while the user continues working; review the unified patch and private artifact hash; prove the registered source is unchanged before Apply; apply without deploying; independently compare the Git diff to the reviewed patch. On one disposable proposal, edit a changed file after Apply and show exact rollback refuse the drift. Restore the exact applied content, request rollback as one administrator, approve it as a different administrator, then execute and show the repository return to clean status.

The current product deliberately blocks `migrate`, `build_app`, and `restart` until a site-specific administrator-reviewed command registry and rollback target exist. Capture that denial as the negative deployment case; it is not evidence of deployment. A final talk recording that claims deployed advanced code must wait for that registry and a separately verified deployment/restore implementation.

## Release evidence

Attach the continuous desktop and mobile clips, screenshots, browser traces, terminal transcript, source/patch hashes, independent reread receipts, and Git before/apply/rollback status to the video evidence manifest. Machine checks prove the contract and fail-closed boundaries; only the actual labelled browser/terminal footage proves human-visible navigation and execution.
