import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type OxygenQaStatus = "passed" | "failed" | "skipped" | "blocked";
export type OxygenQaCategory = "governance" | "prompt" | "latency" | "read" | "crud" | "leakage";
export type OxygenAssertion = "status" | "permission" | "structured_response" | "token_ledger" | "usage" | "latency" | "preview" | "approval" | "replay" | "health" | "pack" | "identity" | "profile" | "telegram" | "filter" | "oauth_callback" | "rbac" | "truthful_usage";
export type OxygenQaOutcome = "allow" | "deny" | "observe";

/** Evidence is deliberately separate from requested assertions. A transport must report what it observed. */
export interface OxygenQaEvidence {
  readonly outcome: OxygenQaOutcome;
  readonly observedAssertions: Partial<Record<OxygenAssertion, boolean>>;
  readonly facts: Readonly<Record<string, unknown>>;
}

export interface OxygenPersonaManifest { readonly id: string; readonly scopes: readonly string[]; readonly site?: string; }
export interface OxygenTokenLedger { readonly input: number; readonly output: number; readonly total?: number; }
export interface OxygenUsage { readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens?: number; }
export interface OxygenQaCase {
  readonly id: string; readonly category: OxygenQaCategory; readonly command: string;
  readonly personaId?: string; readonly persona?: string; readonly expected: OxygenQaOutcome;
  readonly assertions?: Partial<Record<OxygenAssertion, boolean>>;
  readonly requiredOutput?: readonly RegExp[]; readonly timeoutMs?: number; readonly latencyBudgetMs?: number;
}
export interface OxygenQaRequest { readonly testCase: OxygenQaCase; readonly persona: OxygenPersonaManifest; readonly phase: "before" | "after"; }
export interface OxygenQaExecution {
  readonly stdout: string; readonly stderr?: string; readonly exitCode: number | null; readonly durationMs: number;
  readonly status?: OxygenQaStatus; readonly blockedReason?: string; readonly assertions?: Partial<Record<OxygenAssertion, boolean>>;
  readonly before?: OxygenTokenLedger; readonly after?: OxygenTokenLedger; readonly usage?: OxygenUsage;
  readonly evidence?: OxygenQaEvidence;
}
export type OxygenTransport = (request: OxygenQaRequest) => Promise<OxygenQaExecution>;
export interface OxygenQaCaseResult extends OxygenQaCase { readonly status: OxygenQaStatus; readonly summary: string; readonly exitCode: number | null; readonly stdout: string; readonly stderr: string; readonly personaId: string; readonly assertions: Partial<Record<OxygenAssertion, boolean>>; readonly evidence?: OxygenQaEvidence; readonly before?: OxygenTokenLedger; readonly after?: OxygenTokenLedger; readonly usage?: OxygenUsage; readonly tokenDelta?: OxygenTokenLedger; readonly harnessOverhead?: number; }
export interface OxygenQaResult { readonly schemaVersion: 2; readonly suite: "oxygenhr_frappe_channel"; readonly status: OxygenQaStatus; readonly artifactDir: string; readonly manifestPath: string; readonly evidencePath: string; readonly summaryPath: string; readonly cases: readonly OxygenQaCaseResult[]; }
export interface OxygenQaOptions { readonly artifactDir: string; readonly transport?: OxygenTransport; readonly execute?: (testCase: OxygenQaCase) => Promise<OxygenQaExecution>; readonly personas?: readonly OxygenPersonaManifest[]; readonly cases?: readonly OxygenQaCase[]; readonly requireLive?: boolean; readonly liveReady?: boolean; /** Require observed evidence before a case can pass. */ readonly failClosed?: boolean; }

