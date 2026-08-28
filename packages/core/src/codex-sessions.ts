/**
 * Codex rollout discovery + import — the bridge that makes Muster the daily
 * driver over the Codex backend the user already runs.
 *
 * The Codex CLI (verified against 0.150.0-alpha.8 on this machine) appends every
 * thread to `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. The
 * FIRST line is `{type:"session_meta", payload:{id, session_id, cwd, …}}`, and
 * `payload.id` IS the provider thread id that `runCodexAppServer({threadId})`
 * resumes (codex-app-server.ts `thread/resume`). So a rollout file is not just
 * history: it is a resumable handle. This module turns those files into typed
 * summaries and imports their transcripts into Muster's SessionStore so search,
 * memory, and the token ledger see the work the user already did in raw Codex.
 *
 * IDENTITY, measured rather than assumed. Across all 438 rollouts on this
 * machine `payload.id` is unique per file and matches the filename's uuid, while
 * `payload.session_id` REPEATS — a multi-agent parent shares its session_id with
 * every subagent it spawns (`thread_source:"subagent"`, `parent_thread_id` set).
 * Keying on session_id would collapse 438 threads into 175 and hand `resume` the
 * parent's id when the user asked for a child. So `threadId` is `payload.id`,
 * `rootSessionId` keeps the shared value, and discovery HIDES subagent threads by
 * default: 316 of 438 files are fan-out the user never typed into, and listing
 * them buries the 122 real chats.
 *
 * FOUR INVARIANTS:
 *
 * 1. STRICTLY READ-ONLY on CODEX_HOME. Never write, rename, truncate, or delete
 *    a rollout file. Codex owns them and is usually still appending to one.
 *    Everything here opens read streams and nothing else.
 *
 * 2. NEVER THROW ON ONE BAD FILE. A rollout is an append-only log written by a
 *    live process: the tail can be a half-written line, a file can vanish
 *    mid-scan, and old CLI versions wrote shapes we have never seen. Discovery
 *    skips-and-reports per file, and per-line JSON failures are counted, not
 *    raised. One corrupt session must never hide the other 437.
 *
 * 3. BOUNDED MEMORY, ALWAYS. Measured on this machine: rollouts reach 999 MB
 *    with single lines up to 3 MB (giant tool outputs get logged inline). Naive
 *    `readFile` would OOM the CLI. Every read here is a bounded stream with a
 *    byte budget, a per-line cap, a per-message character cap, and a message
 *    count cap; whatever a cap costs is REPORTED (`stats.truncated`,
 *    `oversizedLines`, `droppedMessages`) instead of silently pretended away.
 *    Discovery therefore reads a HEAD WINDOW only and marks `turnCountExact:
 *    false` when it did not reach EOF — an honest "12+" beats a slow lie.
 *
 * 4. IMPORT IS APPEND-ONLY AND IDEMPOTENT. Re-importing a live thread must add
 *    exactly the turns that appeared since last time. Identity is the thread id
 *    (carried in the session title, which the store lets us set), and the
 *    already-stored messages must be a PREFIX of what we are about to write. If
 *    they are not, we append NOTHING and report `diverged` — duplicating or
 *    rewriting a user's history is worse than importing nothing.
 *
 * `lastActivityAt` comes from file mtime, not the last line's timestamp: the
 * timestamp would cost a full read of a 1 GB file per session listed, and mtime
 * on an append-only log is the same fact for free.
 */

import { createReadStream, realpathSync, type Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { SessionStore } from "./sessions.js";

/* ---------- errors: fail closed, WorkspaceObserverError idiom ---------- */

export type CodexSessionErrorCode =
  | "unreadable"
  | "missing_session_meta"
  | "sessions_root_missing";

export class CodexSessionError extends Error {
  readonly code: CodexSessionErrorCode;
  readonly filePath?: string;
  constructor(code: CodexSessionErrorCode, message: string, filePath?: string) {
    super(message);
    this.name = "CodexSessionError";
    this.code = code;
    if (filePath !== undefined) this.filePath = filePath;
  }
}

/* ---------- limits (see invariant 3) ---------- */

/** Head window discovery reads per rollout. Covers a normal session end-to-end. */
export const CODEX_DISCOVERY_SCAN_BYTES = 4 * 1024 * 1024;
/** Budget a deliberate single-session import may spend. */
export const CODEX_IMPORT_SCAN_BYTES = 512 * 1024 * 1024;
/** Lines longer than this are skipped whole — measured max in the wild is ~3 MB. */
export const CODEX_MAX_LINE_BYTES = 8 * 1024 * 1024;
/** Per-message character cap; overflow is truncated with a visible marker. */
export const CODEX_MAX_MESSAGE_CHARS = 64 * 1024;
/** Messages retained per rollout; overflow increments `droppedMessages`. */
export const CODEX_MAX_MESSAGES = 5000;

export const CODEX_IMPORT_CHANNEL = "codex-import";
/** Sessions scanned when resolving a thread id to an already-imported session. */
export const CODEX_IMPORT_SCAN_LIMIT = 5000;

const TRUNCATION_MARKER = "\n… [truncated by muster codex import]";

/**
 * User-role items Codex injects itself. They are prompt scaffolding, not things
 * the human said, and letting them through would make `firstUserMessage` read
 * "<environment_context>" for every session. Matched only as an exact opening
 * tag from this list so a human pasting `<div>` is never dropped.
 */
const SYNTHETIC_USER_TAGS = new Set([
  "codex_delegation",
  "environment_context",
  "goal_context",
  "ide_context",
  "image",
  "multi_agent_mode",
  "multi_agent_role",
  "plan_tool_context",
  "recommended_plugins",
  "skill",
  "skills_instructions",
  "subagent_notification",
  "turn_aborted",
  "user_instructions",
]);

/* ---------- types ---------- */

export interface CodexTranscriptMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  /** Rollout line timestamp, when the line carried one. */
  readonly at?: string;
}

