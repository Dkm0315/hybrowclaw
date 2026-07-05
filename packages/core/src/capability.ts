import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { FlowToolRegistry } from "./flow.js";

export type CapabilityPackKind = "tool" | "skill" | "agent" | "workflow" | "channel";
export type CapabilityPermission = "filesystem:read" | "filesystem:write" | "network" | "shell" | "browser" | "secrets" | "messages" | "git";
export type CapabilitySandbox = "none" | "read_only" | "workspace_write" | "network_limited" | "full_trust";
export type CapabilityReadinessLevel =
  | "listed"
  | "setup_plan"
  | "installable"
  | "executable"
  | "verified"
  | "release_ready";
export type CapabilityReadinessStatus = "stable" | "beta" | "experimental" | "blocked";
export type CapabilityActionability =
  | "metadata"
  | "setup_plan"
  | "local_tool"
  | "runtime_adapter"
  | "mcp_installable"
  | "end_to_end_workflow";
export type CapabilityReadinessSurface = "cli" | "tui" | "gateway" | "web" | "channel" | "frappe";
export type CapabilityCredentialStorage = "env" | "muster-secret-ref" | "external-vault" | "none";
export type CapabilityPermissionMode = "deny_by_default" | "ask" | "allow_when_scoped";
export type CapabilityMutationApproval = "never" | "required" | "policy";
export type CapabilitySafetyRisk = "low" | "medium" | "high";

const PACK_TOOL_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/;

export interface CapabilityReadinessSetup {
  readonly urls: readonly string[];
  readonly requiredEnv: readonly string[];
  readonly requiredAnyEnv: readonly (readonly string[])[];
  readonly credentialStorage: CapabilityCredentialStorage;
}

export interface CapabilityReadinessDiagnostics {
  readonly doctorCommand?: string;
  readonly smokeCommand?: string;
  readonly latencyBudgetMs?: number;
  readonly requiresLiveCredentials: boolean;
}

export interface CapabilityReadinessSafety {
  readonly risk: CapabilitySafetyRisk;
  readonly permissionMode: CapabilityPermissionMode;
  readonly mutationApproval: CapabilityMutationApproval;
  readonly resultCapBytes: number;
  readonly secretRedaction: true;
}

export interface CapabilityReadinessEvidence {
  readonly unitTests: readonly string[];
  readonly qaSuites: readonly string[];
  readonly liveArtifacts: readonly string[];
  readonly docs: readonly string[];
}

export interface CapabilityReadiness {
  readonly level: CapabilityReadinessLevel;
  readonly status: CapabilityReadinessStatus;
  readonly actionability: CapabilityActionability;
  readonly owner: string;
  readonly surfaces: readonly CapabilityReadinessSurface[];
  readonly setup: CapabilityReadinessSetup;
  readonly diagnostics: CapabilityReadinessDiagnostics;
  readonly safety: CapabilityReadinessSafety;
  readonly evidence: CapabilityReadinessEvidence;
}

export interface CapabilityPackManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly kind: CapabilityPackKind;
  /** Optional exclusive plugin slot, e.g. "memory", "channel", "browser". */
  readonly slot?: string;
  readonly entrypoint: string;
  readonly description?: string;
  readonly permissions: CapabilityPermission[];
  readonly sandbox: CapabilitySandbox;
  readonly secrets?: string[];
  readonly evals?: string[];
  readonly implementedTools?: string[];
  readonly digest?: string;
  readonly readiness?: CapabilityReadiness;
}

export interface CapabilityPackInspection {
  readonly path: string;
  readonly manifest?: CapabilityPackManifest;
  readonly status: "ready" | "blocked";
  readonly risk: "low" | "medium" | "high";
  readonly blockers: string[];
  readonly warnings: string[];
}

export interface CapabilityPluginEntry {
  readonly enabled?: boolean;
  readonly config?: Readonly<Record<string, string>>;
}

export interface CapabilityPluginLoadPolicy {
  readonly paths?: readonly string[];
}

