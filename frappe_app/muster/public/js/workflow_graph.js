(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.musterWorkflowGraph = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function () {
  "use strict";

  const NODE_ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
  const NODE_TYPES = new Set([
    "Agent", "Tool", "Approval", "Condition", "Parallel", "Join", "Bounded Loop", "Artifact",
  ]);
  const DEFAULT_LIMITS = Object.freeze({
    maxDepth: 3, maxChildrenPerNode: 8, maxActiveNodes: 32, maxRetries: 3,
  });

  function configuration(node) {
    if (!node.configuration_json) return {};
    if (typeof node.configuration_json === "object" && !Array.isArray(node.configuration_json)) {
      return node.configuration_json;
    }
    const parsed = JSON.parse(node.configuration_json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("configuration_json must be an object");
    }
    return parsed;
  }

  function validateGraph(graph, suppliedLimits) {
    const limits = {...DEFAULT_LIMITS, ...(suppliedLimits || {})};
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const edges = Array.isArray(graph?.edges) ? graph.edges : [];
    const issues = [];
    const add = (code, message, path = "graph") => issues.push({code, message, path});
    if (!nodes.length) add("empty_graph", "Add at least one workflow node.", "nodes");
    if (nodes.length > limits.maxActiveNodes) {
      add("node_limit", `The graph has ${nodes.length} nodes; the limit is ${limits.maxActiveNodes}.`, "nodes");
    }
    const nodeById = new Map();
    nodes.forEach((node, index) => {
      const id = String(node.node_id || "").trim();
      if (!NODE_ID.test(id)) add("invalid_node_id", "Use a letter first, then letters, numbers, . _ : or -.", `nodes[${index}].node_id`);
      else if (nodeById.has(id)) add("duplicate_node", `Node ID ${id} is duplicated.`, `nodes[${index}].node_id`);
      else nodeById.set(id, node);
      if (!NODE_TYPES.has(node.node_type)) add("invalid_node_type", `Unsupported node type: ${node.node_type || "blank"}.`, `nodes[${index}].node_type`);
      if (node.node_type === "Agent" && !node.agent) add("missing_agent", "Choose an agent for this node.", `nodes[${index}].agent`);
      const retry = Number(node.retry_limit || 0);
      if (!Number.isInteger(retry) || retry < 0 || retry > limits.maxRetries) add("retry_limit", `Retry limit must be 0..${limits.maxRetries}.`, `nodes[${index}].retry_limit`);
      try {
        const config = configuration(node);
        const requested = config.requested_capabilities || [];
        if (!Array.isArray(requested) || requested.some((item) => typeof item !== "string" || !item.trim())) {
          add("invalid_capabilities", "Requested capabilities must be a list of non-empty strings.", `nodes[${index}].configuration_json`);
        }
        if (node.node_type === "Bounded Loop" && (!Number.isInteger(config.max_iterations) || config.max_iterations < 1 || config.max_iterations > 100 || !config.progress_predicate)) {
          add("unbounded_loop", "A bounded loop needs max_iterations 1..100 and progress_predicate.", `nodes[${index}].configuration_json`);
        }
      } catch (error) {
        add("invalid_configuration", error.message, `nodes[${index}].configuration_json`);
      }
    });

    const incoming = new Map([...nodeById.keys()].map((id) => [id, 0]));
    const outgoing = new Map([...nodeById.keys()].map((id) => [id, []]));
    const seen = new Set();
    edges.forEach((edge, index) => {
      const from = String(edge.source_node || "").trim();
      const to = String(edge.target_node || "").trim();
      if (!nodeById.has(from) || !nodeById.has(to)) {
        add("unknown_node", `Edge ${from || "?"} → ${to || "?"} references an unknown node.`, `edges[${index}]`);
        return;
      }
      if (from === to) add("self_edge", "A node cannot connect to itself.", `edges[${index}]`);
      const key = `${from}\u0000${to}`;
      if (seen.has(key)) add("duplicate_edge", `Edge ${from} → ${to} is duplicated.`, `edges[${index}]`);
      else {
        seen.add(key); incoming.set(to, incoming.get(to) + 1); outgoing.get(from).push(to);
      }
    });
    const fanOut = Math.max(0, ...[...outgoing.values()].map((items) => items.length));
    if (fanOut > limits.maxChildrenPerNode) add("fan_out_limit", `Fan-out is ${fanOut}; the limit is ${limits.maxChildrenPerNode}.`);
    const roots = [...incoming].filter(([, count]) => count === 0).map(([id]) => id).sort();
    if (nodes.length && roots.length !== 1) add("root_count", `A workflow needs exactly one root; found ${roots.length}.`);

    const pending = new Map(incoming);
    const queue = roots.length === 1 ? [roots[0]] : [];
    const order = [];
    const distance = new Map();
    if (queue.length) distance.set(queue[0], nodeById.get(queue[0]).node_type === "Agent" ? 1 : 0);
    while (queue.length) {
      const current = queue.shift(); order.push(current);
      [...outgoing.get(current)].sort().forEach((target) => {
        const nextDepth = distance.get(current) + (nodeById.get(target).node_type === "Agent" ? 1 : 0);
        distance.set(target, Math.max(distance.get(target) || 0, nextDepth));
        pending.set(target, pending.get(target) - 1);
        if (pending.get(target) === 0) { queue.push(target); queue.sort(); }
      });
    }
    if (nodeById.size && order.length !== nodeById.size) add("cycle", "Raw cycles are forbidden; use a Bounded Loop node.");
    const depth = Math.max(0, ...distance.values());
    if (depth > limits.maxDepth) add("depth_limit", `Agent nesting depth is ${depth}; the limit is ${limits.maxDepth}.`);
    return {
      valid: issues.length === 0,
      issues,
      analysis: {root: roots[0] || null, nodeCount: nodes.length, edgeCount: edges.length, depth, maximumFanOut: fanOut, topologicalOrder: order},
    };
  }

  return Object.freeze({DEFAULT_LIMITS, validateGraph});
});

