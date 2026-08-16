import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const cliPath = resolve(import.meta.dirname, "..", "src", "index.ts");
const tsxPath = resolve(import.meta.dirname, "..", "..", "..", "node_modules", ".bin", "tsx");

async function runCli(args: string[], cwd: string) {
  return execFileAsync(tsxPath, [cliPath, ...args], { cwd, env: { ...process.env, MUSTER_NO_COLOR: "1", MUSTER_ONBOARDING_HOME: join(cwd, ".test-home") } });
}

test("frappe setup configures metadata, pack policy, and OAuth by reference", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-cli-frappe-setup-"));
  const credentialFile = join(cwd, "oauth.json");
  await writeFile(credentialFile, JSON.stringify({ site: "https://oxygen.example.test", clientId: "public-client", redirectUri: "https://gateway.example.test/v1/frappe/oauth/callback" }));
  await chmod(credentialFile, 0o600);
  const result = await runCli([
    "frappe", "setup",
    "--site-url", "https://oxygen.example.test",
    "--oauth-credential-file", "oauth.json",
    "--assistant-name", "OxygenHR assistant",
    "--organization", "OxygenHR",
    "--domain", "oxygen.example.test",
  ], cwd);

  assert.match(result.stdout, /capability_pack=frappe-federated-bridge enabled=true/);
  assert.match(result.stdout, /oauth_connection=frappe-default credential_file=configured/);
  assert.match(result.stdout, /oauth_secrets=not_printed/);
  assert.match(result.stdout, /next_channel=muster channels ready telegram --bot-token-env TELEGRAM_BOT_TOKEN/);
  assert.match(result.stdout, /oauth_registration=https:\/\/oxygen\.example\.test\/app\/oauth-client/);
  assert.match(result.stdout, /oauth_redirect=https:\/\/gateway\.example\.test\/v1\/frappe\/oauth\/callback identity_refresh_ms=60000/);
  assert.match(result.stdout, /next_verify=muster frappe doctor/);
  assert.doesNotMatch(result.stdout, /client_secret|access_token|Bearer /i);

  const gateway = JSON.parse(await readFile(join(cwd, ".muster", "gateway.json"), "utf8"));
  assert.equal(gateway.frappe.assistant.organization, "OxygenHR");
  assert.equal(gateway.frappe.oauth.defaultConnection, "frappe-default");
  assert.equal(gateway.frappe.oauth.connections[0].credentialFile, "oauth.json");
  assert.equal(gateway.frappe.oauth.connections[0].callbackMode, "gateway");
  assert.equal(gateway.frappe.oauth.connections[0].site, undefined);

  const config = JSON.parse(await readFile(join(cwd, ".muster", "config.json"), "utf8"));
  assert.equal(config.plugins.entries["frappe-federated-bridge"].enabled, true);

  const doctor = await runCli(["frappe", "doctor"], cwd);
  assert.match(doctor.stdout, /frappe_doctor=ready/);
  assert.match(doctor.stdout, /site=https:\/\/oxygen\.example\.test connection=frappe-default callback_mode=gateway/);
  assert.match(doctor.stdout, /live_authorization=not_tested/);
  assert.doesNotMatch(doctor.stdout, /public-client|client_secret|access_token|Bearer /i);

  const plugin = await runCli(["plugins", "check", "frappe"], cwd);
  assert.match(plugin.stdout, /plugin_env=not_required/);
  assert.match(plugin.stdout, /plugin_auth=per_user_oauth connections=1 default=frappe-default/);
  assert.match(plugin.stdout, /next="muster frappe doctor"/);
  assert.doesNotMatch(plugin.stdout, /missing=FRAPPE_SITE_URL|FRAPPE_API_TOKEN/);
  assert.doesNotMatch(plugin.stdout, /next_action=enable_pack/);
});

test("frappe setup refuses incomplete OAuth references", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-cli-frappe-setup-invalid-"));
  await assert.rejects(
    runCli(["frappe", "setup", "--site-url", "https://oxygen.example.test"], cwd),
    /oauth-credential-file/,
  );
});

