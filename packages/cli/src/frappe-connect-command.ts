import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { dataDir, ensureDefaultConfig, loadConfig } from "@musterhq/core";
import {
  FrappeSiteBindingCoordinator,
  initGatewayConfig,
  saveGatewayConfig,
  type GatewayConfig,
} from "@musterhq/gateway";

const DISCOVERY_PATH = "/api/method/muster.api.onboarding.discovery";
const HEALTH_PATH = "/v1/health";
const BINDING_STORE = "frappe-site-bindings.v1.enc.json";
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_POLL_MS = 1_000;

export interface FrappeConnectBinding {
  readonly bindingId: string;
  readonly tenantId: string;
  readonly siteUuid: string;
  readonly trustFingerprint: string;
}

export interface FrappeConnectLaunch {
  readonly siteOrigin: string;
  readonly musterOrigin: string;
  readonly onboardingUrl: string;
  readonly flows: readonly ("oauth_pkce" | "api_credentials")[];
  readonly capabilities: readonly string[];
  readonly provider: string;
  readonly connected: boolean;
  readonly binding?: FrappeConnectBinding;
  readonly browserOpened: boolean;
}

export interface FrappeConnectCommandOptions {
  readonly site: string;
  readonly musterOrigin?: string;
  readonly cwd?: string;
  readonly fetcher?: typeof fetch;
  readonly openUrl?: (url: string) => Promise<void>;
  readonly readLine?: (prompt: string) => Promise<string>;
  readonly log?: (line: string) => void;
  /** Defaults to the current terminal. Interactive mode waits for reciprocal verification. */
  readonly tty?: boolean;
  readonly color?: boolean;
  readonly openBrowser?: boolean;
  readonly qr?: boolean;
  readonly renderQr?: (value: string) => Promise<string | undefined>;
  readonly waitForVerification?: boolean;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Discover the app, inspect runtime readiness, persist public metadata, open
 * native Frappe consent, and wait for the gateway's verified trust record.
 * Nothing in this flow prints or returns a bearer, API secret, HMAC key, OAuth
 * code, PKCE verifier, or reciprocal challenge.
 */
export async function runFrappeConnectCommand(options: FrappeConnectCommandOptions): Promise<FrappeConnectLaunch> {
  const cwd = options.cwd ?? process.cwd();
  const log = options.log ?? console.log;
  const tty = options.tty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const color = options.color ?? tty;
  const progress = createProgress(log, color);
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = boundedDuration(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "Connection timeout", 1_000, 30 * 60_000);
  const pollIntervalMs = boundedDuration(options.pollIntervalMs ?? DEFAULT_POLL_MS, "Polling interval", 25, 10_000);
  const waitForVerification = options.waitForVerification ?? tty;
  const shouldOpenBrowser = options.openBrowser ?? true;
  const now = options.now ?? Date.now;

  progress.banner("Connect Muster to Frappe", "One consent. Reciprocal trust. No copied secrets.");
  progress.start(1, "Validate exact HTTPS origins");
  const siteOrigin = strictHttpsOrigin(options.site, "Frappe site");
  const gateway = await initGatewayConfig(cwd);
  const enteredOrigin = options.musterOrigin
    ?? gateway.config.frappe?.publicOrigin
    ?? process.env.MUSTER_PUBLIC_URL
    ?? await (options.readLine ?? readVisibleLine)("Public HTTPS URL for this Muster gateway: ");
  const musterOrigin = strictHttpsOrigin(enteredOrigin, "Muster gateway URL");
  progress.done(1, `${siteOrigin}  ↔  ${musterOrigin}`);

  progress.start(2, "Discover Muster for Frappe");
  const discovery = await discoverFrappe(fetcher, siteOrigin);
  progress.done(2, `Muster ${discovery.musterVersion} · Frappe ${discovery.frappeVersion} · protocol 1.0 · OAuth${discovery.flows.includes("api_credentials") ? " + API fallback" : ""}`);

  progress.start(3, "Inspect gateway and AI runtime readiness");
  const gatewayHealth = await inspectGateway(fetcher, musterOrigin);
  await ensureDefaultConfig(cwd);
  const config = await loadConfig(cwd);
  const runtime = config.runtimes[config.routing.defaultRuntime];
  if (!runtime || !config.providers[runtime.provider]) throw new Error("The default Muster AI runtime is not configured. Run `muster doctor` before connecting Frappe.");
  const provider = config.providers[runtime.provider]!;
  const missingProviderCredential = provider.apiKeyEnv && !process.env[provider.apiKeyEnv] ? provider.apiKeyEnv : undefined;
  progress.done(3, `${gatewayHealth} · ${runtime.id}/${provider.id}${missingProviderCredential ? ` · ${missingProviderCredential} not set` : " · configured"}`);

  progress.start(4, "Save public installation metadata");
  const installationId = gateway.config.frappe?.installationId
    ?? `muster-${createHash("sha256").update(gateway.config.token).digest("hex").slice(0, 24)}`;
  const next: GatewayConfig = {
    ...gateway.config,
    frappe: { ...gateway.config.frappe, publicOrigin: musterOrigin, installationId },
  };
  await saveGatewayConfig(next, cwd);
  progress.done(4, `installation ${installationId} · secrets hidden`);

  const existing = verifiedBindingForSite(cwd, next, siteOrigin);
  const onboarding = new URL("/muster-connect", siteOrigin);
  onboarding.searchParams.set("gateway_url", musterOrigin);
  const base: Omit<FrappeConnectLaunch, "connected" | "binding" | "browserOpened"> = {
    siteOrigin,
    musterOrigin,
    onboardingUrl: onboarding.toString(),
    flows: discovery.flows,
    capabilities: discovery.capabilities,
    provider: provider.id,
  };
  if (existing && discovery.connectionState === "trusted") {
    progress.done(5, "Existing reciprocal trust resumed; no new consent needed");
    printConnected(progress, existing, missingProviderCredential);
    return { ...base, connected: true, binding: existing, browserOpened: false };
  }
  if (existing) progress.warn(5, "Gateway trust exists but Frappe does not confirm it; fresh consent required");

  progress.start(5, "Open native Frappe consent");
  progress.link("Authorize this exact site", onboarding.toString(), tty);
  if ((options.qr ?? tty) && tty) {
    const qr = await (options.renderQr ?? renderTerminalQr)(onboarding.toString());
    if (qr) {
      progress.note("  Scan on your phone:");
      for (const line of qr.trimEnd().split("\n")) progress.note(`  ${line}`);
    }
  }
  let browserOpened = false;
  if (shouldOpenBrowser) {
    try {
      await (options.openUrl ?? openNativeBrowser)(onboarding.toString());
      browserOpened = true;
      progress.done(5, "Browser opened; approve as Administrator or System Manager");
    } catch {
      progress.warn(5, "Browser could not open; use the secure link above on this computer or phone");
    }
  } else {
    progress.done(5, "Automatic browser opening disabled; use the secure link above");
  }

  if (!waitForVerification) {
    progress.note("Consent is pending. Re-run the same command with --wait to resume safely.");
    return { ...base, connected: false, browserOpened };
  }

  progress.start(6, "Wait for reciprocal trust verification");
  const startedAt = now();
  const stopSpinner = startConsentSpinner(tty && options.log === undefined);
  let verified: FrappeConnectBinding | undefined;
  try {
    while (now() - startedAt < timeoutMs) {
      throwIfAborted(options.signal);
      const candidate = verifiedBindingForSite(cwd, next, siteOrigin);
      if (candidate) {
        const confirmation = await discoverFrappe(fetcher, siteOrigin);
        if (confirmation.connectionState === "trusted") {
          verified = candidate;
          break;
        }
      }
      await (options.sleep ?? abortableSleep)(pollIntervalMs, options.signal);
    }
  } finally {
    stopSpinner();
  }
  if (verified) {
    progress.done(6, "Frappe and Muster independently verified both challenges");
    printConnected(progress, verified, missingProviderCredential);
    return { ...base, connected: true, binding: verified, browserOpened };
  }
  throw new Error(`Connection timed out before reciprocal verification. Nothing was connected. Finish consent, then resume with: muster frappe connect ${siteOrigin} --muster-url ${musterOrigin} --wait`);
}

interface DiscoveryResult {
  readonly flows: readonly ("oauth_pkce" | "api_credentials")[];
  readonly capabilities: readonly string[];
  readonly musterVersion: string;
  readonly frappeVersion: string;
  readonly connectionState: "trusted" | "setup_required";
}

async function discoverFrappe(fetcher: typeof fetch, siteOrigin: string): Promise<DiscoveryResult> {
  const response = await fetcher(new URL(DISCOVERY_PATH, siteOrigin), {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status >= 300 && response.status < 400) throw new Error("Frappe discovery refused an HTTP redirect.");
  if (!response.ok) throw new Error(`Muster for Frappe discovery failed (HTTP ${response.status}). Install and migrate the Muster app first.`);
  const body = await response.text();
  if (Buffer.byteLength(body) > 64_000) throw new Error("Frappe discovery response was too large.");
  let raw: unknown;
  try { raw = JSON.parse(body); } catch { throw new Error("Frappe discovery returned invalid JSON."); }
  const value = object(object(raw).message ?? raw);
  if (value.product !== "Muster for Frappe" || value.protocol_version !== "1.0" || value.https_required !== true) {
    throw new Error("The site did not return the supported Muster for Frappe onboarding contract.");
  }
  const discoveredOrigin = strictHttpsOrigin(required(value.site_origin, "site_origin", 500), "Discovered Frappe site");
  if (discoveredOrigin !== siteOrigin) throw new Error("Frappe discovery origin does not match the requested site.");
  const flows = stringArray(value.flows, "flows").filter((flow): flow is "oauth_pkce" | "api_credentials" => flow === "oauth_pkce" || flow === "api_credentials");
  if (!flows.includes("oauth_pkce") && !flows.includes("api_credentials")) throw new Error("The Frappe app offers no supported secure onboarding flow.");
  if (value.connection_state !== "trusted" && value.connection_state !== "setup_required") {
    throw new Error("The Frappe app did not report a supported reciprocal connection state. Update and migrate Muster for Frappe.");
  }
  return {
    flows,
    capabilities: stringArray(value.capabilities, "capabilities"),
    musterVersion: optionalVersion(value.muster_version),
    frappeVersion: optionalVersion(value.frappe_version),
    connectionState: value.connection_state,
  };
}

async function inspectGateway(fetcher: typeof fetch, musterOrigin: string): Promise<string> {
  let response: Response;
  try {
    response = await fetcher(new URL(HEALTH_PATH, musterOrigin), {
      method: "GET", headers: { accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("The Muster gateway is not reachable at its public HTTPS origin. Start it and verify TLS/DNS before connecting Frappe.");
  }
  if (response.status >= 300 && response.status < 400) throw new Error("Muster gateway health refused an HTTP redirect.");
  if (!response.ok) throw new Error(`Muster gateway health failed (HTTP ${response.status}).`);
  let payload: unknown;
  try { payload = JSON.parse(await response.text()); } catch { throw new Error("Muster gateway health returned invalid JSON."); }
  const health = object(payload);
  if (health.ok !== true || health.service !== "muster-gateway") throw new Error("The public URL does not identify a healthy Muster gateway.");
  return "gateway reachable over HTTPS";
}

function verifiedBindingForSite(cwd: string, gateway: GatewayConfig, siteOrigin: string): FrappeConnectBinding | undefined {
  const coordinator = new FrappeSiteBindingCoordinator({
    storePath: join(dataDir(cwd), BINDING_STORE),
    encryptionSecret: gateway.token,
  });
  const binding = coordinator.verifiedBindings().find((candidate) => candidate.siteOrigin === siteOrigin);
  return binding ? {
    bindingId: binding.bindingId,
    tenantId: binding.tenantId,
    siteUuid: binding.siteUuid,
    trustFingerprint: binding.trustFingerprint,
  } : undefined;
}

interface Progress {
  banner(title: string, subtitle: string): void;
  start(step: number, message: string): void;
  done(step: number, message: string): void;
  warn(step: number, message: string): void;
  note(message: string): void;
  link(label: string, url: string, hyperlink: boolean): void;
}

function createProgress(log: (line: string) => void, color: boolean): Progress {
  const paint = (code: number, value: string): string => color ? `\u001b[${code}m${value}\u001b[0m` : value;
  return {
    banner(title, subtitle) {
      log("");
      log(paint(36, `  ◆  ${title}`));
      log(`     ${subtitle}`);
      log("");
    },
    start(step, message) { log(`${paint(90, `  ${step}/6`)}  ${message}…`); },
    done(step, message) { log(`${paint(32, "  ✓")}  ${paint(90, `${step}/6`)}  ${message}`); },
    warn(step, message) { log(`${paint(33, "  !")}  ${paint(90, `${step}/6`)}  ${message}`); },
    note(message) { log(`     ${message}`); },
    link(label, url, hyperlink) {
      const rendered = hyperlink ? `\u001b]8;;${url}\u0007${label}\u001b]8;;\u0007` : label;
      log(`     ${paint(36, "→")} ${rendered}`);
      log(`       ${url}`);
    },
  };
}

function printConnected(progress: Progress, binding: FrappeConnectBinding, missingProviderCredential?: string): void {
  progress.note("");
  progress.note(missingProviderCredential
    ? "◆ SITE TRUST CONNECTED — AI work remains disabled until provider setup is complete"
    : "◆ CONNECTED — Muster may now accept governed work from this Frappe site");
  progress.note(`  Tenant      ${binding.tenantId}`);
  progress.note(`  Site         ${binding.siteUuid}`);
  progress.note(`  Binding      ${binding.bindingId}`);
  progress.note(`  Fingerprint  ${binding.trustFingerprint}`);
  progress.note("  Secrets      hidden");
  if (missingProviderCredential) progress.note(`  Action       set ${missingProviderCredential}, then run muster doctor`);
  else progress.note("  Next         return to Frappe and ask Muster for a workflow");
}

function startConsentSpinner(enabled: boolean): () => void {
  if (!enabled) return () => undefined;
  const frames = ["◐", "◓", "◑", "◒"];
  let index = 0;
  const render = (): void => {
    process.stdout.write(`\r  ${frames[index % frames.length]}  Waiting for Frappe consent and reciprocal verification…`);
    index += 1;
  };
  render();
  const timer = setInterval(render, 120);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    process.stdout.write("\r\u001b[2K");
  };
}

async function openNativeBrowser(url: string): Promise<void> {
  const [command, args] = process.platform === "darwin"
    ? ["open", [url]] as const
    : process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]] as const
      : ["xdg-open", [url]] as const;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Could not open the native Frappe onboarding page.")));
  });
}

