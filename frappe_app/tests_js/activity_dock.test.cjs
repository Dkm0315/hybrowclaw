const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadModel() {
  const window = {};
  const context = {
    window,
    frappe: {utils: {escape_html(value) {
      return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
    }}},
    document: {},
    $() { return {on() {}}; },
    __: String,
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "../muster/public/js/activity_dock.js"), "utf8"),
    context,
  );
  return window.MusterAskDockModel;
}

const model = loadModel();
const source = fs.readFileSync(path.join(__dirname, "../muster/public/js/activity_dock.js"), "utf8");

test("Ask is a universal conversation path and workflow planning is explicit", () => {
  assert.equal(model.submitMethod("ask"), "muster.api.ask.submit");
  assert.equal(model.submitMethod("workflow"), "muster.api.mission.plan");
});

test("a verified form target continues across generic Desk turns without overriding a real form route", () => {
  assert.equal(
    JSON.stringify(model.continuationScope({source: "desk-dock", route: "muster-control"}, "Purchase Order")),
    JSON.stringify({source: "desk-dock", route: "muster-control", doctype: "Purchase Order", page_type: "Form", page_name: "Purchase Order"}),
  );
  assert.equal(
    model.continuationScope({doctype: "Supplier"}, "Purchase Order").doctype,
    "Supplier",
  );
});

test("assistant prose renders safe readable structure instead of literal Markdown", () => {
  const rendered = model.richText("## Purchase Order\n\n1. Choose **Supplier**\n2. Add `Items`\n\n[Open guide](https://example.com/guide)");
  assert.match(rendered, /<h4>Purchase Order<\/h4>/);
  assert.match(rendered, /<ol><li>Choose <strong>Supplier<\/strong><\/li>/);
  assert.match(rendered, /<code>Items<\/code>/);
  assert.match(rendered, /target="_blank"/);
  assert.doesNotMatch(model.richText("<script>alert(1)<\/script>"), /<script>/);
});

test("instructional answers offer one schema-targeted continuation into the attended workflow", () => {
  assert.match(source, /function appendTrainingContinuation\(doctype\)/);
  assert.match(source, /Create one with me/);
  assert.match(source, /Tell me the details listed above in your own words/);
  assert.match(source, /Create a \{0\} with these details: \{1\}/);
  assert.match(source, /Open the live form, fill the reviewed values visibly/);
  assert.match(source, /Pause for my approval before Save or Submit/);
  assert.match(source, /const submittedText = trainingTarget/);
  assert.match(source, /prompt: submittedText/);
  assert.match(source, /appendTrainingContinuation\(state\.context_target\?\.doctype \|\| conversationDoctype\)/);
  assert.match(source, /response\.message\?\.context_target\?\.doctype[\s\S]{0,160}conversationDoctype = response\.message\.context_target\.doctype/);
  assert.doesNotMatch(source, /Create a Purchase Order with me/);
});

test("ordered steps retain their visible number after an indented detail list", () => {
  const rendered = model.richText("4. **Items**, each with:\n   - Item\n   - Quantity\n5. **Warehouse**\n6. **Currency**");
  assert.match(rendered, /<ol start="4"><li><strong>Items<\/strong>, each with:<\/li><\/ol>/);
  assert.match(rendered, /<ul><li>Item<\/li><li>Quantity<\/li><\/ul>/);
  assert.match(rendered, /<ol start="5"><li><strong>Warehouse<\/strong><\/li><li><strong>Currency<\/strong><\/li><\/ol>/);
});

test("current Desk route contributes context without changing the request intent", () => {
  const context = model.scope(["Form", "Sales Invoice", "SINV-0001"], "Form/Sales Invoice/SINV-0001");
  assert.equal(context.scope_mode, "context");
  assert.equal(context.doctype, "Sales Invoice");
  assert.equal(context.docname, "SINV-0001");
});

test("only completed and failed Ask states are terminal", () => {
  assert.equal(model.terminal("queued"), false);
  assert.equal(model.terminal("running"), false);
  assert.equal(model.terminal("completed"), true);
  assert.equal(model.terminal("failed"), true);
});

