import { createHash } from "node:crypto";
import type { FrappeGraphProvenance, FrappeGraphValue } from "./customization-graph.js";

export const FRAPPE_LINEAGE_STATUSES = ["Current", "Requires review", "Requires regeneration", "Inconsistent", "Blocked", "Superseded"] as const;
export type FrappeLineageStatus = (typeof FRAPPE_LINEAGE_STATUSES)[number];

export interface FrappeLineageStage {
  readonly id: string;
  readonly label: string;
  readonly doctype: string;
  readonly route?: string;
}

export interface FrappeLineageFieldMap {
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly comparison?: "exact" | "normalized" | "set" | "ordered";
  readonly mismatchStatus?: Extract<FrappeLineageStatus, "Requires review" | "Requires regeneration" | "Inconsistent">;
}

export interface FrappeLineageRelationship {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly cardinality: "one" | "many";
  readonly identity: readonly FrappeLineageFieldMap[];
  readonly revision: readonly FrappeLineageFieldMap[];
  readonly content: readonly FrappeLineageFieldMap[];
  readonly required?: boolean;
}

export interface FrappeLineageManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly label: string;
  readonly stages: readonly FrappeLineageStage[];
  readonly relationships: readonly FrappeLineageRelationship[];
}

export interface FrappeLineageDocument {
  readonly stage: string;
  readonly name: string;
  readonly values: Readonly<Record<string, FrappeGraphValue>>;
  readonly route?: string;
  readonly readable: boolean;
  readonly lifecycle?: "active" | "superseded" | "cancelled" | "draft";
  readonly modified?: string;
  readonly provenance: FrappeGraphProvenance;
}

export interface FrappeLineageFinding {
  readonly relationshipId: string;
  readonly from: { readonly stage: string; readonly name: string; readonly route?: string };
  readonly to?: { readonly stage: string; readonly name: string; readonly route?: string };
  readonly status: FrappeLineageStatus;
  readonly summary: string;
  readonly comparisons: readonly {
    readonly label: string;
    readonly expected: FrappeGraphValue | undefined;
    readonly observed: FrappeGraphValue | undefined;
    readonly matches: boolean;
    readonly category: "identity" | "revision" | "content";
  }[];
  readonly evidenceIds: readonly string[];
}

export interface FrappeLineageValidation {
  readonly schemaVersion: 1;
  readonly manifestId: string;
  readonly site: string;
  readonly principal: string;
  readonly permissionEpoch: string;
  readonly schemaRevision: string;
  readonly dataRevision: string;
  readonly findings: readonly FrappeLineageFinding[];
  readonly counts: Readonly<Record<FrappeLineageStatus, number>>;
  readonly verdict: "PASS" | "REVIEW" | "FAIL" | "BLOCKED";
  readonly digest: string;
}

export function validateFrappeLineage(input: {
  readonly manifest: FrappeLineageManifest;
  readonly documents: readonly FrappeLineageDocument[];
}): FrappeLineageValidation {
  const manifest = validateManifest(input.manifest);
  if (!input.documents.length) throw new Error("Lineage validation requires authorized document evidence.");
  if (input.documents.length > 10_000) throw new Error("Lineage validation exceeds its bounded document count.");
  const docs = input.documents.map((document) => normalizeDocument(document, manifest));
  const scope = docs[0]!.provenance;
  for (const document of docs) assertScope(scope, document.provenance);
  const byStage = new Map(manifest.stages.map((stage) => [stage.id, docs.filter((document) => document.stage === stage.id)]));
  const findings: FrappeLineageFinding[] = [];

  for (const sourceStage of new Set(manifest.relationships.filter((relationship) => relationship.required !== false).map((relationship) => relationship.from))) {
    if (!(byStage.get(sourceStage)?.length)) {
      throw new Error(`Lineage evidence is incomplete: required source stage ${sourceStage} was not queried.`);
    }
  }

  for (const relationship of manifest.relationships) {
    for (const source of byStage.get(relationship.from) ?? []) {
      if (!source.readable) {
        findings.push(finding(relationship, source, undefined, "Blocked", [], "The connected Frappe identity cannot read the source record required to verify this relationship."));
        continue;
      }
      const candidates = (byStage.get(relationship.to) ?? []).filter((target) => identityMatches(source, target, relationship.identity));
      if (!candidates.length) {
        const unreadableTargets = (byStage.get(relationship.to) ?? []).filter((target) => !target.readable);
        if (unreadableTargets.length) {
          findings.push(finding(relationship, source, undefined, "Blocked", [], "The connected Frappe identity cannot read enough downstream records to verify this relationship.", unreadableTargets));
          continue;
        }
        findings.push(finding(relationship, source, undefined, relationship.required === false ? "Requires review" : "Requires regeneration", [],
          `${stageLabel(manifest, relationship.to)} is missing for ${source.name}.`));
        continue;
      }
      if (relationship.cardinality === "one" && candidates.length > 1) {
        findings.push(finding(relationship, source, undefined, "Inconsistent", [],
          `${candidates.length} ${stageLabel(manifest, relationship.to)} records match ${source.name}; one authoritative record was expected.`, candidates));
        continue;
      }
      for (const target of candidates) findings.push(comparePair(manifest, relationship, source, target));
    }
  }

  const ordered = findings.sort((a, b) => a.relationshipId.localeCompare(b.relationshipId) || a.from.name.localeCompare(b.from.name) || (a.to?.name ?? "").localeCompare(b.to?.name ?? ""));
  const counts = Object.fromEntries(FRAPPE_LINEAGE_STATUSES.map((status) => [status, ordered.filter((finding) => finding.status === status).length])) as Record<FrappeLineageStatus, number>;
  const verdict: FrappeLineageValidation["verdict"] = counts.Blocked
    ? "BLOCKED"
    : counts.Inconsistent || counts["Requires regeneration"]
      ? "FAIL"
      : counts["Requires review"] || counts.Superseded
        ? "REVIEW"
        : "PASS";
  const resultWithoutDigest = {
    schemaVersion: 1 as const, manifestId: manifest.id, site: scope.site, principal: scope.principal,
    permissionEpoch: scope.permissionEpoch, schemaRevision: scope.schemaRevision, dataRevision: scope.dataRevision,
    findings: ordered, counts, verdict,
  };
  return deepFreeze({ ...resultWithoutDigest, digest: hash(resultWithoutDigest) });
}

