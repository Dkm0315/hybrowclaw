import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import type { WorkspacePatchEvent } from "@musterhq/core";

const RESET = "\x1b[0m";
const ADD_RGB = "138;154;91";
const DEL_RGB = "255;107;122";
const MUTED_RGB = "148;144;140";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

export type LiveFileLineKind = "unchanged" | "added" | "removed";

export interface LiveFileRenderLine {
  readonly kind: LiveFileLineKind;
  readonly gutter: " " | "+" | "-";
  /** Current line number, or the original turn-start number for a removal. */
  readonly lineNumber: number;
  readonly text: string;
}

export interface LiveFileView {
  readonly path: string;
  readonly lines: readonly LiveFileRenderLine[];
  readonly additions: number;
  readonly deletions: number;
  /** Render-row index of the newest hunk in this file. */
  readonly latestChangeRow: number;
  readonly eventCount: number;
}

interface ParsedHunkLine {
  readonly kind: "context" | "add" | "delete";
  readonly text: string;
}

interface ParsedHunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly lines: readonly ParsedHunkLine[];
}

interface CurrentLine {
  text: string;
  /** Present only when this line existed at turn start. */
  readonly baselineLine?: number;
}

interface RemovedLine {
  anchor: number;
  readonly text: string;
  readonly baselineLine: number;
}

interface MutableFileState {
  path: string;
  readonly baselineLines: readonly string[];
  readonly current: CurrentLine[];
  readonly removed: RemovedLine[];
  readonly events: WorkspacePatchEvent[];
  latestAnchor: number;
}

/**
 * Cumulative, turn-local file model. It owns no filesystem access: callers
 * supply the current file text captured when the observer event arrives.
 */
export class LiveFileTurnAccumulator {
  private readonly files = new Map<string, MutableFileState>();
  private readonly order: string[] = [];
  private recentPath: string | undefined;

  add(event: WorkspacePatchEvent, currentContent: string): void {
    if (!event.diff || event.binary) return;
    const hunks = parseUnifiedDiffHunks(event.diff);
    if (!hunks.length) return;

    let state = this.files.get(event.path);
    if (!state && event.previousPath) {
      state = this.files.get(event.previousPath);
      if (state) {
        this.files.delete(event.previousPath);
        state.path = event.path;
        this.files.set(event.path, state);
        const index = this.order.indexOf(event.previousPath);
        if (index >= 0) this.order[index] = event.path;
      }
    }

    if (!state) {
      const afterLines = splitFileLines(currentContent);
      const baselineLines = reverseHunks(afterLines, hunks);
      state = {
        path: event.path,
        baselineLines,
        current: baselineLines.map((text, index) => ({ text, baselineLine: index + 1 })),
        removed: [],
        events: [],
        latestAnchor: 0,
      };
      this.files.set(event.path, state);
      this.order.push(event.path);
    }

    applyHunks(state, hunks);
    state.events.push(event);
    reconcileCurrentText(state, splitFileLines(currentContent));
    this.recentPath = event.path;
  }

  paths(): readonly string[] {
    return this.order;
  }

  mostRecentPath(): string | undefined {
    return this.recentPath;
  }

  baseline(path: string): readonly string[] | undefined {
    return this.files.get(path)?.baselineLines;
  }

  events(path: string): readonly WorkspacePatchEvent[] {
    return this.files.get(path)?.events ?? [];
  }

  view(path: string): LiveFileView | undefined {
    const state = this.files.get(path);
    if (!state) return undefined;
    const lines: LiveFileRenderLine[] = [];
    let latestChangeRow = 0;
    for (let anchor = 0; anchor <= state.current.length; anchor += 1) {
      const removals = state.removed
        .filter((line) => line.anchor === anchor)
        .sort((left, right) => left.baselineLine - right.baselineLine);
      if (anchor === state.latestAnchor && removals.length) latestChangeRow = lines.length;
      for (const line of removals) {
        lines.push({ kind: "removed", gutter: "-", lineNumber: line.baselineLine, text: line.text });
      }
      if (anchor < state.current.length) {
        const current = state.current[anchor]!;
        if (anchor === state.latestAnchor && !removals.length) latestChangeRow = lines.length;
        lines.push({
          kind: current.baselineLine === undefined ? "added" : "unchanged",
          gutter: current.baselineLine === undefined ? "+" : " ",
          lineNumber: anchor + 1,
          text: current.text,
        });
      }
    }
    return {
      path,
      lines,
      additions: state.current.filter((line) => line.baselineLine === undefined).length,
      deletions: state.removed.length,
      latestChangeRow: Math.min(latestChangeRow, Math.max(0, lines.length - 1)),
      eventCount: state.events.length,
    };
  }
}

