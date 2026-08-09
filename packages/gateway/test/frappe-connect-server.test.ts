import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfig } from "@musterhq/core";
import { FrappeSiteBindingCoordinator, initGatewayConfig, startGatewayServer } from "../src/index.js";

test("HTTP gateway exposes the exact Frappe bootstrap, exchange, and verify contract", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-binding-http-"));
  const gateway = await initGatewayConfig(cwd);
  const coordinator = new FrappeSiteBindingCoordinator();
  const running = await startGatewayServer({ config: defaultConfig(), gateway: gateway.config, cwd, frappeSiteBindings: coordinator }, 0);
  const base = `http://127.0.0.1:${running.port}`;
  const site = "https://erp.example.test";
  const verifier = "p".repeat(64);
  const authorize = new URL("/v1/frappe/site-bindings/authorize", base);
  authorize.search = new URLSearchParams({
    response_type: "code", client_id: "frappe-site-bootstrap",
    redirect_uri: `${site}/muster-connect`, state: "s".repeat(64),
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256", site_origin: site,
  }).toString();
  try {
    const authorized = await fetch(authorize, { redirect: "manual" });
    assert.equal(authorized.status, 302);
    assert.equal(authorized.headers.get("cache-control"), "no-store");
    const redirect = new URL(authorized.headers.get("location")!);
    const exchangeResponse = await fetch(`${base}/v1/frappe/site-bindings/exchange`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code", code: redirect.searchParams.get("code"), code_verifier: verifier,
        redirect_uri: `${site}/muster-connect`, site_origin: site,
        site_uuid: "fbd2c590-6a24-4ee6-85a6-9fc7e3b7063e", site_challenge: "site-challenge-1234567890",
      }),
    });
    assert.equal(exchangeResponse.status, 200);
    assert.equal(exchangeResponse.headers.get("cache-control"), "private, no-store");
    const exchange = await exchangeResponse.json() as Record<string, string>;
    const verifyResponse = await fetch(`${base}/v1/frappe/site-bindings/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${exchange.access_token}` },
      body: JSON.stringify({
        binding_id: exchange.binding_id, tenant_id: exchange.tenant_id,
        site_uuid: "fbd2c590-6a24-4ee6-85a6-9fc7e3b7063e", site_origin: site,
        site_challenge: "site-challenge-1234567890", gateway_challenge: exchange.gateway_challenge,
      }),
    });
    assert.equal(verifyResponse.status, 200);
    assert.equal((await verifyResponse.json() as { verified: boolean }).verified, true);

    const generic = await fetch(`${base}/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${exchange.access_token}` }, body: "{}",
    });
    assert.equal(generic.status, 401, "site bearer must not become the deployment bearer");
    const wrongSite = await fetch(`${base}/v1/integrations/frappe/messages/async`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${exchange.access_token}` },
      body: JSON.stringify({
        message: { surfaceId: "frappe:evil", conversationId: "c1", senderId: "Administrator", text: "hello" },
        identity: { site: "https://evil.example.test", user: "Administrator", roles: ["System Manager"], authMode: "frappe_session" },
        context: {},
      }),
    });
    assert.equal(wrongSite.status, 403, "verified bearer stays pinned to the registered site origin");

    const replay = await fetch(`${base}/v1/frappe/site-bindings/exchange`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code", code: redirect.searchParams.get("code"), code_verifier: verifier }),
    });
    assert.equal(replay.status, 400);
  } finally {
    await running.close();
  }
});