test("frappe support setup preserves the default customer connection and maps a Helpdesk customer", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-cli-frappe-support-"));
  const customerCredential = join(cwd, "customer.json");
  const supportCredential = join(cwd, "support.json");
  const redirectUri = "https://gateway.example.test/frappe2/oauth/callback";
  await writeFile(customerCredential, JSON.stringify({ site: "https://vinman.example.test", clientId: "vinman", redirectUri }));
  await writeFile(supportCredential, JSON.stringify({ site: "https://support.example.test", clientId: "support", redirectUri }));
  await chmod(customerCredential, 0o600);
  await chmod(supportCredential, 0o600);
  await runCli(["frappe", "setup", "--site-url", "https://vinman.example.test", "--oauth-credential-file", "customer.json", "--connection-id", "vinman"], cwd);
  const result = await runCli([
    "frappe", "setup",
    "--site-url", "https://support.example.test",
    "--oauth-credential-file", "support.json",
    "--connection-id", "hybrow-support",
    "--support",
    "--support-customer", "Vinman App",
  ], cwd);

  assert.match(result.stdout, /support_destination=https:\/\/support\.example\.test doctype=HD Ticket customer=Vinman App/);
  const gateway = JSON.parse(await readFile(join(cwd, ".muster", "gateway.json"), "utf8"));
  assert.equal(gateway.frappe.oauth.defaultConnection, "vinman");
  assert.deepEqual(gateway.frappe.oauth.connections.map((entry: { id: string }) => entry.id), ["vinman", "hybrow-support"]);
  assert.equal(gateway.frappe.support.customer, "Vinman App");
});

test("frappe setup rejects missing, mismatched, and accessible credential files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-cli-frappe-setup-validation-"));
  const missing = await runCliAllowFailure(["frappe", "setup", "--site-url", "https://oxygen.example.test", "--oauth-credential-file", "missing.json"], cwd);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /OAuth credential or callback configuration is unsafe/);

  const credentialFile = join(cwd, "oauth.json");
  await writeFile(credentialFile, JSON.stringify({ site: "https://other.example.test", clientId: "public-client", redirectUri: "https://gateway.example.test/frappe2/oauth/callback" }));
  await chmod(credentialFile, 0o600);
  const mismatch = await runCliAllowFailure(["frappe", "setup", "--site-url", "https://oxygen.example.test", "--oauth-credential-file", "oauth.json"], cwd);
  assert.equal(mismatch.code, 1);
  assert.match(mismatch.stderr, /site mismatch/);

  await chmod(credentialFile, 0o644);
  const permissions = await runCliAllowFailure(["frappe", "setup", "--site-url", "https://other.example.test", "--oauth-credential-file", "oauth.json"], cwd);
  assert.equal(permissions.code, 1);
  assert.match(permissions.stderr, /must not be group\/world accessible/);
  assert.doesNotMatch(permissions.stderr, /public-client|gateway\.example\.test/);
});

test("frappe setup rejects callbacks the selected mode cannot serve", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-cli-frappe-callback-validation-"));
  const credentialFile = join(cwd, "oauth.json");
  await writeFile(credentialFile, JSON.stringify({ site: "https://oxygen.example.test", clientId: "public-client", redirectUri: "https://gateway.example.test/callback" }));
  await chmod(credentialFile, 0o600);

  const invalidGateway = await runCliAllowFailure([
    "frappe", "setup",
    "--site-url", "https://oxygen.example.test",
    "--oauth-credential-file", "oauth.json",
  ], cwd);
  assert.equal(invalidGateway.code, 1);
  assert.match(invalidGateway.stderr, /gateway redirect path/i);

  const missingBridge = await runCliAllowFailure([
    "frappe", "setup",
    "--site-url", "https://oxygen.example.test",
    "--oauth-credential-file", "oauth.json",
    "--callback-mode", "frappe",
  ], cwd);
  assert.equal(missingBridge.code, 1);
  assert.match(missingBridge.stderr, /requires --result-path/i);
});

async function runCliAllowFailure(args: string[], cwd: string) {
  try {
    return { ...(await runCli(args, cwd)), code: 0 };
  } catch (error) {
    const detail = error as Error & { stdout?: string; stderr?: string; code?: number };
    return { stdout: detail.stdout ?? "", stderr: detail.stderr ?? "", code: detail.code ?? 1 };
  }
}
