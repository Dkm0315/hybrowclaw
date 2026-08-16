import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { AgentGraphDefinition } from "@musterhq/core";
import {
  DurableFrappeMissionBridge,
  type FrappeMissionNodeExecutionInput,
  type TrustedFrappeMissionRequest,
} from "../src/frappe-mission-bridge.js";
import { SqliteFrappeRunEventStore, type AcceptedFrappeRunCommand } from "../src/frappe-run-events.js";

const scope = Object.freeze({ tenantId: "tenant-mission", siteId: "site-mission", userId: "owner@example.test" });
const budget = { runtimeMs: 10_000, toolCalls: 10, modelCalls: 3, tokens: 10_000, costMicros: 50_000, artifactBytes: 1_000_000 };
const submittedAt = new Date().toISOString();

function workflow(): AgentGraphDefinition {
  return {
    schemaVersion: 1,
    id: "erp.month-close",
    version: "1.0.0",
    entryNodeId: "plan",
    budget,
    nodes: [
      { id: "plan", kind: "plan" },
      { id: "department_agent", kind: "agent", agentId: "finance-agent" },
      { id: "verify", kind: "verification" },
    ],
    edges: [
      { from: "plan", to: "department_agent" },
      { from: "department_agent", to: "verify" },
    ],
  };
}

function mission(extra: Partial<TrustedFrappeMissionRequest> = {}): TrustedFrappeMissionRequest {
  return {
    schemaVersion: 1,
    missionId: "mission-native-1",
    rootRunId: "root-native-1",
    idempotencyKey: "mission-request-1",
    submittedAt,
    objective: "Close the month using verified Frappe evidence",
    workflow: workflow(),
    identity: { ...scope, permissionEpoch: "permission-1", rolesHash: "roles-1" },
    context: { route: "/desk/muster-control", summary: "Permission-filtered finance context" },
    ...extra,
  };
}

function stable(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort) : item && typeof item === "object"
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, sort(child)]))
    : item;
  return JSON.stringify(sort(value));
}

function executionManifest(nodeId = "plan") {
  const workflowSnapshotHash = createHash("sha256").update(stable(workflow())).digest("hex");
  const unsigned = {
    schemaVersion: 1 as const,
    workflowSnapshotHash,
    nodePlans: {
      [nodeId]: {
        surface: "browser" as const,
        plan: { schemaVersion: 1, actionBudget: 1, actions: [{ kind: "navigate", route: "/desk" }] },
        resourceScope: { routes: ["/desk"], doctypes: [], recordNames: [], fields: [] },
      },
    },
  };
  return { ...unsigned, manifestHash: createHash("sha256").update(stable(unsigned)).digest("hex") };
}

function control(action: AcceptedFrappeRunCommand["action"], index: number, payload?: Record<string, unknown>): AcceptedFrappeRunCommand {
  return {
    schemaVersion: 1,
    commandId: `mission-command-${index}`,
    action,
    missionId: "mission-native-1",
    rootRunId: "root-native-1",
    ...scope,
    issuedAt: new Date().toISOString(),
    idempotencyKey: `mission-control-${index}`,
    ...(payload ? { payload } : {}),
    fingerprint: `fingerprint-${index}`,
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await predicate(), true, "condition did not become true before timeout");
}

