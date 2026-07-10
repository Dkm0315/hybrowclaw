import { createHash } from "node:crypto";

export const ENTERPRISE_SUBJECT_PRECEDENCE = [
  "tenant",
  "site",
  "workspace",
  "channel",
  "department",
  "role",
  "user",
  "agent",
  "plugin",
  "skill",
  "mcp",
  "provider",
  "model",
  "workflow",
  "artifact",
] as const;

export type EnterpriseSubjectKind = typeof ENTERPRISE_SUBJECT_PRECEDENCE[number];

export interface EnterpriseSubject {
  readonly kind: EnterpriseSubjectKind;
  readonly id: string;
}

export type EnterprisePolicyAction =
  | "allow"
  | "warn"
  | "throttle"
  | "queue"
  | "degrade"
  | "approval"
  | "deny"
  | "quarantine";

export type EnterpriseLimitKind = "rate_limit" | "budget";
export type EnterpriseLimitMetric = "runs" | "tokens" | "cost_microusd";
export type EnterpriseLimitWindow = "run" | "minute" | "hour" | "day" | "week" | "month";

export interface EnterpriseLimitPolicy {
  /** Policies with the same key are overrides; the most specific matching scope wins. */
  readonly policyKey: string;
  readonly id: string;
  readonly kind: EnterpriseLimitKind;
  readonly scope: readonly EnterpriseSubject[];
  readonly metric: EnterpriseLimitMetric;
  readonly window: EnterpriseLimitWindow;
  readonly limit: number;
  readonly warnAtPercent?: number;
  readonly action: EnterprisePolicyAction;
  readonly priority?: number;
}

export interface EnterpriseCounterConsumeInput {
  readonly key: string;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly amount: number;
  readonly limit: number;
  /** Soft controls may count over-limit use; enforcement controls normally leave it uncommitted. */
  readonly commitOnExceed?: boolean;
}

export interface EnterpriseCounterReadInput {
  readonly key: string;
  readonly windowStartMs: number;
  readonly nowMs: number;
}

export interface EnterpriseCounterResult {
  readonly accepted: boolean;
  readonly usedBefore: number;
  readonly usedAfter: number;
  readonly remaining: number;
  readonly limit: number;
  readonly resetAt: string;
}

export interface EnterpriseRateLimitStore {
  consumeRateLimit(input: EnterpriseCounterConsumeInput): Promise<EnterpriseCounterResult>;
  readRateLimit(input: EnterpriseCounterReadInput): Promise<number>;
}

export interface EnterpriseBudgetStore {
  consumeBudget(input: EnterpriseCounterConsumeInput): Promise<EnterpriseCounterResult>;
  readBudget(input: EnterpriseCounterReadInput): Promise<number>;
}

export interface EnterpriseIdempotencyClaimInput {
  readonly namespace: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly ttlMs: number;
  readonly nowMs: number;
}

export interface EnterpriseIdempotencyCompleteInput {
  readonly namespace: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly resultRef: string;
  readonly nowMs: number;
}

export interface EnterpriseIdempotencyRecord {
  readonly namespace: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly state: "pending" | "completed";
  readonly claimedAt: string;
  readonly expiresAt: string;
  readonly resultRef?: string;
}

export interface EnterpriseIdempotencyClaim {
  readonly status: "claimed" | "replay" | "conflict";
  readonly record: EnterpriseIdempotencyRecord;
}

export interface EnterpriseIdempotencyStore {
  claimIdempotency(input: EnterpriseIdempotencyClaimInput): Promise<EnterpriseIdempotencyClaim>;
  completeIdempotency(input: EnterpriseIdempotencyCompleteInput): Promise<EnterpriseIdempotencyRecord>;
  readIdempotency(namespace: string, key: string, nowMs: number): Promise<EnterpriseIdempotencyRecord | undefined>;
}

export type EnterpriseReceiptOutcome = "allowed" | "completed" | "failed" | "blocked" | "cancelled";
export type EnterpriseReceiptMetadataValue = string | number | boolean | null;

