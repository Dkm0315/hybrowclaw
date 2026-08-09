# Helpdesk and untouched custom-SPA live proof

This runbook is a recording contract, not a claim that the clips already exist. Use the
dedicated Frappe-2 v16 site only after the deployment owner approves the install window.
Do not edit or fork CRM, Helpdesk, or Field Ops Demo. All integration configuration and
runtime assets belong to Muster.

## Discovered Frappe-2 state (read-only, 2026-07-20)

- Bench: `/home/goblin/personal/muster-frappe-bench`; site: `muster.local`.
- Installed: Frappe 16.27.1, ERPNext 16.9.1, HRMS 16.4.3, CRM 1.78.2,
  Helpdesk 1.27.0, Muster 0.1.0.
- Helpdesk worktree was clean. CRM had three pre-existing generated/lock changes; do not
  attribute those to this integration and do not reset them.
- `muster_spa_surfaces` was absent.
- Ports 8000 and 8001 belonged to different v15 benches and are not evidence for
  `muster.local`. A later full process audit found the v16 bench's development web command
  on port 8004. The deployment owner is moving that service behind a loopback proxy on 8005
  with Socket.IO on 9004; re-discover and capture the final PID, working directory, listeners,
  and proxy target after that change instead of relying on this transient snapshot.
- Direct requests to the v16 web process for `/helpdesk`, `/helpdesk/tickets`, and
  `/helpdesk/tickets/new` returned Frappe 404. The installed Helpdesk source contains the
  correct route rule, but `apps/helpdesk/helpdesk/public` contained only `.gitkeep`; its Vue
  HTML/assets had not been built. Helpdesk is therefore a partial installation and is not
  recordable until the deployment owner runs the app-prescribed frontend build, Bench asset
  build/cache cycle, and proves a real `#app`/`[data-v-app]` shell on the final proxy.
- After the loopback proxy transition, `/api/method/ping` on 8004 returned 200, while
  `/helpdesk` still returned the cached 404 and one `/helpdesk/tickets/new` probe returned
  502. Treat API health and Helpdesk SPA health as separate gates. The pinned Helpdesk
  package's prescribed frontend command is `yarn build` from `apps/helpdesk`.

## Independent reference app

The source is `fixtures/frappe_apps/field_ops_demo`. It is a minimal Frappe v16 app with a
Vue 3 SPA, a normal `Service Visit` DocType, same-origin Frappe resource calls, and explicit
native Create and Save buttons. Its runtime source contains no Muster import, hook, asset,
selector, marker, or API call. Built assets and pinned dependency lockfile are included.

After approval, publish or stage that directory as an independent Git checkout on Frappe-2.
From the exact v16 bench, the deployment owner runs:

```sh
cd /home/goblin/personal/muster-frappe-bench
bench get-app --branch <PINNED_BRANCH> <PINNED_FIELD_OPS_GIT_URL>
bench --site muster.local install-app field_ops_demo
bench --site muster.local migrate
bench build --app field_ops_demo
bench --site muster.local clear-cache
```

Do not use `--overwrite`, an unpinned branch, or a copied app from a v15 bench. Capture
`bench version`, `bench --site muster.local list-apps`, and clean `git status --short` from
both `apps/helpdesk` and `apps/field_ops_demo` before configuration.

Configure only the Muster-owned manifest. The value is the complete JSON array in
`frappe_app/muster/demo/fixtures/field_ops_spa_manifest.json`:

```sh
cd /home/goblin/personal/muster-frappe-bench
bench --site muster.local set-config --parse muster_spa_surfaces '<REVIEWED_JSON_ARRAY>'
bench --site muster.local clear-cache
```

Assign a reviewed, unused web and Socket.IO port before starting the bench. Prove the PID's
working directory is this exact bench. Do not point the public origin at the older v15
processes.

## Helpdesk scenario HD-NATIVE-01