test("native Frappe mission executes a validated hierarchical graph through authoritative durable events", async () => {
  const store = new SqliteFrappeRunEventStore(":memory:");
  const executions: FrappeMissionNodeExecutionInput[] = [];
  const bridge = new DurableFrappeMissionBridge({
    store,
    executeNode: async (input) => {
      executions.push(input);
      return { summary: `Verified ${input.node.id}`, payload: { outputKind: "verified" }, evidenceIds: [`evidence-${input.node.id}`] };
    },
  });
  try {
    const accepted = await bridge.submit(mission(), scope);
    assert.equal(accepted.replayed, false);
    assert.equal(accepted.status, "running");
    await bridge.waitForIdle("mission-native-1");
    const status = await bridge.status(scope, "mission-native-1");
    assert.equal(status?.status, "completed");
    assert.deepEqual(executions.map((item) => item.node.id), ["plan", "department_agent", "verify"]);
    assert.deepEqual(executions.map((item) => item.parentNodeIds), [[], ["plan"], ["department_agent"]]);
    assert.deepEqual(executions.map((item) => item.depth), [0, 1, 2]);
    assert.deepEqual(status?.events.map((item) => item.type), [
      "mission_started",
      "node_started", "lease_claimed", "node_completed",
      "node_started", "lease_claimed", "node_completed",
      "node_started", "lease_claimed", "node_completed",
      "mission_completed",
    ]);
    assert.equal(status?.events.find((item) => item.nodeId === "department_agent" && item.type === "node_started")?.payload?.depth, 1);
    assert.equal(status?.events.some((item) => JSON.stringify(item).includes("chain-of-thought")), false);

    const replayed = await bridge.submit(mission(), scope);
    assert.equal(replayed.replayed, true);
    assert.equal(executions.length, 3);
    await assert.rejects(
      () => bridge.submit(mission({ context: { summary: "changed request under the same idempotency key" } }), scope),
      /different authority or content/i,
    );
    await assert.rejects(
      () => bridge.submit(mission({ missionId: "mission-native-2", rootRunId: "root-native-2" }), scope),
      /different authority or content/i,
    );
    assert.equal(await bridge.status(scope, "mission-native-2"), undefined);
  } finally {
    await bridge.close();
    store.close();
  }
});

test("node capabilities are the deny-by-default intersection of every trusted authority term", async () => {
  const store = new SqliteFrappeRunEventStore(":memory:");
  const observed: string[][] = [];
  const bridge = new DurableFrappeMissionBridge({
    store,
    executeNode: async (input) => {
      observed.push([...input.effectiveCapabilities]);
      return { summary: "Capability boundary verified" };
    },
  });
  try {
    const allowedGraph: AgentGraphDefinition = {
      ...workflow(),
      nodes: [{ id: "plan", kind: "agent", agentId: "finance-agent", requestedCapabilities: ["invoice.read"] }],
      edges: [],
      entryNodeId: "plan",
    };
    await bridge.submit(mission({
      workflow: allowedGraph,
      authority: {
        callerCapabilities: ["invoice.read", "invoice.write"],
        workflowCapabilities: ["invoice.read"],
        agentCapabilities: { "finance-agent": ["invoice.read"] },
      },
    }), scope);
    await bridge.waitForIdle();
    assert.deepEqual(observed, [["invoice.read"]]);
    assert.equal((await bridge.status(scope, "mission-native-1"))?.status, "completed");
  } finally {
    await bridge.close();
    store.close();
  }
});

test("hostile execution manifests fail admission on workflow hash, manifest hash, or node mismatch", async () => {
  for (const candidateManifest of [
    { ...executionManifest(), workflowSnapshotHash: "0".repeat(64) },
    { ...executionManifest(), manifestHash: "0".repeat(64) },
    executionManifest("unknown-node"),
  ]) {
    const store = new SqliteFrappeRunEventStore(":memory:");
    const bridge = new DurableFrappeMissionBridge({ store, executeNode: async () => ({ summary: "must not execute" }) });
    try {
      await assert.rejects(() => bridge.submit(mission({ executionManifest: candidateManifest }), scope), /execution manifest/i);
      assert.equal(await bridge.status(scope, "mission-native-1"), undefined);
    } finally {
      await bridge.close();
      store.close();
    }
  }
});

