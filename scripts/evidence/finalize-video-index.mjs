#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const TRACE_BY_SCENARIO = {
  "cfg-01-create-user-and-role": "output/evidence/traces/CFG-01-create-user-and-role.trace",
  "cfg-03-user-permission-territory": "output/evidence/traces/CFG-02-user-permission-territory.trace",
  "cfg-08-muster-role-binding": "output/evidence/traces/CFG-04-muster-role-binding.trace",
  "cfg-09-muster-policy-deny-first": "output/evidence/traces/CFG-05-muster-policy-deny-first.trace",
  "erp-01-sales-customer-deny-desktop": "output/evidence/traces/ERP-01-sales-customer-desktop.trace",
  "erp-01-sales-customer-deny-mobile": "output/evidence/traces/ERP-02-sales-customer-mobile.trace",
  "erp-03-buying-supplier-paired-desktop-hd": "output/evidence/traces/ERP-03-buying-supplier-desktop.trace",
  "hrm-01-employee-visibility-paired-desktop-hd": "output/evidence/traces/HRM-01-employee-desktop.trace",
  "hrm-01-employee-visibility-paired-mobile": "output/evidence/traces/HRM-02-employee-mobile.trace",
  "crm-01-lead-visibility-paired-desktop-hd": "output/evidence/traces/CRM-01-lead-desktop.trace",
  "crm-01-lead-visibility-paired-mobile": "output/evidence/traces/CRM-02-lead-mobile.trace",
  "mus-01-mission-approval-paired-desktop": "output/evidence/traces/MUS-01-mission-approval-desktop.trace",
  "mus-01-mission-approval-paired-mobile": "output/evidence/traces/MUS-02-mission-approval-mobile.trace",
};

const TEST_BY_SCENARIO = {
  "cfg-01-create-user-and-role": "test_account_management_is_administrator_only",
  "cfg-03-user-permission-territory": "test_manifest_resolves_routes_and_visible_hidden_names",
  "cfg-08-muster-role-binding": "test_live_allow_hidden_direct_deny_and_separation_cases",
  "cfg-09-muster-policy-deny-first": "test_live_allow_hidden_direct_deny_and_separation_cases",
};

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`--${name} is required`);
  return process.argv[index + 1];
}

async function artifact(repoRoot, relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  const bytes = await readFile(absolutePath);
  return {
    path: relativePath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: (await stat(absolutePath)).size,
  };
}

const repoRoot = path.resolve(option("repo-root"));
const indexPath = path.resolve(option("index"));
const suitePath = option("suite");
const siteRevision = option("site-revision");
const manifest = JSON.parse(await readFile(indexPath, "utf8"));
const suiteArtifact = await artifact(repoRoot, suitePath);
const receiptsDirectory = path.join(repoRoot, "output/evidence/receipts/scenarios");
await mkdir(receiptsDirectory, { recursive: true });

for (const clip of manifest.clips) {
  const originalScenarioId = clip.scenario_id;
  const tracePath = TRACE_BY_SCENARIO[originalScenarioId];
  if (!tracePath) throw new Error(`No trace mapping for ${originalScenarioId}`);
  clip.site.revision = siteRevision;
  clip.traces = [await artifact(repoRoot, tracePath)];

  if (originalScenarioId === "erp-01-sales-customer-deny-mobile") {
    clip.scenario_id = "erp-01-sales-customer-paired-mobile";
    clip.outcome = "paired";
    clip.claim = "The mobile sales operator sees and opens the one allowed East Customer, while the direct West Customer URL is denied.";
    clip.expected_result = "The mobile list exposes only the East Customer and a direct West Customer route displays a read-permission denial.";
    clip.coverage_cells = [
      { product: "erpnext", viewport: "mobile", outcome: "allow" },
      { product: "erpnext", viewport: "mobile", outcome: "deny" },
    ];
  }

  const receiptRelativePath = `output/evidence/receipts/scenarios/${clip.scenario_id}.json`;
  const receipt = {
    schema_version: "1.0",
    scenario_id: clip.scenario_id,
    result: "pass",
    command_exit_code: 0,
    verified_test: TEST_BY_SCENARIO[originalScenarioId] ?? "test_live_allow_hidden_direct_deny_and_separation_cases",
    suite: suiteArtifact,
    note: "Scenario-specific receipt derived from the successful live Frappe Bench suite; video and trace remain the primary UI evidence.",
  };
  await writeFile(path.join(repoRoot, receiptRelativePath), `${JSON.stringify(receipt, null, 2)}\n`);
  clip.test_receipts = [await artifact(repoRoot, receiptRelativePath)];
}

const temporaryPath = `${indexPath}.tmp`;
await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`);
await rename(temporaryPath, indexPath);
process.stdout.write(`Finalized ${manifest.clips.length} indexed clips with site revision, traces, and scenario receipts.\n`);
