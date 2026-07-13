import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join as pathJoin } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { isPreDispatchSpawnError, runSubprocess } from "./subprocess.js";

const execFileAsync = promisify(execFile);
const CODEX_EXEC_SUPPORT_CACHE = new Map<string, boolean>();

/**
 * Drives the user's OWN codex CLI at FULL native power (shell, apply_patch,
 * web_search, MCP) via `codex exec --json`, replacing the legacy stripped
 * one-shot `codex -q -m <model> <prompt>`. muster owns orchestration; codex
 * owns the model loop, native tools, compaction, and sessions. muster layers
 * its memory/skills in through `experimental_instructions_file` (system level,
 * never the user turn) so the provider's own AGENTS.md still stacks natively.
 */
export interface CodexRunInput {
  readonly prompt: string;
  /** Profile workspace = the sandbox root (-C). Required; never the install root. */
  readonly cwd: string;
  /** User's chosen model, preserved (e.g. gpt-5.5). */
  readonly model?: string;
  readonly reasoning?: "none" | "low" | "medium" | "high";
  /**
   * muster memory + skill index, injected as a system-level instructions file
   * (-c experimental_instructions_file=). Goes to the system prompt, NOT the
   * user message — so it shapes behaviour without being narrated back (rule 6).
   */
  readonly instructionsFile?: string;
  readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  readonly approval?: "untrusted" | "on-request" | "never";
  readonly networkAccess?: boolean;
  /** thread_id captured from a prior turn's `thread.started` event. */
  readonly sessionId?: string;
  readonly resume?: boolean;
  /** Run without persisting a native Codex session handle. Faster startup, less continuity. */
  readonly ephemeral?: boolean;
  readonly ignoreRules?: boolean;
  /**
   * Environment for the spawned process. MUST carry CODEX_HOME + the user's
   * subscription auth (~/.codex/auth.json), else codex returns 401 under a
   * non-login shell. Merged over process.env.
   */
  readonly env?: Record<string, string>;
  readonly timeoutMs?: number;
  readonly command?: string;
}

export interface CodexRunResult {
  readonly status: "completed" | "failed";
  readonly command: string;
  readonly args: string[];
  /** The clean final agent message (from -o), for the surface reply. */
  readonly finalMessage: string;
  /** Native session handle to resume the next turn. */
  readonly threadId?: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly errorMessage?: string;
  readonly fallbackEligible?: boolean;
}

export async function inspectCodex(command = "codex"): Promise<{ readonly available: boolean; readonly version?: string; readonly supportsExec?: boolean }> {
  try {
    const result = await execFileAsync(command, ["--version"], { timeout: 5000 });
    return { available: true, version: result.stdout.trim() || result.stderr.trim(), supportsExec: await supportsCodexExec(command) };
  } catch {
    return { available: false };
  }
}

