import type { MemoryScope } from "./types.js";

export type DepartmentAssistantType =
  | "hr"
  | "finance"
  | "sales"
  | "support"
  | "engineering"
  | "frappe-admin"
  | "cto-cfo-oversight";

export type AssistantResponseStyle =
  | "concise"
  | "detailed"
  | "evidence-first"
  | "executive-summary"
  | "technical-runbook"
  | "non-technical-explanation";

export type ApprovalRequirement = "none" | "required";
export type RiskLevel = "low" | "medium" | "high";
export type BudgetPeriod = "run" | "daily" | "weekly" | "monthly";
export type RateLimitWindow = "minute" | "hour" | "day" | "month";

export interface AssistantModelAllowance {
  readonly provider: string;
  readonly model: string;
}

export interface ArtifactPermissionPolicy {
  readonly create: boolean;
  readonly export: boolean;
  readonly externalShare: boolean;
  readonly allowedMimeTypes?: readonly string[];
}

export interface AssistantApprovalThresholds {
  readonly toolRisk?: RiskLevel;
  readonly memoryHandoff: ApprovalRequirement;
  readonly budgetUsd?: number;
  readonly artifactExternalShare?: ApprovalRequirement;
}

export interface AssistantTokenBudget {
  readonly period: BudgetPeriod;
  readonly maxTokens: number;
  readonly warnAtPercent?: number;
}

export interface AssistantRateLimit {
  readonly window: RateLimitWindow;
  readonly maxRuns?: number;
  readonly maxTokens?: number;
}

export interface AssistantProfileInput {
  readonly id: string;
  readonly departmentType: DepartmentAssistantType;
  readonly responseStyle: AssistantResponseStyle;
  readonly allowedModels: readonly AssistantModelAllowance[];
  readonly allowedTools: readonly string[];
  readonly allowedMcps: readonly string[];
  readonly allowedChannels: readonly string[];
  readonly memoryScopes: readonly MemoryScope[];
  readonly artifactPermissions: ArtifactPermissionPolicy;
  readonly approvalThresholds: AssistantApprovalThresholds;
  readonly tokenBudget?: AssistantTokenBudget;
  readonly rateLimits?: readonly AssistantRateLimit[];
  readonly frappeSitePermissions?: readonly string[];
  readonly escalationRules?: readonly string[];
}

export interface AssistantProfile extends AssistantProfileInput {
  readonly memoryScopes: readonly MemoryScope[];
}

export type MemoryRecallReason =
  | "prior_work_reference"
  | "named_session"
  | "remembered_fact"
  | "preference_reference"
  | "frappe_user_state"
  | "project_handoff"
  | "previous_decision";

export type MemoryRecallSkipReason =
  | "simple_greeting"
  | "status_command"
  | "setup_command"
  | "deterministic_tool_call"
  | "prompt_does_not_need_memory"
  | "shared_memory_handoff_requires_approval"
  | "enterprise_controls_disabled";

export interface MemoryRecallDecisionInput {
  readonly prompt: string;
  readonly scopes: readonly MemoryScope[];
  readonly requestedSharedScopes?: readonly MemoryScope[];
  readonly handoffApproved?: boolean;
}

export interface MemoryRecallDecision {
  readonly action: "recall" | "skip" | "blocked";
  readonly shouldSearch: boolean;
  readonly reasons: readonly MemoryRecallReason[];
  readonly skipReason?: MemoryRecallSkipReason;
  readonly effectiveScopes: readonly MemoryScope[];
}

export type GovernanceSubjectKind = "user" | "role" | "channel" | "tenant" | "workspace";

export interface GovernanceSubject {
  readonly kind: GovernanceSubjectKind;
  readonly id: string;
}

export interface TokenGovernanceRequest {
  readonly userId: string;
  readonly roleIds: readonly string[];
  readonly channelId: string;
  readonly tenantId?: string;
  readonly workspaceId?: string;
  readonly estimatedInputTokens: number;
  readonly estimatedOutputTokens: number;
}

export interface TokenBudgetPolicy {
  readonly subject: GovernanceSubject;
  readonly period: BudgetPeriod;
  readonly maxTokens: number;
  readonly usedTokens: number;
  readonly warnAtPercent?: number;
}

