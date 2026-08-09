import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  inspectCapabilityPack,
  type CapabilityActionability,
  type CapabilityPluginPolicy,
  type CapabilityPackKind,
  type CapabilityPackManifest,
  type CapabilityReadiness,
  type CapabilityReadinessLevel,
  type CapabilitySafetyRisk,
} from "./capability.js";
import {
  listBuiltinMcpServers,
  listBuiltinPlugins,
  listBuiltinSkills,
  type BuiltinMcpCatalogEntry,
  type BuiltinMcpInstallSpec,
  type BuiltinCatalogSource,
  type BuiltinRisk,
} from "./builtin-catalog.js";
import type { McpServerConfig } from "./mcp.js";
import type { ToolRuntimeConfig } from "./types.js";

const execFileAsync = promisify(execFile);

export type RosterSource =
  | { readonly type: "local"; readonly path: string }
  | { readonly type: "git"; readonly url: string; readonly ref: string; readonly path?: string };

export interface RosterCapabilityEntry {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly kind: CapabilityPackKind;
  readonly source: RosterSource;
  readonly digest: string;
  readonly compatibility: { readonly muster: string };
  readonly actionability: CapabilityActionability;
  readonly risk: CapabilitySafetyRisk;
  readonly metadata?: RosterCapabilityMetadata;
}

export interface RosterCapabilityMetadata {
  readonly readiness: Pick<CapabilityReadiness, "level" | "status" | "actionability" | "owner" | "surfaces">;
  readonly setup: CapabilityReadiness["setup"];
  readonly diagnostics: CapabilityReadiness["diagnostics"];
  readonly safety: CapabilityReadiness["safety"];
  readonly evidence: CapabilityReadiness["evidence"];
  readonly evals: readonly string[];
  readonly implementedTools: readonly string[];
}

export interface RosterIndex {
  readonly schemaVersion: 1;
  readonly generatedAt?: string;
  readonly entries: readonly RosterCapabilityEntry[];
}

export interface RosterIndexSummary {
  readonly total: number;
  readonly withMetadata: number;
  readonly missingMetadata: number;
  readonly requiresLiveCredentials: number;
  readonly withDiagnostics: number;
  readonly withEvalFixtures: number;
  readonly implementedTools: readonly string[];
  readonly byKind: Readonly<Record<string, number>>;
  readonly byActionability: Readonly<Record<string, number>>;
  readonly byRisk: Readonly<Record<string, number>>;
  readonly byReadinessLevel: Readonly<Record<string, number>>;
  readonly byReadinessStatus: Readonly<Record<string, number>>;
  readonly bySurface: Readonly<Record<string, number>>;
  readonly byCredentialStorage: Readonly<Record<string, number>>;
}

export interface RosterGate {
  readonly id: "source" | "compatibility" | "manifest" | "digest" | "readiness" | "metadata" | "evals" | "diagnostics" | "lock";
  readonly status: "passed" | "blocked";
  readonly summary: string;
}

export interface RosterVerification {
  readonly entry: RosterCapabilityEntry;
  readonly status: "ready" | "blocked";
  readonly gates: readonly RosterGate[];
  readonly resolvedPath?: string;
  readonly manifest?: CapabilityPackManifest;
}

export interface RosterLockEntry {
  readonly id: string;
  readonly version: string;
  readonly kind: CapabilityPackKind;
  readonly slot?: string;
  readonly source: RosterSource;
  readonly resolvedPath?: string;
  readonly digest: string;
  readonly actionability: CapabilityActionability;
  readonly risk: CapabilitySafetyRisk;
  readonly readiness: CapabilityReadiness;
  readonly compatibility: { readonly muster: string };
  readonly lockedAt: string;
}

export interface RosterLock {
  readonly schemaVersion: 1;
  readonly generatedBy: "muster-roster";
  readonly entries: Readonly<Record<string, RosterLockEntry>>;
}

export interface VerifyRosterCapabilityOptions {
  readonly musterVersion: string;
  readonly cwd?: string;
  readonly requireMetadata?: boolean;
  readonly minReadinessLevel?: CapabilityReadinessLevel;
}

export interface InstallRosterCapabilityOptions extends VerifyRosterCapabilityOptions {
  readonly lockPath: string;
  readonly version?: string;
  readonly lockedAt?: string;
}

export interface MaterializeRosterCapabilityOptions extends InstallRosterCapabilityOptions {
  readonly cacheDir: string;
}

export interface RosterInstallResult {
  readonly verification: RosterVerification;
  readonly lockEntry: RosterLockEntry;
  readonly lock: RosterLock;
}

export interface RosterMaterializeResult extends RosterInstallResult {
  readonly materializedPath: string;
}

export interface BuildRosterEntryFromPackOptions extends VerifyRosterCapabilityOptions {
  readonly source: RosterSource;
  readonly musterCompatibility: string;
}

export interface BuildRosterIndexFromPacksOptions extends VerifyRosterCapabilityOptions {
  readonly musterCompatibility: string;
  readonly generatedAt?: string;
}

export interface RosterPublishDraft {
  readonly entry: RosterCapabilityEntry;
  readonly verification: RosterVerification;
}

export interface RosterIndexVerificationReport {
  readonly status: "ready" | "blocked";
  readonly readyCount: number;
  readonly blockedCount: number;
  readonly results: readonly RosterVerification[];
}

export interface RosterVerificationSummary {
  readonly total: number;
  readonly ready: number;
  readonly blocked: number;
  readonly gateTotals: Readonly<Record<string, { readonly passed: number; readonly blocked: number }>>;
  readonly blockedEntries: readonly string[];
  readonly blockersByGate: Readonly<Record<string, readonly string[]>>;
  readonly repairs: readonly RosterVerificationRepairAction[];
}

export interface RosterVerificationRepairAction {
  readonly entry: string;
  readonly gate: RosterGate["id"];
  readonly reason: string;
  readonly command: string;
}

export type RosterSupportMode = "owned_pack" | "channel_adapter" | "mcp_installable" | "host_reuse" | "skill_guidance" | "setup_plan";

export interface RosterSupportEntry {
  readonly id: string;
  readonly kind: "plugin" | "mcp" | "skill";
  readonly source: BuiltinCatalogSource;
  readonly category: string;
  readonly support: readonly RosterSupportMode[];
  readonly risk: BuiltinRisk;
  readonly auth: readonly string[];
  readonly packPath?: string;
  readonly mcpServers: readonly string[];
  readonly channels: readonly string[];
  readonly hosts: readonly string[];
}

export interface RosterSupportMatrixSummary {
  readonly total: number;
  readonly byKind: Readonly<Record<RosterSupportEntry["kind"], number>>;
  readonly bySupport: Readonly<Record<RosterSupportMode, number>>;
  readonly byRisk: Readonly<Record<BuiltinRisk, number>>;
  readonly bySource: Readonly<Record<BuiltinCatalogSource, number>>;
  readonly byAuth: Readonly<Record<string, number>>;
  readonly ownedPacks: number;
  readonly channelAdapters: number;
  readonly mcpInstallable: number;
  readonly hostReuse: number;
  readonly setupPlanOnly: number;
}

export interface RosterSupportMatrix {
  readonly generatedBy: "muster-roster";
  readonly summary: RosterSupportMatrixSummary;
  readonly entries: readonly RosterSupportEntry[];
}

export interface RosterDetectedHostConnector {
  readonly provider: string;
  readonly kind: "app" | "mcp" | "plugin" | "skill";
  readonly id: string;
  readonly auth: string;
  readonly transport?: string;
  readonly source?: string;
}

export interface BuildRosterSupportMatrixOptions {
  readonly hostConnectors?: readonly RosterDetectedHostConnector[];
}

export type RosterProjectionTargetKind =
  | "capability_pack"
  | "mcp_server"
  | "channel_adapter"
  | "host_connector"
  | "skill"
  | "setup_plan";

export type RosterProjectionStatus = "ready" | "needs_credentials" | "needs_host" | "setup_only" | "blocked";

export interface RosterProjectionTarget {
  readonly kind: RosterProjectionTargetKind;
  readonly id: string;
  readonly owner: "muster" | "gateway" | "mcp" | "host" | "skill";
  readonly status: RosterProjectionStatus;
  readonly command?: string;
  readonly auth?: readonly string[];
  readonly source?: string;
}

export interface RosterProjectionGate {
  readonly id: "target" | "ownership" | "credentials" | "host_evidence" | "diagnostics" | "mutation_boundary";
  readonly status: "passed" | "needs_action" | "blocked";
  readonly summary: string;
}

export interface RosterProjectionPlan {
  readonly id: string;
  readonly kind: "builtin_plugin" | "builtin_mcp" | "builtin_skill" | "locked_capability";
  readonly status: RosterProjectionStatus;
  readonly targets: readonly RosterProjectionTarget[];
  readonly gates: readonly RosterProjectionGate[];
  readonly depth: RosterDepthContract;
  readonly blockers: readonly string[];
  readonly notes: readonly string[];
}

export type RosterDepthLevel =
  | "verified_runtime"
  | "partial_runtime"
  | "credentials_required"
  | "host_evidence_only"
  | "setup_only"
  | "blocked";

export interface RosterDepthContract {
  readonly level: RosterDepthLevel;
  readonly capabilities: readonly string[];
  readonly auth: readonly string[];
  readonly evidence: readonly string[];
  readonly speed: {
    readonly hotPath: "none" | "pure_projection" | "explicit_host_scan" | "activation_only";
    readonly cache: "not_required" | "host_scan_cacheable" | "lockfile";
    readonly budget: string;
  };
  readonly gaps: readonly string[];
}

export interface RosterProjectionCatalogSummary {
  readonly total: number;
  readonly ready: number;
  readonly needsCredentials: number;
  readonly needsHost: number;
  readonly setupOnly: number;
  readonly blocked: number;
  readonly depthLevels: Readonly<Record<RosterDepthLevel, number>>;
  readonly targetOwners: Readonly<Record<string, number>>;
}

export interface RosterProjectionNextAction {
  readonly priority: number;
  readonly planId: string;
  readonly planKind: RosterProjectionPlan["kind"];
  readonly reason: "blocked" | "credentials" | "diagnostics" | "host_evidence" | "setup";
  readonly summary: string;
  readonly command?: string;
  readonly target?: Pick<RosterProjectionTarget, "kind" | "id" | "owner" | "status">;
}

export interface RosterProjectionCatalog {
  readonly generatedBy: "muster-roster";
  readonly plans: readonly RosterProjectionPlan[];
  readonly summary: RosterProjectionCatalogSummary;
  readonly nextActions: readonly RosterProjectionNextAction[];
}

