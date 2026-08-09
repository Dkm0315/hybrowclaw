const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../muster/public/js/surface_adapters.js"), "utf8");
const crmSource = fs.readFileSync(path.join(__dirname, "../muster/public/js/surfaces/crm.js"), "utf8");
const helpdeskSource = fs.readFileSync(path.join(__dirname, "../muster/public/js/surfaces/helpdesk.js"), "utf8");
const hooksSource = fs.readFileSync(path.join(__dirname, "../muster/hooks.py"), "utf8");

function load(pathname = "/desk/muster-control", {
  supportedRoot = false, supportedVersion = true, customDescriptor = null,
  customVersion = "1.4.0", customSupported = true, resumeIssue = null,
} = {}) {
  const listeners = new Map();
  const deskStarts = [];
  const navigations = [];
  const replacements = [];
  const apiCalls = [];
  const window = {
    location: {pathname, search: "", hash: "", assign(url) { navigations.push(url); }},
    history: {replaceState(_state, _title, url) { replacements.push(url); window.location.hash = ""; }},
    frappe: undefined,
    async fetch(url, options = {}) {
      const parsed = new URL(url, "https://erp.example.test");
      if (parsed.pathname.endsWith("muster.api.attended_resume.issue")) return {
        ok: true,
        async json() {
          const args = Object.fromEntries(new URLSearchParams(options.body || ""));
          apiCalls.push({method: "issue", args});
          return {message: resumeIssue || {schema_version: 1, proposal: args.proposal, navigate_required: false}};
        },
      };
      if (parsed.pathname.endsWith("muster.api.attended_resume.consume")) return {
        ok: true,
        async json() {
          const args = Object.fromEntries(new URLSearchParams(options.body || ""));
          apiCalls.push({method: "consume", args});
          return {message: receipt()};
        },
      };
      const surface = parsed.searchParams.get("surface");
      const route = parsed.searchParams.get("route");
      return {
        ok: true,
        async json() {
          if (route) return {message: customDescriptor ? {
            schema_version: 1, adapter_contract: 1, surface: "custom", supported: customSupported,
            installed_version: customVersion, descriptor: customDescriptor,
          } : {schema_version: 1, adapter_contract: 1, surface: null, supported: false}};
          return {message: {
            schema_version: 1, adapter_contract: 1, surface,
            supported: supportedVersion,
            ...(supportedVersion ? {installed_version: surface === "crm" ? "1.78.2" : "1.27.0"} : {}),
            csrf_token: "csrf-test",
          }};
        },
      };
    },
    musterAttendedPreview: {
      async start(receipt) { deskStarts.push(receipt); },
      async startDelete(receipt) { deskStarts.push(receipt); },
    },
    addEventListener(name, callback) {
      const rows = listeners.get(name) || [];
      rows.push(callback);
      listeners.set(name, rows);
    },
    dispatchEvent(event) {
      (listeners.get(event.type) || []).forEach((callback) => callback(event));
      return true;
    },
  };
  if (/^\/(?:desk|app)(?:\/|$)/.test(pathname)) {
    window.frappe = {
      async call(options) {
        apiCalls.push({method: options.method.endsWith(".consume") ? "consume" : "issue", args: options.args});
        if (options.method.endsWith(".consume")) return {message: receipt()};
        return {message: resumeIssue || {schema_version: 1, proposal: options.args.proposal, navigate_required: false}};
      },
    };
  }
  let context;
  window.document = {
    createElement() { return {dataset: {}}; },
    querySelector(selector) { return supportedRoot && selector.includes("#app") ? {id: "app"} : null; },
    querySelectorAll() { return []; },
    head: {appendChild(script) {
      const moduleSource = script.src.includes("helpdesk.js") ? helpdeskSource : crmSource;
      vm.runInContext(moduleSource, context);
      script.onload?.();
    }},
  };
  class CustomEvent {
    constructor(type, options) { this.type = type; this.detail = options?.detail; }
  }
  context = vm.createContext({window, CustomEvent, Event: class {}, PopStateEvent: class {}, console, Date, Promise, URLSearchParams, encodeURIComponent});
  vm.runInContext(source, context);
  return {registry: window.musterSurfaceAdapters, window, deskStarts, navigations, replacements, apiCalls};
}

