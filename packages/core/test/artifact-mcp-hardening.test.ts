import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createArtifactWorkspace,
  declare_artifact,
  document_generation_workflow,
  large_report_contract,
  persistArtifact,
  readArtifactManifest,
  xlsx_workbook,
} from "../src/artifacts.js";
import {
  mcp_bridge_config_lint,
  mcp_bridge_provider_reuse,
  mcp_bridge_result_receipt,
  mcp_bridge_tool_policy,
} from "../../../capability-packs/mcp-bridge/src/index.js";

test("artifact workspaces isolate tenants and runs under concurrent identical filenames", async () => {
  const root = await mkdtemp(join(tmpdir(), "muster-artifact-scopes-"));
  const [tenantRunA, tenantRunB, otherTenant] = await Promise.all([
    createArtifactWorkspace({ rootDir: root, tenantId: "tenant/a", runId: "run:one" }),
    createArtifactWorkspace({ rootDir: root, tenantId: "tenant/a", runId: "run:two" }),
    createArtifactWorkspace({ rootDir: root, tenantId: "tenant/b", runId: "run:one" }),
  ]);
  const artifact = await xlsx_workbook({
    title: "Quarterly Usage",
    filename: "usage.xlsx",
    sheets: [{ name: "Usage", columns: ["user", "tokens"], rows: [{ user: "u-1", tokens: 42 }] }],
  });

  const secretPrompt = "Create the report using internal customer context that must not enter the manifest.";
  const persisted = await Promise.all([
    persistArtifact({
      workspace: tenantRunA,
      artifact,
      artifactId: "artifact-a1",
      title: "Usage A1",
      sourceChannel: "gchat",
      sourcePrompt: secretPrompt,
      generationMode: "provider",
      providerId: "provider-one",
      providerRunId: "provider-run-a1",
      tokenLedgerId: "ledger-a1",
      requiredText: ["Usage"],
      delivery: { state: "local-only", reason: "No uploader was configured for this test." },
    }),
    persistArtifact({
      workspace: tenantRunA,
      artifact,
      artifactId: "artifact-a2",
      title: "Usage A2",
      sourceChannel: "slack",
      sourcePrompt: "second prompt",
      generationMode: "deterministic_fallback",
      fallbackReason: "Provider timed out before returning structured rows.",
      delivery: { state: "uploaded", target: "thread-42", providerMessageId: "message-42" },
    }),
    persistArtifact({
      workspace: tenantRunB,
      artifact,
      artifactId: "artifact-a1",
      title: "Usage Run B",
      sourceChannel: "telegram",
      sourcePrompt: "same artifact id, different run",
      generationMode: "provider",
      delivery: { state: "local-only", reason: "Telegram uploader was intentionally absent." },
    }),
    persistArtifact({
      workspace: otherTenant,
      artifact,
      artifactId: "artifact-a1",
      title: "Usage Tenant B",
      sourceChannel: "gchat",
      sourcePrompt: "same artifact id, different tenant",
      generationMode: "provider",
      delivery: { state: "url", url: "https://artifacts.example.test/a1" },
    }),
  ]);

  assert.equal(new Set(persisted.map((item) => item.declaration.localPath)).size, 4);
  assert.ok(persisted.every((item) => item.declaration.verification?.structural.status === "passed"));
  assert.ok(persisted.every((item) => item.declaration.verification?.render.status === "not_run"));
  assert.deepEqual(persisted.map((item) => item.declaration.delivery?.state).sort(), ["local-only", "local-only", "uploaded", "url"]);

  const declaredThroughPackTool = await declare_artifact({
    type: "xlsx",
    title: "Usage A3",
    sourceChannel: "gchat",
    sourcePrompt: "declare through the capability tool",
    artifact,
    artifactId: "artifact-a3",
    workspace: { rootDir: root, tenantId: "tenant/a", runId: "run:one" },
    generationMode: "provider",
    delivery: { state: "local-only", reason: "No uploader was configured." },
  });
  assert.equal(declaredThroughPackTool.artifactId, "artifact-a3");
  assert.equal(declaredThroughPackTool.manifestPath, tenantRunA.manifestPath);
  assert.match(declaredThroughPackTool.sourcePrompt, /^sha256:/);

  const [manifestA, manifestRunB, manifestTenantB] = await Promise.all([
    readArtifactManifest(tenantRunA),
    readArtifactManifest(tenantRunB),
    readArtifactManifest(otherTenant),
  ]);
  assert.deepEqual(manifestA.artifacts.map((item) => item.artifactId).sort(), ["artifact-a1", "artifact-a2", "artifact-a3"]);
  assert.deepEqual(manifestRunB.artifacts.map((item) => item.artifactId), ["artifact-a1"]);
  assert.deepEqual(manifestTenantB.artifacts.map((item) => item.artifactId), ["artifact-a1"]);
  assert.notEqual(tenantRunA.workspaceDir, tenantRunB.workspaceDir);
  assert.notEqual(tenantRunA.workspaceDir, otherTenant.workspaceDir);
  const manifestText = await readFile(tenantRunA.manifestPath, "utf8");
  assert.equal(manifestText.includes(secretPrompt), false, "raw prompts must not be stored in artifact manifests");
  assert.match(manifestText, /promptSha256/);
  assert.match(manifestText, /ledger-a1/);
});

