import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfig } from "@musterhq/core";
import { dispatchCommand } from "../src/commands.js";
import type { CommandContext } from "../src/commands.js";
import type { FrappeOAuthActor, FrappeOAuthCoordinator } from "../src/frappe-oauth.js";
import { resolvePairing } from "../src/pairing.js";
import type { PairedIdentity, PairedSender } from "../src/pairing.js";
import type { SurfaceMessage } from "../src/envelope.js";

const CONNECTION_ID = "oxygenhr";
const ACTOR: FrappeOAuthActor = {
  surfaceId: "telegram:oxygenhr",
  senderId: "42",
  pairingId: "pair_42",
};
const PAIRED: PairedSender = {
  pairingId: ACTOR.pairingId,
  surfaceId: ACTOR.surfaceId,
  senderId: ACTOR.senderId,
  approvedAt: "2026-07-14T00:00:00.000Z",
};
const IDENTITY: Omit<PairedIdentity, "provider" | "resolvedAt"> = {
  site: "https://erp.example.test",
  user: "asha@example.test",
  employee: "EMP-0042",
  employeeName: "Asha Example",
  employeeStatus: "Active",
  roles: ["Employee"],
  department: "People",
  authMode: "oauth_bearer",
};

const message = (text: string): SurfaceMessage => ({
  ...ACTOR,
  conversationId: "chat-1",
  text,
});

function context(
  cwd: string,
  coordinator: Partial<FrappeOAuthCoordinator>,
  paired: PairedSender = PAIRED,
  defaultConnection: string | undefined = CONNECTION_ID,
): CommandContext {
  return {
    config: defaultConfig(),
    profile: "telegram",
    paired,
    gateway: {
      token: "gateway-token",
      frappe: { oauth: { defaultConnection, connections: [] } },
    },
    cwd,
    conversationKey: "telegram:oxygenhr:chat-1",
    frappeOAuth: coordinator as FrappeOAuthCoordinator,
  };
}

function coordinator(overrides: Partial<FrappeOAuthCoordinator> = {}): Partial<FrappeOAuthCoordinator> {
  return {
    connectionIds: () => [CONNECTION_ID],
    complete: async () => ({ status: "expired" as const }),
    start: async () => ({
      status: "authorization_required" as const,
      connectionId: CONNECTION_ID,
      authorizationUrl: "https://erp.example.test/api/method/frappe.integrations.oauth2.authorize?state=private-state-1234567890",
      expiresAt: "2026-07-14T00:05:00.000Z",
    }),
    disconnect: async () => false,
    ...overrides,
  };
}