async function renderTerminalQr(value: string): Promise<string | undefined> {
  try {
    const require = createRequire(import.meta.url);
    const qrcode = require("qrcode-terminal") as {
      generate(input: string, options: { small: boolean }, callback: (output: string) => void): void;
    };
    return await new Promise<string>((resolve) => qrcode.generate(value, { small: true }, resolve));
  } catch {
    // The raw HTTPS deep link immediately above remains the recovery path if an
    // installation was built without the terminal renderer.
    return undefined;
  }
}

async function readVisibleLine(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Provide --muster-url when the command is not running in an interactive TTY.");
  process.stdout.write(prompt);
  return await new Promise<string>((resolve) => {
    let value = "";
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      const newline = text.indexOf("\n");
      if (newline >= 0) {
        value += text.slice(0, newline).replace(/\r$/, "");
        process.stdin.off("data", onData);
        resolve(value);
      } else value += text;
    };
    process.stdin.on("data", onData);
    process.stdin.resume();
  });
}

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Connection cancelled. Nothing was connected.")); return; }
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Connection cancelled. Nothing was connected."));
    }, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Connection cancelled. Nothing was connected.");
}

function boundedDuration(value: number, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${field} must be between ${minimum} and ${maximum} milliseconds.`);
  return value;
}

function strictHttpsOrigin(value: string, field: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${field} must be an exact HTTPS origin.`); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) throw new Error(`${field} must be an exact HTTPS origin.`);
  return url.origin;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The remote service returned an invalid JSON object.");
  return value as Record<string, unknown>;
}

function required(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`Frappe discovery ${field} is invalid.`);
  return value.trim();
}

function optionalVersion(value: unknown): string {
  return typeof value === "string" && /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,99}$/.test(value.trim()) ? value.trim() : "unknown";
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 128 || !value.every((item) => typeof item === "string" && item.length <= 256)) throw new Error(`Frappe discovery ${field} is invalid.`);
  return [...new Set(value as string[])];
}