export function buildRosterSupportMatrix(options: BuildRosterSupportMatrixOptions = {}): RosterSupportMatrix {
  const detected = options.hostConnectors ?? [];
  const entries: RosterSupportEntry[] = [];
  for (const plugin of listBuiltinPlugins()) {
    const pluginHosts = detected.filter((connector) => connectorMatchesPlugin(connector, plugin));
    const support = new Set<RosterSupportMode>();
    if (plugin.packPath) support.add("owned_pack");
    if (plugin.setup?.channels?.length) support.add("channel_adapter");
    if (plugin.setup?.mcpServers?.length || plugin.setup?.defaultMcpServers?.length || plugin.actionability === "mcp_installable") support.add("mcp_installable");
    if (pluginHosts.length) support.add("host_reuse");
    if (!support.size) support.add("setup_plan");
    entries.push({
      id: plugin.id,
      kind: "plugin",
      source: plugin.source,
      category: plugin.category,
      support: [...support],
      risk: plugin.risk,
      auth: authModesForPlugin(plugin, pluginHosts),
      packPath: plugin.packPath,
      mcpServers: [...new Set([...(plugin.setup?.mcpServers ?? []), ...(plugin.setup?.defaultMcpServers ?? [])])],
      channels: plugin.setup?.channels ?? [],
      hosts: pluginHosts.map(formatDetectedHost),
    });
  }
  for (const mcp of listBuiltinMcpServers()) {
    const mcpHosts = detected.filter((connector) => connector.kind === "mcp" && normalizeRosterConnectorId(connector.id) === mcp.id);
    const support = new Set<RosterSupportMode>();
    if (mcp.install) support.add("mcp_installable");
    if (mcpHosts.length) support.add("host_reuse");
    if (!support.size) support.add("setup_plan");
    const authModes: string[] = [];
    if (mcp.auth) authModes.push(mcp.auth);
    for (const source of mcpHosts) authModes.push(source.auth);
    entries.push({
      id: `mcp:${mcp.id}`,
      kind: "mcp",
      source: mcp.source,
      category: mcp.category,
      support: [...support],
      risk: mcp.risk,
      auth: sortAuthModes([...new Set(authModes)]),
      mcpServers: [mcp.id],
      channels: [],
      hosts: mcpHosts.map(formatDetectedHost),
    });
  }
  for (const skill of listBuiltinSkills()) {
    const skillHosts = detected.filter((connector) => connector.kind === "skill" && normalizeRosterConnectorId(connector.id) === skill.id);
    const authModes = skillHosts.map((connector) => connector.auth);
    entries.push({
      id: `skill:${skill.id}`,
      kind: "skill",
      source: skill.source,
      category: skill.category,
      support: skillHosts.length ? ["skill_guidance", "host_reuse"] : ["skill_guidance"],
      risk: skill.risk,
      auth: sortAuthModes([...new Set(authModes)]),
      mcpServers: [],
      channels: [],
      hosts: skillHosts.map(formatDetectedHost),
    });
  }
  return { generatedBy: "muster-roster", summary: summarizeRosterSupportEntries(entries), entries };
}

export function planRosterBuiltinProjection(id: string, options: BuildRosterSupportMatrixOptions = {}): RosterProjectionPlan {
  const mcpRequested = id.startsWith("mcp:");
  const skillRequested = id.startsWith("skill:");
  const normalizedId = normalizeRosterConnectorId(id.replace(/^(?:mcp|skill):/, ""));
  if (mcpRequested) {
    const mcp = listBuiltinMcpServers().find((entry) => entry.id === normalizedId);
    if (!mcp) return blockedRosterProjection(id, "builtin_mcp", `Unknown built-in MCP server "${id}".`);
    return planBuiltinMcpProjection(mcp, options.hostConnectors ?? []);
  }
  if (skillRequested) {
    const skill = listBuiltinSkills().find((entry) => entry.id === normalizedId);
    if (!skill) return blockedRosterProjection(id, "builtin_skill", `Unknown built-in skill "${id}".`);
    return planBuiltinSkillProjection(skill, options.hostConnectors ?? []);
  }

  const plugin = listBuiltinPlugins().find((entry) =>
    normalizeRosterConnectorId(entry.id) === normalizedId ||
    (entry.aliases ?? []).some((alias) => normalizeRosterConnectorId(alias) === normalizedId)
  );
  if (plugin) return planBuiltinPluginProjection(plugin, options.hostConnectors ?? []);

  const mcp = listBuiltinMcpServers().find((entry) => entry.id === normalizedId);
  if (mcp) return planBuiltinMcpProjection(mcp, options.hostConnectors ?? []);

  const skill = listBuiltinSkills().find((entry) => entry.id === normalizedId);
  if (skill) return planBuiltinSkillProjection(skill, options.hostConnectors ?? []);

  return blockedRosterProjection(id, "builtin_plugin", `Unknown built-in plugin, MCP, or skill "${id}".`);
}

export function planRosterLockProjection(lock: RosterLock, id: string, options: PlanRosterActivationOptions = {}): RosterProjectionPlan {
  const activation = planRosterActivation(lock, id, options);
  if (activation.status === "blocked" || !activation.entry) {
    const gates = [projectionGate("target", "blocked", activation.blockers.join("; ") || `Roster lock entry "${id}" is not activatable.`)];
    return {
      id,
      kind: "locked_capability",
      status: "blocked",
      targets: [],
      gates,
      depth: depthContractFromProjection({
        status: "blocked",
        targets: [],
        gates,
        blockers: activation.blockers,
        capabilities: ["locked_capability"],
        evidence: ["lockfile"],
        speed: { hotPath: "activation_only", cache: "lockfile", budget: "activation reads the lockfile and does not scan provider hosts" },
      }),
      blockers: activation.blockers,
      notes: [],
    };
  }
  const target = {
    kind: "capability_pack" as const,
    id: activation.entry.id,
    owner: "muster" as const,
    status: "ready" as const,
    command: `muster roster activate ${activation.entry.id}`,
    auth: hasRosterSetupEnv(activation.entry.readiness.setup) ? ["env"] : [],
    source: activation.entry.resolvedPath ?? (activation.entry.source.type === "local" ? activation.entry.source.path : undefined),
  };
  const gates = [
    projectionGate("target", "passed", `locked capability ${activation.entry.id}@${activation.entry.version} resolves to a capability pack target`),
    projectionGate("diagnostics", "passed", `readiness declares ${activation.entry.readiness.diagnostics.doctorCommand} and ${activation.entry.readiness.diagnostics.smokeCommand}`),
    projectionGate("mutation_boundary", "passed", "activation mutates only plugin allow/load policy for the locked pack"),
    ...credentialProjectionGates([target]),
  ];
  return {
    id,
    kind: "locked_capability",
    status: "ready",
    blockers: [],
    targets: [target],
    gates,
    depth: depthContractFromProjection({
      status: "ready",
      targets: [target],
      gates,
      blockers: [],
      capabilities: ["locked_capability", `pack_kind:${activation.entry.kind}`, `actionability:${activation.entry.actionability}`],
      evidence: ["lockfile", "capability_readiness", "verified_digest", "eval_fixtures", "diagnostics"],
      speed: { hotPath: "activation_only", cache: "lockfile", budget: "activation reads a deterministic lock entry and mutates only plugin policy" },
    }),
    notes: [`Activates through plugins.allow/load policy; runtime remains owned by the capability-pack loader.`],
  };
}

export function buildRosterProjectionCatalog(
  options: BuildRosterSupportMatrixOptions & { readonly lock?: RosterLock; readonly cwd?: string } = {},
): RosterProjectionCatalog {
  const builtinPlans = [
    ...listBuiltinPlugins().map((plugin) => planRosterBuiltinProjection(plugin.id, options)),
    ...listBuiltinMcpServers().map((mcp) => planRosterBuiltinProjection(`mcp:${mcp.id}`, options)),
    ...listBuiltinSkills().map((skill) => planRosterBuiltinProjection(`skill:${skill.id}`, options)),
  ];
  const lockedPlans = Object.keys(options.lock?.entries ?? {}).map((id) => planRosterLockProjection(options.lock!, id, { cwd: options.cwd }));
  const plans = [...builtinPlans, ...lockedPlans].sort((left, right) =>
    left.kind.localeCompare(right.kind) ||
    left.id.localeCompare(right.id)
  );
  return {
    generatedBy: "muster-roster",
    plans,
    summary: summarizeProjectionCatalog(plans),
    nextActions: projectionCatalogNextActions(plans),
  };
}

export interface RosterActivationPlan {
  readonly entry?: RosterLockEntry;
  readonly status: "ready" | "blocked";
  readonly blockers: readonly string[];
  readonly pluginPolicy: CapabilityPluginPolicy;
}

export interface PlanRosterActivationOptions {
  readonly cwd?: string;
}

export interface RosterMcpActivationPlan {
  readonly id: string;
  readonly status: "ready" | "blocked";
  readonly blockers: readonly string[];
  readonly mcpPolicy: { readonly servers: Readonly<Record<string, McpServerConfig>> };
  readonly auth: readonly string[];
  readonly postInstallCommands: readonly string[];
  readonly mutationBoundary: "tools.mcp.servers only";
}

export interface PlanRosterMcpActivationOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export function planRosterActivation(lock: RosterLock, id: string, options: PlanRosterActivationOptions = {}): RosterActivationPlan {
  const entry = lock.entries[id];
  if (!entry) {
    return {
      status: "blocked",
      blockers: [`Roster lock entry "${id}" was not found.`],
      pluginPolicy: {},
    };
  }

  const localPath = entry.resolvedPath ?? (entry.source.type === "local" ? resolve(options.cwd ?? process.cwd(), entry.source.path) : undefined);
  if (!localPath) {
    return {
      entry,
      status: "blocked",
      blockers: [`Roster lock entry "${id}" must be materialized to a local path before activation.`],
      pluginPolicy: {},
    };
  }

  return {
    entry,
    status: "ready",
    blockers: [],
    pluginPolicy: {
      allow: [entry.id],
      slots: entry.slot ? { [entry.slot]: entry.id } : undefined,
      load: { paths: [localPath] },
      entries: { [entry.id]: { enabled: true } },
    },
  };
}

export async function verifyRosterLockedCapability(
  lock: RosterLock,
  id: string,
  options: VerifyRosterCapabilityOptions,
): Promise<RosterVerification> {
  const entry = lock.entries[id];
  if (!entry) {
    throw new Error(`Roster lock entry "${id}" was not found.`);
  }
  const localPath = entry.resolvedPath ?? (entry.source.type === "local" ? entry.source.path : undefined);
  const verificationEntry: RosterCapabilityEntry = {
    schemaVersion: 1,
    id: entry.id,
    version: entry.version,
    kind: entry.kind,
    source: localPath ? { type: "local", path: localPath } : entry.source,
    digest: entry.digest,
    compatibility: entry.compatibility,
    actionability: entry.actionability,
    risk: entry.risk,
  };
  const verification = await verifyRosterCapability(verificationEntry, options);
  const lockGate = lockedCapabilityMetadataGate(entry, verification.manifest);
  const gates = [...verification.gates, lockGate];
  return {
    ...verification,
    status: gates.every((item) => item.status === "passed") ? "ready" : "blocked",
    gates,
  };
}

export function applyRosterActivationPlan(policy: CapabilityPluginPolicy | undefined, plan: RosterActivationPlan): CapabilityPluginPolicy {
  if (plan.status !== "ready" || !plan.entry) {
    throw new Error(`Cannot activate blocked roster capability: ${plan.blockers.join("; ") || "activation plan did not pass"}`);
  }
  const allow = new Set([...(policy?.allow ?? []), ...(plan.pluginPolicy.allow ?? [])]);
  const loadPaths = new Set([...(policy?.load?.paths ?? []), ...(plan.pluginPolicy.load?.paths ?? [])]);
  return {
    ...policy,
    allow: [...allow],
    slots: {
      ...(policy?.slots ?? {}),
      ...(plan.pluginPolicy.slots ?? {}),
    },
    load: loadPaths.size ? { paths: [...loadPaths] } : policy?.load,
    entries: {
      ...(policy?.entries ?? {}),
      ...Object.fromEntries(Object.entries(plan.pluginPolicy.entries ?? {}).map(([entryId, entryPolicy]) => [
        entryId,
        { ...(policy?.entries?.[entryId] ?? {}), ...entryPolicy },
      ])),
    },
  };
}

export function planRosterMcpActivation(id: string, options: PlanRosterMcpActivationOptions = {}): RosterMcpActivationPlan {
  const normalizedId = normalizeRosterConnectorId(id.replace(/^mcp:/, ""));
  const entry = listBuiltinMcpServers().find((server) => server.id === normalizedId);
  if (!entry) {
    return blockedMcpActivationPlan(normalizedId, `Unknown built-in MCP server "${id}".`);
  }
  if (!entry.install) {
    return blockedMcpActivationPlan(entry.id, `MCP server "${entry.id}" has no Muster-native install spec; use ${entry.commandHint}.`);
  }
  const missing = missingRosterMcpEnv(entry, options.env ?? process.env);
  if (missing.length) {
    return blockedMcpActivationPlan(entry.id, `MCP server "${entry.id}" requires environment value(s): ${missing.join(", ")}.`);
  }
  const server = rosterMcpConfigFromInstallSpec(entry.install, options);
  if (!server) {
    return blockedMcpActivationPlan(entry.id, `MCP server "${entry.id}" install spec could not be resolved in this host environment.`);
  }
  return {
    id: entry.id,
    status: "ready",
    blockers: [],
    mcpPolicy: { servers: { [entry.id]: server } },
    auth: entry.auth ? [entry.auth] : [],
    postInstallCommands: entry.auth === "oauth" ? [`muster mcp oauth setup ${entry.id}`] : [],
    mutationBoundary: "tools.mcp.servers only",
  };
}

