import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { EnterpriseSqliteStore } from "@musterhq/core";
import {
  createGatewayIngressFingerprint,
  createGatewaySafeResultRef,
  DurableGatewayIngress,
  parseGatewayIngressFingerprint,
  type GatewayIngressClaimStatus,
  type GatewaySafeResultRef,
} from "../src/durable-ingress.js";

const NOW = Date.parse("2026-07-10T12:00:00.000Z");

interface ClaimWorkerData {
  readonly marker: "durable-gateway-ingress-test";
  readonly filename: string;
  readonly scope: string;
  readonly deliveryId: string;
  readonly fingerprint: string;
}

function isClaimWorkerData(value: unknown): value is ClaimWorkerData {
  return typeof value === "object"
    && value !== null
    && (value as { marker?: string }).marker === "durable-gateway-ingress-test";
}

if (!isMainThread && isClaimWorkerData(workerData)) {
  parentPort?.once("message", async (message: unknown) => {
    if (message !== "start") return;
    const store = new EnterpriseSqliteStore({ filename: workerData.filename, busyTimeoutMs: 20_000 });
    try {
      const ingress = new DurableGatewayIngress(store, { defaultLeaseMs: 5_000 });
      const result = await ingress.claim({
        scope: workerData.scope,
        deliveryId: workerData.deliveryId,
        fingerprint: parseGatewayIngressFingerprint(workerData.fingerprint),
        nowMs: NOW,
      });
      parentPort?.postMessage({ status: result.status });
    } catch (error) {
      parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      store.close();
    }
  });
}

function databasePath(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "muster-durable-ingress-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "gateway.db");
}

function identity(label = "event-1") {
  return {
    scope: "slack:workspace:T-1",
    deliveryId: label,
    fingerprint: createGatewayIngressFingerprint(["slack", "T-1", label, "sender:U-1"]),
  } as const;
}

