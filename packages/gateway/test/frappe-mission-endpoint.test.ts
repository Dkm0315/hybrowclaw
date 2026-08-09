import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfig, type AgentGraphDefinition } from "@musterhq/core";
import {
  FRAPPE_RUN_EVENTS_PATH,
  TRUSTED_FRAPPE_MISSIONS_PATH,
  createFrappeRunCsrfProof,
  initGatewayConfig,
  startGatewayServer,
  type FrappeMissionNodeExecutionInput,
  type FrappeRunEvent,
  type FrappeRunEventScope,
  type GatewayConfig,
  type TrustedFrappeMissionRequest,
} from "../src/index.js";

const scope = Object.freeze({ tenantId: "tenant-http-mission", siteId: "site-http-mission", userId: "mission.owner@example.test" });
const csrf = "mission-frappe-csrf";
const budget = { runtimeMs: 10_000, toolCalls: 10, modelCalls: 3, tokens: 10_000, costMicros: 50_000, artifactBytes: 1_000_000 };

function graph(): AgentGraphDefinition {
  return {
    schemaVersion: 1,
    id: "frappe.native-workflow",
    version: "1.0.0",
    entryNodeId: "plan",
    budget,
    nodes: [{ id: "plan", kind: "plan" }, { id: "subagent", kind: "agent", agentId: "module-agent" }, { id: "verify", kind: "verification" }],
    edges: [{ from: "plan", to: "subagent" }, { from: "subagent", to: "verify" }],
  };
}

function mission(): TrustedFrappeMissionRequest {
  return {
    schemaVersion: 1,
    missionId: "http-mission-1",
    rootRunId: "http-root-1",
    idempotencyKey: "http-mission-idempotency-1",
    submittedAt: new Date().toISOString(),
    objective: "Execute the governed native Frappe workflow",
    workflow: graph(),
    identity: { ...scope, permissionEpoch: "permission-epoch-1", rolesHash: "roles-hash-1" },
    context: { route: "/desk/muster-control", summary: "Frappe permission-filtered context" },
  };
}

function headers(config: GatewayConfig, authority: FrappeRunEventScope, idempotencyKey?: string): Record<string, string> {
  return {
    authorization: `Bearer ${config.token}`,
    "content-type": "application/json",
    "x-frappe-tenant-id": authority.tenantId,
    ...(authority.siteId ? { "x-frappe-site-id": authority.siteId } : {}),
    "x-frappe-user-id": authority.userId,
    "x-frappe-csrf-token": csrf,
    "x-muster-csrf-proof": createFrappeRunCsrfProof(config.token, csrf, authority),
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
  };
}

