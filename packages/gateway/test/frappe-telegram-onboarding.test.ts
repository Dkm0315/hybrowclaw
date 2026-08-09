import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfig } from "@musterhq/core";
import {
  FRAPPE_TELEGRAM_LINK_PATH,
  FrappeTelegramLinkCoordinator,
  initGatewayConfig,
  resolvePairing,
  startGatewayServer,
  type GatewayConfig,
} from "../src/index.js";

const BOT_ID = "7123456789";
const TENANT_ID = "tenant-a";
const SITE = "https://erp.example.test";
const USER = "asha@example.test";
const EPOCH = "permissions-v7";
const SCOPES = ["frappe:read", "frappe:write"];

function gateway(token: string): GatewayConfig {
  return {
    token,
    telegram: {
      botToken: `${BOT_ID}:test-secret-never-logged`,
      secretToken: "verified-webhook-secret",
    },
    frappe: {
      telegramLinking: {
        enabled: true,
        botUsername: "MusterFrappeBot",
        tenants: [{ id: TENANT_ID, site: SITE, allowedScopes: SCOPES }],
      },
    },
  };
}

function authority(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { site: SITE, user: USER, tenantId: TENANT_ID, scopes: SCOPES, permissionEpoch: EPOCH, ...overrides };
}

function telegramUpdate(updateId: number, senderId: number, text: string): Record<string, unknown> {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: senderId },
      chat: { id: senderId, type: "private" },
      text,
    },
  };
}