export interface CodexSessionMeta {
  /** `payload.id` — unique per rollout, and the id `thread/resume` accepts. */
  readonly threadId: string;
  /** `payload.session_id` — shared by a multi-agent parent and its subagents. */
  readonly rootSessionId?: string;
  readonly cwd: string;
  readonly startedAt: string;
  /** Set when this thread was forked from another (`payload.forked_from_id`). */
  readonly forkedFromId?: string;
  /** Set on multi-agent children (`payload.parent_thread_id`). */
  readonly parentThreadId?: string;
  /** `payload.thread_source`: "user", "subagent", or absent on older CLIs. */
  readonly threadSource?: string;
  readonly originator?: string;
  readonly cliVersion?: string;
  /** `payload.source` when it is a plain string; it is an object for subagents. */
  readonly source?: string;
  readonly modelProvider?: string;
}

export interface CodexRolloutStats {
  readonly bytesRead: number;
  /** True when a byte budget stopped the read before EOF. */
  readonly truncated: boolean;
  /** Lines that were not valid JSON (a live tail write, or genuine corruption). */
  readonly malformedLines: number;
  /** Lines skipped whole for exceeding the per-line byte cap. */
  readonly oversizedLines: number;
  /** Messages discarded because the retained-message cap was reached. */
  readonly droppedMessages: number;
}

export interface CodexRollout {
  readonly filePath: string;
  readonly meta: CodexSessionMeta;
  /** Most recent model observed in `turn_context` / `world_state`. */
  readonly model?: string;
  readonly messages: readonly CodexTranscriptMessage[];
  /**
   * Latest `timestamp` seen on ANY scanned line. Only meaningful when the scan
   * reached EOF (`stats.truncated === false`); a head-window read stops long
   * before the newest line of a big rollout.
   */
  readonly lastEventAt?: string;
  readonly stats: CodexRolloutStats;
}

export interface CodexSessionSummary extends CodexSessionMeta {
  readonly filePath: string;
  readonly model?: string;
  /** User prompts in the transcript — the unit a human calls a "turn". */
  readonly turnCount: number;
  /** False when a byte budget cut the scan short, so `turnCount` is a floor. */
  readonly turnCountExact: boolean;
  readonly messageCount: number;
  readonly firstUserMessage: string;
  /**
   * When the thread was last worked on. Prefers the newest rollout line
   * timestamp when the scan reached EOF, and only falls back to file mtime when
   * it did not — mtime is a fact about the FILE, and anything that rewrites or
   * touches rollouts (backup agents, sync clients, an index rebuild) makes a
   * day-old thread read as seconds old. See `lastActivitySource`.
   */
  readonly lastActivityAt: string;
  /** Which fact `lastActivityAt` came from — reported, never guessed at. */
  readonly lastActivitySource: "rollout" | "mtime";
  readonly sizeBytes: number;
}

