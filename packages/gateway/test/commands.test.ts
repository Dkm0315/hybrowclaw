import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addMemory, defaultConfig } from "@musterhq/core";
import { dispatchCommand, parseCommand, resolveCustomCommand } from "../src/commands.js";
import type { SurfaceMessage } from "../src/envelope.js";
import type { PairedSender } from "../src/pairing.js";
import { pairingScopes } from "../src/pairing.js";

const PAIRED: PairedSender = { pairingId: "pair_abc", surfaceId: "telegram:bot", senderId: "555", approvedAt: "2026-06-15T00:00:00Z" };
const FRAPPE_PAIRED: PairedSender = {
  ...PAIRED,
  identity: {
    provider: "frappe",
    site: "https://erp.example.test",
    user: "dhairya@example.test",
    employee: "EMP-0001",
    employeeName: "Dhairya Marwaha",
    roles: ["Employee", "HR Manager", "System Manager"],
    department: "People",
    company: "HyBrowLabs",
    authMode: "oauth_bearer",
    resolvedAt: "2026-07-08T00:00:00.000Z",
  },
};
const msg = (text: string): SurfaceMessage => ({ surfaceId: "telegram:bot", conversationId: "c1", senderId: "555", text });
const ctx = { config: defaultConfig(), profile: "tg", paired: PAIRED, conversationKey: "telegram:bot:c1" };

test("parseCommand: extracts name + args, lowercasing the name", () => {
  assert.deepEqual(parseCommand("/help"), { name: "help", args: "" });
  assert.deepEqual(parseCommand("/status now"), { name: "status", args: "now" });
  assert.deepEqual(parseCommand("  /Review the PR  "), { name: "review", args: "the PR" });
});

test("parseCommand: a path-like prompt is NOT a command (passes through)", () => {
  assert.equal(parseCommand("/etc/hosts is missing an entry"), null);
  assert.equal(parseCommand("just a normal message"), null);
  assert.equal(parseCommand("tell me about /usr/bin"), null);
});

test("dispatchCommand: /help is answered in-gateway with the command list", async () => {
  const reply = await dispatchCommand(msg("/help"), ctx);
  assert.ok(reply, "expected a reply");
  assert.match(reply.text, /\/status/);
  assert.match(reply.text, /\/whoami/);
  assert.match(reply.text, /\/tools/);
  assert.match(reply.text, /\/tokens/);
  assert.match(reply.text, /\/pair/);
  assert.doesNotMatch(reply.text, /\/muster/);
});

test("dispatchCommand: /status reports profile, runtime, model, pairing", async () => {
  const reply = await dispatchCommand(msg("/status"), ctx);
  assert.ok(reply);
  assert.match(reply.text, /Profile\s+│ tg/);
  assert.match(reply.text, new RegExp(ctx.config.routing.defaultRuntime));
  assert.match(reply.text, /pair_abc/);
});

test("dispatchCommand: /whoami reports Frappe user and employee identity when paired", async () => {
  const reply = await dispatchCommand(msg("/whoami"), { ...ctx, paired: FRAPPE_PAIRED });
  assert.ok(reply);
  assert.match(reply.text, /Frappe User/);
  assert.match(reply.text, /dhairya@example\.test/);
  assert.match(reply.text, /EMP-0001/);
  assert.match(reply.text, /HR Manager/);
});

test("dispatchCommand: /tools is role-aware and exposes system controls only to eligible identities", async () => {
  const plain = await dispatchCommand(msg("/tools"), ctx);
  assert.ok(plain);
  assert.doesNotMatch(plain.text, /System controls/);

  const frappe = await dispatchCommand(msg("/tools"), { ...ctx, paired: FRAPPE_PAIRED });
  assert.ok(frappe);
  assert.match(frappe.text, /Find records/);
  assert.match(frappe.text, /HRBP tools/);
  assert.match(frappe.text, /System controls/);
  assert.doesNotMatch(frappe.text, /Normal task, code/);
});

test("dispatchCommand: /agents presents the configured Frappe assistant instead of deployment defaults", async () => {
  const reply = await dispatchCommand(msg("/agents"), {
    ...ctx,
    paired: FRAPPE_PAIRED,
    gateway: {
      token: "test",
      frappe: {
        assistant: {
          name: "OxygenHR Assistant",
          description: "HR operations and employee workflows",
          organization: "OxygenHR",
        },
      },
    },
  });
  assert.ok(reply);
  assert.match(reply.text, /OxygenHR Assistant/);
  assert.match(reply.text, /HR operations and employee workflows/);
  assert.equal(reply.presentation?.kind, "menu");
  assert.match(reply.text, /Dhairya Marwaha/);
  assert.doesNotMatch(reply.text, /dhairya@example\.test/);
  assert.doesNotMatch(reply.text, /deployment defaults/i);
});

test("dispatchCommand: /pair never falls through to the provider when Frappe OAuth is unavailable", async () => {
  const reply = await dispatchCommand(msg("/pair"), ctx);
  assert.ok(reply);
  assert.match(reply.text, /Frappe connection unavailable/i);
  assert.match(reply.text, /no Frappe OAuth connection configured/i);
});

test("dispatchCommand: /stop is acknowledged in-gateway", async () => {
  const reply = await dispatchCommand(msg("/stop"), ctx);
  assert.ok(reply);
  assert.match(reply.text, /No active gateway command/i);
});

test("dispatchCommand: /memory reports only evidence visible to the current authority", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-memory-command-"));
  await addMemory({
    summary: "Visible preference",
    provenance: ["test"],
    scopes: pairingScopes(PAIRED),
  }, cwd);
  await addMemory({
    summary: "Hidden preference",
    provenance: ["test"],
    scopes: [{ kind: "pairing", id: "another:sender" }],
  }, cwd);

  const reply = await dispatchCommand(msg("/memory"), { ...ctx, cwd });
  assert.ok(reply);
  assert.match(reply.text, /1 memory item is currently visible/);
  assert.deepEqual(reply.presentation?.tables?.[0]?.rows.at(-1), [
    "Evidence", "Checked 2 stored items; only eligible items counted",
  ]);
  assert.doesNotMatch(reply.text, /pair_abc|another:sender|Visible preference|Hidden preference/);
  assert.doesNotMatch(reply.text, /hash|sha256|backend|provider|model/i);
});

test("resolveCustomCommand: matches exact or prefix surfaces and renders prompt templates", () => {
  const custom = resolveCustomCommand(msg("/deploy site-a"), {
    token: "t",
    commands: {
      entries: {
        deploy: {
          description: "Deploy a site",
          prompt: "Deploy with args: {args}",
          surfaces: ["telegram"],
        },
      },
    },
  });
  assert.ok(custom);
  assert.match(custom.prompt, /Deploy a site/);
  assert.match(custom.prompt, /Deploy with args: site-a/);

  const blocked = resolveCustomCommand({ ...msg("/deploy site-a"), surfaceId: "web:demo" }, {
    token: "t",
    commands: { entries: { deploy: { prompt: "nope", surfaces: ["telegram"] } } },
  });
  assert.equal(blocked, undefined);
});

test("dispatchCommand: a non-builtin /command returns null (passthrough to the agent)", async () => {
  assert.equal(await dispatchCommand(msg("/review the diff"), ctx), null);
  assert.equal(await dispatchCommand(msg("/init"), ctx), null);
});

test("dispatchCommand: a normal message returns null (goes to the agent)", async () => {
  assert.equal(await dispatchCommand(msg("build me an xlsx of tickets"), ctx), null);
});
