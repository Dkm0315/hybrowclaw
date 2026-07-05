import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applySkillEnvForRun,
  curateSkills,
  exportClaudeSkillSnapshot,
  listSkills,
  promoteSkill,
  recordSkillUse,
  resolveAgentSkillAllowlist,
  selectSkills,
  skillDiscoveryRoots,
  skillsDir,
  skillsIndexPath,
  viewSkill,
  resolveSkillCommand,
  writeCandidateSkill,
  listBuiltinSkills,
  listBuiltinPlugins,
  enableBuiltinSkill,
  ensureDefaultConfig,
  resolveBuiltinCapabilityMentions,
} from "../src/index.js";
import type { EvolveReport } from "../src/index.js";

function report(converged: boolean, tasks = 3): EvolveReport {
  return {
    startedAt: new Date().toISOString(),
    iterations: [{ iteration: 1, passed: converged ? tasks : 0, failed: converged ? 0 : tasks, results: Array.from({ length: tasks }, (_, index) => ({ taskId: `t${index}`, status: converged ? "passed" as const : "failed" as const, durationMs: 1 })) }],
    harnessChecks: [],
    converged,
  };
}

test("built-in skill catalog includes broad Hermes-derived workflows without duplicate ids", () => {
  const catalog = listBuiltinSkills();
  const ids = catalog.map((skill) => skill.id);
  assert.equal(new Set(ids).size, ids.length, "built-in skill ids must be unique");
  for (const id of [
    "apple-notes",
    "github-repo-management",
    "computer-use",
    "ascii-video",
    "manim-video",
    "teams-meeting-pipeline",
    "segment-anything",
    "xurl",
    "openhue",
    "subagent-driven-development",
    "adversarial-ux-test",
    "fastmcp",
    "cloudflare-temporary-deploy",
    "finance-modeling",
  ]) {
    assert.ok(ids.includes(id), `missing Hermes-derived built-in skill: ${id}`);
  }
});

test("enabling a high-risk built-in skill writes a guarded Muster-authored profile", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-builtin-skill-"));
  await ensureDefaultConfig(cwd);
  const entry = await enableBuiltinSkill("imessage", cwd);
  const skill = await viewSkill(entry.id, cwd);

  assert.equal(skill.name, "imessage");
  assert.equal(skill.status, "active");
  assert.equal(skill.frontmatter.userInvocable, true);
  assert.match(skill.body, /not a verbatim upstream copy/);
  assert.match(skill.body, /Ask for confirmation before using credentials/);
});

test("optional built-in skills are not completion-only catalog ghosts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-optional-builtin-skill-"));
  await ensureDefaultConfig(cwd);
  const entry = await enableBuiltinSkill("adversarial-ux-test", cwd);
  const skill = await viewSkill(entry.id, cwd);

  assert.equal(entry.source, "hermes");
  assert.equal(skill.name, "adversarial-ux-test");
  assert.equal(skill.status, "active");
  assert.match(skill.body, /not a verbatim upstream copy/);
});

test("prompt capability mentions resolve to concrete skills, plugins, and MCPs", () => {
  const office = resolveBuiltinCapabilityMentions("Use the artifact plugin to create a PPTX and PDF, then save it to Google Drive.");
  assert.ok(office.some((mention) => mention.kind === "plugin" && mention.id === "artifact-studio"), "artifact-studio plugin should be detected from PPTX/PDF");
  assert.ok(office.some((mention) => mention.kind === "mcp" && mention.id === "google-drive"), "google-drive MCP should be detected");

  const channel = resolveBuiltinCapabilityMentions("Set up the Telegram plugin and Slack channel for this assistant.");
  assert.ok(channel.some((mention) => mention.kind === "plugin" && mention.id === "telegram"), "telegram plugin should be detected");
  assert.ok(channel.some((mention) => mention.kind === "plugin" && mention.id === "slack"), "slack plugin should be detected");

  const skill = resolveBuiltinCapabilityMentions("Use the adversarial UX test skill to break the CLI.");
  assert.ok(skill.some((mention) => mention.kind === "skill" && mention.id === "adversarial-ux-test"), "optional skill should be detected");
});

