/**
 * Chat-embedded orchestration — the kanban engine's user surface.
 *
 * `packages/core/src/agent-kanban.ts` shipped an event-sourced board with a
 * 9-gate explainable model selector and a context-bundle seam, and then had
 * ZERO way for a human to reach it: no command, no render, no persistence.
 * An audit surface nobody can open audits nothing. This module is the door,
 * and it opens INSIDE the conversation (docs/PRODUCT_MODES.md — "a mode
 * renders events; it never invents state"), not in a separate app:
 *
 *   /tasks "<goal>"                 plan → select → execute → stream typed cards
 *   /tasks                          the columns, with model + score per assignment
 *   /tasks why <taskId>             the full 9-gate table behind one assignment
 *   /tasks assign <taskId> <card>   manual override, recorded as an event
 *
 * FOUR RULES, enforced everywhere below:
 *
 * 1. EVERY MUTATION IS AN EVENT. Nothing here writes board state directly.
 *    `commit()` runs `reduceKanbanEvent` FIRST and only appends to the JSONL
 *    once the reducer accepted it, so a rejected transition leaves no trace and
 *    the log on disk always replays to exactly the state the user was shown.
 *
 * 2. RENDERING IS PURE. Every `render*` function takes plain data and returns
 *    lines. No clock, no board, no terminal, no I/O — which is what makes the
 *    cards snapshot-testable with ANSI stripped.
 *
 * 3. SELECTION RUNS AGAINST AUTHENTICATED REALITY. The 20-card seed is filtered
 *    to backends this machine can actually drive (`codex login status`, `claude`
 *    on PATH) before a single gate is evaluated. One backend → selection still
 *    runs and `/tasks why` shows which gates the others died at. Zero backends → the
 *    tasks are escalated to `needs_intervention` rather than pretending.
 *
 * 4. THE MISSION NARRATES WHILE IT RUNS. Assignment, live narration and
 *    completion are emitted from inside the execution loop, so the transcript
 *    reads like the work, not like a report written after it.
 */

import { mkdir, readFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  KANBAN_CAPABILITIES,
  MODEL_CARD_SEED,
  SELECTION_GATE_ORDER,
  createKanbanBoardState,
  dataDir,
  nextKanbanEvent,
  reduceKanbanEvent,
  selectModelForTask,
  snapshotKanbanBoard,
  validateKanbanTask,
  type KanbanBoardSnapshot,
  type KanbanBoardState,
  type KanbanEvent,
  type KanbanEventBody,
  type KanbanEventEnvelope,
  type KanbanPriority,
  type KanbanStatus,
  type KanbanTask,
  type ModelCard,
  type ModelSelection,
  type SelectionCandidate,
  type SelectionGateId,
  type SelectionPolicy,
  type SelectionScoreBreakdown,
  type TaskAssignment,
} from "@musterhq/core";

/* ---------- palette (live-diff.ts / chat-tui.ts, same dark-console values) ---------- */

const RESET = "\x1b[0m";
const ACCENT_RGB = "217;119;87";
const OK_RGB = "138;154;91";
const WARN_RGB = "247;198;106";
const BAD_RGB = "255;107;122";
const MUTED_RGB = "148;144;140";

function paint(value: string, rgb: string, enabled: boolean): string {
  return enabled ? `\x1b[38;2;${rgb}m${value}${RESET}` : value;
}

/** Test helper mirror of the CLI's own stripper; exported so callers can assert plain text. */
export function stripOrchestrationAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function colorEnabled(explicit: boolean | undefined): boolean {
  if (explicit !== undefined) return explicit;
  return !process.env.NO_COLOR;
}

