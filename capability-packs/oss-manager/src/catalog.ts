import type { DeploymentProfile, EngineDescriptor, EngineId, PolicyRole, QaState, TypedOperation } from "./types.js";

export const POLICY_ROLES: readonly PolicyRole[] = [
  {
    id: "release-sentinel",
    purpose: "Lock source identity, classify deterministic change impact, and gate the compiled plan.",
    allowedOperationPrefixes: ["source.", "diff.", "gate."],
    mayPropose: true,
    mayExecute: false,
    mayApprove: true,
    mayAssert: false,
    separationOfDuties: ["Cannot execute infrastructure mutations or certify its own evidence."],
  },
  {
    id: "topology-surveyor",
    purpose: "Discover current topology and capture immutable before/after snapshots.",
    allowedOperationPrefixes: ["topology.", "snapshot.", "proof.", "engine."],
    mayPropose: false,
    mayExecute: false,
    mayApprove: false,
    mayAssert: false,
    separationOfDuties: ["Read-only; cannot mutate a target."],
  },
  {
    id: "engine-specialist",
    purpose: "Select engine invariants and interpret typed engine observations.",
    allowedOperationPrefixes: ["engine.", "observe.", "data.", "matrix."],
    mayPropose: true,
    mayExecute: false,
    mayApprove: false,
    mayAssert: false,
    separationOfDuties: ["Cannot issue shell or certify its own interpretation."],
  },
  {
    id: "typed-executor",
    purpose: "Execute only registry-backed operation IDs with schema-validated parameters.",
    allowedOperationPrefixes: ["source.", "diff.", "topology.", "snapshot.", "gate.", "engine.", "seed.", "fault.", "observe.", "matrix.", "data.", "proof.", "report."],
    mayPropose: false,
    mayExecute: true,
    mayApprove: false,
    mayAssert: false,
    separationOfDuties: ["No arbitrary command, script, argv, or model-generated shell input."],
  },
  {
    id: "invariant-auditor",
    purpose: "Evaluate semantic assertions and independent probes from raw receipts.",
    allowedOperationPrefixes: ["probe.", "assert."],
    mayPropose: false,
    mayExecute: false,
    mayApprove: false,
    mayAssert: true,
    separationOfDuties: ["Must use evidence produced independently of the executor receipt being checked."],
  },
  {
    id: "recovery-controller",
    purpose: "Own the finally path and execute registered compensations in reverse order.",
    allowedOperationPrefixes: ["restore.", "probe."],
    mayPropose: false,
    mayExecute: true,
    mayApprove: false,
    mayAssert: true,
    separationOfDuties: ["Independent of the release sentinel and normal executor lifecycle."],
  },
  {
    id: "human-reporter",
    purpose: "Render concise progress plus complete, access-controlled evidence references.",
    allowedOperationPrefixes: ["report."],
    mayPropose: false,
    mayExecute: false,
    mayApprove: false,
    mayAssert: false,
    separationOfDuties: ["Cannot alter verdicts or omit failed restoration evidence."],
  },
] as const;

const commonMatrix = ["matrix.status", "matrix.status_refresh", "matrix.status_refresh_all", "matrix.rotation", "matrix.logs"] as const;