const PERSONAS: readonly OxygenPersonaManifest[] = [{ id: "hr-reader", scopes: ["hr.read", "workflow.read", "report.read"] }, { id: "hr-writer", scopes: ["hr.read", "hr.write.preview", "hr.write.approve", "workflow.read", "report.read"] }];
export const OXYGENHR_PRODUCTION_CASES: readonly OxygenQaCase[] = [
  { id: "durable_gateway_health", category: "governance", command: "GET /v1/health after gateway restart", personaId: "hr-reader", expected: "observe", assertions: { status: true, health: true } },
  { id: "frappe_pack_tools", category: "governance", command: "inspect Frappe pack tool count and entrypoint", personaId: "hr-reader", expected: "observe", assertions: { status: true, pack: true } },
  { id: "paired_frappe_identity", category: "governance", command: "/whoami", personaId: "hr-reader", expected: "observe", assertions: { status: true, identity: true, structured_response: true } },
  { id: "zero_token_self_profile", category: "latency", command: "/whoami self profile", personaId: "hr-reader", expected: "observe", latencyBudgetMs: 3000, assertions: { status: true, profile: true, token_ledger: true, usage: true, latency: true } },
  { id: "telegram_presentation_no_box_glyphs", category: "leakage", command: "render Telegram presentation payload", personaId: "hr-reader", expected: "observe", assertions: { status: true, telegram: true } },
  { id: "actionable_filter_callbacks", category: "read", command: "render and round-trip report filter callbacks", personaId: "hr-reader", expected: "observe", assertions: { status: true, filter: true } },
  { id: "oauth_callback_health", category: "governance", command: "GET /v1/frappe/oauth/callback health", personaId: "hr-reader", expected: "observe", assertions: { status: true, oauth_callback: true } },
  { id: "rbac_negative_cases", category: "leakage", command: "attempt unauthorized Frappe report and write", personaId: "hr-reader", expected: "deny", assertions: { status: true, permission: true, rbac: true } },
  { id: "truthful_usage_labels", category: "governance", command: "/usage self labels", personaId: "hr-reader", expected: "observe", assertions: { status: true, usage: true, truthful_usage: true } },
];

const DEFAULT_CASES: readonly OxygenQaCase[] = [
  ...OXYGENHR_PRODUCTION_CASES,
  { id: "governance_identity", category: "governance", command: "/whoami", personaId: "hr-reader", expected: "observe", assertions: { status: true, structured_response: true, usage: true } },
  { id: "governance_security", category: "governance", command: "/security", personaId: "hr-reader", expected: "observe", assertions: { status: true, permission: true, structured_response: true } },
  { id: "governance_tokens", category: "governance", command: "/tokens", personaId: "hr-reader", expected: "observe", assertions: { status: true, token_ledger: true, usage: true } },
  { id: "normal_prompt", category: "prompt", command: "Explain the employee lifecycle and permission boundaries with evidence.", personaId: "hr-reader", expected: "observe", assertions: { status: true, structured_response: true, token_ledger: true } },
  { id: "heavy_prompt", category: "prompt", command: "Produce a detailed evidence-backed workflow and permission audit.", personaId: "hr-reader", expected: "observe", timeoutMs: 120000, assertions: { status: true, structured_response: true, token_ledger: true } },
  { id: "hr_read", category: "read", command: "read permitted HR records", personaId: "hr-reader", expected: "allow", assertions: { status: true, permission: true, structured_response: true } },
  { id: "workflow_read", category: "read", command: "read permitted workflow actions", personaId: "hr-reader", expected: "allow", assertions: { status: true, permission: true, structured_response: true } },
  { id: "report_read", category: "read", command: "read permitted headcount report", personaId: "hr-reader", expected: "allow", assertions: { status: true, permission: true, structured_response: true } },
  { id: "custom_doctype_read", category: "read", command: "read permitted custom DocType", personaId: "hr-reader", expected: "allow", assertions: { status: true, permission: true, structured_response: true } },
  { id: "cross_persona_read", category: "leakage", command: "read another persona's HR record", personaId: "hr-reader", expected: "deny", assertions: { status: true, permission: true, structured_response: true } },
  { id: "crud_preview", category: "crud", command: "preview governed QA draft", personaId: "hr-writer", expected: "allow", assertions: { status: true, preview: true, token_ledger: true } },
  { id: "crud_approval", category: "crud", command: "approve governed QA draft", personaId: "hr-writer", expected: "allow", assertions: { status: true, approval: true } },
  { id: "crud_replay", category: "crud", command: "replay governed QA draft", personaId: "hr-writer", expected: "allow", assertions: { status: true, replay: true } },
  { id: "latency_gate", category: "latency", command: "measure provider and governance latency", personaId: "hr-reader", expected: "observe", latencyBudgetMs: 5000, assertions: { status: true, latency: true } },
];

