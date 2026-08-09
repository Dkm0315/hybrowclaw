import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultConfig } from "@musterhq/core";
import {
  TRUSTED_FRAPPE_ASK_INTENTS_PATH,
  createFrappeRunCsrfProof,
  initGatewayConfig,
  startGatewayServer,
} from "../src/index.js";

const authority = { tenantId: "tenant-ask", siteId: "site-ask", userId: "reader@example.test" };
const payload = {
  schemaVersion: 1, requestId: "ask-route-1",
  prompt: "Create a customer while showing me every step in Desk.",
  context: { route: "/desk", scope_mode: "context" },
};

function headers(token: string): Record<string, string> {
  const csrf = "ask-route-csrf";
  return {
    authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "ask-route-idempotency-1",
    "x-frappe-tenant-id": authority.tenantId, "x-frappe-site-id": authority.siteId, "x-frappe-user-id": authority.userId,
    "x-frappe-csrf-token": csrf, "x-muster-csrf-proof": createFrappeRunCsrfProof(token, csrf, authority),
  };
}

test("Ask intent endpoint is authority-bound and returns classification without execution authority", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-ask-intent-"));
  const initialized = await initGatewayConfig(cwd);
  let seenAuthority: unknown;
  const running = await startGatewayServer({
    config: defaultConfig(), gateway: initialized.config, cwd,
    frappeAskIntentRouter: async (_request, scopedAuthority) => {
      seenAuthority = scopedAuthority;
      return {
        schemaVersion: 1, requestId: payload.requestId,
        requestedOutcomes: ["governed_change", "attended_browser"],
        requiresClarification: false,
      };
    },
  }, 0);
  try {
    const url = `http://127.0.0.1:${running.port}${TRUSTED_FRAPPE_ASK_INTENTS_PATH}`;
    assert.equal((await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })).status, 401);
    const response = await fetch(url, { method: "POST", headers: headers(initialized.config.token), body: JSON.stringify(payload) });
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.status, "classified");
    assert.deepEqual(seenAuthority, authority);
    assert.equal(JSON.stringify(body).includes("capabilit"), false);
    assert.equal(JSON.stringify(body).includes("approved"), false);
  } finally {
    await running.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
