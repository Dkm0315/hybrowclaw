import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDir, findEpisode } from "./store.js";
import { addMemory, inspectMemoryStore, parseMemoryScope, searchMemoryWithReceipts, type AddMemoryInput, type MemoryStoreInspection } from "./memory.js";
import type { ContextObject, EpisodeRecord, MemoryScope, TaskKind } from "./types.js";

/**
 * Eval-pack fixtures are written because the operator ran a seed command, not
 * because the harness inferred a fact worth keeping — so they carry
 * `explicitUserRequest`, the one thing `config.memory.policy` treats as the
 * user's own decision (packages/core/src/memory.ts). Without it a profile on
 * the "ask"/"never" policy could not seed an eval pack at all: the retrieval
 * evals would fail for a reason that has nothing to do with retrieval.
 */
function seedMemory(input: Omit<AddMemoryInput, "explicitUserRequest">, cwd: string): Promise<ContextObject> {
  return addMemory({ ...input, explicitUserRequest: true }, cwd);
}

export interface EvalCase {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly createdAt: string;
  readonly sourceEpisodeId: string;
  readonly prompt: string;
  readonly taskKind: TaskKind;
  readonly recordedResponseText: string;
  readonly expectedContains: string[];
  readonly forbiddenContains?: string[];
  readonly evidenceLabels: string[];
}

export interface EvalRunResult {
  readonly id: string;
  readonly sourceEpisodeId: string;
  readonly status: "passed" | "failed";
  readonly checks: Array<{
    readonly label: string;
    readonly status: "passed" | "failed";
    readonly detail: string;
  }>;
}

export interface RetrievalEvalCase {
  readonly schemaVersion: 1;
  readonly kind: "retrieval";
  readonly id: string;
  readonly query: string;
  readonly scopes: string[];
  readonly includeGlobal?: boolean;
  readonly expectedIds: string[];
  readonly expectedNone?: boolean;
  readonly forbiddenIds?: string[];
  /** Known contradicted/obsolete memory ids that should not appear in the top-K results. */
  readonly staleIds?: string[];
  /** Treat non-expected memories observed before this timestamp as stale hits. */
  readonly staleBefore?: string;
  /** Opt into linked-memory graph expansion after lexical seed retrieval. */
  readonly graphExpand?: boolean;
  readonly topK?: number;
}

export interface RetrievalEvalListing {
  readonly path: string;
  readonly fixture: RetrievalEvalCase;
}

export interface SeedRetrievalEvalInput {
  readonly id: string;
  readonly query: string;
  readonly scopes: readonly string[];
  readonly expectedIds: readonly string[];
  readonly expectedNone?: boolean;
  readonly forbiddenIds?: readonly string[];
  readonly staleIds?: readonly string[];
  readonly staleBefore?: string;
  readonly graphExpand?: boolean;
  readonly includeGlobal?: boolean;
  readonly topK?: number;
}

export interface RetrievalEvalResult {
  readonly id: string;
  readonly status: "passed" | "failed";
  readonly recallAtK: number;
  readonly mrr: number;
  readonly leakageCount: number;
  readonly unexpectedHitCount: number;
  readonly staleHitCount: number;
  readonly staleHitRate: number;
  readonly latencyMs: number;
  readonly backend: string;
  readonly returnedIds: string[];
  readonly checks: EvalRunResult["checks"];
}

export interface RetrievalEvalThresholds {
  readonly minRecallAtK?: number;
  readonly minMrr?: number;
  readonly maxLeakageRate?: number;
  readonly maxStaleHitRate?: number;
  readonly maxP95LatencyMs?: number;
}

export interface RetrievalEvalSuiteResult {
  readonly status: "passed" | "failed";
  readonly caseCount: number;
  readonly recallAtK: number;
  readonly mrr: number;
  readonly leakageRate: number;
  readonly unexpectedHitRate: number;
  readonly staleHitRate: number;
  readonly p95LatencyMs: number;
  readonly results: readonly RetrievalEvalResult[];
  readonly checks: EvalRunResult["checks"];
}

export interface HybridRetrievalGateDecision {
  readonly allowed: boolean;
  readonly reason: string;
  readonly failedMetrics: readonly string[];
}

export interface RetrievalEvalArtifactResult {
  readonly artifactDir: string;
  readonly manifestPath: string;
  readonly suitePath: string;
  readonly casesPath: string;
  readonly memoryStatusPath: string;
  readonly suite: RetrievalEvalSuiteResult;
  readonly gate: HybridRetrievalGateDecision;
}

export interface SeedRetrievalEvalPackInput {
  readonly id?: string;
  readonly tenant?: string;
  readonly user?: string;
  readonly otherUser?: string;
  readonly distractorCount?: number;
}

