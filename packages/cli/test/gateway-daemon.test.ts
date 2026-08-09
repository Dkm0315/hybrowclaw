import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cliPath = resolve(import.meta.dirname, "..", "src", "index.ts");

test("channels ready initializes a clean workspace and proves daemon health before reporting success", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gateway-daemon-"));
  const port = await availablePort();

  const started = await runCli(["channels", "ready", "web", "--port", String(port)], cwd);
  try {
    assert.match(started.stdout, /channel_ready=web status=ready/);
    assert.match(started.stdout, /gateway_daemon=started pid=\d+ health=verified/);
    assert.match(started.stdout, new RegExp(`port=${port}`));
    assert.match(started.stdout, /done=channel_ready channel=web daemon=started_or_running sample=local_simulation/);
    const config = JSON.parse(await readFile(join(cwd, ".muster", "config.json"), "utf8")) as { version?: number };
    assert.equal(config.version, 1);

    const health = await fetch(`http://127.0.0.1:${port}/v1/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, service: "muster-gateway" });

    const status = await runCli(["gateway", "daemon", "status"], cwd);
    assert.match(status.stdout, /gateway_daemon=running/);
  } finally {
    const stopped = await runCli(["gateway", "daemon", "stop"], cwd);
    assert.match(stopped.stdout, /gateway_daemon=stopped/);
  }

  const log = await readFile(join(cwd, ".muster", "gateway.log"), "utf8");
  assert.doesNotMatch(log, /ENOENT|ERR_MODULE_NOT_FOUND/);
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolvePromise, rejectPromise) => server.close((error) => error ? rejectPromise(error) : resolvePromise()));
  return port;
}

async function runCli(args: readonly string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("tsx", [cliPath, ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: "1", MUSTER_ONBOARDING_HOME: join(cwd, ".home") },
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}
