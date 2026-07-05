import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  disableBuiltinPlugin,
  enableBuiltinPlugin,
  listBuiltinMcpServers,
  listBuiltinPlugins,
  listBuiltinSkills,
  type BuiltinPluginCatalogEntry,
  type BuiltinSkillCatalogEntry,
} from "./builtin-catalog.js";
import { ensureDefaultConfig, loadConfig } from "./config.js";
import { buildRosterSupportMatrix } from "./roster.js";
import type { RuntimeDoctorStatus } from "./runtime-doctor.js";

export interface QaChannelPluginSetupCase {
  readonly id: string;
  readonly status: RuntimeDoctorStatus;
  readonly summary: string;
  readonly evidence: Record<string, unknown>;
}

export interface QaChannelPluginSetupResult {
  readonly suite: "channel_plugin_setup";
  readonly status: RuntimeDoctorStatus;
  readonly artifactDir: string;
  readonly manifestPath: string;
  readonly casesPath: string;
  readonly catalogPath: string;
  readonly cases: readonly QaChannelPluginSetupCase[];
  readonly summary: string;
}

export async function runChannelPluginSetupQa(input: {
  readonly artifactDir: string;
}): Promise<QaChannelPluginSetupResult> {
  const artifactDir = input.artifactDir;
  await mkdir(artifactDir, { recursive: true });
  const cwd = join(artifactDir, "workspace");
  await mkdir(cwd, { recursive: true });
  await ensureDefaultConfig(cwd);

  const plugins = listBuiltinPlugins();
  const mcps = listBuiltinMcpServers();
  const rosterMatrix = buildRosterSupportMatrix();
  const cases: QaChannelPluginSetupCase[] = [];

  cases.push(caseCatalogCoverage(plugins, mcps));
  cases.push(caseRosterSupportDepth(rosterMatrix));
  cases.push(caseCatalogActionabilityEvidence(plugins));
  cases.push(caseEverydayCapabilityBreadth(plugins));
  cases.push(caseSkillCatalogBreadth(listBuiltinSkills()));
  cases.push(caseMcpAuthAndInstallDepth(mcps));
  cases.push(caseSetupGuidance(plugins, "frappe-federated-bridge", { needsSetupUrl: true }));
  cases.push(caseSetupGuidance(plugins, "web-frameworks", { needsPack: true }));
  cases.push(caseSetupGuidance(plugins, "google-workspace", { needsSetupUrl: true, needsMcp: true }));
  cases.push(caseSetupGuidance(plugins, "telegram", { needsChannel: true, needsSetupUrl: true, needsPack: true }));
  cases.push(caseSetupGuidance(plugins, "slack", { needsChannel: true, needsSetupUrl: true }));
  cases.push(await caseHighRiskRefusal(cwd, plugins));
  cases.push(await caseEnableDisablePolicy(cwd, "web-frameworks"));
  cases.push(caseMcpInstallGuidance(mcps));

	  const status: RuntimeDoctorStatus = cases.every((testCase) => testCase.status === "passed") ? "passed" : "failed";
	  const summary = status === "passed"
	    ? "Roster support depth, channel/plugin catalog depth, setup guidance, skill/MCP breadth, unsafe-plugin refusal, and enable/disable policy verified"
	    : "Channel/plugin setup QA found missing roster support depth, catalog depth, setup guidance, or policy regressions";
  const manifestPath = join(artifactDir, "manifest.json");
  const casesPath = join(artifactDir, "cases.jsonl");
  const catalogPath = join(artifactDir, "catalog.json");
  await writeFile(casesPath, `${cases.map((testCase) => JSON.stringify(testCase)).join("\n")}\n`, "utf8");
	  await writeFile(catalogPath, `${JSON.stringify({
	    plugins: plugins.map((plugin) => catalogPluginSnapshot(plugin)),
	    mcpServers: mcps.map((mcp) => ({
      id: mcp.id,
      category: mcp.category,
      auth: mcp.auth ?? "none",
      setupUrls: mcp.setupUrls ?? [],
      installable: Boolean(mcp.install),
	      requiresEnv: mcp.requiresEnv ?? [],
	      requiresAnyEnv: mcp.requiresAnyEnv ?? [],
	    })),
	    rosterMatrix,
	  }, null, 2)}\n`, "utf8");
  await writeFile(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    kind: "muster-qa",
    suite: "channel_plugin_setup",
    status,
    summary,
    caseCount: cases.length,
    artifacts: { cases: "cases.jsonl", catalog: "catalog.json", workspace: "workspace" },
  }, null, 2)}\n`, "utf8");

  return { suite: "channel_plugin_setup", status, artifactDir, manifestPath, casesPath, catalogPath, cases, summary };
}

function caseCatalogCoverage(
  plugins: readonly BuiltinPluginCatalogEntry[],
  mcps: ReturnType<typeof listBuiltinMcpServers>,
): QaChannelPluginSetupCase {
  const requiredPlugins = [
    "web-search",
    "github",
    "google-workspace",
    "notion",
    "telegram",
    "slack",
    "teams",
    "google-chat",
    "frappe-federated-bridge",
    "web-frameworks",
    "browser",
    "mcp-bridge",
  ];
  const requiredMcps = ["git", "browser", "github", "google-drive", "notion", "parallel-search"];
  const pluginIds = new Set(plugins.flatMap((plugin) => [plugin.id, ...(plugin.aliases ?? [])]));
  const mcpIds = new Set(mcps.map((mcp) => mcp.id));
  const missingPlugins = requiredPlugins.filter((id) => !pluginIds.has(id));
  const missingMcps = requiredMcps.filter((id) => !mcpIds.has(id));
  const status: RuntimeDoctorStatus = missingPlugins.length || missingMcps.length ? "failed" : "passed";
  return {
    id: "catalog_core_surfaces",
    status,
    summary: status === "passed"
      ? "core web, channel, Frappe, Playwright, and MCP surfaces are discoverable"
      : "core integration catalog surfaces are missing",
    evidence: { pluginCount: plugins.length, mcpCount: mcps.length, missingPlugins, missingMcps },
  };
}

function caseRosterSupportDepth(matrix: ReturnType<typeof buildRosterSupportMatrix>): QaChannelPluginSetupCase {
  const summary = matrix.summary;
  const entriesById = new Map(matrix.entries.map((entry) => [entry.id, entry]));
  const requiredSupports = [
    { id: "telegram", support: "owned_pack" },
    { id: "telegram", support: "channel_adapter" },
    { id: "slack", support: "owned_pack" },
    { id: "slack", support: "channel_adapter" },
    { id: "frappe-federated-bridge", support: "owned_pack" },
    { id: "mcp:linear", support: "mcp_installable" },
    { id: "mcp:notion", support: "mcp_installable" },
    { id: "skill:systematic-debugging", support: "skill_guidance" },
  ] as const;
  const missingSupports = requiredSupports
    .filter((requirement) => !entriesById.get(requirement.id)?.support.includes(requirement.support))
    .map((requirement) => `${requirement.id}:${requirement.support}`);
  const missingCounts = [
    summary.ownedPacks > 0 ? undefined : "owned_packs",
    summary.channelAdapters >= 2 ? undefined : "channel_adapters",
    summary.mcpInstallable >= 4 ? undefined : "mcp_installable",
    (summary.byKind.plugin ?? 0) > 0 ? undefined : "plugins",
    (summary.byKind.mcp ?? 0) > 0 ? undefined : "mcps",
    (summary.byKind.skill ?? 0) > 0 ? undefined : "skills",
  ].filter((item): item is string => Boolean(item));
  const hostReuseWithoutScan = summary.hostReuse;
  const status: RuntimeDoctorStatus = missingSupports.length || missingCounts.length || hostReuseWithoutScan ? "failed" : "passed";
  return {
    id: "roster_support_depth",
    status,
    summary: status === "passed"
      ? "roster support matrix exposes owned packs, channel adapters, MCP installs, and skill guidance without implicit host scans"
      : "roster support matrix is shallow or mixed with implicit host evidence",
    evidence: {
      summary,
      missingSupports,
      missingCounts,
      hostReuseWithoutScan,
      sampleEntries: ["telegram", "slack", "frappe-federated-bridge", "mcp:linear", "mcp:notion", "skill:systematic-debugging"]
        .map((id) => entriesById.get(id))
        .filter(Boolean),
    },
  };
}

function caseCatalogActionabilityEvidence(plugins: readonly BuiltinPluginCatalogEntry[]): QaChannelPluginSetupCase {
  const offenders = plugins.filter((plugin) => {
    const hasSetupUrl = Boolean(plugin.setup?.setupUrls?.length);
    const hasSetupNote = Boolean(plugin.setup?.notes?.length);
    const hasMcp = Boolean(plugin.setup?.mcpServers?.length || plugin.setup?.defaultMcpServers?.length);
    const hasChannel = Boolean(plugin.setup?.channels?.length);
    const hasEnv = Boolean(plugin.setup?.requiresEnv?.length || plugin.setup?.requiresAnyEnv?.length);
    const hasPack = Boolean(plugin.packPath);
    if (plugin.description.trim().length < 24) return true;
    if (plugin.actionability === "metadata") return true;
    if (plugin.actionability === "setup_plan") return !(hasSetupUrl && hasSetupNote);
    if (plugin.actionability === "local_tool" || plugin.actionability === "end_to_end_workflow") return !(hasPack || hasMcp);
    if (plugin.actionability === "runtime_adapter") return !(hasPack && hasChannel);
    if (plugin.actionability === "mcp_installable") return !(hasMcp || hasPack || hasSetupUrl);
    return !(hasPack || hasSetupUrl || hasSetupNote || hasMcp || hasChannel || hasEnv);
  }).map((plugin) => ({
    id: plugin.id,
    actionability: plugin.actionability,
    category: plugin.category,
    hasPack: Boolean(plugin.packPath),
    hasSetupUrl: Boolean(plugin.setup?.setupUrls?.length),
    hasNotes: Boolean(plugin.setup?.notes?.length),
    hasMcp: Boolean(plugin.setup?.mcpServers?.length || plugin.setup?.defaultMcpServers?.length),
    hasChannel: Boolean(plugin.setup?.channels?.length),
  }));
  const status: RuntimeDoctorStatus = offenders.length ? "failed" : "passed";
  return {
    id: "catalog_actionability_evidence",
    status,
    summary: status === "passed"
      ? "every plugin actionability level is backed by setup, pack, MCP, or channel evidence"
      : "one or more plugin entries have shallow actionability metadata",
    evidence: { offenders },
  };
}

function caseEverydayCapabilityBreadth(plugins: readonly BuiltinPluginCatalogEntry[]): QaChannelPluginSetupCase {
  const pluginIds = new Set(plugins.flatMap((plugin) => [plugin.id, ...(plugin.aliases ?? [])]));
  const required = {
    channels: ["telegram", "slack", "google-chat", "discord", "whatsapp", "teams"],
    personalOps: ["daily-ops", "google-workspace", "notion", "obsidian"],
    officeArtifacts: ["artifact-studio"],
    developerOps: ["developer-tools", "web-frameworks", "github", "browser"],
    enterpriseApps: ["frappe-federated-bridge", "data-analytics"],
    retrievalAndResearch: ["web-search", "research-lab", "mcp-bridge"],
    providers: ["openai", "anthropic", "gemini", "openrouter", "groq", "huggingface-provider"],
    memory: ["memory-mem0", "memory-supermemory", "memory-lancedb", "active-memory"],
  } satisfies Record<string, readonly string[]>;
  const missing = Object.fromEntries(
    Object.entries(required)
      .map(([group, ids]) => [group, ids.filter((id) => !pluginIds.has(id))])
      .filter(([, ids]) => (ids as string[]).length),
  );
  const categoryCounts = plugins.reduce<Record<string, number>>((counts, plugin) => {
    counts[plugin.category] = (counts[plugin.category] ?? 0) + 1;
    return counts;
  }, {});
  const status: RuntimeDoctorStatus = Object.keys(missing).length ? "failed" : "passed";
  return {
    id: "everyday_capability_breadth",
    status,
    summary: status === "passed"
      ? "everyday channels, personal ops, office artifacts, developer, enterprise, research, provider, and memory surfaces are discoverable"
      : "catalog is missing one or more required everyday capability surfaces",
    evidence: { missing, categoryCounts },
  };
}

function caseSkillCatalogBreadth(skills: readonly BuiltinSkillCatalogEntry[]): QaChannelPluginSetupCase {
  const requiredCategories = [
    "software-development",
    "github",
    "autonomous-ai-agents",
    "mcp",
    "productivity",
    "research",
    "artifacts",
    "security",
    "data-science",
    "web-development",
    "quality",
  ];
  const categories = new Set(skills.map((skill) => skill.category));
  const missingCategories = requiredCategories.filter((category) => !categories.has(category));
  const shallow = skills.filter((skill) => skill.description.trim().length < 24 || !skill.tags.length).map((skill) => skill.id);
  const duplicateIds = duplicateValues(skills.map((skill) => skill.id));
  const status: RuntimeDoctorStatus = missingCategories.length || shallow.length || duplicateIds.length ? "failed" : "passed";
  return {
    id: "skill_catalog_breadth",
    status,
    summary: status === "passed"
      ? "built-in skill catalog covers core work families with tagged, non-duplicate entries"
      : "built-in skill catalog has missing families, shallow entries, or duplicate ids",
    evidence: {
      skillCount: skills.length,
      missingCategories,
      shallow,
      duplicateIds,
      categoryCounts: [...categories].sort().map((category) => ({
        category,
        count: skills.filter((skill) => skill.category === category).length,
      })),
    },
  };
}

function caseMcpAuthAndInstallDepth(mcps: ReturnType<typeof listBuiltinMcpServers>): QaChannelPluginSetupCase {
  const offenders = mcps.filter((mcp) => {
    if (mcp.description.trim().length < 24) return true;
    if ((mcp.auth === "api_key" || mcp.auth === "oauth") && !(mcp.setupUrls?.length)) return true;
    if (mcp.auth === "api_key" && !(mcp.requiresEnv?.length || mcp.requiresAnyEnv?.length)) return true;
    if (mcp.auth === "oauth" && !(mcp.install?.auth === "oauth" || mcp.setupUrls?.length)) return true;
    return !(mcp.install || mcp.setupUrls?.length || mcp.commandHint);
  }).map((mcp) => ({
    id: mcp.id,
    auth: mcp.auth ?? "none",
    hasInstall: Boolean(mcp.install),
    setupUrls: mcp.setupUrls ?? [],
    requiresEnv: mcp.requiresEnv ?? [],
    requiresAnyEnv: mcp.requiresAnyEnv ?? [],
  }));
  const status: RuntimeDoctorStatus = offenders.length ? "failed" : "passed";
  return {
    id: "mcp_auth_install_depth",
    status,
    summary: status === "passed"
      ? "MCP catalog entries expose auth, install, setup, and env guidance consistently"
      : "one or more MCP entries lack auth/install/setup depth",
    evidence: { offenders },
  };
}

function caseSetupGuidance(
  plugins: readonly BuiltinPluginCatalogEntry[],
  id: string,
  expectation: { readonly needsSetupUrl?: boolean; readonly needsMcp?: boolean; readonly needsChannel?: boolean; readonly needsPack?: boolean },
): QaChannelPluginSetupCase {
  const plugin = plugins.find((candidate) => candidate.id === id || candidate.aliases?.includes(id));
  const missing: string[] = [];
  if (!plugin) missing.push("plugin");
  if (expectation.needsSetupUrl && !plugin?.setup?.setupUrls?.length) missing.push("setup_url");
  if (expectation.needsMcp && !(plugin?.setup?.mcpServers?.length || plugin?.setup?.defaultMcpServers?.length)) missing.push("mcp_guidance");
  if (expectation.needsChannel && !plugin?.setup?.channels?.length) missing.push("channel_guidance");
  if (expectation.needsPack && !plugin?.packPath) missing.push("pack_path");
  const status: RuntimeDoctorStatus = missing.length ? "failed" : "passed";
  return {
    id: `setup_guidance_${id}`,
    status,
    summary: status === "passed" ? `${id} exposes guided setup metadata` : `${id} is missing setup metadata`,
    evidence: {
      id,
      missing,
      actionability: plugin?.actionability,
      setupUrls: plugin?.setup?.setupUrls ?? [],
      channels: plugin?.setup?.channels ?? [],
      mcpServers: [...(plugin?.setup?.defaultMcpServers ?? []), ...(plugin?.setup?.mcpServers ?? [])],
      packPath: plugin?.packPath,
    },
  };
}

async function caseHighRiskRefusal(cwd: string, plugins: readonly BuiltinPluginCatalogEntry[]): Promise<QaChannelPluginSetupCase> {
  const highRisk = plugins.find((plugin) => plugin.risk === "high");
  if (!highRisk) {
    return { id: "high_risk_refusal", status: "failed", summary: "no high-risk plugin exists to test refusal", evidence: {} };
  }
  let refused = false;
  let message = "";
  try {
    await enableBuiltinPlugin(highRisk.id, cwd);
  } catch (error) {
    refused = true;
    message = error instanceof Error ? error.message : String(error);
  }
  return {
    id: "high_risk_refusal",
    status: refused && message.includes("--allow-high-risk") ? "passed" : "failed",
    summary: refused ? "high-risk plugin enable requires an explicit flag" : "high-risk plugin enabled without explicit flag",
    evidence: { plugin: highRisk.id, refused, message },
  };
}

async function caseEnableDisablePolicy(cwd: string, pluginId: string): Promise<QaChannelPluginSetupCase> {
  const enabled = await enableBuiltinPlugin(pluginId, cwd, { allowHighRisk: true });
  const enabledConfig = await loadConfig(cwd);
  await disableBuiltinPlugin(pluginId, cwd);
  const disabledConfig = await loadConfig(cwd);
  const wasAllowed = enabledConfig.plugins?.allow?.includes(enabled.id) ?? false;
  const wasEnabled = enabledConfig.plugins?.entries?.[enabled.id]?.enabled === true;
  const isDisabled = disabledConfig.plugins?.entries?.[enabled.id]?.enabled === false;
  const allowRemoved = !(disabledConfig.plugins?.allow?.includes(enabled.id) ?? false);
  const packPathLoaded = enabled.packPath ? (enabledConfig.plugins?.load?.paths ?? []).some((path) => path.includes(enabled.packPath!)) : true;
  const status: RuntimeDoctorStatus = wasAllowed && wasEnabled && isDisabled && allowRemoved && packPathLoaded ? "passed" : "failed";
  return {
    id: "enable_disable_policy",
    status,
    summary: status === "passed" ? "plugin enable/disable updates allowlist, entry state, and pack load path" : "plugin enable/disable policy state is inconsistent",
    evidence: { plugin: enabled.id, wasAllowed, wasEnabled, isDisabled, allowRemoved, packPathLoaded },
  };
}

function caseMcpInstallGuidance(mcps: ReturnType<typeof listBuiltinMcpServers>): QaChannelPluginSetupCase {
  const required = ["browser", "github", "notion", "parallel-search"];
  const entries = required.map((id) => mcps.find((mcp) => mcp.id === id));
  const missing = required.filter((_, index) => !entries[index]);
  const withoutSetup = entries.filter((entry) => entry && !entry.install && !entry.setupUrls?.length).map((entry) => entry!.id);
  const oauthWithoutUrl = entries.filter((entry) => entry?.auth === "oauth" && !entry.setupUrls?.length).map((entry) => entry!.id);
  const status: RuntimeDoctorStatus = missing.length || withoutSetup.length || oauthWithoutUrl.length ? "failed" : "passed";
  return {
    id: "mcp_install_guidance",
    status,
    summary: status === "passed" ? "key MCP entries expose install specs or setup URLs" : "key MCP entries lack install/setup guidance",
    evidence: { missing, withoutSetup, oauthWithoutUrl },
  };
}

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function catalogPluginSnapshot(plugin: BuiltinPluginCatalogEntry): Record<string, unknown> {
  return {
    id: plugin.id,
    aliases: plugin.aliases ?? [],
    category: plugin.category,
    source: plugin.source,
    risk: plugin.risk,
    actionability: plugin.actionability,
    slot: plugin.slot,
    packPath: plugin.packPath,
    setup: plugin.setup ?? {},
  };
}
