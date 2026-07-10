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
const SENSITIVE_MANAGER_COLUMN = /^(?:raw\s+)?(?:prompt|message|input|content|query|request)(?:\s+text)?$/i;

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
