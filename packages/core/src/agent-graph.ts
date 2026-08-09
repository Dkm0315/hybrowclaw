/** Portable, host-independent agent graph contracts and validation. */

export const DEFAULT_AGENT_GRAPH_LIMITS = {
  maxDepth: 3,
  maxChildrenPerNode: 8,
  maxActiveNodes: 32,
  maxRetries: 3,
} as const;

export type AgentGraphNodeKind =
  | "plan"
  | "agent"
  | "subworkflow"
  | "command"
  | "transform"
  | "condition"
  | "parallel_map"
  | "approval"
  | "wait"
  | "artifact"
  | "verification"
  | "compensation"
  | "loop";

export interface AgentGraphBudget {
  readonly runtimeMs: number;
  readonly toolCalls: number;
  readonly modelCalls: number;
  readonly tokens: number;
  readonly costMicros: number;
  readonly artifactBytes: number;
}

export interface AgentGraphLimits {
  readonly maxDepth?: number;
  readonly maxChildrenPerNode?: number;
  readonly maxActiveNodes?: number;
  readonly maxRetries?: number;
}

export interface AgentGraphNode {
  readonly id: string;
  readonly kind: AgentGraphNodeKind;
  readonly agentId?: string;
  readonly requestedCapabilities?: readonly string[];
  readonly retryLimit?: number;
  readonly compensationNodeId?: string;
  /** Data-only, host-reviewed intent. It is never executable authority. */
  readonly executionIntent?: unknown;
  /** Required only for loop nodes. The loop body is represented by ordinary acyclic edges. */
  readonly loop?: {
    readonly maxIterations: number;
    readonly progressPredicate: string;
    readonly cancellationCheckpoint: boolean;
    readonly budget: AgentGraphBudget;
  };
}

export interface AgentGraphEdge {
  readonly from: string;
  readonly to: string;
  readonly when?: string;
}

export interface AgentGraphDefinition {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly entryNodeId: string;
  readonly nodes: readonly AgentGraphNode[];
  readonly edges: readonly AgentGraphEdge[];
  readonly budget: AgentGraphBudget;
  readonly limits?: AgentGraphLimits;
}

export interface AgentGraphIssue {
  readonly code: string;
  readonly message: string;
  readonly nodeId?: string;
  readonly edgeIndex?: number;
}

const ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.:-]*$/;
const NODE_KINDS = new Set<AgentGraphNodeKind>([
  "plan", "agent", "subworkflow", "command", "transform", "condition", "parallel_map",
  "approval", "wait", "artifact", "verification", "compensation", "loop",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function validateBudget(value: unknown, label: string, issues: AgentGraphIssue[], nodeId?: string): void {
  if (!isRecord(value)) {
    issues.push({ code: "invalid_budget", message: `${label} must declare finite non-negative ceilings.`, nodeId });
    return;
  }
  for (const field of ["runtimeMs", "toolCalls", "modelCalls", "tokens", "costMicros", "artifactBytes"] as const) {
    const ceiling = value[field];
    if (typeof ceiling !== "number" || !Number.isFinite(ceiling) || ceiling < 0) {
      issues.push({ code: "invalid_budget", message: `${label}.${field} must be a finite non-negative number.`, nodeId });
    }
  }
}

/** Validate untrusted graph JSON without executing or mutating it. */
export function validateAgentGraph(value: unknown): AgentGraphIssue[] {
  const issues: AgentGraphIssue[] = [];
  if (!isRecord(value)) return [{ code: "invalid_graph", message: "Agent graph must be an object." }];
  if (value.schemaVersion !== 1) issues.push({ code: "unsupported_schema", message: "schemaVersion must be 1." });
  if (typeof value.id !== "string" || !ID_PATTERN.test(value.id)) issues.push({ code: "invalid_id", message: "Graph id is invalid." });
  if (typeof value.version !== "string" || !value.version.trim()) issues.push({ code: "invalid_version", message: "Graph version is required." });
  validateBudget(value.budget, "budget", issues);

  const rawLimits = isRecord(value.limits) ? value.limits : {};
  const limits = {
    maxDepth: rawLimits.maxDepth ?? DEFAULT_AGENT_GRAPH_LIMITS.maxDepth,
    maxChildrenPerNode: rawLimits.maxChildrenPerNode ?? DEFAULT_AGENT_GRAPH_LIMITS.maxChildrenPerNode,
    maxActiveNodes: rawLimits.maxActiveNodes ?? DEFAULT_AGENT_GRAPH_LIMITS.maxActiveNodes,
    maxRetries: rawLimits.maxRetries ?? DEFAULT_AGENT_GRAPH_LIMITS.maxRetries,
  };
  for (const [name, limit] of Object.entries(limits)) {
    if (!positiveInteger(limit)) issues.push({ code: "invalid_limit", message: `${name} must be a positive integer.` });
  }

  if (!Array.isArray(value.nodes) || value.nodes.length === 0) {
    issues.push({ code: "missing_nodes", message: "Graph must declare at least one node." });
    return issues;
  }
  if (positiveInteger(limits.maxActiveNodes) && value.nodes.length > limits.maxActiveNodes) {
    issues.push({ code: "active_node_limit", message: `Graph declares ${value.nodes.length} nodes; limit is ${limits.maxActiveNodes}.` });
  }

  const nodeIds = new Set<string>();
  const nodes = new Map<string, Record<string, unknown>>();
  for (const [index, rawNode] of value.nodes.entries()) {
    if (!isRecord(rawNode)) {
      issues.push({ code: "invalid_node", message: `Node ${index + 1} must be an object.` });
      continue;
    }
    const nodeId = typeof rawNode.id === "string" ? rawNode.id : undefined;
    if (!nodeId || !ID_PATTERN.test(nodeId)) issues.push({ code: "invalid_node_id", message: `Node ${index + 1} has an invalid id.`, nodeId });
    else if (nodeIds.has(nodeId)) issues.push({ code: "duplicate_node", message: `Duplicate node id "${nodeId}".`, nodeId });
    else { nodeIds.add(nodeId); nodes.set(nodeId, rawNode); }
    if (!NODE_KINDS.has(rawNode.kind as AgentGraphNodeKind)) issues.push({ code: "invalid_node_kind", message: `Node "${nodeId ?? index + 1}" has an invalid kind.`, nodeId });
    const retryLimit = rawNode.retryLimit ?? DEFAULT_AGENT_GRAPH_LIMITS.maxRetries;
    if (!Number.isInteger(retryLimit) || (retryLimit as number) < 0 || (positiveInteger(limits.maxRetries) && (retryLimit as number) > limits.maxRetries)) {
      issues.push({ code: "retry_limit", message: `Node "${nodeId ?? index + 1}" retryLimit exceeds the graph limit.`, nodeId });
    }
    if (rawNode.kind === "loop") {
      if (!isRecord(rawNode.loop) || !positiveInteger(rawNode.loop.maxIterations) || typeof rawNode.loop.progressPredicate !== "string" || !rawNode.loop.progressPredicate.trim() || rawNode.loop.cancellationCheckpoint !== true) {
        issues.push({ code: "unbounded_loop", message: `Loop node "${nodeId ?? index + 1}" requires maxIterations, a progress predicate, and a cancellation checkpoint.`, nodeId });
      } else validateBudget(rawNode.loop.budget, `node ${nodeId} loop budget`, issues, nodeId);
    } else if (rawNode.loop !== undefined) {
      issues.push({ code: "unexpected_loop", message: `Only loop nodes may declare loop controls.`, nodeId });
    }
  }

  const entryNodeId = typeof value.entryNodeId === "string" ? value.entryNodeId : "";
  if (!nodeIds.has(entryNodeId)) issues.push({ code: "invalid_entry", message: "entryNodeId must reference an existing node." });
  const adjacency = new Map<string, string[]>();
  for (const id of nodeIds) adjacency.set(id, []);
  if (!Array.isArray(value.edges)) issues.push({ code: "invalid_edges", message: "Graph edges must be an array." });
  else for (const [edgeIndex, rawEdge] of value.edges.entries()) {
    if (!isRecord(rawEdge) || typeof rawEdge.from !== "string" || typeof rawEdge.to !== "string") {
      issues.push({ code: "invalid_edge", message: `Edge ${edgeIndex + 1} must reference from and to nodes.`, edgeIndex });
      continue;
    }
    if (!nodeIds.has(rawEdge.from) || !nodeIds.has(rawEdge.to)) {
      issues.push({ code: "dangling_edge", message: `Edge ${edgeIndex + 1} references an unknown node.`, edgeIndex });
      continue;
    }
    adjacency.get(rawEdge.from)!.push(rawEdge.to);
  }
  for (const [nodeId, children] of adjacency) {
    if (positiveInteger(limits.maxChildrenPerNode) && children.length > limits.maxChildrenPerNode) {
      issues.push({ code: "fanout_limit", message: `Node "${nodeId}" has ${children.length} children; limit is ${limits.maxChildrenPerNode}.`, nodeId });
    }
  }

  const reachable = new Set<string>();
  const visiting = new Set<string>();
  const depthMemo = new Map<string, number>();
  let rawCycle = false;
  const walk = (id: string): number => {
    reachable.add(id);
    if (visiting.has(id)) { rawCycle = true; return 0; }
    const memoized = depthMemo.get(id);
    if (memoized !== undefined) return memoized;
    visiting.add(id);
    let childDepth = 0;
    for (const child of adjacency.get(id) ?? []) childDepth = Math.max(childDepth, walk(child));
    visiting.delete(id);
    const kind = nodes.get(id)?.kind;
    const depth = childDepth + (kind === "agent" || kind === "subworkflow" ? 1 : 0);
    depthMemo.set(id, depth);
    return depth;
  };
  const maximumDepth = nodeIds.has(entryNodeId) ? walk(entryNodeId) : 0;
  if (rawCycle) issues.push({ code: "raw_cycle", message: "Raw graph cycles are forbidden; use a bounded loop node." });
  for (const id of nodeIds) if (!reachable.has(id)) issues.push({ code: "unreachable_node", message: `Node "${id}" is unreachable from the entry node.`, nodeId: id });
  if (!rawCycle && positiveInteger(limits.maxDepth) && maximumDepth > limits.maxDepth) {
    issues.push({ code: "depth_limit", message: `Graph depth is ${maximumDepth}; limit is ${limits.maxDepth}.` });
  }
  for (const [nodeId, node] of nodes) {
    if (node.compensationNodeId !== undefined && (typeof node.compensationNodeId !== "string" || !nodeIds.has(node.compensationNodeId))) {
      issues.push({ code: "invalid_compensation", message: `Node "${nodeId}" references an unknown compensation node.`, nodeId });
    }
  }
  return issues;
}

export function parseAgentGraph(value: unknown): AgentGraphDefinition {
  const issues = validateAgentGraph(value);
  if (issues.length > 0) throw new Error(`Invalid agent graph:\n${issues.map((issue) => `- [${issue.code}] ${issue.message}`).join("\n")}`);
  return value as AgentGraphDefinition;
}

/** Effective child rights are deny-by-default: every authority term must grant a capability. */
export function intersectCapabilities(...authorityTerms: readonly (ReadonlySet<string> | readonly string[] | undefined)[]): ReadonlySet<string> {
  if (authorityTerms.length === 0 || authorityTerms.some((term) => term === undefined)) return new Set();
  const terms = authorityTerms.map((term) => new Set(term));
  const effective = new Set(terms[0]);
  for (const capability of effective) {
    if (terms.slice(1).some((term) => !term.has(capability))) effective.delete(capability);
  }
  return effective;
}
