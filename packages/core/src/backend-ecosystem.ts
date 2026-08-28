import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { runSubprocess } from "./subprocess.js";

/**
 * Backend ecosystem reuse (T3 lane).
 *
 * Muster is not an island: the user already configured MCP servers and plugins
 * inside codex and claude, and codex boots those same servers under muster's
 * app-server turns (live probes: 18-19 `mcpServer/startupStatus/updated`
 * notifications per turn). This module makes that inheritance VISIBLE and
 * machine-readable instead of folklore.
 *
 * Hard rule: discovery is READ-ONLY. Nothing here mutates `~/.codex/config.toml`,
 * `~/.claude.json`, or muster config. Every enable/auth step is returned as a
 * one-line command for the human to run, never executed.
 */

export type InheritedStatus = "active" | "needs-auth" | "disabled" | "unreachable";

export type InheritedBackend = "codex" | "claude";

export interface InheritedMcpServer {
  readonly backend: InheritedBackend;
  readonly name: string;
  readonly transport: "stdio" | "http" | "sse" | "unknown";
  readonly url?: string;
  readonly command?: string;
  readonly status: InheritedStatus;
  /** Why the status is what it is — rendered verbatim in `/tools` and the CLI table. */
  readonly detail?: string;
  /** One-line remediation for the human (`codex mcp enable X`, an auth URL, …). */
  readonly guidance?: string;
  /**
   * A claude.ai-hosted connector is bound to the user's Claude account, not to a
   * local process: muster can only reach it by DRIVING the claude backend, and
   * can never attach it natively.
   */
  readonly accountBound?: boolean;
  /** Loopback HTTP servers muster can attach natively via `mcp add-http`. */
  readonly directlyReachable?: boolean;
}

export interface InheritedPlugin {
  readonly backend: InheritedBackend;
  /** Fully qualified id, e.g. `documents@openai-primary-runtime`. */
  readonly id: string;
  readonly marketplace?: string;
  readonly version?: string;
  readonly path?: string;
  readonly status: InheritedStatus;
  readonly detail?: string;
  readonly guidance?: string;
}

export interface ComputerUseStatus {
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly path?: string;
  readonly pluginId?: string;
  /** True when `[plugins."computer-use@…"] enabled = true` is declared in config.toml. */
  readonly configDeclared: boolean;
  readonly detail: string;
  readonly guidance?: string;
}

export interface BackendEcosystem {
  readonly codex: {
    readonly available: boolean;
    readonly mcpServers: readonly InheritedMcpServer[];
    readonly plugins: readonly InheritedPlugin[];
    readonly computerUse: ComputerUseStatus;
    readonly errors: readonly string[];
  };
  readonly claude: {
    readonly available: boolean;
    readonly mcpServers: readonly InheritedMcpServer[];
    readonly errors: readonly string[];
  };
  readonly discoveredAt: string;
}