test("Frappe issue -> Telegram /start -> Frappe confirm binds without generic operator pairing", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-telegram-e2e-"));
  const initialized = await initGatewayConfig(cwd);
  const sent: Array<Record<string, unknown>> = [];
  const fetcher: typeof fetch = async (_url, init) => {
    if (init?.body) sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const coordinator = new FrappeTelegramLinkCoordinator();
  const running = await startGatewayServer({
    config: defaultConfig(),
    gateway: gateway(initialized.config.token),
    cwd,
    fetcher,
    frappeTelegramLinks: coordinator,
  }, 0);
  const base = `http://127.0.0.1:${running.port}`;
  const adminHeaders = { authorization: `Bearer ${initialized.config.token}`, "content-type": "application/json" };
  try {
    assert.equal((await fetch(`${base}${FRAPPE_TELEGRAM_LINK_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "issue", ...authority() }),
    })).status, 401);
    const issue = await fetch(`${base}${FRAPPE_TELEGRAM_LINK_PATH}`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ action: "issue", ...authority(), allowedChatTypes: ["private"] }),
    });
    assert.equal(issue.status, 201);
    assert.equal(issue.headers.get("cache-control"), "private, no-store");
    const issued = await issue.json() as { linkId: string; startUrl: string };
    const token = new URL(issued.startUrl).searchParams.get("start");
    assert.match(token ?? "", /^[A-Za-z0-9_-]{43}$/);

    const observed = await fetch(`${base}/v1/adapters/telegram`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "verified-webhook-secret" },
      body: JSON.stringify(telegramUpdate(81001, 123456789, `/start ${token}`)),
    });
    assert.equal(observed.status, 200);
    await running.waitForIdle();
    assert.match(String(sent.at(-1)?.text), /Return to Muster in Frappe/i);
    assert.equal(await resolvePairing("telegram:bot", "123456789", cwd), undefined, "Telegram observation alone must not bind identity");

    const confirm = await fetch(`${base}${FRAPPE_TELEGRAM_LINK_PATH}`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        action: "confirm",
        linkId: issued.linkId,
        ...authority(),
        identity: { site: SITE, user: USER, roles: ["Employee"], permissionHash: EPOCH, employee: "EMP-0042" },
      }),
    });
    assert.equal(confirm.status, 200);
    const confirmed = await confirm.json() as { telegramUserId: string; telegramChatId: string };
    assert.equal(confirmed.telegramUserId, "123456789");
    assert.equal(confirmed.telegramChatId, "123456789");
    const paired = await resolvePairing("telegram:bot", "123456789", cwd);
    assert.equal(paired?.identity?.user, USER);
    assert.equal(paired?.identity?.telegramLink?.linkId, issued.linkId);
    assert.equal(paired?.identity?.permissionHash, EPOCH);

    const replay = await fetch(`${base}/v1/adapters/telegram`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "verified-webhook-secret" },
      body: JSON.stringify(telegramUpdate(81002, 999999999, `/start ${token}`)),
    });
    assert.equal(replay.status, 200);
    await running.waitForIdle();
    assert.match(String(sent.at(-1)?.text), /unavailable/i);
    assert.equal(await resolvePairing("telegram:bot", "999999999", cwd), undefined);
  } finally {
    await running.close();
  }
});

test("tenant, site, permission-epoch, replay, and rebind attacks fail closed through the gateway RPC", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-telegram-negative-"));
  const initialized = await initGatewayConfig(cwd);
  const sent: Array<Record<string, unknown>> = [];
  const fetcher: typeof fetch = async (_url, init) => {
    if (init?.body) sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const running = await startGatewayServer({ config: defaultConfig(), gateway: gateway(initialized.config.token), cwd, fetcher }, 0);
  const base = `http://127.0.0.1:${running.port}`;
  const headers = { authorization: `Bearer ${initialized.config.token}`, "content-type": "application/json" };
  const rpc = (body: Record<string, unknown>) => fetch(`${base}${FRAPPE_TELEGRAM_LINK_PATH}`, { method: "POST", headers, body: JSON.stringify(body) });
  try {
    assert.equal((await rpc({ action: "issue", ...authority({ tenantId: "tenant-b" }) })).status, 403);
    assert.equal((await rpc({ action: "issue", ...authority({ site: "https://evil.example.test" }) })).status, 403);

    const issue = await rpc({ action: "issue", ...authority() });
    const issued = await issue.json() as { linkId: string; startUrl: string };
    const token = new URL(issued.startUrl).searchParams.get("start");
    await fetch(`${base}/v1/adapters/telegram`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "verified-webhook-secret" },
      body: JSON.stringify(telegramUpdate(82001, 222222222, `/start ${token}`)),
    });
    await running.waitForIdle();

    const wrongEpoch = await rpc({
      action: "confirm",
      linkId: issued.linkId,
      ...authority({ permissionEpoch: "permissions-v8" }),
      identity: { site: SITE, user: USER, roles: ["Employee"], permissionHash: "permissions-v8" },
    });
    assert.equal(wrongEpoch.status, 403);
    const wrongTenant = await rpc({
      action: "confirm",
      linkId: issued.linkId,
      ...authority({ tenantId: "tenant-b" }),
      identity: { site: SITE, user: USER, roles: ["Employee"], permissionHash: EPOCH },
    });
    assert.equal(wrongTenant.status, 403);

    const confirmed = await rpc({
      action: "confirm",
      linkId: issued.linkId,
      ...authority(),
      identity: { site: SITE, user: USER, roles: ["Employee"], permissionHash: EPOCH },
    });
    assert.equal(confirmed.status, 200);
    assert.equal((await rpc({ action: "confirm", linkId: issued.linkId, ...authority(), identity: { site: SITE, user: USER, roles: ["Employee"], permissionHash: EPOCH } })).status, 403);

    const rebound = await rpc({ action: "rebind", tenantId: TENANT_ID, site: SITE });
    assert.equal(rebound.status, 200);
    assert.deepEqual(await rebound.json(), { ok: true, invalidated: 1, identitiesCleared: 1 });
    assert.equal((await resolvePairing("telegram:bot", "222222222", cwd))?.identity, undefined, "rebind clears channel authority immediately");
    await fetch(`${base}/v1/adapters/telegram`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "verified-webhook-secret" },
      body: JSON.stringify(telegramUpdate(82002, 222222222, "Show my tasks")),
    });
    await running.waitForIdle();
    assert.match(String(sent.at(-1)?.text), /Connect this chat from Muster inside Frappe/i);
    assert.equal((await resolvePairing("telegram:bot", "222222222", cwd))?.identity, undefined);
  } finally {
    await running.close();
  }
});
