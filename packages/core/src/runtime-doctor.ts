import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { join as pathJoin } from "node:path";
import { promisify } from "node:util";
import { inspectCodex } from "./codex.js";
import { dataDir, readJsonFile } from "./store.js";
import type { MusterConfig, ProviderConfig } from "./types.js";

const execFileAsync = promisify(execFile);

export type RuntimeDoctorStatus = "passed" | "warning" | "failed" | "unknown";

export interface RuntimeDoctorCheck {
  readonly id: string;
  readonly status: RuntimeDoctorStatus;
  readonly summary: string;
  readonly detail?: string;
  readonly fix?: string;
}

export interface CodexRuntimeDoctorReport {
  readonly command: string;
  readonly available: boolean;
  readonly version?: string;
  readonly latestVersion?: string;
  readonly supportsExec?: boolean;
  readonly supportsAppServer?: boolean;
  readonly authStatus: RuntimeDoctorStatus;
  readonly authDetail?: string;
  readonly checks: readonly RuntimeDoctorCheck[];
  readonly recommendation: string;
}

export interface ProviderDoctorReport {
  readonly id: string;
  readonly kind: ProviderConfig["kind"];
  readonly defaultModel: string;
  readonly status: RuntimeDoctorStatus;
  readonly detail: string;
  readonly fix?: string;
}

export interface RuntimeMaturityScorecard {
  readonly status: RuntimeDoctorStatus;
  readonly checks: readonly RuntimeDoctorCheck[];
  readonly summary: {
    readonly passed: number;
    readonly warning: number;
    readonly failed: number;
    readonly unknown: number;
  };
}

export interface StrictReleaseValidation {
  readonly status: RuntimeDoctorStatus;
  readonly checks: readonly RuntimeDoctorCheck[];
  readonly summary: RuntimeMaturityScorecard["summary"];
}

export const REQUIRED_QA_SUITES = [
  "pty_tui",
  "provider_latency",
  "mcp_auth_failure",
  "memory_retrieval_speed",
  "channel_plugin_setup",
  "frappe2_real_prompts",
  "pack_readiness",
] as const;

export type RequiredQaSuiteId = typeof REQUIRED_QA_SUITES[number];

const REQUIRED_QA_CASES: Readonly<Record<RequiredQaSuiteId, readonly string[]>> = {
  pty_tui: [
    "slash_overlay_stable",
    "escape_closes_bare_completion",
    "history_navigation",
    "prompt_visible_after_output",
    "agent_overlay_navigation",
    "large_overlay_scroll_window",
    "selected_row_contrast",
    "provider_model_speed_workflow",
    "cramped_transcript_receipts",
    "key_classifier",
    "responsive_widths",
    "real_pty_interaction",
  ],
  provider_latency: ["sample_1", "overhead_p50_gate"],
  mcp_auth_failure: ["missing_token", "expired_token", "invalid_token", "valid_token", "logout_recovery"],
  memory_retrieval_speed: ["retrieval_quality", "probe_latency", "index_health", "external_memory_policy"],
  channel_plugin_setup: [
    "catalog_core_surfaces",
    "catalog_actionability_evidence",
    "everyday_capability_breadth",
    "skill_catalog_breadth",
    "mcp_auth_install_depth",
    "setup_guidance_frappe-federated-bridge",
    "setup_guidance_web-frameworks",
    "setup_guidance_google-workspace",
    "setup_guidance_telegram",
    "setup_guidance_slack",
    "integration_action_completion",
    "integration_action_next_steps",
    "high_risk_refusal",
    "enable_disable_policy",
    "mcp_install_guidance",
  ],
  frappe2_real_prompts: [
    "remote_identity",
    "global_help_and_qa_catalog",
    "codex_runtime_doctor",
    "memory_status_probe",
    "real_prompt_latency",
    "retrieval_artifact_gate",
  ],
  pack_readiness: [
    "all_manifests_parse",
    "readiness_metadata_visible",
    "no_release_ready_without_evidence",
    "high_risk_has_secrets_and_policy",
    "declared_evals_are_visible",
  ],
};

export interface QaSuiteEvidence {
  readonly status: RuntimeDoctorStatus;
  readonly artifactDir?: string;
  readonly summary?: string;
  readonly checkedAt?: string;
}