export const ENGINE_DESCRIPTORS: Readonly<Record<EngineId, EngineDescriptor>> = {
  sentinel: descriptor({
    id: "sentinel",
    title: "Redis Sentinel high availability",
    aliases: ["redis-sentinel", "ha", "failover"],
    modules: ["sentinel", "high-availability", "failover"],
    adjacentModules: ["status", "refresh", "rotation", "logs", "backup", "recovery", "migration"],
    topologyOperation: "engine.sentinel.topology",
    snapshotOperation: "engine.redis.snapshot",
    seedOperation: "engine.redis.seed_fixture",
    cleanupOperation: "engine.redis.cleanup_fixture",
    faultOperation: "fault.service_stop",
    recoverOperation: "restore.service_start",
    observeOperation: "observe.sentinel_failover",
    dataDigestOperation: "data.redis_full_digest",
    commandMatrix: commonMatrix,
    invariants: [
      "Sentinel quorum agrees on one master and the expected replica set.",
      "A controlled master stop produces one bounded failover without split brain.",
      "Every seeded key preserves type, value digest, and TTL within tolerance.",
      "The stopped service is restored and rejoins in an allowed healthy role.",
    ],
  }),
  redis: dataEngine("redis", "Redis", "engine.redis.topology", "engine.redis.snapshot", "engine.redis.seed_fixture", "engine.redis.cleanup_fixture", "observe.redis_recovery", "data.redis_full_digest", ["status", "refresh", "backup", "recovery", "migration"]),
  valkey: dataEngine("valkey", "Valkey", "engine.valkey.topology", "engine.valkey.snapshot", "engine.valkey.seed_fixture", "engine.valkey.cleanup_fixture", "observe.valkey_recovery", "data.valkey_full_digest", ["status", "refresh", "backup", "recovery", "migration"]),
  postgres: dataEngine("postgres", "PostgreSQL", "engine.postgres.topology", "engine.postgres.snapshot", "engine.postgres.seed_fixture", "engine.postgres.cleanup_fixture", "observe.postgres_recovery", "data.postgres_row_digest", ["status", "replication", "backup", "recovery", "migration"]),
  mongo: dataEngine("mongo", "MongoDB", "engine.mongo.topology", "engine.mongo.snapshot", "engine.mongo.seed_fixture", "engine.mongo.cleanup_fixture", "observe.mongo_recovery", "data.mongo_document_digest", ["status", "replica-set", "backup", "recovery", "migration"]),
  kafka: dataEngine("kafka", "Kafka", "engine.kafka.topology", "engine.kafka.snapshot", "engine.kafka.seed_fixture", "engine.kafka.cleanup_fixture", "observe.kafka_recovery", "data.kafka_topic_digest", ["status", "isr", "produce-consume", "recovery", "migration"]),
  qdrant: dataEngine("qdrant", "Qdrant", "engine.qdrant.topology", "engine.qdrant.snapshot", "engine.qdrant.seed_fixture", "engine.qdrant.cleanup_fixture", "observe.qdrant_recovery", "data.qdrant_point_digest", ["status", "collections", "replication", "recovery", "migration"]),
  observability: dataEngine("observability", "Observability pipeline", "engine.observability.topology", "engine.observability.snapshot", "engine.observability.seed_signal", "engine.observability.cleanup_signal", "observe.signal_delivery", "data.observability_signal_digest", ["status", "metrics", "logs", "alerts", "retention"]),
};

export const HYBROWLABS_OSS_MANAGER_PROFILE: DeploymentProfile = {
  id: "hybrowlabs-oss-manager",
  name: "Hybrowlabs OSS Manager (sanitized)",
  repository: "https://github.com/hybrowlabs/OSS-Manager",
  branch: "dev",
  schedule: "0 23 * * *",
  timezone: "Asia/Kolkata",
  enabledEngines: ["sentinel", "redis", "valkey", "postgres", "mongo", "kafka", "qdrant", "observability"],
  pathRules: [
    { prefix: "redis", app: "oss-manager", module: "redis", engines: ["redis", "sentinel"] },
    { prefix: "valkey", app: "oss-manager", module: "valkey", engines: ["valkey"] },
    { prefix: "postgres", app: "oss-manager", module: "postgres", engines: ["postgres"] },
    { prefix: "mongo", app: "oss-manager", module: "mongo", engines: ["mongo"] },
    { prefix: "kafka", app: "oss-manager", module: "kafka", engines: ["kafka"] },
    { prefix: "qdrant", app: "oss-manager", module: "qdrant", engines: ["qdrant"] },
    { prefix: "observability", app: "oss-manager", module: "observability", engines: ["observability"] },
    { prefix: "scripts", app: "oss-manager", module: "automation", engines: [] },
    { prefix: "jenkins", app: "oss-manager", module: "delivery", engines: [] },
  ],
  adjacentModules: {
    status: ["refresh", "refresh-all", "logs"],
    refresh: ["status", "refresh-all", "rotation"],
    "refresh-all": ["status", "refresh", "rotation", "logs"],
    failover: ["status", "refresh", "refresh-all", "rotation", "logs", "data-verify"],
    backup: ["recovery", "data-verify", "status"],
    recovery: ["backup", "data-verify", "status"],
    migration: ["status", "data-verify", "rollback"],
  },
  labels: {
    customerType: "separate-customer-profile",
    execution: "native-muster",
    bridge: "none",
  },
};

