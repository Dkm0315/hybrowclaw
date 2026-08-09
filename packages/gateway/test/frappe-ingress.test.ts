import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfig, profileWorkspaceDir } from "@musterhq/core";
import type { MusterConfig } from "@musterhq/core";
import { createFrappeRunCsrfProof, frappeChannelSystemContext, frappeChannelTurnContext, initGatewayConfig, resolvePairing, startGatewayServer, trustedFrappeProviderBoundary, trustedFrappeSystemContext, trustedFrappeTurnContext, TRUSTED_FRAPPE_ASYNC_PATH } from "../src/index.js";

function config(baseUrl: string): MusterConfig {
  const base = defaultConfig();
  return {
    ...base,
    providers: { stub: { id: "stub", kind: "openai-compatible", baseUrl, defaultModel: "stub-model", timeoutMs: 5_000 } },
    runtimes: { native: { id: "native", enabled: true, provider: "stub", routes: {} } },
    routing: { ...base.routing, defaultRuntime: "native" },
  };
}

async function stubProvider(onBody: (body: Record<string, unknown>) => void, content = "Provider-backed Frappe answer."): Promise<{ url: string; close(): void }> {
  const { createServer } = await import("node:http");
  return new Promise((resolvePromise) => {
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        onBody(JSON.parse(body) as Record<string, unknown>);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolvePromise({ url: `http://127.0.0.1:${port}/v1`, close: () => server.close() });
    });
  });
}

function ingress(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message: {
      surfaceId: "frappe:erp.example.test",
      conversationId: "chatnext-session-1",
      senderId: "employee@example.test",
      text: "Summarize my pending leave requests.",
    },
    identity: {
      site: "https://erp.example.test",
      user: "employee@example.test",
      employee: "EMP-0042",
      employeeName: "Asha",
      roles: ["Employee"],
      department: "Operations",
      authMode: "frappe_session",
    },
    context: {
      route: "/app/leave-application",
      doctype: "Leave Application",
      installedApps: ["frappe", "erpnext", "hrms", "nextai"],
      summary: "Permission-filtered rows: one pending leave request from 2026-07-20 to 2026-07-21.",
    },
    ...overrides,
  };
}

function trustedHeaders(token: string, user = "employee@example.test", idempotencyKey?: string): Record<string, string> {
  const csrf = "csrf-test-token";
  const scope = {tenantId: "tenant-a", siteId: "site-a", userId: user};
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-frappe-tenant-id": scope.tenantId,
    "x-frappe-site-id": scope.siteId,
    "x-frappe-user-id": scope.userId,
    "x-frappe-csrf-token": csrf,
    "x-muster-csrf-proof": createFrappeRunCsrfProof(token, csrf, scope),
    ...(idempotencyKey ? {"idempotency-key": idempotencyKey} : {}),
  };
}

test("trusted Frappe context sends a compact permission fingerprint instead of every role", () => {
  const roles = ["Employee", ...Array.from({ length: 233 }, (_, index) => `Custom Role ${index + 1}`)];
  const context = trustedFrappeSystemContext({
    provider: "frappe",
    site: "https://erp.example.test",
    user: "employee@example.test",
    employee: "EMP-0042",
    roles,
    rolesHash: "roles-fingerprint-value",
    permissionHash: "permission-fingerprint-value",
    resolvedAt: new Date().toISOString(),
  }, { doctype: "Leave Application" });

  assert.match(context, /234 Frappe roles resolved/);
  assert.match(context, /roles fingerprint roles-finger/);
  assert.match(context, /permission fingerprint permissio/);
  assert.match(context, /Answer in concise business language/);
  assert.match(context, /Never narrate planning, tool\/MCP calls/);
  assert.match(context, /do not attempt execution or expose hidden reasoning/i);
  assert.doesNotMatch(context, /Custom Role/);
  assert.ok(context.length < 1_000);
});

test("trusted Desk Ask is offline, read-only, skill-disabled, and denies every configured MCP", () => {
  const boundary = trustedFrappeProviderBoundary(["browser", "filesystem", "frappe"], ["browser", "github"]);
  assert.deepEqual(boundary, {
    inheritedToolDeny: ["browser", "filesystem", "frappe", "github"],
    nativeSandbox: "read-only",
    nativeNetworkAccess: false,
    skipSkillSelection: true,
  });
  assert.equal(Object.isFrozen(boundary), true);
  assert.equal(Object.isFrozen(boundary.inheritedToolDeny), true);
});