test("a node capability omitted by any trusted authority term never reaches its executor", async () => {
  const store = new SqliteFrappeRunEventStore(":memory:");
  let executions = 0;
  const bridge = new DurableFrappeMissionBridge({
    store,
    executeNode: async () => {
      executions += 1;
      return { summary: "must not execute" };
    },
  });
  try {
    const deniedGraph: AgentGraphDefinition = {
      ...workflow(),
      nodes: [{ id: "plan", kind: "agent", agentId: "finance-agent", requestedCapabilities: ["invoice.write"] }],
      edges: [],
      entryNodeId: "plan",
    };
    await bridge.submit(mission({
      workflow: deniedGraph,
      authority: {
        callerCapabilities: ["invoice.write"],
        workflowCapabilities: ["invoice.write"],
        agentCapabilities: { "finance-agent": ["invoice.read"] },
      },
    }), scope);
    await bridge.waitForIdle();
    assert.equal(executions, 0);
    assert.equal((await bridge.status(scope, "mission-native-1"))?.status, "failed");
  } finally {
    await bridge.close();
    store.close();
  }
});

test("pause, steering, resume, and cancel control a live hierarchical mission at durable safe points", async () => {
  const store = new SqliteFrappeRunEventStore(":memory:");
  const gates = new Map<string, () => void>();
  const started: string[] = [];
  const bridge = new DurableFrappeMissionBridge({
    store,
    executeNode: (input) => new Promise((resolve, reject) => {
      started.push(input.node.id);
      const finish = () => resolve({ summary: `Finished ${input.node.id}` });
      gates.set(input.node.id, finish);
      input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
    }),
  });
  try {
    await bridge.submit(mission(), scope);
    await waitFor(() => started.includes("plan"));
    await bridge.control(control("pause", 1));
    await bridge.control(control("steer", 2, { instruction: "Use the latest verified ledger only" }));
    gates.get("plan")?.();
    await waitFor(async () => (await bridge.status(scope, "mission-native-1"))?.status === "paused");
    assert.deepEqual(started, ["plan"]);
    await bridge.control(control("resume", 3));
    await waitFor(() => started.includes("department_agent"));
    await bridge.control(control("cancel", 4));
    await bridge.waitForIdle("mission-native-1");
    const status = await bridge.status(scope, "mission-native-1");
    assert.equal(status?.status, "cancelled");
    assert.deepEqual(status?.events.filter((item) => ["pause_requested", "steered", "paused", "resumed", "cancellation_requested", "cancelling", "cancelled"].includes(item.type)).map((item) => item.type), [
      "pause_requested", "steered", "paused", "resumed", "cancellation_requested", "cancelling", "cancelled",
    ]);
    assert.equal(status?.events.find((item) => item.type === "steered")?.payload?.instruction, "Use the latest verified ledger only");
    assert.equal(started.includes("verify"), false);
  } finally {
    await bridge.close();
    store.close();
  }
});

test("mission authority and portable graph validation fail before admission with zero side effects", async () => {
  const store = new SqliteFrappeRunEventStore(":memory:");
  const bridge = new DurableFrappeMissionBridge({ store, executeNode: async () => ({ summary: "unused" }) });
  try {
    await assert.rejects(() => bridge.submit(mission(), { ...scope, userId: "attacker@example.test" }), /authenticated Frappe authority/i);
    const invalid = mission({ workflow: { ...workflow(), edges: [...workflow().edges, { from: "verify", to: "plan" }] } });
    await assert.rejects(() => bridge.submit(invalid, scope), /Invalid agent graph/i);
    assert.equal(await bridge.status(scope, "mission-native-1"), undefined);
  } finally {
    await bridge.close();
    store.close();
  }
});

test("an identical mission resubmission recovers an interrupted fenced node from durable events", async () => {
  const store = new SqliteFrappeRunEventStore(":memory:");
  let firstStarted = false;
  const first = new DurableFrappeMissionBridge({
    store,
    executeNode: (input) => new Promise((_resolve, reject) => {
      firstStarted = true;
      input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
    }),
  });
  await first.submit(mission(), scope);
  await waitFor(() => firstStarted);
  await first.close();

  const recoveredNodes: string[] = [];
  const recovered = new DurableFrappeMissionBridge({
    store,
    executeNode: async (input) => {
      recoveredNodes.push(input.node.id);
      return { summary: `Recovered ${input.node.id}` };
    },
  });
  try {
    const replay = await recovered.submit(mission(), scope);
    assert.equal(replay.replayed, true);
    await recovered.waitForIdle("mission-native-1");
    const status = await recovered.status(scope, "mission-native-1");
    assert.equal(status?.status, "completed");
    assert.deepEqual(recoveredNodes, ["plan", "department_agent", "verify"]);
    const planLeases = status?.events.filter((item) => item.nodeId === "plan" && item.type === "lease_claimed") ?? [];
    assert.deepEqual(planLeases.map((item) => item.fencingToken), [1, 2]);
    assert.equal(status?.events.some((item) => item.nodeId === "plan" && item.type === "node_failed"), true);
  } finally {
    await recovered.close();
    store.close();
  }
});

