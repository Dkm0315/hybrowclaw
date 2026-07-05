interface ChannelContext {
  readonly config: Readonly<Record<string, string | undefined>>;
}

interface GatewayLike {
  readonly port?: number;
  readonly slack?: { readonly botToken?: string; readonly appToken?: string; readonly signingSecret?: string; readonly mode?: "socket" | "http"; readonly stream?: "off" | "draft" } | null;
}

const ROUTE = "/v1/adapters/slack";
const SETUP_URLS = [
  "https://api.slack.com/apps",
  "https://api.slack.com/scopes/files:write",
  "https://api.slack.com/apis/connections/socket",
  "https://api.slack.com/apis/connections/events-api",
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

function hasToken(gateway: GatewayLike | undefined, context: ChannelContext): boolean {
  return Boolean(gateway?.slack?.botToken || context.config.SLACK_BOT_TOKEN);
}

function hasSigningSecret(gateway: GatewayLike | undefined, context: ChannelContext): boolean {
  return Boolean(gateway?.slack?.signingSecret || context.config.SLACK_SIGNING_SECRET);
}

function hasAppToken(gateway: GatewayLike | undefined, context: ChannelContext): boolean {
  return Boolean(gateway?.slack?.appToken || context.config.SLACK_APP_TOKEN);
}

function slackMode(gateway: GatewayLike | undefined, args: Record<string, unknown>, context: ChannelContext): "socket" | "http" {
  const explicit = stringArg(args, "mode");
  if (explicit === "socket" || explicit === "http") return explicit;
  if (gateway?.slack?.mode) return gateway.slack.mode;
  if (gateway?.slack?.appToken || context.config.SLACK_APP_TOKEN) return "socket";
  if (gateway?.slack?.signingSecret) return "http";
  return "socket";
}

export async function slack_setup_plan(args: Record<string, unknown>, context: ChannelContext) {
  const gateway = gatewayArg(args);
  const base = publicBase(args, gateway);
  const mode = slackMode(gateway, args, context);
  return {
    channel: "slack",
    label: "Slack App",
    mode,
    ready: hasToken(gateway, context) && (mode === "socket" ? hasAppToken(gateway, context) : hasSigningSecret(gateway, context)),
    webhookUrl: mode === "http" ? `${base}${ROUTE}` : undefined,
    setupUrls: SETUP_URLS,
    prerequisites: [
      "Slack app with bot token scopes: app_mentions:read, channels:history, chat:write, files:write, im:history, im:write.",
      mode === "socket" ? "Socket Mode enabled with an app-level token (xapp-...) that has connections:write." : "Events API enabled with message/app_mention subscriptions.",
      mode === "socket" ? "No public HTTPS URL is required for Socket Mode." : "Signing secret copied from Basic Information.",
      mode === "socket" ? "Run the gateway daemon with --with-slack-socket." : "Public HTTPS gateway URL for Slack request delivery.",
    ],
    commands: [
      "muster gateway init",
      mode === "socket"
        ? "muster channels ready slack --bot-token-env SLACK_BOT_TOKEN --app-token-env SLACK_APP_TOKEN"
        : `muster channels ready slack --mode http --bot-token-env SLACK_BOT_TOKEN --signing-secret-env SLACK_SIGNING_SECRET --public-url ${base}`,
      "muster channels status slack",
      mode === "socket" ? "muster gateway daemon start --with-slack-socket --port 7460" : "muster gateway daemon start --port 7460",
    ],
    notes: [
      "Socket Mode is the easiest local/private setup and does not require ngrok or a public endpoint.",
      "Muster verifies Slack signatures when HTTP Events API mode is configured.",
      "files:write is required for generated PDFs, documents, spreadsheets, decks, and other artifacts to appear as native Slack files.",
      "Use draft streaming only after normal replies work.",
    ],
  };
}

export async function slack_gateway_check(args: Record<string, unknown>, context: ChannelContext) {
  const gateway = gatewayArg(args);
  const token = hasToken(gateway, context);
  const appToken = hasAppToken(gateway, context);
  const signingSecret = hasSigningSecret(gateway, context);
  const mode = slackMode(gateway, args, context);
  return {
    channel: "slack",
    mode,
    ready: token && (mode === "socket" ? appToken : signingSecret),
    checks: [
      { id: "bot_token", ok: token, detail: token ? "bot token configured" : "Set SLACK_BOT_TOKEN and run channels ready." },
      mode === "socket"
        ? { id: "app_token", ok: appToken, detail: appToken ? "Socket Mode app token configured" : "Set SLACK_APP_TOKEN and run channels ready." }
        : { id: "signing_secret", ok: signingSecret, detail: signingSecret ? "signing secret configured" : "Set SLACK_SIGNING_SECRET and run channels ready." },
      { id: "file_upload_scope", ok: false, detail: "Run `muster channels doctor slack --live`; native document/artifact uploads require files:write and Slack app reinstall." },
      mode === "socket"
        ? { id: "socket_mode", ok: true, detail: "No public HTTPS URL required." }
        : { id: "public_https_url", ok: Boolean(stringArg(args, "publicUrl")?.startsWith("https://")), detail: "Slack Event Subscriptions require a public HTTPS Request URL." },
    ],
    next: token && (mode === "socket" ? appToken : signingSecret)
      ? mode === "socket" ? "Start the gateway daemon with --with-slack-socket and message the app." : "Start the gateway daemon and verify the Slack Request URL."
      : mode === "socket" ? "Run muster channels ready slack with bot-token and app-token env vars." : "Run muster channels ready slack --mode http with token and signing-secret env vars.",
  };
}

export async function slack_event_summary(args: Record<string, unknown>) {
  const outer = args as Record<string, unknown>;
  const event = (typeof args.event === "object" && args.event !== null ? args.event : args) as Record<string, unknown>;
  const inner = typeof event.event === "object" && event.event !== null ? event.event as Record<string, unknown> : event;
  return {
    type: typeof inner.type === "string" ? inner.type : undefined,
    team: typeof outer.team_id === "string" ? outer.team_id : typeof event.team_id === "string" ? event.team_id : typeof inner.team === "string" ? inner.team : undefined,
    channel: typeof inner.channel === "string" ? inner.channel : undefined,
    user: typeof inner.user === "string" ? inner.user : undefined,
    text: typeof inner.text === "string" ? inner.text : "",
    threadTs: typeof inner.thread_ts === "string" ? inner.thread_ts : typeof inner.ts === "string" ? inner.ts : undefined,
  };
}

export const tools = {
  slack_setup_plan,
  slack_gateway_check,
  slack_event_summary,
};
