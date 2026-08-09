const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadUI({user = "operator@example.test", bootUser = null, roles = ["Muster Operator"]} = {}) {
  const handlers = {};
  const dialogs = [];
  const calls = [];
  const routes = [];
  const frappe = {
    session: user ? {user} : {},
    boot: {user: bootUser ? {name: bootUser} : {}},
    user: {has_role: (role) => roles.includes(role)},
    ui: {
      form: {on(_doctype, definition) { Object.assign(handlers, definition); }},
      Dialog: function Dialog(options) {
        this.options = options;
        this.show = () => dialogs.push(this);
        this.hide = () => {};
        this.disable_primary_action = () => {};
        this.enable_primary_action = () => {};
      },
    },
    utils: {escape_html: String, get_random() { return "random"; }},
    msgprint() {},
    async call(options) {
      calls.push(options);
      if (options.method === "muster.api.mission.prepare_attended_preview") return {message: {proposal: options.args.proposal, doctype: "Customer"}};
      return {message: {mission: "MST-MSN-1"}};
    },
    set_route(...parts) { routes.push(parts); },
  };
  const attended = [];
  const window = {musterSurfaceAdapters: {async start(receipt) { attended.push(receipt); }}};
  const context = {window, frappe, __: String, console};
  vm.runInNewContext(
    fs.readFileSync(
      path.join(__dirname, "../muster/muster/doctype/muster_workflow_proposal/muster_workflow_proposal.js"),
      "utf8",
    ),
    context,
  );
  return {ui: window.MusterWorkflowProposalUI, handlers, dialogs, calls, routes, attended};
}

function form(overrides = {}) {
  return {
    doc: {
      status: "Published",
      requested_by: "operator@example.test",
      published_workflow: "Reviewed workflow",
      published_version: "Reviewed workflow-v1",
      compiled_graph_json: JSON.stringify({nodes: [{executionIntent: {surface: "browser", plan: {attendedCrud: {operation: "create"}}}}]}),
      ...overrides,
    },
  };
}

test("offers attended preview only to the requester with one bounded CRUD plan", () => {
  const {ui} = loadUI();
  assert.equal(ui.canPreviewAttendedProposal(form({status: "Proposed"})), true);
  assert.equal(ui.canPreviewAttendedProposal(form({status: "Rejected"})), false);
  assert.equal(ui.canPreviewAttendedProposal(form({requested_by: "another@example.test"})), false);
  assert.equal(ui.canPreviewAttendedProposal(form({compiled_graph_json: "{}"})), false);
  assert.equal(ui.canPreviewAttendedProposal(form({status: "Approved", compiled_graph_json: JSON.stringify({nodes: [{executionIntent: {surface: "browser", plan: {attendedCrud: {operation: "delete"}}}}]})})), true);
});

test("destructive approval UI requires a different dedicated checker", () => {
  const deleteGraph = JSON.stringify({nodes: [{executionIntent: {surface: "browser", plan: {attendedCrud: {operation: "delete", doctype: "Customer", record_name: "ACME"}}}}]});
  const maker = loadUI({user: "maker@example.test", roles: ["Muster Approver"]}).ui;
  assert.equal(maker.canApproveProposal(form({status: "Proposed", requested_by: "maker@example.test", compiled_graph_json: deleteGraph})), false);
  const manager = loadUI({user: "checker@example.test", roles: ["Muster Automation Manager"]}).ui;
  assert.equal(manager.canApproveProposal(form({status: "Proposed", requested_by: "maker@example.test", compiled_graph_json: deleteGraph})), false);
  const checker = loadUI({user: "checker@example.test", roles: ["Muster Approver"]}).ui;
  assert.equal(checker.canApproveProposal(form({status: "Proposed", requested_by: "maker@example.test", compiled_graph_json: deleteGraph})), true);
  assert.equal(checker.attendedTarget(form({compiled_graph_json: deleteGraph})).doctype, "Customer");
  assert.equal(checker.attendedTarget(form({compiled_graph_json: deleteGraph})).recordName, "ACME");
  assert.equal(checker.attendedTarget(form({compiled_graph_json: deleteGraph.replace("ACME", "bad\\nname")})), null);
});

