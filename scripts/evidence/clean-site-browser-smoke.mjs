import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";

import {chromium} from "../../packages/gateway/node_modules/playwright/index.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const baseUrl = process.env.FRAPPE_BASE_URL || "http://127.0.0.1:18200";
const password = process.env.FRAPPE_ADMIN_PASSWORD;
if (!password) throw new Error("FRAPPE_ADMIN_PASSWORD is required");

const evidenceDir = path.join(root, "output", "evidence", "frappeverse-mariadb-live-20260720");
await fs.mkdir(evidenceDir, {recursive: true});

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROME_PATH
    || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
try {
  const context = await browser.newContext({viewport: {width: 1440, height: 900}});
  const page = await context.newPage();
  await page.goto(`${baseUrl}/login`, {waitUntil: "domcontentloaded", timeout: 60_000});
  await page.locator('#login_email, input[name="usr"]').first().fill("Administrator");
  await page.locator('#login_password, input[name="pwd"]').first().fill(password);
  await page.locator('button:has-text("Login"), .btn-login').first().click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), {timeout: 60_000});

  await page.goto(`${baseUrl}/desk/muster-control`, {waitUntil: "networkidle", timeout: 90_000});
  const title = await page.title();
  const body = await page.locator("body").innerText();
  const setupWizard = new URL(page.url()).pathname.startsWith("/desk/setup-wizard");
  const askMusterVisible = /Ask Muster/i.test(body);
  if (setupWizard && !askMusterVisible) {
    throw new Error("Clean setup wizard rendered without the global Ask Muster surface");
  }
  if (!setupWizard && !/Muster/i.test(`${title}\n${body}`)) {
    throw new Error("Muster control surface did not render recognizable content");
  }
  const screenshot = path.join(
    evidenceDir,
    setupWizard
      ? "clean-mariadb-setup-wizard-with-ask-muster.png"
      : "clean-mariadb-muster-control.png",
  );
  await page.screenshot({path: screenshot, fullPage: true});
  const cookies = await context.cookies();
  if (!cookies.some((cookie) => cookie.name === "sid" && cookie.value !== "Guest")) {
    throw new Error("Authenticated Frappe session cookie was not established");
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    baseUrl,
    finalUrl: page.url(),
    title,
    viewport: "1440x900",
    screenshot,
    authenticated: true,
    setupWizard,
    askMusterVisible,
  }));
} finally {
  await browser.close();
}
