import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfig, type MusterConfig } from "@musterhq/core";
import {
  approvePairing,
  createFrappeSupportDraft,
  createGuestFrappeSupportTicket,
  createInMemoryGatewayEnterpriseRuntime,
  gatewayStartupErrors,
  handleSurfaceMessage,
  reconcileGuestFrappeSupportTicket,
  requestPairing,
  resolveFrappeSupportDestination,
} from "../src/index.js";
import type { PairedIdentity } from "../src/pairing.js";

const destinationSite = "https://support.example.test";
const identity: PairedIdentity = {
  provider: "frappe",
  site: "https://customer.example.test",
  user: "engineer@example.test",
  userName: "NPD Engineer",
  roles: ["NPD User"],
  resolvedAt: "2026-08-16T00:00:00.000Z",
};

function guestDestination() {
  return resolveFrappeSupportDestination({ site: destinationSite, doctype: "HD Ticket", authMode: "guest" });
}

function reviewedValues() {
  return createFrappeSupportDraft({
    prompt: "the migrated report is broken, send this issue to support",
    identity,
    context: { doctype: "Report", docname: "MUSTER-DEMO-V16", summary: "The v16 report still resolves a removed field." },
    config: { site: destinationSite, doctype: "HD Ticket", authMode: "guest" },
  }).values;
}

test("guest intake is explicit and cannot inherit defaults or mix OAuth credentials", () => {
  assert.equal(guestDestination().authMode, "guest");
  assert.equal(resolveFrappeSupportDestination().authMode, "oauth");
  assert.throws(() => resolveFrappeSupportDestination({ authMode: "guest", site: destinationSite }), /explicit site and ticket type/i);
  assert.throws(() => resolveFrappeSupportDestination({ authMode: "guest", doctype: "HD Ticket" }), /explicit site and ticket type/i);
  assert.throws(() => resolveFrappeSupportDestination({ authMode: "guest", site: destinationSite, doctype: "HD Ticket", connectionId: "oauth" }), /cannot use an OAuth/i);
  assert.throws(() => resolveFrappeSupportDestination({ authMode: "guest", site: "http://support.example.test", doctype: "HD Ticket" }), /HTTPS origin/i);
  assert.throws(() => resolveFrappeSupportDestination({ authMode: "public" as "guest", site: destinationSite, doctype: "HD Ticket" }), /authentication mode is unsupported/i);
  assert.throws(() => resolveFrappeSupportDestination({ authMode: "guest", site: destinationSite, doctype: "User" as "HD Ticket" }), /ticket type is unsupported/i);
  const errors = gatewayStartupErrors({
    token: "x".repeat(32),
    security: { deployment: "production" },
    frappe: { support: { authMode: "guest", site: destinationSite, doctype: "HD Ticket" } },
  });
  assert.equal(errors.some((error) => /OAuth connection/i.test(error)), false);
});

test("guest client issues one POST and verifies the returned ticket with a public reread", async () => {
  const values = reviewedValues();
  const created = { name: "HD-TICKET-0001", doctype: "HD Ticket", ...values };
  const calls: Array<{ method: string; url: string; authorization?: string | null }> = [];
  const result = await createGuestFrappeSupportTicket({
    destination: guestDestination(),
    values,
    fetcher: async (input, init) => {
      calls.push({ method: init?.method ?? "GET", url: String(input), authorization: new Headers(init?.headers).get("authorization") });
      return init?.method === "POST"
        ? Response.json({ data: created })
        : Response.json({ data: created });
    },
  });
  assert.deepEqual(result, { state: "verified", name: "HD-TICKET-0001", record: created, verification: "reread" });
  assert.deepEqual(calls.map((call) => call.method), ["POST", "GET"]);
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(calls[0]?.url, `${destinationSite}/api/resource/HD%20Ticket`);
  assert.equal(calls[1]?.url, `${destinationSite}/api/resource/HD%20Ticket/HD-TICKET-0001`);
  assert.ok(calls.every((call) => !call.authorization), "guest requests must never attach an OAuth header");
});

test("guest client fails closed on rejected, incomplete, and mismatched results", async () => {
  const values = reviewedValues();
  const rejected = await createGuestFrappeSupportTicket({
    destination: guestDestination(),
    values,
    fetcher: async () => Response.json({ exception: "MandatoryError: customer" }, { status: 422 }),
  });
  assert.equal(rejected.state, "rejected");

  const incomplete = await createGuestFrappeSupportTicket({
    destination: guestDestination(),
    values,
    fetcher: async (_input, init) => init?.method === "POST"
      ? Response.json({ data: { name: "HD-TICKET-0002" } })
      : new Response("forbidden", { status: 403 }),
  });
  assert.equal(incomplete.state, "uncertain");

  const mismatched = await createGuestFrappeSupportTicket({
    destination: guestDestination(),
    values,
    fetcher: async (_input, init) => init?.method === "POST"
      ? Response.json({ data: { name: "HD-TICKET-0003", doctype: "HD Ticket", ...values } })
      : Response.json({ data: { name: "HD-TICKET-0003", doctype: "HD Ticket", ...values, subject: "Different" } }),
  });
  assert.equal(mismatched.state, "uncertain");
});