Preconditions: Helpdesk reports exactly 1.27.x, `/helpdesk/tickets/new` returns the real Vue
shell, and an authorized Helpdesk agent plus a read-only verifier are logged in separately.

1. Start one continuous 1440×900 normal-speed recording with URL bar and user identity.
2. Show clean Helpdesk worktree and pinned revision in terminal, then return to the browser.
3. Open `/helpdesk/tickets`; confirm Ask Muster appears inside the untouched Helpdesk UI.
4. Ask `How many tickets can I see here and which one needs attention first?`; reject the
   take if raw JSON, a method path, token, selector, or traceback appears.
5. Ask `Create a ticket for the printer problem`. Muster must ask only for the missing
   actionable details and must not create a proposal or ticket yet. Verify absence in the
   read-only session.
6. Reply `Subject: Warehouse label printer offline. Description: Printer stopped after the
   14:00 label run; route to the support queue.`
7. Capture automatic navigation to `/helpdesk/tickets/new`, the visible cursor labeled
   `Muster has taken over`, Subject typing, Description typing in the native editor, and the
   green pause before native **Submit**. The verifier must still find no ticket.
8. Click the separate chat **Confirm Submit** action once. Capture the native Submit click,
   `/helpdesk/tickets/<name>`, and the Muster verified result. The verifier rereads the exact
   Subject and Description and records the audit proposal and proof hash.
9. Ask to update that ticket. The operation must fail before focusing or typing into any
   field because Helpdesk 1.27 record fields save on blur. Reread `modified`, Subject, and
   Description to prove zero mutation.
10. Repeat steps 3–8 at 390×844. The cursor label, pause banner, Submit, and Ask controls must
    remain visible and tappable without horizontal overflow.

Reject the release if TipTap does not retain the Description after native Submit. That means
the contenteditable semantic binding has drifted; do not broaden selectors to make it pass.

## Custom Vue scenario SPA-NATIVE-01

Preconditions: `field_ops_demo` 1.x is installed on `muster.local`, the reviewed manifest is
present, and `apps/field_ops_demo` remains clean with zero `muster` matches in runtime source.

1. Record `/operations/visits` at 1440×900. Show the Vue workspace and Ask Muster together.
2. Ask `What visits are planned and what can I do on this page?` and verify a safe in-surface
   answer.
3. Ask `Create a service visit for North Warehouse`. Muster must clarify the missing date;
   no proposal or `Service Visit` may exist.
4. Reply `Schedule it for 2026-08-03, status Planned, notes Bring a spare print head.`
5. Capture route navigation to `/operations/visits/new`, every labeled cursor move, semantic
   field entry, and the pause before the app's native **Create** button. Independently prove
   the disposable customer/date combination is absent.
6. Use the separate chat confirmation. Capture the one native Create click, record route,
   independent reread, audit proposal, and proof hash.
7. Ask to update that exact visit to `In Progress`. Capture the revision-bound form and pause
   before native **Save**. In the verifier session change Notes, then attempt confirmation.
   Preflight must reject the stale revision before clicking Save; the verifier's Notes value
   must remain authoritative.
8. Prepare a fresh update and confirm it once. Capture native Save and independent reread.
9. Repeat create and stale-update cases at 390×844 with the cursor label inside the viewport.

## Negative gates

- Change the controlled bootstrap fixture to Helpdesk 1.21.0: Ask and attended work must not
  load; no Desk fallback is allowed.
- Change Field Ops Demo to 2.0.0 while the manifest supports major 1: bootstrap must return
  unsupported without exposing the version or installed-app catalog.
- Try `/operations-evil/visits`, `/other/operations/visits`, traversal, a missing Vue root,
  duplicate manifests, and a bench-only app not installed on the site. All must fail closed
  and leave the host response and records unchanged.
- Finish by showing unchanged Helpdesk and Field Ops Demo worktrees. Only Muster and site
  configuration may contain integration changes.