export interface TokenBudgetAlert {
  readonly subject: string;
  readonly level: "warning" | "blocked";
  readonly usedTokens: number;
  readonly projectedTokens: number;
  readonly maxTokens: number;
  readonly percentUsed: number;
}

export interface TokenBudgetDecision {
  readonly status: "allow" | "warn" | "block";
  readonly projectedTokens: number;
  readonly matchedSubjects: readonly string[];
  readonly alerts: readonly TokenBudgetAlert[];
  readonly blockedBy?: TokenBudgetAlert;
}

export interface TokenRateLimitPolicy {
  readonly subject: GovernanceSubject;
  readonly window: RateLimitWindow;
  readonly maxRuns?: number;
  readonly maxTokens?: number;
  readonly currentRuns?: number;
  readonly currentTokens?: number;
}

export interface TokenRateLimitBlock {
  readonly subject: string;
  readonly reason: "run_limit" | "token_limit";
  readonly window: RateLimitWindow;
}

export interface TokenRateLimitDecision {
  readonly status: "allow" | "block";
  readonly projectedTokens: number;
  readonly matchedSubjects: readonly string[];
  readonly blockedBy?: TokenRateLimitBlock;
}

export interface BudgetLedgerEntry {
  readonly userId: string;
  readonly roleIds: readonly string[];
  readonly channelId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface AuditReceiptInput {
  readonly runId: string;
  readonly channel: AuditChannelIdentity;
  readonly provider: AuditProviderIdentity;
  readonly memory: MemoryRecallDecision;
  readonly artifacts?: readonly AuditArtifactReceipt[];
  readonly delivery: AuditDeliveryReceipt;
  readonly approvals?: readonly AuditApprovalReceipt[];
  readonly failures?: readonly AuditFailureReceipt[];
}

export interface AuditChannelIdentity {
  readonly id: string;
  readonly kind: string;
  readonly userId?: string;
  readonly threadId?: string;
  readonly sessionId?: string;
}

export interface AuditProviderIdentity {
  readonly id: string;
  readonly model: string;
}

export interface AuditArtifactReceipt {
  readonly title: string;
  readonly mimeType: string;
  readonly deliveryStatus: string;
  readonly path?: string;
  readonly url?: string;
}

export interface AuditDeliveryReceipt {
  readonly status: string;
  readonly target: string;
}

export interface AuditApprovalReceipt {
  readonly kind: string;
  readonly status: "approved" | "denied" | "pending";
  readonly approverId?: string;
}

export interface AuditFailureReceipt {
  readonly stage: string;
  readonly message: string;
}

export interface AuditReceipt {
  readonly runId: string;
  readonly createdAt: string;
  readonly channel: AuditChannelIdentity;
  readonly provider: AuditProviderIdentity;
  readonly memory: MemoryRecallDecision;
  readonly artifacts: readonly AuditArtifactReceipt[];
  readonly delivery: AuditDeliveryReceipt;
  readonly approvals: readonly AuditApprovalReceipt[];
  readonly failures: readonly AuditFailureReceipt[];
}

export interface EnterpriseGovernanceConfig {
  readonly enabled: boolean;
}

export interface GovernanceEvaluationInput {
  readonly enterprise: EnterpriseGovernanceConfig;
  readonly request: TokenGovernanceRequest & { readonly prompt: string; readonly scopes: readonly MemoryScope[] };
  readonly loadEnterprisePolicy: () => Promise<{
    readonly budgets?: readonly TokenBudgetPolicy[];
    readonly rateLimits?: readonly TokenRateLimitPolicy[];
    readonly requestedSharedScopes?: readonly MemoryScope[];
    readonly handoffApproved?: boolean;
  }>;
}

export interface GovernanceEvaluation {
  readonly mode: "personal" | "enterprise";
  readonly enabled: boolean;
  readonly memory: MemoryRecallDecision;
  readonly budget: TokenBudgetDecision;
  readonly rateLimit: TokenRateLimitDecision;
  readonly auditRequired: boolean;
}

const DEPARTMENT_TYPES = new Set<DepartmentAssistantType>([
  "hr",
  "finance",
  "sales",
  "support",
  "engineering",
  "frappe-admin",
  "cto-cfo-oversight",
]);

const RESPONSE_STYLES = new Set<AssistantResponseStyle>([
  "concise",
  "detailed",
  "evidence-first",
  "executive-summary",
  "technical-runbook",
  "non-technical-explanation",
]);

const SCOPE_KINDS = new Set<MemoryScope["kind"]>(["global", "tenant", "workspace", "user", "pairing", "session", "role", "persona"]);

export function validateAssistantProfile(input: AssistantProfileInput): AssistantProfile {
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(input.id)) throw new Error("Assistant profile id must be lowercase kebab-case.");
  if (!DEPARTMENT_TYPES.has(input.departmentType)) throw new Error(`Unknown department assistant type: ${input.departmentType}`);
  if (!RESPONSE_STYLES.has(input.responseStyle)) throw new Error(`Unknown response style: ${input.responseStyle}`);
  if (!input.allowedModels.length) throw new Error("Assistant profile requires at least one allowed provider/model.");
  for (const allowance of input.allowedModels) {
    if (!allowance.provider.trim() || !allowance.model.trim()) throw new Error("Allowed provider/model entries must be non-empty.");
  }
  if (!input.allowedChannels.length) throw new Error("Assistant profile requires at least one allowed channel.");
  const memoryScopes = normalizeMemoryScopes(input.memoryScopes);
  if (!memoryScopes.length) throw new Error("Assistant profile requires at least one memory scope.");
  if (input.artifactPermissions.externalShare && input.approvalThresholds.artifactExternalShare !== "required") {
    throw new Error("External artifact sharing requires approval.");
  }
  validatePositiveLimit(input.tokenBudget?.maxTokens, "Token budget");
  for (const limit of input.rateLimits ?? []) {
    validatePositiveLimit(limit.maxRuns, "Rate limit maxRuns");
    validatePositiveLimit(limit.maxTokens, "Rate limit maxTokens");
  }
  return { ...input, memoryScopes };
}

