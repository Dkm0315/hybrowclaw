/**
 * Pure terminal-output helpers for the CLI.
 *
 * They live outside index.ts because index.ts IS the entry point — importing it
 * runs `main()`. Everything here is a total function over strings so the guards
 * that keep a one-shot run readable (and keep `--help` from becoming a prompt)
 * can be tested without spawning a process or spending a token.
 */

/**
 * Drop an unbalanced trailing code fence from a final answer.
 *
 * Backends routinely stop a beat early and leave an opening ``` with nothing
 * inside it. A terminal has no markdown renderer, so that prints as a bare
 * fence line and reads as truncated output. Only an ODD number of fences —
 * i.e. one genuinely left open — with nothing after the last one is trimmed; a
 * well-formed answer is returned byte-identical.
 */
export function trimDanglingCodeFence(text: string): string {
  const fences = text.match(/^[ \t]*`{3,}.*$/gm);
  if (!fences || fences.length % 2 === 0) return text;
  return text.replace(/\n?[ \t]*`{3,}[^\n`]*\s*$/, "");
}

/**
 * Usage lines for one command, lifted from the master help text.
 *
 * Derived rather than duplicated: a command's help can never drift from the
 * table `muster --help` prints, because it IS that table, filtered.
 */
export function commandUsageLines(helpText: string, name: string): readonly string[] {
  const pattern = new RegExp(`^\\s+muster ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`);
  return helpText.split("\n").filter((line) => pattern.test(line));
}
