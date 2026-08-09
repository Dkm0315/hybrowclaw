import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {chromium} from "../../packages/gateway/node_modules/playwright/index.mjs";

const baseUrl = process.env.FRAPPE_BASE_URL;
const user = process.env.VIDEO_USER;
const password = process.env.VIDEO_PASSWORD;
const outputDir = process.env.VIDEO_OUT_DIR || path.resolve("outputs/buying-training-live");
const record = process.env.RECORD_VIDEO === "1";
const skipCurriculum = process.env.SKIP_CURRICULUM === "1";
const requestedStages = new Set((process.env.BUYING_STAGES || "").split(",").map((value) => value.trim()).filter(Boolean));
if (!baseUrl || !user || !password) throw new Error("Missing FRAPPE_BASE_URL, VIDEO_USER, or VIDEO_PASSWORD");

await fs.mkdir(outputDir, {recursive: true});

const browser = await chromium.launch({
  headless: true,
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const context = await browser.newContext({
  viewport: {width: 1600, height: 1000},
  ...(record ? {recordVideo: {dir: outputDir, size: {width: 1600, height: 1000}}} : {}),
});
const page = await context.newPage();
const evidence = {startedAt: new Date().toISOString(), record, stages: [], errors: []};
const pause = (ms) => page.waitForTimeout(ms);

page.on("console", (message) => {
  if (["error", "warning"].includes(message.type())) evidence.errors.push(`browser-${message.type()}: ${message.text()}`);
});
page.on("pageerror", (error) => evidence.errors.push(`pageerror: ${error.message}`));

async function click(locator, settle = 500) {
  await locator.waitFor({state: "visible", timeout: 60_000});
  const box = await locator.boundingBox();
  if (!box) throw new Error("Visible target has no bounding box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {steps: 20});
  await pause(350);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await pause(settle);
}

async function openDock() {
  const dock = page.locator(".muster-dock");
  await dock.waitFor({state: "visible", timeout: 30_000});
  if (await dock.evaluate((element) => element.classList.contains("is-collapsed"))) await click(page.locator(".muster-dock-toggle"));
  await page.locator(".muster-dock-prompt").waitFor({state: "visible", timeout: 30_000});
}

async function ask(text, expected) {
  await openDock();
  const messages = page.locator(".muster-chat-message.is-assistant, .muster-chat-message.is-error");
  const before = await messages.count();
  const prompt = page.locator(".muster-dock-prompt");
  await prompt.fill(text);
  await pause(700);
  await click(page.locator(".muster-dock-submit"), 250);
  await page.waitForFunction(
    ({selector, count, needle}) => {
      const rows = [...document.querySelectorAll(selector)];
      return rows.length > count && rows.some((row) => row.textContent?.includes(needle));
    },
    {selector: ".muster-chat-message.is-assistant", count: before, needle: expected},
    {timeout: 120_000},
  );
  await pause(1200);
}

async function login() {
  await page.goto(`${baseUrl}/login`, {waitUntil: "domcontentloaded", timeout: 60_000});
  await page.locator('#login_email, input[name="usr"]').first().fill(user);
  await page.locator('#login_password, input[name="pwd"]').first().fill(password);
  await click(page.locator('button:has-text("Continue"), button:has-text("Login"), .btn-login').first());
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), {timeout: 60_000});
  await page.goto(`${baseUrl}/desk/muster-control?training=buying&ui=20260808-10`, {waitUntil: "domcontentloaded", timeout: 60_000});
  await page.locator(".muster-dock-toggle").waitFor({state: "visible", timeout: 60_000});
  await pause(1800);
}

async function verifyCurriculum() {
  await ask("Train me through the complete Buying module from a business need to supplier payment.", "Buying training: from business need to supplier payment");
  const transcript = await page.locator(".muster-chat-log").innerText();
  const expected = [
    "Item", "Supplier", "Material Request", "Request for Quotation", "Supplier Quotation",
    "Purchase Order", "Purchase Receipt", "Purchase Invoice", "Payment Entry", "Human-in-the-loop rule",
  ];
  const missing = expected.filter((value) => !transcript.includes(value));
  if (missing.length) throw new Error(`Buying curriculum is incomplete: ${missing.join(", ")}`);
  evidence.stages.push({stage: "curriculum", result: "pass", expected});
}

async function verifyInstruction(doctype) {
  await ask(`How do I create a ${doctype}? Use the live form rules and explain the human approval boundary.`, `To create a ${doctype}`);
  const transcript = await page.locator(".muster-chat-log").innerText();
  if (!transcript.includes("Before I open it with you") || !transcript.includes("Save or Submit")) {
    throw new Error(`${doctype} instruction omitted live requirements or approval boundary`);
  }
  evidence.stages.push({stage: doctype, result: "instruction-pass"});
}

const trainingCases = [
  {
    doctype: "Item",
    route: /\/desk\/item\/new-item-/i,
    details: "Item Code: MUSTER-BUYING-TRAINING-001. Item Name: Muster Buying Training Kit. Item Group: Frappeverse Items. Default Unit of Measure: Nos.",
  },
  {
    doctype: "Supplier",
    route: /\/desk\/supplier\/new-supplier-/i,
    details: "Supplier Name: Muster Buying Training Supplier. Supplier Type: Company. Supplier Group: Frappeverse Suppliers.",
  },
  {
    doctype: "Material Request",
    route: /\/desk\/material-request\/new-material-request-/i,
    details: "Purpose: Purchase. Company: Muster Frappeverse Demo. Transaction Date: today. Add item MFD-ITEM-040, Required By: 15 August 2026, Quantity: 2, Stock UOM: Nos, UOM: Nos, UOM Conversion Factor: 1, Target Warehouse: Stores - MFD.",
  },
  {
    doctype: "Request for Quotation",
    route: /\/desk\/request-for-quotation\/new-request-for-quotation-/i,
    details: "Company: Muster Frappeverse Demo. Date: today. Subject: Training quotation for a field kit. Supplier: Frappeverse Supplier 001. Add item MFD-ITEM-040, Required Date: 15 August 2026, Quantity: 2, Stock UOM: Nos, UOM: Nos, UOM Conversion Factor: 1, Warehouse: Stores - MFD.",
  },
  {
    doctype: "Supplier Quotation",
    route: /\/desk\/supplier-quotation\/new-supplier-quotation-/i,
    details: "Supplier: Frappeverse Supplier 001. Company: Muster Frappeverse Demo. Status: Draft. Date: today. Currency: USD. Exchange Rate: 1. Add item MFD-ITEM-040, Quantity: 2, Stock UOM: Nos, UOM: Nos, UOM Conversion Factor: 1, Rate: 100.",
  },
  {
    doctype: "Purchase Order",
    route: /\/desk\/purchase-order\/new-purchase-order-/i,
    details: "Supplier: Frappeverse Supplier 001. Company: Muster Frappeverse Demo. Date: today. Currency: USD. Exchange Rate: 1. Add item MFD-ITEM-040, Required By: 15 August 2026, Quantity: 2, Stock UOM: Nos, UOM: Nos, UOM Conversion Factor: 1, Rate: 100, Target Warehouse: Stores - MFD.",
  },
  {
    doctype: "Purchase Receipt",
    route: /\/desk\/purchase-receipt\/new-purchase-receipt-/i,
    details: "Supplier: Frappeverse Supplier 001. Company: Muster Frappeverse Demo. Date: today. Currency: USD. Exchange Rate: 1. Add item MFD-ITEM-040, Received Quantity: 2, Accepted Quantity: 2, Stock UOM: Nos, UOM: Nos, Conversion Factor: 1, Rate: 100, Target Warehouse: Stores - MFD.",
  },
  {
    doctype: "Purchase Invoice",
    route: /\/desk\/purchase-invoice\/new-purchase-invoice-/i,
    details: "Supplier: Frappeverse Supplier 001. Company: Muster Frappeverse Demo. Posting Date: today. Currency: USD. Credit To: Creditors - MFD. Add item MFD-ITEM-040, Accepted Qty: 2, UOM: Nos, Rate: 100.",
  },
  {
    doctype: "Payment Entry",
    route: /\/desk\/payment-entry\/new-payment-entry-/i,
    details: "Payment Type: Pay. Company: Muster Frappeverse Demo. Posting Date: today. Party Type: Supplier. Party: Frappeverse Supplier 001. Paid From: Cash - MFD. Paid To: Creditors - MFD. Paid Amount: 200. Received Amount: 200. Source Exchange Rate: 1. Target Exchange Rate: 1.",
  },
];

async function beginLiveTraining(testCase) {
  const continuation = page.locator(".muster-chat-message.is-training-continuation button").last();
  await click(continuation);
  const prompt = page.locator(".muster-dock-prompt");
  await prompt.fill(testCase.details);
  await pause(900);
  await click(page.locator(".muster-dock-submit"), 200);
  const clarificationValues = new Map([
    ["uom", "Nos"], ["stock uom", "Nos"], ["quantity", "2"],
    ["item code", "MFD-ITEM-040"], ["supplier", "Frappeverse Supplier 001"],
    ["required date", "2026-08-15"], ["schedule date", "2026-08-15"],
    ["warehouse", "Stores - MFD"], ["target warehouse", "Stores - MFD"],
  ]);
  const deadline = Date.now() + 6 * 60_000;
  const answeredClarifications = new Set();
  while (!testCase.route.test(new URL(page.url()).pathname)) {
    if (Date.now() >= deadline) throw new Error(`${testCase.doctype} did not open its live form`);
    if (await page.getByText(/I couldn.t open the form\. Your details are still here/i).isVisible().catch(() => false)) {
      await pause(1200);
      throw new Error(`${testCase.doctype} governed handoff was rejected`);
    }
    const missingPrompt = page.locator(".muster-dock-prompt");
    const placeholder = await missingPrompt.getAttribute("placeholder").catch(() => "");
    if (/missing detail/i.test(placeholder || "")) {
      const transcript = await page.locator(".muster-dock-body").innerText();
      const label = [...transcript.matchAll(/(?:Which existing permitted value should I use for|What value should I use for) ([^?]+)\?/gi)].at(-1)?.[1]?.trim().toLowerCase();
      const answer = label ? clarificationValues.get(label) : undefined;
      if (!answer) throw new Error(`${testCase.doctype} requested an unsupported clarification: ${label || "unknown"}`);
      const signature = `${label}:${transcript.length}`;
      if (answeredClarifications.has(signature)) {
        await pause(350);
        continue;
      }
      answeredClarifications.add(signature);
      await missingPrompt.fill(answer);
      await click(page.locator(".muster-dock-submit"), 200);
      await pause(900);
      continue;
    }
    const continueButton = page.locator(".muster-chat-message.is-training-continuation button:visible").last();
    if (await continueButton.isVisible().catch(() => false)) {
      await click(continueButton, 200);
      await pause(900);
      continue;
    }
    await pause(350);
  }

  const samples = [];
  let waiting = false;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const state = await page.evaluate(() => {
      const overlay = document.querySelector(".muster-attended-overlay");
      const banner = overlay?.querySelector(".muster-attended-banner");
      const cursor = overlay?.querySelector("[data-attended-cursor]");
      return {
        waiting: overlay?.dataset?.waiting === "true",
        title: banner?.querySelector("strong")?.textContent?.trim() || "",
        detail: banner?.querySelector("small")?.textContent?.trim() || "",
        cursor: cursor ? `${getComputedStyle(cursor).getPropertyValue("--attended-x")}|${getComputedStyle(cursor).getPropertyValue("--attended-y")}` : "",
      };
    });
    if (state.title && !samples.some((sample) => sample.title === state.title && sample.detail === state.detail)) samples.push(state);
    if (state.waiting) {
      waiting = true;
      break;
    }
    await pause(300);
  }
  if (!waiting) throw new Error(`${testCase.doctype} never reached the attended approval boundary`);
  if (samples.length < 3) throw new Error(`${testCase.doctype} did not provide changing real-time guidance`);
  if (new Set(samples.map((sample) => sample.cursor).filter(Boolean)).size < 2) {
    throw new Error(`${testCase.doctype} guided cursor did not move between live controls`);
  }
  const takeover = await page.locator(".muster-attended-overlay[data-waiting='true']").innerText();
  if (!/Save|approval|review/i.test(takeover)) throw new Error(`${testCase.doctype} omitted the human approval boundary`);
  evidence.stages.push({stage: testCase.doctype, result: "live-takeover-pass", samples});

  await click(page.locator("[data-attended-stop]"));
  await page.goto(`${baseUrl}/desk/muster-control?training=buying&ui=20260808-10`, {waitUntil: "domcontentloaded", timeout: 60_000});
  await page.locator(".muster-dock-toggle").waitFor({state: "visible", timeout: 60_000});
  await pause(1000);
}

try {
  await login();
  if (!skipCurriculum) await verifyCurriculum();
  for (const testCase of trainingCases.filter((item) => !requestedStages.size || requestedStages.has(item.doctype))) {
    await verifyInstruction(testCase.doctype);
    await beginLiveTraining(testCase);
  }
  evidence.completedAt = new Date().toISOString();
  evidence.result = "pass";
  await fs.writeFile(path.join(outputDir, "acceptance.json"), `${JSON.stringify(evidence, null, 2)}\n`);
} catch (error) {
  evidence.completedAt = new Date().toISOString();
  evidence.result = "fail";
  evidence.failure = error instanceof Error ? error.stack || error.message : String(error);
  await page.screenshot({path: path.join(outputDir, "failure.png"), fullPage: true}).catch(() => {});
  await fs.writeFile(path.join(outputDir, "acceptance.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  throw error;
} finally {
  await context.close();
  await browser.close();
}
