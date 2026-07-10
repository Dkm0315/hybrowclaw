import { createHash } from "node:crypto";
import {
  enterpriseScopeMatches,
  enterpriseSubjectKey,
  normalizeEnterpriseSubjects,
  type EnterpriseSubject,
  type EnterpriseSubjectKind,
} from "./enterprise-governance.js";

export type EnterpriseCacheStatus = "hit" | "miss" | "bypass";
export type EnterpriseUsageOutcome = "success" | "error" | "blocked" | "cancelled";

export interface EnterpriseUsageEvent {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly subjects: readonly EnterpriseSubject[];
  readonly outcome: EnterpriseUsageOutcome;
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  /** Integer micro-USD avoids accumulated floating-point accounting drift. */
  readonly costMicrousd: number;
  readonly cacheStatus: EnterpriseCacheStatus;
  readonly tool?: string;
  readonly requestCategory?: string;
}

export interface EnterpriseUsageQuery {
  readonly from?: string;
  readonly to?: string;
  readonly subjects?: readonly EnterpriseSubject[];
  /** At least one of these subjects must match, in addition to every required subject above. */
  readonly subjectAny?: readonly EnterpriseSubject[];
  readonly limit?: number;
}

export interface EnterpriseUsageStore {
  appendUsage(event: EnterpriseUsageEvent): Promise<void>;
  queryUsage(query?: EnterpriseUsageQuery): Promise<readonly EnterpriseUsageEvent[]>;
}

export type EnterpriseUsageDimension =
  | EnterpriseSubjectKind
  | "tool"
  | "request_category"
  | "outcome"
  | "hour"
  | "day";

export interface EnterpriseUsageMetrics {
  readonly runs: number;
  readonly successfulRuns: number;
  readonly failedRuns: number;
  readonly blockedRuns: number;
  readonly cancelledRuns: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly totalTokens: number;
  readonly costMicrousd: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly cacheBypasses: number;
  readonly cacheHitRate: number;
  readonly p50LatencyMs: number;
  readonly p95LatencyMs: number;
  readonly p99LatencyMs: number;
}

export interface EnterpriseUsageGroup {
  readonly key: string;
  readonly dimensions: Readonly<Record<string, string>>;
  readonly metrics: EnterpriseUsageMetrics;
}

export interface EnterpriseUsageAggregation {
  readonly totals: EnterpriseUsageMetrics;
  readonly groups: readonly EnterpriseUsageGroup[];
}

export interface EnterpriseManagerScope {
  readonly managerUserId: string;
  readonly subordinateUserIds: readonly string[];
  readonly departmentIds?: readonly string[];
  readonly additionalScope?: readonly EnterpriseSubject[];
  readonly canViewIdentifiedUsage?: boolean;
}

export type EnterpriseUserIdentityMode = "aggregate" | "pseudonymous" | "identified";

export interface EnterpriseManagerReportPrivacy {
  readonly userIdentity?: EnterpriseUserIdentityMode;
  readonly minGroupSize?: number;
}

export interface EnterpriseManagerReportInput {
  readonly managerScope: EnterpriseManagerScope;
  readonly events: readonly EnterpriseUsageEvent[];
  readonly groupBy: readonly EnterpriseUsageDimension[];
  readonly from?: string;
  readonly to?: string;
  readonly privacy?: EnterpriseManagerReportPrivacy;
  readonly generatedAt?: string;
}

export interface EnterpriseManagerUsageReport {
  readonly generatedAt: string;
  readonly managerUserId: string;
  readonly period: { readonly from?: string; readonly to?: string };
  readonly privacy: {
    readonly userIdentity: EnterpriseUserIdentityMode;
    readonly minGroupSize: number;
    readonly rawPromptsIncluded: false;
  };
  readonly totals: EnterpriseUsageMetrics;
  readonly groups: readonly EnterpriseUsageGroup[];
  readonly suppressedGroups: number;
}

export class InMemoryEnterpriseUsageStore implements EnterpriseUsageStore {
  readonly #events = new Map<string, EnterpriseUsageEvent>();
  readonly #maxEvents: number;

  constructor(maxEvents = 100_000) {
    if (!Number.isSafeInteger(maxEvents) || maxEvents <= 0) throw new Error("maxEvents must be a positive safe integer.");
    this.#maxEvents = maxEvents;
  }

