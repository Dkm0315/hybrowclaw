import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  EnterpriseSqliteStore,
  InMemoryEnterpriseGovernanceStore,
  InMemoryEnterpriseUsageStore,
  createEnterpriseActionReceipt,
  enterpriseScopeMatches,
  enterpriseWindowBounds,
  normalizeEnterpriseSubjects,
  type EnterpriseReceiptStore,
  type EnterpriseRateLimitStore,
  type EnterpriseIdempotencyStore,
  type EnterpriseSubject,
  type EnterpriseUsageOutcome,
  type EnterpriseUsageStore,
  type TokenRecord,
  dataDir,
} from "@musterhq/core";
import type {
  GatewayConfig,
  GatewayGovernanceAssignment,
  GatewayGovernanceRateLimit,
} from "./gateway-config.js";
import type { SurfaceMessage } from "./envelope.js";
import type { PairedSender } from "./pairing.js";

export interface GatewayEnterpriseRuntime {
  readonly backend: "memory" | "sqlite" | "external";
  readonly rateLimitStore: EnterpriseRateLimitStore;
  readonly idempotencyStore: EnterpriseIdempotencyStore;
  readonly receiptStore: EnterpriseReceiptStore;
  readonly usageStore: EnterpriseUsageStore;
  close?(): void | Promise<void>;
}

export interface GatewayGovernancePreflightResult {
  readonly blocked?: string;
  readonly policyIds: readonly string[];
}

export interface GatewayUsageRecordInput {
  readonly message: SurfaceMessage;
  readonly paired: PairedSender;
  readonly assignment?: GatewayGovernanceAssignment;
  readonly outcome: EnterpriseUsageOutcome;
  readonly latencyMs: number;
  readonly tokens?: TokenRecord;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly requestCategory?: string;
  readonly action: string;
  readonly policyIds?: readonly string[];
}

export function createInMemoryGatewayEnterpriseRuntime(): GatewayEnterpriseRuntime {
  const governance = new InMemoryEnterpriseGovernanceStore();
  return {
    backend: "memory",
    rateLimitStore: governance,
    idempotencyStore: governance,
    receiptStore: governance,
    usageStore: new InMemoryEnterpriseUsageStore(),
  };
}

export function openSqliteGatewayEnterpriseRuntime(cwd = process.cwd()): GatewayEnterpriseRuntime {
  const store = new EnterpriseSqliteStore(join(dataDir(cwd), "enterprise-control-plane.db"));
  return {
    backend: "sqlite",
    rateLimitStore: store,
    idempotencyStore: store,
    receiptStore: store,
    usageStore: store,
    close: () => store.close(),
  };
}

export function resolveGatewayGovernanceAssignment(
  gateway: Pick<GatewayConfig, "governance"> | undefined,
  message: SurfaceMessage,
  pairingId?: string,
): GatewayGovernanceAssignment {
  const assignments = gateway?.governance?.assignments ?? {};
  return assignments[`${message.surfaceId}:${message.senderId}`]
    ?? assignments[message.senderId]
    ?? (pairingId ? assignments[pairingId] : undefined)
    ?? assignments.default
    ?? {};
}

export function gatewayEnterpriseSubjects(
  message: SurfaceMessage,
  paired: PairedSender,
  assignment: GatewayGovernanceAssignment = {},
  tokens?: TokenRecord,
): readonly EnterpriseSubject[] {
  const identity = paired.identity?.provider === "frappe" ? paired.identity : undefined;
  const userId = assignment.userId ?? identity?.user ?? identity?.employee ?? message.senderId;
  const roles = [...new Set([...(assignment.roles ?? []), ...(identity?.roles ?? [])])];
  return normalizeEnterpriseSubjects([
    ...(assignment.tenantId ? [{ kind: "tenant" as const, id: assignment.tenantId }] : []),
    ...(identity?.site ? [{ kind: "site" as const, id: identity.site }] : []),
    ...(assignment.workspaceId ? [{ kind: "workspace" as const, id: assignment.workspaceId }] : []),
    { kind: "channel", id: `${message.surfaceId}:${message.conversationId}` },
    ...(assignment.departmentIds ?? []).map((id) => ({ kind: "department" as const, id })),
    ...roles.map((id) => ({ kind: "role" as const, id })),
    { kind: "user", id: userId },
    ...(tokens?.provider ? [{ kind: "provider" as const, id: tokens.provider }] : []),
    ...(tokens?.model ? [{ kind: "model" as const, id: tokens.model }] : []),
  ]);
}

