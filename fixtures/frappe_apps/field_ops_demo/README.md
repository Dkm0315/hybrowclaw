# Field Ops Demo

Minimal independent Frappe v16 Vue application used to prove that a custom SPA can be
integrated by site configuration alone. The application owns a normal `Service Visit`
DocType and its native Create/Save controls. It deliberately contains no Muster imports,
hooks, selectors, API calls, or runtime awareness.

Build the frontend with `pnpm install --frozen-lockfile` after generating a lockfile for the
pinned package versions, then `pnpm build`. Install the Frappe app through Bench and configure
the adapter separately in the Muster site's `muster_spa_surfaces` setting.