test("channel Frappe context keeps provider power but forbids generic host disclosure", () => {
  const context = frappeChannelSystemContext({
    provider: "frappe",
    site: "https://erp.example.test",
    user: "employee@example.test",
    employee: "EMP-0042",
    employeeName: "Asha Example",
    roles: ["Employee"],
    resolvedAt: new Date().toISOString(),
  }, {
    name: "OxygenHR Assistant",
    organization: "OxygenHR",
    description: "Help employees and managers complete HR work.",
    domains: ["HR", "payroll", "employee workflows"],
  }, true);
  const turnContext = frappeChannelTurnContext("One permission-filtered leave row.");

  assert.match(context, /OxygenHR Assistant for OxygenHR/);
  assert.match(context, /full reasoning, research, and artifact ability/);
  assert.match(context, /live per-user authorization/);
  assert.doesNotMatch(context, /One permission-filtered leave row/);
  assert.match(turnContext, /One permission-filtered leave row/);
  assert.match(turnContext, /replaces any older business-data snapshot/);
  assert.match(context, /Ask one meaningful follow-up question at a time/);
  assert.match(context, /preview before requesting approval/);
  assert.match(context, /Claim completion only after the host verifies/);
  assert.match(context, /Do not expose DocType names, fieldnames, property setters, internal IDs/);
  assert.match(context, /do not present this as a generic coding or filesystem agent/i);
  assert.doesNotMatch(context, /https:\/\/erp\.example\.test/);
});

test("trusted Frappe context applies deployment-owned scope rules before selected record context", () => {
  const liveContext = {
    route: "/desk/user/Administrator",
    doctype: "User",
    docname: "Administrator",
    summary: "The selected user was modified recently.",
  };
  const context = trustedFrappeSystemContext({
    provider: "frappe",
    site: "https://support.example.test",
    user: "cto@example.test",
    roles: ["System Manager"],
    authMode: "frappe_session",
    resolvedAt: "2026-07-15T00:00:00.000Z",
  }, liveContext, {
    name: "OSS Manager",
    domains: ["OSS Manager delivery"],
    operatingInstructions: [
      "Resolve ambiguous change questions against the OSS Manager repository.",
      "Use the selected Frappe record only when the user explicitly asks about it.",
    ],
  });

  assert.match(context, /Resolve ambiguous change questions against the OSS Manager repository/);
  assert.match(context, /Use the selected Frappe record only when the user explicitly asks about it/);
  assert.doesNotMatch(context, /Selected DocType: User/);
  assert.doesNotMatch(context, /selected user was modified/);
  const turn = trustedFrappeTurnContext(liveContext);
  assert.match(turn, /Selected DocType: User/);
  assert.match(turn, /selected user was modified/);
  assert.match(turn, /current page is useful context, not a limit/i);
});