test("active mission polling backs off without an unbounded retry storm", () => {
  assert.equal(model.refreshBackoff(0), 0);
  assert.equal(model.refreshBackoff(1), 2000);
  assert.equal(model.refreshBackoff(2), 4000);
  assert.equal(model.refreshBackoff(5), 32000);
  assert.equal(model.refreshBackoff(99), 32000);
});

test("background mission polling bypasses Frappe's modal-producing request wrapper", () => {
  assert.match(source, /async function fetchActiveMissions\(\)/);
  assert.match(source, /window\.fetch\(url/);
  assert.doesNotMatch(source, /frappe\.db\.get_list\("Muster Mission"/);
  assert.match(source, /if \(refreshInFlight\)/);
});

test("Desk clarification receipts are conversation and lineage bound", () => {
  const continuation = model.clarification({
    turn_id: "MST-ASK-1", handoff_id: "handoff-a", token: "a".repeat(43),
    conversation_id: "desk-safe", prompt_hash: "b".repeat(64), bound_scope: {doctype: "Customer"},
  }, {conversationId: "desk-safe", turnId: "MST-ASK-1", handoffId: "handoff-a"});
  assert.equal(continuation.turnId, "MST-ASK-1");
  assert.equal(continuation.boundScope.doctype, "Customer");
  assert.equal(model.clarification({...continuation, conversation_id: "desk-other"}, {conversationId: "desk-safe"}), null);
  assert.equal(model.clarification({turn_id: "x", handoff_id: "y", token: "short", conversation_id: "desk-safe", prompt_hash: "b".repeat(64), bound_scope: {}}, {conversationId: "desk-safe"}), null);
});

test("attended Ask handoffs navigate immediately while inert proposals retain confirmation", () => {
  assert.match(source, /muster\.api\.ask\.accept_handoff/);
  assert.match(source, /frappe\.confirm/);
  assert.match(source, /handoff\.kind === "attended_browser"[\s\S]{0,240}button\.hidden = true/);
  assert.match(source, /queueMicrotask\(\(\) => button\.click\(\)\)/);
  assert.match(source, /confirmed:\s*1/);
  assert.match(source, /This will not publish, start, open a browser, or change Frappe/);
  assert.doesNotMatch(source, /muster\.api\.mission\.start_proposal[\s\S]{0,500}handoff/);
});

test("Desk keeps a clarified reply bound to the original Ask and displays the merged objective", () => {
  assert.match(source, /response\.message\?\.status === "clarification"/);
  assert.match(source, /clarification_turn_id:\s*clarification\.turnId/);
  assert.match(source, /clarification_handoff_id:\s*clarification\.handoffId/);
  assert.match(source, /clarification_token:\s*clarification\.token/);
  assert.match(source, /clarification_prompt_hash:\s*clarification\.promptHash/);
  assert.match(source, /clarification\?\.boundScope \|\| currentScope\(\)/);
  assert.match(source, /response\.message\.merged_objective/);
  assert.match(source, /appendMessage\("assistant", response\.message\.reason\)/);
});

test("attended handoff prepares its non-saving receipt and starts the real-form preview immediately", async () => {
  const events = [];
  const opened = await model.startAttendedHandoff(
    "attended_browser",
    "MST-WFP-ATTENDED",
    async (proposal) => {
      events.push(["prepare", proposal]);
      return {proposal, executed: false, save_requires_confirmation: true};
    },
    async (receipt) => events.push(["start", receipt]),
  );
  assert.equal(opened, true);
  assert.deepEqual(events, [
    ["prepare", "MST-WFP-ATTENDED"],
    ["start", {proposal: "MST-WFP-ATTENDED", executed: false, save_requires_confirmation: true}],
  ]);
  assert.match(source, /muster\.api\.mission\.prepare_attended_preview/);
  assert.match(source, /window\.musterSurfaceAdapters\.start\(receipt\)/);
  assert.ok(source.indexOf("muster.api.ask.accept_handoff") < source.indexOf("muster.api.mission.prepare_attended_preview"));
});

test("attended handoff reports a clear full-page form transition", async () => {
  const result = await model.startAttendedHandoff(
    "attended_browser", "MST-WFP-ATTENDED",
    async () => ({proposal: "MST-WFP-ATTENDED"}),
    async () => ({navigated: true, opened: false}),
  );
  assert.equal(result, "navigated");
  assert.match(source, /opened === "navigated"/);
  assert.match(source, /Opening the form with your details/);
});

test("attended navigation uses task-focused form language and keeps recovery secondary", async () => {
  let called = false;
  assert.equal(await model.startAttendedHandoff("governed_change", "MST-WFP-1", async () => { called = true; }, async () => { called = true; }), false);
  assert.equal(called, false);
  assert.match(source, /Opening the form with your details/);
  assert.match(source, /Open audit or recover this preview/);
  assert.match(source, /couldn’t open the form\. Your details are still here, so you can try again/);
});

test("permission-filtered catalog separates slash commands from governed mentions", () => {
  const items = model.catalog({schema_version: 1, items: [
    {kind: "command", id: "status", label: "Status", description: "Current status", token: "/status"},
    {kind: "agent", id: "finance", label: "Finance", description: "Finance agent", token: "@agent:finance"},
    {kind: "workflow", id: "close", label: "Close", description: "Month close", token: "@workflow[close]"},
    {kind: "skill", id: "pdf", label: "PDF", description: "Create PDFs", token: "@skill:pdf"},
    {kind: "mcp", id: "drive", label: "Drive", description: "Drive MCP", token: "@mcp:drive"},
    {kind: "secret", id: "bad", label: "Bad", description: "Bad", token: "bad"},
    {kind: "agent", id: "bad", label: "Bad", description: "Bad token", token: "javascript:alert(1)"},
  ]});
  assert.deepEqual(Array.from(model.filterCatalog(items, "/", "stat"), (row) => row.kind), ["command"]);
  assert.deepEqual(Array.from(model.filterCatalog(items, "@", ""), (row) => row.kind), ["agent", "workflow", "mcp", "skill"]);
});

test("toolbar slash selection creates a real leading command and preserves prompt text as arguments", () => {
  const command = model.applySelection("monthly sales", 13, 13, "/", "/reports");
  assert.equal(command.value, "/reports monthly sales");
  assert.equal(command.caret, 9);
  const replacement = model.applySelection("/sta this week", 4, 4, "/", "/status");
  assert.equal(replacement.value, "/status this week");
  assert.match(source, /if \(paletteTrigger === "\/"\) setIntent\("ask"\)/);
});

test("mention selection stays within a free-form Ask prompt", () => {
  const selected = model.applySelection("Please ask @fin", 15, 15, "@", "@agent:finance");
  assert.equal(selected.value, "Please ask @agent:finance ");
  assert.equal(selected.caret, selected.value.length);
});

test("tool-call cards accept only bounded presentation records", () => {
  const calls = model.presentableCalls([
    {kind: "mcp", status: "completed", label: "Customer form", summary: "Read permitted fields", details: {scope: "Customer"}},
    {kind: "tool", status: "failed", label: "provider backend trace", summary: `model failed at /srv/private ${"a".repeat(64)}`, details: {outcome: "stack trace localhost"}},
    {kind: "provider_trace", status: "completed", label: "Internal", summary: "raw trace"},
    {kind: "tool", status: "unknown", label: "Bad", summary: "Bad"},
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].label, "Customer form");
  assert.equal(calls[1].label, "Muster step");
  assert.equal(calls[1].summary, "This step could not be completed. Nothing was changed.");
  assert.equal(calls[1].details, undefined);
  assert.match(source, /details\.purpose/);
  assert.doesNotMatch(source, /details\.raw|details\.arguments|details\.stack/);
  assert.match(source, /<summary>\$\{__\("What Muster did"\)\}/);
  assert.doesNotMatch(source, /call\.kind === "mcp" \? "MCP"/);
});

test("the dock discovers commands from the governed server catalog", () => {
  assert.match(source, /muster\.api\.catalog\.get_palette/);
  assert.match(source, /data-muster-palette="\/"/);
  assert.match(source, /data-muster-palette="@"/);
  assert.doesNotMatch(source, /state\.partial_text/);
  assert.doesNotMatch(source, /throw error;/);
  assert.doesNotMatch(source, /console\.debug\([^\n]*error/);
});

test("the completed answer is rendered before an attended handoff starts", () => {
  assert.ok(source.indexOf("await pollAnswer(response.message.run_id, answerItem)")
    < source.indexOf("appendHandoffs(response.message.turn_id, response.message.handoffs || [])"));
});
