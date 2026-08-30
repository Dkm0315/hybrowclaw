export interface PreviewMessage {
  readonly role: string;
  readonly text?: string;
  readonly content?: string;
}

const INJECTED_LINE = [
  /^Recalled context\b/i,
  /^\[@/,
  /^cluster\s*:/i,
  /^<\/?(?:environment_context|goal_context|ide_context|skills?_instructions|user_instructions)\b/i,
  /^(?:#{1,6}|>|```|---)\s*/,
  /^[-*+]\s+/,
  /^!?\[[^\]]*\]\([^)]+\)\s*$/,
  /^[a-z][a-z0-9_.-]*\s*:\s*(?:[\[{]|.*(?:^|\s)[a-z][a-z0-9_.-]*\s*:)/i,
  /^[a-z][a-z0-9_.-]*\s*:\s*\S*$/i,
  /^[-*]\s+[a-z][a-z0-9_.-]*\s*:\s*\S*$/i,
  /^(?:plugin|skill|tool|mcp)s?\s*:/i,
] as const;

function looksLikeLongYaml(line: string): boolean {
  if (line.length <= 120) return false;
  const assignments = line.match(/(?:^|\s)[a-z][a-z0-9_.-]*\s*:/gi)?.length ?? 0;
  return assignments >= 2 || /^[{[]/.test(line);
}

export function isInjectedSessionPreviewLine(value: string): boolean {
  const line = value.trim();
  return !line || INJECTED_LINE.some((pattern) => pattern.test(line)) || looksLikeLongYaml(line);
}

function sentenceFromText(text: string, maxChars: number): string | undefined {
  let fenced = false;
  const prose: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (/^\s*```/.test(rawLine)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (isInjectedSessionPreviewLine(rawLine)) continue;
    const line = rawLine
      .replace(/\[@?([^\]]*)\]\((?:plugin|https?|file|mcp):\/\/[^)]*\)/g, "$1")
      .replace(/<\/?[a-z][a-z0-9_:.-]*(?:\s[^>]*)?>/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (isInjectedSessionPreviewLine(line)) continue;
    prose.push(line);
  }
  const collapsed = prose.join(" ").replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(collapsed)?.[1];
  const preview = sentence && sentence.length >= 12 ? sentence : collapsed;
  return preview.length <= maxChars ? preview : `${preview.slice(0, Math.max(1, maxChars - 1))}…`;
}

/** First real human sentence, then first assistant sentence, never injected scaffolding. */
export function sessionPreview(messages: readonly PreviewMessage[], maxChars = 200): string {
  for (const role of ["user", "assistant"] as const) {
    for (const message of messages) {
      if (message.role !== role) continue;
      const preview = sentenceFromText(message.text ?? message.content ?? "", maxChars);
      if (preview) return preview;
    }
  }
  return "(no messages)";
}
