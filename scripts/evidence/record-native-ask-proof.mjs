import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {chromium} from "../../packages/gateway/node_modules/playwright/index.mjs";

const baseUrl = process.env.FRAPPE_BASE_URL;
const user = process.env.FRAPPE_USER;
const password = process.env.FRAPPE_PASSWORD;
const outDir = process.env.VIDEO_OUT_DIR;
if (!baseUrl || !user || !password || !outDir) throw new Error("Missing recording environment");
await fs.mkdir(outDir, {recursive: true});

const browser = await chromium.launch({
  headless: true,
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const context = await browser.newContext({
  viewport: {width: 1280, height: 720},
  recordVideo: {dir: outDir, size: {width: 1280, height: 720}},
});

const page = await context.newPage();
const musterResponses = [];
page.on("response", async (response) => {
  if (!response.url().includes("/api/method/muster.")) return;
  let body = "";
  try { body = (await response.text()).slice(0, 4000); } catch { body = "<unavailable>"; }
  musterResponses.push({status: response.status(), url: response.url(), body});
  process.stderr.write(`[muster-response] ${response.status()} ${response.url()} ${body}\n`);
});
page.on("console", (message) => {
  if (["error", "warning"].includes(message.type())) process.stderr.write(`[browser-${message.type()}] ${message.text()}\n`);
});
const pause = (ms) => page.waitForTimeout(ms);
async function pointAndClick(locator) {
  await locator.waitFor({state: "visible", timeout: 60_000});
  const box = await locator.boundingBox();
  if (!box) throw new Error("Target has no visible box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {steps: 18});
  await pause(450);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

try {
  await page.goto(`${baseUrl}/login`, {waitUntil: "domcontentloaded", timeout: 60_000});
  await pause(1200);
  await page.locator('#login_email, input[name="usr"]').first().fill(user);
  await page.locator('#login_password, input[name="pwd"]').first().fill(password);
  await pointAndClick(page.locator('button:has-text("Login"), .btn-login').first());
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), {timeout: 60_000});
  await page.goto(`${baseUrl}/desk/muster-control?ui=20260720-27`, {waitUntil: "domcontentloaded", timeout: 60_000});
  await page.locator(".muster-dock-toggle").waitFor({state: "visible", timeout: 60_000});
  await pause(2500);
  await pointAndClick(page.locator(".muster-dock-toggle"));
  const prompt = page.locator(".muster-dock-prompt");
  await prompt.fill("Create a Customer named Frappeverse Final Browser Video 2026-07-20 with Customer Type Company and Customer Group Frappeverse Customers.");
  await pause(1800);
  await pointAndClick(page.locator(".muster-dock-submit"));
  await Promise.race([
    page.waitForURL((url) => /\/desk\/customer\/new-customer-/i.test(url.pathname), {timeout: 120_000}),
    page.getByText("Muster could not open the attended form. Nothing was saved.", {exact: true})
      .waitFor({state: "visible", timeout: 120_000})
      .then(() => { throw new Error("Attended form reported a safe failure"); }),
  ]);
  await page.locator(".muster-attended-overlay[data-waiting='true']").waitFor({state: "visible", timeout: 60_000});
  const staged = await page.evaluate(() => ({
    customer_name: window.cur_frm?.doc?.customer_name || "",
    customer_type: window.cur_frm?.doc?.customer_type || "",
    customer_group: window.cur_frm?.doc?.customer_group || "",
    route: window.frappe?.get_route?.() || [],
    cursorLabel: document.querySelector("[data-attended-cursor] span")?.textContent?.trim() || "",
  }));
  if (!staged.customer_name.includes("Frappeverse Final Browser Video")
    || staged.customer_type !== "Company" || staged.customer_group !== "Frappeverse Customers") {
    throw new Error(`Native form was not filled: ${JSON.stringify(staged)}`);
  }
  await pause(4500);

  await pointAndClick(page.locator("[data-attended-review]"));
  await page.waitForURL((url) => /\/desk\/muster-workflow-proposal\/MST-WFP-/i.test(url.pathname), {timeout: 60_000});
  await pause(2500);
  await pointAndClick(page.getByRole("button", {name: "Review", exact: true}));
  const approvedResponse = page.waitForResponse(async (response) => {
    if (!response.url().includes("/api/method/muster.api.mission.review_proposal") || response.status() !== 200) return false;
    try { return (await response.json())?.message?.status === "Approved"; } catch { return false; }
  }, {timeout: 60_000});
  await pointAndClick(page.getByText("Approve proposal", {exact: true}).last());
  await approvedResponse;
  await pause(2500);

  await pointAndClick(page.getByRole("button", {name: "Attended work", exact: true}));
  await pointAndClick(page.getByText("Open form preview", {exact: true}).last());
  await pointAndClick(page.getByRole("button", {name: "Open form and fill", exact: true}));
  await page.waitForURL((url) => /\/desk\/customer\/new-customer-/i.test(url.pathname), {timeout: 60_000});
  await page.locator(".muster-attended-overlay[data-waiting='true'] [data-attended-save]").waitFor({state: "visible", timeout: 60_000});
  await pause(4500);
  await pointAndClick(page.locator("[data-attended-save]"));
  const confirmation = page.locator(".modal.show, .modal.in").filter({hasText: "Allow Muster to save this Customer?"}).last();
  await confirmation.waitFor({state: "visible", timeout: 30_000});
  await pause(1800);
  const verifiedResponse = page.waitForResponse(async (response) => {
    if (!response.url().includes("/api/method/muster.api.mission.verify_attended_save") || response.status() !== 200) return false;
    try { return (await response.json())?.message?.verified === true; } catch { return false; }
  }, {timeout: 60_000});
  await pointAndClick(confirmation.getByRole("button", {name: "Yes", exact: true}));
  await verifiedResponse;
  await page.waitForFunction(() => window.cur_frm?.doc?.__islocal !== 1 && Boolean(window.cur_frm?.docname), null, {timeout: 30_000});
  await pause(6500);
  const receipt = await page.evaluate(() => ({
    customer_name: window.cur_frm?.doc?.customer_name || "",
    customer_type: window.cur_frm?.doc?.customer_type || "",
    customer_group: window.cur_frm?.doc?.customer_group || "",
    record_name: window.cur_frm?.docname || "",
    route: window.frappe?.get_route?.() || [],
    saved: window.cur_frm?.doc?.__islocal !== 1,
    success: [...document.querySelectorAll(".alert, .toast-message")].map((node) => node.textContent || "").find((text) => text.includes("Saved and verified")) || "",
  }));
  const evidence = {staged, receipt, musterResponses};
  await fs.writeFile(path.join(outDir, "receipt.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  if (!receipt.saved || !receipt.record_name || !receipt.customer_name.includes("Frappeverse Final Browser Video")) {
    throw new Error(`Native Save was not verified: ${JSON.stringify(receipt)}`);
  }
  process.stdout.write(`${JSON.stringify({staged, receipt})}\n`);
} finally {
  await context.close();
  await browser.close();
}
