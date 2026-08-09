import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type BrowserType, type Locator, type Page } from "playwright";
import {
  FRAPPE_BROWSER_BOOTSTRAP_CONSUME_PATH,
  FRAPPE_BROWSER_SCHEMA_VERIFY_PATH,
  FRAPPE_BROWSER_RECORD_VERIFY_PATH,
  FRAPPE_ATTENDED_FORM_ROUTE,
  FrappeBrowserWorkSessionError,
  type FrappeBrowserAction,
  type FrappeBrowserActionResult,
  type FrappeBrowserAutomationPort,
  type FrappeBrowserSession,
  type FrappeBrowserTarget,
  type FrappeAttendedCrudBinding,
} from "./frappe-browser-work-session.js";

export interface FrappeBrowserUploadArtifact {
  readonly name: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

/** Resolves only gateway-governed artifact ids. Plans never provide paths. */
export interface FrappeBrowserUploadResolver {
  resolve(artifactId: string, signal: AbortSignal): Promise<FrappeBrowserUploadArtifact>;
}

export interface FrappeBrowserScreenshotEvidenceStore {
  persist(input: { readonly bytes: Uint8Array; readonly contextId: string; readonly actionId: string }): Promise<{
    readonly id: string;
    readonly sha256: string;
  }>;
}

export interface PlaywrightFrappeBrowserOptions {
  readonly evidence: FrappeBrowserScreenshotEvidenceStore;
  readonly uploads?: FrappeBrowserUploadResolver;
  readonly headless?: boolean;
  readonly executablePath?: string;
  readonly launchTimeoutMs?: number;
  readonly actionTimeoutMs?: number;
  /** Test-only browser type seam; production uses Playwright Chromium. */
  readonly browserType?: BrowserType;
}

/** Durable local evidence sink. The directory is gateway-selected, never plan-selected. */
export class DirectoryFrappeBrowserScreenshotEvidenceStore implements FrappeBrowserScreenshotEvidenceStore {
  constructor(private readonly directory: string) {}