export interface SeedFrappeGraphRetrievalEvalPackInput extends SeedRetrievalEvalPackInput {
  readonly app?: string;
  readonly module?: string;
  readonly doctype?: string;
  readonly childDoctype?: string;
}

export interface SeedRetrievalEvalPackResult {
  readonly id: string;
  readonly dir: string;
  readonly scopes: readonly string[];
  readonly fixtures: readonly RetrievalEvalCase[];
  readonly memoryIds: {
    readonly exact: string;
    readonly stale: string;
    readonly fresh: string;
    readonly forbidden: string;
    readonly distractors: readonly string[];
    readonly graph?: readonly string[];
  };
}

export function evalsDir(cwd = process.cwd()): string {
  return join(dataDir(cwd), "evals");
}

export function evalPath(id: string, cwd = process.cwd()): string {
  return join(evalsDir(cwd), `${id}.json`);
}

export function retrievalEvalsDir(cwd = process.cwd()): string {
  return join(evalsDir(cwd), "retrieval");
}

export function retrievalEvalPath(id: string, cwd = process.cwd()): string {
  return join(retrievalEvalsDir(cwd), `${safeRetrievalEvalId(id)}.json`);
}

export async function seedEvalFromEpisode(
  episodeId: string,
  options: { readonly expectedContains?: readonly string[]; readonly forbiddenContains?: readonly string[] } = {},
  cwd = process.cwd()
): Promise<EvalCase> {
  const episode = await findEpisode(episodeId, cwd);
  if (!episode) throw new Error(`Episode not found: ${episodeId}`);
  const fixture = buildEvalCase(episode, options);
  await mkdir(evalsDir(cwd), { recursive: true });
  await writeFile(evalPath(fixture.id, cwd), `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  return fixture;
}

export async function listEvalCases(cwd = process.cwd()): Promise<EvalCase[]> {
  const dir = evalsDir(cwd);
  const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const cases: EvalCase[] = [];
  for (const name of names.filter((item) => item.endsWith(".json")).sort()) {
    cases.push(await readEvalCase(join(dir, name)));
  }
  return cases;
}

export async function seedRetrievalEvalCase(input: SeedRetrievalEvalInput, cwd = process.cwd()): Promise<RetrievalEvalCase> {
  const fixture = buildRetrievalEvalCase(input);
  await mkdir(retrievalEvalsDir(cwd), { recursive: true });
  await writeFile(retrievalEvalPath(fixture.id, cwd), `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  return fixture;
}

export async function seedRepresentativeRetrievalEvalPack(
  input: SeedRetrievalEvalPackInput = {},
  cwd = process.cwd()
): Promise<SeedRetrievalEvalPackResult> {
  const id = safeRetrievalEvalId(input.id ?? "representative");
  if (!id) throw new Error("Representative retrieval eval pack id is required.");
  const tenant = input.tenant ?? "f2";
  const user = input.user ?? "goblin";
  const otherUser = input.otherUser ?? `${user}-other`;
  const distractorCount = Math.max(0, Math.floor(input.distractorCount ?? 250));
  const scopes = [parseMemoryScope(`tenant:${tenant}`), parseMemoryScope(`user:${user}`)];
  const scopeStrings = scopes.map((scope) => `${scope.kind}:${scope.id}`);
  const otherScopes = [parseMemoryScope(`tenant:${tenant}`), parseMemoryScope(`user:${otherUser}`)];
  const provenance = `retrieval-pack:${id}`;
  const exact = await seedMemory({
    summary: `Frappe ${id} exact deployment target is uat-erp.example.com and belongs to ${user}.`,
    provenance: [provenance, "case:exact"],
    scopes,
    observedAt: "2026-06-20T00:00:00.000Z",
    confidence: 0.95,
  }, cwd);
  const stale = await seedMemory({
    summary: `Frappe ${id} payroll destination is the retired legacy finance bench.`,
    provenance: [provenance, "case:stale"],
    scopes,
    observedAt: "2025-01-01T00:00:00.000Z",
    confidence: 0.9,
  }, cwd);
  const fresh = await seedMemory({
    summary: `Frappe ${id} payroll destination is the current finance bench.`,
    provenance: [provenance, "case:fresh"],
    scopes,
    observedAt: "2026-06-20T00:00:00.000Z",
    confidence: 0.95,
  }, cwd);
  const forbidden = await seedMemory({
    summary: `Frappe ${id} private forbiddenneedle${otherUser} secret belongs only to ${otherUser}.`,
    provenance: [provenance, "case:forbidden"],
    scopes: otherScopes,
    observedAt: "2026-06-20T00:00:00.000Z",
    confidence: 0.95,
  }, cwd);
  const distractors = [];
  for (let index = 0; index < distractorCount; index += 1) {
    const memory = await seedMemory({
      summary: `Frappe ${id} distractor ${index} about plugins, sessions, benches, workflows, and non-target notes.`,
      provenance: [provenance, `case:distractor:${index}`],
      scopes,
      observedAt: new Date(Date.UTC(2026, 5, 1, 0, 0, index % 60)).toISOString(),
      confidence: 0.5,
    }, cwd);
    distractors.push(memory.id);
  }
  const dir = join(retrievalEvalsDir(cwd), id);
  await mkdir(dir, { recursive: true });
  const fixtureInputs: SeedRetrievalEvalInput[] = [
    {
      id: `${id}-exact-hit`,
      query: `frappe ${id} exact deployment target`,
      scopes: scopeStrings,
      expectedIds: [exact.id],
      forbiddenIds: [forbidden.id],
      topK: 5,
    },
    {
      id: `${id}-no-hit`,
      query: `zxqv-nohit-canary-${id}`,
      scopes: scopeStrings,
      expectedIds: [],
      expectedNone: true,
      topK: 5,
    },
    {
      id: `${id}-stale-hit`,
      query: `frappe ${id} current finance bench`,
      scopes: scopeStrings,
      expectedIds: [fresh.id],
      staleIds: [stale.id],
      staleBefore: "2026-01-01T00:00:00.000Z",
      topK: 1,
    },
    {
      id: `${id}-forbidden-scope`,
      query: `forbiddenneedle${otherUser}`,
      scopes: scopeStrings,
      expectedIds: [],
      expectedNone: true,
      forbiddenIds: [forbidden.id],
      topK: 5,
    },
    {
      id: `${id}-latency-distractors`,
      query: `frappe ${id} exact deployment target`,
      scopes: scopeStrings,
      expectedIds: [exact.id],
      forbiddenIds: [forbidden.id],
      topK: 5,
    },
  ];
  const fixtures = fixtureInputs.map(buildRetrievalEvalCase);
  for (const fixture of fixtures) {
    await writeFile(join(dir, `${fixture.id}.json`), `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  }
  return {
    id,
    dir,
    scopes: scopeStrings,
    fixtures,
    memoryIds: {
      exact: exact.id,
      stale: stale.id,
      fresh: fresh.id,
      forbidden: forbidden.id,
      distractors,
    },
  };
}

export async function seedFrappeGraphRetrievalEvalPack(
  input: SeedFrappeGraphRetrievalEvalPackInput = {},
  cwd = process.cwd()
): Promise<SeedRetrievalEvalPackResult> {
  const id = safeRetrievalEvalId(input.id ?? "frappe-graph");
  if (!id) throw new Error("Frappe graph retrieval eval pack id is required.");
  const tenant = input.tenant ?? "f2";
  const user = input.user ?? "goblin";
  const otherUser = input.otherUser ?? `${user}-other`;
  const app = input.app ?? "frappe_app";
  const module = input.module ?? "HR";
  const doctype = input.doctype ?? "Employee";
  const childDoctype = input.childDoctype ?? `${doctype} Detail`;
  const table = `tab${doctype}`;
  const distractorCount = Math.max(0, Math.floor(input.distractorCount ?? 250));
  const scopes = [parseMemoryScope(`tenant:${tenant}`), parseMemoryScope(`user:${user}`)];
  const scopeStrings = scopes.map((scope) => `${scope.kind}:${scope.id}`);
  const otherScopes = [parseMemoryScope(`tenant:${tenant}`), parseMemoryScope(`user:${otherUser}`)];
  const provenance = `frappe-graph-pack:${id}`;

  const child = await seedMemory({
    kind: "frappe_child_table",
    summary: `${module} child table DocType ${childDoctype} stores row_type Select and amount Currency rows for ${doctype} structured details.`,
    provenance: [provenance, "node:child-table"],
    scopes,
    observedAt: "2026-06-20T00:00:00.000Z",
    confidence: 0.96,
  }, cwd);
  const customField = await seedMemory({
    kind: "frappe_custom_field",
    summary: `${module} Custom Field ${doctype}.external_reference_id is fieldtype Data and is owned by app ${app}.`,
    provenance: [provenance, "node:custom-field"],
    scopes,
    observedAt: "2026-06-20T00:00:00.000Z",
    confidence: 0.95,
  }, cwd);
  const workflow = await seedMemory({
    kind: "frappe_workflow",
    summary: `${module} workflow ${doctype} Onboarding uses states Draft, Verified, and Active for ${doctype}.`,
    provenance: [provenance, "node:workflow"],
    scopes,
    observedAt: "2026-06-20T00:00:00.000Z",
    confidence: 0.95,
  }, cwd);
  const permission = await seedMemory({
    kind: "frappe_permission",
    summary: `${module} permissions allow HR Manager to read and write ${doctype}; Employee Self Service can read only owned records.`,
    provenance: [provenance, "node:permission"],
    scopes,
    observedAt: "2026-06-20T00:00:00.000Z",
    confidence: 0.95,
  }, cwd);
  const stale = await seedMemory({
    kind: "frappe_docfield",
    summary: `${module} retired ${doctype} field legacy_grade was replaced before 2026 and should not be used for salary classification.`,
    provenance: [provenance, "node:stale-field"],
    scopes,
    observedAt: "2025-01-01T00:00:00.000Z",
    confidence: 0.9,
  }, cwd);
  const fresh = await seedMemory({
    kind: "frappe_docfield",
    summary: `${module} current ${doctype} field salary_band is fieldtype Link to Salary Band for salary classification.`,
    provenance: [provenance, "node:fresh-field"],
    scopes,
    observedAt: "2026-06-20T00:00:00.000Z",
    confidence: 0.96,
  }, cwd);
  const doctypeNode = await seedMemory({
    kind: "frappe_doctype",
    summary: `${module} DocType ${doctype} belongs to app ${app}, module ${module}, and maps to MariaDB table ${table}. It has Link fields to related masters and stores structured details through child table ${childDoctype}.`,
    provenance: [provenance, "node:doctype"],
    scopes,
    observedAt: "2026-06-20T00:00:00.000Z",
    confidence: 0.97,
    links: [child.id, customField.id, workflow.id, permission.id, fresh.id],
  }, cwd);
  const forbidden = await seedMemory({
    kind: "frappe_private_metadata",
    summary: `${module} private forbiddenneedle${otherUser} schema token belongs only to ${otherUser}.`,
    provenance: [provenance, "node:forbidden"],
    scopes: otherScopes,
    observedAt: "2026-06-20T00:00:00.000Z",
    confidence: 0.95,
  }, cwd);
  const distractors = [];
  for (let index = 0; index < distractorCount; index += 1) {
    const memory = await seedMemory({
      kind: "frappe_distractor",
      summary: `${module} distractor ${index} covers ERPNext forms, MariaDB tables, workflow state, DocFields, permissions, and unrelated app notes.`,
      provenance: [provenance, `node:distractor:${index}`],
      scopes,
      observedAt: new Date(Date.UTC(2026, 5, 1, 0, 0, index % 60)).toISOString(),
      confidence: 0.5,
    }, cwd);
    distractors.push(memory.id);
  }

  const dir = join(retrievalEvalsDir(cwd), id);
  await mkdir(dir, { recursive: true });
  const fixtureInputs: SeedRetrievalEvalInput[] = [
    {
      id: `${id}-doctype-table`,
      query: `${module} ${doctype} MariaDB table`,
      scopes: scopeStrings,
      expectedIds: [doctypeNode.id],
      forbiddenIds: [forbidden.id],
      topK: 5,
    },
    {
      id: `${id}-custom-field`,
      query: `${doctype} external_reference_id fieldtype`,
      scopes: scopeStrings,
      expectedIds: [customField.id],
      forbiddenIds: [forbidden.id],
      topK: 5,
    },
    {
      id: `${id}-graph-child-table`,
      query: `${module} ${doctype} maps MariaDB ${table}`,
      scopes: scopeStrings,
      expectedIds: [child.id],
      forbiddenIds: [forbidden.id],
      graphExpand: true,
      topK: 5,
    },
    {
      id: `${id}-permission`,
      query: `${module} ${doctype} Employee Self Service own records`,
      scopes: scopeStrings,
      expectedIds: [permission.id],
      forbiddenIds: [forbidden.id],
      topK: 5,
    },
    {
      id: `${id}-stale-field`,
      query: `${module} ${doctype} current salary classification field`,
      scopes: scopeStrings,
      expectedIds: [fresh.id],
      staleIds: [stale.id],
      staleBefore: "2026-01-01T00:00:00.000Z",
      topK: 1,
    },
    {
      id: `${id}-forbidden-scope`,
      query: `forbiddenneedle${otherUser}`,
      scopes: scopeStrings,
      expectedIds: [],
      expectedNone: true,
      forbiddenIds: [forbidden.id],
      topK: 5,
    },
    {
      id: `${id}-no-hit`,
      query: `zxqv-frappe-nohit-${id}`,
      scopes: scopeStrings,
      expectedIds: [],
      expectedNone: true,
      topK: 5,
    },
  ];
  const fixtures = fixtureInputs.map(buildRetrievalEvalCase);
  for (const fixture of fixtures) {
    await writeFile(join(dir, `${fixture.id}.json`), `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  }
  return {
    id,
    dir,
    scopes: scopeStrings,
    fixtures,
    memoryIds: {
      exact: doctypeNode.id,
      stale: stale.id,
      fresh: fresh.id,
      forbidden: forbidden.id,
      distractors,
      graph: [child.id, customField.id, workflow.id, permission.id],
    },
  };
}

export async function listRetrievalEvalCases(pathOrDir: string | undefined = undefined, cwd = process.cwd()): Promise<RetrievalEvalListing[]> {
  const target = pathOrDir
    ? pathOrDir.startsWith("/") ? pathOrDir : join(cwd, pathOrDir)
    : retrievalEvalsDir(cwd);
  const paths = target.endsWith(".json")
    ? [target]
    : (await readdir(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      })).filter((name) => name.endsWith(".json")).sort().map((name) => join(target, name));
  const listings: RetrievalEvalListing[] = [];
  for (const path of paths) listings.push({ path, fixture: await readRetrievalEvalCase(path) });
  return listings;
}

export async function runEvalCases(pathOrDir: string | undefined, cwd = process.cwd()): Promise<EvalRunResult[]> {
  if (!pathOrDir) {
    const cases = await listEvalCases(cwd);
    return cases.map(runEvalCase);
  }
  const absolute = pathOrDir.startsWith("/") ? pathOrDir : join(cwd, pathOrDir);
  if (absolute.endsWith(".json")) return [runEvalCase(await readEvalCase(absolute))];
  const names = await readdir(absolute);
  const cases = await Promise.all(names.filter((item) => item.endsWith(".json")).sort().map((name) => readEvalCase(join(absolute, name))));
  return cases.map(runEvalCase);
}

export async function runRetrievalEvalPath(
  pathOrDir: string,
  thresholds: RetrievalEvalThresholds = {},
  cwd = process.cwd()
): Promise<RetrievalEvalSuiteResult> {
  const absolute = pathOrDir.startsWith("/") ? pathOrDir : join(cwd, pathOrDir);
  const fixtures = (await listRetrievalEvalCases(absolute, cwd)).map((listing) => listing.fixture);
  return runRetrievalEvalCases(fixtures, thresholds, cwd);
}

export async function runRetrievalEvalPathWithArtifacts(
  pathOrDir: string,
  thresholds: RetrievalEvalThresholds = {},
  artifactDir: string | undefined = undefined,
  cwd = process.cwd()
): Promise<RetrievalEvalArtifactResult> {
  const absolute = pathOrDir.startsWith("/") ? pathOrDir : join(cwd, pathOrDir);
  const listings = await listRetrievalEvalCases(absolute, cwd);
  const suite = await runRetrievalEvalCases(listings.map((listing) => listing.fixture), thresholds, cwd);
  const gate = decideHybridRetrievalGate(suite);
  const outputDir = artifactDir
    ? artifactDir.startsWith("/") ? artifactDir : join(cwd, artifactDir)
    : join(dataDir(cwd), "evals", "artifacts", `retrieval-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const memoryStatus = await inspectMemoryStore(cwd);
  return writeRetrievalEvalArtifacts({
    target: absolute,
    artifactDir: outputDir,
    thresholds,
    listings,
    suite,
    gate,
    memoryStatus,
  });
}

export async function runRetrievalEvalCase(fixture: RetrievalEvalCase, cwd = process.cwd()): Promise<RetrievalEvalResult> {
  const topK = Math.max(1, Math.floor(fixture.topK ?? 5));
  const started = performance.now();
  const result = await searchMemoryWithReceipts({
    query: fixture.query,
    scopes: fixture.scopes.map(parseMemoryScope),
    includeGlobal: fixture.includeGlobal,
    limit: topK,
    candidateLimit: Math.max(topK * 20, 50),
    match: "any",
    expandLinked: fixture.graphExpand,
  }, cwd);
  const latencyMs = performance.now() - started;
  const returnedIds = result.receipts.map((receipt) => receipt.memory.id);
  const expected = new Set(fixture.expectedIds);
  const expectedNone = fixture.expectedNone === true;
  const forbidden = new Set(fixture.forbiddenIds ?? []);
  const explicitStale = new Set(fixture.staleIds ?? []);
  const foundExpected = returnedIds.filter((id) => expected.has(id));
  const leaked = returnedIds.filter((id) => forbidden.has(id));
  const unexpectedHits = expectedNone ? returnedIds : [];
  const staleHits = result.receipts
    .filter((receipt) => !expected.has(receipt.memory.id))
    .filter((receipt) => explicitStale.has(receipt.memory.id) || (fixture.staleBefore ? Date.parse(receipt.memory.observedAt) < Date.parse(fixture.staleBefore) : false))
    .map((receipt) => receipt.memory.id);
  const firstRank = returnedIds.findIndex((id) => expected.has(id));
  const checks: EvalRunResult["checks"] = [
    {
      label: "expected_recall",
      status: expectedNone || foundExpected.length === fixture.expectedIds.length ? "passed" : "failed",
      detail: expectedNone ? "expected=none" : `found=${foundExpected.join(",") || "none"} expected=${fixture.expectedIds.join(",")}`,
    },
    {
      label: "unexpected_absent",
      status: !expectedNone || returnedIds.length === 0 ? "passed" : "failed",
      detail: expectedNone ? (returnedIds.join(",") || "none") : "not-applicable",
    },
    {
      label: "forbidden_absent",
      status: leaked.length === 0 ? "passed" : "failed",
      detail: leaked.join(",") || "none",
    },
    {
      label: "stale_absent",
      status: staleHits.length === 0 ? "passed" : "failed",
      detail: staleHits.join(",") || "none",
    },
  ];
  return {
    id: fixture.id,
    status: checks.every((check) => check.status === "passed") ? "passed" : "failed",
    recallAtK: expectedNone ? (returnedIds.length === 0 ? 1 : 0) : (fixture.expectedIds.length ? foundExpected.length / fixture.expectedIds.length : 1),
    mrr: expectedNone ? (returnedIds.length === 0 ? 1 : 0) : (firstRank === -1 ? 0 : 1 / (firstRank + 1)),
    leakageCount: leaked.length,
    unexpectedHitCount: unexpectedHits.length,
    staleHitCount: staleHits.length,
    staleHitRate: returnedIds.length ? staleHits.length / returnedIds.length : 0,
    latencyMs,
    backend: result.backend,
    returnedIds,
    checks,
  };
}

export async function runRetrievalEvalCases(
  fixtures: readonly RetrievalEvalCase[],
  thresholds: RetrievalEvalThresholds = {},
  cwd = process.cwd()
): Promise<RetrievalEvalSuiteResult> {
  const results = [];
  for (const fixture of fixtures) results.push(await runRetrievalEvalCase(fixture, cwd));
  return summarizeRetrievalEvalResults(results, thresholds);
}

export function summarizeRetrievalEvalResults(
  results: readonly RetrievalEvalResult[],
  thresholds: RetrievalEvalThresholds = {}
): RetrievalEvalSuiteResult {
  const caseCount = results.length;
  const totalReturned = results.reduce((sum, result) => sum + result.returnedIds.length, 0);
  const leakageCount = results.reduce((sum, result) => sum + result.leakageCount, 0);
  const unexpectedHitCount = results.reduce((sum, result) => sum + result.unexpectedHitCount, 0);
  const staleHitCount = results.reduce((sum, result) => sum + result.staleHitCount, 0);
  const recallAtK = average(results.map((result) => result.recallAtK), 0);
  const mrr = average(results.map((result) => result.mrr), 0);
  const leakageRate = totalReturned ? leakageCount / totalReturned : 0;
  const unexpectedHitRate = totalReturned ? unexpectedHitCount / totalReturned : 0;
  const staleHitRate = totalReturned ? staleHitCount / totalReturned : 0;
  const p95LatencyMs = percentile(results.map((result) => result.latencyMs), 0.95);
  const checks: EvalRunResult["checks"] = [
    thresholdCheck("non_empty_suite", caseCount > 0, `cases=${caseCount}`),
    thresholdCheck("recall_at_5_floor", recallAtK >= (thresholds.minRecallAtK ?? 1), `actual=${recallAtK.toFixed(3)} min=${thresholds.minRecallAtK ?? 1}`),
    thresholdCheck("mrr_at_5_floor", mrr >= (thresholds.minMrr ?? 1), `actual=${mrr.toFixed(3)} min=${thresholds.minMrr ?? 1}`),
    thresholdCheck("unexpected_hit_rate_ceiling", unexpectedHitRate <= 0, `actual=${unexpectedHitRate.toFixed(3)} max=0`),
    thresholdCheck("leakage_rate_ceiling", leakageRate <= (thresholds.maxLeakageRate ?? 0), `actual=${leakageRate.toFixed(3)} max=${thresholds.maxLeakageRate ?? 0}`),
    thresholdCheck("stale_hit_rate_ceiling", staleHitRate <= (thresholds.maxStaleHitRate ?? 0), `actual=${staleHitRate.toFixed(3)} max=${thresholds.maxStaleHitRate ?? 0}`),
    ...(thresholds.maxP95LatencyMs === undefined
      ? []
      : [thresholdCheck("p95_latency_ceiling", p95LatencyMs <= thresholds.maxP95LatencyMs, `actual=${p95LatencyMs.toFixed(3)}ms max=${thresholds.maxP95LatencyMs}ms`)]),
  ];
  return {
    status: results.every((result) => result.status === "passed") && checks.every((check) => check.status === "passed") ? "passed" : "failed",
    caseCount,
    recallAtK,
    mrr,
    leakageRate,
    unexpectedHitRate,
    staleHitRate,
    p95LatencyMs,
    results,
    checks,
  };
}

export function decideHybridRetrievalGate(suite: RetrievalEvalSuiteResult): HybridRetrievalGateDecision {
  const failedMetrics = suite.checks.filter((check) => check.status === "failed").map((check) => check.label);
  if (failedMetrics.includes("non_empty_suite")) {
    return { allowed: false, reason: "retrieval eval suite is empty; seed representative lexical fixtures before considering hybrid retrieval", failedMetrics };
  }
  const recallInsufficient = failedMetrics.includes("recall_at_5_floor") || failedMetrics.includes("mrr_at_5_floor");
  const safetyFailed = failedMetrics.includes("unexpected_hit_rate_ceiling") || failedMetrics.includes("leakage_rate_ceiling") || failedMetrics.includes("stale_hit_rate_ceiling");
  if (recallInsufficient && !safetyFailed) {
    return { allowed: true, reason: "lexical retrieval failed recall/MRR gates without safety regressions; hybrid experiment may run behind eval gate", failedMetrics };
  }
  if (safetyFailed) {
    return { allowed: false, reason: "fix unexpected, scoped leakage, or stale-hit safety before adding hybrid retrieval", failedMetrics };
  }
  return { allowed: false, reason: "lexical retrieval has not been proven insufficient by recall/MRR gates", failedMetrics };
}

async function writeRetrievalEvalArtifacts(input: {
  readonly target: string;
  readonly artifactDir: string;
  readonly thresholds: RetrievalEvalThresholds;
  readonly listings: readonly RetrievalEvalListing[];
  readonly suite: RetrievalEvalSuiteResult;
  readonly gate: HybridRetrievalGateDecision;
  readonly memoryStatus: MemoryStoreInspection;
}): Promise<RetrievalEvalArtifactResult> {
  await mkdir(input.artifactDir, { recursive: true });
  const manifestPath = join(input.artifactDir, "manifest.json");
  const suitePath = join(input.artifactDir, "suite.json");
  const casesPath = join(input.artifactDir, "cases.jsonl");
  const memoryStatusPath = join(input.artifactDir, "memory-status.json");
  const resultsById = new Map(input.suite.results.map((result) => [result.id, result]));
  const cases = input.listings.map((listing) => ({
    path: listing.path,
    fixture: listing.fixture,
    result: resultsById.get(listing.fixture.id),
  }));
  const manifest = {
    schemaVersion: 1,
    kind: "retrieval-eval-artifacts",
    createdAt: new Date().toISOString(),
    target: input.target,
    thresholds: input.thresholds,
    status: input.suite.status,
    caseCount: input.suite.caseCount,
    metrics: {
      recallAtK: input.suite.recallAtK,
      mrr: input.suite.mrr,
      leakageRate: input.suite.leakageRate,
      unexpectedHitRate: input.suite.unexpectedHitRate,
      staleHitRate: input.suite.staleHitRate,
      p95LatencyMs: input.suite.p95LatencyMs,
    },
    hybridGate: input.gate,
    artifacts: {
      suite: "suite.json",
      cases: "cases.jsonl",
      memoryStatus: "memory-status.json",
    },
    fixtures: input.listings.map((listing) => ({
      id: listing.fixture.id,
      path: listing.path,
      query: listing.fixture.query,
      scopes: listing.fixture.scopes,
      topK: listing.fixture.topK ?? 5,
      expected: listing.fixture.expectedNone ? "none" : listing.fixture.expectedIds,
      forbiddenCount: listing.fixture.forbiddenIds?.length ?? 0,
      staleCount: listing.fixture.staleIds?.length ?? 0,
      graphExpand: listing.fixture.graphExpand === true,
    })),
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(suitePath, `${JSON.stringify({ suite: input.suite, hybridGate: input.gate }, null, 2)}\n`, "utf8");
  await writeFile(casesPath, `${cases.map((item) => JSON.stringify(item)).join("\n")}${cases.length ? "\n" : ""}`, "utf8");
  await writeFile(memoryStatusPath, `${JSON.stringify(input.memoryStatus, null, 2)}\n`, "utf8");
  return {
    artifactDir: input.artifactDir,
    manifestPath,
    suitePath,
    casesPath,
    memoryStatusPath,
    suite: input.suite,
    gate: input.gate,
  };
}

export function runEvalCase(fixture: EvalCase): EvalRunResult {
  const response = fixture.recordedResponseText.toLowerCase();
  const checks: EvalRunResult["checks"] = [];
  for (const expected of fixture.expectedContains) {
    const passed = response.includes(expected.toLowerCase());
    checks.push({
      label: "expected_contains",
      status: passed ? "passed" : "failed",
      detail: expected
    });
  }
  for (const forbidden of fixture.forbiddenContains ?? []) {
    const passed = !response.includes(forbidden.toLowerCase());
    checks.push({
      label: "forbidden_absent",
      status: passed ? "passed" : "failed",
      detail: forbidden
    });
  }
  return {
    id: fixture.id,
    sourceEpisodeId: fixture.sourceEpisodeId,
    status: checks.every((check) => check.status === "passed") ? "passed" : "failed",
    checks
  };
}

function thresholdCheck(label: string, passed: boolean, detail: string): EvalRunResult["checks"][number] {
  return { label, status: passed ? "passed" : "failed", detail };
}

function average(values: readonly number[], fallback: number): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : fallback;
}

function percentile(values: readonly number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] ?? 0;
}

function buildEvalCase(
  episode: EpisodeRecord,
  options: { readonly expectedContains?: readonly string[]; readonly forbiddenContains?: readonly string[] }
): EvalCase {
  const expectedContains = [...(options.expectedContains?.filter(Boolean) ?? [])];
  if (!expectedContains.length) {
    const derived = episode.responseText.trim().split(/\n|\./)[0]?.trim();
    if (derived) expectedContains.push(derived);
  }
  if (!expectedContains.length) throw new Error("Cannot seed eval without expected text.");
  return {
    schemaVersion: 1,
    id: safeEvalId(episode.id),
    createdAt: new Date().toISOString(),
    sourceEpisodeId: episode.id,
    prompt: episode.prompt,
    taskKind: episode.taskKind,
    recordedResponseText: episode.responseText,
    expectedContains,
    forbiddenContains: options.forbiddenContains?.filter(Boolean),
    evidenceLabels: episode.evidence.map((item) => item.label)
  };
}

function buildRetrievalEvalCase(input: SeedRetrievalEvalInput): RetrievalEvalCase {
  const id = safeRetrievalEvalId(input.id);
  const query = input.query.trim();
  const scopes = input.scopes.map((scope) => scope.trim()).filter(Boolean);
  const expectedIds = input.expectedIds.map((id) => id.trim()).filter(Boolean);
  const expectedNone = input.expectedNone === true;
  const forbiddenIds = input.forbiddenIds?.map((id) => id.trim()).filter(Boolean);
  const staleIds = input.staleIds?.map((id) => id.trim()).filter(Boolean);
  if (!id) throw new Error("Retrieval eval id is required.");
  if (!query) throw new Error("Retrieval eval query is required.");
  if (!scopes.length) throw new Error("Retrieval eval requires at least one --scope.");
  for (const scope of scopes) parseMemoryScope(scope);
  if (!expectedIds.length && !expectedNone) throw new Error("Retrieval eval requires at least one --expect memory id or --expect-none.");
  if (expectedIds.length && expectedNone) throw new Error("Retrieval eval cannot combine --expect and --expect-none.");
  if (input.staleBefore !== undefined && Number.isNaN(Date.parse(input.staleBefore))) {
    throw new Error("Retrieval eval staleBefore must be a valid ISO timestamp.");
  }
  return {
    schemaVersion: 1,
    kind: "retrieval",
    id,
    query,
    scopes,
    includeGlobal: input.includeGlobal || undefined,
    expectedIds,
    expectedNone: expectedNone || undefined,
    forbiddenIds: forbiddenIds?.length ? forbiddenIds : undefined,
    staleIds: staleIds?.length ? staleIds : undefined,
    staleBefore: input.staleBefore,
    graphExpand: input.graphExpand || undefined,
    topK: input.topK === undefined ? undefined : Math.max(1, Math.floor(input.topK)),
  };
}

async function readEvalCase(path: string): Promise<EvalCase> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as EvalCase;
  if (parsed.schemaVersion !== 1 || !parsed.id || !parsed.sourceEpisodeId || !Array.isArray(parsed.expectedContains)) {
    throw new Error(`Invalid eval fixture: ${path}`);
  }
  return parsed;
}

async function readRetrievalEvalCase(path: string): Promise<RetrievalEvalCase> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as RetrievalEvalCase;
  if (parsed.schemaVersion !== 1 || parsed.kind !== "retrieval" || !parsed.id || !parsed.query || !Array.isArray(parsed.scopes) || !Array.isArray(parsed.expectedIds)) {
    throw new Error(`Invalid retrieval eval fixture: ${path}`);
  }
  if (!parsed.expectedIds.length && parsed.expectedNone !== true) {
    throw new Error(`Invalid retrieval eval fixture: ${path}`);
  }
  if (parsed.expectedIds.length && parsed.expectedNone === true) {
    throw new Error(`Invalid retrieval eval fixture combines expectedIds and expectedNone: ${path}`);
  }
  if (parsed.staleBefore !== undefined && Number.isNaN(Date.parse(parsed.staleBefore))) {
    throw new Error(`Invalid retrieval eval staleBefore timestamp: ${path}`);
  }
  return parsed;
}

function safeEvalId(episodeId: string): string {
  return `eval_${episodeId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function safeRetrievalEvalId(id: string): string {
  return id.trim().replace(/[^a-zA-Z0-9_-]/g, "-");
}
