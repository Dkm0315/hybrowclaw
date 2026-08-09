import assert from "node:assert/strict";
import { test } from "node:test";
import {
  intersectCapabilities,
  parseAgentGraph,
  validateAgentGraph,
  type AgentGraphDefinition,
} from "../src/index.js";

const budget = { runtimeMs: 60_000, toolCalls: 10, modelCalls: 3, tokens: 10_000, costMicros: 50_000, artifactBytes: 1_000_000 };

function graph(overrides: Partial<AgentGraphDefinition> = {}): AgentGraphDefinition {
  return {
    schemaVersion: 1,
    id: "erp.close-month",
    version: "1.0.0",
    entryNodeId: "plan",
    budget,
    nodes: [
      { id: "plan", kind: "plan" },
      { id: "execute", kind: "agent", requestedCapabilities: ["invoice.read"] },
      { id: "verify", kind: "verification" },
    ],
    edges: [{ from: "plan", to: "execute" }, { from: "execute", to: "verify" }],
    ...overrides,
  };
}

test("parseAgentGraph accepts a bounded portable graph", () => {
  assert.equal(parseAgentGraph(graph()).id, "erp.close-month");
});

test("graph validation rejects cycles, dangling edges, unreachable nodes, and invalid compensation", () => {
  const candidate = graph({
    nodes: [...graph().nodes, { id: "orphan", kind: "agent" }, { id: "undo", kind: "compensation", compensationNodeId: "ghost" }],
    edges: [
      { from: "plan", to: "execute" },
      { from: "execute", to: "plan" },
      { from: "execute", to: "ghost" },
    ],
  });
  const codes = new Set(validateAgentGraph(candidate).map((issue) => issue.code));
  assert.ok(codes.has("raw_cycle"));
  assert.ok(codes.has("dangling_edge"));
  assert.ok(codes.has("unreachable_node"));
  assert.ok(codes.has("invalid_compensation"));
  assert.throws(() => parseAgentGraph(candidate), /Invalid agent graph/);
});

test("loop nodes require an iteration cap, progress predicate, checkpoint, and explicit budget", () => {
  const invalid = graph({ nodes: [{ id: "plan", kind: "loop", loop: { maxIterations: 0, progressPredicate: "", cancellationCheckpoint: false, budget } }], edges: [] });
  assert.ok(validateAgentGraph(invalid).some((issue) => issue.code === "unbounded_loop"));

  const valid = graph({
    nodes: [{ id: "plan", kind: "loop", loop: { maxIterations: 5, progressPredicate: "remaining decreases", cancellationCheckpoint: true, budget } }],
    edges: [],
  });
  assert.deepEqual(validateAgentGraph(valid), []);
});

test("limits reject excessive active nodes, fan-out, delegation depth, and retries", () => {
  const candidate = graph({
    limits: { maxActiveNodes: 3, maxChildrenPerNode: 1, maxDepth: 1, maxRetries: 2 },
    nodes: [
      { id: "plan", kind: "plan" },
      { id: "a", kind: "agent", retryLimit: 3 },
      { id: "b", kind: "agent" },
      { id: "c", kind: "subworkflow" },
    ],
    edges: [{ from: "plan", to: "a" }, { from: "plan", to: "b" }, { from: "a", to: "c" }],
  });
  const codes = new Set(validateAgentGraph(candidate).map((issue) => issue.code));
  assert.deepEqual([...codes].filter((code) => ["active_node_limit", "fanout_limit", "depth_limit", "retry_limit"].includes(code)).sort(),
    ["active_node_limit", "depth_limit", "fanout_limit", "retry_limit"]);
});

test("budgets cannot be absent, negative, infinite, or unbounded", () => {
  const candidate = { ...graph(), budget: { ...budget, tokens: Number.POSITIVE_INFINITY, costMicros: -1 } };
  assert.equal(validateAgentGraph(candidate).filter((issue) => issue.code === "invalid_budget").length, 2);
});

test("capability inheritance denies on any missing authority term and returns an intersection", () => {
  const effective = intersectCapabilities(
    ["invoice.read", "invoice.write", "user.admin"],
    ["invoice.read", "invoice.write"],
    new Set(["invoice.read"]),
  );
  assert.deepEqual([...effective], ["invoice.read"]);
  assert.equal(intersectCapabilities(["invoice.read"], undefined, ["invoice.read"]).size, 0);
  assert.equal(intersectCapabilities().size, 0);
});
