import type { BackendEcosystem, InheritedMcpServer, InheritedPlugin, InheritedStatus } from "@musterhq/core";

export type CapabilityOverlayAction =
  | { readonly kind: "insert-prompt"; readonly text: string }
  | { readonly kind: "confirm-command"; readonly command: string; readonly args: readonly string[] }
  | { readonly kind: "show-guidance"; readonly text: string }
  | { readonly kind: "attach-mcp"; readonly command: string };

export interface CapabilityOverlayOption {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly group: "plugin" | "mcp" | "toolset" | "skill";
  readonly status: InheritedStatus | "reachable" | "native" | "available";
  readonly action: CapabilityOverlayAction;
}

export interface CapabilityOverlayBuildOptions {
  readonly toolsets: readonly string[];
  readonly skills: readonly { readonly value: string; readonly label?: string; readonly description?: string }[];
}

const PLUGIN_ORDER = ["documents", "pdf", "spreadsheets", "presentations", "computer-use"] as const;
const ENCODED_SELECTION_PREFIX = "muster-tools-action:";
const CONFIRM_PREFIX = "[enter] run ";
const CONFIRM_SUFFIX = " · [esc] cancel";

/** Build the single `/tools` surface in the owner-ratified row order. */
export function buildCapabilityOverlayOptions(
  ecosystem: BackendEcosystem,
  options: CapabilityOverlayBuildOptions,
): CapabilityOverlayOption[] {
  return [
    ...orderedPlugins(ecosystem).map((plugin) => pluginOption(plugin, ecosystem)),
    ...ecosystem.codex.mcpServers.map(serverOption),
    ...ecosystem.claude.mcpServers.map(serverOption),
    ...options.toolsets.map((toolset): CapabilityOverlayOption => ({
      id: `toolset:${toolset}`,
      label: toolset,
      description: "native toolset · available · enter inserts a ready prompt",
      group: "toolset",
      status: "native",
      action: { kind: "insert-prompt", text: `use the ${toolset} toolset to ` },
    })),
    ...options.skills.map((skill): CapabilityOverlayOption => ({
      id: `skill:${skill.value}`,
      label: skill.label ?? skill.value,
      description: `skill · available · ${skill.description ?? "enter inserts a ready prompt"}`,
      group: "skill",
      status: "available",
      action: { kind: "insert-prompt", text: `use the ${skill.value} skill to ` },
    })),
  ];
}

function orderedPlugins(ecosystem: BackendEcosystem): InheritedPlugin[] {
  return ecosystem.codex.plugins
    .map((plugin, index) => ({ plugin, index, rank: pluginRank(plugin.id) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ plugin }) => plugin);
}

function pluginRank(id: string): number {
  const name = shortPluginId(id);
  const rank = PLUGIN_ORDER.indexOf(name as (typeof PLUGIN_ORDER)[number]);
  return rank < 0 ? PLUGIN_ORDER.length : rank;
}

function pluginOption(plugin: InheritedPlugin, ecosystem: BackendEcosystem): CapabilityOverlayOption {
  const name = shortPluginId(plugin.id);
  const computerUse = name === "computer-use" ? ecosystem.codex.computerUse : undefined;
  const status: InheritedStatus = computerUse
    ? computerUse.enabled ? "active" : computerUse.installed ? "disabled" : "unreachable"
    : plugin.status;
  const guidance = computerUse?.guidance ?? plugin.guidance;
  return {
    id: `plugin:codex:${plugin.id}`,
    label: name,
    description: `plugin/codex · ${status} · ${computerUse?.detail ?? plugin.detail ?? "inherited on codex turns"}`,
    group: "plugin",
    status,
    action: actionForPlugin(name, status, guidance),
  };
}

function actionForPlugin(name: string, status: InheritedStatus, guidance?: string): CapabilityOverlayAction {
  if (status === "active") return { kind: "insert-prompt", text: `use the ${name} plugin to ` };
  if (status === "disabled") {
    if (name === "computer-use") return { kind: "confirm-command", command: "codex", args: ["mcp", "enable", "computer-use"] };
    const command = parseGuardedCommand(guidance);
    if (command) return { kind: "confirm-command", ...command };
  }
  return { kind: "show-guidance", text: guidance ?? `${name} is ${status}` };
}

