import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  FrappeTelegramLinkCoordinator,
  InMemoryFrappeTelegramLinkStore,
  openSqliteFrappeTelegramLinkCoordinator,
  type FrappeTelegramAuthority,
  type FrappeTelegramLinkAuditEvent,
  type FrappeTelegramLinkStore,
} from "../src/frappe-telegram-link.js";

const authority: FrappeTelegramAuthority = {
  site: "https://erp.example.test",
  user: "asha@example.test",
  tenantId: "tenant-a",
  botId: "7123456789",
  scopes: ["read:Task", "write:ToDo"],
  permissionEpoch: "roles-v7",
};

test("issues an opaque short-lived token and activates only after exact redemption and Frappe confirmation", () => {
  let now = Date.parse("2026-07-19T08:00:00.000Z");
  const events: FrappeTelegramLinkAuditEvent[] = [];
  const coordinator = new FrappeTelegramLinkCoordinator({ now: () => now, audit: (event) => events.push(event) });

  const issued = coordinator.issue({ ...authority, scopes: ["write:ToDo", "read:Task", "read:Task"], ttlMs: 60_000 });
  assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.expiresAt, "2026-07-19T08:01:00.000Z");

  now += 1_000;
  const redeemed = coordinator.redeem({
    ...authority,
    scopes: ["read:Task", "write:ToDo"],
    token: issued.token,
    telegramUserId: "123456789",
    telegramChatId: "123456789",
    chatType: "private",
  });
  assert.deepEqual(redeemed, {
    ok: true,
    value: {
      linkId: issued.linkId,
      identity: { telegramUserId: "123456789", telegramChatId: "123456789", chatType: "private" },
    },
  });

  now += 1_000;
  const confirmed = coordinator.confirm({ ...authority, linkId: issued.linkId });
  assert.equal(confirmed.ok, true);
  if (!confirmed.ok) return;
  assert.deepEqual(confirmed.value, {
    linkId: issued.linkId,
    ...authority,
    telegramUserId: "123456789",
    telegramChatId: "123456789",
    chatType: "private",
    linkedAt: "2026-07-19T08:00:02.000Z",
  });
  assert.deepEqual(events.map((event) => event.action), ["issued", "redeemed", "confirmed"]);
  assert.equal(JSON.stringify(events).includes(issued.token), false);
});

test("all malformed, wrong-binding, expiry, replay, and changed-permission failures are uniform", () => {
  let now = 1_800_000_000_000;
  const reasons: string[] = [];
  const coordinator = new FrappeTelegramLinkCoordinator({
    now: () => now,
    audit: (event) => { if (event.action === "denied") reasons.push(event.reason); },
  });
  const generic = {
    ok: false,
    code: "link_denied",
    message: "This Telegram identity link is unavailable. Start a new link from Frappe.",
  };

  const malformed = coordinator.redeem({ ...authority, token: "not-a-token", telegramUserId: "name", telegramChatId: "1", chatType: "private" });
  assert.deepEqual(malformed, generic);

  const wrongSite = coordinator.issue({ ...authority, ttlMs: 30_000 });
  assert.deepEqual(coordinator.redeem({
    ...authority,
    site: "https://other.example.test",
    token: wrongSite.token,
    telegramUserId: "101",
    telegramChatId: "101",
    chatType: "private",
  }), generic);

  const wrongBot = coordinator.issue({ ...authority, ttlMs: 30_000 });
  assert.deepEqual(coordinator.redeem({
    ...authority,
    botId: "987654321",
    token: wrongBot.token,
    telegramUserId: "101",
    telegramChatId: "101",
    chatType: "private",
  }), generic);

  const wrongEpoch = coordinator.issue({ ...authority, ttlMs: 30_000 });
  assert.deepEqual(coordinator.redeem({
    ...authority,
    permissionEpoch: "roles-v8",
    token: wrongEpoch.token,
    telegramUserId: "101",
    telegramChatId: "101",
    chatType: "private",
  }), generic);

  const wrongChat = coordinator.issue({ ...authority, ttlMs: 30_000 });
  assert.deepEqual(coordinator.redeem({
    ...authority,
    token: wrongChat.token,
    telegramUserId: "101",
    telegramChatId: "-100123",
    chatType: "supergroup",
  }), generic);

  const expired = coordinator.issue({ ...authority, ttlMs: 30_000 });
  now += 30_001;
  assert.deepEqual(coordinator.redeem({
    ...authority,
    token: expired.token,
    telegramUserId: "101",
    telegramChatId: "101",
    chatType: "private",
  }), generic);

  const replay = coordinator.issue({ ...authority });
  const attempt = { ...authority, token: replay.token, telegramUserId: "101", telegramChatId: "101", chatType: "private" as const };
  assert.equal(coordinator.redeem(attempt).ok, true);
  assert.deepEqual(coordinator.redeem(attempt), generic);
  assert.deepEqual(coordinator.confirm({ ...authority, linkId: replay.linkId }).ok, true);
  assert.deepEqual(coordinator.confirm({ ...authority, linkId: replay.linkId }), generic);

  assert.deepEqual(reasons, ["malformed", "wrong_binding", "wrong_binding", "permission_changed", "chat_type", "expired", "replayed", "replayed"]);
});

