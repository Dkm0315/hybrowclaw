#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "../../packages/gateway/node_modules/playwright/index.mjs";
import { getVinmanScenario, VINMAN_SCENARIO_IDS, VINMAN_SCENARIOS } from "./vinman-live-scenarios.mjs";
import { VINMAN_RECEIPT_ATTRIBUTES, VINMAN_SELECTORS } from "./vinman-live-selectors.mjs";

const DEFAULT_VIEWPORT = Object.freeze({width: 1440, height: 900});
const DEFAULT_TIMEOUT_MS = 180_000;
const FORBIDDEN_FIXTURE_REQUEST = /(?:muster\.demo|vinman_engineering_demo|additional_scenario_(?:setup|fault|correct|reset)|MUSTER_DEMO_ACTION)/i;

function usage() {
  return [
    "Usage:",
    "  FRAPPE_BASE_URL=https://demo.example.test FRAPPE_USER=Administrator \\",
    "  FRAPPE_PASSWORD='...' VIDEO_OUT_DIR=output/evidence/vinman-live \\",
    "  node scripts/evidence/vinman-live-recorder.mjs --scenario revision-escape",
    "",
    `--scenario must be one of ${VINMAN_SCENARIO_IDS.join(", ")} or all.`,
    "Each invocation creates a new output directory and uses only visible browser UI actions.",
  ].join("\n");
}

export function parseArgs(argv = []) {
  const values = {scenario: "all", out: process.env.VIDEO_OUT_DIR || "output/evidence/vinman-live", headed: false};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--headed") {
      values.headed = true;
      continue;
    }
    if (!token?.startsWith("--")) throw new Error(`Invalid argument: ${token || "<end>"}\n\n${usage()}`);
    const key = token.slice(2);
    if (!["scenario", "out", "timeout"].includes(key)) throw new Error(`Unknown argument: ${token}\n\n${usage()}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}\n\n${usage()}`);
    values[key] = value;
    index += 1;
  }
  if (values.scenario !== "all" && !VINMAN_SCENARIO_IDS.includes(values.scenario)) {
    throw new Error(`Unknown scenario: ${values.scenario}\n\n${usage()}`);
  }
  const timeoutMs = Number(values.timeout || DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10_000) throw new Error("--timeout must be an integer of at least 10000 milliseconds");
  return {...values, out: path.resolve(values.out), timeoutMs};
}

export function isForbiddenFixtureRequest(url) {
  return FORBIDDEN_FIXTURE_REQUEST.test(String(url));
}

function matches(pattern, value) {
  const regex = pattern instanceof RegExp ? new RegExp(pattern.source, pattern.flags.replaceAll("g", "")) : new RegExp(String(pattern), "i");
  return regex.test(value);
}

function requirePatterns(patterns, value, label) {
  const missing = patterns.filter((pattern) => !matches(pattern, value));
  if (missing.length > 0) throw new Error(`${label} is missing required visible evidence: ${missing.map(String).join(", ")}`);
}

export function validateScenarioObservation(scenario, observation) {
  if (!observation || !Array.isArray(observation.scenarioEvidence) || observation.scenarioEvidence.length === 0) {
    throw new Error(`${scenario.id} produced no scenario-scoped visible evidence`);
  }
  if (!Array.isArray(observation.assistantMessages)) {
    throw new Error(`${scenario.id} produced an invalid assistant transcript`);
  }
  const visibleText = [
    ...observation.assistantMessages,
    ...observation.scenarioEvidence,
    observation.takeover?.text || "",
    observation.receipt?.text || "",
    observation.receipt?.status || "",
  ].join("\n");
  requirePatterns(scenario.requiredVisiblePatterns, visibleText, scenario.id);
  if (!observation.takeover?.visible || !observation.takeover.waiting || !observation.takeover.text) {
    throw new Error(`${scenario.id} did not show a visible waiting takeover overlay`);
  }
  if (!observation.approvalClicked) throw new Error(`${scenario.id} did not cross its visible approval boundary`);
  const receipt = observation.receipt;
  const expectedEvidenceScenario = scenario.evidenceScenario || scenario.id;
  if (!receipt?.visible || !receipt.id || receipt.scenario !== expectedEvidenceScenario) {
    throw new Error(`${scenario.id} did not show a scenario-scoped receipt with an id`);
  }
  if (!matches(/verified|restored/i, `${receipt.status}\n${receipt.text}`)) {
    throw new Error(`${scenario.id} receipt is not visibly verified`);
  }
  requirePatterns(scenario.requiredReceiptPatterns, `${receipt.status}\n${receipt.text}`, `${scenario.id} receipt`);
  if (scenario.id === "authorized-customization-repair") {
    if (!observation.repairReceipt || !matches(/verified/i, `${observation.repairReceipt.status}\n${observation.repairReceipt.text}`)) {
      throw new Error(`${scenario.id} did not preserve the verified repair receipt`);
    }
    if (!observation.restorationReceipt || !matches(/restored/i, `${observation.restorationReceipt.status}\n${observation.restorationReceipt.text}`)) {
      throw new Error(`${scenario.id} did not prove restoration of the original script`);
    }
    if (!observation.businessRetestCompleted) {
      throw new Error(`${scenario.id} did not repeat and verify the affected business-form Save`);
    }
  }
  if (observation.forbiddenRequests?.length) {
    throw new Error(`${scenario.id} attempted a fixture correction request: ${observation.forbiddenRequests[0]}`);
  }
  if (observation.followUpVisible) throw new Error(`${scenario.id} requested a second user prompt`);
  return true;
}