export function applyRosterMcpActivationPlan(policy: ToolRuntimeConfig | undefined, plan: RosterMcpActivationPlan): ToolRuntimeConfig {
  if (plan.status !== "ready") {
    throw new Error(`Cannot activate blocked roster MCP: ${plan.blockers.join("; ") || "activation plan did not pass"}`);
  }
  return {
    ...(policy ?? {}),
    mcp: {
      ...(policy?.mcp ?? {}),
      servers: {
        ...(policy?.mcp?.servers ?? {}),
        ...plan.mcpPolicy.servers,
      },
    },
  };
}

export function rosterMcpConfigFromCatalogEntry(entry: BuiltinMcpCatalogEntry, options: PlanRosterMcpActivationOptions = {}): McpServerConfig | undefined {
  if (!entry.install) return undefined;
  return rosterMcpConfigFromInstallSpec(entry.install, options);
}

export function rosterMcpConfigFromInstallSpec(install: BuiltinMcpInstallSpec, options: PlanRosterMcpActivationOptions = {}): McpServerConfig | undefined {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const templateOptions = { cwd, env };
  const transport = install.transport.kind === "http"
    ? {
        kind: "http" as const,
        url: resolveRosterMcpInstallTemplate(install.transport.url, templateOptions) ?? install.transport.url,
        ...(install.transport.headers ? { headers: resolveRosterMcpInstallRecord(install.transport.headers, templateOptions) } : {}),
      }
    : rosterMcpStdioTransportFromInstall(install.transport, templateOptions);
  if (!transport) return undefined;
  return {
    transport,
    ...(install.auth ? { auth: install.auth } : {}),
    ...(install.oauth ? { oauth: install.oauth } : {}),
    ...(install.tools ? { tools: install.tools } : {}),
    ...(install.limits ? { limits: install.limits } : {}),
  };
}

function rosterMcpStdioTransportFromInstall(
  transport: Extract<BuiltinMcpInstallSpec["transport"], { readonly kind: "stdio" }>,
  options: { readonly cwd: string; readonly env: Readonly<Record<string, string | undefined>> },
): Extract<McpServerConfig["transport"], { readonly kind: "stdio" }> | undefined {
  const args = transport.args?.map((arg) => resolveRosterMcpInstallTemplate(arg, options));
  if (args?.some((arg) => !arg)) return undefined;
  return {
    kind: "stdio" as const,
    command: transport.command,
    args: args?.filter((arg): arg is string => Boolean(arg)),
    ...(transport.env ? { env: resolveRosterMcpInstallRecord(transport.env, options) } : {}),
  };
}

export async function verifyRosterIndex(index: RosterIndex, options: VerifyRosterCapabilityOptions): Promise<RosterIndexVerificationReport> {
  const results = await Promise.all(index.entries.map((entry) => verifyRosterCapability(entry, options)));
  const readyCount = results.filter((result) => result.status === "ready").length;
  const blockedCount = results.length - readyCount;
  return {
    status: blockedCount ? "blocked" : "ready",
    readyCount,
    blockedCount,
    results,
  };
}

export async function verifyRosterLock(lock: RosterLock, options: VerifyRosterCapabilityOptions): Promise<RosterIndexVerificationReport> {
  const results = await Promise.all(Object.keys(lock.entries).sort().map((id) => verifyRosterLockedCapability(lock, id, options)));
  const readyCount = results.filter((result) => result.status === "ready").length;
  const blockedCount = results.length - readyCount;
  return {
    status: blockedCount ? "blocked" : "ready",
    readyCount,
    blockedCount,
    results,
  };
}

export function summarizeRosterVerification(report: RosterIndexVerificationReport): RosterVerificationSummary {
  const gateTotals: Partial<Record<RosterGate["id"], { passed: number; blocked: number }>> = {};
  const blockersByGate: Record<string, Set<string>> = {};
  const repairs: RosterVerificationRepairAction[] = [];
  for (const result of report.results) {
    for (const item of result.gates) {
      const existing = gateTotals[item.id] ?? { passed: 0, blocked: 0 };
      gateTotals[item.id] = {
        passed: existing.passed + (item.status === "passed" ? 1 : 0),
        blocked: existing.blocked + (item.status === "blocked" ? 1 : 0),
      };
      if (item.status === "blocked") {
        blockersByGate[item.id] ??= new Set<string>();
        blockersByGate[item.id]!.add(`${result.entry.id}@${result.entry.version}: ${item.summary}`);
        repairs.push(...rosterVerificationRepairActions(result, item));
      }
    }
  }
  return {
    total: report.results.length,
    ready: report.readyCount,
    blocked: report.blockedCount,
    gateTotals: Object.fromEntries(Object.entries(gateTotals).sort(([left], [right]) => left.localeCompare(right))),
    blockedEntries: report.results
      .filter((result) => result.status === "blocked")
      .map((result) => `${result.entry.id}@${result.entry.version}`)
      .sort(),
    blockersByGate: Object.fromEntries(Object.entries(blockersByGate)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, values]) => [id, [...values].sort()])),
    repairs: dedupeRosterVerificationRepairs(repairs),
  };
}

export function summarizeRosterIndex(index: RosterIndex): RosterIndexSummary {
  const byKind: Record<string, number> = {};
  const byActionability: Record<string, number> = {};
  const byRisk: Record<string, number> = {};
  const byReadinessLevel: Record<string, number> = {};
  const byReadinessStatus: Record<string, number> = {};
  const bySurface: Record<string, number> = {};
  const byCredentialStorage: Record<string, number> = {};
  const implementedTools = new Set<string>();
  let withMetadata = 0;
  let requiresLiveCredentials = 0;
  let withDiagnostics = 0;
  let withEvalFixtures = 0;

  for (const entry of index.entries) {
    incrementCount(byKind, entry.kind);
    incrementCount(byActionability, entry.actionability);
    incrementCount(byRisk, entry.risk);
    if (!entry.metadata) continue;
    withMetadata += 1;
    incrementCount(byReadinessLevel, entry.metadata.readiness.level);
    incrementCount(byReadinessStatus, entry.metadata.readiness.status);
    incrementCount(byCredentialStorage, entry.metadata.setup.credentialStorage);
    for (const surface of entry.metadata.readiness.surfaces) incrementCount(bySurface, surface);
    for (const tool of entry.metadata.implementedTools) implementedTools.add(tool);
    if (entry.metadata.diagnostics.requiresLiveCredentials) requiresLiveCredentials += 1;
    if (entry.metadata.diagnostics.doctorCommand && entry.metadata.diagnostics.smokeCommand) withDiagnostics += 1;
    if (entry.metadata.evals.length) withEvalFixtures += 1;
  }

  return {
    total: index.entries.length,
    withMetadata,
    missingMetadata: index.entries.length - withMetadata,
    requiresLiveCredentials,
    withDiagnostics,
    withEvalFixtures,
    implementedTools: [...implementedTools].sort(),
    byKind: sortedCounts(byKind),
    byActionability: sortedCounts(byActionability),
    byRisk: sortedCounts(byRisk),
    byReadinessLevel: sortedCounts(byReadinessLevel),
    byReadinessStatus: sortedCounts(byReadinessStatus),
    bySurface: sortedCounts(bySurface),
    byCredentialStorage: sortedCounts(byCredentialStorage),
  };
}

export async function buildRosterEntryFromPack(dir: string, options: BuildRosterEntryFromPackOptions): Promise<RosterPublishDraft> {
  const inspection = await inspectCapabilityPack(dir);
  if (inspection.status === "blocked" || !inspection.manifest) {
    throw new Error(`Cannot publish blocked capability pack at ${dir}:\n${inspection.blockers.map((blocker) => `- ${blocker}`).join("\n")}`);
  }
  const readiness = inspection.manifest.readiness;
  if (!readiness) {
    throw new Error(`Cannot publish capability pack "${inspection.manifest.id}" without readiness metadata.`);
  }
  if (!inspection.manifest.digest) {
    throw new Error(`Cannot publish capability pack "${inspection.manifest.id}" without a verified digest.`);
  }
  const entry: RosterCapabilityEntry = {
    schemaVersion: 1,
    id: inspection.manifest.id,
    version: inspection.manifest.version,
    kind: inspection.manifest.kind,
    source: options.source,
    digest: inspection.manifest.digest,
    compatibility: { muster: options.musterCompatibility },
    actionability: readiness.actionability,
    risk: readiness.safety.risk,
    metadata: rosterCapabilityMetadataFromManifest(inspection.manifest),
  };
  const verification = await verifyRosterCapability(entry, options);
  if (verification.status === "blocked") {
    const blockers = verification.gates.filter((gate) => gate.status === "blocked").map((gate) => `${gate.id}: ${gate.summary}`).join("; ");
    throw new Error(`Cannot publish capability pack "${entry.id}": ${blockers}`);
  }
  return { entry, verification };
}

export async function buildRosterIndexFromPacks(packDirs: readonly string[], options: BuildRosterIndexFromPacksOptions): Promise<RosterIndex> {
  if (!packDirs.length) throw new Error("At least one capability pack path is required to build a roster index.");
  const entries: RosterCapabilityEntry[] = [];
  const seen = new Set<string>();
  for (const packDir of packDirs) {
    const inspectionDir = resolve(options.cwd ?? process.cwd(), packDir);
    const draft = await buildRosterEntryFromPack(inspectionDir, {
      ...options,
      source: { type: "local", path: packDir },
    });
    const key = `${draft.entry.id}@${draft.entry.version}`;
    if (seen.has(key)) throw new Error(`Duplicate roster index entry ${key}.`);
    seen.add(key);
    entries.push(draft.entry);
  }
  return {
    schemaVersion: 1,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    entries: sortRosterCapabilityEntries(entries),
  };
}

export async function loadRosterIndex(path: string): Promise<RosterIndex> {
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.entries)) {
    throw new Error("Roster index must be a JSON object with schemaVersion=1 and entries[].");
  }
  const entries = raw.entries.map((entry, index) => parseRosterCapabilityEntry(entry, `entries[${index}]`));
  return {
    schemaVersion: 1,
    generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : undefined,
    entries,
  };
}

export async function installRosterCapability(index: RosterIndex, id: string, options: InstallRosterCapabilityOptions): Promise<RosterInstallResult> {
  const candidates = index.entries.filter((entry) => entry.id === id && (!options.version || entry.version === options.version));
  if (!candidates.length) {
    throw new Error(`Roster capability ${id}${options.version ? `@${options.version}` : ""} was not found in the index.`);
  }
  const entry = selectLatestRosterEntry(candidates);
  const verification = await verifyRosterCapability(entry, options);
  const lockEntry = createRosterLockEntry(verification, options.lockedAt);
  const existing = await readRosterLock(options.lockPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyRosterLock();
    throw error;
  });
  const lock = sortRosterLock({
    schemaVersion: 1,
    generatedBy: "muster-roster",
    entries: {
      ...existing.entries,
      [lockEntry.id]: lockEntry,
    },
  });
  await writeRosterLock(options.lockPath, lock);
  return { verification, lockEntry, lock };
}

