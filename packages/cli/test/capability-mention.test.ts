import assert from "node:assert/strict";
import test from "node:test";
import type { BuiltinCapabilityMention } from "@musterhq/core";
import { resolveBuiltinCapabilityMentions } from "@musterhq/core";
import { composerPrefillForCapabilityMention, intentfulCapabilityMentions } from "../src/capability-mention.js";

test("a greeting asking for one short line never becomes a capability check", () => {
  const prompt = "hi — one short line please";
  assert.deepEqual(intentfulCapabilityMentions(prompt, resolveBuiltinCapabilityMentions(prompt, { limit: 5 })), []);
});

test("explicit use and setup intents preserve real capability positives", () => {
  const prompt = "Use the Telegram plugin and set up browser MCP for this workflow.";
  const hits = intentfulCapabilityMentions(prompt, resolveBuiltinCapabilityMentions(prompt, { limit: 5 }));
  assert.ok(hits.some((hit) => hit.kind === "plugin" && hit.id === "telegram"));
  assert.ok(hits.some((hit) => hit.kind === "mcp" && hit.id === "browser"));
  assert.equal(hits.some((hit) => hit.kind === "plugin" && hit.matched === "browser"), false, "an explicit MCP does not fan out into similarly named plugins");
});

test("keyword-only ordinary nouns need the explicit capability kind", () => {
  const keyword: BuiltinCapabilityMention = { kind: "plugin", id: "imaginary", category: "test", risk: "low", source: "muster", description: "test", matched: "line", confidence: "keyword" };
  assert.deepEqual(intentfulCapabilityMentions("use one line", [keyword]), []);
  assert.deepEqual(intentfulCapabilityMentions("enable the line plugin", [keyword]), [keyword]);
});

test("a high-risk capability never produces a risk-bearing composer prefill", () => {
  const risky: BuiltinCapabilityMention = { kind: "plugin", id: "telegram", category: "channel", risk: "high", source: "muster", description: "test", matched: "telegram", confidence: "exact" };
  assert.equal(composerPrefillForCapabilityMention(risky, { enabled: false }), undefined);
  assert.equal(composerPrefillForCapabilityMention(risky, { enabled: true }), "/plugins telegram");
  assert.doesNotMatch(composerPrefillForCapabilityMention(risky, { enabled: true }) ?? "", /--allow-high-risk/);
});
