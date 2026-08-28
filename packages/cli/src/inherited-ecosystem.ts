/**
 * Terminal surface for backend ecosystem reuse.
 *
 * Muster should not be an island. Codex boots the user's OWN MCP servers under
 * muster's app-server turns (live probes: 18-19 `mcpServer/startupStatus/updated`
 * notifications per turn) and the codex plugin skills stay active (the documents
 * plugin wrote python-docx under muster). None of that was VISIBLE anywhere, so
 * it read as muster having no tools when it had the user's whole toolbox.
 *
 * Rules kept by everything in this file:
 *
 * 1. RENDERING IS PURE. Every `render*` takes a `BackendEcosystem` and returns
 *    lines. No spawning, no clock, no color decisions beyond the shared palette.
 * 2. DISCOVERY IS READ-ONLY AND OPTIONAL. `inheritedEcosystem()` caches for a
 *    few seconds and NEVER throws: a missing codex binary renders as one honest
 *    line, not a failed `/tools`.
 * 3. ATTACHING IS THE HUMAN'S CHOICE. The only inherited servers muster offers
 *    to own are loopback HTTP endpoints that answered a probe; everything else
 *    is listed with the exact command the user would run in codex/claude.
 */

import {
  attachableInheritedServers,
  discoverBackendEcosystem,
  type BackendEcosystem,
  type InheritedMcpServer,
  type InheritedStatus,
} from "@musterhq/core";

const RESET = "\x1b[0m";
const ACCENT_RGB = "41;211;255";
const OK_RGB = "104;245;168";
const WARN_RGB = "255;196;92";
const MUTED_RGB = "142;161;181";

function paint(rgb: string, text: string, bold = false): string {
  if (process.env.NO_COLOR) return text;
  return `\x1b[${bold ? "1;" : ""}38;2;${rgb}m${text}${RESET}`;
}

const accent = (text: string): string => paint(ACCENT_RGB, text);
const muted = (text: string): string => paint(MUTED_RGB, text);

/** Status glyph + word, so a scan of the panel needs no legend. */
export function statusLabel(status: InheritedStatus): string {
  switch (status) {
    case "active":
      return paint(OK_RGB, "● active");
    case "needs-auth":
      return paint(WARN_RGB, "◐ needs-auth");
    case "disabled":
      return muted("○ disabled");
    case "unreachable":
      return paint(WARN_RGB, "◌ unreachable");
  }
}

/** `pycharm  http://127.0.0.1:64462/stream` — identity first, transport second. */
function serverLabel(server: InheritedMcpServer): string {
  const target = server.url ?? server.command;
  return target ? `${server.name} ${muted(target)}` : server.name;
}

const CACHE_TTL_MS = 15_000;
let cached: { readonly at: number; readonly value: BackendEcosystem } | undefined;

/**
 * Discovery for interactive surfaces. Cached briefly because `/tools`,
 * `/senses` and the status line can all ask within one turn, and each miss
 * spawns `codex` twice. Failure is never fatal: an empty inventory renders as
 * "no inherited backends detected".
 */