export async function materializeRosterCapability(index: RosterIndex, id: string, options: MaterializeRosterCapabilityOptions): Promise<RosterMaterializeResult> {
  const candidates = index.entries.filter((entry) => entry.id === id && (!options.version || entry.version === options.version));
  if (!candidates.length) {
    throw new Error(`Roster capability ${id}${options.version ? `@${options.version}` : ""} was not found in the index.`);
  }
  const entry = selectLatestRosterEntry(candidates);
  if (entry.source.type !== "git") {
    throw new Error(`Roster capability "${entry.id}" does not need git materialization; source is ${entry.source.type}.`);
  }
  if (!isPinnedGitCommit(entry.source.ref)) {
    throw new Error(`Roster capability "${entry.id}" must use a pinned 40-character git commit before materialization.`);
  }

  const checkoutPath = resolve(options.cwd ?? process.cwd(), options.cacheDir, entry.id, entry.version, entry.source.ref.slice(0, 12));
  const materializedPath = resolve(checkoutPath, entry.source.path ?? ".");
  await mkdir(dirname(checkoutPath), { recursive: true });
  await rm(checkoutPath, { recursive: true, force: true });
  await execFileAsync("git", ["clone", "--no-checkout", entry.source.url, checkoutPath], { cwd: options.cwd ?? process.cwd() });
  await execFileAsync("git", ["checkout", "--detach", entry.source.ref], { cwd: checkoutPath });

  const verification = await verifyRosterCapability({
    ...entry,
    source: { type: "local", path: materializedPath },
  }, options);
  const verifiedLockEntry = createRosterLockEntry(verification, options.lockedAt);
  const lockEntry: RosterLockEntry = {
    ...verifiedLockEntry,
    source: entry.source,
    resolvedPath: materializedPath,
  };
  const existing = await readRosterLock(options.lockPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyRosterLock();
    throw error;
  });
  const lock = sortRosterLock({
    schemaVersion: 1,
    generatedBy: "muster-roster",
    entries: {
      ...existing.entries,
      [lockEntry.id]: lockEntry,
    },
  });
  await writeRosterLock(options.lockPath, lock);
  return { verification, lockEntry, lock, materializedPath };
}

export async function readRosterLock(path: string): Promise<RosterLock> {
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!isRecord(raw) || raw.schemaVersion !== 1 || raw.generatedBy !== "muster-roster" || !isRecord(raw.entries)) {
    throw new Error("Roster lock must be a JSON object with schemaVersion=1, generatedBy=muster-roster, and entries.");
  }
  const entries: Record<string, RosterLockEntry> = {};
  for (const [id, value] of Object.entries(raw.entries)) {
    entries[id] = parseRosterLockEntry(id, value);
  }
  return sortRosterLock({ schemaVersion: 1, generatedBy: "muster-roster", entries });
}

export async function writeRosterLock(path: string, lock: RosterLock): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const sorted = sortRosterLock(lock);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

export async function verifyRosterCapability(entry: RosterCapabilityEntry, options: VerifyRosterCapabilityOptions): Promise<RosterVerification> {
  const gates: RosterGate[] = [];
  const resolvedPath = resolveSourcePath(entry.source, options.cwd ?? process.cwd());
  gates.push(resolvedPath
    ? gate("source", "passed", `resolved ${entry.source.type} source`)
    : gate("source", "blocked", "only local roster sources can be verified before install"));

  gates.push(satisfiesMusterVersion(options.musterVersion, entry.compatibility.muster)
    ? gate("compatibility", "passed", `muster ${options.musterVersion} satisfies ${entry.compatibility.muster}`)
    : gate("compatibility", "blocked", `muster ${options.musterVersion} does not satisfy ${entry.compatibility.muster}`));

  let manifest: CapabilityPackManifest | undefined;
  if (resolvedPath) {
    try {
      const inspection = await inspectCapabilityPack(resolvedPath);
      manifest = inspection.manifest;
      gates.push(inspection.status === "ready" && manifest
        ? gate("manifest", "passed", `manifest ${manifest.id}@${manifest.version} is valid`)
        : gate("manifest", "blocked", inspection.blockers.join("; ") || "manifest is blocked"));
    } catch (error) {
      gates.push(gate("manifest", "blocked", error instanceof Error ? error.message : String(error)));
    }
  } else {
    gates.push(gate("manifest", "blocked", "manifest cannot be inspected without a local source"));
  }

  if (manifest) {
    const identityMatches = manifest.id === entry.id && manifest.version === entry.version && manifest.kind === entry.kind;
    if (!identityMatches) {
      gates.push(gate("digest", "blocked", `registry identity ${entry.id}@${entry.version}/${entry.kind} does not match manifest ${manifest.id}@${manifest.version}/${manifest.kind}`));
    } else if (manifest.digest !== entry.digest) {
      gates.push(gate("digest", "blocked", `registry digest ${entry.digest} does not match manifest digest ${manifest.digest ?? "missing"}`));
    } else {
      gates.push(gate("digest", "passed", "registry digest matches verified manifest digest"));
    }
  } else {
    gates.push(gate("digest", "blocked", "digest cannot be checked without a valid manifest"));
  }

  const readiness = manifest?.readiness;
  if (!readiness) {
    gates.push(gate("readiness", "blocked", "manifest readiness metadata is required for roster-managed capabilities"));
  } else if (options.minReadinessLevel && !readinessSatisfiesMinimum(readiness.level, options.minReadinessLevel)) {
    gates.push(gate("readiness", "blocked", `readiness ${readiness.level} does not satisfy required minimum ${options.minReadinessLevel}`));
  } else {
    gates.push(gate("readiness", "passed", `readiness ${readiness.level}/${readiness.status}/${readiness.actionability}`));
  }

  if (manifest?.readiness) {
    const expectedMetadata = rosterCapabilityMetadataFromManifest(manifest);
    gates.push(!entry.metadata
      ? options.requireMetadata
        ? gate("metadata", "blocked", "index metadata is required for this verification profile")
        : gate("metadata", "passed", "index metadata is absent; manifest verification remains authoritative")
      : stableStringify(entry.metadata) === stableStringify(expectedMetadata)
        ? gate("metadata", "passed", "index metadata matches manifest-derived readiness metadata")
        : gate("metadata", "blocked", "index metadata does not match manifest-derived readiness metadata"));
  } else {
    gates.push(gate("metadata", "blocked", "metadata cannot be checked without manifest readiness"));
  }

  const evals = manifest?.evals ?? [];
  const missingEvals = resolvedPath && evals.length ? evals.filter((evalPath) => !existsSync(join(resolvedPath, evalPath))) : evals;
  gates.push(evals.length && !missingEvals.length
    ? gate("evals", "passed", `${evals.length} eval fixture(s) declared and present`)
    : gate("evals", "blocked", evals.length ? `missing eval fixture(s): ${missingEvals.join(", ")}` : "at least one eval fixture is required"));

  const diagnostics = readiness?.diagnostics;
  gates.push(diagnostics?.doctorCommand && diagnostics.smokeCommand
    ? gate("diagnostics", "passed", "doctor and smoke commands declared")
    : gate("diagnostics", "blocked", "readiness diagnostics require doctorCommand and smokeCommand"));

  return {
    entry,
    status: gates.every((item) => item.status === "passed") ? "ready" : "blocked",
    gates,
    resolvedPath,
    manifest,
  };
}

export function createRosterLockEntry(verification: RosterVerification, lockedAt = new Date().toISOString()): RosterLockEntry {
  if (verification.status !== "ready" || !verification.manifest?.readiness) {
    const blockers = verification.gates.filter((gate) => gate.status === "blocked").map((gate) => `${gate.id}: ${gate.summary}`).join("; ");
    throw new Error(`Cannot create roster lock entry for blocked capability ${verification.entry.id}: ${blockers || "verification did not pass"}`);
  }

  return {
    id: verification.manifest.id,
    version: verification.manifest.version,
    kind: verification.manifest.kind,
    slot: verification.manifest.slot,
    source: verification.entry.source,
    resolvedPath: verification.resolvedPath,
    digest: verification.manifest.digest ?? verification.entry.digest,
    actionability: verification.manifest.readiness.actionability,
    risk: verification.manifest.readiness.safety.risk,
    readiness: verification.manifest.readiness,
    compatibility: verification.entry.compatibility,
    lockedAt,
  };
}

function resolveSourcePath(source: RosterSource, cwd: string): string | undefined {
  if (source.type !== "local") return undefined;
  return resolve(cwd, source.path);
}

function authModesForPlugin(plugin: ReturnType<typeof listBuiltinPlugins>[number], hosts: readonly RosterDetectedHostConnector[]): readonly string[] {
  const auth = new Set<string>();
  if (plugin.setup?.auth && plugin.setup.auth !== "none") auth.add(plugin.setup.auth);
  if (plugin.setup?.requiresEnv?.length || plugin.setup?.requiresAnyEnv?.length) auth.add("env");
  for (const connector of hosts) auth.add(connector.auth);
  if (plugin.setup?.mcpServers?.length || plugin.setup?.defaultMcpServers?.length) {
    for (const mcpId of [...(plugin.setup?.mcpServers ?? []), ...(plugin.setup?.defaultMcpServers ?? [])]) {
      const mcp = listBuiltinMcpServers().find((entry) => entry.id === mcpId);
      if (mcp?.auth) auth.add(mcp.auth);
    }
  }
  return sortAuthModes([...auth]);
}

function planBuiltinPluginProjection(plugin: ReturnType<typeof listBuiltinPlugins>[number], hosts: readonly RosterDetectedHostConnector[]): RosterProjectionPlan {
  const pluginHosts = hosts.filter((connector) => connectorMatchesPlugin(connector, plugin));
  const targets: RosterProjectionTarget[] = [];
  const notes: string[] = [];

  if (plugin.packPath) {
    targets.push({
      kind: "capability_pack",
      id: plugin.id,
      owner: "muster",
      status: plugin.setup?.requiresEnv?.length || plugin.setup?.requiresAnyEnv?.length ? "needs_credentials" : "ready",
      command: `muster plugins enable ${plugin.id}`,
      auth: plugin.setup?.requiresEnv?.length || plugin.setup?.requiresAnyEnv?.length ? ["env"] : [],
      source: plugin.packPath,
    });
  }

  if (plugin.setup?.auth && !["none", "local"].includes(plugin.setup.auth)) {
    targets.push({
      kind: "setup_plan",
      id: plugin.id,
      owner: "muster",
      status: "needs_credentials",
      command: plugin.setup.setupCommand ?? `muster plugins setup ${plugin.id}`,
      auth: [plugin.setup.auth],
      source: plugin.id,
    });
  }

  for (const channel of plugin.setup?.channels ?? []) {
    targets.push({
      kind: "channel_adapter",
      id: channel,
      owner: "gateway",
      status: "needs_credentials",
      command: `muster channels setup ${channel}`,
      auth: ["env"],
      source: plugin.id,
    });
  }

  for (const mcpId of [...new Set([...(plugin.setup?.mcpServers ?? []), ...(plugin.setup?.defaultMcpServers ?? [])])]) {
    const mcp = listBuiltinMcpServers().find((entry) => entry.id === normalizeRosterConnectorId(mcpId));
    targets.push({
      kind: "mcp_server",
      id: normalizeRosterConnectorId(mcpId),
      owner: "mcp",
      status: mcp?.install ? mcpProjectionStatus(mcp.auth) : "setup_only",
      command: mcp?.install ? mcpProjectionCommand(mcp) : `muster mcp catalog`,
      auth: mcp?.auth ? [mcp.auth] : [],
      source: plugin.id,
    });
  }

  for (const connector of pluginHosts) {
    targets.push({
      kind: "host_connector",
      id: normalizeRosterConnectorId(connector.id),
      owner: "host",
      status: "ready",
      command: `muster plugins reuse ${connector.provider}`,
      auth: [connector.auth],
      source: connector.source ?? connector.provider,
    });
  }

  if (!targets.length) {
    targets.push({
      kind: "setup_plan",
      id: plugin.id,
      owner: "muster",
      status: "setup_only",
      command: `muster plugins setup ${plugin.id}`,
      auth: authModesForPlugin(plugin, []),
      source: plugin.source,
    });
  }

  if (pluginHosts.length) {
    notes.push("Host connectors are reuse evidence only; Roster must not copy opaque host secrets.");
  }
  if (plugin.setup?.notes?.length) notes.push(...plugin.setup.notes);
  const plannedTargets = sortProjectionTargets(targets);
  const gates = projectionGatesForBuiltinPlugin(plugin, plannedTargets, pluginHosts);
  const status = summarizeProjectionStatus(plannedTargets);

  return {
    id: plugin.id,
    kind: "builtin_plugin",
    status,
    targets: plannedTargets,
    gates,
    depth: depthContractFromProjection({
      status,
      targets: plannedTargets,
      gates,
      blockers: [],
      capabilities: builtinPluginDepthCapabilities(plugin, plannedTargets),
      evidence: builtinPluginDepthEvidence(plugin, pluginHosts),
      speed: {
        hotPath: pluginHosts.length ? "explicit_host_scan" : "pure_projection",
        cache: pluginHosts.length ? "host_scan_cacheable" : "not_required",
        budget: pluginHosts.length
          ? "host evidence came from an explicit scan/cache; normal chat and gateway paths do not rescan hosts"
          : "plan uses in-memory builtin metadata only; normal chat and gateway paths do not scan hosts",
      },
    }),
    blockers: [],
    notes,
  };
}

