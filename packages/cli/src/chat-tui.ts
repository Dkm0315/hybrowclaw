import {
  Editor,
  ProcessTerminal,
  TUI,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type AutocompleteItem,
  type AutocompleteProvider,
  type Component,
  type EditorTheme,
} from "@earendil-works/pi-tui";

export interface MusterChatCommand {
  readonly name: string;
  readonly usage: string;
  readonly description: string;
  readonly aliases?: readonly string[];
}

export interface MusterAutocompleteOptions {
  readonly commands: readonly MusterChatCommand[];
  readonly toolsets: readonly string[];
  readonly recentSessions: () => readonly string[];
  readonly catalog?: MusterCompletionCatalog;
  readonly providers?: () => readonly PickerOption[] | Promise<readonly PickerOption[]>;
  readonly models?: (context: { providerId?: string }) => readonly PickerOption[] | Promise<readonly PickerOption[]>;
  readonly runtimes?: () => readonly PickerOption[] | Promise<readonly PickerOption[]>;
  readonly clouds?: () => readonly PickerOption[] | Promise<readonly PickerOption[]>;
  readonly speeds?: () => readonly PickerOption[] | Promise<readonly PickerOption[]>;
  readonly capabilities?: () => readonly PickerOption[] | Promise<readonly PickerOption[]>;
  readonly skills?: () => readonly PickerOption[] | Promise<readonly PickerOption[]>;
  readonly plugins?: () => readonly PickerOption[] | Promise<readonly PickerOption[]>;
  readonly pluginReuseProviders?: () => readonly PickerOption[] | Promise<readonly PickerOption[]>;
  readonly mcpServers?: () => readonly PickerOption[] | Promise<readonly PickerOption[]>;
  readonly integrations?: () => readonly PickerOption[] | Promise<readonly PickerOption[]>;
  readonly integrationWorkflows?: () => readonly PickerOption[] | Promise<readonly PickerOption[]>;
  readonly agents: () => readonly string[] | Promise<readonly string[]>;
}

export type MusterCompletionKind =
  | "command"
  | "toolset"
  | "session"
  | "provider"
  | "provider-model"
  | "model"
  | "runtime"
  | "cloud"
  | "speed"
  | "capability"
  | "skill"
  | "plugin"
  | "plugin-reuse-provider"
  | "mcp"
  | "integration"
  | "integration-workflow"
  | "agent";

export interface MusterCompletionRequest {
  readonly kind: MusterCompletionKind;
  readonly fragment: string;
  readonly providerId?: string;
}

export interface MusterCompletionCatalog {
  complete(request: MusterCompletionRequest): readonly PickerOption[] | Promise<readonly PickerOption[]>;
}

export interface PickerOption {
  readonly value: string;
  readonly label?: string;
  readonly description?: string;
}

export interface MusterChatSink {
  appendLine(line: string): void;
  appendUser(text: string): void;
  clearTranscript(): void;
  setHeaderLines(lines: readonly string[]): void;
  setStatus(status: string): void;
  clearStatus(): void;
  openPicker(command: string): void;
}

export interface RunMusterChatTuiOptions extends MusterAutocompleteOptions {
  readonly headerLines?: readonly string[];
  readonly statusLine: () => string | Promise<string>;
  readonly onSubmit: (text: string, sink: MusterChatSink) => Promise<boolean>;
}

export interface MusterChatHarness {
  input(data: string): void;
  type(text: string): void;
  submit(): Promise<void>;
  visible(width?: number): string[];
  text(): string;
  transcript(): readonly string[];
  openPicker(command: string): void;
}

const WORKING_FRAMES = ["|", "/", "-", "\\"] as const;

export function formatWorkingIndicator(agentId: string | undefined, frame: number): string {
  const label = agentId ? `@${agentId} working` : "working";
  return `${WORKING_FRAMES[Math.abs(frame) % WORKING_FRAMES.length]} ${label}`;
}

const RESET = "\x1b[0m";
const ACCENT_RGB = "41;211;255";
const HIGHLIGHT_RGB = "104;245;168";
const MUTED_RGB = "142;161;181";
const RED_RGB = "255;107;122";
const SELECTION_BG_RGB = "41;211;255";