export interface EnterpriseActionReceiptInput {
  readonly receiptId?: string;
  readonly occurredAt?: string;
  readonly actor: readonly EnterpriseSubject[];
  readonly target: readonly EnterpriseSubject[];
  readonly action: string;
  readonly outcome: EnterpriseReceiptOutcome;
  readonly policyIds?: readonly string[];
  /** A digest or opaque request id, never the raw request body. */
  readonly requestFingerprint: string;
  readonly metadata?: Readonly<Record<string, EnterpriseReceiptMetadataValue>>;
  readonly previousReceiptHash?: string;
}

export interface EnterpriseActionReceipt {
  readonly receiptId: string;
  readonly occurredAt: string;
  readonly actor: readonly EnterpriseSubject[];
  readonly target: readonly EnterpriseSubject[];
  readonly action: string;
  readonly outcome: EnterpriseReceiptOutcome;
  readonly policyIds: readonly string[];
  readonly requestFingerprint: string;
  readonly metadata: Readonly<Record<string, EnterpriseReceiptMetadataValue>>;
  readonly previousReceiptHash?: string;
  readonly integrityHash: string;
}

export interface EnterpriseReceiptStore {
  appendReceipt(receipt: EnterpriseActionReceipt): Promise<void>;
  readReceipt(receiptId: string): Promise<EnterpriseActionReceipt | undefined>;
  listReceipts(): Promise<readonly EnterpriseActionReceipt[]>;
}

export interface EnterprisePolicyDecision {
  readonly policyId: string;
  readonly policyKey: string;
  readonly action: EnterprisePolicyAction;
  readonly proceed: boolean;
  readonly threshold: "within_limit" | "warning" | "exceeded";
  readonly counter: EnterpriseCounterResult;
}

export interface EnterpriseWindowBounds {
  readonly startMs: number;
  readonly endMs: number;
  readonly key: string;
}

export interface PreparedEnterpriseGovernanceDisabled {
  readonly enabled: false;
  readonly policies: readonly [];
}

export interface PreparedEnterpriseGovernanceEnabled {
  readonly enabled: true;
  readonly subjects: readonly EnterpriseSubject[];
  readonly policies: readonly EnterpriseLimitPolicy[];
}

export type PreparedEnterpriseGovernance = PreparedEnterpriseGovernanceDisabled | PreparedEnterpriseGovernanceEnabled;

export interface PrepareEnterpriseGovernanceInput {
  readonly enabled: boolean;
  readonly subjects: readonly EnterpriseSubject[];
  readonly loadPolicies: () => Promise<readonly EnterpriseLimitPolicy[]>;
}

const SUBJECT_RANK = new Map<EnterpriseSubjectKind, number>(
  ENTERPRISE_SUBJECT_PRECEDENCE.map((kind, index) => [kind, index]),
);

const ACTION_PROCEEDS = new Set<EnterprisePolicyAction>(["allow", "warn", "degrade"]);
const POLICY_ACTIONS = new Set<EnterprisePolicyAction>(["allow", "warn", "throttle", "queue", "degrade", "approval", "deny", "quarantine"]);
const LIMIT_KINDS = new Set<EnterpriseLimitKind>(["rate_limit", "budget"]);
const LIMIT_METRICS = new Set<EnterpriseLimitMetric>(["runs", "tokens", "cost_microusd"]);
const LIMIT_WINDOWS = new Set<EnterpriseLimitWindow>(["run", "minute", "hour", "day", "week", "month"]);
const RECEIPT_OUTCOMES = new Set<EnterpriseReceiptOutcome>(["allowed", "completed", "failed", "blocked", "cancelled"]);
const DISABLED_ENTERPRISE_GOVERNANCE = deepFreeze<PreparedEnterpriseGovernanceDisabled>({ enabled: false, policies: [] });
const SWEEP_INTERVAL = 256;

interface StoredCounter {
  value: number;
  expiresAtMs: number;
}

interface StoredIdempotency {
  namespace: string;
  key: string;
  fingerprint: string;
  state: "pending" | "completed";
  claimedAtMs: number;
  expiresAtMs: number;
  resultRef?: string;
}