function planBuiltinMcpProjection(mcp: ReturnType<typeof listBuiltinMcpServers>[number], hosts: readonly RosterDetectedHostConnector[]): RosterProjectionPlan {
  const mcpHosts = hosts.filter((connector) => connector.kind === "mcp" && normalizeRosterConnectorId(connector.id) === mcp.id);
  const targets: RosterProjectionTarget[] = [];
  if (mcp.install) {
    targets.push({
      kind: "mcp_server",
      id: mcp.id,
      owner: "mcp",
      status: mcpProjectionStatus(mcp.auth),
      command: mcpProjectionCommand(mcp),
      auth: mcp.auth ? [mcp.auth] : [],
      source: mcp.source,
    });
  }
  for (const connector of mcpHosts) {
    targets.push({
      kind: "host_connector",
      id: mcp.id,
      owner: "host",
      status: "ready",
      command: `muster plugins reuse ${connector.provider}`,
      auth: [connector.auth],
      source: connector.source ?? connector.provider,
    });
  }
  if (!targets.length) {
    targets.push({
      kind: "setup_plan",
      id: mcp.id,
      owner: "mcp",
      status: "setup_only",
      command: mcp.commandHint,
      auth: mcp.auth ? [mcp.auth] : [],
      source: mcp.source,
    });
  }
  const plannedTargets = sortProjectionTargets(targets);
  const gates = projectionGatesForBuiltinMcp(mcp, plannedTargets, mcpHosts);
  const status = summarizeProjectionStatus(plannedTargets);
  return {
    id: `mcp:${mcp.id}`,
    kind: "builtin_mcp",
    status,
    targets: plannedTargets,
    gates,
    depth: depthContractFromProjection({
      status,
      targets: plannedTargets,
      gates,
      blockers: [],
      capabilities: builtinMcpDepthCapabilities(mcp, plannedTargets),
      evidence: builtinMcpDepthEvidence(mcp, mcpHosts),
      speed: {
        hotPath: mcpHosts.length ? "explicit_host_scan" : "pure_projection",
        cache: mcpHosts.length ? "host_scan_cacheable" : "not_required",
        budget: mcpHosts.length
          ? "host MCP evidence came from an explicit scan/cache; live tool lists remain owned by the MCP layer"
          : "plan uses the builtin MCP install/setup record only; live tool discovery is not run during planning",
      },
    }),
    blockers: [],
    notes: mcp.notes ?? [],
  };
}

function planBuiltinSkillProjection(skill: ReturnType<typeof listBuiltinSkills>[number], hosts: readonly RosterDetectedHostConnector[]): RosterProjectionPlan {
  const skillHosts = hosts.filter((connector) => connector.kind === "skill" && normalizeRosterConnectorId(connector.id) === skill.id);
  const targets: RosterProjectionTarget[] = [{
    kind: "skill",
    id: skill.id,
    owner: "skill",
    status: "ready",
    command: `muster skills enable ${skill.id}`,
    auth: [],
    source: skill.source,
  }];
  for (const connector of skillHosts) {
    targets.push({
      kind: "host_connector",
      id: skill.id,
      owner: "host",
      status: "ready",
      command: `muster plugins reuse ${connector.provider}`,
      auth: [connector.auth],
      source: connector.source ?? connector.provider,
    });
  }
  const plannedTargets = sortProjectionTargets(targets);
  const gates: RosterProjectionGate[] = [
    projectionGate("target", "passed", `skill ${skill.id} can be enabled as profile-scoped guidance`),
    projectionGate("ownership", "passed", projectionOwnersSummary(plannedTargets)),
    projectionGate("mutation_boundary", "passed", "activation writes only the profile skill file and skills.entries policy"),
    projectionGate("credentials", "passed", "skills do not carry secrets; prerequisites stay as explicit diagnostic checks"),
  ];
  if (skill.requires?.length) {
    gates.push(projectionGate("diagnostics", "needs_action", `skill prerequisites should be checked before use: ${skill.requires.join(", ")}`));
  }
  if (skillHosts.length) {
    gates.push(projectionGate("host_evidence", "passed", `${skillHosts.length} host skill record(s) supplied as evidence; host files are not copied`));
  }
  const status = summarizeProjectionStatus(plannedTargets);
  return {
    id: `skill:${skill.id}`,
    kind: "builtin_skill",
    status,
    targets: plannedTargets,
    gates,
    depth: depthContractFromProjection({
      status,
      targets: plannedTargets,
      gates,
      blockers: [],
      capabilities: builtinSkillDepthCapabilities(skill, plannedTargets),
      evidence: builtinSkillDepthEvidence(skill, skillHosts),
      speed: {
        hotPath: skillHosts.length ? "explicit_host_scan" : "pure_projection",
        cache: skillHosts.length ? "host_scan_cacheable" : "not_required",
        budget: skillHosts.length
          ? "host skill evidence came from an explicit scan/cache; activation still uses Muster's profile skill writer"
          : "plan uses in-memory builtin skill metadata only; normal chat performs bounded top-K skill selection separately",
      },
    }),
    blockers: [],
    notes: [`Skill activation is guidance, not a tool adapter; use MCPs or packs for executable integrations.`],
  };
}

function blockedRosterProjection(id: string, kind: RosterProjectionPlan["kind"], blocker: string): RosterProjectionPlan {
  const gates = [projectionGate("target", "blocked", blocker)];
  return {
    id,
    kind,
    status: "blocked",
    targets: [],
    gates,
    depth: depthContractFromProjection({
      status: "blocked",
      targets: [],
      gates,
      blockers: [blocker],
      capabilities: [],
      evidence: [],
      speed: { hotPath: "pure_projection", cache: "not_required", budget: "blocked during in-memory planning" },
    }),
    blockers: [blocker],
    notes: [],
  };
}

function mcpProjectionStatus(auth: ReturnType<typeof listBuiltinMcpServers>[number]["auth"]): RosterProjectionStatus {
  if (auth === "api_key" || auth === "oauth") return "needs_credentials";
  return "setup_only";
}

function mcpProjectionCommand(mcp: ReturnType<typeof listBuiltinMcpServers>[number]): string {
  if (mcp.auth === "oauth") return `muster mcp install ${mcp.id} && muster mcp oauth setup ${mcp.id}`;
  return `muster mcp install ${mcp.id}`;
}

function blockedMcpActivationPlan(id: string, blocker: string): RosterMcpActivationPlan {
  return {
    id,
    status: "blocked",
    blockers: [blocker],
    mcpPolicy: { servers: {} },
    auth: [],
    postInstallCommands: [],
    mutationBoundary: "tools.mcp.servers only",
  };
}

function missingRosterMcpEnv(entry: BuiltinMcpCatalogEntry, env: Readonly<Record<string, string | undefined>>): readonly string[] {
  const missing: string[] = [];
  for (const name of entry.requiresEnv ?? []) {
    if (!env[name]) missing.push(name);
  }
  for (const group of entry.requiresAnyEnv ?? []) {
    if (!group.some((name) => env[name])) missing.push(group.join("|"));
  }
  return missing;
}

function resolveRosterMcpInstallRecord(
  record: Readonly<Record<string, string>>,
  options: { readonly cwd: string; readonly env: Readonly<Record<string, string | undefined>> },
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record)
      .map(([key, value]) => [key, resolveRosterMcpInstallTemplate(value, options)])
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0),
  );
}

function resolveRosterMcpInstallTemplate(
  value: string,
  options: { readonly cwd: string; readonly env: Readonly<Record<string, string | undefined>> },
): string | undefined {
  if (value === "${CWD}") return options.cwd;
  const fullEnv = /^\$\{([A-Z_][A-Z0-9_]*)\}$/.exec(value);
  if (fullEnv) return options.env[fullEnv[1]] ? value : undefined;
  if (/^[A-Z_][A-Z0-9_]*(?:\|[A-Z_][A-Z0-9_]*)+$/.test(value)) {
    return value.split("|").some((name) => options.env[name]) ? value : undefined;
  }
  if (/^[A-Z_][A-Z0-9_]*$/.test(value) && options.env[value]) return value;
  let missing = false;
  const resolved = value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (match, name: string) => {
    if (!options.env[name]) missing = true;
    return match;
  });
  return missing ? undefined : resolved;
}

function builtinPluginDepthCapabilities(plugin: ReturnType<typeof listBuiltinPlugins>[number], targets: readonly RosterProjectionTarget[]): readonly string[] {
  const capabilities = new Set<string>([
    `source:${plugin.source}`,
    `category:${plugin.category}`,
    `actionability:${plugin.actionability}`,
  ]);
  if (plugin.packPath) capabilities.add("capability_pack");
  for (const channel of plugin.setup?.channels ?? []) capabilities.add(`channel:${channel}`);
  for (const mcp of [...(plugin.setup?.mcpServers ?? []), ...(plugin.setup?.defaultMcpServers ?? [])]) capabilities.add(`mcp:${normalizeRosterConnectorId(mcp)}`);
  for (const target of targets) capabilities.add(depthCapabilityForTarget(target));
  return [...capabilities].sort();
}

function builtinPluginDepthEvidence(plugin: ReturnType<typeof listBuiltinPlugins>[number], hosts: readonly RosterDetectedHostConnector[]): readonly string[] {
  const evidence = new Set<string>(["builtin_catalog"]);
  if (plugin.packPath) evidence.add("pack_path");
  if (plugin.setup?.channels?.length) evidence.add("gateway_adapter_setup");
  if (plugin.setup?.mcpServers?.length || plugin.setup?.defaultMcpServers?.length) evidence.add("mcp_setup_metadata");
  if (plugin.setup?.requiresEnv?.length || plugin.setup?.requiresAnyEnv?.length) evidence.add("credential_metadata");
  if (plugin.setup?.auth) evidence.add("auth_metadata");
  if (plugin.setup?.setupUrls?.length) evidence.add("setup_urls");
  if (hosts.length) evidence.add("explicit_host_scan");
  return [...evidence].sort();
}

function builtinMcpDepthCapabilities(mcp: ReturnType<typeof listBuiltinMcpServers>[number], targets: readonly RosterProjectionTarget[]): readonly string[] {
  const capabilities = new Set<string>([
    `source:${mcp.source}`,
    `category:${mcp.category}`,
    `mcp:${mcp.id}`,
  ]);
  if (mcp.install?.transport.kind) capabilities.add(`transport:${mcp.install.transport.kind}`);
  for (const tool of mcp.defaultTools ?? []) capabilities.add(`tool:${tool}`);
  for (const target of targets) capabilities.add(depthCapabilityForTarget(target));
  return [...capabilities].sort();
}