test("artifact delivery fails closed when render verification fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "muster-artifact-render-fail-"));
  const workspace = await createArtifactWorkspace({ rootDir: root, tenantId: "tenant", runId: "run" });
  const artifact = await xlsx_workbook({ title: "Broken Visual", rows: [{ value: 1 }], filename: "visual.xlsx" });
  const result = await persistArtifact({
    workspace,
    artifact,
    title: "Broken Visual",
    sourceChannel: "slack",
    sourcePrompt: "Create a polished workbook.",
    generationMode: "provider",
    renderVerification: {
      status: "failed",
      engine: "headless-office",
      issues: ["Chart overlaps the summary table."],
      facts: { pages: 1 },
    },
    delivery: { state: "uploaded", target: "thread", providerMessageId: "message" },
  });
  assert.equal(result.declaration.validationStatus, "invalid");
  assert.equal(result.declaration.delivery?.state, "failed");
  assert.match(result.declaration.failureReason ?? "", /verification failed/i);
  assert.deepEqual(result.declaration.validationIssues, ["Chart overlaps the summary table."]);
  assert.equal(result.entry.delivery.state, "failed");

  await assert.rejects(
    persistArtifact({
      workspace,
      artifact,
      artifactId: "unsupported-upload",
      title: "Unsupported Upload",
      sourceChannel: "slack",
      sourcePrompt: "Upload it.",
      generationMode: "provider",
      delivery: { state: "uploaded" },
    }),
    /providerMessageId or target evidence/,
  );
  await assert.rejects(
    persistArtifact({
      workspace,
      artifact,
      artifactId: "credential-url",
      title: "Credential URL",
      sourceChannel: "gchat",
      sourcePrompt: "Host it.",
      generationMode: "provider",
      delivery: { state: "url", url: "https://artifacts.example.test/file?access_token=secret" },
    }),
    /must not embed credentials/,
  );
  assert.equal((await readArtifactManifest(workspace)).artifacts.length, 1, "rejected deliveries must not enter the manifest");
});

test("provider-led and large-report contracts stay provider-neutral and bounded", async () => {
  const defaultWorkflow = await document_generation_workflow({ format: "docx", title: "Provider First" });
  assert.equal(defaultWorkflow.mode, "provider-generated");
  assert.deepEqual(defaultWorkflow.invokeSequence, ["provider_run", "docx_document", "declare_artifact"]);

  const workflow = await document_generation_workflow({
    format: "pdf",
    originMode: "provider-generated",
    title: "Enterprise Audit",
    prompt: "Create a detailed audit report.",
    totalRows: 250_001,
    pageSize: 50_000,
    previewRows: 500,
    snapshotId: "snapshot-17",
    hostCapabilities: {
      providerId: "runtime-selected-by-user",
      discoveryId: "discovery-17",
      skills: ["documents", "pdf"],
      mcpServers: ["drive"],
    },
  });
  assert.equal((workflow.generationPolicy as { primary: string }).primary, "provider");
  assert.equal(((workflow.generationPolicy as { providerHost: { providerId: string } }).providerHost).providerId, "runtime-selected-by-user");
  assert.deepEqual((workflow.delivery as { states: string[] }).states, ["uploaded", "url", "local-only", "failed"]);
  assert.equal((workflow.largeReport as { pagination: { pageSize: number } }).pagination.pageSize, 1_000);
  assert.equal((workflow.largeReport as { export: { mode: string; chunks: number } }).export.mode, "asynchronous");
  assert.equal((workflow.largeReport as { export: { chunks: number } }).export.chunks, 3);
  assert.equal(JSON.stringify(workflow).includes("Codex"), false);
  assert.equal(JSON.stringify(workflow).includes("Claude"), false);

  const report = await large_report_contract({ totalRows: 5_000_000, sheetRowCap: 2_000_000 });
  assert.equal((report.export as { xlsxSheetRowCap: number }).xlsxSheetRowCap, 1_000_000);
  assert.equal((report.export as { chunks: number }).chunks, 5);
});

