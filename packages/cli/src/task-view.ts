import { spawn, type ChildProcess } from "node:child_process";
import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { BoardViewCard, MessageRow } from "@musterhq/core";
import { formatAssistantBlock, formatReasoningLine, formatToolLine, formatToolResultLines, formatUserLine, isUserTranscriptLine } from "./chat-tui.js";
import { bandUserRow } from "./prose-renderer.js";
import { followScrollTarget, LiveFileTurnAccumulator, renderFullFileLine } from "./live-file-view.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const MUTED = "148;144;140";
const ACCENT = "217;119;87";
function dim(text: string, enabled: boolean): string { return enabled ? `${DIM}\x1b[38;2;${MUTED}m${text}${RESET}` : text; }
function accent(text: string, enabled: boolean): string { return enabled ? `\x1b[38;2;${ACCENT}m${text}${RESET}` : text; }
function pad(text: string, width: number): string { return text + " ".repeat(Math.max(0, width - visibleWidth(text))); }

export interface TaskTranscriptRow { readonly role: string; readonly content: string }

/** Stored history and live rows use precisely the chat grammar helpers. */
export function renderTaskTranscript(rows: readonly TaskTranscriptRow[]): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    if (row.role === "user") {
      const parts = row.content.split(/\r?\n/);
      lines.push(formatUserLine(parts[0] ?? ""), ...parts.slice(1).map((line) => `  ${line}`));
    } else if (row.role === "assistant") {
      lines.push(...formatAssistantBlock(row.content));
    } else if (row.role === "reasoning" || row.role === "thinking") {
      for (const part of row.content.split(/\r?\n/).filter((line) => line.trim())) lines.push(formatReasoningLine(part));
    } else if (row.role === "tool") {
      let name = "Tool";
      let target: string | undefined;
      let summary = row.content;
      try {
        const parsed = JSON.parse(row.content) as { name?: unknown; target?: unknown; summary?: unknown };
        if (typeof parsed.name === "string") name = parsed.name;
        if (typeof parsed.target === "string") target = parsed.target;
        if (typeof parsed.summary === "string") summary = parsed.summary;
      } catch { /* older rows store only the result text */ }
      lines.push(formatToolLine(name, target, "success"), ...formatToolResultLines(summary));
    }
  }
  return lines;
}

export interface EditorGuardOptions {
  readonly editor?: string;
  readonly cwd: string;
  readonly line?: number;
  readonly setRawMode?: (enabled: boolean) => void;
  readonly write?: (data: string) => void;
  readonly spawnEditor?: (command: string, args: readonly string[], cwd: string) => ChildProcess;
}

/** Suspend terminal input around $EDITOR and restore it even on spawn failure. */
export async function openFileWithEditorGuard(path: string, options: EditorGuardOptions): Promise<void> {
  const editor = options.editor || process.env.EDITOR || "vi";
  const parts = editor.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, "")) ?? [editor];
  const command = parts.shift() || "vi";
  const fileArg = options.line && /(?:^|\/)(?:vi|vim|nvim)$/.test(command) ? `+${options.line}` : undefined;
  const args = [...parts, ...(fileArg ? [fileArg] : []), path];
  const setRaw = options.setRawMode ?? ((enabled: boolean) => { if (process.stdin.isTTY) process.stdin.setRawMode(enabled); });
  const write = options.write ?? ((data: string) => process.stdout.write(data));
  const spawnEditor = options.spawnEditor ?? ((cmd, argv, cwd) => spawn(cmd, argv, { cwd, stdio: "inherit" }));
  write("\x1b[?1002l\x1b[?1006l\x1b[?25h");
  setRaw(false);
  try {
    const child = spawnEditor(command, args, options.cwd);
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => resolve());
    });
  } finally {
    setRaw(true);
    write("\x1b[?1002h\x1b[?1006h\x1b[?25l");
  }
}

export interface TaskViewOptions {
  readonly card: () => BoardViewCard;
  readonly messages: () => readonly (MessageRow | TaskTranscriptRow)[];
  readonly diff: () => LiveFileTurnAccumulator;
  readonly rows: () => number;
  readonly cwd: string;
  readonly requestRender: (force?: boolean) => void;
  readonly close: () => void;
  readonly comment: (text: string, anchor?: { readonly path: string; readonly line: number }) => void | Promise<void>;
  readonly approve: () => void | Promise<void>;
  readonly retry: () => void | Promise<void>;
  readonly cancel: () => void | Promise<void>;
  readonly openEditor?: (path: string, line?: number) => void | Promise<void>;
  readonly color?: boolean;
}