/** Center the newest hunk when possible, clamped to a legal scroll window. */
export function followScrollTarget(latestRow: number, totalRows: number, viewportRows: number): number {
  const height = Math.max(1, Math.floor(viewportRows));
  const maxTop = Math.max(0, Math.floor(totalRows) - height);
  return Math.max(0, Math.min(maxTop, Math.floor(latestRow) - Math.floor(height / 2)));
}

export interface LiveFileOverlayOptions {
  readonly terminalRows: () => number;
  readonly requestRender: () => void;
  readonly close: () => void;
  readonly color?: boolean;
}

/** Focusable pi-tui overlay; transcript rendering continues beneath it. */
export class LiveFileOverlay implements Component {
  private accumulator: LiveFileTurnAccumulator;
  private selectedPath: string | undefined;
  private following = true;
  private scrollTop = 0;

  constructor(accumulator: LiveFileTurnAccumulator, private readonly options: LiveFileOverlayOptions) {
    this.accumulator = accumulator;
    this.selectedPath = accumulator.mostRecentPath();
  }

  update(accumulator: LiveFileTurnAccumulator): void {
    this.accumulator = accumulator;
    if (this.following) this.selectedPath = accumulator.mostRecentPath();
    else if (this.selectedPath && !accumulator.paths().includes(this.selectedPath)) this.selectedPath = accumulator.paths()[0];
    this.options.requestRender();
  }

  render(width: number): string[] {
    const frameWidth = Math.max(20, width);
    const viewportRows = Math.max(1, Math.floor(this.options.terminalRows() * 0.85) - 3);
    const path = this.selectedPath ?? this.accumulator.mostRecentPath();
    const view = path ? this.accumulator.view(path) : undefined;
    if (!view) return [pad(dim("no files edited this turn", this.paint), frameWidth)];

    if (this.following) this.scrollTop = followScrollTarget(view.latestChangeRow, view.lines.length, viewportRows);
    else this.scrollTop = Math.min(this.scrollTop, Math.max(0, view.lines.length - viewportRows));

    const followLabel = this.following ? "following" : "paused";
    const header = `${view.path} · +${view.additions} −${view.deletions} · ${followLabel} ⏸(space pauses follow)`;
    const body = view.lines
      .slice(this.scrollTop, this.scrollTop + viewportRows)
      .map((line) => renderFullFileLine(line, frameWidth, { color: this.paint }));
    const footer = `↑↓/PgUp/PgDn scroll · Tab next file · Ctrl+D/Esc close${this.accumulator.paths().length > 1 ? ` · ${this.accumulator.paths().indexOf(view.path) + 1}/${this.accumulator.paths().length}` : ""}`;
    return [pad(dim(truncateToWidth(header, frameWidth, ""), this.paint), frameWidth), ...body, pad(dim(truncateToWidth(footer, frameWidth, ""), this.paint), frameWidth)];
  }

  handleInput(data: string): void {
    if (data === "\x04" || matchesKey(data, "escape")) {
      this.options.close();
      return;
    }
    if (data === " ") {
      this.following = !this.following;
      this.options.requestRender();
      return;
    }
    if (data === "\t" || matchesKey(data, "tab")) {
      const paths = this.accumulator.paths();
      if (paths.length) {
        const index = Math.max(0, paths.indexOf(this.selectedPath ?? ""));
        this.selectedPath = paths[(index + 1) % paths.length];
        this.following = false;
        this.scrollTop = 0;
      }
      this.options.requestRender();
      return;
    }
    const view = this.selectedPath ? this.accumulator.view(this.selectedPath) : undefined;
    if (!view) return;
    const page = Math.max(1, Math.floor(this.options.terminalRows() * 0.85) - 5);
    let delta = 0;
    if (matchesKey(data, "up")) delta = -1;
    else if (matchesKey(data, "down")) delta = 1;
    else if (matchesKey(data, "pageUp")) delta = -page;
    else if (matchesKey(data, "pageDown")) delta = page;
    if (delta) {
      this.following = false;
      this.scrollTop = Math.max(0, Math.min(Math.max(0, view.lines.length - page), this.scrollTop + delta));
      this.options.requestRender();
    }
  }

  invalidate(): void {}

  private get paint(): boolean {
    return this.options.color ?? !process.env.NO_COLOR;
  }
}