function builtinMcpDepthEvidence(mcp: ReturnType<typeof listBuiltinMcpServers>[number], hosts: readonly RosterDetectedHostConnector[]): readonly string[] {
  const evidence = new Set<string>(["builtin_catalog"]);
  if (mcp.install) evidence.add("mcp_install_spec");
  if (mcp.auth) evidence.add("auth_metadata");
  if (mcp.requiresEnv?.length || mcp.requiresAnyEnv?.length) evidence.add("credential_metadata");
  if (mcp.setupUrls?.length) evidence.add("setup_urls");
  if (hosts.length) evidence.add("explicit_host_scan");
  return [...evidence].sort();
}

function builtinSkillDepthCapabilities(skill: ReturnType<typeof listBuiltinSkills>[number], targets: readonly RosterProjectionTarget[]): readonly string[] {
  const capabilities = new Set<string>([
    `source:${skill.source}`,
    `category:${skill.category}`,
    `skill:${skill.id}`,
  ]);
  for (const tag of skill.tags) capabilities.add(`tag:${tag}`);
  for (const requirement of skill.requires ?? []) capabilities.add(`requires:${requirement}`);
  for (const target of targets) capabilities.add(depthCapabilityForTarget(target));
  return [...capabilities].sort();
}

function builtinSkillDepthEvidence(skill: ReturnType<typeof listBuiltinSkills>[number], hosts: readonly RosterDetectedHostConnector[]): readonly string[] {
  const evidence = new Set<string>(["builtin_catalog", "skill_metadata"]);
  if (skill.requires?.length) evidence.add("prerequisite_metadata");
  if (hosts.length) evidence.add("explicit_host_scan");
  return [...evidence].sort();
}

function depthCapabilityForTarget(target: RosterProjectionTarget): string {
  if (target.kind === "capability_pack") return "owned_runtime:capability_pack";
  if (target.kind === "channel_adapter") return "owned_runtime:channel_adapter";
  if (target.kind === "mcp_server") return "owned_runtime:mcp_server";
  if (target.kind === "host_connector") return "host_reuse";
  if (target.kind === "skill") return "skill_guidance";
  return "setup_plan";
}

function depthContractFromProjection(input: {
  readonly status: RosterProjectionStatus;
  readonly targets: readonly RosterProjectionTarget[];
  readonly gates: readonly RosterProjectionGate[];
  readonly blockers: readonly string[];
  readonly capabilities: readonly string[];
  readonly evidence: readonly string[];
  readonly speed: RosterDepthContract["speed"];
}): RosterDepthContract {
  return {
    level: rosterDepthLevel(input.status, input.targets, input.gates, input.blockers),
    capabilities: [...new Set(input.capabilities)].sort(),
    auth: sortAuthModes([...new Set(input.targets.flatMap((target) => target.auth ?? []))]),
    evidence: [...new Set(input.evidence)].sort(),
    speed: input.speed,
    gaps: rosterDepthGaps(input.targets, input.gates, input.blockers),
  };
}

function rosterDepthLevel(
  status: RosterProjectionStatus,
  targets: readonly RosterProjectionTarget[],
  gates: readonly RosterProjectionGate[],
  blockers: readonly string[],
): RosterDepthLevel {
  if (status === "blocked" || blockers.length || gates.some((gate) => gate.status === "blocked")) return "blocked";
  const readyTargets = targets.filter((target) => target.status === "ready");
  const readyOwnedRuntime = readyTargets.some((target) => target.owner !== "host" && target.kind !== "setup_plan");
  const hasNeedsCredentials = targets.some((target) => target.status === "needs_credentials") || gates.some((gate) => gate.id === "credentials" && gate.status === "needs_action");
  if (readyOwnedRuntime && !hasNeedsCredentials && gates.every((gate) => gate.status === "passed")) return "verified_runtime";
  if (readyOwnedRuntime) return "partial_runtime";
  if (readyTargets.length && readyTargets.every((target) => target.kind === "host_connector")) return "host_evidence_only";
  if (hasNeedsCredentials) return "credentials_required";
  return "setup_only";
}

function rosterDepthGaps(
  targets: readonly RosterProjectionTarget[],
  gates: readonly RosterProjectionGate[],
  blockers: readonly string[],
): readonly string[] {
  const gaps = new Set<string>(blockers);
  for (const gate of gates) {
    if (gate.status !== "passed") gaps.add(`${gate.id}:${gate.summary}`);
  }
  for (const target of targets) {
    if (target.status !== "ready") gaps.add(`${target.kind}:${target.id}:${target.status}`);
  }
  return [...gaps].sort();
}

function projectionGatesForBuiltinPlugin(
  plugin: ReturnType<typeof listBuiltinPlugins>[number],
  targets: readonly RosterProjectionTarget[],
  hosts: readonly RosterDetectedHostConnector[],
): readonly RosterProjectionGate[] {
  const gates: RosterProjectionGate[] = [
    projectionGate("target", targets.length ? "passed" : "blocked", targets.length ? `${targets.length} projection target(s) planned` : "no projection targets were planned"),
    projectionGate("ownership", "passed", projectionOwnersSummary(targets)),
    projectionGate("mutation_boundary", "passed", "plan is read-only; each target keeps its runtime owner and command boundary"),
    ...credentialProjectionGates(targets),
  ];
  if (plugin.setup?.channels?.length) {
    gates.push(projectionGate("diagnostics", "needs_action", `channel adapter setup must run through gateway diagnostics: ${plugin.setup.channels.map((channel) => `muster channels doctor ${channel}`).join(", ")}`));
  } else if (plugin.packPath) {
    gates.push(projectionGate("diagnostics", "needs_action", `capability pack readiness should be checked before enable: muster plugins check ${plugin.id}`));
  }
  if (hosts.length) {
    gates.push(projectionGate("host_evidence", "passed", `${hosts.length} host connector(s) supplied as evidence; opaque host secrets are not copied`));
  } else if ((plugin.id === "authenticated-app-reuse" || plugin.setup?.notes?.some((note) => /reuse|host-authenticated|host exposes/i.test(note)))) {
    gates.push(projectionGate("host_evidence", "needs_action", "host reuse requires an explicit host scan such as muster roster plan <id> --host codex"));
  }
  return gates;
}

function projectionGatesForBuiltinMcp(
  mcp: ReturnType<typeof listBuiltinMcpServers>[number],
  targets: readonly RosterProjectionTarget[],
  hosts: readonly RosterDetectedHostConnector[],
): readonly RosterProjectionGate[] {
  return [
    projectionGate("target", targets.length ? "passed" : "blocked", targets.length ? `${targets.length} projection target(s) planned` : "no projection targets were planned"),
    projectionGate("ownership", "passed", projectionOwnersSummary(targets)),
    projectionGate("mutation_boundary", "passed", "MCP installation/adoption remains owned by MCP config or the provider host"),
    ...credentialProjectionGates(targets),
    hosts.length
      ? projectionGate("host_evidence", "passed", `${hosts.length} host MCP connector(s) supplied as evidence; opaque host secrets are not copied`)
      : projectionGate(
        "host_evidence",
        targets.length ? "needs_action" : "blocked",
        mcp.install
          ? "no host evidence supplied; Muster-native MCP install remains available"
          : targets.some((target) => target.kind === "setup_plan")
            ? "no host evidence supplied; manual MCP setup remains available through the command hint"
            : "no host evidence or Muster-native MCP install is available",
      ),
  ];
}

function credentialProjectionGates(targets: readonly RosterProjectionTarget[]): readonly RosterProjectionGate[] {
  const needsCredentials = targets.filter((target) => target.status === "needs_credentials");
  if (!needsCredentials.length) {
    return [projectionGate("credentials", "passed", "no additional credentials are required by ready targets")];
  }
  return [projectionGate(
    "credentials",
    "needs_action",
    needsCredentials.map((target) => `${target.kind}:${target.id} requires ${target.auth?.join(",") || "credentials"}`).join("; "),
  )];
}

function projectionOwnersSummary(targets: readonly RosterProjectionTarget[]): string {
  const owners = [...new Set(targets.map((target) => `${target.owner}:${target.kind}`))];
  return owners.length ? `runtime owners: ${owners.join(", ")}` : "no runtime owner";
}

function summarizeRosterSupportEntries(entries: readonly RosterSupportEntry[]): RosterSupportMatrixSummary {
  const byKind: Record<RosterSupportEntry["kind"], number> = { plugin: 0, mcp: 0, skill: 0 };
  const bySupport: Record<RosterSupportMode, number> = {
    owned_pack: 0,
    channel_adapter: 0,
    mcp_installable: 0,
    host_reuse: 0,
    skill_guidance: 0,
    setup_plan: 0,
  };
  const byRisk: Record<BuiltinRisk, number> = { low: 0, medium: 0, high: 0 };
  const bySource: Partial<Record<BuiltinCatalogSource, number>> = {};
  const byAuth: Record<string, number> = {};
  for (const entry of entries) {
    byKind[entry.kind] += 1;
    byRisk[entry.risk] += 1;
    bySource[entry.source] = (bySource[entry.source] ?? 0) + 1;
    for (const support of entry.support) bySupport[support] += 1;
    for (const auth of entry.auth) byAuth[auth] = (byAuth[auth] ?? 0) + 1;
  }
  return {
    total: entries.length,
    byKind,
    bySupport,
    byRisk,
    bySource: Object.fromEntries(Object.entries(bySource).sort(([left], [right]) => left.localeCompare(right))) as Record<BuiltinCatalogSource, number>,
    byAuth: Object.fromEntries(Object.entries(byAuth).sort(([left], [right]) => left.localeCompare(right))),
    ownedPacks: bySupport.owned_pack,
    channelAdapters: bySupport.channel_adapter,
    mcpInstallable: bySupport.mcp_installable,
    hostReuse: bySupport.host_reuse,
    setupPlanOnly: entries.filter((entry) => entry.support.length === 1 && entry.support[0] === "setup_plan").length,
  };
}

function projectionGate(id: RosterProjectionGate["id"], status: RosterProjectionGate["status"], summary: string): RosterProjectionGate {
  return { id, status, summary };
}

function summarizeProjectionCatalog(plans: readonly RosterProjectionPlan[]): RosterProjectionCatalogSummary {
  const targetOwners: Record<string, number> = {};
  const depthLevels: Record<RosterDepthLevel, number> = {
    verified_runtime: 0,
    partial_runtime: 0,
    credentials_required: 0,
    host_evidence_only: 0,
    setup_only: 0,
    blocked: 0,
  };
  for (const plan of plans) {
    depthLevels[plan.depth.level] += 1;
    for (const target of plan.targets) {
      const key = `${target.owner}:${target.kind}`;
      targetOwners[key] = (targetOwners[key] ?? 0) + 1;
    }
  }
  return {
    total: plans.length,
    ready: plans.filter((plan) => plan.status === "ready").length,
    needsCredentials: plans.filter((plan) => plan.status === "needs_credentials").length,
    needsHost: plans.filter((plan) => plan.status === "needs_host").length,
    setupOnly: plans.filter((plan) => plan.status === "setup_only").length,
    blocked: plans.filter((plan) => plan.status === "blocked").length,
    depthLevels,
    targetOwners: Object.fromEntries(Object.entries(targetOwners).sort(([left], [right]) => left.localeCompare(right))),
  };
}