function comparePair(manifest: FrappeLineageManifest, relationship: FrappeLineageRelationship, source: FrappeLineageDocument, target: FrappeLineageDocument): FrappeLineageFinding {
  if (!source.readable || !target.readable) return finding(relationship, source, target, "Blocked", [], "The connected Frappe identity cannot read all records required to verify this relationship.");
  if (target.lifecycle === "superseded" || target.lifecycle === "cancelled") return finding(relationship, source, target, "Superseded", [], `${target.name} is no longer an active downstream record.`);
  const comparisons = [
    ...compareFields(source, target, relationship.identity, "identity"),
    ...compareFields(source, target, relationship.revision, "revision"),
    ...compareFields(source, target, relationship.content, "content"),
  ];
  const mismatches = comparisons.filter((item) => !item.matches);
  let status: FrappeLineageStatus = "Current";
  for (const mismatch of mismatches) {
    const map = [...relationship.identity, ...relationship.revision, ...relationship.content].find((item) => item.label === mismatch.label);
    status = strongest(status, map?.mismatchStatus ?? (mismatch.category === "revision" ? "Requires regeneration" : "Inconsistent"));
  }
  const summary = status === "Current"
    ? `${stageLabel(manifest, relationship.to)} ${target.name} matches ${source.name}.`
    : `${stageLabel(manifest, relationship.to)} ${target.name} differs from ${source.name} in ${mismatches.map((item) => item.label).join(", ")}.`;
  return finding(relationship, source, target, status, comparisons, summary);
}

function compareFields(source: FrappeLineageDocument, target: FrappeLineageDocument, fields: readonly FrappeLineageFieldMap[], category: "identity" | "revision" | "content") {
  return fields.map((field) => {
    const expected = getPath(source.values, field.from);
    const observed = getPath(target.values, field.to);
    return { label: field.label, expected, observed, matches: compare(expected, observed, field.comparison ?? "normalized"), category } as const;
  });
}

function identityMatches(source: FrappeLineageDocument, target: FrappeLineageDocument, fields: readonly FrappeLineageFieldMap[]): boolean {
  return fields.every((field) => {
    const left = getPath(source.values, field.from);
    const right = getPath(target.values, field.to);
    return hasIdentityValue(left) && hasIdentityValue(right) && compare(left, right, field.comparison ?? "normalized");
  });
}

function finding(relationship: FrappeLineageRelationship, source: FrappeLineageDocument, target: FrappeLineageDocument | undefined, status: FrappeLineageStatus, comparisons: FrappeLineageFinding["comparisons"], summary: string, extraEvidence: readonly FrappeLineageDocument[] = []): FrappeLineageFinding {
  return deepFreeze({
    relationshipId: relationship.id,
    from: { stage: source.stage, name: source.name, ...(source.route ? { route: source.route } : {}) },
    ...(target ? { to: { stage: target.stage, name: target.name, ...(target.route ? { route: target.route } : {}) } } : {}),
    status, summary, comparisons,
    evidenceIds: [...new Set([source, ...(target ? [target] : []), ...extraEvidence].map((document) => document.provenance.evidenceId))].sort(),
  });
}