export interface RuntimeQaEvidence {
  readonly providerPickerWorkflow?: boolean;
  readonly mcpAuthWorkflow?: boolean;
  readonly suites?: Partial<Record<RequiredQaSuiteId, QaSuiteEvidence>>;
}

interface QaArtifactManifest {
  readonly schemaVersion?: number;
  readonly kind?: string;
  readonly suite?: string;
  readonly status?: RuntimeDoctorStatus;
  readonly caseCount?: number;
}

export function qaEvidencePath(cwd = process.cwd()): string {
  return pathJoin(dataDir(cwd), "qa", "scorecard.json");
}

export async function loadRuntimeQaEvidence(cwd = process.cwd(), path = qaEvidencePath(cwd)): Promise<RuntimeQaEvidence> {
  return readJsonFile<RuntimeQaEvidence>(path, {});
}

export async function recordRuntimeQaSuiteEvidence(input: {
  readonly suite: RequiredQaSuiteId;
  readonly status: RuntimeDoctorStatus;
  readonly artifactDir?: string;
  readonly summary?: string;
  readonly evidencePath?: string;
  readonly cwd?: string;
  readonly checkedAt?: string;
}): Promise<{ readonly evidencePath: string; readonly evidence: RuntimeQaEvidence; readonly suite: QaSuiteEvidence }> {
  assertRequiredQaSuite(input.suite);
  const cwd = input.cwd ?? process.cwd();
  const evidencePath = input.evidencePath ?? qaEvidencePath(cwd);
  const suite = normalizeRecordedQaSuite(input.suite, {
    status: input.status,
    artifactDir: input.artifactDir,
    summary: input.summary,
    checkedAt: input.checkedAt ?? new Date().toISOString(),
  });
  const previous = await loadRuntimeQaEvidence(cwd, evidencePath);
  const evidence: RuntimeQaEvidence = {
    ...previous,
    suites: {
      ...(previous.suites ?? {}),
      [input.suite]: suite,
    },
  };
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return { evidencePath, evidence, suite };
}

export function assertRequiredQaSuite(value: string): asserts value is RequiredQaSuiteId {
  if (!(REQUIRED_QA_SUITES as readonly string[]).includes(value)) {
    throw new Error(`Unknown QA suite "${value}". Expected one of: ${REQUIRED_QA_SUITES.join(", ")}`);
  }
}

export async function inspectCodexRuntime(input: {
  readonly command?: string;
  readonly latestVersion?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
} = {}): Promise<CodexRuntimeDoctorReport> {
  const command = resolveCodexCommand(input.command);
  const checks: RuntimeDoctorCheck[] = [];
  const codex = await inspectCodex(command);
  checks.push({
    id: "codex.available",
    status: codex.available ? "passed" : "failed",
    summary: codex.available ? "Codex CLI is installed" : "Codex CLI is not available",
    detail: codex.version,
    fix: codex.available ? undefined : "Install or update Codex, then run `codex login` and `muster doctor codex`.",
  });

  if (!codex.available) {
    return {
      command,
      available: false,
      checks,
      authStatus: "unknown",
      recommendation: "Codex is not usable until the CLI is installed and logged in.",
    };
  }

  const version = cleanVersion(codex.version);
  const stale = version && input.latestVersion && compareVersions(version, input.latestVersion) < 0;
  if (version && input.latestVersion) {
    checks.push({
      id: "codex.version",
      status: stale ? "warning" : "passed",
      summary: stale ? "Codex CLI is behind the latest known package" : "Codex CLI is current enough",
      detail: `installed=${version} latest=${input.latestVersion}`,
      fix: stale ? "Update Codex before judging Muster latency; stale Codex builds can miss app-server and cache fixes." : undefined,
    });
  } else {
    checks.push({
      id: "codex.version",
      status: version ? "unknown" : "warning",
      summary: version ? "Codex version detected; latest version not checked" : "Codex version could not be parsed",
      detail: codex.version,
      fix: version ? "Run with a latest-version check in release QA, or compare against `npm view @openai/codex version`." : "Run `codex --version` manually and update if it is old.",
    });
  }

  checks.push({
    id: "codex.exec",
    status: codex.supportsExec ? "passed" : "failed",
    summary: codex.supportsExec ? "codex exec --json is available" : "codex exec --json is unavailable",
    fix: codex.supportsExec ? undefined : "Update Codex. Muster refuses to fake modern exec behavior with legacy interactive flags.",
  });

  const appServer = await supportsCodexAppServer(command, input.cwd, input.env);
  checks.push({
    id: "codex.app_server",
    status: appServer.ok ? "passed" : "warning",
    summary: appServer.ok ? "Codex app-server command is available" : "Codex app-server is not available",
    detail: appServer.detail,
    fix: appServer.ok ? undefined : "Update Codex and prefer the app-server transport for warm interactive sessions.",
  });

  const auth = await inspectCodexAuth(command, input.cwd, input.env);
  checks.push({
    id: "codex.auth",
    status: auth.status,
    summary: auth.summary,
    detail: auth.detail,
    fix: auth.fix,
  });

  const recommendation =
    appServer.ok && auth.status !== "failed"
      ? "Use warm native Codex/app-server sessions for TUI and fast prompts; investigate provider time before blaming Muster overhead."
      : "Fix Codex auth/app-server health before measuring Muster latency or provider quality.";

  return {
    command,
    available: true,
    version,
    latestVersion: input.latestVersion,
    supportsExec: codex.supportsExec,
    supportsAppServer: appServer.ok,
    authStatus: auth.status,
    authDetail: auth.detail,
    checks,
    recommendation,
  };
}