test("MCP receipts redact and cap hostile oversized output", async () => {
  let getterCalls = 0;
  const hostileAccessor: Record<string, unknown> = { safe: "visible" };
  Object.defineProperty(hostileAccessor, "explode", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("receipt sanitizer executed an untrusted getter");
    },
  });
  const receipt = await mcp_bridge_result_receipt({
    tenantId: "tenant-a",
    runId: "run-a",
    customerPackId: "customer-pack",
    server: "records",
    tool: "search",
    include: ["search"],
    input: { query: "quarterly", api_key: "input-secret" },
    result: {
      authorization: "Bearer top-secret-token",
      nested: { password: "hunter2", token: "xoxb-super-secret-token" },
      rows: Array.from({ length: 150 }, (_, index) => ({ index, text: "X".repeat(2_000) })),
      hostileAccessor,
    },
    auth: { mode: "oauth", status: "ready" },
    readiness: { status: "ready", checkedAt: "2026-07-10T00:00:00.000Z" },
    limits: { maxResultChars: 512, toolTimeoutMs: 5_000, maxCallsPerTurn: 4 },
    tokenLedgerId: "ledger-mcp-1",
    durationMs: 45,
  });
  assert.equal(receipt.status, "succeeded");
  const output = receipt.output as { preview: string; previewChars: number; truncated: boolean; redactions: number; omitted: number };
  assert.equal(output.previewChars <= 512, true);
  assert.equal(output.truncated, true);
  assert.equal(output.redactions >= 3, true);
  assert.equal(output.omitted > 0, true);
  assert.equal(output.preview.includes("top-secret-token"), false);
  assert.equal(output.preview.includes("hunter2"), false);
  assert.equal(output.preview.includes("xoxb-super-secret-token"), false);
  assert.equal(JSON.stringify(receipt).includes("input-secret"), false);
  assert.equal((receipt.isolation as { failureContained: boolean }).failureContained, true);
  assert.equal((receipt.policy as { maxResultChars: number }).maxResultChars, 512);
  assert.equal(getterCalls, 0, "receipt sanitization must not invoke accessors from an MCP result");
});

test("MCP policy blocks missing auth, missing allowlists, unready servers, and unapproved provider reuse", async () => {
  const missingAllowlist = await mcp_bridge_result_receipt({
    server: "remote",
    tool: "write",
    result: "must not leak",
    auth: { mode: "oauth", status: "ready" },
    readiness: { status: "ready" },
  });
  assert.equal(missingAllowlist.status, "blocked");
  assert.match(String(missingAllowlist.failureReason), /allowlist/i);
  assert.equal((missingAllowlist.output as { preview: string }).preview, "");

  const missingAuth = await mcp_bridge_result_receipt({
    server: "remote",
    tool: "read",
    include: ["read"],
    auth: { mode: "oauth", status: "missing" },
    readiness: { status: "ready" },
    result: "must not leak",
  });
  assert.equal(missingAuth.status, "blocked");
  assert.match(String(missingAuth.failureReason), /Authentication is missing/);

  const unready = await mcp_bridge_result_receipt({
    server: "remote",
    tool: "read",
    include: ["read"],
    auth: { mode: "local", status: "ready" },
    result: "must not leak",
  });
  assert.equal(unready.status, "blocked");
  assert.match(String(unready.failureReason), /unverified/);

  const reuse = await mcp_bridge_provider_reuse({
    providerHost: {
      providerId: "runtime-selected-by-user",
      discoveryId: "disc-1",
      discoveryConfirmed: true,
      approved: ["docs"],
      capabilities: [
        { id: "docs", kind: "skill", auth: "oauth", secret: "must-not-be-returned" },
        { id: "drive", kind: "mcp", auth: "oauth", token: "must-not-be-returned" },
      ],
    },
  });
  const capabilities = reuse.capabilities as Array<{ id: string; reusable: boolean }>;
  assert.deepEqual(capabilities.map((item) => [item.id, item.reusable]), [["docs", true], ["drive", false]]);
  assert.equal(JSON.stringify(reuse).includes("must-not-be-returned"), false);

  const withReceipt = await mcp_bridge_tool_policy({
    server: "remote",
    include: ["read"],
    tool: "read",
    result: "safe",
    auth: { mode: "oauth", status: "ready" },
    readiness: { status: "ready" },
    limits: { maxResultChars: 256 },
  });
  assert.equal((withReceipt.receipt as { status: string }).status, "succeeded");
});

test("MCP config lint blocks static bearer auth and invalid execution bounds without echoing secrets", async () => {
  const lint = await mcp_bridge_config_lint({
    servers: {
      unsafe: {
        transport: {
          kind: "http",
          url: "https://mcp.example.test/tools?access_token=url-secret",
          headers: { Authorization: "Bearer header-secret" },
        },
        auth: "oauth",
        tools: { include: ["read"] },
        limits: { maxResultChars: 999_999, toolTimeoutMs: 1 },
      },
    },
  });
  assert.equal(lint.blocked, 1);
  const serialized = JSON.stringify(lint);
  assert.equal(serialized.includes("url-secret"), false);
  assert.equal(serialized.includes("header-secret"), false);
  assert.match(serialized, /static Authorization/);
  assert.match(serialized, /limits\.maxResultChars/);
  assert.match(serialized, /limits\.toolTimeoutMs/);
});