  async appendUsage(event: EnterpriseUsageEvent): Promise<void> {
    const normalized = normalizeUsageEvent(event);
    const existing = this.#events.get(normalized.eventId);
    if (existing) {
      if (usageFingerprint(existing) !== usageFingerprint(normalized)) {
        throw new Error(`Usage event ${normalized.eventId} already exists with different content.`);
      }
      return;
    }
    if (this.#events.size >= this.#maxEvents) {
      const oldest = this.#events.keys().next().value as string | undefined;
      if (oldest) this.#events.delete(oldest);
    }
    this.#events.set(normalized.eventId, normalized);
  }

  async queryUsage(query: EnterpriseUsageQuery = {}): Promise<readonly EnterpriseUsageEvent[]> {
    validateUsageQuery(query);
    let result = [...this.#events.values()].filter((event) => usageMatchesQuery(event, query));
    result.sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt) || left.eventId.localeCompare(right.eventId));
    if (query.limit !== undefined) result = result.slice(-query.limit);
    return Object.freeze(result);
  }
}

const USAGE_OUTCOMES = new Set<EnterpriseUsageOutcome>(["success", "error", "blocked", "cancelled"]);
const CACHE_STATUSES = new Set<EnterpriseCacheStatus>(["hit", "miss", "bypass"]);

export function nearestRankPercentile(values: readonly number[], percentile: number): number {
  if (!Number.isFinite(percentile) || percentile < 0 || percentile > 1) throw new Error("Percentile must be between 0 and 1.");
  if (!values.length) return 0;
  const sorted = values.map((value) => {
    validateMetric(value, "Percentile value");
    return value;
  }).sort((left, right) => left - right);
  const index = percentile === 0 ? 0 : Math.ceil(percentile * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, index)] ?? 0;
}

export function aggregateEnterpriseUsage(
  events: readonly EnterpriseUsageEvent[],
  groupBy: readonly EnterpriseUsageDimension[] = [],
): EnterpriseUsageAggregation {
  const normalizedEvents = events.map(normalizeUsageEvent);
  const dimensions = [...new Set(groupBy)];
  const buckets = new Map<string, { dimensions: Readonly<Record<string, string>>; events: EnterpriseUsageEvent[] }>();
  for (const event of normalizedEvents) {
    const values = Object.fromEntries(dimensions.map((dimension) => [dimension, usageDimension(event, dimension)]));
    const key = dimensions.length ? dimensions.map((dimension) => `${dimension}=${values[dimension]}`).join("|") : "all";
    const bucket = buckets.get(key) ?? { dimensions: Object.freeze(values), events: [] };
    bucket.events.push(event);
    buckets.set(key, bucket);
  }
  const groups = [...buckets.entries()].map(([key, bucket]) => Object.freeze({
    key,
    dimensions: bucket.dimensions,
    metrics: usageMetrics(bucket.events),
  })).sort((left, right) => left.key.localeCompare(right.key));
  return Object.freeze({ totals: usageMetrics(normalizedEvents), groups: Object.freeze(groups) });
}

export function buildEnterpriseManagerUsageReport(input: EnterpriseManagerReportInput): EnterpriseManagerUsageReport {
  validateManagerScope(input.managerScope);
  const fromMs = parseOptionalTimestamp(input.from, "Report from");
  const toMs = parseOptionalTimestamp(input.to, "Report to");
  if (fromMs !== undefined && toMs !== undefined && fromMs >= toMs) throw new Error("Report to must be after from.");

  const identityMode = input.privacy?.userIdentity ?? "pseudonymous";
  if (identityMode === "identified" && !input.managerScope.canViewIdentifiedUsage) {
    throw new Error("Manager scope does not permit identified user usage.");
  }
  const minGroupSize = input.privacy?.minGroupSize ?? 1;
  if (!Number.isSafeInteger(minGroupSize) || minGroupSize <= 0) throw new Error("minGroupSize must be a positive safe integer.");

  const permittedUsers = new Set(input.managerScope.subordinateUserIds);
  const permittedDepartments = input.managerScope.departmentIds ? new Set(input.managerScope.departmentIds) : undefined;
  const filtered = input.events.map(normalizeUsageEvent).filter((event) => {
    const occurredAt = Date.parse(event.occurredAt);
    if (fromMs !== undefined && occurredAt < fromMs) return false;
    if (toMs !== undefined && occurredAt >= toMs) return false;
    const users = subjectValues(event, "user");
    if (!users.some((user) => permittedUsers.has(user))) return false;
    if (permittedDepartments && !subjectValues(event, "department").some((department) => permittedDepartments.has(department))) return false;
    return !input.managerScope.additionalScope?.length || enterpriseScopeMatches(event.subjects, input.managerScope.additionalScope);
  });

  const reportEvents = identityMode === "identified"
    ? filtered
    : filtered.map((event) => replaceUserSubjects(event, identityMode, input.managerScope.managerUserId));
  const aggregation = aggregateEnterpriseUsage(reportEvents, input.groupBy);
  const visibleGroups = aggregation.groups.filter((group) => group.metrics.runs >= minGroupSize);
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(generatedAt))) throw new Error("generatedAt must be an ISO timestamp.");
  return deepFreeze({
    generatedAt,
    managerUserId: input.managerScope.managerUserId,
    period: { ...(input.from ? { from: input.from } : {}), ...(input.to ? { to: input.to } : {}) },
    privacy: { userIdentity: identityMode, minGroupSize, rawPromptsIncluded: false },
    totals: aggregation.totals,
    groups: visibleGroups,
    suppressedGroups: aggregation.groups.length - visibleGroups.length,
  });
}

