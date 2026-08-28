/**
 * Agent Kanban Orchestrator: a governed, event-sourced task board.
 *
 * Three invariants hold the design together:
 *  1. The board is reconstructable from its log alone. State is a pure fold over events; every
 *     surface renders from the fold, never from a side channel (STRATEGY_V2 Wave 0 gate).
 *  2. Capability match is mandatory and re-checked by the reducer at `task_assigned`, so a wrong
 *     assignment cannot be committed even when the planner is buggy or the event is forged.
 *  3. The log carries digests, never model answers or context text. `ConsultationAnswer` and
 *     `ContextBundleReceipt` have no text field at all, so prose cannot enter the log structurally.
 *
 * STRATEGY_V2 §2.2 is why the codex-cli card ships a caveat rather than a capability claim: the
 * app-server emitted zero `item/fileChange/patchUpdated` events in 3/3 live runs and edits arrived
 * through shell `commandExecution`, so the agent's self-report is never the audit source. Model
 * cards therefore carry graded evidence, and `vendor_claim` scores lowest of all evidence kinds.
 *
 * I/O-free leaf: the only runtime import is node:crypto plus one type-only import. It deliberately
 * does not import tokens.ts, which would drag store.ts -> config.ts/profiles.ts and filesystem
 * access into a module that must stay pure and replayable.
 */

import { createHash } from "node:crypto";
import type { MemoryScope } from "./types.js";

// ============================================================================
// 1. Status lattice
// ============================================================================

export type KanbanStatus =
  | "backlog"
  | "ready"
  | "assigned"
  | "in_progress"
  | "review"
  | "done"
  | "blocked"
  | "needs_intervention";

export type KanbanPriority = "critical" | "high" | "normal" | "low";
export type KanbanActorKind = "human" | "agent" | "system";

export const KANBAN_STATUSES: readonly KanbanStatus[] = [
  "backlog", "ready", "assigned", "in_progress", "review", "done", "blocked", "needs_intervention",
];

/**
 * Deny-by-default transition lattice; `done` is the only terminal status. `review -> assigned`
 * (not `-> in_progress`) is deliberate: rework re-enters through task_started, so MAX_TASK_ATTEMPTS
 * bounds the review loop. Rework beyond the cap is an escalation, not a retry.
 */
export const KANBAN_TRANSITIONS: Readonly<Record<KanbanStatus, readonly KanbanStatus[]>> = {
  backlog: ["ready", "blocked", "needs_intervention"],
  ready: ["assigned", "blocked", "backlog", "needs_intervention"],
  assigned: ["in_progress", "ready", "blocked", "needs_intervention"],
  in_progress: ["review", "blocked", "needs_intervention"],
  review: ["done", "assigned", "blocked", "needs_intervention"],
  blocked: ["ready", "backlog", "needs_intervention"],
  needs_intervention: ["ready", "backlog", "blocked"],
  done: [],
};

export const KANBAN_PRIORITY_RANK: Readonly<Record<KanbanPriority, number>> = {
  critical: 0, high: 1, normal: 2, low: 3,
};

/** Statuses that hold model + agent capacity. Load is derived from status, never from event type. */
export const KANBAN_CAPACITY_STATUSES: ReadonlySet<KanbanStatus> = new Set<KanbanStatus>(["assigned", "in_progress"]);

export const MAX_TASK_ATTEMPTS = 3;

export function isLegalKanbanTransition(from: KanbanStatus, to: KanbanStatus): boolean {
  return KANBAN_TRANSITIONS[from]?.includes(to) ?? false;
}

// ============================================================================
// 2. Internal helpers (pure, no clock, no I/O)
// ============================================================================

const ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.:-]*$/;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9_]*$/;
const MEMORY_SCOPE_KINDS = new Set(["global", "tenant", "workspace", "user", "pairing", "session", "role", "persona"]);
const CONTEXT_REF_KINDS = new Set(["memory", "session", "file", "artifact", "receipt", "url", "doctype"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampNonNegativeInt(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

/** Stable serialization: sorted keys, dropped undefined, array order preserved. */
function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

/** Mirrors tokens.ts:47 estimateTokens; kept local so this module stays an I/O-free leaf. */
function estimateContextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ============================================================================
// 3. Tasks and context refs
// ============================================================================

export type ContextRefKind = "memory" | "session" | "file" | "artifact" | "receipt" | "url" | "doctype";

export interface ContextRef {
  readonly id: string;
  readonly kind: ContextRefKind;
  readonly uri: string;
  /** Mandatory: an unscoped ref cannot be authority-checked, so it is rejected at task validation. */
  readonly scope: MemoryScope;
  readonly required?: boolean;
}

export interface KanbanTask {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  /** Non-empty; matched by exact string equality, never fuzzily. */
  readonly requiredCapabilities: readonly string[];
  readonly preferredStrengths?: readonly string[];
  readonly contextRefs: readonly ContextRef[];
  readonly dependsOn: readonly string[];
  readonly priority: KanbanPriority;
  readonly estimatedContextTokens?: number;
  readonly labels?: readonly string[];
  readonly createdAt: string;
}

/** Validate untrusted task JSON without executing or mutating it (agent-graph.ts idiom). */
export function validateKanbanTask(value: unknown): readonly string[] {
  const issues: string[] = [];
  if (!isRecord(value)) return ["Task must be an object."];
  if (typeof value.id !== "string" || !ID_PATTERN.test(value.id)) issues.push("Task id is invalid.");
  if (typeof value.title !== "string" || !value.title.trim()) issues.push("Task title is required.");
  if (typeof value.goal !== "string" || !value.goal.trim()) issues.push("Task goal is required.");

  const capabilities = value.requiredCapabilities;
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    // An empty requirement set would make every card qualify; that is how a governed board starts
    // misassigning, so it is rejected rather than defaulted.
    issues.push("Task must declare at least one required capability.");
  } else {
    const seen = new Set<string>();
    for (const capability of capabilities) {
      if (typeof capability !== "string" || !CAPABILITY_PATTERN.test(capability)) issues.push(`Required capability "${String(capability)}" is not a lower_snake token.`);
      else if (seen.has(capability)) issues.push(`Duplicate required capability "${capability}".`);
      else seen.add(capability);
    }
  }
  if (value.preferredStrengths !== undefined && (!Array.isArray(value.preferredStrengths) || value.preferredStrengths.some((entry) => typeof entry !== "string" || !entry.trim()))) {
    issues.push("preferredStrengths must be an array of non-empty strings.");
  }
  if (value.labels !== undefined && (!Array.isArray(value.labels) || value.labels.some((entry) => typeof entry !== "string"))) {
    issues.push("labels must be an array of strings.");
  }
  // Object.hasOwn, not `in`: "toString" et al. would pass via the prototype chain and score NaN.
  if (typeof value.priority !== "string" || !Object.hasOwn(KANBAN_PRIORITY_RANK, value.priority)) issues.push("Task priority is invalid.");
  if (value.estimatedContextTokens !== undefined && (!Number.isInteger(value.estimatedContextTokens) || (value.estimatedContextTokens as number) < 0)) {
    issues.push("estimatedContextTokens must be a non-negative integer.");
  }
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) issues.push("Task createdAt must be an ISO timestamp.");

  if (!Array.isArray(value.dependsOn)) issues.push("dependsOn must be an array.");
  else {
    const seen = new Set<string>();
    for (const dependency of value.dependsOn) {
      if (typeof dependency !== "string" || !ID_PATTERN.test(dependency)) issues.push(`Dependency "${String(dependency)}" is not a valid task id.`);
      else if (dependency === value.id) issues.push("A task cannot depend on itself.");
      else if (seen.has(dependency)) issues.push(`Duplicate dependency "${dependency}".`);
      else seen.add(dependency);
    }
  }

  if (!Array.isArray(value.contextRefs)) issues.push("contextRefs must be an array.");
  else {
    const seen = new Set<string>();
    for (const [index, rawRef] of value.contextRefs.entries()) {
      const label = `contextRefs[${index}]`;
      if (!isRecord(rawRef)) { issues.push(`${label} must be an object.`); continue; }
      if (typeof rawRef.id !== "string" || !rawRef.id.trim()) issues.push(`${label} requires an id.`);
      else if (seen.has(rawRef.id)) issues.push(`Duplicate context ref id "${rawRef.id}".`);
      else seen.add(rawRef.id);
      if (typeof rawRef.kind !== "string" || !CONTEXT_REF_KINDS.has(rawRef.kind)) issues.push(`${label} has an invalid kind.`);
      if (typeof rawRef.uri !== "string" || !rawRef.uri.trim()) issues.push(`${label} requires a uri.`);
      if (!isRecord(rawRef.scope) || typeof rawRef.scope.kind !== "string" || !MEMORY_SCOPE_KINDS.has(rawRef.scope.kind) || typeof rawRef.scope.id !== "string" || !rawRef.scope.id.trim()) {
        issues.push(`${label} requires a scope; an unscoped ref cannot be authority-checked.`);
      }
      if (rawRef.required !== undefined && typeof rawRef.required !== "boolean") issues.push(`${label}.required must be a boolean.`);
    }
  }
  return issues;
}

export function parseKanbanTask(value: unknown): KanbanTask {
  const issues = validateKanbanTask(value);
  if (issues.length > 0) throw new Error(`Invalid kanban task:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
  return value as KanbanTask;
}

// ============================================================================
// 4. Model card registry
// ============================================================================

export type CostTier = "free" | "low" | "medium" | "high" | "premium";
export type LatencyTier = "realtime" | "fast" | "standard" | "slow";
export type ModelDeployment = "cloud" | "local" | "cli" | "aggregator";
export type DataResidency = "any" | "in_region" | "on_premise";
export type ModelEvidenceKind = "live_probe" | "internal_eval" | "benchmark" | "integration_test" | "vendor_claim";

export interface ModelCardEvidence {
  readonly kind: ModelEvidenceKind;
  /** A repo path (file:line) or a fetched URL. Never a bare assertion. */
  readonly ref: string;
  readonly metric?: string;
  readonly value?: number;
  readonly observedAt?: string;
}

export interface ModelCard {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly deployment: ModelDeployment;
  /** Hard gate: exact string equality against task.requiredCapabilities. */
  readonly capabilities: readonly string[];
  /** Soft signal only; contributes a weighted score, never a gate. */
  readonly strengths: readonly string[];
  readonly costTier: CostTier;
  readonly latencyTier: LatencyTier;
  readonly contextWindow: number;
  readonly evidence: readonly ModelCardEvidence[];
  readonly dataResidency?: DataResidency;
  readonly maxConcurrentTasks?: number;
  readonly caveats?: readonly string[];
  readonly retired?: boolean;
}

/** Advisory canonical vocabulary. Matching is exact string equality; this list does not close the type. */
export const KANBAN_CAPABILITIES: readonly string[] = [
  "code_edit", "code_review", "test_authoring", "debugging", "architecture", "research", "web_search",
  "long_context", "structured_output", "tool_use", "vision", "artifact_generation", "sql", "data_analysis",
  "local_execution", "air_gapped", "agentic_shell", "translation", "classification",
];

const COST_TIERS: readonly CostTier[] = ["free", "low", "medium", "high", "premium"];
const LATENCY_TIERS: readonly LatencyTier[] = ["realtime", "fast", "standard", "slow"];
const DEPLOYMENTS = new Set<ModelDeployment>(["cloud", "local", "cli", "aggregator"]);
const RESIDENCIES = new Set<DataResidency>(["any", "in_region", "on_premise"]);
const EVIDENCE_KINDS = new Set<ModelEvidenceKind>(["live_probe", "internal_eval", "benchmark", "integration_test", "vendor_claim"]);

export function validateModelCard(value: unknown): readonly string[] {
  const issues: string[] = [];
  if (!isRecord(value)) return ["Model card must be an object."];
  if (typeof value.id !== "string" || !value.id.trim()) issues.push("Model card id is required.");
  if (typeof value.provider !== "string" || !value.provider.trim()) issues.push("Model card provider is required.");
  if (typeof value.model !== "string" || !value.model.trim()) issues.push("Model card model is required.");
  if (!DEPLOYMENTS.has(value.deployment as ModelDeployment)) issues.push("Model card deployment is invalid.");
  if (!COST_TIERS.includes(value.costTier as CostTier)) issues.push("Model card costTier is invalid.");
  if (!LATENCY_TIERS.includes(value.latencyTier as LatencyTier)) issues.push("Model card latencyTier is invalid.");
  if (!Number.isInteger(value.contextWindow) || (value.contextWindow as number) <= 0) issues.push("Model card contextWindow must be a positive integer.");
  if (!Array.isArray(value.capabilities) || value.capabilities.length === 0 || value.capabilities.some((entry) => typeof entry !== "string" || !CAPABILITY_PATTERN.test(entry))) {
    issues.push("Model card must declare at least one lower_snake capability.");
  }
  if (!Array.isArray(value.strengths) || value.strengths.some((entry) => typeof entry !== "string" || !entry.trim())) {
    issues.push("Model card strengths must be an array of non-empty strings.");
  }
  if (!Array.isArray(value.evidence) || value.evidence.length === 0) issues.push("Model card must cite at least one evidence entry.");
  else for (const [index, rawEvidence] of value.evidence.entries()) {
    if (!isRecord(rawEvidence) || !EVIDENCE_KINDS.has(rawEvidence.kind as ModelEvidenceKind) || typeof rawEvidence.ref !== "string" || !rawEvidence.ref.trim()) {
      issues.push(`evidence[${index}] requires a known kind and a non-empty ref.`);
    }
  }
  if (value.dataResidency !== undefined && !RESIDENCIES.has(value.dataResidency as DataResidency)) issues.push("Model card dataResidency is invalid.");
  if (value.maxConcurrentTasks !== undefined && clampNonNegativeInt(value.maxConcurrentTasks) === undefined) issues.push("maxConcurrentTasks must be a non-negative integer.");
  if (value.retired !== undefined && typeof value.retired !== "boolean") issues.push("retired must be a boolean.");
  return issues;
}

function vendorClaim(catalogLine: number, contextWindow: number): ModelCardEvidence {
  return { kind: "vendor_claim", ref: `packages/core/src/providers-catalog.ts:${catalogLine}`, metric: "context_window", value: contextWindow };
}

const SERVED_MODEL_CAVEAT = "capabilities and context window depend on the served model; operators must override this card via model_card_registered";

/**
 * Starting inventory, not a source of truth. Eighteen of twenty cards cite only `vendor_claim`
 * evidence from providers-catalog.ts, which is vendor marketing, not measurement. Re-measure per
 * release exactly as STRATEGY_V2's appendix prescribes for the codex probe, and override a stale
 * card with `model_card_registered` rather than editing this list in place.
 */
export const MODEL_CARD_SEED: readonly ModelCard[] = [
  {
    id: "anthropic/claude-fable-5", provider: "anthropic", model: "claude-fable-5", deployment: "cloud",
    capabilities: ["code_edit", "code_review", "architecture", "long_context", "structured_output", "tool_use", "vision", "artifact_generation"],
    strengths: ["refactoring", "long_context_recall", "instruction_following", "code_review"],
    costTier: "high", latencyTier: "standard", contextWindow: 1_000_000,
    evidence: [vendorClaim(23, 1_000_000)], dataResidency: "any",
  },
  {
    id: "claude-code/claude-fable-5", provider: "claude-code", model: "claude-fable-5", deployment: "cli",
    capabilities: ["code_edit", "code_review", "debugging", "test_authoring", "tool_use", "local_execution", "agentic_shell", "long_context"],
    strengths: ["agentic_shell", "repo_navigation", "test_authoring", "refactoring"],
    costTier: "high", latencyTier: "standard", contextWindow: 1_000_000,
    evidence: [
      { kind: "integration_test", ref: "packages/core/test/claude.test.ts" },
      vendorClaim(23, 1_000_000),
    ],
    dataResidency: "any",
    caveats: ["subscription CLI auth; throughput is bounded by the local `claude` login, not by an API quota"],
  },
  {
    id: "openai/gpt-5.6", provider: "openai", model: "gpt-5.6", deployment: "cloud",
    capabilities: ["code_edit", "code_review", "architecture", "structured_output", "tool_use", "vision"],
    strengths: ["structured_output", "architecture", "instruction_following"],
    costTier: "medium", latencyTier: "standard", contextWindow: 400_000,
    evidence: [vendorClaim(22, 400_000)], dataResidency: "any",
  },
  {
    id: "codex-cli/gpt-5.6-sol", provider: "codex-cli", model: "gpt-5.6-sol", deployment: "cli",
    capabilities: ["code_edit", "debugging", "tool_use", "local_execution", "agentic_shell"],
    strengths: ["agentic_shell", "repo_navigation", "debugging"],
    costTier: "medium", latencyTier: "slow", contextWindow: 1_000_000,
    evidence: [
      { kind: "live_probe", ref: "docs/STRATEGY_V2.md#2.2", metric: "first_token_ms", value: 6246, observedAt: "2026-08-27" },
      { kind: "integration_test", ref: "packages/core/test/codex.test.ts" },
      // The only source for this model's window is the operator's own codex
      // config; cite that file, not the preset line, so the claim is checkable.
      { kind: "vendor_claim", ref: "~/.codex/config.toml (model_context_window)", metric: "context_window", value: 1_000_000, observedAt: "2026-08-27" },
    ],
    dataResidency: "any",
    caveats: [
      "codex app-server emitted zero item/fileChange/patchUpdated events in 3/3 live runs (STRATEGY_V2 §2.2); edits arrive via shell commandExecution, so the workspace observer, not this backend, is the audit source",
      "first text delta measured 5.3-9.4s against the local codex CLI on 2026-08-27",
      "the context window is read from the operator's ~/.codex/config.toml, not from a published vendor benchmark",
    ],
  },
  {
    id: "xai/grok-4", provider: "xai", model: "grok-4", deployment: "cloud",
    capabilities: ["code_edit", "research", "structured_output", "tool_use"],
    strengths: ["research", "fast_iteration"],
    costTier: "medium", latencyTier: "fast", contextWindow: 256_000,
    evidence: [vendorClaim(25, 256_000)], dataResidency: "any",
  },
  {
    id: "kimi/kimi-k2-0905-preview", provider: "kimi", model: "kimi-k2-0905-preview", deployment: "cloud",
    capabilities: ["code_edit", "long_context", "structured_output", "tool_use"],
    strengths: ["long_context_recall", "cheap_bulk"],
    costTier: "low", latencyTier: "standard", contextWindow: 256_000,
    evidence: [vendorClaim(26, 256_000)], dataResidency: "any",
  },
  {
    id: "deepseek/deepseek-chat", provider: "deepseek", model: "deepseek-chat", deployment: "cloud",
    capabilities: ["code_edit", "code_review", "structured_output", "tool_use", "sql"],
    strengths: ["cheap_bulk", "sql", "code_review"],
    costTier: "low", latencyTier: "standard", contextWindow: 128_000,
    evidence: [vendorClaim(27, 128_000)], dataResidency: "any",
  },
  {
    id: "mistral/mistral-large-latest", provider: "mistral", model: "mistral-large-latest", deployment: "cloud",
    capabilities: ["code_edit", "structured_output", "tool_use", "translation"],
    strengths: ["translation", "fast_iteration"],
    costTier: "medium", latencyTier: "fast", contextWindow: 128_000,
    evidence: [vendorClaim(28, 128_000)], dataResidency: "any",
  },
  {
    id: "gemini/gemini-2.5-pro", provider: "gemini", model: "gemini-2.5-pro", deployment: "cloud",
    capabilities: ["long_context", "vision", "research", "structured_output", "tool_use", "code_edit"],
    strengths: ["long_context_recall", "vision", "research"],
    costTier: "medium", latencyTier: "standard", contextWindow: 1_000_000,
    evidence: [vendorClaim(29, 1_000_000)], dataResidency: "any",
  },
  {
    id: "qwen/qwen-max", provider: "qwen", model: "qwen-max", deployment: "cloud",
    capabilities: ["code_edit", "structured_output", "tool_use", "translation", "classification"],
    strengths: ["cheap_bulk", "translation"],
    costTier: "low", latencyTier: "standard", contextWindow: 128_000,
    evidence: [vendorClaim(30, 128_000)], dataResidency: "any",
  },
  {
    id: "zhipu/glm-4.6", provider: "zhipu", model: "glm-4.6", deployment: "cloud",
    capabilities: ["code_edit", "structured_output", "tool_use"],
    strengths: ["cheap_bulk"],
    costTier: "low", latencyTier: "standard", contextWindow: 200_000,
    evidence: [vendorClaim(31, 200_000)], dataResidency: "any",
  },
  {
    id: "perplexity/sonar-pro", provider: "perplexity", model: "sonar-pro", deployment: "cloud",
    capabilities: ["research", "web_search"],
    strengths: ["citations", "web_search"],
    costTier: "medium", latencyTier: "fast", contextWindow: 200_000,
    evidence: [vendorClaim(32, 200_000)], dataResidency: "any",
  },
  {
    id: "groq/llama-3.3-70b-versatile", provider: "groq", model: "llama-3.3-70b-versatile", deployment: "cloud",
    capabilities: ["classification", "structured_output", "translation"],
    strengths: ["low_latency", "cheap_bulk"],
    costTier: "low", latencyTier: "realtime", contextWindow: 128_000,
    evidence: [vendorClaim(34, 128_000)], dataResidency: "any",
  },
  {
    id: "cerebras/llama-3.3-70b", provider: "cerebras", model: "llama-3.3-70b", deployment: "cloud",
    capabilities: ["classification", "structured_output"],
    strengths: ["low_latency", "cheap_bulk"],
    costTier: "low", latencyTier: "realtime", contextWindow: 128_000,
    evidence: [vendorClaim(35, 128_000)], dataResidency: "any",
  },
  {
    id: "openrouter/anthropic/claude-sonnet-4.6", provider: "openrouter", model: "anthropic/claude-sonnet-4.6", deployment: "aggregator",
    capabilities: ["code_edit", "code_review", "tool_use", "structured_output"],
    strengths: ["refactoring", "code_review"],
    costTier: "medium", latencyTier: "standard", contextWindow: 200_000,
    evidence: [vendorClaim(37, 200_000)], dataResidency: "any",
    caveats: ["aggregator routing can change serving provider/region per request; unsuitable under a residency constraint"],
  },
  {
    id: "together/meta-llama/Llama-3.3-70B-Instruct-Turbo", provider: "together", model: "meta-llama/Llama-3.3-70B-Instruct-Turbo", deployment: "aggregator",
    capabilities: ["structured_output", "classification", "translation"],
    strengths: ["cheap_bulk", "fast_iteration"],
    costTier: "low", latencyTier: "fast", contextWindow: 128_000,
    evidence: [vendorClaim(38, 128_000)], dataResidency: "any",
    caveats: ["aggregator routing can change serving provider/region per request; unsuitable under a residency constraint"],
  },
  {
    id: "fireworks/llama-v3p3-70b-instruct", provider: "fireworks", model: "llama-v3p3-70b-instruct", deployment: "aggregator",
    capabilities: ["structured_output", "classification"],
    strengths: ["cheap_bulk", "fast_iteration"],
    costTier: "low", latencyTier: "fast", contextWindow: 128_000,
    evidence: [vendorClaim(39, 128_000)], dataResidency: "any",
    caveats: ["aggregator routing can change serving provider/region per request; unsuitable under a residency constraint"],
  },
  {
    id: "lmstudio/local-model", provider: "lmstudio", model: "local-model", deployment: "local",
    capabilities: ["structured_output", "air_gapped", "local_execution"],
    strengths: ["air_gapped_deployment", "zero_egress"],
    costTier: "free", latencyTier: "standard", contextWindow: 32_000,
    evidence: [vendorClaim(41, 32_000)], dataResidency: "on_premise",
    caveats: [SERVED_MODEL_CAVEAT],
  },
  {
    id: "vllm/served-model", provider: "vllm", model: "served-model", deployment: "local",
    capabilities: ["code_edit", "structured_output", "tool_use", "air_gapped", "local_execution"],
    strengths: ["air_gapped_deployment", "zero_egress", "cheap_bulk"],
    costTier: "free", latencyTier: "fast", contextWindow: 128_000,
    evidence: [vendorClaim(42, 128_000)], dataResidency: "on_premise",
    caveats: [SERVED_MODEL_CAVEAT],
  },
  {
    id: "sglang/served-model", provider: "sglang", model: "served-model", deployment: "local",
    capabilities: ["structured_output", "tool_use", "air_gapped", "local_execution"],
    strengths: ["air_gapped_deployment", "zero_egress", "low_latency"],
    costTier: "free", latencyTier: "fast", contextWindow: 128_000,
    evidence: [vendorClaim(43, 128_000)], dataResidency: "on_premise",
    caveats: [SERVED_MODEL_CAVEAT],
  },
];

export function findModelCard(id: string, cards: readonly ModelCard[] = MODEL_CARD_SEED): ModelCard | undefined {
  return cards.find((card) => card.id === id);
}

export function listModelCardsByCapability(capability: string, cards: readonly ModelCard[] = MODEL_CARD_SEED): readonly ModelCard[] {
  return cards.filter((card) => !card.retired && card.capabilities.includes(capability));
}

/** Bounded Levenshtein: returns `limit + 1` as soon as no alignment can fit. */
function editDistance(left: string, right: string, limit: number): number {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = Array.from({ length: right.length + 1 }, (_unused, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      const value = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost);
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > limit) return limit + 1;
    previous = current;
  }
  return previous[right.length]!;
}

/** Suggestions are capped so a typo never turns an escalation into a dump. */
const MAX_CAPABILITY_SUGGESTIONS = 3;
/** Levenshtein ceiling for "did you mean" — 3 covers plural/tense/one-typo slips. */
export const CAPABILITY_SUGGESTION_MAX_DISTANCE = 3;

/**
 * Nearest known capabilities to an unrecognized token: edit distance <= 3, or a
 * substring relation either way (`edit` → `code_edit`).
 *
 * Fail-closed stays fail-closed — this only enriches the escalation DETAIL a
 * human reads, never the gate that produced it. Ordering is distance then
 * alphabetical, so the same board always escalates with the same bytes.
 */
export function suggestCapabilityMatches(
  unknown: string,
  known: Iterable<string>,
  limit = MAX_CAPABILITY_SUGGESTIONS,
): readonly string[] {
  const needle = unknown.toLowerCase();
  const scored: Array<{ readonly value: string; readonly distance: number }> = [];
  for (const candidate of new Set(known)) {
    if (candidate === unknown) continue;
    const value = candidate.toLowerCase();
    const distance = editDistance(needle, value, CAPABILITY_SUGGESTION_MAX_DISTANCE);
    const related = value.includes(needle) || needle.includes(value);
    if (distance <= CAPABILITY_SUGGESTION_MAX_DISTANCE) scored.push({ value: candidate, distance });
    else if (related) scored.push({ value: candidate, distance: CAPABILITY_SUGGESTION_MAX_DISTANCE + 1 });
  }
  return scored
    .sort((a, b) => a.distance - b.distance || compareStrings(a.value, b.value))
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.value);
}

/**
 * "no card qualified" is usually a typo, not a missing model. Name the required
 * capabilities NO card declares at all, with their nearest known neighbours.
 */
function capabilitySuggestionHint(task: KanbanTask, cards: readonly ModelCard[]): string {
  const known = new Set<string>();
  for (const card of cards) for (const capability of card.capabilities) known.add(capability);
  const hints: string[] = [];
  for (const required of task.requiredCapabilities) {
    if (known.has(required)) continue;
    const suggestions = suggestCapabilityMatches(required, known);
    hints.push(suggestions.length
      ? `no card declares "${required}" — did you mean ${suggestions.join(", ")}?`
      : `no card declares "${required}"`);
  }
  return hints.length ? `; ${hints.join("; ")}` : "";
}

// ============================================================================
// 5. Deterministic, explainable selection
// ============================================================================

export type SelectionDimension = "strength" | "cost" | "latency" | "context" | "evidence";
export type SelectionGateId = "retired" | "capability" | "provider" | "residency" | "cost" | "latency" | "context" | "evidence" | "wip";

export const SELECTION_GATE_ORDER: readonly SelectionGateId[] = [
  "retired", "capability", "provider", "residency", "cost", "latency", "context", "evidence", "wip",
];

const SELECTION_DIMENSIONS: readonly SelectionDimension[] = ["context", "cost", "evidence", "latency", "strength"];

export const SELECTION_BASE_WEIGHTS: Readonly<Record<SelectionDimension, number>> = {
  strength: 35, evidence: 20, cost: 15, latency: 15, context: 15,
};

/** Every row must sum to 100; the reducer re-checks the sum on every committed assignment. */
export const SELECTION_PRIORITY_WEIGHTS: Readonly<Record<KanbanPriority, Readonly<Record<SelectionDimension, number>>>> = {
  critical: { strength: 40, evidence: 25, cost: 5, latency: 20, context: 10 },
  high: { strength: 40, evidence: 20, cost: 10, latency: 15, context: 15 },
  normal: SELECTION_BASE_WEIGHTS,
  low: { strength: 25, evidence: 15, cost: 35, latency: 10, context: 15 },
};

export const COST_TIER_SCORE: Readonly<Record<CostTier, number>> = { free: 1000, low: 850, medium: 650, high: 400, premium: 200 };
export const LATENCY_TIER_SCORE: Readonly<Record<LatencyTier, number>> = { realtime: 1000, fast: 850, standard: 650, slow: 350 };
export const EVIDENCE_KIND_SCORE: Readonly<Record<ModelEvidenceKind, number>> = {
  live_probe: 1000, internal_eval: 1000, benchmark: 750, integration_test: 550, vendor_claim: 400,
};

/** Reserve ~20% of the window for output: a need only fits if window >= ceil(need * 1.25). */
export const CONTEXT_HEADROOM = 1.25;

const VERIFIED_EVIDENCE_KINDS = new Set<ModelEvidenceKind>(["live_probe", "internal_eval", "benchmark"]);

export interface SelectionPolicy {
  readonly weights?: Partial<Record<SelectionDimension, number>>;
  readonly maxCostTier?: CostTier;
  readonly maxLatencyTier?: LatencyTier;
  /** Present => deny-by-default. */
  readonly allowedProviders?: readonly string[];
  /** Denial always wins. */
  readonly deniedProviders?: readonly string[];
  readonly requiredDataResidency?: DataResidency;
  readonly requireVerifiedEvidence?: boolean;
  readonly estimatedContextTokens?: number;
  /** Runtime capacity; deliberately excluded from policyDigest. */
  readonly modelLoad?: ReadonlyMap<string, number>;
  /** Per-model WIP overrides (runtime capacity, excluded from policyDigest); wins over the card's own cap. */
  readonly wipPerModel?: ReadonlyMap<string, number>;
  readonly defaultWipPerModel?: number;
}

export interface SelectionGate {
  readonly id: SelectionGateId;
  readonly status: "passed" | "blocked";
  readonly summary: string;
}

export interface SelectionScoreBreakdown {
  readonly dimension: SelectionDimension;
  readonly raw: number;
  readonly weight: number;
  readonly weighted: number;
  readonly reason: string;
}

export interface SelectionCandidate {
  readonly cardId: string;
  readonly qualified: boolean;
  readonly gates: readonly SelectionGate[];
  readonly blockedBy?: SelectionGateId;
  readonly total: number;
  readonly breakdown: readonly SelectionScoreBreakdown[];
}

export type SelectionTieBreak = "score" | "evidence" | "context_window" | "card_id";

export type ModelSelection =
  | {
      readonly outcome: "selected";
      readonly cardId: string;
      readonly total: number;
      readonly breakdown: readonly SelectionScoreBreakdown[];
      readonly runnerUpCardId?: string;
      readonly margin: number;
      readonly tieBreak: SelectionTieBreak;
      readonly candidates: readonly SelectionCandidate[];
      readonly policyDigest: string;
      readonly rationale: string;
    }
  | {
      readonly outcome: "needs_intervention";
      readonly reason: KanbanEscalationReason;
      readonly detail: string;
      readonly candidates: readonly SelectionCandidate[];
      readonly policyDigest: string;
      readonly rationale: string;
    };

/**
 * Merge priority weights with the policy override and rescale to exactly 100 by largest remainder.
 * The sum is an audit invariant (`total === Σ weighted` over weights summing to 100), so an operator
 * override that does not sum to 100 is normalized rather than silently breaking every assignment.
 */
function resolveWeights(priority: KanbanPriority, override?: Partial<Record<SelectionDimension, number>>): Record<SelectionDimension, number> {
  const base = SELECTION_PRIORITY_WEIGHTS[priority];
  const merged = SELECTION_DIMENSIONS.map((dimension) => {
    const candidate = override?.[dimension];
    const value = typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 ? candidate : base[dimension];
    return { dimension, value };
  });
  const sum = merged.reduce((accumulator, entry) => accumulator + entry.value, 0);
  const weights = {} as Record<SelectionDimension, number>;
  if (sum <= 0) return { ...base };
  if (sum === 100 && merged.every((entry) => Number.isInteger(entry.value))) {
    for (const entry of merged) weights[entry.dimension] = entry.value;
    return weights;
  }
  const shares = merged.map((entry) => {
    const exact = (entry.value * 100) / sum;
    const floor = Math.floor(exact);
    return { dimension: entry.dimension, allocated: floor, remainder: exact - floor };
  });
  let remaining = 100 - shares.reduce((accumulator, entry) => accumulator + entry.allocated, 0);
  for (const entry of [...shares].sort((a, b) => b.remainder - a.remainder || compareStrings(a.dimension, b.dimension))) {
    if (remaining <= 0) break;
    entry.allocated += 1;
    remaining -= 1;
  }
  for (const entry of shares) weights[entry.dimension] = entry.allocated;
  return weights;
}

/** Bands, not a curve, so an auditor can read "headroom band 4x" instead of trusting a formula. */
function contextScoreLadder(contextWindow: number, needTokens: number): { raw: number; reason: string } {
  if (needTokens <= 0) return { raw: 800, reason: "no context estimate declared (neutral band)" };
  const ratio = contextWindow / needTokens;
  const band = ratio >= 8 ? 8 : ratio >= 4 ? 4 : ratio >= 2 ? 2 : ratio >= 1.5 ? 1.5 : 1.25;
  const raw = ratio >= 8 ? 1000 : ratio >= 4 ? 900 : ratio >= 2 ? 800 : ratio >= 1.5 ? 700 : 600;
  return { raw, reason: `headroom band ${band}x (${contextWindow} window vs ${needTokens} needed)` };
}

function evidenceScore(card: ModelCard): { raw: number; reason: string } {
  let best = 0;
  let kind: ModelEvidenceKind | undefined;
  for (const entry of card.evidence) {
    const score = EVIDENCE_KIND_SCORE[entry.kind] ?? 0;
    if (score > best) { best = score; kind = entry.kind; }
  }
  return { raw: best, reason: kind ? `strongest evidence is ${kind} (${card.evidence.length} entries)` : "no evidence cited" };
}

function strengthScore(task: KanbanTask, card: ModelCard): { raw: number; reason: string } {
  const preferred = task.preferredStrengths ?? [];
  if (preferred.length === 0) return { raw: 500, reason: "no preferred strengths declared (neutral)" };
  const matched = preferred.filter((strength) => card.strengths.includes(strength));
  return {
    raw: Math.round((1000 * matched.length) / preferred.length),
    reason: `matched ${matched.length}/${preferred.length} preferred strengths [${matched.join(", ")}]`,
  };
}

interface EffectivePolicy {
  readonly weights: Record<SelectionDimension, number>;
  readonly maxCostTier?: CostTier;
  readonly maxLatencyTier?: LatencyTier;
  readonly allowedProviders?: readonly string[];
  readonly deniedProviders?: readonly string[];
  readonly requiredDataResidency?: DataResidency;
  readonly requireVerifiedEvidence?: boolean;
  readonly needTokens: number;
}

function evaluateCard(task: KanbanTask, card: ModelCard, effective: EffectivePolicy, policy: SelectionPolicy | undefined): SelectionCandidate {
  const gates: SelectionGate[] = [];
  const push = (id: SelectionGateId, ok: boolean, summary: string): void => {
    gates.push({ id, status: ok ? "passed" : "blocked", summary });
  };

  push("retired", card.retired !== true, card.retired === true ? "card is retired" : "card is active");

  const missing = task.requiredCapabilities.filter((capability) => !card.capabilities.includes(capability));
  push("capability", missing.length === 0, missing.length === 0
    ? `covers all ${task.requiredCapabilities.length} required capabilities`
    : `missing capabilities [${missing.join(", ")}]`);

  const denied = effective.deniedProviders?.includes(card.provider) === true;
  const allowed = effective.allowedProviders === undefined || effective.allowedProviders.includes(card.provider);
  push("provider", !denied && allowed, denied
    ? `provider "${card.provider}" is denied`
    : allowed ? `provider "${card.provider}" is permitted` : `provider "${card.provider}" is not on the allowlist`);

  const required = effective.requiredDataResidency;
  const residencyOk = required === undefined || required === "any" || card.dataResidency === required;
  push("residency", residencyOk, residencyOk
    ? `residency ${card.dataResidency ?? "unstated"} satisfies ${required ?? "no requirement"}`
    : `residency ${card.dataResidency ?? "unstated"} does not satisfy ${required}`);

  const costOk = effective.maxCostTier === undefined || COST_TIERS.indexOf(card.costTier) <= COST_TIERS.indexOf(effective.maxCostTier);
  push("cost", costOk, costOk ? `cost tier ${card.costTier} within ceiling` : `cost tier ${card.costTier} exceeds ceiling ${effective.maxCostTier}`);

  const latencyOk = effective.maxLatencyTier === undefined || LATENCY_TIERS.indexOf(card.latencyTier) <= LATENCY_TIERS.indexOf(effective.maxLatencyTier);
  push("latency", latencyOk, latencyOk ? `latency tier ${card.latencyTier} within ceiling` : `latency tier ${card.latencyTier} exceeds ceiling ${effective.maxLatencyTier}`);

  const requiredWindow = effective.needTokens > 0 ? Math.ceil(effective.needTokens * CONTEXT_HEADROOM) : 0;
  const contextOk = requiredWindow === 0 || card.contextWindow >= requiredWindow;
  push("context", contextOk, contextOk
    ? `window ${card.contextWindow} covers ${requiredWindow} (need ${effective.needTokens} x ${CONTEXT_HEADROOM})`
    : `window ${card.contextWindow} below ${requiredWindow} required (need ${effective.needTokens} x ${CONTEXT_HEADROOM})`);

  const hasEvidence = card.evidence.length > 0;
  const verifiedOk = effective.requireVerifiedEvidence !== true || card.evidence.some((entry) => VERIFIED_EVIDENCE_KINDS.has(entry.kind));
  push("evidence", hasEvidence && verifiedOk, !hasEvidence
    ? "card cites no evidence"
    : verifiedOk ? `${card.evidence.length} evidence entries cited` : "policy requires verified evidence; card cites vendor claims only");

  const load = policy?.modelLoad?.get(card.id) ?? 0;
  // Same precedence as the reducer's task_assigned check: board override > card cap > default.
  const wipLimit = policy?.modelLoad === undefined
    ? Number.POSITIVE_INFINITY
    : policy.wipPerModel?.get(card.id) ?? card.maxConcurrentTasks ?? policy.defaultWipPerModel ?? Number.POSITIVE_INFINITY;
  const wipOk = load < wipLimit;
  push("wip", wipOk, wipOk ? `load ${load}/${wipLimit === Number.POSITIVE_INFINITY ? "unbounded" : wipLimit}` : `model is at its WIP limit (${load}/${wipLimit})`);

  const ordered = SELECTION_GATE_ORDER.map((id) => gates.find((gate) => gate.id === id)!);
  const blocked = ordered.find((gate) => gate.status === "blocked");
  if (blocked) return { cardId: card.id, qualified: false, gates: ordered, blockedBy: blocked.id, total: 0, breakdown: [] };

  const raws: Record<SelectionDimension, { raw: number; reason: string }> = {
    context: contextScoreLadder(card.contextWindow, effective.needTokens),
    cost: { raw: COST_TIER_SCORE[card.costTier], reason: `cost tier ${card.costTier}` },
    evidence: evidenceScore(card),
    latency: { raw: LATENCY_TIER_SCORE[card.latencyTier], reason: `latency tier ${card.latencyTier}` },
    strength: strengthScore(task, card),
  };
  const breakdown: SelectionScoreBreakdown[] = SELECTION_DIMENSIONS.map((dimension) => {
    const weight = effective.weights[dimension];
    const { raw, reason } = raws[dimension];
    return { dimension, raw, weight, weighted: Math.round((raw * weight) / 100), reason };
  });
  const total = breakdown.reduce((accumulator, entry) => accumulator + entry.weighted, 0);
  return { cardId: card.id, qualified: true, gates: ordered, total, breakdown };
}

function candidateEvidenceRaw(candidate: SelectionCandidate): number {
  return candidate.breakdown.find((entry) => entry.dimension === "evidence")?.raw ?? 0;
}

type RationaleInput =
  | {
      readonly outcome: "selected";
      readonly cardId: string;
      readonly total: number;
      readonly breakdown: readonly SelectionScoreBreakdown[];
      readonly runnerUpCardId?: string;
      readonly margin: number;
      readonly tieBreak: SelectionTieBreak;
      readonly candidates: readonly SelectionCandidate[];
    }
  | {
      readonly outcome: "needs_intervention";
      readonly reason: KanbanEscalationReason;
      readonly detail: string;
      readonly candidates: readonly SelectionCandidate[];
    };

function renderRationale(input: RationaleInput): string {
  const lines: string[] = [];
  if (input.outcome === "selected") {
    lines.push(`selected ${input.cardId} (total ${input.total})`);
    for (const entry of input.breakdown) {
      lines.push(`  ${entry.dimension.padEnd(9)} ${String(entry.weighted).padStart(4)} = ${entry.raw} x ${entry.weight}% — ${entry.reason}`);
    }
    lines.push(input.runnerUpCardId
      ? `runner-up ${input.runnerUpCardId}; margin ${input.margin} decided by ${input.tieBreak}`
      : "no runner-up: exactly one card qualified");
  } else {
    lines.push(`no model selected (${input.reason}): ${input.detail}`);
  }
  const rejected = input.candidates.filter((candidate) => !candidate.qualified);
  if (rejected.length > 0) {
    lines.push("rejected:");
    for (const candidate of rejected) {
      const gate = candidate.gates.find((entry) => entry.id === candidate.blockedBy);
      lines.push(`  ${candidate.cardId} blocked at ${candidate.blockedBy}: ${gate?.summary ?? "unspecified"}`);
    }
  }
  return lines.join("\n");
}

export function renderSelectionRationale(selection: ModelSelection): string {
  return renderRationale(selection);
}

/**
 * Pure, deterministic and order-independent: reversing `cards` yields a byte-identical result.
 * Capability match is mandatory; with no qualified card the board escalates rather than guessing.
 */
export function selectModelForTask(task: KanbanTask, cards: readonly ModelCard[], policy?: SelectionPolicy): ModelSelection {
  const effective: EffectivePolicy = {
    weights: resolveWeights(task.priority, policy?.weights),
    maxCostTier: policy?.maxCostTier,
    maxLatencyTier: policy?.maxLatencyTier,
    allowedProviders: policy?.allowedProviders ? [...policy.allowedProviders].sort(compareStrings) : undefined,
    deniedProviders: policy?.deniedProviders ? [...policy.deniedProviders].sort(compareStrings) : undefined,
    requiredDataResidency: policy?.requiredDataResidency,
    requireVerifiedEvidence: policy?.requireVerifiedEvidence,
    needTokens: policy?.estimatedContextTokens ?? task.estimatedContextTokens ?? 0,
  };
  // Built field by field on purpose: `{ weights, ...policy }` would let policy.weights overwrite the
  // merged weights, and modelLoad (runtime capacity) must never enter the digest.
  const policyDigest = digest(effective);

  const evaluated = cards.map((card) => evaluateCard(task, card, effective, policy));
  const qualified = evaluated.filter((candidate) => candidate.qualified).sort((a, b) =>
    b.total - a.total ||
    candidateEvidenceRaw(b) - candidateEvidenceRaw(a) ||
    (findModelCard(b.cardId, cards)?.contextWindow ?? 0) - (findModelCard(a.cardId, cards)?.contextWindow ?? 0) ||
    compareStrings(a.cardId, b.cardId));
  const rejected = evaluated.filter((candidate) => !candidate.qualified).sort((a, b) => compareStrings(a.cardId, b.cardId));
  const candidates = [...qualified, ...rejected];

  if (qualified.length === 0) {
    // A card blocked only at "wip" passed every governance gate: that is transient capacity
    // saturation, not a capability gap, and must escalate under its own reason so an auditor
    // (and a retry loop) can tell the two apart.
    const wipBlocked = rejected.filter((candidate) => candidate.blockedBy === "wip").map((candidate) => candidate.cardId);
    const reason: KanbanEscalationReason = cards.length > 0 && wipBlocked.length > 0 ? "wip_exhausted" : "no_qualified_model";
    const detail = cards.length === 0
      ? "no model cards registered"
      : wipBlocked.length > 0
        ? `all otherwise-qualified cards are at WIP capacity [${wipBlocked.join(", ")}]`
        : `no card qualified for capabilities [${task.requiredCapabilities.join(", ")}]${capabilitySuggestionHint(task, cards)}`;
    const draft = { outcome: "needs_intervention" as const, reason, detail, candidates };
    return { ...draft, policyDigest, rationale: renderRationale(draft) };
  }

  const winner = qualified[0]!;
  const runnerUp = qualified[1];
  const tieBreak: SelectionTieBreak = !runnerUp || winner.total !== runnerUp.total
    ? "score"
    : candidateEvidenceRaw(winner) !== candidateEvidenceRaw(runnerUp)
      ? "evidence"
      : (findModelCard(winner.cardId, cards)?.contextWindow ?? 0) !== (findModelCard(runnerUp.cardId, cards)?.contextWindow ?? 0)
        ? "context_window"
        : "card_id";
  const draft = {
    outcome: "selected" as const,
    cardId: winner.cardId,
    total: winner.total,
    breakdown: winner.breakdown,
    runnerUpCardId: runnerUp?.cardId,
    margin: winner.total - (runnerUp?.total ?? 0),
    tieBreak,
    candidates,
  };
  return { ...draft, policyDigest, rationale: renderRationale(draft) };
}

// ============================================================================
// 6. Consultation seam (interface + deterministic stub only)
// ============================================================================

export interface ConsultationBrief {
  readonly taskId: string;
  readonly title: string;
  readonly goal: string;
  readonly requiredCapabilities: readonly string[];
  /** Bundle digest: raw context never crosses this seam. */
  readonly contextDigest?: string;
  readonly candidateCardIds: readonly string[];
}

export interface ConsultationAnswer {
  readonly cardId: string;
  /** No `text` field exists by design: answers can only ever enter the log as digests. */
  readonly answerDigest: string;
  readonly answerChars: number;
  readonly latencyMs: number;
  readonly costMicros?: number;
  readonly selfReportedConfidence?: number;
}

export interface ConsultationScore {
  readonly cardId: string;
  readonly score: number;
  readonly reason: string;
}

export interface ConsultationVerdict {
  readonly winnerCardId: string;
  readonly judgeKind: "deterministic" | "model_judge" | "human";
  readonly judgeCardId?: string;
  readonly scores: readonly ConsultationScore[];
  readonly rationale: string;
}

export interface ConsultInput {
  readonly brief: ConsultationBrief;
  readonly candidates: readonly ModelCard[];
  readonly signal?: AbortSignal;
}

export interface ConsultationResult {
  readonly strategyId: string;
  readonly brief: ConsultationBrief;
  readonly answers: readonly ConsultationAnswer[];
  readonly verdict: ConsultationVerdict;
}

export interface ConsultStrategy {
  readonly id: string;
  readonly maxCandidates: number;
  consult(input: ConsultInput): Promise<ConsultationResult>;
}

export interface ConsultationRecord {
  readonly id: string;
  readonly strategyId: string;
  readonly briefDigest: string;
  readonly answers: readonly ConsultationAnswer[];
  readonly verdict: ConsultationVerdict;
  readonly deterministicWinnerCardId: string;
  readonly overrodeDeterministic: boolean;
  readonly consultedAt: string;
}

function tokenize(text: string): readonly string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 0);
}

/** Offline stub: a pure `answer` fn, a token-overlap judge, injectable latency, no clock, no I/O. */
export function createDeterministicConsultStrategy(options: {
  readonly id?: string;
  readonly maxCandidates?: number;
  readonly answer: (brief: ConsultationBrief, card: ModelCard) => string;
  readonly latencyMs?: (card: ModelCard) => number;
}): ConsultStrategy {
  const id = options.id ?? "deterministic";
  const maxCandidates = options.maxCandidates ?? 3;
  return {
    id,
    maxCandidates,
    async consult(input: ConsultInput): Promise<ConsultationResult> {
      const candidates = input.candidates.slice(0, maxCandidates);
      const target = new Set(tokenize(`${input.brief.goal} ${input.brief.requiredCapabilities.join(" ")}`));
      const answers: ConsultationAnswer[] = [];
      const scores: ConsultationScore[] = [];
      let winner: { cardId: string; score: number; index: number } | undefined;
      for (const [index, card] of candidates.entries()) {
        const text = options.answer(input.brief, card);
        answers.push({
          cardId: card.id,
          answerDigest: digest(text),
          answerChars: text.length,
          latencyMs: options.latencyMs?.(card) ?? 0,
        });
        const matched = new Set(tokenize(text).filter((token) => target.has(token)));
        const score = matched.size;
        scores.push({ cardId: card.id, score, reason: `covered ${score}/${target.size} brief tokens` });
        const better = !winner || score > winner.score || (score === winner.score && index < winner.index);
        if (better) winner = { cardId: card.id, score, index };
      }
      if (!winner) throw new Error("Consultation requires at least one candidate.");
      return {
        strategyId: id,
        brief: input.brief,
        answers,
        verdict: {
          winnerCardId: winner.cardId,
          judgeKind: "deterministic",
          scores,
          rationale: `token-overlap judge selected ${winner.cardId} with ${winner.score} covered brief tokens`,
        },
      };
    },
  };
}

export type ConsultedSelection =
  | {
      readonly outcome: "selected";
      readonly cardId: string;
      readonly selection: Extract<ModelSelection, { outcome: "selected" }>;
      readonly consultation?: ConsultationRecord;
      readonly overrodeDeterministic: boolean;
    }
  | {
      readonly outcome: "needs_intervention";
      readonly reason: KanbanEscalationReason;
      readonly detail: string;
      readonly selection: ModelSelection;
      readonly consultation?: ConsultationRecord;
    };

/**
 * Gates first, consult second. Consultation may only REORDER the pre-gated qualified set; a judge
 * that names anything else is refused, and the reducer re-validates the winner independently.
 */
export async function assignWithConsultation(input: {
  readonly task: KanbanTask;
  readonly cards: readonly ModelCard[];
  readonly policy?: SelectionPolicy;
  readonly strategy?: ConsultStrategy;
  readonly consultationId: string;
  readonly now: string;
}): Promise<ConsultedSelection> {
  const selection = selectModelForTask(input.task, input.cards, input.policy);
  if (selection.outcome === "needs_intervention") {
    return { outcome: "needs_intervention", reason: selection.reason, detail: selection.detail, selection };
  }
  if (!input.strategy) return { outcome: "selected", cardId: selection.cardId, selection, overrodeDeterministic: false };

  const qualifiedIds = selection.candidates
    .filter((candidate) => candidate.qualified)
    .slice(0, input.strategy.maxCandidates)
    .map((candidate) => candidate.cardId);
  const brief: ConsultationBrief = {
    taskId: input.task.id,
    title: input.task.title,
    goal: input.task.goal,
    requiredCapabilities: input.task.requiredCapabilities,
    candidateCardIds: qualifiedIds,
  };
  const candidateCards = qualifiedIds.map((cardId) => findModelCard(cardId, input.cards)!).filter(Boolean);
  const result = await input.strategy.consult({ brief, candidates: candidateCards });
  const consultation: ConsultationRecord = {
    id: input.consultationId,
    strategyId: result.strategyId,
    briefDigest: digest(brief),
    answers: result.answers,
    verdict: result.verdict,
    deterministicWinnerCardId: selection.cardId,
    overrodeDeterministic: result.verdict.winnerCardId !== selection.cardId,
    consultedAt: input.now,
  };
  if (!qualifiedIds.includes(result.verdict.winnerCardId)) {
    return {
      outcome: "needs_intervention",
      reason: "consultation_unqualified",
      detail: `consultation named "${result.verdict.winnerCardId}", which is not in the gated candidate set [${qualifiedIds.join(", ")}]`,
      selection,
      consultation,
    };
  }
  return {
    outcome: "selected",
    cardId: result.verdict.winnerCardId,
    selection,
    consultation,
    overrodeDeterministic: consultation.overrodeDeterministic,
  };
}

// ============================================================================
// 7. Context assembly
// ============================================================================

export type ContextDenialReason = "out_of_scope" | "missing" | "budget_exhausted" | "resolver_error" | "resolver_denied";

export interface ContextRequest {
  readonly taskId: string;
  readonly agentId?: string;
  readonly purpose: string;
  /** Deny-by-default; id "*" wildcards within a scope kind. */
  readonly grantedScopes: readonly MemoryScope[];
  readonly tokenBudget: number;
  readonly assembledAt: string;
}

export interface ContextResolution {
  readonly outcome: "included" | "truncated" | "denied" | "missing";
  readonly reason: string;
  readonly text?: string;
  readonly estimatedTokens?: number;
  readonly digest?: string;
}

export interface ContextResolver {
  resolve(ref: ContextRef, request: ContextRequest): Promise<ContextResolution> | ContextResolution;
}

export interface ContextBundleItem {
  readonly refId: string;
  readonly kind: ContextRefKind;
  readonly uri: string;
  readonly scope: MemoryScope;
  readonly digest: string;
  readonly estimatedTokens: number;
  readonly truncated: boolean;
  readonly text: string;
}

export interface ContextDenial {
  readonly refId: string;
  readonly kind: ContextRefKind;
  readonly uri: string;
  readonly required: boolean;
  readonly reason: ContextDenialReason;
  readonly detail: string;
}

export interface ContextBundle {
  readonly taskId: string;
  readonly purpose: string;
  readonly assembledAt: string;
  /** Carries text: in-memory only, never logged. */
  readonly included: readonly ContextBundleItem[];
  readonly denied: readonly ContextDenial[];
  readonly estimatedTokens: number;
  readonly tokenBudget: number;
  readonly truncated: boolean;
  readonly satisfiesRequired: boolean;
  readonly digest: string;
}

/** Log-safe projection: digests only, never text. */
export interface ContextBundleReceipt {
  readonly taskId: string;
  readonly purpose: string;
  readonly assembledAt: string;
  readonly includedRefIds: readonly string[];
  readonly itemDigests: readonly string[];
  readonly denied: readonly ContextDenial[];
  readonly estimatedTokens: number;
  readonly tokenBudget: number;
  readonly truncated: boolean;
  readonly satisfiesRequired: boolean;
  readonly digest: string;
}

function scopeGranted(granted: readonly MemoryScope[], scope: MemoryScope): boolean {
  return granted.some((entry) => entry.kind === scope.kind && (entry.id === scope.id || entry.id === "*"));
}

export async function resolveContext(task: KanbanTask, resolver: ContextResolver, request: ContextRequest): Promise<ContextBundle> {
  const ordered = task.contextRefs
    .map((ref, index) => ({ ref, index }))
    .sort((a, b) => Number(b.ref.required === true) - Number(a.ref.required === true) || a.index - b.index)
    .map((entry) => entry.ref);

  const included: ContextBundleItem[] = [];
  const denied: ContextDenial[] = [];
  let used = 0;
  let truncated = false;

  for (const ref of ordered) {
    const required = ref.required === true;
    const deny = (reason: ContextDenialReason, detail: string): void => {
      denied.push({ refId: ref.id, kind: ref.kind, uri: ref.uri, required, reason, detail });
    };
    // Authority first: an out-of-scope ref must never reach the resolver, so the store never even
    // sees the request.
    if (!scopeGranted(request.grantedScopes, ref.scope)) {
      deny("out_of_scope", `scope ${ref.scope.kind}:${ref.scope.id} is not granted for this request`);
      continue;
    }
    let resolution: ContextResolution;
    try {
      resolution = await resolver.resolve(ref, request);
    } catch (error) {
      // Error names only: messages leak paths, ids and occasionally secrets.
      deny("resolver_error", error instanceof Error ? error.name : "Error");
      continue;
    }
    if (resolution.outcome === "denied") { deny("resolver_denied", resolution.reason); continue; }
    if (resolution.outcome === "missing") { deny("missing", resolution.reason); continue; }
    const text = resolution.text ?? "";
    // Never trust the resolver's arithmetic: a negative or NaN count would credit budget back
    // (or sail through comparisons) and poison every downstream context-window gate.
    const tokens = clampNonNegativeInt(resolution.estimatedTokens) ?? estimateContextTokens(text);
    if (used + tokens > request.tokenBudget) {
      // Never partially slice text here: a resolver that wants to truncate returns "truncated" with
      // its own text and count, which stays attributable.
      truncated = true;
      deny("budget_exhausted", `needs ${tokens} tokens; ${request.tokenBudget - used} of ${request.tokenBudget} remain`);
      continue;
    }
    used += tokens;
    if (resolution.outcome === "truncated") truncated = true;
    included.push({
      refId: ref.id,
      kind: ref.kind,
      uri: ref.uri,
      scope: ref.scope,
      digest: resolution.digest ?? digest(text),
      estimatedTokens: tokens,
      truncated: resolution.outcome === "truncated",
      text,
    });
  }

  return {
    taskId: task.id,
    purpose: request.purpose,
    assembledAt: request.assembledAt,
    included,
    denied,
    estimatedTokens: used,
    tokenBudget: request.tokenBudget,
    truncated,
    satisfiesRequired: !denied.some((entry) => entry.required),
    digest: digest({
      taskId: task.id,
      purpose: request.purpose,
      items: included.map((item) => ({
        refId: item.refId, kind: item.kind, uri: item.uri, scope: item.scope,
        digest: item.digest, estimatedTokens: item.estimatedTokens,
      })),
    }),
  };
}

export function toContextBundleReceipt(bundle: ContextBundle): ContextBundleReceipt {
  return {
    taskId: bundle.taskId,
    purpose: bundle.purpose,
    assembledAt: bundle.assembledAt,
    includedRefIds: bundle.included.map((item) => item.refId),
    itemDigests: bundle.included.map((item) => item.digest),
    denied: bundle.denied,
    estimatedTokens: bundle.estimatedTokens,
    tokenBudget: bundle.tokenBudget,
    truncated: bundle.truncated,
    satisfiesRequired: bundle.satisfiesRequired,
    digest: bundle.digest,
  };
}

export function renderContextBundle(bundle: ContextBundle | ContextBundleReceipt): string {
  const refIds = "included" in bundle ? bundle.included.map((item) => item.refId) : bundle.includedRefIds;
  const digests = "included" in bundle ? bundle.included.map((item) => item.digest) : bundle.itemDigests;
  const lines: string[] = [
    `context ${bundle.taskId} — ${bundle.purpose} @ ${bundle.assembledAt}`,
    `tokens ${bundle.estimatedTokens}/${bundle.tokenBudget}${bundle.truncated ? " (truncated)" : ""}  required ${bundle.satisfiesRequired ? "satisfied" : "UNSATISFIED"}`,
    `digest ${bundle.digest}`,
  ];
  for (const [index, refId] of refIds.entries()) lines.push(`  + ${refId.padEnd(24)} ${digests[index] ?? ""}`);
  for (const denial of bundle.denied) lines.push(`  - ${denial.refId.padEnd(24)} ${denial.reason}: ${denial.detail}`);
  return lines.join("\n");
}

// ============================================================================
// 8. Events and board state
// ============================================================================

export interface KanbanEventEnvelope {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly boardId: string;
  readonly tenantId: string;
  readonly siteId?: string;
  readonly sequence: number;
  readonly at: string;
  readonly actorId: string;
  /** Authority, not decoration: only a human may release a needs_intervention task. */
  readonly actorKind: KanbanActorKind;
  readonly summary: string;
  readonly evidenceIds?: readonly string[];
}

export interface WipLimits {
  readonly defaultPerModel: number;
  readonly defaultPerAgent: number;
  readonly perModel: ReadonlyMap<string, number>;
  readonly perAgent: ReadonlyMap<string, number>;
}

export interface KanbanAgent {
  readonly id: string;
  readonly allowedCardIds?: readonly string[];
  readonly maxConcurrentTasks?: number;
}

export type KanbanEscalationReason =
  | "no_qualified_model"
  | "no_available_agent"
  | "context_denied"
  | "dependency_cycle"
  | "wip_exhausted"
  | "consultation_unqualified"
  | "attempts_exhausted"
  | "operator_request";

export interface TaskAssignment {
  readonly cardId: string;
  readonly agentId: string;
  readonly assignedAt: string;
  readonly total: number;
  readonly breakdown: readonly SelectionScoreBreakdown[];
  readonly policyDigest: string;
  readonly rationale: string;
  readonly contextBundleDigest?: string;
  readonly consultationId?: string;
}

export type KanbanAttemptStatus = "running" | "completed" | "failed" | "cancelled";

/** One retained execution try. A retry appends a new record; it never rewrites this one. */
export interface KanbanAttemptState {
  readonly attemptId: string;
  readonly status: KanbanAttemptStatus;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly turnId?: string;
  readonly processId?: string;
  readonly costUsd?: number;
  readonly receiptHash?: string;
  readonly error?: string;
}

export type KanbanEventBody =
  | { readonly type: "board_opened"; readonly defaults: { readonly defaultWipPerModel: number; readonly defaultWipPerAgent: number; readonly policy?: SelectionPolicy } }
  | { readonly type: "model_card_registered"; readonly card: ModelCard }
  | { readonly type: "model_card_retired"; readonly cardId: string; readonly reason: string }
  | { readonly type: "wip_limit_set"; readonly scope: "model" | "agent" | "default_model" | "default_agent"; readonly targetId?: string; readonly limit: number }
  | { readonly type: "task_created"; readonly taskId: string; readonly task: KanbanTask }
  | { readonly type: "task_ready"; readonly taskId: string; readonly satisfiedDependencies: readonly string[] }
  | { readonly type: "task_blocked"; readonly taskId: string; readonly reason: string; readonly blockingTaskIds?: readonly string[] }
  | { readonly type: "context_bundle_attached"; readonly taskId: string; readonly bundle: ContextBundleReceipt }
  | { readonly type: "consultation_recorded"; readonly taskId: string; readonly consultation: ConsultationRecord }
  | { readonly type: "task_assigned"; readonly taskId: string; readonly assignment: TaskAssignment }
  | { readonly type: "task_unassigned"; readonly taskId: string; readonly reason: string }
  | { readonly type: "task_session_bound"; readonly taskId: string; readonly sessionId: string }
  | { readonly type: "task_attempt_started"; readonly taskId: string; readonly attemptId: string; readonly agentId: string; readonly turnId?: string; readonly processId?: string }
  | { readonly type: "task_attempt_completed"; readonly taskId: string; readonly attemptId: string; readonly turnId?: string; readonly processId?: string; readonly receiptHash?: string; readonly costUsd?: number }
  | { readonly type: "task_attempt_failed"; readonly taskId: string; readonly attemptId: string; readonly error: string; readonly turnId?: string; readonly processId?: string; readonly costUsd?: number }
  /** Legacy lifecycle fact retained so existing JSONL histories remain replayable. */
  | { readonly type: "task_started"; readonly taskId: string; readonly agentId: string; readonly attemptId: string }
  | { readonly type: "task_progress"; readonly taskId: string; readonly note: string; readonly percentComplete?: number }
  | { readonly type: "comment_recorded"; readonly taskId: string; readonly attemptId: string; readonly comment: string; readonly path?: string; readonly line?: number }
  | { readonly type: "approval_requested"; readonly taskId: string; readonly attemptId: string; readonly reviewerId: string }
  | { readonly type: "task_attempt_cancelled"; readonly taskId: string; readonly attemptId: string; readonly reason: string }
  | { readonly type: "task_submitted_for_review"; readonly taskId: string; readonly artifactDigests?: readonly string[] }
  | { readonly type: "task_review_rejected"; readonly taskId: string; readonly reviewerId: string; readonly reason: string }
  | { readonly type: "task_completed"; readonly taskId: string; readonly reviewerId: string; readonly receiptHash: string }
  | { readonly type: "task_escalated"; readonly taskId: string; readonly reason: KanbanEscalationReason; readonly detail: string }
  | { readonly type: "task_intervention_resolved"; readonly taskId: string; readonly resolution: "requeue" | "backlog" | "blocked"; readonly note: string };

export type KanbanEventType = KanbanEventBody["type"];
export type KanbanEvent = KanbanEventEnvelope & KanbanEventBody;

export interface KanbanTaskState {
  readonly task: KanbanTask;
  readonly status: KanbanStatus;
  readonly assignment?: TaskAssignment;
  readonly contextBundle?: ContextBundleReceipt;
  readonly consultationId?: string;
  readonly sessionId?: string;
  readonly currentAttemptId?: string;
  readonly attemptHistory: ReadonlyMap<string, KanbanAttemptState>;
  readonly attempts: number;
  readonly reviewRejections: number;
  readonly reason?: string;
  readonly lastEventSequence: number;
}

export interface KanbanBoardState {
  readonly boardId: string;
  readonly tenantId: string;
  readonly siteId?: string;
  readonly opened: boolean;
  readonly nextSequence: number;
  readonly lastEventAt?: string;
  readonly appliedEventIds: ReadonlySet<string>;
  readonly tasks: ReadonlyMap<string, KanbanTaskState>;
  readonly cards: ReadonlyMap<string, ModelCard>;
  readonly wipLimits: WipLimits;
  /** Derived by diffing status against KANBAN_CAPACITY_STATUSES, never from event type. */
  readonly loadByModel: ReadonlyMap<string, number>;
  readonly loadByAgent: ReadonlyMap<string, number>;
  readonly consultations: ReadonlyMap<string, ConsultationRecord>;
  readonly policy?: SelectionPolicy;
  readonly completedReceipts: ReadonlyMap<string, string>;
}

export class KanbanEventConflictError extends Error {
  constructor(message: string) { super(message); this.name = "KanbanEventConflictError"; }
}

/**
 * Persistent applied-id set. A naive `new Set(prior)` per event makes an N-event fold O(N^2) —
 * ~50M set inserts for a 10k-event history — which blows any replay latency budget. Instead each
 * derive shares the immutable `base` and copies only a small `recent` overlay; the overlay folds
 * into a fresh base every APPLIED_ID_CHUNK adds, so deriving stays amortized O(1) while prior
 * states remain untouched. Internals are plain enumerable fields on purpose: two boards fed the
 * same event sequence compare deep-equal, and iteration preserves insertion order across folds.
 */
const APPLIED_ID_CHUNK = 64;

class AppliedEventIds implements ReadonlySet<string> {
  private constructor(
    private readonly base: ReadonlySet<string>,
    private readonly recent: readonly string[],
  ) {}

  static empty(): AppliedEventIds {
    return new AppliedEventIds(new Set(), []);
  }

  /** Derive from any ReadonlySet (a caller-built state may carry a plain Set) plus one new id. */
  static derive(prior: ReadonlySet<string>, id: string): AppliedEventIds {
    if (prior instanceof AppliedEventIds) return prior.with(id);
    const flat = new Set(prior);
    flat.add(id);
    return new AppliedEventIds(flat, []);
  }

  /** Caller guarantees `id` is unseen: reduceKanbanEvent short-circuits duplicates before deriving. */
  private with(id: string): AppliedEventIds {
    if (this.recent.length + 1 < APPLIED_ID_CHUNK) return new AppliedEventIds(this.base, [...this.recent, id]);
    const flat = new Set(this.base);
    for (const known of this.recent) flat.add(known);
    flat.add(id);
    return new AppliedEventIds(flat, []);
  }

  get size(): number {
    return this.base.size + this.recent.length;
  }

  has(id: string): boolean {
    return this.base.has(id) || this.recent.includes(id);
  }

  /** Iteration is O(n) regardless; materializing keeps iterator types identical to the lib's Set. */
  private materialize(): Set<string> {
    const flat = new Set(this.base);
    for (const id of this.recent) flat.add(id);
    return flat;
  }

  [Symbol.iterator]() {
    return this.materialize()[Symbol.iterator]();
  }

  keys() {
    return this.materialize().keys();
  }

  values() {
    return this.materialize().values();
  }

  entries() {
    return this.materialize().entries();
  }

  forEach(callback: (value: string, key: string, set: ReadonlySet<string>) => void, thisArg?: unknown): void {
    for (const id of this.materialize()) callback.call(thisArg, id, id, this);
  }
}

const DEFAULT_WIP = 1;
const ACTOR_KINDS = new Set<KanbanActorKind>(["human", "agent", "system"]);
const ESCALATION_REASONS = new Set<KanbanEscalationReason>([
  "no_qualified_model", "no_available_agent", "context_denied", "dependency_cycle",
  "wip_exhausted", "consultation_unqualified", "attempts_exhausted", "operator_request",
]);

/** Extends run-events.ts:99 with the fields a kanban payload could plausibly smuggle. */
const FORBIDDEN_PAYLOAD_KEY = /^(?:password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|bearer|private[_-]?key|credential|chain[_-]?of[_-]?thought|reasoning[_-]?trace|thinking|scratchpad)$/i;
/** run-events.ts guards keys only; a value guard catches a credential pasted into a free-text field. */
const SECRET_VALUE_PATTERN = /(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
export const MAX_EVENT_STRING_CHARS = 4000;

function scanEvent(value: unknown, seen = new Set<object>()): "forbidden_key" | "secret_value" | "oversized_string" | undefined {
  if (typeof value === "string") {
    if (SECRET_VALUE_PATTERN.test(value)) return "secret_value";
    if (value.length > MAX_EVENT_STRING_CHARS) return "oversized_string";
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = scanEvent(item, seen);
      if (found) return found;
    }
    return undefined;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_PAYLOAD_KEY.test(key)) return "forbidden_key";
    const found = scanEvent(item, seen);
    if (found) return found;
  }
  return undefined;
}

function assertEnvelope(state: KanbanBoardState, event: KanbanEvent): void {
  if (event.schemaVersion !== 1) throw new KanbanEventConflictError("Unsupported event schema version.");
  if (!event.id || !event.actorId || !event.summary || !ACTOR_KINDS.has(event.actorKind) || Number.isNaN(Date.parse(event.at))
    || !Number.isInteger(event.sequence) || event.sequence < 1) {
    throw new KanbanEventConflictError("Invalid kanban event envelope.");
  }
  if (event.boardId !== state.boardId || event.tenantId !== state.tenantId || event.siteId !== state.siteId) {
    throw new KanbanEventConflictError("Event authority scope does not match the board.");
  }
  if (event.sequence !== state.nextSequence) throw new KanbanEventConflictError(`Expected sequence ${state.nextSequence}; received ${event.sequence}.`);
  if (state.lastEventAt && Date.parse(event.at) < Date.parse(state.lastEventAt)) throw new KanbanEventConflictError("Event timestamp moves backwards.");
  const finding = scanEvent(event);
  if (finding === "forbidden_key") throw new KanbanEventConflictError("Kanban event contains forbidden secret or hidden-reasoning fields.");
  if (finding === "secret_value") throw new KanbanEventConflictError("Kanban event contains a value matching a known credential pattern.");
  if (finding === "oversized_string") throw new KanbanEventConflictError(`Kanban event contains a string longer than ${MAX_EVENT_STRING_CHARS} characters.`);
  if (!state.opened && event.type !== "board_opened") throw new KanbanEventConflictError("Board is not open; board_opened must be the first event.");
}

export function createKanbanBoardState(identity: Pick<KanbanEventEnvelope, "boardId" | "tenantId" | "siteId">): KanbanBoardState {
  return {
    boardId: identity.boardId,
    tenantId: identity.tenantId,
    siteId: identity.siteId,
    opened: false,
    nextSequence: 1,
    appliedEventIds: AppliedEventIds.empty(),
    tasks: new Map(),
    cards: new Map(),
    wipLimits: { defaultPerModel: DEFAULT_WIP, defaultPerAgent: DEFAULT_WIP, perModel: new Map(), perAgent: new Map() },
    loadByModel: new Map(),
    loadByAgent: new Map(),
    consultations: new Map(),
    completedReceipts: new Map(),
  };
}

export function kanbanWipLimitFor(state: KanbanBoardState, scope: "model" | "agent", id: string): number {
  if (scope === "model") {
    return state.wipLimits.perModel.get(id) ?? state.cards.get(id)?.maxConcurrentTasks ?? state.wipLimits.defaultPerModel;
  }
  return state.wipLimits.perAgent.get(id) ?? state.wipLimits.defaultPerAgent;
}

function bump(map: Map<string, number>, key: string, delta: number): void {
  const next = (map.get(key) ?? 0) + delta;
  if (next <= 0) map.delete(key); else map.set(key, next);
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new KanbanEventConflictError(`${label} is required.`);
  return value;
}

/**
 * Apply one authoritative event. Duplicate transport delivery (same event id) is harmless and is
 * short-circuited before validation. Containers are copy-on-write — an event replaces only what it
 * changes and no returned container is ever mutated afterwards — so historical snapshots stay
 * immutable without an O(board) copy per event.
 */
export function reduceKanbanEvent(state: KanbanBoardState, event: KanbanEvent): KanbanBoardState {
  if (state.appliedEventIds.has(event.id)) return state;
  assertEnvelope(state, event);

  const tasks = new Map(state.tasks);
  const cards = new Map(state.cards);
  const consultations = new Map(state.consultations);
  // Copied only in task_completed: an eager per-event copy of a 1000-receipt map is pure O(N^2) waste.
  let completedReceipts = state.completedReceipts;
  const loadByModel = new Map(state.loadByModel);
  const loadByAgent = new Map(state.loadByAgent);
  let wipLimits = state.wipLimits;
  let opened = state.opened;
  let policy = state.policy;

  const requireTask = (taskId: string): KanbanTaskState => {
    const entry = tasks.get(taskId);
    if (!entry) throw new KanbanEventConflictError(`Unknown task "${taskId}".`);
    if (entry.status === "done") throw new KanbanEventConflictError(`Task "${taskId}" is terminal (done).`);
    return entry;
  };

  const commit = (taskId: string, prior: KanbanTaskState, patch: Partial<KanbanTaskState>): KanbanTaskState => {
    const next: KanbanTaskState = { ...prior, ...patch, lastEventSequence: event.sequence };
    if (next.status !== prior.status && !isLegalKanbanTransition(prior.status, next.status)) {
      throw new KanbanEventConflictError(`Task "${taskId}" cannot move ${prior.status} -> ${next.status}.`);
    }
    tasks.set(taskId, next);
    // One capacity rule for the whole board: load is a function of status, so it cannot drift.
    const before = KANBAN_CAPACITY_STATUSES.has(prior.status) ? prior.assignment : undefined;
    const after = KANBAN_CAPACITY_STATUSES.has(next.status) ? next.assignment : undefined;
    if (before && (!after || after.cardId !== before.cardId)) bump(loadByModel, before.cardId, -1);
    if (before && (!after || after.agentId !== before.agentId)) bump(loadByAgent, before.agentId, -1);
    if (after && (!before || before.cardId !== after.cardId)) bump(loadByModel, after.cardId, 1);
    if (after && (!before || before.agentId !== after.agentId)) bump(loadByAgent, after.agentId, 1);
    return next;
  };

  switch (event.type) {
    case "board_opened": {
      if (opened) throw new KanbanEventConflictError("Board is already opened.");
      const perModel = clampNonNegativeInt(event.defaults.defaultWipPerModel);
      const perAgent = clampNonNegativeInt(event.defaults.defaultWipPerAgent);
      if (!perModel || !perAgent) throw new KanbanEventConflictError("board_opened requires positive default WIP limits.");
      wipLimits = { defaultPerModel: perModel, defaultPerAgent: perAgent, perModel: new Map(), perAgent: new Map() };
      policy = event.defaults.policy;
      opened = true;
      break;
    }
    case "model_card_registered": {
      const issues = validateModelCard(event.card);
      if (issues.length > 0) throw new KanbanEventConflictError(`Invalid model card: ${issues.join(" ")}`);
      // Re-registering a known id is a version update; the log keeps both revisions.
      cards.set(event.card.id, event.card);
      break;
    }
    case "model_card_retired": {
      const card = cards.get(event.cardId);
      if (!card) throw new KanbanEventConflictError(`Unknown model card "${event.cardId}".`);
      requireText(event.reason, "model_card_retired reason");
      // In-flight assignments are untouched: retirement affects future selection only.
      cards.set(card.id, { ...card, retired: true });
      break;
    }
    case "wip_limit_set": {
      const limit = clampNonNegativeInt(event.limit);
      if (limit === undefined) throw new KanbanEventConflictError("wip_limit_set requires a non-negative integer limit.");
      const perModel = new Map(wipLimits.perModel);
      const perAgent = new Map(wipLimits.perAgent);
      let defaultPerModel = wipLimits.defaultPerModel;
      let defaultPerAgent = wipLimits.defaultPerAgent;
      if (event.scope === "model" || event.scope === "agent") {
        const targetId = requireText(event.targetId, `wip_limit_set targetId for scope ${event.scope}`);
        if (event.scope === "model") perModel.set(targetId, limit); else perAgent.set(targetId, limit);
      } else if (event.scope === "default_model") defaultPerModel = limit;
      else defaultPerAgent = limit;
      wipLimits = { defaultPerModel, defaultPerAgent, perModel, perAgent };
      break;
    }
    case "task_created": {
      if (tasks.has(event.taskId)) throw new KanbanEventConflictError(`Task "${event.taskId}" already exists.`);
      const issues = validateKanbanTask(event.task);
      if (issues.length > 0) throw new KanbanEventConflictError(`Invalid task "${event.taskId}": ${issues.join(" ")}`);
      if (event.task.id !== event.taskId) throw new KanbanEventConflictError("task_created taskId must match the task body.");
      tasks.set(event.taskId, {
        task: event.task, status: "backlog", attemptHistory: new Map(), attempts: 0,
        reviewRejections: 0, lastEventSequence: event.sequence,
      });
      break;
    }
    case "task_ready": {
      const prior = requireTask(event.taskId);
      if (prior.status !== "backlog" && prior.status !== "blocked") {
        throw new KanbanEventConflictError(`Task "${event.taskId}" may only become ready from backlog or blocked (was ${prior.status}).`);
      }
      for (const declared of event.satisfiedDependencies) {
        if (!prior.task.dependsOn.includes(declared)) throw new KanbanEventConflictError(`Task "${event.taskId}" does not depend on "${declared}".`);
      }
      for (const dependency of prior.task.dependsOn) {
        const upstream = tasks.get(dependency);
        if (!upstream) throw new KanbanEventConflictError(`Task "${event.taskId}" depends on unknown task "${dependency}".`);
        if (upstream.status !== "done") throw new KanbanEventConflictError(`Task "${event.taskId}" is gated by "${dependency}" (${upstream.status}).`);
      }
      commit(event.taskId, prior, { status: "ready", reason: undefined });
      break;
    }
    case "task_blocked": {
      const prior = requireTask(event.taskId);
      commit(event.taskId, prior, { status: "blocked", reason: requireText(event.reason, "task_blocked reason") });
      break;
    }
    case "context_bundle_attached": {
      const prior = requireTask(event.taskId);
      const bundle = event.bundle;
      if (bundle.taskId !== event.taskId) throw new KanbanEventConflictError(`Context bundle names task "${bundle.taskId}", not "${event.taskId}".`);
      // A forged receipt with NaN/negative token counts or a truthy non-boolean satisfiesRequired
      // would bypass the window and required-context gates at task_assigned. Fail closed here.
      if (clampNonNegativeInt(bundle.estimatedTokens) === undefined || clampNonNegativeInt(bundle.tokenBudget) === undefined) {
        throw new KanbanEventConflictError(`Context bundle for "${event.taskId}" must carry non-negative integer token counts.`);
      }
      if (typeof bundle.satisfiesRequired !== "boolean" || typeof bundle.truncated !== "boolean") {
        throw new KanbanEventConflictError(`Context bundle for "${event.taskId}" must carry boolean satisfiesRequired and truncated flags.`);
      }
      requireText(bundle.digest, "context bundle digest");
      commit(event.taskId, prior, { contextBundle: bundle });
      break;
    }
    case "consultation_recorded": {
      const prior = requireTask(event.taskId);
      if (consultations.has(event.consultation.id)) throw new KanbanEventConflictError(`Consultation "${event.consultation.id}" already recorded.`);
      const winner = cards.get(event.consultation.verdict.winnerCardId);
      if (!winner || winner.retired === true) {
        throw new KanbanEventConflictError(`Consultation winner "${event.consultation.verdict.winnerCardId}" is not a registered, active card.`);
      }
      consultations.set(event.consultation.id, event.consultation);
      commit(event.taskId, prior, { consultationId: event.consultation.id });
      break;
    }
    case "task_assigned": {
      const prior = requireTask(event.taskId);
      if (prior.status !== "ready") throw new KanbanEventConflictError(`Task "${event.taskId}" must be ready to assign (was ${prior.status}).`);
      const assignment = event.assignment;
      requireText(assignment.agentId, "assignment agentId");
      requireText(assignment.policyDigest, "assignment policyDigest");
      // (a) the card must exist on this same log and still be active.
      const card = cards.get(assignment.cardId);
      if (!card) throw new KanbanEventConflictError(`Task "${event.taskId}" names unregistered card "${assignment.cardId}".`);
      if (card.retired === true) throw new KanbanEventConflictError(`Card "${card.id}" is retired and cannot take new work.`);
      // (b) the never-misassign gate: re-checked here so a buggy or forged planner cannot land it.
      const missing = prior.task.requiredCapabilities.filter((capability) => !card.capabilities.includes(capability));
      if (missing.length > 0) throw new KanbanEventConflictError(`Card "${card.id}" lacks required capabilities [${missing.join(", ")}] for task "${event.taskId}".`);
      // (c) declared context must actually have been assembled and satisfied.
      if (prior.task.contextRefs.length > 0) {
        const bundle = prior.contextBundle;
        if (!bundle) throw new KanbanEventConflictError(`Task "${event.taskId}" declares context refs but has no attached context bundle.`);
        if (!bundle.satisfiesRequired) throw new KanbanEventConflictError(`Task "${event.taskId}" has unsatisfied required context.`);
        if (assignment.contextBundleDigest !== bundle.digest) throw new KanbanEventConflictError(`Task "${event.taskId}" assignment cites a stale context bundle digest.`);
      }
      // (d) the context must fit with output headroom reserved.
      const needTokens = prior.contextBundle?.estimatedTokens ?? prior.task.estimatedContextTokens ?? 0;
      const requiredWindow = needTokens > 0 ? Math.ceil(needTokens * CONTEXT_HEADROOM) : 0;
      if (card.contextWindow < requiredWindow) {
        throw new KanbanEventConflictError(`Card "${card.id}" window ${card.contextWindow} is below the ${requiredWindow} required for task "${event.taskId}".`);
      }
      // (e) capacity.
      const modelLoad = loadByModel.get(card.id) ?? 0;
      const modelLimit = wipLimits.perModel.get(card.id) ?? card.maxConcurrentTasks ?? wipLimits.defaultPerModel;
      if (modelLoad >= modelLimit) throw new KanbanEventConflictError(`Card "${card.id}" is at its WIP limit (${modelLoad}/${modelLimit}).`);
      const agentLoad = loadByAgent.get(assignment.agentId) ?? 0;
      const agentLimit = wipLimits.perAgent.get(assignment.agentId) ?? wipLimits.defaultPerAgent;
      if (agentLoad >= agentLimit) throw new KanbanEventConflictError(`Agent "${assignment.agentId}" is at its WIP limit (${agentLoad}/${agentLimit}).`);
      // (f) the score must be arithmetically auditable, not decorative.
      if (assignment.breakdown.length === 0) throw new KanbanEventConflictError(`Task "${event.taskId}" assignment carries no score breakdown.`);
      const weightSum = assignment.breakdown.reduce((accumulator, entry) => accumulator + entry.weight, 0);
      if (weightSum !== 100) throw new KanbanEventConflictError(`Task "${event.taskId}" assignment weights sum to ${weightSum}, not 100.`);
      const weightedSum = assignment.breakdown.reduce((accumulator, entry) => accumulator + entry.weighted, 0);
      if (weightedSum !== assignment.total) throw new KanbanEventConflictError(`Task "${event.taskId}" assignment total ${assignment.total} does not equal its weighted sum ${weightedSum}.`);
      // (g) a cited consultation must exist on this log.
      if (assignment.consultationId !== undefined && !consultations.has(assignment.consultationId)) {
        throw new KanbanEventConflictError(`Task "${event.taskId}" cites unknown consultation "${assignment.consultationId}".`);
      }
      commit(event.taskId, prior, { status: "assigned", assignment, reason: undefined });
      break;
    }
    case "task_unassigned": {
      const prior = requireTask(event.taskId);
      if (prior.status !== "assigned") throw new KanbanEventConflictError(`Task "${event.taskId}" is not assigned (was ${prior.status}).`);
      commit(event.taskId, prior, { status: "ready", assignment: undefined, reason: requireText(event.reason, "task_unassigned reason") });
      break;
    }
    case "task_session_bound": {
      const prior = requireTask(event.taskId);
      const sessionId = requireText(event.sessionId, "task_session_bound sessionId");
      if (prior.sessionId !== undefined && prior.sessionId !== sessionId) {
        throw new KanbanEventConflictError(`Task "${event.taskId}" is already bound to session "${prior.sessionId}" and cannot be rebound to "${sessionId}".`);
      }
      commit(event.taskId, prior, { sessionId });
      break;
    }
    case "task_attempt_started": {
      const prior = requireTask(event.taskId);
      if (prior.status !== "assigned") throw new KanbanEventConflictError(`Task "${event.taskId}" must be assigned before an attempt starts (was ${prior.status}).`);
      if (!prior.sessionId) throw new KanbanEventConflictError(`Task "${event.taskId}" must bind a session before an attempt starts.`);
      if (!prior.assignment || prior.assignment.agentId !== event.agentId) {
        throw new KanbanEventConflictError(`Agent "${event.agentId}" does not own task "${event.taskId}".`);
      }
      const attemptId = requireText(event.attemptId, "task_attempt_started attemptId");
      if (event.turnId !== undefined) requireText(event.turnId, "task_attempt_started turnId");
      if (event.processId !== undefined) requireText(event.processId, "task_attempt_started processId");
      if (prior.attemptHistory.has(attemptId)) throw new KanbanEventConflictError(`Attempt "${attemptId}" already exists on task "${event.taskId}".`);
      const attempts = prior.attempts + 1;
      if (attempts > MAX_TASK_ATTEMPTS) throw new KanbanEventConflictError(`Task "${event.taskId}" exhausted ${MAX_TASK_ATTEMPTS} attempts; escalate instead of retrying.`);
      const attemptHistory = new Map(prior.attemptHistory);
      attemptHistory.set(attemptId, {
        attemptId,
        status: "running",
        startedAt: event.at,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        ...(event.processId ? { processId: event.processId } : {}),
      });
      commit(event.taskId, prior, { status: "in_progress", attemptHistory, currentAttemptId: attemptId, attempts, reason: undefined });
      break;
    }
    case "task_attempt_completed": {
      const prior = requireTask(event.taskId);
      if (prior.status !== "in_progress") throw new KanbanEventConflictError(`Task "${event.taskId}" must be in progress when an attempt completes (was ${prior.status}).`);
      const attempt = prior.attemptHistory.get(event.attemptId);
      if (!attempt || prior.currentAttemptId !== event.attemptId) throw new KanbanEventConflictError(`Attempt "${event.attemptId}" is not the current attempt on task "${event.taskId}".`);
      if (attempt.status !== "running") throw new KanbanEventConflictError(`Attempt "${event.attemptId}" is already ${attempt.status}.`);
      if (event.turnId !== undefined) requireText(event.turnId, "task_attempt_completed turnId");
      if (event.processId !== undefined) requireText(event.processId, "task_attempt_completed processId");
      if (event.receiptHash !== undefined) requireText(event.receiptHash, "task_attempt_completed receiptHash");
      if (attempt.turnId && event.turnId && attempt.turnId !== event.turnId) throw new KanbanEventConflictError(`Attempt "${event.attemptId}" has conflicting turn identity.`);
      if (attempt.processId && event.processId && attempt.processId !== event.processId) throw new KanbanEventConflictError(`Attempt "${event.attemptId}" has conflicting process identity.`);
      if (event.costUsd !== undefined && (!Number.isFinite(event.costUsd) || event.costUsd < 0)) throw new KanbanEventConflictError("task_attempt_completed costUsd must be non-negative and finite.");
      const attemptHistory = new Map(prior.attemptHistory);
      attemptHistory.set(event.attemptId, {
        ...attempt,
        status: "completed",
        finishedAt: event.at,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        ...(event.processId ? { processId: event.processId } : {}),
        ...(event.receiptHash ? { receiptHash: event.receiptHash } : {}),
        ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
      });
      commit(event.taskId, prior, { status: "review", attemptHistory, reason: undefined });
      break;
    }
    case "task_attempt_failed": {
      const prior = requireTask(event.taskId);
      if (prior.status !== "in_progress") throw new KanbanEventConflictError(`Task "${event.taskId}" must be in progress when an attempt fails (was ${prior.status}).`);
      const attempt = prior.attemptHistory.get(event.attemptId);
      if (!attempt || prior.currentAttemptId !== event.attemptId) throw new KanbanEventConflictError(`Attempt "${event.attemptId}" is not the current attempt on task "${event.taskId}".`);
      if (attempt.status !== "running") throw new KanbanEventConflictError(`Attempt "${event.attemptId}" is already ${attempt.status}.`);
      if (event.turnId !== undefined) requireText(event.turnId, "task_attempt_failed turnId");
      if (event.processId !== undefined) requireText(event.processId, "task_attempt_failed processId");
      if (attempt.turnId && event.turnId && attempt.turnId !== event.turnId) throw new KanbanEventConflictError(`Attempt "${event.attemptId}" has conflicting turn identity.`);
      if (attempt.processId && event.processId && attempt.processId !== event.processId) throw new KanbanEventConflictError(`Attempt "${event.attemptId}" has conflicting process identity.`);
      if (event.costUsd !== undefined && (!Number.isFinite(event.costUsd) || event.costUsd < 0)) throw new KanbanEventConflictError("task_attempt_failed costUsd must be non-negative and finite.");
      const error = requireText(event.error, "task_attempt_failed error");
      const attemptHistory = new Map(prior.attemptHistory);
      attemptHistory.set(event.attemptId, {
        ...attempt,
        status: "failed",
        finishedAt: event.at,
        error,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        ...(event.processId ? { processId: event.processId } : {}),
        ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
      });
      commit(event.taskId, prior, { status: "blocked", attemptHistory, reason: error });
      break;
    }
    case "task_attempt_cancelled": {
      const prior = requireTask(event.taskId);
      if (prior.status !== "in_progress") throw new KanbanEventConflictError(`Task "${event.taskId}" must be in progress when an attempt is cancelled (was ${prior.status}).`);
      const attempt = prior.attemptHistory.get(event.attemptId);
      if (!attempt || prior.currentAttemptId !== event.attemptId) throw new KanbanEventConflictError(`Attempt "${event.attemptId}" is not the current attempt on task "${event.taskId}".`);
      if (attempt.status !== "running") throw new KanbanEventConflictError(`Attempt "${event.attemptId}" is already ${attempt.status}.`);
      const reason = requireText(event.reason, "task_attempt_cancelled reason");
      const attemptHistory = new Map(prior.attemptHistory);
      attemptHistory.set(event.attemptId, { ...attempt, status: "cancelled", finishedAt: event.at, error: reason });
      commit(event.taskId, prior, { status: "blocked", attemptHistory, reason });
      break;
    }
    case "task_started": {
      const prior = requireTask(event.taskId);
      if (prior.status !== "assigned") throw new KanbanEventConflictError(`Task "${event.taskId}" must be assigned before it starts (was ${prior.status}).`);
      if (!prior.assignment || prior.assignment.agentId !== event.agentId) {
        throw new KanbanEventConflictError(`Agent "${event.agentId}" does not own task "${event.taskId}".`);
      }
      requireText(event.attemptId, "task_started attemptId");
      const attempts = prior.attempts + 1;
      if (attempts > MAX_TASK_ATTEMPTS) throw new KanbanEventConflictError(`Task "${event.taskId}" exhausted ${MAX_TASK_ATTEMPTS} attempts; escalate instead of retrying.`);
      // Old logs did not retain attempt records or session binding. Preserve
      // their exact transition while all new execution uses task_attempt_started.
      commit(event.taskId, prior, { status: "in_progress", attempts });
      break;
    }
    case "task_progress": {
      const prior = requireTask(event.taskId);
      if (prior.status !== "in_progress") throw new KanbanEventConflictError(`Progress requires an in-progress task "${event.taskId}".`);
      requireText(event.note, "task_progress note");
      // Number.isFinite, not typeof: NaN answers false to both < 0 and > 100.
      if (event.percentComplete !== undefined && (!Number.isFinite(event.percentComplete) || event.percentComplete < 0 || event.percentComplete > 100)) {
        throw new KanbanEventConflictError("task_progress percentComplete must be between 0 and 100.");
      }
      commit(event.taskId, prior, {});
      break;
    }
    case "comment_recorded": {
      const prior = requireTask(event.taskId);
      if (!prior.attemptHistory.has(requireText(event.attemptId, "comment_recorded attemptId"))) throw new KanbanEventConflictError(`Unknown attempt "${event.attemptId}" on task "${event.taskId}".`);
      requireText(event.comment, "comment_recorded comment");
      if (event.path !== undefined) requireText(event.path, "comment_recorded path");
      if (event.line !== undefined && (!Number.isInteger(event.line) || event.line < 1)) throw new KanbanEventConflictError("comment_recorded line must be a positive integer.");
      commit(event.taskId, prior, {});
      break;
    }
    case "approval_requested": {
      const prior = requireTask(event.taskId);
      if (prior.status !== "review") throw new KanbanEventConflictError(`Task "${event.taskId}" must be in review before approval is requested (was ${prior.status}).`);
      if (!prior.attemptHistory.has(requireText(event.attemptId, "approval_requested attemptId"))) throw new KanbanEventConflictError(`Unknown attempt "${event.attemptId}" on task "${event.taskId}".`);
      requireText(event.reviewerId, "approval_requested reviewerId");
      commit(event.taskId, prior, {});
      break;
    }
    case "task_submitted_for_review": {
      const prior = requireTask(event.taskId);
      if (prior.status !== "in_progress") throw new KanbanEventConflictError(`Task "${event.taskId}" must be in progress to submit for review (was ${prior.status}).`);
      commit(event.taskId, prior, { status: "review" });
      break;
    }
    case "task_review_rejected": {
      const prior = requireTask(event.taskId);
      if (prior.status !== "review") throw new KanbanEventConflictError(`Task "${event.taskId}" is not in review (was ${prior.status}).`);
      requireText(event.reviewerId, "task_review_rejected reviewerId");
      if (prior.assignment && event.reviewerId === prior.assignment.agentId) {
        throw new KanbanEventConflictError(`Reviewer "${event.reviewerId}" may not review their own work on task "${event.taskId}".`);
      }
      commit(event.taskId, prior, {
        status: "assigned",
        reviewRejections: prior.reviewRejections + 1,
        reason: requireText(event.reason, "task_review_rejected reason"),
      });
      break;
    }
    case "task_completed": {
      const prior = requireTask(event.taskId);
      if (prior.status !== "review") throw new KanbanEventConflictError(`Task "${event.taskId}" must pass review before completion (was ${prior.status}).`);
      requireText(event.receiptHash, "task_completed receiptHash");
      // An anonymous reviewer would make the maker-checker check below vacuously pass.
      requireText(event.reviewerId, "task_completed reviewerId");
      // Maker-checker: neither the reviewer nor the committing actor may be the worker.
      if (prior.assignment && (event.reviewerId === prior.assignment.agentId || event.actorId === prior.assignment.agentId)) {
        throw new KanbanEventConflictError(`Task "${event.taskId}" cannot be completed by its own worker.`);
      }
      const priorReceipt = completedReceipts.get(event.taskId);
      if (priorReceipt && priorReceipt !== event.receiptHash) throw new KanbanEventConflictError(`Task "${event.taskId}" has a conflicting completion receipt.`);
      const nextReceipts = new Map(completedReceipts);
      nextReceipts.set(event.taskId, event.receiptHash);
      completedReceipts = nextReceipts;
      commit(event.taskId, prior, { status: "done", reason: undefined });
      break;
    }
    case "task_escalated": {
      const prior = requireTask(event.taskId);
      if (!ESCALATION_REASONS.has(event.reason)) throw new KanbanEventConflictError(`Unknown escalation reason "${event.reason}".`);
      commit(event.taskId, prior, { status: "needs_intervention", reason: `${event.reason}: ${requireText(event.detail, "task_escalated detail")}` });
      break;
    }
    case "task_intervention_resolved": {
      const prior = requireTask(event.taskId);
      if (prior.status !== "needs_intervention") throw new KanbanEventConflictError(`Task "${event.taskId}" is not awaiting intervention (was ${prior.status}).`);
      // Authority, not decoration: an agent cannot clear its own escalation.
      if (event.actorKind !== "human") throw new KanbanEventConflictError("Only a human actor may resolve an intervention.");
      requireText(event.note, "task_intervention_resolved note");
      const status: KanbanStatus = event.resolution === "requeue" ? "ready" : event.resolution === "backlog" ? "backlog" : "blocked";
      if (status === "ready") {
        for (const dependency of prior.task.dependsOn) {
          const upstream = tasks.get(dependency);
          if (!upstream || upstream.status !== "done") throw new KanbanEventConflictError(`Task "${event.taskId}" cannot requeue while "${dependency}" is unfinished.`);
        }
      }
      commit(event.taskId, prior, { status, reason: event.note });
      break;
    }
  }

  const appliedEventIds = AppliedEventIds.derive(state.appliedEventIds, event.id);
  return {
    boardId: state.boardId,
    tenantId: state.tenantId,
    siteId: state.siteId,
    opened,
    nextSequence: state.nextSequence + 1,
    lastEventAt: event.at,
    appliedEventIds,
    tasks,
    cards,
    wipLimits,
    loadByModel,
    loadByAgent,
    consultations,
    policy,
    completedReceipts,
  };
}

export function replayKanbanEvents(initial: KanbanBoardState, events: readonly KanbanEvent[]): KanbanBoardState {
  return events.reduce(reduceKanbanEvent, initial);
}

export function nextKanbanEvent<B extends KanbanEventBody>(
  state: KanbanBoardState,
  envelope: Pick<KanbanEventEnvelope, "id" | "at" | "actorId" | "actorKind" | "summary"> & { readonly evidenceIds?: readonly string[] },
  body: B,
): KanbanEventEnvelope & B {
  return {
    schemaVersion: 1,
    boardId: state.boardId,
    tenantId: state.tenantId,
    ...(state.siteId !== undefined ? { siteId: state.siteId } : {}),
    sequence: state.nextSequence,
    ...envelope,
    ...body,
  } as KanbanEventEnvelope & B;
}

// ============================================================================
// 9. Facts-only board projection
// ============================================================================

export type BoardViewColumn = "backlog" | "ready" | "running" | "review" | "done";

export interface BoardViewCard {
  readonly taskId: string;
  readonly title: string;
  readonly currentAttempt?: string;
  readonly sessionId?: string;
  readonly modelId?: string;
  readonly score?: number;
  readonly status: KanbanStatus;
  readonly startedAt?: string;
  readonly lastEventAt: string;
  readonly costUsd?: number;
  readonly lastNarrationLine?: string;
}

export interface BoardView {
  readonly columns: Readonly<Record<BoardViewColumn, readonly string[]>>;
  readonly cards: Readonly<Record<string, BoardViewCard>>;
}

const BOARD_VIEW_EVENT_IDS = Symbol("board-view-event-ids");
type BoardViewWithIds = BoardView & { readonly [BOARD_VIEW_EVENT_IDS]?: ReadonlySet<string> };

function boardColumnForStatus(status: KanbanStatus): BoardViewColumn {
  if (status === "in_progress") return "running";
  if (status === "assigned") return "ready";
  if (status === "blocked" || status === "needs_intervention") return "backlog";
  return status;
}

function boardColumns(cards: Readonly<Record<string, BoardViewCard>>): BoardView["columns"] {
  const columns: Record<BoardViewColumn, string[]> = { backlog: [], ready: [], running: [], review: [], done: [] };
  for (const card of Object.values(cards)) columns[boardColumnForStatus(card.status)].push(card.taskId);
  return columns;
}

function withBoardEventIds(view: BoardView, ids: ReadonlySet<string>): BoardView {
  Object.defineProperty(view, BOARD_VIEW_EVENT_IDS, { value: ids, enumerable: false, configurable: false, writable: false });
  return view;
}

function updateProjectedCard(card: BoardViewCard, event: KanbanEvent): BoardViewCard {
  let patch: Partial<BoardViewCard> = {};
  switch (event.type) {
    case "task_ready": patch = { status: "ready" }; break;
    case "task_blocked": patch = { status: "blocked" }; break;
    case "task_escalated": patch = { status: "needs_intervention" }; break;
    case "task_intervention_resolved": patch = { status: event.resolution === "requeue" ? "ready" : event.resolution === "backlog" ? "backlog" : "blocked" }; break;
    case "task_assigned": patch = { status: "assigned", modelId: event.assignment.cardId, score: event.assignment.total }; break;
    case "task_unassigned": patch = { status: "ready", modelId: undefined, score: undefined }; break;
    case "task_session_bound": patch = { sessionId: event.sessionId }; break;
    case "task_attempt_started": patch = { status: "in_progress", currentAttempt: event.attemptId, startedAt: event.at }; break;
    case "task_attempt_completed": patch = { status: "review", costUsd: event.costUsd }; break;
    case "task_attempt_failed": patch = { status: "blocked", costUsd: event.costUsd }; break;
    case "task_attempt_cancelled": patch = { status: "blocked" }; break;
    case "task_started": patch = { status: "in_progress", currentAttempt: event.attemptId, startedAt: event.at }; break;
    case "task_progress": patch = { lastNarrationLine: event.note }; break;
    case "task_submitted_for_review": patch = { status: "review" }; break;
    case "task_review_rejected": patch = { status: "assigned" }; break;
    case "task_completed": patch = { status: "done" }; break;
    default: break;
  }
  return { ...card, ...patch, lastEventAt: event.at };
}

/** Apply one appended fact without consulting live board or provider state. */
export function applyEventToBoardView(view: BoardView, event: KanbanEvent): BoardView {
  const knownIds = (view as BoardViewWithIds)[BOARD_VIEW_EVENT_IDS] ?? new Set<string>();
  if (knownIds.has(event.id)) return view;
  const ids = new Set(knownIds);
  ids.add(event.id);
  const taskId = "taskId" in event && typeof event.taskId === "string" ? event.taskId : undefined;
  if (!taskId) return withBoardEventIds({ columns: view.columns, cards: view.cards }, ids);

  const cards: Record<string, BoardViewCard> = { ...view.cards };
  if (event.type === "task_created") {
    cards[taskId] = { taskId, title: event.task.title, status: "backlog", lastEventAt: event.at };
  } else if (cards[taskId]) {
    cards[taskId] = updateProjectedCard(cards[taskId], event);
  }
  return withBoardEventIds({ columns: boardColumns(cards), cards }, ids);
}

/** Fold the complete UI read model from persisted facts alone. */
export function projectBoardView(events: readonly KanbanEvent[]): BoardView {
  let view = withBoardEventIds({ columns: { backlog: [], ready: [], running: [], review: [], done: [] }, cards: {} }, new Set());
  for (const event of events) view = applyEventToBoardView(view, event);
  return view;
}

// ============================================================================
// 10. Gating, planning, snapshot
// ============================================================================

function compareTasks(a: KanbanTaskState, b: KanbanTaskState): number {
  return KANBAN_PRIORITY_RANK[a.task.priority] - KANBAN_PRIORITY_RANK[b.task.priority]
    || compareStrings(a.task.createdAt, b.task.createdAt)
    || compareStrings(a.task.id, b.task.id);
}

function sortedTasks(state: KanbanBoardState, statuses: readonly KanbanStatus[]): readonly KanbanTaskState[] {
  return [...state.tasks.values()].filter((entry) => statuses.includes(entry.status)).sort(compareTasks);
}

/** Advisory: which backlog/blocked tasks a `task_ready` event would now be accepted for. */
export function computeReadyTasks(state: KanbanBoardState): readonly string[] {
  return sortedTasks(state, ["backlog", "blocked"])
    .filter((entry) => entry.task.dependsOn.every((dependency) => state.tasks.get(dependency)?.status === "done"))
    .map((entry) => entry.task.id);
}

function normalizeCycle(path: readonly string[]): readonly string[] {
  let start = 0;
  for (let index = 1; index < path.length; index += 1) if (compareStrings(path[index]!, path[start]!) < 0) start = index;
  return [...path.slice(start), ...path.slice(0, start)];
}

/** Iterative DFS with deterministic id ordering: a starved cycle is reported, never silently stuck. */
export function findKanbanDependencyCycles(state: KanbanBoardState): readonly (readonly string[])[] {
  const ids = [...state.tasks.keys()].sort(compareStrings);
  const edges = new Map<string, readonly string[]>();
  for (const id of ids) {
    edges.set(id, [...(state.tasks.get(id)?.task.dependsOn ?? [])].filter((dependency) => state.tasks.has(dependency)).sort(compareStrings));
  }
  const color = new Map<string, 1 | 2>();
  const cycles: (readonly string[])[] = [];
  const seen = new Set<string>();
  for (const root of ids) {
    if (color.has(root)) continue;
    const frames: { id: string; index: number }[] = [{ id: root, index: 0 }];
    const path: string[] = [root];
    color.set(root, 1);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const children = edges.get(frame.id)!;
      if (frame.index < children.length) {
        const child = children[frame.index]!;
        frame.index += 1;
        const mark = color.get(child);
        if (mark === 1) {
          const cycle = normalizeCycle(path.slice(path.indexOf(child)));
          const key = cycle.join(">");
          if (!seen.has(key)) { seen.add(key); cycles.push(cycle); }
        } else if (mark === undefined) {
          color.set(child, 1);
          path.push(child);
          frames.push({ id: child, index: 0 });
        }
      } else {
        color.set(frame.id, 2);
        frames.pop();
        path.pop();
      }
    }
  }
  return cycles;
}

export interface KanbanAssignmentProposal {
  readonly taskId: string;
  readonly assignment: TaskAssignment;
  readonly selection: Extract<ModelSelection, { outcome: "selected" }>;
}

export interface KanbanEscalationProposal {
  readonly taskId: string;
  readonly reason: KanbanEscalationReason;
  readonly detail: string;
  readonly selection?: ModelSelection;
}

export interface KanbanAssignmentPlan {
  readonly proposals: readonly KanbanAssignmentProposal[];
  readonly escalations: readonly KanbanEscalationProposal[];
}

/**
 * Pure greedy planner: priority -> createdAt -> id, consuming WIP capacity within the plan itself so
 * two proposals can never oversubscribe the same model or agent. Proposals are suggestions; the
 * reducer re-validates every one of them.
 */
export function planKanbanAssignments(state: KanbanBoardState, options: {
  readonly agents: readonly KanbanAgent[];
  readonly now: string;
  readonly policy?: SelectionPolicy;
  readonly limit?: number;
}): KanbanAssignmentPlan {
  const proposals: KanbanAssignmentProposal[] = [];
  const escalations: KanbanEscalationProposal[] = [];
  const modelLoad = new Map(state.loadByModel);
  const agentLoad = new Map(state.loadByAgent);
  const cards = [...state.cards.values()];
  const agents = [...options.agents].sort((a, b) => compareStrings(a.id, b.id));
  const limit = options.limit ?? Number.POSITIVE_INFINITY;

  for (const entry of sortedTasks(state, ["ready"])) {
    if (proposals.length >= limit) break;
    const needTokens = entry.contextBundle?.estimatedTokens ?? entry.task.estimatedContextTokens;
    const policy: SelectionPolicy = {
      ...state.policy,
      ...options.policy,
      modelLoad,
      // Board overrides must reach the selection gate, or the planner proposes what the reducer refuses.
      wipPerModel: state.wipLimits.perModel,
      defaultWipPerModel: state.wipLimits.defaultPerModel,
      ...(needTokens !== undefined ? { estimatedContextTokens: needTokens } : {}),
    };
    const selection = selectModelForTask(entry.task, cards, policy);
    if (selection.outcome === "needs_intervention") {
      escalations.push({ taskId: entry.task.id, reason: selection.reason, detail: selection.detail, selection });
      continue;
    }
    const agent = agents
      .filter((candidate) => candidate.allowedCardIds === undefined || candidate.allowedCardIds.includes(selection.cardId))
      .map((candidate) => ({
        candidate,
        load: agentLoad.get(candidate.id) ?? 0,
        // min, not ??: the reducer enforces the board limit regardless of the agent's own cap, so
        // an agent declaring a higher cap must not tempt the planner past what the log will accept.
        limit: Math.min(candidate.maxConcurrentTasks ?? Number.POSITIVE_INFINITY, kanbanWipLimitFor(state, "agent", candidate.id)),
      }))
      .filter((candidate) => candidate.load < candidate.limit)
      .sort((a, b) => a.load - b.load || compareStrings(a.candidate.id, b.candidate.id))[0];
    if (!agent) {
      escalations.push({
        taskId: entry.task.id,
        reason: "no_available_agent",
        detail: `no agent may run "${selection.cardId}" within its WIP limit`,
        selection,
      });
      continue;
    }
    proposals.push({
      taskId: entry.task.id,
      selection,
      assignment: {
        cardId: selection.cardId,
        agentId: agent.candidate.id,
        assignedAt: options.now,
        total: selection.total,
        breakdown: selection.breakdown,
        policyDigest: selection.policyDigest,
        rationale: selection.rationale,
        ...(entry.contextBundle ? { contextBundleDigest: entry.contextBundle.digest } : {}),
        ...(entry.consultationId ? { consultationId: entry.consultationId } : {}),
      },
    });
    modelLoad.set(selection.cardId, (modelLoad.get(selection.cardId) ?? 0) + 1);
    agentLoad.set(agent.candidate.id, agent.load + 1);
  }
  return { proposals, escalations };
}

export interface KanbanTaskSummary {
  readonly id: string;
  readonly title: string;
  readonly priority: KanbanPriority;
  readonly status: KanbanStatus;
  readonly requiredCapabilities: readonly string[];
  readonly dependsOn: readonly string[];
  readonly blockedBy: readonly string[];
  readonly assignedCardId?: string;
  readonly assignedAgentId?: string;
  readonly assignmentTotal?: number;
  readonly contextBundleDigest?: string;
  readonly contextTokens?: number;
  readonly attempts: number;
  readonly reason?: string;
}

export interface KanbanBoardSnapshot {
  readonly schemaVersion: 1;
  readonly boardId: string;
  readonly tenantId: string;
  readonly siteId?: string;
  readonly atSequence: number;
  readonly atTime?: string;
  readonly columns: Readonly<Record<KanbanStatus, readonly KanbanTaskSummary[]>>;
  readonly counts: Readonly<Record<KanbanStatus, number>>;
  readonly wip: {
    readonly byModel: readonly { cardId: string; load: number; limit: number }[];
    readonly byAgent: readonly { agentId: string; load: number; limit: number }[];
  };
  readonly cards: readonly { cardId: string; provider: string; retired: boolean }[];
}

function summarize(state: KanbanBoardState, entry: KanbanTaskState): KanbanTaskSummary {
  const blockedBy = entry.task.dependsOn.filter((dependency) => state.tasks.get(dependency)?.status !== "done");
  return {
    id: entry.task.id,
    title: entry.task.title,
    priority: entry.task.priority,
    status: entry.status,
    requiredCapabilities: entry.task.requiredCapabilities,
    dependsOn: entry.task.dependsOn,
    blockedBy,
    ...(entry.assignment ? { assignedCardId: entry.assignment.cardId, assignedAgentId: entry.assignment.agentId, assignmentTotal: entry.assignment.total } : {}),
    ...(entry.contextBundle ? { contextBundleDigest: entry.contextBundle.digest, contextTokens: entry.contextBundle.estimatedTokens } : {}),
    attempts: entry.attempts,
    ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
  };
}

/** JSON-safe by construction: no Map, no Set, and no explicitly-undefined keys. */
export function snapshotKanbanBoard(state: KanbanBoardState): KanbanBoardSnapshot {
  const columns = {} as Record<KanbanStatus, readonly KanbanTaskSummary[]>;
  const counts = {} as Record<KanbanStatus, number>;
  for (const status of KANBAN_STATUSES) {
    const summaries = sortedTasks(state, [status]).map((entry) => summarize(state, entry));
    columns[status] = summaries;
    counts[status] = summaries.length;
  }
  const modelIds = [...new Set([...state.cards.keys(), ...state.loadByModel.keys()])].sort(compareStrings);
  const agentIds = [...new Set([...state.loadByAgent.keys(), ...state.wipLimits.perAgent.keys()])].sort(compareStrings);
  return {
    schemaVersion: 1,
    boardId: state.boardId,
    tenantId: state.tenantId,
    ...(state.siteId !== undefined ? { siteId: state.siteId } : {}),
    atSequence: state.nextSequence - 1,
    ...(state.lastEventAt !== undefined ? { atTime: state.lastEventAt } : {}),
    columns,
    counts,
    wip: {
      byModel: modelIds.map((cardId) => ({ cardId, load: state.loadByModel.get(cardId) ?? 0, limit: kanbanWipLimitFor(state, "model", cardId) })),
      byAgent: agentIds.map((agentId) => ({ agentId, load: state.loadByAgent.get(agentId) ?? 0, limit: kanbanWipLimitFor(state, "agent", agentId) })),
    },
    cards: [...state.cards.values()]
      .map((card) => ({ cardId: card.id, provider: card.provider, retired: card.retired === true }))
      .sort((a, b) => compareStrings(a.cardId, b.cardId)),
  };
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value + " ".repeat(width - value.length);
}

export function renderKanbanBoard(snapshot: KanbanBoardSnapshot): string {
  const lines: string[] = [
    `board ${snapshot.boardId}  tenant ${snapshot.tenantId}${snapshot.siteId ? `  site ${snapshot.siteId}` : ""}  @seq ${snapshot.atSequence}`,
    `${pad("status", 20)} ${pad("n", 3)} tasks`,
  ];
  lines.push("-".repeat(72));
  for (const status of KANBAN_STATUSES) {
    const summaries = snapshot.columns[status];
    const rendered = summaries.length === 0
      ? "-"
      : summaries.map((summary) => `${summary.id}${summary.assignedCardId ? `->${summary.assignedCardId}` : ""}`).join(", ");
    lines.push(`${pad(status, 20)} ${pad(String(snapshot.counts[status]), 3)} ${rendered}`);
  }
  lines.push("-".repeat(72));
  const wip = [
    ...snapshot.wip.byModel.filter((entry) => entry.load > 0).map((entry) => `model ${entry.cardId} ${entry.load}/${entry.limit}`),
    ...snapshot.wip.byAgent.filter((entry) => entry.load > 0).map((entry) => `agent ${entry.agentId} ${entry.load}/${entry.limit}`),
  ];
  lines.push(`WIP  ${wip.length > 0 ? wip.join("  |  ") : "idle"}`);
  return lines.join("\n");
}
