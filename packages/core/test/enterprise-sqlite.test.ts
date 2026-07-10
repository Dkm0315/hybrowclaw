import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { test, type TestContext } from "node:test";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import {
  createEnterpriseActionReceipt,
  EnterpriseSqliteStore,
  enterpriseWindowBounds,
  type EnterpriseSubject,
  type EnterpriseUsageEvent,
} from "../src/index.js";

const now = Date.parse("2026-07-10T10:24:30.000Z");

interface CounterWorkerJob {
  readonly marker: "enterprise-sqlite-test";
  readonly operation: "counter";
  readonly filename: string;
  readonly attempts: number;
  readonly limit: number;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
}

interface IdempotencyWorkerJob {
  readonly marker: "enterprise-sqlite-test";
  readonly operation: "idempotency";
  readonly filename: string;
  readonly fingerprint: string;
}

type WorkerJob = CounterWorkerJob | IdempotencyWorkerJob;

function isWorkerJob(value: unknown): value is WorkerJob {
  return typeof value === "object" && value !== null
    && (value as { marker?: string }).marker === "enterprise-sqlite-test";
}

if (!isMainThread && isWorkerJob(workerData)) {
  parentPort?.once("message", async (message: unknown) => {
    if (message !== "start") return;
    const store = new EnterpriseSqliteStore({ filename: workerData.filename, busyTimeoutMs: 20_000 });
    try {
      if (workerData.operation === "counter") {
        let accepted = 0;
        for (let index = 0; index < workerData.attempts; index += 1) {
          const result = await store.consumeRateLimit({
            key: "tenant:acme:user:u-1:runs",
            windowStartMs: workerData.windowStartMs,
            windowEndMs: workerData.windowEndMs,
            amount: 1,
            limit: workerData.limit,
          });
          if (result.accepted) accepted += 1;
        }
        parentPort?.postMessage({ accepted });
      } else {
        const claim = await store.claimIdempotency({
          namespace: "slack",
          key: "event-race",
          fingerprint: workerData.fingerprint,
          ttlMs: 60_000,
          nowMs: now,
        });
        parentPort?.postMessage({ status: claim.status, fingerprint: claim.record.fingerprint });
      }
    } finally {
      store.close();
    }
  });
}

function databasePath(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "muster-enterprise-sqlite-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "enterprise.db");
}

function usage(
  eventId: string,
  occurredAt: string,
  subjects: readonly EnterpriseSubject[],
  overrides: Partial<EnterpriseUsageEvent> = {},
): EnterpriseUsageEvent {
  return {
    eventId,
    occurredAt,
    subjects,
    outcome: "success",
    latencyMs: 25,
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 40,
    costMicrousd: 125,
    cacheStatus: "hit",
    tool: "frappe.query",
    requestCategory: "operational_lookup",
    ...overrides,
  };
}

async function runWorkers(jobs: readonly WorkerJob[]): Promise<Record<string, unknown>[]> {
  const workers = jobs.map((job) => new Worker(new URL(import.meta.url), { workerData: job }));
  try {
    await Promise.all(workers.map((worker) => new Promise<void>((resolve, reject) => {
      worker.once("online", resolve);
      worker.once("error", reject);
    })));
    const results = workers.map((worker) => new Promise<Record<string, unknown>>((resolve, reject) => {
      worker.once("message", (message: Record<string, unknown>) => resolve(message));
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code !== 0) reject(new Error(`Enterprise SQLite worker exited with code ${code}.`));
      });
    }));
    for (const worker of workers) worker.postMessage("start");
    return await Promise.all(results);
  } finally {
    await Promise.all(workers.map(async (worker) => {
      if (worker.threadId !== -1) await worker.terminate();
    }));
  }
}

