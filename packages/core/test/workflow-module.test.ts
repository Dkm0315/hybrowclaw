import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compileWorkflowModule,
  exportWorkflowModule,
  parseWorkflowModule,
  validateWorkflowModule,
  type WorkflowModuleDefinition,
} from "../src/index.js";

const budget = { runtimeMs: 60_000, toolCalls: 20, modelCalls: 8, tokens: 20_000, costMicros: 100_000, artifactBytes: 1_000_000 };

function workflow(overrides: Partial<WorkflowModuleDefinition> = {}): WorkflowModuleDefinition {
  return {
    schemaVersion: 1,
    id: "erp.close-month",
    version: "1.0.0",
    meta: {
      name: "Close month",
      description: "Prompt-aware finance close with governed specialist lanes.",
      phases: [
        { title: "Research", detail: "Collect and reconcile evidence" },
        { title: "Approve", detail: "Require a finance approver" },
      ],
    },
    goal: "Close {{ input.company }} for {{ input.period }} and explain every change.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["company", "period"],
      properties: { company: { type: "string" }, period: { type: "string" } },
    },
    resultSchema: {
      type: "object", additionalProperties: false, required: ["status", "exceptions"],
      properties: { status: { type: "string", enum: ["ready", "blocked"] }, exceptions: { type: "array", items: { type: "string" } } },
    },
    budget,
    limits: { maxDepth: 8, maxChildrenPerNode: 4, maxActiveNodes: 32, maxRetries: 2, maxParallelism: 2, maxPhases: 8, maxSteps: 32 },
    steps: [
      {
        kind: "phase", label: "Research", steps: [
          {
            kind: "parallel", label: "Reconcile ledgers", maxConcurrency: 2, branches: [
              { kind: "agent", label: "Receivables specialist", prompt: "Reconcile receivables for {{ input.company }}.", capabilities: ["invoice.read"], resultSchema: { type: "object", properties: { total: { type: "number" } } } },
              { kind: "subworkflow", label: "Payables close", workflowId: "erp.payables-close", goal: "Reconcile payables", capabilities: ["bill.read"], steps: [
                { kind: "agent", label: "Payables specialist", prompt: "Investigate payables exceptions." },
              ] },
            ],
          },
          { kind: "verification", label: "Verify reconciliation", criteria: "Ledger totals balance and all exceptions cite a document." },
        ],
      },
      { kind: "approval", label: "Finance approval", prompt: "Approve posting the close?", requiredRoles: ["Finance Manager"] },
      { kind: "agent", label: "Post close", prompt: "Post only the approved close.", capabilities: ["journal.post"], compensation: "Reverse close", subagents: [
        { kind: "agent", label: "Posting auditor", prompt: "Check the draft journal without modifying it.", capabilities: ["journal.read"] },
      ] },
      { kind: "verification", label: "Verify posting", criteria: "Posted journal equals approved plan." },
      { kind: "compensation", label: "Reverse close", action: "Create and submit the exact reversal after approval." },
    ],
    ...overrides,
  };
}

test("parses a prompt-aware declarative workflow and compiles it to a validated AgentGraph", () => {
  const parsed = parseWorkflowModule(workflow());
  assert.equal(parsed.goal.includes("{{ input.company }}"), true);
  const graph = compileWorkflowModule(parsed);
  assert.equal(graph.id, parsed.id);
  assert.ok(graph.nodes.some((node) => node.kind === "parallel_map"));
  assert.ok(graph.nodes.some((node) => node.kind === "subworkflow"));
  assert.ok(graph.nodes.some((node) => node.kind === "approval"));
  assert.ok(graph.nodes.some((node) => node.kind === "verification"));
  const posting = graph.nodes.find((node) => node.id.endsWith("post-close"));
  assert.ok(posting?.compensationNodeId?.endsWith("reverse-close"));
  assert.ok(graph.nodes.some((node) => node.id.endsWith("payables-specialist")));
  assert.ok(graph.nodes.some((node) => node.id.endsWith("posting-auditor")));
  assert.deepEqual(graph.edges.filter((edge) => edge.to === posting?.compensationNodeId).map((edge) => edge.when), ["compensation.requested"]);
  assert.equal(graph.edges.some((edge) => edge.from.endsWith("verify-posting") && edge.to.endsWith("reverse-close")), false);
});

