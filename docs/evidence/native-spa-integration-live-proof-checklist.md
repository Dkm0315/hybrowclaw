# Native SPA integration: installation and live-proof checklist

This checklist proves that Muster operates Frappe-native Vue/React surfaces without editing or forking CRM, Helpdesk, or the customer application. A passing unit test is not live proof; record every applicable step in one continuous browser capture.

## Supported contract

- CRM 1.78.x: Ask and attended create are enabled by the Muster-owned CRM adapter. Record fields save on blur, so attended update is deliberately disabled until CRM exposes a separately confirmable boundary.
- Helpdesk 1.27.x: Ask and attended ticket creation are enabled. Ticket creation has a native **Submit** boundary. Record-field updates are intentionally disabled because this Helpdesk line commits several fields on blur; claiming a separate pause-before-Save boundary would be false.
- Custom Vue/React app: Ask plus attended create/update are enabled only after an administrator adds a bounded `muster_spa_surfaces` manifest to the site's `site_config.json`. The manifest lives in site configuration, not in the target app.
- An unknown route, ambiguous manifest, missing app, wrong major version, absent SPA root, unsupported DocType/operation, missing control, or malformed server receipt must show the safe unavailable message and make no change.

The custom manifest accepts no JavaScript, callbacks, expressions, or CSS selectors. It declares an installed app, one supported major, same-origin route templates, DocTypes, operations, one of four standard SPA root markers, native Create-button labels, and semantic field labels/placeholders.

Example (replace these values with the audited custom app):

```json
{
  "muster_spa_surfaces": [
    {
      "id": "field-ops",
      "label": "Field Operations",
      "app": "field_ops",
      "supported_major": 1,
      "base": "/operations",
      "path_prefixes": ["/operations/"],
      "root_markers": ["[data-reactroot]"],
      "doctypes": ["Service Visit"],
      "operations": ["create", "update"],
      "routes": {
        "Service Visit": {
          "create": "/visits/new",
          "record": "/visits/{name}",
          "create_buttons": ["Create"],
          "commit_buttons": {"create": ["Create"], "update": ["Save"]},
          "field_hints": {
            "customer": ["Customer", "Choose customer"],
            "scheduled_on": ["Scheduled on"]
          }
        }
      }
    }
  ]
}
```

## Install and inspect

1. Pin Frappe, Muster, CRM, Helpdesk, and the custom app commits. Capture `bench version` and `bench --site <site> list-apps` in the terminal.
2. Capture clean `git status --short` for CRM, Helpdesk, and the custom app before and after the proof. The output must show no Muster integration edits.
3. Configure the custom manifest through `bench --site <site> set-config --parse muster_spa_surfaces '<reviewed-json>'`; rebuild only Muster assets, migrate, clear cache, and restart through the normal production supervisor.
4. In browser DevTools, show `/assets/muster/js/surface_adapters.js` and `/assets/muster/js/spa_assistant.js` on the native HTML document. Show that both are same-origin and that no browser extension is required.
5. Inspect the authenticated bootstrap response. It may expose only the requested support decision, bounded descriptor, installed version, and CSRF token. It must not expose the installed-app catalog or backend errors.
6. Before recording Helpdesk, prove `/helpdesk` and `/helpdesk/tickets` return the real Vue shell with `#app` or `[data-v-app]`. A Frappe Not Found page is a failed/partial installation: Ask must remain absent, and the final MariaDB demo site must be repaired before proof.

## Continuous live evidence

For each supported surface, keep the URL bar, Ask Muster prompt, native app chrome, labeled Muster cursor, and pause banner visible:

1. Ask a normal question about the current CRM/Helpdesk/custom-app page. Confirm the answer remains in the native surface and contains no stack, method path, selector, token, or raw JSON.
2. Give a partial create prompt. Capture Muster's targeted clarification and prove no record/proposal was created.
3. Give a complete create prompt. Accept the attended handoff. Capture native navigation, native Create control where present, every visible cursor move, field-by-field typing, and the green pause-before-Save banner. Verify in a second read-only session that the record does not exist.
4. Separately authorize Save using the product's governed Save flow. Capture the native record and audit evidence.
5. For CRM, attempt an update and capture the safe unsupported result with a server reread proving zero mutation. For the configured custom app, repeat with an existing record and a revision-bound update; pause before Save, mutate the same record in a second session, then prove the stale preview refuses to proceed.
6. In Helpdesk, attempt an update. Capture the safe unsupported response and prove the record is unchanged; do not portray inline blur-save as pause-before-Save.
7. Change each app to an unsupported major (or use a controlled bootstrap fixture), reload, and capture Ask/attended work failing closed without falling back to Desk or hidden REST.
8. Repeat create allow/deny with an authorized agent and a restricted user. Capture both the visible UI outcome and an independent read-only database/API check.
9. Repeat the supported create on a mobile viewport. The cursor label and pause state must remain visible without covering the native Submit/Save control.

## Release gates

- Unit suites pass: `node --test frappe_app/tests_js/surface_adapters.test.cjs frappe_app/tests_js/spa_assistant.test.cjs` and the Frappe `test_surface_api`/`test_spa_shell` modules.
- No target-app source changed; no Desk fallback claimed as native SPA work; no silent REST mutation occurred.
- Every allow clip has a paired deny clip, an unsaved-state check, and a final audit reference.
- Any selector drift, route drift, ambiguous configuration, or version mismatch blocks release instead of broadening heuristics.
