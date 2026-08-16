import { createHash } from "node:crypto";
import type { FrappeIndexRecord } from "./enterprise.js";

export const FRAPPE_CUSTOMIZATION_NODE_KINDS = [
  "app", "doctype", "child_table", "field", "custom_field", "property_setter",
  "workflow", "role", "permission", "client_script", "server_script", "hook",
  "override", "api", "custom_button", "background_job", "report", "validation_rule",
  "error_log", "document",
] as const;

export type FrappeCustomizationNodeKind = (typeof FRAPPE_CUSTOMIZATION_NODE_KINDS)[number];

export const FRAPPE_CUSTOMIZATION_EDGE_KINDS = [
  "contains", "child_of", "links_to", "dynamic_links_to", "reads", "writes", "calls",
  "controls", "permits", "transitions", "overrides", "runs", "reports_on",
  "generated_from", "revision_of", "observed_failure_in",
] as const;

export type FrappeCustomizationEdgeKind = (typeof FRAPPE_CUSTOMIZATION_EDGE_KINDS)[number];
export type FrappeGraphScalar = string | number | boolean | null;
export type FrappeGraphValue = FrappeGraphScalar | readonly FrappeGraphValue[] | { readonly [key: string]: FrappeGraphValue };

export interface FrappeGraphProvenance {
  readonly site: string;
  readonly principal: string;
  readonly permissionEpoch: string;
  readonly schemaRevision: string;
  readonly dataRevision: string;
  readonly observedAt: string;
  readonly evidenceId: string;
}

export interface FrappeCustomizationNodeInput {
  readonly id: string;
  readonly kind: FrappeCustomizationNodeKind;
  readonly label: string;
  readonly doctype?: string;
  readonly docname?: string;
  readonly app?: string;
  readonly module?: string;
  readonly route?: string;
  readonly attributes?: Readonly<Record<string, FrappeGraphValue>>;
  readonly provenance: FrappeGraphProvenance;
}

export interface FrappeCustomizationEdgeInput {
  readonly from: string;
  readonly to: string;
  readonly kind: FrappeCustomizationEdgeKind;
  readonly label?: string;
  readonly attributes?: Readonly<Record<string, FrappeGraphValue>>;
  readonly provenance: FrappeGraphProvenance;
}

export interface FrappeCustomizationGraph {
  readonly schemaVersion: 1;
  readonly site: string;
  readonly principal: string;
  readonly permissionEpoch: string;
  readonly schemaRevision: string;
  readonly dataRevision: string;
  readonly observedAt: string;
  readonly nodes: readonly FrappeCustomizationNodeInput[];
  readonly edges: readonly (FrappeCustomizationEdgeInput & { readonly id: string })[];
  readonly digest: string;
}

const NODE_KIND_SET = new Set<string>(FRAPPE_CUSTOMIZATION_NODE_KINDS);
const EDGE_KIND_SET = new Set<string>(FRAPPE_CUSTOMIZATION_EDGE_KINDS);
const SECRET_TERMS = new Set(["password", "passwd", "secret", "token", "authorization", "cookie", "privatekey", "apikey"]);
const SCRIPT_BODY_TERMS = new Set(["script", "code", "sourcecode"]);
const MAX_NODES = 25_000;
const MAX_EDGES = 100_000;

export function buildFrappeCustomizationGraph(input: {
  readonly nodes: readonly FrappeCustomizationNodeInput[];
  readonly edges: readonly FrappeCustomizationEdgeInput[];
}): FrappeCustomizationGraph {
  if (!input.nodes.length) throw new Error("A customization graph requires at least one authorized node.");
  if (input.nodes.length > MAX_NODES || input.edges.length > MAX_EDGES) throw new Error("Customization graph exceeds its bounded size.");

  const nodes = new Map<string, FrappeCustomizationNodeInput>();
  for (const raw of input.nodes) {
    const node = normalizeNode(raw);
    const prior = nodes.get(node.id);
    if (prior && canonical(prior) !== canonical(node)) throw new Error(`Customization graph node ${node.id} has conflicting authorized evidence.`);
    nodes.set(node.id, node);
  }
  const scope = commonScope([...nodes.values()].map((node) => node.provenance));
  const edgeMap = new Map<string, FrappeCustomizationEdgeInput & { readonly id: string }>();
  for (const raw of input.edges) {
    const edge = normalizeEdge(raw);
    assertSameScope(scope, edge.provenance);
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) throw new Error(`Customization graph edge ${edge.from} -> ${edge.to} references an unavailable node.`);
    const id = digest({ from: edge.from, to: edge.to, kind: edge.kind, label: edge.label ?? "" });
    const normalized = Object.freeze({ ...edge, id });
    const prior = edgeMap.get(id);
    if (prior && canonical(prior) !== canonical(normalized)) throw new Error(`Customization graph edge ${id} has conflicting authorized evidence.`);
    edgeMap.set(id, normalized);
  }

  const orderedNodes = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  const orderedEdges = [...edgeMap.values()].sort((a, b) => a.id.localeCompare(b.id));
  const graphWithoutDigest = {
    schemaVersion: 1 as const,
    ...scope,
    nodes: orderedNodes,
    edges: orderedEdges,
  };
  return deepFreeze({ ...graphWithoutDigest, digest: digest(graphWithoutDigest) });
}

