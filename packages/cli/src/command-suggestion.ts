export function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? left.length;
}

export function nearestCommand(input: string, candidates: readonly string[], maxDistance = 3): string | undefined {
  const target = input.toLowerCase();
  return candidates
    .map((candidate, index) => ({ candidate, index, distance: editDistance(target, candidate.toLowerCase()) }))
    .filter((entry) => entry.distance <= maxDistance)
    .sort((left, right) => left.distance - right.distance || left.index - right.index)[0]?.candidate;
}

export function unknownSlashCommandMessage(input: string, candidates: readonly string[]): string {
  const suggestion = nearestCommand(input, candidates);
  return suggestion
    ? `unknown command /${input} — did you mean /${suggestion}?`
    : `unknown command /${input} — try /help`;
}

export function unknownShellCommandMessage(input: string, candidates: readonly string[]): string {
  const suggestion = nearestCommand(input, candidates);
  return suggestion
    ? `unknown command ${input} — did you mean ${suggestion}?`
    : `unknown command ${input} — try muster --help`;
}