test("compiles a bounded repeat with explicit progress, cancellation, and budget controls", () => {
  const graph = compileWorkflowModule(workflow({
    steps: [{
      kind: "repeat", label: "Resolve exceptions", maxIterations: 3,
      progressPredicate: "open exception count decreases", cancellationCheckpoint: true, budget,
      steps: [{ kind: "agent", label: "Exception worker", prompt: "Resolve one approved exception." }],
    }],
  }));
  const repeat = graph.nodes.find((node) => node.kind === "loop");
  assert.equal(repeat?.loop?.maxIterations, 3);
  assert.equal(repeat?.loop?.cancellationCheckpoint, true);
});

test("compiles a generic reviewed execution step without embedding mission authority", () => {
  const intent = {
    schemaVersion: 1 as const, capability: "frappe.record.create",
    operation: { kind: "record", action: "create", doctype: "ToDo", values: { description: "Call customer" } },
    postconditions: [{ path: "$.description", operator: "equals", expected: "Call customer" }],
    approvalClass: "single",
  };
  const graph = compileWorkflowModule(workflow({ steps: [{
    kind: "execution", label: "Create follow-up", capabilities: ["frappe.record.create"],
    execution: { surface: "server_effect", plan: intent },
  }] }));
  const node = graph.nodes[0]!;
  assert.equal(node.kind, "command");
  assert.deepEqual(node.executionIntent, { surface: "server_effect", plan: intent });
  assert.equal("authority" in intent, false);
  assert.equal("approval" in intent, false);
});

test("execution steps reject effect capability drift and runtime authority injection", () => {
  const candidate = workflow({ steps: [{
    kind: "execution", label: "Unsafe", capabilities: ["frappe.record.update"],
    execution: { surface: "server_effect", plan: {
      schemaVersion: 1, capability: "frappe.record.create",
      operation: { kind: "record", action: "create", doctype: "ToDo", values: {} },
      postconditions: [{ path: "$.name", operator: "exists" }], approvalClass: "single",
      authority: { userId: "attacker@example.test" },
    } },
  } as never] });
  const issues = validateWorkflowModule(candidate);
  assert.ok(issues.some((issue) => issue.code === "unknown_field"));
  assert.ok(issues.some((issue) => issue.code === "invalid_effect_intent"));
});

test("compiles the same generic execution step for a closed semantic browser plan", () => {
  const plan = { schemaVersion: 1 as const, actionBudget: 1, actions: [{
    kind: "navigate", route: "/desk/todo",
  }] };
  const graph = compileWorkflowModule(workflow({ steps: [{
    kind: "execution", label: "Open tasks", capabilities: ["frappe.browser.navigate"],
    execution: { surface: "browser", plan },
  }] }));
  assert.deepEqual(graph.nodes[0]?.executionIntent, { surface: "browser", plan });
});

test("rejects JavaScript source rather than evaluating it", () => {
  (globalThis as Record<string, unknown>).__musterWorkflowPwned = false;
  assert.throws(
    () => parseWorkflowModule("globalThis.__musterWorkflowPwned = true; export default {}"),
    /never evals or dynamically imports/,
  );
  assert.equal((globalThis as Record<string, unknown>).__musterWorkflowPwned, false);
  delete (globalThis as Record<string, unknown>).__musterWorkflowPwned;
});

test("rejects executable fields and unsupported or externally referenced result schemas", () => {
  const candidate = workflow() as unknown as Record<string, unknown>;
  candidate.steps = [{ kind: "agent", label: "Injected", prompt: "x", run: "process.exit(0)", resultSchema: { $ref: "https://evil.test/schema.json" } }];
  const codes = new Set(validateWorkflowModule(candidate).map((issue) => issue.code));
  assert.ok(codes.has("unknown_field"));
  assert.ok(codes.has("unsafe_schema_ref"));

  const invalidType = workflow({ resultSchema: { type: "function" } });
  assert.ok(validateWorkflowModule(invalidType).some((issue) => issue.code === "invalid_schema"));
});

