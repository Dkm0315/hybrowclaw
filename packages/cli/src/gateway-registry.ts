import {
  inspectCapabilityPack,
  loadCapabilityPack,
  type FlowToolRegistry,
  type LoadedCapabilityPack,
  type MusterConfig,
} from "@musterhq/core";
import type { FrappeOAuthAuthorization, FrappeOAuthCoordinator } from "@musterhq/gateway";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface GatewayPackLoadOptions {
  readonly cwd?: string;
  readonly log?: (line: string) => void;
  readonly env?: Record<string, string | undefined>;
}

export interface FrappeIndexSyncHandle {
  readonly ready: Promise<void>;
  stop(): void;
}

/** Keep the metadata-only Frappe read model warm without blocking the gateway. */
export function startConfiguredFrappeIndexing(
  registry: FlowToolRegistry,
  coordinator: Pick<FrappeOAuthCoordinator, "metadataAuthorizations"> | undefined,
  options: GatewayPackLoadOptions & { readonly intervalMs?: number; readonly deferInitialMs?: number } = {},
): FrappeIndexSyncHandle {
  const tool = registry["frappe-federated-bridge__frappe_enterprise_sync"];
  if (!tool || !coordinator) return { ready: Promise.resolve(), stop: () => undefined };
  const intervalMs = Math.max(60_000, Math.min(options.intervalMs ?? 300_000, 3_600_000));
  const deferInitialMs = Math.max(0, Math.min(options.deferInitialMs ?? 0, 300_000));
  const abortController = new AbortController();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  const successfulSyncs = new Map<string, number>();
  let settleReady: (() => void) | undefined;
  const ready = new Promise<void>((resolvePromise) => { settleReady = resolvePromise; });
  const sync = async (): Promise<void> => {
    if (stopped || running) return running;
    running = (async () => {
      const authorizations = await coordinator.metadataAuthorizations();
      for (const authorization of authorizations) {
        const apiToken = bearerToken(authorization);
        if (!apiToken) continue;
        const syncCount = successfulSyncs.get(authorization.site) ?? 0;
        const raw = await tool({
          siteUrl: authorization.site,
          apiToken,
          // Hydrate enough schemas to retain at least one representative from
          // every installed module plus the high-traffic operational set. Any
          // other DocType is still hydrated on demand before a live read/write.
          maxHydratedDoctypes: 128,
          full: syncCount > 0 && syncCount % 96 === 0,
          signal: abortController.signal,
        });
        const result = objectValue(raw);
        if (typeof result?.error === "string") {
          options.log?.(`frappe_index_sync_failed site=${authorization.site} detail=${boundedLog(result.error)}`);
          continue;
        }
        successfulSyncs.set(authorization.site, syncCount + 1);
        options.log?.(`frappe_index_sync_ready site=${authorization.site} mode=${String(result?.mode ?? "full")} revision=${String(result?.schemaRevision ?? "unknown").slice(0, 12)} requests=${String(result?.requests ?? "unknown")} changed=${String(result?.changedRecords ?? "all")}`);
      }
    })().catch((error) => {
      options.log?.(`frappe_index_sync_failed detail=${boundedLog(error instanceof Error ? error.message : String(error))}`);
    }).finally(() => {
      running = undefined;
      if (!stopped) {
        timer = setTimeout(() => void sync(), intervalMs);
        timer.unref?.();
      }
    });
    return running;
  };
  const beginInitialSync = (): void => {
    timer = undefined;
    void sync().finally(() => settleReady?.());
  };
  if (deferInitialMs > 0) {
    timer = setTimeout(beginInitialSync, deferInitialMs);
    timer.unref?.();
  } else {
    beginInitialSync();
  }
  return {
    ready,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      abortController.abort();
      if (!running) settleReady?.();
    },
  };
}

/**
 * Load the capability packs that an operator explicitly enabled in policy.
 * High-risk packs require all three persisted signals: load path, allow-list,
 * and entries.<id>.enabled=true. This turns setup into runtime behavior without
 * making an arbitrary filesystem path an ambient execution grant.
 */
export async function loadConfiguredGatewayPacks(
  config: MusterConfig,
  registry: FlowToolRegistry,
  options: GatewayPackLoadOptions = {},
): Promise<readonly LoadedCapabilityPack[]> {
  const policy = config.plugins;
  const paths = [...new Set(policy?.load?.paths ?? [])];
  if (!paths.length) return [];

  const cwd = options.cwd ?? process.cwd();
  const loaded: LoadedCapabilityPack[] = [];
  const slotClaims: Record<string, string> = {};
  for (const configuredPath of paths) {
    const packPath = resolvePackPath(configuredPath, cwd);
    const inspection = await inspectCapabilityPack(packPath);
    if (!inspection.manifest || inspection.status === "blocked") {
      throw new Error(`Configured gateway capability at ${packPath} is blocked: ${inspection.blockers.join("; ")}`);
    }

    const id = inspection.manifest.id;
    if (policy?.entries?.[id]?.enabled === false) {
      options.log?.(`gateway_pack_skipped=${id} reason=disabled`);
      continue;
    }
    const explicitlyEnabled = policy?.entries?.[id]?.enabled === true
      && policy.allow?.includes(id) === true;
    if (inspection.risk === "high" && !explicitlyEnabled) {
      throw new Error(
        `Configured high-risk gateway capability "${id}" is not explicitly enabled in both plugins.allow and plugins.entries.${id}.enabled.`,
      );
    }

    const sourceEnv = options.env ?? process.env;
    const env = id === "frappe-federated-bridge" && !sourceEnv.FRAPPE_READ_MODEL_PATH
      ? {
          ...sourceEnv,
          FRAPPE_READ_MODEL_PATH: defaultFrappeReadModelPath(cwd),
        }
      : sourceEnv;
    if (env.FRAPPE_READ_MODEL_PATH) mkdirSync(dirname(env.FRAPPE_READ_MODEL_PATH), { recursive: true, mode: 0o700 });
    const capability = await loadCapabilityPack(packPath, {
      registry,
      pluginPolicy: policy,
      allowHighRisk: inspection.risk === "high" ? explicitlyEnabled : true,
      slotClaims,
      env,
    });
    loaded.push(capability);
    options.log?.(`gateway_pack_loaded=${id} tools=${capability.toolNames.length}`);
  }
  return loaded;
}

function defaultFrappeReadModelPath(cwd: string): string {
  return resolve(cwd, ".muster", "data", "frappe-read-model.db");
}

function resolvePackPath(input: string, cwd: string): string {
  if (input.startsWith("/")) return resolve(input);
  const candidates = [
    resolve(cwd, input),
    resolve(cwd, "..", input),
    resolve(cwd, "..", "..", input),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function bearerToken(authorization: FrappeOAuthAuthorization): string | undefined {
  const match = /^(?:Bearer|token)\s+(.+)$/i.exec(authorization.header.trim());
  return match?.[1]?.trim() || undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function boundedLog(value: string): string {
  return value.replace(/\b(?:Bearer|token)\s+\S+/gi, "[redacted]").replace(/\s+/g, " ").slice(0, 300);
}
