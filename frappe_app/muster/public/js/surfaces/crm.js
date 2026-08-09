(() => {
  const registry = window.musterSurfaceAdapters;
  if (!registry?.registerSupported || !/^\/crm(?:\/|$)/.test(window.location.pathname)) return;
  if (!window.document?.querySelector?.("#app, [data-v-app]")) return;
  registry.registerSupported("crm", {
    schemaVersion: 1,
    id: "muster-frappe-crm",
    label: "Frappe CRM",
    priority: 80,
    base: "/crm",
    pathPrefixes: ["/crm/"],
    doctypes: ["CRM Lead", "CRM Deal", "Contact", "CRM Organization"],
    // CRM 1.78 record fields commit on blur. Only creation has a truthful,
    // separately confirmable native Create boundary; attended update must
    // fail before touching any field.
    operations: ["create"],
    capabilities: {navigate: true, fill: true, pauseBeforeSave: true, save: "separate_confirmation"},
    rootMarkers: ["#app", "[data-v-app]"],
    routes: {
      "CRM Lead": {
        create: "/leads/view/list",
        record: "/leads/{name}",
        createButtons: ["Create", "New Lead", "Create Lead"],
        commitButtons: {create: ["Create"]},
        fieldBindings: {
          first_name: {kind: "text", labels: ["First Name", "Full Name"]},
          status: {
            kind: "button_select",
            labels: ["Status"],
            options: ["Contacted", "Converted", "Junk", "New", "Nurture", "Qualified", "Unqualified"],
          },
        },
      },
      "CRM Deal": {create: "/deals", record: "/deals/{name}", createButtons: ["New Deal", "Create Deal"], commitButtons: {create: ["Create"]}},
      "Contact": {create: "/contacts", record: "/contacts/{name}", createButtons: ["New Contact", "Create Contact"], commitButtons: {create: ["Create"]}},
      "CRM Organization": {create: "/organizations", record: "/organizations/{name}", createButtons: ["New Organization", "Create Organization"], commitButtons: {create: ["Create"]}},
    },
  }).catch(() => {});
})();
