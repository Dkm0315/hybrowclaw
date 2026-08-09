import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfig } from "@musterhq/core";
import {
  FRAPPE_RUN_EVENTS_PATH,
  createFrappeRunCsrfProof,
  initGatewayConfig,
  startGatewayServer,
  type AcceptedFrappeRunCommand,
  type FrappeRunCommandAction,
  type FrappeRunEvent,
  type FrappeRunEventScope,
  type GatewayConfig,
} from "../src/index.js";

const alice = Object.freeze({ tenantId: "tenant-a", siteId: "site-a", userId: "alice@example.test" });
const bob = Object.freeze({ ...alice, userId: "bob@example.test" });
const csrf = "frappe-session-csrf";

function event(sequence: number, extra: Partial<FrappeRunEvent> = {}): FrappeRunEvent {
  return {
    schemaVersion: 1,
    id: `event-${sequence}`,
    missionId: "mission-1",
    rootRunId: "run-1",
    tenantId: alice.tenantId,
    siteId: alice.siteId,
    sequence,
    type: sequence === 1 ? "mission_started" : "node_started",
    at: new Date().toISOString(),
    actorId: alice.userId,
    summary: `event ${sequence}`,
    payload: { visible: true },
    ...extra,
  };
}

function authorityHeaders(config: GatewayConfig, scope: FrappeRunEventScope): Record<string, string> {
  return {
    authorization: `Bearer ${config.token}`,
    "x-frappe-tenant-id": scope.tenantId,
    ...(scope.siteId ? { "x-frappe-site-id": scope.siteId } : {}),
    "x-frappe-user-id": scope.userId,
    "x-frappe-csrf-token": csrf,
    "x-muster-csrf-proof": createFrappeRunCsrfProof(config.token, csrf, scope),
  };
}

async function appendEvent(
  baseUrl: string,
  config: GatewayConfig,
  scope: FrappeRunEventScope,
  value: FrappeRunEvent,
  headerId = value.id,
): Promise<Response> {
  return fetch(`${baseUrl}${FRAPPE_RUN_EVENTS_PATH}`, {
    method: "POST",
    headers: { ...authorityHeaders(config, scope), "content-type": "application/json", "idempotency-key": headerId },
    body: JSON.stringify({ scope, event: value }),
  });
}

function command(action: FrappeRunCommandAction, index: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    commandId: `command-${index}`,
    action,
    missionId: "mission-1",
    rootRunId: "run-1",
    tenantId: alice.tenantId,
    siteId: alice.siteId,
    userId: alice.userId,
    issuedAt: new Date().toISOString(),
    idempotencyKey: `control-${index}`,
    csrfToken: csrf,
    ...(action === "steer" ? { payload: { instruction: "prioritize the verified report" } } : {}),
    ...extra,
  };
}

