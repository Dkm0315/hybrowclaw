import { createHash } from "node:crypto";
import type {
  EnterpriseIdempotencyRecord,
  EnterpriseIdempotencyStore,
} from "@musterhq/core";

const DEFAULT_LEASE_MS = 120_000;
const MIN_LEASE_MS = 100;
const MAX_LEASE_MS = 15 * 60_000;
const DEFAULT_MAX_TRANSITIONS = 32;
const MAX_TRANSITIONS_LIMIT = 128;
const DEFAULT_MAX_RUN_ATTEMPTS = 8;
const DEFAULT_MAX_DELIVERY_ATTEMPTS = 8;
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SAFE_RESULT_REF_PATTERN = /^(run|receipt|artifact|delivery):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DELIVERY_RESULT_PATTERN = /^delivery:(accepted|running|generated|delivering|delivered|failed)\.(\d+)\.(\d+)\.(accepted|running|generated|delivering|delivered)$/;

declare const ingressFingerprintBrand: unique symbol;
declare const safeResultRefBrand: unique symbol;

export type GatewayIngressFingerprint = string & { readonly [ingressFingerprintBrand]: true };
export type GatewaySafeResultRef = string & { readonly [safeResultRefBrand]: true };
export type GatewayIngressClaimStatus = "claimed" | "replay" | "conflict" | "in-flight";
export type GatewayIngressCompletionStatus = "completed" | "replay";
export type GatewayDeliveryTransitionStatus = "transitioned" | "replay" | "conflict" | "in-flight";
export type GatewayDeliveryState = "accepted" | "running" | "generated" | "delivering" | "delivered" | "failed";
type GatewayOperationalState = Exclude<GatewayDeliveryState, "failed">;

export interface GatewayIngressIdentity {
  /** Tenant/account/channel scope. It is hashed before persistence. */
  readonly scope: string;
  /** Platform delivery or event id. It is hashed before persistence. */
  readonly deliveryId: string;
  /** A SHA-256 digest of canonical event metadata, never the raw prompt. */
  readonly fingerprint: GatewayIngressFingerprint;
}

export interface GatewayIngressClaimInput extends GatewayIngressIdentity {
  readonly nowMs?: number;
  readonly leaseMs?: number;
}

export interface GatewayIngressCompleteInput extends GatewayIngressIdentity {
  readonly resultRef: GatewaySafeResultRef;
  readonly nowMs?: number;
}

export interface GatewayDeliveryTransitionInput extends GatewayIngressIdentity {
  readonly to: GatewayDeliveryState;
  readonly nowMs?: number;
}

export interface GatewayDeliveryLifecycle {
  readonly state: GatewayDeliveryState;
  readonly runAttempts: number;
  readonly deliveryAttempts: number;
  readonly transitionCount: number;
  readonly lastOperationalState: GatewayOperationalState;
  readonly transitionInFlight?: Readonly<{
    to: GatewayDeliveryState;
    leaseExpiresAt: string;
  }>;
}

export interface GatewayIngressClaimResult {
  readonly status: GatewayIngressClaimStatus;
  readonly claimedAt: string;
  readonly leaseExpiresAt: string;
  readonly resultRef?: GatewaySafeResultRef;
  readonly lifecycle?: GatewayDeliveryLifecycle;
}

export interface GatewayDeliveryTransitionResult {
  readonly status: GatewayDeliveryTransitionStatus;
  readonly lifecycle: GatewayDeliveryLifecycle;
}

export interface GatewayIngressCompletionResult {
  readonly status: GatewayIngressCompletionStatus;
  readonly claimedAt: string;
  readonly leaseExpiresAt: string;
  readonly resultRef: GatewaySafeResultRef;
  readonly lifecycle: GatewayDeliveryLifecycle;
}

export interface DurableGatewayIngressOptions {
  readonly namespacePrefix?: string;
  readonly defaultLeaseMs?: number;
  readonly maxTransitions?: number;
  readonly maxRunAttempts?: number;
  readonly maxDeliveryAttempts?: number;
  readonly clock?: () => number;
}

interface DurableGatewayIngressConfig {
  readonly namespacePrefix: string;
  readonly defaultLeaseMs: number;
  readonly maxTransitions: number;
  readonly maxRunAttempts: number;
  readonly maxDeliveryAttempts: number;
  readonly clock: () => number;
}

interface IngressAddress {
  readonly namespace: string;
  readonly key: string;
  readonly lifecycleNamespace: string;
  readonly lifecycleKeyPrefix: string;
}