export interface DiscoverBackendEcosystemOptions {
  readonly codexHome?: string;
  readonly claudeConfigPath?: string;
  /** Per-command spawn budget. Discovery must never stall a chat turn. */
  readonly timeoutMs?: number;
  /** Per-server localhost reachability budget. */
  readonly probeTimeoutMs?: number;
  /** Skip localhost HEAD probes (tests, offline runs). */
  readonly probe?: boolean;
  /** Injection seam for tests: replaces the `codex …` spawns. */
  readonly runCommand?: (command: string, args: readonly string[]) => Promise<string>;
  /** Injection seam for tests: replaces the localhost HEAD probe. */
  readonly probeUrl?: (url: string, timeoutMs: number) => Promise<boolean>;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_PROBE_TIMEOUT_MS = 1_000;

/* ------------------------------------------------------------------ parsers */

interface RawCodexMcpEntry {
  readonly name?: unknown;
  readonly enabled?: unknown;
  readonly disabled_reason?: unknown;
  readonly auth_status?: unknown;
  readonly transport?: {
    readonly type?: unknown;
    readonly url?: unknown;
    readonly command?: unknown;
  };
}

/**
 * Parse `codex mcp list --json`. Shape verified live against codex
 * 0.150.x: an array of entries with `transport.type` in
 * `streamable_http` | `stdio` | `sse`, plus `auth_status`
 * (`not_logged_in` | `unsupported` | `logged_in`).
 */
export function parseCodexMcpList(raw: string): InheritedMcpServer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { servers?: unknown })?.servers)
      ? (parsed as { servers: unknown[] }).servers
      : [];
  const servers: InheritedMcpServer[] = [];
  for (const value of entries) {
    if (!value || typeof value !== "object") continue;
    const entry = value as RawCodexMcpEntry;
    const name = typeof entry.name === "string" ? entry.name : undefined;
    if (!name) continue;
    const transport = normalizeTransport(entry.transport?.type);
    const url = typeof entry.transport?.url === "string" ? entry.transport.url : undefined;
    const command = typeof entry.transport?.command === "string" ? entry.transport.command : undefined;
    const enabled = entry.enabled !== false;
    const auth = typeof entry.auth_status === "string" ? entry.auth_status : undefined;
    const disabledReason = typeof entry.disabled_reason === "string" ? entry.disabled_reason : undefined;
    const status: InheritedStatus = !enabled
      ? "disabled"
      : auth === "not_logged_in"
        ? "needs-auth"
        : "active";
    servers.push({
      backend: "codex",
      name,
      transport,
      ...(url ? { url } : {}),
      ...(command ? { command } : {}),
      status,
      detail: !enabled
        ? disabledReason ?? "disabled in codex config"
        : auth === "not_logged_in"
          ? "codex reports no login for this server"
          : auth && auth !== "unsupported"
            ? `auth ${auth}`
            : transport === "stdio"
              ? "local stdio server"
              : "remote server",
      guidance: !enabled
        ? `codex mcp enable ${name}`
        : auth === "not_logged_in"
          ? `codex mcp login ${name}${url ? ` (auth at ${url})` : ""}`
          : undefined,
      directlyReachable: enabled && isLoopbackHttpUrl(url),
    });
  }
  return servers;
}

/**
 * Parse the human table emitted by `codex plugin list` (there is no --json).
 * Format, verified live:
 *
 *   Marketplace `openai-bundled`
 *   /path/to/marketplace.json
 *
 *   PLUGIN                STATUS              VERSION   PATH
 *   browser@openai-bundled  installed, enabled  26.8...  /path
 *
 * Anything that does not look like `<id>  <status…>` is ignored, so a future
 * header/footer change degrades to "fewer rows", never to a crash.
 */
export function parseCodexPluginList(raw: string): InheritedPlugin[] {
  const plugins: InheritedPlugin[] = [];
  let marketplace: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    const marketplaceMatch = line.match(/^Marketplace\s+[`'"]?([A-Za-z0-9._@\/-]+)[`'"]?\s*$/);
    if (marketplaceMatch) {
      marketplace = marketplaceMatch[1];
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed || /^PLUGIN\s+STATUS/.test(trimmed) || trimmed.startsWith("/")) continue;
    const row = trimmed.match(/^([A-Za-z0-9._-]+(?:@[A-Za-z0-9._-]+)?)\s{2,}(.+)$/);
    if (!row) continue;
    const id = row[1]!;
    const rest = row[2]!.trim();
    const statusText = rest.match(/^(installed,\s*enabled|installed,\s*disabled|installed|not installed)/i)?.[1];
    if (!statusText) continue;
    const remainder = rest.slice(statusText.length).trim();
    const columns = remainder.split(/\s{2,}/).filter(Boolean);
    const path = columns.find((column) => column.startsWith("/"));
    const version = columns.find((column) => column !== path);
    const normalizedStatus = statusText.toLowerCase().replace(/\s+/g, " ");
    const status: InheritedStatus = normalizedStatus === "installed, enabled"
      ? "active"
      : normalizedStatus === "not installed"
        ? "unreachable"
        : "disabled";
    plugins.push({
      backend: "codex",
      id,
      ...(marketplace ? { marketplace } : {}),
      ...(version ? { version } : {}),
      ...(path ? { path } : {}),
      status,
      detail: normalizedStatus,
      guidance: status === "active" ? undefined : `codex plugin install ${id}`,
    });
  }
  return plugins;
}

/**
 * Which plugin ids does `~/.codex/config.toml` explicitly enable/disable?
 * Sections look like `[plugins."computer-use@openai-bundled"]` followed by
 * `enabled = true`.
 */
export function parseCodexPluginPolicy(configToml: string): Map<string, boolean> {
  const policy = new Map<string, boolean>();
  const section = /^\s*\[plugins\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9._@-]+))\]\s*$/;
  let current: string | undefined;
  for (const line of configToml.split(/\r?\n/)) {
    const header = line.match(section);
    if (header) {
      current = header[1] ?? header[2] ?? header[3];
      continue;
    }
    if (/^\s*\[/.test(line)) {
      current = undefined;
      continue;
    }
    if (!current) continue;
    const enabled = line.match(/^\s*enabled\s*=\s*(true|false)\s*$/);
    if (enabled) policy.set(current, enabled[1] === "true");
  }
  return policy;
}

