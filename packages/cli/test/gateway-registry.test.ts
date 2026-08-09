import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { defaultConfig, type FlowToolRegistry, type MusterConfig } from "@musterhq/core";
import { loadConfiguredGatewayPacks, startConfiguredFrappeIndexing } from "../src/gateway-registry.js";

const frappePack = resolve(import.meta.dirname, "../../../capability-packs/frappe");
const execFileAsync = promisify(execFile);

test.before(async () => {
  await execFileAsync("pnpm", ["--dir", frappePack, "build"], { cwd: resolve(frappePack, "../..") });
});

function configWithFrappe(entry: { readonly enabled?: boolean } | undefined, allow = true): MusterConfig {
  return {
    ...defaultConfig(),
    plugins: {
      load: { paths: [frappePack] },
      ...(allow ? { allow: ["frappe-federated-bridge"] } : {}),
      ...(entry ? { entries: { "frappe-federated-bridge": entry } } : {}),
    },
  };
}

test("gateway loads an explicitly enabled high-risk Frappe pack into the shared registry", async () => {
  const registry: FlowToolRegistry = {};
  const loaded = await loadConfiguredGatewayPacks(configWithFrappe({ enabled: true }), registry);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].manifest.id, "frappe-federated-bridge");
  assert.equal(typeof registry["frappe-federated-bridge__frappe_fast_route"], "function");
});

test("gateway gives the Frappe pack a private local read model when no path is configured", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "muster-gateway-frappe-cache-"));
  try {
    await loadConfiguredGatewayPacks(configWithFrappe({ enabled: true }), {}, { cwd, env: {} });
    assert.equal(existsSync(resolve(cwd, ".muster/data")), true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("gateway rejects a high-risk pack path that lacks explicit persisted enablement", async () => {
  await assert.rejects(
    loadConfiguredGatewayPacks(configWithFrappe(undefined), {}),
    /not explicitly enabled/,
  );
  await assert.rejects(
    loadConfiguredGatewayPacks(configWithFrappe({ enabled: true }, false), {}),
    /not explicitly enabled/,
  );
});

test("gateway skips a configured pack whose policy entry is disabled", async () => {
  const registry: FlowToolRegistry = {};
  const loaded = await loadConfiguredGatewayPacks(configWithFrappe({ enabled: false }), registry);
  assert.deepEqual(loaded, []);
  assert.equal(registry["frappe-federated-bridge__frappe_fast_route"], undefined);
});

test("gateway metadata indexing uses one host OAuth authorization without logging its token", async () => {
  const calls: Record<string, unknown>[] = [];
  const logs: string[] = [];
  const handle = startConfiguredFrappeIndexing({
    "frappe-federated-bridge__frappe_enterprise_sync": async (args) => {
      calls.push(args);
      return { status: "ready", schemaRevision: "abcdef1234567890", requests: 4 };
    },
  }, {
    metadataAuthorizations: async () => [{
      connectionId: "erp",
      site: "https://erp.example.test",
      header: "Bearer private-access-token",
      identity: { site: "https://erp.example.test", user: "person@example.test", roles: ["System Manager"], authMode: "oauth_bearer" },
    }],
  } as never, { intervalMs: 60_000, log: (line) => logs.push(line) });
  handle.stop();
  await handle.ready;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].siteUrl, "https://erp.example.test");
  assert.equal(calls[0].apiToken, "private-access-token");
  assert.equal((calls[0].signal as AbortSignal).aborted, true, "stop aborts an in-flight metadata refresh");
  assert.doesNotMatch(logs.join("\n"), /private-access-token/);
  assert.match(logs.join("\n"), /frappe_index_sync_ready/);
});

test("gateway can defer metadata indexing so startup traffic gets priority", async () => {
  let calls = 0;
  const handle = startConfiguredFrappeIndexing({
    "frappe-federated-bridge__frappe_enterprise_sync": async () => {
      calls += 1;
      return { status: "ready" };
    },
  }, {
    metadataAuthorizations: async () => [],
  } as never, { deferInitialMs: 60_000 });

  handle.stop();
  await handle.ready;
  assert.equal(calls, 0);
});