interface LifecycleReadResult {
  readonly lifecycle: GatewayDeliveryLifecycle;
  readonly nextSlot: number;
  readonly pending?: EnterpriseIdempotencyRecord;
}

/** Hashes length-framed event metadata without retaining any input text. */
export function createGatewayIngressFingerprint(parts: readonly string[]): GatewayIngressFingerprint {
  if (parts.length === 0) throw new Error("Ingress fingerprint requires at least one metadata part.");
  const hash = createHash("sha256");
  for (const part of parts) {
    if (typeof part !== "string") throw new Error("Ingress fingerprint parts must be strings.");
    const length = Buffer.byteLength(part, "utf8");
    if (length > 65_536) throw new Error("Ingress fingerprint metadata parts must not exceed 65536 bytes.");
    hash.update(String(length));
    hash.update(":");
    hash.update(part);
    hash.update(";");
  }
  return `sha256:${hash.digest("hex")}` as GatewayIngressFingerprint;
}

export function parseGatewayIngressFingerprint(value: string): GatewayIngressFingerprint {
  if (!FINGERPRINT_PATTERN.test(value)) {
    throw new Error("Gateway ingress fingerprint must be a sha256:<64 lowercase hex> digest.");
  }
  return value as GatewayIngressFingerprint;
}

/** Creates an opaque reference. Model output, URLs, filesystem paths, and secrets are rejected. */
export function createGatewaySafeResultRef(
  kind: "run" | "receipt" | "artifact" | "delivery",
  opaqueId: string,
): GatewaySafeResultRef {
  return parseGatewaySafeResultRef(`${kind}:${opaqueId}`);
}

export function parseGatewaySafeResultRef(value: string): GatewaySafeResultRef {
  if (!SAFE_RESULT_REF_PATTERN.test(value)) {
    throw new Error("Gateway resultRef must be an opaque run, receipt, artifact, or delivery reference.");
  }
  return value as GatewaySafeResultRef;
}

export class DurableGatewayIngress {
  readonly #store: EnterpriseIdempotencyStore;
  readonly #config: DurableGatewayIngressConfig;