export function inspectProviderConfig(config: MusterConfig): ProviderDoctorReport[] {
  return Object.values(config.providers).map((provider) => {
    if (provider.kind === "codex-cli") {
      return {
        id: provider.id,
        kind: provider.kind,
        defaultModel: provider.defaultModel,
        status: "passed",
        detail: "uses local Codex auth; verify with `muster doctor codex`",
      };
    }
    if (provider.apiKeyEnv && !process.env[provider.apiKeyEnv]) {
      return {
        id: provider.id,
        kind: provider.kind,
        defaultModel: provider.defaultModel,
        status: "warning",
        detail: `${provider.apiKeyEnv} is not set`,
        fix: `Set ${provider.apiKeyEnv} or choose another provider with /provider.`,
      };
    }
    if (provider.kind === "openai-compatible" && !provider.baseUrl) {
      return {
        id: provider.id,
        kind: provider.kind,
        defaultModel: provider.defaultModel,
        status: "failed",
        detail: "missing baseUrl",
        fix: "Re-add the provider with `muster provider add-openai-compatible <id> <base-url> <model>`.",
      };
    }
    return {
      id: provider.id,
      kind: provider.kind,
      defaultModel: provider.defaultModel,
      status: "passed",
      detail: provider.apiKeyEnv ? `${provider.apiKeyEnv} is set` : "no API key env required",
    };
  });
}