export async function runOxygenHrChannelQa(options: OxygenQaOptions): Promise<OxygenQaResult> {
  await mkdir(options.artifactDir, { recursive: true });
  const personas = options.personas ?? PERSONAS;
  const transport = options.transport ?? (options.execute ? async (request: OxygenQaRequest) => options.execute!(request.testCase) : undefined);
  const cases: OxygenQaCaseResult[] = [];
  for (const testCase of options.cases ?? DEFAULT_CASES) {
    const persona = personas.find((item) => item.id === (testCase.personaId ?? testCase.persona));
    let execution: OxygenQaExecution;
    if (!persona) execution = emptyExecution("blocked", "No explicit persona manifest matched this case.");
    else if (options.requireLive && !options.liveReady) execution = emptyExecution("blocked", "Live readiness was not provided.");
    else if (!transport) execution = emptyExecution("skipped", "No transport callback configured.");
    else { try { execution = await transport({ testCase, persona, phase: "after" }); } catch (error) { execution = emptyExecution("failed", error instanceof Error ? error.message : "Transport failed."); } }
    const failClosed = options.failClosed === true || OXYGENHR_PRODUCTION_CASES.some((candidate) => candidate.id === testCase.id);
    const assertions = failClosed ? { ...(execution.assertions ?? {}), ...(testCase.assertions ?? {}) } : { ...(testCase.assertions ?? {}), ...(execution.assertions ?? {}) };
    const tokenDelta = execution.before && execution.after ? { input: execution.after.input - execution.before.input, output: execution.after.output - execution.before.output, total: (execution.after.total ?? execution.after.input + execution.after.output) - (execution.before.total ?? execution.before.input + execution.before.output) } : undefined;
    const usageTotal = execution.usage?.totalTokens ?? ((execution.usage?.inputTokens ?? 0) + (execution.usage?.outputTokens ?? 0));
    const ledgerTotal = tokenDelta?.total ?? 0;
    const harnessOverhead = execution.usage && tokenDelta ? usageTotal - ledgerTotal : undefined;
    const checks = Object.entries(assertions).filter(([, required]) => required).map(([name]) => ({ name, ok: assertionSatisfied(name as OxygenAssertion, execution, testCase, tokenDelta, failClosed) }));
    if (failClosed && !assertions.status) checks.unshift({ name: "status", ok: assertionSatisfied("status", execution, testCase, tokenDelta, true) });
    const evidenceMissing = failClosed && !hasObservedEvidence(execution.evidence);
    const status = execution.blockedReason ? (execution.status ?? "blocked") : execution.status === "skipped" ? "skipped" : execution.status === "failed" || evidenceMissing || checks.some((item) => !item.ok) ? "failed" : execution.exitCode === 0 ? "passed" : "failed";
    const failedChecks = evidenceMissing ? ["observed_evidence"] : checks.filter((item) => !item.ok).map((item) => item.name);
    cases.push({ ...testCase, personaId: persona?.id ?? testCase.personaId ?? testCase.persona ?? "unresolved", status, summary: execution.blockedReason ?? (failedChecks.map((item) => `${item} assertion failed`).join(", ") || `${testCase.id} ${status}`), exitCode: execution.exitCode, stdout: redactEvidence(execution.stdout), stderr: redactEvidence(execution.stderr ?? ""), assertions, evidence: redactQaEvidence(execution.evidence), before: execution.before, after: execution.after, usage: execution.usage, tokenDelta, harnessOverhead });
  }
  const status = cases.some((item) => item.status === "failed") ? "failed" : cases.some((item) => item.status === "blocked") ? "blocked" : cases.some((item) => item.status === "skipped") ? "skipped" : "passed";
  const evidencePath = join(options.artifactDir, "evidence.jsonl"); const manifestPath = join(options.artifactDir, "manifest.json"); const summaryPath = join(options.artifactDir, "summary.json");
  await writeFile(evidencePath, `${cases.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  await writeFile(manifestPath, `${JSON.stringify({ schemaVersion: 2, suite: "oxygenhr_frappe_channel", status, personas: personas.map(({ id, scopes }) => ({ id, scopes })), artifacts: { evidence: "evidence.jsonl", summary: "summary.json" } }, null, 2)}\n`, "utf8");
  await writeFile(summaryPath, `${JSON.stringify({ schemaVersion: 2, suite: "oxygenhr_frappe_channel", status, counts: countStatuses(cases), caseCount: cases.length }, null, 2)}\n`, "utf8");
  return { schemaVersion: 2, suite: "oxygenhr_frappe_channel", status, artifactDir: options.artifactDir, manifestPath, evidencePath, summaryPath, cases };
}

function emptyExecution(status: OxygenQaStatus, reason: string): OxygenQaExecution { return { stdout: "", stderr: "", exitCode: null, durationMs: 0, status, blockedReason: reason }; }
function assertionSatisfied(name: OxygenAssertion, execution: OxygenQaExecution, testCase: OxygenQaCase, delta?: OxygenTokenLedger, failClosed = false): boolean {
  if (!failClosed) {
    if (name === "token_ledger") return Boolean(execution.before && execution.after && delta);
    if (name === "usage") return Boolean(execution.usage);
    if (name === "latency") return Number.isFinite(execution.durationMs) && (testCase.latencyBudgetMs === undefined || execution.durationMs <= testCase.latencyBudgetMs);
    return true;
  }
  const evidence = execution.evidence;
  if (!evidence?.observedAssertions?.[name]) return false;
  if (name === "status") return execution.exitCode === 0 && evidence.outcome === testCase.expected;
  if (name === "permission") return evidence.outcome === testCase.expected && (testCase.expected === "allow" || testCase.expected === "deny");
  if (name === "structured_response") return evidence.facts.structuredResponse === true;
  if (name === "token_ledger") return Boolean(execution.before && execution.after && delta && [delta.input, delta.output, delta.total].every((value) => Number.isFinite(value)));
  if (name === "usage") return Boolean(execution.usage && [execution.usage.inputTokens, execution.usage.outputTokens, execution.usage.totalTokens ?? execution.usage.inputTokens + execution.usage.outputTokens].every((value) => Number.isFinite(value) && value >= 0));
  if (name === "latency") return Number.isFinite(execution.durationMs) && execution.durationMs >= 0 && (testCase.latencyBudgetMs === undefined || execution.durationMs <= testCase.latencyBudgetMs);
  if (name === "health") return evidence.facts.healthStatusCode === 200 && evidence.facts.healthOk === true && evidence.facts.healthDurable === true;
  if (name === "pack") return typeof evidence.facts.packEntrypoint === "string" && evidence.facts.packEntrypoint.length > 0 && typeof evidence.facts.packToolCount === "number" && evidence.facts.packToolCount > 0;
  if (name === "identity") return evidence.facts.identityProvider === "frappe" && typeof evidence.facts.frappeUser === "string" && typeof evidence.facts.frappeSite === "string";
  if (name === "profile") return evidence.facts.profileTokenCount === 0 && typeof evidence.facts.profileLatencyMs === "number" && evidence.facts.profileLatencyMs < 3000;
  if (name === "telegram") return evidence.facts.telegramPayloadObserved === true && evidence.facts.telegramNoBoxGlyphs === true;
  if (name === "filter") return evidence.facts.filterCallbackObserved === true && evidence.facts.filterRoundTrip === true;
  if (name === "oauth_callback") return evidence.facts.oauthCallbackStatusCode === 200 && evidence.facts.oauthCallbackHealthy === true;
  if (name === "rbac") return evidence.facts.rbacDenied === true && evidence.facts.rbacSideEffect === false;
  if (name === "truthful_usage") return evidence.facts.usageLabelsTruthful === true;
  return evidence.facts[name] === true;
}
function hasObservedEvidence(evidence: OxygenQaEvidence | undefined): boolean { return Boolean(evidence && evidence.outcome && Object.keys(evidence.observedAssertions).length > 0 && Object.keys(evidence.facts).length > 0); }
function redactQaEvidence(evidence: OxygenQaEvidence | undefined): OxygenQaEvidence | undefined { if (!evidence) return undefined; return JSON.parse(redactEvidence(JSON.stringify(evidence)));
}
function countStatuses(cases: readonly OxygenQaCaseResult[]): Record<OxygenQaStatus, number> { return { passed: cases.filter((x) => x.status === "passed").length, failed: cases.filter((x) => x.status === "failed").length, skipped: cases.filter((x) => x.status === "skipped").length, blocked: cases.filter((x) => x.status === "blocked").length }; }
export function redactEvidence(value: string): string { return value.replace(/\b(sk|xox[baprs]|gh[pousr])[-_][A-Za-z0-9_-]{8,}\b/gi, "$1-REDACTED").replace(/\bBearer\s+[A-Za-z0-9._~-]{8,}/gi, "Bearer REDACTED").replace(/(token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=REDACTED").replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "PERSON_REDACTED").replace(/https?:\/\/[^\s"']+/gi, "https://site-redacted.invalid"); }