test("trusted node outcomes choose only declared workflow branches and persist the decision", async () => {
  const store = new SqliteFrappeRunEventStore(":memory:");
  const branching: AgentGraphDefinition = {
    ...workflow(),
    nodes: [{ id: "plan", kind: "condition" }, { id: "approved", kind: "agent" }, { id: "rejected", kind: "agent" }],
    edges: [{ from: "plan", to: "approved" }, { from: "plan", to: "rejected" }],
  };
  const executed: string[] = [];
  const bridge = new DurableFrappeMissionBridge({
    store,
    executeNode: async (input) => {
      executed.push(input.node.id);
      return input.node.id === "plan"
        ? { summary: "Selected approved branch", selectedNextNodeIds: ["approved"] }
        : { summary: `Completed ${input.node.id}` };
    },
  });
  try {
    await bridge.submit(mission({ workflow: branching }), scope);
    await bridge.waitForIdle();
    assert.deepEqual(executed, ["plan", "approved"]);
    const status = await bridge.status(scope, "mission-native-1");
    assert.deepEqual(status?.events.find((item) => item.nodeId === "plan" && item.type === "node_completed")?.payload?.selectedNextNodeIds, ["approved"]);
    assert.equal(status?.status, "completed");
  } finally {
    await bridge.close();
    store.close();
  }
});

test("a node cannot escape its portable graph by selecting an undeclared target", async () => {
  const store = new SqliteFrappeRunEventStore(":memory:");
  const bridge = new DurableFrappeMissionBridge({
    store,
    executeNode: async () => ({ summary: "malformed branch", selectedNextNodeIds: ["outside_graph"] }),
  });
  try {
    await bridge.submit(mission(), scope);
    await bridge.waitForIdle();
    const status = await bridge.status(scope, "mission-native-1");
    assert.equal(status?.status, "failed");
    assert.equal(status?.events.some((item) => item.type === "node_completed"), false);
    assert.deepEqual(status?.events.slice(-2).map((item) => item.type), ["node_failed", "mission_failed"]);
  } finally {
    await bridge.close();
    store.close();
  }
});

test("a loop node keeps working and streaming progress until verification", async () => {
  const store = new SqliteFrappeRunEventStore(":memory:");
  const iterations: number[] = [];
  const loopWorkflow: AgentGraphDefinition = {
    ...workflow(),
    entryNodeId: "repair_until_verified",
    nodes: [{
      id: "repair_until_verified",
      kind: "loop",
      loop: { maxIterations: 5, progressPredicate: "live validation advances", cancellationCheckpoint: true, budget },
    }],
    edges: [],
  };
  const bridge = new DurableFrappeMissionBridge({
    store,
    executeNode: async (input) => {
      iterations.push(input.iteration);
      assert.equal(input.previousProgressMarker, input.iteration === 1 ? undefined : `state-${input.iteration - 1}`);
      return {
        summary: input.iteration === 3 ? "Correction re-read and verified." : `Completed bounded repair step ${input.iteration}.`,
        continuation: {
          state: input.iteration === 3 ? "verified" : "continue",
          progressMarker: `state-${input.iteration}`,
        },
        evidenceIds: [`evidence-${input.iteration}`],
      };
    },
  });
  try {
    await bridge.submit(mission({ workflow: loopWorkflow }), scope);
    await bridge.waitForIdle();
    const status = await bridge.status(scope, "mission-native-1");
    assert.equal(status?.status, "completed");
    assert.deepEqual(iterations, [1, 2, 3]);
    const progress = status?.events.filter((event) => event.type === "node_progress") ?? [];
    assert.deepEqual(progress.map((event) => event.payload?.continuationState), ["continue", "continue", "verified"]);
    assert.deepEqual(progress.map((event) => event.payload?.iteration), [1, 2, 3]);
    assert.equal(status?.events.filter((event) => event.type === "node_completed").length, 1);
    assert.equal(progress.every((event) => !JSON.stringify(event).includes("chain-of-thought")), true);
  } finally {
    await bridge.close();
    store.close();
  }
});

