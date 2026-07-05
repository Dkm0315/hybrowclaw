interface ChannelContext {
  readonly config: Readonly<Record<string, string | undefined>>;
}

interface GatewayLike {
  readonly port?: number;
  readonly gchat?: { readonly verificationToken?: string } | null;
}

const ROUTE = "/v1/adapters/gchat";
const SETUP_URLS = [
  "https://console.cloud.google.com/apis/library/chat.googleapis.com",
  "https://developers.google.com/workspace/chat/quickstart/webhooks",
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

function ready(gateway: GatewayLike | undefined, context: ChannelContext): boolean {
  return Boolean(gateway?.gchat?.verificationToken || context.config.GOOGLE_CHAT_VERIFICATION_TOKEN);
}

export async function google_chat_setup_plan(args: Record<string, unknown>, context: ChannelContext) {
  const gateway = gatewayArg(args);
  const base = publicBase(args, gateway);
  return {
    channel: "google-chat",
    gatewayChannel: "gchat",
    label: "Google Chat App",
    ready: ready(gateway, context),
    webhookUrl: `${base}${ROUTE}`,
    setupUrls: SETUP_URLS,
    prerequisites: [
      "A deployed Muster gateway URL reachable by Google Chat over HTTPS.",
      "Google Chat API enabled in the target Google Cloud project.",
      "A Google Chat app configured to send events to the Muster webhook URL.",
      "Verification token configured in Google Cloud and Muster so Google Chat can authenticate without Muster's gateway bearer token.",
    ],
    commands: [
      "muster gateway init",
      `muster channels ready gchat --verification-token-env GOOGLE_CHAT_VERIFICATION_TOKEN --public-url ${base}`,
      "muster channels status gchat",
      "muster gateway daemon start --port 7460",
    ],
    notes: [
      "Google Chat app identity lives in Google Cloud; Muster needs the webhook URL and verification token to accept real events.",
      "Use this channel when Telegram is unavailable in your region but Google Workspace is available.",
    ],
  };
}

export async function google_chat_gateway_check(args: Record<string, unknown>, context: ChannelContext) {
  const gateway = gatewayArg(args);
  const hasGatewayEntry = Boolean(gateway?.gchat?.verificationToken || context.config.GOOGLE_CHAT_VERIFICATION_TOKEN);
  const hasVerificationToken = Boolean(gateway?.gchat?.verificationToken || context.config.GOOGLE_CHAT_VERIFICATION_TOKEN);
  return {
    channel: "google-chat",
    ready: ready(gateway, context),
    checks: [
      { id: "gateway_config", ok: hasGatewayEntry, detail: hasGatewayEntry ? "gchat verification token is present" : "Run: muster channels ready gchat --verification-token-env GOOGLE_CHAT_VERIFICATION_TOKEN --public-url <https-url>" },
      { id: "verification_token", ok: hasVerificationToken, detail: hasVerificationToken ? "verification token configured" : "Add --verification-token-env GOOGLE_CHAT_VERIFICATION_TOKEN" },
      { id: "public_https_url", ok: Boolean(stringArg(args, "publicUrl")?.startsWith("https://")), detail: "Google Chat production webhooks require an HTTPS URL." },
    ],
    next: hasGatewayEntry ? "Start the gateway daemon and paste the webhook URL into Google Cloud Chat API configuration." : "Run muster channels ready gchat with verification-token env.",
  };
}

export async function google_chat_event_summary(args: Record<string, unknown>) {
  const event = (typeof args.event === "object" && args.event !== null ? args.event : args) as Record<string, unknown>;
  const message = typeof event.message === "object" && event.message !== null ? event.message as Record<string, unknown> : {};
  const space = typeof event.space === "object" && event.space !== null ? event.space as Record<string, unknown> : typeof message.space === "object" && message.space !== null ? message.space as Record<string, unknown> : {};
  const user = typeof event.user === "object" && event.user !== null ? event.user as Record<string, unknown> : typeof message.sender === "object" && message.sender !== null ? message.sender as Record<string, unknown> : {};
  return {
    type: typeof event.type === "string" ? event.type : "MESSAGE",
    text: typeof message.text === "string" ? message.text : "",
    space: typeof space.name === "string" ? space.name : undefined,
    user: typeof user.name === "string" ? user.name : typeof user.displayName === "string" ? user.displayName : undefined,
    thread: typeof message.thread === "object" && message.thread !== null && typeof (message.thread as Record<string, unknown>).name === "string" ? (message.thread as Record<string, string>).name : undefined,
  };
}

export const tools = {
  google_chat_setup_plan,
  google_chat_gateway_check,
  google_chat_event_summary,
};
