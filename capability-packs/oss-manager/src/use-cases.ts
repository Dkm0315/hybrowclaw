import type {
  ChangeCategory,
  DeploymentProfile,
  DiffClassification,
  EngineId,
  JsonValue,
  QaSuiteContract,
  QaSuiteEngineId,
  QaUseCaseFamily,
  QaUseCasePlan,
  QaUseCaseRisk,
  QaUseCaseSelection,
} from "./types.js";
import { HYBROWLABS_SUITE_MANIFEST_V2 } from "./suite-catalog.generated.js";
import { asRecord, requiredString, sha256, uniqueSorted } from "./utils.js";

export const OSS_MANAGER_SUITE_CATALOG_VERSION = "oss-manager-qa-suites-v3";

const READ_ONLY_EVIDENCE = ["suite_receipt", "semantic_assertion", "independent_probe", "source_sha"] as const;
const MUTATION_EVIDENCE = [...READ_ONLY_EVIDENCE, "registered_compensation", "post_restore_proof"] as const;

function suite(
  engine: QaSuiteEngineId,
  name: string,
  scopes: readonly string[],
  risk: QaUseCaseRisk = "read_only",
  commandIds: readonly string[] = [],
): QaSuiteContract {
  const id = `${engine}:${name}:${scopes.join(",")}`;
  const family = familyForSuite(name);
  const evidenceRequired = risk === "mutation_gated" ? MUTATION_EVIDENCE : READ_ONLY_EVIDENCE;
  const expected: JsonValue = commandIds.length
    ? { commandExitCodes: Object.fromEntries(uniqueSorted(commandIds).map((commandId) => [commandId, 0])) }
    : { contractSatisfied: true };
  return {
    id,
    engine,
    suite: name,
    scopes,
    family,
    risk,
    approvalRequired: risk !== "read_only",
    compensationRequired: risk === "mutation_gated",
    commandIds,
    evidenceRequired,
    validator: {
      id: `validator:${id}`,
      owner: {
        kind: "feature_suite",
        feature: family,
        suiteContractId: id,
      },
      operator: "deep_equal",
      expected,
      evidenceRequired,
      terminal: true,
      deployment: {
        required: risk === "mutation_gated",
        postDeploymentFamilies: risk === "mutation_gated" ? ["health_status"] : [],
      },
    },
  };
}

function group(
  engine: QaSuiteEngineId,
  scopes: readonly string[],
  names: readonly string[],
  risk: QaUseCaseRisk = "read_only",
): QaSuiteContract[] {
  return names.map((name) => suite(engine, name, scopes, risk));
}

/**
 * Exact sanitized contract for the reviewed source manifest. Registry IDs are
 * retained so removing a command cannot pass validation; execution text is not.
 */
export const HYBROWLABS_SUITE_CATALOG: readonly QaSuiteContract[] = HYBROWLABS_SUITE_MANIFEST_V2.map((item) => suite(
  item.engine,
  item.suite,
  item.configScope.split(",").map((scope) => scope.trim()),
  item.destructive ? "destructive_plan" : item.requiresAllowApply || !item.safe ? "mutation_gated" : "read_only",
  item.commandIds,
));

const GENERIC_SUITE_NAMES = ["plan", "status", "status_refresh", "status_refresh_all", "backup", "restore_validate"] as const;

const FAMILY_SIGNALS: readonly [QaUseCaseFamily, RegExp][] = [
  ["deployment", /(^|[/_.-])(?:apply|install|deploy|provision|bootstrap)([/_.-]|$)/i],
  ["diagnostics", /(^|[/_.-])(?:status|rotation|logs?|diagnostic|output|memory|activity|locks?|query[_-]?stats|vacuum|pooler|support)([/_.-]|$)/i],
  ["backup_restore", /(^|[/_.-])(?:backup|snapshot)([/_.-]|$)/i],
  ["recovery", /(^|[/_.-])(?:restore|recovery|repair|rollback)([/_.-]|$)/i],
  ["high_availability", /(^|[/_.-])(?:sentinel|failover|patroni|active[_-]?active|pgactive|replica|replication|shard|cluster)([/_.-]|$)/i],
  ["disaster_recovery", /(^|[/_.-])(?:dr|disaster|failback)([/_.-]|$)/i],
  ["migration", /(^|[/_.-])(?:migration|migrate|pglogical|oracle|fdw|cutover)([/_.-]|$)/i],
  ["security", /(^|[/_.-])(?:security|tls|ssl|auth|roles?|acl|permissions?|secrets?|password)([/_.-]|$)/i],
  ["scale_upgrade", /(^|[/_.-])(?:scale|upgrade|capacity)([/_.-]|$)/i],
  ["integrations", /(^|[/_.-])(?:connect|schema[_-]?registry|integration)([/_.-]|$)/i],
  ["observability", /(^|[/_.-])(?:observability|metrics?|alerts?|dashboard|export)([/_.-]|$)/i],
  ["destructive_dry_run", /(^|[/_.-])(?:destroy|destructive)([/_.-]|$)/i],
];