function validateManifest(manifest: FrappeLineageManifest): FrappeLineageManifest {
  if (manifest.schemaVersion !== 1 || !safeId(manifest.id) || !manifest.stages.length || !manifest.relationships.length) throw new Error("Lineage manifest is incomplete.");
  const stages = new Map<string, FrappeLineageStage>();
  for (const stage of manifest.stages) { if (!safeId(stage.id) || !stage.label.trim() || !stage.doctype.trim() || stages.has(stage.id)) throw new Error("Lineage manifest contains an invalid or duplicate stage."); stages.set(stage.id, stage); }
  const relationships = new Set<string>();
  for (const relationship of manifest.relationships) {
    if (!safeId(relationship.id) || relationships.has(relationship.id) || !stages.has(relationship.from) || !stages.has(relationship.to) || relationship.from === relationship.to) throw new Error("Lineage manifest contains an invalid relationship.");
    if (!relationship.identity.length) throw new Error(`Lineage relationship ${relationship.id} requires an identity mapping.`);
    for (const field of [...relationship.identity, ...relationship.revision, ...relationship.content]) if (!field.from.trim() || !field.to.trim() || !field.label.trim()) throw new Error(`Lineage relationship ${relationship.id} contains an invalid field mapping.`);
    relationships.add(relationship.id);
  }
  return deepFreeze(manifest);
}

function normalizeDocument(document: FrappeLineageDocument, manifest: FrappeLineageManifest): FrappeLineageDocument {
  if (!manifest.stages.some((stage) => stage.id === document.stage) || !document.name.trim()) throw new Error("Lineage document stage or name is invalid.");
  if (document.modified && Number.isNaN(Date.parse(document.modified))) throw new Error("Lineage document modified time is invalid.");
  if (document.route && (!document.route.startsWith("/") || /[\0\r\n]/.test(document.route))) throw new Error("Lineage document route is invalid.");
  return deepFreeze({ ...document, name: document.name.trim() });
}

function assertScope(expected: FrappeGraphProvenance, actual: FrappeGraphProvenance): void { for (const key of ["site", "principal", "permissionEpoch", "schemaRevision", "dataRevision"] as const) if (expected[key] !== actual[key]) throw new Error(`Lineage evidence mixes ${key} scopes.`); }
function stageLabel(manifest: FrappeLineageManifest, id: string): string { return manifest.stages.find((stage) => stage.id === id)?.label ?? id; }
function getPath(value: Readonly<Record<string, FrappeGraphValue>>, path: string): FrappeGraphValue | undefined {
  let cursors: FrappeGraphValue[] = [value];
  for (const rawSegment of path.split(".")) {
    const many = rawSegment.endsWith("[]");
    const segment = many ? rawSegment.slice(0, -2) : rawSegment;
    const next: FrappeGraphValue[] = [];
    for (const cursor of cursors) {
      if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) continue;
      const child = (cursor as Readonly<Record<string, FrappeGraphValue>>)[segment];
      if (child === undefined) continue;
      if (many && Array.isArray(child)) next.push(...child);
      else if (!many) next.push(child);
    }
    cursors = next;
  }
  if (!cursors.length) return undefined;
  return cursors.length === 1 ? cursors[0] : cursors;
}
function compare(left: FrappeGraphValue | undefined, right: FrappeGraphValue | undefined, mode: FrappeLineageFieldMap["comparison"]): boolean { if (mode === "exact") return JSON.stringify(left) === JSON.stringify(right); if (mode === "set") return JSON.stringify(asSet(left)) === JSON.stringify(asSet(right)); if (mode === "ordered") return JSON.stringify(asOrdered(left)) === JSON.stringify(asOrdered(right)); return normalize(left) === normalize(right); }
function normalize(value: FrappeGraphValue | undefined): string { return value === undefined ? "" : typeof value === "string" ? value.toLowerCase().replace(/\s+/g, " ").trim() : JSON.stringify(value); }
function asSet(value: FrappeGraphValue | undefined): string[] { const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]; return [...new Set(list.map((item) => normalize(item)))].sort(); }
function asOrdered(value: FrappeGraphValue | undefined): string[] { const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]; return list.map((item) => normalize(item)); }
function hasIdentityValue(value: FrappeGraphValue | undefined): boolean { if (value === undefined || value === null) return false; if (typeof value === "string") return Boolean(value.trim()); if (Array.isArray(value)) return value.length > 0 && value.every(hasIdentityValue); return true; }
function strongest(left: FrappeLineageStatus, right: FrappeLineageStatus): FrappeLineageStatus { const rank: Record<FrappeLineageStatus, number> = { Current: 0, Superseded: 1, "Requires review": 2, "Requires regeneration": 3, Inconsistent: 4, Blocked: 5 }; return rank[left] >= rank[right] ? left : right; }
function safeId(value: string): boolean { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(value); }
function hash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function canonical(value: unknown): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; const row = value as Record<string, unknown>; return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`; }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }
