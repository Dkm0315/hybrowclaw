import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addCodexCliProvider, addOpenAICompatibleProvider, DEFAULT_CODEX_MODEL, ensureDefaultConfig, loadConfig, setRuntimeProvider } from "../src/index.js";

test("default config uses Codex CLI and does not seed a local model route", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-config-"));
  const path = await ensureDefaultConfig(cwd);

  const config = await loadConfig(cwd);
  assert.equal(config.providers.codex?.kind, "codex-cli");
  assert.equal(config.providers.codex?.defaultModel, DEFAULT_CODEX_MODEL);
  assert.equal(DEFAULT_CODEX_MODEL, "gpt-5.6-sol", "the seeded model is the one the local codex CLI runs and the one modelHintsForProvider offers");
  assert.equal(config.memory?.policy, "auto", "a fresh profile writes memory freely until onboarding says otherwise");
  assert.equal(config.runtimes.native?.provider, "codex");
  assert.equal(config.runtimes.native?.routes.simple_qa?.provider, "codex");
  assert.equal(config.runtimes.native?.routes.simple_qa?.model, DEFAULT_CODEX_MODEL);
  assert.equal(config.routing.preferLocalForSensitive, false);
  assert.equal(config.providers.local, undefined);
  assert.doesNotMatch(JSON.stringify(config), /"local"/);
  assert.equal((await stat(join(cwd, ".muster"))).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("legacy local model configs are normalized back to Codex on load", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-config-"));
  const configDir = join(cwd, ".muster");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "config.json"), JSON.stringify({
    version: 1,
    providers: {
      local: {
        id: "local",
        kind: "openai-compatible",
        baseUrl: `http://localhost:${11_434}/v1`,
        defaultModel: ["llama", "3.1"].join(""),
        timeoutMs: 120_000,
      },
    },
    runtimes: {
      native: {
        id: "native",
        enabled: true,
        provider: "local",
        routes: {
          simple_qa: { provider: "local", model: ["llama", "3.1"].join(""), reasoning: "low" },
          research: { provider: "local", model: ["llama", "3.1"].join(""), reasoning: "medium" },
        },
      },
    },
    routing: {
      oneRuntimePerRun: true,
      defaultRuntime: "native",
      preferLocalForSensitive: true,
      maxCostUsdPerRun: 1,
      approvalRequiredAboveUsd: 3,
    },
  }), "utf8");

  const config = await loadConfig(cwd);
  assert.equal(config.providers.local, undefined);
  assert.equal(config.providers.codex?.kind, "codex-cli");
  assert.equal(config.runtimes.native.provider, "codex");
  assert.equal(config.runtimes.native.routes.simple_qa.provider, "codex");
  assert.equal(config.runtimes.native.routes.simple_qa.model, DEFAULT_CODEX_MODEL);
  assert.equal(config.routing.preferLocalForSensitive, false);
});

test("addOpenAICompatibleProvider persists a provider", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-config-"));
  await ensureDefaultConfig(cwd);

  await addOpenAICompatibleProvider(
    {
      id: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1/",
      defaultModel: "openai/gpt-5-mini",
      apiKeyEnv: "OPENROUTER_API_KEY"
    },
    cwd
  );

  const config = await loadConfig(cwd);
  assert.equal(config.providers.openrouter?.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(config.providers.openrouter?.defaultModel, "openai/gpt-5-mini");
  assert.equal(config.providers.openrouter?.apiKeyEnv, "OPENROUTER_API_KEY");
});

test("addOpenAICompatibleProvider rejects unsafe provider ids", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-config-"));
  await ensureDefaultConfig(cwd);

  await assert.rejects(
    addOpenAICompatibleProvider(
      {
        id: "../bad",
        baseUrl: "http://127.0.0.1:9900/v1",
        defaultModel: "custom-model"
      },
      cwd
    ),
    /Provider id/
  );
});

test("addCodexCliProvider persists a local Codex CLI provider", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-config-"));
  await ensureDefaultConfig(cwd);

  await addCodexCliProvider({ id: "codex", defaultModel: "o4-mini" }, cwd);

  const config = await loadConfig(cwd);
  assert.equal(config.providers.codex?.kind, "codex-cli");
  assert.equal(config.providers.codex?.defaultModel, "o4-mini");
});

test("setRuntimeProvider repoints runtime routes to a provider", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-config-"));
  await ensureDefaultConfig(cwd);
  await addCodexCliProvider({ id: "codex", defaultModel: "o4-mini" }, cwd);

  await setRuntimeProvider({ runtimeId: "native", providerId: "codex" }, cwd);

  const config = await loadConfig(cwd);
  assert.equal(config.runtimes.native?.provider, "codex");
  assert.equal(config.runtimes.native?.routes.architecture?.provider, "codex");
  assert.equal(config.runtimes.native?.routes.architecture?.model, "o4-mini");
});
