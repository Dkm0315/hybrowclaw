import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { connectMcpServer, connectMcpServers, writeMcpOAuthToken } from "../src/index.js";

/** A fake MCP server speaking newline-delimited JSON-RPC over stdio. */
const FAKE_SERVER = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "fake" } } });
  else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
    { name: "echo", description: "echoes input" },
    { name: "huge", description: "returns a huge payload" },
    { name: "flaky", description: "always errors" },
    { name: "secret", description: "should be excluded" },
  ] } });
  else if (msg.method === "tools/call") {
    const tool = msg.params.name;
    if (tool === "echo") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "echo:" + JSON.stringify(msg.params.arguments) }] } });
    else if (tool === "huge") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "X".repeat(20000) }] } });
    else send({ jsonrpc: "2.0", id: msg.id, error: { code: -1, message: "flaky failure" } });
  }
});
`;

const stdioConfig = (extra = {}) => ({
  transport: { kind: "stdio" as const, command: process.execPath, args: ["-e", FAKE_SERVER] },
  ...extra,
});

test("stdio handshake, tool listing with namespacing, include/exclude filters", async () => {
  const handle = await connectMcpServer("fake", stdioConfig({ tools: { exclude: ["secret"] } }));
  assert.equal(handle.status, "ready");
  assert.deepEqual(handle.tools.map((tool) => tool.namespaced).sort(), ["fake__echo", "fake__flaky", "fake__huge"]);
  const result = await handle.call("echo", { a: 1 });
  assert.equal(result.ok, true);
  assert.match(result.content, /echo:\{"a":1\}/);
  handle.close();
});

test("stdio env and arg templates resolve at process start without storing secrets in config", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-mcp-runtime-env-"));
  const previous = {
    MCP_TOKEN: process.env.MCP_TOKEN,
    MCP_FALLBACK_TOKEN: process.env.MCP_FALLBACK_TOKEN,
    MCP_ARG_SECRET: process.env.MCP_ARG_SECRET,
  };
  process.env.MCP_FALLBACK_TOKEN = "runtime-token";
  process.env.MCP_ARG_SECRET = "runtime-arg-secret";
  delete process.env.MCP_TOKEN;
  const INSPECT_SERVER = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "inspect" } } });
  else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "inspect" }] } });
  else if (msg.method === "tools/call") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify({ token: process.env.MCP_TOKEN, literal: process.env.MCP_LITERAL, cwd: process.env.MCP_CWD, args: process.argv.slice(1) }) }] } });
});
`;
  const config = {
    transport: {
      kind: "stdio" as const,
      command: process.execPath,
      args: ["-e", INSPECT_SERVER, "${MCP_ARG_SECRET}", "${CWD}"],
      env: {
        MCP_TOKEN: "MCP_TOKEN|MCP_FALLBACK_TOKEN",
        MCP_LITERAL: "literal-value",
        MCP_CWD: "${CWD}",
      },
    },
  };
  assert.equal(JSON.stringify(config).includes("runtime-token"), false);
  assert.equal(JSON.stringify(config).includes("runtime-arg-secret"), false);
  try {
    const handle = await connectMcpServer("inspect", config, cwd);
    assert.equal(handle.status, "ready");
    const result = await handle.call("inspect", {});
    assert.equal(result.ok, true);
    const inspected = JSON.parse(result.content) as { token: string; literal: string; cwd: string; args: string[] };
    assert.equal(inspected.token, "runtime-token");
    assert.equal(inspected.literal, "literal-value");
    assert.equal(inspected.cwd, cwd);
    assert.deepEqual(inspected.args.slice(-2), ["runtime-arg-secret", cwd]);
    handle.close();
  } finally {
    if (previous.MCP_TOKEN === undefined) delete process.env.MCP_TOKEN;
    else process.env.MCP_TOKEN = previous.MCP_TOKEN;
    if (previous.MCP_FALLBACK_TOKEN === undefined) delete process.env.MCP_FALLBACK_TOKEN;
    else process.env.MCP_FALLBACK_TOKEN = previous.MCP_FALLBACK_TOKEN;
    if (previous.MCP_ARG_SECRET === undefined) delete process.env.MCP_ARG_SECRET;
    else process.env.MCP_ARG_SECRET = previous.MCP_ARG_SECRET;
  }
});

