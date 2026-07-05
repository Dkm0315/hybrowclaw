interface ChannelContext {
  readonly config: Readonly<Record<string, string | undefined>>;
}

interface GatewayLike {
  readonly port?: number;
  readonly discord?: { readonly botToken?: string; readonly publicKey?: string } | null;
}

const ROUTE = "/v1/adapters/discord";
const SETUP_URLS = [
  "https://discord.com/developers/applications",
  "https://discord.com/developers/docs/interactions/overview",
  "https://discord.com/developers/docs/interactions/application-commands",
];

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function gatewayArg(args: Record<string, unknown>): GatewayLike | undefined {
  const value = args.gatewayConfig;
  return typeof value === "object" && value !== null ? value as GatewayLike : undefined;
}

function publicBase(args: Record<string, unknown>, gateway?: GatewayLike): string {
  const explicit = stringArg(args, "publicUrl")?.replace(/\/+$/, "");
  if (explicit) return explicit;
  const port = typeof gateway?.port === "number" && Number.isFinite(gateway.port) ? gateway.port : 7460;
  return `http://127.0.0.1:${port}`;
}

function hasBotToken(gateway: GatewayLike | undefined, context: ChannelContext): boolean {
  return Boolean(gateway?.discord?.botToken || context.config.DISCORD_BOT_TOKEN);
}

function hasPublicKey(gateway: GatewayLike | undefined, context: ChannelContext): boolean {
  return Boolean(gateway?.discord?.publicKey || context.config.DISCORD_PUBLIC_KEY);
}

export async function discord_setup_plan(args: Record<string, unknown>, context: ChannelContext) {
  const gateway = gatewayArg(args);
  const base = publicBase(args, gateway);
  const token = hasBotToken(gateway, context);
  const publicKey = hasPublicKey(gateway, context);
  return {
    channel: "discord",
    label: "Discord App",
    ready: token && publicKey,
    webhookUrl: `${base}${ROUTE}`,
    setupUrls: SETUP_URLS,
    prerequisites: [
      "Discord application created in the Developer Portal.",
      "Bot token copied into an environment variable for gateway outbound replies.",
      "Interactions endpoint URL set to the Muster Discord adapter webhook.",
      "Application public key copied for gateway-level Ed25519 signature verification.",
      "A slash command whose text option carries the user prompt.",
    ],
    commands: [
      "muster gateway init",
      `muster channels ready discord --bot-token-env DISCORD_BOT_TOKEN --public-key-env DISCORD_PUBLIC_KEY --public-url ${base}`,
      "muster channels status discord",
      "muster gateway daemon start --port 7460",
    ],
    notes: [
      "Discord sends slash-command interactions to the webhook and expects a synchronous response.",
      "The gateway ignores component interactions as message input; approval buttons are handled through the flows API.",
      "OpenClaw's Discord extension has broader channel actions; this pack covers the safe setup/doctor/debug subset around Muster's current adapter.",
    ],
    security: {
      botTokenConfigured: token,
      publicKeyConfigured: publicKey,
      recommendation: "Store DISCORD_BOT_TOKEN and DISCORD_PUBLIC_KEY outside prompts; `muster channels ready` reads env values and never prints them.",
    },
  };
}

export async function discord_gateway_check(args: Record<string, unknown>, context: ChannelContext) {
  const gateway = gatewayArg(args);
  const token = hasBotToken(gateway, context);
  const publicKey = hasPublicKey(gateway, context);
  return {
    channel: "discord",
    ready: token && publicKey,
    checks: [
      { id: "bot_token", ok: token, detail: token ? "bot token configured" : "Set DISCORD_BOT_TOKEN and run channels ready." },
      { id: "public_key", ok: publicKey, detail: publicKey ? "public key configured" : "Add DISCORD_PUBLIC_KEY for Discord interaction signature verification." },
      { id: "public_https_url", ok: Boolean(stringArg(args, "publicUrl")?.startsWith("https://")), detail: "Discord Interaction Endpoint URLs must be public HTTPS in production." },
    ],
    next: token && publicKey ? "Start the gateway daemon and paste the webhook URL into Discord Interactions Endpoint URL." : "Run muster channels ready discord with bot-token and public-key env.",
  };
}

function interactionUser(interaction: Record<string, unknown>): string | undefined {
  const member = typeof interaction.member === "object" && interaction.member !== null ? interaction.member as Record<string, unknown> : {};
  const memberUser = typeof member.user === "object" && member.user !== null ? member.user as Record<string, unknown> : {};
  const user = typeof interaction.user === "object" && interaction.user !== null ? interaction.user as Record<string, unknown> : memberUser;
  return typeof user.id === "string" ? user.id : undefined;
}

function optionText(data: Record<string, unknown>): string {
  const options = Array.isArray(data.options) ? data.options : [];
  return options
    .map((option) => typeof option === "object" && option !== null ? (option as Record<string, unknown>).value : undefined)
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .trim();
}

export async function discord_interaction_summary(args: Record<string, unknown>) {
  const interaction = (typeof args.interaction === "object" && args.interaction !== null ? args.interaction : args) as Record<string, unknown>;
  const data = typeof interaction.data === "object" && interaction.data !== null ? interaction.data as Record<string, unknown> : {};
  return {
    type: typeof interaction.type === "number" ? interaction.type : undefined,
    id: typeof interaction.id === "string" ? interaction.id : undefined,
    guild: typeof interaction.guild_id === "string" ? interaction.guild_id : undefined,
    channel: typeof interaction.channel_id === "string" ? interaction.channel_id : undefined,
    user: interactionUser(interaction),
    command: typeof data.name === "string" ? data.name : undefined,
    customId: typeof data.custom_id === "string" ? data.custom_id : undefined,
    text: optionText(data),
    messageId: typeof interaction.message === "object" && interaction.message !== null && typeof (interaction.message as Record<string, unknown>).id === "string"
      ? (interaction.message as Record<string, string>).id
      : undefined,
  };
}

export const tools = {
  discord_setup_plan,
  discord_gateway_check,
  discord_interaction_summary,
};
