import { createHash } from "node:crypto";
import type { FrappeGraphScalar, FrappeGraphValue } from "./customization-graph.js";
import {
  validateFrappeLineage,
  type FrappeLineageDocument,
  type FrappeLineageFieldMap,
  type FrappeLineageFinding,
  type FrappeLineageManifest,
  type FrappeLineageRelationship,
  type FrappeLineageValidation,
} from "./lineage.js";

const SYSTEM_FIELDS = new Set([
  "name", "owner", "creation", "modified", "modified_by", "docstatus", "idx",
  "parent", "parentfield", "parenttype", "doctype", "__islocal", "__unsaved",
  "_user_tags", "_comments", "_assign", "_liked_by",
]);

const EXECUTION_STATEMENT = "Execution requires frappe_safe_write, a fresh permission check, and one-use human approval.";

export interface FrappeReviewedLineageManifest {
  readonly manifest: FrappeLineageManifest;
  readonly review: {
    readonly status: "reviewed";
    readonly manifestDigest: string;
    readonly reviewedBy: string;
    readonly reviewedAt: string;
  };
}

export interface FrappeLineageRemediationChange {
  readonly kind: "scalar" | "child_table";
  readonly path: string;
  readonly value: FrappeGraphValue;
  readonly before: string;
  readonly after: string;
  readonly labels: readonly string[];
}

export interface FrappeLineageRemediationAction {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly kind: "proposed_update";
  readonly relationshipId: string;
  readonly source: { readonly stage: string; readonly name: string };
  readonly target: { readonly stage: string; readonly name: string };
  readonly expected_modified: string;
  readonly route: string;
  readonly changes: readonly FrappeLineageRemediationChange[];
  readonly evidenceIds: readonly string[];
  readonly executionRequirements: {
    readonly writer: "frappe_safe_write";
    readonly freshPermissionCheck: true;
    readonly humanApproval: "one-use";
    readonly statement: typeof EXECUTION_STATEMENT;
  };
}

export type FrappeLineageRemediationRefusalCode =
  | "blocked"
  | "missing_record"
  | "unreadable_record"
  | "identity_change"
  | "superseded_record"
  | "missing_concurrency_token"
  | "missing_route"
  | "unsupported_path"
  | "unsafe_system_field"
  | "ambiguous_child_rows"
  | "no_safe_change"
  | "conflicting_actions";

export interface FrappeLineageRemediationRefusal {
  readonly relationshipId: string;
  readonly source: { readonly stage: string; readonly name: string };
  readonly target?: { readonly stage: string; readonly name: string };
  readonly code: FrappeLineageRemediationRefusalCode;
  readonly reason: string;
  readonly evidenceIds: readonly string[];
}

export interface FrappeLineageRemediationPlan {
  readonly schemaVersion: 1;
  readonly manifestId: string;
  readonly manifestDigest: string;
  readonly validationDigest: string;
  readonly site: string;
  readonly principal: string;
  readonly permissionEpoch: string;
  readonly schemaRevision: string;
  readonly dataRevision: string;
  readonly actions: readonly FrappeLineageRemediationAction[];
  readonly refusals: readonly FrappeLineageRemediationRefusal[];
  readonly digest: string;
}

export function digestFrappeLineageManifest(manifest: FrappeLineageManifest): string {
  return hash(manifest);
}