const ADJACENT_FAMILIES: Readonly<Partial<Record<QaUseCaseFamily, readonly QaUseCaseFamily[]>>> = {
  deployment: ["configuration", "health_status", "backup_restore", "recovery"],
  diagnostics: ["health_status"],
  backup_restore: ["recovery", "health_status"],
  recovery: ["backup_restore", "health_status"],
  high_availability: ["health_status", "recovery", "backup_restore", "diagnostics"],
  disaster_recovery: ["health_status", "recovery", "backup_restore", "high_availability"],
  migration: ["health_status", "recovery", "backup_restore", "security"],
  security: ["configuration", "health_status"],
  scale_upgrade: ["configuration", "health_status", "backup_restore"],
  integrations: ["health_status", "security"],
  observability: ["health_status", "diagnostics"],
  destructive_dry_run: ["configuration", "health_status", "backup_restore", "recovery"],
};

export function selectUseCases(
  profile: DeploymentProfile,
  classification: DiffClassification,
  sourceSha: string,
): QaUseCasePlan {
  const catalog = profile.id === "hybrowlabs-oss-manager" ? HYBROWLABS_SUITE_CATALOG : genericCatalog(profile.enabledEngines);
  const catalogVersion = profile.id === "hybrowlabs-oss-manager" ? OSS_MANAGER_SUITE_CATALOG_VERSION : "generic-typed-suites-v2";
  const selected: QaUseCaseSelection[] = [];
  const baseline = catalog.find((item) => item.engine === "all" && item.suite === "baseline");
  if (baseline) selected.push(selectionFor(baseline, undefined, "contract", "Locked source baseline is required for every plan."));

  if (!["NO_CHANGE", "DOCUMENTATION_ONLY", "TEST_ONLY"].includes(classification.impact)) {
    const globalPaths = classification.files.filter((file) => !file.engines.length).map((file) => file.path);
    const globalFamilies = familiesFor(globalPaths, classification.files.flatMap((file) => file.categories));
    for (const targetEngine of classification.engines) {
      const suiteEngine: QaSuiteEngineId = targetEngine === "sentinel" ? "redis" : targetEngine;
      const enginePaths = classification.files.filter((file) => file.engines.includes(targetEngine)).map((file) => file.path);
      const directFamilies = familiesFor([...globalPaths, ...enginePaths], classification.files
        .filter((file) => !file.engines.length || file.engines.includes(targetEngine))
        .flatMap((file) => file.categories));
      globalFamilies.forEach((family) => directFamilies.add(family));
      directFamilies.add("configuration");
      directFamilies.add("health_status");
      const adjacent = new Set<QaUseCaseFamily>();
      for (const family of directFamilies) for (const item of ADJACENT_FAMILIES[family] ?? []) adjacent.add(item);
      const candidates = catalog.filter((contract) => contract.engine === suiteEngine);
      for (const contract of candidates) {
        if (!directFamilies.has(contract.family) && !adjacent.has(contract.family)) continue;
        const mode = directFamilies.has(contract.family) ? "direct" : "adjacent";
        const reason = mode === "direct"
          ? `${targetEngine} source paths require ${contract.family.replaceAll("_", " ")} coverage.`
          : `${contract.family.replaceAll("_", " ")} is an adjacent regression for changed ${targetEngine} behavior.`;
        selected.push(selectionFor(contract, targetEngine, mode, reason));
      }
    }
  }

  const deduped = [...new Map(selected.map((item) => [item.selectionId, item])).values()]
    .sort((left, right) => left.selectionId.localeCompare(right.selectionId));
  assertDeploymentValidationCoverage(deduped);
  return {
    catalogVersion,
    catalogDigest: sha256(catalog),
    sourceSha,
    profileId: profile.id,
    selected: deduped,
    readOnlyCount: deduped.filter((item) => item.risk === "read_only").length,
    gatedCount: deduped.filter((item) => item.approvalRequired).length,
  };
}

