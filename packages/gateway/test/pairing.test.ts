import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  approvePairing,
  loadPairings,
  pairingScopes,
  requestPairing,
  resolvePairing,
  upsertTrustedFrappePairing,
} from "../src/index.js";

test("unpaired sender gets a stable pairing code until approved", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-pairing-"));
  const first = await requestPairing("telegram:bot", "12345", cwd);
  assert.match(first.code, /^[A-Z2-9]{8}$/);

  const second = await requestPairing("telegram:bot", "12345", cwd);
  assert.equal(second.code, first.code, "repeated requests reuse the same code");

  const other = await requestPairing("telegram:bot", "67890", cwd);
  assert.notEqual(other.code, first.code, "different senders get different codes");

  assert.equal(await resolvePairing("telegram:bot", "12345", cwd), undefined);
});

test("concurrent pairing requests are serialized without lost senders or duplicate codes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-pairing-concurrent-"));
  const sameSender = await Promise.all(Array.from({ length: 16 }, () => requestPairing("telegram:bot", "same", cwd)));
  assert.equal(new Set(sameSender.map((entry) => entry.code)).size, 1);
  await Promise.all(Array.from({ length: 16 }, (_, index) => requestPairing("telegram:bot", `sender-${index}`, cwd)));
  const store = await loadPairings(cwd);
  assert.equal(store.pending.length, 17);
  assert.equal(new Set(store.pending.map((entry) => entry.code)).size, 17);
});

test("approvePairing mints a pairingId and the sender resolves afterwards", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-pairing-approve-"));
  const pending = await requestPairing("slack:T024", "U1", cwd);
  const paired = await approvePairing(pending.code, cwd);
  assert.match(paired.pairingId, /^pair_[0-9a-f]{8}$/);
  assert.equal(paired.surfaceId, "slack:T024");
  assert.equal(paired.senderId, "U1");

  const resolved = await resolvePairing("slack:T024", "U1", cwd);
  assert.equal(resolved?.pairingId, paired.pairingId);

  const store = await loadPairings(cwd);
  assert.equal(store.pending.length, 0, "approved pairing leaves the pending list");
  assert.equal(store.paired.length, 1);
});

test("approvePairing rejects unknown codes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-pairing-unknown-"));
  await assert.rejects(() => approvePairing("NOPE1234", cwd), /No pending pairing/);
});

test("pairingScopes grants exactly the pairing lane and the resolved user lane", () => {
  const scopes = pairingScopes({
    pairingId: "pair_abcd1234",
    surfaceId: "telegram:bot",
    senderId: "12345",
    approvedAt: new Date().toISOString(),
  });
  assert.deepEqual(scopes, [
    { kind: "pairing", id: "telegram:bot:12345" },
    { kind: "user", id: "pair_abcd1234" },
  ]);
});

test("approved pairings can carry Frappe user and employee identity scopes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-pairing-frappe-"));
  const pending = await requestPairing("slack:T024", "U1", cwd);
  const paired = await approvePairing(pending.code, cwd, {
    provider: "frappe",
    site: "https://erp.example.test",
    user: "dhairya@example.test",
    employee: "EMP-0001",
    employeeName: "Dhairya",
    roles: ["HR User", "Employee"],
    department: "People",
    company: "Example",
    permissionHash: "permhash",
    rolesHash: "roleshash",
    authMode: "oauth_bearer",
  });
  assert.equal(paired.identity?.provider, "frappe");
  assert.equal(paired.identity?.user, "dhairya@example.test");
  assert.deepEqual(paired.identity?.roles, ["Employee", "HR User"]);

  const scopes = pairingScopes(paired);
  assert.deepEqual(scopes.slice(0, 5), [
    { kind: "pairing", id: "slack:T024:U1" },
    { kind: "user", id: paired.pairingId },
    { kind: "tenant", id: "https://erp.example.test" },
    { kind: "user", id: "frappe:dhairya@example.test" },
    { kind: "user", id: "frappe-employee:EMP-0001" },
  ]);
  assert.equal(scopes[5]?.kind, "persona");
  assert.match(scopes[5]?.id ?? "", /^frappe-permissions:[a-f0-9]{64}$/);
  assert.equal(scopes.length, 6);
});

test("trusted Frappe ingress creates and refreshes one identity-bound pairing", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-pairing-trusted-frappe-"));
  const enterpriseRoles = ["Employee", ...Array.from({ length: 233 }, (_, index) => `Custom Role ${index + 1}`)];
  const pending = await requestPairing("frappe:erp.example.test", "employee@example.test", cwd);
  assert.ok(pending.code);

  const first = await upsertTrustedFrappePairing("frappe:erp.example.test", "employee@example.test", {
    site: "https://erp.example.test/",
    user: "employee@example.test",
    employee: "EMP-0042",
    roles: ["Employee", "Employee"],
    department: "Operations",
    authMode: "frappe_session",
  }, cwd);
  const refreshed = await upsertTrustedFrappePairing("frappe:erp.example.test", "employee@example.test", {
    site: "https://erp.example.test",
    user: "employee@example.test",
    employee: "EMP-0042",
    roles: enterpriseRoles,
    department: "Operations",
    authMode: "frappe_session",
  }, cwd);

  assert.equal(refreshed.pairingId, first.pairingId);
  assert.equal(refreshed.identity?.roles.length, 234);
  assert.ok(refreshed.identity?.roles.includes("Custom Role 233"));
  assert.equal(pairingScopes(refreshed).length, 6, "role-heavy identities use one permission epoch scope");
  assert.equal((await loadPairings(cwd)).pending.length, 0);
  await assert.rejects(() => upsertTrustedFrappePairing("frappe:erp.example.test", "employee@example.test", {
    site: "https://erp.example.test",
    user: "someone-else@example.test",
    roles: ["Employee"],
    authMode: "frappe_session",
  }, cwd), /different Frappe identity/);
});
