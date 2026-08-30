import { readFile } from "node:fs/promises";
import { adjudicateFeedback } from "./feedback.js";
import { verifyIntegrity } from "./integrity.js";
import { addMemory, MemoryPolicyError, searchMemory } from "./memory.js";
import { executeRun, type RunOptions } from "./run.js";
import { appendFeedback } from "./store.js";
import { buildTokenRecord } from "./tokens.js";
import type { MusterConfig, TaskKind } from "./types.js";

export interface EvolveTask {
  readonly id: string;
  readonly prompt: string;
  readonly taskKind?: TaskKind;
  readonly expectedContains?: string[];
  /** At least one of these must appear (case-insensitive). Use for intent checks where correct behavior has many valid phrasings. */
  readonly expectedAnyOf?: string[];
  readonly forbiddenContains?: string[];
}

export interface EvolveTaskResult {
  readonly taskId: string;
  readonly runId?: string;
  readonly status: "passed" | "failed";
  readonly failureKind?: "run_failed" | "missing_expected" | "forbidden_content" | "empty_response";
  readonly detail?: string;
  readonly durationMs: number;
}

export interface EvolveIterationResult {
  readonly iteration: number;
  readonly results: EvolveTaskResult[];
  readonly passed: number;
  readonly failed: number;
}

export interface EvolveReport {
  readonly startedAt: string;
  readonly iterations: EvolveIterationResult[];
  readonly harnessChecks: HarnessCheckResult[];
  readonly converged: boolean;
}

export async function loadEvolveSuite(path: string): Promise<EvolveTask[]> {
  const raw = JSON.parse(await readFile(path, "utf8"));
  const tasks = Array.isArray(raw) ? raw : raw.tasks;
  if (!Array.isArray(tasks)) throw new Error("Evolve suite must be a JSON array of tasks or {tasks:[...]}.");
  return tasks as EvolveTask[];
}

function judgeResponse(task: EvolveTask, responseText: string): { status: "passed" | "failed"; failureKind?: EvolveTaskResult["failureKind"]; detail?: string } {
  if (!responseText.trim()) return { status: "failed", failureKind: "empty_response", detail: "Response was empty" };
  const lower = responseText.toLowerCase();
  for (const expected of task.expectedContains ?? []) {
    if (!lower.includes(expected.toLowerCase())) {
      return { status: "failed", failureKind: "missing_expected", detail: `Missing expected content: "${expected}"` };
    }
  }
  if (task.expectedAnyOf?.length && !task.expectedAnyOf.some((option) => lower.includes(option.toLowerCase()))) {
    return { status: "failed", failureKind: "missing_expected", detail: `Missing all acceptable phrasings: ${task.expectedAnyOf.join(" | ")}` };
  }
  for (const forbidden of task.forbiddenContains ?? []) {
    if (lower.includes(forbidden.toLowerCase())) {
      return { status: "failed", failureKind: "forbidden_content", detail: `Contains forbidden content: "${forbidden}"` };
    }
  }
  return { status: "passed" };
}

/**
 * The recursive self-test loop: runs every suite task through the real
 * harness, judges responses against expectations, records evidence-aware
 * feedback for each run, and repeats failed tasks up to maxIterations so
 * harness fixes between iterations can be verified to actually converge.
 */
export async function evolve(
  config: MusterConfig,
  tasks: EvolveTask[],
  options: Omit<RunOptions, "prompt"> & { maxIterations?: number } = {},
): Promise<EvolveReport> {
  const startedAt = new Date().toISOString();
  const maxIterations = options.maxIterations ?? 2;
  const iterations: EvolveIterationResult[] = [];
  let remaining = [...tasks];

  for (let iteration = 1; iteration <= maxIterations && remaining.length; iteration += 1) {
    const results: EvolveTaskResult[] = [];
    const stillFailing: EvolveTask[] = [];
    for (const task of remaining) {
      const started = Date.now();
      try {
        const outcome = await executeRun(config, { ...options, prompt: task.prompt, taskKind: task.taskKind, skipMemoryWrite: true });
        const judgement = outcome.episode.outcome?.kind === "completed"
          ? judgeResponse(task, outcome.episode.responseText)
          : { status: "failed" as const, failureKind: "run_failed" as const, detail: outcome.episode.outcome?.detail };
        const feedback = adjudicateFeedback({
          episodeId: outcome.episode.id,
          value: judgement.status === "passed" ? "useful" : "not_useful",
          reason: judgement.detail ?? (judgement.status === "passed" ? "evolve suite expectations met" : "evolve suite expectations missed"),
          correctAndWorked: judgement.status === "passed",
        }, outcome.episode);
        await appendFeedback(feedback, options.cwd);
        results.push({ taskId: task.id, runId: outcome.episode.id, status: judgement.status, failureKind: judgement.failureKind, detail: judgement.detail, durationMs: Date.now() - started });
        if (judgement.status === "failed") stillFailing.push(task);
      } catch (error) {
        results.push({ taskId: task.id, status: "failed", failureKind: "run_failed", detail: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started });
        stillFailing.push(task);
      }
    }
    iterations.push({
      iteration,
      results,
      passed: results.filter((result) => result.status === "passed").length,
      failed: results.filter((result) => result.status === "failed").length,
    });
    remaining = stillFailing;
  }

  return {
    startedAt,
    iterations,
    harnessChecks: await runHarnessChecks(options.cwd),
    converged: remaining.length === 0,
  };
}