async function runClaimWorkers(filename: string): Promise<GatewayIngressClaimStatus[]> {
  const event = identity("event-concurrent");
  const jobs: ClaimWorkerData[] = Array.from({ length: 2 }, () => ({
    marker: "durable-gateway-ingress-test",
    filename,
    ...event,
  }));
  const workers = jobs.map((job) => new Worker(new URL(import.meta.url), { workerData: job }));
  try {
    await Promise.all(workers.map((worker) => new Promise<void>((resolve, reject) => {
      worker.once("online", resolve);
      worker.once("error", reject);
    })));
    const results = workers.map((worker) => new Promise<GatewayIngressClaimStatus>((resolve, reject) => {
      worker.once("message", (message: { status?: GatewayIngressClaimStatus; error?: string }) => {
        if (message.error) reject(new Error(message.error));
        else if (message.status) resolve(message.status);
        else reject(new Error("Claim worker returned no status."));
      });
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code !== 0) reject(new Error(`Claim worker exited with code ${code}.`));
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
  test("two independent processes admit one inbound delivery before provider execution", async (t) => {
    const filename = databasePath(t);
    new EnterpriseSqliteStore(filename).close();
    const statuses = (await runClaimWorkers(filename)).sort();
    assert.deepEqual(statuses, ["claimed", "in-flight"]);

    const store = new EnterpriseSqliteStore(filename);
    const ingress = new DurableGatewayIngress(store, { defaultLeaseMs: 5_000 });
    assert.equal((await ingress.claim({ ...identity("event-concurrent"), nowMs: NOW + 1 })).status, "in-flight");
    store.close();
  });

  test("claims conflict on the wrong fingerprint and reclaim exactly at bounded lease expiry", async (t) => {
    const filename = databasePath(t);
    const firstStore = new EnterpriseSqliteStore(filename);
    const first = new DurableGatewayIngress(firstStore, { defaultLeaseMs: 1_000 });
    const event = identity("event-crash");
    const otherFingerprint = createGatewayIngressFingerprint(["different-event-metadata"]);

    assert.equal((await first.claim({ ...event, nowMs: NOW })).status, "claimed");
    firstStore.close();

    const recoveryStore = new EnterpriseSqliteStore(filename);
    const recovery = new DurableGatewayIngress(recoveryStore, { defaultLeaseMs: 1_000 });
    assert.equal((await recovery.claim({ ...event, nowMs: NOW + 999 })).status, "in-flight");
    assert.equal((await recovery.claim({ ...event, fingerprint: otherFingerprint, nowMs: NOW + 999 })).status, "conflict");
    const reclaimed = await recovery.claim({ ...event, fingerprint: otherFingerprint, nowMs: NOW + 1_000 });
    assert.equal(reclaimed.status, "claimed");
    assert.equal(reclaimed.lifecycle?.state, "accepted");
    recoveryStore.close();
  });

  test("completion stores only an opaque result reference and is duplicate-safe", async (t) => {
    const filename = databasePath(t);
    const store = new EnterpriseSqliteStore(filename);
    const ingress = new DurableGatewayIngress(store, { defaultLeaseMs: 30_000 });
    const privatePrompt = "Summarize acquisition target ALPHA using secret sk-live-never-persist";
    const event = {
      scope: "telegram:bot-secret-account",
      deliveryId: "private-update-991",
      fingerprint: createGatewayIngressFingerprint(["telegram", "991", privatePrompt]),
    } as const;

    await ingress.claim({ ...event, nowMs: NOW });
    await ingress.transition({ ...event, to: "running", nowMs: NOW + 1 });
    await ingress.transition({ ...event, to: "generated", nowMs: NOW + 2 });
    await assert.rejects(
      ingress.complete({ ...event, resultRef: privatePrompt as GatewaySafeResultRef, nowMs: NOW + 3 }),
      /opaque run, receipt, artifact, or delivery reference/,
    );

    const resultRef = createGatewaySafeResultRef("run", "01J2Y9A6WXR5N8P3C4Q7T1V0ZZ");
    const completed = await ingress.complete({ ...event, resultRef, nowMs: NOW + 4 });
    assert.equal(completed.status, "completed");
    assert.equal(completed.resultRef, resultRef);
    assert.equal((await ingress.complete({ ...event, resultRef, nowMs: NOW + 5 })).status, "replay");
    await assert.rejects(
      ingress.complete({
        ...event,
        resultRef: createGatewaySafeResultRef("run", "different-result"),
        nowMs: NOW + 6,
      }),
      /another result/,
    );
    const replay = await ingress.claim({ ...event, nowMs: NOW + 7 });
    assert.equal(replay.status, "replay");
    assert.equal(replay.resultRef, resultRef);
    store.close();

    const databaseBytes = readFileSync(filename).toString("utf8");
    assert.doesNotMatch(databaseBytes, /Summarize acquisition target|sk-live-never-persist|bot-secret-account|private-update-991/);
  });

  test("delivery lifecycle enforces ordering, survives restart, and counts run and delivery attempts", async (t) => {
    const filename = databasePath(t);
    const event = identity("event-lifecycle");
    let store = new EnterpriseSqliteStore(filename);
    let ingress = new DurableGatewayIngress(store, {
      defaultLeaseMs: 60_000,
      maxRunAttempts: 2,
      maxDeliveryAttempts: 2,
    });

    await ingress.claim({ ...event, nowMs: NOW });
    assert.deepEqual(await ingress.readLifecycle({ ...event, nowMs: NOW }), {
      state: "accepted",
      runAttempts: 0,
      deliveryAttempts: 0,
      transitionCount: 0,
      lastOperationalState: "accepted",
    });
    await assert.rejects(ingress.transition({ ...event, to: "generated", nowMs: NOW + 1 }), /Illegal.*accepted -> generated/);
    await assert.rejects(
      ingress.complete({ ...event, resultRef: createGatewaySafeResultRef("run", "too-early"), nowMs: NOW + 1 }),
      /cannot complete.*accepted/,
    );

    const running = await ingress.transition({ ...event, to: "running", nowMs: NOW + 2 });
    assert.deepEqual(
      { state: running.lifecycle.state, runs: running.lifecycle.runAttempts, deliveries: running.lifecycle.deliveryAttempts },
      { state: "running", runs: 1, deliveries: 0 },
    );
    const duplicateRunning = await ingress.transition({ ...event, to: "running", nowMs: NOW + 3 });
    assert.equal(duplicateRunning.status, "replay");
    assert.equal(duplicateRunning.lifecycle.transitionCount, 1);

    await ingress.transition({ ...event, to: "failed", nowMs: NOW + 4 });
    const retriedRun = await ingress.transition({ ...event, to: "running", nowMs: NOW + 5 });
    assert.equal(retriedRun.lifecycle.runAttempts, 2);
    const generated = await ingress.transition({ ...event, to: "generated", nowMs: NOW + 6 });
    assert.equal(generated.lifecycle.state, "generated");
    await ingress.complete({
      ...event,
      resultRef: createGatewaySafeResultRef("receipt", "generation-9f2a"),
      nowMs: NOW + 7,
    });
    const delivering = await ingress.transition({ ...event, to: "delivering", nowMs: NOW + 8 });
    assert.equal(delivering.lifecycle.deliveryAttempts, 1);
    const failedDelivery = await ingress.transition({ ...event, to: "failed", nowMs: NOW + 9 });
    assert.equal(failedDelivery.lifecycle.lastOperationalState, "delivering");
    await assert.rejects(ingress.transition({ ...event, to: "delivered", nowMs: NOW + 10 }), /Illegal.*failed -> delivered/);
    const deliveryRetry = await ingress.transition({ ...event, to: "delivering", nowMs: NOW + 11 });
    assert.equal(deliveryRetry.lifecycle.deliveryAttempts, 2);
    const delivered = await ingress.transition({ ...event, to: "delivered", nowMs: NOW + 12 });
    assert.deepEqual(
      {
        state: delivered.lifecycle.state,
        runs: delivered.lifecycle.runAttempts,
        deliveries: delivered.lifecycle.deliveryAttempts,
        transitions: delivered.lifecycle.transitionCount,
      },
      { state: "delivered", runs: 2, deliveries: 2, transitions: 8 },
    );
    await assert.rejects(ingress.transition({ ...event, to: "failed", nowMs: NOW + 13 }), /Illegal.*delivered -> failed/);
    store.close();

    store = new EnterpriseSqliteStore(filename);
    ingress = new DurableGatewayIngress(store, { defaultLeaseMs: 60_000 });
    const restored = await ingress.readLifecycle({ ...event, nowMs: NOW + 14 });
    assert.deepEqual(restored, delivered.lifecycle);
    store.close();
  });

  test("attempt caps and result reference validation fail closed", async (t) => {
    const filename = databasePath(t);
    const store = new EnterpriseSqliteStore(filename);
    const ingress = new DurableGatewayIngress(store, { maxRunAttempts: 1, defaultLeaseMs: 30_000 });
    const event = identity("event-attempt-cap");
    await ingress.claim({ ...event, nowMs: NOW });
    await ingress.transition({ ...event, to: "running", nowMs: NOW + 1 });
    await ingress.transition({ ...event, to: "failed", nowMs: NOW + 2 });
    await assert.rejects(ingress.transition({ ...event, to: "running", nowMs: NOW + 3 }), /run attempts exceeded 1/);
    assert.throws(() => createGatewaySafeResultRef("artifact", "../../etc/passwd"), /opaque run, receipt, artifact, or delivery/);
    assert.throws(() => createGatewaySafeResultRef("run", "id with secret text"), /opaque run, receipt, artifact, or delivery/);
    store.close();
  });
}
