import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfig, type MusterConfig } from "@musterhq/core";
import {
  approvePairing,
  handleSurfaceMessage,
  openSqliteGatewayEnterpriseRuntime,
  requestPairing,
  type GatewayConfig,
  type SurfaceMessage,
} from "../src/index.js";

function providerServer(): Promise<{ url: string; calls: () => number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    let callCount = 0;
    const server = createServer((_request, response) => {
      callCount += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "provider-ok" } }] }));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        calls: () => callCount,
        close: () => new Promise<void>((done, fail) => server.close((error) => error ? fail(error) : done())),
      });
    });
  });
}

function providerConfig(baseUrl: string): MusterConfig {
  const base = defaultConfig();
  return {
    ...base,
    providers: { stub: { id: "stub", kind: "openai-compatible", baseUrl, defaultModel: "stub-model", timeoutMs: 5_000 } },
    runtimes: { native: { id: "native", enabled: true, provider: "stub", routes: {} } },
    routing: { ...base.routing, defaultRuntime: "native" },
  };
}

function message(text: string): SurfaceMessage {
  return { surfaceId: "gchat:app", conversationId: "spaces/team", senderId: "users/alice", text };
}

test("gateway records real usage and preserves atomic limits across restart", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-enterprise-gateway-"));
  const provider = await providerServer();
  const gateway: GatewayConfig = {
    token: "test-token",
    governance: {
      enabled: true,
      assignments: { default: { userId: "employee-alice", capabilities: ["*"] } },
      rateLimits: [{ subject: { kind: "user", id: "employee-alice" }, window: "hour", maxRuns: 1 }],
      estimatedOutputTokens: 10,
    },
  };
  const pending = await requestPairing("gchat:app", "users/alice", cwd);
  await approvePairing(pending.code, cwd);
  let enterprise = openSqliteGatewayEnterpriseRuntime(cwd);
  try {
    const first = await handleSurfaceMessage(message("hello"), { config: providerConfig(provider.url), gateway, enterprise, cwd });
    assert.match("text" in first ? first.text : "", /provider-ok/);
    assert.equal(provider.calls(), 1);

    const blocked = await handleSurfaceMessage(message("second request"), { config: providerConfig(provider.url), gateway, enterprise, cwd });
    assert.match("text" in blocked ? blocked.text : "", /Rate limit exceeded/);
    assert.equal(provider.calls(), 1, "blocked requests must not invoke the provider");

    const usage = await handleSurfaceMessage(message("/usage"), { config: providerConfig(provider.url), gateway, enterprise, cwd });
    assert.equal("presentation" in usage ? usage.presentation?.title : undefined, "Usage");
    assert.match("text" in usage ? usage.text : "", /Runs: 2/);
    assert.match("text" in usage ? usage.text : "", /success/);
    assert.match("text" in usage ? usage.text : "", /blocked/);

    await enterprise.close?.();
    enterprise = openSqliteGatewayEnterpriseRuntime(cwd);
    const afterRestart = await handleSurfaceMessage(message("after restart"), { config: providerConfig(provider.url), gateway, enterprise, cwd });
    assert.match("text" in afterRestart ? afterRestart.text : "", /Rate limit exceeded/);
    assert.equal(provider.calls(), 1, "restart must not reset a durable rate window");
  } finally {
    await enterprise.close?.();
    await provider.close();
  }
});

test("separate gateway runtimes cannot over-admit one shared SQLite rate limit", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-enterprise-gateway-race-"));
  const provider = await providerServer();
  const gateway: GatewayConfig = {
    token: "test-token",
    governance: {
      enabled: true,
      assignments: { default: { userId: "employee-alice", capabilities: ["*"] } },
      rateLimits: [{ subject: { kind: "user", id: "employee-alice" }, window: "hour", maxRuns: 1, maxTokens: 1_000 }],
      estimatedOutputTokens: 10,
    },
  };
  const pending = await requestPairing("gchat:app", "users/alice", cwd);
  await approvePairing(pending.code, cwd);
  const firstRuntime = openSqliteGatewayEnterpriseRuntime(cwd);
  const secondRuntime = openSqliteGatewayEnterpriseRuntime(cwd);
  try {
    const replies = await Promise.all([
      handleSurfaceMessage(message("concurrent request one"), { config: providerConfig(provider.url), gateway, enterprise: firstRuntime, cwd }),
      handleSurfaceMessage(message("concurrent request two"), { config: providerConfig(provider.url), gateway, enterprise: secondRuntime, cwd }),
    ]);
    assert.equal(provider.calls(), 1, "the shared limit must admit exactly one provider call");
    assert.equal(replies.filter((reply) => "text" in reply && /Rate limit exceeded/.test(reply.text)).length, 1);
  } finally {
    await firstRuntime.close?.();
    await secondRuntime.close?.();
    await provider.close();
  }
});

test("department and agent limits are enforced before provider execution", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-enterprise-department-agent-"));
  const provider = await providerServer();
  const gateway: GatewayConfig = {
    token: "test-token",
    governance: {
      enabled: true,
      assignments: { default: { userId: "employee-alice", departmentIds: ["Professional Services"] } },
      rateLimits: [
        { subject: { kind: "department", id: "Professional Services" }, window: "hour", maxRuns: 5 },
        { subject: { kind: "agent", id: "default" }, window: "hour", maxRuns: 1 },
      ],
    },
  };
  const pending = await requestPairing("gchat:app", "users/alice", cwd);
  await approvePairing(pending.code, cwd);
  const enterprise = openSqliteGatewayEnterpriseRuntime(cwd);
  try {
    const first = await handleSurfaceMessage(message("first agent request"), { config: providerConfig(provider.url), gateway, enterprise, cwd });
    assert.match("text" in first ? first.text : "", /provider-ok/);
    const second = await handleSurfaceMessage(message("second agent request"), { config: providerConfig(provider.url), gateway, enterprise, cwd });
    assert.match("text" in second ? second.text : "", /Rate limit exceeded for agent:default/);
    assert.equal(provider.calls(), 1);
  } finally {
    await enterprise.close?.();
    await provider.close();
  }
});