function usageMetrics(events: readonly EnterpriseUsageEvent[]): EnterpriseUsageMetrics {
  let successfulRuns = 0;
  let failedRuns = 0;
  let blockedRuns = 0;
  let cancelledRuns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let costMicrousd = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let cacheBypasses = 0;
  const latencies: number[] = [];
  for (const event of events) {
    if (event.outcome === "success") successfulRuns += 1;
    else if (event.outcome === "blocked") blockedRuns += 1;
    else if (event.outcome === "error") failedRuns += 1;
    else cancelledRuns += 1;
    inputTokens = addSafeCount(inputTokens, event.inputTokens, "inputTokens");
    outputTokens = addSafeCount(outputTokens, event.outputTokens, "outputTokens");
    cachedInputTokens = addSafeCount(cachedInputTokens, event.cachedInputTokens, "cachedInputTokens");
    costMicrousd = addSafeCount(costMicrousd, event.costMicrousd, "costMicrousd");
    if (event.cacheStatus === "hit") cacheHits += 1;
    else if (event.cacheStatus === "miss") cacheMisses += 1;
    else cacheBypasses += 1;
    latencies.push(event.latencyMs);
  }
  const cacheAttempts = cacheHits + cacheMisses;
  return Object.freeze({
    runs: events.length,
    successfulRuns,
    failedRuns,
    blockedRuns,
    cancelledRuns,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    totalTokens: inputTokens + outputTokens,
    costMicrousd,
    cacheHits,
    cacheMisses,
    cacheBypasses,
    cacheHitRate: cacheAttempts ? Math.round(cacheHits / cacheAttempts * 10_000) / 100 : 0,
    p50LatencyMs: nearestRankPercentile(latencies, 0.5),
    p95LatencyMs: nearestRankPercentile(latencies, 0.95),
    p99LatencyMs: nearestRankPercentile(latencies, 0.99),
  });
}

function normalizeUsageEvent(event: EnterpriseUsageEvent): EnterpriseUsageEvent {
  if (!event.eventId.trim()) throw new Error("Usage event id must be non-empty.");
  const occurredAtMs = Date.parse(event.occurredAt);
  if (!Number.isFinite(occurredAtMs)) throw new Error(`Usage event ${event.eventId} has an invalid occurredAt.`);
  if (!USAGE_OUTCOMES.has(event.outcome)) throw new Error(`Usage event ${event.eventId} has an invalid outcome.`);
  if (!CACHE_STATUSES.has(event.cacheStatus)) throw new Error(`Usage event ${event.eventId} has an invalid cacheStatus.`);
  validateMetric(event.latencyMs, "latencyMs");
  validateCountMetric(event.inputTokens, "inputTokens");
  validateCountMetric(event.outputTokens, "outputTokens");
  validateCountMetric(event.cachedInputTokens, "cachedInputTokens");
  validateCountMetric(event.costMicrousd, "costMicrousd");
  if (event.cachedInputTokens > event.inputTokens) throw new Error("cachedInputTokens cannot exceed inputTokens.");
  if (!event.subjects.length) throw new Error(`Usage event ${event.eventId} requires subjects.`);
  return deepFreeze({
    eventId: event.eventId.trim(),
    occurredAt: new Date(occurredAtMs).toISOString(),
    subjects: normalizeEnterpriseSubjects(event.subjects),
    outcome: event.outcome,
    latencyMs: event.latencyMs,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cachedInputTokens: event.cachedInputTokens,
    costMicrousd: event.costMicrousd,
    cacheStatus: event.cacheStatus,
    ...(event.tool ? { tool: event.tool.trim() } : {}),
    ...(event.requestCategory ? { requestCategory: event.requestCategory.trim() } : {}),
  });
}

