import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationSessionId, isPairingChallenge, parseSurfaceMessage } from "../src/index.js";

test("parseSurfaceMessage accepts a full envelope and preserves raw", () => {
  const message = parseSurfaceMessage({
    surfaceId: "slack:T024",
    conversationId: "C99",
    senderId: "U1",
    text: "hello",
    replyTo: "171234.5678",
    attachments: [{ name: "a.txt", mime: "text/plain", url: "https://example.com/a.txt" }],
    raw: { original: true },
  });
  assert.equal(message.surfaceId, "slack:T024");
  assert.equal(message.attachments?.[0].mime, "text/plain");
  assert.deepEqual(message.raw, { original: true });
});

test("parseSurfaceMessage rejects missing or empty required fields", () => {
  assert.throws(() => parseSurfaceMessage(null), /JSON object/);
  assert.throws(() => parseSurfaceMessage({ surfaceId: "s", conversationId: "c", senderId: "u" }), /"text"/);
  assert.throws(() => parseSurfaceMessage({ surfaceId: " ", conversationId: "c", senderId: "u", text: "x" }), /"surfaceId"/);
  assert.throws(
    () => parseSurfaceMessage({ surfaceId: "s", conversationId: "c", senderId: "u", text: "x", attachments: [{ name: 1 }] }),
    /attachment/,
  );
});

test("conversationSessionId and isPairingChallenge helpers", () => {
  assert.equal(conversationSessionId({ surfaceId: "telegram:bot", conversationId: "42" }), "telegram:bot:42");
  assert.equal(
    conversationSessionId({ surfaceId: "slack:T1", conversationId: "C1", senderId: "U1" }),
    "slack:T1:C1:sender:U1",
  );
  assert.notEqual(
    conversationSessionId({ surfaceId: "slack:T1", conversationId: "C1", senderId: "U1" }),
    conversationSessionId({ surfaceId: "slack:T1", conversationId: "C1", senderId: "U2" }),
  );
  assert.equal(isPairingChallenge({ status: "pairing_required", code: "ABCD2345" }), true);
  assert.equal(isPairingChallenge({ text: "hi" }), false);
});