export interface CapabilityPluginPolicy {
  /**
   * Non-empty allowlist: only these pack ids may load. Empty/undefined means no
   * allowlist gate. `deny` always wins over `allow`.
   */
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
  /** Exclusive slot owner map, e.g. { "memory": "memory-core" }. */
  readonly slots?: Readonly<Record<string, string>>;
  readonly load?: CapabilityPluginLoadPolicy;
  readonly entries?: Readonly<Record<string, CapabilityPluginEntry>>;
}

export async function inspectCapabilityPack(path: string): Promise<CapabilityPackInspection> {
  // Canonical manifest name first; "manifest.json" is accepted as a fallback
  // (capability-packs/* in this repo use it).
  let raw: string;
  try {
    raw = await readFile(join(path, "muster.capability.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    raw = await readFile(join(path, "manifest.json"), "utf8");
  }
  const parsed = JSON.parse(raw) as unknown;
  const inspection = inspectCapabilityManifest(path, parsed);
  if (inspection.status === "blocked" || !inspection.manifest?.digest) return inspection;

  const digestBlocker = await verifyEntrypointDigest(path, inspection.manifest);
  if (!digestBlocker) return inspection;
  return {
    ...inspection,
    manifest: undefined,
    status: "blocked",
    risk: "high",
    blockers: [...inspection.blockers, digestBlocker],
  };
}

export async function computeCapabilityEntrypointDigest(path: string, manifest: Pick<CapabilityPackManifest, "entrypoint">): Promise<string> {
  const entrypoint = isAbsolute(manifest.entrypoint) ? manifest.entrypoint : join(path, manifest.entrypoint);
  const raw = await readFile(entrypoint);
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

export function inspectCapabilityManifest(path: string, value: unknown): CapabilityPackInspection {
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(value)) {
    return { path, status: "blocked", risk: "high", blockers: ["Manifest must be a JSON object."], warnings };
  }

  if (value.schemaVersion !== 1) blockers.push("schemaVersion must be 1.");
  if (!isSafeId(value.id)) blockers.push("id must be lowercase kebab-case, 3-80 chars.");
  if (!isNonEmpty(value.name)) blockers.push("name is required.");
  if (!isSemverLike(value.version)) blockers.push("version must be semver-like.");
  if (!isKind(value.kind)) blockers.push("kind is invalid.");
  if (value.slot !== undefined && !isPluginSlot(value.slot)) blockers.push("slot must be lowercase kebab-case, 2-64 chars.");
  if (!isNonEmpty(value.entrypoint)) blockers.push("entrypoint is required.");
  if (!Array.isArray(value.permissions) || !value.permissions.every(isPermission)) blockers.push("permissions must be valid permission strings.");
  if (!isSandbox(value.sandbox)) blockers.push("sandbox is invalid.");
  if (Array.isArray(value.secrets) && !value.secrets.every(isEnvName)) blockers.push("secrets must be environment variable names.");
  if (Array.isArray(value.evals) && !value.evals.every(isNonEmpty)) blockers.push("evals must be non-empty paths.");
  if (value.implementedTools !== undefined && (!Array.isArray(value.implementedTools) || !value.implementedTools.every(isPackToolName))) {
    blockers.push("implementedTools must be tool export names.");
  }
  const readiness = value.readiness === undefined ? undefined : inspectReadiness(value.readiness, blockers);

  const permissions = Array.isArray(value.permissions) ? value.permissions.filter(isPermission) : [];
  const sandbox = isSandbox(value.sandbox) ? value.sandbox : "none";
  if (permissions.includes("secrets") && (!Array.isArray(value.secrets) || !value.secrets.length)) {
    blockers.push("secrets permission requires declared secret environment variables.");
  }
  if (permissions.includes("shell") && sandbox !== "workspace_write" && sandbox !== "full_trust") {
    blockers.push("shell permission requires workspace_write or full_trust sandbox.");
  }
  if (sandbox === "full_trust") warnings.push("full_trust capability must be reviewed before enabling.");
  if (!Array.isArray(value.evals) || !value.evals.length) warnings.push("No eval fixtures declared.");
  if (!isNonEmpty(value.digest)) warnings.push("No signed digest declared.");

  const manifest = blockers.length
    ? undefined
    : ({
        schemaVersion: 1,
        id: value.id as string,
        name: value.name as string,
        version: value.version as string,
        kind: value.kind as CapabilityPackKind,
        slot: typeof value.slot === "string" ? value.slot : undefined,
        entrypoint: value.entrypoint as string,
        description: typeof value.description === "string" ? value.description : undefined,
        permissions,
        sandbox,
        secrets: Array.isArray(value.secrets) ? value.secrets.filter(isEnvName) : undefined,
        evals: Array.isArray(value.evals) ? value.evals.filter(isNonEmpty) : undefined,
        implementedTools: Array.isArray(value.implementedTools) ? value.implementedTools.filter(isPackToolName) : undefined,
        digest: typeof value.digest === "string" ? value.digest : undefined,
        readiness
      } satisfies CapabilityPackManifest);

  return {
    path,
    manifest,
    status: blockers.length ? "blocked" : "ready",
    risk: riskFor(permissions, sandbox, blockers),
    blockers,
    warnings
  };
}

function riskFor(permissions: CapabilityPermission[], sandbox: CapabilitySandbox, blockers: string[]): CapabilityPackInspection["risk"] {
  if (blockers.length || sandbox === "full_trust" || permissions.includes("secrets") || permissions.includes("shell")) return "high";
  if (permissions.includes("filesystem:write") || permissions.includes("network") || sandbox === "workspace_write") return "medium";
  return "low";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{2,79}$/.test(value);
}

function isPluginSlot(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{1,63}$/.test(value);
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPackToolName(value: unknown): value is string {
  return typeof value === "string" && PACK_TOOL_NAME_PATTERN.test(value);
}

function isSemverLike(value: unknown): value is string {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(value);
}

function isKind(value: unknown): value is CapabilityPackKind {
  return value === "tool" || value === "skill" || value === "agent" || value === "workflow" || value === "channel";
}

function isPermission(value: unknown): value is CapabilityPermission {
  return (
    value === "filesystem:read" ||
    value === "filesystem:write" ||
    value === "network" ||
    value === "shell" ||
    value === "browser" ||
    value === "secrets" ||
    value === "messages" ||
    value === "git"
  );
}

function isSandbox(value: unknown): value is CapabilitySandbox {
  return value === "none" || value === "read_only" || value === "workspace_write" || value === "network_limited" || value === "full_trust";
}

function isEnvName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z_][A-Z0-9_]*$/.test(value);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isReadinessLevel(value: unknown): value is CapabilityReadinessLevel {
  return (
    value === "listed" ||
    value === "setup_plan" ||
    value === "installable" ||
    value === "executable" ||
    value === "verified" ||
    value === "release_ready"
  );
}

function isReadinessStatus(value: unknown): value is CapabilityReadinessStatus {
  return value === "stable" || value === "beta" || value === "experimental" || value === "blocked";
}

function isActionability(value: unknown): value is CapabilityActionability {
  return (
    value === "metadata" ||
    value === "setup_plan" ||
    value === "local_tool" ||
    value === "runtime_adapter" ||
    value === "mcp_installable" ||
    value === "end_to_end_workflow"
  );
}

function isReadinessSurface(value: unknown): value is CapabilityReadinessSurface {
  return value === "cli" || value === "tui" || value === "gateway" || value === "web" || value === "channel" || value === "frappe";
}

function isCredentialStorage(value: unknown): value is CapabilityCredentialStorage {
  return value === "env" || value === "muster-secret-ref" || value === "external-vault" || value === "none";
}

function isPermissionMode(value: unknown): value is CapabilityPermissionMode {
  return value === "deny_by_default" || value === "ask" || value === "allow_when_scoped";
}

function isMutationApproval(value: unknown): value is CapabilityMutationApproval {
  return value === "never" || value === "required" || value === "policy";
}

function isSafetyRisk(value: unknown): value is CapabilitySafetyRisk {
  return value === "low" || value === "medium" || value === "high";
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmpty);
}

function inspectReadiness(value: unknown, blockers: string[]): CapabilityReadiness | undefined {
  if (!isRecord(value)) {
    blockers.push("readiness must be an object.");
    return undefined;
  }

  if (!isReadinessLevel(value.level)) blockers.push("readiness.level is invalid.");
  if (!isReadinessStatus(value.status)) blockers.push("readiness.status is invalid.");
  if (!isActionability(value.actionability)) blockers.push("readiness.actionability is invalid.");
  if (!isNonEmpty(value.owner)) blockers.push("readiness.owner is required.");
  if (!Array.isArray(value.surfaces) || !value.surfaces.every(isReadinessSurface)) {
    blockers.push("readiness.surfaces must be valid surface names.");
  }

  const setup = inspectReadinessSetup(value.setup, blockers);
  const diagnostics = inspectReadinessDiagnostics(value.diagnostics, blockers);
  const safety = inspectReadinessSafety(value.safety, blockers);
  const evidence = inspectReadinessEvidence(value.evidence, blockers);

  if (
    !isReadinessLevel(value.level) ||
    !isReadinessStatus(value.status) ||
    !isActionability(value.actionability) ||
    !isNonEmpty(value.owner) ||
    !Array.isArray(value.surfaces) ||
    !value.surfaces.every(isReadinessSurface) ||
    !setup ||
    !diagnostics ||
    !safety ||
    !evidence
  ) {
    return undefined;
  }

  return {
    level: value.level,
    status: value.status,
    actionability: value.actionability,
    owner: value.owner,
    surfaces: value.surfaces,
    setup,
    diagnostics,
    safety,
    evidence
  };
}

function inspectReadinessSetup(value: unknown, blockers: string[]): CapabilityReadinessSetup | undefined {
  if (!isRecord(value)) {
    blockers.push("readiness.setup must be an object.");
    return undefined;
  }

  if (!isNonEmptyStringArray(value.urls)) blockers.push("readiness.setup.urls must be non-empty strings.");
  if (!Array.isArray(value.requiredEnv) || !value.requiredEnv.every(isEnvName)) {
    blockers.push("readiness.setup.requiredEnv must be environment variable names.");
  }
  if (
    !Array.isArray(value.requiredAnyEnv) ||
    !value.requiredAnyEnv.every((group) => Array.isArray(group) && group.every(isEnvName))
  ) {
    blockers.push("readiness.setup.requiredAnyEnv must be arrays of environment variable names.");
  }
  if (!isCredentialStorage(value.credentialStorage)) blockers.push("readiness.setup.credentialStorage is invalid.");

  if (
    !isNonEmptyStringArray(value.urls) ||
    !Array.isArray(value.requiredEnv) ||
    !value.requiredEnv.every(isEnvName) ||
    !Array.isArray(value.requiredAnyEnv) ||
    !value.requiredAnyEnv.every((group) => Array.isArray(group) && group.every(isEnvName)) ||
    !isCredentialStorage(value.credentialStorage)
  ) {
    return undefined;
  }

  return {
    urls: value.urls,
    requiredEnv: value.requiredEnv,
    requiredAnyEnv: value.requiredAnyEnv,
    credentialStorage: value.credentialStorage
  };
}

function inspectReadinessDiagnostics(value: unknown, blockers: string[]): CapabilityReadinessDiagnostics | undefined {
  if (!isRecord(value)) {
    blockers.push("readiness.diagnostics must be an object.");
    return undefined;
  }

  if (value.doctorCommand !== undefined && !isNonEmpty(value.doctorCommand)) {
    blockers.push("readiness.diagnostics.doctorCommand must be a non-empty string.");
  }
  if (value.smokeCommand !== undefined && !isNonEmpty(value.smokeCommand)) {
    blockers.push("readiness.diagnostics.smokeCommand must be a non-empty string.");
  }
  if (value.latencyBudgetMs !== undefined && !isPositiveFiniteNumber(value.latencyBudgetMs)) {
    blockers.push("readiness.diagnostics.latencyBudgetMs must be a positive finite number.");
  }
  if (typeof value.requiresLiveCredentials !== "boolean") {
    blockers.push("readiness.diagnostics.requiresLiveCredentials must be a boolean.");
  }

  if (
    (value.doctorCommand !== undefined && !isNonEmpty(value.doctorCommand)) ||
    (value.smokeCommand !== undefined && !isNonEmpty(value.smokeCommand)) ||
    (value.latencyBudgetMs !== undefined && !isPositiveFiniteNumber(value.latencyBudgetMs)) ||
    typeof value.requiresLiveCredentials !== "boolean"
  ) {
    return undefined;
  }

  return {
    doctorCommand: typeof value.doctorCommand === "string" ? value.doctorCommand : undefined,
    smokeCommand: typeof value.smokeCommand === "string" ? value.smokeCommand : undefined,
    latencyBudgetMs: typeof value.latencyBudgetMs === "number" ? value.latencyBudgetMs : undefined,
    requiresLiveCredentials: value.requiresLiveCredentials
  };
}

function inspectReadinessSafety(value: unknown, blockers: string[]): CapabilityReadinessSafety | undefined {
  if (!isRecord(value)) {
    blockers.push("readiness.safety must be an object.");
    return undefined;
  }

  if (!isSafetyRisk(value.risk)) blockers.push("readiness.safety.risk is invalid.");
  if (!isPermissionMode(value.permissionMode)) blockers.push("readiness.safety.permissionMode is invalid.");
  if (!isMutationApproval(value.mutationApproval)) blockers.push("readiness.safety.mutationApproval is invalid.");
  if (!isPositiveFiniteNumber(value.resultCapBytes)) {
    blockers.push("readiness.safety.resultCapBytes must be a positive finite number.");
  }
  if (value.secretRedaction !== true) blockers.push("readiness.safety.secretRedaction must be true.");

  if (
    !isSafetyRisk(value.risk) ||
    !isPermissionMode(value.permissionMode) ||
    !isMutationApproval(value.mutationApproval) ||
    !isPositiveFiniteNumber(value.resultCapBytes) ||
    value.secretRedaction !== true
  ) {
    return undefined;
  }

  return {
    risk: value.risk,
    permissionMode: value.permissionMode,
    mutationApproval: value.mutationApproval,
    resultCapBytes: value.resultCapBytes,
    secretRedaction: true
  };
}

function inspectReadinessEvidence(value: unknown, blockers: string[]): CapabilityReadinessEvidence | undefined {
  if (!isRecord(value)) {
    blockers.push("readiness.evidence must be an object.");
    return undefined;
  }

  if (!isNonEmptyStringArray(value.unitTests)) blockers.push("readiness.evidence.unitTests must be non-empty strings.");
  if (!isNonEmptyStringArray(value.qaSuites)) blockers.push("readiness.evidence.qaSuites must be non-empty strings.");
  if (!isNonEmptyStringArray(value.liveArtifacts)) blockers.push("readiness.evidence.liveArtifacts must be non-empty strings.");
  if (!isNonEmptyStringArray(value.docs)) blockers.push("readiness.evidence.docs must be non-empty strings.");

  if (
    !isNonEmptyStringArray(value.unitTests) ||
    !isNonEmptyStringArray(value.qaSuites) ||
    !isNonEmptyStringArray(value.liveArtifacts) ||
    !isNonEmptyStringArray(value.docs)
  ) {
    return undefined;
  }

  return {
    unitTests: value.unitTests,
    qaSuites: value.qaSuites,
    liveArtifacts: value.liveArtifacts,
    docs: value.docs
  };
}

async function verifyEntrypointDigest(path: string, manifest: CapabilityPackManifest): Promise<string | undefined> {
  const match = /^sha256:([a-f0-9]{64})$/i.exec(manifest.digest ?? "");
  if (!match) return `Capability digest must be sha256:<64 hex chars>; got ${JSON.stringify(manifest.digest)}.`;
  let actual: string;
  try {
    actual = await computeCapabilityEntrypointDigest(path, manifest);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const entrypoint = isAbsolute(manifest.entrypoint) ? manifest.entrypoint : join(path, manifest.entrypoint);
    return `Capability digest could not read entrypoint ${entrypoint}: ${detail}`;
  }
  const expected = match[1].toLowerCase();
  if (actual !== `sha256:${expected}`) return `Capability digest mismatch for ${manifest.entrypoint}: expected sha256:${expected}, got ${actual}.`;
  return undefined;
}

// --- capability-pack loader (HC-012) ---

/**
 * Execution context handed to every pack tool. Packs receive capabilities
 * explicitly through this object instead of reaching for ambient globals:
 * `fetch` is present only when the manifest declares the `network`
 * permission, and `config` exposes only the env vars declared in
 * `manifest.secrets`.
 *
 * v1 enforcement is CONTRACTUAL, not a sandbox: a malicious pack could still
 * import `node:http` or read `process.env` directly. The contract makes
 * well-behaved packs reviewable and testable; process-level sandboxing is a
 * later slice.
 */
export interface CapabilityToolContext {
  readonly fetch?: typeof globalThis.fetch;
  readonly config: Readonly<Record<string, string | undefined>>;
}

export type CapabilityPackTool = (args: Record<string, unknown>, context: CapabilityToolContext) => Promise<unknown>;

export interface LoadedCapabilityPack {
  readonly manifest: CapabilityPackManifest;
  /** Namespaced tool names registered into the flow registry: `<packId>__<tool>`. */
  readonly toolNames: readonly string[];
  readonly warnings: readonly string[];
}

export interface LoadCapabilityPackOptions {
  /** Flow tool registry the pack tools are registered into. */
  readonly registry: FlowToolRegistry;
  /** High-risk packs (secrets/shell/full_trust) refuse to load without this. */
  readonly allowHighRisk?: boolean;
  /** Optional OpenClaw-style plugin policy, enforced before dynamic import. */
  readonly pluginPolicy?: CapabilityPluginPolicy;
  /** Mutable slot owner table shared across multiple pack loads in one process. */
  readonly slotClaims?: Record<string, string>;
  /** Env source for `manifest.secrets`; defaults to process.env (injectable for tests). */
  readonly env?: Record<string, string | undefined>;
}

/**
 * Validates the pack manifest (inspectCapabilityPack), refuses invalid or
 * high-risk-without-flag packs, dynamically imports the entrypoint module
 * (must export `tools: Record<string, (args, context) => Promise<unknown>>`),
 * and registers each tool into the flow registry as `<packId>__<tool>` with a
 * frozen, permission-scoped context bound in.
 *
 * The entrypoint must be importable by the current runtime: plain JS always
 * works; TS entrypoints work when running under tsx (tests, `pnpm hc`).
 */
export async function loadCapabilityPack(dir: string, options: LoadCapabilityPackOptions): Promise<LoadedCapabilityPack> {
  const inspection = await inspectCapabilityPack(dir);
  if (inspection.status === "blocked" || !inspection.manifest) {
    throw new Error(`Capability pack at ${dir} is blocked:\n${inspection.blockers.map((blocker) => `- ${blocker}`).join("\n")}`);
  }
  if (inspection.risk === "high" && !options.allowHighRisk) {
    throw new Error(
      `Capability pack "${inspection.manifest.id}" is high-risk (permissions: ${inspection.manifest.permissions.join(", ") || "none"}; sandbox: ${inspection.manifest.sandbox}). Pass allowHighRisk (CLI: --allow-high-risk) to load it.`,
    );
  }
  const manifest = inspection.manifest;
  enforceCapabilityPluginPolicy(dir, manifest, options.pluginPolicy, options.slotClaims);
  const entrypoint = isAbsolute(manifest.entrypoint) ? manifest.entrypoint : join(dir, manifest.entrypoint);
  let module: Record<string, unknown>;
  try {
    module = (await import(pathToFileURL(entrypoint).href)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Capability pack "${manifest.id}": failed to import entrypoint ${entrypoint}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const tools = module.tools;
  if (typeof tools !== "object" || tools === null || Array.isArray(tools) || !Object.keys(tools).length) {
    throw new Error(`Capability pack "${manifest.id}": entrypoint must export a non-empty \`tools\` record.`);
  }
  for (const [name, fn] of Object.entries(tools as Record<string, unknown>)) {
    if (!PACK_TOOL_NAME_PATTERN.test(name)) {
      throw new Error(`Capability pack "${manifest.id}": tool name "${name}" must match ${PACK_TOOL_NAME_PATTERN}.`);
    }
    if (typeof fn !== "function") {
      throw new Error(`Capability pack "${manifest.id}": tool "${name}" must be a function.`);
    }
  }

  const env = options.env ?? process.env;
  const entryConfig = options.pluginPolicy?.entries?.[manifest.id]?.config ?? {};
  const context: CapabilityToolContext = Object.freeze({
    // Permission gate: packs that do not declare `network` get no fetch.
    fetch: manifest.permissions.includes("network") ? globalThis.fetch.bind(globalThis) : undefined,
    config: Object.freeze({
      ...entryConfig,
      ...Object.fromEntries((manifest.secrets ?? []).map((name) => [name, env[name]])),
    }),
  });

  const toolNames: string[] = [];
  for (const [name, fn] of Object.entries(tools as Record<string, CapabilityPackTool>)) {
    const namespaced = `${manifest.id}__${name}`;
    options.registry[namespaced] = (args) => fn(args, context);
    toolNames.push(namespaced);
  }
  return { manifest, toolNames, warnings: inspection.warnings };
}

function enforceCapabilityPluginPolicy(
  dir: string,
  manifest: CapabilityPackManifest,
  policy: CapabilityPluginPolicy | undefined,
  slotClaims: Record<string, string> | undefined,
): void {
  if (!policy) return;

  if (policy.load?.paths?.length) {
    const resolvedDir = resolve(dir);
    const allowed = policy.load.paths.map((candidate) => resolve(candidate));
    if (!allowed.includes(resolvedDir)) {
      throw new Error(`Capability pack "${manifest.id}" path ${resolvedDir} is not present in plugins.load.paths.`);
    }
  }

  if (policy.deny?.includes(manifest.id)) {
    throw new Error(`Capability pack "${manifest.id}" is denied by plugins.deny.`);
  }

  if (policy.allow?.length && !policy.allow.includes(manifest.id)) {
    throw new Error(`Capability pack "${manifest.id}" is not present in plugins.allow.`);
  }

  if (policy.entries?.[manifest.id]?.enabled === false) {
    throw new Error(`Capability pack "${manifest.id}" is disabled by plugins.entries.${manifest.id}.enabled=false.`);
  }

  if (!manifest.slot) return;
  const configuredOwner = policy.slots?.[manifest.slot];
  if (configuredOwner && configuredOwner !== manifest.id) {
    throw new Error(`Capability slot "${manifest.slot}" is assigned to "${configuredOwner}", not "${manifest.id}".`);
  }

  if (!slotClaims) return;
  const currentOwner = slotClaims[manifest.slot];
  if (currentOwner && currentOwner !== manifest.id) {
    throw new Error(`Capability slot "${manifest.slot}" is already claimed by "${currentOwner}".`);
  }
  slotClaims[manifest.slot] = manifest.id;
}