test("rejects callbacks, accessors, custom prototypes, cycles, and non-finite values anywhere in the descriptor", () => {
  const callback = workflow() as unknown as Record<string, unknown>;
  callback.resultSchema = { type: "string", default: () => "owned" };
  assert.ok(validateWorkflowModule(callback).some((issue) => issue.code === "unsafe_value"));

  const accessor = workflow() as unknown as Record<string, unknown>;
  let accessed = false;
  Object.defineProperty(accessor, "payload", { enumerable: true, get: () => { accessed = true; return "owned"; } });
  assert.ok(validateWorkflowModule(accessor).some((issue) => issue.code === "unsafe_value"));
  assert.equal(accessed, false);

  const custom = workflow() as unknown as Record<string, unknown>;
  custom.resultSchema = new Date() as unknown as Record<string, unknown>;
  assert.ok(validateWorkflowModule(custom).some((issue) => issue.code === "unsafe_value"));

  const circular = workflow() as unknown as Record<string, unknown>;
  circular.loop = circular;
  assert.ok(validateWorkflowModule(circular).some((issue) => issue.code === "unsafe_value"));

  assert.ok(validateWorkflowModule(workflow({ budget: { ...budget, tokens: Number.POSITIVE_INFINITY } })).some((issue) => issue.code === "unsafe_value"));

  const polluted = JSON.parse('{"schemaVersion":1,"__proto__":{"polluted":true}}');
  assert.ok(validateWorkflowModule(polluted).some((issue) => issue.code === "unsafe_key"));
});

test("rejects unbounded repeats even when a body is present", () => {
  const invalid = workflow({
    steps: [{
      kind: "repeat", label: "Keep trying", maxIterations: 0, progressPredicate: "", cancellationCheckpoint: false as true,
      budget, steps: [{ kind: "agent", label: "Worker", prompt: "Try again" }],
    }],
  });
  assert.ok(validateWorkflowModule(invalid).filter((issue) => issue.code === "unbounded_loop").length >= 2);
  assert.throws(() => compileWorkflowModule(invalid), /unbounded_loop/);
});

test("rejects duplicate labels and bounded nesting/fan-out violations", () => {
  const invalid = workflow({
    limits: { maxDepth: 1, maxChildrenPerNode: 1, maxActiveNodes: 20, maxRetries: 1, maxParallelism: 1, maxPhases: 2, maxSteps: 20 },
    steps: [{ kind: "phase", label: "Same", steps: [{ kind: "parallel", label: "lanes", maxConcurrency: 1, branches: [
      { kind: "agent", label: "Same", prompt: "one" },
      { kind: "agent", label: "two", prompt: "two" },
    ] }] }],
  });
  const codes = new Set(validateWorkflowModule(invalid).map((issue) => issue.code));
  assert.ok(codes.has("duplicate_label"));
  assert.ok(codes.has("depth_limit"));
  assert.ok(codes.has("fanout_limit"));
});

test("rejects excessive parallelism and retry ceilings fail closed during compilation", () => {
  const tooParallel = workflow({
    limits: { maxDepth: 8, maxChildrenPerNode: 4, maxActiveNodes: 32, maxRetries: 1, maxParallelism: 1, maxPhases: 8, maxSteps: 32 },
    steps: [{ kind: "parallel", label: "lanes", maxConcurrency: 2, branches: [
      { kind: "agent", label: "a", prompt: "a", retryLimit: 2 },
      { kind: "agent", label: "b", prompt: "b" },
    ] }],
  });
  assert.ok(validateWorkflowModule(tooParallel).some((issue) => issue.code === "parallelism_limit"));
  assert.throws(() => compileWorkflowModule(tooParallel), /parallelism_limit/);
});

test("exports deterministic human-readable .mjs without template-literal interpolation", () => {
  const maliciousPrompt = "Audit ${process.exit(1)} and   preserve this as text";
  const value = workflow({ steps: [{ kind: "agent", label: "Safe export", prompt: maliciousPrompt }] });
  const first = exportWorkflowModule(value);
  const second = exportWorkflowModule(JSON.stringify(value));
  assert.equal(first, second);
  assert.match(first, /defineWorkflow/);
  assert.match(first, /phase, agent, parallel, subworkflow, workflowStep/);
  assert.match(first, /\\u2028/);
  assert.ok(first.includes("${process.exit(1)}"));
  assert.ok(!first.includes("`Audit"));
  assert.ok(!first.includes('agent({\n      "kind"'));

  const reordered = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  const rawStep = (reordered.steps as Array<Record<string, unknown>>)[0];
  reordered.steps = [Object.fromEntries(Object.entries(rawStep).reverse())];
  assert.equal(exportWorkflowModule(reordered), first);
});

test("normalization clones input so later caller mutation cannot change the parsed workflow", () => {
  const source = workflow();
  const parsed = parseWorkflowModule(source);
  (source.steps as WorkflowModuleDefinition["steps"] as Array<{ label: string }>)[0].label = "mutated";
  assert.equal(parsed.steps[0].label, "Research");
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.steps), true);
});