test("Frappe pairing start names the connection, exposes only the private auth URL, and bounds expiry", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-pairing-ux-start-"));
  try {
    const reply = await dispatchCommand(message("/pair start oxygenhr"), context(cwd, coordinator()));
    assert.ok(reply);
    assert.equal(reply.presentation?.title, "Connect Frappe");
    assert.match(reply.text, /Connection oxygenhr/);
    assert.match(reply.text, /private authorization link/);
    assert.match(reply.text, /private-state-1234567890/);
    assert.match(reply.text, /Expires: 2026-07-14T00:05:00\.000Z/);
    assert.match(reply.text, /\/pair status oxygenhr/);
    assert.doesNotMatch(reply.text, /access-token|client-secret|code_verifier/i);
    assert.deepEqual(reply.presentation?.actions?.map((action) => action.command), [
      "/pair status oxygenhr",
      "/pair restart oxygenhr",
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Frappe pairing status is compact for pending, expired, and failed consent", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-pairing-ux-status-"));
  try {
    const pending = await dispatchCommand(message("/pair status oxygenhr"), context(cwd, coordinator({
      complete: async () => ({ status: "pending" as const, expiresAt: "2026-07-14T00:05:00.000Z" }),
    })));
    assert.ok(pending);
    assert.equal(pending.presentation?.title, "Frappe authorization pending");
    assert.match(pending.text, /Expires: 2026-07-14T00:05:00\.000Z/);
    assert.match(pending.text, /approving in Frappe/i);
    assert.match(pending.text, /\/pair restart oxygenhr/);

    const expired = await dispatchCommand(message("/pair status oxygenhr"), context(cwd, coordinator()));
    assert.ok(expired);
    assert.equal(expired.presentation?.title, "Frappe authorization expired");
    assert.match(expired.text, /no Frappe identity was bound/i);
    assert.match(expired.text, /\/pair restart oxygenhr/);

    const failed = await dispatchCommand(message("/pair status oxygenhr"), context(cwd, coordinator({
      complete: async () => { throw new Error("OAuth state private-state-1234567890 failed with access-token-secret"); },
    })));
    assert.ok(failed);
    assert.equal(failed.presentation?.title, "Frappe authorization failed");
    assert.doesNotMatch(failed.text, /private-state|access-token-secret/);
    assert.match(failed.text, /\/pair restart oxygenhr/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Frappe pairing restart clears failed consent before issuing a new authorization", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-pairing-ux-restart-"));
  const calls: string[] = [];
  try {
    const reply = await dispatchCommand(message("/pair restart oxygenhr"), context(cwd, coordinator({
      disconnect: async () => { calls.push("disconnect"); return true; },
      start: async () => {
        calls.push("start");
        return {
          status: "authorization_required" as const,
          connectionId: CONNECTION_ID,
          authorizationUrl: "https://erp.example.test/authorize?state=new-private-state",
          expiresAt: "2026-07-14T00:10:00.000Z",
        };
      },
    })));
    assert.ok(reply);
    assert.deepEqual(calls, ["disconnect", "start"]);
    assert.match(reply.text, /new-private-state/);
    assert.match(reply.text, /Expires: 2026-07-14T00:10:00\.000Z/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Frappe pairing confirms exact identity and disconnect removes the bound identity", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-pairing-ux-identity-"));
  try {
    const connected = await dispatchCommand(message("/pair status oxygenhr"), context(cwd, coordinator({
      complete: async () => ({ status: "connected" as const, identity: IDENTITY }),
    })));
    assert.ok(connected);
    assert.equal(connected.presentation?.title, "Frappe connected");
    assert.match(connected.text, /Confirmed Frappe identity/);
    assert.match(connected.text, /https:\/\/erp\.example\.test/);
    assert.match(connected.text, /asha@example\.test/);
    assert.match(connected.text, /Asha Example \(EMP-0042\)/);
    assert.doesNotMatch(connected.text, /Bearer|access-token|rolesHash|permissionHash/i);

    const persisted = await resolvePairing(ACTOR.surfaceId, ACTOR.senderId, cwd);
    assert.ok(persisted);
    assert.equal(persisted?.identity?.user, IDENTITY.user);

    const disconnected = await dispatchCommand(message("/pair disconnect oxygenhr"), context(cwd, coordinator({
      disconnect: async () => true,
    }), persisted));
    assert.ok(disconnected);
    assert.equal(disconnected.presentation?.title, "Frappe disconnected");
    assert.doesNotMatch(disconnected.text, /Bearer|access-token|private-state/i);
    assert.equal((await resolvePairing(ACTOR.surfaceId, ACTOR.senderId, cwd))?.identity, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Frappe pairing rejects ambiguous connection selection without inventing config", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-pairing-ux-connections-"));
  try {
    const twoConnections = coordinator({ connectionIds: () => ["oxygenhr", "sandbox"] });
    const reply = await dispatchCommand(message("/pair start"), context(cwd, twoConnections, PAIRED, ""));
    assert.ok(reply);
    assert.equal(reply.presentation?.title, "Pair Frappe");
    assert.match(reply.text, /Connections: oxygenhr, sandbox/);
    assert.match(reply.text, /\/pair start <connection-id>/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