test("built-in plugin catalog declares honest actionability levels", () => {
  const plugins = listBuiltinPlugins();
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));

  assert.equal(byId.get("slack")?.actionability, "runtime_adapter");
  assert.equal(byId.get("telegram")?.actionability, "runtime_adapter");
  assert.equal(byId.get("mcp-bridge")?.actionability, "mcp_installable");
  assert.equal(byId.get("developer-tools")?.actionability, "mcp_installable");
  assert.equal(byId.get("web-frameworks")?.actionability, "local_tool");
  assert.equal(byId.get("browserbase")?.actionability, "setup_plan");
  assert.equal(byId.get("memory-mem0")?.actionability, "setup_plan");
  assert.equal(byId.get("langfuse")?.actionability, "setup_plan");
  assert.equal(byId.get("matrix")?.actionability, "setup_plan");
  assert.equal(byId.get("provider-gemini")?.actionability, "setup_plan");
  assert.equal(byId.get("provider-groq")?.actionability, "setup_plan");
  assert.equal(byId.get("provider-perplexity")?.actionability, "setup_plan");
  assert.equal(byId.get("signal")?.actionability, "setup_plan");
  assert.equal(byId.get("document-extract")?.actionability, "setup_plan");
  assert.equal(byId.get("qa-lab")?.actionability, "setup_plan");
  assert.equal(byId.get("active-memory")?.actionability, "setup_plan");

  for (const plugin of plugins) {
    assert.ok(plugin.actionability, `plugin ${plugin.id} must declare actionability`);
    if (plugin.setup?.channels?.length) {
      const expected = plugin.packPath ? "runtime_adapter" : "setup_plan";
      assert.equal(plugin.actionability, expected, `channel plugin ${plugin.id} must distinguish bundled adapters from setup-only guides`);
    }
    if (plugin.actionability === "mcp_installable") {
      assert.ok(plugin.setup?.mcpServers?.length || plugin.setup?.defaultMcpServers?.length, `mcp_installable plugin ${plugin.id} needs MCP setup metadata`);
    }
    if (plugin.actionability === "local_tool" || plugin.actionability === "end_to_end_workflow") {
      assert.ok(plugin.packPath, `${plugin.actionability} plugin ${plugin.id} needs a capability pack path`);
    }
  }
});

test("built-in plugin catalog includes source-backed Hermes and OpenClaw breadth without local-provider drift", () => {
  const plugins = listBuiltinPlugins();
  const ids = plugins.map((plugin) => plugin.id);
  assert.equal(new Set(ids).size, ids.length, "built-in plugin ids must be unique");

  for (const id of [
    "provider-perplexity",
    "provider-cohere",
    "provider-azure-foundry",
    "provider-copilot",
    "signal",
    "imessage-channel",
    "nextcloud-talk",
    "feishu",
    "dingtalk",
    "wecom",
    "email-channel",
    "document-extract",
    "file-transfer",
    "webhooks",
    "policy",
    "tokenjuice",
    "diagnostics-otel",
    "voice-call",
    "deepgram",
    "elevenlabs",
    "workboard",
    "qa-lab",
    "qa-matrix",
    "codex-supervisor",
    "migrate-hermes",
    "memory-lancedb",
    "memory-wiki",
    "active-memory",
  ]) {
    assert.ok(ids.includes(id), `missing source-backed built-in plugin: ${id}`);
  }

  const serialized = JSON.stringify(plugins);
  const disallowedLocalRoute = new RegExp(["ol", "lama"].join(""), "i");
  const disallowedLocalModel = new RegExp(["llama", "3"].join(""), "i");
  assert.doesNotMatch(serialized, disallowedLocalRoute);
  assert.doesNotMatch(serialized, disallowedLocalModel);
  assert.doesNotMatch(serialized, new RegExp(`${11_434}`));
});

test("built-in catalog does not hardcode user-specific host connector availability", () => {
  const serialized = JSON.stringify(listBuiltinPlugins());

  assert.doesNotMatch(serialized, /hostConnectors|openai-curated-remote|claude-plugins-official|~\/\.codex|~\/\.claude/);
  assert.match(serialized, /authenticated-app-reuse/);
  assert.match(serialized, /provider plugin manifests/);
});

test("candidates are quarantined and invisible to injection until promoted", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-skills-"));
  await writeCandidateSkill({ name: "deploy-frappe", description: "Deploy a Frappe bench safely", body: "1. backup 2. migrate", sourceRunId: "run_1" }, cwd);
  const candidate = await viewSkill("deploy-frappe", cwd);
  assert.equal(candidate.status, "candidate");
  const selection = await selectSkills("how do I deploy the frappe bench", 500, cwd);
  assert.equal(selection.included.length, 0, "candidates must never inject");
});