test("redemption is atomically single-use even when two promises race", async () => {
  const coordinator = new FrappeTelegramLinkCoordinator();
  const issued = coordinator.issue(authority);
  const attempt = { ...authority, token: issued.token, telegramUserId: "222", telegramChatId: "222", chatType: "private" as const };
  const results = await Promise.all([Promise.resolve().then(() => coordinator.redeem(attempt)), Promise.resolve().then(() => coordinator.redeem(attempt))]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok).length, 1);
});

test("numeric Telegram identities are canonical and non-numeric identity claims fail closed", () => {
  const coordinator = new FrappeTelegramLinkCoordinator();
  const issued = coordinator.issue(authority);
  assert.equal(coordinator.redeem({ ...authority, token: issued.token, telegramUserId: "@asha", telegramChatId: "123", chatType: "private" }).ok, false);
  const issued2 = coordinator.issue(authority);
  const redeemed = coordinator.redeem({ ...authority, token: issued2.token, telegramUserId: "000123", telegramChatId: "000123", chatType: "private" });
  assert.deepEqual(redeemed.ok && redeemed.value.identity, { telegramUserId: "123", telegramChatId: "123", chatType: "private" });
});

test("active links fail immediately after permission epoch changes, explicit revocation, or site rebind", () => {
  const coordinator = new FrappeTelegramLinkCoordinator();
  const activate = (telegramUserId: string) => {
    const issued = coordinator.issue(authority);
    assert.equal(coordinator.redeem({ ...authority, token: issued.token, telegramUserId, telegramChatId: telegramUserId, chatType: "private" }).ok, true);
    assert.equal(coordinator.confirm({ ...authority, linkId: issued.linkId }).ok, true);
    return issued.linkId;
  };

  const epochLink = activate("301");
  assert.equal(coordinator.resolveActive(epochLink, { ...authority, permissionEpoch: "roles-v8" }).ok, false);
  assert.equal(coordinator.resolveActive(epochLink, authority).ok, false, "epoch mismatch permanently revokes the stale link");

  const revokedLink = activate("302");
  assert.equal(coordinator.revoke({ linkId: revokedLink, site: authority.site, user: authority.user, tenantId: authority.tenantId }).ok, true);
  assert.equal(coordinator.resolveActive(revokedLink, authority).ok, false);

  const reboundLink = activate("303");
  assert.equal(coordinator.invalidateForRebind({ site: authority.site, tenantId: authority.tenantId }), 1);
  assert.equal(coordinator.resolveActive(reboundLink, authority).ok, false);
});

test("confirmation denies cross-account collisions within the same tenant and bot", () => {
  const coordinator = new FrappeTelegramLinkCoordinator();
  const first = coordinator.issue(authority);
  assert.equal(coordinator.redeem({ ...authority, token: first.token, telegramUserId: "401", telegramChatId: "401", chatType: "private" }).ok, true);
  assert.equal(coordinator.confirm({ ...authority, linkId: first.linkId }).ok, true);

  const other = { ...authority, user: "ravi@example.test" };
  const second = coordinator.issue(other);
  assert.equal(coordinator.redeem({ ...other, token: second.token, telegramUserId: "401", telegramChatId: "401", chatType: "private" }).ok, true);
  assert.equal(coordinator.confirm({ ...other, linkId: second.linkId }).ok, false);

  const duplicate = coordinator.issue(authority);
  assert.equal(coordinator.redeem({ ...authority, token: duplicate.token, telegramUserId: "401", telegramChatId: "401", chatType: "private" }).ok, true);
  assert.equal(coordinator.confirm({ ...authority, linkId: duplicate.linkId }).ok, false, "an already active identity cannot create duplicate bindings");
});

