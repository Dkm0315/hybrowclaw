import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultConfig } from "@musterhq/core";
import {
  TRUSTED_FRAPPE_READ_PLANS_PATH,
  createFrappeRunCsrfProof,
  initGatewayConfig,
  startGatewayServer,
} from "../src/index.js";

const authority = { tenantId: "tenant-read", siteId: "site-read", userId: "reader@example.test" };
const payload = {
  schemaVersion: 1, requestId: "read-endpoint-1", question: "List overdue invoices",
  catalog: [{ doctype: "Sales Invoice", fields: ["name", "status"] }], context: { route: "/app/home" },
};

function headers(token: string): Record<string, string> {
  const csrf = "read-csrf";
  return {
    authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "read-endpoint-plan-1",
    "x-frappe-tenant-id": authority.tenantId, "x-frappe-site-id": authority.siteId, "x-frappe-user-id": authority.userId,
    "x-frappe-csrf-token": csrf, "x-muster-csrf-proof": createFrappeRunCsrfProof(token, csrf, authority),
  };
}

test("read planning endpoint is site/user signed and returns inert IR only", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-read-plan-"));
  const initialized = await initGatewayConfig(cwd);
  const running = await startGatewayServer({
    config: defaultConfig(), gateway: initialized.config, cwd,
    frappeReadPlanner: async () => ({
      schemaVersion: 1, requestId: "read-endpoint-1", disposition: "query", reason: "Fresh invoice evidence is required.",
      queries: [{ doctype: "Sales Invoice", fields: ["name"], filters: [{ field: "status", operator: "=", value: "Overdue" }], orderBy: [], limit: 20 }],
    }),
  }, 0);
  try {
    const url = `http://127.0.0.1:${running.port}${TRUSTED_FRAPPE_READ_PLANS_PATH}`;
    assert.equal((await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })).status, 401);
    const response = await fetch(url, { method: "POST", headers: headers(initialized.config.token), body: JSON.stringify(payload) });
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.status, "planned");
    assert.equal(JSON.stringify(body).includes("select *"), false);
  } finally {
    await running.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