test("a long node streams redacted provider-visible progress before completion", async () => {
  const store = new SqliteFrappeRunEventStore(":memory:");
  const oneNode: AgentGraphDefinition = { ...workflow(), nodes: [{ id: "plan", kind: "agent" }], edges: [], entryNodeId: "plan" };
  const bridge = new DurableFrappeMissionBridge({
    store,
    executeNode: async (input) => {
      await input.recordProgress?.("Inspecting /home/goblin/private/repo with API_TOKEN=secret-value");
      return { summary: "Inspection completed." };
    },
  });
  try {
    await bridge.submit(mission({ workflow: oneNode }), scope);
    await bridge.waitForIdle();
    const status = await bridge.status(scope, "mission-native-1");
    const progress = status?.events.find((event) => event.type === "node_progress");
    assert.equal(progress?.summary, "Inspecting the workspace with API_TOKEN=[redacted]");
    assert.equal(progress?.payload?.progressKind, "provider_summary");
    assert.equal(status?.status, "completed");
    assert.ok((progress?.sequence ?? 0) < (status?.events.find((event) => event.type === "node_completed")?.sequence ?? 0));
  } finally {
    await bridge.close();
    store.close();
  }
});

test("a loop fails closed when an executor repeats a progress marker", async () => {
  const store = new SqliteFrappeRunEventStore(":memory:");
  const loopWorkflow: AgentGraphDefinition = {
    ...workflow(),
    entryNodeId: "repair_until_verified",
    nodes: [{
      id: "repair_until_verified",
      kind: "loop",
      loop: { maxIterations: 5, progressPredicate: "live validation advances", cancellationCheckpoint: true, budget },
    }],
    edges: [],
  };
  const bridge = new DurableFrappeMissionBridge({
    store,
    executeNode: async () => ({
      summary: "Still checking the same state.",
      continuation: { state: "continue", progressMarker: "unchanged-state" },
      evidenceIds: ["evidence-unchanged"],
    }),
  });
  try {
    await bridge.submit(mission({ workflow: loopWorkflow }), scope);
    await bridge.waitForIdle();
    const status = await bridge.status(scope, "mission-native-1");
    assert.equal(status?.status, "failed");
    assert.equal(status?.events.filter((event) => event.type === "node_progress").length, 1);
    assert.deepEqual(status?.events.slice(-2).map((event) => event.type), ["node_failed", "mission_failed"]);
  } finally {
    await bridge.close();
    store.close();
  }
});

test("a loop cannot claim verification without durable evidence", async () => {
  const store = new SqliteFrappeRunEventStore(":memory:");
  const loopWorkflow: AgentGraphDefinition = {
    ...workflow(),
    entryNodeId: "repair_until_verified",
    nodes: [{
      id: "repair_until_verified",
      kind: "loop",
      loop: { maxIterations: 2, progressPredicate: "live validation advances", cancellationCheckpoint: true, budget },
    }],
    edges: [],
  };
  const bridge = new DurableFrappeMissionBridge({
    store,
    executeNode: async () => ({
      summary: "The correction appears valid.",
      continuation: { state: "verified", progressMarker: "claimed-verification" },
    }),
  });
  try {
    await bridge.submit(mission({ workflow: loopWorkflow }), scope);
    await bridge.waitForIdle();
    const status = await bridge.status(scope, "mission-native-1");
    assert.equal(status?.status, "failed");
    assert.equal(status?.events.some((event) => event.type === "node_completed"), false);
    assert.deepEqual(status?.events.slice(-2).map((event) => event.type), ["node_failed", "mission_failed"]);
  } finally {
    await bridge.close();
    store.close();
  }
});