/** Exact fixed-gutter row used by both the overlay and snapshot tests. */
export function renderFullFileLine(line: LiveFileRenderLine, width: number, options: { readonly color?: boolean } = {}): string {
  const paint = options.color ?? !process.env.NO_COLOR;
  const lineNumber = String(line.lineNumber).padStart(5);
  const gutter = ` ${line.gutter} `;
  const prefix = dim(lineNumber, paint) + colorize(gutter, line.kind === "added" ? ADD_RGB : line.kind === "removed" ? DEL_RGB : MUTED_RGB, paint);
  const available = Math.max(0, width - visibleWidth(prefix));
  const text = truncateToWidth(line.text, available, "");
  const paintedText = !paint
    ? text
    : line.kind === "added"
      ? colorize(`${BOLD}${text}`, ADD_RGB, true)
      : line.kind === "removed"
        ? colorize(`${DIM}${text}`, DEL_RGB, true)
        : text;
  return pad(prefix + paintedText, width);
}

/** Plain fallback for non-TTY/cramped terminals: cumulative final turn delta. */
export function renderLiveFilePlain(accumulator: LiveFileTurnAccumulator): readonly string[] {
  const output: string[] = [];
  for (const path of accumulator.paths()) {
    const view = accumulator.view(path);
    if (!view) continue;
    output.push(`--- turn-start/${path}`, `+++ current/${path}`);
    for (const line of view.lines) {
      if (line.kind === "removed") output.push(`-${line.text}`);
      else if (line.kind === "added") output.push(`+${line.text}`);
    }
  }
  return output.length ? output : ["no files edited this turn"];
}

export function parseUnifiedDiffHunks(diff: string): readonly ParsedHunk[] {
  const input = diff.split("\n");
  const hunks: ParsedHunk[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const match = input[index]?.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!match) continue;
    const lines: ParsedHunkLine[] = [];
    index += 1;
    while (index < input.length && !input[index]!.startsWith("@@ ")) {
      const raw = input[index]!;
      if (raw.startsWith(" ")) lines.push({ kind: "context", text: raw.slice(1) });
      else if (raw.startsWith("+")) lines.push({ kind: "add", text: raw.slice(1) });
      else if (raw.startsWith("-")) lines.push({ kind: "delete", text: raw.slice(1) });
      index += 1;
    }
    index -= 1;
    hunks.push({
      oldStart: Number(match[1]),
      oldCount: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newCount: match[4] === undefined ? 1 : Number(match[4]),
      lines,
    });
  }
  return hunks;
}

function reverseHunks(after: readonly string[], hunks: readonly ParsedHunk[]): string[] {
  const result = [...after];
  for (const hunk of [...hunks].reverse()) {
    const oldSide = hunk.lines.filter((line) => line.kind !== "add").map((line) => line.text);
    result.splice(Math.max(0, hunk.newStart - 1), hunk.newCount, ...oldSide);
  }
  return result;
}

function applyHunks(state: MutableFileState, hunks: readonly ParsedHunk[]): void {
  let eventOffset = 0;
  for (const hunk of hunks) {
    let cursor = Math.max(0, hunk.oldStart - 1 + eventOffset);
    let firstChange: number | undefined;
    for (const line of hunk.lines) {
      if (line.kind === "context") {
        cursor += 1;
        continue;
      }
      firstChange = firstChange === undefined ? cursor : Math.min(firstChange, cursor);
      if (line.kind === "delete") {
        const removed = state.current[cursor];
        if (!removed) continue;
        state.current.splice(cursor, 1);
        for (const phantom of state.removed) if (phantom.anchor > cursor) phantom.anchor -= 1;
        if (removed.baselineLine !== undefined && !state.removed.some((phantom) => phantom.baselineLine === removed.baselineLine)) {
          state.removed.push({ anchor: cursor, text: removed.text, baselineLine: removed.baselineLine });
        }
        continue;
      }
      for (const phantom of state.removed) if (phantom.anchor > cursor) phantom.anchor += 1;
      state.current.splice(cursor, 0, { text: line.text });
      cursor += 1;
    }
    state.latestAnchor = Math.max(0, Math.min(state.current.length, firstChange ?? Math.max(0, hunk.newStart - 1)));
    eventOffset += hunk.newCount - hunk.oldCount;
  }
}

function reconcileCurrentText(state: MutableFileState, actual: readonly string[]): void {
  // Diff application is authoritative for provenance; disk text is authoritative
  // for display. Equal lengths let us combine both without fuzzy matching.
  if (actual.length !== state.current.length) return;
  for (let index = 0; index < actual.length; index += 1) state.current[index]!.text = actual[index]!;
}

function splitFileLines(content: string): string[] {
  if (!content) return [];
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function colorize(text: string, rgb: string, paint: boolean, suffix = RESET): string {
  return paint ? `\x1b[38;2;${rgb}m${text}${suffix}` : text;
}

function dim(text: string, paint: boolean): string {
  return paint ? `${DIM}\x1b[38;2;${MUTED_RGB}m${text}${RESET}` : text;
}

function pad(value: string, width: number): string {
  const clipped = truncateToWidth(value, width, "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}