export interface HarnessCheckResult {
  readonly id: string;
  readonly description: string;
  readonly status: "passed" | "failed";
  readonly detail?: string;
}

/**
 * Deterministic harness self-checks derived from documented failure modes of
 * other harnesses (OpenClaw #60719/#5429 compaction memory loss, #65646
 * silent model drift, #75235 transcript poisoning; Hermes #5563 replay
 * waste/state corruption). These run without any model call.
 */
export async function runHarnessChecks(cwd = process.cwd()): Promise<HarnessCheckResult[]> {
  const checks: HarnessCheckResult[] = [];

  // 1. Memory isolation: session/user-scoped memory must never appear in global search.
  try {
    const probe = await addMemory({
      kind: "isolation_probe",
      summary: `isolation probe ${Date.now()}`,
      provenance: ["harness_check"],
      scopes: [{ kind: "user", id: "harness-check-user" }, { kind: "session", id: "harness-check-session" }],
    }, cwd);
    const globalHits = await searchMemory({ query: "isolation probe", scopes: [{ kind: "global", id: "global" }] }, cwd);
    const leaked = globalHits.some((object) => object.id === probe.id);
    checks.push({
      id: "memory_isolation",
      description: "User/session-scoped memory is invisible to global-scope retrieval",
      status: leaked ? "failed" : "passed",
      detail: leaked ? "Scoped memory leaked into global search" : undefined,
    });
  } catch (error) {
    // A policy refusal is not an isolation defect: the check could not run
    // because config.memory.policy forbids the durable probe it needs. Still
    // reported as failed — an unverified guarantee is not a verified one — but
    // the detail must not claim scoped memory leaked.
    const detail = error instanceof MemoryPolicyError
      ? `check not run: the durable probe it needs was refused. ${error.message}`
      : String(error);
    checks.push({ id: "memory_isolation", description: "User/session-scoped memory is invisible to global-scope retrieval", status: "failed", detail });
  }

  // 2. Replay-waste detection: the token ledger must flag continuation bloat.
  const wasteRecord = buildTokenRecord({
    runId: "harness-check-waste",
    provider: "check",
    model: "check-model",
    prompt: "short",
    recalledContext: "",
    responseText: "ok",
    durationMs: 1,
    sessionMode: "continue",
    inputTokens: 100_000,
    outputTokens: 10,
  });
  checks.push({
    id: "replay_waste_detection",
    description: "Token ledger flags continued sessions with replay waste",
    status: wasteRecord.wasteRatio !== undefined ? "passed" : "failed",
  });

  // 3. Store integrity: no corrupt lines, duplicate run ids, or silent model drift.
  const integrity = await verifyIntegrity(cwd);
  checks.push({
    id: "store_integrity",
    description: "Episode/memory/token stores parse cleanly with no drift or poisoning",
    status: integrity.ok ? "passed" : "failed",
    detail: integrity.ok ? undefined : integrity.issues.map((issue) => `${issue.kind}: ${issue.detail}`).slice(0, 3).join("; "),
  });

  return checks;
}

export function renderEvolveReport(report: EvolveReport): string {
  const lines: string[] = [];
  for (const iteration of report.iterations) {
    lines.push(`iteration ${iteration.iteration}: ${iteration.passed} passed, ${iteration.failed} failed`);
    for (const result of iteration.results) {
      const marker = result.status === "passed" ? "PASS" : "FAIL";
      lines.push(`  [${marker}] ${result.taskId}${result.failureKind ? ` (${result.failureKind})` : ""}${result.detail ? ` - ${result.detail.slice(0, 120)}` : ""}`);
    }
  }
  lines.push("");
  lines.push("harness self-checks:");
  for (const check of report.harnessChecks) {
    lines.push(`  [${check.status === "passed" ? "PASS" : "FAIL"}] ${check.id}: ${check.description}${check.detail ? ` - ${check.detail}` : ""}`);
  }
  lines.push("");
  lines.push(report.converged ? "converged: all suite tasks pass." : "NOT converged: failing tasks remain. Fix the harness and re-run.");
  return lines.join("\n");
}
