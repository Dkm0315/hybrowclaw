import { createPublicKey, verify as verifySignature } from "node:crypto";
import type { GchatRequestVerificationInput, GchatRequestVerifier } from "./adapters/gchat.js";

const CHAT_SERVICE_ACCOUNT = "chat@system.gserviceaccount.com";
const GOOGLE_OIDC_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const OIDC_CERTS_URL = "https://www.googleapis.com/oauth2/v1/certs";
const CHAT_CERTS_URL = `https://www.googleapis.com/service_accounts/v1/metadata/x509/${CHAT_SERVICE_ACCOUNT}`;

interface JwtHeader {
  readonly alg?: string;
  readonly kid?: string;
}

interface JwtPayload {
  readonly aud?: string | readonly string[];
  readonly iss?: string;
  readonly email?: string;
  readonly email_verified?: boolean;
  readonly exp?: number;
  readonly nbf?: number;
  readonly iat?: number;
}

interface CachedCertificates {
  readonly expiresAt: number;
  readonly entries: Readonly<Record<string, string>>;
}

export interface GoogleChatVerifierOptions {
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly clockSkewSeconds?: number;
  readonly maxCertificateTtlMs?: number;
}

/**
 * Dependency-free verifier for Google Chat's signed bearer token. It supports
 * both recommended endpoint-audience OIDC tokens and project-number JWTs,
 * caches Google's public certificates, and fails closed on any ambiguity.
 */
export function createGoogleChatRequestVerifier(options: GoogleChatVerifierOptions = {}): GchatRequestVerifier {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const clockSkewSeconds = options.clockSkewSeconds ?? 60;
  const maxCertificateTtlMs = options.maxCertificateTtlMs ?? 6 * 60 * 60_000;
  const certificateCache = new Map<string, CachedCertificates>();

  return {
    async verify(input: GchatRequestVerificationInput): Promise<boolean> {
      try {
        const token = bearerToken(input.authorization);
        if (!token) return false;
        const parts = token.split(".");
        if (parts.length !== 3) return false;
        const header = parseSegment<JwtHeader>(parts[0]);
        const payload = parseSegment<JwtPayload>(parts[1]);
        if (header.alg !== "RS256" || !header.kid || !payload.iss) return false;
        if (!audienceMatches(payload.aud, input.audience)) return false;
        if (!timeClaimsValid(payload, Math.floor(now() / 1000), clockSkewSeconds)) return false;

        const oidc = GOOGLE_OIDC_ISSUERS.has(payload.iss);
        const projectJwt = payload.iss === CHAT_SERVICE_ACCOUNT;
        if (!oidc && !projectJwt) return false;
        if (oidc && (payload.email !== CHAT_SERVICE_ACCOUNT || payload.email_verified !== true)) return false;

        const certUrl = projectJwt ? CHAT_CERTS_URL : OIDC_CERTS_URL;
        const certificates = await loadCertificates(certUrl, fetcher, certificateCache, now(), maxCertificateTtlMs);
        const certificate = certificates[header.kid];
        if (!certificate) return false;
        const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
        const signature = Buffer.from(parts[2], "base64url");
        return verifySignature("RSA-SHA256", signed, createPublicKey(certificate), signature);
      } catch {
        return false;
      }
    },
  };
}

function bearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization.trim());
  return match?.[1];
}

function parseSegment<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
}

function audienceMatches(actual: JwtPayload["aud"], expected: string): boolean {
  return typeof actual === "string" ? actual === expected : Array.isArray(actual) && actual.includes(expected);
}

function timeClaimsValid(payload: JwtPayload, nowSeconds: number, skewSeconds: number): boolean {
  if (!Number.isFinite(payload.exp) || !Number.isFinite(payload.iat)) return false;
  if ((payload.exp as number) < nowSeconds - skewSeconds) return false;
  if ((payload.iat as number) > nowSeconds + skewSeconds) return false;
  if (payload.nbf !== undefined && (!Number.isFinite(payload.nbf) || payload.nbf > nowSeconds + skewSeconds)) return false;
  return true;
}

async function loadCertificates(
  url: string,
  fetcher: typeof fetch,
  cache: Map<string, CachedCertificates>,
  nowMs: number,
  maxTtlMs: number,
): Promise<Readonly<Record<string, string>>> {
  const cached = cache.get(url);
  if (cached && cached.expiresAt > nowMs) return cached.entries;
  const response = await fetcher(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Google certificate fetch failed: HTTP ${response.status}`);
  const body = await response.json();
  if (!isCertificateMap(body)) throw new Error("Google certificate response is invalid.");
  const header = response.headers.get("cache-control") ?? "";
  const maxAge = Number(/(?:^|,)\s*max-age=(\d+)/i.exec(header)?.[1] ?? "300");
  const ttl = Math.min(maxTtlMs, Math.max(30_000, Number.isFinite(maxAge) ? maxAge * 1000 : 300_000));
  const entries = Object.freeze({ ...body });
  cache.set(url, { entries, expiresAt: nowMs + ttl });
  return entries;
}

function isCertificateMap(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length > 0
    && Object.entries(value).every(([key, certificate]) => Boolean(key) && typeof certificate === "string"
      && (certificate.includes("PUBLIC KEY") || certificate.includes("CERTIFICATE")));
}