export function buildRuntimeMaturityScorecard(input: {
  readonly config: MusterConfig;
  readonly codex: CodexRuntimeDoctorReport;
  readonly providerReports?: readonly ProviderDoctorReport[];
  readonly evidence?: RuntimeQaEvidence;
}): RuntimeMaturityScorecard {
  const providerReports = input.providerReports ?? inspectProviderConfig(input.config);
  const checks: RuntimeDoctorCheck[] = [...input.codex.checks];
  const ptySuite = input.evidence?.suites?.pty_tui;
  const providerPickerEvidence = qaSuiteHasPassedCase(ptySuite, "provider_model_speed_workflow");
  const mcpAuthEvidence = effectiveQaSuiteStatus("mcp_auth_failure", input.evidence?.suites?.mcp_auth_failure) === "passed";
  const defaultRuntime = input.config.runtimes[input.config.routing.defaultRuntime];
  checks.push({
    id: "runtime.default",
    status: defaultRuntime ? "passed" : "failed",
    summary: defaultRuntime ? `default runtime ${defaultRuntime.id} exists` : "default runtime is missing",
    detail: input.config.routing.defaultRuntime,
    fix: defaultRuntime ? undefined : "Run `muster doctor --fix` or `muster runtime use-provider native codex`.",
  });
  checks.push({
    id: "provider.selection",
    status: providerReports.some((provider) => provider.status === "passed") ? "passed" : "failed",
    summary: `${providerReports.length} provider(s) configured`,
    detail: providerReports.map((provider) => `${provider.id}:${provider.status}`).join(", ") || "none",
    fix: providerReports.length ? undefined : "Run `muster provider presets` and add a provider.",
  });
  checks.push({
    id: "provider.picker_workflow",
    status: providerPickerEvidence ? "passed" : "warning",
    summary: providerPickerEvidence ? "provider/model/speed picker workflow has artifact-backed evidence" : "provider/model picker needs artifact-backed workflow evidence",
    detail: providerPickerEvidence
      ? "PTY/TUI evidence covers provider -> model -> speed selection, selected markers, and stable overlay behavior"
      : "Do not count picker wiring as complete until PTY/TUI artifacts include provider_model_speed_workflow.",
    fix: providerPickerEvidence ? undefined : "Run `muster qa run pty_tui` after adding a provider/model/speed workflow case.",
  });
  checks.push({
    id: "mcp.auth_workflow",
    status: mcpAuthEvidence ? "passed" : Object.keys(input.config.tools?.mcp?.servers ?? {}).length ? "warning" : "failed",
    summary: `${Object.keys(input.config.tools?.mcp?.servers ?? {}).length} MCP server(s) configured`,
    detail: mcpAuthEvidence
      ? "MCP auth workflow evidence is present"
      : "OAuth/status flows must be tested with bad creds, no-browser, and transient network failures",
    fix: mcpAuthEvidence ? undefined : "Add `muster mcp login/logout/status` verification cases and Frappe-2 auth failure regressions.",
  });
  checks.push({
    id: "qa.hostile_suite",
    status: allRequiredQaSuitesPassed(input.evidence?.suites) ? "passed" : "warning",
    summary: allRequiredQaSuitesPassed(input.evidence?.suites) ? "hostile QA artifacts are present" : "hostile QA evidence is incomplete",
    detail: summarizeQaSuiteEvidence(input.evidence?.suites),
    fix: allRequiredQaSuitesPassed(input.evidence?.suites) ? undefined : "Run every required QA suite and store evidence before release claims.",
  });
  for (const suiteId of REQUIRED_QA_SUITES) {
    const suite = input.evidence?.suites?.[suiteId];
    const status = effectiveQaSuiteStatus(suiteId, suite) ?? "unknown";
    checks.push({
      id: `qa.${suiteId}`,
      status,
      summary: effectiveQaSuiteSummary(suiteId, suite),
      detail: suite?.artifactDir ? `artifact=${suite.artifactDir}${suite.checkedAt ? ` checked_at=${suite.checkedAt}` : ""}` : suite?.checkedAt,
      fix: status === "passed" ? undefined : qaSuiteFix(suiteId),
    });
  }
  const summary = summarizeChecks(checks);
  const status: RuntimeDoctorStatus = summary.failed > 0 ? "failed" : summary.warning > 0 || summary.unknown > 0 ? "warning" : "passed";
  return { status, checks, summary };
}