async function waitForStatus(baseUrl: string, config: GatewayConfig, expected: string): Promise<{ status: string; events: FrappeRunEvent[] }> {
  const deadline = Date.now() + 3_000;
  let snapshot = { status: "unknown", events: [] as FrappeRunEvent[] };
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}${TRUSTED_FRAPPE_MISSIONS_PATH}/http-mission-1`, { headers: headers(config, scope) });
    assert.equal(response.status, 200);
    snapshot = await response.json() as typeof snapshot;
    if (snapshot.status === expected) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(snapshot.status, expected);
  return snapshot;
}

test("trusted Frappe mission endpoint executes the portable graph and bridges async status/control", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-native-mission-http-"));
  const initialized = await initGatewayConfig(cwd);
  const executed: FrappeMissionNodeExecutionInput[] = [];
  let releasePlan!: () => void;
  const planGate = new Promise<void>((resolve) => { releasePlan = resolve; });
  const running = await startGatewayServer({
    config: defaultConfig(),
    gateway: initialized.config,
    cwd,
    frappeMissionExecutor: async (input) => {
      executed.push(input);
      if (input.node.id === "plan") await planGate;
      return { summary: `Verified native node ${input.node.id}`, payload: { verified: true } };
    },
  }, 0);
  const baseUrl = `http://127.0.0.1:${running.port}`;
  const request = mission();
  try {
    const unauthenticated = await fetch(`${baseUrl}${TRUSTED_FRAPPE_MISSIONS_PATH}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
    });
    assert.equal(unauthenticated.status, 401);

    const accepted = await fetch(`${baseUrl}${TRUSTED_FRAPPE_MISSIONS_PATH}`, {
      method: "POST",
      headers: headers(initialized.config, scope, request.idempotencyKey),
      body: JSON.stringify(request),
    });
    assert.equal(accepted.status, 202);
    const submission = await accepted.json() as { pollPath: string; eventsPath: string; replayed: boolean };
    assert.equal(submission.pollPath, `${TRUSTED_FRAPPE_MISSIONS_PATH}/http-mission-1`);
    assert.match(submission.eventsPath, /run-events/);
    await waitForStatus(baseUrl, initialized.config, "running");

    const controlUrl = `${baseUrl}${FRAPPE_RUN_EVENTS_PATH}/missions/http-mission-1/commands`;
    const steer = {
      schemaVersion: 1, commandId: "http-steer-1", action: "steer", missionId: "http-mission-1", rootRunId: "http-root-1",
      ...scope, issuedAt: new Date().toISOString(), idempotencyKey: "http-steer-idem-1", csrfToken: csrf,
      payload: { instruction: "Use only the freshly verified Frappe ledger" },
    };
    assert.equal((await fetch(controlUrl, {
      method: "POST", headers: headers(initialized.config, scope, steer.idempotencyKey), body: JSON.stringify(steer),
    })).status, 202);
    const pause = { ...steer, commandId: "http-pause-1", action: "pause", idempotencyKey: "http-pause-idem-1", payload: undefined };
    assert.equal((await fetch(controlUrl, {
      method: "POST", headers: headers(initialized.config, scope, pause.idempotencyKey), body: JSON.stringify(pause),
    })).status, 202);
    releasePlan();
    await waitForStatus(baseUrl, initialized.config, "paused");
    assert.deepEqual(executed.map((item) => item.node.id), ["plan"]);

    const resume = { ...steer, commandId: "http-resume-1", action: "resume", idempotencyKey: "http-resume-idem-1", payload: undefined };
    assert.equal((await fetch(controlUrl, {
      method: "POST", headers: headers(initialized.config, scope, resume.idempotencyKey), body: JSON.stringify(resume),
    })).status, 202);
    const completed = await waitForStatus(baseUrl, initialized.config, "completed");
    assert.deepEqual(executed.map((item) => item.node.id), ["plan", "subagent", "verify"]);
    assert.deepEqual(completed.events.filter((item) => ["steered", "pause_requested", "paused", "resumed"].includes(item.type)).map((item) => item.type), [
      "steered", "pause_requested", "paused", "resumed",
    ]);
    assert.equal(completed.events.find((item) => item.nodeId === "subagent" && item.type === "node_started")?.payload?.parentNodeIds instanceof Array, true);

    const duplicate = await fetch(`${baseUrl}${TRUSTED_FRAPPE_MISSIONS_PATH}`, {
      method: "POST", headers: headers(initialized.config, scope, request.idempotencyKey), body: JSON.stringify(request),
    });
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json() as { replayed: boolean }).replayed, true);

    const changed = { ...request, workflow: { ...request.workflow, version: "2.0.0" } };
    assert.equal((await fetch(`${baseUrl}${TRUSTED_FRAPPE_MISSIONS_PATH}`, {
      method: "POST", headers: headers(initialized.config, scope, request.idempotencyKey), body: JSON.stringify(changed),
    })).status, 409);

    const otherUser = { ...scope, userId: "other@example.test" };
    assert.equal((await fetch(`${baseUrl}${TRUSTED_FRAPPE_MISSIONS_PATH}/http-mission-1`, {
      headers: headers(initialized.config, otherUser),
    })).status, 404);
  } finally {
    releasePlan();
    await running.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("invalid native workflow and spoofed Frappe identity fail before mission admission", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-native-mission-negative-"));
  const initialized = await initGatewayConfig(cwd);
  const running = await startGatewayServer({
    config: defaultConfig(), gateway: initialized.config, cwd,
    frappeMissionExecutor: async () => ({ summary: "must not run" }),
  }, 0);
  const baseUrl = `http://127.0.0.1:${running.port}`;
  try {
    const spoofed = { ...mission(), identity: { ...mission().identity, userId: "attacker@example.test" } };
    assert.equal((await fetch(`${baseUrl}${TRUSTED_FRAPPE_MISSIONS_PATH}`, {
      method: "POST", headers: headers(initialized.config, scope, spoofed.idempotencyKey), body: JSON.stringify(spoofed),
    })).status, 403);
    const invalid = { ...mission(), workflow: { ...graph(), edges: [...graph().edges, { from: "verify", to: "plan" }] } };
    assert.equal((await fetch(`${baseUrl}${TRUSTED_FRAPPE_MISSIONS_PATH}`, {
      method: "POST", headers: headers(initialized.config, scope, invalid.idempotencyKey), body: JSON.stringify(invalid),
    })).status, 400);
    const status = await fetch(`${baseUrl}${TRUSTED_FRAPPE_MISSIONS_PATH}/http-mission-1`, { headers: headers(initialized.config, scope) });
    assert.equal(status.status, 404);
  } finally {
    await running.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("production site-scoped Frappe routes reject the deployment-wide bearer", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-production-site-auth-"));
  const initialized = await initGatewayConfig(cwd);
  const production = {
    ...initialized.config,
    security: { deployment: "production" as const },
  };
  const running = await startGatewayServer({
    config: defaultConfig(), gateway: production, cwd,
    frappeMissionExecutor: async () => ({ summary: "must not run" }),
  }, 0);
  const baseUrl = `http://127.0.0.1:${running.port}`;
  try {
    const request = mission();
    const submitted = await fetch(`${baseUrl}${TRUSTED_FRAPPE_MISSIONS_PATH}`, {
      method: "POST",
      headers: headers(production, scope, request.idempotencyKey),
      body: JSON.stringify(request),
    });
    assert.equal(submitted.status, 401);
    const replay = await fetch(`${baseUrl}${FRAPPE_RUN_EVENTS_PATH}?missionId=${request.missionId}`, {
      headers: headers(production, scope),
    });
    assert.equal(replay.status, 401);
  } finally {
    await running.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("normal gateway startup provisions the offline read-only Codex mission executor", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-default-mission-"));
  const fakeCodex = join(cwd, "fake-codex.mjs");
  const argsLog = join(cwd, "codex-args.jsonl");
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(args) + "\\n");
const outputIndex = args.indexOf("-o");
if (outputIndex >= 0) writeFileSync(args[outputIndex + 1], "Verified the permission-filtered Frappe node without side effects.");
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "fake-thread" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");
`, "utf8");
  await chmod(fakeCodex, 0o755);
  const initialized = await initGatewayConfig(cwd);
  const previousCommand = process.env.MUSTER_CODEX_COMMAND;
  process.env.MUSTER_CODEX_COMMAND = fakeCodex;
  const running = await startGatewayServer({ config: defaultConfig(), gateway: initialized.config, cwd }, 0);
  const baseUrl = `http://127.0.0.1:${running.port}`;
  const request: TrustedFrappeMissionRequest = {
    ...mission(),
    workflow: {
      ...graph(),
      entryNodeId: "plan",
      nodes: [{ id: "plan", kind: "plan" }],
      edges: [],
    },
  };
  try {
    const accepted = await fetch(`${baseUrl}${TRUSTED_FRAPPE_MISSIONS_PATH}`, {
      method: "POST", headers: headers(initialized.config, scope, request.idempotencyKey), body: JSON.stringify(request),
    });
    assert.equal(accepted.status, 202);
    const completed = await waitForStatus(baseUrl, initialized.config, "completed");
    const node = completed.events.find((event) => event.type === "node_completed");
    assert.equal(node?.payload?.executionBoundary, "read-only-offline-codex");
    const invocations = (await readFile(argsLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    const executions = invocations.filter((args) => args.includes("exec") && args.includes("-o"));
    assert.equal(executions.length, 1);
    assert.deepEqual(executions[0].slice(executions[0].indexOf("-s"), executions[0].indexOf("-s") + 2), ["-s", "read-only"]);
    assert.equal(executions[0].some((arg) => arg.includes("sandbox_workspace_write.network_access=true")), false);
  } finally {
    await running.close();
    if (previousCommand === undefined) delete process.env.MUSTER_CODEX_COMMAND;
    else process.env.MUSTER_CODEX_COMMAND = previousCommand;
    await rm(cwd, { recursive: true, force: true });
  }
});
