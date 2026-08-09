import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isPreDispatchSpawnError, runSubprocess } from "./subprocess.js";

const execFileAsync = promisify(execFile);

export interface ClaudeCodeRunInput {
  readonly prompt: string;
  /**
   * Operating rules / recalled context to apply as the Claude CLI *system*
   * prompt (via --append-system-prompt) rather than inlining into the user
   * message — inlining makes the model narrate the rules back into its answer.
   */
  readonly systemPrompt?: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max";
  readonly allowedTools?: readonly string[];
  readonly pluginDirs?: readonly string[];
  readonly timeoutMs?: number;
  readonly command?: string;
  /**
   * A muster-managed session id (UUID). When set, the session is persisted so a
   * follow-up turn can resume it — muster pins its OWN id (`--session-id`) rather
   * than parsing one out of Claude's output, keeping the text output format.
   */
  readonly sessionId?: string;
  readonly resume?: boolean;
}

export interface ClaudeCodeRunResult {
  readonly status: "completed" | "failed";
  readonly command: string;
  readonly args: string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly errorMessage?: string;
  readonly fallbackEligible?: boolean;
}

export async function inspectClaudeCode(command = "claude"): Promise<{ readonly available: boolean; readonly version?: string }> {
  try {
    const result = await execFileAsync(command, ["--version"], { timeout: 5000 });
    return { available: true, version: result.stdout.trim() || result.stderr.trim() };
  } catch {
    return { available: false };
  }
}

export async function runClaudeCode(input: ClaudeCodeRunInput): Promise<ClaudeCodeRunResult> {
  if (!input.prompt.trim()) throw new Error("Claude Code prompt is required.");
  const command = input.command ?? "claude";
  const args = buildClaudeCodeArgs(input);
  const started = Date.now();
  try {
    const result = await runSubprocess(command, args, {
      cwd: input.cwd ?? process.cwd(),
      timeoutMs: input.timeoutMs ?? 120_000,
      maxBuffer: 1024 * 1024 * 8
    });
    return {
      status: "completed",
      command,
      args,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      durationMs: Date.now() - started
    };
  } catch (error) {
    const detail = error as Error & { stdout?: string; stderr?: string };
    return {
      status: "failed",
      command,
      args,
      stdout: detail.stdout?.trim() ?? "",
      stderr: detail.stderr?.trim() ?? "",
      durationMs: Date.now() - started,
      errorMessage: detail.message,
      fallbackEligible: isPreDispatchSpawnError(error),
    };
  }
}

export function buildClaudeCodeArgs(input: ClaudeCodeRunInput): string[] {
  const args = ["--print", "--output-format", "text"];
  // Persist the session only when muster is managing a session id; otherwise keep
  // the original stateless behaviour. Resume an existing session, or pin a fresh
  // one with the muster-generated id so the next turn can resume it.
  if (input.resume && input.sessionId) args.push("--resume", input.sessionId);
  else if (input.sessionId) args.push("--session-id", input.sessionId);
  else args.push("--no-session-persistence");
  if (input.model) args.push("--model", input.model);
  if (input.effort) args.push("--effort", input.effort);
  if (input.allowedTools?.length) args.push("--allowedTools", input.allowedTools.join(","));
  for (const pluginDir of input.pluginDirs ?? []) args.push("--plugin-dir", pluginDir);
  if (input.systemPrompt) args.push("--append-system-prompt", input.systemPrompt);
  args.push(input.prompt);
  return args;
}
