import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const definition = JSON.parse(fs.readFileSync(path.join(here, "../native-surface-browser-scenarios.json"), "utf8"));
const scenarios = new Map(definition.scenarios.map((scenario) => [scenario.id, scenario]));
const index = (scenario, step) => scenario.steps.indexOf(step);
const before = (scenario, first, second) => index(scenario, first) >= 0 && index(scenario, first) < index(scenario, second);

test("native browser definitions use the release desktop and phone viewports", () => {
  assert.deepEqual(definition.viewports.desktop, {width: 1440, height: 900});
  assert.deepEqual(definition.viewports.mobile, {width: 390, height: 844});
  assert.ok(definition.global_release_gates.some((gate) => gate.includes("continuous normal-speed")));
  assert.ok(definition.global_release_gates.some((gate) => gate.includes("no Muster integration edits")));
  assert.ok(definition.global_release_gates.some((gate) => gate.includes("labeled Muster cursor")));
});

test("all native surfaces have executable create, mobile, and negative boundaries", () => {
  for (const surface of ["desk", "crm", "helpdesk", "custom"]) {
    const rows = definition.scenarios.filter((scenario) => scenario.surface === surface);
    assert.ok(rows.length >= 2, surface);
    assert.ok(rows.some((scenario) => scenario.viewport === "mobile"), `${surface} mobile`);
  }
  for (const product of ["erpnext", "hrms", "crm", "helpdesk", "custom_app"]) {
    assert.ok(definition.scenarios.some((scenario) => scenario.product === product), product);
  }
  assert.ok(scenarios.has("crm-lead-update-fails-before-touch"));
  assert.ok(scenarios.has("helpdesk-ticket-update-fails-before-touch"));
});

test("native creates prove absence before the one commit and presence afterwards", () => {
  const creates = definition.scenarios.filter((scenario) => scenario.operation === "create");
  assert.ok(creates.length >= 5);
  for (const scenario of creates) {
    assert.ok(before(scenario, "expect_takeover", "expect_native_pause"), scenario.id);
    assert.ok(before(scenario, "expect_native_pause", "independent_read_absent"), scenario.id);
    assert.ok(before(scenario, "independent_read_absent", "confirm_native_commit"), scenario.id);
    assert.ok(before(scenario, "confirm_native_commit", "independent_read_present"), scenario.id);
  }
});

test("inline auto-save surfaces fail before interaction and stale custom work fails after the race", () => {
  for (const id of ["crm-lead-update-fails-before-touch", "helpdesk-ticket-update-fails-before-touch"]) {
    const scenario = scenarios.get(id);
    assert.deepEqual(scenario.steps.slice(-2), ["expect_fail_closed", "independent_read_unchanged"]);
    assert.equal(scenario.steps.includes("expect_takeover"), false);
    assert.equal(scenario.steps.includes("confirm_native_commit"), false);
  }
  const stale = scenarios.get("custom-spa-stale-update-mobile");
  assert.ok(before(stale, "expect_native_pause", "second_session_mutate"));
  assert.ok(before(stale, "second_session_mutate", "expect_fail_closed"));
  assert.equal(stale.steps.at(-1), "independent_read_second_session_value");
});
