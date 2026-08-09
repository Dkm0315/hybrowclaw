import type { GchatActor } from "./adapters/gchat.js";
import type { GatewayConfig } from "./gateway-config.js";
import { MAX_FRAPPE_IDENTITY_ROLES, type PairedIdentity } from "./pairing.js";

export type GchatFrappeIdentityResolution =
  | { readonly ok: true; readonly identity: Omit<PairedIdentity, "provider" | "resolvedAt"> }
  | { readonly ok: false; readonly reason: string; readonly detail?: string };

type IdentityConfig = NonNullable<NonNullable<GatewayConfig["gchat"]>["frappeIdentity"]>;

/**
 * Resolve a platform-verified Google actor through Frappe.
 *
 * The Chat resource name/display name never grants access. Both Muster and
 * Frappe enforce the email domain, and Frappe must return an enabled User plus
 * the roles/Employee record that it owns.
 */
export async function resolveGchatFrappeIdentity(
  actor: GchatActor | undefined,
  config: IdentityConfig,
  fetcher: typeof fetch = fetch,
): Promise<GchatFrappeIdentityResolution> {
  if (!actor?.email) {
    return { ok: false, reason: "Google Chat did not provide your email address, so Frappe access cannot be verified." };
  }
  const email = actor.email.trim().toLowerCase();
  const domain = email.split("@")[1];
  const allowedDomains = new Set(config.allowedDomains.map((value) => value.trim().toLowerCase().replace(/^@/, "")).filter(Boolean));
  if (!allowedDomains.size || !domain || !allowedDomains.has(domain)) {
    return { ok: false, reason: "Your Google Workspace domain is not allowed for this Frappe site." };
  }
  const resolver = safeResolverUrl(config.resolverUrl);
  if (!resolver) {
    return { ok: false, reason: "The Frappe identity connection is not configured safely." };
  }
  const token = process.env[config.oauthTokenEnv]?.trim();
  if (!token) {
    return { ok: false, reason: "The Frappe identity connection needs administrator attention." };
  }
  const timeoutMs = boundedTimeout(config.timeoutMs);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  let response: Response;
  try {
    response = await fetcher(resolver, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ email }),
      signal: controller.signal,
    });
  } catch (error) {
    return {
      ok: false,
      reason: "Frappe identity verification is temporarily unavailable.",
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }

  const raw = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = raw ? JSON.parse(raw) as Record<string, unknown> : {};
  } catch {
    return { ok: false, reason: "Frappe returned an unreadable identity response." };
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: response.status === 401 || response.status === 403
        ? "Your Google Chat email is not authorized for this Frappe site."
        : "Frappe identity verification is temporarily unavailable.",
      detail: frappeError(payload).slice(0, 500),
    };
  }
  const message = objectValue(payload.message);
  if (message.email?.toString().trim().toLowerCase() !== email || message.matched !== true) {
    return { ok: false, reason: "Frappe did not confirm an exact email match." };
  }
  const identity = objectValue(message.identity);
  const roles = Array.isArray(identity.roles)
    ? [...new Set(identity.roles.filter((role): role is string => typeof role === "string" && role.trim().length > 0).map((role) => role.trim()))]
    : [];
  const site = stringValue(identity.site);
  const user = stringValue(identity.user)?.toLowerCase();
  if (!site || !safeSiteUrl(site) || !user || !roles.length
    || roles.length > MAX_FRAPPE_IDENTITY_ROLES || roles.some((role) => role.length > 140)) {
    return { ok: false, reason: "Frappe returned an incomplete permission identity." };
  }
  return {
    ok: true,
    identity: {
      site,
      user,
      roles,
      authMode: "workspace_delegation",
      ...optionalIdentity(identity, "employee"),
      ...optionalIdentity(identity, "employeeName"),
      ...optionalIdentity(identity, "userName"),
      ...optionalIdentity(identity, "department"),
      ...optionalIdentity(identity, "departmentName"),
      ...optionalIdentity(identity, "reportsTo"),
      ...optionalIdentity(identity, "reportsToName"),
      ...optionalIdentity(identity, "company"),
      ...optionalIdentity(identity, "permissionHash"),
      ...optionalIdentity(identity, "rolesHash"),
    },
  };
}

function safeResolverUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return undefined;
    if (url.username || url.password || url.search || url.hash) return undefined;
    if (!url.pathname.startsWith("/api/method/")) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function safeSiteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function boundedTimeout(value: number | undefined): number {
  if (!Number.isFinite(value)) return 3_000;
  return Math.max(500, Math.min(10_000, Math.trunc(value as number)));
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalIdentity(value: Record<string, unknown>, key: "userName" | "employee" | "employeeName" | "department" | "departmentName" | "reportsTo" | "reportsToName" | "company" | "permissionHash" | "rolesHash"): Record<string, string> {
  const field = stringValue(value[key]);
  return field ? { [key]: field } : {};
}

function frappeError(payload: Record<string, unknown>): string {
  return stringValue(payload.message)
    ?? stringValue(payload.exception)
    ?? stringValue(payload.exc_type)
    ?? "Frappe identity resolver rejected the request.";
}