export function planFrappeLineageRemediation(input: {
  readonly reviewedManifest: FrappeReviewedLineageManifest;
  readonly documents: readonly FrappeLineageDocument[];
  readonly validation: FrappeLineageValidation;
}): FrappeLineageRemediationPlan {
  const manifest = verifyReview(input.reviewedManifest);
  const freshValidation = validateFrappeLineage({ manifest, documents: input.documents });
  if (freshValidation.digest !== input.validation.digest || canonical(freshValidation) !== canonical(input.validation)) {
    throw new Error("Lineage remediation requires validation produced from the supplied permission-scoped documents.");
  }

  const documents = new Map<string, FrappeLineageDocument>();
  for (const document of input.documents) {
    const key = documentKey(document.stage, document.name);
    if (documents.has(key)) throw new Error(`Lineage remediation evidence duplicates ${document.stage} ${document.name}.`);
    documents.set(key, document);
  }
  const relationships = new Map(manifest.relationships.map((relationship) => [relationship.id, relationship]));
  const actions: FrappeLineageRemediationAction[] = [];
  const refusals: FrappeLineageRemediationRefusal[] = [];

  for (const finding of freshValidation.findings) {
    if (finding.status === "Current") continue;
    const relationship = relationships.get(finding.relationshipId);
    if (!relationship) throw new Error(`Lineage validation references unknown relationship ${finding.relationshipId}.`);
    const source = documents.get(documentKey(finding.from.stage, finding.from.name));
    const target = finding.to ? documents.get(documentKey(finding.to.stage, finding.to.name)) : undefined;
    const refused = refuseUnsafeFinding(finding, source, target, relationship);
    if (refused) {
      refusals.push(refused);
      continue;
    }

    const proposed = proposeAction(relationship, finding, source!, target!);
    if ("code" in proposed) refusals.push(proposed);
    else actions.push(proposed);
  }

  const conflictIds = conflictingActionIds(actions);
  const safeActions = actions.filter((action) => !conflictIds.has(action.id));
  for (const action of actions.filter((candidate) => conflictIds.has(candidate.id))) {
    refusals.push({
      relationshipId: action.relationshipId,
      source: action.source,
      target: action.target,
      code: "conflicting_actions",
      reason: "Multiple lineage findings propose different values for the same target path; no update was proposed.",
      evidenceIds: action.evidenceIds,
    });
  }

  const orderedActions = safeActions.sort((a, b) => actionOrder(a).localeCompare(actionOrder(b)));
  const orderedRefusals = refusals.sort((a, b) => refusalOrder(a).localeCompare(refusalOrder(b)));
  const resultWithoutDigest = {
    schemaVersion: 1 as const,
    manifestId: manifest.id,
    manifestDigest: input.reviewedManifest.review.manifestDigest,
    validationDigest: freshValidation.digest,
    site: freshValidation.site,
    principal: freshValidation.principal,
    permissionEpoch: freshValidation.permissionEpoch,
    schemaRevision: freshValidation.schemaRevision,
    dataRevision: freshValidation.dataRevision,
    actions: orderedActions,
    refusals: orderedRefusals,
  };
  return deepFreeze({ ...resultWithoutDigest, digest: hash(resultWithoutDigest) });
}

function verifyReview(reviewed: FrappeReviewedLineageManifest): FrappeLineageManifest {
  const expected = digestFrappeLineageManifest(reviewed.manifest);
  const review = reviewed.review;
  if (review.status !== "reviewed" || review.manifestDigest !== expected) {
    throw new Error("Lineage remediation requires a review bound to the exact manifest digest.");
  }
  if (!review.reviewedBy.trim() || Number.isNaN(Date.parse(review.reviewedAt))) {
    throw new Error("Lineage manifest review metadata is invalid.");
  }
  for (const relationship of reviewed.manifest.relationships) {
    const labels = [...relationship.identity, ...relationship.revision, ...relationship.content].map((field) => field.label);
    if (new Set(labels).size !== labels.length) throw new Error(`Lineage relationship ${relationship.id} requires unique reviewed field labels.`);
  }
  return reviewed.manifest;
}