function receipt(overrides = {}) {
  return {
    proposal: "MST-WFP-1", objective: "Create the reviewed customer",
    operation: "create", doctype: "Customer", record_name: null,
    executed: false, save_requires_confirmation: true, save_authorized: false,
    fields: [{fieldname: "customer_name", label: "Customer Name", control: "fill", value: "Acme"}],
    ...overrides,
  };
}

function adapter(id, prefix, starts, overrides = {}) {
  return {
    schemaVersion: 1,
    id,
    label: id,
    priority: 50,
    pathPrefixes: [prefix],
    doctypes: ["*"],
    operations: ["create", "update"],
    capabilities: {navigate: true, fill: true, pauseBeforeSave: true, save: "separate_confirmation"},
    async start(value, context) { starts.push({value, context}); },
    ...overrides,
  };
}

test("ERPNext, HRMS and normal Frappe Desk use only the path-bound Desk adapter", async () => {
  const {registry, deskStarts} = load("/desk/hr/employee");
  const result = await registry.start(receipt({doctype: "Employee"}));
  assert.equal(result.adapter, "frappe-desk");
  assert.equal(result.opened, true);
  assert.equal(result.saved, false);
  assert.equal(deskStarts.length, 1);
  assert.equal(registry.context().family, "desk");
});

test("Desk attended previews preserve validated child-table rows", async () => {
  const items = {
    fieldname: "items", label: "Items", control: "table", child_doctype: "Purchase Order Item",
    rows: [[
      {fieldname: "item_code", label: "Item Code", control: "fill", value: "MFD-ITEM-001"},
      {fieldname: "qty", label: "Quantity", control: "fill", value: "2"},
    ]],
  };
  const {registry, deskStarts} = load("/desk/muster-control");
  const result = await registry.start(receipt({doctype: "Purchase Order", fields: [items]}));
  assert.equal(result.adapter, "frappe-desk");
  assert.equal(result.saved, false);
  assert.equal(deskStarts.length, 1);
  assert.equal(deskStarts[0].fields[0].control, "table");
  assert.equal(deskStarts[0].fields[0].child_doctype, "Purchase Order Item");
  assert.equal(deskStarts[0].fields[0].rows[0][1].value, "2");
});

test("Desk attended previews reject malformed child-table rows", async () => {
  const {registry, deskStarts} = load("/desk/muster-control");
  await assert.rejects(registry.start(receipt({
    doctype: "Purchase Order",
    fields: [{
      fieldname: "items", label: "Items", control: "table", child_doctype: "Purchase Order Item",
      rows: [[
        {fieldname: "item_code", label: "Item Code", control: "fill", value: "MFD-ITEM-001"},
        {fieldname: "item_code", label: "Item Code", control: "fill", value: "duplicate"},
      ]],
    }],
  })), {name: "MusterSurfaceUnavailableError"});
  assert.equal(deskStarts.length, 0);
});

test("Muster automatically loads CRM and Helpdesk adapters without target-app registration", async () => {
  for (const [pathname, family, id, prefix, doctype] of [
    ["/crm/leads/view/LEAD-1", "crm", "muster-frappe-crm", "/crm/", "CRM Lead"],
    ["/helpdesk/tickets/HD-TICKET-1", "helpdesk", "muster-frappe-helpdesk", "/helpdesk/", "HD Ticket"],
  ]) {
    const {registry, deskStarts} = load(pathname, {supportedRoot: true});
    await registry.loadKnownSurface();
    const loaded = registry.capabilities().find((entry) => entry.id === id);
    assert.ok(loaded);
    assert.deepEqual(Array.from(loaded.pathPrefixes), [prefix]);
    assert.ok(Array.from(loaded.doctypes).includes(doctype));
    assert.equal(registry.context().family, family);
    assert.equal(deskStarts.length, 0, "SPA work must not fall through to Desk globals");
  }
});

