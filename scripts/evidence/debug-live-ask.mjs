import { chromium } from "../../packages/gateway/node_modules/playwright/index.mjs";

const browser = await chromium.launch({headless: true});
const page = await browser.newPage();
page.on("console", (message) => console.log("BROWSER", message.type(), message.text()));
page.on("pageerror", (error) => console.log("PAGEERROR", error.stack || error.message));
await page.goto(`${process.env.FRAPPE_BASE_URL}/login`);
await page.locator("#login_email, input[name='usr']").first().fill(process.env.FRAPPE_USER);
await page.locator("#login_password, input[name='pwd']").first().fill(process.env.FRAPPE_PASSWORD);
await page.locator("button.btn-login, button:has-text('Login')").first().click();
await page.waitForURL((url) => !url.pathname.endsWith("/login"));
const targetRoute = process.env.FRAPPE_TARGET_ROUTE || "/desk/muster-control";
const prompt = process.env.FRAPPE_ASK_PROMPT || "MUSTER-DEMO-ITEM-001 drawing changed but production still shows old work. why this happening? please fix";
const scope = process.env.FRAPPE_ASK_SCOPE
  ? JSON.parse(process.env.FRAPPE_ASK_SCOPE)
  : {route: targetRoute};
await page.goto(`${process.env.FRAPPE_BASE_URL}${targetRoute}`, {waitUntil: "domcontentloaded"});
await page.waitForFunction(() => typeof window.frappe?.call === "function", undefined, {timeout: 30_000});
const result = await page.evaluate(async ({prompt, scope}) => {
  try {
    const response = await frappe.call({
      method: "muster.api.ask.submit", type: "POST", freeze: false,
      args: {
        prompt,
        conversation_id: `debug-${Date.now()}`,
        scope: JSON.stringify(scope),
        idempotency_key: `debug-${Date.now()}-ask`,
      },
    });
    return {ok: true, message: response.message};
  } catch (error) {
    return {ok: false, message: error?.message, response: error?.responseJSON, status: error?.status};
  }
}, {prompt, scope});
console.log(JSON.stringify(result, null, 2));
if (process.env.FRAPPE_POLL === "1" && result.ok && result.message?.run_id) {
  const state = await page.evaluate(async (runId) => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await frappe.call({
        method: "muster.api.ask.poll", type: "GET", freeze: false,
        args: {run_id: runId, wait_ms: 5000},
      });
      if (["completed", "failed"].includes(response.message?.status)) return response.message;
    }
    return {status: "timeout"};
  }, result.message.run_id);
  console.log("POLL", JSON.stringify(state, null, 2));
}
if (process.env.FRAPPE_ACCEPT_HANDOFF === "1" && result.ok && result.message?.handoffs?.[0]) {
  const accepted = await page.evaluate(async ({turnId, handoffId}) => {
    const accepted = await frappe.call({
      method: "muster.api.ask.accept_handoff", type: "POST",
      args: {turn_id: turnId, handoff_id: handoffId, confirmed: 1, idempotency_key: frappe.utils.get_random(24)},
    });
    return accepted.message;
  }, {turnId: result.message.turn_id, handoffId: result.message.handoffs[0].id});
  console.log("ACCEPTED", JSON.stringify(accepted, null, 2));
  if (accepted?.lineage_plan) {
    const started = page.evaluate(async (lineagePlan) => {
      await window.musterLineagePreview.start(lineagePlan);
      return "completed";
    }, accepted.lineage_plan);
    await page.locator(".modal.show .btn-primary").waitFor({state: "visible", timeout: 20_000});
    await page.locator(".modal.show .btn-primary").click();
    try { console.log("TAKEOVER", await started); } catch (error) { console.log("TAKEOVER_ERROR", error.stack || error.message); }
    await page.screenshot({path: "/tmp/muster-lineage-debug.png", fullPage: true});
  }
}
await browser.close();
