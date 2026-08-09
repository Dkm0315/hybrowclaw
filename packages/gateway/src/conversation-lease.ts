import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { EnterpriseIdempotencyStore } from "@musterhq/core";

export interface ConversationLeaseOptions {
  readonly leaseMs?: number;
  readonly retryMs?: number;
  readonly clock?: () => number;
}

/** Cross-process conversation lock backed by the enterprise atomic store. */
export class DurableConversationLease {
  readonly #store: EnterpriseIdempotencyStore;
  readonly #leaseMs: number;
  readonly #retryMs: number;
  readonly #clock: () => number;

  constructor(store: EnterpriseIdempotencyStore, options: ConversationLeaseOptions = {}) {
    this.#store = store;
    this.#leaseMs = bounded(options.leaseMs ?? 120_000, 10_000, 15 * 60_000, "leaseMs");
    this.#retryMs = bounded(options.retryMs ?? 25, 5, 1_000, "retryMs");
    this.#clock = options.clock ?? Date.now;
  }

  async run<T>(conversationKey: string, task: () => Promise<T>): Promise<T> {
    if (!conversationKey) throw new Error("Conversation lease key is required.");
    const digest = createHash("sha256").update(conversationKey).digest("hex");
    const namespace = "muster:conversation-lease:v1";
    const key = digest;
    const fingerprint = `sha256:${digest}`;
    let claimToken = "";

    for (;;) {
      const nowMs = this.#clock();
      const claim = await this.#store.claimIdempotency({
        namespace,
        key,
        fingerprint,
        ttlMs: this.#leaseMs,
        nowMs,
      });
      if (claim.status === "claimed") {
        claimToken = claim.record.claimToken;
        break;
      }
      if (claim.status === "conflict") throw new Error("Conversation lease fingerprint conflict.");
      await delay(this.#retryMs);
    }

    let heartbeatError: unknown;
    let heartbeatRunning = false;
    const heartbeat = setInterval(() => {
      if (heartbeatRunning || heartbeatError) return;
      heartbeatRunning = true;
      void this.#store.renewIdempotency({
        namespace,
        key,
        fingerprint,
        claimToken,
        ttlMs: this.#leaseMs,
        nowMs: this.#clock(),
      }).catch((error) => { heartbeatError = error; }).finally(() => { heartbeatRunning = false; });
    }, Math.max(1_000, Math.floor(this.#leaseMs / 4)));
    heartbeat.unref?.();

    try {
      const result = await task();
      if (heartbeatError) throw new Error(`Conversation lease renewal failed: ${heartbeatError instanceof Error ? heartbeatError.message : String(heartbeatError)}`);
      return result;
    } finally {
      clearInterval(heartbeat);
      await this.#store.releaseIdempotency({
        namespace,
        key,
        fingerprint,
        claimToken,
        nowMs: this.#clock(),
      }).catch(() => false);
    }
  }
}

function bounded(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}
