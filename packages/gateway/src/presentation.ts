import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Channel-neutral interaction data. Adapters render this without changing command semantics. */

export type PresentationTone = "neutral" | "positive" | "warning" | "critical";
export type PresentationAudience = "general" | "self" | "manager" | "admin";
export type SurfaceActionStyle = "default" | "primary" | "danger";

export interface PresentationKpi {
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
  readonly tone?: PresentationTone;
}

export interface PresentationTrendPoint {
  readonly label: string;
  readonly value: number;
}

export interface PresentationTrend {
  readonly id: string;
  readonly label: string;
  readonly unit?: string;
  readonly points: readonly PresentationTrendPoint[];
}

export interface PresentationPagination {
  readonly page: number;
  readonly pageSize: number;
  readonly totalRows: number;
}

export interface PresentationTable {
  readonly id: string;
  readonly title?: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly pagination?: PresentationPagination;
}

export interface PresentationFilterOption {
  readonly label: string;
  readonly value: string;
}

export interface PresentationFilter {
  readonly id: string;
  readonly label: string;
  readonly selected?: string;
  readonly options?: readonly PresentationFilterOption[];
  readonly action?: SurfaceAction;
}

export interface SurfaceAction {
  readonly id: string;
  readonly label: string;
  /** Direct command re-entered through the same governed dispatcher. */
  readonly command: string;
  readonly detail?: string;
  readonly style?: SurfaceActionStyle;
  readonly kind?: "command" | "drilldown" | "filter" | "page" | "confirm";
}

export interface SurfaceWorkStatus {
  readonly id: string;
  readonly state: "accepted" | "running" | "waiting" | "completed" | "failed";
  readonly label: string;
  readonly detail?: string;
  readonly updatedAt?: string;
}

export interface SurfacePresentation {
  readonly kind: "menu" | "report" | "status" | "form";
  readonly title: string;
  readonly summary: string;
  readonly audience?: PresentationAudience;
  readonly kpis?: readonly PresentationKpi[];
  readonly trends?: readonly PresentationTrend[];
  readonly tables?: readonly PresentationTable[];
  readonly filters?: readonly PresentationFilter[];
  readonly drilldowns?: readonly SurfaceAction[];
  readonly actions?: readonly SurfaceAction[];
  readonly work?: SurfaceWorkStatus;
  readonly notice?: string;
  readonly privacy?: {
    /** Manager/admin reports must opt in explicitly before raw prompts can be rendered. */
    readonly rawPromptsIncluded: boolean;
    readonly note?: string;
  };
}

export interface AsyncAcknowledgementInput {
  readonly id: string;
  readonly title?: string;
  readonly label: string;
  readonly detail?: string;
  readonly actions?: readonly SurfaceAction[];
}

/** Immediate, channel-renderable acknowledgement for work completed out of band. */
export function createAsyncAcknowledgement(input: AsyncAcknowledgementInput): { readonly text: string; readonly presentation: SurfacePresentation } {
  const presentation: SurfacePresentation = {
    kind: "status",
    title: input.title ?? "Work accepted",
    summary: input.detail ?? "The request was accepted and can continue asynchronously.",
    work: { id: input.id, state: "accepted", label: input.label, detail: input.detail },
    ...(input.actions?.length ? { actions: input.actions } : {}),
  };
  return { text: renderPresentationText(presentation), presentation };
}

const ACTION_PREFIX = "muster:cmd:";
const APPROVAL_ACTION_PREFIX = "ma1";
const APPROVAL_ACTION_ID_BYTES = 12;
const APPROVAL_ACTION_SIGNATURE_BYTES = 12;
const SENSITIVE_MANAGER_COLUMN = /^(?:raw\s+)?(?:prompt|message|input|content|query|request)(?:\s+text)?$/i;
const VERIFIED_APPROVAL_RAW = new WeakSet<object>();
const PENDING_APPROVAL_RAW = new WeakSet<object>();

export type ApprovalDecision = "approve" | "reject";
export type ApprovalActionFailureReason =
  | "invalid"
  | "not_found"
  | "tampered"
  | "expired"
  | "wrong_actor"
  | "wrong_surface"
  | "wrong_conversation"
  | "replay"
  | "conflict";