  async persist(input: { readonly bytes: Uint8Array; readonly contextId: string; readonly actionId: string }) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700).catch(() => undefined);
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const id = `browser-${createHash("sha256").update(input.contextId).update("\0").update(input.actionId).update("\0").update(sha256).digest("hex").slice(0, 40)}`;
    await writeFile(join(this.directory, `${id}.png`), input.bytes, { flag: "wx", mode: 0o600 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    return Object.freeze({ id, sha256: `sha256:${sha256}` });
  }
}

/**
 * Real isolated Playwright transport for the closed Frappe browser DSL.
 * It never evaluates JS, accepts selectors/URLs from a plan, imports a human
 * profile, or lets the browser leave the exact verified HTTPS origin.
 */
export function createPlaywrightFrappeBrowserAutomationPort(options: PlaywrightFrappeBrowserOptions): FrappeBrowserAutomationPort {
  const browserType = options.browserType ?? chromium;
  const launchTimeout = bounded(options.launchTimeoutMs ?? 30_000, 1_000, 120_000, "launch timeout");
  const actionTimeout = bounded(options.actionTimeoutMs ?? 15_000, 1_000, 60_000, "action timeout");
  let browserPromise: Promise<Browser> | undefined;
  const active = new Set<BrowserContext>();

  const getBrowser = (): Promise<Browser> => {
    browserPromise ??= browserType.launch({
      headless: options.headless ?? true,
      ...(options.executablePath ? { executablePath: options.executablePath } : {}),
      timeout: launchTimeout,
      args: ["--disable-extensions", "--disable-sync", "--no-first-run"],
    });
    return browserPromise;
  };

  return {
    async open(input) {
      const origin = exactOrigin(input.bootstrap.siteOrigin);
      if (input.signal.aborted) throw new FrappeBrowserWorkSessionError("Browser work was cancelled before opening an isolated context.");
      const browser = await getBrowser();
      const context = await browser.newContext({
        acceptDownloads: false,
        ignoreHTTPSErrors: false,
        serviceWorkers: "block",
        viewport: { width: 1440, height: 900 },
      });
      active.add(context);
      let page: Page | undefined;
      const abort = () => { void context.close().catch(() => undefined); };
      input.signal.addEventListener("abort", abort, { once: true });
      try {
        await context.route("**/*", async (route) => {
          const request = route.request();
          if (frappeBrowserRequestIsAllowed(request.url(), origin, request.resourceType(), request.isNavigationRequest())) await route.continue();
          else await route.abort("blockedbyclient");
        });
        // Playwright HTTP routing does not govern WebSocket handshakes. Route
        // them independently so compromised page code cannot use an external
        // socket as a side channel around the exact-origin network boundary.
        await context.routeWebSocket(/.*/, async (socket) => {
          if (frappeBrowserNetworkUrlIsAllowed(socket.url(), origin)) socket.connectToServer();
          else await socket.close({ code: 1008, reason: "Blocked by Muster exact-origin policy" });
        });
        const consumed = await context.request.post(new URL(FRAPPE_BROWSER_BOOTSTRAP_CONSUME_PATH, origin).href, {
          data: {
            ticket: input.bootstrap.ticket,
            browser_challenge: input.bootstrap.browserChallenge,
            bootstrap_id: input.bootstrap.bootstrapId,
          },
          failOnStatusCode: false,
          maxRedirects: 0,
          timeout: actionTimeout,
        });
        if (!consumed.ok()) throw new FrappeBrowserWorkSessionError("Frappe refused the one-use browser bootstrap.");
        const receipt = responseMessage(await consumed.json().catch(() => undefined));
        const sessionFingerprint = requiredId(receipt.session_fingerprint, "session fingerprint");
        if (receipt.authenticated !== true || receipt.bootstrap_id !== input.bootstrap.bootstrapId || !sameActor(receipt.actor_id, input.bootstrap.actorId) || receipt.route !== "/desk") {
          throw new FrappeBrowserWorkSessionError("Frappe returned a mismatched browser bootstrap receipt.");
        }
        if (input.bootstrap.attendedCrud) assertAttendedSchemaReceipt(receipt.form_schema, input.bootstrap.attendedCrud);
        // The API request context shares this brand-new context's cookie jar.
        // Prove a SID was actually installed without ever reading its value.
        const cookies = await context.cookies(origin);
        if (!cookies.some((cookie) => cookie.name === "sid")) {
          throw new FrappeBrowserWorkSessionError("Frappe did not install an isolated browser session.");
        }
        page = await context.newPage();
        page.setDefaultTimeout(actionTimeout);
        page.setDefaultNavigationTimeout(actionTimeout);
        page.on("dialog", (dialog) => { void dialog.dismiss(); });
        page.on("download", (download) => { void download.cancel(); });
        context.on("page", (candidate) => { if (candidate !== page) void candidate.close(); });
        await page.goto(new URL("/desk", origin).href, { waitUntil: "domcontentloaded" });
        assertObservedRoute(page.url(), origin, "/desk");

        let closed = false;
        const attendedValues = new Map<string, string>();
        const routeBindings = new Map<string, string>();
        const session: FrappeBrowserSession = {
          contextId: input.contextId,
          siteOrigin: origin,
          actorId: input.bootstrap.actorId,
          bootstrapId: input.bootstrap.bootstrapId,
          sessionFingerprint,
          bootstrapConsumed: true,
          async perform(action, call) {
            if (closed || input.signal.aborted || call.signal.aborted) throw new FrappeBrowserWorkSessionError("The isolated browser session is no longer active.");
            const currentPage = page!;
            if (input.bootstrap.attendedCrud && (action.kind === "fill" || action.kind === "select" || action.kind === "upload" || action.kind === "click")) {
              const verified = await context.request.post(new URL(FRAPPE_BROWSER_SCHEMA_VERIFY_PATH, origin).href, {
                data: { binding: input.bootstrap.attendedCrud }, failOnStatusCode: false, maxRedirects: 0, timeout: actionTimeout,
              });
              if (!verified.ok()) throw new FrappeBrowserWorkSessionError("The attended form schema or field authority changed before the next visible action.");
              const live = responseMessage(await verified.json().catch(() => undefined));
              assertAttendedSchemaReceipt(live, input.bootstrap.attendedCrud);
            }
            const target = "target" in action && action.target ? await uniqueSemanticLocator(currentPage, action.target) : undefined;
            const expectedRoute = resolveActionRoute(action.route, routeBindings);
            if (action.kind !== "navigate") assertObservedRoute(currentPage.url(), origin, expectedRoute);
            if (target && (action.kind === "fill" || action.kind === "select" || action.kind === "upload")) await assertNonSecretControl(target, action.target.name);
            if (action.kind === "click") await assertClickPostconditionNotAlreadySatisfied(currentPage, action);
            const pointer = target ? await locatorPointer(target, currentPage) : await viewportCenter(currentPage);
            await call.onActionReady({ actionId: call.actionId, kind: action.kind, route: expectedRoute, pointer });
            const viewport = currentPage.viewportSize();
            if (!viewport) throw new FrappeBrowserWorkSessionError("The isolated browser has no bounded viewport.");
            await currentPage.mouse.move((pointer.x / 100) * viewport.width, (pointer.y / 100) * viewport.height);
            const evidence = await performAction({ action, page: currentPage, target, origin, contextId: input.contextId, actionId: call.actionId, evidence: options.evidence, uploads: options.uploads, signal: call.signal });
            const observedRoute = await verifyActionPostcondition(currentPage, action, origin, routeBindings);
            if (action.kind === "fill") attendedValues.set(action.field, action.value);
            if (action.kind === "select") attendedValues.set(action.field, action.option);
            let serverRecordProof: FrappeBrowserActionResult["serverRecordProof"];
            if (input.bootstrap.attendedCrud && action.kind === "click" && action.target.name.toLowerCase() === "save") {
              const binding = input.bootstrap.attendedCrud;
              if (attendedValues.size !== binding.fields.length || binding.fields.some((field) => !attendedValues.has(field))) {
                throw new FrappeBrowserWorkSessionError("The visible Save could not be bound to every reviewed attended CRUD field.");
              }
              const recordName = binding.record_name ?? recordNameFromRoute(observedRoute);
              const proofResponse = await context.request.post(new URL(FRAPPE_BROWSER_RECORD_VERIFY_PATH, origin).href, {
                data: { binding, record_name: recordName, expected: Object.fromEntries(attendedValues) }, failOnStatusCode: false, maxRedirects: 0, timeout: actionTimeout,
              });
              if (!proofResponse.ok()) throw new FrappeBrowserWorkSessionError("Frappe could not reread and verify the visibly saved record.");
              const proof = responseMessage(await proofResponse.json().catch(() => undefined));
              if (proof.doctype !== binding.doctype || proof.record_name !== recordName || typeof proof.proof_hash !== "string" || !/^[a-f0-9]{64}$/.test(proof.proof_hash)) {
                throw new FrappeBrowserWorkSessionError("Frappe returned an invalid saved-record proof.");
              }
              serverRecordProof = { doctype: binding.doctype, recordName, proofHash: proof.proof_hash };
            }
            return Object.freeze({
              actionId: call.actionId,
              kind: action.kind,
              route: observedRoute,
              pointer,
              performed: true,
              postconditionVerified: true,
              rbac: "allowed",
              bootstrapId: input.bootstrap.bootstrapId,
              sessionFingerprint,
              ...(action.kind === "fill" || action.kind === "select" || action.kind === "upload" ? { fieldsAffected: [action.field] } : {}),
              ...(evidence ?? {}),
              ...(serverRecordProof ? { serverRecordProof } : {}),
            }) as FrappeBrowserActionResult;
          },
          async close() {
            if (closed) return { serverSessionRevoked: true };
            closed = true;
            let revoked = false;
            try {
              const response = await context.request.get(new URL("/api/method/logout", origin).href, { failOnStatusCode: false, maxRedirects: 0, timeout: actionTimeout });
              const remainingSid = (await context.cookies(origin)).find((cookie) => cookie.name === "sid");
              const identity = await context.request.get(new URL("/api/method/frappe.auth.get_logged_user", origin).href, { failOnStatusCode: false, maxRedirects: 0, timeout: actionTimeout });
              const identityBody = await identity.json().catch(() => undefined);
              revoked = response.ok() && identity.ok() && record(identityBody) && identityBody.message === "Guest" && (!remainingSid || remainingSid.value === "Guest");
            } finally {
              input.signal.removeEventListener("abort", abort);
              active.delete(context);
              await context.close().catch(() => undefined);
            }
            return { serverSessionRevoked: revoked as true };
          },
        };
        return session;
      } catch (error) {
        input.signal.removeEventListener("abort", abort);
        active.delete(context);
        await context.close().catch(() => undefined);
        if (error instanceof FrappeBrowserWorkSessionError) throw error;
        throw new FrappeBrowserWorkSessionError("The isolated Playwright browser failed closed.");
      }
    },
    async close() {
      await Promise.all([...active].map((context) => context.close().catch(() => undefined)));
      active.clear();
      const browser = await browserPromise?.catch(() => undefined);
      browserPromise = undefined;
      await browser?.close().catch(() => undefined);
    },
  };
}

async function performAction(input: {
  readonly action: FrappeBrowserAction;
  readonly page: Page;
  readonly target?: Locator;
  readonly origin: string;
  readonly contextId: string;
  readonly actionId: string;
  readonly evidence: FrappeBrowserScreenshotEvidenceStore;
  readonly uploads?: FrappeBrowserUploadResolver;
  readonly signal: AbortSignal;
}): Promise<Partial<FrappeBrowserActionResult>> {
  const { action, page, target } = input;
  switch (action.kind) {
    case "navigate":
      await page.goto(new URL(action.route, input.origin).href, { waitUntil: "domcontentloaded" });
      assertObservedRoute(page.url(), input.origin, action.route);
      return {};
    case "click":
      await target!.click();
      return {};
    case "fill":
      await target!.fill(action.value);
      if (await target!.inputValue() !== action.value) throw new FrappeBrowserWorkSessionError("The filled control did not retain the exact governed value.");
      return {};
    case "select": {
      const selected = await target!.selectOption({ label: action.option });
      if (selected.length !== 1 || await target!.inputValue() !== selected[0]) throw new FrappeBrowserWorkSessionError("The selected control did not retain the governed option.");
      return {};
    }
    case "upload": {
      if (!input.uploads) throw new FrappeBrowserWorkSessionError("Browser uploads are disabled because no governed artifact resolver is configured.");
      const artifact = await input.uploads.resolve(action.artifactId, input.signal);
      validateArtifact(artifact);
      await target!.setInputFiles({ name: artifact.name, mimeType: artifact.mimeType, buffer: Buffer.from(artifact.bytes) });
      if (!(await target!.inputValue()).replaceAll("\\", "/").endsWith(`/${artifact.name}`)) throw new FrappeBrowserWorkSessionError("The upload control did not retain the governed artifact.");
      return {};
    }
    case "read_visible": {
      const visibleText = await (target ?? page.locator("body")).innerText();
      return { visibleText: visibleText.slice(0, action.maxChars) };
    }
    case "screenshot": {
      const masks: Locator[] = [page.locator('input[type="password"]')];
      for (const field of action.redactFields) {
        const mask = page.getByLabel(field, { exact: true });
        if (await mask.count() !== 1) throw new FrappeBrowserWorkSessionError("A required screenshot redaction target was missing or ambiguous.");
        masks.push(mask);
      }
      const bytes = await page.screenshot({ type: "png", fullPage: false, mask: masks, animations: "disabled" });
      const stored = await input.evidence.persist({ bytes, contextId: input.contextId, actionId: input.actionId });
      return { evidence: { ...stored, maskingScope: "explicit_fields_and_password_controls", requestedMasksVerified: true } };
    }
  }
}

async function assertNonSecretControl(locator: Locator, semanticName: string): Promise<void> {
  const metadata: Record<string, string> = { semanticName };
  for (const attribute of ["type", "name", "id", "autocomplete", "aria-label", "placeholder"] as const) metadata[attribute] = (await locator.getAttribute(attribute)) ?? "";
  if (frappeBrowserControlMetadataIsSecret(metadata)) {
    throw new FrappeBrowserWorkSessionError("Credential and secret controls are not available to browser workflows.");
  }
}

/** Exported only to make the DOM-metadata fail-closed boundary independently hostile-testable. */
export function frappeBrowserControlMetadataIsSecret(metadata: Readonly<Record<string, string>>): boolean {
  const joined = Object.values(metadata).join("\0");
  const autocomplete = metadata.autocomplete?.toLowerCase() ?? "";
  return /password|passwd|secret|api.?key|token|authorization|cookie|private.?key/i.test(joined)
    || /(?:^|\s)(?:username|current-password|new-password|one-time-code|webauthn|cc-number|cc-csc)(?:\s|$)/.test(autocomplete);
}

async function assertClickPostconditionNotAlreadySatisfied(page: Page, action: Extract<FrappeBrowserAction, { readonly kind: "click" }>): Promise<void> {
  // Route transitions are statically required to differ from the current route.
  if (action.postcondition.kind === "route" || action.postcondition.kind === "record_saved" || action.postcondition.kind === "bind_route") return;
  const candidate = semanticLocator(page, action.postcondition.target);
  const count = await candidate.count();
  if (count > 1) throw new FrappeBrowserWorkSessionError("The click postcondition target was ambiguous before the action.");
  const visibleBefore = count === 1 && await candidate.isVisible();
  if (!frappeBrowserClickTransitionPreconditionIsValid(action.postcondition.state, count, visibleBefore) && action.postcondition.state === "visible") {
    throw new FrappeBrowserWorkSessionError("The click postcondition was already satisfied before the action.");
  }
  if (!frappeBrowserClickTransitionPreconditionIsValid(action.postcondition.state, count, visibleBefore)) {
    throw new FrappeBrowserWorkSessionError("A hidden click postcondition must identify one visible pre-action target.");
  }
}

/** A click must transition the asserted target state; observation alone is not proof of the click. */
export function frappeBrowserClickTransitionPreconditionIsValid(state: "visible" | "hidden", count: number, visibleBefore: boolean): boolean {
  if (!Number.isInteger(count) || count < 0 || count > 1) return false;
  return state === "visible" ? !visibleBefore : count === 1 && visibleBefore;
}

async function verifyActionPostcondition(page: Page, action: FrappeBrowserAction, origin: string, routeBindings: Map<string, string>): Promise<string> {
  if (action.kind === "navigate") {
    assertObservedRoute(page.url(), origin, action.route);
    return action.route;
  }
  if (action.kind === "click" || action.kind === "fill" || action.kind === "select" || action.kind === "upload") {
    if (action.postcondition.kind === "route") {
      await page.waitForURL(new URL(action.postcondition.route, origin).href, { waitUntil: "domcontentloaded" });
      assertObservedRoute(page.url(), origin, action.postcondition.route);
      return action.postcondition.route;
    }
    if (action.postcondition.kind === "record_saved") {
      const postcondition = action.postcondition;
      await page.waitForURL((candidate) => {
        return frappeAttendedRouteMatchesDoctype(candidate.href, origin, postcondition.doctype, postcondition.recordName, false);
      }, { waitUntil: "domcontentloaded" });
      return new URL(page.url()).pathname;
    }
    if (action.postcondition.kind === "bind_route") {
      const postcondition = action.postcondition;
      await page.waitForURL((candidate) => {
        return frappeAttendedRouteMatchesDoctype(candidate.href, origin, postcondition.doctype, null, true);
      }, { waitUntil: "domcontentloaded" });
      const bound = new URL(page.url()).pathname;
      if (routeBindings.has(postcondition.token) && routeBindings.get(postcondition.token) !== bound) {
        throw new FrappeBrowserWorkSessionError("The attended form route token was rebound to another route.");
      }
      routeBindings.set(postcondition.token, bound);
      return bound;
    }
    const candidate = semanticLocator(page, action.postcondition.target);
    await candidate.waitFor({ state: action.postcondition.state });
    const count = await candidate.count();
    if ((action.postcondition.state === "visible" && count !== 1) || (action.postcondition.state === "hidden" && count > 1)) {
      throw new FrappeBrowserWorkSessionError("The browser action postcondition was missing or ambiguous.");
    }
  }
  const expected = resolveActionRoute(action.route, routeBindings);
  assertObservedRoute(page.url(), origin, expected);
  return expected;
}

/** Pure boundary used by the real Playwright redirect wait and hostile tests. */
export function frappeAttendedRouteMatchesDoctype(value: string, origin: string, doctype: string, recordName: string | null, allowNew: boolean): boolean {
  try {
    const candidate = new URL(value);
    const path = candidate.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
    const observedName = path.at(-1) ?? "";
    return candidate.origin === origin && !candidate.search && !candidate.hash && path.length === 3 && path[0] === "desk"
      && path[1]?.toLowerCase().replaceAll("-", " ") === doctype.toLowerCase().replaceAll("-", " ")
      && Boolean(observedName) && (allowNew || !observedName.startsWith("new-"))
      && (recordName === null || observedName === recordName);
  } catch {
    return false;
  }
}

function resolveActionRoute(route: string, bindings: ReadonlyMap<string, string>): string {
  if (route !== FRAPPE_ATTENDED_FORM_ROUTE) return route;
  const bound = bindings.get("attended_form");
  if (!bound) throw new FrappeBrowserWorkSessionError("The attended form route token is not bound to an observed Frappe route.");
  return bound;
}

async function uniqueSemanticLocator(page: Page, target: FrappeBrowserTarget): Promise<Locator> {
  const locator = semanticLocator(page, target);
  const count = await locator.count();
  if (count !== 1) throw new FrappeBrowserWorkSessionError("The semantic browser target was missing or ambiguous.");
  await locator.waitFor({ state: "visible" });
  return locator;
}

function semanticLocator(page: Page, target: FrappeBrowserTarget): Locator {
  return target.kind === "role"
    ? page.getByRole(target.role, { name: target.name, exact: true })
    : target.kind === "label"
      ? page.getByLabel(target.name, { exact: true })
      : page.getByTestId(target.name);
}

async function locatorPointer(locator: Locator, page: Page): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  if (!box || !viewport || viewport.width <= 0 || viewport.height <= 0) throw new FrappeBrowserWorkSessionError("The semantic browser target has no observable pointer position.");
  return Object.freeze({
    x: clampPercent(((box.x + box.width / 2) / viewport.width) * 100),
    y: clampPercent(((box.y + box.height / 2) / viewport.height) * 100),
  });
}

