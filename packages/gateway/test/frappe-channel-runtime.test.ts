import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfig, type FlowToolRegistry, type MusterConfig } from "@musterhq/core";
import { approvePairing, handleSurfaceMessage, requestPairing } from "../src/index.js";
import { createInMemoryGatewayEnterpriseRuntime } from "../src/enterprise-runtime.js";
import type { FrappeOAuthCoordinator } from "../src/frappe-oauth.js";

test("a normal Frappe-paired channel turn joins exact OAuth evidence before provider execution", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-channel-runtime-"));
  const messages: Array<{ role?: string; content?: string }> = [];
  const { createServer } = await import("node:http");
  const provider = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += String(chunk); });
    request.on("end", () => {
      messages.push(...((JSON.parse(body) as { messages: Array<{ role?: string; content?: string }> }).messages));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "You have one pending leave request." } }] }));
    });
  });
  await new Promise<void>((resolveListen) => provider.listen(0, "127.0.0.1", resolveListen));
  const address = provider.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = defaultConfig();
  const config: MusterConfig = {
    ...base,
    providers: { stub: { id: "stub", kind: "openai-compatible", baseUrl: `http://127.0.0.1:${port}/v1`, defaultModel: "stub", timeoutMs: 5_000 } },
    runtimes: { native: { id: "native", enabled: true, provider: "stub", routes: {} } },
    routing: { ...base.routing, defaultRuntime: "native" },
  };
  const pending = await requestPairing("telegram:oxygenhr", "42", cwd);
  const paired = await approvePairing(pending.code, cwd, {
    provider: "frappe",
    site: "https://erp.example.test",
    user: "asha@example.test",
    employee: "EMP-0042",
    employeeName: "Asha Example",
    roles: ["Employee"],
  });
  let liveArgs: Record<string, unknown> | undefined;
  const registry: FlowToolRegistry = {
    "frappe-federated-bridge__frappe_fast_route": async () => ({
      intent: "record_lookup",
      answerPath: "live_frappe",
      candidateDoctypes: ["Leave Application"],
      requiredChecks: ["live_frappe_permission_preflight"],
    }),
    "frappe-federated-bridge__frappe_semantic_data_resolve_lite": async (args) => {
      liveArgs = args;
      return { doctype: "Leave Application", rows: [{ name: "LEAVE-0001", modified: "2026-07-13" }], count: 1 };
    },
  };
  const frappeOAuth = {
    authorizationForActor: async () => ({
      connectionId: "oxygenhr",
      site: "https://erp.example.test",
      header: "Bearer live-user-secret",
      identity: { site: "https://erp.example.test", user: "asha@example.test", employee: "EMP-0042", roles: ["Employee"] },
    }),
  } as unknown as FrappeOAuthCoordinator;
  try {
    const reply = await handleSurfaceMessage({
      surfaceId: "telegram:oxygenhr",
      conversationId: "chat-1",
      senderId: "42",
      pairingId: paired.pairingId,
      text: "Summarize my pending leave requests",
    }, {
      config,
      gateway: { token: "test", frappe: { assistant: { name: "OxygenHR Assistant" } } },
      cwd,
      registry,
      frappeOAuth,
    });
    assert.equal("text" in reply ? reply.text : undefined, "You have one pending leave request.");
    const system = messages.filter((message) => message.role === "system").map((message) => message.content ?? "").join("\n");
    assert.match(system, /OxygenHR Assistant/);
    assert.match(system, /LEAVE-0001/);
    assert.doesNotMatch(system, /live-user-secret/);
    assert.equal(messages.at(-1)?.content, "Summarize my pending leave requests");
    assert.equal(liveArgs?.apiToken, "live-user-secret");
  } finally {
    provider.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a guided Frappe create keeps required-field state across natural follow-up turns", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-guided-create-"));
  const base = defaultConfig();
  const pending = await requestPairing("telegram:assistant", "42", cwd);
  const paired = await approvePairing(pending.code, cwd, {
    provider: "frappe",
    site: "https://erp.example.test",
    user: "asha@example.test",
    employee: "EMP-0042",
    employeeName: "Asha Example",
    roles: ["Employee"],
  });
  const enterprise = createInMemoryGatewayEnterpriseRuntime();
  let providerCalls = 0;
  const interactionCalls: Record<string, unknown>[] = [];
  const safeWriteCalls: Record<string, unknown>[] = [];
  const registry: FlowToolRegistry = {
    "frappe-federated-bridge__frappe_fast_route": async () => ({
      intent: "record_create",
      candidateDoctypes: ["Support Request"],
    }),
    "frappe-federated-bridge__frappe_chat_interaction_plan": async (args) => {
      interactionCalls.push(args);
      const values = args.values as Record<string, unknown>;
      return {
        kind: "guided_crud",
        title: values.subject ? "Review support request" : "Create support request",
        doctype: "Support Request",
        operation: "create",
        requiredFields: values.subject
          ? []
          : [{ fieldname: "subject", label: "Subject", reason: "Required by the current form." }],
        table: values.subject ? { columns: ["Field", "Value"], rows: [["Subject", String(values.subject)]] } : undefined,
      };
    },
    "frappe-federated-bridge__frappe_safe_write": async (args) => {
      safeWriteCalls.push(args);
      if (!args.approvalReceipt) {
        return {
          status: "approval_required",
          approvalProposal: {
            proposalId: "frappe-approval:test",
            mutationHash: "mutation-hash",
            site: "https://erp.example.test",
            principal: "asha@example.test",
            operation: "create",
            doctype: "Support Request",
            fields: ["subject"],
            permissionEpoch: "permission-1",
            schemaRevision: "schema-1",
            dataRevision: "data-1",
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
            nonce: "nonce-1",
            humanSummary: "Create Support Request with 1 field.",
            bindingRequirements: [],
          },
        };
      }
      return {
        status: "executed",
        result: { created: { name: "SUP-0001", ...(args.doc as Record<string, unknown>) } },
        verification: { verified: true, fetched: { name: "SUP-0001", ...(args.doc as Record<string, unknown>) } },
      };
    },
  };
  const frappeOAuth = {
    authorizationForActor: async () => ({
      connectionId: "example",
      site: "https://erp.example.test",
      header: "Bearer live-user-secret",
      identity: { site: "https://erp.example.test", user: "asha@example.test", employee: "EMP-0042", roles: ["Employee"] },
    }),
  } as unknown as FrappeOAuthCoordinator;
  const config: MusterConfig = {
    ...base,
    providers: {
      stub: {
        id: "stub",
        kind: "openai-compatible",
        baseUrl: "http://127.0.0.1:1/v1",
        defaultModel: "stub",
        timeoutMs: 100,
      },
    },
    runtimes: { native: { id: "native", enabled: true, provider: "stub", routes: {} } },
    routing: { ...base.routing, defaultRuntime: "native" },
  };
  const send = (text: string) => handleSurfaceMessage({
    surfaceId: "telegram:assistant",
    conversationId: "chat-1",
    senderId: "42",
    pairingId: paired.pairingId,
    text,
  }, {
    config,
    gateway: { token: "test", frappe: { approvalSigningKey: "test-signing-key" } },
    cwd,
    registry: new Proxy(registry, { get(target, property) { return property in target ? target[property as keyof typeof target] : (() => { providerCalls += 1; }); } }),
    frappeOAuth,
    enterprise,
  });
  try {
    const first = await send("Create a support ticket for me");
    assert.match("text" in first ? first.text : "", /what should the subject be/i);
    assert.doesNotMatch("text" in first ? first.text : "", /doctype|fieldname/i);

    await send("How much leave do I have left?");
    assert.equal(interactionCalls.at(-1)?.prompt, "How much leave do I have left?");
    assert.equal((interactionCalls.at(-1)?.values as Record<string, unknown>).subject, undefined);

    const second = await send("test");
    assert.match("text" in second ? second.text : "", /review your request/i);
    assert.match("text" in second ? second.text : "", /Subject.*test/is);
    assert.match("text" in second ? second.text : "", /review it before anything is saved/i);
    assert.deepEqual("presentation" in second ? second.presentation?.actions?.map((action) => action.label) : [], ["Accept & create", "Cancel this request"]);
    assert.equal(providerCalls, 0);

    const cancelled = await send("/cancel");
    assert.match("text" in cancelled ? cancelled.text : "", /request cancelled/i);

    await send("Create a support ticket for me");
    const review = await send("final issue");
    assert.match("text" in review ? review.text : "", /review your request/i);
    const accepted = await send("/accept");
    assert.match("text" in accepted ? accepted.text : "", /created/i);
    assert.match("text" in accepted ? accepted.text : "", /SUP-0001/);
    assert.equal("presentation" in accepted ? accepted.presentation?.tables?.[0]?.rows[0]?.[1] : undefined, "https://erp.example.test/app/support-request/SUP-0001");
    assert.equal(safeWriteCalls.length, 2);
    const receipt = safeWriteCalls[1]?.approvalReceipt as Record<string, unknown>;
    assert.equal(receipt.approvedBy, "asha@example.test");
    assert.equal(typeof receipt.signature, "string");
    const replay = await send("/accept");
    assert.match("text" in replay ? replay.text : "", /no request waiting/i);
    assert.equal(safeWriteCalls.length, 2);
  } finally {
    await enterprise.close?.();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("issue reporting targets the configured Helpdesk OAuth grant and preserves governed creation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-support-report-"));
  const base = defaultConfig();
  const pending = await requestPairing("telegram:vinman", "42", cwd);
  const paired = await approvePairing(pending.code, cwd, {
    provider: "frappe",
    site: "https://vinman.example.test",
    user: "engineer@example.test",
    userName: "NPD Engineer",
    roles: ["NPD User"],
  });
  const enterprise = createInMemoryGatewayEnterpriseRuntime();
  const interactionCalls: Record<string, unknown>[] = [];
  const safeWriteCalls: Record<string, unknown>[] = [];
  let throwOnExecution = false;
  let reconcileRecord: Record<string, unknown> | undefined;
  let lastExecutedRecord: Record<string, unknown> | undefined;
  const registry: FlowToolRegistry = {
    "frappe-federated-bridge__frappe_fast_route": async () => ({ intent: "record_create", candidateDoctypes: ["HD Ticket"] }),
    "frappe-federated-bridge__frappe_chat_interaction_plan": async (args) => {
      interactionCalls.push(args);
      return {
        kind: "guided_crud",
        title: "Review support ticket",
        doctype: "HD Ticket",
        operation: "create",
        requiredFields: [],
        table: { columns: ["Field", "Value"], rows: [["Subject", String((args.values as Record<string, unknown>).subject)]] },
      };
    },
    "frappe-federated-bridge__frappe_safe_write": async (args) => {
      safeWriteCalls.push(args);
      if (!args.approvalReceipt) return {
        status: "approval_required",
        approvalProposal: {
          proposalId: "frappe-approval:hybrow-support",
          mutationHash: "support-mutation-hash",
          site: "https://support.hybrowlabs.com",
          principal: "engineer@example.test",
          operation: "create",
          doctype: "HD Ticket",
          fields: ["subject", "description"],
          permissionEpoch: "permission-1",
          schemaRevision: "schema-1",
          dataRevision: "data-1",
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          nonce: "nonce-support-1",
          humanSummary: "Create an evidence-rich Helpdesk ticket.",
          bindingRequirements: [],
        },
      };
      if (throwOnExecution) {
        reconcileRecord = { name: "HD-TICKET-UNCERTAIN", ...(args.doc as Record<string, unknown>) };
        throw new Error("ambiguous upstream timeout");
      }
      lastExecutedRecord = { name: "HD-TICKET-0042", ...(args.doc as Record<string, unknown>) };
      return {
        status: "executed",
        result: { created: lastExecutedRecord },
        verification: { verified: true, fetched: lastExecutedRecord },
      };
    },
  };
  const authorizationSites: string[] = [];
  const frappeOAuth = {
    authorization: async (connectionId: string) => {
      authorizationSites.push(`connection:${connectionId}`);
      return connectionId === "hybrow-support" ? {
        connectionId,
        site: "https://support.hybrowlabs.com",
        header: "Bearer support-user-secret",
        identity: { site: "https://support.hybrowlabs.com", user: "engineer@example.test", userName: "NPD Engineer", roles: ["Customer"] },
      } : undefined;
    },
    authorizationForActor: async (_actor: unknown, expectedSite?: string) => {
      authorizationSites.push(expectedSite ?? "");
      if (expectedSite === "https://support.hybrowlabs.com") return {
        connectionId: "hybrow-support",
        site: expectedSite,
        header: "Bearer support-user-secret",
        identity: { site: expectedSite, user: "engineer@example.test", userName: "NPD Engineer", roles: ["Customer"] },
      };
      if (expectedSite === "https://vinman.example.test") return {
        connectionId: "vinman",
        site: expectedSite,
        header: "Bearer vinman-user-secret",
        identity: { site: expectedSite, user: "engineer@example.test", userName: "NPD Engineer", roles: ["NPD User"] },
      };
      return undefined;
    },
  } as unknown as FrappeOAuthCoordinator;
  const send = (text: string) => handleSurfaceMessage({
    surfaceId: "telegram:vinman",
    conversationId: "chat-1",
    senderId: "42",
    pairingId: paired.pairingId,
    text,
  }, {
    config: { ...base, providers: {}, runtimes: {}, routing: { ...base.routing, defaultRuntime: "native" } },
    gateway: { token: "test", frappe: { approvalSigningKey: "support-signing-key", support: { connectionId: "hybrow-support", customer: "Vinman Engineering Private Limited" } } },
    cwd,
    registry,
    frappeOAuth,
    enterprise,
    fetcher: async (input) => {
      const url = new URL(String(input));
      const direct = /\/api\/resource\/HD%20Ticket\//.test(url.pathname);
      return new Response(JSON.stringify({ data: direct ? lastExecutedRecord : reconcileRecord ? [reconcileRecord] : [] }), {
        status: direct && !lastExecutedRecord ? 404 : 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  try {
    const reply = await send("Report this engineering revision mismatch to support");
    assert.match("text" in reply ? reply.text : "", /review the support ticket/i);
    assert.deepEqual("presentation" in reply ? reply.presentation?.actions?.map((action) => action.label) : [], ["Approve & send to support", "Cancel ticket"]);
    const previewRows = "presentation" in reply ? reply.presentation?.tables?.[0]?.rows ?? [] : [];
    assert.match(String(previewRows.find((row) => row[0] === "Evidence preview")?.[1]), /Source site/);
    assert.ok(authorizationSites.includes("connection:hybrow-support"));
    assert.equal(interactionCalls.at(-1)?.siteUrl, "https://support.hybrowlabs.com");
    assert.equal(interactionCalls.at(-1)?.apiToken, "support-user-secret");
    assert.doesNotMatch(JSON.stringify(interactionCalls.at(-1)), /vinman-user-secret/);
    assert.equal((interactionCalls.at(-1)?.values as Record<string, unknown>).customer, "Vinman Engineering Private Limited");
    assert.match(String((interactionCalls.at(-1)?.values as Record<string, unknown>).description), /Source site/);
    const created = await send("/accept");
    assert.match("text" in created ? created.text : "", /HD-TICKET-0042/);
    assert.equal("presentation" in created ? created.presentation?.tables?.[0]?.rows[0]?.[1] : undefined,
      "https://support.hybrowlabs.com/app/hd-ticket/HD-TICKET-0042");
    assert.equal(safeWriteCalls.length, 2);
    assert.equal(safeWriteCalls[0]?.siteUrl, "https://support.hybrowlabs.com");
    assert.equal(safeWriteCalls[1]?.siteUrl, "https://support.hybrowlabs.com");
    assert.equal((safeWriteCalls[0]?.doc as Record<string, unknown>).customer, "Vinman Engineering Private Limited");

    await send("Please raise this engineering mismatch with support");
    const concurrentStart = safeWriteCalls.length;
    const concurrent = await Promise.all([send("/accept"), send("/accept")]);
    assert.equal(
      safeWriteCalls.slice(concurrentStart).filter((args) => args.approvalReceipt).length,
      1,
      "atomic admission must allow only one executed write",
    );
    assert.ok(concurrent.every((reply) => /already being processed|created|no request waiting/i.test("text" in reply ? reply.text : "")));

    await send("after update this page not opening. check and send to support");
    throwOnExecution = true;
    const uncertain = await send("/accept");
    assert.match("text" in uncertain ? uncertain.text : "", /will not send the request again/i);
    const callsAfterUncertainResult = safeWriteCalls.length;
    reconcileRecord = undefined;
    const unresolvedRetry = await send("/accept");
    assert.match("text" in unresolvedRetry ? unresolvedRetry.text : "", /already admitted|will not send it again/i);
    assert.equal(safeWriteCalls.length, callsAfterUncertainResult, "an uncertain write must never be replayed blindly");
    const unsafeCancel = await send("/cancel");
    assert.match("text" in unsafeCancel ? unsafeCancel.text : "", /cannot be discarded safely/i);
    assert.equal(safeWriteCalls.length, callsAfterUncertainResult, "cancelling an uncertain write must not execute or erase it");
    reconcileRecord = { name: "HD-TICKET-UNCERTAIN", ...(safeWriteCalls.at(-1)?.doc as Record<string, unknown>) };
    const reconciled = await send("/accept");
    assert.match("text" in reconciled ? reconciled.text : "", /HD-TICKET-UNCERTAIN/);
    assert.equal(safeWriteCalls.length, callsAfterUncertainResult, "reconciliation must remain read-only");
  } finally {
    await enterprise.close?.();
    await rm(cwd, { recursive: true, force: true });
  }
});