test("every authority component is bound into the one-time state", () => {
  const variants: ReadonlyArray<Partial<FrappeTelegramAuthority>> = [
    { site: "https://other.example.test" },
    { user: "ravi@example.test" },
    { tenantId: "tenant-b" },
    { botId: "8123456789" },
    { scopes: ["read:Task"] },
    { permissionEpoch: "roles-v8" },
  ];
  const genericMessage = "This Telegram identity link is unavailable. Start a new link from Frappe.";
  for (const variant of variants) {
    const coordinator = new FrappeTelegramLinkCoordinator();
    const issued = coordinator.issue(authority);
    const result = coordinator.redeem({
      ...authority,
      ...variant,
      token: issued.token,
      telegramUserId: "501",
      telegramChatId: "501",
      chatType: "private",
    });
    assert.equal(result.ok, false, JSON.stringify(variant));
    if (!result.ok) assert.equal(result.message, genericMessage);
  }
});

test("a revoked identity can be explicitly rebound but stale tokens remain dead", () => {
  const coordinator = new FrappeTelegramLinkCoordinator();
  const first = coordinator.issue(authority);
  const firstAttempt = { ...authority, token: first.token, telegramUserId: "601", telegramChatId: "601", chatType: "private" as const };
  assert.equal(coordinator.redeem(firstAttempt).ok, true);
  assert.equal(coordinator.confirm({ ...authority, linkId: first.linkId }).ok, true);
  assert.equal(coordinator.revoke({ linkId: first.linkId, site: authority.site, user: authority.user, tenantId: authority.tenantId }).ok, true);
  assert.equal(coordinator.redeem(firstAttempt).ok, false);

  const second = coordinator.issue(authority);
  assert.equal(coordinator.redeem({ ...authority, token: second.token, telegramUserId: "602", telegramChatId: "602", chatType: "private" }).ok, true);
  assert.equal(coordinator.confirm({ ...authority, linkId: second.linkId }).ok, true);
});

test("update-id dedupe is bot-bound, atomic, expiring, and rejects invalid ids", () => {
  let now = 1_800_000_000_000;
  const coordinator = new FrappeTelegramLinkCoordinator({ now: () => now });
  assert.equal(coordinator.claimTelegramUpdate(authority.botId, "0", 60_000), true);
  assert.equal(coordinator.claimTelegramUpdate(authority.botId, "0", 60_000), false);
  assert.equal(coordinator.claimTelegramUpdate("987654321", "0", 60_000), true);
  assert.equal(coordinator.claimTelegramUpdate(authority.botId, "not-numeric", 60_000), false);
  assert.equal(coordinator.claimTelegramUpdate(authority.botId, "1", Number.NaN), false);
  now += 60_001;
  assert.equal(coordinator.claimTelegramUpdate(authority.botId, "0", 60_000), true);
});

test("storage receives only a token hash, never the redeemable opaque token", () => {
  let persistedHash = "";
  const delegate = new InMemoryFrappeTelegramLinkStore();
  const store: FrappeTelegramLinkStore = {
    insert: (record) => { persistedHash = record.tokenHash; delegate.insert(record); },
    redeem: (...args) => delegate.redeem(...args),
    redeemObserved: (...args) => delegate.redeemObserved(...args),
    confirm: (...args) => delegate.confirm(...args),
    revoke: (...args) => delegate.revoke(...args),
    resolve: (...args) => delegate.resolve(...args),
    invalidateForRebind: (...args) => delegate.invalidateForRebind(...args),
  };
  const coordinator = new FrappeTelegramLinkCoordinator({ store });
  const issued = coordinator.issue(authority);
  assert.notEqual(persistedHash, issued.token);
  assert.match(persistedHash, /^[A-Za-z0-9_-]{43}$/);
});

test("SQLite state survives restart and two gateway instances cannot redeem one token", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-telegram-link-sqlite-"));
  const filename = join(cwd, "links.db");
  const issuer = openSqliteFrappeTelegramLinkCoordinator(filename);
  const issued = issuer.issue(authority);
  issuer.close();

  const first = openSqliteFrappeTelegramLinkCoordinator(filename);
  const second = openSqliteFrappeTelegramLinkCoordinator(filename);
  try {
    const observation = { token: issued.token, botId: authority.botId, telegramUserId: "701", telegramChatId: "701", chatType: "private" as const };
    const results = await Promise.all([
      Promise.resolve().then(() => first.redeemFromTelegram(observation)),
      Promise.resolve().then(() => second.redeemFromTelegram(observation)),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => !result.ok).length, 1);
    assert.equal(second.confirm({ ...authority, linkId: issued.linkId }).ok, true);
  } finally {
    first.close();
    second.close();
  }
});
