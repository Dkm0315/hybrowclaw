(() => {
  const registry = window.musterSurfaceAdapters;
  if (!registry?.registerSupported || !/^\/helpdesk(?:\/|$)/.test(window.location.pathname)) return;
  if (!window.document?.querySelector?.("#app, [data-v-app]")) return;
  const base = "/helpdesk";
  registry.registerSupported("helpdesk", {
    schemaVersion: 1,
    id: "muster-frappe-helpdesk",
    label: "Frappe Helpdesk",
    priority: 80,
    base,
    pathPrefixes: [`${base}/`],
    doctypes: ["HD Ticket"],
    // Ticket creation has an explicit Submit boundary. Helpdesk v1 record
    // fields commit on blur, so update is intentionally not advertised as a
    // pause-before-Save workflow until a separately confirmable host control exists.
    operations: ["create"],
    capabilities: {navigate: true, fill: true, pauseBeforeSave: true, save: "separate_confirmation"},
    rootMarkers: ["#app", "[data-v-app]"],
    routes: {
      "HD Ticket": {
        create: "/tickets/new",
        record: "/tickets/{name}",
        commitButtons: {create: ["Submit"]},
        fieldBindings: {
          subject: {kind: "text", labels: ["Subject", "A short description"]},
          description: {kind: "contenteditable", labels: ["Description", "Detailed explanation"], unique: true},
        },
        fieldHints: {
          subject: ["Subject", "A short description"],
          description: ["Description", "Detailed explanation"],
        },
      },
    },
  }).catch(() => {});
})();
