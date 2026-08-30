import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  attachableInheritedServers,
  discoverBackendEcosystem,
  inheritedInventoryRows,
  parseClaudeMcpServers,
  parseCodexMcpList,
  parseCodexPluginList,
  parseCodexPluginPolicy,
} from "../src/backend-ecosystem.js";

/**
 * Fixtures are trimmed copies of REAL output recorded on the owner's machine
 * (codex 0.150.x): `codex mcp list --json` and `codex plugin list`. Shapes that
 * only exist in a doc are not evidence.
 */
const CODEX_MCP_JSON = JSON.stringify([
  {
    name: "cloudflare-api",
    enabled: true,
    disabled_reason: null,
    transport: { type: "streamable_http", url: "https://mcp.cloudflare.com/mcp" },
    auth_status: "not_logged_in",
  },
  {
    name: "computer-use",
    enabled: false,
    disabled_reason: null,
    transport: { type: "stdio", command: "./Codex Computer Use.app/Contents/MacOS/SkyComputerUseClient", args: ["mcp"] },
    auth_status: "unsupported",
  },
  {
    name: "openaiDeveloperDocs",
    enabled: true,
    transport: { type: "streamable_http", url: "https://developers.openai.com/mcp" },
    auth_status: "unsupported",
  },
  {
    name: "pycharm",
    enabled: true,
    transport: { type: "streamable_http", url: "http://127.0.0.1:64462/stream" },
    auth_status: "unsupported",
  },
]);

const CODEX_PLUGIN_LIST = `Marketplace \`openai-primary-runtime\`
/Users/x/.cache/codex-runtimes/marketplace.json

PLUGIN                                   STATUS              VERSION       PATH
documents@openai-primary-runtime         installed, enabled  26.826.12353  /Users/x/plugins/documents
spreadsheets@openai-primary-runtime      installed, enabled  26.826.12353  /Users/x/plugins/spreadsheets

Marketplace \`openai-bundled\`
/Users/x/.codex/.tmp/bundled-marketplaces/openai-bundled/.agents/plugins/marketplace.json

PLUGIN                            STATUS              VERSION       PATH
computer-use@openai-bundled       installed, enabled  1.0.1000816   /Users/x/.codex/plugins/computer-use
messages@openai-bundled           not installed                     /Users/x/.codex/plugins/messages
`;

const CODEX_CONFIG_TOML = `model = "gpt-5.5"

[plugins."computer-use@openai-bundled"]
  enabled = true

[plugins."documents@openai-primary-runtime"]
  enabled = true

[plugins."spreadsheets@openai-primary-runtime"]
  enabled = false

[projects."/Users/x/repo"]
  trust_level = "trusted"
`;

const CLAUDE_JSON = JSON.stringify({
  numStartups: 12,
  mcpServers: {
    "hosted-gmail": { type: "http", url: "https://claude.ai/api/mcp/gmail" },
  },
  projects: {
    "/Users/x/repo": {
      mcpServers: { codex: { type: "stdio", command: "codex", args: ["mcp-server"], env: {} } },
    },
    "/Users/x/other": { mcpServers: {} },
  },
});

test("parseCodexMcpList maps transport, enablement, and auth to a status", () => {
  const servers = parseCodexMcpList(CODEX_MCP_JSON);
  assert.equal(servers.length, 4);
  const byName = new Map(servers.map((server) => [server.name, server]));
  assert.equal(byName.get("cloudflare-api")?.status, "needs-auth");
  assert.match(byName.get("cloudflare-api")?.guidance ?? "", /codex mcp login cloudflare-api/);
  assert.equal(byName.get("cloudflare-api")?.transport, "http");
  assert.equal(byName.get("computer-use")?.status, "disabled");
  assert.equal(byName.get("computer-use")?.guidance, "codex mcp enable computer-use");
  assert.equal(byName.get("openaiDeveloperDocs")?.status, "active");
  // Remote endpoints are never "directly reachable": muster must not attach or
  // probe a third party from a listing.
  assert.equal(byName.get("openaiDeveloperDocs")?.directlyReachable, false);
  assert.equal(byName.get("pycharm")?.directlyReachable, true);
});

test("parseCodexMcpList tolerates garbage instead of throwing", () => {
  assert.deepEqual(parseCodexMcpList(""), []);
  assert.deepEqual(parseCodexMcpList("not json"), []);
  assert.deepEqual(parseCodexMcpList(JSON.stringify([{ transport: { type: "stdio" } }])), []);
});

test("parseCodexPluginList reads the human table, marketplace by marketplace", () => {
  const plugins = parseCodexPluginList(CODEX_PLUGIN_LIST);
  const ids = plugins.map((plugin) => plugin.id);
  assert.deepEqual(ids, [
    "documents@openai-primary-runtime",
    "spreadsheets@openai-primary-runtime",
    "computer-use@openai-bundled",
    "messages@openai-bundled",
  ]);
  const documents = plugins[0]!;
  assert.equal(documents.status, "active");
  assert.equal(documents.marketplace, "openai-primary-runtime");
  assert.equal(documents.version, "26.826.12353");
  assert.equal(documents.path, "/Users/x/plugins/documents");
  const messages = plugins.at(-1)!;
  assert.equal(messages.status, "unreachable");
  assert.equal(messages.guidance, "codex plugin install messages@openai-bundled");
});

