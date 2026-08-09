import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FRAPPE_SITE_AUTHORIZE_PATH,
  FrappeSiteBindingCoordinator,
} from "../src/frappe-connect.js";

const siteOrigin = "https://erp.example.test";
const siteUuid = "fbd2c590-6a24-4ee6-85a6-9fc7e3b7063e";

test("OAuth PKCE exchange and reciprocal verification are exact, one-shot, and tenant bound", async () => {
  let now = 1_800_000_000_000;
  const coordinator = new FrappeSiteBindingCoordinator({ now: () => now });
  const verifier = "v".repeat(64);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = "s".repeat(64);
  const authorize = new URL(FRAPPE_SITE_AUTHORIZE_PATH, "https://gateway.example.test");
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: "frappe-site-bootstrap",
    redirect_uri: `${siteOrigin}/muster-connect`,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    site_origin: siteOrigin,
  }).toString();
  const redirect = new URL(coordinator.authorize(authorize));
  assert.throws(() => coordinator.authorize(authorize), /state was already used/i);
  assert.equal(redirect.origin, siteOrigin);
  assert.equal(redirect.pathname, "/muster-connect");
  assert.equal(redirect.searchParams.get("state"), state);
  const code = redirect.searchParams.get("code");
  assert.ok(code);

  const exchange = await coordinator.exchange({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: `${siteOrigin}/muster-connect`,
    site_origin: siteOrigin,
    site_uuid: siteUuid,
    site_challenge: "site-challenge-1234567890",
  });
  assert.ok(exchange.access_token);
  assert.ok(exchange.hmac_secret);
  assert.ok(exchange.webhook_secret);
  assert.match(exchange.tenant_id!, /^tenant-/);
  assert.match(exchange.binding_id!, /^binding-/);
  assert.match(exchange.trust_fingerprint!, /^sha256:/);
  assert.throws(() => coordinator.authorization(exchange.access_token!), /invalid/i, "pending trust must not authorize jobs");

  const verified = coordinator.verify(exchange.access_token!, {
    binding_id: exchange.binding_id,
    tenant_id: exchange.tenant_id,
    site_uuid: siteUuid,
    site_origin: siteOrigin,
    site_challenge: "site-challenge-1234567890",
    gateway_challenge: exchange.gateway_challenge,
  });
  assert.deepEqual(verified, {
    verified: true,
    site_challenge: "site-challenge-1234567890",
    gateway_challenge: exchange.gateway_challenge,
    tenant_id: exchange.tenant_id,
    binding_id: exchange.binding_id,
    trust_fingerprint: exchange.trust_fingerprint,
  });
  assert.equal(coordinator.authorization(exchange.access_token!).siteUuid, siteUuid);
  await assert.rejects(coordinator.exchange({
    grant_type: "authorization_code", code, code_verifier: verifier,
    redirect_uri: `${siteOrigin}/muster-connect`, site_origin: siteOrigin,
    site_uuid: siteUuid, site_challenge: "another-site-challenge",
  }), /already used|invalid/i);

  now += 1;
});

test("authorize and exchange fail closed on HTTP, redirect/origin mismatch, bad PKCE, expiry, and challenge mismatch", async () => {
  let now = 1_800_000_000_000;
  const coordinator = new FrappeSiteBindingCoordinator({ now: () => now });
  let sequence = 0;
  const make = (overrides: Record<string, string> = {}) => {
    sequence += 1;
    const verifier = "w".repeat(64);
    const url = new URL(FRAPPE_SITE_AUTHORIZE_PATH, "https://gateway.example.test");
    url.search = new URLSearchParams({
      response_type: "code", client_id: "frappe-site-bootstrap",
      redirect_uri: `${siteOrigin}/muster-connect`, state: `${String(sequence).padStart(2, "0")}${"x".repeat(62)}`,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256", site_origin: siteOrigin, ...overrides,
    }).toString();
    return { verifier, url };
  };
  assert.throws(() => coordinator.authorize(make({ site_origin: "http://erp.example.test" }).url), /HTTPS origin/i);
  assert.throws(() => coordinator.authorize(make({ redirect_uri: "https://evil.example.test/muster-connect" }).url), /exact Frappe/i);
  assert.throws(() => coordinator.authorize(make({ code_challenge_method: "plain" }).url), /S256/i);

  const wrongPkce = make();
  const wrongPkceCode = new URL(coordinator.authorize(wrongPkce.url)).searchParams.get("code");
  await assert.rejects(coordinator.exchange({
    grant_type: "authorization_code", code: wrongPkceCode, code_verifier: "z".repeat(64),
    redirect_uri: `${siteOrigin}/muster-connect`, site_origin: siteOrigin, site_uuid: siteUuid,
    site_challenge: "site-challenge-1234567890",
  }), /PKCE/);

  const expired = make();
  const expiredCode = new URL(coordinator.authorize(expired.url)).searchParams.get("code");
  now += 5 * 60_000 + 1;
  await assert.rejects(coordinator.exchange({
    grant_type: "authorization_code", code: expiredCode, code_verifier: expired.verifier,
    redirect_uri: `${siteOrigin}/muster-connect`, site_origin: siteOrigin, site_uuid: siteUuid,
    site_challenge: "site-challenge-1234567890",
  }), /expired|invalid/i);

  const fresh = make();
  const freshCode = new URL(coordinator.authorize(fresh.url)).searchParams.get("code");
  const exchange = await coordinator.exchange({
    grant_type: "authorization_code", code: freshCode, code_verifier: fresh.verifier,
    redirect_uri: `${siteOrigin}/muster-connect`, site_origin: siteOrigin, site_uuid: siteUuid,
    site_challenge: "site-challenge-1234567890",
  });
  assert.throws(() => coordinator.verify(exchange.access_token!, {
    binding_id: exchange.binding_id, tenant_id: exchange.tenant_id, site_uuid: siteUuid,
    site_origin: siteOrigin, site_challenge: "wrong-site-challenge", gateway_challenge: exchange.gateway_challenge,
  }), /verification failed/i);
  assert.throws(() => coordinator.authorization(exchange.access_token!), /invalid/i);
});