test("THE GATE: promotion requires a converged, non-empty eval report", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-skills-gate-"));
  await writeCandidateSkill({ name: "payroll-report", description: "Generate payroll summaries", body: "..." }, cwd);
  await assert.rejects(() => promoteSkill("payroll-report", report(false), cwd), /did not converge/);
  await assert.rejects(() => promoteSkill("payroll-report", report(true, 0), cwd), /empty suite/);
  const promoted = await promoteSkill("payroll-report", report(true), cwd);
  assert.equal(promoted.status, "active");
  assert.equal(promoted.gate?.suiteTasks, 3);
  await assert.rejects(() => promoteSkill("payroll-report", report(true), cwd), /Only candidates/);
  const all = await listSkills(cwd);
  assert.equal(all.length, 1, "promotion moves, not copies");
});

test("top-K injection respects the budget and reports dropped skills", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-skills-topk-"));
  for (let index = 0; index < 12; index += 1) {
    await writeCandidateSkill({ name: `frappe-skill-${index}`, description: `Frappe workflow recipe number ${index} for deployments`, body: "x" }, cwd);
    await promoteSkill(`frappe-skill-${index}`, report(true), cwd);
  }
  const selection = await selectSkills("frappe deployments workflow", 60, cwd);
  assert.ok(selection.included.length >= 1);
  assert.ok(selection.dropped.length >= 1, "over-budget skills are reported, never silent");
  assert.ok(selection.block.includes("[skill:"));
  const unrelated = await selectSkills("completely unrelated cooking question zzz", 500, cwd);
  assert.equal(unrelated.block, "", "no zero-score injection");
});

test("extended frontmatter controls model and command invocation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-skills-frontmatter-"));
  await writeCandidateSkill({
    name: "ops-command",
    description: "Frappe operations command",
    body: "Run the operation.",
    frontmatter: {
      userInvocable: true,
      disableModelInvocation: true,
      commandDispatch: "tool",
      commandTool: "frappe.run",
      commandArgMode: "raw",
      homepage: "https://example.test/ops",
    },
  }, cwd);
  await promoteSkill("ops-command", report(true), cwd);

  const skill = await viewSkill("ops-command", cwd);
  assert.equal(skill.frontmatter.userInvocable, true);
  assert.equal(skill.frontmatter.disableModelInvocation, true);
  assert.equal(skill.frontmatter.commandDispatch, "tool");
  assert.equal(skill.frontmatter.commandTool, "frappe.run");
  assert.equal(skill.frontmatter.commandArgMode, "raw");
  assert.equal(skill.frontmatter.homepage, "https://example.test/ops");

  const selection = await selectSkills("frappe operations command", 500, cwd);
  assert.equal(selection.block, "", "disable-model-invocation keeps command-only skills out of the model prompt");
});

test("metadata.openclaw availability gates filter skills before injection", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-skills-gates-"));
  await writeCandidateSkill({
    name: "frappe-online",
    description: "Frappe online maintenance",
    body: "Requires configured site.",
    openclaw: {
      requires: {
        env: ["FRAPPE_SITE_URL"],
        bins: ["bench"],
      },
      os: [process.platform],
    },
  }, cwd);
  await promoteSkill("frappe-online", report(true), cwd);

  assert.equal((await selectSkills("frappe online maintenance", 500, cwd, {
    env: {},
    binExists: () => true,
  })).block, "");
  assert.equal((await selectSkills("frappe online maintenance", 500, cwd, {
    env: { FRAPPE_SITE_URL: "https://example.test" },
    binExists: () => false,
  })).block, "");

  const selected = await selectSkills("frappe online maintenance", 500, cwd, {
    env: { FRAPPE_SITE_URL: "https://example.test" },
    binExists: (name) => name === "bench",
  });
  assert.deepEqual(selected.included, ["frappe-online"]);
});

