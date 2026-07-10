import { clearConversationSessionHandles } from "@musterhq/core";
import type { MusterConfig } from "@musterhq/core";
import type { GatewayConfig, GatewayCustomCommand } from "./gateway-config.js";
import type { PairedSender } from "./pairing.js";
import type { SurfaceMessage, SurfaceReply } from "./envelope.js";
import { isInteractionCommand, renderInteractionCommand } from "./interaction.js";
import type { GatewayEnterpriseRuntime } from "./enterprise-runtime.js";

/**
 * A leading /command, requiring the name to end at whitespace or string end so
 * that prompts beginning with a path (e.g. "/etc/hosts is missing") are NOT
 * swallowed as commands and pass through to the agent untouched.
 */
const COMMAND_PATTERN = /^\/([a-z][a-z0-9_-]*)(?:[ \t]+([\s\S]*))?$/i;

export interface ParsedCommand {
  readonly name: string;
  readonly args: string;
}

export interface ResolvedCustomCommand {
  readonly commandName: string;
  readonly args: string;
  readonly prompt: string;
}

export function parseCommand(text: string): ParsedCommand | null {
  const match = COMMAND_PATTERN.exec(text.trim());
  if (!match) return null;
  return { name: match[1].toLowerCase(), args: (match[2] ?? "").trim() };
}

function customCommandEntry(parsed: ParsedCommand, gateway: GatewayConfig | undefined): GatewayCustomCommand | undefined {
  const entries = gateway?.commands?.entries;
  if (!entries) return undefined;
  return entries[parsed.name] ?? entries[parsed.name.replace(/_/g, "-")];
}

function surfaceMatches(command: GatewayCustomCommand, surfaceId: string): boolean {
  if (!command.surfaces?.length) return true;
  return command.surfaces.some((surface) => surface === surfaceId || surfaceId.startsWith(`${surface}:`));
}

function renderCustomPrompt(name: string, args: string, entry: GatewayCustomCommand, message: SurfaceMessage): string {
  const body = entry.prompt?.trim()
    ? entry.prompt.replace(/\{\{\s*args\s*\}\}|\{args\}/g, args)
    : `Handle the custom command /${name}.${args ? `\n\nCommand arguments:\n${args}` : ""}`;
  return [
    `Run custom surface command "/${name}".`,
    entry.description ? `Command description: ${entry.description}` : undefined,
    `Surface: ${message.surfaceId}`,
    "",
    "Command instruction:",
    body,
  ].filter((line): line is string => line !== undefined).join("\n");
}

export function resolveCustomCommand(message: SurfaceMessage, gateway: GatewayConfig | undefined): ResolvedCustomCommand | undefined {
  const parsed = parseCommand(message.text);
  if (!parsed || isBuiltinCommand(parsed.name)) return undefined;
  const entry = customCommandEntry(parsed, gateway);
  if (!entry || !surfaceMatches(entry, message.surfaceId)) return undefined;
  return {
    commandName: parsed.name,
    args: parsed.args,
    prompt: renderCustomPrompt(parsed.name, parsed.args, entry, message),
  };
}

/** Builtin commands answered in-gateway with no model call. */
const BUILTINS = [
  "start", "help", "status", "pair", "new", "reset", "stop", "whoami", "tools", "reports", "tokens", "usage", "limits", "security", "evals", "index", "settings",
  "approvals", "audit", "incidents", "providers", "models", "plugins", "skills", "mcp", "channels", "agents", "artifacts", "sessions", "memory",
] as const;
type BuiltinName = (typeof BUILTINS)[number];

export function isBuiltinCommand(name: string): name is BuiltinName {
  return (BUILTINS as readonly string[]).includes(name);
}

export interface CommandContext {
  readonly config: MusterConfig;
  readonly profile: string;
  readonly paired: PairedSender;
  readonly gateway?: GatewayConfig;
  readonly cwd?: string;
  readonly conversationKey: string;
  /** Legacy pre-user-isolation lane, cleared on reset/new during migration. */
  readonly legacyConversationKey?: string;
  readonly enterprise?: GatewayEnterpriseRuntime;
}

/** A representative model for the active runtime, for /status and /start. */
function activeModel(config: MusterConfig, runtime: string): string {
  const rt = config.runtimes?.[runtime];
  const routeModel = rt?.routes ? Object.values(rt.routes)[0]?.model : undefined;
  const provider = rt?.provider ? config.providers?.[rt.provider] : undefined;
  return routeModel ?? provider?.defaultModel ?? "(unset)";
}

/**
 * Surface-level slash-command dispatch. Builtins (/start /pair /status
 * /help) are answered here directly — they never reach the model. ANY other
 * /command returns null so the caller can resolve per-surface custom commands,
 * user-invocable skills, then fall through to the native provider CLI.
 */
export async function dispatchCommand(message: SurfaceMessage, ctx: CommandContext): Promise<SurfaceReply | null> {
  const parsed = parseCommand(message.text);
  if (!parsed || !isBuiltinCommand(parsed.name)) return null;
  const runtime = ctx.config.routing?.defaultRuntime ?? "native";
  const model = activeModel(ctx.config, runtime);
  if (isInteractionCommand(parsed.name)) {
    return await renderInteractionCommand({
      command: parsed.name,
      args: parsed.args,
      config: ctx.config,
      profile: ctx.profile,
      runtime,
      model,
      paired: ctx.paired,
      message,
      gateway: ctx.gateway,
      enterprise: ctx.enterprise,
    });
  }
  switch (parsed.name) {
    case "pair":
      return {
        text: [
          "Pairing",
          "",
          `This chat is already paired (${ctx.paired.pairingId}). Nothing else is needed for this sender.`,
          "",
          "What can be done next:",
          "1. /whoami — show resolved identity",
          "2. /tools — show available tools",
          "3. /status — check runtime and connection",
        ].join("\n"),
      };
    case "new": {
      const removed = await clearCommandSessionHandles(ctx);
      return {
        text: `Started a fresh thread for this chat. Cleared ${removed} provider session handle${removed === 1 ? "" : "s"}.`,
      };
    }
    case "reset": {
      const removed = await clearCommandSessionHandles(ctx);
      return {
        text: `Reset this chat's provider session handles (${removed} cleared). Pairing, memory, and run history were left intact.`,
      };
    }
    case "stop":
      return {
        text: "No active gateway command is running for this chat. Streaming replies stop automatically if the channel reports a terminal delivery error.",
      };
  }
  return null;
}

async function clearCommandSessionHandles(ctx: CommandContext): Promise<number> {
  const keys = [...new Set([ctx.conversationKey, ctx.legacyConversationKey].filter((key): key is string => Boolean(key)))];
  let removed = 0;
  for (const key of keys) removed += await clearConversationSessionHandles(key, ctx.cwd);
  return removed;
}