function serverOption(server: InheritedMcpServer): CapabilityOverlayOption {
  const reachable = server.status === "active" && server.directlyReachable === true && Boolean(server.url);
  const status = reachable ? "reachable" as const : server.status;
  return {
    id: `mcp:${server.backend}:${server.name}`,
    label: server.name,
    description: `mcp/${server.backend} · ${status} · ${server.detail ?? server.url ?? server.command ?? "inherited server"}`,
    group: "mcp",
    status,
    action: actionForServer(server, reachable),
  };
}

function actionForServer(server: InheritedMcpServer, reachable: boolean): CapabilityOverlayAction {
  if (reachable) return { kind: "attach-mcp", command: `/mcp attach ${server.name}` };
  if (server.status === "active") return { kind: "insert-prompt", text: `use the ${server.name} MCP to ` };
  if (server.status === "disabled") {
    const command = parseGuardedCommand(server.guidance);
    if (command) return { kind: "confirm-command", ...command };
  }
  return { kind: "show-guidance", text: server.guidance ?? server.url ?? `${server.name} is ${server.status}` };
}

function shortPluginId(id: string): string {
  return id.split("@")[0] ?? id;
}

/** The exact composer text applied by the first Enter on a selected row. */
export function composerTextForCapabilityAction(action: CapabilityOverlayAction): string {
  switch (action.kind) {
    case "insert-prompt":
      return action.text;
    case "attach-mcp":
      return action.command;
    case "show-guidance":
      return action.text;
    case "confirm-command":
      return capabilityConfirmationText(action.command, action.args);
  }
}

export function capabilityConfirmationText(command: string, args: readonly string[]): string {
  return `${CONFIRM_PREFIX}${[command, ...args].join(" ")}${CONFIRM_SUFFIX}`;
}

/**
 * Parse only the confirmation shape generated above, then allowlist argv.
 * This is the second-step guard: selecting a row can only stage this text;
 * execution is possible only after the staged line is submitted separately.
 */
export function parseCapabilityConfirmation(text: string): { readonly command: string; readonly args: readonly string[] } | undefined {
  if (!text.startsWith(CONFIRM_PREFIX) || !text.endsWith(CONFIRM_SUFFIX)) return undefined;
  const words = text.slice(CONFIRM_PREFIX.length, -CONFIRM_SUFFIX.length).trim().split(/\s+/);
  const [command, ...args] = words;
  if (command !== "codex") return undefined;
  if (args.length === 3 && args[0] === "mcp" && args[1] === "enable" && isSafeCapabilityId(args[2])) return { command, args };
  if (args.length === 3 && args[0] === "plugin" && args[1] === "install" && isSafeCapabilityId(args[2])) return { command, args };
  return undefined;
}

export function isCapabilityConfirmationText(text: string): boolean {
  return parseCapabilityConfirmation(text) !== undefined;
}

function parseGuardedCommand(guidance: string | undefined): { readonly command: string; readonly args: readonly string[] } | undefined {
  if (!guidance) return undefined;
  const parsed = parseCapabilityConfirmation(capabilityConfirmationText(...commandWords(guidance)));
  return parsed;
}

function commandWords(value: string): [string, string[]] {
  const [command = "", ...args] = value.trim().split(/\s+/);
  return [command, args];
}

function isSafeCapabilityId(value: string | undefined): value is string {
  return Boolean(value && /^[A-Za-z0-9._@-]+$/.test(value));
}

/** Hide action payloads from the row label while preserving them through pi-tui. */
export function encodeCapabilitySelection(text: string): string {
  return `${ENCODED_SELECTION_PREFIX}${encodeURIComponent(text)}`;
}

export function decodeCapabilitySelection(value: string): string | undefined {
  if (!value.startsWith(ENCODED_SELECTION_PREFIX)) return undefined;
  try {
    return decodeURIComponent(value.slice(ENCODED_SELECTION_PREFIX.length));
  } catch {
    return undefined;
  }
}
