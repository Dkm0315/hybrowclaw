import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FrappeOAuthCoordinator, inspectFrappeOAuthConnection } from "../src/frappe-oauth.js";

test("gateway OAuth callback is PKCE-bound, identity-scoped, encrypted, and one-shot", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-oauth-"));
  const credentialFile = join(cwd, "oauth.json");
  await writeFile(credentialFile, `${JSON.stringify({
    site: "https://erp.example.test",
    clientId: "client-1",
    clientSecret: "secret-1",
    redirectUri: "https://muster.example.test/frappe2/oauth/callback",
  })}\n`, { mode: 0o600 });
  const requests: Array<{ url: string; body?: string }> = [];
  const profileRoles = ["All", "Employee", ...Array.from({ length: 232 }, (_, index) => `Custom Role ${index + 1}`)];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.endsWith("/api/method/frappe.integrations.oauth2.get_token")) {
      return new Response(JSON.stringify({ access_token: "access-1", refresh_token: "refresh-1", token_type: "Bearer", expires_in: 3600 }), { status: 200 });
    }
    if (url.endsWith("/api/method/frappe.integrations.oauth2.openid_profile")) {
      return new Response(JSON.stringify({ email: "person@example.test", name: "Test Person", roles: profileRoles, iss: "http://erp.example.test" }), { status: 200 });
    }
    if (url.includes("/api/resource/Employee?")) {
      return new Response(JSON.stringify({ data: [{ name: "EMP-0001", employee_name: "Test Person", department: "DEP-001", company: "Example", status: "Active", reports_to: "EMP-0002" }] }), { status: 200 });
    }
    if (url.includes("frappe.client.get_value") && url.includes("Department")) {
      return new Response(JSON.stringify({ message: { name: "DEP-001", department_name: "People Operations" } }), { status: 200 });
    }
    if (url.includes("frappe.client.get_value") && url.includes("Employee")) {
      return new Response(JSON.stringify({ message: { name: "EMP-0002", employee_name: "Manager Person" } }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
  }) as typeof fetch;
  const coordinator = new FrappeOAuthCoordinator({
    cwd,
    fetcher,
    connections: [{ id: "oxygenhr", credentialFile }],
  });
  const actor = { surfaceId: "telegram:bot", senderId: "42", pairingId: "pair_42" };
  try {
    const started = await coordinator.start("oxygenhr", actor);
    const authorization = new URL(started.authorizationUrl);
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    assert.ok(authorization.searchParams.get("code_challenge"));
    const state = authorization.searchParams.get("state");
    assert.ok(state);
    assert.equal((await coordinator.complete("oxygenhr", actor)).status, "pending");

    const completed = await coordinator.completeCallback(`/frappe2/oauth/callback?state=${encodeURIComponent(state)}&code=auth-code`);
    assert.equal(completed.senderId, actor.senderId);
    assert.equal(completed.pairingId, actor.pairingId);
    assert.equal(completed.identity.user, "person@example.test");
    assert.equal(completed.identity.employee, "EMP-0001");
    assert.equal(completed.identity.department, "DEP-001");
    assert.equal(completed.identity.departmentName, "People Operations");
    assert.equal(completed.identity.reportsTo, "EMP-0002");
    assert.equal(completed.identity.reportsToName, "Manager Person");
    assert.equal(completed.identity.userName, "Test Person");
    assert.equal(completed.identity.roles.length, 234);
    assert.ok(completed.identity.roles.includes("All"));
    assert.ok(completed.identity.roles.includes("Custom Role 232"));
    const actorAuthorization = await coordinator.authorizationForActor(actor, "https://erp.example.test");
    assert.equal(actorAuthorization?.connectionId, "oxygenhr");
    assert.equal(actorAuthorization?.identity.user, "person@example.test");
    assert.equal(actorAuthorization?.header, "Bearer access-1");
    const metadataAuthorizations = await coordinator.metadataAuthorizations();
    assert.equal(metadataAuthorizations.length, 1);
    assert.equal(metadataAuthorizations[0].site, "https://erp.example.test");
    assert.equal(metadataAuthorizations[0].header, "Bearer access-1");
    assert.equal(await coordinator.authorizationForActor({ ...actor, senderId: "43" }, "https://erp.example.test"), undefined);
    assert.equal(await coordinator.authorizationForActor(actor, "https://another.example.test"), undefined);
    assert.match(requests.find((request) => request.url.includes("get_token"))?.body ?? "", /code_verifier=/);
    assert.equal((await coordinator.complete("oxygenhr", actor)).status, "connected");
    await assert.rejects(
      () => coordinator.completeCallback(`https://muster.example.test/frappe2/oauth/callback?state=${encodeURIComponent(state)}&code=replay`),
      /unknown or expired/i,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("gateway OAuth rejects an issuer downgrade from a different host", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-oauth-issuer-"));
  const credentialFile = join(cwd, "oauth.json");
  await writeFile(credentialFile, `${JSON.stringify({
    site: "https://erp.example.test",
    clientId: "client-1",
    clientSecret: "secret-1",
    redirectUri: "https://muster.example.test/frappe2/oauth/callback",
  })}\n`, { mode: 0o600 });
  const fetcher = (async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith("/api/method/frappe.integrations.oauth2.get_token")) {
      return new Response(JSON.stringify({ access_token: "access-1", token_type: "Bearer" }), { status: 200 });
    }
    if (url.endsWith("/api/method/frappe.integrations.oauth2.openid_profile")) {
      return new Response(JSON.stringify({ email: "person@example.test", roles: ["All"], iss: "http://other.example.test" }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as typeof fetch;
  const coordinator = new FrappeOAuthCoordinator({
    cwd,
    fetcher,
    connections: [{ id: "oxygenhr", credentialFile }],
  });
  const actor = { surfaceId: "telegram:bot", senderId: "42", pairingId: "pair_42" };
  try {
    const started = await coordinator.start("oxygenhr", actor);
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    assert.ok(state);
    await assert.rejects(
      () => coordinator.completeCallback(`https://muster.example.test/frappe2/oauth/callback?state=${encodeURIComponent(state)}&code=auth-code`),
      /profile issuer does not match/i,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("gateway OAuth rejects a callback origin mismatch and clears failed consent for reconnect", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-oauth-reconnect-"));
  const credentialFile = join(cwd, "oauth.json");
  await writeFile(credentialFile, `${JSON.stringify({
    site: "https://erp.example.test",
    clientId: "client-1",
    redirectUri: "https://muster.example.test/frappe2/oauth/callback",
  })}\n`, { mode: 0o600 });
  const actor = { surfaceId: "gchat:space", senderId: "user@example.test", pairingId: "pair-1" };
  const coordinator = new FrappeOAuthCoordinator({
    cwd,
    connections: [{ id: "oxygenhr", credentialFile }],
    fetcher: (async (input: string | URL) => {
      if (String(input).endsWith("/get_token")) return new Response(JSON.stringify({ error: "temporarily_unavailable" }), { status: 503 });
      return new Response(JSON.stringify({}), { status: 500 });
    }) as typeof fetch,
  });
  try {
    const started = await coordinator.start("oxygenhr", actor);
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    assert.ok(state);
    await assert.rejects(
      () => coordinator.completeCallback(`https://evil.example.test/frappe2/oauth/callback?state=${encodeURIComponent(state)}&code=auth-code`),
      /redirect URI/i,
    );
    await assert.rejects(
      () => coordinator.completeCallback(`https://muster.example.test/frappe2/oauth/callback?state=${encodeURIComponent(state)}&code=auth-code`),
      /unknown or expired/i,
    );
    assert.equal((await coordinator.complete("oxygenhr", actor)).status, "expired");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Frappe OAuth setup rejects unusable callbacks and cross-origin method paths", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-oauth-inspect-"));
  const gatewayCredential = join(cwd, "gateway.json");
  const invalidCredential = join(cwd, "invalid.json");
  const hostedCredential = join(cwd, "hosted.json");
  await writeFile(gatewayCredential, `${JSON.stringify({
    site: "https://erp.example.test",
    clientId: "client-1",
    redirectUri: "https://muster.example.test/v1/frappe/oauth/callback",
  })}\n`, { mode: 0o600 });
  await writeFile(invalidCredential, `${JSON.stringify({
    site: "https://erp.example.test",
    clientId: "client-1",
    redirectUri: "https://muster.example.test/callback",
  })}\n`, { mode: 0o600 });
  await writeFile(hostedCredential, `${JSON.stringify({
    site: "https://erp.example.test",
    clientId: "client-1",
    redirectUri: "https://erp.example.test/api/method/custom_app.oauth.callback",
  })}\n`, { mode: 0o600 });
  try {
    const gateway = await inspectFrappeOAuthConnection({ id: "erp", credentialFile: gatewayCredential }, cwd);
    assert.equal(gateway.callbackMode, "gateway");
    assert.equal(gateway.redirectUri, "https://muster.example.test/v1/frappe/oauth/callback");
    assert.equal(gateway.identityTtlMs, 60_000);

    await assert.rejects(
      inspectFrappeOAuthConnection({ id: "erp", credentialFile: invalidCredential }, cwd),
      /gateway redirect path/i,
    );

    const hosted = await inspectFrappeOAuthConnection({
      id: "erp-hosted",
      credentialFile: hostedCredential,
      callbackMode: "frappe",
      resultPath: "/api/method/custom_app.oauth.consume",
      identityPath: "/api/method/custom_app.oauth.identity",
    }, cwd);
    assert.equal(hosted.callbackMode, "frappe");
    assert.equal(hosted.resultPath, "/api/method/custom_app.oauth.consume");
    assert.equal(hosted.identityPath, "/api/method/custom_app.oauth.identity");

    await assert.rejects(
      inspectFrappeOAuthConnection({
        id: "erp-hosted",
        credentialFile: hostedCredential,
        callbackMode: "frappe",
        identityPath: "https://evil.example.test/steal",
      }, cwd),
      /same-site \/api\/method/i,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("authorization refreshes Frappe roles after the bounded identity cache expires", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-oauth-identity-ttl-"));
  const credentialFile = join(cwd, "oauth.json");
  await writeFile(credentialFile, `${JSON.stringify({
    site: "https://erp.example.test",
    clientId: "client-1",
    redirectUri: "https://muster.example.test/frappe2/oauth/callback",
  })}\n`, { mode: 0o600 });
  let now = 1_000_000;
  let roles = ["Employee"];
  let profileCalls = 0;
  const fetcher = (async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith("/api/method/frappe.integrations.oauth2.get_token")) {
      return new Response(JSON.stringify({ access_token: "access-1", token_type: "Bearer", expires_in: 3600 }), { status: 200 });
    }
    if (url.endsWith("/api/method/frappe.integrations.oauth2.openid_profile")) {
      profileCalls += 1;
      return new Response(JSON.stringify({ email: "person@example.test", name: "Test Person", roles, iss: "https://erp.example.test" }), { status: 200 });
    }
    if (url.includes("/api/resource/Employee?")) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
  }) as typeof fetch;
  const coordinator = new FrappeOAuthCoordinator({
    cwd,
    fetcher,
    now: () => now,
    connections: [{ id: "oxygenhr", credentialFile, identityTtlMs: 5_000 }],
  });
  const actor = { surfaceId: "telegram:bot", senderId: "42", pairingId: "pair_42" };
  try {
    const started = await coordinator.start("oxygenhr", actor);
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    assert.ok(state);
    await coordinator.completeCallback(`https://muster.example.test/frappe2/oauth/callback?state=${encodeURIComponent(state)}&code=auth-code`);
    assert.equal(profileCalls, 1);

    assert.deepEqual((await coordinator.authorization("oxygenhr", actor))?.identity.roles, ["Employee"]);
    assert.equal(profileCalls, 1);
    roles = ["HR Manager"];
    now += 4_999;
    assert.deepEqual((await coordinator.authorization("oxygenhr", actor))?.identity.roles, ["Employee"]);
    assert.equal(profileCalls, 1);

    now += 1;
    assert.deepEqual((await coordinator.authorization("oxygenhr", actor))?.identity.roles, ["HR Manager"]);
    assert.equal(profileCalls, 2);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
