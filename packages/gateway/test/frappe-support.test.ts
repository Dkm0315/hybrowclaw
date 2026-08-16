import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFrappeSupportDraft,
  DEFAULT_FRAPPE_SUPPORT_SITE,
  gatewayStartupErrors,
  isFrappeIssueReportRequest,
  resolveFrappeSupportDestination,
} from "../src/index.js";
import type { PairedIdentity } from "../src/pairing.js";

const identity: PairedIdentity = {
  provider: "frappe",
  site: "https://vinman.example.test",
  user: "engineer@example.test",
  userName: "NPD Engineer",
  roles: ["NPD User"],
  resolvedAt: "2026-08-15T00:00:00.000Z",
};

test("support reporting has a safe default and recognizes natural requests", () => {
  assert.equal(resolveFrappeSupportDestination().site, DEFAULT_FRAPPE_SUPPORT_SITE);
  assert.equal(resolveFrappeSupportDestination().doctype, "HD Ticket");
  assert.equal(isFrappeIssueReportRequest("Please raise this with support"), true);
  assert.equal(isFrappeIssueReportRequest("Explain this control plan"), false);
});

test("support evidence is bounded, linked, and redacts credentials", () => {
  const draft = createFrappeSupportDraft({
    prompt: "/report-issue downstream engineering records still use the previous revision",
    identity,
    context: {
      doctype: "Control Plan",
      docname: "CP-0042",
      pageName: "Control Plan CP-0042",
      summary: "Observed revision B. api_key=should-not-leak Authorization: Bearer secret-value",
    },
    config: { connectionId: "hybrow-support", priority: "High", customer: "Vinman App" },
    investigation: {
      expected: "Drawing revision B should reach production and inspection.",
      observed: "Process Flow and Quality Inspection still use revision A.",
      businessImpact: "Production could manufacture or inspect against an obsolete specification.",
      likelyLocations: ["Control Plan process table mapping", "Quality Inspection population script"],
      affectedRecords: [
        { label: "Control Plan", doctype: "Control Plan", name: "CP-0042" },
        { label: "Process Flow", doctype: "Process Flow", name: "PF-0042" },
      ],
      appVersions: { frappe: "16.27.1", vinman_app: "version-16" },
      reproduction: ["Open the revised Control Plan.", "Compare the linked Process Flow revision."],
      validation: ["lineage:Inconsistent", "permission_scope:engineer@example.test"],
      evidenceIds: ["lineage:abc123"],
    },
  });
  assert.equal(draft.destination.site, "https://support.hybrowlabs.com");
  assert.equal(draft.values.priority, "High");
  assert.equal(draft.values.customer, "Vinman App");
  assert.match(draft.description, /Control Plan CP-0042/);
  assert.match(draft.description, /https:\/\/vinman\.example\.test\/app\/control-plan\/CP-0042/);
  assert.doesNotMatch(draft.description, /should-not-leak|secret-value/);
  assert.match(draft.description, /\[redacted\]/);
  assert.match(draft.description, /Drawing revision B should reach production/);
  assert.match(draft.description, /process-flow\/PF-0042/);
  assert.match(draft.description, /lineage:Inconsistent/);
});

test("support destination rejects non-canonical or credential-bearing origins", () => {
  for (const site of [
    "http://support.example.test",
    "https://user:secret@support.example.test",
    "https://support.example.test/path",
    "https://support.example.test/?tenant=x",
  ]) {
    assert.throws(() => resolveFrappeSupportDestination({ site }));
  }
});

test("production startup rejects a missing configured support OAuth connection", () => {
  const errors = gatewayStartupErrors({
    token: "a".repeat(32),
    security: { deployment: "production" },
    frappe: { support: { connectionId: "hybrow-support" } },
  });
  assert.ok(errors.some((error) => /hybrow-support.*not configured/i.test(error)));
});