export interface ApprovalActionBinding {
  readonly id: string;
  readonly actorId: string;
  readonly surfaceId: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly gateId: string;
  readonly revision: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface ApprovalActionIssueInput {
  readonly actorId: string;
  readonly surfaceId: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly gateId: string;
  readonly revision: string;
  readonly expiresAt: number;
}

export interface ApprovalActionAttempt {
  readonly actorId: string;
  readonly surfaceId: string;
  readonly conversationId: string;
}

export type ApprovalActionResult =
  | { readonly ok: true; readonly decision: ApprovalDecision; readonly binding: ApprovalActionBinding }
  | { readonly ok: false; readonly reason: ApprovalActionFailureReason };

export interface ApprovalActionTokens {
  readonly approve: string;
  readonly reject: string;
}

export type ApprovalActionConsumeResult = "consumed" | "missing" | "replay" | "conflict";

/**
 * The store owns the atomic one-shot transition. A durable implementation can
 * back this interface with SQLite/Postgres without changing channel adapters.
 */
export interface ApprovalActionStore {
  create(binding: ApprovalActionBinding): boolean;
  read(id: string): ApprovalActionBinding | undefined;
  consume(id: string, expectedFingerprint: string, decision: ApprovalDecision, consumedAt: number): ApprovalActionConsumeResult;
}

export interface ApprovalActionIssuer {
  issue(input: ApprovalActionIssueInput, maxBytes?: number): ApprovalActionTokens | undefined;
}

export interface ApprovalActionParser {
  parse(value: unknown, attempt: ApprovalActionAttempt): ApprovalActionResult;
}

export interface ApprovalActionCodec extends ApprovalActionIssuer, ApprovalActionParser {}

export interface ApprovalActionRenderContext extends ApprovalActionIssueInput {
  readonly codec: ApprovalActionIssuer;
}

export interface ApprovalActionCodecOptions {
  readonly secret: string | Uint8Array;
  readonly store?: ApprovalActionStore;
  readonly now?: () => number;
  readonly idFactory?: () => string;
  /** Optional live gate check for revision/revocation beyond the signed binding. */
  readonly validate?: (binding: ApprovalActionBinding, attempt: ApprovalActionAttempt) => ApprovalActionFailureReason | undefined;
}

interface MutableApprovalRecord {
  readonly binding: ApprovalActionBinding;
  readonly fingerprint: string;
  consumedAt?: number;
  decision?: ApprovalDecision;
}

/** Process-local test/development store. Production can inject a durable store. */
export class InMemoryApprovalActionStore implements ApprovalActionStore {
  readonly #records = new Map<string, MutableApprovalRecord>();