function padEnd(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function clip(value: string, width: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= width ? flat : `${flat.slice(0, Math.max(0, width - 1))}…`;
}

function displayTaskSetId(boardId: string): string {
  return boardId.replace(/^board\./, "tasks.");
}

// ============================================================================
// 1. Command parsing
// ============================================================================

export type OrchestrationCommand =
  | { readonly kind: "mission"; readonly goal: string }
  | { readonly kind: "board" }
  | { readonly kind: "why"; readonly taskId: string }
  | { readonly kind: "assign"; readonly taskId: string; readonly cardId: string }
  | { readonly kind: "usage"; readonly usage: string };

/** Command names this module owns, in catalog order. */
export const ORCHESTRATION_COMMAND_NAMES: readonly string[] = ["tasks"];

const TASKS_USAGE = 'Usage: /tasks board | /tasks "<goal>" | /tasks why <taskId> | /tasks assign <taskId> <cardId>';
const WHY_USAGE = "Usage: /tasks why <taskId> — show the 9-gate table behind that assignment";
const ASSIGN_USAGE = "Usage: /tasks assign <taskId> <cardId> — override the routed model (recorded as user-override)";

/**
 * Quotes are stripped, not required: `/tasks "ship X"` and `/tasks ship X`
 * mean the same thing, and a smart-quoted paste from a chat client works too.
 */
function unquote(value: string): string {
  const trimmed = value.trim();
  const pairs: readonly (readonly [string, string])[] = [["\"", "\""], ["'", "'"], ["“", "”"], ["‘", "’"]];
  for (const [open, close] of pairs) {
    if (trimmed.length >= 2 && trimmed.startsWith(open) && trimmed.endsWith(close)) return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/**
 * Parse one chat line. Returns undefined when the line is not an orchestration
 * command at all, so the caller's existing dispatch is untouched.
 */
export function parseChatOrchestrationCommand(text: string): OrchestrationCommand | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const match = /^\/([a-zA-Z-]+)\s*([\s\S]*)$/.exec(trimmed);
  if (!match) return undefined;
  return parseOrchestrationInvocation(match[1]!.toLowerCase(), match[2] ?? "");
}

/** Shared by the chat dispatcher (already split into name + args) and the parser above. */
export function parseOrchestrationInvocation(name: string, args: string): OrchestrationCommand | undefined {
  const rest = args.trim();
  switch (name) {
    case "tasks": {
      if (!rest) return { kind: "board" };
      const [action, ...parts] = rest.split(/\s+/);
      if (action === "board") return parts.length === 0 ? { kind: "board" } : { kind: "usage", usage: TASKS_USAGE };
      if (action === "why") return parts[0] ? { kind: "why", taskId: parts[0] } : { kind: "usage", usage: WHY_USAGE };
      if (action === "assign") return parts.length >= 2
        ? { kind: "assign", taskId: parts[0]!, cardId: parts.slice(1).join(" ") }
        : { kind: "usage", usage: ASSIGN_USAGE };
      const goal = unquote(rest);
      return goal ? { kind: "mission", goal } : { kind: "usage", usage: TASKS_USAGE };
    }
    case "mission": {
      const goal = unquote(rest);
      return goal ? { kind: "mission", goal } : { kind: "usage", usage: TASKS_USAGE };
    }
    case "board":
      return { kind: "board" };
    case "why": {
      const taskId = rest.split(/\s+/)[0] ?? "";
      return taskId ? { kind: "why", taskId } : { kind: "usage", usage: WHY_USAGE };
    }
    case "assign": {
      const parts = rest.split(/\s+/).filter(Boolean);
      return parts.length >= 2
        ? { kind: "assign", taskId: parts[0]!, cardId: parts.slice(1).join(" ") }
        : { kind: "usage", usage: ASSIGN_USAGE };
    }
    default:
      return undefined;
  }
}

export const BOARD_CLI_USAGE = "Usage: muster tasks [list] | muster tasks why <taskId> | muster tasks assign <taskId> <cardId>";

/** The non-chat door: `muster tasks <list|why|assign>` maps onto the same handlers. */
export function parseBoardCliCommand(args: readonly string[]): OrchestrationCommand {
  const [action, ...rest] = args.filter((entry) => !entry.startsWith("--"));
  if (action === undefined || action === "list" || action === "ls") return { kind: "board" };
  if (action === "why") return rest[0] ? { kind: "why", taskId: rest[0] } : { kind: "usage", usage: BOARD_CLI_USAGE };
  if (action === "assign") {
    return rest.length >= 2 ? { kind: "assign", taskId: rest[0]!, cardId: rest.slice(1).join(" ") } : { kind: "usage", usage: BOARD_CLI_USAGE };
  }
  return { kind: "usage", usage: BOARD_CLI_USAGE };
}

// ============================================================================
// 2. Authenticated reality — which cards may even be considered
// ============================================================================

export interface BackendAuth {
  /** `codex login status` exits 0. */
  readonly codex: boolean;
  /** `claude` resolves on PATH. */
  readonly claude: boolean;
}

/** Card provider ids that a local backend actually drives. */
export const BACKEND_CARD_PROVIDERS: Readonly<Record<keyof BackendAuth, string>> = {
  codex: "codex-cli",
  claude: "claude-code",
};

/**
 * Filter the 20-card seed to backends this machine can drive. Only `cli`
 * deployments qualify: an API-keyed cloud card is not "authenticated" just
 * because it exists in the seed, and routing to one would fail at run time.
 */
export function authenticatedModelCards(auth: BackendAuth, cards: readonly ModelCard[] = MODEL_CARD_SEED): readonly ModelCard[] {
  const providers = new Set<string>();
  if (auth.codex) providers.add(BACKEND_CARD_PROVIDERS.codex);
  if (auth.claude) providers.add(BACKEND_CARD_PROVIDERS.claude);
  return cards.filter((card) => card.retired !== true && card.deployment === "cli" && providers.has(card.provider));
}

export function describeBackendAuth(auth: BackendAuth): string {
  return `codex ${auth.codex ? "authenticated" : "unavailable"} · claude ${auth.claude ? "on PATH" : "unavailable"}`;
}

// ============================================================================
// 3. Mission planning — model output → KanbanTasks
// ============================================================================

export const MISSION_MIN_TASKS = 2;
export const MISSION_MAX_TASKS = 5;
/** Clamp so a hallucinated estimate cannot fail the reducer's window gate. */
export const MISSION_MAX_CONTEXT_TOKENS = 120_000;

const PRIORITIES: readonly KanbanPriority[] = ["critical", "high", "normal", "low"];

export function buildMissionPlanPrompt(goal: string, cards: readonly ModelCard[]): string {
  const capabilities = cards.length > 0
    ? [...new Set(cards.flatMap((card) => card.capabilities))].sort()
    : [...KANBAN_CAPABILITIES];
  const strengths = [...new Set(cards.flatMap((card) => card.strengths))].sort();
  return [
    "You plan parallel tasks for governed agents. Split the goal below into",
    `${MISSION_MIN_TASKS} to ${MISSION_MAX_TASKS} independently executable tasks.`,
    "",
    `GOAL: ${goal}`,
    "",
    "Reply with ONE json object and nothing else, in this exact shape:",
    '{"tasks":[{"title":"short imperative title","goal":"what the agent must do, self-contained",',
    '"requiredCapabilities":["code_edit"],"preferredStrengths":["refactoring"],"dependsOn":[],',
    '"priority":"normal","estimatedContextTokens":8000}]}',
    "",
    `requiredCapabilities MUST come from: ${capabilities.join(", ")}`,
    strengths.length > 0 ? `preferredStrengths SHOULD come from: ${strengths.join(", ")}` : "",
    "priority is one of critical, high, normal, low.",
    "dependsOn refers to the 1-based index of an earlier task as \"t1\", \"t2\", ... and must be acyclic.",
    "Order the tasks so dependencies come first. Do not invent files you have not been told exist.",
  ].filter(Boolean).join("\n");
}

export interface MissionPlanResult {
  readonly tasks: readonly KanbanTask[];
  /** Non-fatal normalizations and dropped fields, surfaced to the user verbatim. */
  readonly issues: readonly string[];
}

/** First balanced JSON object in a blob that may be fenced, prefixed or chatty. */
function extractJsonObject(raw: string): string | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const haystack = fenced ? fenced[1]! : raw;
  const start = haystack.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < haystack.length; index += 1) {
    const character = haystack[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return haystack.slice(start, index + 1);
    }
  }
  return undefined;
}

function textField(value: unknown, fallback: string, max: number): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  const chosen = text || fallback;
  return chosen.length > max ? `${chosen.slice(0, max - 1)}…` : chosen;
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0) : [];
}

/**
 * Parse the planner's reply into board-legal tasks. Deliberately forgiving about
 * shape and unforgiving about content: anything the reducer would reject is
 * normalized here (or reported), so a sloppy plan never lands a corrupt event.
 */