  constructor(store: EnterpriseIdempotencyStore, options: DurableGatewayIngressOptions = {}) {
    this.#store = store;
    const namespacePrefix = options.namespacePrefix ?? "muster:gateway:v1";
    if (!/^[A-Za-z0-9:_-]{1,80}$/.test(namespacePrefix)) {
      throw new Error("Gateway ingress namespace prefix must be 1-80 safe identifier characters.");
    }
    this.#config = Object.freeze({
      namespacePrefix,
      defaultLeaseMs: validateLeaseMs(options.defaultLeaseMs ?? DEFAULT_LEASE_MS),
      maxTransitions: boundedInteger(options.maxTransitions ?? DEFAULT_MAX_TRANSITIONS, 1, MAX_TRANSITIONS_LIMIT, "maxTransitions"),
      maxRunAttempts: boundedInteger(options.maxRunAttempts ?? DEFAULT_MAX_RUN_ATTEMPTS, 1, 100, "maxRunAttempts"),
      maxDeliveryAttempts: boundedInteger(
        options.maxDeliveryAttempts ?? DEFAULT_MAX_DELIVERY_ATTEMPTS,
        1,
        100,
        "maxDeliveryAttempts",
      ),
      clock: options.clock ?? Date.now,
    });
  }

  async claim(input: GatewayIngressClaimInput): Promise<GatewayIngressClaimResult> {
    const identity = validateIdentity(input);
    const nowMs = resolveNow(input.nowMs, this.#config.clock);
    const leaseMs = validateLeaseMs(input.leaseMs ?? this.#config.defaultLeaseMs);
    const address = ingressAddress(this.#config.namespacePrefix, identity.scope, identity.deliveryId);
    const claim = await this.#store.claimIdempotency({
      namespace: address.namespace,
      key: address.key,
      fingerprint: identity.fingerprint,
      ttlMs: leaseMs,
      nowMs,
    });

    if (claim.status === "conflict") return claimResult("conflict", claim.record);
    const lifecycle = await this.#readLifecycle(address, identity.fingerprint, nowMs);
    if (claim.status === "claimed") return claimResult("claimed", claim.record, lifecycle.lifecycle);
    return claimResult(
      claim.record.state === "completed" ? "replay" : "in-flight",
      claim.record,
      lifecycle.lifecycle,
    );
  }

  async readLifecycle(input: GatewayIngressIdentity & { readonly nowMs?: number }): Promise<GatewayDeliveryLifecycle | undefined> {
    const identity = validateIdentity(input);
    const nowMs = resolveNow(input.nowMs, this.#config.clock);
    const address = ingressAddress(this.#config.namespacePrefix, identity.scope, identity.deliveryId);
    const ingress = await this.#store.readIdempotency(address.namespace, address.key, nowMs);
    if (!ingress) return undefined;
    assertFingerprint(ingress, identity.fingerprint);
    return (await this.#readLifecycle(address, identity.fingerprint, nowMs)).lifecycle;
  }

  async transition(input: GatewayDeliveryTransitionInput): Promise<GatewayDeliveryTransitionResult> {
    const identity = validateIdentity(input);
    const nowMs = resolveNow(input.nowMs, this.#config.clock);
    const address = ingressAddress(this.#config.namespacePrefix, identity.scope, identity.deliveryId);
    const ingress = await this.#store.readIdempotency(address.namespace, address.key, nowMs);
    if (!ingress) throw new Error("Gateway ingress claim is missing or its lease expired.");
    assertFingerprint(ingress, identity.fingerprint);

    const current = await this.#readLifecycle(address, identity.fingerprint, nowMs);
    if (current.pending) {
      const pendingTarget = inferPendingTarget(current.lifecycle, current.nextSlot, identity.fingerprint, current.pending.fingerprint, this.#config);
      return {
        status: pendingTarget === input.to ? "in-flight" : "conflict",
        lifecycle: withPending(current.lifecycle, pendingTarget, current.pending.expiresAt),
      };
    }
    if (current.lifecycle.state === input.to) return { status: "replay", lifecycle: current.lifecycle };
    if (current.nextSlot > this.#config.maxTransitions) {
      throw new Error(`Gateway delivery exceeded ${this.#config.maxTransitions} durable transitions.`);
    }

    const next = nextLifecycle(current.lifecycle, input.to, this.#config);
    const transitionFingerprint = lifecycleFingerprint(identity.fingerprint, current.nextSlot, current.lifecycle, next);
    const remainingLeaseMs = Date.parse(ingress.expiresAt) - nowMs;
    if (remainingLeaseMs <= 0) throw new Error("Gateway ingress claim lease expired before the delivery transition.");
    const key = lifecycleSlotKey(address.lifecycleKeyPrefix, current.nextSlot);
    const claim = await this.#store.claimIdempotency({
      namespace: address.lifecycleNamespace,
      key,
      fingerprint: transitionFingerprint,
      ttlMs: remainingLeaseMs,
      nowMs,
    });

    if (claim.status === "conflict") return { status: "conflict", lifecycle: current.lifecycle };
    if (claim.status === "replay") {
      if (claim.record.state === "pending") {
        return { status: "in-flight", lifecycle: withPending(current.lifecycle, input.to, claim.record.expiresAt) };
      }
      return { status: "replay", lifecycle: applyCompletedTransition(current.lifecycle, claim.record, current.nextSlot, identity.fingerprint) };
    }

    const completed = await this.#store.completeIdempotency({
      namespace: address.lifecycleNamespace,
      key,
      fingerprint: transitionFingerprint,
      resultRef: lifecycleResultRef(next),
      nowMs,
    });
    return {
      status: "transitioned",
      lifecycle: applyCompletedTransition(current.lifecycle, completed, current.nextSlot, identity.fingerprint),
    };
  }

  async complete(input: GatewayIngressCompleteInput): Promise<GatewayIngressCompletionResult> {
    const identity = validateIdentity(input);
    const resultRef = parseGatewaySafeResultRef(input.resultRef);
    const nowMs = resolveNow(input.nowMs, this.#config.clock);
    const address = ingressAddress(this.#config.namespacePrefix, identity.scope, identity.deliveryId);
    const ingress = await this.#store.readIdempotency(address.namespace, address.key, nowMs);
    if (!ingress) throw new Error("Gateway ingress claim is missing or its lease expired.");
    assertFingerprint(ingress, identity.fingerprint);
    const lifecycle = (await this.#readLifecycle(address, identity.fingerprint, nowMs)).lifecycle;
    if (!(["generated", "delivering", "delivered"] as GatewayDeliveryState[]).includes(lifecycle.state)) {
      throw new Error(`Gateway ingress cannot complete while delivery state is ${lifecycle.state}.`);
    }
    const completed = await this.#store.completeIdempotency({
      namespace: address.namespace,
      key: address.key,
      fingerprint: identity.fingerprint,
      resultRef,
      nowMs,
    });
    return Object.freeze({
      status: ingress.state === "completed" ? "replay" : "completed",
      claimedAt: completed.claimedAt,
      leaseExpiresAt: completed.expiresAt,
      resultRef: parseGatewaySafeResultRef(completed.resultRef ?? ""),
      lifecycle,
    });
  }

  async #readLifecycle(
    address: IngressAddress,
    ingressFingerprint: GatewayIngressFingerprint,
    nowMs: number,
  ): Promise<LifecycleReadResult> {
    let lifecycle = initialLifecycle();
    for (let slot = 1; slot <= this.#config.maxTransitions; slot += 1) {
      const record = await this.#store.readIdempotency(
        address.lifecycleNamespace,
        lifecycleSlotKey(address.lifecycleKeyPrefix, slot),
        nowMs,
      );
      if (!record) return { lifecycle, nextSlot: slot };
      if (record.state === "pending") return { lifecycle, nextSlot: slot, pending: record };
      lifecycle = applyCompletedTransition(lifecycle, record, slot, ingressFingerprint);
    }
    return { lifecycle, nextSlot: this.#config.maxTransitions + 1 };
  }
}

function initialLifecycle(): GatewayDeliveryLifecycle {
  return Object.freeze({
    state: "accepted",
    runAttempts: 0,
    deliveryAttempts: 0,
    transitionCount: 0,
    lastOperationalState: "accepted",
  });
}

function nextLifecycle(
  current: GatewayDeliveryLifecycle,
  to: GatewayDeliveryState,
  config: DurableGatewayIngressConfig,
): GatewayDeliveryLifecycle {
  if (!isLegalTransition(current, to)) throw new Error(`Illegal gateway delivery transition: ${current.state} -> ${to}.`);
  const runAttempts = current.runAttempts + (to === "running" ? 1 : 0);
  const deliveryAttempts = current.deliveryAttempts + (to === "delivering" ? 1 : 0);
  if (runAttempts > config.maxRunAttempts) throw new Error(`Gateway run attempts exceeded ${config.maxRunAttempts}.`);
  if (deliveryAttempts > config.maxDeliveryAttempts) {
    throw new Error(`Gateway delivery attempts exceeded ${config.maxDeliveryAttempts}.`);
  }
  return Object.freeze({
    state: to,
    runAttempts,
    deliveryAttempts,
    transitionCount: current.transitionCount + 1,
    lastOperationalState: to === "failed" ? current.lastOperationalState : to,
  });
}

function isLegalTransition(current: GatewayDeliveryLifecycle, to: GatewayDeliveryState): boolean {
  if (current.state === "accepted") return to === "running" || to === "failed";
  if (current.state === "running") return to === "generated" || to === "failed";
  if (current.state === "generated") return to === "delivering" || to === "failed";
  if (current.state === "delivering") return to === "delivered" || to === "failed";
  if (current.state === "delivered") return false;
  return current.lastOperationalState === "generated" || current.lastOperationalState === "delivering"
    ? to === "delivering"
    : to === "running";
}

function legalTargets(current: GatewayDeliveryLifecycle): readonly GatewayDeliveryState[] {
  const states: readonly GatewayDeliveryState[] = ["accepted", "running", "generated", "delivering", "delivered", "failed"];
  return states.filter((state) => isLegalTransition(current, state));
}

function applyCompletedTransition(
  current: GatewayDeliveryLifecycle,
  record: EnterpriseIdempotencyRecord,
  slot: number,
  ingressFingerprint: GatewayIngressFingerprint,
): GatewayDeliveryLifecycle {
  if (!record.resultRef) throw new Error(`Gateway delivery transition ${slot} has no result reference.`);
  const match = DELIVERY_RESULT_PATTERN.exec(record.resultRef);
  if (!match) throw new Error(`Gateway delivery transition ${slot} has an invalid result reference.`);
  const next = Object.freeze({
    state: match[1] as GatewayDeliveryState,
    runAttempts: Number(match[2]),
    deliveryAttempts: Number(match[3]),
    transitionCount: current.transitionCount + 1,
    lastOperationalState: match[4] as GatewayOperationalState,
  });
  if (!isLegalTransition(current, next.state)) throw new Error(`Gateway delivery transition ${slot} violates lifecycle ordering.`);
  const expected = lifecycleFingerprint(ingressFingerprint, slot, current, next);
  if (record.fingerprint !== expected) throw new Error(`Gateway delivery transition ${slot} failed its fingerprint check.`);
  const calculated = nextLifecycle(current, next.state, {
    namespacePrefix: "verify",
    defaultLeaseMs: DEFAULT_LEASE_MS,
    maxTransitions: MAX_TRANSITIONS_LIMIT,
    maxRunAttempts: 100,
    maxDeliveryAttempts: 100,
    clock: Date.now,
  });
  if (
    calculated.runAttempts !== next.runAttempts
    || calculated.deliveryAttempts !== next.deliveryAttempts
    || calculated.lastOperationalState !== next.lastOperationalState
  ) {
    throw new Error(`Gateway delivery transition ${slot} has inconsistent attempt metadata.`);
  }
  return next;
}

function inferPendingTarget(
  current: GatewayDeliveryLifecycle,
  slot: number,
  ingressFingerprint: GatewayIngressFingerprint,
  pendingFingerprint: string,
  config: DurableGatewayIngressConfig,
): GatewayDeliveryState {
  for (const target of legalTargets(current)) {
    const next = nextLifecycle(current, target, config);
    if (lifecycleFingerprint(ingressFingerprint, slot, current, next) === pendingFingerprint) return target;
  }
  throw new Error(`Gateway delivery transition ${slot} has an unrecognized pending fingerprint.`);
}

function lifecycleFingerprint(
  ingressFingerprint: GatewayIngressFingerprint,
  slot: number,
  current: GatewayDeliveryLifecycle,
  next: GatewayDeliveryLifecycle,
): GatewayIngressFingerprint {
  return createGatewayIngressFingerprint([
    "gateway-delivery-v1",
    ingressFingerprint,
    String(slot),
    current.state,
    next.state,
    String(next.runAttempts),
    String(next.deliveryAttempts),
    next.lastOperationalState,
  ]);
}

function lifecycleResultRef(lifecycle: GatewayDeliveryLifecycle): string {
  return `delivery:${lifecycle.state}.${lifecycle.runAttempts}.${lifecycle.deliveryAttempts}.${lifecycle.lastOperationalState}`;
}

function withPending(
  lifecycle: GatewayDeliveryLifecycle,
  to: GatewayDeliveryState,
  leaseExpiresAt: string,
): GatewayDeliveryLifecycle {
  return Object.freeze({ ...lifecycle, transitionInFlight: Object.freeze({ to, leaseExpiresAt }) });
}

function claimResult(
  status: GatewayIngressClaimStatus,
  record: EnterpriseIdempotencyRecord,
  lifecycle?: GatewayDeliveryLifecycle,
): GatewayIngressClaimResult {
  const resultRef = record.resultRef ? parseGatewaySafeResultRef(record.resultRef) : undefined;
  return Object.freeze({
    status,
    claimedAt: record.claimedAt,
    leaseExpiresAt: record.expiresAt,
    ...(resultRef ? { resultRef } : {}),
    ...(lifecycle ? { lifecycle } : {}),
  });
}

function ingressAddress(prefix: string, scope: string, deliveryId: string): IngressAddress {
  const scopeHash = digest(scope);
  const deliveryHash = digest(deliveryId);
  return Object.freeze({
    namespace: `${prefix}:ingress:${scopeHash}`,
    key: `event:${deliveryHash}`,
    lifecycleNamespace: `${prefix}:delivery:${scopeHash}`,
    lifecycleKeyPrefix: `event:${deliveryHash}:transition`,
  });
}

function lifecycleSlotKey(prefix: string, slot: number): string {
  return `${prefix}:${String(slot).padStart(3, "0")}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateIdentity(input: GatewayIngressIdentity): Readonly<{
  scope: string;
  deliveryId: string;
  fingerprint: GatewayIngressFingerprint;
}> {
  validatePrivateIdentifier(input.scope, "Gateway ingress scope");
  validatePrivateIdentifier(input.deliveryId, "Gateway delivery id");
  return Object.freeze({
    scope: input.scope,
    deliveryId: input.deliveryId,
    fingerprint: parseGatewayIngressFingerprint(input.fingerprint),
  });
}

function validatePrivateIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must be a non-empty identifier of at most 1024 characters.`);
  }
}

function validateLeaseMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_LEASE_MS || value > MAX_LEASE_MS) {
    throw new Error(`Gateway ingress lease must be an integer between ${MIN_LEASE_MS} and ${MAX_LEASE_MS} ms.`);
  }
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function resolveNow(input: number | undefined, clock: () => number): number {
  const value = input ?? clock();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Gateway ingress time must be a non-negative integer timestamp.");
  return value;
}

function assertFingerprint(record: EnterpriseIdempotencyRecord, fingerprint: GatewayIngressFingerprint): void {
  if (record.fingerprint !== fingerprint) throw new Error("Gateway ingress fingerprint conflict.");
}
