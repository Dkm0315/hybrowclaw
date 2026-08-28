import assert from "node:assert/strict";
import { test } from "node:test";
import type { BackendEcosystem } from "@musterhq/core";
import {
  buildCapabilityOverlayOptions,
  capabilityConfirmationText,
  composerTextForCapabilityAction,
  decodeCapabilitySelection,
  encodeCapabilitySelection,
  parseCapabilityConfirmation,
} from "../src/capabilities-overlay.js";

const ecosystem: BackendEcosystem = {
  codex: {
    available: true,
    plugins: [
      { backend: "codex", id: "presentations@runtime", status: "unreachable", detail: "not installed", guidance: "codex plugin install presentations@runtime" },
      { backend: "codex", id: "computer-use@bundled", status: "active", detail: "installed" },
      { backend: "codex", id: "documents@runtime", status: "active", detail: "installed, enabled" },
      { backend: "codex", id: "spreadsheets@runtime", status: "disabled", detail: "installed, disabled", guidance: "codex plugin install spreadsheets@runtime" },
      { backend: "codex", id: "pdf@runtime", status: "needs-auth", detail: "login required", guidance: "https://example.test/pdf-auth" },
    ],
    mcpServers: [
      { backend: "codex", name: "docs", transport: "http", url: "https://example.test/mcp", status: "active", directlyReachable: false },
      { backend: "codex", name: "pycharm", transport: "http", url: "http://127.0.0.1:64462/stream", status: "active", detail: "reachable on localhost", directlyReachable: true },
      { backend: "codex", name: "cloud", transport: "http", status: "needs-auth", guidance: "codex mcp login cloud", directlyReachable: false },
      { backend: "codex", name: "screen", transport: "stdio", status: "disabled", guidance: "codex mcp enable screen", directlyReachable: false },
      { backend: "codex", name: "ide-down", transport: "http", status: "unreachable", guidance: "start the IDE", directlyReachable: false },
    ],
    computerUse: { installed: true, enabled: false, configDeclared: false, detail: "installed, disabled" },
    errors: [],
  },
  claude: {
    available: true,
    mcpServers: [
      { backend: "claude", name: "gmail", transport: "http", status: "needs-auth", guidance: "https://claude.ai/settings/connectors", accountBound: true },
    ],
    errors: [],
  },
  discoveredAt: "2026-08-28T00:00:00.000Z",
};

test("/tools overlay builds ordered actionable rows and maps every inherited status honestly", () => {
  const rows = buildCapabilityOverlayOptions(ecosystem, {
    toolsets: ["core", "files"],
    skills: [{ value: "release-check", description: "release safety" }],
  });

  assert.deepEqual(rows.slice(0, 5).map((row) => row.label), ["documents", "pdf", "spreadsheets", "presentations", "computer-use"]);
  assert.deepEqual(rows.slice(5, 11).map((row) => row.label), ["docs", "pycharm", "cloud", "screen", "ide-down", "gmail"]);
  assert.deepEqual(rows.slice(11).map((row) => row.group), ["toolset", "toolset", "skill"]);

  assert.equal(rows.find((row) => row.label === "documents")?.action.kind, "insert-prompt");
  assert.equal(rows.find((row) => row.label === "pdf")?.action.kind, "show-guidance");
  assert.equal(rows.find((row) => row.label === "spreadsheets")?.action.kind, "confirm-command");
  assert.equal(rows.find((row) => row.label === "presentations")?.action.kind, "show-guidance");
  assert.equal(rows.find((row) => row.label === "computer-use")?.status, "disabled", "computer-use must use its real resolved enable state");
  assert.deepEqual(rows.find((row) => row.label === "computer-use")?.action, { kind: "confirm-command", command: "codex", args: ["mcp", "enable", "computer-use"] });

  assert.equal(rows.find((row) => row.label === "docs")?.action.kind, "insert-prompt");
  assert.deepEqual(rows.find((row) => row.label === "pycharm")?.action, { kind: "attach-mcp", command: "/mcp attach pycharm" });
  assert.equal(rows.find((row) => row.label === "cloud")?.action.kind, "show-guidance");
  assert.equal(rows.find((row) => row.label === "screen")?.action.kind, "confirm-command");
  assert.equal(rows.find((row) => row.label === "ide-down")?.action.kind, "show-guidance");
  assert.equal(rows.find((row) => row.label === "gmail")?.action.kind, "show-guidance");
});

test("active capability selection inserts ready composer text with the cursor-ready trailing space", () => {
  const action = buildCapabilityOverlayOptions(ecosystem, { toolsets: [], skills: [] })[0]!.action;
  const text = composerTextForCapabilityAction(action);
  assert.equal(text, "use the documents plugin to ");
  assert.equal(decodeCapabilitySelection(encodeCapabilitySelection(text)), text);
  assert.ok(text.endsWith(" "));
});

test("state-changing commands require the separately submitted confirmation line", () => {
  const staged = capabilityConfirmationText("codex", ["mcp", "enable", "computer-use"]);
  assert.equal(staged, "[enter] run codex mcp enable computer-use · [esc] cancel");
  assert.equal(parseCapabilityConfirmation("codex mcp enable computer-use"), undefined, "a command alone is never executable");
  assert.deepEqual(parseCapabilityConfirmation(staged), { command: "codex", args: ["mcp", "enable", "computer-use"] });
  assert.equal(parseCapabilityConfirmation("[enter] run sh -c rm -rf / · [esc] cancel"), undefined, "the guard allowlists argv without a shell");
});