export function validateStrictReleaseEvidence(evidence?: RuntimeQaEvidence): StrictReleaseValidation {
  const checks: RuntimeDoctorCheck[] = [];
  for (const suiteId of REQUIRED_QA_SUITES) {
    const suite = evidence?.suites?.[suiteId];
    const baseStatus = effectiveQaSuiteStatus(suiteId, suite);
    const artifactDir = suite?.artifactDir;
    if (!suite) {
      checks.push({
        id: `strict.${suiteId}`,
        status: "failed",
        summary: "required QA suite has no recorded evidence",
        fix: qaSuiteFix(suiteId),
      });
      continue;
    }
    if (baseStatus !== "passed") {
      checks.push({
        id: `strict.${suiteId}`,
        status: "failed",
        summary: `required QA suite is ${baseStatus ?? "missing"}, not passed`,
        detail: suite.summary,
        fix: qaSuiteFix(suiteId),
      });
      continue;
    }
    if (!artifactDir) {
      checks.push({
        id: `strict.${suiteId}`,
        status: "failed",
        summary: "passed QA suite has no artifact directory",
        fix: qaSuiteFix(suiteId),
      });
      continue;
    }
    const validation = validatePassedQaArtifact(suiteId, artifactDir);
    if (validation) {
      checks.push({
        id: `strict.${suiteId}`,
        status: "failed",
        summary: validation,
        detail: `artifact=${artifactDir}`,
        fix: qaSuiteFix(suiteId),
      });
      continue;
    }
    const cases = readQaArtifactCases(pathJoin(artifactDir, "cases.jsonl"));
    const passedCases = new Set(cases.filter((entry) => entry.status === "passed").map((entry) => entry.id).filter(Boolean));
    const missing = REQUIRED_QA_CASES[suiteId].filter((caseId) => !passedCases.has(caseId));
    checks.push({
      id: `strict.${suiteId}`,
      status: missing.length ? "failed" : "passed",
      summary: missing.length ? `missing required passed case(s): ${missing.join(", ")}` : "required release cases passed",
      detail: `artifact=${artifactDir} cases=${cases.length}`,
      fix: missing.length ? qaSuiteFix(suiteId) : undefined,
    });
  }
  const summary = summarizeChecks(checks);
  return {
    status: summary.failed > 0 ? "failed" : summary.warning > 0 || summary.unknown > 0 ? "warning" : "passed",
    checks,
    summary,
  };
}

export function renderStrictReleaseValidation(validation: StrictReleaseValidation): string {
  const lines = [
    `strict_release status=${validation.status} passed=${validation.summary.passed} warning=${validation.summary.warning} failed=${validation.summary.failed} unknown=${validation.summary.unknown}`,
  ];
  for (const check of validation.checks) {
    lines.push(`${check.status.padEnd(7)} ${check.id.padEnd(36)} ${check.summary}${check.detail ? ` (${check.detail})` : ""}`);
    if (check.fix && check.status !== "passed") lines.push(`fix     ${check.id.padEnd(36)} ${check.fix}`);
  }
  return lines.join("\n");
}

function allRequiredQaSuitesPassed(suites: RuntimeQaEvidence["suites"]): boolean {
  return REQUIRED_QA_SUITES.every((suiteId) => effectiveQaSuiteStatus(suiteId, suites?.[suiteId]) === "passed");
}

function summarizeQaSuiteEvidence(suites: RuntimeQaEvidence["suites"]): string {
  return REQUIRED_QA_SUITES.map((suiteId) => `${suiteId}:${effectiveQaSuiteStatus(suiteId, suites?.[suiteId]) ?? "missing"}`).join(", ");
}

function qaSuiteFix(suiteId: RequiredQaSuiteId): string {
  switch (suiteId) {
    case "pty_tui":
      return "Run PTY/TUI interaction tests and record terminal-state artifacts.";
    case "provider_latency":
      return "Run provider latency tests that split provider time from Muster overhead.";
    case "mcp_auth_failure":
      return "Run MCP auth failure tests for missing, expired, invalid, no-browser, and retry paths.";
    case "memory_retrieval_speed":
      return "Run memory retrieval speed tests across scoped small/medium/large stores.";
    case "channel_plugin_setup":
      return "Run channel/plugin setup tests for missing credentials, enable/disable, and recovery UX.";
    case "frappe2_real_prompts":
      return "Run Frappe-2 real prompt regression tests against the globally installed Muster build.";
    case "pack_readiness":
      return "Run pack-readiness QA to prove capability manifests, readiness levels, eval paths, and release-ready claims are honest.";
  }
}

function normalizeRecordedQaSuite(suiteId: RequiredQaSuiteId, suite: QaSuiteEvidence): QaSuiteEvidence {
  const status = suite.status;
  if (!["passed", "warning", "failed", "unknown"].includes(status)) {
    throw new Error(`Invalid status for ${suiteId}: ${status}`);
  }
  if (status === "passed" && !suite.artifactDir) {
    throw new Error(`QA suite ${suiteId} cannot be recorded as passed without --artifact-dir.`);
  }
  if (status === "passed" && suite.artifactDir && !existsSync(suite.artifactDir)) {
    throw new Error(`QA suite ${suiteId} artifact directory does not exist: ${suite.artifactDir}`);
  }
  if (status === "passed" && suite.artifactDir) {
    const validation = validatePassedQaArtifact(suiteId, suite.artifactDir);
    if (validation) throw new Error(validation);
  }
  const summary = suite.summary?.trim() || defaultQaSuiteSummary(suiteId, status);
  return {
    status,
    artifactDir: suite.artifactDir,
    summary,
    checkedAt: suite.checkedAt,
  };
}