function normalizeCodexWorkspace(cwd: string): string {
  const absolute = resolve(cwd);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

export interface CodexRolloutSkip {
  readonly filePath: string;
  readonly reason: CodexSessionErrorCode;
  readonly detail?: string;
}

export interface CodexDiscoveryResult {
  readonly root: string;
  readonly sessions: readonly CodexSessionSummary[];
  readonly skipped: readonly CodexRolloutSkip[];
  /** Rollout files opened. Lower than the file count when `limit`/`since` cut it short. */
  readonly scanned: number;
  /** Rollout files found under the root before filtering. */
  readonly candidates: number;
  /** Threads excluded as multi-agent fan-out (`thread_source: "subagent"`). */
  readonly subagentsHidden: number;
}

export interface CodexReadLimits {
  readonly maxBytes?: number;
  readonly maxLineBytes?: number;
  readonly maxMessages?: number;
  readonly maxMessageChars?: number;
}

export interface DiscoverCodexSessionsOptions extends CodexReadLimits {
  readonly codexHome?: string;
  /** Newest-first cap on returned sessions. Default 25. */
  readonly limit?: number;
  /** ISO date, epoch ms, `Date`, or a relative span like `7d` / `24h` / `30m`. */
  readonly since?: string | number | Date;
  /** Include multi-agent fan-out threads the user never typed into. Default false. */
  readonly includeSubagents?: boolean;
  /** Only threads whose cwd matches exactly. */
  readonly cwd?: string;
  readonly nowMs?: number;
}

export interface ImportCodexSessionOptions extends CodexReadLimits {
  readonly scanLimit?: number;
}

export interface CodexImportResult {
  readonly sessionId: string;
  readonly threadId: string;
  readonly created: boolean;
  readonly appended: number;
  /** Messages already stored from a previous import of this thread. */
  readonly alreadyPresent: number;
  /**
   * True when the stored transcript is NOT a prefix of the rollout. Nothing is
   * appended in that case (invariant 4).
   */
  readonly diverged: boolean;
  readonly stats: CodexRolloutStats;
}

export type CodexThreadMatch<T> =
  | { readonly kind: "match"; readonly session: T }
  | { readonly kind: "ambiguous"; readonly candidates: readonly T[] }
  | { readonly kind: "none" };

/* ---------- paths ---------- */

export function codexHomeDir(codexHome?: string): string {
  return codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

export function codexSessionsDir(codexHome?: string): string {
  return join(codexHomeDir(codexHome), "sessions");
}

/* ---------- bounded line scanning (invariant 3) ---------- */

interface LineScanResult {
  readonly bytesRead: number;
  readonly truncated: boolean;
  readonly oversizedLines: number;
}

/**
 * Stream `filePath` line by line under a hard byte budget. `onLine` returning
 * false stops the scan (used to bail once the message cap is hit). A line whose
 * bytes exceed `maxLineBytes` is discarded WITHOUT being buffered — that cap is
 * the only thing standing between a 3 MB tool-output line and unbounded memory.
 */
async function scanLines(
  filePath: string,
  maxBytes: number,
  maxLineBytes: number,
  onLine: (line: string) => boolean | void,
): Promise<LineScanResult> {
  const stream = createReadStream(filePath, { highWaterMark: Math.max(1, Math.min(1 << 20, maxBytes)) });
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let skipping = false;
  let bytesRead = 0;
  let oversizedLines = 0;
  let truncated = false;
  let stopped = false;

  const flushLine = (): boolean => {
    const line = Buffer.concat(pending).toString("utf8");
    pending = [];
    pendingBytes = 0;
    if (!line.trim()) return true;
    return onLine(line) !== false;
  };

  try {
    for await (const rawChunk of stream as AsyncIterable<Buffer>) {
      // Enforce the budget to the BYTE, not to the read-chunk boundary: a 1 MiB
      // highWaterMark would otherwise let a "4 MiB" scan read 5 MiB.
      const remaining = maxBytes - bytesRead;
      const chunk = rawChunk.length > remaining ? rawChunk.subarray(0, remaining) : rawChunk;
      truncated ||= chunk.length < rawChunk.length;
      bytesRead += chunk.length;
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(0x0a, offset);
        const end = newline === -1 ? chunk.length : newline;
        if (!skipping) {
          pendingBytes += end - offset;
          if (pendingBytes > maxLineBytes) {
            skipping = true;
            pending = [];
            pendingBytes = 0;
          } else {
            pending.push(chunk.subarray(offset, end));
          }
        }
        if (newline === -1) break;
        offset = newline + 1;
        if (skipping) {
          skipping = false;
          oversizedLines += 1;
          continue;
        }
        if (!flushLine()) {
          stopped = true;
          break;
        }
      }
      if (stopped) break;
      if (bytesRead >= maxBytes) {
        truncated = true;
        break;
      }
    }
  } finally {
    stream.destroy();
  }
  // A rollout being appended to right now legitimately ends mid-line; only a
  // complete final line (no trailing newline) is worth handing to the parser.
  if (!stopped && !truncated && !skipping && pendingBytes > 0) flushLine();
  return { bytesRead, truncated, oversizedLines };
}

/* ---------- rollout parsing ---------- */

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Codex content parts are `{type:"input_text"|"output_text", text}`; tolerate strings. */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      if (part) parts.push(part);
      continue;
    }
    if (!isRecord(part)) continue;
    const text = part.text;
    if (typeof text === "string" && text) parts.push(text);
  }
  return parts.join("\n");
}

export function isSyntheticCodexUserText(text: string): boolean {
  const match = /^<([a-z0-9_]+)>/i.exec(text.trimStart());
  return match ? SYNTHETIC_USER_TAGS.has(match[1].toLowerCase()) : false;
}