export class InMemoryEnterpriseGovernanceStore implements
  EnterpriseRateLimitStore,
  EnterpriseBudgetStore,
  EnterpriseIdempotencyStore,
  EnterpriseReceiptStore {
  readonly #rateLimits = new Map<string, StoredCounter>();
  readonly #budgets = new Map<string, StoredCounter>();
  readonly #idempotency = new Map<string, StoredIdempotency>();
  readonly #receipts = new Map<string, EnterpriseActionReceipt>();
  #rateLimitOperations = 0;
  #budgetOperations = 0;
  #idempotencyOperations = 0;

  async consumeRateLimit(input: EnterpriseCounterConsumeInput): Promise<EnterpriseCounterResult> {
    this.#rateLimitOperations += 1;
    if (this.#rateLimitOperations % SWEEP_INTERVAL === 0) sweepExpiredCounters(this.#rateLimits, input.windowStartMs);
    return consumeCounter(this.#rateLimits, input);
  }

  async readRateLimit(input: EnterpriseCounterReadInput): Promise<number> {
    return readCounter(this.#rateLimits, input);
  }

  async consumeBudget(input: EnterpriseCounterConsumeInput): Promise<EnterpriseCounterResult> {
    this.#budgetOperations += 1;
    if (this.#budgetOperations % SWEEP_INTERVAL === 0) sweepExpiredCounters(this.#budgets, input.windowStartMs);
    return consumeCounter(this.#budgets, input);
  }

  async readBudget(input: EnterpriseCounterReadInput): Promise<number> {
    return readCounter(this.#budgets, input);
  }

  async claimIdempotency(input: EnterpriseIdempotencyClaimInput): Promise<EnterpriseIdempotencyClaim> {
    validateIdempotencyClaim(input);
    this.#idempotencyOperations += 1;
    if (this.#idempotencyOperations % SWEEP_INTERVAL === 0) sweepExpiredIdempotency(this.#idempotency, input.nowMs);
    const storageKey = idempotencyStorageKey(input.namespace, input.key);
    const existing = this.#idempotency.get(storageKey);
    if (existing && existing.expiresAtMs > input.nowMs) {
      return {
        status: existing.fingerprint === input.fingerprint ? "replay" : "conflict",
        record: freezeIdempotencyRecord(existing),
      };
    }
    const record: StoredIdempotency = {
      namespace: input.namespace,
      key: input.key,
      fingerprint: input.fingerprint,
      state: "pending",
      claimedAtMs: input.nowMs,
      expiresAtMs: input.nowMs + input.ttlMs,
    };
    this.#idempotency.set(storageKey, record);
    return { status: "claimed", record: freezeIdempotencyRecord(record) };
  }

  async completeIdempotency(input: EnterpriseIdempotencyCompleteInput): Promise<EnterpriseIdempotencyRecord> {
    validateNonEmpty(input.namespace, "Idempotency namespace");
    validateNonEmpty(input.key, "Idempotency key");
    validateNonEmpty(input.fingerprint, "Idempotency fingerprint");
    validateNonEmpty(input.resultRef, "Idempotency resultRef");
    validateTimestamp(input.nowMs, "Idempotency completion time");
    const storageKey = idempotencyStorageKey(input.namespace, input.key);
    const existing = this.#idempotency.get(storageKey);
    if (!existing || existing.expiresAtMs <= input.nowMs) {
      if (existing) this.#idempotency.delete(storageKey);
      throw new Error("Idempotency claim is missing or expired.");
    }
    if (existing.fingerprint !== input.fingerprint) throw new Error("Idempotency fingerprint conflict.");
    if (existing.state === "completed" && existing.resultRef !== input.resultRef) {
      throw new Error("Idempotency claim was already completed with another result.");
    }
    existing.state = "completed";
    existing.resultRef = input.resultRef;
    return freezeIdempotencyRecord(existing);
  }

  async readIdempotency(namespace: string, key: string, nowMs: number): Promise<EnterpriseIdempotencyRecord | undefined> {
    validateTimestamp(nowMs, "Idempotency read time");
    const storageKey = idempotencyStorageKey(namespace, key);
    const existing = this.#idempotency.get(storageKey);
    if (!existing) return undefined;
    if (existing.expiresAtMs <= nowMs) {
      this.#idempotency.delete(storageKey);
      return undefined;
    }
    return freezeIdempotencyRecord(existing);
  }

  async appendReceipt(receipt: EnterpriseActionReceipt): Promise<void> {
    const immutable = recreateEnterpriseActionReceipt(receipt);
    if (immutable.integrityHash !== receipt.integrityHash) throw new Error(`Receipt ${receipt.receiptId} failed its integrity check.`);
    const existing = this.#receipts.get(immutable.receiptId);
    if (existing && existing.integrityHash !== immutable.integrityHash) {
      throw new Error(`Receipt ${immutable.receiptId} already exists with different content.`);
    }
    if (!existing) this.#receipts.set(immutable.receiptId, immutable);
  }

  async readReceipt(receiptId: string): Promise<EnterpriseActionReceipt | undefined> {
    return this.#receipts.get(receiptId);
  }

  async listReceipts(): Promise<readonly EnterpriseActionReceipt[]> {
    return Object.freeze([...this.#receipts.values()]);
  }
}

export function normalizeEnterpriseSubjects(subjects: readonly EnterpriseSubject[]): readonly EnterpriseSubject[] {
  const seen = new Set<string>();
  const normalized: EnterpriseSubject[] = [];
  for (const subject of subjects) {
    if (!SUBJECT_RANK.has(subject.kind)) throw new Error(`Unknown enterprise subject kind: ${subject.kind}`);
    const id = subject.id.trim();
    if (!id) throw new Error(`Enterprise subject ${subject.kind} requires an id.`);
    const key = `${subject.kind}:${id}`;
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push({ kind: subject.kind, id });
    }
  }
  return Object.freeze(normalized);
}

export function enterpriseSubjectKey(subject: EnterpriseSubject): string {
  return `${subject.kind}:${subject.id}`;
}

export function enterpriseScopeKey(subjects: readonly EnterpriseSubject[]): string {
  return normalizeEnterpriseSubjects(subjects)
    .map(enterpriseSubjectKey)
    .sort()
    .join("|");
}

export function enterpriseScopeMatches(
  requestSubjects: readonly EnterpriseSubject[],
  policyScope: readonly EnterpriseSubject[],
): boolean {
  const requestKeys = new Set(normalizeEnterpriseSubjects(requestSubjects).map(enterpriseSubjectKey));
  return scopeMatchesKeys(requestKeys, normalizeEnterpriseSubjects(policyScope));
}

export function resolveEffectiveEnterprisePolicies(
  requestSubjects: readonly EnterpriseSubject[],
  policies: readonly EnterpriseLimitPolicy[],
): readonly EnterpriseLimitPolicy[] {
  const subjects = normalizeEnterpriseSubjects(requestSubjects);
  const subjectKeys = new Set(subjects.map(enterpriseSubjectKey));
  const winners = new Map<string, EnterpriseLimitPolicy>();
  for (const policy of policies) {
    const scope = validateEnterpriseLimitPolicy(policy);
    if (!scopeMatchesKeys(subjectKeys, scope)) continue;
    const current = winners.get(policy.policyKey);
    if (!current || comparePolicySpecificity(policy, current) < 0) winners.set(policy.policyKey, policy);
  }
  return Object.freeze([...winners.values()].sort((left, right) => left.policyKey.localeCompare(right.policyKey)));
}

export function enterpriseWindowBounds(
  window: EnterpriseLimitWindow,
  nowMs: number,
  runId?: string,
): EnterpriseWindowBounds {
  validateTimestamp(nowMs, "Window time");
  if (window === "run") {
    validateNonEmpty(runId, "Run id");
    return { startMs: nowMs, endMs: nowMs + 1, key: `run:${runId}` };
  }
  if (window === "month") {
    const now = new Date(nowMs);
    const startMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const endMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
    return { startMs, endMs, key: `month:${new Date(startMs).toISOString().slice(0, 7)}` };
  }
  if (window === "week") {
    const now = new Date(nowMs);
    const day = now.getUTCDay() || 7;
    const startMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day + 1);
    const endMs = startMs + 7 * 86_400_000;
    return { startMs, endMs, key: `week:${new Date(startMs).toISOString().slice(0, 10)}` };
  }
  const durationMs = window === "minute" ? 60_000 : window === "hour" ? 3_600_000 : 86_400_000;
  const startMs = Math.floor(nowMs / durationMs) * durationMs;
  return {
    startMs,
    endMs: startMs + durationMs,
    key: `${window}:${new Date(startMs).toISOString()}`,
  };
}

export function enterpriseCounterKey(policy: EnterpriseLimitPolicy): string {
  return `${policy.policyKey}:${policy.metric}:${enterpriseScopeKey(policy.scope)}`;
}

export function evaluateEnterprisePolicyCounter(
  policy: EnterpriseLimitPolicy,
  counter: EnterpriseCounterResult,
): EnterprisePolicyDecision {
  validateEnterpriseLimitPolicy(policy);
  const percent = counter.limit === 0 ? 100 : counter.usedAfter / counter.limit * 100;
  const threshold = !counter.accepted
    ? "exceeded"
    : percent >= (policy.warnAtPercent ?? 90)
      ? "warning"
      : "within_limit";
  const action = threshold === "exceeded" ? policy.action : threshold === "warning" ? "warn" : "allow";
  return deepFreeze({
    policyId: policy.id,
    policyKey: policy.policyKey,
    action,
    proceed: ACTION_PROCEEDS.has(action),
    threshold,
    counter,
  });
}

export async function prepareEnterpriseGovernance(
  input: PrepareEnterpriseGovernanceInput,
): Promise<PreparedEnterpriseGovernance> {
  if (!input.enabled) return DISABLED_ENTERPRISE_GOVERNANCE;
  const subjects = normalizeEnterpriseSubjects(input.subjects);
  const policies = resolveEffectiveEnterprisePolicies(subjects, await input.loadPolicies());
  return deepFreeze({ enabled: true, subjects, policies });
}

export function createEnterpriseActionReceipt(input: EnterpriseActionReceiptInput): EnterpriseActionReceipt {
  validateNonEmpty(input.action, "Receipt action");
  validateNonEmpty(input.requestFingerprint, "Receipt request fingerprint");
  if (!RECEIPT_OUTCOMES.has(input.outcome)) throw new Error(`Unknown receipt outcome: ${input.outcome}`);
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(occurredAt))) throw new Error("Receipt occurredAt must be an ISO timestamp.");
  const metadata = sanitizeReceiptMetadata(input.metadata ?? {});
  const policyIds = [...(input.policyIds ?? [])].map((policyId) => {
    validateNonEmpty(policyId, "Receipt policy id");
    return policyId.trim();
  }).sort();
  const body = {
    occurredAt,
    actor: normalizeEnterpriseSubjects(input.actor),
    target: normalizeEnterpriseSubjects(input.target),
    action: input.action.trim(),
    outcome: input.outcome,
    policyIds: Object.freeze(policyIds),
    requestFingerprint: input.requestFingerprint.trim(),
    metadata,
    ...(input.previousReceiptHash ? { previousReceiptHash: input.previousReceiptHash } : {}),
  };
  const integrityHash = sha256(stableJson(body));
  const receiptId = input.receiptId?.trim() || `receipt_${integrityHash.slice(0, 24)}`;
  return deepFreeze({ receiptId, ...body, integrityHash });
}

function validateEnterpriseLimitPolicy(policy: EnterpriseLimitPolicy): readonly EnterpriseSubject[] {
  validateNonEmpty(policy.id, "Policy id");
  validateNonEmpty(policy.policyKey, "Policy key");
  if (!LIMIT_KINDS.has(policy.kind)) throw new Error(`Policy ${policy.id} has an unknown limit kind: ${policy.kind}`);
  if (!LIMIT_METRICS.has(policy.metric)) throw new Error(`Policy ${policy.id} has an unknown metric: ${policy.metric}`);
  if (!LIMIT_WINDOWS.has(policy.window)) throw new Error(`Policy ${policy.id} has an unknown window: ${policy.window}`);
  if (!POLICY_ACTIONS.has(policy.action)) throw new Error(`Policy ${policy.id} has an unknown action: ${policy.action}`);
  if (!policy.scope.length) throw new Error(`Policy ${policy.id} requires a scope.`);
  const scope = normalizeEnterpriseSubjects(policy.scope);
  validateFiniteNonNegative(policy.limit, `Policy ${policy.id} limit`);
  if (policy.limit === 0) throw new Error(`Policy ${policy.id} limit must be positive.`);
  if (policy.warnAtPercent !== undefined && (!Number.isFinite(policy.warnAtPercent) || policy.warnAtPercent <= 0 || policy.warnAtPercent > 100)) {
    throw new Error(`Policy ${policy.id} warnAtPercent must be in (0, 100].`);
  }
  if (policy.priority !== undefined && !Number.isFinite(policy.priority)) throw new Error(`Policy ${policy.id} priority must be finite.`);
  return scope;
}

function comparePolicySpecificity(left: EnterpriseLimitPolicy, right: EnterpriseLimitPolicy): number {
  const leftScore = policySpecificity(left);
  const rightScore = policySpecificity(right);
  for (let index = 0; index < leftScore.length; index += 1) {
    const difference = (rightScore[index] ?? 0) - (leftScore[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.id.localeCompare(right.id);
}

function policySpecificity(policy: EnterpriseLimitPolicy): readonly number[] {
  const scope = normalizeEnterpriseSubjects(policy.scope);
  const ranks = scope.map((subject) => SUBJECT_RANK.get(subject.kind) ?? -1);
  return [scope.length, Math.max(...ranks), ranks.reduce((total, rank) => total + rank, 0), policy.priority ?? 0];
}

function scopeMatchesKeys(requestKeys: ReadonlySet<string>, policyScope: readonly EnterpriseSubject[]): boolean {
  return policyScope.every((subject) => requestKeys.has(enterpriseSubjectKey(subject)));
}

function consumeCounter(store: Map<string, StoredCounter>, input: EnterpriseCounterConsumeInput): EnterpriseCounterResult {
  validateCounterInput(input);
  const storageKey = `${input.key}\0${input.windowStartMs}`;
  const existing = store.get(storageKey);
  const usedBefore = existing && existing.expiresAtMs === input.windowEndMs ? existing.value : 0;
  const projected = usedBefore + input.amount;
  const accepted = projected <= input.limit;
  const usedAfter = accepted || input.commitOnExceed ? projected : usedBefore;
  if (usedAfter > 0) store.set(storageKey, { value: usedAfter, expiresAtMs: input.windowEndMs });
  else if (existing) store.delete(storageKey);
  return deepFreeze({
    accepted,
    usedBefore,
    usedAfter,
    remaining: Math.max(0, input.limit - usedAfter),
    limit: input.limit,
    resetAt: new Date(input.windowEndMs).toISOString(),
  });
}

function readCounter(store: Map<string, StoredCounter>, input: EnterpriseCounterReadInput): number {
  validateNonEmpty(input.key, "Counter key");
  validateTimestamp(input.windowStartMs, "Counter window start");
  validateTimestamp(input.nowMs, "Counter read time");
  const storageKey = `${input.key}\0${input.windowStartMs}`;
  const existing = store.get(storageKey);
  if (!existing) return 0;
  if (existing.expiresAtMs <= input.nowMs) {
    store.delete(storageKey);
    return 0;
  }
  return existing.value;
}

function validateCounterInput(input: EnterpriseCounterConsumeInput): void {
  validateNonEmpty(input.key, "Counter key");
  validateTimestamp(input.windowStartMs, "Counter window start");
  validateTimestamp(input.windowEndMs, "Counter window end");
  if (input.windowEndMs <= input.windowStartMs) throw new Error("Counter window end must follow its start.");
  validateFiniteNonNegative(input.amount, "Counter amount");
  validateFiniteNonNegative(input.limit, "Counter limit");
  if (input.limit === 0) throw new Error("Counter limit must be positive.");
}

function validateIdempotencyClaim(input: EnterpriseIdempotencyClaimInput): void {
  validateNonEmpty(input.namespace, "Idempotency namespace");
  validateNonEmpty(input.key, "Idempotency key");
  validateNonEmpty(input.fingerprint, "Idempotency fingerprint");
  validateTimestamp(input.nowMs, "Idempotency claim time");
  if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) throw new Error("Idempotency ttlMs must be positive.");
}

function freezeIdempotencyRecord(record: StoredIdempotency): EnterpriseIdempotencyRecord {
  return deepFreeze({
    namespace: record.namespace,
    key: record.key,
    fingerprint: record.fingerprint,
    state: record.state,
    claimedAt: new Date(record.claimedAtMs).toISOString(),
    expiresAt: new Date(record.expiresAtMs).toISOString(),
    ...(record.resultRef ? { resultRef: record.resultRef } : {}),
  });
}

function idempotencyStorageKey(namespace: string, key: string): string {
  return `${namespace}\0${key}`;
}

function sanitizeReceiptMetadata(
  metadata: Readonly<Record<string, EnterpriseReceiptMetadataValue>>,
): Readonly<Record<string, EnterpriseReceiptMetadataValue>> {
  const sanitized: Record<string, EnterpriseReceiptMetadataValue> = {};
  for (const [rawKey, rawValue] of Object.entries(metadata)) {
    const key = rawKey.trim();
    if (!key) throw new Error("Receipt metadata keys must be non-empty.");
    if (/(?:raw[_-]?)?(?:prompt|message|content|request[_-]?body)/i.test(key)) {
      throw new Error(`Receipt metadata cannot contain raw conversational content: ${key}`);
    }
    if (rawValue !== null && !["string", "number", "boolean"].includes(typeof rawValue)) {
      throw new Error(`Receipt metadata ${key} must be a primitive value.`);
    }
    if (typeof rawValue === "number" && !Number.isFinite(rawValue)) throw new Error(`Receipt metadata ${key} must be finite.`);
    sanitized[key] = typeof rawValue === "string" ? redactSensitiveValue(rawValue) : rawValue;
  }
  return Object.freeze(sanitized);
}

function redactSensitiveValue(value: string): string {
  return value
    .replace(/(token=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b(xox[a-z]-)[A-Za-z0-9-]+/g, "$1[redacted]")
    .replace(/\b[A-Za-z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD)[A-Za-z0-9_]*=([^\s]+)/g, (match) => match.replace(/=([^\s]+)/, "=[redacted]"));
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function recreateEnterpriseActionReceipt(receipt: EnterpriseActionReceipt): EnterpriseActionReceipt {
  return createEnterpriseActionReceipt({
    receiptId: receipt.receiptId,
    occurredAt: receipt.occurredAt,
    actor: receipt.actor,
    target: receipt.target,
    action: receipt.action,
    outcome: receipt.outcome,
    policyIds: receipt.policyIds,
    requestFingerprint: receipt.requestFingerprint,
    metadata: receipt.metadata,
    previousReceiptHash: receipt.previousReceiptHash,
  });
}

function sweepExpiredCounters(store: Map<string, StoredCounter>, nowMs: number): void {
  for (const [key, counter] of store) {
    if (counter.expiresAtMs <= nowMs) store.delete(key);
  }
}

function sweepExpiredIdempotency(store: Map<string, StoredIdempotency>, nowMs: number): void {
  for (const [key, record] of store) {
    if (record.expiresAtMs <= nowMs) store.delete(key);
  }
}

function validateNonEmpty(value: string | undefined, label: string): asserts value is string {
  if (!value?.trim()) throw new Error(`${label} must be non-empty.`);
}

function validateTimestamp(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative finite timestamp.`);
}

function validateFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be finite and non-negative.`);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return value;
}