export function frappeCustomizationNeighborhood(
  graph: FrappeCustomizationGraph,
  nodeIds: readonly string[],
  maxDepth = 2,
  maxNodes = 200,
): FrappeCustomizationGraph {
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 8) throw new Error("Customization graph depth must be between 0 and 8.");
  if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 2_000) throw new Error("Customization graph result cap must be between 1 and 2000 nodes.");
  const available = new Map(graph.nodes.map((node) => [node.id, node]));
  let frontier = [...new Set(nodeIds)].filter((id) => available.has(id)).sort();
  const selected = new Set(frontier);
  for (let depth = 0; depth < maxDepth && frontier.length; depth += 1) {
    const next: string[] = [];
    for (const edge of graph.edges) {
      if (frontier.includes(edge.from) && !selected.has(edge.to)) next.push(edge.to);
      if (frontier.includes(edge.to) && !selected.has(edge.from)) next.push(edge.from);
    }
    frontier = [...new Set(next)].sort().slice(0, Math.max(0, maxNodes - selected.size));
    for (const id of frontier) selected.add(id);
    if (selected.size >= maxNodes) break;
  }
  const nodes = graph.nodes.filter((node) => selected.has(node.id));
  if (!nodes.length) throw new Error("No requested customization graph nodes are visible in this permission scope.");
  const edges = graph.edges.filter((edge) => selected.has(edge.from) && selected.has(edge.to));
  return buildFrappeCustomizationGraph({ nodes, edges });
}

export function buildFrappeCustomizationGraphFromIndex(input: {
  readonly records: readonly FrappeIndexRecord[];
  readonly principal: string;
  readonly permissionEpoch: string;
  readonly schemaRevision: string;
  readonly dataRevision: string;
}): FrappeCustomizationGraph {
  if (!input.records.length) throw new Error("A customization graph requires indexed Frappe evidence.");
  const site = input.records[0]!.site;
  const baseProvenance = (record: FrappeIndexRecord): FrappeGraphProvenance => ({
    site,
    principal: input.principal,
    permissionEpoch: input.permissionEpoch,
    schemaRevision: input.schemaRevision,
    dataRevision: input.dataRevision,
    observedAt: record.observedAt,
    evidenceId: `index:${record.kind}:${digest({ objectId: record.objectId, revision: record.revision }).slice(0, 32)}`,
  });
  const nodeMap = new Map<string, FrappeCustomizationNodeInput>();
  const edgeMap: FrappeCustomizationEdgeInput[] = [];
  const addNode = (node: FrappeCustomizationNodeInput): string => { if (!nodeMap.has(node.id)) nodeMap.set(node.id, node); return node.id; };
  const doctypeId = (name: string): string => `doctype:${idPart(name)}`;
  const ensureDoctype = (name: string, provenance: FrappeGraphProvenance): string => addNode({ id: doctypeId(name), kind: "doctype", label: name, doctype: name, provenance });

  for (const record of input.records) {
    if (record.site !== site) throw new Error("Customization graph index records mix sites.");
    const provenance = baseProvenance(record);
    const payload = graphPayload(record.payload);
    const kind = indexNodeKind(record);
    if (!kind) continue;
    const id = `${kind}:${idPart(record.objectId)}`;
    addNode({
      id, kind, label: record.label ?? record.objectId,
      ...(record.doctype ? { doctype: record.doctype } : {}),
      ...(record.module ? { module: record.module } : {}),
      attributes: payload, provenance,
    });
    const parentDoctype = record.doctype ?? stringField(record.payload, "dt", "doc_type", "document_type", "reference_doctype", "parent");
    if (parentDoctype && kind !== "doctype") {
      const parentId = ensureDoctype(parentDoctype, provenance);
      edgeMap.push({ from: parentId, to: id, kind: relationFor(kind), provenance });
    }
    if (kind === "field" || kind === "custom_field") {
      const fieldtype = stringField(record.payload, "fieldtype");
      const options = stringField(record.payload, "options");
      if (options && (fieldtype === "Link" || fieldtype === "Table")) {
        const targetId = ensureDoctype(options, provenance);
        edgeMap.push({ from: id, to: targetId, kind: fieldtype === "Table" ? "child_of" : "links_to", provenance });
      }
      if (fieldtype === "Dynamic Link") edgeMap.push({ from: id, to: ensureDoctype(options || "Dynamic Link target", provenance), kind: "dynamic_links_to", provenance });
    }
    if (kind === "permission") {
      const role = stringField(record.payload, "role");
      if (role) {
        const roleId = addNode({ id: `role:${idPart(role)}`, kind: "role", label: role, provenance });
        edgeMap.push({ from: roleId, to: id, kind: "permits", provenance });
      }
    }
  }
  return buildFrappeCustomizationGraph({ nodes: [...nodeMap.values()], edges: edgeMap });
}

function normalizeNode(node: FrappeCustomizationNodeInput): FrappeCustomizationNodeInput {
  if (!safeId(node.id) || !NODE_KIND_SET.has(node.kind)) throw new Error("Customization graph node identity or kind is invalid.");
  const provenance = normalizeProvenance(node.provenance);
  const attributes = normalizeAttributes(node.attributes);
  return Object.freeze({
    id: node.id.trim(), kind: node.kind, label: cleanText(node.label, 240),
    ...(node.doctype ? { doctype: cleanText(node.doctype, 240) } : {}),
    ...(node.docname ? { docname: cleanText(node.docname, 240) } : {}),
    ...(node.app ? { app: cleanText(node.app, 160) } : {}),
    ...(node.module ? { module: cleanText(node.module, 160) } : {}),
    ...(node.route ? { route: cleanRoute(node.route) } : {}),
    ...(attributes ? { attributes } : {}), provenance,
  });
}

function indexNodeKind(record: FrappeIndexRecord): FrappeCustomizationNodeKind | undefined {
  const map: Partial<Record<FrappeIndexRecord["kind"], FrappeCustomizationNodeKind>> = {
    app: "app", doctype: "doctype", field: "field", custom_field: "custom_field",
    property_setter: "property_setter", workflow: "workflow", report: "report",
    client_script: "client_script", server_script: "server_script",
    dynamic_assignment: "validation_rule", permission_rule: "permission",
    notification: "validation_rule",
  };
  return map[record.kind];
}

function relationFor(kind: FrappeCustomizationNodeKind): FrappeCustomizationEdgeKind {
  if (kind === "permission") return "controls";
  if (kind === "workflow") return "transitions";
  if (kind === "report") return "reports_on";
  if (kind === "client_script" || kind === "server_script" || kind === "validation_rule") return "controls";
  return "contains";
}

function graphPayload(value: Readonly<Record<string, unknown>>): Readonly<Record<string, FrappeGraphValue>> {
  const output: Record<string, FrappeGraphValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key) || item === undefined) continue;
    output[key] = asGraphValue(item, 0);
  }
  return output;
}

function asGraphValue(value: unknown, depth: number): FrappeGraphValue {
  if (depth > 8) return "[depth capped]";
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => asGraphValue(item, depth + 1));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key, item]) => !isSensitiveKey(key) && item !== undefined).slice(0, 200).map(([key, item]) => [key, asGraphValue(item, depth + 1)]));
  return String(value);
}

