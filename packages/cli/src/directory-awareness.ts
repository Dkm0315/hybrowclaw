import { homedir } from "node:os";

/** Deterministic, local-only detection for prompts that explicitly ask for parallel work. */
export function isParallelWorkPrompt(prompt: string): boolean {
  const text = prompt.toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return false;
  return [
    /\bsplit\b.{0,48}\binto\s+(?:parallel\s+)?tasks?\b/,
    /\bin parallel\b/,
    /\borchestrat(?:e|ing)\b/,
    /\bdivide\b.{0,40}\b(?:the\s+)?work\b/,
    /\bparallel(?:ize|ise)\b.{0,40}\b(?:the\s+)?(?:work|tasks?|implementation)\b/,
  ].some((pattern) => pattern.test(text));
}

export function displayWorkspacePath(path: string, home = homedir()): string {
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function formatWorkspaceMismatchBanner(workspaceCwd: string, home = homedir()): string {
  return `this conversation belongs to ${displayWorkspacePath(workspaceCwd, home)} — [enter] work there · [c] continue here`;
}

export type ParallelTaskChoice = "tasks" | "single";

/** Enter accepts; escape or any other key keeps the original prompt as one turn. */
export function parallelTaskChoiceForKey(data: string): ParallelTaskChoice {
  return data === "\r" || data === "\n" ? "tasks" : "single";
}

export type WorkspaceMismatchChoice = "home" | "here" | undefined;

export function workspaceMismatchChoiceForKey(data: string): WorkspaceMismatchChoice {
  if (data === "\r" || data === "\n") return "home";
  if (data.toLowerCase() === "c") return "here";
  return undefined;
}

export function workspaceOverrideForMismatchChoice(workspaceCwd: string, choice: Exclude<WorkspaceMismatchChoice, undefined>): string | undefined {
  return choice === "home" ? workspaceCwd : undefined;
}
