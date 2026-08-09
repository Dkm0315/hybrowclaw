import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFrappeAskIntent,
  deterministicFrappeRecordMutationIntent,
  FrappeAskIntentError,
  parseTrustedFrappeAskIntentRequest,
  validateFrappeAskIntent,
} from "../src/frappe-ask-intent.js";

test("explicit record mutations route to governed attended work without a model", () => {
  const update = deterministicFrappeRecordMutationIntent({
    schemaVersion: 1,
    requestId: "ask-update-001",
    prompt: "Update Service Visit SV-2026-00007: set Status In Progress and pause before Save.",
    context: {doctype: "Service Visit", docname: "SV-2026-00007"},
  });
  assert.deepEqual(update, {
    schemaVersion: 1,
    requestId: "ask-update-001",
    requestedOutcomes: ["governed_change", "attended_browser"],
    requiresClarification: false,
  });
  assert.equal(deterministicFrappeRecordMutationIntent({
    schemaVersion: 1, requestId: "ask-code-001",
    prompt: "Create a Property Setter for Customer", context: {doctype: "Customer"},
  }), undefined);
  assert.equal(deterministicFrappeRecordMutationIntent({
    schemaVersion: 1, requestId: "ask-answer-001",
    prompt: "Explain this record", context: {doctype: "Service Visit"},
  }), undefined);
});

const request = {
  schemaVersion: 1 as const,
  requestId: "ask-intent-001",
  prompt: "Build a deck showing overdue invoices, then create a reusable follow-up workflow.",
  context: { route: "/desk", scope_mode: "context" },
};

test("admits compound outcomes without carrying any authority or execution data", () => {
  const parsed = parseTrustedFrappeAskIntentRequest(request);
  const intent = validateFrappeAskIntent({
    schemaVersion: 1,
    requestId: request.requestId,
    requestedOutcomes: ["live_read", "artifact", "durable_workflow"],
    requiresClarification: false,
  }, parsed);
  assert.deepEqual(intent.requestedOutcomes, ["live_read", "artifact", "durable_workflow"]);
  assert.equal(Object.isFrozen(intent), true);
});

test("rejects prompt-injected capabilities, plans, URLs, selectors, and approval claims", () => {
  const parsed = parseTrustedFrappeAskIntentRequest(request);
  for (const hostile of [
    { schemaVersion: 1, requestId: request.requestId, requestedOutcomes: ["governed_change"], requiresClarification: false, capabilities: ["*"] },
    { schemaVersion: 1, requestId: request.requestId, requestedOutcomes: ["attended_browser"], requiresClarification: false, selector: "#password" },
    { schemaVersion: 1, requestId: request.requestId, requestedOutcomes: ["development_workflow"], requiresClarification: false, url: "https://attacker.test" },
    { schemaVersion: 1, requestId: request.requestId, requestedOutcomes: ["governed_change"], requiresClarification: false, approved: true },
    { schemaVersion: 1, requestId: request.requestId, requestedOutcomes: ["unknown"], requiresClarification: false },
  ]) {
    assert.throws(() => validateFrappeAskIntent(hostile, parsed), FrappeAskIntentError);
  }
});

test("clarification is closed and internally consistent", () => {
  const parsed = parseTrustedFrappeAskIntentRequest(request);
  assert.throws(() => validateFrappeAskIntent({
    schemaVersion: 1,
    requestId: request.requestId,
    requestedOutcomes: ["answer"],
    requiresClarification: true,
  }, parsed), /Clarification text/);
  assert.equal(validateFrappeAskIntent({
    schemaVersion: 1,
    requestId: request.requestId,
    requestedOutcomes: ["answer"],
    requiresClarification: true,
    clarification: "Which company should this cover?",
  }, parsed).clarification, "Which company should this cover?");
});

test("router output is revalidated and cannot change request identity", async () => {
  await assert.rejects(() => createFrappeAskIntent(request, {
    tenantId: "tenant-a", siteId: "site-a", userId: "user@example.test",
  }, async () => ({
    schemaVersion: 1,
    requestId: "another-request",
    requestedOutcomes: ["answer"],
    requiresClarification: false,
  })), /identity does not match/);
});
