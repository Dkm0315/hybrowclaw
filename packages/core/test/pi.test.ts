import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildPiCliArgs, buildPiInteractiveArgs, buildPiSessionLabel, inspectPiCommands, inspectPiRuntime, inspectPiTools, listPiModels, runPiCliDiagnostic, runPiEmbeddedAgent, runPiInteractive, summarizePiEventTrace } from "../src/index.js";

test("inspectPiRuntime reports missing pi root without throwing", async () => {
  const home = await mkdtemp(join(tmpdir(), "muster-no-pi-"));
  const report = await inspectPiRuntime({ homeDir: home });

  assert.equal(report.installed, false);
  assert.equal(report.integrationMode, "embedded_sdk");
  assert.equal(report.sdkLoadable, true);
  assert.equal(report.missingSdkExports.length, 0);
  assert.equal(typeof report.cliAvailable, "boolean");
  assert.equal(typeof report.npxAvailable, "boolean");
  assert.equal(report.packageName, "@earendil-works/pi-coding-agent");
  assert.equal(report.adapterState, "sdk_ready");
  assert.match(report.nextActions.join("\n"), /createAgentSession/);
});

test("inspectPiRuntime detects workflow and config candidates", async () => {
  const home = await mkdtemp(join(tmpdir(), "muster-pi-"));
  await mkdir(join(home, ".pi", "workflows"), { recursive: true });
  await writeFile(join(home, ".pi", "config.json"), "{}\n", "utf8");
  await writeFile(join(home, ".pi", "workflows", "incident-flow.yaml"), "name: incident\n", "utf8");

  const report = await inspectPiRuntime({ homeDir: home });

  assert.equal(report.installed, true);
  assert.equal(report.adapterState, "sdk_ready_with_pi_home");
  assert.deepEqual(report.configFiles, ["config.json"]);
  assert.deepEqual(report.workflowFiles, ["workflows/incident-flow.yaml"]);
});

test("buildPiCliArgs creates an explicit diagnostic Pi CLI invocation", () => {
  const args = buildPiCliArgs({
    prompt: "Review this repo",
    provider: "openai",
    model: "gpt-4o-mini",
    thinking: "low",
    tools: ["read", "grep"],
    noSession: true
  });

  assert.deepEqual(args, [
    "--mode",
    "text",
    "--print",
    "--no-session",
    "--tools",
    "read,grep",
    "--provider",
    "openai",
    "--model",
    "gpt-4o-mini",
    "--thinking",
    "low",
    "Review this repo"
  ]);
});

test("buildPiInteractiveArgs creates a real Pi TUI invocation without print mode", () => {
  const args = buildPiInteractiveArgs({
    prompt: "Help me inspect the workspace",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    thinking: "medium",
    tools: ["read", "grep"],
    sessionMode: "continue",
    sessionDir: "/tmp/muster-sessions",
    sessionId: "session-123"
  });

  assert.deepEqual(args, [
    "--continue",
    "--session-id",
    "session-123",
    "--session-dir",
    "/tmp/muster-sessions",
    "--tools",
    "read,grep",
    "--provider",
    "anthropic",
    "--model",
    "claude-sonnet-4-5",
    "--thinking",
    "medium",
    "Help me inspect the workspace"
  ]);
  assert.equal(args.includes("--print"), false);
});

test("listPiModels exposes Pi-native provider and model discovery", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "muster-pi-agent-"));
  const models = await listPiModels({ agentDir });

  assert.ok(models.length > 0);
  assert.ok(models.some((model) => model.provider === "anthropic"));
  assert.ok(models.some((model) => model.provider === "openai-codex"));
  assert.ok(models.some((model) => model.id.toLowerCase().includes("claude")));
  for (const model of models.slice(0, 5)) {
    assert.equal(typeof model.available, "boolean");
    assert.equal(typeof model.contextWindow, "number");
    assert.equal(typeof model.maxTokens, "number");
  }
});

test("listPiModels can filter to Claude-capable Anthropic models", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "muster-pi-agent-anthropic-"));
  const models = await listPiModels({ agentDir, provider: "anthropic" });

  assert.ok(models.length > 0);
  assert.ok(models.every((model) => model.provider === "anthropic"));
  assert.ok(models.some((model) => model.id.toLowerCase().includes("claude")));
});

test("inspectPiTools exposes the real Pi tool registry and active allowlist", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-pi-tools-cwd-"));
  const agentDir = join(cwd, ".agent");
  const report = await inspectPiTools({ cwd, agentDir, tools: ["read", "grep"] });

  assert.equal(report.cwd, cwd);
  assert.equal(report.agentDir, agentDir);
  assert.deepEqual(report.activeTools, ["read", "grep"]);
  assert.ok(report.tools.some((tool) => tool.name === "read" && tool.active));
  assert.ok(report.tools.some((tool) => tool.name === "grep" && tool.active));
  assert.ok(report.tools.some((tool) => tool.name === "ls" && !tool.active));
  assert.ok(report.tools.every((tool) => Array.isArray(tool.parameterKeys)));
});