function clampText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}${TRUNCATION_MARKER}`;
}

function readMeta(payload: Record<string, unknown>, lineAt: string | undefined): CodexSessionMeta | undefined {
  // `id` first: it is the unique, resumable thread. `session_id` is a fallback
  // for any build that omits `id`, and is otherwise kept as `rootSessionId`.
  const threadId = stringValue(payload.id) ?? stringValue(payload.session_id);
  if (!threadId) return undefined;
  const meta: Mutable<CodexSessionMeta> = {
    threadId,
    cwd: stringValue(payload.cwd) ?? "",
    startedAt: stringValue(payload.timestamp) ?? lineAt ?? "",
  };
  // `exactOptionalPropertyTypes` is on: an optional field is set or absent,
  // never explicitly undefined.
  const optional = {
    rootSessionId: stringValue(payload.session_id),
    forkedFromId: stringValue(payload.forked_from_id),
    parentThreadId: stringValue(payload.parent_thread_id),
    threadSource: stringValue(payload.thread_source),
    originator: stringValue(payload.originator),
    cliVersion: stringValue(payload.cli_version),
    // An object for subagent threads; only a plain string is meaningful here.
    source: stringValue(payload.source),
    modelProvider: stringValue(payload.model_provider),
  } as const;
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) meta[key as keyof typeof optional] = value;
  }
  return meta;
}

/** `world_state.state.collaboration_mode.model` — the shape `turn_context` omits on some builds. */
function readWorldStateModel(payload: Record<string, unknown>): string | undefined {
  const state = payload.state;
  if (!isRecord(state)) return undefined;
  const mode = state.collaboration_mode;
  return isRecord(mode) ? stringValue(mode.model) : undefined;
}

/** Bytes the meta probe reads. Largest `session_meta` line measured here: 64 KB. */
const META_PROBE_BYTES = 1024 * 1024;

/**
 * Read ONLY the `session_meta` line and stop.
 *
 * Discovery uses this to reject the 316-of-438 subagent rollouts before paying
 * for a full head-window scan of each. Costs one read of the first chunk.
 */
export async function readCodexSessionMeta(filePath: string): Promise<CodexSessionMeta> {
  let meta: CodexSessionMeta | undefined;
  try {
    await scanLines(filePath, META_PROBE_BYTES, CODEX_MAX_LINE_BYTES, (line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      if (!isRecord(parsed) || stringValue(parsed.type) !== "session_meta") return;
      const payload = parsed.payload;
      if (!isRecord(payload)) return;
      meta = readMeta(payload, stringValue(parsed.timestamp));
      return meta === undefined;
    });
  } catch (error) {
    throw new CodexSessionError("unreadable", `Cannot read Codex rollout: ${(error as Error).message}`, filePath);
  }
  if (!meta) throw new CodexSessionError("missing_session_meta", `Codex rollout has no session_meta line: ${filePath}`, filePath);
  return meta;
}

/**
 * Parse one rollout file into meta + a user/assistant transcript.
 *
 * Throws `CodexSessionError` only for a file that cannot be read at all or that
 * carries no `session_meta`; every other defect is absorbed into `stats`.
 */
export async function readCodexRollout(filePath: string, limits: CodexReadLimits = {}): Promise<CodexRollout> {
  const maxBytes = limits.maxBytes ?? CODEX_IMPORT_SCAN_BYTES;
  const maxLineBytes = limits.maxLineBytes ?? CODEX_MAX_LINE_BYTES;
  const maxMessages = limits.maxMessages ?? CODEX_MAX_MESSAGES;
  const maxMessageChars = limits.maxMessageChars ?? CODEX_MAX_MESSAGE_CHARS;

  let meta: CodexSessionMeta | undefined;
  let model: string | undefined;
  let lastEventAt: string | undefined;
  let lastEventMs = Number.NEGATIVE_INFINITY;
  let malformedLines = 0;
  let droppedMessages = 0;
  const messages: CodexTranscriptMessage[] = [];
  // Only used when the file carries no `response_item` messages at all, which
  // guards format drift without ever double-counting the normal shape.
  const eventFallback: CodexTranscriptMessage[] = [];

  const push = (into: CodexTranscriptMessage[], role: "user" | "assistant", text: string, at: string | undefined): void => {
    if (!text.trim()) return;
    if (into.length >= maxMessages) {
      droppedMessages += 1;
      return;
    }
    const clamped = clampText(text, maxMessageChars);
    into.push(at ? { role, text: clamped, at } : { role, text: clamped });
  };

  let scan: LineScanResult;
  try {
    scan = await scanLines(filePath, maxBytes, maxLineBytes, (line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        malformedLines += 1;
        return;
      }
      if (!isRecord(parsed)) {
        malformedLines += 1;
        return;
      }
      const payload = parsed.payload;
      if (!isRecord(payload)) return;
      const lineAt = stringValue(parsed.timestamp);
      if (lineAt) {
        // Every line type counts: the newest write is the newest write, whether
        // it was a message, a turn_context, or a compaction marker.
        const at = Date.parse(lineAt);
        if (Number.isFinite(at) && at > lastEventMs) {
          lastEventMs = at;
          lastEventAt = lineAt;
        }
      }
      switch (stringValue(parsed.type)) {
        case "session_meta":
          meta ??= readMeta(payload, lineAt);
          return;
        case "turn_context":
          model = stringValue(payload.model) ?? model;
          return;
        case "world_state":
          model = readWorldStateModel(payload) ?? model;
          return;
        case "response_item": {
          if (stringValue(payload.type) !== "message") return;
          const role = stringValue(payload.role);
          if (role !== "user" && role !== "assistant") return;
          const text = extractText(payload.content);
          if (role === "user" && isSyntheticCodexUserText(text)) return;
          push(messages, role, text, lineAt);
          return;
        }
        case "event_msg": {
          const kind = stringValue(payload.type);
          if (kind !== "user_message" && kind !== "agent_message") return;
          const text = stringValue(payload.message) ?? "";
          const role = kind === "user_message" ? "user" : "assistant";
          if (role === "user" && isSyntheticCodexUserText(text)) return;
          push(eventFallback, role, text, lineAt);
          return;
        }
        default:
          return;
      }
    });
  } catch (error) {
    throw new CodexSessionError("unreadable", `Cannot read Codex rollout: ${(error as Error).message}`, filePath);
  }

  if (!meta) throw new CodexSessionError("missing_session_meta", `Codex rollout has no session_meta line: ${filePath}`, filePath);

  const rollout: {
    filePath: string;
    meta: CodexSessionMeta;
    model?: string;
    messages: readonly CodexTranscriptMessage[];
    lastEventAt?: string;
    stats: CodexRolloutStats;
  } = {
    filePath,
    meta,
    messages: messages.length ? messages : eventFallback,
    stats: {
      bytesRead: scan.bytesRead,
      truncated: scan.truncated,
      malformedLines,
      oversizedLines: scan.oversizedLines,
      droppedMessages,
    },
  };
  if (model) rollout.model = model;
  if (lastEventAt) rollout.lastEventAt = lastEventAt;
  return rollout;
}

/* ---------- discovery ---------- */

export interface CodexRolloutFile {
  readonly filePath: string;
  readonly mtimeMs: number;
  readonly sizeBytes: number;
}

/** `7d` / `24h` / `30m` / `90s`, an ISO date, epoch ms, or a `Date`. */
export function parseCodexSince(since: string | number | Date | undefined, nowMs = Date.now()): number | undefined {
  if (since === undefined) return undefined;
  if (since instanceof Date) return Number.isFinite(since.getTime()) ? since.getTime() : undefined;
  if (typeof since === "number") return Number.isFinite(since) ? since : undefined;
  const relative = /^(\d+)\s*([smhdw])$/i.exec(since.trim());
  if (relative) {
    const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[relative[2].toLowerCase() as "s" | "m" | "h" | "d" | "w"];
    return nowMs - Number(relative[1]) * unit;
  }
  const parsed = Date.parse(since);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** All `rollout-*.jsonl` under the sessions root, newest mtime first. */
export async function listCodexRolloutFiles(codexHome?: string): Promise<readonly CodexRolloutFile[]> {
  const root = codexSessionsDir(codexHome);
  let entries: Dirent[];
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw new CodexSessionError("sessions_root_missing", `Cannot list Codex sessions at ${root}: ${(error as Error).message}`, root);
  }
  const files: CodexRolloutFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) continue;
    const filePath = join(entry.parentPath, entry.name);
    try {
      const info = await stat(filePath);
      files.push({ filePath, mtimeMs: info.mtimeMs, sizeBytes: info.size });
    } catch {
      // Codex rotated or removed it mid-scan; it simply is not there to list.
    }
  }
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

/**
 * When the thread was actually last worked on.
 *
 * mtime is only a proxy, and a lying one whenever something other than Codex
 * writes the file: a day-old thread rendered "1s" old in `muster codex sessions`
 * because its rollout had been re-touched. The rollout's own newest line
 * timestamp is the truth — but only when the scan reached EOF, because a head
 * window stops long before the newest line of a large rollout. So: rollout
 * timestamp on a complete scan, mtime otherwise, and say which one was used.
 */
export function resolveCodexLastActivity(
  rollout: Pick<CodexRollout, "lastEventAt" | "stats">,
  mtimeMs: number,
): { readonly lastActivityAt: string; readonly lastActivitySource: "rollout" | "mtime" } {
  const at = rollout.lastEventAt ? Date.parse(rollout.lastEventAt) : Number.NaN;
  if (!rollout.stats.truncated && Number.isFinite(at)) {
    return { lastActivityAt: new Date(at).toISOString(), lastActivitySource: "rollout" };
  }
  return { lastActivityAt: new Date(mtimeMs).toISOString(), lastActivitySource: "mtime" };
}

function summarize(rollout: CodexRollout, file: CodexRolloutFile): CodexSessionSummary {
  const userMessages = rollout.messages.filter((message) => message.role === "user");
  const summary: CodexSessionSummary = {
    ...rollout.meta,
    filePath: file.filePath,
    turnCount: userMessages.length,
    turnCountExact: !rollout.stats.truncated,
    messageCount: rollout.messages.length,
    firstUserMessage: userMessages[0]?.text ?? "",
    ...resolveCodexLastActivity(rollout, file.mtimeMs),
    sizeBytes: file.sizeBytes,
  };
  return rollout.model ? { ...summary, model: rollout.model } : summary;
}

/* ---------- prompt preview ---------- */

/**
 * Lines that are scaffolding rather than something a human said: YAML front
 * matter and its scalar keys, plugin/skill manifest references, fence markers,
 * and bullet lists that only ever precede the real ask. Matched conservatively
 * — a key must be a bare lower_snake token with a single-token value, so
 * "Fix: rebuild the dist first" (multi-word value) survives as prose.
 */
const PROMPT_NOISE_LINE = [
  /^-{3,}$/,
  /^`{3,}/,
  /^#/,
  /^[a-z][a-z0-9_.-]*\s*:\s*\S*$/,
  /^[-*]\s+[a-z][a-z0-9_.-]*\s*:\s*\S*$/,
  /^[-*]\s*$/,
  /^(?:plugin|skill|tool|mcp)s?\s*:/i,
] as const;

