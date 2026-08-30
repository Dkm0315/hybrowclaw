import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfig, type FlowToolRegistry, type MusterConfig } from "@musterhq/core";
import {
  approvePairing,
  createFrappeSupportDraft,
  DEFAULT_FRAPPE_SUPPORT_SITE,
  gatewayStartupErrors,
  handleSurfaceMessage,
  isFrappeIssueReportRequest,
  requestPairing,
  resolveFrappeSupportDestination,
} from "../src/index.js";
import { createInMemoryGatewayEnterpriseRuntime } from "../src/enterprise-runtime.js";
import type { FrappeOAuthCoordinator } from "../src/frappe-oauth.js";
import type { PairedIdentity } from "../src/pairing.js";

const identity: PairedIdentity = {
  provider: "frappe",
  site: "https://vinman.example.test",
  user: "engineer@example.test",
  userName: "NPD Engineer",
  roles: ["NPD User"],
  resolvedAt: "2026-08-15T00:00:00.000Z",
};

test("support reporting has a safe default and recognizes natural requests", () => {
  assert.equal(resolveFrappeSupportDestination().site, DEFAULT_FRAPPE_SUPPORT_SITE);
  assert.equal(resolveFrappeSupportDestination().doctype, "HD Ticket");
  assert.equal(isFrappeIssueReportRequest("Please raise this with support"), true);
  assert.equal(isFrappeIssueReportRequest("after update this page not opening. check and send to support"), true);
  assert.equal(isFrappeIssueReportRequest("create a support ticket for this migration failure"), true);
  assert.equal(isFrappeIssueReportRequest("prepare a ticket for support with this customization evidence"), true);
  assert.equal(isFrappeIssueReportRequest("do not send this to support"), false);
  assert.equal(isFrappeIssueReportRequest("Explain this control plan"), false);
});

test("support evidence is bounded, linked, and redacts credentials", () => {
  const draft = createFrappeSupportDraft({
    prompt: "/report-issue downstream engineering records still use the previous revision",
    identity,
    context: {
      doctype: "Control Plan",
      docname: "CP-0042",
      pageName: "Control Plan CP-0042",
      summary: "Observed revision B. api_key=should-not-leak Authorization: Bearer secret-value",
    },
    config: { connectionId: "hybrow-support", priority: "High", customer: "Vinman App" },
    investigation: {
      expected: "Drawing revision B should reach production and inspection.",
      observed: "Process Flow and Quality Inspection still use revision A.",
      businessImpact: "Production could manufacture or inspect against an obsolete specification.",
      likelyLocations: ["Control Plan process table mapping", "Quality Inspection population script"],
      affectedRecords: [
        { label: "Control Plan", doctype: "Control Plan", name: "CP-0042" },
        { label: "Process Flow", doctype: "Process Flow", name: "PF-0042" },
      ],
      appVersions: { frappe: "16.27.1", vinman_app: "version-16" },
      reproduction: ["Open the revised Control Plan.", "Compare the linked Process Flow revision."],
      validation: ["lineage:Inconsistent", "permission_scope:engineer@example.test"],
      errorEvidence: ["TypeError at migrated report boundary", "api_key=must-not-leak"],
      evidenceIds: ["lineage:abc123"],
    },
  });
  assert.equal(draft.destination.site, "https://support.hybrowlabs.com");
  assert.equal(draft.values.priority, "High");
  assert.equal(draft.values.customer, "Vinman App");
  assert.match(draft.description, /Control Plan CP-0042/);
  assert.match(draft.description, /https:\/\/vinman\.example\.test\/app\/control-plan\/CP-0042/);
  assert.doesNotMatch(draft.description, /should-not-leak|secret-value/);
  assert.match(draft.description.replaceAll("\\", ""), /\[redacted\]/);
  assert.match(draft.description, /Drawing revision B should reach production/);
  assert.match(draft.description, /process-flow\/PF-0042/);
  assert.match(draft.description, /lineage:Inconsistent/);
  assert.match(draft.description, /TypeError at migrated report boundary/);
  assert.doesNotMatch(draft.description, /must-not-leak/);
});

test("support evidence redacts URL credentials, JWT-shaped tokens, and active markup", () => {
  const draft = createFrappeSupportDraft({
    prompt: "send this to support",
    identity: { ...identity, userName: "<img src=x onerror=alert(1)> token: reporter-secret" },
    context: {
      pageName: "<img src=x onerror=alert(2)> token: source-secret",
      summary: [
        "callback?access_token=secret-value&next=ok eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMzQ1NiJ9.signature123456 <script>alert(1)</script>",
        "password=\"alpha\\\" beta-secret\"",
        "[literal](javascript:alert(1)) [entity](javascript&#58;alert(2)) [data](data&#x3a;text/html,secret-payload)",
        '{"password":"json-secret","access_token":"json-token","ok":true}',
        "[encoded](java&#115;cript:alert(2)) [encoded2](jav&#x61;script&#58;alert(3))",
        "[ref][attack]",
        "[attack]: javascript:alert(4)",
        "[escaped](javascript\\:alert(5))",
        "[escaped-ref][escaped-attack]",
        "[escaped-attack]: data\\:text/html,escaped-secret-payload",
        "[escaped-label][a\\]]",
        "[a\\]]: javascript:alert(6)",
        "status=failed;password=semicolon-secret",
        "{token:abc123}",
        "{token:a1}",
        '"password":',
        '  "multiline-secret"',
        "api_key: |",
        "  yaml-block-secret",
        "client_secret: |-",
        "  yaml-minus-secret",
        "redirect=https://url-user:url-pass@example.test/path",
        "redirect=https://user%3Aencoded-pass@example.test/path",
        "redirect=//user:protocol-pass@example.test/path",
        "callback#access_token=fragment-secret",
        "Set-Cookie: sid=session-secret; Secure",
        "response Set-Cookie: sid=prefixed-secret; Secure",
        "Set-Cookie2: sid=cookie2-secret; Secure",
        "Cookie: sid=cookie-secret; theme=dark",
        "Authorization: Basic dXNlcjpwYXNz",
        "Proxy-Authorization: Basic cHJveHk6c2VjcmV0",
        "X-Api-Key: header-api-secret",
        "X-Auth-Token: header-token-secret",
        "X-Goog-Api-Key: AIza-realistic-secret",
        "X-Amz-Security-Token: aws-session-secret",
        "Private-Token: glpat-realistic-secret",
        '"refresh_token":',
        '"flush-left-secret"',
        "Look here: https://attacker.example/phish www.attacker.example/phish attacker@example.test",
        "Token: usage increased after release",
        "Token: authentication failed for this request",
        "Password: policy requires twelve characters",
        "Password: correct horse battery staple",
        "Cookie: settings page is unavailable",
      ].join("\n"),
    },
  });
  assert.doesNotMatch(`${draft.subject}\n${draft.description}`, /secret-value|reporter-secret|source-secret|beta-secret|secret-payload|escaped-secret-payload|semicolon-secret|abc123|multiline-secret|yaml-(?:block|minus)-secret|url-user|url-pass|encoded-pass|protocol-pass|fragment-secret|session-secret|prefixed-secret|cookie2-secret|cookie-secret|dXNlcjpwYXNz|cHJveHk6c2VjcmV0|header-(?:api|token)-secret|AIza-realistic-secret|aws-session-secret|glpat-realistic-secret|flush-left-secret|correct horse battery staple|attacker\.example|attacker@example|json-secret|json-token|eyJhbGci|<[^>]+>|java(?:script|&#115;cript)|jav&#x61;script|data(?:&#x3a;|\\:|:)/i);
  const plainMarkers = draft.description.replaceAll("\\", "");
  assert.match(plainMarkers, /access_token=\[redacted\]|\[redacted-token\]|\[removed-markup\]/);
  assert.match(plainMarkers, /password=\[redacted\]/);
  assert.match(plainMarkers, /\[removed-link\]/);
  assert.match(plainMarkers, /\[external-link-removed\]/);
  assert.match(plainMarkers, /\[email-removed\]/);
  assert.match(draft.description, /Token: usage increased after release/);
  assert.match(draft.description, /Token: authentication failed for this request/);
  assert.doesNotMatch(draft.description, /Password: policy requires twelve characters/);
  assert.doesNotMatch(draft.description, /Cookie: settings page is unavailable/);
});

test("scenario 4 keeps complete sanitized migration evidence at the configured destination", () => {
  const destination = "https://migration-helpdesk.example.test";
  const draft = createFrappeSupportDraft({
    prompt: "after update this page not opening. check what happened and send to support",
    identity,
    context: {
      doctype: "Report",
      docname: "MUSTER-DEMO-MIGRATION-REPORT",
      pageName: "Migration failure report",
      summary: [
        "Source Frappe 15.41.0 -> target Frappe 16.27.1",
        "App revisions: vinman_app=2026.08.15; frappe=16.27.1",
        "Failed patch boundary: custom_report_schema_reference",
        "Restoration state: restored staging backup baseline before diagnosis",
        "Sanitized traceback fingerprint: report_builder.missing_field",
        "Authorization: Bearer migration-secret",
      ].join("\n"),
    },
    config: {
      site: destination,
      connectionId: "migration-helpdesk",
      customer: "Vinman Engineering Private Limited",
      priority: "High",
    },
    investigation: {
      expected: "The migrated report should open against the v16 schema.",
      observed: "The report fails when the removed v15 field is resolved.",
      businessImpact: "Operators cannot review the post-upgrade production report.",
      likelyLocations: ["Custom report query", "Migration patch boundary"],
      affectedRecords: [{ label: "Migration report", doctype: "Report", name: "MUSTER-DEMO-MIGRATION-REPORT" }],
      reproduction: ["Open the report after migration.", "Run the saved report with the restored staging baseline."],
      validation: ["Restore the baseline and rerun migration checks.", "Confirm the report opens on v16."],
      errorEvidence: ["report_builder.missing_field", "Authorization: Bearer must-not-leak"],
      evidenceIds: ["migration:baseline-2026-08-15", "migration:validation-1"],
    },
  });
  assert.equal(draft.destination.site, destination);
  assert.equal(draft.destination.connectionId, "migration-helpdesk");
  assert.equal(draft.values.customer, "Vinman Engineering Private Limited");
  assert.equal(draft.values.priority, "High");
  assert.doesNotMatch(JSON.stringify(draft), new RegExp(DEFAULT_FRAPPE_SUPPORT_SITE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const plainDescription = draft.description.replaceAll("\\", "");
  for (const marker of [
    "Source Frappe 15.41.0",
    "target Frappe 16.27.1",
    "App revisions",
    "Failed patch boundary",
    "Restoration state",
    "report_builder.missing_field",
    "The migrated report should open",
    "The report fails when",
    "Open the report after migration.",
    "Confirm the report opens on v16.",
    "migration:baseline-2026-08-15",
  ]) {
    assert.match(plainDescription, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), marker);
  }
  assert.doesNotMatch(draft.description, /migration-secret|must-not-leak/);
  assert.match(plainDescription, /Authorization=\[redacted\]/);
  assert.match(draft.description, /https:\/\/vinman\.example\.test\/app\/report\/MUSTER-DEMO-MIGRATION-REPORT/);
});

test("scenario 4 Frappe Ask contract supports review, cancel, approval, and reread-verified ticket URL", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-frappe-support-scenario-4-"));
  const destination = "https://migration-helpdesk.example.test";
  const base = defaultConfig();
  const config: MusterConfig = {
    ...base,
    providers: {},
    runtimes: {},
    routing: { ...base.routing, defaultRuntime: "native" },
  };
  const pairing = await requestPairing("frappe:vinman.example.test", identity.user, cwd);
  const paired = await approvePairing(pairing.code, cwd, {
    provider: "frappe",
    site: identity.site,
    user: identity.user,
    userName: identity.userName,
    roles: identity.roles,
  });
  const enterprise = createInMemoryGatewayEnterpriseRuntime();
  const interactionCalls: Record<string, unknown>[] = [];
  const safeWriteCalls: Record<string, unknown>[] = [];
  const created = {
    name: "HD-TICKET-MIGRATION-0001",
    doctype: "HD Ticket",
  } as Record<string, unknown>;
  let rereadRecord: Record<string, unknown> | undefined;
  const rereadUrls: string[] = [];
  let mismatchReread = false;
  const registry: FlowToolRegistry = {
    "frappe-federated-bridge__frappe_fast_route": async () => ({ intent: "record_create", candidateDoctypes: ["HD Ticket"] }),
    "frappe-federated-bridge__frappe_chat_interaction_plan": async (args) => {
      interactionCalls.push(args);
      return { kind: "guided_crud", title: "Review support ticket", doctype: "HD Ticket", operation: "create", requiredFields: [] };
    },
    "frappe-federated-bridge__frappe_safe_write": async (args) => {
      safeWriteCalls.push(args);
      if (!args.approvalReceipt) {
        return {
          status: "approval_required",
          approvalProposal: {
            proposalId: "frappe-approval:migration-support",
            mutationHash: "migration-support-hash",
            site: destination,
            principal: identity.user,
            operation: "create",
            doctype: "HD Ticket",
            fields: ["subject", "description", "customer"],
            permissionEpoch: "permission-1",
            schemaRevision: "schema-1",
            dataRevision: "data-1",
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
            nonce: "nonce-migration-support",
            humanSummary: "Create the verified migration Helpdesk ticket.",
            bindingRequirements: [],
          },
        };
      }
      rereadRecord = { ...created, ...(args.doc as Record<string, unknown>) };
      return {
        status: "executed",
        result: { created: rereadRecord },
        verification: { verified: true, fetched: rereadRecord },
      };
    },
  };
  const frappeOAuth = {
    authorization: async (connectionId: string) => connectionId === "migration-helpdesk"
      ? {
          connectionId,
          site: destination,
          header: "Bearer migration-support-secret",
          identity: { site: destination, user: identity.user, userName: identity.userName, roles: ["Customer"] },
        }
      : undefined,
  } as unknown as FrappeOAuthCoordinator;
  const trustedFrappe = {
    doctype: "Report",
    docname: "MUSTER-DEMO-MIGRATION-REPORT",
    pageName: "Migration failure report",
    summary: "Source Frappe 15.41.0 -> target Frappe 16.27.1; failed patch boundary: custom_report_schema_reference; restoration state: baseline restored; sanitized error: report_builder.missing_field",
    ask: { schemaVersion: 1 as const, requestId: "ask-migration-scenario-4", requestedOutcomes: ["answer"] },
    supportEvidence: {
      expected: "The readiness report opens against the v16 schema.",
      observed: "The report resolves a field removed during the v16 migration.",
      businessImpact: "Production readiness review is blocked.",
      likelyLocations: ["Custom report query", "Migration patch boundary"],
      affectedRecords: [{ label: "Readiness report", doctype: "Report", name: "MUSTER-DEMO-MIGRATION-REPORT" }],
      appVersions: { frappe: "16.27.1", vinman_app: "2026.08.15" },
      reproduction: ["Restore the isolated baseline.", "Open the readiness report."],
      validation: ["Baseline restored before diagnosis.", "Failure reproduced twice."],
      errorEvidence: ["report_builder.missing_field"],
      evidenceIds: ["migration:baseline-1", "migration:reproduction-2"],
    },
  };
  const fetcher = async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    assert.equal(url.origin, destination);
    rereadUrls.push(url.toString());
    const data = mismatchReread && rereadRecord ? { ...rereadRecord, customer: "Wrong customer" } : rereadRecord;
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const send = (text: string) => handleSurfaceMessage({
    surfaceId: "frappe:vinman.example.test",
    conversationId: "ask-session-1",
    senderId: identity.user,
    pairingId: paired.pairingId,
    text,
  }, {
    config,
    gateway: { token: "test", frappe: { approvalSigningKey: "migration-signing-key", support: { site: destination, connectionId: "migration-helpdesk", customer: "Vinman Engineering Private Limited" } } },
    cwd,
    registry,
    frappeOAuth,
    enterprise,
    trustedFrappe,
    fetcher,
  });
  try {
    const review = await send("after update this page not opening. check what happened and send to support");
    assert.equal("presentation" in review ? review.presentation?.kind : undefined, "form");
    assert.equal("presentation" in review ? review.presentation?.title : undefined, "Review the support ticket");
    assert.deepEqual("presentation" in review ? review.presentation?.actions?.map((action) => [action.label, action.command]) : [], [
      ["Approve & send to support", "/accept"],
      ["Cancel ticket", "/cancel"],
    ]);
    assert.equal(safeWriteCalls.length, 0, "pre-approval review must not call the write tool");
    const values = interactionCalls.at(-1)?.values as Record<string, unknown>;
    assert.equal(values.customer, "Vinman Engineering Private Limited");
    assert.equal(interactionCalls.at(-1)?.siteUrl, destination);
    assert.match(String(values.description), /v16 schema|field removed|Production readiness review|Migration patch boundary|16\.27\.1|Baseline restored|migration:baseline-1|frappe-ask:ask-migration-scenario-4/i);
    assert.doesNotMatch(JSON.stringify(values), /migration-support-secret|support\.hybrowlabs\.com/);

    const cancelled = await send("/cancel");
    assert.equal("presentation" in cancelled ? cancelled.presentation?.title : undefined, "Ticket cancelled");
    assert.match("text" in cancelled ? cancelled.text : "", /Nothing was sent to support/i);
    assert.equal(safeWriteCalls.length, 0, "cancel must never call the write tool");

    const reviewAgain = await send("create a support ticket for this migration failure");
    assert.equal("presentation" in reviewAgain ? reviewAgain.presentation?.title : undefined, "Review the support ticket");

    const accepted = await send("/accept");
    assert.equal(safeWriteCalls.length, 2);
    assert.equal(typeof safeWriteCalls[1]?.approvalReceipt, "object");
    assert.equal(safeWriteCalls[1]?.approvalNote, "Approved from the governed channel review.");
    assert.equal("presentation" in accepted ? accepted.presentation?.title : undefined, "Sent to support");
    assert.equal("presentation" in accepted ? accepted.presentation?.tables?.[0]?.rows[0]?.[1] : undefined,
      `${destination}/app/hd-ticket/HD-TICKET-MIGRATION-0001`);
    assert.deepEqual(rereadUrls, [`${destination}/api/resource/HD%20Ticket/HD-TICKET-MIGRATION-0001`]);

    const replay = await send("/accept");
    assert.match("text" in replay ? replay.text : "", /no request waiting/i);
    assert.equal(safeWriteCalls.length, 2, "a replayed approval must not execute another write");

    await send("raise a support ticket for this customization mismatch");
    mismatchReread = true;
    const callsBeforeMismatch = safeWriteCalls.length;
    const mismatched = await send("/accept");
    assert.match("text" in mismatched ? mismatched.text : "", /does not match the approved request/i);
    assert.equal("presentation" in mismatched ? mismatched.presentation?.title : undefined, undefined);
    const callsAfterMismatch = safeWriteCalls.length;
    assert.equal(callsAfterMismatch, callsBeforeMismatch + 2);
    const mismatchReplay = await send("/accept");
    assert.match("text" in mismatchReplay ? mismatchReplay.text : "", /already admitted|will not send it again/i);
    assert.equal(safeWriteCalls.length, callsAfterMismatch, "a mismatched reread must never trigger another create");
  } finally {
    await enterprise.close?.();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("support destination rejects non-canonical or credential-bearing origins", () => {
  for (const site of [
    "http://support.example.test",
    "https://user:secret@support.example.test",
    "https://support.example.test/path",
    "https://support.example.test/?tenant=x",
  ]) {
    assert.throws(() => resolveFrappeSupportDestination({ site }));
  }
});

test("production startup rejects a missing configured support OAuth connection", () => {
  const errors = gatewayStartupErrors({
    token: "a".repeat(32),
    security: { deployment: "production" },
    frappe: { support: { connectionId: "hybrow-support" } },
  });
  assert.ok(errors.some((error) => /hybrow-support.*not configured/i.test(error)));
});