test("a server-issued cross-surface ticket navigates without exposing proposal data in the URL", async () => {
  const ticket = "t".repeat(64);
  const resumeIssue = {
    schema_version: 1, proposal: "MST-WFP-1", navigate_required: true,
    target_surface: "crm", target_route: "/crm/leads/view/list",
    url: `/crm/leads/view/list#muster-attended-resume=${ticket}`,
  };
  const {registry, navigations, deskStarts} = load("/desk/muster-control", {resumeIssue});
  const result = await registry.start(receipt({doctype: "CRM Lead"}));
  assert.equal(result.navigated, true);
  assert.equal(result.opened, false);
  assert.deepEqual(navigations, [resumeIssue.url]);
  assert.equal(deskStarts.length, 0);
  assert.doesNotMatch(resumeIssue.url, /MST-WFP|CRM Lead|first_name/);
});

test("destination consumes and strips one opaque resume fragment before starting its local adapter", async () => {
  const ticket = "r".repeat(64);
  const {registry, window, replacements, apiCalls, deskStarts} = load("/desk", {supportedRoot: true});
  window.location.hash = `#muster-attended-resume=${ticket}`;
  assert.equal(await registry.resumeFromLocation(), true);
  assert.deepEqual(replacements, ["/desk"]);
  assert.equal(apiCalls.filter((row) => row.method === "consume").length, 1);
  assert.equal(apiCalls.find((row) => row.method === "consume").args.ticket, ticket);
  assert.equal(deskStarts.length, 1);
  assert.equal(deskStarts[0].proposal, "MST-WFP-1");
});

test("malformed cross-surface navigation receipts fail closed before location change", async () => {
  for (const resumeIssue of [
    {schema_version: 1, proposal: "MST-WFP-1", navigate_required: true, target_route: "/crm", url: "https://evil.test/crm#mi"},
    {schema_version: 1, proposal: "MST-WFP-1", navigate_required: true, target_route: "/crm", url: "/helpdesk#muster-attended-resume=" + "t".repeat(64)},
  ]) {
    const {registry, navigations} = load("/desk", {resumeIssue});
    await assert.rejects(registry.start(receipt()), {name: "MusterSurfaceUnavailableError"});
    assert.deepEqual(navigations, []);
  }
});

test("a Muster site manifest can enable a custom Vue or React SPA without target-app code", async () => {
  const descriptor = {
    schemaVersion: 1,
    id: "muster-config-operations",
    label: "Operations",
    priority: 60,
    base: "/operations",
    pathPrefixes: ["/operations/"],
    doctypes: ["Service Visit"],
    operations: ["create", "update"],
    capabilities: {navigate: true, fill: true, pauseBeforeSave: true, save: "separate_confirmation"},
    rootMarkers: ["[data-reactroot]"],
    routes: {
      "Service Visit": {
        create: "/visits/new", record: "/visits/{name}", createButtons: [],
        commitButtons: {create: ["Create"], update: ["Save"]},
        fieldHints: {customer: ["Customer", "Choose customer"]},
      },
    },
  };
  const {registry, deskStarts} = load("/operations/visits", {customDescriptor: descriptor});
  await registry.loadKnownSurface();
  const loaded = registry.capabilities().find((entry) => entry.id === descriptor.id);
  assert.ok(loaded);
  assert.deepEqual(Array.from(loaded.operations), ["create", "update"]);
  assert.equal(deskStarts.length, 0);
});

test("custom SPA adapter rejects incompatible routes, versions and support decisions", async () => {
  const descriptor = {
    schemaVersion: 1, id: "muster-config-field-ops-demo", label: "Field Operations Demo",
    priority: 60, base: "/operations", pathPrefixes: ["/operations/"],
    doctypes: ["Service Visit"], operations: ["create", "update"],
    capabilities: {navigate: true, fill: true, pauseBeforeSave: true, save: "separate_confirmation"},
    rootMarkers: ["[data-v-app]"], routes: {"Service Visit": {
      create: "/visits/new", record: "/visits/{name}", createButtons: [],
      commitButtons: {create: ["Create"], update: ["Save"]}, fieldHints: {customer: ["Customer"]},
    }},
  };
  for (const [pathname, options] of [
    ["/operations-evil/visits", {customDescriptor: descriptor}],
    ["/operations/visits", {customDescriptor: descriptor, customVersion: "not-a-version"}],
    ["/operations/visits", {customDescriptor: descriptor, customSupported: false}],
  ]) {
    const {registry, deskStarts} = load(pathname, options);
    await assert.rejects(registry.start(receipt({doctype: "Service Visit"})), {name: "MusterSurfaceUnavailableError"});
    assert.equal(deskStarts.length, 0);
  }
});

