import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SqliteFrappeInteractionStore, type PendingFrappeInteraction } from "../src/frappe-interaction-store.js";

function interaction(key: string, nowMs = 1_000): PendingFrappeInteraction {
  return {
    key,
    site: "https://erp.example.test",
    principal: "person@example.test",
    surfaceId: "telegram:assistant",
    conversationId: "chat-1",
    senderId: "sender-1",
    doctype: "Support Request",
    operation: "create",
    values: {},
    requiredFields: [{ fieldname: "subject", label: "Subject" }],
    phase: "collecting",
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    expiresAtMs: nowMs + 60_000,
  };
}

test("pending Frappe interactions survive restart and expire closed", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-interaction-"));
  const filename = join(cwd, "control.db");
  try {
    const first = new SqliteFrappeInteractionStore(filename);
    first.put(interaction("actor-a"));
    first.close();

    const reopened = new SqliteFrappeInteractionStore(filename);
    assert.equal(reopened.read("actor-a", 2_000)?.doctype, "Support Request");
    assert.equal(reopened.read("actor-b", 2_000), undefined, "another actor cannot inherit the pending form");
    assert.equal(reopened.read("actor-a", 61_001), undefined, "expired input is never replayed");
    reopened.close();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