test("agent skill allowlists apply to prompt injection and slash commands", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-skills-allowlist-"));
  for (const name of ["github", "weather", "docs-search"]) {
    await writeCandidateSkill({
      name,
      description: `${name} frappe workflow helper`,
      body: `Use ${name}.`,
      frontmatter: { userInvocable: true },
    }, cwd);
    await promoteSkill(name, report(true), cwd);
  }

  const config = {
    agents: {
      defaults: { skills: ["github", "weather"] },
      list: [
        { id: "writer" },
        { id: "docs", skills: ["docs-search"] },
        { id: "locked-down", skills: [] },
      ],
    },
  };

  assert.deepEqual(resolveAgentSkillAllowlist(config, "writer"), ["github", "weather"]);
  assert.deepEqual(resolveAgentSkillAllowlist(config, "docs"), ["docs-search"]);
  assert.deepEqual(resolveAgentSkillAllowlist(config, "locked-down"), []);
  assert.equal(resolveAgentSkillAllowlist({ agents: {} }, "any"), undefined);

  const writerSelection = await selectSkills("frappe workflow github weather docs-search", 500, cwd, {
    skillAllowlist: resolveAgentSkillAllowlist(config, "writer"),
  });
  assert.deepEqual(writerSelection.included.sort(), ["github", "weather"]);
  assert.equal(await resolveSkillCommand("docs-search", "", cwd, {
    skillAllowlist: resolveAgentSkillAllowlist(config, "writer"),
  }), undefined);

  const docsSelection = await selectSkills("frappe workflow github weather docs-search", 500, cwd, {
    skillAllowlist: resolveAgentSkillAllowlist(config, "docs"),
  });
  assert.deepEqual(docsSelection.included, ["docs-search"]);
  assert.equal((await resolveSkillCommand("docs-search", "", cwd, {
    skillAllowlist: resolveAgentSkillAllowlist(config, "docs"),
  }))?.skillName, "docs-search");

  const lockedSelection = await selectSkills("frappe workflow github weather docs-search", 500, cwd, {
    skillAllowlist: resolveAgentSkillAllowlist(config, "locked-down"),
  });
  assert.deepEqual(lockedSelection.included, []);
});

test("layered local discovery is grouped, explicit, and profile-first", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-skills-layered-"));
  await writeCandidateSkill({
    name: "shared-tool",
    description: "Profile pinned shared tool",
    body: "Use the profile version.",
  }, cwd);
  await promoteSkill("shared-tool", report(true), cwd);

  await mkdir(join(cwd, "skills", "ops", "shared-tool"), { recursive: true });
  await writeFile(
    join(cwd, "skills", "ops", "shared-tool", "SKILL.md"),
    "---\nname: shared-tool\ndescription: Workspace lower priority shared tool\n---\n\nWorkspace body.\n",
  );
  await mkdir(join(cwd, ".agents", "skills", "docs", "docs-search"), { recursive: true });
  await writeFile(
    join(cwd, ".agents", "skills", "docs", "docs-search", "SKILL.md"),
    "---\nname: docs-search\ndescription: Docs search grouped workflow\n---\n\nDocs body.\n",
  );
  const extraDir = join(cwd, "vendor-skills");
  await mkdir(join(extraDir, "research", "web-research"), { recursive: true });
  await writeFile(
    join(extraDir, "research", "web-research", "SKILL.md"),
    "---\nname: web-research\ndescription: Web research local extra workflow\n---\n\nResearch body.\n",
  );

  const withoutExtra = await listSkills(cwd, ["active"]);
  assert.deepEqual(withoutExtra.map((skill) => skill.name).sort(), ["docs-search", "shared-tool"]);
  assert.equal(withoutExtra.find((skill) => skill.name === "shared-tool")?.description, "Profile pinned shared tool");

  const withExtra = await listSkills(cwd, ["active"], { extraDirs: [extraDir] });
  assert.deepEqual(withExtra.map((skill) => skill.name).sort(), ["docs-search", "shared-tool", "web-research"]);
  assert.ok(skillDiscoveryRoots(cwd, { extraDirs: ["vendor-skills"] }).some((root) => root.endsWith("vendor-skills")));

  const selected = await selectSkills("docs search and web research", 500, cwd, {
    discovery: { extraDirs: [extraDir] },
  });
  assert.deepEqual(selected.included.sort(), ["docs-search", "web-research"]);
});

test("skill catalog snapshots refresh when discovered SKILL.md content changes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-skills-snapshot-"));
  const skillPath = join(cwd, "skills", "live", "fast-skill", "SKILL.md");
  await mkdir(join(cwd, "skills", "live", "fast-skill"), { recursive: true });
  await writeFile(
    skillPath,
    "---\nname: fast-skill\ndescription: Fast skill v1\n---\n\nBody v1.\n",
  );

  assert.equal((await listSkills(cwd, ["active"])).find((skill) => skill.name === "fast-skill")?.description, "Fast skill v1");

  await writeFile(
    skillPath,
    "---\nname: fast-skill\ndescription: Fast skill v2\n---\n\nBody v2 with same snapshot root.\n",
  );
  assert.equal((await listSkills(cwd, ["active"])).find((skill) => skill.name === "fast-skill")?.description, "Fast skill v2");
});

