import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  addMemory,
  configPath,
  defaultConfig,
  ensureDefaultConfig,
  listMemory,
  loadConfig,
  MemoryPolicyError,
  memoryWritePolicy,
  runHarnessChecks,
  saveConfig,
  seedRepresentativeRetrievalEvalPack,
  type MemoryWritePolicy,
} from "../src/index.js";

const SCOPES = [{ kind: "user" as const, id: "goblin" }];

async function workspace(policy?: MemoryWritePolicy | string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "muster-memory-policy-"));
  await ensureDefaultConfig(cwd);
  if (policy !== undefined) {
    const config = await loadConfig(cwd);
    await saveConfig({ ...config, memory: { policy: policy as MemoryWritePolicy } }, cwd);
  }
  return cwd;
}

function fact(extra: Record<string, unknown> = {}) {
  return { summary: "The gateway deploys on Fridays", provenance: ["policy:test"], scopes: SCOPES, ...extra };
}

async function rejectsPolicy(run: () => Promise<unknown>, policy: MemoryWritePolicy, message: RegExp): Promise<MemoryPolicyError> {
  const error = await run().then(() => undefined, (thrown: unknown) => thrown);
  assert.ok(error instanceof MemoryPolicyError, `expected a MemoryPolicyError, got ${String(error)}`);
  assert.equal(error.name, "MemoryPolicyError");
  assert.equal(error.policy, policy);
  assert.match(error.message, message);
  return error;
}

test("the policy matrix decides every durable write", async () => {
  const matrix: ReadonlyArray<{
    readonly policy: MemoryWritePolicy | undefined;
    readonly input: Record<string, unknown>;
    readonly allowed: boolean;
    readonly label: string;
  }> = [
    { policy: undefined, input: {}, allowed: true, label: "absent policy → auto" },
    { policy: "auto", input: {}, allowed: true, label: "auto + agent write" },
    { policy: "auto", input: { explicitUserRequest: true }, allowed: true, label: "auto + user write" },
    { policy: "auto", input: { consentReceipt: "approval_1" }, allowed: true, label: "auto ignores receipts" },
    { policy: "ask", input: {}, allowed: false, label: "ask + no receipt" },
    { policy: "ask", input: { consentReceipt: "   " }, allowed: false, label: "ask + blank receipt" },
    { policy: "ask", input: { consentReceipt: 7 }, allowed: false, label: "ask + non-string receipt" },
    { policy: "ask", input: { consentReceipt: "approval_9f2" }, allowed: true, label: "ask + real receipt" },
    { policy: "ask", input: { explicitUserRequest: true }, allowed: true, label: "ask + the user asking IS the consent" },
    { policy: "never", input: {}, allowed: false, label: "never + agent write" },
    { policy: "never", input: { consentReceipt: "approval_9f2" }, allowed: false, label: "never is not buyable with a receipt" },
    { policy: "never", input: { explicitUserRequest: "yes" }, allowed: false, label: "never + truthy-but-not-true flag" },
    { policy: "never", input: { explicitUserRequest: true }, allowed: true, label: "never + explicit user request" },
  ];

  for (const entry of matrix) {
    const cwd = await workspace(entry.policy);
    if (entry.allowed) {
      const written = await addMemory(fact(entry.input) as never, cwd);
      assert.equal(written.summary, "The gateway deploys on Fridays", entry.label);
      assert.equal((await listMemory(cwd)).length, 1, entry.label);
      continue;
    }
    await rejectsPolicy(() => addMemory(fact(entry.input) as never, cwd), entry.policy as MemoryWritePolicy, /config\.memory\.policy/);
    assert.deepEqual(await listMemory(cwd), [], `${entry.label}: a refused write must leave no trace on disk`);
  }
});

test("a refused write is refused before anything is persisted or indexed", async () => {
  const cwd = await workspace("never");
  await rejectsPolicy(() => addMemory(fact(), cwd), "never", /does not write durable memory on its own/);
  assert.deepEqual(await listMemory(cwd), []);

  // And the store still works the moment the user asks for it themselves.
  await addMemory(fact({ explicitUserRequest: true }) as never, cwd);
  assert.equal((await listMemory(cwd)).length, 1);
});