interface RawClaudeMcpEntry {
  readonly type?: unknown;
  readonly transport?: unknown;
  readonly url?: unknown;
  readonly command?: unknown;
  readonly args?: unknown;
}

/**
 * Parse `~/.claude.json`. Servers live at the top level (`mcpServers`) and per
 * project (`projects["/path"].mcpServers`). claude.ai-hosted connectors are
 * account-bound: they are listed so the user knows they exist, but they are
 * only reusable while DRIVING the claude backend — muster cannot attach them.
 */
export function parseClaudeMcpServers(raw: string): InheritedMcpServer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const root = parsed as { mcpServers?: unknown; projects?: unknown };
  const scopes: { scope: string; servers: Record<string, unknown> }[] = [];
  if (root.mcpServers && typeof root.mcpServers === "object") {
    scopes.push({ scope: "user", servers: root.mcpServers as Record<string, unknown> });
  }
  if (root.projects && typeof root.projects === "object") {
    for (const [projectPath, project] of Object.entries(root.projects as Record<string, unknown>)) {
      const servers = (project as { mcpServers?: unknown } | null)?.mcpServers;
      if (servers && typeof servers === "object") {
        scopes.push({ scope: `project ${projectPath}`, servers: servers as Record<string, unknown> });
      }
    }
  }
  const seen = new Set<string>();
  const results: InheritedMcpServer[] = [];
  for (const { scope, servers } of scopes) {
    for (const [name, value] of Object.entries(servers)) {
      if (!value || typeof value !== "object") continue;
      if (seen.has(name)) continue;
      seen.add(name);
      const entry = value as RawClaudeMcpEntry;
      const declared = typeof entry.type === "string"
        ? entry.type
        : typeof entry.transport === "string"
          ? entry.transport
          : undefined;
      const url = typeof entry.url === "string" ? entry.url : undefined;
      const command = typeof entry.command === "string" ? entry.command : undefined;
      const transport = normalizeTransport(declared ?? (url ? "http" : command ? "stdio" : undefined));
      // Only stdio/http(sse) entries are real local transports; everything else
      // is an account-bound connector we can name but never attach.
      const accountBound = isAccountBoundConnectorUrl(url) || (!url && !command);
      results.push({
        backend: "claude",
        name,
        transport,
        ...(url ? { url } : {}),
        ...(command ? { command } : {}),
        status: accountBound ? "needs-auth" : "active",
        detail: accountBound
          ? `claude.ai-hosted connector (${scope})`
          : `${transport} server (${scope})`,
        guidance: accountBound
          ? "account-bound: reusable only when muster drives the claude backend"
          : undefined,
        ...(accountBound ? { accountBound: true } : {}),
        directlyReachable: !accountBound && isLoopbackHttpUrl(url),
      });
    }
  }
  return results;
}

/* --------------------------------------------------------------- discovery */

/**
 * Read-only inventory of what codex and claude already give this machine.
 * Spawn-tolerant: a missing `codex` binary, a non-zero exit, or a garbage
 * payload yields an empty list plus an error string — never a throw, because
 * this runs inline in `/tools` while the user is waiting.
 */
