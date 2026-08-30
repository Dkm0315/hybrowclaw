import { classifyTask } from "./router.js";
import type { MusterConfig, ReasoningLevel, TaskKind } from "./types.js";

/**
 * Reasoning economy.
 *
 * The user runs inside a 5-hour usage window, so a two-line chat turn must not
 * burn a high-reasoning budget. `classifyTask` already sends plain questions to
 * `simple_qa`, and the seeded native runtime maps `simple_qa -> low`
 * (`config.ts`). The HOLE is everything else: the seeded runtime declares routes
 * only for `simple_qa`, `research`, `architecture` and `private_analysis`, while
 * `CODING_HINTS` in `router.ts` matches words as common as "code", "test",
 * "build" and "bug". So "fix the failing test" classifies as `coding`, finds NO
 * route, and `planForManagedRuntime` leaves `reasoning` undefined — the model
 * default (medium/high), for a ten-second task.
 *
 * `run.ts` is out of bounds for this wave, and it does not need to change:
 * `executeRun(config, options)` takes the config BY VALUE, so the caller can
 * hand it a per-turn copy whose route for this task kind carries the economical
 * tier. Nothing is persisted — `saveConfig` is never called from here.
 *
 * Direction rule for `auto`: it may only LOWER the tier below what the config
 * (or the model default) would have spent. Raising spend always requires an
 * explicit `/reasoning high`.
 */

export type ReasoningTier = "low" | "medium" | "high";
/** `auto` = heuristic; anything else is a sticky per-chat override. */
export type ReasoningPreference = "auto" | ReasoningTier;

export interface ReasoningDecision {
  readonly taskKind: TaskKind;
  /** Tier actually applied to the run's route. */
  readonly tier: ReasoningTier;
  /** What the prompt heuristic asked for, before the never-raise clamp. */
  readonly heuristicTier: ReasoningTier;
  /** Tier the config (or the model default) would have used. */
  readonly baselineTier: ReasoningTier;
  readonly source: "override" | "heuristic" | "baseline";
  readonly reason: string;
}

const TIER_ORDER: readonly ReasoningTier[] = ["low", "medium", "high"];

/** Deep work: worth the tokens even when the prompt is short. */
const DEEP_VERBS = /\b(architect|architecture|design\s+(?:a|an|the)\s+\w+|root[- ]cause|rearchitect|refactor|migrate|migration|threat\s?model|security\s+review|prove|derive|optimi[sz]e|benchmark|trade[- ]?offs?|strategy|roadmap|rfc|spec\s+out|end[- ]to[- ]end|investigate|debug\s+why|why\s+does\s+.+\s+fail)\b/i;
/** Small work: a lookup, a rename, a one-liner, a "what is this" question. */
const SMALL_VERBS = /\b(what|where|when|who|which|list|show|print|display|rename|typo|format|lint|bump|tweak|comment|docstring|import|spelling|status|summari[sz]e briefly|remind|hi|hello|thanks|yes|no|ok)\b/i;
/** Words that mean "the model must hold a lot of state at once". */
const BREADTH_HINTS = /\b(across\s+(?:the\s+)?(?:repo|codebase|files|packages)|whole\s+(?:repo|codebase)|every\s+file|all\s+(?:the\s+)?(?:call\s?sites|packages|modules))\b/i;

const SMALL_PROMPT_CHARS = 160;
const SMALL_PROMPT_WORDS = 24;
const LARGE_PROMPT_CHARS = 900;
const LARGE_PROMPT_WORDS = 140;

/** Task kinds that are inherently deep, regardless of how tersely they are asked. */
const DEEP_TASK_KINDS: ReadonlySet<TaskKind> = new Set<TaskKind>(["architecture", "private_analysis"]);

export function parseReasoningPreference(value: string | undefined): ReasoningPreference | undefined {
  const text = value?.trim().toLowerCase();
  if (!text) return undefined;
  if (text === "auto") return "auto";
  if (text === "low" || text === "medium" || text === "high") return text;
  return undefined;
}

/**
 * Prompt-shape heuristic. Deliberately boring and testable: length classes plus
 * verb classes. It never inspects the workspace, so the same prompt always
 * produces the same tier and a `/reasoning` decision can be explained.
 */