export function parseMissionPlan(raw: string, options: {
  readonly createdAt: string;
  /** First numeric suffix to use, so a second mission on the same board keeps counting. */
  readonly startIndex?: number;
  /** Capabilities the authenticated cards actually offer; used only for reporting. */
  readonly availableCapabilities?: readonly string[];
}): MissionPlanResult {
  const issues: string[] = [];
  const json = extractJsonObject(raw);
  if (!json) return { tasks: [], issues: ["planner returned no JSON object"] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return { tasks: [], issues: [`planner JSON did not parse: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const rawTasks = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { tasks?: unknown }).tasks) ? (parsed as { tasks: unknown[] }).tasks : [];
  if (rawTasks.length === 0) return { tasks: [], issues: ["planner produced no tasks"] };
  if (rawTasks.length > MISSION_MAX_TASKS) issues.push(`planner returned ${rawTasks.length} tasks; kept the first ${MISSION_MAX_TASKS}`);

  const start = options.startIndex ?? 1;
  const kept = rawTasks.slice(0, MISSION_MAX_TASKS);
  // Planner-local labels ("t1", "1", a title) map onto the board's real ids.
  const idByLabel = new Map<string, string>();
  kept.forEach((entry, index) => {
    const id = `t${start + index}`;
    idByLabel.set(`t${index + 1}`, id);
    idByLabel.set(String(index + 1), id);
    if (entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string") {
      idByLabel.set((entry as { id: string }).id.trim().toLowerCase(), id);
    }
  });

  const available = new Set(options.availableCapabilities ?? []);
  const known = new Set(KANBAN_CAPABILITIES);
  const tasks: KanbanTask[] = [];
  kept.forEach((entry, index) => {
    const record = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const id = `t${start + index}`;
    const requested = stringList(record.requiredCapabilities).map((capability) => capability.trim().toLowerCase());
    const capabilities = requested.filter((capability) => known.has(capability));
    for (const capability of requested) {
      if (!known.has(capability)) issues.push(`${id}: dropped unknown capability "${capability}"`);
      else if (available.size > 0 && !available.has(capability)) issues.push(`${id}: no authenticated backend offers "${capability}"`);
    }
    if (capabilities.length === 0) {
      capabilities.push("code_edit");
      issues.push(`${id}: no usable capability declared; defaulted to code_edit`);
    }
    const dependsOn = [...new Set(stringList(record.dependsOn)
      .map((label) => idByLabel.get(label.trim().toLowerCase()))
      .filter((mapped): mapped is string => typeof mapped === "string" && mapped !== id))]
      // Forward references would deadlock the wave loop; only earlier tasks may gate.
      .filter((mapped) => Number(mapped.slice(1)) < start + index);
    const priority = PRIORITIES.includes(record.priority as KanbanPriority) ? (record.priority as KanbanPriority) : "normal";
    const rawTokens = typeof record.estimatedContextTokens === "number" && Number.isFinite(record.estimatedContextTokens)
      ? Math.max(0, Math.floor(record.estimatedContextTokens))
      : 0;
    const estimatedContextTokens = Math.min(rawTokens, MISSION_MAX_CONTEXT_TOKENS);
    if (rawTokens > MISSION_MAX_CONTEXT_TOKENS) issues.push(`${id}: clamped context estimate ${rawTokens} to ${MISSION_MAX_CONTEXT_TOKENS}`);
    const title = textField(record.title, `task ${id}`, 80);
    const task: KanbanTask = {
      id,
      title,
      goal: textField(record.goal ?? record.description, title, 2000),
      requiredCapabilities: [...new Set(capabilities)],
      preferredStrengths: [...new Set(stringList(record.preferredStrengths).map((strength) => strength.trim()))],
      contextRefs: [],
      dependsOn,
      priority,
      ...(estimatedContextTokens > 0 ? { estimatedContextTokens } : {}),
      createdAt: options.createdAt,
    };
    const problems = validateKanbanTask(task);
    if (problems.length > 0) issues.push(`${id}: dropped (${problems.join("; ")})`);
    else tasks.push(task);
  });

  if (tasks.length > 0 && tasks.length < MISSION_MIN_TASKS) {
    issues.push(`planner produced ${tasks.length} task; the contract asks for ${MISSION_MIN_TASKS}-${MISSION_MAX_TASKS} (running it anyway)`);
  }
  return { tasks, issues };
}

// ============================================================================
// 4. Event-sourced persistence — one JSONL per named chat session
// ============================================================================

export const BOARD_TENANT_ID = "local";

export function boardEventsPath(sessionName: string, cwd: string = process.cwd()): string {
  const safe = sessionName.replace(/[^a-zA-Z0-9._-]/g, "_") || "main";
  return join(dataDir(cwd), "boards", `${safe}.jsonl`);
}

export function boardIdForSession(sessionName: string): string {
  const safe = sessionName.replace(/[^a-zA-Z0-9._-]/g, "_") || "main";
  return `board.${safe}`;
}

export async function readBoardEvents(sessionName: string, cwd: string = process.cwd()): Promise<readonly KanbanEvent[]> {
  let raw = "";
  try {
    raw = await readFile(boardEventsPath(sessionName, cwd), "utf8");
  } catch {
    return [];
  }
  const events: KanbanEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as KanbanEvent);
    } catch {
      // A torn tail line is skipped, never guessed at: the reducer would reject
      // it anyway and a mid-write crash must not make the board unopenable.
    }
  }
  return events;
}

export interface BoardStore {
  readonly sessionName: string;
  readonly cwd: string;
  readonly path: string;
  state(): KanbanBoardState;
  /** Reduce first, append only on acceptance. Throws KanbanEventConflictError otherwise. */
  commit(
    envelope: Pick<KanbanEventEnvelope, "actorId" | "actorKind" | "summary"> & { readonly evidenceIds?: readonly string[] },
    body: KanbanEventBody,
  ): Promise<KanbanBoardState>;
}

export interface OpenBoardOptions {
  readonly sessionName: string;
  readonly cwd?: string;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/**
 * Replay the session's log into live state. `undefined` identity fields on the
 * first event are authoritative, so a board written by an older CLI still
 * replays byte-identically.
 */
export async function openBoardStore(options: OpenBoardOptions): Promise<BoardStore> {
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => `kbe_${randomUUID().slice(0, 12)}`);
  const path = boardEventsPath(options.sessionName, cwd);
  const events = await readBoardEvents(options.sessionName, cwd);
  const identity = events[0]
    ? { boardId: events[0].boardId, tenantId: events[0].tenantId, siteId: events[0].siteId }
    : { boardId: boardIdForSession(options.sessionName), tenantId: BOARD_TENANT_ID, siteId: undefined };
  let state = createKanbanBoardState(identity);
  let writes: Promise<void> = Promise.resolve();
  for (const event of events) {
    try {
      state = reduceKanbanEvent(state, event);
    } catch {
      // Stop at the first event the reducer refuses: replaying past a rejected
      // event would present state the log does not actually justify.
      break;
    }
  }
  return {
    sessionName: options.sessionName,
    cwd,
    path,
    state: () => state,
    commit(envelope, body) {
      const write = writes.then(async () => {
      // Clock skew must never make the log unreplayable (`assertEnvelope` rejects
      // a timestamp that moves backwards), so time is monotonic per board.
      const wall = now().toISOString();
      const at = state.lastEventAt && Date.parse(wall) < Date.parse(state.lastEventAt) ? state.lastEventAt : wall;
      const event = nextKanbanEvent(state, { id: newId(), at, ...envelope }, body) as KanbanEvent;
      const next = reduceKanbanEvent(state, event);
      // The reducer treats a repeated event id as duplicate transport delivery and
      // returns the SAME state. Appending anyway would put a line in the log that
      // replay ignores, so the file and the board would disagree forever. A
      // colliding id is a caller bug (production ids are randomUUID-derived), and
      // it fails loudly here rather than corrupting the log.
      if (next === state) {
        throw new Error(`Task event id "${event.id}" is already applied to ${displayTaskSetId(state.boardId)}; event ids must be unique per task set.`);
      }
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(event)}\n`);
      state = next;
      return state;
      });
      writes = write.then(() => undefined, () => undefined);
      return write;
    },
  };
}

// ============================================================================
// 5. Rendering — pure, snapshot-testable
// ============================================================================

export interface RenderOptions {
  readonly color?: boolean;
  readonly width?: number;
}

const STATUS_GLYPH: Readonly<Record<KanbanStatus, string>> = {
  backlog: "·",
  ready: "○",
  assigned: "◔",
  in_progress: "◑",
  review: "◕",
  done: "●",
  blocked: "◼",
  needs_intervention: "!",
};

