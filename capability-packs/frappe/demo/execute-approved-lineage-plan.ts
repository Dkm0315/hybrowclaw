import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  frappe_safe_write,
  signFrappeApproval,
  type FrappeToolContext,
} from "../src/index.js";
import type { FrappeLineageRemediationPlan } from "../src/lineage-remediation.js";
import type { FrappeLineageManifest } from "../src/lineage.js";

const [profilePath, planPath] = process.argv.slice(2);
if (!profilePath || !planPath) {
  throw new Error("Usage: tsx execute-approved-lineage-plan.ts <profile.json> <plan.json>");
}
if (process.env.MUSTER_DEMO_APPROVE_EXACT_PLAN !== "yes") {
  throw new Error("Set MUSTER_DEMO_APPROVE_EXACT_PLAN=yes only after reviewing the exact plan JSON.");
}
const siteUrl = process.env.FRAPPE_SITE_URL;
const adminUser = process.env.FRAPPE_ADMIN_USER;
const adminPassword = process.env.FRAPPE_ADMIN_PASSWORD;
const approver = process.env.MUSTER_DEMO_APPROVER;
if (!siteUrl || !adminUser || !adminPassword || !approver) {
  throw new Error("FRAPPE_SITE_URL, FRAPPE_ADMIN_USER, FRAPPE_ADMIN_PASSWORD, and MUSTER_DEMO_APPROVER are required.");
}

const profile = JSON.parse(await readFile(profilePath, "utf8")) as { manifest: FrappeLineageManifest };
const plan = JSON.parse(await readFile(planPath, "utf8")) as FrappeLineageRemediationPlan;
if (!plan.actions.length) throw new Error("The reviewed remediation plan contains no executable actions.");
const stageDoctypes = new Map(profile.manifest.stages.map((stage) => [stage.id, stage.doctype]));
const runDir = await mkdtemp(join(tmpdir(), "muster-frappe-lineage-approval-"));
const signingKey = randomUUID() + randomUUID();
const context: FrappeToolContext = {
  fetch: globalThis.fetch.bind(globalThis),
  config: {
    FRAPPE_APPROVAL_SIGNING_KEY: signingKey,
    FRAPPE_READ_MODEL_PATH: join(runDir, "read-model.db"),
  },
};

const results = [];
for (const action of plan.actions) {
  const doctype = stageDoctypes.get(action.target.stage);
  if (!doctype) throw new Error(`No reviewed DocType exists for stage ${action.target.stage}.`);
  const doc = Object.fromEntries(action.changes.map((change) => [change.path, change.value]));
  const mutation = {
    operation: "update",
    doctype,
    docname: action.target.name,
    expected_modified: action.expected_modified,
    doc,
    siteUrl,
    adminUser,
    adminPassword,
    permissionEpoch: plan.permissionEpoch,
    schemaRevision: plan.schemaRevision,
    dataRevision: plan.dataRevision,
  };
  const proposal = await frappe_safe_write(mutation, context);
  if ("error" in proposal) throw new Error(proposal.error);
  if (proposal.status !== "approval_required" || !proposal.approvalProposal) {
    throw new Error(`Expected an approval proposal for ${doctype} ${action.target.name}.`);
  }
  const receipt = signFrappeApproval(
    proposal.approvalProposal,
    approver,
    signingKey,
    proposal.approvalProposal.issuedAt,
  );
  const executed = await frappe_safe_write({ ...mutation, approvalReceipt: receipt }, context);
  if ("error" in executed) throw new Error(executed.error);
  if (executed.status !== "executed" || !executed.verification?.verified) {
    throw new Error(`Governed write verification failed for ${doctype} ${action.target.name}: ${executed.verification?.reason ?? executed.status}.`);
  }
  results.push({
    actionId: action.id,
    doctype,
    docname: action.target.name,
    status: executed.status,
    verified: executed.verification.verified,
    evidenceLog: executed.evidenceLog,
  });
}

process.stdout.write(`${JSON.stringify({ planDigest: plan.digest, approver, results }, null, 2)}\n`);
