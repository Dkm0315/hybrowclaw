import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "@musterhq/core";
import { loadGatewayConfig } from "@musterhq/gateway";
import { applyOnboardingProfile, globalOnboardingProfilePath, onboardingProfilePath, onboardingStateForSelections, runMusterOnboardingTui } from "../src/onboarding-tui.js";

function fakeTtyInput(): PassThrough & NodeJS.ReadStream {
  const input = new PassThrough() as PassThrough & NodeJS.ReadStream & { isRaw: boolean };
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (mode: boolean) => {
    input.isRaw = mode;
    return input;
  };
  return input;
}

function fakeTtyOutput(): { output: PassThrough & NodeJS.WriteStream; read: () => string } {
  const output = new PassThrough() as PassThrough & NodeJS.WriteStream;
  output.isTTY = true;
  output.columns = 100;
  let raw = "";
  output.on("data", (chunk) => {
    raw += chunk.toString("utf8");
  });
  return { output, read: () => raw };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test("onboarding applies real providers, plugins, MCPs, channels, memory policy, and profiles", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-onboarding-apply-"));
  const home = await mkdtemp(join(tmpdir(), "muster-onboarding-home-"));
  const state = onboardingStateForSelections({
    purpose: ["code", "frappe", "research"],
    style: ["speed", "tokens", "privacy"],
    provider: ["codex", "openai", "claude", "selfhosted"],
    integrations: ["frappe", "github", "browser", "web", "mcp", "artifacts"],
    channels: ["slack", "google-chat", "whatsapp"],
    memory: ["project", "preferences", "ask"],
  });

  const applied = await applyOnboardingProfile(state, cwd, home);
  const config = await loadConfig(cwd);
  const gateway = await loadGatewayConfig(cwd);
  const workspaceProfile = JSON.parse(await readFile(onboardingProfilePath(cwd), "utf8")) as {
    configured: string[];
    nextActions: Array<{ id: string; command?: string; url?: string; env?: string[] }>;
  };
  const globalProfile = JSON.parse(await readFile(globalOnboardingProfilePath(home), "utf8")) as {
    lastWorkspaceProfilePath: string;
    configured: string[];
  };

  assert.equal(config.providers.codex?.kind, "codex-cli");
  assert.equal(config.providers.openai?.kind, "openai");
  assert.equal(config.providers.selfhosted, undefined);
  assert.equal(config.runtimes.native.provider, "codex");
  assert.equal(config.runtimes.native.routes.simple_qa.provider, "codex");

  assert.ok(config.plugins?.allow?.includes("frappe-federated-bridge"));
  assert.ok(config.plugins?.allow?.includes("web-frameworks"));
  assert.ok(config.plugins?.allow?.includes("github"));
  assert.ok(config.plugins?.allow?.includes("browser"));
  assert.ok(config.plugins?.allow?.includes("artifact-studio"));
  assert.ok(config.plugins?.load?.paths?.some((path) => /(?:capability|builtin)-packs[\\/]frappe/.test(path)));

  assert.equal(config.tools?.mcp?.servers?.git?.transport.kind, "stdio");
  assert.equal(config.tools?.mcp?.servers?.sqlite?.transport.kind, "stdio");
  assert.equal(config.tools?.mcp?.servers?.browser?.transport.kind, "stdio");
  assert.equal(config.tools?.mcp?.servers?.["parallel-search"]?.transport.kind, "http");
  assert.equal(config.tools?.mcp?.servers?.notion?.auth, "oauth");

  assert.ok(gateway.token);
  assert.ok(applied.gatewayPath?.endsWith(".muster/gateway.json"));
  assert.equal(config.identity?.name, "Muster");
  assert.match(config.identity?.persona ?? "", /scoped memory/);

  assert.ok(workspaceProfile.configured.includes("provider:codex"));
  assert.ok(workspaceProfile.configured.includes("provider:selfhosted:manual"));
  assert.ok(workspaceProfile.configured.includes("channel:slack:gateway-ready"));
  assert.ok(workspaceProfile.nextActions.some((action) => action.id === "slack" && action.env?.includes("SLACK_BOT_TOKEN")));
  assert.ok(workspaceProfile.nextActions.some((action) => action.id === "gchat" && action.command === "muster channels ready gchat --audience https://your-domain.example/v1/adapters/gchat --no-start" && !action.env?.length));
  assert.ok(workspaceProfile.nextActions.some((action) => action.id === "openai" && action.url?.includes("platform.openai.com")));
  assert.ok(workspaceProfile.nextActions.some((action) => action.id === "notion" && action.command === "muster mcp oauth setup notion"));

  assert.equal(globalProfile.lastWorkspaceProfilePath, onboardingProfilePath(cwd));
  assert.ok(globalProfile.configured.includes("memory:scoped-policy"));
});

test("interactive onboarding redraws in one live screen and ignores normal character keys", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-onboarding-redraw-"));
  const input = fakeTtyInput();
  const { output, read } = fakeTtyOutput();
  const running = runMusterOnboardingTui(["--no-chat", "--no-color"], { cwd, input, output });

  await tick();
  input.write("\x1b[B");
  await tick();
  input.write("x");
  await tick();
  input.write("q");

  const result = await running;
  const raw = read();
  assert.equal(result.saved, false);
  assert.match(raw, /\x1b\[\?1049h/, "onboarding should enter the alternate screen to avoid scrollback panes");
  assert.match(raw, /\x1b\[\?1049l/, "onboarding should leave the alternate screen on cleanup");
  assert.equal((raw.match(/Muster onboarding/g) ?? []).length, 2, "initial render plus Down update only; ordinary character keys should not append duplicate frames");
});
