import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dataDir } from "@musterhq/core";
import { FrappeSiteBindingCoordinator, initGatewayConfig } from "@musterhq/gateway";
import { runFrappeConnectCommand } from "../src/frappe-connect-command.js";

const site = "https://erp.example.test";
const muster = "https://gateway.example.test";
const siteUuid = "fbd2c590-6a24-4ee6-85a6-9fc7e3b7063e";

function discoveryBody(origin = site, connectionState: "trusted" | "setup_required" = "setup_required"): Record<string, unknown> {
  return { message: {
    product: "Muster for Frappe", protocol_version: "1.0", https_required: true,
    muster_version: "0.1.0", frappe_version: "16.27.1", site_origin: origin,
    connection_state: connectionState,
    flows: ["oauth_pkce", "api_credentials"],
    capabilities: ["frappe.identity.live", "frappe.permissions.live"],
  } };
}

function healthyFetcher(overrides: { discovery?: Response; health?: Response } = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    assert.equal(init?.redirect, "manual");
    if (url.endsWith("/v1/health")) return overrides.health ?? new Response(JSON.stringify({ ok: true, service: "muster-gateway" }), { status: 200 });
    if (url.endsWith("/api/method/muster.api.onboarding.discovery")) return overrides.discovery ?? new Response(JSON.stringify(discoveryBody()), { status: 200 });
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;
}

async function seedVerifiedBinding(cwd: string): Promise<{ accessToken: string; hmacSecret: string; webhookSecret: string }> {
  const gateway = await initGatewayConfig(cwd);
  const coordinator = new FrappeSiteBindingCoordinator({
    storePath: join(dataDir(cwd), "frappe-site-bindings.v1.enc.json"),
    encryptionSecret: gateway.config.token,
  });
  const verifier = "v".repeat(64);
  const authorize = new URL("/v1/frappe/site-bindings/authorize", muster);
  authorize.search = new URLSearchParams({
    response_type: "code", client_id: "frappe-site-bootstrap", redirect_uri: `${site}/muster-connect`,
    state: "s".repeat(64), code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256", site_origin: site,
  }).toString();
  const code = new URL(coordinator.authorize(authorize)).searchParams.get("code");
  const exchange = await coordinator.exchange({
    grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: `${site}/muster-connect`,
    site_origin: site, site_uuid: siteUuid, site_challenge: "site-challenge-1234567890",
  });
  coordinator.verify(exchange.access_token!, {
    binding_id: exchange.binding_id, tenant_id: exchange.tenant_id, site_uuid: siteUuid, site_origin: site,
    site_challenge: "site-challenge-1234567890", gateway_challenge: exchange.gateway_challenge,
  });
  return { accessToken: exchange.access_token!, hmacSecret: exchange.hmac_secret!, webhookSecret: exchange.webhook_secret! };
}

test("frappe connect discovers the installed app, inspects readiness, and opens native consent", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-cli-frappe-connect-"));
  let opened = "";
  const logs: string[] = [];
  const result = await runFrappeConnectCommand({
    cwd, site, musterOrigin: muster, fetcher: healthyFetcher(),
    openUrl: async (url) => { opened = url; }, log: (line) => logs.push(line), tty: false,
  });
  assert.equal(opened, `${site}/muster-connect?gateway_url=https%3A%2F%2Fgateway.example.test`);
  assert.equal(result.onboardingUrl, opened);
  assert.equal(result.connected, false);
  assert.equal(result.browserOpened, true);
  assert.deepEqual(result.flows, ["oauth_pkce", "api_credentials"]);
  assert.match(logs.join("\n"), /gateway reachable over HTTPS/);
  assert.match(logs.join("\n"), /Consent is pending/);
  assert.doesNotMatch(logs.join("\n"), /access_token|api_secret|hmac_secret|code_verifier/i);
  const config = JSON.parse(await readFile(join(cwd, ".muster", "gateway.json"), "utf8"));
  assert.equal(config.frappe.publicOrigin, muster);
  assert.match(config.frappe.installationId, /^muster-[a-f0-9]{24}$/);
});

test("TTY onboarding resumes a verified binding and reports tenant/site/fingerprint without secrets", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-cli-frappe-resume-"));
  const secrets = await seedVerifiedBinding(cwd);
  const logs: string[] = [];
  let opened = false;
  const result = await runFrappeConnectCommand({
    cwd, site, musterOrigin: muster,
    fetcher: healthyFetcher({ discovery: new Response(JSON.stringify(discoveryBody(site, "trusted")), { status: 200 }) }),
    tty: true, color: false,
    openUrl: async () => { opened = true; }, log: (line) => logs.push(line),
  });
  assert.equal(opened, false);
  assert.equal(result.connected, true);
  assert.equal(result.binding?.siteUuid, siteUuid);
  assert.match(result.binding?.trustFingerprint ?? "", /^sha256:/);
  const transcript = logs.join("\n");
  assert.match(transcript, /Existing reciprocal trust resumed/);
  assert.match(transcript, /◆ CONNECTED/);
  assert.match(transcript, /Tenant\s+tenant-/);
  assert.match(transcript, /Fingerprint\s+sha256:/);
  for (const secret of Object.values(secrets)) assert.equal(transcript.includes(secret), false);
});

