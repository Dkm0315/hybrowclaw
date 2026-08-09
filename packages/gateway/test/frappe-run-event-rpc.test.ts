import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfig } from "@musterhq/core";
import { createRpcCore } from "../src/rpc.js";
import type { AcceptedFrappeRunCommand, FrappeRunCommandAction, FrappeRunEvent } from "../src/frappe-run-events.js";

const scope = Object.freeze({ tenantId: "tenant-rpc", siteId: "site-rpc", userId: "rpc@example.test" });
const csrfToken = "rpc-frappe-csrf";

function event(sequence: number, visible = true): FrappeRunEvent {
  return {
    schemaVersion: 1,
    id: `rpc-event-${sequence}`,
    missionId: "rpc-mission",
    rootRunId: "rpc-run",
    tenantId: scope.tenantId,
    siteId: scope.siteId,
    sequence,
    type: sequence === 1 ? "mission_started" : "node_started",
    at: new Date().toISOString(),
    actorId: scope.userId,
    summary: `RPC event ${sequence}`,
    payload: { visible },
  };
}

function command(action: FrappeRunCommandAction, index: number): Record<string, unknown> {
  return {
    schemaVersion: 1,
    commandId: `rpc-command-${index}`,
    action,
    missionId: "rpc-mission",
    rootRunId: "rpc-run",
    tenantId: scope.tenantId,
    siteId: scope.siteId,
    userId: scope.userId,
    issuedAt: new Date().toISOString(),
    idempotencyKey: `rpc-control-${index}`,
    csrfToken,
    ...(action === "steer" ? { payload: { instruction: "continue with verified evidence" } } : {}),
  };
}

test("RPC run-event methods use host authority, durable cursors, filtering, CSRF, and idempotent controls", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-run-rpc-"));
  const dispatched: AcceptedFrappeRunCommand[] = [];
  const options = {
    config: defaultConfig(),
    cwd,
    frappeRunEventScope: scope,
    frappeRunEventCanRead: (item: FrappeRunEvent) => item.payload?.visible === true,
    frappeRunCommandCsrfToken: csrfToken,
    onFrappeRunCommand: (accepted: AcceptedFrappeRunCommand) => { dispatched.push(accepted); },
  };
  const core = createRpcCore(options);
  try {
    const first = event(1);
    const appended = await core.handle({
      jsonrpc: "2.0", id: 1, method: "frappe.runEvents.append",
      params: { event: first, idempotencyKey: first.id },
    });
    assert.equal((appended.result as { status: string }).status, "appended");
    const replayed = await core.handle({
      jsonrpc: "2.0", id: 2, method: "frappe.runEvents.append",
      params: { event: first, idempotencyKey: first.id },
    });
    assert.equal((replayed.result as { status: string }).status, "deduplicated");
    const hidden = event(2, false);
    assert.equal((await core.handle({
      jsonrpc: "2.0", id: 3, method: "frappe.runEvents.append",
      params: { event: hidden, idempotencyKey: hidden.id },
    })).error, undefined);

    const forged = { ...event(3), tenantId: "tenant-other" };
    const rejected = await core.handle({
      jsonrpc: "2.0", id: 4, method: "frappe.runEvents.append",
      params: { event: forged, idempotencyKey: forged.id, tenantId: "tenant-other" },
    });
    assert.match(rejected.error?.message ?? "", /authority/i);

    const page = await core.handle({
      jsonrpc: "2.0", id: 5, method: "frappe.runEvents.replay",
      params: { missionId: "rpc-mission", limit: 10, tenantId: "tenant-other", userId: "other@example.test" },
    });
    const pageResult = page.result as { events: FrappeRunEvent[]; nextCursor?: string };
    assert.deepEqual(pageResult.events.map((item) => item.id), [first.id], "params cannot widen the host-provided authority");
    assert.ok(pageResult.nextCursor);

    const missingCsrf = command("pause", 1);
    missingCsrf.csrfToken = "wrong";
    const csrfRejected = await core.handle({
      jsonrpc: "2.0", id: 6, method: "frappe.runCommands.submit",
      params: { command: missingCsrf, idempotencyKey: "rpc-control-1" },
    });
    assert.match(csrfRejected.error?.message ?? "", /CSRF/i);
    assert.equal(dispatched.length, 0);

    const controls = (["pause", "cancel", "steer"] as const).map((action, index) => command(action, index + 1));
    for (const [index, request] of controls.entries()) {
      const response = await core.handle({
        jsonrpc: "2.0", id: 7 + index, method: "frappe.runCommands.submit",
        params: { command: request, idempotencyKey: request.idempotencyKey },
      });
      assert.equal((response.result as { status: string }).status, "claimed");
    }
    assert.deepEqual(dispatched.map((item) => item.action), ["pause", "cancel", "steer"]);
    const replay = await core.handle({
      jsonrpc: "2.0", id: 10, method: "frappe.runCommands.submit",
      params: { command: controls[0], idempotencyKey: controls[0].idempotencyKey },
    });
    assert.equal((replay.result as { status: string }).status, "replay");
    assert.equal(dispatched.filter((item) => item.action === "pause").length, 2);
  } finally {
    core.close();
  }

  const restarted = createRpcCore(options);
  try {
    const page = await restarted.handle({
      jsonrpc: "2.0", id: 11, method: "frappe.runEvents.replay", params: { missionId: "rpc-mission" },
    });
    assert.deepEqual((page.result as { events: FrappeRunEvent[] }).events.map((item) => item.id), ["rpc-event-1"]);
  } finally {
    restarted.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("RPC Frappe methods fail closed when host authority and dispatch are not configured", async () => {
  const core = createRpcCore({ config: defaultConfig() });
  try {
    const response = await core.handle({ jsonrpc: "2.0", id: 1, method: "frappe.runEvents.replay" });
    assert.match(response.error?.message ?? "", /authority is unavailable/i);
  } finally {
    core.close();
  }
});