async function viewportCenter(page: Page): Promise<{ x: number; y: number }> {
  if (!page.viewportSize()) throw new FrappeBrowserWorkSessionError("The isolated browser has no bounded viewport.");
  return Object.freeze({ x: 50, y: 50 });
}

function assertObservedRoute(value: string, origin: string, route: string): void {
  let observed: URL;
  try { observed = new URL(value); } catch { throw new FrappeBrowserWorkSessionError("The browser left the verified Frappe origin."); }
  if (observed.origin !== origin || observed.pathname !== route || observed.search || observed.hash) throw new FrappeBrowserWorkSessionError("The browser left the fixed governed Frappe route.");
}

/** Exported for hostile boundary tests; production callers use browser routing. */
export function frappeBrowserNetworkUrlIsAllowed(value: string, origin: string): boolean {
  if (value.startsWith("data:") || value.startsWith("blob:")) return true;
  try {
    const candidate = new URL(value);
    const trusted = new URL(origin);
    if (candidate.username || candidate.password) return false;
    if (candidate.protocol === "https:") return candidate.origin === trusted.origin;
    // An HTTPS page's same-origin WebSocket transport uses wss on the exact
    // same host and effective port. Queries are required by Socket.IO.
    return candidate.protocol === "wss:" && candidate.host === trusted.host;
  } catch {
    return false;
  }
}

