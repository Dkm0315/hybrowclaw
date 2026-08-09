const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../muster/public/js/spa_assistant.js"), "utf8");
const hooks = fs.readFileSync(path.join(__dirname, "../muster/hooks.py"), "utf8");

function model(pathname) {
  const window = {location: {pathname}, document: {body: null}};
  vm.runInNewContext(source, {window, console});
  return window.MusterSpaAssistantModel;
}

function dispatchModel() {
  const window = {
    location: {pathname: "/operations/visits"},
    document: {body: null},
  };
  vm.runInNewContext(source, {window, console});
  return window.MusterSpaAssistantModel;
}

test("Muster-owned assistant recognizes standalone Frappe SPA routes", () => {
  const ui = model("/crm/leads");
  for (const pathname of ["/crm", "/crm/leads", "/helpdesk/tickets"]) {
    assert.equal(ui.eligible(pathname, true), true, pathname);
  }
  for (const pathname of ["/desk/muster-control", "/app/customer", "/login"]) {
    assert.equal(ui.eligible(pathname, true), false, pathname);
  }
  for (const pathname of ["/support/tickets", "/hrms", "/hr/leave", "/unknown-app"]) {
    assert.equal(ui.eligible(pathname, true), true, `${pathname} is only a bootstrap-gated custom candidate`);
  }
  assert.equal(ui.eligible("/custom-operations/orders", true), true, "custom Vue/React root");
  assert.equal(ui.eligible("/custom-operations/orders", false), false, "ordinary website route");
  for (const pathname of ["/api/method/x", "/assets/app.js", "/files/report.pdf", "/private/files/a.pdf"]) {
    assert.equal(ui.eligible(pathname, true), false, pathname);
  }
  assert.match(source, /#app, \[data-v-app\], \[data-reactroot\], \[data-muster-spa-root\]/);
});

test("known paths still require a real SPA root and a supported bootstrap before Ask is revealed", () => {
  const ui = model("/helpdesk/tickets");
  assert.equal(ui.eligible("/helpdesk/tickets", false), false, "Frappe 404 shell");
  assert.equal(ui.eligible("/helpdesk/tickets", true), true, "real Helpdesk SPA root");
  assert.match(source, /Promise\.all\(\[[\s\S]*frappe\.auth\.get_logged_user[\s\S]*muster\.api\.surface\.bootstrap/);
  assert.match(source, /support\?\.supported === true/);
  assert.match(source, /else root\.remove\(\)/);
});

test("natural Ask remains a universal SPA conversation with route context", () => {
  const ui = model("/crm/leads/LEAD-1");
  const scope = ui.scope("/crm/leads/LEAD-1");
  assert.equal(scope.scope_mode, "context");
  assert.equal(scope.page_type, "SPA");
  assert.equal(scope.page_name, "crm");
  assert.equal(scope.route, "/crm/leads/LEAD-1");
  assert.equal(scope.doctype, "CRM Lead");
  assert.equal(scope.docname, "LEAD-1");
  assert.equal(ui.scope("/crm/leads/LEAD%20SAFE").docname, "LEAD SAFE");
  assert.equal(ui.scope("/crm/leads/view/list").docname, undefined);
  assert.equal(ui.scope("/crm/leads/new").docname, undefined);
  assert.equal(ui.scope("/crm/deals").doctype, "CRM Deal");
  assert.equal(ui.scope("/crm/contacts").doctype, "Contact");
  assert.equal(ui.scope("/crm/organizations").doctype, "CRM Organization");
  assert.equal(ui.scope("/helpdesk/tickets/HD-TICKET-1").doctype, "HD Ticket");
  assert.equal(ui.scope("/helpdesk/tickets/HD-TICKET-1").docname, "HD-TICKET-1");
  assert.equal(ui.scope("/helpdesk/tickets/HD%20SAFE").docname, "HD SAFE");
  assert.equal(ui.scope("/helpdesk/tickets/new").docname, undefined);
  assert.equal(ui.safeError(), "Muster could not complete that request. Nothing was changed.");
});

test("configured SPA Ask derives one exact record identity from its inert route manifest", () => {
  const ui = model("/operations/visits/SV-0001");
  const descriptor = {
    base: "/operations",
    routes: {
      "Service Visit": {list: "/visits", create: "/visits/new", record: "/visits/{name}"},
      "Service Crew": {create: "/crews/new", record: "/crews/{name}/view"},
    },
  };
  assert.deepEqual(JSON.parse(JSON.stringify(ui.scope("/operations/visits/SV-0001", descriptor))), {
    source: "spa-assistant", scope_mode: "context", route: "/operations/visits/SV-0001",
    page_type: "SPA", page_name: "operations", doctype: "Service Visit", docname: "SV-0001",
  });
  assert.equal(ui.scope("/operations/visits/new", descriptor).doctype, "Service Visit");
  assert.equal(ui.scope("/operations/visits/new", descriptor).docname, undefined);
  assert.equal(ui.scope("/operations/visits", descriptor).doctype, "Service Visit");
  assert.equal(ui.scope("/operations/visits", descriptor).docname, undefined);
  assert.equal(ui.scope("/operations/crews/CREW%20A/view", descriptor).docname, "CREW A");
  assert.equal(ui.scope("/operations/crews/a/b/view", descriptor).docname, undefined);
  assert.equal(ui.scope("/operations/unknown/ROW-1", descriptor).doctype, undefined);
});

test("SPA clarification receipts reject cross-conversation and malformed lineage", () => {
  const ui = model("/crm/leads");
  const valid = {
    turn_id: "MST-ASK-1", handoff_id: "handoff-a", token: "a".repeat(43),
    conversation_id: "spa-safe", prompt_hash: "b".repeat(64), bound_scope: {route: "/crm/leads"},
  };
  assert.equal(ui.clarification(valid, {conversationId: "spa-safe", turnId: "MST-ASK-1", handoffId: "handoff-a"}).turnId, "MST-ASK-1");
  assert.equal(ui.clarification({...valid, conversation_id: "spa-other"}, {conversationId: "spa-safe"}), null);
  assert.equal(ui.clarification({...valid, bound_scope: []}, {conversationId: "spa-safe"}), null);
});

test("SPA overlay goes directly from an attended Ask to the native form and keeps confirmation for inert proposals", () => {
  assert.match(source, /muster\.api\.ask\.submit/);
  assert.match(source, /muster\.api\.ask\.poll/);
  assert.match(source, /muster\.api\.ask\.accept_handoff/);
  assert.match(source, /muster\.api\.mission\.prepare_attended_preview/);
  assert.match(source, /muster\.api\.surface\.bootstrap/);
  assert.match(source, /handoff\.kind === "attended_browser"[\s\S]{0,240}button\.hidden = true/);
  assert.match(source, /model\.dispatchAttended\(handoff, prepare\)/);
  assert.match(source, /!attended && !window\.confirm/);
  assert.match(source, /window\.musterSurfaceAdapters\.start\(receipt\)/);
  assert.match(source, /session\?\.navigated === true/);
  assert.match(source, /Opening the form with your details/);
  assert.match(source, /frappe\.auth\.get_logged_user/);
  assert.doesNotMatch(source, /window\.frappe|frappe\.boot|frappe\.sessions\.get_csrf_token/);
  assert.doesNotMatch(source, /frappe\.(?:set_route|route_options|get_route)/);
  assert.doesNotMatch(source, /innerHTML\s*=\s*[^;]*error|error\?\.message|throw _error/);
});

test("attended handoffs schedule the handler directly without relying on a hidden button click", async () => {
  const ui = dispatchModel();
  let prepared = 0;
  assert.equal(ui.dispatchAttended({kind: "attended_browser"}, async () => { prepared += 1; }), true);
  assert.equal(prepared, 1);
  assert.equal(ui.dispatchAttended({kind: "review_proposal"}, () => { prepared += 1; }), false);
  assert.equal(ui.dispatchAttended({kind: "attended_browser"}, null), false);
  assert.equal(prepared, 1);
  assert.doesNotMatch(source, /button\.click\(\)/);
  assert.doesNotMatch(source, /queueMicrotask/);
});

test("CRM native Create requires a separate explicit chat confirmation", () => {
  assert.match(source, /\.muster-spa-assistant\{[^}]*pointer-events:auto/);
  assert.match(source, /const session = await window\.musterSurfaceAdapters\.start\(receipt\)/);
  assert.match(source, /session\.confirmationLabel\.replace\(\/\^Confirm \/, ""\)/);
  assert.match(source, /confirmation\.textContent = label/);
  assert.match(source, /renderNativeConfirmation\(\(\) => session\.confirm\(\), session\.confirmationLabel, receipt\.operation\)/);
  assert.match(source, /confirmation\.addEventListener\("click"/);
  assert.match(source, /if \(confirmation\.disabled\) return;[\s\S]*confirmation\.disabled = true/);
  assert.match(source, /const verified = await confirmAction\(\)/);
  assert.match(source, /operation === "update" \? "Updated" : "Created"\} and verified \$\{verified\.recordName\}/);
  assert.match(source, /verified\?\.operation !== operation/);
  assert.match(source, /log\.scrollTop = log\.scrollHeight;[\s\S]*confirmation\.scrollIntoView\(\{block: "nearest", inline: "nearest"\}\)/);
  assert.match(source, /confirmation\.focus\(\{preventScroll: true\}\)/);
  assert.match(source, /muster\.api\.mission\.review_proposal/);
  assert.match(source, /reviewed\?\.status !== "Approved"/);
  assert.match(source, /const approvedReceipt = await method\("muster\.api\.mission\.prepare_attended_preview"/);
  assert.match(source, /return approvedSession\.confirm\(\)/);
  assert.match(source, /new Set\(\["Confirm Create", "Confirm Submit"\]\)/);
  assert.match(source, /!allowedLabels\.has\(approvedSession\.confirmationLabel\)/);
  assert.doesNotMatch(source, /confirmation\.click\(\)/);
});

test("exact-record updates wait for an independent reviewer before Save is enabled", () => {
  assert.match(source, /receipt\?\.operation === "update"[\s\S]*continueAfterApproval\.textContent = "Check approval and continue"/);
  assert.match(source, /approvedReceipt\?\.save_authorized !== true/);
  assert.match(source, /Still awaiting approval from a different authorized reviewer\. Nothing was saved\./);
  assert.match(source, /approvedSession\.confirmationLabel !== "Confirm Save"/);
  assert.match(source, /renderNativeConfirmation\(\(\) => approvedSession\.confirm\(\), "Confirm Save", "update"\)/);
  assert.match(source, /This exact-record update requires approval from a different authorized reviewer/);
});

test("exact-record deletes require another reviewer and exact-name confirmation in chat", () => {
  assert.match(source, /Check destructive approval and continue/);
  assert.match(source, /approvedReceipt\?\.delete_authorized !== true/);
  assert.match(source, /typeof approvedSession\?\.confirmDelete !== "function"/);
  assert.match(source, /Type \$\{recordName\} to authorize one visible native deletion/);
  assert.match(source, /confirmation\.disabled = exactName\.value !== recordName/);
  assert.match(source, /await deleteSession\.confirmDelete\(exactName\.value\)/);
  assert.match(source, /Deleted and verified \$\{verified\.recordName\}/);
  assert.match(source, /Do not repeat the deletion/);
});

test("Ask Muster remains usable at a phone viewport and respects display safe areas", () => {
  assert.match(source, /env\(safe-area-inset-right\)/);
  assert.match(source, /env\(safe-area-inset-bottom\)/);
  assert.match(source, /@media\(max-width:767px\)/);
  assert.match(source, /max-height:calc\(100dvh/);
  assert.match(source, /\.muster-spa-actions>\*\{flex:1\}/);
  assert.match(source, /min-height:44px/);
});

test("SPA displays exact clarification and transparently submits the next reply against it", () => {
  assert.match(source, /append\("assistant", accepted\.reason\)/);
  assert.match(source, /clarification_turn_id:\s*clarification\.turnId/);
  assert.match(source, /clarification_handoff_id:\s*clarification\.handoffId/);
  assert.match(source, /clarification_token:\s*clarification\.token/);
  assert.match(source, /clarification_prompt_hash:\s*clarification\.promptHash/);
  assert.match(source, /clarification\?\.boundScope \|\| model\.scope/);
  assert.match(source, /model\.scope\(window\.location\.pathname, activeDescriptor\)/);
  assert.match(source, /submitted\.merged_objective/);
});

test("site hooks load only Muster-owned framework-independent SPA assets", () => {
  assert.match(hooks, /web_include_js[\s\S]*\/assets\/muster\/js\/surface_adapters\.js/);
  assert.match(hooks, /web_include_js[\s\S]*\/assets\/muster\/js\/spa_assistant\.js/);
  assert.doesNotMatch(hooks, /apps\/(?:crm|helpdesk|hrms)|frontend\/src|desk\/src/);
});
