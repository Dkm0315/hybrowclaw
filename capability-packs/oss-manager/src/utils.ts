import { createHash } from "node:crypto";
import type { JsonValue } from "./types.js";

export function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function nonNegativeInteger(value: unknown, label: string): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`);
  return value;
}

export function isoTimestamp(value: unknown, label: string, fallback?: string): string {
  const raw = optionalString(value) ?? fallback;
  if (!raw || Number.isNaN(Date.parse(raw))) throw new Error(`${label} must be an ISO-8601 timestamp.`);
  return new Date(raw).toISOString();
}

export function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function jsonRecord(value: unknown, label: string): Readonly<Record<string, JsonValue>> {
  const record = asRecord(value ?? {}, label);
  assertJsonValue(record, label);
  return sortValue(record) as Readonly<Record<string, JsonValue>>;
}

export function redactExcerpt(value: unknown): string | undefined {
  const raw = optionalString(value);
  if (!raw) return undefined;
  return raw
    .slice(0, 500)
    .replace(/\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, "$1 [REDACTED]");
}

export function shortDigest(value: unknown): string {
  return sha256(value).slice("sha256:".length, "sha256:".length + 16);
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortValue(item)]),
  );
}

function assertJsonValue(value: unknown, label: string): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${label}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) throw new Error(`${label}.${key} cannot be undefined.`);
      assertJsonValue(item, `${label}.${key}`);
    }
    return;
  }
  throw new Error(`${label} must contain JSON values only.`);
}
