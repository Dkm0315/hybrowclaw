interface ChannelContext {
  readonly config: Readonly<Record<string, string | undefined>>;
}

interface GatewayLike {
  readonly port?: number;
  readonly whatsapp?: {
    readonly accessToken?: string;
    readonly verifyToken?: string;
    readonly phoneNumberId?: string;
    readonly appSecret?: string;
    readonly apiVersion?: string;
  } | null;
}

const ROUTE = "/v1/adapters/whatsapp";
const SETUP_URLS = [
  "https://developers.facebook.com/docs/whatsapp/cloud-api/get-started",
  "https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks",
  "https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages",
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

function hasAccessToken(gateway: GatewayLike | undefined, context: ChannelContext): boolean {
  return Boolean(gateway?.whatsapp?.accessToken || context.config.WHATSAPP_ACCESS_TOKEN);
}

function hasVerifyToken(gateway: GatewayLike | undefined, context: ChannelContext): boolean {
  return Boolean(gateway?.whatsapp?.verifyToken || context.config.WHATSAPP_VERIFY_TOKEN);
}

function hasPhoneNumberId(gateway: GatewayLike | undefined, context: ChannelContext): boolean {
  return Boolean(gateway?.whatsapp?.phoneNumberId || context.config.WHATSAPP_PHONE_NUMBER_ID);
}

function hasAppSecret(gateway: GatewayLike | undefined, context: ChannelContext): boolean {
  return Boolean(gateway?.whatsapp?.appSecret || context.config.WHATSAPP_APP_SECRET);
}

function ready(gateway: GatewayLike | undefined, context: ChannelContext): boolean {
  return hasAccessToken(gateway, context) && hasVerifyToken(gateway, context) && hasPhoneNumberId(gateway, context) && hasAppSecret(gateway, context);
}

export async function whatsapp_setup_plan(args: Record<string, unknown>, context: ChannelContext) {
  const gateway = gatewayArg(args);
  const base = publicBase(args, gateway);
  const apiVersion = stringArg(args, "apiVersion") ?? gateway?.whatsapp?.apiVersion ?? "v19.0";
  return {
    channel: "whatsapp",
    label: "WhatsApp Cloud API",
    ready: ready(gateway, context),
    webhookUrl: `${base}${ROUTE}`,
    verifyUrl: `${base}${ROUTE}?hub.mode=subscribe&hub.verify_token=<verify-token>&hub.challenge=<challenge>`,
    graphMessagesUrl: `https://graph.facebook.com/${apiVersion}/<phone-number-id>/messages`,
    setupUrls: SETUP_URLS,
    prerequisites: [
      "Meta developer app with WhatsApp product enabled.",
      "Permanent or long-lived access token stored in WHATSAPP_ACCESS_TOKEN.",
      "Webhook verify token stored in WHATSAPP_VERIFY_TOKEN.",
      "Phone Number ID stored in WHATSAPP_PHONE_NUMBER_ID.",
      "Meta app secret stored in WHATSAPP_APP_SECRET for X-Hub-Signature-256 POST verification.",
      "Public HTTPS gateway URL for Meta webhook delivery.",
    ],
    commands: [
      "muster gateway init",
      `muster channels ready whatsapp --access-token-env WHATSAPP_ACCESS_TOKEN --verify-token-env WHATSAPP_VERIFY_TOKEN --phone-number-id-env WHATSAPP_PHONE_NUMBER_ID --app-secret-env WHATSAPP_APP_SECRET --api-version ${apiVersion} --public-url ${base}`,
      "muster channels status whatsapp",
      "muster gateway daemon start --port 7460",
    ],
    notes: [
      "Muster uses Meta's Cloud API webhook handshake and replies through the Graph /messages endpoint.",
      "OpenClaw also supports WhatsApp Web socket workflows; this pack is intentionally Cloud API only because that is Muster's current gateway adapter.",
      "Pairing policy still applies before replies reach a real conversation.",
    ],
  };
}

export async function whatsapp_gateway_check(args: Record<string, unknown>, context: ChannelContext) {
  const gateway = gatewayArg(args);
  const token = hasAccessToken(gateway, context);
  const verify = hasVerifyToken(gateway, context);
  const phone = hasPhoneNumberId(gateway, context);
  const appSecret = hasAppSecret(gateway, context);
  return {
    channel: "whatsapp",
    ready: token && verify && phone && appSecret,
    checks: [
      { id: "access_token", ok: token, detail: token ? "access token configured" : "Set WHATSAPP_ACCESS_TOKEN and run channels ready." },
      { id: "verify_token", ok: verify, detail: verify ? "verify token configured" : "Set WHATSAPP_VERIFY_TOKEN and run channels ready." },
      { id: "phone_number_id", ok: phone, detail: phone ? "phone number id configured" : "Set WHATSAPP_PHONE_NUMBER_ID and run channels ready." },
      { id: "app_secret", ok: appSecret, detail: appSecret ? "app secret configured for POST signature checks" : "Set WHATSAPP_APP_SECRET and run channels ready." },
      { id: "public_https_url", ok: Boolean(stringArg(args, "publicUrl")?.startsWith("https://")), detail: "Meta webhooks require a public HTTPS callback URL in production." },
    ],
    next: token && verify && phone && appSecret ? "Start the gateway daemon and paste the callback URL plus verify token into Meta webhook configuration." : "Run muster channels ready whatsapp with access-token, verify-token, phone-number-id, and app-secret env vars.",
  };
}

export async function whatsapp_webhook_summary(args: Record<string, unknown>) {
  const payload = (typeof args.webhook === "object" && args.webhook !== null ? args.webhook : args) as Record<string, unknown>;
  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  const messages: Array<{ from?: string; id?: string; type?: string; text?: string; phoneNumberId?: string; replyTo?: string }> = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const changes = Array.isArray((entry as Record<string, unknown>).changes) ? (entry as Record<string, unknown>).changes as unknown[] : [];
    for (const change of changes) {
      if (typeof change !== "object" || change === null) continue;
      const value = typeof (change as Record<string, unknown>).value === "object" && (change as Record<string, unknown>).value !== null
        ? (change as Record<string, unknown>).value as Record<string, unknown>
        : {};
      const metadata = typeof value.metadata === "object" && value.metadata !== null ? value.metadata as Record<string, unknown> : {};
      const phoneNumberId = typeof metadata.phone_number_id === "string" ? metadata.phone_number_id : undefined;
      const rawMessages = Array.isArray(value.messages) ? value.messages : [];
      for (const rawMessage of rawMessages) {
        if (typeof rawMessage !== "object" || rawMessage === null) continue;
        const message = rawMessage as Record<string, unknown>;
        const text = typeof message.text === "object" && message.text !== null && typeof (message.text as Record<string, unknown>).body === "string"
          ? (message.text as Record<string, string>).body
          : typeof message.button === "object" && message.button !== null && typeof (message.button as Record<string, unknown>).text === "string"
            ? (message.button as Record<string, string>).text
            : undefined;
        const context = typeof message.context === "object" && message.context !== null ? message.context as Record<string, unknown> : {};
        messages.push({
          from: typeof message.from === "string" ? message.from : undefined,
          id: typeof message.id === "string" ? message.id : undefined,
          type: typeof message.type === "string" ? message.type : undefined,
          text,
          phoneNumberId,
          replyTo: typeof context.id === "string" ? context.id : undefined,
        });
      }
    }
  }
  return {
    object: typeof payload.object === "string" ? payload.object : undefined,
    messages,
    messageCount: messages.length,
  };
}

export const tools = {
  whatsapp_setup_plan,
  whatsapp_gateway_check,
  whatsapp_webhook_summary,
};