test("oversized results are capped through the persistence pipeline (stub + result_fetch)", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-mcp-cap-"));
  const handle = await connectMcpServer("fake", stdioConfig({ limits: { maxResultChars: 1000 } }), cwd);
  const result = await handle.call("huge", {}, cwd);
  assert.equal(result.ok, true);
  assert.ok(result.content.length < 1000);
  assert.match(result.content, /result_fetch\("res_/);
  handle.close();
});

test("circuit breaker opens after 3 consecutive failures and reports cooling down", async () => {
  const handle = await connectMcpServer("fake", stdioConfig());
  for (let index = 0; index < 3; index += 1) {
    const failed = await handle.call("flaky", {});
    assert.equal(failed.ok, false);
    assert.match(failed.error ?? "", /flaky failure/);
  }
  const open = await handle.call("echo", {});
  assert.equal(open.ok, false);
  assert.match(open.error ?? "", /circuit open/);
  handle.close();
});

test("a failing server is isolated: the registry survives and good servers still work", async () => {
  const { handles, registry, close } = await connectMcpServers({
    good: stdioConfig(),
    broken: { transport: { kind: "stdio", command: process.execPath, args: ["-e", "process.exit(1)"] } },
  });
  const good = handles.find((handle) => handle.name === "good")!;
  const broken = handles.find((handle) => handle.name === "broken")!;
  assert.equal(good.status, "ready");
  assert.equal(broken.status, "failed");
  assert.ok(broken.error, "failure is loud, not silent");
  assert.ok(registry["good__echo"], "good server tools registered");
  assert.equal(registry["broken__anything"], undefined);
  const output = await registry["good__echo"]({ ping: true });
  assert.match(String(output), /ping/);
  close();
});

test("tool timeout produces a clear error, not a hang", async () => {
  const SILENT = 'setInterval(() => {}, 1000);'; // never replies
  const handle = await connectMcpServer("mute", {
    transport: { kind: "stdio", command: process.execPath, args: ["-e", SILENT] },
    limits: { toolTimeoutMs: 200 },
  });
  assert.equal(handle.status, "failed");
  assert.match(handle.error ?? "", /timed out/);
  handle.close();
});

// #34443 isolated supervision: a bad command (ENOENT spawn failure) emits an
// async 'error' on the child. Without an error listener Node rethrows it as an
// UNCAUGHT exception that crashes the whole host — this test would take the
// runner down. It must instead resolve to a clean per-server "failed" handle.
test("a non-existent MCP command fails cleanly and does NOT crash the host", async () => {
  const handle = await connectMcpServer("ghost", {
    transport: { kind: "stdio", command: "muster-no-such-binary-xyzzy", args: [] },
    limits: { toolTimeoutMs: 1500 },
  });
  assert.equal(handle.status, "failed");
  assert.match(handle.error ?? "", /ENOENT|spawn|not running|exited/i);
  // The handle's call() still answers without throwing (registry stays alive).
  const result = await handle.call("anything", {});
  assert.equal(result.ok, false);
  handle.close();
});

test("OAuth HTTP MCP refuses unauthenticated setup before making requests", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-mcp-oauth-missing-"));
  const handle = await connectMcpServer("linear", {
    transport: { kind: "http", url: "https://mcp.linear.app/mcp" },
    auth: "oauth",
    limits: { toolTimeoutMs: 100 },
  }, cwd);
  assert.equal(handle.status, "failed");
  assert.match(handle.error ?? "", /requires OAuth login/);
});

test("OAuth HTTP MCP sends bearer token from profile token store", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-mcp-oauth-token-"));
  let seenAuthorization = "";
  const server = createServer((req, res) => {
    seenAuthorization = String(req.headers.authorization ?? "");
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => {
      const message = JSON.parse(body) as { id: number; method: string };
      const result = message.method === "initialize"
        ? { protocolVersion: "2025-06-18", serverInfo: { name: "oauth-fake" } }
        : { tools: [] };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await writeMcpOAuthToken("oauth-fake", { accessToken: "tok_test" }, cwd);
    const handle = await connectMcpServer("oauth-fake", {
      transport: { kind: "http", url: `http://127.0.0.1:${address.port}/mcp` },
      auth: "oauth",
    }, cwd);
    assert.equal(handle.status, "ready");
    assert.equal(seenAuthorization, "Bearer tok_test");
    handle.close();
  } finally {
    server.close();
  }
});
