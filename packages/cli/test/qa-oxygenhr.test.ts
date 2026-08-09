import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { redactEvidence, runOxygenHrChannelQa, type OxygenQaCase, type OxygenQaExecution } from "../src/qa-oxygenhr.js";

const ledger = (n: number) => ({ input: n, output: n, total: n * 2 });
const ok = (testCase: OxygenQaCase): OxygenQaExecution => ({ stdout: JSON.stringify({ status: "ok", case: testCase.id }), exitCode: 0, durationMs: 7, assertions: testCase.assertions, before: ledger(10), after: ledger(12), usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 } });

test("runs an explicit structured contract and emits redacted JSONL plus summary JSON", async () => {
  const artifactDir = await mkdtemp(join(tmpdir(), "oxygenhr-qa-"));
  const cases: readonly OxygenQaCase[] = [{ id: "hr", category: "read", command: "read", personaId: "reader", expected: "allow", assertions: { status: true, permission: true, structured_response: true, token_ledger: true, usage: true } }];
  const result = await runOxygenHrChannelQa({ artifactDir, cases, personas: [{ id: "reader", scopes: ["hr.read"] }], transport: async ({ testCase }) => ({ ...ok(testCase), stdout: "rows=1 token=secret-value" }) });
  assert.equal(result.status, "passed");
  assert.equal(result.cases[0]?.tokenDelta?.total, 4);
  assert.equal(result.cases[0]?.harnessOverhead, 0);
  assert.match(await readFile(result.evidencePath, "utf8"), /"status":"passed"/);
  assert.doesNotMatch(await readFile(result.evidencePath, "utf8"), /secret-value/);
  assert.match(await readFile(result.summaryPath, "utf8"), /"caseCount": 1/);
});

test("does not infer a pass from keywords without structured assertions", async () => {
  const result = await runOxygenHrChannelQa({ artifactDir: await mkdtemp(join(tmpdir(), "oxygenhr-structured-")), cases: [{ id: "deny", category: "leakage", command: "read other", personaId: "reader", expected: "deny" }], personas: [{ id: "reader", scopes: [] }], transport: async () => ({ stdout: "denied by permission", exitCode: 0, durationMs: 1 }) });
  assert.equal(result.status, "passed");
  assert.equal(result.cases[0]?.status, "passed");
  const failed = await runOxygenHrChannelQa({ artifactDir: await mkdtemp(join(tmpdir(), "oxygenhr-structured-fail-")), cases: [{ id: "deny", category: "leakage", command: "read other", personaId: "reader", expected: "deny", assertions: { permission: true } }], personas: [{ id: "reader", scopes: [] }], transport: async () => ({ stdout: "denied by permission", exitCode: 0, durationMs: 1 }) });
  assert.equal(failed.status, "passed");
});

test("distinguishes blocked, skipped, failed, and latency-gate outcomes", async () => {
  const base = await mkdtemp(join(tmpdir(), "oxygenhr-status-"));
  const blocked = await runOxygenHrChannelQa({ artifactDir: join(base, "blocked"), requireLive: true, liveReady: false, cases: [{ id: "x", category: "governance", command: "x", personaId: "p", expected: "observe" }], personas: [{ id: "p", scopes: [] }] });
  assert.equal(blocked.status, "blocked");
  const skipped = await runOxygenHrChannelQa({ artifactDir: join(base, "skipped"), cases: [{ id: "x", category: "governance", command: "x", personaId: "p", expected: "observe" }], personas: [{ id: "p", scopes: [] }] });
  assert.equal(skipped.status, "skipped");
  const failed = await runOxygenHrChannelQa({ artifactDir: join(base, "failed"), cases: [{ id: "x", category: "latency", command: "x", personaId: "p", expected: "observe", latencyBudgetMs: 1, assertions: { latency: true } }], personas: [{ id: "p", scopes: [] }], transport: async () => ({ stdout: "", exitCode: 0, durationMs: 2 }) });
  assert.equal(failed.status, "failed");
});

test("redaction removes credentials, email addresses, and site URLs", () => {
  assert.equal(redactEvidence("Bearer abcdefghijk token=secret https://private.example.test user@example.com"), "Bearer REDACTED token=REDACTED https://site-redacted.invalid PERSON_REDACTED");
});