test("policy errors name the fix the caller can actually perform", async () => {
  const askCwd = await workspace("ask");
  const askError = await rejectsPolicy(() => addMemory(fact(), askCwd), "ask", /consentReceipt/);
  assert.match(askError.message, /obtain the user's confirmation/);

  const neverCwd = await workspace("never");
  const neverError = await rejectsPolicy(() => addMemory(fact(), neverCwd), "never", /explicitUserRequest: true/);
  assert.match(neverError.message, /muster onboard|\.muster\/config\.json/);
});

test("input validation still runs before the policy gate", async () => {
  const cwd = await workspace("never");
  // A malformed write under a `never` policy reports the malformation, not the
  // policy: the caller must not have to fix consent to learn its input is bad.
  await assert.rejects(() => addMemory({ provenance: ["p"], scopes: SCOPES } as never, cwd), /addMemory requires summary/);
  await assert.rejects(() => addMemory(undefined as never, cwd), /addMemory requires an input object/);
});

test("an unreadable or absent config degrades to auto, an unknown policy does not", async () => {
  const bare = await mkdtemp(join(tmpdir(), "muster-memory-policy-bare-"));
  assert.equal(await memoryWritePolicy(bare), "auto", "no config file → today's behaviour, never a hard failure");
  const written = await addMemory(fact(), bare);
  assert.ok(written.id.startsWith("mem_"));

  const broken = await mkdtemp(join(tmpdir(), "muster-memory-policy-broken-"));
  await ensureDefaultConfig(broken);
  await writeFile(configPath(broken), "{ not json", "utf8");
  assert.equal(await memoryWritePolicy(broken), "auto");

  const bogus = await workspace("sometimes");
  await rejectsPolicy(() => memoryWritePolicy(bogus), "never", /Unknown config\.memory\.policy/);
  await rejectsPolicy(() => addMemory(fact(), bogus), "never", /Unknown config\.memory\.policy/);
  assert.deepEqual(await listMemory(bogus), [], "an unenforceable policy blocks writes instead of guessing");
});

test("a user-run seed still works under `never`; the agent's own promotion still does not", async () => {
  const cwd = await workspace("never");
  // Seeding an eval pack is something the operator typed, so it must survive
  // the strictest policy — otherwise retrieval evals fail for a reason that has
  // nothing to do with retrieval.
  const seeded = await seedRepresentativeRetrievalEvalPack({ id: "policy", distractorCount: 0 }, cwd);
  const { exact, stale, fresh, forbidden, distractors } = seeded.memoryIds;
  const seededIds = [exact, stale, fresh, forbidden, ...distractors];
  assert.equal(seededIds.length, 4, "no distractors were requested, so only the four cases were written");
  const stored = await listMemory(cwd);
  assert.deepEqual([...stored.map((object) => object.id)].sort(), [...seededIds].sort());
  // ...while an unattributed write on the same workspace is still refused.
  await rejectsPolicy(() => addMemory(fact(), cwd), "never", /does not write durable memory on its own/);
  assert.equal((await listMemory(cwd)).length, seededIds.length, "the refused write persisted nothing");
});

test("a policy-blocked harness probe is not reported as a memory isolation leak", async () => {
  const cwd = await workspace("never");
  const checks = await runHarnessChecks(cwd);
  const isolation = checks.find((check) => check.id === "memory_isolation");
  assert.ok(isolation, "the harness still runs the isolation check");
  assert.equal(isolation.status, "failed", "an unverified guarantee is never reported as verified");
  assert.match(isolation.detail ?? "", /check not run/);
  assert.doesNotMatch(isolation.detail ?? "", /leaked into global search/);
  assert.match(isolation.detail ?? "", /config\.memory\.policy/);
});

test("defaultConfig ships the policy field so the setting is discoverable, not hidden", async () => {
  assert.equal(defaultConfig().memory?.policy, "auto");
  const cwd = await workspace();
  const raw = JSON.parse(await readFile(configPath(cwd), "utf8")) as { memory?: { policy?: string } };
  assert.equal(raw.memory?.policy, "auto");
});