/** Structural markers that are never worth showing, even in the fallback. */
const PROMPT_STRUCTURAL_LINE = /^(?:-{3,}|`{3,}.*)$/;

function isPromptNoiseLine(line: string): boolean {
  return PROMPT_NOISE_LINE.some((pattern) => pattern.test(line));
}

/**
 * Render a rollout's opening prompt as one readable line.
 *
 * `firstUserMessage` keeps full fidelity for import and search; a table column
 * cannot. Markup is dropped, fenced blocks are dropped whole, leading manifest
 * noise is skipped, and what is returned is the first sentence a HUMAN wrote.
 * Returns "" when there is nothing but scaffolding — the caller decides how to
 * say "no user message" rather than being handed an invented one.
 */
export function summarizeCodexPrompt(text: string, maxChars = 200): string {
  const withoutFences = text.replace(/```[\s\S]*?(?:```|$)/g, " ");
  // `[@chrome](plugin://chrome@openai-bundled)` is a plugin reference the TUI
  // renders as a chip; in a table it is 30 characters of URL for one word.
  const withoutRefs = withoutFences.replace(/\[@?([^\]]*)\]\((?:plugin|https?|file|mcp):\/\/[^)]*\)/g, "$1");
  const withoutTags = withoutRefs.replace(/<\/?[a-z][a-z0-9_:.-]*(?:\s[^>]*)?>/gi, " ");
  const lines = withoutTags.split(/\r?\n/).map((line) => line.trim());
  const prose: string[] = [];
  for (const line of lines) {
    if (!line) continue;
    // Skip scaffolding only while it LEADS the message; once prose starts, the
    // rest of the paragraph belongs to the human.
    if (!prose.length && isPromptNoiseLine(line)) continue;
    prose.push(line);
  }
  // A prompt that is ONLY a config paste has no human sentence to prefer. Show
  // it, minus the structural markers — an honest ugly preview beats claiming
  // there was no message at all.
  const shown = prose.length ? prose : lines.filter((line) => line && !PROMPT_STRUCTURAL_LINE.test(line));
  const collapsed = shown.join(" ").replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(collapsed)?.[1];
  const preview = sentence && sentence.length >= 12 ? sentence : collapsed;
  return preview.length <= maxChars ? preview : `${preview.slice(0, maxChars - 1)}…`;
}

