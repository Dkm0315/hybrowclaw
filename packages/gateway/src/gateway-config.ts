import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Gateway-local config (.muster/gateway.json): bearer token + adapter bot tokens. */
export interface GatewayCustomCommand {
  /** Reader-facing summary shown in future command listings. */
  readonly description?: string;
  /** Prompt template; "{args}" or "{{args}}" is replaced with command args. */
  readonly prompt?: string;
  /** Exact surface id ("web:demo") or surface prefix ("telegram") allowed to use this command. */
  readonly surfaces?: readonly string[];
  readonly source?: "openclaw" | "user" | "migration";
  readonly sourceChannel?: string;
}

export interface GatewayConfig {
  readonly token: string;
  readonly port?: number;
  readonly governance?: GatewayGovernanceConfig;
  readonly commands?: {
    readonly entries?: Record<string, GatewayCustomCommand>;
  };
  readonly telegram?: {
    /** Friendly bot label shown in setup/status output; not used as a secret. */
    readonly name?: string;
    readonly botToken: string;
    /** "draft" streams replies as live-edited drafts (sendMessage + editMessageText). */
    readonly stream?: "off" | "draft";
    /** Native presence/progress behavior while a run is active. */
    readonly status?: "off" | "typing";
    /** High-level progress messages. Never exposes provider chain-of-thought. */
    readonly thinking?: "off" | "progress";
    /** Handling for a second message while the same chat already has a run. */
    readonly busy?: "queue" | "reject";
    /**
     * Optional webhook secret. When set, Telegram echoes it in the
     * X-Telegram-Bot-Api-Secret-Token header; the gateway rejects any webhook
     * whose header does not match (constant-time). Configure it via setWebhook.
     */
    readonly secretToken?: string;
  };
  readonly slack?: {
    readonly botToken: string;
    /** Slack Socket Mode app-level token (`xapp-...`). Avoids public HTTPS webhook setup. */
    readonly appToken?: string;
    /** Socket Mode is the local/private default; HTTP Events API stays available for public webhook deployments. */
    readonly mode?: "socket" | "http";
    /** "draft" streams replies as live-edited drafts (chat.postMessage + chat.update). */
    readonly stream?: "off" | "draft";
    /** Slack has no bot typing API; "message" posts/updates one progress note. */
    readonly status?: "off" | "message";
    /** High-level progress messages. Never exposes provider chain-of-thought. */
    readonly thinking?: "off" | "progress";
    /** Handling for a second message while the same Slack thread already has a run. */
    readonly busy?: "queue" | "reject";
    /**
     * Slack app "Signing Secret". When set, every webhook is verified against
     * the X-Slack-Signature / X-Slack-Request-Timestamp headers (v0 HMAC-SHA256)
     * before parsing, and stale requests (>5 min) are rejected as replays.
     */
    readonly signingSecret?: string;
  };
  readonly discord?: {
    readonly botToken: string;
    /** Application public key (hex, developer portal) for ed25519 interaction verification. */
    readonly publicKey?: string;
  };
  readonly whatsapp?: {
    readonly accessToken: string;
    readonly verifyToken: string;
    readonly phoneNumberId: string;
    /** Meta app secret for X-Hub-Signature-256 POST webhook verification. */
    readonly appSecret?: string;
    /** Graph API version segment; defaults to v19.0. */
    readonly apiVersion?: string;
  };
  readonly gchat?: { readonly verificationToken?: string };
  readonly teams?: { readonly hmacSecret?: string };
  readonly devices?: {
    readonly entries?: Record<string, GatewayDeviceRecord>;
  };
}

export interface GatewayDeviceRecord {
  readonly source?: "openclaw" | "migration" | "user";
  readonly sourceId?: string;
  readonly surfaceId?: string;
  readonly accountId?: string;
  readonly scopes?: readonly string[];
  readonly approved?: boolean;
  readonly migratedAt?: string;
}

export type GatewayGovernanceSubjectKind = "user" | "role" | "channel" | "surface" | "tenant" | "workspace";
export type GatewayGovernanceRateWindow = "minute" | "hour" | "day" | "month";

export interface GatewayGovernanceSubject {
  readonly kind: GatewayGovernanceSubjectKind;
  readonly id: string;
}

export interface GatewayGovernanceAssignment {
  /** Friendly user id used in reports; defaults to the surface sender id. */
  readonly userId?: string;
  readonly roles?: readonly string[];
  readonly tenantId?: string;
  readonly workspaceId?: string;
  readonly allowedSurfaces?: readonly string[];
  readonly allowedChannels?: readonly string[];
}

export interface GatewayGovernanceValidationConfig {
  readonly maxChars?: number;
  readonly blockSecrets?: boolean;
  readonly blockedPatterns?: readonly string[];
}

export interface GatewayGovernanceRateLimit {
  readonly subject: GatewayGovernanceSubject;
  readonly window: GatewayGovernanceRateWindow;
  readonly maxRuns?: number;
  readonly maxTokens?: number;
}

export interface GatewayGovernanceConfig {
  readonly enabled?: boolean;
  /**
   * Assignments are keyed by the most specific available identity:
   *   - "<surfaceId>:<senderId>"
   *   - "<senderId>"
   *   - "default"
   */
  readonly assignments?: Record<string, GatewayGovernanceAssignment>;
  readonly requestValidation?: GatewayGovernanceValidationConfig;
  readonly rateLimits?: readonly GatewayGovernanceRateLimit[];
  /** Conservative output estimate for pre-run token/rate checks; defaults to 800. */
  readonly estimatedOutputTokens?: number;
}

export const DEFAULT_GATEWAY_PORT = 7460;

export function gatewayConfigPath(cwd = process.cwd()): string {
  return join(cwd, ".muster", "gateway.json");
}

/** Create .muster/gateway.json with a fresh bearer token; reuse if present. */
export async function initGatewayConfig(cwd = process.cwd()): Promise<{ path: string; config: GatewayConfig; created: boolean }> {
  const path = gatewayConfigPath(cwd);
  try {
    const existing = await loadGatewayConfig(cwd);
    return { path, config: existing, created: false };
  } catch {
    const config: GatewayConfig = { token: randomBytes(24).toString("hex"), port: DEFAULT_GATEWAY_PORT };
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o700).catch(() => undefined);
    await writeJsonAtomic(path, config);
    return { path, config, created: true };
  }
}

export async function loadGatewayConfig(cwd = process.cwd()): Promise<GatewayConfig> {
  const raw = await readFile(gatewayConfigPath(cwd), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new Error("Gateway not initialized. Run: muster gateway init");
    }
    throw error;
  });
  const parsed = JSON.parse(raw) as Partial<GatewayConfig>;
  if (typeof parsed.token !== "string" || !parsed.token.trim()) {
    throw new Error(`Gateway config at ${gatewayConfigPath(cwd)} is missing a "token". Re-run: muster gateway init`);
  }
  return parsed as GatewayConfig;
}

export async function saveGatewayConfig(config: GatewayConfig, cwd = process.cwd()): Promise<string> {
  const path = gatewayConfigPath(cwd);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700).catch(() => undefined);
  await writeJsonAtomic(path, config);
  return path;
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temp, 0o600).catch(() => undefined);
  await rename(temp, target);
  await chmod(target, 0o600).catch(() => undefined);
}