function resolveCodexCommand(command?: string): string {
  if (command) return command;
  if (process.env.MUSTER_CODEX_COMMAND) return process.env.MUSTER_CODEX_COMMAND;
  const appBundle = "/Applications/Codex.app/Contents/Resources/codex";
  if (existsSync(appBundle)) return appBundle;
  const home = process.env.HOME;
  if (home) {
    const candidates = [
      pathJoin(home, ".nvm/versions/node/v24.17.0/bin/codex"),
      pathJoin(home, ".nvm/versions/node/v22.22.3/bin/codex"),
      pathJoin(home, ".nvm/versions/node/v22.15.1/bin/codex"),
      pathJoin(home, ".nvm/versions/node/v20.19.5/bin/codex"),
      pathJoin(home, ".local/bin/codex"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return "codex";
}

export function buildCodexArgs(input: CodexRunInput, outputLastMessageFile: string): string[] {
  const isResume = Boolean(input.resume && input.sessionId);
  const args = isResume ? ["exec", "resume", "--json"] : ["exec", "--json"];
  if (!isResume && input.ephemeral) args.push("--ephemeral");
  if (!isResume) args.push("-C", input.cwd);
  args.push("--skip-git-repo-check");
  if (input.model) args.push("-m", input.model);
  if (input.reasoning) args.push("-c", `model_reasoning_effort=${JSON.stringify(input.reasoning === "none" ? "low" : input.reasoning)}`);
  if (!isResume) args.push("-s", input.sandbox ?? "workspace-write");
  if (input.ignoreRules) args.push("--ignore-rules");
  // `codex exec` is non-interactive (no approval prompt possible) and has NO `-a`
  // flag — that belongs to the interactive root command. Approval policy is set
  // via a config override. `never` is the correct headless value.
  args.push("-c", `approval_policy=${input.approval ?? "never"}`);
  if (input.networkAccess) args.push("-c", "sandbox_workspace_write.network_access=true");
  if (input.instructionsFile) args.push("-c", `experimental_instructions_file=${input.instructionsFile}`);
  args.push("-o", outputLastMessageFile);
  if (isResume && input.sessionId) args.push(input.sessionId);
  args.push(input.prompt);
  return args;
}

/**
 * Parse the codex `--json` JSONL event stream. We need the thread_id (resume
 * handle) and whether the turn failed; the final reply text comes from the -o
 * file, which is cleaner than reconstructing it from item deltas.
 */
export function parseCodexEvents(stdout: string): { threadId?: string; failed: boolean; failureMessage?: string } {
  let threadId: string | undefined;
  let failed = false;
  let failureMessage: string | undefined;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      threadId = event.thread_id;
    } else if (event.type === "turn.failed") {
      failed = true;
      const err = event.error;
      if (err && typeof err === "object" && "message" in err) {
        failureMessage = String((err as Record<string, unknown>).message);
      } else if (typeof event.message === "string") {
        failureMessage = event.message;
      }
    }
  }
  return { threadId, failed, failureMessage };
}

export async function runCodex(input: CodexRunInput): Promise<CodexRunResult> {
  if (!input.prompt.trim()) throw new Error("Codex prompt is required.");
  const command = resolveCodexCommand(input.command);
  const outputFile = join(tmpdir(), `muster-codex-${randomUUID()}.txt`);
  const args = buildCodexArgs(input, outputFile);
  const started = Date.now();
  if (!(await supportsCodexExec(command))) {
    return {
      status: "failed",
      command,
      args,
      finalMessage: "",
      stdout: "",
      stderr: "",
      durationMs: Date.now() - started,
      errorMessage: "Installed Codex CLI does not support `codex exec --json`. Update Codex or use the app-server transport; refusing to pass modern exec flags to a legacy interactive Codex binary.",
      fallbackEligible: true,
    };
  }
  // Inherit the real environment (so CODEX_HOME / auth resolve) and overlay
  // any caller-provided env. Without this codex 401s under headless shells.
  const env = { ...process.env, ...(input.env ?? {}) } as NodeJS.ProcessEnv;
  try {
    const result = await runSubprocess(command, args, {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs ?? 180_000,
      maxBuffer: 1024 * 1024 * 16,
      env,
    });
    const events = parseCodexEvents(result.stdout);
    const finalMessage = await readFinalMessage(outputFile);
    return {
      status: events.failed ? "failed" : "completed",
      command,
      args,
      finalMessage,
      threadId: events.threadId,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      durationMs: Date.now() - started,
      errorMessage: events.failed ? (events.failureMessage || "codex turn failed") : undefined,
    };
  } catch (error) {
    const detail = error as Error & { stdout?: string; stderr?: string };
    const events = parseCodexEvents(detail.stdout ?? "");
    const finalMessage = await readFinalMessage(outputFile);
    const stderr = detail.stderr?.trim() ?? "";
    const errorMessage = [detail.message, stderr ? truncateForError(stderr) : undefined].filter(Boolean).join(": ");
    return {
      status: "failed",
      command,
      args,
      finalMessage,
      threadId: events.threadId,
      stdout: detail.stdout?.trim() ?? "",
      stderr,
      durationMs: Date.now() - started,
      errorMessage,
      fallbackEligible: isPreDispatchSpawnError(error),
    };
  } finally {
    await rm(outputFile, { force: true }).catch(() => {});
  }
}

function truncateForError(value: string): string {
  return value.length <= 800 ? value : `${value.slice(0, 797)}...`;
}

async function readFinalMessage(file: string): Promise<string> {
  try {
    return (await readFile(file, "utf8")).trim();
  } catch {
    return "";
  }
}

async function supportsCodexExec(command: string): Promise<boolean> {
  const cached = CODEX_EXEC_SUPPORT_CACHE.get(command);
  if (cached !== undefined) return cached;
  try {
    await execFileAsync(command, ["exec", "--help"], { timeout: 5000 });
    CODEX_EXEC_SUPPORT_CACHE.set(command, true);
    return true;
  } catch {
    CODEX_EXEC_SUPPORT_CACHE.set(command, false);
    return false;
  }
}