/* ---------- fork lineage ---------- */

export interface CodexSessionLineageRow {
  readonly session: CodexSessionSummary;
  /** 0 for a root thread; 1+ for a fork whose ancestor is also in the listing. */
  readonly depth: number;
}

/**
 * Order a listing so forks sit under the thread they were forked from.
 *
 * A fork is the SAME conversation continued, so listing it as an unrelated row
 * (usually adjacent, since it shares recent activity) reads as duplicate work.
 * Roots keep the caller's order; each fork follows its parent, depth+1, forks of
 * forks nested further. A thread whose parent is not in this listing is a root
 * here — the parent may be older than `--limit` or filtered out entirely.
 */
export function orderCodexSessionsByLineage(
  sessions: readonly CodexSessionSummary[],
): readonly CodexSessionLineageRow[] {
  const present = new Set(sessions.map((session) => session.threadId));
  const children = new Map<string, CodexSessionSummary[]>();
  const roots: CodexSessionSummary[] = [];
  for (const session of sessions) {
    const parent = session.forkedFromId;
    if (parent && parent !== session.threadId && present.has(parent)) {
      const bucket = children.get(parent);
      if (bucket) bucket.push(session);
      else children.set(parent, [session]);
    } else {
      roots.push(session);
    }
  }
  const rows: CodexSessionLineageRow[] = [];
  // Visited guard: a malformed fork cycle must not hang or duplicate a row.
  const visited = new Set<string>();
  const walk = (session: CodexSessionSummary, depth: number): void => {
    if (visited.has(session.threadId)) return;
    visited.add(session.threadId);
    rows.push({ session, depth });
    for (const child of children.get(session.threadId) ?? []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  // Any thread stranded by a cycle still gets listed; nothing silently vanishes.
  for (const session of sessions) if (!visited.has(session.threadId)) walk(session, 0);
  return rows;
}

/**
 * Summarize the user's recent Codex threads, newest activity first.
 *
 * Reads a HEAD WINDOW of each rollout (invariant 3) — enough for meta, model,
 * and the opening prompt, and for the full turn count on any session that fits.
 * Sessions whose files cannot be parsed land in `skipped` instead of failing the
 * scan (invariant 2).
 */
export async function discoverCodexSessions(options: DiscoverCodexSessionsOptions = {}): Promise<CodexDiscoveryResult> {
  const root = codexSessionsDir(options.codexHome);
  const files = await listCodexRolloutFiles(options.codexHome);
  const sinceMs = parseCodexSince(options.since, options.nowMs);
  const limit = Math.max(0, options.limit ?? 25);
  const limits: CodexReadLimits = {
    maxBytes: options.maxBytes ?? CODEX_DISCOVERY_SCAN_BYTES,
    ...(options.maxLineBytes === undefined ? {} : { maxLineBytes: options.maxLineBytes }),
    ...(options.maxMessages === undefined ? {} : { maxMessages: options.maxMessages }),
    ...(options.maxMessageChars === undefined ? {} : { maxMessageChars: options.maxMessageChars }),
  };
  const sessions: CodexSessionSummary[] = [];
  const skipped: CodexRolloutSkip[] = [];
  let scanned = 0;
  let subagentsHidden = 0;
  for (const file of files) {
    if (sessions.length >= limit) break;
    // Files are mtime-descending, so the first one older than the cutoff ends it.
    if (sinceMs !== undefined && file.mtimeMs < sinceMs) break;
    scanned += 1;
    try {
      // Probe the meta line first so an excluded thread never costs a full scan.
      const meta = await readCodexSessionMeta(file.filePath);
      if (!options.includeSubagents && meta.threadSource === "subagent") {
        subagentsHidden += 1;
        continue;
      }
      if (options.cwd !== undefined && normalizeCodexWorkspace(meta.cwd) !== normalizeCodexWorkspace(options.cwd)) continue;
      sessions.push(summarize(await readCodexRollout(file.filePath, limits), file));
    } catch (error) {
      const skip = error instanceof CodexSessionError
        ? { filePath: file.filePath, reason: error.code, detail: error.message }
        : { filePath: file.filePath, reason: "unreadable" as const, detail: (error as Error).message };
      skipped.push(skip);
    }
  }
  return { root, sessions, skipped, scanned, candidates: files.length, subagentsHidden };
}

/* ---------- lineage + lookup ---------- */

/**
 * Resolve `<threadId-prefix>` the way a human types it: an exact id always wins,
 * otherwise a unique case-insensitive prefix. Two matches is a question for the
 * user, not a coin flip.
 */
export function matchCodexThread<T extends { readonly threadId: string }>(
  sessions: readonly T[],
  prefix: string,
): CodexThreadMatch<T> {
  const needle = prefix.trim().toLowerCase();
  if (!needle) return { kind: "none" };
  const exact = sessions.find((session) => session.threadId.toLowerCase() === needle);
  if (exact) return { kind: "match", session: exact };
  const candidates = sessions.filter((session) => session.threadId.toLowerCase().startsWith(needle));
  if (!candidates.length) return { kind: "none" };
  if (candidates.length > 1) return { kind: "ambiguous", candidates };
  return { kind: "match", session: candidates[0] };
}

/**
 * Ancestors of `threadId` oldest-first, ending with the thread itself. Codex
 * forks (`/new` from a point in history) chain arbitrarily deep; a `seen` guard
 * keeps a malformed cycle from hanging the CLI.
 */
export function resolveCodexForkChain(
  sessions: readonly CodexSessionSummary[],
  threadId: string,
): readonly CodexSessionSummary[] {
  const byId = new Map(sessions.map((session) => [session.threadId, session]));
  const chain: CodexSessionSummary[] = [];
  const seen = new Set<string>();
  let current = byId.get(threadId);
  while (current && !seen.has(current.threadId)) {
    seen.add(current.threadId);
    chain.unshift(current);
    const parent = current.forkedFromId ?? current.parentThreadId;
    current = parent ? byId.get(parent) : undefined;
  }
  return chain;
}

/* ---------- import ---------- */

/** Stable, never-truncated identity prefix; matching an import is a `startsWith`. */
export function codexImportTitlePrefix(threadId: string): string {
  return `codex ${threadId}`;
}

export function codexImportPeer(cwd: string): string {
  return basename(cwd.replace(/[/\\]+$/, "")) || "codex";
}

export function codexImportTitle(threadId: string, cwd: string): string {
  return `${codexImportTitlePrefix(threadId)} (${codexImportPeer(cwd).slice(0, 30)})`;
}

/**
 * The provenance header. Deliberately built from IMMUTABLE facts only — a field
 * that can change between scans (model, turn count) would break the prefix match
 * that makes re-import idempotent.
 */
function provenanceMessage(meta: CodexSessionMeta): string {
  const lines = [
    `Imported Codex session ${meta.threadId}`,
    `workspace: ${meta.cwd || "(unknown)"}`,
    `started: ${meta.startedAt || "(unknown)"}`,
  ];
  if (meta.forkedFromId) lines.push(`forked from: ${meta.forkedFromId}`);
  if (meta.parentThreadId) lines.push(`parent thread: ${meta.parentThreadId}`);
  return lines.join("\n");
}

function findImportedSession(store: SessionStore, threadId: string, scanLimit: number): string | undefined {
  const result = store.search({ limit: scanLimit });
  if (result.shape !== "browse") return undefined;
  const prefix = codexImportTitlePrefix(threadId);
  return result.sessions.find((session) => session.channel === CODEX_IMPORT_CHANNEL && session.title.startsWith(prefix))?.id;
}

/**
 * Write a Codex thread's transcript into Muster's SessionStore so cross-session
 * search, memory recall, and the token ledger cover work done in raw Codex.
 *
 * Append-only and idempotent (invariant 4): a second call after the user added
 * three turns in Codex appends exactly those three. If the stored transcript is
 * not a prefix of the rollout, nothing is written and `diverged` is true.
 */
export async function importCodexSession(
  summary: CodexSessionSummary,
  store: SessionStore,
  options: ImportCodexSessionOptions = {},
): Promise<CodexImportResult> {
  const limits: CodexReadLimits = {
    maxBytes: options.maxBytes ?? CODEX_IMPORT_SCAN_BYTES,
    ...(options.maxLineBytes === undefined ? {} : { maxLineBytes: options.maxLineBytes }),
    ...(options.maxMessages === undefined ? {} : { maxMessages: options.maxMessages }),
    ...(options.maxMessageChars === undefined ? {} : { maxMessageChars: options.maxMessageChars }),
  };
  const rollout = await readCodexRollout(summary.filePath, limits);
  const threadId = rollout.meta.threadId;
  const desired: { role: string; content: string }[] = [
    { role: "system", content: provenanceMessage(rollout.meta) },
    ...rollout.messages.map((message) => ({ role: message.role, content: message.text })),
  ];

  const existingId = findImportedSession(store, threadId, options.scanLimit ?? CODEX_IMPORT_SCAN_LIMIT);
  const sessionId = existingId
    ?? store.createSession({
      channel: CODEX_IMPORT_CHANNEL,
      peer: codexImportPeer(rollout.meta.cwd),
      title: codexImportTitle(threadId, rollout.meta.cwd),
      workspaceCwd: rollout.meta.cwd || null,
    }).id;
  // Re-importing a thread created before the binding column shipped upgrades
  // that imported row in place; unrelated old rows intentionally stay global.
  store.setWorkspaceCwd(sessionId, rollout.meta.cwd || null);

  const stored = store.loadActiveMessages(sessionId);
  let matched = 0;
  while (matched < stored.length && matched < desired.length
    && stored[matched].role === desired[matched].role
    && stored[matched].content === desired[matched].content) {
    matched += 1;
  }
  const diverged = matched < stored.length;
  let appended = 0;
  if (!diverged) {
    for (const message of desired.slice(matched)) {
      store.appendMessage(sessionId, message.role, message.content);
      appended += 1;
    }
  }
  return {
    sessionId,
    threadId,
    created: existingId === undefined,
    appended,
    alreadyPresent: matched,
    diverged,
    stats: rollout.stats,
  };
}