function refuseUnsafeFinding(
  finding: FrappeLineageFinding,
  source: FrappeLineageDocument | undefined,
  target: FrappeLineageDocument | undefined,
  relationship: FrappeLineageRelationship,
): FrappeLineageRemediationRefusal | undefined {
  const base = refusalBase(finding);
  if (finding.status === "Blocked") return { ...base, code: "blocked", reason: "Blocked lineage evidence cannot be remediated." };
  if (!finding.to || !source || !target) return { ...base, code: "missing_record", reason: "Both source and target records must exist in the reviewed permission scope." };
  if (!source.readable || !target.readable) return { ...base, code: "unreadable_record", reason: "Both source and target records must be readable by the reviewed principal." };
  if (finding.status === "Superseded" || target.lifecycle === "superseded" || target.lifecycle === "cancelled") {
    return { ...base, code: "superseded_record", reason: "Superseded or cancelled records are not eligible for automatic remediation proposals." };
  }
  if (finding.comparisons.some((comparison) => comparison.category === "identity" && !comparison.matches)) {
    return { ...base, code: "identity_change", reason: "Lineage identity changes require a separately reviewed regeneration workflow." };
  }
  const identityTargets = new Set(relationship.identity.map((field) => field.to));
  if ([...relationship.revision, ...relationship.content].some((field) => identityTargets.has(field.to))) {
    return { ...base, code: "identity_change", reason: "A proposed remediation mapping targets a field used to establish record identity." };
  }
  if (!target.modified) return { ...base, code: "missing_concurrency_token", reason: "The target has no modified timestamp for optimistic concurrency protection." };
  if (!target.route) return { ...base, code: "missing_route", reason: "The permission-scoped target has no reviewed route for human inspection." };
  return undefined;
}

function proposeAction(
  relationship: FrappeLineageRelationship,
  finding: FrappeLineageFinding,
  source: FrappeLineageDocument,
  target: FrappeLineageDocument,
): FrappeLineageRemediationAction | FrappeLineageRemediationRefusal {
  const mismatchedLabels = new Set(finding.comparisons.filter((item) => !item.matches && item.category !== "identity").map((item) => item.label));
  const eligible = [...relationship.revision, ...relationship.content].filter((field) => mismatchedLabels.has(field.label));
  const parsed = eligible.map((field) => ({ field, path: parseTargetPath(field.to) }));
  const invalid = parsed.find((item) => !item.path);
  if (invalid) return refusal(finding, "unsupported_path", `Target path ${invalid.field.to} is not a supported scalar or child-table field path.`);
  const unsafe = parsed.find((item) => isSystemPath(item.field.to));
  if (unsafe) return refusal(finding, "unsafe_system_field", `Target path ${unsafe.field.to} is a Frappe-managed system field.`);

  const changes: FrappeLineageRemediationChange[] = [];
  for (const item of parsed.filter((candidate) => candidate.path!.kind === "scalar")) {
    const expected = readPath(source.values, item.field.from);
    if (expected.many || expected.value === undefined || !isScalar(expected.value)) {
      return refusal(finding, "unsupported_path", `Source path ${item.field.from} does not resolve to one scalar value.`);
    }
    const observed = readPath(target.values, item.field.to).value;
    changes.push(change("scalar", item.field.to, expected.value, observed, expected.value, [item.field.label]));
  }

  const childRoots = [...new Set(parsed.filter((item) => item.path!.kind === "child_table").map((item) => item.path!.root))].sort();
  for (const root of childRoots) {
    const mapped = [...relationship.revision, ...relationship.content]
      .map((field) => ({ field, path: parseTargetPath(field.to) }))
      .filter((item): item is { field: FrappeLineageFieldMap; path: ChildTargetPath } => item.path?.kind === "child_table" && item.path.root === root && !isSystemPath(item.field.to));
    const sourceRoots = mapped.map((item) => parseSourceChildPath(item.field.from)?.root);
    if (sourceRoots.some((sourceRoot) => !sourceRoot) || new Set(sourceRoots).size !== 1 || mapped.some((item) => item.field.comparison === "set")) {
      return refusal(finding, "ambiguous_child_rows", `Mapped child-table fields for ${root} do not provide one deterministic row order.`);
    }
    const beforeRaw = target.values[root];
    if (beforeRaw !== undefined && (!Array.isArray(beforeRaw) || beforeRaw.some((row) => !isRow(row)))) {
      return refusal(finding, "ambiguous_child_rows", `Target child table ${root} is not represented as a list of rows.`);
    }
    const columns = mapped.map(({ field, path }) => ({ field, path, source: readPath(source.values, field.from) }));
    if (columns.some((column) => !column.source.many || !Array.isArray(column.source.value))) {
      return refusal(finding, "ambiguous_child_rows", `Mapped source values for ${root} are not row-aligned child-table evidence.`);
    }
    const lengths = new Set(columns.map((column) => (column.source.value as readonly FrappeGraphValue[]).length));
    if (lengths.size !== 1) return refusal(finding, "ambiguous_child_rows", `Mapped source columns for ${root} contain different row counts.`);
    const rowCount = [...lengths][0] ?? 0;
    const beforeRows = ((beforeRaw ?? []) as readonly FrappeGraphValue[]).map((row) => sanitizeRow(row as Readonly<Record<string, FrappeGraphValue>>));
    const afterRows: Record<string, FrappeGraphValue>[] = [];
    for (let index = 0; index < rowCount; index += 1) {
      const row: Record<string, FrappeGraphValue> = { ...(beforeRows[index] ?? {}) };
      for (const column of columns) {
        const value = (column.source.value as readonly FrappeGraphValue[])[index];
        if (value === undefined) return refusal(finding, "ambiguous_child_rows", `Mapped source column ${column.field.from} is missing row ${index + 1}.`);
        row[column.path.field] = sanitizeValue(value);
      }
      afterRows.push(row);
    }
    changes.push(change("child_table", root, afterRows, beforeRows, afterRows, mapped.map((item) => item.field.label).sort()));
  }

  const uniqueChanges = dedupeChanges(changes).sort((a, b) => a.path.localeCompare(b.path));
  if (!uniqueChanges.length) return refusal(finding, "no_safe_change", "The lineage finding contains no safe mapped revision or content update.");
  const actionSeed = {
    relationshipId: relationship.id,
    source: { stage: source.stage, name: source.name },
    target: { stage: target.stage, name: target.name },
    expected_modified: target.modified!,
    changes: uniqueChanges.map((item) => ({ path: item.path, value: item.value })),
    validationEvidence: finding.evidenceIds,
  };
  return deepFreeze({
    schemaVersion: 1,
    id: `lineage-update:${hash(actionSeed)}`,
    kind: "proposed_update",
    relationshipId: relationship.id,
    source: actionSeed.source,
    target: actionSeed.target,
    expected_modified: target.modified!,
    route: target.route!,
    changes: uniqueChanges,
    evidenceIds: [...finding.evidenceIds].sort(),
    executionRequirements: {
      writer: "frappe_safe_write",
      freshPermissionCheck: true,
      humanApproval: "one-use",
      statement: EXECUTION_STATEMENT,
    },
  });
}