export class TaskView implements Component {
  private selectedPath: string | undefined;
  private diffScroll = 0;
  private transcriptScroll = 0;
  private following = true;
  private input: string | undefined;
  private notice = "";
  constructor(private readonly options: TaskViewOptions) { this.selectedPath = options.diff().mostRecentPath(); }
  render(width: number): string[] {
    const color = this.options.color ?? !process.env.NO_COLOR;
    const height = Math.max(12, this.options.rows());
    const card = this.options.card();
    const transcriptHeight = Math.max(4, Math.floor((height - 5) * 0.42));
    const diffHeight = Math.max(3, height - transcriptHeight - 5);
    const transcript = renderTaskTranscript(this.options.messages());
    const transcriptTop = this.following ? Math.max(0, transcript.length - transcriptHeight) : Math.min(this.transcriptScroll, Math.max(0, transcript.length - transcriptHeight));
    const rows: string[] = [pad(`${accent(card.title, color)} ${dim(`· ${card.modelId ?? "unassigned"} · ${card.status}`, color)}`, width)];
    rows.push(pad(dim("transcript", color), width));
    let userBandOpen = false;
    for (let index = 0; index < transcriptTop; index += 1) {
      const line = transcript[index]!;
      if (isUserTranscriptLine(line)) userBandOpen = true;
      else if (!line.replace(/\x1b\[[0-9;]*m/g, "").startsWith("  ")) userBandOpen = false;
    }
    for (const line of transcript.slice(transcriptTop, transcriptTop + transcriptHeight)) {
      if (isUserTranscriptLine(line)) userBandOpen = true;
      else if (!line.replace(/\x1b\[[0-9;]*m/g, "").startsWith("  ")) userBandOpen = false;
      const fitted = pad(truncateToWidth(line, width, ""), width);
      rows.push(userBandOpen ? bandUserRow(fitted, width) : fitted);
    }
    while (rows.length < transcriptHeight + 2) rows.push("");

    const accumulator = this.options.diff();
    if (!this.selectedPath || !accumulator.paths().includes(this.selectedPath)) this.selectedPath = accumulator.mostRecentPath() ?? accumulator.paths()[0];
    const view = this.selectedPath ? accumulator.view(this.selectedPath) : undefined;
    rows.push(pad(dim(view ? `${view.path} · +${view.additions} −${view.deletions}${this.following ? " · following" : ""}` : "work · no files edited in this attempt", color), width));
    if (view) {
      if (this.following) this.diffScroll = followScrollTarget(view.latestChangeRow, view.lines.length, diffHeight);
      this.diffScroll = Math.min(this.diffScroll, Math.max(0, view.lines.length - diffHeight));
      for (const line of view.lines.slice(this.diffScroll, this.diffScroll + diffHeight)) rows.push(renderFullFileLine(line, width, { color }));
    }
    while (rows.length < height - 2) rows.push("");
    const controls = this.input !== undefined
      ? `${accent("comment", color)} › ${this.input}_`
      : "c comment · a approve · r retry · x cancel · o open in $EDITOR · tab file · esc back";
    rows.push(pad(truncateToWidth(controls, width, ""), width));
    rows.push(pad(dim(this.notice || "review actions are recorded; send-to-agent and merge mechanics land in K-C", color), width));
    return rows.slice(0, height);
  }
  handleInput(data: string): void {
    if (this.input !== undefined) {
      if (matchesKey(data, "escape")) { this.input = undefined; this.options.requestRender(); return; }
      if (matchesKey(data, "enter") || matchesKey(data, "return")) {
        const text = this.input.trim(); this.input = undefined;
        if (text) this.runAction(this.options.comment(text, this.anchor()), "comment recorded · send-to-agent lands in K-C");
        return;
      }
      if (matchesKey(data, "backspace")) this.input = this.input.slice(0, -1);
      else if (!data.startsWith("\x1b") && data >= " ") this.input += data;
      this.options.requestRender(); return;
    }
    if (matchesKey(data, "escape")) { this.options.close(); return; }
    if (data === "c") { this.input = ""; this.options.requestRender(); return; }
    if (data === "a") { this.runAction(this.options.approve(), "approval requested · acceptance checks and merge land in K-C"); return; }
    if (data === "r") { this.runAction(this.options.retry(), "new attempt started"); return; }
    if (data === "x") { this.runAction(this.options.cancel(), "attempt cancelled"); return; }
    if (data === "o") { const anchor = this.anchor(); if (anchor) void Promise.resolve(this.options.openEditor?.(anchor.path, anchor.line) ?? openFileWithEditorGuard(anchor.path, { cwd: this.options.cwd, line: anchor.line })).finally(() => this.options.requestRender(true)); return; }
    if (data === "\t" || matchesKey(data, "tab")) { const paths = this.options.diff().paths(); if (paths.length) { const index = Math.max(0, paths.indexOf(this.selectedPath ?? "")); this.selectedPath = paths[(index + 1) % paths.length]; this.diffScroll = 0; this.following = false; } this.options.requestRender(); return; }
    const view = this.selectedPath ? this.options.diff().view(this.selectedPath) : undefined;
    if (matchesKey(data, "up")) { this.following = false; this.diffScroll = Math.max(0, this.diffScroll - 1); }
    if (matchesKey(data, "down")) { this.following = false; this.diffScroll = Math.min(Math.max(0, (view?.lines.length ?? 0) - 1), this.diffScroll + 1); }
    if (data === " ") this.following = !this.following;
    this.options.requestRender();
  }
  invalidate(): void {}
  private anchor(): { path: string; line: number } | undefined {
    if (!this.selectedPath) return undefined;
    const view = this.options.diff().view(this.selectedPath);
    const line = view?.lines[Math.min(this.diffScroll, Math.max(0, (view?.lines.length ?? 1) - 1))]?.lineNumber ?? 1;
    return { path: this.selectedPath, line };
  }
  private runAction(action: void | Promise<void>, success: string): void {
    void Promise.resolve(action).then(() => { this.notice = success; }, (error) => { this.notice = error instanceof Error ? error.message : String(error); }).finally(() => this.options.requestRender());
  }
}
