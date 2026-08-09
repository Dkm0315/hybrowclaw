import { randomUUID } from "node:crypto";
import type { MusterConfig, RunPlan, RunRequest, TaskKind } from "./types.js";

const CODING_HINTS = /\b(code|repo|bug|test|build|compile|patch|pr|commit|typescript|python|frappe|stack trace)\b/i;
const ARCH_HINTS = /(?:\b(?:architecture|system design|technical design|solution design|platform design|trade-?offs?|roadmap|prd|strategy)\b|\bimplementation plan\b|\bproject plan\b|\bdesign\s+(?:an?|the)\s+(?:system|architecture|platform|service|api)\b)/i;
const RESEARCH_HINTS = /\b(research|compare|latest|market|paper|trend|source|web)\b/i;
const ARTIFACT_HINTS = /\b(pdf|excel|ppt|presentation|artifact|report|docx|spreadsheet)\b/i;
const PRIVATE_HINTS = /\b(secret|credential|customer|bank|bfsi|nda|private|logs|production)\b/i;

export function classifyTask(prompt: string, explicit?: TaskKind): TaskKind {
  if (explicit) return explicit;
  if (ARTIFACT_HINTS.test(prompt)) return "artifact";
  if (CODING_HINTS.test(prompt)) return "coding";
  if (ARCH_HINTS.test(prompt)) return "architecture";
  if (RESEARCH_HINTS.test(prompt)) return "research";
  if (PRIVATE_HINTS.test(prompt)) return "private_analysis";
  return "simple_qa";
}

export function planRun(config: MusterConfig, request: RunRequest): RunPlan {
  const taskKind = classifyTask(request.prompt, request.taskKind);
  const sensitive = Boolean(request.sensitive) || PRIVATE_HINTS.test(request.prompt);
  const runtimeId = selectRuntime(config, request.runtime, sensitive);
  const runtime = config.runtimes[runtimeId];
  if (!runtime?.enabled) {
    throw new Error(`Runtime is not enabled or does not exist: ${runtimeId}`);
  }
  const provider = config.providers[runtime.provider];
  if (!provider) {
    throw new Error(`Runtime ${runtimeId} references missing provider: ${runtime.provider}`);
  }
  const route = runtime.routes[taskKind] ?? {
    provider: provider.id,
    model: provider.defaultModel,
    reasoning: taskKind === "simple_qa" ? "low" : "medium"
  };
  if (!config.providers[route.provider]) {
    throw new Error(`Runtime ${runtimeId} route for ${taskKind} references missing provider: ${route.provider}`);
  }
  return {
    runId: randomUUID(),
    taskKind,
    runtimeId,
    route,
    sensitive,
    createdAt: new Date().toISOString()
  };
}

function selectRuntime(config: MusterConfig, requested: string | undefined, sensitive: boolean): string {
  if (requested) return requested;
  if (sensitive && config.routing.preferLocalForSensitive) {
    const localRuntime = Object.values(config.runtimes).find((runtime) => {
      const provider = config.providers[runtime.provider];
      return runtime.enabled && provider?.kind === "openai-compatible" && provider.baseUrl?.includes("localhost");
    });
    if (localRuntime) return String(localRuntime.id);
  }
  return config.routing.defaultRuntime;
}