function assertDeploymentValidationCoverage(selected: readonly QaUseCaseSelection[]): void {
  for (const deployment of selected.filter((item) => item.validator.deployment.required)) {
    for (const family of deployment.validator.deployment.postDeploymentFamilies) {
      const covered = selected.some((candidate) => candidate.selectionId !== deployment.selectionId
        && candidate.targetEngine === deployment.targetEngine
        && candidate.family === family);
      if (!covered) {
        throw new Error(`Mutation-gated suite ${deployment.selectionId} lacks required post-deployment ${family} validation coverage.`);
      }
    }
  }
}

export function suiteCatalogReport(profileId = "hybrowlabs-oss-manager") {
  if (profileId !== "hybrowlabs-oss-manager") throw new Error(`No source-manifest reference catalog is bundled for profile ${profileId}.`);
  return {
    profileId,
    version: OSS_MANAGER_SUITE_CATALOG_VERSION,
    digest: sha256(HYBROWLABS_SUITE_CATALOG),
    count: HYBROWLABS_SUITE_CATALOG.length,
    commandIdCount: HYBROWLABS_SUITE_CATALOG.reduce((total, item) => total + item.commandIds.length, 0),
    validatorCount: HYBROWLABS_SUITE_CATALOG.filter((item) => item.validator.owner.suiteContractId === item.id).length,
    contracts: HYBROWLABS_SUITE_CATALOG,
    containsCommands: false,
  };
}

export function validateSuiteManifestFromArgs(args: Record<string, unknown>) {
  const profileId = typeof args.profileId === "string" && args.profileId.trim() ? args.profileId.trim() : "hybrowlabs-oss-manager";
  if (profileId !== "hybrowlabs-oss-manager") throw new Error(`No source-manifest reference catalog is bundled for profile ${profileId}.`);
  const manifest = asRecord(args.manifest, "manifest");
  const sourceSha = requiredString(manifest.sourceSha, "manifest.sourceSha").toLowerCase();
  if (!/^[a-f0-9]{7,64}$/.test(sourceSha)) throw new Error("manifest.sourceSha must be a Git object id.");
  const version = manifest.version;
  if (!Number.isInteger(version) || Number(version) < 1) throw new Error("manifest.version must be a positive integer.");
  if (!Array.isArray(manifest.suites)) throw new Error("manifest.suites must be an array of sanitized suite metadata.");
  const suites = manifest.suites.map((value, index) => normalizeManifestSuite(value, index));
  const expected = new Map(HYBROWLABS_SUITE_CATALOG.map((item) => [contractKey(item), item]));
  const observed = new Map(suites.map((item) => [contractKey(item), item]));
  const missing = [...expected.keys()].filter((key) => !observed.has(key)).sort();
  const extra = [...observed.keys()].filter((key) => !expected.has(key)).sort();
  const mismatched = [...expected.entries()].flatMap(([key, contract]) => {
    const item = observed.get(key);
    if (!item) return [];
    const expectedSafe = contract.risk !== "mutation_gated";
    const expectedApply = contract.risk === "mutation_gated";
    const expectedDestructive = contract.risk === "destructive_plan";
    const expectedCommandIds = uniqueSorted(contract.commandIds);
    const commandIdsMatch = item.commandIds.length === expectedCommandIds.length
      && item.commandIds.every((id, index) => id === expectedCommandIds[index]);
    return item.safe === expectedSafe
      && item.requiresAllowApply === expectedApply
      && item.destructive === expectedDestructive
      && commandIdsMatch
      ? []
      : [{
        key,
        expected: {
          safe: expectedSafe,
          requiresAllowApply: expectedApply,
          destructive: expectedDestructive,
          commandIds: expectedCommandIds,
        },
        observed: item,
      }];
  });
  return {
    verdict: missing.length || extra.length || mismatched.length ? "INCONCLUSIVE" : "PASS",
    profileId,
    sourceSha,
    version,
    suiteCount: suites.length,
    commandIdCount: suites.reduce((total, item) => total + item.commandIds.length, 0),
    manifestDigest: sha256({ sourceSha, version, suites }),
    catalogDigest: sha256(HYBROWLABS_SUITE_CATALOG),
    drift: { missing, extra, mismatched },
    guarantees: ["metadata_only", "no_raw_commands", "reviewed_command_ids", "source_sha_bound", "unknown_drift_is_inconclusive"],
  };
}

