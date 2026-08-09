import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import { FrappeSiteBindingCoordinator } from "../src/frappe-connect.js";
import { createVerifiedBindingFrappeEffectTransport, FRAPPE_EFFECT_CALLBACK_PATH } from "../src/frappe-effect-executor.js";
import type { GovernedFrappeEffectPlan } from "../src/frappe-effect-executor.js";

const origin = "https://erp.example.test";
const siteUuid = "123e4567-e89b-42d3-a456-426614174000";
const execution = { missionId: "MST-MSN-2026-00001", rootRunId: "run-1", nodeId: "write-1", actor: "operator@example.test" };

async function coordinator(fetcher: typeof fetch = fetch): Promise<{ registry: FrappeSiteBindingCoordinator; binding: ReturnType<FrappeSiteBindingCoordinator["authorization"]> }> {
  const registry = new FrappeSiteBindingCoordinator({ fetcher, now: () => 1_000_000 });
  const verifier = "v".repeat(64);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL("https://gateway.example.test/v1/frappe/site-bindings/authorize");
  authorize.search = new URLSearchParams({ response_type: "code", client_id: "frappe-site-bootstrap", redirect_uri: `${origin}/muster-connect`, state: "s".repeat(64), code_challenge: challenge, code_challenge_method: "S256", site_origin: origin }).toString();
  const redirect = new URL(registry.authorize(authorize));
  const exchanged = await registry.exchange({ grant_type: "authorization_code", code: redirect.searchParams.get("code"), code_verifier: verifier, redirect_uri: `${origin}/muster-connect`, site_origin: origin, site_uuid: siteUuid, site_challenge: "site-challenge-123456789" });
  registry.verify(exchanged.access_token!, { binding_id: exchanged.binding_id, tenant_id: exchanged.tenant_id, site_uuid: siteUuid, site_origin: origin, site_challenge: "site-challenge-123456789", gateway_challenge: exchanged.gateway_challenge });
  return { registry, binding: registry.authorization(exchanged.access_token!) };
}

function authority(tenantId: string) {
  return { tenantId, siteId: siteUuid, siteOrigin: origin, userId: execution.actor, permissionEpoch: "epoch-1", rolesHash: "a".repeat(64), schemaRevision: "schema-1", dataRevision: "data-1" };
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`;
}

test("verified binding transport calls only the fixed callback and signs the exact body", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const placeholder = await coordinator();
  const expected = authority(placeholder.binding.tenantId);
  const fetcher: typeof fetch = async (input, init) => {
    seen = { url: String(input), init: init! };
    return new Response(JSON.stringify({ message: { authority: expected } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const transport = createVerifiedBindingFrappeEffectTransport({ bindings: placeholder.registry, fetcher, now: () => 1_700_000_000_000 });
  const result = await transport.resolveAuthority({ execution, authority: expected, operation: { kind: "record", action: "create", doctype: "ToDo", values: {} }, signal: new AbortController().signal });
  assert.deepEqual(result, expected);
  assert.equal(seen?.url, `${origin}${FRAPPE_EFFECT_CALLBACK_PATH}`);
  assert.equal(seen?.init.method, "POST");
  const headers = new Headers(seen?.init.headers);
  const body = String(seen?.init.body);
  const timestamp = headers.get("x-muster-timestamp")!;
  const nonce = headers.get("x-muster-nonce")!;
  const expectedSignature = createHmac("sha256", placeholder.binding.secrets.hmacSecret)
    .update(`${timestamp}\n${nonce}\n${createHash("sha256").update(body).digest("hex")}`).digest("hex");
  assert.equal(headers.get("authorization"), `Bearer ${placeholder.binding.secrets.accessToken}`);
  assert.equal(headers.get("x-muster-signature"), `sha256=${expectedSignature}`);
  const envelope = JSON.parse(body).envelope;
  assert.equal(envelope.phase, "resolve");
  assert.equal(envelope.mission_id, execution.missionId);
  assert.equal(envelope.node_id, execution.nodeId);
  assert.equal("url" in envelope, false);
  assert.equal("method" in envelope, false);
  assert.equal("tool" in envelope, false);
});

test("transport denies cross-site authority before network", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; throw new Error("must not call"); };
  const { registry, binding } = await coordinator();
  const transport = createVerifiedBindingFrappeEffectTransport({ bindings: registry, fetcher });
  await assert.rejects(() => transport.resolveAuthority({ execution, authority: { ...authority(binding.tenantId), siteOrigin: "https://evil.example.test" }, operation: { kind: "record", action: "create", doctype: "ToDo", values: {} }, signal: new AbortController().signal }), /No reciprocally verified/);
  assert.equal(calls, 0);
});

test("transport refuses callback redirects and never follows an SSRF target", async () => {
  const { registry, binding } = await coordinator();
  const fetcher: typeof fetch = async () => new Response("", { status: 307, headers: { location: "https://evil.example.test/steal" } });
  const transport = createVerifiedBindingFrappeEffectTransport({ bindings: registry, fetcher });
  await assert.rejects(() => transport.resolveAuthority({ execution, authority: authority(binding.tenantId), operation: { kind: "record", action: "create", doctype: "ToDo", values: {} }, signal: new AbortController().signal }), /refused a redirect/);
});

test("transport accepts only a site-HMAC-signed server-side application receipt", async () => {
  const { registry, binding } = await coordinator();
  const effect: GovernedFrappeEffectPlan = {
    schemaVersion: 1, capability: "frappe.record.create", authority: authority(binding.tenantId),
    operation: { kind: "record", action: "create", doctype: "ToDo", values: { description: "Call customer" } },
    idempotencyKey: "effect-1", postconditions: [{ path: "$.description", operator: "equals", expected: "Call customer" }],
    approval: { receiptId: "approval-1", planHash: "a".repeat(64), actor: execution.actor, approvers: ["manager@example.test"], approvedAt: "2026-07-19T10:00:00Z", expiresAt: "2026-07-19T11:00:00Z", scope: ["frappe.record.create"], approvalClass: "single", proof: {} },
    planHash: "a".repeat(64),
  };
  const proposal = { planHash: effect.planHash, authority: effect.authority, summary: "Dry run", approvalBindingHash: "b".repeat(64) };
  const resultRef = { doctype: "ToDo", name: "TODO-1" };
  const receiptSignature = createHmac("sha256", binding.secrets.hmacSecret).update(canonical({ plan: effect.planHash, result: resultRef })).digest("hex");
  let forged = false;
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({ message: { application: { receiptId: "effect-1", resultRef, evidenceIds: ["evidence-1"], executionSurface: "server_side", receiptSignature: forged ? "0".repeat(64) : receiptSignature } } }), { status: 200 });
  const transport = createVerifiedBindingFrappeEffectTransport({ bindings: registry, fetcher });
  const application = await transport.apply({ execution, plan: effect, proposal, fencingToken: 1, signal: new AbortController().signal });
  assert.equal(application.executionSurface, "server_side");
  assert.equal(application.siteReceiptSignature, receiptSignature);
  forged = true;
  await assert.rejects(() => transport.apply({ execution, plan: effect, proposal, fencingToken: 2, signal: new AbortController().signal }), /receipt signature is invalid/i);
});
