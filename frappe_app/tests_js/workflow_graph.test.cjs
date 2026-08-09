const assert = require("node:assert/strict");
const {test} = require("node:test");
const {validateGraph} = require("../muster/public/js/workflow_graph.js");

const node = (node_id, extra = {}) => ({
  node_id, label: node_id, node_type: "Agent", agent: "Agent A",
  retry_limit: 1, timeout_seconds: 60, configuration_json: "{}", ...extra,
});

test("validates a visual DAG and reports analysis", () => {
  const result = validateGraph({
    nodes: [node("root"), node("left"), node("right")],
    edges: [
      {source_node: "root", target_node: "left"},
      {source_node: "root", target_node: "right"},
    ],
  });
  assert.equal(result.valid, true);
  assert.equal(result.analysis.maximumFanOut, 2);
  assert.equal(result.analysis.depth, 2);
});

test("rejects raw cycles", () => {
  const result = validateGraph({
    nodes: [node("one"), node("two")],
    edges: [
      {source_node: "one", target_node: "two"},
      {source_node: "two", target_node: "one"},
    ],
  });
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "cycle"));
});

test("rejects excessive fan-out and malformed loop controls", () => {
  const result = validateGraph({
    nodes: [
      node("root", {node_type: "Bounded Loop", agent: null, configuration_json: "{}"}),
      node("left"), node("right"),
    ],
    edges: [
      {source_node: "root", target_node: "left"},
      {source_node: "root", target_node: "right"},
    ],
  }, {maxChildrenPerNode: 1});
  assert.ok(result.issues.some((issue) => issue.code === "fan_out_limit"));
  assert.ok(result.issues.some((issue) => issue.code === "unbounded_loop"));
});

test("never executes configuration text", () => {
  globalThis.__musterInjected = false;
  const result = validateGraph({
    nodes: [node("root", {configuration_json: '{"x":"globalThis.__musterInjected=true"}'})],
    edges: [],
  });
  assert.equal(result.valid, true);
  assert.equal(globalThis.__musterInjected, false);
});