test("Helpdesk v1 does not overclaim inline auto-saving record updates", async () => {
  const {registry} = load("/helpdesk/tickets/HD-TICKET-1", {supportedRoot: true});
  await registry.loadKnownSurface();
  const loaded = registry.capabilities().find((entry) => entry.id === "muster-frappe-helpdesk");
  assert.deepEqual(Array.from(loaded.operations), ["create"]);
  await assert.rejects(registry.start(receipt({
    doctype: "HD Ticket", operation: "update", record_name: "HD-TICKET-1",
    record_revision: "2026-07-20 12:34:56.123456",
  })), {name: "MusterSurfaceUnavailableError"});
});

test("all adapter loading is Muster-owned and requires no CRM, Helpdesk, or customer-app source change", () => {
  assert.match(source, /\/assets\/muster\/js\/surfaces\/crm\.js/);
  assert.match(source, /\/assets\/muster\/js\/surfaces\/helpdesk\.js/);
  assert.match(hooksSource, /\/assets\/muster\/js\/surface_adapters\.js/);
  assert.doesNotMatch(hooksSource, /apps\/(?:crm|helpdesk|hrms)|frontend\/src|desk\/src/);
  assert.doesNotMatch(`${crmSource}\n${helpdeskSource}`, /import\s|require\s*\(|node_modules|apps\/(?:crm|helpdesk)/);
  assert.doesNotMatch(`${crmSource}\n${helpdeskSource}`, /frappe\.boot|window\.frappe/);
  assert.match(source, /muster\.api\.surface\.bootstrap\?surface=/);
});

test("unsupported CRM and Helpdesk versions load no adapter and fail closed", async () => {
  for (const pathname of ["/crm/leads", "/helpdesk/tickets"]) {
    const {registry, deskStarts} = load(pathname, {supportedRoot: true, supportedVersion: false});
    await assert.rejects(registry.start(receipt({doctype: pathname.startsWith("/crm") ? "CRM Lead" : "HD Ticket"})), {name: "MusterSurfaceUnavailableError"});
    assert.equal(registry.capabilities().some((entry) => entry.id.startsWith("muster-frappe-")), false);
    assert.equal(deskStarts.length, 0);
  }
});

test("a mismatched or malformed server support receipt cannot register an adapter", async () => {
  const {registry, window, deskStarts} = load("/crm/leads", {supportedRoot: true});
  window.fetch = async () => ({
    ok: true,
    async json() {
      return {message: {schema_version: 1, adapter_contract: 1, surface: "helpdesk", supported: true, installed_version: "1.27.0"}};
    },
  });
  await assert.rejects(registry.start(receipt({doctype: "CRM Lead"})), {name: "MusterSurfaceUnavailableError"});
  assert.equal(registry.capabilities().some((entry) => entry.id === "muster-frappe-crm"), false);
  assert.equal(deskStarts.length, 0);
});

test("CRM v1 adapter includes the current Leads Create control and visible attended takeover", () => {
  assert.match(crmSource, /createButtons:\s*\["Create",\s*"New Lead",\s*"Create Lead"\]/);
  assert.match(source, /Muster has taken over/);
  assert.match(source, /Muster paused · Review the form before \$\{commitLabel\}/);
  assert.match(source, /await guide\.point\(createControl, "Opening a new record"\)/);
  assert.match(source, /let createControl = receipt\.operation === "create"/);
  assert.match(source, /await fill\(control, field, guide, definition\.routes\?\.\[receipt\.doctype\]\)/);
  assert.match(source, /return \{opened: true, saved: false, confirmationLabel: `Confirm \$\{commitLabel\}`\}/);
  assert.match(source, /await guide\.point\(commit, `Pausing before \$\{commitLabel\}`\)/);
  assert.doesNotMatch(source, /pause\(commitLabel\)[\s\S]{0,160}cursor\.style\.display\s*=\s*"none"/);
});

test("the labeled SPA takeover stays inside desktop and mobile safe areas", () => {
  assert.match(source, /cursor\.dataset\.label = "Muster has taken over"/);
  assert.match(source, /content:attr\(data-label\)/);
  assert.match(source, /env\(safe-area-inset-top\)/);
  assert.match(source, /@media\(max-width:767px\)/);
  assert.match(source, /@media\(prefers-reduced-motion:reduce\)/);
  assert.match(source, /Math\.min\(width - Math\.min\(190, width - 16\)/);
  assert.match(source, /Math\.min\(height - 44/);
  assert.match(source, /cursor\.dataset\.label = "Muster paused for you"/);
});

test("Helpdesk create uses its native Submit boundary and editor semantics", () => {
  assert.match(helpdeskSource, /operations:\s*\["create"\]/);
  assert.match(helpdeskSource, /commitButtons:\s*\{create:\s*\["Submit"\]\}/);
  assert.match(helpdeskSource, /subject:\s*\{kind:\s*"text"/);
  assert.match(helpdeskSource, /description:\s*\{kind:\s*"contenteditable"[\s\S]*unique:\s*true/);
  assert.match(source, /binding\?\.kind === "contenteditable"/);
  assert.match(source, /getAttribute\?\.\("data-placeholder"\)/);
  assert.match(source, /uniqueVisible\("\[contenteditable='true'\]", \(\) => true, root\)/);
  assert.match(source, /range\.selectNodeContents\(control\)/);
  assert.match(source, /window\.document\.execCommand\("insertText", false/);
  assert.doesNotMatch(source, /control\.textContent = field\.value/);
  assert.match(source, /Confirming native \$\{commitLabel\}/);
  assert.doesNotMatch(source, /definition\.id !== "muster-frappe-crm"/);
  assert.match(source, /definition\.id === "muster-frappe-helpdesk" \? "helpdesk"/);
  assert.match(source, /\^Confirm \(\?:Create\|Submit\|Save\|Delete\)\$/);
});

test("configured SPA update confirmation is revision-bound before the native Save click", () => {
  assert.match(source, /record_name: receipt\.operation === "update" \? receipt\.record_name : ""/);
  assert.match(source, /record_revision: receipt\.operation === "update" \? receipt\.record_revision : ""/);
  assert.match(source, /preflight\.record_revision !== receipt\.record_revision/);
  assert.match(source, /commit\.click\(\);[\s\S]{0,180}receipt\.operation === "create"/);
  assert.match(source, /receipt\.operation === "update"\)[\s\S]{0,100}await sleep\(0\);[\s\S]{0,100}await waitFor\(\(\) => visible\(commit\), 15_000\)/);
});

test("CRM Lead uses validated semantic bindings for Full Name and the native Status chooser", () => {
  assert.match(crmSource, /first_name:\s*\{kind:\s*"text",\s*labels:\s*\["First Name",\s*"Full Name"\]\}/);
  assert.match(crmSource, /status:\s*\{[\s\S]*kind:\s*"button_select"[\s\S]*options:\s*\["Contacted",\s*"Converted",\s*"Junk",\s*"New",\s*"Nurture",\s*"Qualified",\s*"Unqualified"\]/);
  assert.match(source, /uniqueVisible\("\[role='option'\]"/);
  assert.match(source, /candidate\.textContent\?\.trim\(\) === field\.value/);
  assert.match(source, /await guide\.point\(control, `Opening \$\{field\.label\}`\)/);
  assert.match(source, /await guide\.point\(option, `Selecting \$\{field\.value\}`\)/);
  assert.match(source, /controlValue\(control\) === field\.value/);
  assert.match(source, /Keeping \$\{field\.label\} as \$\{field\.value\}/);
  assert.match(source, /depth < 4/);
  assert.match(source, /text\?\.startsWith\(hint\)/);
  assert.match(source, /ranked\[0\]\.depth < ranked\[1\]\.depth/);
  assert.doesNotMatch(crmSource, /(?:selector|xpath)\s*:/i);
});

test("malformed field bindings cannot register an adapter", () => {
  const {registry} = load("/crm/leads");
  const base = {
    schemaVersion: 1, id: "bad-binding", label: "Bad", priority: 1, base: "/crm",
    pathPrefixes: ["/crm/"], doctypes: ["CRM Lead"], operations: ["create"],
    capabilities: {navigate: true, fill: true, pauseBeforeSave: true, save: "separate_confirmation"},
    rootMarkers: ["#app"],
  };
  assert.throws(() => registry.registerKnown({...base, routes: {
    "CRM Lead": {create: "/leads", commitButtons: {create: ["Create"]}, fieldBindings: {status: {kind: "css", selector: "#status"}}},
  }}), {name: "MusterSurfaceUnavailableError"});
  assert.throws(() => registry.registerKnown({...base, id: "bad-options", routes: {
    "CRM Lead": {create: "/leads", commitButtons: {create: ["Create"]}, fieldBindings: {status: {kind: "button_select", labels: ["Status"], options: []}}},
  }}), {name: "MusterSurfaceUnavailableError"});
  assert.throws(() => registry.registerKnown({...base, id: "ambiguous-editor", routes: {
    "CRM Lead": {create: "/leads", commitButtons: {create: ["Create"]}, fieldBindings: {description: {kind: "contenteditable", labels: ["Description"]}}},
  }}), {name: "MusterSurfaceUnavailableError"});
  assert.throws(() => registry.registerKnown({...base, id: "executable-binding", routes: {
    "CRM Lead": {create: "/leads", commitButtons: {create: ["Create"]}, fieldBindings: {description: {kind: "contenteditable", labels: ["Description"], unique: true, callback: "run"}}},
  }}), {name: "MusterSurfaceUnavailableError"});
});

test("an unsupported SPA fails safely without invoking the Desk controller", async () => {
  const {registry, deskStarts} = load("/custom-operations/orders");
  await assert.rejects(registry.start(receipt()), (error) => {
    assert.equal(error.name, "MusterSurfaceUnavailableError");
    assert.doesNotMatch(error.message, /selector|stack|route|controller/i);
    return true;
  });
  assert.equal(deskStarts.length, 0);
});

test("registration requires the complete non-saving capability contract", () => {
  const {registry} = load("/crm/leads");
  const starts = [];
  assert.throws(() => registry.register(adapter("unsafe", "/crm/", starts, {
    capabilities: {navigate: true, fill: true, pauseBeforeSave: false, save: "automatic"},
  })), {name: "MusterSurfaceUnavailableError"});
  assert.throws(() => registry.register(adapter("selector-injection", "javascript:alert(1)", starts)), {name: "MusterSurfaceUnavailableError"});
  assert.throws(() => registry.register(adapter("ambiguous-prefix", "/crm", starts)), {name: "MusterSurfaceUnavailableError"});
  assert.throws(() => registry.register(adapter("raw", "/crm/", starts, {operations: ["delete"]})), {name: "MusterSurfaceUnavailableError"});
});

test("first registration wins and adapters receive only the normalized receipt", async () => {
  const {registry} = load("/crm/leads");
  const first = [];
  const replacement = [];
  registry.register(adapter("frappe-crm", "/crm/", first));
  registry.register(adapter("frappe-crm", "/crm/", replacement, {priority: 99}));
  await registry.start(receipt({
    operation: "update", record_name: "Acme", record_revision: "2026-07-20 12:34:56.123456",
    injected: {selector: "#password"}, fields: [
    {fieldname: "annual_revenue", label: "Annual Revenue", control: "fill", value: 42},
  ]}));
  assert.equal(first.length, 1);
  assert.equal(replacement.length, 0);
  assert.equal(first[0].value.fields[0].value, "42");
  assert.equal(first[0].value.record_revision, "2026-07-20 12:34:56.123456");
  assert.equal("injected" in first[0].value, false);
  assert.equal(Object.isFrozen(first[0].value), true);
  assert.equal(Object.isFrozen(first[0].value.fields), true);
});

test("update revision is mandatory and create receipts cannot smuggle one", async () => {
  const {registry} = load("/crm/leads");
  registry.register(adapter("frappe-crm", "/crm/", []));
  await assert.rejects(registry.start(receipt({operation: "update", record_name: "Acme"})), {
    name: "MusterSurfaceUnavailableError",
  });
  await assert.rejects(registry.start(receipt({record_revision: "2026-07-20 12:34:56.123456"})), {
    name: "MusterSurfaceUnavailableError",
  });
  await assert.rejects(registry.start(receipt({
    operation: "update", record_name: "Acme", record_revision: "bad\nrevision",
  })), {name: "MusterSurfaceUnavailableError"});
});

test("the Desk adapter admits a bounded dual-control delete review receipt", async () => {
  const {registry, deskStarts} = load("/desk/customer/ACME");
  const result = await registry.start(receipt({
    objective: "Delete Customer ACME", operation: "delete", record_name: "ACME",
    record_revision: "2026-07-20 12:34:56.123456", approval_proof: "a".repeat(64),
    delete_requires_confirmation: true, delete_authorized: true,
    save_requires_confirmation: undefined, save_authorized: undefined, fields: [],
  }));
  assert.equal(result.adapter, "frappe-desk");
  assert.equal(deskStarts.length, 1);
  assert.equal(deskStarts[0].approval_proof, "a".repeat(64));
  assert.equal(deskStarts[0].delete_requires_confirmation, true);
  assert.equal(deskStarts[0].executed, false);
  assert.equal("save_authorized" in deskStarts[0], false);
  await assert.rejects(registry.start(receipt({
    objective: "Delete Customer ACME", operation: "delete", record_name: "ACME",
    record_revision: "2026-07-20 12:34:56.123456", approval_proof: "forged",
    delete_requires_confirmation: true, delete_authorized: true,
    save_requires_confirmation: undefined, save_authorized: undefined, fields: [],
  })), {name: "MusterSurfaceUnavailableError"});
});

test("configured SPA delete is revision-bound, one-use, native, and server-verified", () => {
  assert.match(source, /\["update", "delete"\]\.includes\(receipt\.operation\)/);
  assert.match(source, /receipt\.operation === "delete"[\s\S]*receipt\.delete_authorized/);
  assert.match(source, /muster\.api\.mission\.recheck_attended_delete/);
  assert.match(source, /recheck\?\.record_revision !== receipt\.record_revision/);
  assert.match(source, /muster\.api\.mission\.issue_attended_delete/);
  assert.match(source, /typed_record_name: typedRecordName/);
  assert.match(source, /commit\.click\(\);[\s\S]*\[role='dialog'\]/);
  assert.match(source, /muster\.api\.mission\.consume_attended_delete/);
  assert.match(source, /confirmButton\.click\(\)/);
  assert.match(source, /muster\.api\.mission\.verify_attended_delete_result/);
  assert.match(source, /operation: "delete", deleted: true, verified: true/);
});

test("CRM delete is explicitly unsupported and cannot fall through to Desk", async () => {
  const {registry, deskStarts} = load("/crm/leads/CRM-LEAD-1", {supportedRoot: true});
  await registry.loadKnownSurface();
  const crm = registry.capabilities().find((entry) => entry.id === "muster-frappe-crm");
  assert.deepEqual(Array.from(crm.operations), ["create"]);
  await assert.rejects(registry.start(receipt({
    objective: "Delete CRM Lead CRM-LEAD-1", operation: "delete", doctype: "CRM Lead",
    record_name: "CRM-LEAD-1", record_revision: "2026-07-20 12:34:56.123456",
    approval_proof: "a".repeat(64), delete_requires_confirmation: true, delete_authorized: true,
    save_requires_confirmation: undefined, save_authorized: undefined, fields: [],
  })), {name: "MusterSurfaceUnavailableError"});
  assert.equal(deskStarts.length, 0);
});

test("CRM inline auto-saving update is rejected before any native field interaction", async () => {
  const {registry, deskStarts} = load("/crm/leads/CRM-LEAD-1", {supportedRoot: true});
  await registry.loadKnownSurface();
  const crm = registry.capabilities().find((entry) => entry.id === "muster-frappe-crm");
  assert.deepEqual(Array.from(crm.operations), ["create"]);
  await assert.rejects(registry.start(receipt({
    objective: "Update CRM Lead CRM-LEAD-1", operation: "update", doctype: "CRM Lead",
    record_name: "CRM-LEAD-1", record_revision: "2026-07-20 12:34:56.123456",
  })), {name: "MusterSurfaceUnavailableError"});
  assert.equal(deskStarts.length, 0);
});

test("CRM Create is a visible one-shot native commit bracketed by server preflight and verification", () => {
  const start = source.indexOf('async confirm()');
  const end = source.indexOf('confirmationInFlight = false;', start);
  const block = source.slice(start, end);
  const preflight = block.indexOf('muster.api.mission.preflight_attended_save');
  const click = block.indexOf('commit.click()');
  const verify = block.indexOf('muster.api.mission.verify_attended_save');
  assert.ok(start > 0 && preflight > 0 && click > preflight && verify > click);
  assert.match(block, /if \(confirmationInFlight \|\| confirmationUsed\) throw/);
  assert.match(block, /confirmationUsed = true;[\s\S]*commit\.click\(\)/);
  assert.match(block, /uniqueVisible\("button, \[role='button'\]"[\s\S]*!== commit/);
  assert.match(block, /controlValue\(stagedControls\.get\(field\.fieldname\)\) !== field\.value/);
  assert.match(block, /createdRecordName\(row, String\(window\.location\.pathname\)\)/);
  assert.match(block, /await sleep\(750\);[\s\S]*waitForSavedRecord/);
  assert.match(block, /Date\.now\(\) - verificationStarted < 5_000/);
  assert.match(block, /candidate\?\.verified === true[\s\S]*candidate\?\.proof_hash/);
  assert.match(block, /created: receipt\.operation === "create"/);
  assert.match(block, /updated: receipt\.operation === "update"/);
  assert.match(source, /operation === "update" \? "Updated" : "Created"/);
  assert.doesNotMatch(block, /frappe\.client|\/api\/resource|\.insert\(|\.save\(/);
  assert.match(source, /if \(existingFormRoot\) \{\s*if \(controlValue\(control\) !== field\.value\) throw/);
});

test("CRM Create confirmation failures are sanitized and never re-enable a used native click", () => {
  assert.match(source, /guide\.stop\(clicked, receipt\.operation\)/);
  assert.match(source, /uncertainAction = operation === "delete" \? "Deletion"/);
  assert.match(source, /\$\{uncertainAction\} may have completed; review the audit record/);
  assert.doesNotMatch(source, /error\?\.message|_error\.message|stack|Traceback/);
  assert.match(source, /confirmationUsed = true/);
  assert.equal((source.match(/confirmationUsed = false/g) || []).length, 1);
  assert.equal((source.match(/confirmationUsed = true/g) || []).length, 1);
});

test("adapter capability discovery is declarative and omits executable callbacks", () => {
  const {registry} = load("/crm/leads");
  registry.register(adapter("frappe-crm", "/crm/", []));
  const row = registry.capabilities().find((entry) => entry.id === "frappe-crm");
  assert.equal(row.capabilities.navigate, true);
  assert.equal(row.capabilities.fill, true);
  assert.equal(row.capabilities.pauseBeforeSave, true);
  assert.equal(row.capabilities.save, "separate_confirmation");
  assert.equal("start" in row, false);
  assert.deepEqual(Array.from(row.operations), ["create", "update"]);
});

test("adapter failures are replaced with one safe surface error", async () => {
  const {registry} = load("/crm/leads");
  registry.register(adapter("frappe-crm", "/crm/", [], {
    async start() { throw new Error("raw React stack and selector #password"); },
  }));
  await assert.rejects(registry.start(receipt({doctype: "CRM Lead"})), (error) => {
    assert.equal(error.name, "MusterSurfaceUnavailableError");
    assert.doesNotMatch(error.message, /React|selector|password/);
    return true;
  });
});

test("attended receipts cannot weaken pause-before-save at adapter selection", async () => {
  const {registry} = load("/crm/leads");
  registry.register(adapter("frappe-crm", "/crm/", []));
  await assert.rejects(registry.start(receipt({save_requires_confirmation: false})), {name: "MusterSurfaceUnavailableError"});
  await assert.rejects(registry.start(receipt({executed: true})), {name: "MusterSurfaceUnavailableError"});
  await assert.rejects(registry.start(receipt({operation: "delete"})), {name: "MusterSurfaceUnavailableError"});
});