test("API credential fallback validates against the exact HTTPS site without redirects and never returns inputs", async () => {
  const seen: Array<{ url: string; authorization?: string; redirect?: RequestRedirect }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") ?? undefined, redirect: init?.redirect });
    return new Response(JSON.stringify({ message: "Administrator" }), { status: 200 });
  }) as typeof fetch;
  const coordinator = new FrappeSiteBindingCoordinator({ fetcher });
  const exchange = await coordinator.exchangeApiCredentials({
    grant_type: "api_credentials", api_key: "api-key", api_secret: "api-secret",
    nonce: "n".repeat(64), site_origin: siteOrigin, site_uuid: siteUuid,
    site_challenge: "site-challenge-1234567890",
  });
  assert.equal(seen[0]?.url, `${siteOrigin}/api/method/frappe.auth.get_logged_user`);
  assert.equal(seen[0]?.authorization, "token api-key:api-secret");
  assert.equal(seen[0]?.redirect, "manual");
  assert.equal(JSON.stringify(exchange).includes("api-key"), false);
  assert.equal(JSON.stringify(exchange).includes("api-secret"), false);
  await assert.rejects(coordinator.exchangeApiCredentials({
    grant_type: "api_credentials", api_key: "api-key", api_secret: "api-secret",
    nonce: "n".repeat(64), site_origin: siteOrigin, site_uuid: siteUuid,
    site_challenge: "site-challenge-replay-123",
  }), /nonce was already used/i);

  const redirecting = new FrappeSiteBindingCoordinator({
    fetcher: (async () => new Response("", { status: 302, headers: { location: "https://evil.example.test" } })) as typeof fetch,
  });
  await assert.rejects(redirecting.exchangeApiCredentials({
    grant_type: "api_credentials", api_key: "api-key", api_secret: "api-secret",
    nonce: "r".repeat(64), site_origin: siteOrigin, site_uuid: siteUuid,
    site_challenge: "site-challenge-1234567890",
  }), /refused a redirect/i);
});

test("verified bindings and one-shot code consumption survive restart in an encrypted private registry", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-binding-store-"));
  const storePath = join(cwd, "bindings.enc.json");
  const options = { storePath, encryptionSecret: "gateway-secret-that-is-long-enough-for-derivation" };
  const verifier = "q".repeat(64);
  const authorize = new URL(FRAPPE_SITE_AUTHORIZE_PATH, "https://gateway.example.test");
  authorize.search = new URLSearchParams({
    response_type: "code", client_id: "frappe-site-bootstrap",
    redirect_uri: `${siteOrigin}/muster-connect`, state: "s".repeat(64),
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256", site_origin: siteOrigin,
  }).toString();
  const first = new FrappeSiteBindingCoordinator(options);
  const code = new URL(first.authorize(authorize)).searchParams.get("code");
  const exchange = await first.exchange({
    grant_type: "authorization_code", code, code_verifier: verifier,
    redirect_uri: `${siteOrigin}/muster-connect`, site_origin: siteOrigin, site_uuid: siteUuid,
    site_challenge: "durable-site-challenge-123",
  });
  first.verify(exchange.access_token!, {
    binding_id: exchange.binding_id, tenant_id: exchange.tenant_id, site_uuid: siteUuid,
    site_origin: siteOrigin, site_challenge: "durable-site-challenge-123", gateway_challenge: exchange.gateway_challenge,
  });
  const second = new FrappeSiteBindingCoordinator(options);
  assert.equal(second.authorization(exchange.access_token!).bindingId, exchange.binding_id);
  await assert.rejects(second.exchange({
    grant_type: "authorization_code", code, code_verifier: verifier,
    redirect_uri: `${siteOrigin}/muster-connect`, site_origin: siteOrigin, site_uuid: siteUuid,
    site_challenge: "replay-challenge-123456",
  }), /already used|invalid/i);
  const raw = await readFile(storePath, "utf8");
  assert.equal(raw.includes(exchange.access_token!), false);
  assert.equal(raw.includes(exchange.hmac_secret!), false);
  assert.equal((await stat(storePath)).mode & 0o077, 0);
});