export async function discoverBackendEcosystem(
  options: DiscoverBackendEcosystemOptions = {},
): Promise<BackendEcosystem> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const claudeConfigPath = options.claudeConfigPath ?? join(homedir(), ".claude.json");
  const run = options.runCommand
    ?? (async (command: string, args: readonly string[]): Promise<string> => {
      const result = await runSubprocess(command, args, { timeoutMs, env: { ...process.env, CODEX_HOME: codexHome } });
      return result.stdout;
    });

  const codexErrors: string[] = [];
  const claudeErrors: string[] = [];

  const mcpJson = await run("codex", ["mcp", "list", "--json"]).catch((error: unknown) => {
    codexErrors.push(`codex mcp list: ${errorText(error)}`);
    return "";
  });
  const pluginText = await run("codex", ["plugin", "list"]).catch((error: unknown) => {
    codexErrors.push(`codex plugin list: ${errorText(error)}`);
    return "";
  });
  const configToml = await readFile(join(codexHome, "config.toml"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") codexErrors.push(`codex config.toml: ${errorText(error)}`);
    return "";
  });
  const claudeJson = await readFile(claudeConfigPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") claudeErrors.push(`claude config: ${errorText(error)}`);
    return "";
  });

  const pluginPolicy = parseCodexPluginPolicy(configToml);
  const codexMcp = await resolveReachability(parseCodexMcpList(mcpJson), { ...options, probeTimeoutMs });
  const claudeMcp = await resolveReachability(parseClaudeMcpServers(claudeJson), { ...options, probeTimeoutMs });
  const codexPlugins = parseCodexPluginList(pluginText).map((plugin) => applyPluginPolicy(plugin, pluginPolicy));

  return {
    codex: {
      available: Boolean(mcpJson || pluginText || configToml),
      mcpServers: codexMcp,
      plugins: codexPlugins,
      computerUse: resolveComputerUse(codexPlugins, pluginPolicy, codexMcp),
      errors: codexErrors,
    },
    claude: {
      available: Boolean(claudeJson),
      mcpServers: claudeMcp,
      errors: claudeErrors,
    },
    discoveredAt: new Date().toISOString(),
  };
}

/**
 * A codex plugin row says "installed, enabled" from the marketplace's point of
 * view; `config.toml` is the machine-local override that actually decides.
 */
function applyPluginPolicy(plugin: InheritedPlugin, policy: ReadonlyMap<string, boolean>): InheritedPlugin {
  const declared = policy.get(plugin.id);
  if (declared === undefined) return plugin;
  if (declared) return plugin.status === "active" ? plugin : { ...plugin, detail: `${plugin.detail ?? ""} (config.toml enables it)`.trim() };
  return {
    ...plugin,
    status: "disabled",
    detail: "disabled in ~/.codex/config.toml",
    guidance: `set [plugins."${plugin.id}"] enabled = true in ~/.codex/config.toml`,
  };
}

/**
 * Codex computer-use is a CODEX-NATIVE capability. Muster surfaces and verifies
 * it; muster never drives the screen itself. When it is enabled, a turn can ask
 * for it in the prompt and the resulting tool call is recorded like any other.
 */
function resolveComputerUse(
  plugins: readonly InheritedPlugin[],
  policy: ReadonlyMap<string, boolean>,
  mcpServers: readonly InheritedMcpServer[],
): ComputerUseStatus {
  const plugin = plugins.find((entry) => entry.id === "computer-use" || entry.id.startsWith("computer-use@"));
  const policyId = plugin?.id
    ?? [...policy.keys()].find((id) => id === "computer-use" || id.startsWith("computer-use@"));
  const configDeclared = policyId !== undefined && policy.get(policyId) === true;
  const installed = plugin ? plugin.status !== "unreachable" : configDeclared;
  const enabled = installed && (configDeclared || plugin?.status === "active");
  const server = mcpServers.find((entry) => entry.name === "computer-use");
  const path = plugin?.path ?? server?.command;
  return {
    installed,
    enabled: Boolean(enabled),
    ...(path ? { path } : {}),
    ...(policyId ? { pluginId: policyId } : {}),
    configDeclared,
    detail: !installed
      ? "codex computer-use plugin is not installed"
      : enabled
        ? "codex-native screen control is available to codex turns"
        : "installed but not enabled in ~/.codex/config.toml",
    guidance: !installed
      ? "codex plugin install computer-use@openai-bundled"
      : enabled
        ? undefined
        : `set [plugins."${policyId ?? "computer-use@openai-bundled"}"] enabled = true in ~/.codex/config.toml`,
  };
}

