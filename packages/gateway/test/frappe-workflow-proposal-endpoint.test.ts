import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultConfig } from "@musterhq/core";
import {
  TRUSTED_FRAPPE_WORKFLOW_PROPOSALS_PATH,
  createFrappeRunCsrfProof,
  defaultFrappeWorkflowPlanner,
  initGatewayConfig,
  startGatewayServer,
} from "../src/index.js";

const authority = { tenantId: "tenant-planner", siteId: "site-planner", userId: "planner@example.test" };

function requestHeaders(token: string, withIdempotency = true): Record<string, string> {
  const csrf = "planner-csrf-token";
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-frappe-tenant-id": authority.tenantId,
    "x-frappe-site-id": authority.siteId,
    "x-frappe-user-id": authority.userId,
    "x-frappe-csrf-token": csrf,
    "x-muster-csrf-proof": createFrappeRunCsrfProof(token, csrf, authority),
    ...(withIdempotency ? { "idempotency-key": "workflow-plan-1" } : {}),
  };
}

const request = {
  schemaVersion: 1,
  requestId: "workflow-plan-1",
  objective: "Review overdue invoices",
  context: { route: "List/Sales Invoice" },
  allowedCapabilities: ["frappe.invoice.read"],
};

test("trusted planning endpoint fails closed and returns only inert JSON", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-workflow-plan-"));
  const initialized = await initGatewayConfig(cwd);
  const running = await startGatewayServer({
    config: defaultConfig(), gateway: initialized.config, cwd,
    frappeWorkflowPlanner: defaultFrappeWorkflowPlanner,
  }, 0);
  const url = `http://127.0.0.1:${running.port}${TRUSTED_FRAPPE_WORKFLOW_PROPOSALS_PATH}`;
  try {
    const untrusted = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
    assert.equal(untrusted.status, 401);

    const missingIdempotency = await fetch(url, { method: "POST", headers: requestHeaders(initialized.config.token, false), body: JSON.stringify(request) });
    assert.equal(missingIdempotency.status, 400);

    const planned = await fetch(url, { method: "POST", headers: requestHeaders(initialized.config.token), body: JSON.stringify(request) });
    assert.equal(planned.status, 200);
    const response = await planned.json() as Record<string, unknown>;
    assert.equal(response.status, "proposed");
    assert.equal(typeof response.proposal, "object");
    assert.equal(typeof response.graph, "object");
    assert.equal((response.graph as Record<string, unknown>).schemaVersion, 1);
    assert.equal(JSON.stringify(response).includes("export default"), false);
  } finally {
    await running.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("planning endpoint rejects capability escalation from a planner", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-workflow-escalation-"));
  const initialized = await initGatewayConfig(cwd);
  const running = await startGatewayServer({
    config: defaultConfig(), gateway: initialized.config, cwd,
    frappeWorkflowPlanner: async (input) => ({
      schemaVersion: 1, id: "unsafe.workflow", version: "1", meta: { name: "Unsafe", description: "Unsafe", phases: [{ title: "Write" }] }, goal: input.objective,
      resultSchema: { type: "object" }, budget: { runtimeMs: 1000, toolCalls: 1, modelCalls: 1, tokens: 10, costMicros: 10, artifactBytes: 10 },
      limits: { maxDepth: 2, maxChildrenPerNode: 2, maxActiveNodes: 2, maxRetries: 1 },
      steps: [{ kind: "agent", label: "Escalate", prompt: "Write records", capabilities: ["frappe.invoice.write"] }],
    }),
  }, 0);
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}${TRUSTED_FRAPPE_WORKFLOW_PROPOSALS_PATH}`, {
      method: "POST", headers: requestHeaders(initialized.config.token), body: JSON.stringify(request),
    });
    assert.equal(response.status, 403);
  } finally {
    await running.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