test("Claude skill snapshots export eligible active skills as a temporary plugin", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-skills-claude-snapshot-"));
  await writeCandidateSkill({
    name: "review-code",
    description: "Review code changes",
    body: "Review carefully.",
  }, cwd);
  await promoteSkill("review-code", report(true), cwd);
  await writeCandidateSkill({
    name: "command-only",
    description: "Command only helper",
    body: "Only slash invocation.",
    frontmatter: { disableModelInvocation: true },
  }, cwd);
  await promoteSkill("command-only", report(true), cwd);

  const snapshot = await exportClaudeSkillSnapshot(cwd);
  assert.ok(snapshot);
  try {
    assert.deepEqual(snapshot.skillNames, ["review-code"]);
    const manifest = JSON.parse(await readFile(join(snapshot.pluginDir, ".claude-plugin", "plugin.json"), "utf8")) as { name?: string };
    assert.equal(manifest.name, "muster-skill-snapshot");
    const skillRaw = await readFile(join(snapshot.pluginDir, "skills", "review-code", "SKILL.md"), "utf8");
    assert.match(skillRaw, /name: review-code/);
    await assert.rejects(
      () => readFile(join(snapshot.pluginDir, "skills", "command-only", "SKILL.md"), "utf8"),
      /ENOENT/,
    );
  } finally {
    await snapshot.cleanup();
  }
  await assert.rejects(() => readFile(join(snapshot.pluginDir, ".claude-plugin", "plugin.json"), "utf8"), /ENOENT/);
});

test("skill env injection is scoped, non-overwriting, and restorable", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-skills-env-"));
  await writeCandidateSkill({
    name: "env-skill",
    description: "Env backed skill",
    body: "Use the configured env.",
    openclaw: { primaryEnv: "PRIMARY_TOKEN" },
  }, cwd);
  await promoteSkill("env-skill", report(true), cwd);

  const targetEnv: NodeJS.ProcessEnv = {
    EXISTING_TOKEN: "operator",
    SOURCE_TOKEN: "from-source",
  };
  const applied = await applySkillEnvForRun(["env-skill", "env-skill"], {
    skills: {
      entries: {
        "env-skill": {
          env: {
            NEW_TOKEN: "new-secret",
            EXISTING_TOKEN: "config-secret",
          },
          apiKey: { source: "env", id: "SOURCE_TOKEN" },
        },
      },
    },
  }, cwd, targetEnv);

  assert.deepEqual(applied.applied, ["NEW_TOKEN", "PRIMARY_TOKEN"]);
  assert.equal(targetEnv.NEW_TOKEN, "new-secret");
  assert.equal(targetEnv.PRIMARY_TOKEN, "from-source");
  assert.equal(targetEnv.EXISTING_TOKEN, "operator", "skill env must not overwrite operator env");

  applied.restore();
  assert.equal(targetEnv.NEW_TOKEN, undefined);
  assert.equal(targetEnv.PRIMARY_TOKEN, undefined);
  assert.equal(targetEnv.EXISTING_TOKEN, "operator");
});

test("resolveSkillCommand maps user-invocable skills to prompt or tool dispatch", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-skills-command-"));
  await writeCandidateSkill({
    name: "deploy-frappe",
    description: "Deploy Frappe safely",
    body: "Backup first, migrate second.",
    frontmatter: { userInvocable: true },
  }, cwd);
  await promoteSkill("deploy-frappe", report(true), cwd);
  await writeCandidateSkill({
    name: "make-record",
    description: "Create a record",
    body: "Use the record creation tool.",
    frontmatter: {
      userInvocable: true,
      disableModelInvocation: true,
      commandDispatch: "tool",
      commandTool: "frappe.records_create",
      commandArgMode: "raw",
    },
  }, cwd);
  await promoteSkill("make-record", report(true), cwd);
  await writeCandidateSkill({
    name: "private-skill",
    description: "Hidden skill",
    body: "No command.",
    frontmatter: { userInvocable: false },
  }, cwd);
  await promoteSkill("private-skill", report(true), cwd);

  const prompt = await resolveSkillCommand("deploy-frappe", "site-a", cwd);
  assert.equal(prompt?.dispatch, "prompt");
  assert.match(prompt?.prompt ?? "", /Backup first/);
  assert.match(prompt?.prompt ?? "", /site-a/);

  const tool = await resolveSkillCommand("make-record", "Task subject", cwd);
  assert.equal(tool?.dispatch, "tool");
  assert.equal(tool?.tool, "frappe.records_create");
  assert.deepEqual(tool?.args, { command: "Task subject", commandName: "make-record", skillName: "make-record" });

  assert.equal(await resolveSkillCommand("private-skill", "", cwd), undefined);
  assert.equal(await resolveSkillCommand("missing-skill", "", cwd), undefined);
});