test("trusted Frappe ingress binds identity, preserves the user turn, and runs durably", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-ingress-"));
  let providerCalls = 0;
  let providerMessages: Array<{ role?: string; content?: string }> = [];
  const provider = await stubProvider((body) => {
    providerCalls += 1;
    providerMessages = body.messages as Array<{ role?: string; content?: string }>;
  });
  const initialized = await initGatewayConfig(cwd);
  const running = await startGatewayServer({ config: config(provider.url), gateway: initialized.config, cwd }, 0);
  const baseUrl = `http://127.0.0.1:${running.port}`;
  const headers = trustedHeaders(initialized.config.token, "employee@example.test", "desk-turn-1");
  try {
    const accepted = await fetch(`${baseUrl}${TRUSTED_FRAPPE_ASYNC_PATH}`, { method: "POST", headers, body: JSON.stringify(ingress()) });
    assert.equal(accepted.status, 202);
    const start = await accepted.json() as { runId: string; pollUrl: string; pairingId: string };
    let snapshot: { status: string; reply?: { text?: string }; partialText?: string; reasoningText?: string } = { status: "running" };
    const deadline = Date.now() + 5_000;
    while ((snapshot.status === "queued" || snapshot.status === "running") && Date.now() < deadline) {
      const completed = await fetch(`${baseUrl}${start.pollUrl}?waitMs=1000`, {
        headers,
      });
      snapshot = await completed.json() as { status: string; reply?: { text?: string } };
    }
    assert.equal(snapshot.status, "completed");
    assert.equal(snapshot.reply?.text, "Provider-backed Frappe answer.");
    assert.equal(snapshot.partialText, undefined);
    assert.equal(snapshot.reasoningText, undefined);
    assert.equal(providerCalls, 1);
    assert.equal(providerMessages.at(-1)?.role, "user");
    assert.equal(providerMessages.at(-1)?.content, "Summarize my pending leave requests.");
    assert.match(
      providerMessages.filter((message) => message.role === "system").map((message) => message.content ?? "").join("\n"),
      /Permission-filtered rows/,
    );

    const paired = await resolvePairing("frappe:erp.example.test", "employee@example.test", cwd);
    assert.equal(paired?.pairingId, start.pairingId);
    assert.equal(paired?.identity?.employee, "EMP-0042");

    const replay = await fetch(`${baseUrl}${TRUSTED_FRAPPE_ASYNC_PATH}`, { method: "POST", headers, body: JSON.stringify(ingress()) });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as { runId: string }).runId, start.runId);
    assert.equal(providerCalls, 1);

    const otherUserPoll = await fetch(`${baseUrl}${start.pollUrl}`, {
      headers: trustedHeaders(initialized.config.token, "other@example.test"),
    });
    assert.equal(otherUserPoll.status, 404);
    const otherSiteHeaders = trustedHeaders(initialized.config.token);
    otherSiteHeaders["x-frappe-site-id"] = "site-b";
    otherSiteHeaders["x-muster-csrf-proof"] = createFrappeRunCsrfProof(
      initialized.config.token,
      "csrf-test-token",
      {tenantId: "tenant-a", siteId: "site-b", userId: "employee@example.test"},
    );
    const otherSitePoll = await fetch(`${baseUrl}${start.pollUrl}`, {headers: otherSiteHeaders});
    assert.equal(otherSitePoll.status, 404);

    const mismatchedUser = await fetch(`${baseUrl}${TRUSTED_FRAPPE_ASYNC_PATH}`, {
      method: "POST",
      headers: trustedHeaders(initialized.config.token, "other@example.test"),
      body: JSON.stringify(ingress()),
    });
    assert.equal(mismatchedUser.status, 403);

    const conflict = await fetch(`${baseUrl}${TRUSTED_FRAPPE_ASYNC_PATH}`, {
      method: "POST",
      headers,
      body: JSON.stringify(ingress({ context: { summary: "A different permission-scoped snapshot." } })),
    });
    assert.equal(conflict.status, 409);
  } finally {
    await running.close();
    provider.close();
  }
});