test("a loop pauses for genuine input and resumes the same objective", async () => {
  const store = new SqliteFrappeRunEventStore(":memory:");
  const steering: string[][] = [];
  const loopWorkflow: AgentGraphDefinition = {
    ...workflow(),
    entryNodeId: "repair_until_verified",
    nodes: [{
      id: "repair_until_verified",
      kind: "loop",
      loop: { maxIterations: 3, progressPredicate: "required business input is supplied", cancellationCheckpoint: true, budget },
    }],
    edges: [],
  };
  const bridge = new DurableFrappeMissionBridge({
    store,
    executeNode: async (input) => {
      steering.push([...input.steering]);
      return input.iteration === 1
        ? { summary: "Choose the approved effective date to continue.", continuation: { state: "needs_input", progressMarker: "awaiting-effective-date" } }
        : { summary: "Effective date applied and the correction is verified.", continuation: { state: "verified", progressMarker: "verified-effective-date" }, evidenceIds: ["evidence-effective-date"] };
    },
  });
  try {
    await bridge.submit(mission({ workflow: loopWorkflow }), scope);
    await waitFor(async () => (await bridge.status(scope, "mission-native-1"))?.status === "paused");
    await bridge.control(control("steer", 20, { instruction: "Use 2026-08-17 as the approved effective date." }));
    await bridge.control(control("resume", 21));
    await bridge.waitForIdle();
    const status = await bridge.status(scope, "mission-native-1");
    assert.equal(status?.status, "completed");
    assert.deepEqual(steering, [[], ["Use 2026-08-17 as the approved effective date."]]);
    assert.deepEqual(status?.events.filter((event) => ["pause_requested", "paused", "steered", "resumed"].includes(event.type)).map((event) => event.type), [
      "pause_requested", "paused", "steered", "resumed",
    ]);
  } finally {
    await bridge.close();
    store.close();
  }
});

test("a recovered loop resumes after its last durable progress marker", async () => {
  const store = new SqliteFrappeRunEventStore(":memory:");
  const loopWorkflow: AgentGraphDefinition = {
    ...workflow(),
    entryNodeId: "repair_until_verified",
    nodes: [{
      id: "repair_until_verified",
      kind: "loop",
      loop: { maxIterations: 4, progressPredicate: "live validation advances", cancellationCheckpoint: true, budget },
    }],
    edges: [],
  };
  let secondIterationStarted = false;
  const first = new DurableFrappeMissionBridge({
    store,
    executeNode: async (input) => {
      if (input.iteration === 1) {
        return { summary: "First repair persisted.", continuation: { state: "continue", progressMarker: "state-1" }, evidenceIds: ["evidence-state-1"] };
      }
      secondIterationStarted = true;
      return new Promise((_resolve, reject) => input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true }));
    },
  });
  await first.submit(mission({ workflow: loopWorkflow }), scope);
  await waitFor(() => secondIterationStarted);
  await first.close();

  const resumed: Array<{ iteration: number; marker?: string }> = [];
  const recovered = new DurableFrappeMissionBridge({
    store,
    executeNode: async (input) => {
      resumed.push({ iteration: input.iteration, ...(input.previousProgressMarker ? { marker: input.previousProgressMarker } : {}) });
      return { summary: "Recovered repair verified.", continuation: { state: "verified", progressMarker: "state-2-verified" }, evidenceIds: ["evidence-state-2"] };
    },
  });
  try {
    await recovered.submit(mission({ workflow: loopWorkflow }), scope);
    await recovered.waitForIdle();
    assert.deepEqual(resumed, [{ iteration: 2, marker: "state-1" }]);
    assert.equal((await recovered.status(scope, "mission-native-1"))?.status, "completed");
  } finally {
    await recovered.close();
    store.close();
  }
});