/** Allows data/blob only as subresources; a document must remain exact-origin HTTPS Desk. */
export function frappeBrowserRequestIsAllowed(value: string, origin: string, resourceType: string, isNavigationRequest: boolean): boolean {
  if (isNavigationRequest || resourceType === "document") {
    if (value.startsWith("data:") || value.startsWith("blob:")) return false;
    try {
      const document = new URL(value);
      if (document.origin !== new URL(origin).origin || document.search || document.hash || !(document.pathname === "/desk" || document.pathname.startsWith("/desk/"))) return false;
    } catch {
      return false;
    }
  }
  return frappeBrowserNetworkUrlIsAllowed(value, origin);
}

function responseMessage(value: unknown): Record<string, unknown> {
  if (!record(value) || !record(value.message)) throw new FrappeBrowserWorkSessionError("Frappe returned an invalid browser bootstrap receipt.");
  return value.message;
}

function assertAttendedSchemaReceipt(value: unknown, expected: FrappeAttendedCrudBinding): void {
  if (!record(value) || value.doctype !== expected.doctype || value.schema_hash !== expected.schema_hash || value.revision !== expected.revision
    || !Array.isArray(value.customized_fields) || !Array.isArray(value.client_scripts)) {
    throw new FrappeBrowserWorkSessionError("The attended form schema receipt is stale or invalid.");
  }
}