async function visibleTexts(locator) {
  const texts = [];
  for (let index = 0; index < await locator.count(); index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) {
      const text = (await item.innerText().catch(() => "")).trim();
      if (text) texts.push(text);
    }
  }
  return texts;
}

async function firstVisible(locator) {
  for (let index = 0; index < await locator.count(); index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return null;
}

async function humanClick(page, locator, label) {
  const target = await firstVisible(locator);
  if (!target) throw new Error(`Could not find visible ${label}`);
  await target.scrollIntoViewIfNeeded();
  await page.waitForTimeout(280);
  const box = await target.boundingBox();
  if (!box) throw new Error(`Visible ${label} has no clickable bounds`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const visibleLabel = await target.evaluate((element, fallback) => {
    const candidate = [
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      fallback,
      element.textContent,
    ].find((value) => typeof value === "string" && value.trim());
    return String(candidate || fallback).replace(/\s+/g, " ").trim().slice(0, 72);
  }, label);
  await showPresentationPointer(page, {x, y, label: visibleLabel});
  await page.mouse.move(x, y, {steps: 14});
  await page.waitForTimeout(220);
  // Frappe forms can leave transparent controls above dock overlays. Keep the
  // cursor movement visible in the recording, then dispatch to the element we
  // already proved is visible instead of letting that form layer steal it.
  await page.waitForTimeout(90);
  await pulsePresentationPointer(page);
  await target.evaluate((element) => element.click());
  await page.waitForTimeout(260);
  return target;
}

async function humanPoint(page, locator, label) {
  const target = await firstVisible(locator);
  if (!target) throw new Error(`Could not find visible ${label}`);
  await target.scrollIntoViewIfNeeded();
  await page.waitForTimeout(320);
  const box = await target.boundingBox();
  if (!box) throw new Error(`Visible ${label} has no bounds`);
  const x = box.x + Math.min(box.width * 0.42, 320);
  const y = box.y + Math.min(box.height * 0.5, 72);
  await showPresentationPointer(page, {x, y, label});
  await page.mouse.move(x, y, {steps: 14});
  await page.waitForTimeout(240);
  return target;
}

async function showPresentationPointer(page, {x, y, label}) {
  await page.evaluate(({x: nextX, y: nextY, label: nextLabel}) => {
    let style = document.getElementById("muster-presentation-pointer-style");
    if (!style) {
      style = document.createElement("style");
      style.id = "muster-presentation-pointer-style";
      style.textContent = `
        #muster-presentation-pointer {
          position: fixed; left: 0; top: 0; z-index: 2147483647;
          width: 30px; height: 36px; pointer-events: none; opacity: 1;
          transform: translate3d(24px, 24px, 0);
          transition: transform 360ms cubic-bezier(.2,.8,.2,1), opacity 120ms ease;
          filter: drop-shadow(0 2px 4px rgba(0,0,0,.34));
        }
        #muster-presentation-pointer svg { display: block; width: 30px; height: 36px; }
        #muster-presentation-pointer .muster-pointer-label {
          position: absolute; left: 24px; top: 24px; max-width: 260px;
          padding: 6px 10px; border-radius: 7px; background: #111827;
          color: white; font: 600 12px/1.25 Inter, system-ui, sans-serif;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          box-shadow: 0 4px 16px rgba(0,0,0,.24);
        }
        #muster-presentation-step {
          position: fixed; z-index: 2147483646; left: 50%; top: 22px;
          transform: translateX(-50%); width: min(620px, calc(100vw - 48px));
          padding: 11px 15px; border: 1px solid rgba(124,58,237,.28);
          border-radius: 8px; background: rgba(255,255,255,.97); color: #17212b;
          box-shadow: 0 8px 28px rgba(23,33,43,.18); pointer-events: none;
          font: 600 14px/1.35 Inter, system-ui, sans-serif; text-align: center;
        }
        #muster-presentation-step small {
          display: block; margin-bottom: 2px; color: #7c3aed;
          font-size: 10px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase;
        }
        #muster-presentation-pointer::after {
          content: ""; position: absolute; left: -14px; top: -14px;
          width: 34px; height: 34px; border: 3px solid #111827;
          border-radius: 50%; opacity: 0; transform: scale(.35);
        }
        #muster-presentation-pointer.is-clicking::after {
          animation: muster-pointer-pulse 620ms ease-out;
        }
        @keyframes muster-pointer-pulse {
          0% { opacity: .95; transform: scale(.35); }
          100% { opacity: 0; transform: scale(1.55); }
        }
      `;
      document.head.appendChild(style);
    }
    let pointer = document.getElementById("muster-presentation-pointer");
    if (!pointer) {
      pointer = document.createElement("div");
      pointer.id = "muster-presentation-pointer";
      pointer.innerHTML = `
        <svg viewBox="0 0 30 36" aria-hidden="true">
          <path d="M3 2.5 24 20l-10.2 1.9L19 32l-5.1 2.6-5.2-10.2L3 32Z"
            fill="#111827" stroke="#fff" stroke-width="2.3" stroke-linejoin="round"/>
        </svg>
        <span class="muster-pointer-label"></span>`;
      document.body.appendChild(pointer);
    }
    pointer.classList.remove("is-clicking");
    pointer.querySelector(".muster-pointer-label").textContent = nextLabel;
    pointer.style.transform = `translate3d(${Math.max(8, nextX - 4)}px, ${Math.max(8, nextY - 4)}px, 0)`;
    pointer.style.opacity = "1";
    document.getElementById("muster-presentation-step")?.remove();
  }, {x, y, label});
  await page.waitForTimeout(420);
}

async function pulsePresentationPointer(page) {
  await page.evaluate(() => {
    const pointer = document.getElementById("muster-presentation-pointer");
    if (!pointer) return;
    pointer.classList.remove("is-clicking");
    void pointer.offsetWidth;
    pointer.classList.add("is-clicking");
  });
  await page.waitForTimeout(240);
}

async function pauseForReading(page, milliseconds = 2200) {
  await page.waitForTimeout(milliseconds);
}

async function waitForExternalApproval(scenario, options) {
  if (scenario.id !== "v16-migration" || !options.externalApprovalFile) return;
  process.stdout.write(`AWAITING_EXTERNAL_APPROVAL ${options.externalApprovalFile}\n`);
  const startedAt = Date.now();
  while (Date.now() - startedAt < options.timeoutMs) {
    if (await fs.access(options.externalApprovalFile).then(() => true).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new Error("Timed out waiting for explicit approval to create the external support ticket");
}

async function openRecordFromList(page, scenario, options) {
  if (!scenario.recordName) return;
  await page.waitForLoadState("domcontentloaded");
  await pauseForReading(page, 2800);
  const escapedName = scenario.recordName.replaceAll('"', '\\"');
  const record = page.locator([
    `.list-row-container[data-name="${escapedName}"] a`,
    `.list-row[data-name="${escapedName}"] a`,
    `a[data-name="${escapedName}"]`,
    `a[href$="/${encodeURIComponent(scenario.recordName)}"]`,
    `a:has-text("${escapedName}")`,
  ].join(", "));
  const visibleRecord = await record.first().waitFor({state: "visible", timeout: 8_000})
    .then(() => true)
    .catch(() => false);
  if (visibleRecord) {
    await humanClick(page, record, `${scenario.recordName} list row`);
  } else {
    const listPath = new URL(page.url()).pathname.replace(/\/$/, "");
    await page.goto(`${options.baseUrl}${listPath}/${encodeURIComponent(scenario.recordName)}`, {
      waitUntil: "domcontentloaded",
      timeout: options.timeoutMs,
    });
  }
  await page.waitForURL((url) => decodeURIComponent(url.pathname).includes(scenario.recordName), {timeout: options.timeoutMs});
  await pauseForReading(page, 3200);
}

async function openFromDeskSearch(page, scenario, options) {
  if (!scenario.searchTarget) return;
  await pauseForReading(page, 2600);
  await humanClick(page, page.locator("#desktop-navbar-modal-search"), "Search for the affected migration report");
  const search = page.locator("#navbar-search");
  await search.waitFor({state: "visible", timeout: options.timeoutMs});
  await search.pressSequentially(scenario.searchTarget, {delay: options.promptDelayMs});
  await pauseForReading(page, 2400);
  const result = page.locator("a", {hasText: `Report ${scenario.searchTarget}`});
  await humanClick(page, result, "Open the report that fails after migration");
  await page.waitForURL((url) => decodeURIComponent(url.pathname).includes(scenario.searchTarget), {timeout: options.timeoutMs});
  const error = page.getByText(scenario.expectedError, {exact: false});
  await error.first().waitFor({state: "visible", timeout: options.timeoutMs});
  await pauseForReading(page, 5200);
  const dialog = page.locator(".modal.show, .msgprint-dialog:visible");
  const close = dialog.locator('button:has-text("Close"), button.btn-modal-close, .modal-header .btn-modal-close');
  if (await firstVisible(close)) await humanClick(page, close, "Keep the visible migration error as evidence");
  else await page.keyboard.press("Escape");
  await pauseForReading(page, 1400);
}

async function openScenarioRoute(page, scenario, options) {
  if (scenario.id !== "revision-escape") {
    await page.goto(`${options.baseUrl}${scenario.route}`, {waitUntil: "domcontentloaded", timeout: options.timeoutMs});
    return;
  }
  await page.goto(`${options.baseUrl}/desk`, {waitUntil: "domcontentloaded", timeout: options.timeoutMs});
  await pauseForReading(page, 3200);
  const musterEntry = page.locator([
    'a[href="/desk/muster-control"]',
    'a[href$="/muster-control"]',
    '.widget.shortcut-widget-box:has-text("Muster")',
    '.widget:has-text("Muster") a',
  ].join(", "));
  if (!(await firstVisible(musterEntry))) {
    throw new Error("The Frappe home page did not expose a visible Muster entry point");
  }
  await musterEntry.first().evaluate((element) => element.removeAttribute("target"));
  await humanClick(page, musterEntry, "Open Muster");
  await page.waitForURL((url) => url.pathname.includes("/desk/muster-control"), {timeout: options.timeoutMs});
  await pauseForReading(page, 2600);
}

async function reproduceCustomizationError(page, scenario, options) {
  if (scenario.id !== "authorized-customization-repair" && !scenario.reproduceCustomizationError) return;
  const revision = page.locator([
    '[data-fieldname="drawing_rev_no"] input',
    '[data-fieldname="drawing_rev_no"] .input-with-feedback',
  ].join(", "));
  await revision.first().waitFor({state: "visible", timeout: options.timeoutMs});
  const input = await firstVisible(revision);
  if (!input) throw new Error("Could not find the visible Drawing Revision field on the Control Plan");

  await humanClick(page, revision, "Drawing Revision field");
  await input.press("ControlOrMeta+A");
  await input.pressSequentially("A", {delay: options.promptDelayMs});
  await input.press("Tab");
  await pauseForReading(page, 900);
  await humanClick(page, revision, "Drawing Revision field");
  await input.press("ControlOrMeta+A");
  await input.pressSequentially("B", {delay: options.promptDelayMs});
  await input.press("Tab");
  await pauseForReading(page, 1800);

  const save = page.locator('button:has-text("Save"), [data-label="Save"], .primary-action:has-text("Save")');
  await humanClick(page, save, "Repeat the same Save to reproduce the reported failure");
  const error = page.getByText(scenario.expectedError, {exact: false});
  await error.first().waitFor({state: "visible", timeout: options.timeoutMs});
  await pauseForReading(page, 5200);

  const dialog = page.locator('.modal.show, .msgprint-dialog:visible');
  const close = dialog.locator('button:has-text("Close"), button.btn-modal-close, .modal-header .btn-modal-close');
  if (await firstVisible(close)) {
    await humanClick(page, close, "Keep the failed Save visible as diagnosis evidence");
  } else {
    await page.keyboard.press("Escape");
  }
  await pauseForReading(page, 1600);
}

async function retestCustomizationRepair(page, scenario, options) {
  const retest = page.locator("[data-repair-retest]");
  await humanClick(page, retest, "Re-test the affected form");
  await page.waitForLoadState("domcontentloaded", {timeout: options.timeoutMs});
  const continueButton = page.locator("[data-repair-retest-continue]");
  await continueButton.waitFor({state: "visible", timeout: options.timeoutMs});
  await pauseForReading(page, options.reviewPauseMs);
  await humanClick(page, continueButton, "Repeat the live Save");
  await page.waitForTimeout(900);

  const revision = page.locator([
    '[data-fieldname="drawing_rev_no"] input',
    '[data-fieldname="drawing_rev_no"] .input-with-feedback',
  ].join(", "));
  const input = await firstVisible(revision);
  if (!input) throw new Error("The reloaded Control Plan did not expose its Drawing Revision field");
  const oldError = page.getByText(scenario.expectedError, {exact: false});
  const save = page.locator('button:has-text("Save"), [data-label="Save"], .primary-action:has-text("Save")');

  const saveRevision = async (value, label) => {
    await humanClick(page, revision, "Drawing Revision field");
    await input.press("ControlOrMeta+A");
    await input.pressSequentially(value, {delay: options.promptDelayMs});
    await input.press("Tab");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(850);
    const beforeModified = await page.evaluate(() => String(window.cur_frm?.doc?.modified || ""));
    await humanClick(page, save, label);
    await page.waitForFunction(({beforeModified, errorText}) => {
      const dialogText = [...document.querySelectorAll(".modal.show, .msgprint-dialog")]
        .map((node) => node.textContent || "").join("\n");
      if (dialogText.includes(errorText)) return false;
      const form = window.cur_frm;
      return Boolean(form?.doc?.modified && String(form.doc.modified) !== beforeModified && !form.is_dirty());
    }, {beforeModified, errorText: scenario.expectedError}, {timeout: options.timeoutMs});
    if (await firstVisible(oldError)) throw new Error("The former Client Script validation error returned during re-test");
    return {
      beforeModified,
      afterModified: await page.evaluate(() => String(window.cur_frm?.doc?.modified || "")),
    };
  };

  await saveRevision("A", "Save the control revision");
  const verified = await saveRevision("B", "Save revision B again");
  await page.evaluate((evidence) => window.musterCustomizationRepair.markRetestVerified({
    before_modified: evidence.beforeModified,
    after_modified: evidence.afterModified,
    old_error_absent: true,
    saved: true,
  }), verified);
  await page.locator("[data-muster-business-retest][data-muster-retest-status='verified']")
    .waitFor({state: "visible", timeout: options.timeoutMs});
  await pauseForReading(page, options.resultPauseMs);
}

export async function typeHumanPrompt(page, locator, prompt, {delayMs = 42} = {}) {
  await locator.click();
  await locator.press("ControlOrMeta+A");
  await locator.press("Backspace");
  await locator.pressSequentially(prompt, {delay: delayMs});
}

async function login(page, options) {
  await page.goto(`${options.baseUrl}/login`, {waitUntil: "domcontentloaded", timeout: options.timeoutMs});
  await page.locator(VINMAN_SELECTORS.login.user).first().fill(options.user);
  await page.locator(VINMAN_SELECTORS.login.password).first().fill(options.password);
  await humanClick(page, page.locator(VINMAN_SELECTORS.login.submit), "Frappe login button");
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), {timeout: options.timeoutMs});
}

async function readReceipt(locator) {
  const item = await firstVisible(locator);
  if (!item) return null;
  return {
    visible: true,
    id: await item.getAttribute(VINMAN_RECEIPT_ATTRIBUTES.id) || "",
    status: await item.getAttribute(VINMAN_RECEIPT_ATTRIBUTES.status) || "",
    scenario: await item.getAttribute(VINMAN_RECEIPT_ATTRIBUTES.scenario) || "",
    text: (await item.innerText().catch(() => "")).trim(),
  };
}

async function clickApprovalBoundary(page, scenario) {
  const takeover = page.locator(VINMAN_SELECTORS.muster.waitingTakeover);
  const review = await firstVisible(takeover.locator(VINMAN_SELECTORS.muster.review));
  if (review) {
    const reviewText = (await review.innerText().catch(() => "")).trim();
    if (!matches(scenario.approvalPattern, reviewText)) throw new Error(`${scenario.id} takeover review control had unexpected text: ${reviewText}`);
    await humanClick(page, takeover.locator(VINMAN_SELECTORS.muster.review), "takeover review button");
    await page.waitForTimeout(450);
  }
  const approval = await firstVisible(page.locator(VINMAN_SELECTORS.muster.approve));
  if (!approval) throw new Error(`${scenario.id} takeover did not expose a visible approval control`);
  const approvalText = (await approval.innerText().catch(() => "")).trim();
  if (!matches(scenario.approvalPattern, approvalText)) throw new Error(`${scenario.id} approval control had unexpected text: ${approvalText}`);
  await humanClick(page, page.locator(VINMAN_SELECTORS.muster.approve), "takeover approval button");
}

async function captureVisibleScenario(page, scenario, options, forbiddenRequests) {
  const startedAt = Date.now();
  let launchClicked = false;
  let approvalClicked = false;
  let restorationStarted = false;
  let businessRetestCompleted = false;
  let supportEvidenceReviewed = false;
  let repairReceipt = null;
  const clickedApprovals = new Set();
  const takeoverSamples = [];
  while (Date.now() - startedAt < options.timeoutMs) {
    const followUpVisible = Boolean(await firstVisible(page.locator(VINMAN_SELECTORS.muster.followUp)));
    if (followUpVisible) throw new Error(`${scenario.id} exposed a second-prompt state`);

    const assistantMessages = await visibleTexts(page.locator(VINMAN_SELECTORS.muster.assistantMessages));
    const evidenceScenario = scenario.evidenceScenario || scenario.id;
    const scenarioEvidence = await visibleTexts(page.locator(VINMAN_SELECTORS.muster.evidence(evidenceScenario)));
    if (!launchClicked) {
      const launch = await firstVisible(page.locator(VINMAN_SELECTORS.muster.launch(scenario.id)));
      if (launch) {
        await page.waitForTimeout(options.reviewPauseMs);
        const launchText = (await launch.innerText().catch(() => "")).trim();
        await humanClick(page, page.locator(VINMAN_SELECTORS.muster.launch(scenario.id)), launchText || "Continue with Muster's reviewed next step");
        launchClicked = true;
        await page.waitForTimeout(450);
      }
    }
    if (!supportEvidenceReviewed) {
      const highlight = await firstVisible(page.locator("[data-muster-support-highlight]"));
      if (highlight) {
        const exactLine = highlight.locator("code").first();
        await humanPoint(
          page,
          (await firstVisible(exactLine)) ? exactLine : page.locator("[data-muster-support-highlight]"),
          "Exact failing customization",
        );
        await page.waitForTimeout(Math.max(options.reviewPauseMs, 6_500));
        supportEvidenceReviewed = true;
      }
    }
    const approval = await firstVisible(page.locator(VINMAN_SELECTORS.muster.approve));
    if (approval) {
      const approvalText = (await approval.innerText().catch(() => "")).trim();
      const approvalKey = `${approvalText}:${await page.url()}`;
      if (!clickedApprovals.has(approvalKey)) {
        await page.waitForTimeout(options.reviewPauseMs);
        await waitForExternalApproval(scenario, options);
        await humanClick(page, page.locator(VINMAN_SELECTORS.muster.approve), approvalText || "Approve the reviewed action");
        clickedApprovals.add(approvalKey);
        approvalClicked = true;
        await page.waitForTimeout(650);
        const confirmation = await firstVisible(page.locator(".modal.show .btn-primary"));
        if (confirmation) {
          const confirmationText = (await confirmation.innerText().catch(() => "")).trim();
          if (!matches(/yes|confirm|apply|approve|send|create/i, confirmationText)) {
            throw new Error(`${scenario.id} confirmation control had unexpected text: ${confirmationText}`);
          }
          await page.waitForTimeout(options.reviewPauseMs);
          await humanClick(page, page.locator(".modal.show .btn-primary"), confirmationText || "Confirm the exact reviewed action");
          clickedApprovals.add(`confirmation:${confirmationText}:${await page.url()}`);
        }
        await page.waitForTimeout(450);
      }
    }
    const waitingTakeover = await firstVisible(page.locator(VINMAN_SELECTORS.muster.waitingTakeover));
    if (waitingTakeover) {
      const takeoverText = (await waitingTakeover.innerText().catch(() => "")).trim();
      if (takeoverText && !takeoverSamples.includes(takeoverText)) takeoverSamples.push(takeoverText);
      if (!approvalClicked && !(await firstVisible(page.locator(VINMAN_SELECTORS.muster.approve)))) {
        await clickApprovalBoundary(page, scenario);
        approvalClicked = true;
      }
    }
    let receipt = await readReceipt(page.locator(VINMAN_SELECTORS.muster.receipt(evidenceScenario)));
    if (scenario.id === "authorized-customization-repair" && receipt?.status === "verified") {
      repairReceipt ||= receipt;
      if (!businessRetestCompleted) {
        await page.waitForTimeout(options.reviewPauseMs);
        await retestCustomizationRepair(page, scenario, options);
        businessRetestCompleted = true;
        receipt = await readReceipt(page.locator(VINMAN_SELECTORS.muster.receipt(scenario.id)));
      }
      if (!restorationStarted) {
        const restoreReview = await firstVisible(page.locator("[data-repair-prepare-rollback]"));
        if (restoreReview) {
          await page.waitForTimeout(options.reviewPauseMs);
          await humanClick(page, page.locator("[data-repair-prepare-rollback]"), "Review how the isolated demo change will be restored");
          restorationStarted = true;
          await page.waitForTimeout(650);
          receipt = await readReceipt(page.locator(VINMAN_SELECTORS.muster.receipt(scenario.id)));
        }
      }
    }
    const restorationReceipt = scenario.id === "authorized-customization-repair" && receipt?.status === "restored"
      ? receipt : null;
    const observation = {
      assistantMessages,
      scenarioEvidence: scenarioEvidence.length ? scenarioEvidence : assistantMessages,
      takeover: {
        visible: takeoverSamples.length > 0,
        waiting: takeoverSamples.length > 0,
        text: takeoverSamples.join("\n"),
      },
      takeoverSamples,
      launchClicked,
      approvalClicked,
      receipt,
      repairReceipt,
      restorationReceipt,
      businessRetestCompleted,
      forbiddenRequests,
      followUpVisible,
    };
    const complete = scenario.id === "authorized-customization-repair"
      ? Boolean(restorationReceipt && repairReceipt)
      : Boolean(receipt);
    if (complete && approvalClicked) {
      validateScenarioObservation(scenario, observation);
      await page.waitForTimeout(options.resultPauseMs);
      return observation;
    }
    await page.waitForTimeout(350);
  }
  throw new Error(`${scenario.id} did not produce its visible evidence, takeover, and receipt before timeout`);
}

async function prepareOutputDir(outputDir) {
  await fs.mkdir(path.dirname(outputDir), {recursive: true});
  await fs.mkdir(outputDir);
}

async function artifactBytes(filename) {
  return fs.stat(filename).then((stat) => stat.size).catch(() => 0);
}

async function isWebm(filename) {
  const header = await fs.open(filename, "r").then(async (handle) => {
    const buffer = Buffer.alloc(4);
    await handle.read(buffer, 0, 4, 0);
    await handle.close();
    return buffer;
  }).catch(() => Buffer.alloc(0));
  return header.equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
}

async function closeSession({context, browser, tracePath, traceStarted, page, screenshotPath}) {
  if (traceStarted) await context.tracing.stop({path: tracePath}).catch(() => {});
  if (page && screenshotPath) await page.screenshot({path: screenshotPath, fullPage: true}).catch(() => {});
  const video = page?.video();
  await context?.close().catch(() => {});
  const videoPath = await video?.path().catch(() => undefined);
  await browser?.close().catch(() => {});
  return videoPath;
}

export async function recordScenario(scenario, options, {browserType = chromium} = {}) {
  await prepareOutputDir(options.outputDir);
  const startedAt = new Date().toISOString();
  const tempVideoDir = path.join(options.outputDir, ".playwright-video");
  await fs.mkdir(tempVideoDir);
  const videoOutput = path.join(options.outputDir, "recording.webm");
  const tracePath = path.join(options.outputDir, "trace.zip");
  const screenshotPath = path.join(options.outputDir, "final.png");
  let browser;
  let context;
  let page;
  let traceStarted = false;
  const forbiddenRequests = [];
  let failure;
  let observation;
  try {
    browser = await browserType.launch({
      headless: !options.headed,
      executablePath: options.executablePath || undefined,
    });
    const authContext = await browser.newContext({viewport: options.viewport || DEFAULT_VIEWPORT});
    const authPage = await authContext.newPage();
    await login(authPage, options);
    const storageState = await authContext.storageState();
    await authContext.close();
    context = await browser.newContext({
      viewport: options.viewport || DEFAULT_VIEWPORT,
      storageState,
      recordVideo: {dir: tempVideoDir, size: options.viewport || DEFAULT_VIEWPORT},
    });
    await context.tracing.start({screenshots: true, snapshots: true, sources: false});
    traceStarted = true;
    page = await context.newPage();
    page.on("request", (request) => {
      if (isForbiddenFixtureRequest(request.url())) forbiddenRequests.push(request.url());
    });
    await openScenarioRoute(page, scenario, options);
    await openFromDeskSearch(page, scenario, options);
    await openRecordFromList(page, scenario, options);
    await reproduceCustomizationError(page, scenario, options);
    const prompt = page.locator(VINMAN_SELECTORS.muster.prompt);
    if (!(await firstVisible(prompt))) await humanClick(page, page.locator(VINMAN_SELECTORS.muster.toggle), "Open Muster beside the affected work");
    await prompt.waitFor({state: "visible", timeout: options.timeoutMs});
    await typeHumanPrompt(page, prompt, scenario.prompt, {delayMs: options.promptDelayMs});
    await humanClick(page, page.locator(VINMAN_SELECTORS.muster.submit), "Ask Muster to investigate and continue the work");
    observation = await captureVisibleScenario(page, scenario, options, forbiddenRequests);
    if (forbiddenRequests.length) throw new Error(`Forbidden fixture request observed: ${forbiddenRequests[0]}`);
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }

  const recordedVideoPath = await closeSession({context, browser, tracePath, traceStarted, page, screenshotPath});
  if (recordedVideoPath) await fs.copyFile(recordedVideoPath, videoOutput);
  await fs.rm(tempVideoDir, {recursive: true, force: true});
  const finishedAt = new Date().toISOString();
  const videoBytes = await artifactBytes(videoOutput);
  const screenshotBytes = await artifactBytes(screenshotPath);
  const traceBytes = await artifactBytes(tracePath);
  if (!failure && (videoBytes < 1 || !(await isWebm(videoOutput)))) failure = new Error(`${scenario.id} did not produce a valid WebM recording`);
  if (!failure && (screenshotBytes < 1 || traceBytes < 1)) failure = new Error(`${scenario.id} did not produce its screenshot and trace evidence`);

  const receipt = {
    scenario_id: scenario.id,
    title: scenario.title,
    prompt: scenario.prompt,
    started_at: startedAt,
    finished_at: finishedAt,
    browser: {base_url: options.baseUrl, route: scenario.route, viewport: options.viewport || DEFAULT_VIEWPORT},
    visible_evidence: observation || null,
    artifacts: {
      video: "recording.webm",
      screenshot: "final.png",
      trace: "trace.zip",
      video_bytes: videoBytes,
      screenshot_bytes: screenshotBytes,
      trace_bytes: traceBytes,
    },
    result: failure ? "fail" : "pass",
    ...(failure ? {failure: failure.stack || failure.message} : {}),
  };
  await fs.writeFile(path.join(options.outputDir, failure ? "failure.json" : "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, {flag: "wx"});
  if (failure) throw failure;
  return receipt;
}

function environmentOptions(args) {
  const baseUrl = process.env.FRAPPE_BASE_URL;
  const user = process.env.FRAPPE_USER || process.env.FRAPPE_USERNAME;
  const password = process.env.FRAPPE_PASSWORD;
  if (!baseUrl || !user || !password) throw new Error(`FRAPPE_BASE_URL, FRAPPE_USER, and FRAPPE_PASSWORD are required\n\n${usage()}`);
  return {
    ...args,
    baseUrl: baseUrl.replace(/\/$/, ""),
    user,
    password,
    promptDelayMs: Number(process.env.VINMAN_PROMPT_DELAY_MS || 42),
    reviewPauseMs: Number(process.env.VINMAN_REVIEW_PAUSE_MS || 2800),
    resultPauseMs: Number(process.env.VINMAN_RESULT_PAUSE_MS || 3200),
    externalApprovalFile: process.env.VINMAN_EXTERNAL_APPROVAL_FILE || "",
    executablePath: process.env.PLAYWRIGHT_CHROME_PATH || undefined,
    viewport: DEFAULT_VIEWPORT,
  };
}

function outputForScenario(root, scenario, runStamp, multiple) {
  return multiple ? path.join(root, `${scenario.id}-${runStamp}`) : root;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const selected = args.scenario === "all" ? VINMAN_SCENARIOS : [getVinmanScenario(args.scenario)];
  const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const results = [];
  for (const scenario of selected) {
    results.push(await recordScenario(scenario, environmentOptions({
      ...args,
      outputDir: outputForScenario(args.out, scenario, runStamp, selected.length > 1),
    })));
  }
  return results;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && import.meta.url.endsWith(invokedPath)) {
  main().then((results) => process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