test("inspectPiCommands exposes Pi-native prompt and skill command catalog", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-pi-commands-cwd-"));
  const agentDir = join(cwd, ".agent");
  await mkdir(join(agentDir, "skills", "redis-triage"), { recursive: true });
  await mkdir(join(agentDir, "prompts"), { recursive: true });
  await writeFile(
    join(agentDir, "skills", "redis-triage", "SKILL.md"),
    "---\nname: redis-triage\ndescription: Triage Redis production incidents.\n---\nUse safe Redis diagnostics.\n",
    "utf8"
  );
  await writeFile(
    join(agentDir, "prompts", "incident.md"),
    "---\ndescription: Draft an incident response.\nargument-hint: service name\n---\nDraft response for $ARGUMENTS.\n",
    "utf8"
  );

  const report = await inspectPiCommands({ cwd, agentDir, tools: ["read", "grep"] });

  assert.equal(report.cwd, cwd);
  assert.equal(report.agentDir, agentDir);
  assert.ok(report.commands.some((command) => command.invocation === "/skill:redis-triage" && command.source === "skill"));
  assert.ok(report.commands.some((command) => command.invocation === "/incident" && command.source === "prompt"));
  assert.ok(report.commands.every((command) => command.invocation.startsWith("/")));
});

test("runPiCliDiagnostic invokes an external Pi-compatible command only when requested", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-pi-command-"));
  const command = join(cwd, "fake-pi.sh");
  await writeFile(command, "#!/usr/bin/env bash\nprintf 'pi-output:%s\\n' \"$*\"\n", "utf8");
  await chmod(command, 0o755);

  const result = await runPiCliDiagnostic({
    command,
    prompt: "Say hello",
    cwd,
    tools: ["read"],
    noSession: true
  });

  assert.equal(result.status, "completed");
  assert.equal(result.transport, "cli");
  assert.equal(result.command, command);
  assert.match(result.stdout, /pi-output:/);
  assert.match(result.stdout, /Say hello/);
});

test("runPiInteractive blocks safely in non-interactive test processes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-pi-tui-cwd-"));
  const result = await runPiInteractive({
    cwd,
    prompt: "Open the TUI",
    sessionMode: "memory"
  });

  assert.equal(result.status, "blocked");
  assert.match(result.command, /node/);
  assert.ok(result.args.some((arg) => arg.endsWith("cli.js")));
  assert.match(result.reason ?? "", /requires an attached TTY/);
});

test("runPiEmbeddedAgent returns persistent session metadata even when provider auth fails", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-pi-session-cwd-"));
  const sessionDir = join(cwd, ".sessions");
  const agentDir = join(cwd, ".agent");

  const result = await runPiEmbeddedAgent({
    prompt: "Reply with one word.",
    cwd,
    agentDir,
    sessionDir,
    sessionMode: "create",
    tools: ["read", "grep", "find", "ls"],
    timeoutMs: 10_000
  });

  assert.equal(result.transport, "sdk");
  assert.equal(result.sessionMode, "create");
  assert.equal(result.sessionDir, sessionDir);
  assert.ok(result.sessionId);
  assert.ok(result.sessionFile?.startsWith(sessionDir));
  assert.deepEqual(result.activeTools, ["read", "grep", "find", "ls"]);
  assert.ok(result.eventTrace?.some((event) => event.type === "session_created"));
  assert.ok(result.eventTrace?.some((event) => event.type === "prompt_start"));
  assert.ok(result.eventTrace?.some((event) => event.type === "prompt_end"));
  assert.match(buildPiSessionLabel(result), /mode=create/);
  assert.match(buildPiSessionLabel(result), /tools=read,grep,find,ls/);
  assert.match(summarizePiEventTrace(result.eventTrace ?? []), /session_created/);
  assert.equal(result.fallbackEligible, false, "a submitted Pi prompt must never be replayed");
});

test("runPiEmbeddedAgent marks model-resolution setup failures as fallback-safe", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-pi-safe-fallback-"));
  const result = await runPiEmbeddedAgent({
    prompt: "hello",
    cwd,
    agentDir: join(cwd, ".agent"),
    provider: "provider-that-does-not-exist",
    model: "model-that-does-not-exist",
  });

  assert.equal(result.status, "failed");
  assert.equal(result.fallbackEligible, true);
  assert.ok(!result.eventTrace?.some((event) => event.type === "prompt_start"));
});