test("compound live-read artifact uses the isolated lane and download is user/site bound", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-artifact-ingress-"));
  let providerCalls = 0;
  let isolatedCall: Record<string, unknown> | undefined;
  let persistedPath = "";
  const provider = await stubProvider(() => { providerCalls += 1; });
  const initialized = await initGatewayConfig(cwd);
  const running = await startGatewayServer({
    config: config(provider.url), gateway: initialized.config, cwd,
    frappeAskArtifactExecutor: async (options) => {
      isolatedCall = { evidence: options.evidence, authority: options.authority, durableRoot: options.durableRoot };
      await mkdir(options.durableRoot, { recursive: true });
      const bytes = Buffer.from("live permission-filtered evidence\n", "utf8");
      persistedPath = join(options.durableRoot, "verified-report.txt");
      await writeFile(persistedPath, bytes);
      return { text: "Report created for review.", artifacts: [{
        name: "report.txt", mime: "text/plain", path: persistedPath,
        sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
      }] };
    },
  }, 0);
  const baseUrl = `http://127.0.0.1:${running.port}`;
  const ownerHeaders = trustedHeaders(initialized.config.token, "employee@example.test", "artifact-turn-1");
  const artifactIngress = ingress({
    message: {
      surfaceId: "frappe:erp.example.test", conversationId: "artifact-chat", senderId: "employee@example.test",
      text: "Use my current leave data to create a text report.",
    },
    context: {
      summary: "Permission-filtered live read: one pending leave request.",
      ask: { schemaVersion: 1, requestId: "intent-artifact-1", requestedOutcomes: ["live_read", "artifact"] },
    },
  });
  try {
    const accepted = await fetch(`${baseUrl}${TRUSTED_FRAPPE_ASYNC_PATH}`, {
      method: "POST", headers: ownerHeaders, body: JSON.stringify(artifactIngress),
    });
    assert.equal(accepted.status, 202);
    const start = await accepted.json() as { runId: string; pollUrl: string };
    const completed = await fetch(`${baseUrl}${start.pollUrl}?waitMs=5000`, { headers: ownerHeaders });
    const snapshot = await completed.json() as { status: string; reply?: { text?: string; artifacts?: Array<{ path: string }> } };
    assert.equal(snapshot.status, "completed");
    assert.equal(snapshot.reply?.text, "Report created for review.");
    assert.equal(snapshot.reply?.artifacts?.[0]?.path, `${start.pollUrl}/artifacts/0`);
    assert.equal(providerCalls, 0);
    assert.deepEqual(isolatedCall && isolatedCall.authority, { tenantId: "tenant-a", siteId: "site-a", userId: "employee@example.test" });
    assert.equal(isolatedCall?.evidence, "Permission-filtered live read: one pending leave request.");

    const artifactUrl = `${baseUrl}${start.pollUrl}/artifacts/0`;
    assert.equal((await fetch(artifactUrl, { headers: ownerHeaders })).status, 200);
    assert.equal(await (await fetch(artifactUrl, { headers: ownerHeaders })).text(), "live permission-filtered evidence\n");
    assert.equal((await fetch(artifactUrl, { headers: trustedHeaders(initialized.config.token, "other@example.test") })).status, 404);

    const otherSiteHeaders = trustedHeaders(initialized.config.token, "employee@example.test");
    otherSiteHeaders["x-frappe-site-id"] = "site-b";
    otherSiteHeaders["x-muster-csrf-proof"] = createFrappeRunCsrfProof(
      initialized.config.token, "csrf-test-token",
      { tenantId: "tenant-a", siteId: "site-b", userId: "employee@example.test" },
    );
    assert.equal((await fetch(artifactUrl, { headers: otherSiteHeaders })).status, 404);
    await writeFile(persistedPath, "live permission-filtered evidencf\n", "utf8");
    assert.equal((await fetch(artifactUrl, { headers: ownerHeaders })).status, 404);
  } finally {
    await running.close();
    provider.close();
  }
});

test("trusted Frappe failed runs return a business error without backend diagnostics", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-safe-error-"));
  const initialized = await initGatewayConfig(cwd);
  const running = await startGatewayServer({
    config: config("http://127.0.0.1:1/v1"), gateway: initialized.config, cwd,
  }, 0);
  const baseUrl = `http://127.0.0.1:${running.port}`;
  const headers = trustedHeaders(initialized.config.token, "employee@example.test", "safe-error-1");
  try {
    const accepted = await fetch(`${baseUrl}${TRUSTED_FRAPPE_ASYNC_PATH}`, {
      method: "POST", headers, body: JSON.stringify(ingress()),
    });
    assert.equal(accepted.status, 202);
    const start = await accepted.json() as { pollUrl: string };
    const completed = await fetch(`${baseUrl}${start.pollUrl}?waitMs=5000`, { headers });
    const snapshot = await completed.json() as { status: string; error?: string; partialText?: string; reasoningText?: string };
    assert.equal(snapshot.status, "failed");
    assert.equal(snapshot.error, "Muster could not complete this request. You can retry safely.");
    assert.equal(snapshot.partialText, undefined);
    assert.equal(snapshot.reasoningText, undefined);
    assert.doesNotMatch(JSON.stringify(snapshot), /ECONNREFUSED|127\.0\.0\.1|provider|model|backend|stack|trace|sha256/i);
  } finally {
    await running.close();
  }
});

