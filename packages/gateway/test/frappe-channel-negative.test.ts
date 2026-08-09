import assert from "node:assert/strict";
import { test } from "node:test";
import type { FlowToolRegistry } from "@musterhq/core";
import {
  frappeChannelSystemContext,
  frappeChannelTurnContext,
  frappeEvidenceQuickReply,
  frappePermissionContextForTurn,
  type FrappeOAuthAuthorization,
  type FrappePermissionContextResult,
  type PairedIdentity,
} from "../src/index.js";

const FAST_ROUTE_TOOL = "frappe-federated-bridge__frappe_fast_route";
const LIVE_READ_TOOL = "frappe-federated-bridge__frappe_semantic_data_resolve_lite";
const INTERACTION_PLAN_TOOL = "frappe-federated-bridge__frappe_chat_interaction_plan";
const SAFE_WRITE_TOOL = "frappe-federated-bridge__frappe_safe_write";
const OAUTH_SECRET = "oauth-secret-must-stay-host-side";

const identity: PairedIdentity = {
  provider: "frappe",
  site: "https://erp.example.test",
  user: "asha@example.test",
  employee: "EMP-0042",
  employeeName: "Asha Example",
  department: "DEP-1097",
  departmentName: "Operations",
  company: "Example Holdings",
  reportsTo: "EMP-0007",
  reportsToName: "Ravi Manager",
  roles: ["Employee", "Leave Approver"],
  resolvedAt: "2026-07-13T00:00:00.000Z",
};

const authorization: FrappeOAuthAuthorization = {
  connectionId: "oxygenhr",
  site: identity.site,
  header: `Bearer ${OAUTH_SECRET}`,
  identity: {
    site: identity.site,
    user: identity.user,
    employee: identity.employee,
    roles: identity.roles,
  },
};

interface ContextPacket {
  readonly route?: Record<string, unknown>;
  readonly interaction?: Record<string, unknown>;
  readonly evidence: readonly Record<string, unknown>[];
  readonly note?: string;
  readonly instruction?: string;
}

function packetFrom(result: FrappePermissionContextResult): ContextPacket {
  assert.ok(result.context, "the routed turn should produce provider context");
  const packet = JSON.parse(result.context) as ContextPacket;
  assert.ok(Array.isArray(packet.evidence), "provider context should carry an explicit evidence list");
  return packet;
}

function evidenceFor(packet: ContextPacket, doctype: string): Record<string, unknown> {
  const evidence = packet.evidence.find((item) => item.doctype === doctype);
  assert.ok(evidence, `expected evidence for ${doctype}`);
  return evidence;
}

test("self Task and ToDo lookups stay live without inventing an employee filter", async () => {
  const reads: Record<string, unknown>[] = [];
  const registry: FlowToolRegistry = {
    [FAST_ROUTE_TOOL]: async () => ({
      intent: "record_lookup",
      answerPath: "live_frappe",
      candidateDoctypes: ["Task", "ToDo", "Task"],
      requiredChecks: ["live_frappe_permission_preflight"],
    }),
    [LIVE_READ_TOOL]: async (args) => {
      reads.push(args);
      return { doctype: args.doctype, rows: [], count: 0 };
    },
  };

  const result = await frappePermissionContextForTurn({
    prompt: "Show my open Tasks and ToDos assigned to me",
    surfaceId: "telegram:oxygenhr",
    identity,
    authorization,
    registry,
  });

  assert.equal(result.source, "live_frappe");
  assert.deepEqual(result.candidateDoctypes, ["Task", "ToDo"]);
  assert.deepEqual(reads.map((args) => args.doctype), ["Task", "ToDo"]);
  for (const args of reads) {
    assert.equal(args.filters, undefined, `${String(args.doctype)} has no generic employee field`);
    assert.equal(args.user, identity.user);
    assert.equal(args.apiToken, OAUTH_SECRET);
  }

  const packet = packetFrom(result);
  assert.deepEqual(packet.evidence.map((item) => ({
    doctype: item.doctype,
    status: item.status,
    count: item.count,
  })), [
    { doctype: "Task", status: "permission_filtered", count: 0 },
    { doctype: "ToDo", status: "permission_filtered", count: 0 },
  ]);
  assert.equal(result.evidenceState, "verified_empty");
  const reply = frappeEvidenceQuickReply(result);
  assert.match(reply?.text ?? "", /nothing matching this request/i);
  assert.doesNotMatch(reply?.text ?? "", /Task|ToDo|doctype/i);
  assert.doesNotMatch(result.context ?? "", new RegExp(OAUTH_SECRET));
});

test("explain-only leave preflight performs a live read with zero mutation calls", async () => {
  const calls: string[] = [];
  const registry: FlowToolRegistry = {
    [FAST_ROUTE_TOOL]: async () => {
      calls.push("route");
      return {
        intent: "permission_explanation",
        answerPath: "live_frappe",
        candidateDoctypes: ["Leave Application"],
        requiredChecks: ["live_frappe_permission_preflight"],
      };
    },
    [LIVE_READ_TOOL]: async (args) => {
      calls.push("read");
      return {
        doctype: args.doctype,
        rows: [{ name: "LEAVE-0007", status: "Draft" }],
        count: 1,
      };
    },
    [INTERACTION_PLAN_TOOL]: async () => {
      calls.push("mutation-plan");
      return { kind: "guided_crud" };
    },
    [SAFE_WRITE_TOOL]: async () => {
      calls.push("write");
      return { name: "LEAVE-SHOULD-NOT-EXIST" };
    },
  };

  const result = await frappePermissionContextForTurn({
    prompt: "Explain why my leave request cannot be submitted. Do not create or update anything.",
    surfaceId: "slack:oxygenhr",
    identity,
    authorization,
    registry,
  });

  assert.equal(result.intent, "permission_explanation");
  assert.deepEqual(calls, ["route", "read"]);
  assert.equal(packetFrom(result).interaction, undefined);
  assert.deepEqual(evidenceFor(packetFrom(result), "Leave Application").rows, [
    { name: "LEAVE-0007", status: "Draft" },
  ]);
});

test("team-scope wording never collapses a manager query to the manager's employee record", async () => {
  const prompts = [
    "Show pending leave requests for my team",
    "Show pending leave requests from people reporting to me",
    "Show pending leave requests for my direct reports",
    "Show pending leave requests awaiting my review",
  ];

  for (const prompt of prompts) {
    let readArgs: Record<string, unknown> | undefined;
    const registry: FlowToolRegistry = {
      [FAST_ROUTE_TOOL]: async () => ({
        intent: "record_lookup",
        answerPath: "live_frappe",
        candidateDoctypes: ["Leave Application"],
        requiredChecks: ["live_frappe_permission_preflight"],
      }),
      [LIVE_READ_TOOL]: async (args) => {
        readArgs = args;
        return { doctype: "Leave Application", rows: [], count: 0 };
      },
    };

    const result = await frappePermissionContextForTurn({
      prompt,
      surfaceId: "gchat:oxygenhr",
      identity,
      authorization,
      registry,
    });

    assert.equal(result.source, "live_frappe", prompt);
    assert.ok(readArgs, `expected a live read for: ${prompt}`);
    assert.equal(readArgs.filters, undefined, `team scope must be left to Frappe permissions: ${prompt}`);
  }
});

test("layperson self-history wording always sends the paired employee scope", async () => {
  for (const prompt of [
    "Have I asked for any time off recently?",
    "Did I submit any attendance corrections this week?",
    "Can I see recent reimbursements for me?",
  ]) {
    let readArgs: Record<string, unknown> | undefined;
    const registry: FlowToolRegistry = {
      [FAST_ROUTE_TOOL]: async () => ({
        intent: "record_lookup",
        answerPath: "live_frappe",
        candidateDoctypes: ["Business Record"],
      }),
      [LIVE_READ_TOOL]: async (args) => {
        readArgs = args;
        return { doctype: args.doctype, rows: [], count: 0 };
      },
    };

    await frappePermissionContextForTurn({
      prompt,
      surfaceId: "telegram:oxygenhr",
      identity,
      authorization,
      registry,
    });

    assert.deepEqual(readArgs?.scope, {
      mode: "self",
      user: identity.user,
      employee: identity.employee,
    }, prompt);
  }
});

test("a direct single-domain answer cannot merge a related secondary candidate", async () => {
  const reads: string[] = [];
  const result = await frappePermissionContextForTurn({
    prompt: "Show my recent payslips",
    surfaceId: "telegram:oxygenhr",
    identity,
    authorization,
    registry: {
      [FAST_ROUTE_TOOL]: async () => ({
        intent: "record_lookup",
        candidateDoctypes: ["Salary Slip", "Employee"],
      }),
      [LIVE_READ_TOOL]: async (args) => {
        reads.push(String(args.doctype));
        return { doctype: args.doctype, rows: [{ name: "VISIBLE-1" }], count: 1 };
      },
    },
  });

  assert.deepEqual(reads, ["Salary Slip"]);
  assert.deepEqual(packetFrom(result).evidence.map((item) => item.doctype), ["Salary Slip"]);
});

test("ordinary what and which questions use one authoritative business domain", async () => {
  for (const prompt of [
    "Which company equipment is assigned to me?",
    "What work is still waiting for me on projects?",
  ]) {
    const reads: string[] = [];
    const result = await frappePermissionContextForTurn({
      prompt,
      surfaceId: "telegram:oxygenhr",
      identity,
      authorization,
      registry: {
        [FAST_ROUTE_TOOL]: async () => ({
          intent: "record_lookup",
          candidateDoctypes: ["Primary Business Record", "Related Metadata"],
        }),
        [LIVE_READ_TOOL]: async (args) => {
          reads.push(String(args.doctype));
          return { doctype: args.doctype, rows: [], count: 0 };
        },
      },
    });

    assert.deepEqual(reads, ["Primary Business Record"], prompt);
    assert.equal(result.evidenceState, "verified_empty", prompt);
    assert.ok(frappeEvidenceQuickReply(result), prompt);
  }
});

test("preview-first preparation stays in guided act mode even when submission is declined", async () => {
  let planArgs: Record<string, unknown> | undefined;
  const result = await frappePermissionContextForTurn({
    prompt: "Help me prepare a reimbursement for a taxi ride without submitting it",
    surfaceId: "telegram:oxygenhr",
    identity,
    authorization,
    registry: {
      [FAST_ROUTE_TOOL]: async () => ({
        intent: "record_create",
        candidateDoctypes: ["Expense Claim"],
      }),
      [INTERACTION_PLAN_TOOL]: async (args) => {
        planArgs = args;
        return {
          kind: "guided_crud",
          doctype: "Expense Claim",
          operation: "create",
          requiredFields: [{ fieldname: "expense_type", label: "Expense type", reason: "Required by the current form." }],
        };
      },
    },
  });

  assert.equal(planArgs?.mode, "act");
  assert.equal(planArgs?.operation, "create");
  assert.equal(result.pendingInteraction?.requiredFields[0]?.label, "Expense type");
});

test("permission denial remains explicit evidence and is never presented as an empty result", async () => {
  const registry: FlowToolRegistry = {
    [FAST_ROUTE_TOOL]: async () => ({
      intent: "record_lookup",
      answerPath: "live_frappe",
      candidateDoctypes: ["Salary Slip"],
      requiredChecks: ["live_frappe_permission_preflight"],
    }),
    [LIVE_READ_TOOL]: async () => ({
      status: 403,
      excType: "PermissionError",
      error: "GET https://erp.example.test/api/resource/Salary%20Slip failed: frappe.exceptions.PermissionError: User asha@example.test does not have doctype access to Salary Slip",
    }),
  };

  const result = await frappePermissionContextForTurn({
    prompt: "Why can't I view my latest salary slip?",
    surfaceId: "telegram:oxygenhr",
    identity,
    authorization,
    registry,
  });

  const evidence = evidenceFor(packetFrom(result), "Salary Slip");
  assert.equal(evidence.status, "permission_denied");
  assert.equal(result.evidenceState, "permission_denied");
  assert.match(frappeEvidenceQuickReply(result)?.text ?? "", /current access.*does not include/i);
  assert.match(String(evidence.reason), /PermissionError.*does not have doctype access to Salary Slip/i);
  assert.equal("rows" in evidence, false);
  assert.equal("count" in evidence, false);
  assert.doesNotMatch(result.context ?? "", /https:\/\/erp\.example\.test\/api\/resource|oauth-secret/i);
});

test("permission denial uses authoritative status and exception type instead of message wording", async () => {
  for (const denied of [
    { status: 403, error: "Request rejected" },
    { excType: "frappe.exceptions.PermissionError", error: "Request rejected" },
  ]) {
    const result = await frappePermissionContextForTurn({
      prompt: "Show my latest private document",
      surfaceId: "telegram:oxygenhr",
      identity,
      authorization,
      registry: {
        [FAST_ROUTE_TOOL]: async () => ({ intent: "record_lookup", candidateDoctypes: ["Private Record"] }),
        [LIVE_READ_TOOL]: async () => denied,
      },
    });
    assert.equal(result.evidenceState, "permission_denied");
  }
});

test("a thrown live read is unavailable while a deadline expiry is a timeout", async () => {
  const thrown = await frappePermissionContextForTurn({
    prompt: "Show my open work",
    surfaceId: "telegram:oxygenhr",
    identity,
    authorization,
    registry: {
      [FAST_ROUTE_TOOL]: async () => ({ intent: "record_lookup", candidateDoctypes: ["Work"] }),
      [LIVE_READ_TOOL]: async () => { throw new Error("network failure"); },
    },
  });
  assert.equal(evidenceFor(packetFrom(thrown), "Work").status, "unavailable");
  assert.equal(thrown.evidenceState, "unavailable");
});

test("timeout and unavailable reads remain distinct evidence instead of becoming zero-row claims", async () => {
  const registry: FlowToolRegistry = {
    [FAST_ROUTE_TOOL]: async () => ({
      intent: "report",
      answerPath: "live_frappe",
      candidateDoctypes: ["Attendance", "Expense Claim"],
      requiredChecks: ["live_frappe_permission_preflight"],
    }),
    [LIVE_READ_TOOL]: async (args) => args.doctype === "Attendance"
      ? await new Promise<never>(() => {})
      : {
          error: "503 ServiceUnavailable while reading https://erp.example.test/private/read-path",
        },
  };

  const result = await frappePermissionContextForTurn({
    prompt: "Compare this month's attendance and expense claims",
    surfaceId: "telegram:oxygenhr",
    identity,
    authorization,
    registry,
  });

  const packet = packetFrom(result);
  const timedOut = evidenceFor(packet, "Attendance");
  const unavailable = evidenceFor(packet, "Expense Claim");
  assert.equal(timedOut.status, "timeout");
  assert.equal(unavailable.status, "unavailable");
  assert.match(String(unavailable.reason), /503 ServiceUnavailable/);
  for (const evidence of [timedOut, unavailable]) {
    assert.equal("rows" in evidence, false);
    assert.equal("count" in evidence, false);
  }
  assert.equal(result.evidenceState, "unavailable");
  assert.match(frappeEvidenceQuickReply(result)?.text ?? "", /did not return a complete result/i);
  assert.match(packet.instruction ?? "", /zero-row result means no match.*timeout.*unknown rather than empty/i);
  assert.doesNotMatch(result.context ?? "", /private\/read-path|oauth-secret/i);
});

test("route-only provider context drops invented live values and says evidence is missing", async () => {
  const inventedRecord = "INVENTED-LEAVE-0099";
  const registry: FlowToolRegistry = {
    [FAST_ROUTE_TOOL]: async () => ({
      intent: "record_lookup",
      answerPath: "live_frappe",
      candidateDoctypes: ["Leave Application"],
      requiredChecks: ["live_frappe_permission_preflight"],
      reason: "Fresh records are required before answering.",
      rows: [{ name: inventedRecord, status: "Approved" }],
      count: 99,
      answer: "The employee has 99 approved leave requests.",
    }),
  };

  const result = await frappePermissionContextForTurn({
    prompt: "How many leave requests have been approved for me?",
    surfaceId: "telegram:oxygenhr",
    identity,
    authorization,
    registry,
  });

  assert.equal(result.source, "route");
  const packet = packetFrom(result);
  assert.deepEqual(packet.evidence, []);
  assert.match(packet.note ?? "", /No live record payload was prefetched/i);
  assert.doesNotMatch(result.context ?? "", new RegExp(`${inventedRecord}|99 approved leave requests`));

  const providerContext = [
    frappeChannelSystemContext(identity, { name: "OxygenHR Assistant" }, true),
    frappeChannelTurnContext(result.context ?? ""),
  ].join("\n");
  assert.match(providerContext, /answer only from fresh permission-filtered evidence/i);
  assert.match(providerContext, /evidence is missing or ambiguous.*instead of inventing/i);
  assert.doesNotMatch(providerContext, new RegExp(`${inventedRecord}|99 approved leave requests|${OAUTH_SECRET}`));
});

test("an explicit request beyond the reporting scope is denied before any live read", async () => {
  for (const prompt of [
    "Show me salary details for people outside my reporting line.",
    "Show me salary and bank details for every employee.",
  ]) {
    let reads = 0;
    const result = await frappePermissionContextForTurn({
    prompt,
    surfaceId: "telegram:oxygenhr",
    identity,
    authorization,
    registry: {
      [FAST_ROUTE_TOOL]: async () => ({
        intent: "record_lookup",
        candidateDoctypes: ["Salary Slip"],
      }),
      [LIVE_READ_TOOL]: async () => {
        reads += 1;
        return { rows: [{ name: "private-record" }], count: 1 };
      },
    },
  });

    assert.equal(reads, 0);
    assert.equal(result.intent, "permission_explanation");
    assert.equal(result.evidenceState, "permission_denied");
    assert.equal(frappeEvidenceQuickReply(result)?.presentation?.title, "This information is restricted");
  }
});