type ScalarTargetPath = { readonly kind: "scalar"; readonly root: string };
type ChildTargetPath = { readonly kind: "child_table"; readonly root: string; readonly field: string };

function parseTargetPath(path: string): ScalarTargetPath | ChildTargetPath | undefined {
  const scalar = /^([A-Za-z_][A-Za-z0-9_]*)$/.exec(path);
  if (scalar) return { kind: "scalar", root: scalar[1]! };
  const child = /^([A-Za-z_][A-Za-z0-9_]*)\[\]\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(path);
  if (child) return { kind: "child_table", root: child[1]!, field: child[2]! };
  return undefined;
}

function parseSourceChildPath(path: string): { readonly root: string; readonly field: string } | undefined {
  const child = /^([A-Za-z_][A-Za-z0-9_]*)\[\]\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(path);
  return child ? { root: child[1]!, field: child[2]! } : undefined;
}

function readPath(root: Readonly<Record<string, FrappeGraphValue>>, path: string): { readonly many: boolean; readonly value: FrappeGraphValue | undefined } {
  let cursors: FrappeGraphValue[] = [root];
  let many = false;
  for (const rawSegment of path.split(".")) {
    const isMany = rawSegment.endsWith("[]");
    many ||= isMany;
    const segment = isMany ? rawSegment.slice(0, -2) : rawSegment;
    const next: FrappeGraphValue[] = [];
    for (const cursor of cursors) {
      if (!isRow(cursor)) continue;
      const child = cursor[segment];
      if (child === undefined) continue;
      if (isMany) {
        if (!Array.isArray(child)) return { many: true, value: undefined };
        next.push(...child);
      } else {
        next.push(child);
      }
    }
    cursors = next;
  }
  if (many) return { many: true, value: cursors };
  return { many: false, value: cursors.length === 1 ? cursors[0] : undefined };
}