export function createMusterAutocompleteProvider(options: MusterAutocompleteOptions): AutocompleteProvider {
  const catalog = options.catalog ?? createCallbackCompletionCatalog(options);
  return {
    triggerCharacters: ["@", "/", " "],
    async getSuggestions(lines, cursorLine, cursorCol, { signal }) {
      if (signal.aborted) return null;
      const line = lines[cursorLine] ?? "";
      const beforeCursor = line.slice(0, cursorCol);
      const trimmed = beforeCursor.trimStart();
      if (trimmed !== beforeCursor && beforeCursor.slice(0, beforeCursor.length - trimmed.length).includes("\n")) return null;

      const slash = slashCompletionContext(trimmed);
      if (slash) {
        const choices = await catalog.complete({
          kind: slash.kind,
          fragment: slash.fragment,
          providerId: "providerId" in slash ? slash.providerId : undefined,
        });
        if (signal.aborted) return null;
        const items = pickerOptionsToItems(choices);
        return items.length ? { items, prefix: slash.prefix } : null;
      }

      const agentFragment = agentCompletionFragment(trimmed);
      if (agentFragment !== undefined) {
        const choices = await catalog.complete({ kind: "agent", fragment: agentFragment });
        if (signal.aborted) return null;
        const items = pickerOptionsToItems(choices);
        return items.length ? { items, prefix: `@${agentFragment}` } : null;
      }
      return null;
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const line = lines[cursorLine] ?? "";
      const beforeCursor = line.slice(0, cursorCol);
      const afterCursor = line.slice(cursorCol);
      const replacement = completionReplacement(beforeCursor, item, prefix);
      const startCol = Math.max(0, cursorCol - prefix.length);
      const nextLine = `${line.slice(0, startCol)}${replacement}${afterCursor}`;
      const nextLines = [...lines];
      nextLines[cursorLine] = nextLine;
      return {
        lines: nextLines,
        cursorLine,
        cursorCol: startCol + replacement.length,
      };
    },
  };
}

export function createMusterChatEditor(tui: Pick<TUI, "terminal" | "requestRender">): Editor {
  const editor = new Editor(tui as TUI, musterEditorTheme(), { autocompleteMaxVisible: 16 });
  editor.setPaddingX(0);
  return editor;
}

export function createMusterChatHarness(options: MusterAutocompleteOptions & {
  readonly onSubmit?: (text: string, sink: MusterChatSink) => Promise<boolean>;
  readonly width?: number;
  readonly rows?: number;
}): MusterChatHarness {
  const tui = fakeHarnessTui(options.width ?? 120, options.rows ?? 40);
  const editor = createMusterChatEditor(tui);
  const sink = new HarnessSink(editor, options.onSubmit);
  editor.setAutocompleteProvider(createMusterAutocompleteProvider(options));
  editor.onSubmit = (text) => {
    void sink.submit(text);
  };
  return {
    input(data) {
      if (isClearComposerKey(data)) {
        editor.handleInput("\x1b");
        editor.setText("");
        return;
      }
      if (data === "\x1b" && isBareCompletionTrigger(editor.getText())) {
        editor.handleInput(data);
        editor.setText("");
        return;
      }
      editor.handleInput(data);
    },
    type(text) {
      for (const char of text) editor.handleInput(char);
    },
    async submit() {
      const text = editor.getText();
      editor.setText("");
      await sink.submit(text);
    },
    visible(width = options.width ?? 120) {
      return [...sink.transcriptLines, ...renderMusterComposer(editor, width)];
    },
    text() {
      return editor.getText();
    },
    transcript() {
      return sink.transcriptLines;
    },
    openPicker(command) {
      sink.openPicker(command);
    },
  };
}

export function renderMusterComposer(editor: Editor, width: number): string[] {
  const frameWidth = Math.max(32, Math.floor(width));
  const innerWidth = frameWidth - 4;
  const editorWidth = Math.max(8, innerWidth - 2);
  const rawLines = editor.render(editorWidth);
  const borderIndexes = rawLines
    .map((line, index) => ({ line: stripAnsi(line).trim(), index }))
    .filter(({ line }) => /^─+$/.test(line) || /^─── [↑↓] \d+ more/.test(line))
    .map(({ index }) => index);
  const firstBorder = borderIndexes[0] ?? -1;
  const secondBorder = borderIndexes.find((index) => index > firstBorder) ?? rawLines.length;
  const inputLines = rawLines.slice(firstBorder + 1, secondBorder);
  const completionLines = rawLines.slice(secondBorder + 1);
  const result = [accent(`╭─ chat ${"─".repeat(Math.max(1, frameWidth - 9))}╮`)];

  if (!inputLines.length) {
    result.push(frameLine(`${highlight("›")} `, innerWidth));
  } else {
    inputLines.forEach((line, index) => {
      const prefix = index === 0 ? `${highlight("›")} ` : "  ";
      result.push(frameLine(prefix + line, innerWidth));
    });
  }

  if (completionLines.length) {
    result.push(accent(`├─ suggestions ${"─".repeat(Math.max(1, frameWidth - 16))}┤`));
    for (const line of completionLines) {
      result.push(frameLine(line, innerWidth));
    }
  }

  result.push(accent(`╰${"─".repeat(frameWidth - 2)}╯`));
  return result.map((line) => padAnsi(line, frameWidth));
}

export async function runMusterChatTui(options: RunMusterChatTuiOptions): Promise<void> {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal, true);
  const editor = createMusterChatEditor(tui);
  const screen = new MusterChatScreen(tui, editor, options.statusLine, options.headerLines ?? []);
  editor.setAutocompleteProvider(createMusterAutocompleteProvider(options));
  editor.onSubmit = (text) => {
    void screen.submit(text, options.onSubmit);
  };
  tui.addChild(screen);
  tui.setFocus(editor);
  tui.addInputListener((data) => {
    if (data === "\x03" || data === "\x04") {
      screen.stop();
      return { consume: true };
    }
    if (isClearComposerKey(data)) {
      editor.handleInput("\x1b");
      editor.setText("");
      tui.requestRender(true);
      return { consume: true };
    }
    if ((matchesKey(data, "enter") || matchesKey(data, "return")) && isExitCommand(editor.getText())) {
      const text = editor.getText();
      editor.setText("");
      void screen.submit(text, options.onSubmit);
      return { consume: true };
    }
    if (matchesKey(data, "escape") && isBareCompletionTrigger(editor.getText())) {
      editor.handleInput(data);
      editor.setText("");
      return { consume: true };
    }
    return undefined;
  });
  await screen.refreshStatusLine();
  const rawEscapeHandler = (chunk: Buffer | string): void => {
    const data = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    if (data === "\x1b" && isBareCompletionTrigger(editor.getText())) {
      editor.handleInput(data);
      editor.setText("");
      tui.requestRender(true);
    }
  };
  await new Promise<void>((resolve) => {
    screen.onStop = resolve;
    tui.start();
    process.stdin.on("data", rawEscapeHandler);
    tui.requestRender(true);
  });
  process.stdin.off("data", rawEscapeHandler);
  tui.stop();
  await terminal.drainInput(150, 25).catch(() => {});
}

class MusterChatScreen implements Component, MusterChatSink {
  private readonly lines: string[] = [];
  private status = "";
  private stopped = false;
  onStop?: () => void;

  constructor(
    private readonly tui: TUI,
    private readonly editor: Editor,
    private readonly statusLine: () => string | Promise<string>,
    private headerLines: readonly string[],
  ) {}

  async refreshStatusLine(): Promise<void> {
    this.status = await this.statusLine();
  }

  appendLine(line: string): void {
    for (const part of String(line).split(/\r?\n/)) {
      this.lines.push(part);
    }
    this.trimTranscript();
    this.tui.requestRender();
  }

  appendUser(text: string): void {
    this.appendLine(`${highlight("›")} ${text}`);
  }

  clearTranscript(): void {
    this.lines.length = 0;
    this.tui.requestRender(true);
  }

  setHeaderLines(lines: readonly string[]): void {
    this.headerLines = lines;
    this.tui.requestRender(true);
  }

  setStatus(status: string): void {
    this.status = status;
    this.tui.requestRender();
  }

  clearStatus(): void {
    void this.refreshStatusLine().finally(() => this.tui.requestRender());
  }

  openPicker(command: string): void {
    this.editor.setText("");
    for (const char of command) this.editor.handleInput(char);
    this.tui.requestRender(true);
  }

