import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs, isForbiddenFixtureRequest, validateScenarioObservation } from "../vinman-live-recorder.mjs";
import { VINMAN_SCENARIO_IDS, VINMAN_SCENARIOS } from "../vinman-live-scenarios.mjs";
import { VINMAN_RECEIPT_ATTRIBUTES, VINMAN_SELECTORS } from "../vinman-live-selectors.mjs";

test("the recorder defines the four canonical Vinman scenarios plus the support retake", () => {
  assert.deepEqual(VINMAN_SCENARIO_IDS, [
    "revision-escape",
    "guided-workflow",
    "authorized-customization-repair",
    "customization-support",
    "v16-migration",
  ]);
  assert.equal(new Set(VINMAN_SCENARIOS.map((scenario) => scenario.prompt)).size, 5);
  const expectedRoutes = {
    "revision-escape": "/desk/bom",
    "guided-workflow": "/desk/muster-control",
    "authorized-customization-repair": "/desk/control-plan",
    "customization-support": "/desk/control-plan",
    "v16-migration": "/desk",
  };
  for (const scenario of VINMAN_SCENARIOS) {
    assert.equal(scenario.route, expectedRoutes[scenario.id]);
    assert.ok(scenario.requiredVisiblePatterns.length >= 3, scenario.id);
    assert.ok(scenario.requiredReceiptPatterns.length >= 2, scenario.id);
  }
  const repair = VINMAN_SCENARIOS.find((scenario) => scenario.id === "authorized-customization-repair");
  assert.equal(repair.recordName, "MUSTER-DEMO-CP-002");
  assert.match(repair.expectedError, /Only revision A/);
});

test("stable browser selectors scope evidence and receipts to the scenario", () => {
  assert.match(VINMAN_SELECTORS.muster.prompt, /data-muster-prompt/);
  assert.match(VINMAN_SELECTORS.muster.assistantMessages, /data-muster-message/);
  assert.match(VINMAN_SELECTORS.muster.waitingTakeover, /data-muster-takeover/);
  assert.match(VINMAN_SELECTORS.muster.approve, /data-muster-approve/);
  assert.equal(
    VINMAN_SELECTORS.muster.launch("authorized-customization-repair"),
    "[data-muster-handoff-kind='customization_repair']",
  );
  const evidence = VINMAN_SELECTORS.muster.evidence("v16-migration");
  const receipt = VINMAN_SELECTORS.muster.receipt("v16-migration");
  assert.match(evidence, /data-muster-evidence/);
  assert.match(evidence, /data-muster-scenario='v16-migration'/);
  assert.match(receipt, /data-muster-receipt/);
  assert.match(receipt, /data-muster-scenario='v16-migration'/);
  assert.equal(VINMAN_RECEIPT_ATTRIBUTES.id, "data-muster-receipt-id");
  assert.equal(VINMAN_RECEIPT_ATTRIBUTES.status, "data-muster-receipt-status");
});

test("argument parsing is explicit and does not require live recording", () => {
  const parsed = parseArgs(["--scenario", "v16-migration", "--out", "tmp/vinman", "--timeout", "12000", "--headed"]);
  assert.equal(parsed.scenario, "v16-migration");
  assert.equal(parsed.timeoutMs, 12000);
  assert.equal(parsed.headed, true);
  assert.throws(() => parseArgs(["--scenario", "unknown"]), /Unknown scenario/);
  assert.throws(() => parseArgs(["--headed", "--no-live"]), /Unknown argument/);
});

test("fixture setup, fault, correction, and reset requests are rejected by the recorder guard", () => {
  assert.equal(isForbiddenFixtureRequest("https://demo.test/api/method/muster.demo.vinman_engineering_demo.additional_scenario_correct"), true);
  assert.equal(isForbiddenFixtureRequest("https://demo.test/api/method/muster.demo.vinman_engineering_demo.additional_scenario_reset"), true);
  assert.equal(isForbiddenFixtureRequest("https://demo.test/api/method/muster.api.mission.review_proposal"), false);
});

function passingObservation(scenario) {
  return {
    assistantMessages: ["Muster found a visible scenario result."],
    scenarioEvidence: [scenario.requiredVisiblePatterns.map((item) => item.source).join(" ")],
    takeover: {visible: true, waiting: true, text: "Review and approve this action"},
    approvalClicked: true,
    receipt: {
      visible: true,
      id: `receipt-${scenario.id}`,
      scenario: scenario.id,
      status: "verified",
      text: `${scenario.requiredReceiptPatterns.map((item) => item.source).join(" ")} Verified`,
    },
    forbiddenRequests: [],
    followUpVisible: false,
  };
}

test("scenario validation fails closed for missing visible proof and accepts complete proof", () => {
  const scenario = VINMAN_SCENARIOS[0];
  assert.equal(validateScenarioObservation(scenario, passingObservation(scenario)), true);
  assert.throws(
    () => validateScenarioObservation(scenario, {...passingObservation(scenario), scenarioEvidence: []}),
    /no scenario-scoped visible evidence/,
  );
  assert.throws(
    () => validateScenarioObservation(scenario, {...passingObservation(scenario), receipt: null}),
    /scenario-scoped receipt/,
  );
  assert.throws(
    () => validateScenarioObservation(scenario, {...passingObservation(scenario), forbiddenRequests: ["fixture"]}),
    /fixture correction request/,
  );
});

test("customization repair requires a live business-form re-test before restoration counts", () => {
  const scenario = VINMAN_SCENARIOS.find((item) => item.id === "authorized-customization-repair");
  const observation = {
    ...passingObservation(scenario),
    receipt: {
      visible: true,
      id: "restoration-receipt",
      scenario: scenario.id,
      status: "restored",
      text: "Original Client Script restored and independently verified",
    },
    repairReceipt: {status: "verified", text: "repair verified"},
    restorationReceipt: {status: "restored", text: "original script restored"},
    businessRetestCompleted: true,
  };
  assert.equal(validateScenarioObservation(scenario, observation), true);
  assert.throws(
    () => validateScenarioObservation(scenario, {...observation, businessRetestCompleted: false}),
    /did not repeat and verify the affected business-form Save/,
  );
});