function change(kind: FrappeLineageRemediationChange["kind"], path: string, value: FrappeGraphValue, beforeValue: FrappeGraphValue | undefined, afterValue: FrappeGraphValue, labels: readonly string[]): FrappeLineageRemediationChange {
  return deepFreeze({
    kind,
    path,
    value: sanitizeValue(value),
    before: `${path}: ${display(beforeValue)}`,
    after: `${path}: ${display(afterValue)}`,
    labels: [...new Set(labels)].sort(),
  });
}

function sanitizeRow(row: Readonly<Record<string, FrappeGraphValue>>): Record<string, FrappeGraphValue> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !SYSTEM_FIELDS.has(key.toLowerCase())).map(([key, value]) => [key, sanitizeValue(value)]));
}

function sanitizeValue(value: FrappeGraphValue): FrappeGraphValue {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (isRow(value)) return sanitizeRow(value);
  return value;
}

function isSystemPath(path: string): boolean {
  const parsed = parseTargetPath(path);
  return !parsed || SYSTEM_FIELDS.has(parsed.root.toLowerCase()) || (parsed.kind === "child_table" && SYSTEM_FIELDS.has(parsed.field.toLowerCase()));
}

function isScalar(value: FrappeGraphValue): value is FrappeGraphScalar {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isRow(value: FrappeGraphValue | undefined): value is Readonly<Record<string, FrappeGraphValue>> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function refusal(finding: FrappeLineageFinding, code: FrappeLineageRemediationRefusalCode, reason: string): FrappeLineageRemediationRefusal {
  return { ...refusalBase(finding), code, reason };
}

function refusalBase(finding: FrappeLineageFinding) {
  return {
    relationshipId: finding.relationshipId,
    source: { stage: finding.from.stage, name: finding.from.name },
    ...(finding.to ? { target: { stage: finding.to.stage, name: finding.to.name } } : {}),
    evidenceIds: [...finding.evidenceIds].sort(),
  };
}

function dedupeChanges(changes: readonly FrappeLineageRemediationChange[]): FrappeLineageRemediationChange[] {
  const output = new Map<string, FrappeLineageRemediationChange>();
  for (const item of changes) {
    const prior = output.get(item.path);
    if (prior && canonical(prior.value) !== canonical(item.value)) throw new Error(`Lineage remediation produced conflicting values for ${item.path}.`);
    output.set(item.path, item);
  }
  return [...output.values()];
}

function conflictingActionIds(actions: readonly FrappeLineageRemediationAction[]): Set<string> {
  const byTargetPath = new Map<string, Map<string, Set<string>>>();
  const conflicts = new Set<string>();
  for (const action of actions) {
    for (const item of action.changes) {
      const key = `${action.target.stage}\0${action.target.name}\0${item.path}`;
      const value = canonical(item.value);
      const values = byTargetPath.get(key) ?? new Map<string, Set<string>>();
      const ids = values.get(value) ?? new Set<string>();
      ids.add(action.id);
      values.set(value, ids);
      byTargetPath.set(key, values);
    }
  }
  for (const values of byTargetPath.values()) {
    if (values.size > 1) for (const ids of values.values()) for (const id of ids) conflicts.add(id);
  }
  return conflicts;
}

function actionOrder(action: FrappeLineageRemediationAction): string { return `${action.relationshipId}\0${action.source.name}\0${action.target.name}\0${action.id}`; }
function refusalOrder(item: FrappeLineageRemediationRefusal): string { return `${item.relationshipId}\0${item.source.name}\0${item.target?.name ?? ""}\0${item.code}`; }
function documentKey(stage: string, name: string): string { return `${stage}\0${name}`; }
function display(value: FrappeGraphValue | undefined): string { return value === undefined ? "not set" : canonical(sanitizeValue(value)); }
function hash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function canonical(value: unknown): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; const row = value as Record<string, unknown>; return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`; }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }
