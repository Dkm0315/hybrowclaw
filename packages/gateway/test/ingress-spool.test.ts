import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createGatewayIngressFingerprint, DurableGatewayIngressSpool } from "../src/index.js";

test("durable ingress spool records accepted payloads, delivery markers, and removal", async () => {
  const root = await mkdtemp(join(tmpdir(), "muster-ingress-spool-"));
  const spool = new DurableGatewayIngressSpool(root, "test-ingress-spool-integrity-key");
  const ownership = {
    scope: "adapter:telegram",
    deliveryId: "telegram:42",
    fingerprint: createGatewayIngressFingerprint(["telegram", "telegram:42", "body"]),
    claimToken: "claim-generation-42",
  };
  await spool.put({ adapterId: "telegram", ownership, body: "body" });
  let snapshot = await spool.snapshot();
  assert.equal(snapshot.rejectedFiles, 0);
  assert.equal(snapshot.entries.length, 1);
  assert.equal(snapshot.entries[0].state, "accepted");

  await spool.markPlatformDelivered(ownership);
  snapshot = await spool.snapshot();
  assert.equal(snapshot.entries[0].state, "platform-delivered");

  await spool.remove(ownership);
  assert.equal((await spool.snapshot()).entries.length, 0);
});

test("durable ingress spool quarantines malformed files instead of blocking startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "muster-ingress-spool-invalid-"));
  await writeFile(join(root, "invalid.json"), "{not-json", { mode: 0o600 });
  const snapshot = await new DurableGatewayIngressSpool(root, "test-ingress-spool-integrity-key").snapshot();
  assert.equal(snapshot.entries.length, 0);
  assert.equal(snapshot.rejectedFiles, 1);
  assert.ok((await readdir(root)).some((name) => name.startsWith("invalid.json.rejected-")));
});
