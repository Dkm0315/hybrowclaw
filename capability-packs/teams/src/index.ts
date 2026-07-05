interface ChannelContext {
  readonly config: Readonly<Record<string, string | undefined>>;
}

interface GatewayLike {
  readonly port?: number;
  readonly teams?: { readonly hmacSecret?: string } | null;
}

const ROUTE = "/v1/adapters/teams";
const SETUP_URLS = [
  "https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-and-group-conversations",
  "https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/authentication/bot-sso-overview",
  "https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
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

function hasGatewayEntry(gateway: GatewayLike | undefined): boolean {
  return Boolean(gateway?.teams?.hmacSecret);
}

function hasHmacSecret(gateway: GatewayLike | undefined, context: ChannelContext): boolean {
  return Boolean(gateway?.teams?.hmacSecret || context.config.TEAMS_HMAC_SECRET);
}

export async function teams_setup_plan(args: Record<string, unknown>, context: ChannelContext) {
  const gateway = gatewayArg(args);
  const base = publicBase(args, gateway);
  return {
    channel: "teams",
    label: "Microsoft Teams Bot",
    ready: hasGatewayEntry(gateway),
    webhookUrl: `${base}${ROUTE}`,
    setupUrls: SETUP_URLS,
    prerequisites: [
      "Azure app registration or Bot Framework registration for the Teams app identity.",
      "A public HTTPS Muster gateway URL reachable by Microsoft Teams.",
      "Teams bot messaging endpoint set to the Muster Teams adapter webhook.",
      "Shared HMAC secret configured in Teams middleware and Muster so Teams traffic can authenticate without Muster's gateway bearer token.",
    ],
    commands: [
      "muster gateway init",
      `muster channels ready teams --hmac-secret-env TEAMS_HMAC_SECRET --public-url ${base}`,
      "muster channels status teams",
      "muster gateway daemon start --port 7460",
    ],
    notes: [
      "Muster's Teams adapter accepts Teams-style message activities and maps them to the same surface pipeline as other chat channels.",
      "Use --hmac-secret-env TEAMS_HMAC_SECRET so your edge layer can sign Teams activity payloads for the gateway.",
      "Production Bot Framework OAuth, SSO, and app manifest publishing remain explicit Azure/Teams setup steps.",
    ],
    security: {
      hmacConfigured: hasHmacSecret(gateway, context),
      recommendation: "Keep Teams app secrets in environment variables or your deployment secret manager; never paste them into prompts.",
    },
  };
}

export async function teams_gateway_check(args: Record<string, unknown>, context: ChannelContext) {
  const gateway = gatewayArg(args);
  const gatewayEntry = hasGatewayEntry(gateway);
  const hmac = hasHmacSecret(gateway, context);
  const https = Boolean(stringArg(args, "publicUrl")?.startsWith("https://"));
  return {
    channel: "teams",
    ready: gatewayEntry,
    checks: [
      { id: "gateway_config", ok: gatewayEntry, detail: gatewayEntry ? "teams HMAC entry is present" : "Run: muster channels ready teams --hmac-secret-env TEAMS_HMAC_SECRET --public-url <https-url>" },
      { id: "public_https_url", ok: https, detail: "Teams production messaging endpoints require a public HTTPS URL." },
      { id: "hmac_secret", ok: hmac, detail: hmac ? "HMAC secret configured" : "Add --hmac-secret-env TEAMS_HMAC_SECRET when your edge layer signs requests." },
    ],
    next: gatewayEntry ? "Start the gateway daemon and configure the Teams bot messaging endpoint." : "Run muster channels ready teams with hmac-secret env.",
  };
}

export async function teams_activity_summary(args: Record<string, unknown>) {
  const activity = (typeof args.activity === "object" && args.activity !== null ? args.activity : args) as Record<string, unknown>;
  const from = typeof activity.from === "object" && activity.from !== null ? activity.from as Record<string, unknown> : {};
  const conversation = typeof activity.conversation === "object" && activity.conversation !== null ? activity.conversation as Record<string, unknown> : {};
  const channelData = typeof activity.channelData === "object" && activity.channelData !== null ? activity.channelData as Record<string, unknown> : {};
  const tenant = typeof channelData.tenant === "object" && channelData.tenant !== null ? channelData.tenant as Record<string, unknown> : {};
  return {
    type: typeof activity.type === "string" ? activity.type : "message",
    text: typeof activity.text === "string" ? activity.text : "",
    id: typeof activity.id === "string" ? activity.id : undefined,
    user: typeof from.name === "string" ? from.name : typeof from.id === "string" ? from.id : undefined,
    conversation: typeof conversation.id === "string" ? conversation.id : undefined,
    tenant: typeof tenant.id === "string" ? tenant.id : undefined,
    serviceUrl: typeof activity.serviceUrl === "string" ? activity.serviceUrl : undefined,
  };
}

export const tools = {
  teams_setup_plan,
  teams_gateway_check,
  teams_activity_summary,
};
