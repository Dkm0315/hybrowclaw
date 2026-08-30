export function threadConflictCure(importedFromCodex: boolean): string {
  return importedFromCodex
    ? "Close that conversation there and retry — or /codex resume <id> --fork to continue as a copy."
    : "/reset clears this conversation's provider thread";
}