function effectiveQaSuiteStatus(suiteId: RequiredQaSuiteId, suite: QaSuiteEvidence | undefined): RuntimeDoctorStatus | undefined {
  if (!suite) return undefined;
  if (suite.status === "passed" && (!suite.artifactDir || !existsSync(suite.artifactDir))) return "warning";
  if (suite.status === "passed") {
    if (validatePassedQaArtifact(suiteId, suite.artifactDir ?? "")) return "warning";
  }
  return suite.status;
}

function effectiveQaSuiteSummary(suiteId: RequiredQaSuiteId, suite: QaSuiteEvidence | undefined): string {
  if (!suite) return "required QA suite has no recorded evidence";
  if (suite.status === "passed" && !suite.artifactDir) return "claimed passed but no artifact directory was recorded";
  if (suite.status === "passed" && suite.artifactDir && !existsSync(suite.artifactDir)) return "claimed passed but artifact directory is missing";
  if (suite.status === "passed" && suite.artifactDir) {
    const validation = validatePassedQaArtifact(suiteId, suite.artifactDir);
    if (validation) return validation.replace(`QA suite ${suiteId} cannot be recorded as passed without `, "claimed passed but ");
  }
  return suite.summary ?? defaultQaSuiteSummary(suiteId, suite.status);
}

function validatePassedQaArtifact(suiteId: RequiredQaSuiteId, artifactDir: string): string | undefined {
  const manifest = readQaArtifactManifest(artifactDir);
  if (!manifest) return `QA suite ${suiteId} cannot be recorded as passed without artifact manifest.json.`;
  if (manifest.suite !== suiteId) return `QA suite ${suiteId} artifact manifest belongs to ${manifest.suite ?? "unknown"}.`;
  if (manifest.status !== "passed") return `QA suite ${suiteId} artifact manifest status is ${manifest.status ?? "unknown"}, not passed.`;
  const caseCount = Number(manifest.caseCount ?? 0);
  if (!Number.isFinite(caseCount) || caseCount <= 0) return `QA suite ${suiteId} artifact manifest has no recorded cases.`;
  const casesPath = pathJoin(artifactDir, "cases.jsonl");
  if (!existsSync(casesPath)) return `QA suite ${suiteId} artifact cases.jsonl is missing.`;
  const cases = readQaArtifactCases(casesPath);
  if (!cases.length) return `QA suite ${suiteId} artifact cases.jsonl is empty or invalid.`;
  if (cases.length < caseCount) return `QA suite ${suiteId} artifact cases.jsonl has ${cases.length} case(s), expected at least ${caseCount}.`;
  const failed = cases.find((entry) => entry.status !== "passed");
  if (failed) return `QA suite ${suiteId} artifact case ${failed.id ?? "unknown"} is ${failed.status ?? "unknown"}, not passed.`;
  return undefined;
}

function readQaArtifactManifest(artifactDir: string): QaArtifactManifest | undefined {
  const path = pathJoin(artifactDir, "manifest.json");
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as QaArtifactManifest;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function qaSuiteHasPassedCase(suite: QaSuiteEvidence | undefined, caseId: string): boolean {
  if (effectiveQaSuiteStatus("pty_tui", suite) !== "passed" || !suite?.artifactDir) return false;
  const casesPath = pathJoin(suite.artifactDir, "cases.jsonl");
  if (!existsSync(casesPath)) return false;
  return readQaArtifactCases(casesPath).some((entry) => entry.id === caseId && entry.status === "passed");
}

function readQaArtifactCases(path: string): Array<{ id?: string; status?: string }> {
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id?: string; status?: string })
      .filter((entry) => entry && typeof entry === "object");
  } catch {
    return [];
  }
}

