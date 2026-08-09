import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import test from "node:test";

const scriptsRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(scriptsRoot, "..");
const scriptPath = path.join(scriptsRoot, "frappeverse-demo-provision.sh");
const script = fs.readFileSync(scriptPath, "utf8");
const passwordScriptPath = path.join(scriptsRoot, "frappeverse-generate-demo-user-passwords.sh");
const passwordScript = fs.readFileSync(passwordScriptPath, "utf8");
const lock = fs.readFileSync(path.join(scriptsRoot, "frappeverse-demo-apps.lock.example.tsv"), "utf8");
const seeder = fs.readFileSync(path.join(repoRoot, "frappe_app/muster/demo/frappeverse_baseline.py"), "utf8");
const runbook = fs.readFileSync(path.join(repoRoot, "docs/evidence/frappeverse-demo-provisioning-runbook.md"), "utf8");

test("provisioner is valid shell and uses the complete Bench lifecycle", () => {
  assert.equal(spawnSync("bash", ["-n", scriptPath]).status, 0);
  for (const expected of [
    "bench init", "bench new-site", "--db-type mariadb", "bench get-app",
    "install-app", "bench --site \"$SITE_NAME\" migrate", "bench build --production",
    "bench setup requirements", "backup --with-files --compress", "restore \"$RESTORE_SQL\"",
  ]) assert.ok(script.includes(expected), expected);
});

test("required Frappeverse applications and stable service names are explicit", () => {
  assert.match(lock, /^#.*\nerpnext\t/m);
  for (const app of ["muster", "erpnext", "hrms", "telephony", "crm", "helpdesk", "payments", "insights", "builder", "drive", "lms"]) {
    assert.match(lock, new RegExp(`^${app}\\t`, "m"));
  }
  assert.match(script, /ERPNext must be the first app installed after Frappe/);
  for (const service of ["web_service", "socketio_service", "worker_service", "scheduler_service", "gateway_service"]) {
    assert.match(script, new RegExp(service));
  }
});

test("Bench repositories may use the upstream remote name without weakening URL verification", () => {
  assert.match(script, /preferred_remote\(\)/);
  assert.match(script, /reviewed_remote\(\)/);
  assert.match(script, /for remote in upstream origin/);
  assert.doesNotMatch(script, /remote get-url origin/);
  assert.match(script, /No Git remote for \$repo_dir matches reviewed repository/);
});

test("new bench uses an explicit non-overlapping port block", () => {
  for (const name of ["WEB_PORT", "SOCKETIO_PORT", "REDIS_CACHE_PORT", "REDIS_QUEUE_PORT", "REDIS_SOCKETIO_PORT", "MUSTER_GATEWAY_PORT"]) {
    assert.match(script, new RegExp(`${name}=`));
  }
  assert.match(script, /Service ports must be unique/);
  assert.match(script, /ss -ltnH/);
  assert.match(script, /bench set-config -g webserver_port/);
  assert.match(script, /bench setup redis/);
  assert.match(runbook, /default isolated port block/);
});

test("mutating runs are serialized and production builds are de-prioritized", () => {
  assert.match(script, /flock -n 9/);
  assert.match(script, /Another \$\{SERVICE_PREFIX\} provisioning operation is already running/);
  assert.match(script, /ionice -c 2 -n 7 nice -n 10/);
  assert.match(script, /run_resource_intensive bench build --production/);
  assert.match(script, /\^\(plan\|inspect\)\$/);
});

test("final recording rejects ephemeral origins and mutable revisions", () => {
  assert.match(script, /trycloudflare\\\.com\|ngrok\|loca\\\.lt/);
  assert.match(script, /Final recording requires an immutable Frappe v16 commit/);
  assert.match(script, /must be pinned to a 40-character commit/);
  assert.match(runbook, /Final recording rejects Cloudflare Quick Tunnels/);
});

test("secrets are not accepted as Bench command arguments", () => {
  assert.doesNotMatch(script, /--admin-password|--db-root-password|password\s*=\s*["'][^"']+["']/i);
  assert.match(script, /SEED_PASSWORD_FILE must be chmod 600 or 400/);
  assert.match(runbook, /hidden prompts/);
});

test("demo credentials are generated privately without revealing values", () => {
  assert.equal(spawnSync("bash", ["-n", passwordScriptPath]).status, 0);
  assert.match(passwordScript, /umask 077/);
  assert.match(passwordScript, /openssl rand -hex 24/g);
  assert.match(passwordScript, /Refusing to overwrite an existing password file/);

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "muster-frappeverse-passwords-"));
  const output = path.join(temporary, "demo-users.json");
  const result = spawnSync("bash", [passwordScriptPath, output], {encoding: "utf8"});
  assert.equal(result.status, 0, result.stderr);
  const credentials = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.deepEqual(Object.keys(credentials).sort(), [
    "demo.auditor@frappeverse.invalid", "demo.finance@frappeverse.invalid",
    "demo.hr@frappeverse.invalid", "demo.owner@frappeverse.invalid",
    "demo.sales@frappeverse.invalid", "demo.support@frappeverse.invalid",
  ]);
  for (const value of Object.values(credentials)) {
    assert.match(value, /^[a-f0-9]{48}$/);
    assert.equal(result.stdout.includes(value), false);
    assert.equal(result.stderr.includes(value), false);
  }
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  assert.notEqual(spawnSync("bash", [passwordScriptPath, output]).status, 0);
});

test("baseline data is deterministic and proves that AI outcomes were not pre-seeded", () => {
  assert.match(seeder, /SCENARIO = "frappeverse-clean-v1"/);
  assert.match(seeder, /DEMO_CAPABILITIES/);
  assert.match(seeder, /_ensure_muster_role_binding/);
  assert.match(seeder, /"frappe\.record\.create"/);
  assert.match(seeder, /"frappe\.browser\.navigate"/);
  assert.match(seeder, /"muster_role_bindings": binding_result/);
  assert.match(seeder, /before = _outcome_counts\(\)/);
  assert.match(seeder, /after = _outcome_counts\(\)/);
  assert.match(seeder, /if after != before:[\s\S]*frappe\.db\.rollback\(\)/);
  assert.doesNotMatch(script, /seed-demo|seed_video_evidence/);
  assert.match(runbook, /must be created live during the demonstration/);
});

test("baseline provisions a persistent least-privilege independent checker", () => {
  assert.match(seeder, /DEMO_CHECKER = "demo\.checker@frappeverse\.invalid"/);
  assert.match(
    seeder,
    /DEMO_CHECKER: \("Morgan", "Checker", \("Muster Approver", "Muster Automation Manager"\)\)/,
  );
  assert.match(seeder, /DEMO_CHECKER: CHECKER_CAPABILITIES/);
  assert.match(seeder, /for index, email in enumerate\(EMPLOYEE_USERS, start=1\)/);
  const employeeBlock = seeder.match(/EMPLOYEE_USERS = \(([\s\S]*?)\n\)/)?.[1] ?? "";
  assert.doesNotMatch(employeeBlock, /demo\.checker@frappeverse\.invalid/);

  const block = seeder.match(/CHECKER_CAPABILITIES = \(([\s\S]*?)\n\)/)?.[1];
  assert.ok(block, "CHECKER_CAPABILITIES tuple");
  const capabilities = [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(capabilities, [
    "approval.decide", "approval.read", "artifact.read",
    "frappe.browser.click", "frappe.browser.navigate", "frappe.browser.read_visible",
    "mission.read",
  ]);
  for (const forbidden of [
    "frappe.record.create", "frappe.record.update", "frappe.record.delete",
    "frappe.browser.fill", "frappe.browser.select", "mission.create", "mission.control",
    "policy.manage", "workflow.manage", "agent.manage", "evidence.export",
  ]) assert.equal(capabilities.includes(forbidden), false, forbidden);
});

test("clean-site seeding uses Bench-compatible kwargs and converges ERPNext setup masters", () => {
  assert.match(script, /local kwargs='\{"confirm":True\}'/);
  assert.match(seeder, /def _ensure_erpnext_setup_fixtures\(\)/);
  assert.match(seeder, /\("Gender", "Male", \{"gender": "Male"\}\)/);
  assert.match(seeder, /\("Warehouse Type", "Transit", \{"name": "Transit"\}\)/);
  assert.match(seeder, /\("UOM", "Nos", \{"uom_name": "Nos"/);
  assert.match(seeder, /ignore_if_duplicate=True/);
  assert.match(seeder, /_ensure_erpnext_setup_fixtures\(\)[\s\S]*before = _outcome_counts\(\)/);
});

test("baseline converges the supported Frappe v16 setup state and Desk route", () => {
  assert.match(seeder, /def _converge_desk_setup_state\(\)/);
  assert.match(seeder, /frappe\.get_single\("Installed Applications"\)/);
  assert.match(seeder, /installed_applications\.update_versions\(\)/);
  assert.match(seeder, /filters=\{"app_name": \("in", \("frappe", "erpnext"\)\)\}/);
  assert.match(seeder, /if incomplete:[\s\S]*raise frappe\.ValidationError/);
  assert.match(seeder, /frappe\.db\.set_default\("desktop:home_page", "workspace"\)/);
  assert.match(seeder, /frappe\.db\.set_single_value\("System Settings", "setup_complete", 1\)/);
  assert.match(seeder, /company = _ensure\("Company"[\s\S]*_converge_desk_setup_state\(\)/);
});

test("bench, site, app installation and business records have convergence guards", () => {
  assert.match(script, /if \[\[ ! -d "\$BENCH_DIR" \]\]/);
  assert.match(script, /if \[\[ ! -d "\$BENCH_DIR\/sites\/\$SITE_NAME" \]\]/);
  assert.match(script, /if \[\[ ! -d "\$app_dir\/\.git" \]\]/);
  assert.match(script, /if ! grep -Fxq "\$app"/);
  assert.match(seeder, /existing = frappe\.db\.exists\(doctype, filters\)/);
  assert.match(seeder, /if existing:[\s\S]*return str\(existing\)/);
});

test("provisioner contains no automated destructive primary-site operation", () => {
  assert.doesNotMatch(script, /rm\s+-rf|drop-site|drop-database|reset\s+--hard/);
  assert.match(script, /RESTORE_SITE.*!=.*SITE_NAME/);
  assert.match(script, /ALLOW_RESTORE_REHEARSAL/);
});

test("plan mode is read-only for an absent explicit bench", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "muster-frappeverse-plan-"));
  const apps = path.join(temporary, "apps.tsv");
  fs.writeFileSync(apps, "erpnext\thttps://github.com/frappe/erpnext.git\tversion-16\tversion-16\ttrue\n", {mode: 0o600});
  const bench = path.join(temporary, "frappeverse-demo-v16");
  const artifacts = path.join(temporary, "artifacts");
  const result = spawnSync("bash", [scriptPath, "plan"], {
    encoding: "utf8",
    env: {...process.env, BENCH_DIR: bench, APPS_LOCK_FILE: apps, ARTIFACT_DIR: artifacts, ALLOW_MUTABLE_REFS: "1"},
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /bench_state=absent/);
  assert.match(result.stdout, /Plan only: no state changed/);
  assert.equal(fs.existsSync(bench), false);
  assert.equal(fs.existsSync(artifacts), false);
});