export function classifyReasoningTier(prompt: string, taskKind: TaskKind): { tier: ReasoningTier; reason: string } {
  const text = prompt.trim();
  const words = text ? text.split(/\s+/).length : 0;
  if (DEEP_TASK_KINDS.has(taskKind)) return { tier: "high", reason: `${taskKind} task kind` };
  if (DEEP_VERBS.test(text)) return { tier: "high", reason: "deep-work verb in prompt" };
  if (BREADTH_HINTS.test(text)) return { tier: "high", reason: "repo-wide scope in prompt" };
  if (text.length >= LARGE_PROMPT_CHARS || words >= LARGE_PROMPT_WORDS) {
    return { tier: "high", reason: `long prompt (${words} words)` };
  }
  if (text.length <= SMALL_PROMPT_CHARS && words <= SMALL_PROMPT_WORDS) {
    const small = taskKind === "simple_qa" || SMALL_VERBS.test(text);
    return { tier: "low", reason: `short ${taskKind} turn (${words} words${small ? "" : ", no deep-work signal"})` };
  }
  return { tier: "medium", reason: `medium-length ${taskKind} turn (${words} words)` };
}

/**
 * Decide the tier for one turn. `baseline` is what would have been spent
 * without this module: the configured route's reasoning, else the model default
 * that `run.ts` falls back to when a route omits it.
 */
export function decideReasoning(options: {
  readonly prompt: string;
  readonly config?: MusterConfig;
  readonly runtimeId?: string;
  readonly taskKind?: TaskKind;
  readonly preference?: ReasoningPreference;
}): ReasoningDecision {
  const taskKind = classifyTask(options.prompt, options.taskKind);
  const baselineTier = configuredTier(options.config, options.runtimeId, taskKind) ?? "medium";
  const heuristic = classifyReasoningTier(options.prompt, taskKind);
  const preference = options.preference ?? "auto";
  if (preference !== "auto") {
    return {
      taskKind,
      tier: preference,
      heuristicTier: heuristic.tier,
      baselineTier,
      source: "override",
      reason: `/reasoning ${preference}`,
    };
  }
  // Never-raise clamp: auto is an economy control, not a quality dial.
  const tier = lowerTier(heuristic.tier, baselineTier);
  return {
    taskKind,
    tier,
    heuristicTier: heuristic.tier,
    baselineTier,
    source: tier === heuristic.tier ? "heuristic" : "baseline",
    reason: tier === heuristic.tier ? heuristic.reason : `${heuristic.reason}; capped at configured ${baselineTier}`,
  };
}

/**
 * Per-turn config copy carrying the decided tier on the route the run will pick.
 * Returns the ORIGINAL config object when nothing changes, so callers can pass
 * it straight through with no allocation on the common path.
 */
export function applyReasoningDecision(config: MusterConfig, decision: ReasoningDecision): MusterConfig {
  const runtimes = Object.fromEntries(
    Object.entries(config.runtimes).map(([runtimeId, runtime]) => {
      const existing = runtime.routes[decision.taskKind];
      const provider = config.providers[runtime.provider];
      // A runtime with no route for this task kind gets one, otherwise run.ts
      // falls through to the model default and the decision is silently lost.
      const route = existing
        ? { ...existing, reasoning: decision.tier as ReasoningLevel }
        : provider
          ? { provider: provider.id, model: provider.defaultModel, reasoning: decision.tier as ReasoningLevel }
          : undefined;
      if (!route) return [runtimeId, runtime];
      return [runtimeId, { ...runtime, routes: { ...runtime.routes, [decision.taskKind]: route } }];
    }),
  );
  return { ...config, runtimes };
}

/** One-shot helper for call sites: decide, then hand back the config to run with. */
export function withReasoningEconomy(config: MusterConfig, options: {
  readonly prompt: string;
  readonly runtimeId?: string;
  readonly taskKind?: TaskKind;
  readonly preference?: ReasoningPreference;
}): { readonly config: MusterConfig; readonly decision: ReasoningDecision } {
  const decision = decideReasoning({ ...options, config });
  return { config: applyReasoningDecision(config, decision), decision };
}

/** `low · short coding turn (6 words)` — the status-line fragment. */
export function formatReasoningDecision(decision: ReasoningDecision): string {
  return `${decision.tier} · ${decision.reason}`;
}

function configuredTier(config: MusterConfig | undefined, runtimeId: string | undefined, taskKind: TaskKind): ReasoningTier | undefined {
  if (!config) return undefined;
  const runtimes = [
    runtimeId ? config.runtimes[runtimeId] : undefined,
    config.runtimes[config.routing.defaultRuntime],
    ...Object.values(config.runtimes),
  ];
  for (const runtime of runtimes) {
    const reasoning = runtime?.routes[taskKind]?.reasoning;
    if (reasoning === "low" || reasoning === "medium" || reasoning === "high") return reasoning;
  }
  return undefined;
}

function lowerTier(left: ReasoningTier, right: ReasoningTier): ReasoningTier {
  return TIER_ORDER.indexOf(left) <= TIER_ORDER.indexOf(right) ? left : right;
}
