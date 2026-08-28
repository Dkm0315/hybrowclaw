import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyReasoningDecision,
  classifyReasoningTier,
  decideReasoning,
  formatReasoningDecision,
  parseReasoningPreference,
  withReasoningEconomy,
} from "../src/reasoning-economy.js";
import { classifyTask } from "../src/router.js";
import type { MusterConfig, TaskKind } from "../src/types.js";

function testConfig(routes: MusterConfig["runtimes"][string]["routes"]): MusterConfig {
  return {
    version: 1,
    profile: "default",
    providers: {
      codex: { id: "codex", kind: "codex-cli", defaultModel: "gpt-5.5" },
    },
    runtimes: {
      native: { id: "native", enabled: true, provider: "codex", routes },
    },
    routing: {
      oneRuntimePerRun: true,
      defaultRuntime: "native",
      preferLocalForSensitive: false,
    },
  } as unknown as MusterConfig;
}

const SEEDED_ROUTES = {
  simple_qa: { provider: "codex", model: "gpt-5.5", reasoning: "low" as const },
  research: { provider: "codex", model: "gpt-5.5", reasoning: "medium" as const },
  architecture: { provider: "codex", model: "gpt-5.5", reasoning: "high" as const },
};

test("heuristic matrix: prompt length and verb class decide the tier", () => {
  const cases: { prompt: string; tier: "low" | "medium" | "high" }[] = [
    { prompt: "hi", tier: "low" },
    { prompt: "what does this repo do?", tier: "low" },
    { prompt: "rename the getUser helper to loadUser", tier: "low" },
    { prompt: "fix the failing test in tokens.test.ts", tier: "low" },
    { prompt: "add a docstring to classifyTask", tier: "low" },
    { prompt: "architect the multi-tenant billing system", tier: "high" },
    { prompt: "root-cause the intermittent gateway timeout", tier: "high" },
    { prompt: "refactor the run pipeline", tier: "high" },
    { prompt: "rename the token helper across the codebase", tier: "high" },
    { prompt: `write a report about ${"detail ".repeat(150)}`, tier: "high" },
    {
      prompt: "update the gateway ingress handler so that inbound frappe webhooks are validated before they reach the interaction store, keeping the existing signature check and adding a short circuit for replays",
      tier: "medium",
    },
  ];
  for (const { prompt, tier } of cases) {
    const taskKind = classifyTask(prompt);
    const actual = classifyReasoningTier(prompt, taskKind);
    assert.equal(actual.tier, tier, `${prompt} -> ${actual.tier} (${actual.reason})`);
    assert.ok(actual.reason.length > 0);
  }
});

test("architecture and private_analysis task kinds are deep regardless of brevity", () => {
  for (const taskKind of ["architecture", "private_analysis"] as TaskKind[]) {
    assert.equal(classifyReasoningTier("ok", taskKind).tier, "high");
  }
});

test("a short coding turn is routed low even though the seeded config has no coding route", () => {
  const config = testConfig(SEEDED_ROUTES);
  const prompt = "fix the failing test in tokens.test.ts";
  // The gap this closes: classifyTask says `coding`, the seeded runtime has no
  // `coding` route, so run.ts would leave reasoning undefined (model default).
  assert.equal(classifyTask(prompt), "coding");
  assert.equal(config.runtimes.native!.routes.coding, undefined);
  const { config: next, decision } = withReasoningEconomy(config, { prompt });
  assert.equal(decision.taskKind, "coding");
  assert.equal(decision.tier, "low");
  assert.equal(decision.source, "heuristic");
  assert.equal(next.runtimes.native!.routes.coding?.reasoning, "low");
  assert.equal(next.runtimes.native!.routes.coding?.provider, "codex");
  assert.equal(next.runtimes.native!.routes.coding?.model, "gpt-5.5");
  // Discovery-only: the caller's config object is never mutated.
  assert.equal(config.runtimes.native!.routes.coding, undefined);
});

test("auto never raises spend above the configured tier", () => {
  const config = testConfig(SEEDED_ROUTES);
  const decision = decideReasoning({ config, prompt: "architect the billing system", taskKind: "research" });
  assert.equal(decision.heuristicTier, "high");
  assert.equal(decision.baselineTier, "medium");
  assert.equal(decision.tier, "medium");
  assert.equal(decision.source, "baseline");
  assert.match(decision.reason, /capped at configured medium/);
});

test("auto keeps the seeded simple_qa low route low", () => {
  const config = testConfig(SEEDED_ROUTES);
  const { decision, config: next } = withReasoningEconomy(config, { prompt: "who owns the gateway config?" });
  assert.equal(decision.taskKind, "simple_qa");
  assert.equal(decision.tier, "low");
  assert.equal(next.runtimes.native!.routes.simple_qa?.reasoning, "low");
});

test("an explicit override wins in both directions and is labelled as an override", () => {
  const config = testConfig(SEEDED_ROUTES);
  const high = decideReasoning({ config, prompt: "hi", preference: "high" });
  assert.equal(high.tier, "high");
  assert.equal(high.source, "override");
  assert.equal(high.reason, "/reasoning high");
  const low = decideReasoning({ config, prompt: "design the system architecture for billing", preference: "low" });
  assert.equal(low.taskKind, "architecture");
  assert.equal(low.heuristicTier, "high");
  assert.equal(low.tier, "low");
  assert.equal(applyReasoningDecision(config, low).runtimes.native!.routes.architecture?.reasoning, "low");
});

test("parseReasoningPreference accepts only the four tiers", () => {
  assert.equal(parseReasoningPreference("AUTO"), "auto");
  assert.equal(parseReasoningPreference(" high "), "high");
  assert.equal(parseReasoningPreference("xhigh"), undefined);
  assert.equal(parseReasoningPreference(""), undefined);
  assert.equal(parseReasoningPreference(undefined), undefined);
});

test("a decision renders as a status-line fragment", () => {
  const decision = decideReasoning({ prompt: "what is this file?" });
  assert.equal(formatReasoningDecision(decision), `low · ${decision.reason}`);
  assert.match(formatReasoningDecision(decision), /^low · short simple_qa turn/);
});

test("runtimes without a provider are left untouched instead of gaining a broken route", () => {
  const config = testConfig(SEEDED_ROUTES);
  const orphan = { ...config, runtimes: { ...config.runtimes, ghost: { id: "ghost", enabled: true, provider: "missing", routes: {} } } } as MusterConfig;
  const decision = decideReasoning({ config: orphan, prompt: "rename a variable in the repo" });
  const next = applyReasoningDecision(orphan, decision);
  assert.deepEqual(next.runtimes.ghost!.routes, {});
  assert.equal(next.runtimes.native!.routes.coding?.reasoning, "low");
});
