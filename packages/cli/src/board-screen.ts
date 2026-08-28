import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { BoardView, BoardViewCard, BoardViewColumn } from "@musterhq/core";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const MUTED = "148;144;140";
const ACCENT = "217;119;87";
export const BOARD_COLUMNS: readonly BoardViewColumn[] = ["backlog", "ready", "running", "review", "done"];
const COLUMN_LABELS: Readonly<Record<BoardViewColumn, string>> = { backlog: "Backlog", ready: "Ready", running: "Running", review: "Review", done: "Done" };
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export interface BoardFocus { readonly column: number; readonly row: number }
export interface CardRect { readonly taskId: string; readonly column: number; readonly row: number; readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface BoardLayout { readonly lines: readonly string[]; readonly cardRects: readonly CardRect[]; readonly focus: BoardFocus }

function paint(text: string, rgb: string, enabled: boolean): string { return enabled ? `\x1b[38;2;${rgb}m${text}${RESET}` : text; }
function dim(text: string, enabled: boolean): string { return enabled ? `${DIM}\x1b[38;2;${MUTED}m${text}${RESET}` : text; }
function pad(text: string, width: number): string { return text + " ".repeat(Math.max(0, width - visibleWidth(text))); }
function clip(text: string, width: number): string { return truncateToWidth(text.replace(/\s+/g, " ").trim(), Math.max(1, width), "…"); }

export function normalizeBoardFocus(view: BoardView, focus: BoardFocus): BoardFocus {
  const column = Math.max(0, Math.min(BOARD_COLUMNS.length - 1, focus.column));
  const count = view.columns[BOARD_COLUMNS[column]!].length;
  return { column, row: Math.max(0, Math.min(Math.max(0, count - 1), focus.row)) };
}

/** Arrow movement is deterministic and pure; horizontal moves preserve the visual row. */
export function moveBoardFocus(view: BoardView, focus: BoardFocus, direction: "up" | "down" | "left" | "right"): BoardFocus {
  const current = normalizeBoardFocus(view, focus);
  if (direction === "up" || direction === "down") {
    const count = view.columns[BOARD_COLUMNS[current.column]!].length;
    return { column: current.column, row: Math.max(0, Math.min(Math.max(0, count - 1), current.row + (direction === "up" ? -1 : 1))) };
  }
  const delta = direction === "left" ? -1 : 1;
  let column = current.column + delta;
  while (column >= 0 && column < BOARD_COLUMNS.length && view.columns[BOARD_COLUMNS[column]!].length === 0) column += delta;
  if (column < 0 || column >= BOARD_COLUMNS.length) return current;
  return { column, row: Math.min(current.row, view.columns[BOARD_COLUMNS[column]!].length - 1) };
}

export function focusedTaskId(view: BoardView, focus: BoardFocus): string | undefined {
  const normalized = normalizeBoardFocus(view, focus);
  return view.columns[BOARD_COLUMNS[normalized.column]!][normalized.row];
}

export function hitTestCard(rects: readonly CardRect[], x: number, y: number): CardRect | undefined {
  return rects.find((rect) => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height);
}

export interface SgrMouseEvent { readonly button: number; readonly x: number; readonly y: number; readonly release: boolean }
const SGR_MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([mM])/g;

export function parseSgrMouseSequence(data: string): SgrMouseEvent | undefined {
  SGR_MOUSE.lastIndex = 0;
  const match = SGR_MOUSE.exec(data);
  return match ? { button: Number(match[1]), x: Number(match[2]), y: Number(match[3]), release: match[4] === "m" } : undefined;
}

/** Remove every complete SGR mouse report before normal key routing sees it. */
export function stripMouseSequences(data: string): string { SGR_MOUSE.lastIndex = 0; return data.replace(SGR_MOUSE, ""); }

function elapsed(card: BoardViewCard, nowMs: number): string {
  if (!card.startedAt) return "—";
  const seconds = Math.max(0, Math.floor((nowMs - Date.parse(card.startedAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function modelLabel(card: BoardViewCard): string {
  if (!card.modelId) return "unassigned";
  const label = card.modelId.split("/").at(-1) ?? card.modelId;
  return `${label}${card.score === undefined ? "" : ` (${card.score})`}`;
}

export function renderBoardLayout(view: BoardView, width: number, height: number, focus: BoardFocus, options: { readonly color?: boolean; readonly nowMs?: number; readonly spinnerFrame?: number } = {}): BoardLayout {
  const color = options.color ?? !process.env.NO_COLOR;
  const nowMs = options.nowMs ?? Date.now();
  const frame = options.spinnerFrame ?? 0;
  const gutter = 1;
  const usable = Math.max(40, width - gutter * (BOARD_COLUMNS.length - 1));
  const columnWidth = Math.max(8, Math.floor(usable / BOARD_COLUMNS.length));
  const normalized = normalizeBoardFocus(view, focus);
  const header = pad(`tasks · ${Object.keys(view.cards).length} ${Object.keys(view.cards).length === 1 ? "task" : "tasks"}`, width);
  const columnHeaders = BOARD_COLUMNS.map((column) => dim(pad(`${COLUMN_LABELS[column]} ${view.columns[column].length}`, columnWidth), color)).join(" ");
  const lines: string[] = [header, columnHeaders];
  const rects: CardRect[] = [];
  const cardHeight = 5;
  const maxCards = Math.max(0, ...BOARD_COLUMNS.map((column) => view.columns[column].length));
  for (let row = 0; row < maxCards; row += 1) {
    const cells: string[][] = [];
    for (let column = 0; column < BOARD_COLUMNS.length; column += 1) {
      const taskId = view.columns[BOARD_COLUMNS[column]!]![row];
      if (!taskId) { cells.push(Array.from({ length: cardHeight }, () => " ".repeat(columnWidth))); continue; }
      const card = view.cards[taskId]!;
      const active = normalized.column === column && normalized.row === row;
      const inner = Math.max(1, columnWidth - 3);
      const glyph = card.status === "in_progress" ? SPINNER[frame % SPINNER.length] : "·";
      const cost = card.costUsd === undefined ? "cost —" : `$${card.costUsd.toFixed(3)}`;
      const rows = [
        `${glyph} ${clip(card.title, inner)}`,
        `  ${clip(modelLabel(card), inner)}`,
        `  ${elapsed(card, nowMs)} · ${cost}`,
        `  ${card.status === "in_progress" ? clip(card.lastNarrationLine ?? "working", inner) : clip(card.status.replace("_", " "), inner)}`,
        "",
      ].map((line) => pad(active ? paint(line, ACCENT, color) : line, columnWidth));
      cells.push(rows);
      rects.push({ taskId, column, row, x: column * (columnWidth + gutter) + 1, y: 3 + row * cardHeight, width: columnWidth, height: cardHeight });
    }
    for (let sub = 0; sub < cardHeight; sub += 1) lines.push(cells.map((cell) => cell[sub]!).join(" "));
  }
  const footer = dim("↑↓←→ move · enter open · esc/q chat · mouse click", color);
  while (lines.length < Math.max(3, height - 1)) lines.push("");
  lines.push(pad(footer, width));
  return { lines: lines.slice(0, Math.max(1, height)), cardRects: rects, focus: normalized };
}

export interface BoardScreenOptions {
  readonly view: () => BoardView;
  readonly rows: () => number;
  readonly requestRender: () => void;
  readonly openTask: (taskId: string) => void;
  readonly close: () => void;
  readonly color?: boolean;
}

export class BoardScreen implements Component {
  private focus: BoardFocus = { column: 0, row: 0 };
  private rects: readonly CardRect[] = [];
  private frame = 0;
  private lastClick: { readonly taskId: string; readonly at: number } | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(private readonly options: BoardScreenOptions) {
    const first = BOARD_COLUMNS.findIndex((column) => options.view().columns[column].length > 0);
    if (first >= 0) this.focus = { column: first, row: 0 };
  }
  start(): void { if (!this.timer) this.timer = setInterval(() => { this.frame += 1; this.options.requestRender(); }, 250); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  render(width: number): string[] {
    const layout = renderBoardLayout(this.options.view(), width, this.options.rows(), this.focus, { color: this.options.color, spinnerFrame: this.frame });
    this.focus = layout.focus; this.rects = layout.cardRects; return [...layout.lines];
  }
  handleMouse(event: SgrMouseEvent): boolean {
    if (event.release || (event.button & 3) !== 0) return true;
    const rect = hitTestCard(this.rects, event.x, event.y);
    if (!rect) return true;
    const alreadyFocused = focusedTaskId(this.options.view(), this.focus) === rect.taskId;
    this.focus = { column: rect.column, row: rect.row };
    const now = Date.now();
    const doubleClick = this.lastClick?.taskId === rect.taskId && now - this.lastClick.at <= 400;
    this.lastClick = { taskId: rect.taskId, at: now };
    if (alreadyFocused || doubleClick) this.options.openTask(rect.taskId);
    this.options.requestRender();
    return true;
  }
  handleInput(data: string): void {
    const view = this.options.view();
    if (matchesKey(data, "escape") || data === "q") { this.options.close(); return; }
    if (matchesKey(data, "enter") || matchesKey(data, "return")) { const id = focusedTaskId(view, this.focus); if (id) this.options.openTask(id); return; }
    for (const direction of ["up", "down", "left", "right"] as const) if (matchesKey(data, direction)) { this.focus = moveBoardFocus(view, this.focus, direction); break; }
    this.options.requestRender();
  }
  invalidate(): void {}
}
