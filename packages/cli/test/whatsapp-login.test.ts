import assert from "node:assert/strict";
import test from "node:test";
import { runWhatsAppLoginCommand } from "../src/whatsapp-login.js";

test("channels login whatsapp prints an honest non-TTY QR payload path without a live network", async () => {
  const output: string[] = [];
  await runWhatsAppLoginCommand({
    gateway: { token: "test-token", whatsapp: { account: "work", groups: [] } },
    isTTY: false,
    output: (line) => output.push(line),
    login: async (options) => { options.onQr("test-qr-payload"); },
  });
  assert.match(output[0], /unofficial protocol; Meta ToS gray zone; the linked number can be banned/);
  assert.ok(output.some((line) => line.includes("WhatsApp QR payload: test-qr-payload")));
  assert.ok(output.some((line) => line.includes("Linked devices")));
  assert.equal(output.at(-1), "next=muster channels status whatsapp");
});