  create(binding: ApprovalActionBinding): boolean {
    if (this.#records.has(binding.id)) return false;
    this.#records.set(binding.id, { binding, fingerprint: approvalBindingFingerprint(binding) });
    return true;
  }

  read(id: string): ApprovalActionBinding | undefined {
    return this.#records.get(id)?.binding;
  }

  consume(id: string, expectedFingerprint: string, decision: ApprovalDecision, consumedAt: number): ApprovalActionConsumeResult {
    const record = this.#records.get(id);
    if (!record) return "missing";
    if (record.fingerprint !== expectedFingerprint) return "conflict";
    if (record.consumedAt !== undefined) return "replay";
    record.consumedAt = consumedAt;
    record.decision = decision;
    return "consumed";
  }
}

/**
 * Compact opaque approval codec. The callback contains only a random id,
 * decision bit, and truncated HMAC; all identity and gate claims remain in the
 * injected store. Tokens are 39 bytes with the default sizes (Telegram: 64).
 */
export function createApprovalActionCodec(options: ApprovalActionCodecOptions): ApprovalActionCodec {
  const secret = Buffer.from(options.secret);
  if (secret.byteLength < 32) throw new Error("Approval action signing secret must contain at least 32 bytes.");
  const store = options.store ?? new InMemoryApprovalActionStore();
  const now = options.now ?? Date.now;
  const idFactory = options.idFactory ?? (() => randomBytes(APPROVAL_ACTION_ID_BYTES).toString("base64url"));

  return {
    issue(input, maxBytes = Number.POSITIVE_INFINITY) {
      validateApprovalIssueInput(input, now());
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const binding: ApprovalActionBinding = { ...input, id: idFactory(), issuedAt: now() };
        if (!/^[A-Za-z0-9_-]{8,32}$/.test(binding.id)) throw new Error("Approval action ids must be 8-32 base64url characters.");
        const approve = approvalToken(binding, "approve", secret);
        const reject = approvalToken(binding, "reject", secret);
        if (Buffer.byteLength(approve, "utf8") > maxBytes || Buffer.byteLength(reject, "utf8") > maxBytes) return undefined;
        if (store.create(binding)) return { approve, reject };
      }
      throw new Error("Could not allocate a unique approval action id.");
    },

    parse(value, attempt) {
      const token = parseApprovalToken(value);
      if (!token) return { ok: false, reason: "invalid" };
      const binding = store.read(token.id);
      if (!binding) return { ok: false, reason: "not_found" };
      const expected = approvalToken(binding, token.decision, secret);
      if (!constantTimeTextEqual(expected, token.value)) return { ok: false, reason: "tampered" };
      const currentTime = now();
      if (binding.expiresAt <= currentTime) return { ok: false, reason: "expired" };
      if (binding.actorId !== attempt.actorId) return { ok: false, reason: "wrong_actor" };
      if (binding.surfaceId !== attempt.surfaceId) return { ok: false, reason: "wrong_surface" };
      if (binding.conversationId !== attempt.conversationId) return { ok: false, reason: "wrong_conversation" };
      const invalid = options.validate?.(binding, attempt);
      if (invalid) return { ok: false, reason: invalid };
      const consumed = store.consume(binding.id, approvalBindingFingerprint(binding), token.decision, currentTime);
      if (consumed !== "consumed") {
        return { ok: false, reason: consumed === "missing" ? "not_found" : consumed };
      }
      return { ok: true, decision: token.decision, binding };
    },
  };
}

/** Internal dispatcher marker; the verified claims live in raw metadata. */
export const VERIFIED_APPROVAL_COMMAND = "/approvals decide";

export interface VerifiedApprovalActionRaw {
  readonly platformPayload: unknown;
  readonly verifiedApprovalAction: {
    readonly decision: ApprovalDecision;
    readonly binding: ApprovalActionBinding;
  };
}

export interface PendingApprovalActionRaw {
  readonly platformPayload: unknown;
  readonly pendingApprovalAction: {
    readonly value: unknown;
    readonly attempt: ApprovalActionAttempt;
  };
}

export function verifiedApprovalRaw(platformPayload: unknown, result: Extract<ApprovalActionResult, { ok: true }>): VerifiedApprovalActionRaw {
  const raw: VerifiedApprovalActionRaw = { platformPayload, verifiedApprovalAction: { decision: result.decision, binding: result.binding } };
  VERIFIED_APPROVAL_RAW.add(raw);
  return raw;
}

export function verifiedApprovalFromRaw(raw: unknown): VerifiedApprovalActionRaw["verifiedApprovalAction"] | undefined {
  if (typeof raw !== "object" || raw === null || !VERIFIED_APPROVAL_RAW.has(raw)) return undefined;
  const value = (raw as Partial<VerifiedApprovalActionRaw>).verifiedApprovalAction;
  if (!value || (value.decision !== "approve" && value.decision !== "reject")) return undefined;
  return value;
}

export function pendingApprovalRaw(
  platformPayload: unknown,
  value: unknown,
  attempt: ApprovalActionAttempt,
): PendingApprovalActionRaw {
  const raw: PendingApprovalActionRaw = { platformPayload, pendingApprovalAction: { value, attempt } };
  PENDING_APPROVAL_RAW.add(raw);
  return raw;
}

export function pendingApprovalFromRaw(raw: unknown): PendingApprovalActionRaw["pendingApprovalAction"] | undefined {
  if (typeof raw !== "object" || raw === null || !PENDING_APPROVAL_RAW.has(raw)) return undefined;
  return (raw as Partial<PendingApprovalActionRaw>).pendingApprovalAction;
}

export function pendingApprovalSurfaceFields(
  parser: ApprovalActionParser | undefined,
  value: unknown,
  attempt: ApprovalActionAttempt,
  platformPayload: unknown,
): { readonly text: string; readonly raw: PendingApprovalActionRaw } | undefined {
  return parser && parseApprovalToken(value)
    ? { text: VERIFIED_APPROVAL_COMMAND, raw: pendingApprovalRaw(platformPayload, value, attempt) }
    : undefined;
}

export function parseVerifiedApprovalSurfaceFields(
  parser: ApprovalActionParser | undefined,
  value: unknown,
  attempt: ApprovalActionAttempt,
  platformPayload: unknown,
): { readonly text: string; readonly raw: VerifiedApprovalActionRaw } | undefined {
  if (!parser) return undefined;
  const result = parser.parse(value, attempt);
  return result.ok ? { text: VERIFIED_APPROVAL_COMMAND, raw: verifiedApprovalRaw(platformPayload, result) } : undefined;
}

export function approvalFallbackText(hasActions: boolean): string {
  return hasActions
    ? "Approve or reject with the authenticated controls below."
    : "Authenticated approval controls are unavailable in this response. Ask an operator to reopen the approval.";
}

export function issueApprovalActions(
  request: { readonly runId: string; readonly gateId: string },
  context: ApprovalActionRenderContext | undefined,
  maxBytes: number,
): ApprovalActionTokens | undefined {
  if (!context) return undefined;
  if (context.runId !== request.runId || context.gateId !== request.gateId) return undefined;
  try {
    return context.codec.issue(context, maxBytes);
  } catch {
    return undefined;
  }
}

function validateApprovalIssueInput(input: ApprovalActionIssueInput, currentTime: number): void {
  for (const [name, value] of Object.entries({
    actorId: input.actorId,
    surfaceId: input.surfaceId,
    conversationId: input.conversationId,
    runId: input.runId,
    gateId: input.gateId,
    revision: input.revision,
  })) {
    if (typeof value !== "string" || !value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error(`Approval action ${name} must be a non-empty safe string up to 512 characters.`);
    }
  }
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= currentTime) {
    throw new Error("Approval action expiry must be a future integer timestamp in milliseconds.");
  }
}