function usageDimension(event: EnterpriseUsageEvent, dimension: EnterpriseUsageDimension): string {
  if (dimension === "tool") return event.tool || "none";
  if (dimension === "request_category") return event.requestCategory || "uncategorized";
  if (dimension === "outcome") return event.outcome;
  if (dimension === "hour") return event.occurredAt.slice(0, 13) + ":00Z";
  if (dimension === "day") return event.occurredAt.slice(0, 10);
  return subjectValues(event, dimension).sort().join(",") || "none";
}

function subjectValues(event: EnterpriseUsageEvent, kind: EnterpriseSubjectKind): string[] {
  return event.subjects.filter((subject) => subject.kind === kind).map((subject) => subject.id);
}

function replaceUserSubjects(
  event: EnterpriseUsageEvent,
  mode: Exclude<EnterpriseUserIdentityMode, "identified">,
  managerUserId: string,
): EnterpriseUsageEvent {
  const subjects = event.subjects.map((subject) => subject.kind !== "user"
    ? subject
    : { kind: "user" as const, id: mode === "aggregate" ? "[aggregate]" : pseudonym(managerUserId, subject.id) });
  return deepFreeze({ ...event, subjects: normalizeEnterpriseSubjects(subjects) });
}

function pseudonym(managerUserId: string, userId: string): string {
  return `user_${createHash("sha256").update(`${managerUserId}\0${userId}`).digest("hex").slice(0, 10)}`;
}

function usageMatchesQuery(event: EnterpriseUsageEvent, query: EnterpriseUsageQuery): boolean {
  const occurredAt = Date.parse(event.occurredAt);
  if (query.from && occurredAt < Date.parse(query.from)) return false;
  if (query.to && occurredAt >= Date.parse(query.to)) return false;
  if (query.subjects?.length && !enterpriseScopeMatches(event.subjects, query.subjects)) return false;
  return !query.subjectAny?.length || query.subjectAny.some((subject) =>
    event.subjects.some((candidate) => candidate.kind === subject.kind && candidate.id === subject.id));
}

function validateUsageQuery(query: EnterpriseUsageQuery): void {
  const fromMs = parseOptionalTimestamp(query.from, "Usage query from");
  const toMs = parseOptionalTimestamp(query.to, "Usage query to");
  if (fromMs !== undefined && toMs !== undefined && fromMs >= toMs) throw new Error("Usage query to must be after from.");
  if (query.subjects) normalizeEnterpriseSubjects(query.subjects);
  if (query.subjectAny) normalizeEnterpriseSubjects(query.subjectAny);
  if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit <= 0)) {
    throw new Error("Usage query limit must be a positive safe integer.");
  }
}

function validateManagerScope(scope: EnterpriseManagerScope): void {
  if (!scope.managerUserId.trim()) throw new Error("Manager user id must be non-empty.");
  if (!scope.subordinateUserIds.length) throw new Error("Manager scope requires at least one subordinate user.");
  if (scope.subordinateUserIds.some((userId) => !userId.trim())) throw new Error("Subordinate user ids must be non-empty.");
  if (scope.departmentIds?.some((departmentId) => !departmentId.trim())) throw new Error("Department ids must be non-empty.");
  if (scope.additionalScope) normalizeEnterpriseSubjects(scope.additionalScope);
}

function parseOptionalTimestamp(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be an ISO timestamp.`);
  return parsed;
}

function validateMetric(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be finite and non-negative.`);
}

function validateCountMetric(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer.`);
}

function addSafeCount(total: number, value: number, label: string): number {
  const result = total + value;
  if (!Number.isSafeInteger(result)) throw new Error(`Aggregated ${label} exceeds JavaScript's safe integer range.`);
  return result;
}

function usageFingerprint(event: EnterpriseUsageEvent): string {
  return JSON.stringify({
    ...event,
    subjects: [...event.subjects].map(enterpriseSubjectKey).sort(),
  });
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return value;
}