test("ordinary trusted Ask cannot turn a provider MEDIA claim into a shared-workspace artifact", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-no-artifact-lane-"));
  const sharedWorkspace = profileWorkspaceDir(cwd, "default");
  await mkdir(sharedWorkspace, { recursive: true });
  const sentinel = join(sharedWorkspace, "private-existing.txt");
  await writeFile(sentinel, "must remain private and unchanged\n", "utf8");
  let providerCalls = 0;
  const provider = await stubProvider(
    () => { providerCalls += 1; },
    `Here is the answer.\nMEDIA:${sentinel}`,
  );
  const initialized = await initGatewayConfig(cwd);
  const running = await startGatewayServer({ config: config(provider.url), gateway: initialized.config, cwd }, 0);
  const baseUrl = `http://127.0.0.1:${running.port}`;
  const ownerHeaders = trustedHeaders(initialized.config.token, "employee@example.test", "ordinary-no-artifact-1");
  const ordinary = ingress({
    message: {
      surfaceId: "frappe:erp.example.test", conversationId: "ordinary-chat", senderId: "employee@example.test",
      text: "Explain the leave policy in the supplied context.",
    },
    context: {
      summary: "Permission-filtered policy summary.",
      ask: { schemaVersion: 1, requestId: "intent-answer-1", requestedOutcomes: ["answer"] },
    },
  });
  try {
    const accepted = await fetch(`${baseUrl}${TRUSTED_FRAPPE_ASYNC_PATH}`, {
      method: "POST", headers: ownerHeaders, body: JSON.stringify(ordinary),
    });
    const start = await accepted.json() as { pollUrl: string };
    const completed = await fetch(`${baseUrl}${start.pollUrl}?waitMs=5000`, { headers: ownerHeaders });
    const snapshot = await completed.json() as { status: string; reply?: { text?: string; artifacts?: unknown[] } };
    assert.equal(snapshot.status, "completed");
    assert.equal(snapshot.reply?.text, "Here is the answer.");
    assert.equal(snapshot.reply?.artifacts, undefined);
    assert.equal(providerCalls, 1);
    assert.equal(await readFile(sentinel, "utf8"), "must remain private and unchanged\n");
    assert.equal((await fetch(`${baseUrl}${start.pollUrl}/artifacts/0`, { headers: ownerHeaders })).status, 404);
  } finally {
    await running.close();
    provider.close();
  }
});

test("trusted Frappe deterministic reply bypasses the provider and spoofed sender fails", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-fast-reply-"));
  let providerCalls = 0;
  const provider = await stubProvider(() => { providerCalls += 1; });
  const initialized = await initGatewayConfig(cwd);
  const running = await startGatewayServer({ config: config(provider.url), gateway: initialized.config, cwd }, 0);
  const baseUrl = `http://127.0.0.1:${running.port}`;
  const headers = trustedHeaders(initialized.config.token);
  try {
    const fast = ingress({ context: { fastReply: { text: "You are signed in as Asha (EMP-0042)." } } });
    const accepted = await fetch(`${baseUrl}${TRUSTED_FRAPPE_ASYNC_PATH}`, { method: "POST", headers, body: JSON.stringify(fast) });
    const start = await accepted.json() as { pollUrl: string };
    const completed = await fetch(`${baseUrl}${start.pollUrl}?waitMs=5000`, { headers });
    const snapshot = await completed.json() as { status: string; reply?: { text?: string } };
    assert.equal(snapshot.status, "completed");
    assert.equal(snapshot.reply?.text, "You are signed in as Asha (EMP-0042).");
    assert.equal(providerCalls, 0);

    const forged = ingress({
      message: { surfaceId: "frappe:erp.example.test", conversationId: "c2", senderId: "attacker@example.test", text: "hi" },
    });
    const rejected = await fetch(`${baseUrl}${TRUSTED_FRAPPE_ASYNC_PATH}`, { method: "POST", headers, body: JSON.stringify(forged) });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json() as { error: string }).error, /senderId must match/);
  } finally {
    await running.close();
    provider.close();
  }
});

test("trusted Frappe ingress does not start a second /pair workflow", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-no-pair-"));
  let providerCalls = 0;
  const provider = await stubProvider(() => { providerCalls += 1; });
  const initialized = await initGatewayConfig(cwd);
  const running = await startGatewayServer({ config: config(provider.url), gateway: initialized.config, cwd }, 0);
  const baseUrl = `http://127.0.0.1:${running.port}`;
  const headers = trustedHeaders(initialized.config.token);
  try {
    const pairedIngress = ingress({
      message: {
        surfaceId: "frappe:erp.example.test",
        conversationId: "chatnext-session-1",
        senderId: "employee@example.test",
        text: "/pair",
      },
    });
    const accepted = await fetch(`${baseUrl}${TRUSTED_FRAPPE_ASYNC_PATH}`, { method: "POST", headers, body: JSON.stringify(pairedIngress) });
    const start = await accepted.json() as { pollUrl: string };
    const completed = await fetch(`${baseUrl}${start.pollUrl}?waitMs=5000`, { headers });
    const snapshot = await completed.json() as { status: string; reply?: { text?: string } };
    assert.equal(snapshot.status, "completed");
    assert.equal(snapshot.reply?.text, "Your Frappe identity is already connected through this signed session. No separate pairing is needed.");
    assert.equal(providerCalls, 0);
  } finally {
    await running.close();
    provider.close();
  }
});
