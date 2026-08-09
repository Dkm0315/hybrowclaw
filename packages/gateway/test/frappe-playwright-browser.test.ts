import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createPlaywrightFrappeBrowserAutomationPort,
  DirectoryFrappeBrowserScreenshotEvidenceStore,
  frappeBrowserClickTransitionPreconditionIsValid,
  frappeBrowserControlMetadataIsSecret,
  frappeBrowserNetworkUrlIsAllowed,
  frappeBrowserRequestIsAllowed,
} from "../src/frappe-playwright-browser.js";

test("redacted screenshot evidence is content-addressed and privately persisted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muster-browser-evidence-"));
  const store = new DirectoryFrappeBrowserScreenshotEvidenceStore(directory);
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const first = await store.persist({ bytes, contextId: "context-1", actionId: "action-1" });
  const second = await store.persist({ bytes, contextId: "context-1", actionId: "action-1" });
  assert.deepEqual(second, first, "an exact evidence retry must not create a second artifact");
  assert.match(first.id, /^browser-[a-f0-9]{40}$/);
  assert.match(first.sha256, /^sha256:[a-f0-9]{64}$/);
  const path = join(directory, `${first.id}.png`);
  assert.deepEqual(new Uint8Array(await readFile(path)), bytes);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("Playwright transport rejects unsafe runtime bounds before launching a browser", () => {
  const evidence = new DirectoryFrappeBrowserScreenshotEvidenceStore("/operator-owned/evidence-root");
  assert.throws(() => createPlaywrightFrappeBrowserAutomationPort({ evidence, launchTimeoutMs: 999 }), /outside its safe bound/);
  assert.throws(() => createPlaywrightFrappeBrowserAutomationPort({ evidence, actionTimeoutMs: 60_001 }), /outside its safe bound/);
});

test("browser network boundary allows only exact HTTPS and same-host secure WebSockets", () => {
  const origin = "https://erp.example.test:8443";
  for (const allowed of [
    "https://erp.example.test:8443/desk",
    "https://erp.example.test:8443/assets/muster.js",
    "wss://erp.example.test:8443/socket.io/?EIO=4&transport=websocket",
    "data:image/png;base64,AA==",
    "blob:https://erp.example.test:8443/opaque-id",
  ]) assert.equal(frappeBrowserNetworkUrlIsAllowed(allowed, origin), true, allowed);

  for (const denied of [
    "http://erp.example.test:8443/desk",
    "https://erp.example.test.evil.test:8443/desk",
    "https://erp.example.test/desk",
    "wss://evil.example.test:8443/socket",
    "wss://erp.example.test/socket",
    "ws://erp.example.test:8443/socket",
    "https://user:pass@erp.example.test:8443/desk",
    "javascript:alert(1)",
  ]) assert.equal(frappeBrowserNetworkUrlIsAllowed(denied, origin), false, denied);
});

test("data and blob URLs are subresources only and can never become the page document", () => {
  const origin = "https://erp.example.test";
  assert.equal(frappeBrowserRequestIsAllowed("data:image/png;base64,AA==", origin, "image", false), true);
  assert.equal(frappeBrowserRequestIsAllowed("blob:https://erp.example.test/opaque", origin, "image", false), true);
  assert.equal(frappeBrowserRequestIsAllowed("data:text/html,hostile", origin, "document", true), false);
  assert.equal(frappeBrowserRequestIsAllowed("blob:https://erp.example.test/hostile", origin, "document", true), false);
  assert.equal(frappeBrowserRequestIsAllowed("https://erp.example.test/api/method/frappe.auth.get_logged_user", origin, "document", true), false);
  assert.equal(frappeBrowserRequestIsAllowed("https://erp.example.test/desk?token=leak", origin, "document", true), false);
  assert.equal(frappeBrowserRequestIsAllowed("https://erp.example.test/desk/Sales%20Invoice", origin, "document", true), true);
});

test("resolved DOM credential metadata fails closed even when the planned field alias looks harmless", () => {
  assert.equal(frappeBrowserControlMetadataIsSecret({ semanticName: "Notes", type: "password" }), true);
  assert.equal(frappeBrowserControlMetadataIsSecret({ semanticName: "Display name", name: "friendly", autocomplete: "new-password" }), true);
  assert.equal(frappeBrowserControlMetadataIsSecret({ semanticName: "Code", id: "api_token_value" }), true);
  assert.equal(frappeBrowserControlMetadataIsSecret({ semanticName: "Customer", type: "text", name: "customer", autocomplete: "off" }), false);
});

test("click postconditions prove a transition instead of accepting a pre-existing observation", () => {
  assert.equal(frappeBrowserClickTransitionPreconditionIsValid("visible", 1, true), false, "an already-visible success target proves nothing");
  assert.equal(frappeBrowserClickTransitionPreconditionIsValid("visible", 0, false), true);
  assert.equal(frappeBrowserClickTransitionPreconditionIsValid("hidden", 0, false), false, "an already-absent target proves nothing");
  assert.equal(frappeBrowserClickTransitionPreconditionIsValid("hidden", 1, true), true);
  assert.equal(frappeBrowserClickTransitionPreconditionIsValid("visible", 2, false), false, "ambiguous targets fail closed");
});