export function decideMemoryRecall(input: MemoryRecallDecisionInput): MemoryRecallDecision {
  const prompt = input.prompt.toLowerCase().replace(/\s+/g, " ").trim();
  const scopes = normalizeMemoryScopes(input.scopes);
  if (!scopes.length) throw new Error("Memory recall requires at least one scope.");

  if (input.requestedSharedScopes?.length && !input.handoffApproved) {
    return {
      action: "blocked",
      shouldSearch: false,
      reasons: [],
      skipReason: "shared_memory_handoff_requires_approval",
      effectiveScopes: scopes,
    };
  }

  const skipReason = recallSkipReason(prompt);
  if (skipReason) {
    return { action: "skip", shouldSearch: false, reasons: [], skipReason, effectiveScopes: scopes };
  }

  const reasons = recallReasons(prompt);
  if (!reasons.length) {
    return {
      action: "skip",
      shouldSearch: false,
      reasons: [],
      skipReason: "prompt_does_not_need_memory",
      effectiveScopes: scopes,
    };
  }

  return {
    action: "recall",
    shouldSearch: true,
    reasons,
    effectiveScopes: normalizeMemoryScopes([...scopes, ...(input.requestedSharedScopes ?? [])]),
  };
}

export function evaluateTokenBudget(input: { readonly request: TokenGovernanceRequest; readonly budgets: readonly TokenBudgetPolicy[] }): TokenBudgetDecision {
  const projectedTokens = projectedRequestTokens(input.request);
  const matched = input.budgets.filter((budget) => subjectMatches(input.request, budget.subject));
  const alerts: TokenBudgetAlert[] = [];
  for (const budget of matched) {
    const projectedUsed = budget.usedTokens + projectedTokens;
    const percentUsed = Math.round(projectedUsed / budget.maxTokens * 10_000) / 100;
    if (projectedUsed > budget.maxTokens) {
      alerts.push({
        subject: formatSubject(budget.subject),
        level: "blocked",
        usedTokens: budget.usedTokens,
        projectedTokens,
        maxTokens: budget.maxTokens,
        percentUsed,
      });
      continue;
    }
    const warnAtPercent = budget.warnAtPercent ?? 90;
    if (percentUsed >= warnAtPercent) {
      alerts.push({
        subject: formatSubject(budget.subject),
        level: "warning",
        usedTokens: budget.usedTokens,
        projectedTokens,
        maxTokens: budget.maxTokens,
        percentUsed,
      });
    }
  }
  const blockedBy = alerts.find((alert) => alert.level === "blocked");
  return {
    status: blockedBy ? "block" : alerts.length ? "warn" : "allow",
    projectedTokens,
    matchedSubjects: matched.map((budget) => formatSubject(budget.subject)),
    alerts,
    blockedBy,
  };
}