test("exact-record update approval UI requires a different reviewer", () => {
  const updateGraph = JSON.stringify({nodes: [{executionIntent: {surface: "browser", plan: {attendedCrud: {operation: "update", doctype: "Customer", record_name: "ACME"}}}}]});
  const maker = loadUI({user: "maker@example.test", roles: ["Muster Automation Manager"]}).ui;
  const checker = loadUI({user: "checker@example.test", roles: ["Muster Automation Manager"]}).ui;
  assert.equal(maker.canApproveProposal(form({status: "Proposed", requested_by: "maker@example.test", compiled_graph_json: updateGraph})), false);
  assert.equal(checker.canApproveProposal(form({status: "Proposed", requested_by: "maker@example.test", compiled_graph_json: updateGraph})), true);
});

test("delete preview copy promises exact-record one-time native deletion", () => {
  const {ui, dialogs} = loadUI();
  ui.previewInDesk(form({
    name: "MST-WFP-DELETE", status: "Approved",
    compiled_graph_json: JSON.stringify({nodes: [{executionIntent: {surface: "browser", plan: {attendedCrud: {operation: "delete"}}}}]}),
  }));
  assert.match(dialogs[0].options.title, /destructive review/i);
  assert.match(dialogs[0].options.fields[0].options, /one short-lived attempt/i);
  assert.match(dialogs[0].options.fields[0].options, /independent approval/i);
});

test("opens attended work through a confirmed non-saving server projection", async () => {
  const {ui, dialogs, calls, attended} = loadUI();
  ui.previewInDesk(form({name: "MST-WFP-ATTENDED", status: "Proposed"}));
  assert.equal(dialogs.length, 1);
  await dialogs[0].options.primary_action();
  assert.equal(calls[0].method, "muster.api.mission.prepare_attended_preview");
  assert.equal(calls[0].args.confirmed, 1);
  assert.equal(calls[0].args.proposal, "MST-WFP-ATTENDED");
  assert.deepEqual(attended, [{proposal: "MST-WFP-ATTENDED", doctype: "Customer"}]);
});

test("offers Start only to the original mission-capable requester", () => {
  const {ui} = loadUI();
  assert.equal(ui.canStartPublishedProposal(form()), true);
  assert.equal(ui.canStartPublishedProposal(form({requested_by: "someone@example.test"})), false);
});

test("fails closed when publication evidence or a creator role is absent", () => {
  const {ui} = loadUI({roles: ["Muster Viewer"]});
  assert.equal(ui.canStartPublishedProposal(form()), false);
  const operator = loadUI().ui;
  assert.equal(operator.canStartPublishedProposal(form({status: "Approved"})), false);
  assert.equal(operator.canStartPublishedProposal(form({published_version: ""})), false);
  assert.equal(operator.canStartPublishedProposal(form({published_workflow: ""})), false);
});

test("registers the native proposal form controller", () => {
  const {handlers} = loadUI();
  assert.equal(typeof handlers.refresh, "function");
});

test("Administrator keeps proposal controls after a fresh client role cache", () => {
  const administrator = loadUI({user: "Administrator", roles: []}).ui;
  assert.equal(administrator.isProposalManager(), true);
  const viewer = loadUI({user: "viewer@example.test", roles: ["Muster Viewer"]}).ui;
  assert.equal(viewer.isProposalManager(), false);
});

test("proposal management falls back to the server-filtered Frappe write permission", () => {
  const viewer = loadUI({user: null, roles: []}).ui;
  assert.equal(viewer.isProposalManager({perm: [{read: 1, write: 1}]}), true);
  assert.equal(viewer.isProposalManager({perm: [{read: 1, write: 0}]}), false);
});

test("proposal identity falls back to the Frappe v16 boot user during reload", () => {
  const administrator = loadUI({user: null, bootUser: "Administrator", roles: []}).ui;
  assert.equal(administrator.currentSessionUser(), "Administrator");
  assert.equal(administrator.isProposalManager(), true);
  assert.equal(
    administrator.canPreviewAttendedProposal(form({status: "Proposed", requested_by: "Administrator"})),
    true,
  );
});

test("requires the visible confirmation before calling the Start API", async () => {
  const {ui, dialogs, calls, routes} = loadUI();
  ui.startProposal(form({name: "MST-WFP-1"}));
  assert.equal(dialogs.length, 1);
  await dialogs[0].options.primary_action({confirm_start: 0});
  assert.equal(calls.length, 0);
  await dialogs[0].options.primary_action({confirm_start: 1});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "muster.api.mission.start_proposal");
  assert.equal(calls[0].args.confirmed, 1);
  assert.equal(calls[0].args.proposal, "MST-WFP-1");
  assert.deepEqual(routes[0], ["Form", "Muster Mission", "MST-MSN-1"]);
});