const runtimeLocks = new WeakMap<GatewayEnterpriseRuntime, Promise<void>>();

export async function enforceGatewayRateLimits(input: {
  readonly runtime: GatewayEnterpriseRuntime;
  readonly gateway: Pick<GatewayConfig, "governance">;
  readonly message: SurfaceMessage;
  readonly paired: PairedSender;
  readonly assignment: GatewayGovernanceAssignment;
  readonly estimatedTokens: number;
  readonly nowMs?: number;
}): Promise<GatewayGovernancePreflightResult> {
  const limits = (input.gateway.governance?.rateLimits ?? []).filter((limit) =>
    gatewayLimitMatches(limit, input.message, input.paired, input.assignment));
  if (!limits.length) return { policyIds: [] };

  let release!: () => void;
  const previous = runtimeLocks.get(input.runtime) ?? Promise.resolve();
  const current = new Promise<void>((resolve) => { release = resolve; });
  const chained = previous.then(() => current);
  runtimeLocks.set(input.runtime, chained);
  await previous;
  try {
    const nowMs = input.nowMs ?? Date.now();
    const checks = limits.flatMap((limit) => {
      const bounds = enterpriseWindowBounds(limit.window, nowMs);
      const base = `${limit.subject.kind}:${limit.subject.id}:${bounds.key}`;
      return [
        ...(limit.maxRuns === undefined ? [] : [{
          id: `${base}:runs`, key: `gateway:${base}:runs`, amount: 1, limit: limit.maxRuns,
          subject: `${limit.subject.kind}:${limit.subject.id}`, window: limit.window, bounds,
        }]),
        ...(limit.maxTokens === undefined ? [] : [{
          id: `${base}:tokens`, key: `gateway:${base}:tokens`, amount: input.estimatedTokens, limit: limit.maxTokens,
          subject: `${limit.subject.kind}:${limit.subject.id}`, window: limit.window, bounds,
        }]),
      ];
    });

    const batch = await input.runtime.rateLimitStore.consumeRateLimitsAtomically(checks.map((check) => ({
        key: check.key,
        windowStartMs: check.bounds.startMs,
        windowEndMs: check.bounds.endMs,
        amount: check.amount,
        limit: check.limit,
      })));
    if (!batch.accepted) {
      const rejectedIndex = batch.results.findIndex((result) => !result.accepted);
      const rejected = checks[Math.max(0, rejectedIndex)];
      const decision = batch.results[Math.max(0, rejectedIndex)];
      return {
        blocked: `Rate limit exceeded for ${rejected.subject}: ${(decision?.usedBefore ?? 0) + rejected.amount}/${rejected.limit} ${rejected.id.endsWith(":runs") ? "runs" : "estimated tokens"} in the current ${rejected.window}.`,
        policyIds: checks.map((item) => item.id),
      };
    }
    return { policyIds: checks.map((check) => check.id) };
  } finally {
    release();
    if (runtimeLocks.get(input.runtime) === chained) runtimeLocks.delete(input.runtime);
  }
}