async function resolveReachability(
  servers: readonly InheritedMcpServer[],
  options: DiscoverBackendEcosystemOptions & { probeTimeoutMs: number },
): Promise<InheritedMcpServer[]> {
  if (options.probe === false) return [...servers];
  const probe = options.probeUrl ?? probeLocalMcpUrl;
  return Promise.all(servers.map(async (server) => {
    if (!server.directlyReachable || !server.url || server.status !== "active") return server;
    const reachable = await probe(server.url, options.probeTimeoutMs).catch(() => false);
    return reachable
      ? { ...server, detail: "reachable on localhost" }
      : { ...server, status: "unreachable" as const, detail: "configured but not answering on localhost", guidance: "start the host app (e.g. the IDE) that serves this endpoint" };
  }));
}

/**
 * 1s HEAD against a LOOPBACK url only. Never probe remote endpoints: a HEAD to
 * a third-party MCP would be an unrequested outbound call from a listing.
 */
export async function probeLocalMcpUrl(url: string, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<boolean> {
  if (!isLoopbackHttpUrl(url)) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(url, { method: "HEAD", signal: controller.signal });
    // Any HTTP answer proves a listener; MCP endpoints legitimately reject HEAD
    // with 405/404, and that is still "reachable".
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Inherited HTTP servers muster may offer to attach natively (loopback only). */
export function attachableInheritedServers(ecosystem: BackendEcosystem): InheritedMcpServer[] {
  return [...ecosystem.codex.mcpServers, ...ecosystem.claude.mcpServers]
    .filter((server) => server.directlyReachable === true && server.status === "active" && !server.accountBound && Boolean(server.url));
}

/** Flat, render-ready list for `/tools` and `muster integrations inherited`. */
export function inheritedInventoryRows(ecosystem: BackendEcosystem): {
  readonly kind: "mcp" | "plugin";
  readonly backend: InheritedBackend;
  readonly id: string;
  readonly status: InheritedStatus;
  readonly detail: string;
  readonly guidance: string;
}[] {
  const rows: { kind: "mcp" | "plugin"; backend: InheritedBackend; id: string; status: InheritedStatus; detail: string; guidance: string }[] = [];
  for (const server of [...ecosystem.codex.mcpServers, ...ecosystem.claude.mcpServers]) {
    rows.push({
      kind: "mcp",
      backend: server.backend,
      id: server.name,
      status: server.status,
      detail: server.detail ?? server.url ?? server.command ?? "",
      guidance: server.guidance ?? (server.directlyReachable ? `muster mcp add-http ${server.name} ${server.url}` : "inherited automatically on this backend's turns"),
    });
  }
  for (const plugin of ecosystem.codex.plugins) {
    rows.push({
      kind: "plugin",
      backend: plugin.backend,
      id: plugin.id,
      status: plugin.status,
      detail: plugin.detail ?? "",
      guidance: plugin.guidance ?? "inherited automatically on codex turns",
    });
  }
  return rows;
}

/* ---------------------------------------------------------------- helpers */

function normalizeTransport(value: unknown): InheritedMcpServer["transport"] {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  if (text === "stdio") return "stdio";
  if (text === "sse") return "sse";
  if (text === "http" || text === "streamable_http" || text === "streamable-http" || text === "http_stream") return "http";
  return "unknown";
}

function isLoopbackHttpUrl(url: string | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function isAccountBoundConnectorUrl(url: string | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return host === "claude.ai" || host.endsWith(".claude.ai") || host.endsWith(".anthropic.com");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