function recordNameFromRoute(route: string): string {
  const parts = route.split("/").filter(Boolean);
  if (parts.length < 3) throw new FrappeBrowserWorkSessionError("The visible Save did not reveal the created record route.");
  const value = decodeURIComponent(parts.at(-1)!);
  if (!value || value.startsWith("new-") || value.length > 140 || /[\u0000-\u001F]/.test(value)) throw new FrappeBrowserWorkSessionError("The visible Save did not reveal a valid record name.");
  return value;
}

function validateArtifact(value: FrappeBrowserUploadArtifact): void {
  if (!value || typeof value.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_. -]{0,127}$/.test(value.name) || value.name.includes("..") || typeof value.mimeType !== "string" || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(value.mimeType) || !(value.bytes instanceof Uint8Array) || value.bytes.byteLength === 0 || value.bytes.byteLength > 25_000_000) {
    throw new FrappeBrowserWorkSessionError("The governed upload artifact is invalid.");
  }
}

function exactOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new FrappeBrowserWorkSessionError("The browser site origin is invalid."); }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new FrappeBrowserWorkSessionError("The browser requires one exact HTTPS site origin.");
  return url.origin;
}

function sameActor(value: unknown, expected: string): boolean {
  return typeof value === "string" && value.toLowerCase() === expected.toLowerCase();
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(value)) throw new FrappeBrowserWorkSessionError(`The browser ${label} is invalid.`);
  return value;
}

function bounded(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new FrappeBrowserWorkSessionError(`The browser ${label} is outside its safe bound.`);
  return value;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 100) / 100));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