function defaultQaSuiteSummary(suiteId: RequiredQaSuiteId, status: RuntimeDoctorStatus): string {
  if (status === "passed") return `${suiteId} evidence passed`;
  if (status === "failed") return `${suiteId} evidence failed`;
  if (status === "warning") return `${suiteId} evidence needs review`;
  return `${suiteId} evidence is unknown`;
}

export function renderRuntimeMaturityScorecard(scorecard: RuntimeMaturityScorecard): string {
  const lines = [
    `qa_scorecard status=${scorecard.status} passed=${scorecard.summary.passed} warning=${scorecard.summary.warning} failed=${scorecard.summary.failed} unknown=${scorecard.summary.unknown}`,
  ];
  for (const check of scorecard.checks) {
    lines.push(`${check.status.padEnd(7)} ${check.id.padEnd(24)} ${check.summary}${check.detail ? ` (${check.detail})` : ""}`);
    if (check.fix && check.status !== "passed") lines.push(`fix     ${check.id.padEnd(24)} ${check.fix}`);
  }
  return lines.join("\n");
}

function summarizeChecks(checks: readonly RuntimeDoctorCheck[]): RuntimeMaturityScorecard["summary"] {
  return {
    passed: checks.filter((check) => check.status === "passed").length,
    warning: checks.filter((check) => check.status === "warning").length,
    failed: checks.filter((check) => check.status === "failed").length,
    unknown: checks.filter((check) => check.status === "unknown").length,
  };
}

async function supportsCodexAppServer(command: string, cwd = process.cwd(), env?: NodeJS.ProcessEnv): Promise<{ ok: boolean; detail?: string }> {
  try {
    const result = await execFileAsync(command, ["app-server", "--help"], { cwd, env: { ...process.env, ...(env ?? {}) }, timeout: 5000 });
    return { ok: true, detail: firstLine(result.stdout || result.stderr) };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function inspectCodexAuth(command: string, cwd = process.cwd(), env?: NodeJS.ProcessEnv): Promise<{
  status: RuntimeDoctorStatus;
  summary: string;
  detail?: string;
  fix?: string;
}> {
  try {
    const result = await execFileAsync(command, ["login", "status"], { cwd, env: { ...process.env, ...(env ?? {}) }, timeout: 5000 });
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (/not\s+logged\s+in|unauthenticated|expired|no\s+auth/i.test(output)) {
      return { status: "failed", summary: "Codex auth is not healthy", detail: firstLine(output), fix: "Run `codex login`, then rerun `muster doctor codex`." };
    }
    return { status: "passed", summary: "Codex auth status command succeeded", detail: firstLine(output) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      status: "unknown",
      summary: "Codex auth status could not be verified",
      detail,
      fix: "Run `codex login status` or `codex login`; some Codex builds do not expose a status subcommand.",
    };
  }
}

function firstLine(value: string | undefined): string | undefined {
  return value?.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

function resolveCodexCommand(command?: string): string {
  if (command) return command;
  if (process.env.MUSTER_CODEX_COMMAND) return process.env.MUSTER_CODEX_COMMAND;
  const appBundle = "/Applications/Codex.app/Contents/Resources/codex";
  if (existsSync(appBundle)) return appBundle;
  const home = process.env.HOME;
  if (home) {
    const candidates = [
      pathJoin(home, ".nvm/versions/node/v24.17.0/bin/codex"),
      pathJoin(home, ".nvm/versions/node/v22.22.3/bin/codex"),
      pathJoin(home, ".nvm/versions/node/v22.15.1/bin/codex"),
      pathJoin(home, ".nvm/versions/node/v20.19.5/bin/codex"),
      pathJoin(home, ".local/bin/codex"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return "codex";
}

function cleanVersion(version: string | undefined): string | undefined {
  return version?.match(/\d+\.\d+\.\d+(?:[-+][^\s]+)?/)?.[0];
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(/[.-]/).map((part) => Number.parseInt(part, 10));
  const rightParts = right.split(/[.-]/).map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const a = Number.isFinite(leftParts[index]) ? leftParts[index]! : 0;
    const b = Number.isFinite(rightParts[index]) ? rightParts[index]! : 0;
    if (a !== b) return a > b ? 1 : -1;
  }
  return 0;
}