  async submit(text: string, onSubmit: (text: string, sink: MusterChatSink) => Promise<boolean>): Promise<void> {
    const value = text.trim();
    if (!value || this.stopped) return;
    this.editor.disableSubmit = true;
    this.editor.addToHistory(value);
    this.appendUser(value);
    try {
      const keepGoing = await onSubmit(value, this);
      if (!keepGoing) this.stop();
    } catch (error) {
      this.appendLine(red(error instanceof Error ? error.message : String(error)));
    } finally {
      this.editor.disableSubmit = false;
      this.clearStatus();
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.onStop?.();
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  render(width: number): string[] {
    const frameWidth = Math.max(40, Math.min(width, 240));
    const composer = renderMusterComposer(this.editor, frameWidth);
    const rows = Math.max(12, this.tui.terminal.rows);
    const status = this.status ? [dim(truncateToWidth(this.status, frameWidth, ""))] : [];
    const fittedHeader = fitLines(this.headerLines, frameWidth);
    const freeRows = Math.max(0, rows - composer.length - status.length - 1);
    const reserveTranscriptRows = Math.min(6, Math.max(1, Math.floor(freeRows * 0.45)));
    const headerBudget = Math.max(0, freeRows - reserveTranscriptRows);
    const header = renderHeaderWindow(fittedHeader, headerBudget);
    const transcriptBudget = Math.max(1, rows - header.length - composer.length - status.length - 1);
    const transcript = renderTranscriptWindow(this.lines, frameWidth, transcriptBudget);
    return [...header, ...transcript, ...status, ...composer].map((line) => padAnsi(line, frameWidth));
  }

  handleInput(data: string): void {
    this.editor.handleInput(data);
  }

  private trimTranscript(): void {
    if (this.lines.length > 500) this.lines.splice(0, this.lines.length - 500);
  }
}

class HarnessSink implements MusterChatSink {
  readonly transcriptLines: string[] = [];
  private status = "";

  constructor(
    private readonly editor: Editor,
    private readonly onSubmit?: (text: string, sink: MusterChatSink) => Promise<boolean>,
  ) {}

  appendLine(line: string): void {
    for (const part of String(line).split(/\r?\n/)) this.transcriptLines.push(part);
  }

  appendUser(text: string): void {
    this.appendLine(`${highlight("›")} ${text}`);
  }

  clearTranscript(): void {
    this.transcriptLines.length = 0;
  }

  setHeaderLines(_lines: readonly string[]): void {}

  setStatus(status: string): void {
    this.status = status;
  }

  clearStatus(): void {
    this.status = "";
  }

  openPicker(command: string): void {
    this.editor.setText("");
    for (const char of command) this.editor.handleInput(char);
  }

  async submit(text: string): Promise<boolean> {
    const value = text.trim();
    if (!value) return true;
    this.editor.addToHistory(value);
    this.appendUser(value);
    const keepGoing = await (this.onSubmit?.(value, this) ?? Promise.resolve(true));
    this.clearStatus();
    void this.status;
    return keepGoing;
  }
}

function fakeHarnessTui(width: number, rows: number): Pick<TUI, "terminal" | "requestRender"> {
  return {
    terminal: { columns: width, rows },
    requestRender() {},
  } as Pick<TUI, "terminal" | "requestRender">;
}

export function renderTranscriptWindow(lines: readonly string[], width: number, budget: number): string[] {
  if (budget <= 0) return [];
  const latestUserIndex = findLatestUserLine(lines);
  if (latestUserIndex < 0) return lines.flatMap((line) => wrapLine(line, width)).slice(-budget);

  const before = lines.slice(0, latestUserIndex).flatMap((line) => wrapLine(line, width));
  const turn = lines.slice(latestUserIndex).flatMap((line) => wrapLine(line, width));
  if (turn.length <= budget) {
    return [...before.slice(-(budget - turn.length)), ...turn].slice(-budget);
  }

  const userLine = turn[0] ?? wrapLine(lines[latestUserIndex] ?? "", width)[0] ?? "";
  if (budget === 1) return [userLine];
  const pinned = turn.slice(1).filter(isPinnedReceiptLine);
  if (budget >= 3 && pinned.length) {
    const pinnedBudget = Math.min(pinned.length, budget - 2);
    const tailBudget = budget - 1 - pinnedBudget;
    return [userLine, ...pinned.slice(0, pinnedBudget), ...turn.slice(-tailBudget)].slice(0, budget);
  }
  return [userLine, ...turn.slice(-(budget - 1))].slice(0, budget);
}

export function isClearComposerKey(data: string): boolean {
  return data === "\x15";
}

function isPinnedReceiptLine(line: string): boolean {
  const clean = stripAnsi(line).trimStart();
  return clean.startsWith("memory backend=") || clean.startsWith("timings total=");
}

export function renderHeaderWindow(lines: readonly string[], budget: number): string[] {
  if (budget <= 0) return [];
  if (lines.length <= budget) return [...lines];
  if (budget === 1) return [lines.at(-1) ?? ""];
  if (budget === 2) return [lines[0] ?? "", lines.at(-1) ?? ""];
  const headCount = Math.max(1, Math.floor((budget - 1) / 2));
  const tailCount = Math.max(1, budget - headCount - 1);
  const width = Math.max(80, visibleWidth(lines[0] ?? ""));
  return [
    ...lines.slice(0, headCount),
    truncateToWidth(dim("… header collapsed to keep chat visible"), width, ""),
    ...lines.slice(-tailCount),
  ];
}

function findLatestUserLine(lines: readonly string[]): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (stripAnsi(lines[index] ?? "").trimStart().startsWith("› ")) return index;
  }
  return -1;
}

function slashCompletionContext(trimmed: string):
  | { kind: "command"; fragment: string; prefix: string }
  | { kind: "toolset"; fragment: string; prefix: string }
  | { kind: "session"; fragment: string; prefix: string }
  | { kind: "provider"; fragment: string; prefix: string }
  | { kind: "provider-model"; providerId: string; fragment: string; prefix: string }
  | { kind: "model"; fragment: string; prefix: string }
  | { kind: "runtime"; fragment: string; prefix: string }
  | { kind: "cloud"; fragment: string; prefix: string }
  | { kind: "speed"; fragment: string; prefix: string }
  | { kind: "capability"; fragment: string; prefix: string }
  | { kind: "skill"; fragment: string; prefix: string }
  | { kind: "plugin"; fragment: string; prefix: string }
  | { kind: "plugin-reuse-provider"; fragment: string; prefix: string }
  | { kind: "mcp"; fragment: string; prefix: string }
  | { kind: "integration"; fragment: string; prefix: string }
  | { kind: "integration-workflow"; fragment: string; prefix: string }
  | undefined {
  switch (trimmed.toLowerCase()) {
    case "/tools":
      return { kind: "toolset", fragment: "", prefix: trimmed };
    case "/resume":
    case "/name":
      return { kind: "session", fragment: "", prefix: trimmed };
    case "/provider":
    case "/use-provider":
      return { kind: "provider", fragment: "", prefix: trimmed };
    case "/model":
      return { kind: "model", fragment: "", prefix: trimmed };
    case "/runtime":
      return { kind: "runtime", fragment: "", prefix: trimmed };
    case "/cloud":
      return { kind: "cloud", fragment: "", prefix: trimmed };
    case "/speed":
      return { kind: "speed", fragment: "", prefix: trimmed };
    case "/capability":
    case "/capabilities":
    case "/caps":
      return { kind: "capability", fragment: "", prefix: trimmed };
    case "/skill":
    case "/skills":
      return { kind: "skill", fragment: "", prefix: trimmed };
    case "/plugin":
    case "/plugins":
      return { kind: "plugin", fragment: "", prefix: trimmed };
    case "/mcp":
      return { kind: "mcp", fragment: "", prefix: trimmed };
    case "/integration":
    case "/integrations":
      return { kind: "integration", fragment: "", prefix: trimmed };
    case "/integration workflow":
    case "/integrations workflow":
    case "/integration setup":
    case "/integrations setup":
    case "/integration verify":
    case "/integrations verify":
    case "/integration enable":
    case "/integrations enable":
    case "/integration sample":
    case "/integrations sample":
      return { kind: "integration-workflow", fragment: "", prefix: trimmed };
  }
  if (/^\/[a-z-]*$/i.test(trimmed)) return { kind: "command", fragment: trimmed.slice(1), prefix: trimmed };
  const toolMatch = trimmed.match(/^\/tools\s+([^\s]*)$/i);
  if (toolMatch) return { kind: "toolset", fragment: toolMatch[1] ?? "", prefix: trimmed };
  const sessionMatch = trimmed.match(/^\/(?:resume|name)\s+([^\s]*)$/i);
  if (sessionMatch) return { kind: "session", fragment: sessionMatch[1] ?? "", prefix: trimmed };
  const providerModelMatch = trimmed.match(/^\/(?:provider|use-provider)\s+([^\s]+)\s+([^\s]*)$/i);
  if (providerModelMatch) return { kind: "provider-model", providerId: providerModelMatch[1] ?? "", fragment: providerModelMatch[2] ?? "", prefix: trimmed };
  const providerMatch = trimmed.match(/^\/(?:provider|use-provider)\s+([^\s]*)$/i);
  if (providerMatch) return { kind: "provider", fragment: providerMatch[1] ?? "", prefix: trimmed };
  const modelMatch = trimmed.match(/^\/model\s+([^\s]*)$/i);
  if (modelMatch) return { kind: "model", fragment: modelMatch[1] ?? "", prefix: trimmed };
  const runtimeMatch = trimmed.match(/^\/runtime\s+([^\s]*)$/i);
  if (runtimeMatch) return { kind: "runtime", fragment: runtimeMatch[1] ?? "", prefix: trimmed };
  const cloudMatch = trimmed.match(/^\/cloud\s+([^\s]*)$/i);
  if (cloudMatch) return { kind: "cloud", fragment: cloudMatch[1] ?? "", prefix: trimmed };
  const speedMatch = trimmed.match(/^\/speed\s+([^\s]*)$/i);
  if (speedMatch) return { kind: "speed", fragment: speedMatch[1] ?? "", prefix: trimmed };
  const capabilityMatch = trimmed.match(/^\/(?:capabilities|capability|caps)\s+([^\s]*)$/i);
  if (capabilityMatch) return { kind: "capability", fragment: capabilityMatch[1] ?? "", prefix: trimmed };
  const skillMatch = trimmed.match(/^\/skills?\s+([^\s]*)$/i);
  if (skillMatch) return { kind: "skill", fragment: skillMatch[1] ?? "", prefix: trimmed };
  const pluginReuseMatch = trimmed.match(/^\/plugins?\s+reuse(?:\s+([^\s]*))?$/i);
  if (pluginReuseMatch) return { kind: "plugin-reuse-provider", fragment: pluginReuseMatch[1] ?? "", prefix: trimmed };
  const pluginMatch = trimmed.match(/^\/plugins?\s+([^\s]*)$/i);
  if (pluginMatch) return { kind: "plugin", fragment: pluginMatch[1] ?? "", prefix: trimmed };
  const mcpMatch = trimmed.match(/^\/mcp\s+([^\s]*)$/i);
  if (mcpMatch) return { kind: "mcp", fragment: mcpMatch[1] ?? "", prefix: trimmed };
  const integrationWorkflowMatch = trimmed.match(/^\/integrations?\s+(?:workflow|setup|verify|enable|sample)\s+([^\s]*)$/i);
  if (integrationWorkflowMatch) return { kind: "integration-workflow", fragment: integrationWorkflowMatch[1] ?? "", prefix: trimmed };
  const integrationMatch = trimmed.match(/^\/integrations?\s+([^\s]*)$/i);
  if (integrationMatch) return { kind: "integration", fragment: integrationMatch[1] ?? "", prefix: trimmed };
  return undefined;
}