export function formatUsd(value: number | undefined): string {
  if (value === undefined) return "cost unpriced";
  return `$${value < 0.01 && value > 0 ? value.toFixed(4) : value.toFixed(2)}`;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export interface AssignedCardInput {
  readonly taskId: string;
  readonly title: string;
  readonly cardId: string;
  readonly total: number;
}

/** "◔ t1 rate-limiter → claude-code/claude-fable-5 (768)" */
export function renderTaskAssignedCard(input: AssignedCardInput, options: RenderOptions = {}): string {
  const on = colorEnabled(options.color);
  return [
    paint("◔", ACCENT_RGB, on),
    paint(input.taskId, ACCENT_RGB, on),
    clip(input.title, 44),
    "→",
    paint(input.cardId, OK_RGB, on),
    paint(`(${input.total})`, MUTED_RGB, on),
  ].join(" ");
}

/** The live line under the active task; one line, always truncated. */
export function renderTaskNarrationLine(taskId: string, text: string, options: RenderOptions = {}): string {
  const on = colorEnabled(options.color);
  const width = Math.max(24, (options.width ?? 100) - 12);
  return `  ${paint("⎿", MUTED_RGB, on)} ${paint(taskId, MUTED_RGB, on)} ${paint(clip(text, width), MUTED_RGB, on)}`;
}

export interface DoneCardInput {
  readonly taskId: string;
  readonly detail: string;
  readonly costUsd?: number;
  readonly ok?: boolean;
}

/** "● t1 done · 14 tests pass · $0.04" (or the blocked variant, same shape). */
export function renderTaskDoneCard(input: DoneCardInput, options: RenderOptions = {}): string {
  const on = colorEnabled(options.color);
  const ok = input.ok !== false;
  const glyph = paint(ok ? "●" : "◼", ok ? OK_RGB : BAD_RGB, on);
  const verb = paint(ok ? "done" : "blocked", ok ? OK_RGB : BAD_RGB, on);
  return `${glyph} ${paint(input.taskId, ACCENT_RGB, on)} ${verb} · ${clip(input.detail, 60)} · ${paint(formatUsd(input.costUsd), MUTED_RGB, on)}`;
}

export interface MissionSummaryInput {
  readonly goal: string;
  readonly boardId: string;
  readonly elapsedMs: number;
  readonly costUsd?: number;
  readonly tasks: readonly {
    readonly taskId: string;
    readonly title: string;
    readonly status: KanbanStatus;
    readonly cardId?: string;
    readonly total?: number;
    readonly costUsd?: number;
  }[];
}

export function renderMissionSummaryCard(input: MissionSummaryInput, options: RenderOptions = {}): readonly string[] {
  const on = colorEnabled(options.color);
  const done = input.tasks.filter((task) => task.status === "done").length;
  const stalled = input.tasks.filter((task) => task.status === "blocked" || task.status === "needs_intervention").length;
  const lines: string[] = [
    paint(`── tasks ${displayTaskSetId(input.boardId)} · ${clip(input.goal, 56)}`, ACCENT_RGB, on),
    `   ${input.tasks.length} task(s) · ${done} done · ${stalled} stalled · ${formatUsd(input.costUsd)} · ${formatDuration(input.elapsedMs)}`,
  ];
  for (const task of input.tasks) {
    const glyph = STATUS_GLYPH[task.status];
    const routed = task.cardId ? `${task.cardId}${task.total !== undefined ? ` (${task.total})` : ""}` : "unrouted";
    lines.push(`   ${glyph} ${padEnd(task.taskId, 4)} ${padEnd(clip(task.title, 34), 34)} ${padEnd(routed, 34)} ${formatUsd(task.costUsd)}`);
  }
  lines.push(paint("   /tasks for the list · /tasks why <taskId> for the gate table", MUTED_RGB, on));
  return lines;
}

/** Columns, grouped by status, with model + score per assigned task. */
export function renderBoardView(snapshot: KanbanBoardSnapshot, options: RenderOptions = {}): readonly string[] {
  const on = colorEnabled(options.color);
  const total = Object.values(snapshot.counts).reduce((sum, count) => sum + count, 0);
  const lines: string[] = [
    paint(`── tasks ${displayTaskSetId(snapshot.boardId)} · seq ${snapshot.atSequence} · ${total} task(s)`, ACCENT_RGB, on),
  ];
  if (total === 0) {
    lines.push(paint('   no tasks yet — /tasks "<goal>" opens one', MUTED_RGB, on));
    return lines;
  }
  for (const status of Object.keys(snapshot.columns) as KanbanStatus[]) {
    const column = snapshot.columns[status];
    if (column.length === 0) continue;
    lines.push(`   ${status.toUpperCase().replace(/_/g, " ")} (${column.length})`);
    for (const task of column) {
      const routed = task.assignedCardId
        ? `${task.assignedCardId}${task.assignmentTotal !== undefined ? ` (${task.assignmentTotal})` : ""}`
        : task.blockedBy.length > 0
          ? `waits on ${task.blockedBy.join(", ")}`
          : "unrouted";
      lines.push(`     ${STATUS_GLYPH[status]} ${padEnd(task.id, 4)} ${padEnd(clip(task.title, 32), 32)} ${padEnd(task.priority, 8)} ${routed}`);
      if (task.reason) lines.push(paint(`        ${clip(task.reason, 76)}`, WARN_RGB, on));
    }
  }
  const wip = snapshot.wip.byModel.filter((entry) => entry.load > 0).map((entry) => `${entry.cardId} ${entry.load}/${entry.limit}`);
  lines.push(paint(`   wip ${wip.length > 0 ? wip.join(" · ") : "idle"}`, MUTED_RGB, on));
  return lines;
}

export interface AssignmentExplanation {
  readonly taskId: string;
  readonly title: string;
  readonly status: KanbanStatus;
  readonly assignment?: TaskAssignment;
  /** Gates for the assigned card, re-evaluated against the board's own registered cards. */
  readonly gates: readonly { readonly id: SelectionGateId; readonly status: "passed" | "blocked" | "unknown"; readonly summary: string }[];
  readonly breakdown: readonly SelectionScoreBreakdown[];
  readonly rejected: readonly { readonly cardId: string; readonly gate: SelectionGateId | "none"; readonly summary: string }[];
  readonly runnerUpCardId?: string;
  readonly margin?: number;
  readonly notes: readonly string[];
}

export function renderWhyView(explanation: AssignmentExplanation, options: RenderOptions = {}): readonly string[] {
  const on = colorEnabled(options.color);
  const lines: string[] = [
    paint(`── why ${explanation.taskId} · ${clip(explanation.title, 52)}`, ACCENT_RGB, on),
  ];
  lines.push(explanation.assignment
    ? `   assigned ${paint(explanation.assignment.cardId, OK_RGB, on)} · total ${explanation.assignment.total} · agent ${explanation.assignment.agentId} · status ${explanation.status}`
    : `   no assignment recorded · status ${explanation.status}`);
  if (explanation.assignment) lines.push(paint(`   policy ${explanation.assignment.policyDigest}`, MUTED_RGB, on));

  lines.push(`   ${padEnd("gate", 12)} ${padEnd("status", 8)} detail`);
  for (const gate of explanation.gates) {
    const rgb = gate.status === "passed" ? OK_RGB : gate.status === "blocked" ? BAD_RGB : MUTED_RGB;
    lines.push(`   ${padEnd(gate.id, 12)} ${paint(padEnd(gate.status, 8), rgb, on)} ${clip(gate.summary, 62)}`);
  }

  if (explanation.breakdown.length > 0) {
    lines.push(`   ${padEnd("score", 12)} ${padEnd("raw", 6)} ${padEnd("weight", 7)} ${padEnd("weighted", 9)} reason`);
    for (const entry of explanation.breakdown) {
      lines.push(`   ${padEnd(entry.dimension, 12)} ${padEnd(String(entry.raw), 6)} ${padEnd(`${entry.weight}%`, 7)} ${padEnd(String(entry.weighted), 9)} ${clip(entry.reason, 46)}`);
    }
    const total = explanation.breakdown.reduce((sum, entry) => sum + entry.weighted, 0);
    lines.push(`   ${padEnd("total", 12)} ${padEnd("", 6)} ${padEnd("100%", 7)} ${padEnd(String(total), 9)}`);
  }

  if (explanation.runnerUpCardId) {
    lines.push(paint(`   runner-up ${explanation.runnerUpCardId} · margin ${explanation.margin ?? 0}`, MUTED_RGB, on));
  }
  for (const rejected of explanation.rejected) {
    lines.push(paint(`   rejected ${padEnd(rejected.cardId, 30)} ${rejected.gate}: ${clip(rejected.summary, 44)}`, MUTED_RGB, on));
  }
  for (const note of explanation.notes) lines.push(paint(`   ${note}`, WARN_RGB, on));
  return lines;
}

export interface InterventionCardInput {
  readonly title: string;
  readonly detail: string;
  readonly fixes: readonly string[];
}

export function renderNeedsInterventionCard(input: InterventionCardInput, options: RenderOptions = {}): readonly string[] {
  const on = colorEnabled(options.color);
  const lines = [
    paint(`! needs intervention · ${clip(input.title, 56)}`, BAD_RGB, on),
    `   ${clip(input.detail, 92)}`,
  ];
  for (const fix of input.fixes) lines.push(paint(`   fix: ${fix}`, WARN_RGB, on));
  return lines;
}

// ============================================================================
// 6. Explaining one assignment (the /tasks why data path)
// ============================================================================

/**
 * Selection load for a "why" question is the board's load MINUS this task's own
 * assignment: the honest answer to "why this card" is the capacity that existed
 * when the task was routed, not the capacity it is itself consuming.
 */
function loadExcludingTask(state: KanbanBoardState, taskId: string): ReadonlyMap<string, number> {
  const load = new Map(state.loadByModel);
  const entry = state.tasks.get(taskId);
  const cardId = entry?.assignment?.cardId;
  if (cardId && load.has(cardId)) {
    const next = (load.get(cardId) ?? 0) - 1;
    if (next <= 0) load.delete(cardId); else load.set(cardId, next);
  }
  return load;
}

function candidateFor(selection: ModelSelection, cardId: string): SelectionCandidate | undefined {
  return selection.candidates.find((candidate) => candidate.cardId === cardId);
}

/**
 * The selector's WIP gate must agree with the reducer's `task_assigned` capacity
 * check, or the planner proposes assignments the log then rejects (the exact
 * class of bug adversarial verification found in the kanban pre-ship). Capacity
 * inputs are excluded from `policyDigest` by construction, so this cannot change
 * the recorded policy identity.
 */
function selectionPolicyFor(state: KanbanBoardState, modelLoad: ReadonlyMap<string, number>): SelectionPolicy {
  return {
    ...(state.policy ?? {}),
    modelLoad,
    wipPerModel: state.wipLimits.perModel,
    defaultWipPerModel: state.wipLimits.defaultPerModel,
  };
}

export function explainAssignment(state: KanbanBoardState, taskId: string): AssignmentExplanation | undefined {
  const entry = state.tasks.get(taskId);
  if (!entry) return undefined;
  const cards = [...state.cards.values()];
  const selection = selectModelForTask(entry.task, cards, selectionPolicyFor(state, loadExcludingTask(state, taskId)));
  const notes: string[] = [];
  const assignedCardId = entry.assignment?.cardId;
  const candidate = assignedCardId ? candidateFor(selection, assignedCardId) : undefined;

  const gates = candidate
    ? SELECTION_GATE_ORDER.map((id) => {
        const gate = candidate.gates.find((entry_) => entry_.id === id);
        return gate ? { id, status: gate.status, summary: gate.summary } : { id, status: "unknown" as const, summary: "not evaluated (blocked earlier)" };
      })
    : SELECTION_GATE_ORDER.map((id) => ({ id, status: "unknown" as const, summary: assignedCardId ? "assigned card is not registered for these tasks" : "no assignment yet" }));

  const overridden = entry.assignment?.rationale.startsWith("user-override") === true;
  if (assignedCardId && !candidate) notes.push(`card "${assignedCardId}" is not among these tasks' registered cards; gates cannot be re-evaluated`);
  // Provenance is never inferred from the score: a human pin says so even when
  // the router would have reached the same card on its own.
  if (overridden) notes.push(`this assignment was recorded by a user-override (/tasks assign), not by the router`);
  if (selection.outcome === "selected" && assignedCardId && selection.cardId !== assignedCardId) {
    notes.push(`re-evaluated now the router would pick ${selection.cardId}; the recorded assignment stands (${overridden ? "user-override" : "routed earlier"})`);
  }
  if (selection.outcome === "needs_intervention") notes.push(`re-evaluation escalates: ${selection.reason} — ${selection.detail}`);
  notes.push("gates are re-evaluated at read time against the cards registered for these tasks; the score row is the value recorded at assignment.");

  const rejected = selection.candidates
    .filter((entry_) => !entry_.qualified && entry_.cardId !== assignedCardId)
    .map((entry_) => {
      const gate = entry_.gates.find((gateEntry) => gateEntry.id === entry_.blockedBy);
      return { cardId: entry_.cardId, gate: entry_.blockedBy ?? ("none" as const), summary: gate?.summary ?? "unspecified" };
    });

  return {
    taskId,
    title: entry.task.title,
    status: entry.status,
    ...(entry.assignment ? { assignment: entry.assignment } : {}),
    gates,
    breakdown: entry.assignment?.breakdown ?? candidate?.breakdown ?? [],
    rejected,
    ...(selection.outcome === "selected" && selection.runnerUpCardId ? { runnerUpCardId: selection.runnerUpCardId, margin: selection.margin } : {}),
    notes,
  };
}

// ============================================================================
// 7. Handlers
// ============================================================================

export interface MissionTaskRunInput {
  readonly task: KanbanTask;
  readonly attemptId: string;
  readonly sessionId: string;
  readonly cardId: string;
  readonly agentId: string;
  readonly onNarration: (text: string) => void;
}

export interface MissionTaskRunResult {
  readonly ok: boolean;
  /** One line for the completion card ("14 tests pass"). */
  readonly summary: string;
  readonly costUsd?: number;
  readonly receiptHash?: string;
  readonly runId?: string;
  readonly turnId?: string;
  readonly processId?: string;
}

export interface OrchestrationDeps {
  readonly sessionName: string;
  readonly cwd?: string;
  readonly emit: (line: string) => void;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly color?: boolean;
  readonly width?: number;
  /** Authenticated backend probe. */
  readonly detectAuth: () => Promise<BackendAuth>;
  /** Planning turn on the configured model (executeRun in production). */
  readonly plan: (prompt: string) => Promise<string>;
  /** Resolve/create the durable Muster conversation opened by this task's card. */
  readonly taskSessionId?: (task: KanbanTask) => Promise<string> | string;
  /** One task execution (spawnSubagent in production). */
  readonly execute: (input: MissionTaskRunInput) => Promise<MissionTaskRunResult>;
  /** Minimum gap between durable task_progress events. */
  readonly progressIntervalMs?: number;
}

export const MISSION_AGENT_ID = "muster-subagent";
const ORCHESTRATOR_ID = "muster-orchestrator";
const USER_ACTOR_ID = "user";

function emitAll(deps: OrchestrationDeps, lines: readonly string[]): void {
  for (const line of lines) deps.emit(line);
}

function renderOptions(deps: OrchestrationDeps): RenderOptions {
  return { ...(deps.color !== undefined ? { color: deps.color } : {}), ...(deps.width !== undefined ? { width: deps.width } : {}) };
}

function nextTaskIndex(state: KanbanBoardState): number {
  let highest = 0;
  for (const id of state.tasks.keys()) {
    const match = /^t(\d+)$/.exec(id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
}

async function ensureBoardOpen(store: BoardStore): Promise<void> {
  if (store.state().opened) return;
  await store.commit(
    { actorId: ORCHESTRATOR_ID, actorKind: "system", summary: "open chat tasks" },
    {
      type: "board_opened",
      // Two authenticated backends, tasks that may run in parallel waves: a WIP of
      // one per model would escalate a legal parallel plan as wip_exhausted.
      defaults: { defaultWipPerModel: 4, defaultWipPerAgent: 4 },
    },
  );
}

async function registerCards(store: BoardStore, cards: readonly ModelCard[]): Promise<void> {
  for (const card of cards) {
    const known = store.state().cards.get(card.id);
    if (known && JSON.stringify(known) === JSON.stringify(card)) continue;
    await store.commit(
      { actorId: ORCHESTRATOR_ID, actorKind: "system", summary: `register model card ${card.id}` },
      { type: "model_card_registered", card },
    );
  }
}

export interface MissionOutcome {
  readonly boardId: string;
  readonly tasks: readonly string[];
  readonly done: readonly string[];
  readonly stalled: readonly string[];
  readonly costUsd?: number;
}

/**
 * `/tasks "<goal>"` — plan, route, run, narrate. Every state change below is a
 * kanban event; the transcript cards are rendered FROM those events, so what the
 * user reads and what the log replays cannot drift.
 */
export async function runMissionCommand(goal: string, deps: OrchestrationDeps): Promise<MissionOutcome | undefined> {
  const options = renderOptions(deps);
  const cwd = deps.cwd ?? process.cwd();
  const now = deps.now ?? (() => new Date());
  const startedAt = now().getTime();
  const store = await openBoardStore({
    sessionName: deps.sessionName,
    cwd,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.newId ? { newId: deps.newId } : {}),
  });

  const auth = await deps.detectAuth();
  const cards = authenticatedModelCards(auth);
  deps.emit(paint(`── tasks ${displayTaskSetId(store.state().boardId)} · ${describeBackendAuth(auth)}`, ACCENT_RGB, colorEnabled(deps.color)));

  let planText: string;
  try {
    planText = await deps.plan(buildMissionPlanPrompt(goal, cards));
  } catch (error) {
    emitAll(deps, renderNeedsInterventionCard({
      title: `planning "${goal}"`,
      detail: `the planning turn failed: ${error instanceof Error ? error.message : String(error)}`,
      fixes: ["muster doctor", "/providers to check the configured planning model"],
    }, options));
    return undefined;
  }

  await ensureBoardOpen(store);
  const plan = parseMissionPlan(planText, {
    createdAt: now().toISOString(),
    startIndex: nextTaskIndex(store.state()),
    availableCapabilities: [...new Set(cards.flatMap((card) => card.capabilities))],
  });
  for (const issue of plan.issues) deps.emit(paint(`   plan note: ${issue}`, WARN_RGB, colorEnabled(deps.color)));
  if (plan.tasks.length === 0) {
    emitAll(deps, renderNeedsInterventionCard({
      title: `planning "${goal}"`,
      detail: "the planner produced no valid tasks",
      fixes: ["re-run with a more concrete goal", "/model to switch the planning model"],
    }, options));
    return undefined;
  }

  for (const task of plan.tasks) {
    await store.commit(
      { actorId: ORCHESTRATOR_ID, actorKind: "system", summary: `create task ${task.id}` },
      { type: "task_created", taskId: task.id, task },
    );
    const sessionId = await (deps.taskSessionId?.(task) ?? `task-session:${deps.sessionName}:${task.id}`);
    await store.commit(
      { actorId: ORCHESTRATOR_ID, actorKind: "system", summary: `bind ${task.id} to session ${sessionId}` },
      { type: "task_session_bound", taskId: task.id, sessionId },
    );
  }
  await registerCards(store, cards);

  const taskIds = plan.tasks.map((task) => task.id);
  const costs = new Map<string, number>();

  if (cards.length === 0) {
    for (const taskId of taskIds) {
      await store.commit(
        { actorId: ORCHESTRATOR_ID, actorKind: "system", summary: `escalate ${taskId}: no authenticated backend` },
        { type: "task_escalated", taskId, reason: "no_qualified_model", detail: "no authenticated backend: codex is not logged in and the claude CLI is not on PATH" },
      );
    }
    emitAll(deps, renderNeedsInterventionCard({
      title: `${taskIds.length} task(s) planned, none routable`,
      detail: "selection ran against zero authenticated model cards, so every task was escalated rather than routed to a backend that would fail at run time.",
      fixes: ["codex login", "install Claude Code so `claude` is on PATH", "/tasks to see the escalated tasks"],
    }, options));
  } else {
    await runMissionWaves(store, taskIds, cards, deps, costs);
  }

  const finalState = store.state();
  const summaryTasks = taskIds.map((taskId) => {
    const entry = finalState.tasks.get(taskId);
    return {
      taskId,
      title: entry?.task.title ?? taskId,
      status: entry?.status ?? ("backlog" as KanbanStatus),
      ...(entry?.assignment ? { cardId: entry.assignment.cardId, total: entry.assignment.total } : {}),
      ...(costs.has(taskId) ? { costUsd: costs.get(taskId) } : {}),
    };
  });
  const priced = [...costs.values()];
  emitAll(deps, renderMissionSummaryCard({
    goal,
    boardId: finalState.boardId,
    elapsedMs: now().getTime() - startedAt,
    ...(priced.length > 0 ? { costUsd: priced.reduce((sum, value) => sum + value, 0) } : {}),
    tasks: summaryTasks,
  }, options));

  return {
    boardId: finalState.boardId,
    tasks: taskIds,
    done: summaryTasks.filter((task) => task.status === "done").map((task) => task.taskId),
    stalled: summaryTasks.filter((task) => task.status !== "done").map((task) => task.taskId),
    ...(priced.length > 0 ? { costUsd: priced.reduce((sum, value) => sum + value, 0) } : {}),
  };
}

/**
 * Wave loop: everything whose dependencies are `done` runs together, so an
 * independent plan is parallel and a chained plan is sequential — the shape of
 * the DAG decides, not a flag. A wave that routes nothing stops the mission
 * instead of spinning.
 */
async function runMissionWaves(
  store: BoardStore,
  taskIds: readonly string[],
  cards: readonly ModelCard[],
  deps: OrchestrationDeps,
  costs: Map<string, number>,
): Promise<void> {
  const options = renderOptions(deps);
  const on = colorEnabled(deps.color);
  const pending = new Set(taskIds);

  while (pending.size > 0) {
    const state = store.state();
    const wave = [...pending].filter((taskId) => {
      const entry = state.tasks.get(taskId);
      if (!entry || entry.status !== "backlog") return false;
      return entry.task.dependsOn.every((dependency) => state.tasks.get(dependency)?.status === "done");
    });
    if (wave.length === 0) {
      for (const taskId of pending) {
        const entry = store.state().tasks.get(taskId);
        deps.emit(paint(`   ${taskId} not started (${entry?.status ?? "unknown"}; upstream unfinished)`, MUTED_RGB, on));
      }
      return;
    }

    const routed: { taskId: string; cardId: string; task: KanbanTask; sessionId: string }[] = [];
    for (const taskId of wave) {
      pending.delete(taskId);
      const entry = store.state().tasks.get(taskId)!;
      await store.commit(
        { actorId: ORCHESTRATOR_ID, actorKind: "system", summary: `${taskId} dependencies satisfied` },
        { type: "task_ready", taskId, satisfiedDependencies: entry.task.dependsOn },
      );
      const current = store.state();
      const selection = selectModelForTask(entry.task, cards, selectionPolicyFor(current, current.loadByModel));
      if (selection.outcome !== "selected") {
        await store.commit(
          { actorId: ORCHESTRATOR_ID, actorKind: "system", summary: `escalate ${taskId}: ${selection.reason}` },
          { type: "task_escalated", taskId, reason: selection.reason, detail: clip(selection.detail, 400) },
        );
        emitAll(deps, renderNeedsInterventionCard({
          title: `${taskId} ${entry.task.title}`,
          detail: `${selection.reason}: ${selection.detail}`,
          fixes: [`/tasks why ${taskId} for the full gate table`, `/tasks assign ${taskId} <cardId> to override`],
        }, options));
        continue;
      }
      const assignment: TaskAssignment = {
        cardId: selection.cardId,
        agentId: MISSION_AGENT_ID,
        assignedAt: (deps.now ?? (() => new Date()))().toISOString(),
        total: selection.total,
        breakdown: selection.breakdown,
        policyDigest: selection.policyDigest,
        rationale: clip(selection.rationale, 3000),
      };
      await store.commit(
        { actorId: ORCHESTRATOR_ID, actorKind: "system", summary: `assign ${taskId} to ${selection.cardId}` },
        { type: "task_assigned", taskId, assignment },
      );
      deps.emit(renderTaskAssignedCard({ taskId, title: entry.task.title, cardId: selection.cardId, total: selection.total }, options));
      const sessionId = store.state().tasks.get(taskId)?.sessionId;
      if (!sessionId) throw new Error(`Task ${taskId} has no bound session after task_session_bound.`);
      routed.push({ taskId, cardId: selection.cardId, task: entry.task, sessionId });
    }
    if (routed.length === 0) continue;

    // Started/progress/completion events are serialized through the store (single
    // writer, ordered sequence) while the runs themselves overlap.
    const results = await Promise.all(routed.map(async (entry) => {
      const attemptId = `attempt-${entry.taskId}-${store.state().tasks.get(entry.taskId)!.attempts + 1}`;
      await store.commit(
        { actorId: ORCHESTRATOR_ID, actorKind: "system", summary: `request run ${attemptId}` },
        { type: "task_attempt_started", taskId: entry.taskId, agentId: MISSION_AGENT_ID, attemptId },
      );
      const progress = createProgressRecorder(store, entry.taskId, deps);
      let result: MissionTaskRunResult;
      try {
        result = await deps.execute({
          task: entry.task,
          attemptId,
          sessionId: entry.sessionId,
          cardId: entry.cardId,
          agentId: MISSION_AGENT_ID,
          onNarration: (text) => {
            deps.emit(renderTaskNarrationLine(entry.taskId, text, options));
            progress.note(text);
          },
        });
      } catch (error) {
        result = { ok: false, summary: `execution threw: ${error instanceof Error ? error.message : String(error)}` };
      }
      return { ...entry, attemptId, result, progress };
    }));

    for (const entry of results) {
      await entry.progress.flush();
      if (!entry.result.ok) {
        await store.commit(
          { actorId: ORCHESTRATOR_ID, actorKind: "system", summary: `fail ${entry.attemptId}` },
          {
            type: "task_attempt_failed", taskId: entry.taskId, attemptId: entry.attemptId,
            error: clip(entry.result.summary || "run failed", 400),
            ...(entry.result.turnId ? { turnId: entry.result.turnId } : {}),
            ...(entry.result.processId ? { processId: entry.result.processId } : {}),
            ...(entry.result.costUsd !== undefined ? { costUsd: entry.result.costUsd } : {}),
          },
        );
        if (entry.result.costUsd !== undefined) costs.set(entry.taskId, entry.result.costUsd);
        deps.emit(renderTaskDoneCard({
          taskId: entry.taskId,
          detail: entry.result.summary || "run failed",
          ...(entry.result.costUsd !== undefined ? { costUsd: entry.result.costUsd } : {}),
          ok: false,
        }, options));
        continue;
      }
      await store.commit(
        { actorId: ORCHESTRATOR_ID, actorKind: "system", summary: `complete ${entry.attemptId}` },
        {
          type: "task_attempt_completed", taskId: entry.taskId, attemptId: entry.attemptId,
          ...(entry.result.turnId ? { turnId: entry.result.turnId } : {}),
          ...(entry.result.processId ? { processId: entry.result.processId } : {}),
          ...(entry.result.receiptHash ? { receiptHash: entry.result.receiptHash } : {}),
          ...(entry.result.costUsd !== undefined ? { costUsd: entry.result.costUsd } : {}),
        },
      );
      await store.commit(
        { actorId: ORCHESTRATOR_ID, actorKind: "system", summary: `complete ${entry.taskId}` },
        {
          type: "task_completed",
          taskId: entry.taskId,
          reviewerId: ORCHESTRATOR_ID,
          receiptHash: entry.result.receiptHash ?? `run:${entry.result.runId ?? entry.taskId}`,
        },
      );
      if (entry.result.costUsd !== undefined) costs.set(entry.taskId, entry.result.costUsd);
      deps.emit(renderTaskDoneCard({
        taskId: entry.taskId,
        detail: entry.result.summary || "completed",
        ...(entry.result.costUsd !== undefined ? { costUsd: entry.result.costUsd } : {}),
      }, options));
    }
  }
}

interface ProgressRecorder {
  note(text: string): void;
  flush(): Promise<void>;
}

/**
 * Narration is a stream; the log is evidence. Progress notes are throttled and
 * deduplicated so a chatty backend cannot turn one task into a thousand events.
 */
function createProgressRecorder(store: BoardStore, taskId: string, deps: OrchestrationDeps): ProgressRecorder {
  const interval = deps.progressIntervalMs ?? 10_000;
  const now = deps.now ?? (() => new Date());
  let lastAt = 0;
  let lastNote: string | undefined;
  let pendingNote: string | undefined;
  let chain: Promise<void> = Promise.resolve();

  const write = (note: string): void => {
    lastNote = note;
    chain = chain.then(async () => {
      try {
        await store.commit(
          { actorId: MISSION_AGENT_ID, actorKind: "agent", summary: `progress on ${taskId}` },
          { type: "task_progress", taskId, note },
        );
      } catch {
        // Progress is evidence, never a gate: a task that finished (or was
        // blocked) before a late note lands must not fail on the note.
      }
    });
  };

  return {
    note(text) {
      const note = clip(text, 240);
      if (!note || note === lastNote) return;
      pendingNote = note;
      const at = now().getTime();
      if (at - lastAt < interval) return;
      lastAt = at;
      pendingNote = undefined;
      write(note);
    },
    async flush() {
      if (pendingNote && pendingNote !== lastNote) {
        const note = pendingNote;
        pendingNote = undefined;
        write(note);
      }
      await chain;
    },
  };
}

export async function runBoardCommand(deps: OrchestrationDeps): Promise<KanbanBoardSnapshot> {
  const store = await openBoardStore({
    sessionName: deps.sessionName,
    ...(deps.cwd ? { cwd: deps.cwd } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.newId ? { newId: deps.newId } : {}),
  });
  const snapshot = snapshotKanbanBoard(store.state());
  emitAll(deps, renderBoardView(snapshot, renderOptions(deps)));
  return snapshot;
}

export async function runWhyCommand(taskId: string, deps: OrchestrationDeps): Promise<AssignmentExplanation | undefined> {
  const store = await openBoardStore({
    sessionName: deps.sessionName,
    ...(deps.cwd ? { cwd: deps.cwd } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.newId ? { newId: deps.newId } : {}),
  });
  const explanation = explainAssignment(store.state(), taskId);
  if (!explanation) {
    deps.emit(paint(`no task "${taskId}" in ${displayTaskSetId(store.state().boardId)} — /tasks lists what exists`, WARN_RGB, colorEnabled(deps.color)));
    return undefined;
  }
  emitAll(deps, renderWhyView(explanation, renderOptions(deps)));
  return explanation;
}

/**
 * `/tasks assign <taskId> <cardId>` — the human wins, but on the record. The override
 * is scored against the SAME selector (restricted to the chosen card) so the
 * event carries an arithmetically auditable breakdown, and it is refused when
 * the reducer's never-misassign gate would reject it — with the blocking gate
 * printed, not a bare "no".
 */
export async function runAssignCommand(taskId: string, cardId: string, deps: OrchestrationDeps): Promise<boolean> {
  const options = renderOptions(deps);
  const on = colorEnabled(deps.color);
  const store = await openBoardStore({
    sessionName: deps.sessionName,
    ...(deps.cwd ? { cwd: deps.cwd } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.newId ? { newId: deps.newId } : {}),
  });
  const entry = store.state().tasks.get(taskId);
  if (!entry) {
    deps.emit(paint(`no task "${taskId}" in ${displayTaskSetId(store.state().boardId)} — /tasks lists what exists`, WARN_RGB, on));
    return false;
  }
  const card = store.state().cards.get(cardId);
  if (!card) {
    const known = [...store.state().cards.keys()];
    deps.emit(paint(`card "${cardId}" is not registered for these tasks${known.length ? ` — known: ${known.join(", ")}` : ""}`, WARN_RGB, on));
    return false;
  }

  // Walk the task to `ready` through legal transitions only; anything past
  // in_progress is refused rather than force-moved.
  if (entry.status === "in_progress" || entry.status === "review" || entry.status === "done") {
    deps.emit(paint(`${taskId} is ${entry.status}; an override would rewrite work already in flight`, WARN_RGB, on));
    return false;
  }
  if (entry.status === "assigned") {
    await store.commit(
      { actorId: USER_ACTOR_ID, actorKind: "human", summary: `unassign ${taskId} for user override` },
      { type: "task_unassigned", taskId, reason: "user-override" },
    );
  } else if (entry.status === "needs_intervention") {
    await store.commit(
      { actorId: USER_ACTOR_ID, actorKind: "human", summary: `requeue ${taskId} for user override` },
      { type: "task_intervention_resolved", taskId, resolution: "requeue", note: "user-override" },
    );
  }
  if (store.state().tasks.get(taskId)!.status !== "ready") {
    try {
      await store.commit(
        { actorId: USER_ACTOR_ID, actorKind: "human", summary: `ready ${taskId} for user override` },
        { type: "task_ready", taskId, satisfiedDependencies: entry.task.dependsOn },
      );
    } catch (error) {
      // Dependency gating is the reducer's call, not the override's: a task whose
      // upstream is unfinished stays where it is, and the reason is printed.
      deps.emit(paint(`override refused: ${error instanceof Error ? error.message : String(error)}`, BAD_RGB, on));
      return false;
    }
  }

  const state = store.state();
  const selection = selectModelForTask(entry.task, [card], selectionPolicyFor(state, loadExcludingTask(state, taskId)));
  if (selection.outcome !== "selected") {
    const candidate = candidateFor(selection, cardId);
    const blocking = candidate?.gates.find((gate) => gate.id === candidate.blockedBy);
    deps.emit(paint(`override refused: ${cardId} is blocked at gate "${candidate?.blockedBy ?? selection.reason}" — ${blocking?.summary ?? selection.detail}`, BAD_RGB, on));
    deps.emit(paint(`   tasks keeps ${taskId} routable; /tasks why ${taskId} shows every gate`, MUTED_RGB, on));
    return false;
  }

  const assignment: TaskAssignment = {
    cardId: selection.cardId,
    agentId: MISSION_AGENT_ID,
    assignedAt: (deps.now ?? (() => new Date()))().toISOString(),
    total: selection.total,
    breakdown: selection.breakdown,
    policyDigest: selection.policyDigest,
    rationale: clip(`user-override: operator pinned ${selection.cardId}\n${selection.rationale}`, 3000),
  };
  await store.commit(
    { actorId: USER_ACTOR_ID, actorKind: "human", summary: `user-override: assign ${taskId} to ${cardId}` },
    { type: "task_assigned", taskId, assignment },
  );
  deps.emit(renderTaskAssignedCard({ taskId, title: entry.task.title, cardId: selection.cardId, total: selection.total }, options));
  deps.emit(paint(`   recorded as user-override · /tasks why ${taskId} for the gate table`, MUTED_RGB, on));
  return true;
}

/** Single entry point shared by the chat dispatcher and `muster tasks`. */
export async function runOrchestrationCommand(command: OrchestrationCommand, deps: OrchestrationDeps): Promise<void> {
  switch (command.kind) {
    case "usage":
      deps.emit(paint(command.usage, WARN_RGB, colorEnabled(deps.color)));
      return;
    case "mission":
      await runMissionCommand(command.goal, deps);
      return;
    case "board":
      await runBoardCommand(deps);
      return;
    case "why":
      await runWhyCommand(command.taskId, deps);
      return;
    case "assign":
      await runAssignCommand(command.taskId, command.cardId, deps);
      return;
  }
}