test("a stale gateway-only binding cannot claim the Frappe site is connected", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-cli-frappe-asymmetric-"));
  await seedVerifiedBinding(cwd);
  const logs: string[] = [];
  let opened = "";
  const result = await runFrappeConnectCommand({
    cwd, site, musterOrigin: muster, fetcher: healthyFetcher(), tty: false, color: false,
    openUrl: async (url) => { opened = url; }, log: (line) => logs.push(line),
  });
  assert.equal(result.connected, false);
  assert.equal(opened, result.onboardingUrl);
  assert.match(logs.join("\n"), /Gateway trust exists but Frappe does not confirm it; fresh consent required/);
  assert.doesNotMatch(logs.join("\n"), /◆ CONNECTED/);
});

test("interactive wait reports connected only after the verified binding appears", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-cli-frappe-poll-"));
  const logs: string[] = [];
  let sleepCalls = 0;
  let qrValue = "";
  let siteTrusted = false;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    assert.equal(init?.redirect, "manual");
    if (url.endsWith("/v1/health")) return new Response(JSON.stringify({ ok: true, service: "muster-gateway" }), { status: 200 });
    if (url.endsWith("/api/method/muster.api.onboarding.discovery")) {
      return new Response(JSON.stringify(discoveryBody(site, siteTrusted ? "trusted" : "setup_required")), { status: 200 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;
  const result = await runFrappeConnectCommand({
    cwd, site, musterOrigin: muster, fetcher, tty: true, color: false,
    openUrl: async () => undefined, log: (line) => logs.push(line), timeoutMs: 2_000, pollIntervalMs: 25,
    renderQr: async (value) => { qrValue = value; return "QR-ROW-1\nQR-ROW-2\n"; },
    sleep: async () => { sleepCalls += 1; if (sleepCalls === 1) { await seedVerifiedBinding(cwd); siteTrusted = true; } },
  });
  assert.equal(result.connected, true);
  assert.equal(sleepCalls, 1);
  assert.equal(qrValue, result.onboardingUrl);
  const transcript = logs.join("\n");
  assert.match(transcript, /Scan on your phone:\n\s+QR-ROW-1/);
  assert.ok(transcript.indexOf("Wait for reciprocal trust") < transcript.indexOf("◆ CONNECTED"));
});

test("browser-open failure keeps a safe phone/manual deep link and continues without claiming trust", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-cli-frappe-browser-failure-"));
  const logs: string[] = [];
  const result = await runFrappeConnectCommand({
    cwd, site, musterOrigin: muster, fetcher: healthyFetcher(), tty: false,
    openUrl: async () => { throw new Error("launch failed with api-secret-never-log"); },
    log: (line) => logs.push(line),
  });
  assert.equal(result.connected, false);
  assert.equal(result.browserOpened, false);
  assert.match(logs.join("\n"), /use the secure link above on this computer or phone/);
  assert.match(logs.join("\n"), new RegExp(`${site}/muster-connect`));
  assert.doesNotMatch(logs.join("\n"), /api-secret-never-log/);
});

test("wait timeout and cancellation fail closed with recovery guidance", async () => {
  const timeoutCwd = await mkdtemp(join(tmpdir(), "muster-cli-frappe-timeout-"));
  let elapsed = 0;
  await assert.rejects(runFrappeConnectCommand({
    cwd: timeoutCwd, site, musterOrigin: muster, fetcher: healthyFetcher(), tty: true, color: false,
    openUrl: async () => undefined, timeoutMs: 1_000, pollIntervalMs: 25,
    now: () => 1_800_000_000_000 + elapsed,
    sleep: async () => { elapsed += 1_001; },
  }), /timed out.*Nothing was connected.*--wait/i);

  const cancelCwd = await mkdtemp(join(tmpdir(), "muster-cli-frappe-cancel-"));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runFrappeConnectCommand({
    cwd: cancelCwd, site, musterOrigin: muster, fetcher: healthyFetcher(), tty: true, color: false,
    openUrl: async () => undefined, signal: controller.signal,
  }), /cancelled.*Nothing was connected/i);
});

test("frappe connect rejects HTTP, redirects, origin mismatch, unhealthy gateway, and invalid JSON", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-cli-frappe-connect-negative-"));
  await assert.rejects(runFrappeConnectCommand({ cwd, site: "http://erp.example.test", musterOrigin: muster, openUrl: async () => undefined }), /HTTPS origin/);
  await assert.rejects(runFrappeConnectCommand({
    cwd, site, musterOrigin: muster, openUrl: async () => undefined,
    fetcher: healthyFetcher({ discovery: new Response("", { status: 302, headers: { location: "https://evil.example.test" } }) }),
  }), /refused an HTTP redirect/);
  await assert.rejects(runFrappeConnectCommand({
    cwd, site, musterOrigin: muster, openUrl: async () => undefined,
    fetcher: healthyFetcher({ discovery: new Response(JSON.stringify(discoveryBody("https://evil.example.test")), { status: 200 }) }),
  }), /origin does not match/);
  await assert.rejects(runFrappeConnectCommand({
    cwd, site, musterOrigin: muster, openUrl: async () => undefined,
    fetcher: healthyFetcher({ health: new Response(JSON.stringify({ ok: false }), { status: 200 }) }),
  }), /does not identify a healthy Muster gateway/);
  await assert.rejects(runFrappeConnectCommand({
    cwd, site, musterOrigin: muster, openUrl: async () => undefined,
    fetcher: healthyFetcher({ discovery: new Response("not-json", { status: 200 }) }),
  }), /invalid JSON/);
});