test("Frappe run HTTP endpoints enforce authority, replay scoped cursors, and durably dispatch controls", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-run-http-"));
  const initialized = await initGatewayConfig(cwd);
  const dispatched: AcceptedFrappeRunCommand[] = [];
  const options = {
    config: defaultConfig(),
    gateway: initialized.config,
    cwd,
    frappeRunEventCanRead: (item: FrappeRunEvent) => item.payload?.visible === true,
    onFrappeRunCommand: (accepted: AcceptedFrappeRunCommand) => { dispatched.push(accepted); },
  };
  const running = await startGatewayServer(options, 0);
  const baseUrl = `http://127.0.0.1:${running.port}`;
  try {
    const unauthenticated = await fetch(`${baseUrl}${FRAPPE_RUN_EVENTS_PATH}`);
    assert.equal(unauthenticated.status, 401);
    const unsigned = await fetch(`${baseUrl}${FRAPPE_RUN_EVENTS_PATH}`, {
      headers: { authorization: `Bearer ${initialized.config.token}` },
    });
    assert.equal(unsigned.status, 403);

    const firstEvent = event(1);
    const accepted = await appendEvent(baseUrl, initialized.config, alice, firstEvent, "event-1");
    assert.equal(accepted.status, 201);
    const replayedAppend = await appendEvent(baseUrl, initialized.config, alice, firstEvent, "event-1");
    assert.equal(replayedAppend.status, 200);
    assert.equal((await replayedAppend.json() as { status: string }).status, "deduplicated");
    assert.equal((await appendEvent(baseUrl, initialized.config, alice, event(2), "wrong-id")).status, 409);
    assert.equal((await appendEvent(baseUrl, initialized.config, alice, event(2, { payload: { visible: false } }))).status, 201);

    // The same authoritative event id can be projected into Bob's independent permission lane.
    assert.equal((await appendEvent(baseUrl, initialized.config, bob, firstEvent)).status, 201);
    const alicePageResponse = await fetch(`${baseUrl}${FRAPPE_RUN_EVENTS_PATH}?missionId=mission-1&limit=1`, {
      headers: authorityHeaders(initialized.config, alice),
    });
    assert.equal(alicePageResponse.status, 200);
    assert.equal(alicePageResponse.headers.get("cache-control"), "private, no-store");
    const alicePage = await alicePageResponse.json() as { events: FrappeRunEvent[]; nextCursor?: string; hasMore: boolean };
    assert.deepEqual(alicePage.events.map((item) => item.id), ["event-1"]);
    assert.ok(alicePage.nextCursor);
    assert.equal(alicePage.hasMore, false, "hidden events must not become a pagination existence oracle");

    const filteredTail = await fetch(`${baseUrl}${FRAPPE_RUN_EVENTS_PATH}?missionId=mission-1&cursor=${encodeURIComponent(alicePage.nextCursor!)}`, {
      headers: authorityHeaders(initialized.config, alice),
    });
    assert.equal(filteredTail.status, 200);
    assert.deepEqual((await filteredTail.json() as { events: FrappeRunEvent[] }).events, []);

    const crossUserCursor = await fetch(`${baseUrl}${FRAPPE_RUN_EVENTS_PATH}?missionId=mission-1&cursor=${encodeURIComponent(alicePage.nextCursor!)}`, {
      headers: authorityHeaders(initialized.config, bob),
    });
    assert.equal(crossUserCursor.status, 403);
    const bobPage = await fetch(`${baseUrl}${FRAPPE_RUN_EVENTS_PATH}?missionId=mission-1`, {
      headers: authorityHeaders(initialized.config, bob),
    });
    assert.deepEqual((await bobPage.json() as { events: FrappeRunEvent[] }).events.map((item) => item.id), ["event-1"]);

    const spoofedScope = await fetch(`${baseUrl}${FRAPPE_RUN_EVENTS_PATH}`, {
      method: "POST",
      headers: { ...authorityHeaders(initialized.config, alice), "content-type": "application/json", "idempotency-key": "event-spoof" },
      body: JSON.stringify({ scope: bob, event: event(3, { id: "event-spoof" }) }),
    });
    assert.equal(spoofedScope.status, 403);

    const commandUrl = `${baseUrl}${FRAPPE_RUN_EVENTS_PATH}/missions/mission-1/commands`;
    const missingCsrf = await fetch(commandUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${initialized.config.token}`, "content-type": "application/json", "idempotency-key": "control-1" },
      body: JSON.stringify(command("pause", 1)),
    });
    assert.equal(missingCsrf.status, 403);
    assert.equal(dispatched.length, 0);

    const invalidProof = await fetch(commandUrl, {
      method: "POST",
      headers: {
        ...authorityHeaders(initialized.config, alice),
        "x-muster-csrf-proof": "0".repeat(64),
        "content-type": "application/json",
        "idempotency-key": "control-1",
      },
      body: JSON.stringify(command("pause", 1)),
    });
    assert.equal(invalidProof.status, 403);
    assert.equal(dispatched.length, 0, "an invalid authority proof must not reach claim or dispatch");

    const controlRequests = (["pause", "cancel", "steer"] as const).map((action, index) => command(action, index + 1));
    for (const request of controlRequests) {
      const response = await fetch(commandUrl, {
        method: "POST",
        headers: { ...authorityHeaders(initialized.config, alice), "content-type": "application/json", "idempotency-key": String(request.idempotencyKey) },
        body: JSON.stringify(request),
      });
      assert.equal(response.status, 202);
    }
    assert.deepEqual(dispatched.map((item) => item.action), ["pause", "cancel", "steer"]);
    assert.equal(dispatched.some((item) => "csrfToken" in item), false, "CSRF credentials never reach dispatch or storage");

    const pauseReplay = controlRequests[0];
    const replayResponse = await fetch(commandUrl, {
      method: "POST",
      headers: { ...authorityHeaders(initialized.config, alice), "content-type": "application/json", "idempotency-key": "control-1" },
      body: JSON.stringify(pauseReplay),
    });
    assert.equal(replayResponse.status, 200);
    assert.equal((await replayResponse.json() as { status: string }).status, "replay");
    assert.equal(dispatched.filter((item) => item.action === "pause").length, 2, "replay heals a possibly failed dispatch; runtime dedupe remains authoritative");

    const conflicting = await fetch(commandUrl, {
      method: "POST",
      headers: { ...authorityHeaders(initialized.config, alice), "content-type": "application/json", "idempotency-key": "control-1" },
      body: JSON.stringify(command("steer", 9, { idempotencyKey: "control-1" })),
    });
    assert.equal(conflicting.status, 409);
    assert.equal(dispatched.length, 4);

    const wrongUser = command("cancel", 10, { userId: bob.userId });
    const wrongUserResponse = await fetch(commandUrl, {
      method: "POST",
      headers: { ...authorityHeaders(initialized.config, alice), "content-type": "application/json", "idempotency-key": "control-10" },
      body: JSON.stringify(wrongUser),
    });
    assert.equal(wrongUserResponse.status, 403);
    assert.equal(dispatched.length, 4);
  } finally {
    await running.close();
  }

  // The server-owned store closes cleanly and a fresh gateway instance replays its durable projection.
  const restarted = await startGatewayServer(options, 0);
  try {
    const response = await fetch(`http://127.0.0.1:${restarted.port}${FRAPPE_RUN_EVENTS_PATH}?missionId=mission-1`, {
      headers: authorityHeaders(initialized.config, alice),
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as { events: FrappeRunEvent[] }).events.map((item) => item.id), ["event-1"]);
  } finally {
    await restarted.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a transient control dispatch failure is durably retried without admitting a second command", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-run-dispatch-retry-"));
  const initialized = await initGatewayConfig(cwd);
  let attempts = 0;
  const running = await startGatewayServer({
    config: defaultConfig(),
    gateway: initialized.config,
    cwd,
    onFrappeRunCommand: () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient graph worker outage");
    },
  }, 0);
  try {
    const request = command("pause", 50);
    const url = `http://127.0.0.1:${running.port}${FRAPPE_RUN_EVENTS_PATH}/missions/mission-1/commands`;
    const send = () => fetch(url, {
      method: "POST",
      headers: { ...authorityHeaders(initialized.config, alice), "content-type": "application/json", "idempotency-key": "control-50" },
      body: JSON.stringify(request),
    });
    assert.equal((await send()).status, 500);
    const healed = await send();
    assert.equal(healed.status, 200);
    assert.equal((await healed.json() as { status: string }).status, "replay");
    assert.equal(attempts, 2);
  } finally {
    await running.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