function filterPickerOptions(options: readonly PickerOption[], fragment: string): AutocompleteItem[] {
  const lower = fragment.toLowerCase();
  return options
    .map((option, index) => ({ option, index, rank: pickerMatchRank(option, lower) }))
    .filter((entry) => entry.rank < Number.POSITIVE_INFINITY)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((option) => ({
      value: option.option.value,
      label: option.option.label ?? option.option.value,
      description: option.option.description,
    }));
}

function pickerMatchRank(option: PickerOption, lowerFragment: string): number {
  if (!lowerFragment) return 0;
  const value = option.value.toLowerCase();
  const label = option.label?.toLowerCase() ?? "";
  const description = option.description?.toLowerCase() ?? "";
  if (value.startsWith(lowerFragment)) return 0;
  if (label.startsWith(lowerFragment)) return 1;
  if (value.includes(lowerFragment)) return 2;
  if (label.includes(lowerFragment)) return 3;
  if (description.includes(lowerFragment)) return 4;
  return Number.POSITIVE_INFINITY;
}

function pickerOptionsToItems(options: readonly PickerOption[]): AutocompleteItem[] {
  return options.map((option) => ({
    value: option.value,
    label: option.label ?? option.value,
    description: option.description,
  }));
}

function createCallbackCompletionCatalog(options: MusterAutocompleteOptions): MusterCompletionCatalog {
  return {
    async complete(request) {
      switch (request.kind) {
        case "command":
          return options.commands
            .filter((command) => command.name.startsWith(request.fragment.toLowerCase()) || command.aliases?.some((alias) => alias.startsWith(request.fragment.toLowerCase())))
            .map((command) => ({ value: `/${command.name}`, label: command.usage, description: command.description }));
        case "toolset":
          return filterPickerOptions(options.toolsets.map((toolset) => ({ value: toolset, label: toolset, description: "toolset" })), request.fragment);
        case "session":
          return filterPickerOptions(options.recentSessions().map((name) => ({ value: name, label: name, description: "chat session" })), request.fragment);
        case "provider":
          return filterPickerOptions(await options.providers?.() ?? [], request.fragment);
        case "provider-model":
          return filterPickerOptions(await options.models?.({ providerId: request.providerId }) ?? [], request.fragment);
        case "model":
          return filterPickerOptions(await options.models?.({}) ?? [], request.fragment);
        case "runtime":
          return filterPickerOptions(await options.runtimes?.() ?? [], request.fragment);
        case "cloud":
          return filterPickerOptions(await options.clouds?.() ?? [], request.fragment);
        case "speed":
          return filterPickerOptions(await options.speeds?.() ?? [], request.fragment);
        case "capability": {
          const capabilities = await options.capabilities?.();
          return filterPickerOptions(capabilities ?? [
            ...((await options.skills?.()) ?? []),
            ...((await options.plugins?.()) ?? []),
            ...((await options.mcpServers?.()) ?? []),
          ], request.fragment);
        }
        case "skill":
          return filterPickerOptions(await options.skills?.() ?? [], request.fragment);
        case "plugin":
          return filterPickerOptions(await options.plugins?.() ?? [], request.fragment);
        case "plugin-reuse-provider":
          return filterPickerOptions(await options.pluginReuseProviders?.() ?? [], request.fragment);
        case "mcp":
          return filterPickerOptions(await options.mcpServers?.() ?? [], request.fragment);
        case "integration":
          return filterPickerOptions(await options.integrations?.() ?? [], request.fragment);
        case "integration-workflow":
          return filterPickerOptions(await options.integrationWorkflows?.() ?? await options.integrations?.() ?? [], request.fragment);
        case "agent": {
          const fragment = request.fragment.toLowerCase();
          return [...new Set(await options.agents())]
            .filter((agent) => agent.toLowerCase().startsWith(fragment))
            .map((agent) => ({ value: `@${agent}`, label: `@${agent}`, description: "route this turn" }));
        }
      }
    },
  };
}

