import assert from "node:assert/strict";
import { test } from "node:test";
import type { BackendEcosystem } from "@musterhq/core";
import {
  inheritedNextStep,
  renderInheritedIntegrationsTable,
  renderInheritedToolsSection,
  renderSensesPanel,
  resolveAttachableServer,
  statusLabel,
} from "../src/inherited-ecosystem.js";

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function plain(lines: readonly string[]): string[] {
  return lines.map(stripAnsi);
}

/** Mirrors the live inventory recorded on the owner's machine. */
function ecosystem(overrides: Partial<BackendEcosystem> = {}): BackendEcosystem {
  return {
    codex: {
      available: true,
      mcpServers: [
        { backend: "codex", name: "cloudflare-api", transport: "http", url: "https://mcp.cloudflare.com/mcp", status: "needs-auth", detail: "codex reports no login for this server", guidance: "codex mcp login cloudflare-api", directlyReachable: false },
        { backend: "codex", name: "openaiDeveloperDocs", transport: "http", url: "https://developers.openai.com/mcp", status: "active", detail: "remote server", directlyReachable: false },
        { backend: "codex", name: "pycharm", transport: "http", url: "http://127.0.0.1:64462/stream", status: "active", detail: "reachable on localhost", directlyReachable: true },
        { backend: "codex", name: "computer-use", transport: "stdio", command: "/Applications/SkyComputerUseClient", status: "disabled", detail: "disabled in codex config", guidance: "codex mcp enable computer-use", directlyReachable: false },
      ],
      plugins: [
        { backend: "codex", id: "documents@openai-primary-runtime", marketplace: "openai-primary-runtime", version: "26.826.12353", path: "/p/documents", status: "active", detail: "installed, enabled" },
        { backend: "codex", id: "computer-use@openai-bundled", marketplace: "openai-bundled", status: "active", detail: "installed, enabled" },
        { backend: "codex", id: "chrome@openai-bundled", marketplace: "openai-bundled", status: "active", detail: "installed, enabled" },
        { backend: "codex", id: "messages@openai-bundled", status: "unreachable", detail: "not installed", guidance: "codex plugin install messages@openai-bundled" },
      ],
      computerUse: {
        installed: true,
        enabled: true,
        path: "/Users/x/.codex/plugins/computer-use",
        pluginId: "computer-use@openai-bundled",
        configDeclared: true,
        detail: "codex-native screen control is available to codex turns",
      },
      errors: [],
    },
    claude: {
      available: true,
      mcpServers: [
        { backend: "claude", name: "hosted-gmail", transport: "http", url: "https://claude.ai/api/mcp/gmail", status: "needs-auth", detail: "claude.ai-hosted connector (user)", guidance: "account-bound: reusable only when muster drives the claude backend", accountBound: true, directlyReachable: false },
      ],
      errors: [],
    },
    discoveredAt: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
}

const EMPTY: BackendEcosystem = {
  codex: { available: false, mcpServers: [], plugins: [], computerUse: { installed: false, enabled: false, configDeclared: false, detail: "codex computer-use plugin is not installed", guidance: "codex plugin install computer-use@openai-bundled" }, errors: ["codex mcp list: spawn codex ENOENT"] },
  claude: { available: false, mcpServers: [], errors: [] },
  discoveredAt: "2026-08-27T00:00:00.000Z",
};

test("/tools renders the inherited section with status, backend, and the attach offer", () => {
  const lines = plain(renderInheritedToolsSection(ecosystem()));
  const body = lines.join("\n");
  assert.match(body, /Inherited from codex\/claude/);
  assert.match(body, /● active {2}mcp\/codex pycharm http:\/\/127\.0\.0\.1:64462\/stream/);
  assert.match(body, /◐ needs-auth {2}mcp\/codex cloudflare-api/);
  assert.match(body, /○ disabled {2}mcp\/codex computer-use/);
  assert.match(body, /mcp\/claude hosted-gmail/);
  assert.match(body, /plugins\/codex documents, computer-use, chrome/);
  // The honest claim: these load because the BACKEND has them, not because
  // muster re-declared them.
  assert.match(body, /muster does not re-declare them/);
  assert.match(body, /\/mcp attach pycharm/);
  assert.match(body, /muster integrations inherited/);
});

test("/tools truncates a long inherited list instead of flooding the panel", () => {
  const many = ecosystem();
  const inflated: BackendEcosystem = {
    ...many,
    codex: {
      ...many.codex,
      mcpServers: Array.from({ length: 9 }, (_, index) => ({ ...many.codex.mcpServers[0]!, name: `server-${index}` })),
    },
  };
  const body = plain(renderInheritedToolsSection(inflated, { limit: 3 })).join("\n");
  assert.match(body, /… 7 more MCP servers/);
});

test("/tools stays honest when there is nothing to inherit", () => {
  const body = plain(renderInheritedToolsSection(EMPTY)).join("\n");
  assert.match(body, /No inherited backends detected/);
  assert.doesNotMatch(body, /attach/i);
});

test("integrations inherited prints one tab-separated row per entry with a next step", () => {
  const lines = renderInheritedIntegrationsTable(ecosystem());
  assert.equal(lines[2], "backend\tkind\tid\tstatus\tdetail\tnext");
  const rows = lines.slice(3).filter((line) => line.includes("\t"));
  const byId = new Map(rows.map((row) => [row.split("\t")[2]!, row.split("\t")]));
  assert.deepEqual(byId.get("cloudflare-api")?.slice(3), ["needs-auth", "codex reports no login for this server", "codex mcp login cloudflare-api"]);
  assert.deepEqual(byId.get("pycharm")?.slice(3), ["active", "reachable on localhost", "muster mcp add-http pycharm http://127.0.0.1:64462/stream"]);
  assert.equal(byId.get("hosted-gmail")?.[0], "claude");
  assert.match(byId.get("hosted-gmail")?.[5] ?? "", /account-bound/);
  assert.equal(byId.get("openaiDeveloperDocs")?.[5], "inherited automatically on codex turns");
  assert.equal(byId.get("documents@openai-primary-runtime")?.[1], "plugin");
  assert.ok(rows.some((row) => row.startsWith("codex\tplugin\tcomputer-use@openai-bundled\tactive")));
  // computer-use always gets its own row, so `/senses` and this table cannot disagree.
  assert.ok(rows.some((row) => row.startsWith("codex\tcomputer-use\tcomputer-use@openai-bundled\tactive")));
});

test("integrations inherited surfaces discovery failures as warnings, never as silence", () => {
  const lines = renderInheritedIntegrationsTable(EMPTY);
  assert.ok(lines.some((line) => line === "# discovery_warning=codex mcp list: spawn codex ENOENT"));
  assert.ok(lines.some((line) => /No backend inventory found/.test(line)));
});

test("/senses reports codex-native computer use, and never claims muster drives the screen", () => {
  const body = plain(renderSensesPanel(ecosystem())).join("\n");
  assert.match(body, /computer-use ● active/);
  assert.match(body, /codex-native plugin computer-use@openai-bundled · enabled in ~\/\.codex\/config\.toml/);
  assert.match(body, /path \/Users\/x\/\.codex\/plugins\/computer-use/);
  assert.match(body, /use computer use to …/);
  assert.match(body, /browser chrome@openai-bundled/);
  assert.match(body, /local endpoints pycharm \(active\)/);
  assert.match(body, /Muster never drives the screen itself/);
});

test("/senses on a machine without the plugin shows the enable line, not a capability", () => {
  const body = plain(renderSensesPanel(EMPTY)).join("\n");
  assert.match(body, /computer-use ◌ unreachable/);
  assert.match(body, /enable codex plugin install computer-use@openai-bundled/);
  assert.match(body, /local endpoints none/);
  assert.doesNotMatch(body, /use computer use to/);
});

test("attach is gated to reachable loopback servers, with a reason for every refusal", () => {
  const live = ecosystem();
  const ok = resolveAttachableServer(live, "PyCharm");
  assert.ok("server" in ok && ok.server.name === "pycharm");
  const remote = resolveAttachableServer(live, "openaiDeveloperDocs");
  assert.match("error" in remote ? remote.error : "", /only attaches loopback endpoints/);
  const hosted = resolveAttachableServer(live, "hosted-gmail");
  assert.match("error" in hosted ? hosted.error : "", /bound to the account/);
  const stdio = resolveAttachableServer(live, "computer-use");
  assert.match("error" in stdio ? stdio.error : "", /stdio server owned by codex/);
  const missing = resolveAttachableServer(live, "nope");
  assert.match("error" in missing ? missing.error : "", /No inherited MCP server named "nope"\. Attachable: pycharm\./);
});

test("an unreachable loopback server is refused with its own diagnosis", () => {
  const down = ecosystem();
  const withDown: BackendEcosystem = {
    ...down,
    codex: {
      ...down.codex,
      mcpServers: down.codex.mcpServers.map((server) => server.name === "pycharm"
        ? { ...server, status: "unreachable" as const, detail: "configured but not answering on localhost", guidance: "start the host app (e.g. the IDE) that serves this endpoint" }
        : server),
    },
  };
  const result = resolveAttachableServer(withDown, "pycharm");
  assert.match("error" in result ? result.error : "", /unreachable .*start the host app/);
});

test("status labels and next steps are stable strings", () => {
  assert.equal(stripAnsi(statusLabel("active")), "● active");
  assert.equal(stripAnsi(statusLabel("needs-auth")), "◐ needs-auth");
  assert.equal(stripAnsi(statusLabel("disabled")), "○ disabled");
  assert.equal(stripAnsi(statusLabel("unreachable")), "◌ unreachable");
  assert.equal(
    inheritedNextStep({ backend: "codex", name: "pycharm", transport: "http", url: "http://127.0.0.1:1/stream", status: "active", directlyReachable: true }),
    "muster mcp add-http pycharm http://127.0.0.1:1/stream",
  );
});
