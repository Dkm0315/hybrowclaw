import type { BuiltinCapabilityMention } from "@musterhq/core";

const EXPLICIT_INTENT = /\b(?:use|enable|install|set\s+up)\b/gi;

/**
 * Catalog discovery is deliberately fuzzy; unsolicited setup checks are not.
 * A check needs an explicit setup/use verb and a boundary-safe capability
 * name. Keyword-only hits are accepted only when the user also names the
 * capability kind, preventing ordinary words such as "line" from becoming a
 * plugin action.
 */
export function intentfulCapabilityMentions(
  prompt: string,
  mentions: readonly BuiltinCapabilityMention[],
): readonly BuiltinCapabilityMention[] {
  const clauses = intentObjectClauses(prompt);
  if (!clauses.length) return [];
  return mentions.filter((mention) => {
    return clauses.some((clause) => {
      const term = containsTerm(clause, mention.id) ? mention.id : containsTerm(clause, mention.matched) ? mention.matched : undefined;
      if (!term) return false;
      const namesAnyKind = /\b(?:plugin|integration|mcp|server|skill)\b/i.test(clause);
      if (namesAnyKind && !termNamesKind(clause, term, mention.kind)) return false;
      return mention.confidence !== "keyword" || termNamesKind(clause, term, mention.kind);
    });
  });
}

function intentObjectClauses(prompt: string): string[] {
  const clauses: string[] = [];
  EXPLICIT_INTENT.lastIndex = 0;
  for (let match = EXPLICIT_INTENT.exec(prompt); match; match = EXPLICIT_INTENT.exec(prompt)) {
    const rest = prompt.slice(EXPLICIT_INTENT.lastIndex);
    const object = rest.split(/\b(?:to|for|so\s+that|in\s+order\s+to)\b|[.!?;\n]/i, 1)[0]?.trim();
    if (object) clauses.push(object);
  }
  return clauses;
}

function termNamesKind(text: string, term: string, kind: BuiltinCapabilityMention["kind"]): boolean {
  const kinds = kind === "mcp" ? "(?:mcp|server)" : kind === "plugin" ? "(?:plugin|integration)" : "skill";
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\-/g, "[ -]");
  return new RegExp(`(?:${escaped}\\s+${kinds}|${kinds}\\s+${escaped})`, "i").test(text);
}

/** A high-risk enable is never staged into an editable/submittable composer. */
export function composerPrefillForCapabilityMention(
  mention: BuiltinCapabilityMention,
  state: { readonly enabled?: boolean; readonly configured?: boolean } = {},
): string | undefined {
  if (mention.kind === "plugin") {
    if (mention.risk === "high" && !state.enabled) return undefined;
    return `/plugins ${mention.id}`;
  }
  if (mention.kind === "skill") return `/skills ${mention.id}`;
  return `/mcp ${state.configured ? `test ${mention.id}` : mention.id}`;
}

function containsTerm(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\-/g, "[ -]");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(text);
}