export const GENERIC_OSS_QA_PROFILE: DeploymentProfile = {
  id: "generic-oss-qa",
  name: "Generic app and engine QA",
  repository: "configured-at-runtime",
  branch: "configured-at-runtime",
  enabledEngines: ["sentinel", "redis", "valkey", "postgres", "mongo", "kafka", "qdrant", "observability"],
  pathRules: Object.values(ENGINE_DESCRIPTORS).map((engine) => ({
    prefix: engine.id,
    app: "runtime-app",
    module: engine.id,
    engines: [engine.id],
  })),
  adjacentModules: {
    status: ["refresh", "refresh-all", "logs"],
    failover: ["status", "data-verify", "recovery"],
    backup: ["recovery", "data-verify"],
    recovery: ["backup", "status", "data-verify"],
    migration: ["status", "data-verify", "rollback"],
  },
  labels: {
    customerType: "runtime-supplied",
    execution: "native-muster",
    bridge: "none",
  },
};

export const ALLOWED_OPERATION_TYPES = new Set<string>([
  "source.verify_lock",
  "diff.verify_classification",
  "topology.generic_discover",
  "snapshot.generic_capture",
  "gate.approve_plan",
  "seed.fixture",
  "seed.cleanup_fixture",
  "fault.service_stop",
  "restore.service_start",
  "observe.health_recovery",
  "data.full_digest",
  "proof.snapshot_compare",
  "report.render_receipts",
  ...Object.values(ENGINE_DESCRIPTORS).flatMap((engine) => [
    engine.topologyOperation,
    engine.snapshotOperation,
    engine.seedOperation,
    engine.cleanupOperation,
    engine.faultOperation,
    engine.recoverOperation,
    engine.observeOperation,
    engine.dataDigestOperation,
    ...engine.commandMatrix,
  ]),
]);

export function operationRole(state: QaState): TypedOperation["role"] {
  if (state === "SOURCE_LOCK" || state === "DIFF" || state === "GATE") return "release-sentinel";
  if (state === "TOPOLOGY" || state === "BEFORE_SNAPSHOT" || state === "POST_PROOF") return "topology-surveyor";
  if (state === "RESTORE") return "recovery-controller";
  if (state === "REPORT") return "human-reporter";
  return "typed-executor";
}

function descriptor(value: EngineDescriptor): EngineDescriptor {
  return value;
}

function dataEngine(
  id: Exclude<EngineId, "sentinel">,
  title: string,
  topologyOperation: string,
  snapshotOperation: string,
  seedOperation: string,
  cleanupOperation: string,
  observeOperation: string,
  dataDigestOperation: string,
  adjacentModules: readonly string[],
): EngineDescriptor {
  return descriptor({
    id,
    title,
    aliases: [id, title.toLowerCase()],
    modules: [id],
    adjacentModules,
    topologyOperation,
    snapshotOperation,
    seedOperation,
    cleanupOperation,
    faultOperation: "fault.service_stop",
    recoverOperation: "restore.service_start",
    observeOperation,
    dataDigestOperation,
    commandMatrix: commonMatrix,
    invariants: [
      `${title} topology and health match the deployment contract.`,
      "The controlled fault is observed through an independent probe.",
      "Every seeded record preserves type, value digest, and lifecycle metadata.",
      "All registered compensations complete and post-proof matches the allowed baseline.",
    ],
  });
}