function agentCompletionFragment(trimmed: string): string | undefined {
  const match = trimmed.match(/^@([a-zA-Z0-9_.:-]*)$/);
  return match?.[1];
}

function completionReplacement(beforeCursor: string, item: AutocompleteItem, prefix: string): string {
  const trimmed = beforeCursor.trimStart();
  switch (trimmed.toLowerCase()) {
    case "/tools":
      return `/tools ${item.value}`;
    case "/resume":
      return `/resume ${item.value}`;
    case "/name":
      return `/name ${item.value}`;
    case "/provider":
    case "/use-provider":
      return `/provider ${item.value}`;
    case "/model":
      return `/model ${item.value}`;
    case "/runtime":
      return `/runtime ${item.value}`;
    case "/cloud":
      return `/cloud ${item.value}`;
    case "/speed":
      return `/speed ${item.value}`;
    case "/capability":
    case "/capabilities":
    case "/caps":
      return `/capabilities ${item.value}`;
    case "/skill":
    case "/skills":
      return `/skills ${item.value}`;
    case "/plugin":
    case "/plugins":
      return `/plugins ${item.value}`;
    case "/mcp":
      return `/mcp ${item.value}`;
    case "/integration":
    case "/integrations":
      return `/integrations ${item.value}`;
    case "/integration workflow":
    case "/integrations workflow":
      return `/integrations workflow ${item.value}`;
    case "/integration setup":
    case "/integrations setup":
      return `/integrations setup ${item.value}`;
    case "/integration verify":
    case "/integrations verify":
      return `/integrations verify ${item.value}`;
    case "/integration enable":
    case "/integrations enable":
      return `/integrations enable ${item.value}`;
    case "/integration sample":
    case "/integrations sample":
      return `/integrations sample ${item.value}`;
  }
  if (/^\/tools\s+/i.test(trimmed)) return `/tools ${item.value}`;
  if (/^\/resume\s+/i.test(trimmed)) return `/resume ${item.value}`;
  if (/^\/name\s+/i.test(trimmed)) return `/name ${item.value}`;
  const providerModel = trimmed.match(/^\/(?:provider|use-provider)\s+(\S+)\s+/i);
  if (providerModel) return `/provider ${providerModel[1]} ${item.value}`;
  if (/^\/(?:provider|use-provider)\s+/i.test(trimmed)) return `/provider ${item.value}`;
  if (/^\/model\s+/i.test(trimmed)) return `/model ${item.value}`;
  if (/^\/runtime\s+/i.test(trimmed)) return `/runtime ${item.value}`;
  if (/^\/cloud\s+/i.test(trimmed)) return `/cloud ${item.value}`;
  if (/^\/speed\s+/i.test(trimmed)) return `/speed ${item.value}`;
  if (/^\/(?:capabilities|capability|caps)\s+/i.test(trimmed)) return `/capabilities ${item.value}`;
  if (/^\/skills?\s+/i.test(trimmed)) return `/skills ${item.value}`;
  if (/^\/plugins?\s+reuse(?:\s+.*)?$/i.test(trimmed)) return `/plugins reuse ${item.value}`;
  if (/^\/plugins?\s+/i.test(trimmed)) return `/plugins ${item.value}`;
  if (/^\/mcp\s+/i.test(trimmed)) return `/mcp ${item.value}`;
  const integrationAction = trimmed.match(/^\/integrations?\s+(workflow|setup|verify|enable|sample)\s+/i);
  if (integrationAction) return `/integrations ${integrationAction[1]?.toLowerCase()} ${item.value}`;
  if (/^\/integrations?\s+/i.test(trimmed)) return `/integrations ${item.value}`;
  return item.value;
}

