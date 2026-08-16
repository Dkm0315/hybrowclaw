/** Authoritative, append-only mission event contract and pure state reducer. */

export type MissionStatus =
  | "pending"
  | "running"
  | "pause_requested"
  | "paused"
  | "cancel_requested"
  | "cancelling"
  | "cancelled"
  | "compensation_running"
  | "compensated"
  | "needs_intervention"
  | "failed"
  | "completed";

export type RunEventType =
  | "mission_started"
  | "node_started"
  | "lease_claimed"
  | "lease_heartbeat"
  | "effect_started"
  | "effect_committed"
  | "node_progress"
  | "node_completed"
  | "node_failed"
  | "pause_requested"
  | "paused"
  | "resumed"
  | "steered"
  | "cancellation_requested"
  | "cancelling"
  | "cancelled"
  | "compensation_started"
  | "compensation_completed"
  | "compensation_failed"
  | "mission_failed"
  | "mission_completed";

export interface RunEvent {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly missionId: string;
  readonly rootRunId: string;
  readonly nodeId?: string;
  readonly attemptId?: string;
  readonly tenantId: string;
  readonly siteId?: string;
  readonly sequence: number;
  readonly type: RunEventType;
  readonly at: string;
  readonly actorId: string;
  readonly agentId?: string;
  readonly fencingToken?: number;
  readonly idempotencyKey?: string;
  readonly receiptHash?: string;
  readonly summary: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly evidenceIds?: readonly string[];
}

export interface NodeRuntimeState {
  readonly status: "running" | "completed" | "failed";
  readonly attemptId?: string;
  readonly fencingToken: number;
  readonly leaseExpiresAt?: string;
  readonly effectsInFlight: ReadonlySet<string>;
}

export interface MissionRuntimeState {
  readonly missionId: string;
  readonly rootRunId: string;
  readonly tenantId: string;
  readonly siteId?: string;
  readonly status: MissionStatus;
  readonly nextSequence: number;
  readonly appliedEventIds: ReadonlySet<string>;
  readonly committedEffects: ReadonlyMap<string, string>;
  readonly nodes: ReadonlyMap<string, NodeRuntimeState>;
}

export function createMissionRuntimeState(identity: Pick<RunEvent, "missionId" | "rootRunId" | "tenantId" | "siteId">): MissionRuntimeState {
  return {
    ...identity,
    status: "pending",
    nextSequence: 1,
    appliedEventIds: new Set(),
    committedEffects: new Map(),
    nodes: new Map(),
  };
}

export class RunEventConflictError extends Error {
  constructor(message: string) { super(message); this.name = "RunEventConflictError"; }
}

const TERMINAL = new Set<MissionStatus>(["cancelled", "compensated", "needs_intervention", "completed"]);
const FENCED_TYPES = new Set<RunEventType>(["lease_heartbeat", "effect_started", "effect_committed", "node_progress", "node_completed", "node_failed"]);
const FORBIDDEN_PAYLOAD_KEY = /^(?:password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|chain[_-]?of[_-]?thought|reasoning)$/i;

function containsForbiddenPayload(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsForbiddenPayload(item, seen));
  return Object.entries(value).some(([key, item]) => FORBIDDEN_PAYLOAD_KEY.test(key) || containsForbiddenPayload(item, seen));
}

function requireNode(event: RunEvent): string {
  if (!event.nodeId) throw new RunEventConflictError(`${event.type} requires nodeId.`);
  return event.nodeId;
}

function requireEffect(event: RunEvent): string {
  if (!event.idempotencyKey) throw new RunEventConflictError(`${event.type} requires idempotencyKey.`);
  return event.idempotencyKey;
}

function assertEnvelope(state: MissionRuntimeState, event: RunEvent): void {
  if (event.schemaVersion !== 1) throw new RunEventConflictError("Unsupported event schema version.");
  if (!event.id || !event.actorId || !event.summary || !Number.isInteger(event.sequence) || event.sequence < 1 || Number.isNaN(Date.parse(event.at))) {
    throw new RunEventConflictError("Invalid run event envelope.");
  }
  if (containsForbiddenPayload(event.payload)) throw new RunEventConflictError("Run event payload contains forbidden secret or hidden-reasoning fields.");
  if (event.missionId !== state.missionId || event.rootRunId !== state.rootRunId || event.tenantId !== state.tenantId || event.siteId !== state.siteId) {
    throw new RunEventConflictError("Event authority scope does not match the mission.");
  }
  if (event.sequence !== state.nextSequence) throw new RunEventConflictError(`Expected sequence ${state.nextSequence}; received ${event.sequence}.`);
}