export async function recordGatewayUsage(runtime: GatewayEnterpriseRuntime, input: GatewayUsageRecordInput): Promise<void> {
  const subjects = gatewayEnterpriseSubjects(input.message, input.paired, input.assignment, input.tokens);
  const occurredAt = input.tokens?.createdAt ?? new Date().toISOString();
  const requestFingerprint = sha256(input.message.text);
  const eventId = input.tokens?.runId ?? `gateway_${randomUUID()}`;
  const inputTokens = input.tokens?.inputTokens ?? input.inputTokens ?? 0;
  const outputTokens = input.tokens?.outputTokens ?? input.outputTokens ?? 0;
  const cachedInputTokens = Math.min(inputTokens, input.tokens?.cachedInputTokens ?? 0);
  await runtime.usageStore.appendUsage({
    eventId,
    occurredAt,
    subjects,
    outcome: input.outcome,
    latencyMs: Math.max(0, Math.round(input.latencyMs)),
    inputTokens: Math.max(0, Math.round(inputTokens)),
    outputTokens: Math.max(0, Math.round(outputTokens)),
    cachedInputTokens: Math.max(0, Math.round(cachedInputTokens)),
    costMicrousd: Math.max(0, Math.round((input.tokens?.costUsd ?? 0) * 1_000_000)),
    cacheStatus: cachedInputTokens > 0 ? "hit" : "bypass",
    requestCategory: input.requestCategory ?? classifyGatewayRequest(input.message.text),
  });
  const receipt = createEnterpriseActionReceipt({
    actor: subjects.filter((subject) => ["tenant", "site", "workspace", "channel", "role", "user"].includes(subject.kind)),
    target: subjects,
    action: input.action,
    outcome: input.outcome === "success" ? "completed" : input.outcome === "blocked" ? "blocked" : input.outcome === "cancelled" ? "cancelled" : "failed",
    policyIds: input.policyIds,
    requestFingerprint,
    metadata: {
      surface: input.message.surfaceId,
      category: input.requestCategory ?? classifyGatewayRequest(input.message.text),
      event_id: eventId,
      latency_ms: Math.max(0, Math.round(input.latencyMs)),
      input_tokens: Math.max(0, Math.round(inputTokens)),
      output_tokens: Math.max(0, Math.round(outputTokens)),
    },
  });
  await runtime.receiptStore.appendReceipt(receipt);
}

export function usageEventsForSubjects<T extends { readonly subjects: readonly EnterpriseSubject[] }>(
  events: readonly T[],
  subjects: readonly EnterpriseSubject[],
): readonly T[] {
  return subjects.length ? events.filter((event) => enterpriseScopeMatches(event.subjects, subjects)) : events;
}

export function classifyGatewayRequest(text: string): string {
  const normalized = text.trim().toLowerCase();
  if (normalized.startsWith("/")) return "command";
  if (/\b(?:pdf|docx|xlsx|pptx|spreadsheet|presentation|artifact|report)\b/.test(normalized)) return "artifact";
  if (/\b(?:frappe|erpnext|doctype|employee|leave|attendance|invoice|purchase|sales)\b/.test(normalized)) return "frappe";
  if (/\b(?:test|qa|failover|sentinel|systemd|jenkins|deployment)\b/.test(normalized)) return "operations_qa";
  return "general";
}

function gatewayLimitMatches(
  limit: GatewayGovernanceRateLimit,
  message: SurfaceMessage,
  paired: PairedSender,
  assignment: GatewayGovernanceAssignment,
): boolean {
  const identity = paired.identity?.provider === "frappe" ? paired.identity : undefined;
  if (limit.subject.kind === "user") {
    return [assignment.userId, identity?.user, identity?.employee, message.senderId, paired.pairingId].includes(limit.subject.id);
  }
  if (limit.subject.kind === "role") return [...(assignment.roles ?? []), ...(identity?.roles ?? [])].includes(limit.subject.id);
  if (limit.subject.kind === "channel") return limit.subject.id === `${message.surfaceId}:${message.conversationId}` || limit.subject.id === message.conversationId;
  if (limit.subject.kind === "surface") return limit.subject.id === message.surfaceId;
  if (limit.subject.kind === "tenant") return limit.subject.id === assignment.tenantId || limit.subject.id === identity?.site;
  if (limit.subject.kind === "workspace") return limit.subject.id === assignment.workspaceId;
  return false;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