export function isBareCompletionTrigger(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === "/" || trimmed === "@";
}

function isExitCommand(text: string): boolean {
  return /^\/(?:exit|quit|q)\s*$/i.test(text.trim());
}

function musterEditorTheme(): EditorTheme {
  return {
    borderColor: accent,
    selectList: {
      selectedPrefix: highlight,
      selectedText: (text) => `\x1b[48;2;${SELECTION_BG_RGB}m\x1b[30;1m${text}`,
      description: dim,
      scrollInfo: accent,
      noMatch: dim,
    },
  };
}

function frameLine(content: string, innerWidth: number): string {
  const padded = padAnsi(content, innerWidth);
  return `${accent("│ ")}${padded}${RESET}${accent(" │")}`;
}

function wrapLine(line: string, width: number): string[] {
  const cleanWidth = Math.max(10, width - 2);
  if (visibleWidth(line) <= cleanWidth) return [line];
  const chunks: string[] = [];
  const plain = stripAnsi(line);
  let rest = plain;
  while (visibleWidth(rest) > cleanWidth) {
    const chunk = truncateToWidth(rest, cleanWidth, "");
    chunks.push(chunk);
    rest = rest.slice(chunk.length);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function fitLines(lines: readonly string[], width: number): string[] {
  return lines.map((line) => truncateToWidth(line, width, ""));
}

function padAnsi(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function accent(text: string): string {
  return color(text, ACCENT_RGB);
}

function highlight(text: string): string {
  return color(text, HIGHLIGHT_RGB);
}

function dim(text: string): string {
  return color(text, MUTED_RGB);
}

function red(text: string): string {
  return color(text, RED_RGB);
}

function color(text: string, rgb: string): string {
  if (process.env.NO_COLOR) return text;
  return `\x1b[38;2;${rgb}m${text}${RESET}`;
}