/**
 * Apply one authoritative event. Duplicate transport delivery (same event id) is harmless.
 * All returned Sets/Maps are fresh, so historical snapshots remain immutable.
 */
export function reduceRunEvent(state: MissionRuntimeState, event: RunEvent): MissionRuntimeState {
  if (state.appliedEventIds.has(event.id)) return state;
  assertEnvelope(state, event);
  if (TERMINAL.has(state.status)) throw new RunEventConflictError(`Mission is terminal (${state.status}).`);

  const nodes = new Map(state.nodes);
  const committedEffects = new Map(state.committedEffects);
  let status = state.status;
  const nodeId = event.nodeId;
  const currentNode = nodeId ? nodes.get(nodeId) : undefined;

  if (FENCED_TYPES.has(event.type)) {
    requireNode(event);
    if (!currentNode || event.fencingToken === undefined || event.fencingToken !== currentNode.fencingToken) {
      throw new RunEventConflictError(`Stale or missing fencing token for node "${event.nodeId}".`);
    }
    if (event.attemptId !== currentNode.attemptId) throw new RunEventConflictError(`Attempt does not own node "${event.nodeId}".`);
    if (!currentNode.leaseExpiresAt || Date.parse(event.at) > Date.parse(currentNode.leaseExpiresAt)) {
      throw new RunEventConflictError(`Lease for node "${event.nodeId}" has expired.`);
    }
  }

  switch (event.type) {
    case "mission_started":
      if (status !== "pending") throw new RunEventConflictError("Mission can start only once.");
      status = "running";
      break;
    case "node_started": {
      const id = requireNode(event);
      if (status !== "running") throw new RunEventConflictError("Cancellation prevents new node work.");
      if (!event.attemptId) throw new RunEventConflictError("node_started requires attemptId.");
      if (currentNode?.status === "completed") throw new RunEventConflictError(`Completed node "${id}" cannot restart.`);
      if (currentNode && currentNode.effectsInFlight.size > 0) throw new RunEventConflictError(`Node "${id}" cannot restart with effects in flight.`);
      nodes.set(id, { status: "running", attemptId: event.attemptId, fencingToken: currentNode?.fencingToken ?? 0, effectsInFlight: new Set() });
      break;
    }
    case "lease_claimed": {
      const id = requireNode(event);
      if (status !== "running") throw new RunEventConflictError("Cancellation prevents new leases.");
      if (!currentNode || currentNode.status !== "running" || !event.attemptId || !Number.isInteger(event.fencingToken) || (event.fencingToken ?? 0) <= currentNode.fencingToken) {
        throw new RunEventConflictError(`Lease for node "${id}" must advance its fencing token.`);
      }
      const leaseExpiresAt = typeof event.payload?.leaseExpiresAt === "string" ? event.payload.leaseExpiresAt : undefined;
      if (!leaseExpiresAt || Number.isNaN(Date.parse(leaseExpiresAt)) || Date.parse(leaseExpiresAt) <= Date.parse(event.at)) throw new RunEventConflictError("Lease requires a future leaseExpiresAt.");
      nodes.set(id, { ...currentNode, attemptId: event.attemptId, fencingToken: event.fencingToken!, leaseExpiresAt, effectsInFlight: new Set(currentNode.effectsInFlight) });
      break;
    }
    case "lease_heartbeat": {
      const id = requireNode(event);
      const leaseExpiresAt = typeof event.payload?.leaseExpiresAt === "string" ? event.payload.leaseExpiresAt : undefined;
      if (!leaseExpiresAt || Number.isNaN(Date.parse(leaseExpiresAt)) || Date.parse(leaseExpiresAt) <= Date.parse(event.at)) throw new RunEventConflictError("Heartbeat requires a future leaseExpiresAt.");
      nodes.set(id, { ...currentNode!, leaseExpiresAt, effectsInFlight: new Set(currentNode!.effectsInFlight) });
      break;
    }
    case "effect_started": {
      if (status !== "running") throw new RunEventConflictError("Cancellation prevents new effects.");
      const id = requireNode(event);
      const key = requireEffect(event);
      if (committedEffects.has(key)) break;
      const effects = new Set(currentNode!.effectsInFlight); effects.add(key);
      nodes.set(id, { ...currentNode!, effectsInFlight: effects });
      break;
    }
    case "effect_committed": {
      const id = requireNode(event);
      const key = requireEffect(event);
      if (!event.receiptHash) throw new RunEventConflictError("effect_committed requires receiptHash.");
      const prior = committedEffects.get(key);
      if (prior && prior !== event.receiptHash) throw new RunEventConflictError(`Idempotency key "${key}" has a conflicting receipt.`);
      committedEffects.set(key, event.receiptHash);
      const effects = new Set(currentNode!.effectsInFlight); effects.delete(key);
      nodes.set(id, { ...currentNode!, effectsInFlight: effects });
      break;
    }
    case "node_progress":
      if (status !== "running" || currentNode!.status !== "running") {
        throw new RunEventConflictError(`Progress requires running node "${requireNode(event)}".`);
      }
      break;
    case "node_completed": {
      const id = requireNode(event);
      if (currentNode!.effectsInFlight.size > 0) throw new RunEventConflictError(`Node "${id}" has effects in flight.`);
      nodes.set(id, { ...currentNode!, status: "completed", effectsInFlight: new Set() });
      break;
    }
    case "node_failed": {
      const id = requireNode(event);
      nodes.set(id, { ...currentNode!, status: "failed", effectsInFlight: new Set(currentNode!.effectsInFlight) });
      break;
    }
    case "pause_requested":
      if (status !== "running") throw new RunEventConflictError("Pause may be requested only while running.");
      status = "pause_requested";
      break;
    case "paused":
      if (status !== "pause_requested") throw new RunEventConflictError("Mission must be pause-requested before pausing.");
      if ([...nodes.values()].some((node) => node.effectsInFlight.size > 0)) throw new RunEventConflictError("Cannot pause before in-flight effects reach safe points.");
      status = "paused";
      break;
    case "resumed":
      if (status !== "paused") throw new RunEventConflictError("Only a paused mission may resume.");
      status = "running";
      break;
    case "steered":
      if (status !== "running" && status !== "pause_requested" && status !== "paused") {
        throw new RunEventConflictError("Mission cannot be steered from its current state.");
      }
      break;
    case "cancellation_requested":
      if (status !== "running" && status !== "pause_requested" && status !== "paused") throw new RunEventConflictError("Cancellation may be requested only while active.");
      status = "cancel_requested";
      break;
    case "cancelling":
      if (status !== "cancel_requested") throw new RunEventConflictError("Mission must be cancel-requested before cancelling.");
      status = "cancelling";
      break;
    case "cancelled":
      if (status !== "cancelling") throw new RunEventConflictError("Mission must be cancelling before it is cancelled.");
      if ([...nodes.values()].some((node) => node.effectsInFlight.size > 0)) throw new RunEventConflictError("Cannot cancel before in-flight effects reach safe points.");
      status = "cancelled";
      break;
    case "compensation_started":
      if (status !== "cancelling" && status !== "failed") throw new RunEventConflictError("Compensation requires cancellation or failure.");
      status = "compensation_running";
      break;
    case "compensation_completed":
      if (status !== "compensation_running") throw new RunEventConflictError("Compensation is not running.");
      status = "compensated";
      break;
    case "compensation_failed":
      if (status !== "compensation_running") throw new RunEventConflictError("Compensation is not running.");
      status = "needs_intervention";
      break;
    case "mission_failed":
      if (status !== "running" && status !== "pause_requested" && status !== "paused" && status !== "cancelling") throw new RunEventConflictError("Mission cannot fail from its current state.");
      status = "failed";
      break;
    case "mission_completed":
      if (status !== "running") throw new RunEventConflictError("Cancellation wins once its authoritative event is committed.");
      if ([...nodes.values()].some((node) => node.status === "running")) throw new RunEventConflictError("Mission has unfinished nodes.");
      status = "completed";
      break;
  }

  const appliedEventIds = new Set(state.appliedEventIds); appliedEventIds.add(event.id);
  return { ...state, status, nextSequence: state.nextSequence + 1, nodes, committedEffects, appliedEventIds };
}

/** Replay may contain duplicate transport delivery but no sequence gaps or conflicting authority. */
export function replayRunEvents(initial: MissionRuntimeState, events: readonly RunEvent[]): MissionRuntimeState {
  return events.reduce(reduceRunEvent, initial);
}