test("telemetry accumulates and the curator transitions stale and archived without deleting", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-skills-curate-"));
  await writeCandidateSkill({ name: "old-skill", description: "Rarely used", body: "x" }, cwd);
  await promoteSkill("old-skill", report(true), cwd);
  await recordSkillUse(["old-skill"], cwd);

  const in40Days = new Date(Date.now() + 40 * 86_400_000);
  const first = await curateSkills(cwd, in40Days);
  assert.deepEqual(first.staled, ["old-skill"]);
  const in200Days = new Date(Date.now() + 200 * 86_400_000);
  const second = await curateSkills(cwd, in200Days);
  assert.deepEqual(second.archived, ["old-skill"]);
  const archived = await viewSkill("old-skill", cwd);
  assert.equal(archived.status, "archived", "archived, never deleted");
});

test("skill names are validated and oversized bodies refused", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-skills-validate-"));
  await assert.rejects(() => writeCandidateSkill({ name: "Bad Name!", description: "x", body: "x" }, cwd), /Invalid skill name/);
  await assert.rejects(() => writeCandidateSkill({ name: "ok-name", description: "x", body: "y".repeat(100_001) }, cwd), /100K/);
});

test("promoted skills are hash-pinned and tampering blocks load and injection", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-skills-index-"));
  await writeCandidateSkill({ name: "audit-frappe", description: "Audit Frappe deployments", body: "Check patches before migrate." }, cwd);
  await promoteSkill("audit-frappe", report(true), cwd);

  const index = JSON.parse(await readFile(skillsIndexPath(cwd), "utf8")) as {
    skills: Record<string, { digest: string; status: string }>;
  };
  assert.match(index.skills["audit-frappe"].digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(index.skills["audit-frappe"].status, "active");
  assert.deepEqual((await selectSkills("audit frappe deploy", 500, cwd)).included, ["audit-frappe"]);
  assert.deepEqual((await selectSkills("Reply with exactly: hi", 500, cwd)).included, []);

  await writeFile(join(skillsDir(cwd), "audit-frappe", "SKILL.md"), "---\nname: audit-frappe\ndescription: Audit Frappe deployments\nmetadata:\n  muster: {\"version\":\"0.1.0\",\"tags\":[],\"status\":\"active\",\"provenance\":{\"createdBy\":\"user\",\"createdAt\":\"2026-06-19T00:00:00.000Z\"}}\n---\n\nTampered body.\n");

  await assert.rejects(() => listSkills(cwd, ["active"]), /Skill digest mismatch/);
  await assert.rejects(() => selectSkills("audit frappe deploy", 500, cwd), /Skill digest mismatch/);
});

test("missing usage telemetry is treated as first use; corrupt telemetry throws instead of clobbering counts", async () => {
  // Missing .usage.json -> recordSkillUse starts fresh and succeeds.
  const freshCwd = await mkdtemp(join(tmpdir(), "muster-skills-usage-missing-"));
  await recordSkillUse(["alpha"], freshCwd);
  await curateSkills(freshCwd); // also exercises the read path with no error

  // Corrupt .usage.json -> both readers throw rather than silently overwriting it.
  const corruptCwd = await mkdtemp(join(tmpdir(), "muster-skills-usage-corrupt-"));
  await mkdir(skillsDir(corruptCwd), { recursive: true });
  await writeFile(join(skillsDir(corruptCwd), ".usage.json"), "{ corrupt");
  await assert.rejects(() => recordSkillUse(["alpha"], corruptCwd), /Corrupt JSON/);
  await assert.rejects(() => curateSkills(corruptCwd), /Corrupt JSON/);
});