if (isMainThread) {
  test("SQLite counters persist across restart and keep rate and budget scopes independent", async (t) => {
    const filename = databasePath(t);
    const minute = enterpriseWindowBounds("minute", now);
    const month = enterpriseWindowBounds("month", now);
    let store = new EnterpriseSqliteStore(filename);

    const first = await store.consumeRateLimit({
      key: "runs", windowStartMs: minute.startMs, windowEndMs: minute.endMs, amount: 2.5, limit: 5,
    });
    const rejected = await store.consumeRateLimit({
      key: "runs", windowStartMs: minute.startMs, windowEndMs: minute.endMs, amount: 3, limit: 5,
    });
    const budget = await store.consumeBudget({
      key: "runs", windowStartMs: month.startMs, windowEndMs: month.endMs, amount: 1_100, limit: 1_000,
      commitOnExceed: true,
    });
    assert.deepEqual(
      { accepted: first.accepted, used: first.usedAfter, rejectedAfter: rejected.usedAfter, budgetAfter: budget.usedAfter },
      { accepted: true, used: 2.5, rejectedAfter: 2.5, budgetAfter: 1_100 },
    );
    store.close();

    store = new EnterpriseSqliteStore(filename);
    assert.equal(await store.readRateLimit({ key: "runs", windowStartMs: minute.startMs, nowMs: now }), 2.5);
    assert.equal(await store.readBudget({ key: "runs", windowStartMs: month.startMs, nowMs: now }), 1_100);
    assert.equal(await store.readRateLimit({ key: "runs", windowStartMs: minute.startMs, nowMs: minute.endMs }), 0);
    store.close();
  });

  test("BEGIN IMMEDIATE admits exactly the limit under simultaneous multi-connection writes", async (t) => {
    const filename = databasePath(t);
    const window = enterpriseWindowBounds("minute", now);
    new EnterpriseSqliteStore(filename).close();
    const jobs: CounterWorkerJob[] = Array.from({ length: 8 }, () => ({
      marker: "enterprise-sqlite-test",
      operation: "counter",
      filename,
      attempts: 20,
      limit: 37,
      windowStartMs: window.startMs,
      windowEndMs: window.endMs,
    }));
    const results = await runWorkers(jobs);
    assert.equal(results.reduce((total, result) => total + Number(result.accepted), 0), 37);

    const store = new EnterpriseSqliteStore(filename);
    assert.equal(await store.readRateLimit({ key: "tenant:acme:user:u-1:runs", windowStartMs: window.startMs, nowMs: now }), 37);
    store.close();
  });

  test("idempotency claims are durable, replay-safe, conflict-safe, and reclaimable after expiry", async (t) => {
    const filename = databasePath(t);
    new EnterpriseSqliteStore(filename).close();
    const jobs: IdempotencyWorkerJob[] = Array.from({ length: 10 }, (_, index) => ({
      marker: "enterprise-sqlite-test",
      operation: "idempotency",
      filename,
      fingerprint: index % 2 ? "sha256:alpha" : "sha256:beta",
    }));
    const results = await runWorkers(jobs);
    assert.equal(results.filter((result) => result.status === "claimed").length, 1);
    const winner = String(results.find((result) => result.status === "claimed")?.fingerprint);
    assert.ok(winner === "sha256:alpha" || winner === "sha256:beta");
    assert.equal(results.filter((result) => result.status === "replay").length, 4);
    assert.equal(results.filter((result) => result.status === "conflict").length, 5);

    let store = new EnterpriseSqliteStore(filename);
    const completed = await store.completeIdempotency({
      namespace: "slack", key: "event-race", fingerprint: winner, resultRef: "receipt-1", nowMs: now + 1,
    });
    assert.equal(completed.state, "completed");
    assert.equal((await store.completeIdempotency({
      namespace: "slack", key: "event-race", fingerprint: winner, resultRef: "receipt-1", nowMs: now + 2,
    })).resultRef, "receipt-1");
    await assert.rejects(store.completeIdempotency({
      namespace: "slack", key: "event-race", fingerprint: winner, resultRef: "receipt-2", nowMs: now + 3,
    }), /another result/);
    store.close();

    store = new EnterpriseSqliteStore(filename);
    assert.equal((await store.readIdempotency("slack", "event-race", now + 4))?.resultRef, "receipt-1");
    const reclaimed = await store.claimIdempotency({
      namespace: "slack", key: "event-race", fingerprint: "sha256:new", ttlMs: 1_000, nowMs: now + 60_000,
    });
    assert.equal(reclaimed.status, "claimed");
    await assert.rejects(store.completeIdempotency({
      namespace: "missing", key: "event", fingerprint: "sha256:x", resultRef: "r", nowMs: now,
    }), /missing or expired/);
    store.close();
  });

  test("receipts are restart-durable, append-idempotent, ordered, redacted, and integrity checked", async (t) => {
    const filename = databasePath(t);
    const first = createEnterpriseActionReceipt({
      receiptId: "receipt-1",
      occurredAt: "2026-07-10T10:00:00.000Z",
      actor: [{ kind: "user", id: "manager" }],
      target: [{ kind: "department", id: "support" }],
      action: "budget.override",
      outcome: "completed",
      requestFingerprint: "sha256:request-1",
      metadata: { detail: "API_TOKEN=do-not-persist", reason: "incident" },
    });
    const second = createEnterpriseActionReceipt({
      receiptId: "receipt-2",
      occurredAt: "2026-07-10T10:01:00.000Z",
      actor: [{ kind: "user", id: "manager" }],
      target: [{ kind: "user", id: "u-1" }],
      action: "usage.inspect",
      outcome: "allowed",
      requestFingerprint: "sha256:request-2",
      previousReceiptHash: first.integrityHash,
    });
    let store = new EnterpriseSqliteStore(filename);
    await store.appendReceipt(first);
    await store.appendReceipt(first);
    await store.appendReceipt(second);
    await assert.rejects(store.appendReceipt({ ...first, integrityHash: "0".repeat(64) }), /integrity check/);
    await assert.rejects(store.appendReceipt(createEnterpriseActionReceipt({
      receiptId: "receipt-1",
      occurredAt: first.occurredAt,
      actor: first.actor,
      target: first.target,
      action: "budget.delete",
      outcome: "completed",
      requestFingerprint: first.requestFingerprint,
    })), /different content/);
    store.close();

    store = new EnterpriseSqliteStore(filename);
    assert.deepEqual((await store.listReceipts()).map((receipt) => receipt.receiptId), ["receipt-1", "receipt-2"]);
    assert.equal((await store.readReceipt("receipt-1"))?.metadata.detail, "API_TOKEN=[redacted]");
    store.close();
    assert.equal(readFileSync(filename).includes(Buffer.from("do-not-persist")), false);
  });

  test("usage events persist idempotently and support ISO ranges, conjunctive scopes, limits, and restart", async (t) => {
    const filename = databasePath(t);
    const acmeSupportU1: EnterpriseSubject[] = [
      { kind: "tenant", id: "acme" },
      { kind: "department", id: "support" },
      { kind: "user", id: "u-1" },
    ];
    const acmeFinanceU1: EnterpriseSubject[] = [
      { kind: "tenant", id: "acme" },
      { kind: "department", id: "finance" },
      { kind: "user", id: "u-1" },
    ];
    const otherSupportU2: EnterpriseSubject[] = [
      { kind: "tenant", id: "other" },
      { kind: "department", id: "support" },
      { kind: "user", id: "u-2" },
    ];
    const privateMarker = "raw-private-payroll-question-9341";
    const first = {
      ...usage("e1", "2026-07-10T10:00:00.000Z", acmeSupportU1),
      rawPrompt: privateMarker,
      arbitraryPayload: { content: privateMarker },
    } as EnterpriseUsageEvent;
    let store = new EnterpriseSqliteStore(filename);
    await store.appendUsage(first);
    await store.appendUsage(first);
    await store.appendUsage(usage("e2", "2026-07-10T11:00:00.000Z", acmeFinanceU1, { cacheStatus: "miss" }));
    await store.appendUsage(usage("e3", "2026-07-10T12:00:00.000Z", otherSupportU2, { outcome: "blocked" }));
    await store.appendUsage(usage("e4", "2026-07-10T13:00:00.000Z", acmeSupportU1, { tool: "mcp.search" }));
    await assert.rejects(store.appendUsage(usage("e1", "2026-07-10T10:00:00.000Z", acmeSupportU1, {
      latencyMs: 999,
    })), /different content/);
    store.close();

    store = new EnterpriseSqliteStore(filename);
    assert.deepEqual((await store.queryUsage({
      from: "2026-07-10T10:00:00.000Z",
      to: "2026-07-10T13:00:00.000Z",
    })).map((event) => event.eventId), ["e1", "e2", "e3"]);
    assert.deepEqual((await store.queryUsage({
      subjects: [{ kind: "tenant", id: "acme" }, { kind: "department", id: "support" }],
    })).map((event) => event.eventId), ["e1", "e4"]);
    assert.deepEqual((await store.queryUsage({ limit: 2 })).map((event) => event.eventId), ["e3", "e4"]);
    assert.doesNotMatch(JSON.stringify(await store.queryUsage()), /rawPrompt|arbitraryPayload|private-payroll/);
    await assert.rejects(store.queryUsage({
      from: "2026-07-11T00:00:00.000Z", to: "2026-07-10T00:00:00.000Z",
    }), /must be after/);
    await assert.rejects(store.queryUsage({ limit: 0 }), /positive safe integer/);
    store.close();
    assert.equal(readFileSync(filename).includes(Buffer.from(privateMarker)), false);
  });

  test("scoped usage queries fail closed if the denormalized subject index is corrupted", async (t) => {
    const filename = databasePath(t);
    let store = new EnterpriseSqliteStore(filename);
    await store.appendUsage(usage("scope-1", "2026-07-10T10:00:00.000Z", [
      { kind: "tenant", id: "acme" },
      { kind: "user", id: "u-1" },
    ]));
    store.close();

    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (path: string) => {
        prepare(sql: string): { run(...params: unknown[]): unknown };
        close(): void;
      };
    };
    const raw = new DatabaseSync(filename);
    raw.prepare(`
      INSERT INTO enterprise_usage_subjects (event_id, kind, subject_id) VALUES (?, ?, ?)
    `).run("scope-1", "tenant", "other");
    raw.close();

    store = new EnterpriseSqliteStore(filename);
    await assert.rejects(store.queryUsage({ subjects: [{ kind: "tenant", id: "other" }] }), /scope-index integrity/);
    store.close();
  });

  test("close is idempotent and closed stores reject subsequent work", async (t) => {
    const store = new EnterpriseSqliteStore(databasePath(t));
    store.close();
    store.close();
    await assert.rejects(store.queryUsage(), /closed/);
    await assert.rejects(store.consumeRateLimit({
      key: "runs", windowStartMs: now, windowEndMs: now + 1_000, amount: 1, limit: 1,
    }), /closed/);
  });
}