function approvalToken(binding: ApprovalActionBinding, decision: ApprovalDecision, secret: Buffer): string {
  const bit = decision === "approve" ? "a" : "r";
  const unsigned = `${APPROVAL_ACTION_PREFIX}.${binding.id}.${bit}`;
  const signature = createHmac("sha256", secret)
    .update(approvalBindingCanonical(binding))
    .update("\n")
    .update(bit)
    .digest()
    .subarray(0, APPROVAL_ACTION_SIGNATURE_BYTES)
    .toString("base64url");
  return `${unsigned}.${signature}`;
}

function parseApprovalToken(value: unknown): { readonly value: string; readonly id: string; readonly decision: ApprovalDecision } | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^ma1\.([A-Za-z0-9_-]{8,32})\.([ar])\.([A-Za-z0-9_-]{16})$/.exec(value);
  if (!match) return undefined;
  return { value, id: match[1], decision: match[2] === "a" ? "approve" : "reject" };
}

function approvalBindingCanonical(binding: ApprovalActionBinding): string {
  return JSON.stringify([
    APPROVAL_ACTION_PREFIX,
    binding.id,
    binding.actorId,
    binding.surfaceId,
    binding.conversationId,
    binding.runId,
    binding.gateId,
    binding.revision,
    binding.issuedAt,
    binding.expiresAt,
  ]);
}

function approvalBindingFingerprint(binding: ApprovalActionBinding): string {
  return createHmac("sha256", "muster-approval-store-fingerprint-v1").update(approvalBindingCanonical(binding)).digest("base64url");
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

/**
 * Bind an action to a compact, stateless callback. Telegram limits callback_data
 * to 64 bytes; callers can pass that limit and fall back to numbered text.
 */
export function bindSurfaceAction(action: Pick<SurfaceAction, "command">, maxBytes = Number.POSITIVE_INFINITY): string | undefined {
  const command = action.command.trim();
  if (!isSafeCommand(command)) return undefined;
  const binding = `${ACTION_PREFIX}${command}`;
  return Buffer.byteLength(binding, "utf8") <= maxBytes ? binding : undefined;
}

/** Convert a channel callback into the exact slash command it represents. */
export function parseSurfaceAction(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith(ACTION_PREFIX)) return undefined;
  const command = value.slice(ACTION_PREFIX.length).trim();
  return isSafeCommand(command) ? command : undefined;
}

export function presentationActions(presentation: SurfacePresentation): readonly SurfaceAction[] {
  return [
    ...(presentation.filters ?? []).flatMap((filter) => filter.action ? [filter.action] : []),
    ...(presentation.drilldowns ?? []),
    ...(presentation.actions ?? []),
  ];
}

function isSafeCommand(command: string): boolean {
  return command.startsWith("/") && command.length <= 512 && !/[\u0000-\u001f\u007f]/.test(command);
}