function familyForSuite(name: string): QaUseCaseFamily {
  if (name === "baseline") return "baseline";
  if (["os_tune_check", "plan", "preflight", "prereq"].includes(name)) return "configuration";
  if (["os_tune_apply", "apply"].includes(name)) return "deployment";
  if (name === "status" || name.startsWith("status_refresh") || name === "health") return "health_status";
  if (["memory", "runtime_diagnostics", "activity", "locks", "query_stats", "vacuum_health", "pooler_status", "connection_info", "broker", "support"].includes(name)) return "diagnostics";
  if (name === "backup") return "backup_restore";
  if (["restore_validate", "recovery", "repair", "repair_validate"].includes(name)) return "recovery";
  if (["patroni_ha_validate", "active_active_validate", "failover_validate"].includes(name)) return "high_availability";
  if (name.startsWith("dr_")) return "disaster_recovery";
  if (name === "migration_validate") return "migration";
  if (["security", "user_security", "schema_registry", "extensions_validate", "tls_validate"].includes(name)) return "security";
  if (["scale_plan", "upgrade_plan"].includes(name)) return "scale_upgrade";
  if (name === "connect") return "integrations";
  if (["dashboard", "export"].includes(name)) return "observability";
  return "destructive_dry_run";
}

function genericCatalog(engines: readonly EngineId[]): QaSuiteContract[] {
  return [
    suite("all", "baseline", ["all"]),
    ...engines.flatMap((engine) => group(engine === "sentinel" ? "redis" : engine, ["runtime"], GENERIC_SUITE_NAMES)),
  ];
}

function familiesFor(paths: readonly string[], categories: readonly ChangeCategory[]): Set<QaUseCaseFamily> {
  const text = paths.join("\n");
  const families = new Set<QaUseCaseFamily>();
  for (const [family, pattern] of FAMILY_SIGNALS) if (pattern.test(text)) families.add(family);
  if (categories.includes("security")) families.add("security");
  if (categories.includes("schema")) families.add("migration");
  return families;
}

function selectionFor(
  contract: QaSuiteContract,
  targetEngine: EngineId | undefined,
  selection: "direct" | "adjacent" | "contract",
  reason: string,
) {
  return {
    ...contract,
    selectionId: `${targetEngine ?? "all"}:${contract.id}`,
    targetEngine,
    selection,
    dispatch: contract.risk === "mutation_gated"
      ? "approval_compensation_adapter_required" as const
      : contract.risk === "destructive_plan"
        ? "approval_adapter_required" as const
        : "typed_adapter_required" as const,
    blockedReason: contract.risk === "mutation_gated"
      ? "Reviewed deployment adapter and exact compensation binding are not bundled in this pack."
      : undefined,
    reason,
  };
}

function normalizeManifestSuite(value: unknown, index: number) {
  const item = asRecord(value, `manifest.suites[${index}]`);
  for (const forbidden of ["command", "commands", "cmd", "shell", "script", "argv"]) {
    if (forbidden in item) throw new Error(`manifest.suites[${index}] contains forbidden raw execution field ${forbidden}; provide commandIds only.`);
  }
  const engine = requiredString(item.engine, `manifest.suites[${index}].engine`) as QaSuiteEngineId;
  if (!new Set(["all", "redis", "valkey", "postgres", "mongo", "kafka", "qdrant", "observability"]).has(engine)) {
    throw new Error(`manifest.suites[${index}].engine is unsupported: ${engine}.`);
  }
  const suiteName = requiredString(item.suite, `manifest.suites[${index}].suite`);
  const configScope = requiredString(item.configScope ?? item.config_scope, `manifest.suites[${index}].configScope`);
  const safe = booleanValue(item.safe, `manifest.suites[${index}].safe`);
  const requiresAllowApply = item.requiresAllowApply === undefined && item.requires_allow_apply === undefined
    ? false
    : booleanValue(item.requiresAllowApply ?? item.requires_allow_apply, `manifest.suites[${index}].requiresAllowApply`);
  const destructive = item.destructive === undefined ? false : booleanValue(item.destructive, `manifest.suites[${index}].destructive`);
  const commandIds = item.commandIds === undefined ? [] : stringIds(item.commandIds, `manifest.suites[${index}].commandIds`);
  return {
    engine,
    suite: suiteName,
    scopes: uniqueSorted(configScope.split(",").map((part) => part.trim()).filter(Boolean)),
    safe,
    requiresAllowApply,
    destructive,
    commandIds,
  };
}

function contractKey(value: { engine: QaSuiteEngineId; suite: string; scopes: readonly string[] }): string {
  return `${value.engine}:${value.suite}:${[...value.scopes].sort().join(",")}`;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean.`);
  return value;
}

function stringIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(item))) {
    throw new Error(`${label} must contain registry command IDs only.`);
  }
  return uniqueSorted(value);
}