export async function inheritedEcosystem(options: { readonly refresh?: boolean } = {}): Promise<BackendEcosystem> {
  if (!options.refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  const value = await discoverBackendEcosystem({ timeoutMs: 4_000 }).catch((): BackendEcosystem => ({
    codex: { available: false, mcpServers: [], plugins: [], computerUse: { installed: false, enabled: false, configDeclared: false, detail: "codex discovery failed" }, errors: ["discovery failed"] },
    claude: { available: false, mcpServers: [], errors: [] },
    discoveredAt: new Date().toISOString(),
  }));
  cached = { at: Date.now(), value };
  return value;
}

/** Test seam: drop the memo so a suite never sees another test's inventory. */
export function resetInheritedEcosystemCache(): void {
  cached = undefined;
}

/**
 * The "inherited from codex/claude" block appended to `/tools`.
 *
 * Compact by construction: muster's own toolsets are the headline, and this is
 * the reminder that a codex turn also carries the user's MCP servers and plugin
 * skills without any muster config.
 */
export function renderInheritedToolsSection(ecosystem: BackendEcosystem, options: { readonly limit?: number } = {}): string[] {
  const limit = options.limit ?? 6;
  const lines: string[] = ["", accent("Inherited from codex/claude")];
  const servers = [...ecosystem.codex.mcpServers, ...ecosystem.claude.mcpServers];
  if (!servers.length && !ecosystem.codex.plugins.length) {
    lines.push(muted("No inherited backends detected. Run `muster integrations inherited` for details."));
    return lines;
  }
  for (const server of servers.slice(0, limit)) {
    lines.push(`  ${statusLabel(server.status)}  ${muted(`mcp/${server.backend}`)} ${serverLabel(server)}`);
  }
  if (servers.length > limit) lines.push(muted(`  … ${servers.length - limit} more MCP servers`));
  const activePlugins = ecosystem.codex.plugins.filter((plugin) => plugin.status === "active");
  if (activePlugins.length) {
    const names = activePlugins.map((plugin) => plugin.id.split("@")[0]!).slice(0, 10);
    lines.push(`  ${statusLabel("active")}  ${muted("plugins/codex")} ${names.join(", ")}${activePlugins.length > names.length ? `, +${activePlugins.length - names.length}` : ""}`);
  }
  lines.push(muted("These load on codex/claude turns as the backend already has them configured; muster does not re-declare them."));
  const attachable = attachableInheritedServers(ecosystem);
  if (attachable.length) {
    lines.push(`${accent("Attach natively")} ${attachable.map((server) => server.name).join(", ")} — reachable on localhost. Submit ${accent(`/mcp attach ${attachable[0]!.name}`)} to let muster own it too.`);
  }
  lines.push(muted("Full table with per-entry enable guidance: muster integrations inherited"));
  return lines;
}

/**
 * `muster integrations inherited` — same inventory, script-friendly.
 * Tab-separated to match the existing `muster integrations` table so the two
 * can be piped into the same tooling.
 */
export function renderInheritedIntegrationsTable(ecosystem: BackendEcosystem): string[] {
  const lines = [
    "Inherited backend ecosystem (read-only discovery; muster never edits codex or claude config)",
    "",
    "backend\tkind\tid\tstatus\tdetail\tnext",
  ];
  for (const server of [...ecosystem.codex.mcpServers, ...ecosystem.claude.mcpServers]) {
    lines.push([
      server.backend,
      "mcp",
      server.name,
      server.status,
      server.detail ?? server.url ?? server.command ?? "",
      inheritedNextStep(server),
    ].join("\t"));
  }
  for (const plugin of ecosystem.codex.plugins) {
    lines.push([
      plugin.backend,
      "plugin",
      plugin.id,
      plugin.status,
      plugin.detail ?? "",
      plugin.guidance ?? "inherited automatically on codex turns",
    ].join("\t"));
  }
  const computerUse = ecosystem.codex.computerUse;
  lines.push([
    "codex",
    "computer-use",
    computerUse.pluginId ?? "computer-use",
    computerUse.enabled ? "active" : computerUse.installed ? "disabled" : "unreachable",
    computerUse.detail,
    computerUse.guidance ?? "codex turns may request it in the prompt",
  ].join("\t"));
  for (const error of [...ecosystem.codex.errors, ...ecosystem.claude.errors]) {
    lines.push(`# discovery_warning=${error}`);
  }
  if (!ecosystem.codex.available && !ecosystem.claude.available) {
    lines.push("");
    lines.push("No backend inventory found. Install codex (`codex mcp list --json`) or claude, then rerun.");
  }
  return lines;
}

/** Per-entry, one-line remediation. Never executed — printed for the human. */
export function inheritedNextStep(server: InheritedMcpServer): string {
  if (server.guidance) return server.guidance;
  if (server.directlyReachable && server.url) return `muster mcp add-http ${server.name} ${server.url}`;
  return `inherited automatically on ${server.backend} turns`;
}

/**
 * `/senses` — what this machine can PERCEIVE beyond text.
 *
 * Computer use is a CODEX-NATIVE capability: when the codex plugin is installed
 * and enabled, a codex turn can request screen control from its own prompt and
 * the resulting tool call is recorded like any other tool line. Muster builds no
 * screen control of its own, so this panel surfaces and verifies — nothing else.
 */
export function renderSensesPanel(ecosystem: BackendEcosystem): string[] {
  const computerUse = ecosystem.codex.computerUse;
  const lines = [
    `${accent("computer-use")} ${statusLabel(computerUse.enabled ? "active" : computerUse.installed ? "disabled" : "unreachable")} ${muted(computerUse.detail)}`,
    `${accent("source")} codex-native plugin${computerUse.pluginId ? ` ${computerUse.pluginId}` : ""}${computerUse.configDeclared ? " · enabled in ~/.codex/config.toml" : ""}`,
  ];
  if (computerUse.path) lines.push(`${accent("path")} ${muted(computerUse.path)}`);
  if (computerUse.guidance) lines.push(`${accent("enable")} ${computerUse.guidance}`);
  if (computerUse.enabled) {
    lines.push(muted("Ask for it in the turn itself (\"use computer use to …\"); codex owns the screen, muster records the tool line."));
  }
  const browsers = ecosystem.codex.plugins.filter((plugin) => /^(browser|chrome)(@|$)/.test(plugin.id) && plugin.status === "active");
  lines.push(`${accent("browser")} ${browsers.length ? browsers.map((plugin) => plugin.id).join(", ") : muted("no codex browser plugin enabled")}`);
  const local = [...ecosystem.codex.mcpServers, ...ecosystem.claude.mcpServers].filter((server) => server.directlyReachable);
  lines.push(`${accent("local endpoints")} ${local.length ? local.map((server) => `${server.name} (${server.status})`).join(", ") : muted("none")}`);
  lines.push(muted("Muster never drives the screen itself. Every sense here belongs to a backend and is surfaced, not simulated."));
  return lines;
}

/**
 * `/mcp attach <name>` resolution: which inherited server (if any) may muster
 * take ownership of? The gate is deliberately narrow — a loopback HTTP endpoint
 * that answered a probe — because attaching means muster will connect to it
 * directly, outside the backend that vouched for it.
 */
export function resolveAttachableServer(ecosystem: BackendEcosystem, name: string): { readonly server: InheritedMcpServer } | { readonly error: string } {
  const wanted = name.trim().toLowerCase();
  const all = [...ecosystem.codex.mcpServers, ...ecosystem.claude.mcpServers];
  const match = all.find((server) => server.name.toLowerCase() === wanted);
  if (!match) {
    const options = attachableInheritedServers(ecosystem).map((server) => server.name);
    return { error: `No inherited MCP server named "${name}".${options.length ? ` Attachable: ${options.join(", ")}.` : ""}` };
  }
  if (match.accountBound) {
    return { error: `${match.name} is a claude.ai-hosted connector bound to the account; it is reusable only when muster drives the claude backend.` };
  }
  if (!match.url || match.transport === "stdio") {
    return { error: `${match.name} is a ${match.transport} server owned by ${match.backend}; muster inherits it on ${match.backend} turns instead of attaching it.` };
  }
  if (!match.directlyReachable) {
    return { error: `${match.name} is remote (${match.url}). Muster only attaches loopback endpoints automatically — use "muster mcp add-http ${match.name} ${match.url}" if you intend to.` };
  }
  if (match.status !== "active") {
    return { error: `${match.name} is ${match.status} (${match.detail ?? "no detail"}). ${inheritedNextStep(match)}` };
  }
  return { server: match };
}