test("guest reconciliation uses the embedded reference and requires one exact matching row", async () => {
  const values = reviewedValues();
  const record = { name: "HD-TICKET-0004", doctype: "HD Ticket", ...values };
  const urls: string[] = [];
  const verified = await reconcileGuestFrappeSupportTicket({
    destination: guestDestination(),
    values,
    fetcher: async (input, init) => {
      assert.equal(init?.method, "GET");
      urls.push(String(input));
      return Response.json({ data: [record] });
    },
  });
  assert.equal(verified.state, "verified");
  assert.match(urls[0] ?? "", /filters=.*MUSTER-/);

  const duplicate = await reconcileGuestFrappeSupportTicket({
    destination: guestDestination(),
    values,
    fetcher: async () => Response.json({ data: [record, { ...record, name: "HD-TICKET-0005" }] }),
  });
  assert.equal(duplicate.state, "uncertain");
  assert.match(duplicate.reason, /More than one/i);
});

async function guestHarness(fetcher: typeof fetch) {
  const cwd = await mkdtemp(join(tmpdir(), "muster-guest-support-"));
  const base = defaultConfig();
  const config: MusterConfig = { ...base, providers: {}, runtimes: {}, routing: { ...base.routing, defaultRuntime: "native" } };
  const requested = await requestPairing("frappe:customer.example.test", identity.user, cwd);
  const paired = await approvePairing(requested.code, cwd, identity);
  const enterprise = createInMemoryGatewayEnterpriseRuntime();
  const gateway = {
    token: "test",
    frappe: {
      support: {
        site: destinationSite,
        doctype: "HD Ticket" as const,
        authMode: "guest" as const,
        customer: "Example Customer",
      },
    },
  };
  const trustedFrappe = {
    doctype: "Report",
    docname: "MUSTER-DEMO-V16",
    pageName: "Migration readiness report",
    summary: "The restored v15 report fails against a removed v16 field.",
    supportEvidence: {
      expected: "The report opens on v16.",
      observed: "The report still queries a removed field.",
      validation: ["Failure reproduced twice on the isolated demo record."],
    },
  };
  const send = (text: string) => handleSurfaceMessage({
    surfaceId: "frappe:customer.example.test",
    conversationId: "scenario-4",
    senderId: identity.user,
    pairingId: paired.pairingId,
    text,
  }, { config, gateway, cwd, enterprise, trustedFrappe, fetcher });
  return { cwd, enterprise, send, gateway };
}

test("guest scenario reviews before I/O, skips OAuth, posts once, verifies, and suppresses replay", async () => {
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  let created: Record<string, unknown> | undefined;
  const harness = await guestHarness(async (input, init) => {
    calls.push({ method: init?.method ?? "GET", url: String(input), body: typeof init?.body === "string" ? init.body : undefined });
    if (init?.method === "POST") {
      const values = JSON.parse(String(init.body)) as Record<string, unknown>;
      created = { name: "HD-TICKET-GUEST-0001", doctype: "HD Ticket", ...values };
      return Response.json({ data: created });
    }
    return Response.json({ data: created });
  });
  try {
    const review = await harness.send("this report broke after migration, send this issue to support");
    assert.equal(review.presentation?.title, "Review the support ticket");
    assert.deepEqual(review.presentation?.actions?.map((action) => action.label), ["Approve & send to support", "Cancel ticket"]);
    assert.equal(calls.length, 0, "review must not contact the public endpoint");
    assert.doesNotMatch(review.text, /connect support|oauth|pair/i);

    const accepted = await harness.send("/accept");
    assert.equal(accepted.presentation?.title, "Sent to support");
    assert.equal(accepted.presentation?.tables?.[0]?.rows[0]?.[0], "HD-TICKET-GUEST-0001");
    assert.equal(calls.filter((call) => call.method === "POST").length, 1);
    const replay = await harness.send("/accept");
    assert.match(replay.text, /no request waiting/i);
    assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  } finally {
    await harness.enterprise.close?.();
    await rm(harness.cwd, { recursive: true, force: true });
  }
});

test("an uncertain guest submission reconciles on the next approval without another POST", async () => {
  let postCalls = 0;
  let listCalls = 0;
  let submitted: Record<string, unknown> | undefined;
  const harness = await guestHarness(async (input, init) => {
    if (init?.method === "POST") {
      postCalls += 1;
      const values = JSON.parse(String(init.body)) as Record<string, unknown>;
      submitted = { name: "HD-TICKET-GUEST-0002", doctype: "HD Ticket", ...values };
      throw new Error("connection reset after upstream commit");
    }
    const url = new URL(String(input));
    if (url.searchParams.has("filters")) {
      listCalls += 1;
      return Response.json({ data: [submitted] });
    }
    return new Response("not available", { status: 403 });
  });
  try {
    await harness.send("the migration report failed, raise this with support");
    const uncertain = await harness.send("/accept");
    assert.match(uncertain.text, /will not send the ticket again/i);
    assert.equal(postCalls, 1);
    const reconciled = await harness.send("/accept");
    assert.equal(reconciled.presentation?.title, "Sent to support");
    assert.equal(postCalls, 1, "reconciliation must not POST again");
    assert.equal(listCalls, 1);
  } finally {
    await harness.enterprise.close?.();
    await rm(harness.cwd, { recursive: true, force: true });
  }
});

test("guest execution fails closed if the configured origin changes after review", async () => {
  let calls = 0;
  const harness = await guestHarness(async () => {
    calls += 1;
    return Response.json({ data: {} });
  });
  try {
    await harness.send("the v16 report is broken, send this to support");
    (harness.gateway.frappe.support as { site: string }).site = "https://other-support.example.test";
    const result = await harness.send("/accept");
    assert.match(result.text, /authorization is unavailable|reconnect/i);
    assert.equal(calls, 0);
  } finally {
    await harness.enterprise.close?.();
    await rm(harness.cwd, { recursive: true, force: true });
  }
});