export function commandPage(args: string): number {
  const match = /(?:^|\s)page(?:=|\s+)(\d+)(?:\s|$)/i.exec(args);
  if (!match) return 1;
  const page = Number(match[1]);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

export function paginateRows(
  rows: readonly (readonly string[])[],
  page: number,
  pageSize: number,
): { rows: readonly (readonly string[])[]; pagination: PresentationPagination } {
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const pageCount = Math.max(1, Math.ceil(rows.length / safePageSize));
  const safePage = Math.min(Math.max(1, Math.floor(page)), pageCount);
  const start = (safePage - 1) * safePageSize;
  return {
    rows: rows.slice(start, start + safePageSize),
    pagination: { page: safePage, pageSize: safePageSize, totalRows: rows.length },
  };
}

/**
 * Strip prompt-like columns for manager/admin views unless a separately audited
 * report has explicitly opted in. This is a last-mile guard, not an RBAC system.
 */
export function sanitizePresentationForAudience(presentation: SurfacePresentation): SurfacePresentation {
  if (
    presentation.audience !== "manager" && presentation.audience !== "admin" ||
    presentation.privacy?.rawPromptsIncluded === true
  ) return presentation;

  const tables = presentation.tables?.map((table) => {
    const keep = table.columns.map((column, index) => ({ column, index })).filter(({ column }) => !SENSITIVE_MANAGER_COLUMN.test(column));
    return {
      ...table,
      columns: keep.map(({ column }) => column),
      rows: table.rows.map((row) => keep.map(({ index }) => row[index] ?? "")),
    };
  });
  return {
    ...presentation,
    ...(tables ? { tables } : {}),
    privacy: {
      rawPromptsIncluded: false,
      note: presentation.privacy?.note ?? "Prompt text is hidden in manager reports by default.",
    },
  };
}

export interface PresentationTextOptions {
  readonly maxRowsPerTable?: number;
  readonly maxCellWidth?: number;
  readonly includeActions?: boolean;
}

/** Accessible fallback shared by every channel and plain-text clients. */
export function renderPresentationText(input: SurfacePresentation, options: PresentationTextOptions = {}): string {
  const presentation = sanitizePresentationForAudience(input);
  const maxRows = Math.max(1, options.maxRowsPerTable ?? 10);
  const maxWidth = Math.max(8, options.maxCellWidth ?? 34);
  const lines: string[] = [presentation.title, "", presentation.summary];

  if (presentation.work) {
    lines.push("", `${presentation.work.label} [${presentation.work.state}]${presentation.work.detail ? ` — ${presentation.work.detail}` : ""}`);
  }
  if (presentation.kpis?.length) {
    lines.push("", ...presentation.kpis.map((kpi) => `${kpi.label}: ${kpi.value}${kpi.detail ? ` (${kpi.detail})` : ""}`));
  }
  for (const trend of presentation.trends ?? []) {
    const points = trend.points.map((point) => `${point.label} ${point.value}${trend.unit ?? ""}`).join(" · ");
    lines.push("", `${trend.label}: ${points}`);
  }
  for (const table of presentation.tables ?? []) {
    if (table.title) lines.push("", table.title);
    lines.push(renderTable(table.columns, table.rows.slice(0, maxRows), maxWidth));
    if (table.pagination) {
      const pages = Math.max(1, Math.ceil(table.pagination.totalRows / table.pagination.pageSize));
      lines.push(`Page ${table.pagination.page}/${pages} · ${table.pagination.totalRows} rows`);
    } else if (table.rows.length > maxRows) {
      lines.push(`Showing ${maxRows} of ${table.rows.length} rows`);
    }
  }
  if (presentation.filters?.length) {
    lines.push("", `Filters: ${presentation.filters.map((filter) => `${filter.label}${filter.selected ? `=${filter.selected}` : ""}`).join(" · ")}`);
  }
  const actions = presentationActions(presentation);
  if (options.includeActions !== false && actions.length) {
    lines.push("", "Actions:", ...actions.map((action, index) => `${index + 1}. ${action.label}${action.detail ? ` — ${action.detail}` : ""} (${action.command})`));
  }
  if (presentation.privacy?.note) lines.push("", presentation.privacy.note);
  if (presentation.notice) lines.push("", presentation.notice);
  return lines.join("\n");
}

function renderTable(columns: readonly string[], rows: readonly (readonly string[])[], maxWidth: number): string {
  const widths = columns.map((column, index) => Math.min(maxWidth, Math.max(
    displayLength(column),
    ...rows.map((row) => displayLength(row[index] ?? "")),
  )));
  const border = (left: string, mid: string, right: string) => `${left}${widths.map((width) => "─".repeat(width + 2)).join(mid)}${right}`;
  const row = (cells: readonly string[]) => `│${widths.map((width, index) => ` ${truncate(cells[index] ?? "", width).padEnd(width)} `).join("│")}│`;
  return [
    border("┌", "┬", "┐"),
    row(columns),
    border("├", "┼", "┤"),
    ...rows.map(row),
    border("└", "┴", "┘"),
  ].join("\n");
}

function truncate(value: string, width: number): string {
  return displayLength(value) <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`;
}

function displayLength(value: string): number {
  return value.length;
}