export function evaluateTokenRateLimit(input: { readonly request: TokenGovernanceRequest; readonly limits: readonly TokenRateLimitPolicy[] }): TokenRateLimitDecision {
  const projectedTokens = projectedRequestTokens(input.request);
  const matched = input.limits.filter((limit) => subjectMatches(input.request, limit.subject));
  for (const limit of matched) {
    const subject = formatSubject(limit.subject);
    if (limit.maxRuns !== undefined && (limit.currentRuns ?? 0) + 1 > limit.maxRuns) {
      return {
        status: "block",
        projectedTokens,
        matchedSubjects: matched.map((entry) => formatSubject(entry.subject)),
        blockedBy: { subject, reason: "run_limit", window: limit.window },
      };
    }
    if (limit.maxTokens !== undefined && (limit.currentTokens ?? 0) + projectedTokens > limit.maxTokens) {
      return {
        status: "block",
        projectedTokens,
        matchedSubjects: matched.map((entry) => formatSubject(entry.subject)),
        blockedBy: { subject, reason: "token_limit", window: limit.window },
      };
    }
  }
  return { status: "allow", projectedTokens, matchedSubjects: matched.map((entry) => formatSubject(entry.subject)) };
}

export function renderTokenBudgetReport(entries: readonly BudgetLedgerEntry[]): string {
  if (!entries.length) return "No governed token usage yet.";
  const totals = new Map<string, number>();
  for (const entry of entries) {
    const tokens = entry.inputTokens + entry.outputTokens;
    addTotal(totals, `user:${entry.userId}`, tokens);
    addTotal(totals, `channel:${entry.channelId}`, tokens);
    for (const roleId of entry.roleIds) addTotal(totals, `role:${roleId}`, tokens);
  }
  const lines = ["subject tokens", "--------------"];
  for (const [subject, tokens] of [...totals].sort((left, right) => left[0].localeCompare(right[0]))) {
    lines.push(`${subject} ${tokens}`);
  }
  return lines.join("\n");
}

export function buildAuditReceipt(input: AuditReceiptInput): AuditReceipt {
  return {
    runId: input.runId,
    createdAt: new Date().toISOString(),
    channel: sanitizeObject(input.channel),
    provider: sanitizeObject(input.provider),
    memory: {
      ...input.memory,
      effectiveScopes: normalizeMemoryScopes(input.memory.effectiveScopes),
    },
    artifacts: (input.artifacts ?? []).map((artifact) => sanitizeObject(artifact)),
    delivery: sanitizeObject(input.delivery),
    approvals: (input.approvals ?? []).map((approval) => sanitizeObject(approval)),
    failures: (input.failures ?? []).map((failure) => sanitizeObject(failure)),
  };
}

export function disabledEnterpriseDecision(): GovernanceEvaluation {
  return {
    mode: "personal",
    enabled: false,
    memory: {
      action: "skip",
      shouldSearch: false,
      reasons: [],
      skipReason: "enterprise_controls_disabled",
      effectiveScopes: [],
    },
    budget: { status: "allow", projectedTokens: 0, matchedSubjects: [], alerts: [] },
    rateLimit: { status: "allow", projectedTokens: 0, matchedSubjects: [] },
    auditRequired: false,
  };
}

export async function evaluateGovernance(input: GovernanceEvaluationInput): Promise<GovernanceEvaluation> {
  if (!input.enterprise.enabled) return disabledEnterpriseDecision();
  const policy = await input.loadEnterprisePolicy();
  const memory = decideMemoryRecall({
    prompt: input.request.prompt,
    scopes: input.request.scopes,
    requestedSharedScopes: policy.requestedSharedScopes,
    handoffApproved: policy.handoffApproved,
  });
  return {
    mode: "enterprise",
    enabled: true,
    memory,
    budget: evaluateTokenBudget({ request: input.request, budgets: policy.budgets ?? [] }),
    rateLimit: evaluateTokenRateLimit({ request: input.request, limits: policy.rateLimits ?? [] }),
    auditRequired: true,
  };
}