function projectionCatalogNextActions(plans: readonly RosterProjectionPlan[]): readonly RosterProjectionNextAction[] {
  const actions: RosterProjectionNextAction[] = [];
  for (const plan of plans) {
    for (const blocker of plan.blockers) {
      actions.push({
        priority: 10,
        planId: plan.id,
        planKind: plan.kind,
        reason: "blocked",
        summary: blocker,
      });
    }
    for (const gate of plan.gates) {
      if (gate.status === "passed") continue;
      const priority = projectionGatePriority(gate);
      actions.push({
        priority,
        planId: plan.id,
        planKind: plan.kind,
        reason: projectionGateReason(gate),
        summary: gate.summary,
        command: projectionGateCommand(plan, gate),
      });
    }
    for (const target of plan.targets) {
      if (target.status === "ready") continue;
      actions.push({
        priority: projectionTargetPriority(target),
        planId: plan.id,
        planKind: plan.kind,
        reason: target.status === "needs_credentials" ? "credentials" : "setup",
        summary: `${target.kind}:${target.id} is ${target.status}`,
        command: target.command,
        target: {
          kind: target.kind,
          id: target.id,
          owner: target.owner,
          status: target.status,
        },
      });
    }
  }
  const seen = new Set<string>();
  return actions
    .sort((left, right) =>
      left.priority - right.priority ||
      left.planId.localeCompare(right.planId) ||
      left.reason.localeCompare(right.reason) ||
      (left.command ?? "").localeCompare(right.command ?? "") ||
      left.summary.localeCompare(right.summary)
    )
    .filter((action) => {
      const key = `${action.priority}:${action.planId}:${action.reason}:${action.command ?? ""}:${action.summary}:${action.target?.kind ?? ""}:${action.target?.id ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function projectionGatePriority(gate: RosterProjectionGate): number {
  if (gate.status === "blocked") return 10;
  if (gate.id === "credentials") return 20;
  if (gate.id === "diagnostics") return 30;
  if (gate.id === "host_evidence") return 40;
  return 50;
}

function projectionGateReason(gate: RosterProjectionGate): RosterProjectionNextAction["reason"] {
  if (gate.status === "blocked") return "blocked";
  if (gate.id === "credentials") return "credentials";
  if (gate.id === "diagnostics") return "diagnostics";
  if (gate.id === "host_evidence") return "host_evidence";
  return "setup";
}

function projectionGateCommand(plan: RosterProjectionPlan, gate: RosterProjectionGate): string | undefined {
  if (gate.id === "credentials") {
    return plan.targets.find((target) => target.status === "needs_credentials")?.command;
  }
  if (gate.id === "diagnostics") {
    const channelTarget = plan.targets.find((target) => target.kind === "channel_adapter");
    if (channelTarget) return `muster channels doctor ${channelTarget.id}`;
    const packTarget = plan.targets.find((target) => target.kind === "capability_pack");
    if (packTarget) return `muster plugins check ${packTarget.id}`;
  }
  if (gate.id === "host_evidence") {
    if (/manual MCP setup|Muster-native MCP install/.test(gate.summary)) {
      return plan.targets.find((target) => target.kind === "setup_plan" || target.kind === "mcp_server")?.command;
    }
    return `muster roster plan ${plan.id} --host codex`;
  }
  return undefined;
}

function projectionTargetPriority(target: RosterProjectionTarget): number {
  if (target.status === "blocked") return 10;
  if (target.status === "needs_credentials") return 20;
  if (target.status === "needs_host") return 40;
  return 50;
}

function summarizeProjectionStatus(targets: readonly RosterProjectionTarget[]): RosterProjectionStatus {
  if (targets.some((target) => target.status === "ready")) return "ready";
  if (targets.some((target) => target.status === "needs_credentials")) return "needs_credentials";
  if (targets.some((target) => target.status === "needs_host")) return "needs_host";
  if (targets.some((target) => target.status === "setup_only")) return "setup_only";
  return "blocked";
}

function sortProjectionTargets(targets: readonly RosterProjectionTarget[]): readonly RosterProjectionTarget[] {
  const rank = new Map<RosterProjectionTargetKind, number>([
    ["capability_pack", 0],
    ["channel_adapter", 1],
    ["mcp_server", 2],
    ["host_connector", 3],
    ["skill", 4],
    ["setup_plan", 5],
  ]);
  const unique = new Map<string, RosterProjectionTarget>();
  for (const target of targets) {
    const key = [
      target.kind,
      target.owner,
      target.id,
      target.status,
      target.command ?? "",
      target.kind === "host_connector" ? "" : target.source ?? "",
      (target.auth ?? []).join(","),
    ].join("\0");
    if (!unique.has(key)) unique.set(key, target);
  }
  return [...unique.values()].sort((left, right) =>
    (rank.get(left.kind) ?? 99) - (rank.get(right.kind) ?? 99) ||
    left.id.localeCompare(right.id) ||
    left.owner.localeCompare(right.owner) ||
    left.status.localeCompare(right.status) ||
    (left.source ?? "").localeCompare(right.source ?? "") ||
    (left.command ?? "").localeCompare(right.command ?? "")
  );
}

function hasRosterSetupEnv(setup: RosterLockEntry["readiness"]["setup"]): boolean {
  return setup.requiredEnv.length > 0 || setup.requiredAnyEnv.length > 0;
}

function connectorMatchesPlugin(connector: RosterDetectedHostConnector, plugin: ReturnType<typeof listBuiltinPlugins>[number]): boolean {
  const connectorId = normalizeRosterConnectorId(connector.id);
  const pluginTerms = new Set([plugin.id, ...(plugin.aliases ?? [])].map(normalizeRosterConnectorId));
  if (connector.kind === "app") return pluginTerms.has(connectorId);
  if (connector.kind === "plugin") return pluginTerms.has(connectorId);
  if (connector.kind === "mcp") {
    return pluginTerms.has(connectorId) ||
      (plugin.setup?.mcpServers ?? []).some((id) => normalizeRosterConnectorId(id) === connectorId) ||
      (plugin.setup?.defaultMcpServers ?? []).some((id) => normalizeRosterConnectorId(id) === connectorId);
  }
  return false;
}

function formatDetectedHost(connector: RosterDetectedHostConnector): string {
  return `${connector.provider}:${connector.kind}:${connector.auth}`;
}

function normalizeRosterConnectorId(value: string): string {
  return value.replace(/_/g, "-").replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`).replace(/^-/, "").toLowerCase();
}

function sortAuthModes(values: readonly string[]): readonly string[] {
  const rank = new Map([["env", 0], ["api_key", 1], ["oauth", 2], ["host_oauth", 3], ["local", 4], ["none", 5]]);
  return [...values].sort((a, b) => (rank.get(a) ?? 99) - (rank.get(b) ?? 99) || a.localeCompare(b));
}

function emptyRosterLock(): RosterLock {
  return { schemaVersion: 1, generatedBy: "muster-roster", entries: {} };
}

function sortRosterLock(lock: RosterLock): RosterLock {
  return {
    schemaVersion: 1,
    generatedBy: "muster-roster",
    entries: Object.fromEntries(Object.entries(lock.entries).sort(([a], [b]) => a.localeCompare(b))),
  };
}

function selectLatestRosterEntry(entries: readonly RosterCapabilityEntry[]): RosterCapabilityEntry {
  return [...entries].sort((a, b) => compareVersions(b.version, a.version))[0]!;
}

function sortRosterCapabilityEntries(entries: readonly RosterCapabilityEntry[]): readonly RosterCapabilityEntry[] {
  return [...entries].sort((left, right) => left.id.localeCompare(right.id) || compareVersions(left.version, right.version));
}

function rosterVerificationRepairActions(result: RosterVerification, gate: RosterGate): readonly RosterVerificationRepairAction[] {
  const entryLabel = `${result.entry.id}@${result.entry.version}`;
  const packPath = result.resolvedPath ?? (result.entry.source.type === "local" ? result.entry.source.path : undefined);
  const actions: RosterVerificationRepairAction[] = [];
  const push = (command: string): void => {
    actions.push({ entry: entryLabel, gate: gate.id, reason: gate.summary, command });
  };

  if (gate.id === "source") {
    if (result.entry.source.type === "git") push(`muster roster materialize ${result.entry.id}`);
    else push(`check local roster source path for ${entryLabel}`);
  } else if (gate.id === "compatibility") {
    push(`review compatibility.muster for ${entryLabel} or upgrade Muster`);
  } else if (gate.id === "digest") {
    if (packPath) {
      push(`muster capability digest ${packPath} --write`);
      push(`muster roster index ${packPath} --dry-run`);
    } else {
      push(`materialize ${entryLabel} before regenerating its digest`);
    }
  } else if (gate.id === "manifest") {
    if (packPath) push(`muster capability inspect ${packPath}`);
    else push(`materialize ${entryLabel} before inspecting its manifest`);
  } else if (gate.id === "readiness") {
    if (packPath) {
      const minimum = /required minimum ([a-z_]+)/.exec(gate.summary)?.[1];
      if (minimum) {
        push(`run release evidence and QA required for readiness.level ${minimum} in ${packPath}/manifest.json`);
        push(`muster qa run pack_readiness --evidence ${packPath}`);
        push(`muster roster index ${packPath} --dry-run`);
      } else {
        push(`add readiness metadata with doctorCommand and smokeCommand in ${packPath}/manifest.json`);
      }
      push(`muster capability inspect ${packPath}`);
    } else {
      push(`materialize ${entryLabel} before repairing readiness metadata`);
    }
  } else if (gate.id === "diagnostics") {
    if (packPath) {
      push(`add readiness metadata with doctorCommand and smokeCommand in ${packPath}/manifest.json`);
      push(`muster capability inspect ${packPath}`);
    } else {
      push(`materialize ${entryLabel} before repairing readiness diagnostics`);
    }
  } else if (gate.id === "metadata") {
    if (packPath) {
      push(`muster roster index ${packPath} --dry-run`);
      push(`regenerate the roster index entry for ${entryLabel}`);
    } else {
      push(`regenerate the roster index entry for ${entryLabel} after materialization`);
    }
  } else if (gate.id === "lock") {
    if (packPath) {
      push(`muster roster install ${result.entry.id} --version ${result.entry.version}`);
      push(`muster roster activate ${result.entry.id} --dry-run`);
    } else {
      push(`materialize ${entryLabel} and refresh its roster lock entry`);
    }
  } else if (gate.id === "evals") {
    if (packPath) {
      push(`add or fix eval fixture paths declared in ${packPath}/manifest.json`);
      push(`muster capability inspect ${packPath}`);
    } else {
      push(`materialize ${entryLabel} before repairing eval fixtures`);
    }
  }
  if (!actions.length && packPath) push(`muster capability inspect ${packPath}`);
  return actions;
}

function lockedCapabilityMetadataGate(entry: RosterLockEntry, manifest: CapabilityPackManifest | undefined): RosterGate {
  if (!manifest?.readiness) {
    return gate("lock", "blocked", "lock metadata cannot be checked without manifest readiness");
  }
  const drift: string[] = [];
  if (stableStringify(entry.readiness) !== stableStringify(manifest.readiness)) drift.push("readiness");
  if (entry.actionability !== manifest.readiness.actionability) drift.push("actionability");
  if (entry.risk !== manifest.readiness.safety.risk) drift.push("risk");
  if ((entry.slot ?? "") !== (manifest.slot ?? "")) drift.push("slot");
  return drift.length
    ? gate("lock", "blocked", `lock metadata drift detected: ${drift.join(", ")}`)
    : gate("lock", "passed", "lock metadata matches manifest readiness, actionability, risk, and slot");
}

function dedupeRosterVerificationRepairs(actions: readonly RosterVerificationRepairAction[]): readonly RosterVerificationRepairAction[] {
  const seen = new Set<string>();
  return [...actions]
    .sort((left, right) =>
      left.entry.localeCompare(right.entry) ||
      left.gate.localeCompare(right.gate) ||
      left.command.localeCompare(right.command)
    )
    .filter((action) => {
      const key = `${action.entry}\0${action.gate}\0${action.command}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function incrementCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function sortedCounts(counts: Readonly<Record<string, number>>): Readonly<Record<string, number>> {
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function rosterCapabilityMetadataFromManifest(manifest: CapabilityPackManifest): RosterCapabilityMetadata {
  const readiness = manifest.readiness;
  if (!readiness) throw new Error(`Capability pack "${manifest.id}" is missing readiness metadata.`);
  return {
    readiness: {
      level: readiness.level,
      status: readiness.status,
      actionability: readiness.actionability,
      owner: readiness.owner,
      surfaces: readiness.surfaces,
    },
    setup: readiness.setup,
    diagnostics: readiness.diagnostics,
    safety: readiness.safety,
    evidence: readiness.evidence,
    evals: manifest.evals ?? [],
    implementedTools: manifest.implementedTools ?? [],
  };
}

function parseRosterCapabilityEntry(value: unknown, label: string): RosterCapabilityEntry {
  if (!isRecord(value)) throw new Error(`Roster ${label} must be an object.`);
  if (value.schemaVersion !== 1) throw new Error(`Roster ${label}.schemaVersion must be 1.`);
  if (!isSafeId(value.id)) throw new Error(`Roster ${label}.id must be lowercase kebab-case.`);
  if (!isSemverLike(value.version)) throw new Error(`Roster ${label}.version must be semver-like.`);
  if (!isCapabilityKind(value.kind)) throw new Error(`Roster ${label}.kind is invalid.`);
  if (!isRosterSource(value.source)) throw new Error(`Roster ${label}.source is invalid.`);
  if (!isSha256Digest(value.digest)) throw new Error(`Roster ${label}.digest must be sha256:<64 hex chars>.`);
  if (!isRecord(value.compatibility) || typeof value.compatibility.muster !== "string") throw new Error(`Roster ${label}.compatibility.muster is required.`);
  if (!isCapabilityActionability(value.actionability)) throw new Error(`Roster ${label}.actionability is invalid.`);
  if (!isSafetyRiskValue(value.risk)) throw new Error(`Roster ${label}.risk is invalid.`);
  const metadata = value.metadata === undefined ? undefined : parseRosterCapabilityMetadata(value.metadata, `${label}.metadata`);
  return {
    schemaVersion: 1,
    id: value.id,
    version: value.version,
    kind: value.kind,
    source: value.source,
    digest: value.digest,
    compatibility: { muster: value.compatibility.muster },
    actionability: value.actionability,
    risk: value.risk,
    metadata,
  };
}

function parseRosterCapabilityMetadata(value: unknown, label: string): RosterCapabilityMetadata {
  if (!isRecord(value)) throw new Error(`Roster ${label} must be an object.`);
  if (!isRecord(value.readiness)) throw new Error(`Roster ${label}.readiness is required.`);
  if (!isReadinessLevel(value.readiness.level)) throw new Error(`Roster ${label}.readiness.level is invalid.`);
  if (!isReadinessStatus(value.readiness.status)) throw new Error(`Roster ${label}.readiness.status is invalid.`);
  if (!isCapabilityActionability(value.readiness.actionability)) throw new Error(`Roster ${label}.readiness.actionability is invalid.`);
  if (typeof value.readiness.owner !== "string" || !value.readiness.owner.length) throw new Error(`Roster ${label}.readiness.owner is required.`);
  if (!isStringArray(value.readiness.surfaces) || !value.readiness.surfaces.every(isReadinessSurface)) throw new Error(`Roster ${label}.readiness.surfaces is invalid.`);

  if (!isRecord(value.setup)) throw new Error(`Roster ${label}.setup is required.`);
  if (!isStringArray(value.setup.urls) || !isStringArray(value.setup.requiredEnv) || !isStringMatrix(value.setup.requiredAnyEnv)) throw new Error(`Roster ${label}.setup env/url fields are invalid.`);
  if (!isCredentialStorage(value.setup.credentialStorage)) throw new Error(`Roster ${label}.setup.credentialStorage is invalid.`);

  if (!isRecord(value.diagnostics)) throw new Error(`Roster ${label}.diagnostics is required.`);
  if (value.diagnostics.doctorCommand !== undefined && typeof value.diagnostics.doctorCommand !== "string") throw new Error(`Roster ${label}.diagnostics.doctorCommand is invalid.`);
  if (value.diagnostics.smokeCommand !== undefined && typeof value.diagnostics.smokeCommand !== "string") throw new Error(`Roster ${label}.diagnostics.smokeCommand is invalid.`);
  if (value.diagnostics.latencyBudgetMs !== undefined && typeof value.diagnostics.latencyBudgetMs !== "number") throw new Error(`Roster ${label}.diagnostics.latencyBudgetMs is invalid.`);
  if (typeof value.diagnostics.requiresLiveCredentials !== "boolean") throw new Error(`Roster ${label}.diagnostics.requiresLiveCredentials is required.`);

  if (!isRecord(value.safety)) throw new Error(`Roster ${label}.safety is required.`);
  if (!isSafetyRiskValue(value.safety.risk)) throw new Error(`Roster ${label}.safety.risk is invalid.`);
  if (!isPermissionMode(value.safety.permissionMode)) throw new Error(`Roster ${label}.safety.permissionMode is invalid.`);
  if (!isMutationApproval(value.safety.mutationApproval)) throw new Error(`Roster ${label}.safety.mutationApproval is invalid.`);
  if (typeof value.safety.resultCapBytes !== "number") throw new Error(`Roster ${label}.safety.resultCapBytes is required.`);
  if (value.safety.secretRedaction !== true) throw new Error(`Roster ${label}.safety.secretRedaction must be true.`);

  if (!isRecord(value.evidence) || !isStringArray(value.evidence.unitTests) || !isStringArray(value.evidence.qaSuites) || !isStringArray(value.evidence.liveArtifacts) || !isStringArray(value.evidence.docs)) {
    throw new Error(`Roster ${label}.evidence is invalid.`);
  }
  if (!isStringArray(value.evals)) throw new Error(`Roster ${label}.evals is invalid.`);
  if (!isStringArray(value.implementedTools)) throw new Error(`Roster ${label}.implementedTools is invalid.`);

  return {
    readiness: {
      level: value.readiness.level,
      status: value.readiness.status,
      actionability: value.readiness.actionability,
      owner: value.readiness.owner,
      surfaces: value.readiness.surfaces,
    },
    setup: {
      urls: value.setup.urls,
      requiredEnv: value.setup.requiredEnv,
      requiredAnyEnv: value.setup.requiredAnyEnv,
      credentialStorage: value.setup.credentialStorage,
    },
    diagnostics: {
      doctorCommand: value.diagnostics.doctorCommand,
      smokeCommand: value.diagnostics.smokeCommand,
      latencyBudgetMs: value.diagnostics.latencyBudgetMs,
      requiresLiveCredentials: value.diagnostics.requiresLiveCredentials,
    },
    safety: {
      risk: value.safety.risk,
      permissionMode: value.safety.permissionMode,
      mutationApproval: value.safety.mutationApproval,
      resultCapBytes: value.safety.resultCapBytes,
      secretRedaction: true,
    },
    evidence: {
      unitTests: value.evidence.unitTests,
      qaSuites: value.evidence.qaSuites,
      liveArtifacts: value.evidence.liveArtifacts,
      docs: value.evidence.docs,
    },
    evals: value.evals,
    implementedTools: value.implementedTools,
  };
}

function parseRosterLockEntry(id: string, value: unknown): RosterLockEntry {
  if (!isRecord(value)) throw new Error(`Roster lock entry ${id} must be an object.`);
  const entry = parseRosterCapabilityEntry({ ...value, schemaVersion: 1 }, `lock.entries.${id}`);
  if (!isRecord(value.readiness)) throw new Error(`Roster lock entry ${id}.readiness is required.`);
  if (typeof value.lockedAt !== "string") throw new Error(`Roster lock entry ${id}.lockedAt is required.`);
  return {
    id: entry.id,
    version: entry.version,
    kind: entry.kind,
    slot: typeof value.slot === "string" ? value.slot : undefined,
    source: entry.source,
    resolvedPath: typeof value.resolvedPath === "string" ? value.resolvedPath : undefined,
    digest: entry.digest,
    actionability: entry.actionability,
    risk: entry.risk,
    readiness: value.readiness as unknown as CapabilityReadiness,
    compatibility: entry.compatibility,
    lockedAt: value.lockedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{2,79}$/.test(value);
}

function isSemverLike(value: unknown): value is string {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(value);
}

function isCapabilityKind(value: unknown): value is CapabilityPackKind {
  return value === "tool" || value === "skill" || value === "agent" || value === "workflow" || value === "channel";
}

function isCapabilityActionability(value: unknown): value is CapabilityActionability {
  return (
    value === "metadata" ||
    value === "setup_plan" ||
    value === "local_tool" ||
    value === "runtime_adapter" ||
    value === "mcp_installable" ||
    value === "end_to_end_workflow"
  );
}

function isSafetyRiskValue(value: unknown): value is CapabilitySafetyRisk {
  return value === "low" || value === "medium" || value === "high";
}

function isReadinessLevel(value: unknown): value is CapabilityReadiness["level"] {
  return value === "listed" || value === "setup_plan" || value === "installable" || value === "executable" || value === "verified" || value === "release_ready";
}

function readinessSatisfiesMinimum(actual: CapabilityReadinessLevel, minimum: CapabilityReadinessLevel): boolean {
  const rank: Record<CapabilityReadinessLevel, number> = {
    listed: 0,
    setup_plan: 1,
    installable: 2,
    executable: 3,
    verified: 4,
    release_ready: 5,
  };
  return rank[actual] >= rank[minimum];
}

function isReadinessStatus(value: unknown): value is CapabilityReadiness["status"] {
  return value === "stable" || value === "beta" || value === "experimental" || value === "blocked";
}

function isReadinessSurface(value: unknown): value is CapabilityReadiness["surfaces"][number] {
  return value === "cli" || value === "tui" || value === "gateway" || value === "web" || value === "channel" || value === "frappe";
}

function isCredentialStorage(value: unknown): value is CapabilityReadiness["setup"]["credentialStorage"] {
  return value === "env" || value === "muster-secret-ref" || value === "external-vault" || value === "none";
}

function isPermissionMode(value: unknown): value is CapabilityReadiness["safety"]["permissionMode"] {
  return value === "deny_by_default" || value === "ask" || value === "allow_when_scoped";
}

function isMutationApproval(value: unknown): value is CapabilityReadiness["safety"]["mutationApproval"] {
  return value === "never" || value === "required" || value === "policy";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringMatrix(value: unknown): value is string[][] {
  return Array.isArray(value) && value.every(isStringArray);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRosterSource(value: unknown): value is RosterSource {
  if (!isRecord(value)) return false;
  if (value.type === "local") return typeof value.path === "string" && value.path.length > 0;
  if (value.type === "git") return typeof value.url === "string" && value.url.length > 0 && typeof value.ref === "string" && value.ref.length > 0 && (value.path === undefined || typeof value.path === "string");
  return false;
}

function isPinnedGitCommit(value: string): boolean {
  return /^[a-f0-9]{40}$/i.test(value);
}

function isSha256Digest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/i.test(value);
}

function gate(id: RosterGate["id"], status: RosterGate["status"], summary: string): RosterGate {
  return { id, status, summary };
}

function satisfiesMusterVersion(version: string, range: string): boolean {
  const exact = parseVersion(range);
  if (exact) return compareVersions(version, exact) === 0;
  const atLeast = /^>=\s*(\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?)$/.exec(range);
  if (atLeast) return compareVersions(version, atLeast[1]) >= 0;
  const sameMajor = /^\^\s*(\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?)$/.exec(range);
  if (!sameMajor) return false;
  const current = numericVersion(version);
  const minimum = numericVersion(sameMajor[1]);
  return current[0] === minimum[0] && compareVersionParts(current, minimum) >= 0;
}

function parseVersion(value: string): string | undefined {
  return /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(value) ? value : undefined;
}

function compareVersions(a: string, b: string): number {
  return compareVersionParts(numericVersion(a), numericVersion(b));
}

function numericVersion(value: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
  if (!match) return [Number.NaN, Number.NaN, Number.NaN];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersionParts(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (!Number.isFinite(left) || !Number.isFinite(right)) return -1;
    if (left > right) return 1;
    if (left < right) return -1;
  }
  return 0;
}