test("parseCodexPluginPolicy reads [plugins.\"id\"] enabled flags only", () => {
  const policy = parseCodexPluginPolicy(CODEX_CONFIG_TOML);
  assert.equal(policy.get("computer-use@openai-bundled"), true);
  assert.equal(policy.get("spreadsheets@openai-primary-runtime"), false);
  assert.equal(policy.has("/Users/x/repo"), false);
});

test("parseClaudeMcpServers reads user and project scopes, flagging account-bound connectors", () => {
  const servers = parseClaudeMcpServers(CLAUDE_JSON);
  const byName = new Map(servers.map((server) => [server.name, server]));
  assert.equal(byName.size, 2);
  const hosted = byName.get("hosted-gmail")!;
  assert.equal(hosted.accountBound, true);
  assert.equal(hosted.status, "needs-auth");
  assert.match(hosted.guidance ?? "", /only when muster drives the claude backend/);
  const codex = byName.get("codex")!;
  assert.equal(codex.transport, "stdio");
  assert.equal(codex.status, "active");
  assert.match(codex.detail ?? "", /project \/Users\/x\/repo/);
  assert.equal(codex.accountBound, undefined);
  assert.deepEqual(parseClaudeMcpServers("{"), []);
});

test("discoverBackendEcosystem builds a typed inventory from injected backends", async () => {
  const home = await mkdtemp(join(tmpdir(), "muster-ecosystem-"));
  await writeFile(join(home, "config.toml"), CODEX_CONFIG_TOML, "utf8");
  const claudePath = join(home, "claude.json");
  await writeFile(claudePath, CLAUDE_JSON, "utf8");
  const probed: string[] = [];
  const ecosystem = await discoverBackendEcosystem({
    codexHome: home,
    claudeConfigPath: claudePath,
    runCommand: async (command, args) => {
      assert.equal(command, "codex");
      if (args[0] === "mcp") return CODEX_MCP_JSON;
      if (args[0] === "plugin") return CODEX_PLUGIN_LIST;
      throw new Error(`unexpected args: ${args.join(" ")}`);
    },
    probeUrl: async (url) => {
      probed.push(url);
      return true;
    },
  });
  assert.equal(ecosystem.codex.available, true);
  assert.equal(ecosystem.claude.available, true);
  assert.deepEqual(ecosystem.codex.errors, []);
  // Only the loopback endpoint is probed.
  assert.deepEqual(probed, ["http://127.0.0.1:64462/stream"]);
  const pycharm = ecosystem.codex.mcpServers.find((server) => server.name === "pycharm")!;
  assert.equal(pycharm.status, "active");
  assert.equal(pycharm.detail, "reachable on localhost");
  // config.toml is the local authority over the marketplace row.
  const spreadsheets = ecosystem.codex.plugins.find((plugin) => plugin.id === "spreadsheets@openai-primary-runtime")!;
  assert.equal(spreadsheets.status, "disabled");
  assert.match(spreadsheets.guidance ?? "", /enabled = true/);
  assert.deepEqual(ecosystem.codex.computerUse, {
    installed: true,
    enabled: true,
    path: "/Users/x/.codex/plugins/computer-use",
    pluginId: "computer-use@openai-bundled",
    configDeclared: true,
    detail: "codex-native screen control is available to codex turns",
    guidance: undefined,
  });
  assert.deepEqual(
    attachableInheritedServers(ecosystem).map((server) => server.name),
    ["pycharm"],
  );
  const rows = inheritedInventoryRows(ecosystem);
  assert.equal(rows.filter((row) => row.kind === "mcp").length, 6);
  assert.equal(rows.filter((row) => row.kind === "plugin").length, 4);
  assert.match(rows.find((row) => row.id === "pycharm")?.guidance ?? "", /muster mcp add-http pycharm http:\/\/127\.0\.0\.1:64462\/stream/);
});

test("discoverBackendEcosystem survives a missing codex binary and missing configs", async () => {
  const home = await mkdtemp(join(tmpdir(), "muster-ecosystem-empty-"));
  const ecosystem = await discoverBackendEcosystem({
    codexHome: home,
    claudeConfigPath: join(home, "absent.json"),
    runCommand: async () => {
      const error = new Error("spawn codex ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
    probe: false,
  });
  assert.equal(ecosystem.codex.available, false);
  assert.equal(ecosystem.claude.available, false);
  assert.deepEqual(ecosystem.codex.mcpServers, []);
  assert.deepEqual(ecosystem.codex.plugins, []);
  assert.equal(ecosystem.codex.errors.length, 2);
  assert.match(ecosystem.codex.errors[0]!, /codex mcp list: spawn codex ENOENT/);
  assert.equal(ecosystem.codex.computerUse.installed, false);
  assert.equal(ecosystem.codex.computerUse.enabled, false);
  assert.match(ecosystem.codex.computerUse.guidance ?? "", /codex plugin install computer-use/);
});

test("an unreachable localhost server is reported, not silently listed as active", async () => {
  const home = await mkdtemp(join(tmpdir(), "muster-ecosystem-down-"));
  const ecosystem = await discoverBackendEcosystem({
    codexHome: home,
    claudeConfigPath: join(home, "absent.json"),
    runCommand: async (_command, args) => (args[0] === "mcp" ? CODEX_MCP_JSON : ""),
    probeUrl: async () => false,
  });
  const pycharm = ecosystem.codex.mcpServers.find((server) => server.name === "pycharm")!;
  assert.equal(pycharm.status, "unreachable");
  assert.match(pycharm.guidance ?? "", /start the host app/);
  assert.deepEqual(attachableInheritedServers(ecosystem), []);
});