function recallSkipReason(prompt: string): MemoryRecallSkipReason | undefined {
  if (/^(hi|hello|hey|yo|thanks|thank you|ok|okay)[.!? ]*$/.test(prompt)) return "simple_greeting";
  if (/^(status|doctor|version|help)\b/.test(prompt) || /^muster (status|doctor|version|help)\b/.test(prompt)) return "status_command";
  if (/\b(setup|configure|ready)\b/.test(prompt) && /\b(channel|plugin|provider|telegram|slack|frappe|mcp)\b/.test(prompt)) return "setup_command";
  if (/\b(list|show|print)\b/.test(prompt) && /\b(current|this|working)\b/.test(prompt) && /\b(folder|directory|files?)\b/.test(prompt)) {
    return "deterministic_tool_call";
  }
  return undefined;
}

function recallReasons(prompt: string): MemoryRecallReason[] {
  const reasons: MemoryRecallReason[] = [];
  addReason(reasons, /\b(previous|prior|earlier|last time|last week|yesterday|before)\b/.test(prompt), "prior_work_reference");
  addReason(reasons, /\bsession\b/.test(prompt), "named_session");
  addReason(reasons, /\b(remember|remembered|memory|preference|prefers?)\b/.test(prompt), "remembered_fact");
  addReason(reasons, /\b(tone|style|preference|prefers?)\b/.test(prompt), "preference_reference");
  addReason(reasons, /\bfrappe|erpnext|doctype|workflow|permission\b/.test(prompt), "frappe_user_state");
  addReason(reasons, /\bhandoff|shared team|project context\b/.test(prompt), "project_handoff");
  addReason(reasons, /\bdecision|decided|approved|rejected\b/.test(prompt), "previous_decision");
  return reasons;
}

function addReason(reasons: MemoryRecallReason[], matched: boolean, reason: MemoryRecallReason): void {
  if (matched && !reasons.includes(reason)) reasons.push(reason);
}

function projectedRequestTokens(request: TokenGovernanceRequest): number {
  return Math.max(0, Math.floor(request.estimatedInputTokens)) + Math.max(0, Math.floor(request.estimatedOutputTokens));
}

function subjectMatches(request: TokenGovernanceRequest, subject: GovernanceSubject): boolean {
  if (subject.kind === "user") return request.userId === subject.id;
  if (subject.kind === "role") return request.roleIds.includes(subject.id);
  if (subject.kind === "channel") return request.channelId === subject.id;
  if (subject.kind === "tenant") return request.tenantId === subject.id;
  if (subject.kind === "workspace") return request.workspaceId === subject.id;
  return false;
}

function formatSubject(subject: GovernanceSubject): string {
  return `${subject.kind}:${subject.id}`;
}

function addTotal(totals: Map<string, number>, subject: string, tokens: number): void {
  totals.set(subject, (totals.get(subject) ?? 0) + tokens);
}

function normalizeMemoryScopes(scopes: readonly MemoryScope[]): MemoryScope[] {
  const seen = new Set<string>();
  const result: MemoryScope[] = [];
  for (const scope of scopes) {
    if (!SCOPE_KINDS.has(scope.kind)) throw new Error(`Invalid memory scope kind: ${scope.kind}`);
    const id = scope.kind === "global" ? "global" : scope.id.trim();
    if (!id) throw new Error(`Memory scope ${scope.kind} requires an id.`);
    const normalized = { kind: scope.kind, id };
    const key = `${normalized.kind}:${normalized.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  }
  return result;
}

function validatePositiveLimit(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error(`${label} must be positive.`);
}

function sanitizeObject<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map((entry) => sanitizeObject(entry)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, sanitizeObject(entry)])
    ) as T;
  }
  return value;
}

function redactSecrets(value: string): string {
  return value
    .replace(/(token=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b(xox[a-z]-)[A-Za-z0-9-]+/g, "$1[redacted]")
    .replace(/\b[A-Za-z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD)[A-Za-z0-9_]*=([^\s]+)/g, (match) => match.replace(/=([^\s]+)/, "=[redacted]"));
}