function stringField(value: Readonly<Record<string, unknown>>, ...keys: string[]): string | undefined { for (const key of keys) { const item = value[key]; if (typeof item === "string" && item.trim()) return item.trim(); } return undefined; }
function isSensitiveKey(key: string): boolean { const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, ""); return SCRIPT_BODY_TERMS.has(normalized) || [...SECRET_TERMS].some((term) => normalized.includes(term)); }
function idPart(value: string): string { const original = value.trim(); const slug = original.replace(/[^A-Za-z0-9_.:@/-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 440) || "unnamed"; return `${slug}-h${digest(original).slice(0, 12)}`; }

function normalizeEdge(edge: FrappeCustomizationEdgeInput): FrappeCustomizationEdgeInput {
  if (!safeId(edge.from) || !safeId(edge.to) || edge.from === edge.to || !EDGE_KIND_SET.has(edge.kind)) {
    throw new Error("Customization graph edge identity or kind is invalid.");
  }
  const attributes = normalizeAttributes(edge.attributes);
  return Object.freeze({
    from: edge.from.trim(), to: edge.to.trim(), kind: edge.kind,
    ...(edge.label ? { label: cleanText(edge.label, 240) } : {}),
    ...(attributes ? { attributes } : {}), provenance: normalizeProvenance(edge.provenance),
  });
}

function normalizeProvenance(value: FrappeGraphProvenance): FrappeGraphProvenance {
  const site = new URL(value.site);
  if (site.protocol !== "https:" || site.username || site.password || site.search || site.hash) throw new Error("Customization graph provenance site must be a canonical HTTPS origin.");
  if (!safeId(value.principal) || !safeId(value.permissionEpoch) || !safeId(value.schemaRevision) || !safeId(value.dataRevision) || !safeId(value.evidenceId)) {
    throw new Error("Customization graph provenance identity is invalid.");
  }
  if (Number.isNaN(Date.parse(value.observedAt))) throw new Error("Customization graph observation time is invalid.");
  return Object.freeze({ ...value, site: site.origin, principal: value.principal.toLowerCase() });
}

function commonScope(values: readonly FrappeGraphProvenance[]): Omit<FrappeCustomizationGraph, "schemaVersion" | "nodes" | "edges" | "digest"> {
  const first = values[0]!;
  for (const value of values) assertSameScope(first, value);
  return {
    site: first.site, principal: first.principal, permissionEpoch: first.permissionEpoch,
    schemaRevision: first.schemaRevision, dataRevision: first.dataRevision,
    observedAt: values.map((value) => value.observedAt).sort().at(-1)!,
  };
}

function assertSameScope(expected: FrappeGraphProvenance | ReturnType<typeof commonScope>, actual: FrappeGraphProvenance): void {
  for (const key of ["site", "principal", "permissionEpoch", "schemaRevision", "dataRevision"] as const) {
    if (expected[key] !== actual[key]) throw new Error(`Customization graph mixes ${key} scopes.`);
  }
}

function normalizeAttributes(value: Readonly<Record<string, FrappeGraphValue>> | undefined): Readonly<Record<string, FrappeGraphValue>> | undefined {
  if (!value) return undefined;
  if (Object.keys(value).length > 200) throw new Error("Customization graph attributes exceed the bounded field count.");
  for (const [key, item] of Object.entries(value)) {
    if (!key || isSensitiveKey(key)) throw new Error(`Customization graph attribute ${key || "<empty>"} is forbidden.`);
    assertGraphValue(item, `attributes.${key}`, 0);
  }
  return deepFreeze({ ...value });
}

function assertGraphValue(value: FrappeGraphValue, path: string, depth: number): void {
  if (depth > 8) throw new Error(`${path} exceeds graph value depth.`);
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
  if (typeof value === "string") { if (value.length > 8_000) throw new Error(`${path} exceeds graph text bounds.`); return; }
  if (Array.isArray(value)) { if (value.length > 500) throw new Error(`${path} exceeds graph list bounds.`); value.forEach((item, index) => assertGraphValue(item, `${path}[${index}]`, depth + 1)); return; }
  if (typeof value === "object") { for (const [key, item] of Object.entries(value)) { if (isSensitiveKey(key)) throw new Error(`${path}.${key} is forbidden.`); assertGraphValue(item, `${path}.${key}`, depth + 1); } return; }
  throw new Error(`${path} is not bounded JSON.`);
}

function cleanText(value: string, max: number): string { const text = value.trim(); if (!text || text.length > max || /[\0\r\n]/.test(text)) throw new Error("Customization graph text is invalid."); return text; }
function cleanRoute(value: string): string { const route = value.trim(); if (!route.startsWith("/") || route.length > 1_000 || /[\0\r\n]/.test(route)) throw new Error("Customization graph route is invalid."); return route; }
function safeId(value: string): boolean { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:@\/-]{0,511}$/.test(value.trim()); }
function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function canonical(value: unknown): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; const row = value as Record<string, unknown>; return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`; }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }
