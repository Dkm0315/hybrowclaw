import assert from "node:assert/strict";
import { test } from "node:test";
import { surfaceReplyToTelegramSend, telegramUpdateToSurfaceMessage } from "../src/adapters/telegram.js";
import type { SurfaceReply } from "../src/envelope.js";

test("Telegram reports keep complete pages and every action executable", () => {
  const longCommand = `/usage scope=team provider=${"provider".repeat(10)}`;
  const reply: SurfaceReply = {
    text: "┌──────────┬──────────┐\n│ terminal │ fallback │\n└──────────┴──────────┘",
    presentation: {
      kind: "report",
      title: "Usage <Admin>",
      summary: "Authorized usage from the live gateway ledger.",
      audience: "admin",
      kpis: [
        { label: "Runs", value: "7" },
        { label: "provider_prompt-cache", value: "42%", detail: "Provider-reported events only" },
      ],
      tables: [{
        id: "reports",
        title: "Report areas",
        columns: ["No", "report_area", "includes"],
        rows: [
          ["1", "Personal usage", "Requests and tokens"],
          ["2", "Artifacts", "Generated files"],
          ["3", "Team usage", "Authorized reporting scope"],
          ["4", "Audit", "Governed outcomes"],
          ["5", "Incidents", "Failures and recovery"],
        ],
      }],
      filters: [
        {
          id: "period",
          label: "Period",
          selected: "7d",
          options: [{ label: "Today", value: "today" }, { label: "7 days", value: "7d" }],
          action: { id: "filter-period", label: "Apply period", command: "/usage period={value}", kind: "filter" },
        },
        {
          id: "channel",
          label: "Channel",
          selected: "telegram",
          options: [{ label: "Telegram", value: "telegram" }, { label: "Slack", value: "slack" }],
          action: { id: "filter-channel", label: "Apply channel", command: "/usage channel={value}", kind: "filter" },
        },
      ],
      drilldowns: [
        { id: "limits", label: "Limits", command: "/limits", kind: "drilldown" },
        { id: "security", label: "Security", command: "/security", kind: "drilldown" },
      ],
      actions: [
        { id: "refresh", label: "Refresh usage", command: "/usage", style: "primary" },
        { id: "duplicate-limits", label: "/limits", command: "/limits" },
        { id: "long", label: "Detailed provider view", command: longCommand, kind: "drilldown" },
      ],
      notice: "Billing is omitted because no verified billing source is connected.",
      privacy: { rawPromptsIncluded: false, note: "Evidence: gateway ledger only. Raw prompts are hidden." },
    },
  };

  const payload = surfaceReplyToTelegramSend(reply, "100");
  assert.equal(payload.parse_mode, "HTML");
  assert.match(payload.text, /<b>Usage &lt;Admin&gt;<\/b>/);
  assert.match(payload.text, /<b>Key metrics<\/b>/);
  assert.match(payload.text, /<b>Provider prompt cache<\/b> 42%/);
  assert.match(payload.text, /1\. <b>Personal usage<\/b>/);
  assert.doesNotMatch(payload.text, /1\.\s*(?:<b>)?1(?:<\/b>)?/);
  assert.match(payload.text, /4\. <b>Audit<\/b>/);
  assert.match(payload.text, /5\. <b>Incidents<\/b>/);
  assert.doesNotMatch(payload.text, /Showing 4 of 5 rows/);
  assert.match(payload.text, /<b>Period<\/b>: 7 days/);
  assert.doesNotMatch(payload.text, /<b>More (?:filters|actions)<\/b>/);
  assert.match(payload.text, /<b>Other commands<\/b>/);
  assert.match(payload.text, new RegExp(longCommand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(payload.text, /<b>Notice<\/b>\nBilling is omitted/);
  assert.match(payload.text, /<b>Evidence &amp; privacy<\/b>\n<i>gateway ledger only\. Raw prompts are hidden\.<\/i>/);
  assert.doesNotMatch(payload.text, /Evidence &amp; privacy<\/b>\n<i>Evidence:/i);
  assert.doesNotMatch(payload.text, /[\u2500-\u257f]/);
  assert.doesNotMatch(payload.text, /(?:^|\n)\s*\|/);
  assert.ok(payload.text.length <= 3_900);

  const buttons = payload.reply_markup?.inline_keyboard.flat() ?? [];
  assert.equal(buttons.length, 5, "every safe alternative and action remains directly executable");
  assert.equal(buttons.filter((button) => button.callback_data.includes("/limits")).length, 1, "duplicate commands collapse to one action");
  assert.equal(buttons.some((button) => /current/i.test(button.text)), false, "selected filter values do not add no-op buttons");

  const inboundCommands = buttons.map((button, index) => {
    assert.ok(Buffer.byteLength(button.callback_data, "utf8") <= 64);
    assert.doesNotMatch(button.callback_data, /\{value\}/);
    const inbound = telegramUpdateToSurfaceMessage({
      update_id: index + 1,
      callback_query: {
        id: `callback-${index + 1}`,
        from: { id: 42 },
        data: button.callback_data,
        message: { message_id: 10, chat: { id: 100 } },
      },
    });
    assert.equal(inbound?.conversationId, "100");
    assert.equal(inbound?.senderId, "42");
    assert.equal(inbound?.replyTo, "10");
    assert.ok(inbound?.text.startsWith("/"), "every visible button re-enters the governed command dispatcher");
    return inbound?.text;
  });
  assert.deepEqual(new Set(inboundCommands), new Set(["/usage period=today", "/usage channel=slack", "/limits", "/security", "/usage"]));
  assert.equal(buttons.some((button) => button.callback_data.includes(longCommand)), false, "over-limit callbacks remain exact text commands");
});

test("Telegram renders every row in the largest gateway page", () => {
  const rows = Array.from({ length: 10 }, (_, index) => [
    String(index + 1),
    `/command-${index + 1}`,
    `Use command ${index + 1}`,
  ]);
  const payload = surfaceReplyToTelegramSend({
    text: "terminal fallback",
    presentation: {
      kind: "menu",
      title: "Commands",
      summary: "Available commands.",
      tables: [{
        id: "commands",
        columns: ["No", "Command", "Use"],
        rows,
        pagination: { page: 1, pageSize: 10, totalRows: 20 },
      }],
      actions: [{ id: "next", label: "Next", command: "/help page=2", kind: "page" }],
    },
  }, "100");

  for (let index = 1; index <= 10; index += 1) assert.match(payload.text, new RegExp(`${index}\\. <b>\\/command-${index}<\\/b>`));
  assert.match(payload.text, /Page 1 of 2 · 20 total rows/);
  assert.doesNotMatch(payload.text, /Showing \d+ of 10 rows on this page/);
  assert.match(JSON.stringify(payload.reply_markup), /muster:cmd:\/help page=2/);
  assert.ok(payload.text.length <= 3_900);
});

test("Telegram bounds plain and approval messages without dropping approval guidance", () => {
  const plain = surfaceReplyToTelegramSend({ text: "x".repeat(5_000) }, "100");
  assert.ok([...plain.text].length <= 4_096);
  assert.match(plain.text, /Message shortened for Telegram/);

  const approval = surfaceReplyToTelegramSend({
    text: "Review this operation.",
    approvalRequest: {
      runId: "flowrun_1",
      gateId: "publish",
      show: { detail: "y".repeat(5_000) },
      options: ["approve", "reject"],
    },
  }, "100");
  assert.ok([...approval.text].length <= 4_096);
  assert.match(approval.text, /Message shortened for Telegram/);
  assert.match(approval.text, /Authenticated approval controls are unavailable/);
});

test("Telegram renders zero-total and fully redacted tables as empty states", () => {
  const zeroTotal = surfaceReplyToTelegramSend({
    text: "fallback",
    presentation: {
      kind: "report",
      title: "Usage",
      summary: "No activity.",
      tables: [{
        id: "usage",
        columns: ["Type of work", "Runs"],
        rows: [["No activity in this view", "0"]],
        pagination: { page: 1, pageSize: 8, totalRows: 0 },
      }],
    },
  }, "100");
  assert.match(zeroTotal.text, /No records are available for this view/);
  assert.doesNotMatch(zeroTotal.text, /1\. <b>Type of work<\/b>/);

  const redacted = surfaceReplyToTelegramSend({
    text: "fallback",
    presentation: {
      kind: "report",
      title: "Manager report",
      summary: "Protected details.",
      audience: "manager",
      tables: [{ id: "prompts", columns: ["Prompt"], rows: [["private text"]] }],
      privacy: { rawPromptsIncluded: false },
    },
  }, "100");
  assert.match(redacted.text, /No displayable fields are available for this view/);
  assert.doesNotMatch(redacted.text, /Item<\/b>: Not provided|private text/);
});

test("Telegram renders identity fields without terminal table rails", () => {
  const employeeId = "EMP-TEST-001";
  const departmentId = "DEPT-TEST-002";
  const payload = surfaceReplyToTelegramSend({
    text: "fallback",
    presentation: {
      kind: "status",
      title: "Frappe connected",
      summary: "Identity verified.",
      tables: [{
        id: "identity",
        columns: ["Field", "Value"],
        rows: [["employee_id", employeeId], ["department_name", departmentId]],
      }],
    },
  }, "100");

  assert.match(payload.text, new RegExp(`<b>Employee ID<\\/b>: ${employeeId}`));
  assert.match(payload.text, new RegExp(`<b>Department name<\\/b>: ${departmentId}`));
  assert.doesNotMatch(payload.text, /[\u2500-\u257f]/);
});

test("Telegram ordinal columns do not duplicate row numbers", () => {
  for (const ordinalColumn of ["No", "#"]) {
    const payload = surfaceReplyToTelegramSend({
      text: "fallback",
      presentation: {
        kind: "menu",
        title: "Reports",
        summary: "Available report areas.",
        tables: [{
          id: `ordinal-${ordinalColumn}`,
          columns: [ordinalColumn, "report_area", "includes"],
          rows: [["1", "Personal usage", "Requests and tokens"]],
        }],
      },
    }, "100");

    assert.match(payload.text, /1\. <b>Personal usage<\/b>/);
    assert.doesNotMatch(payload.text, /1\.\s*(?:<b>)?1(?:<\/b>)?/);
    assert.match(payload.text, /<b>Includes<\/b>: Requests and tokens/);
  }
});
