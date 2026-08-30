const pattern = (source, flags = "i") => new RegExp(source, flags);

export const VINMAN_SCENARIOS = Object.freeze([
  {
    id: "revision-escape",
    title: "Repair an engineering revision escape",
    prompt: "MUSTER-DEMO-ITEM-001 drawing changed but production still shows old work. why this happening? please fix",
    route: "/desk/bom",
    requiredVisiblePatterns: [
      pattern("Requires regeneration|Inconsistent"),
      pattern("Process Flow|PPFMEA|revision"),
      pattern("Verified"),
    ],
    requiredReceiptPatterns: [pattern("verified"), pattern("Process Flow|PPFMEA|revision")],
    approvalPattern: pattern("approve|review|save"),
  },
  {
    id: "guided-workflow",
    title: "Teach the customized workflow with human approval",
    prompt: "make and submit a new manufacturing recipe for MUSTER-DEMO-ITEM-001 using one MUSTER-DEMO-COMPONENT-001. teach me what each field and component row mean. ask before save and again before submit",
    route: "/desk/muster-control",
    requiredVisiblePatterns: [
      pattern("Blocked"),
      pattern("next|required|workflow|business step"),
      pattern("Verified|completed|complete"),
    ],
    requiredReceiptPatterns: [pattern("verified"), pattern("workflow|business step|completed")],
    approvalPattern: pattern("approve|review|save"),
  },
  {
    id: "authorized-customization-repair",
    title: "Repair a customization under role-bound approval",
    prompt: "why is this not saving? drawing B is already approved. please check and fix it",
    route: "/desk/control-plan",
    recordName: "MUSTER-DEMO-CP-002",
    expectedError: "Only revision A is permitted for this operation.",
    requiredVisiblePatterns: [
      pattern("Blocked"),
      pattern("validation|script|rule"),
      pattern("Verified|succeeds|success"),
    ],
    requiredReceiptPatterns: [pattern("restored"), pattern("original|script")],
    approvalPattern: pattern("approve|review|save"),
  },
  {
    id: "customization-support",
    title: "Escalate a customization failure with exact evidence",
    prompt: "drawing B is approved but this is still not saving. check what is wrong and send it to support",
    route: "/desk/control-plan",
    recordName: "MUSTER-DEMO-CP-002",
    expectedError: "Only revision A is permitted for this operation.",
    reproduceCustomizationError: true,
    evidenceScenario: "v16-migration",
    requiredVisiblePatterns: [
      pattern("Client Script|MUSTER-DEMO-VALIDATE-REVISED-OPERATION"),
      pattern("line\\s+4|frappe\\.throw|Only revision A"),
      pattern("support|ticket"),
    ],
    requiredReceiptPatterns: [pattern("verified"), pattern("support|ticket|HD-")],
    approvalPattern: pattern("Approve & send to support|approve|send to support"),
  },
  {
    id: "v16-migration",
    title: "Escalate a v15 to v16 migration failure",
    prompt: "this report stopped working after the update. please check what happened and send it to support",
    route: "/desk",
    searchTarget: "MUSTER-DEMO-V16-ENGINEERING-READINESS",
    expectedError: "legacy_drawing_revision",
    evidenceScenario: "v16-migration",
    requiredVisiblePatterns: [
      pattern("report stopped|MUSTER-DEMO-V16-ENGINEERING-READINESS"),
      pattern("v15|v16|schema|stale|migration"),
      pattern("support|ticket"),
      pattern("Verified|created|sent"),
    ],
    requiredReceiptPatterns: [pattern("verified"), pattern("support|ticket|HD-")],
    approvalPattern: pattern("Approve & send to support|approve|send to support"),
  },
]);

export const VINMAN_SCENARIO_IDS = Object.freeze(VINMAN_SCENARIOS.map((scenario) => scenario.id));

export function getVinmanScenario(id) {
  const scenario = VINMAN_SCENARIOS.find((candidate) => candidate.id === id);
  if (!scenario) throw new Error(`Unknown Vinman scenario: ${id}`);
  return scenario;
}
