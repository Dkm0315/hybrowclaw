#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

const codex = process.env.MUSTER_CODEX_COMMAND || "codex";
const proofBase = join(homedir(), ".cache", "muster", "sandbox-proofs");
await mkdir(proofBase, { recursive: true, mode: 0o700 });
const root = await mkdtemp(join(proofBase, "real-codex-"));
const workspace = join(root, "workspace");
const outside = join(root, "outside-sentinel.txt");
let server;
try {
  const version = await run(codex, ["--version"]);
  if (version.code !== 0) throw new Error("release blocker: a runnable Codex CLI is required for the artifact sandbox proof");
  await mkdir(workspace, { mode: 0o700 });
  await writeFile(outside, "unchanged\n", { encoding: "utf8", mode: 0o600 });

  let networkHits = 0;
  server = createServer((_request, response) => {
    networkHits += 1;
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("reachable only if sandbox failed\n");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("release blocker: local network fixture did not bind");

  const probe = await run(codex, [
    "sandbox", "-P", ":workspace", "--sandbox-state-disable-network",
    "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true",
    "-c", "sandbox_workspace_write.exclude_slash_tmp=true",
    "-C", workspace, "--",
    "sh", "-c", [
      "printf 'inside\\n' > inside.txt || exit 10",
      "if printf 'escaped\\n' > \"$MUSTER_ESCAPE_TARGET\"; then exit 20; fi",
      "if /usr/bin/curl -fsS --max-time 3 \"$MUSTER_NETWORK_URL\" > network.txt; then exit 21; fi",
      "printf 'proved\\n' > proof.txt || exit 30",
    ].join("; "),
  ], {
    cwd: workspace,
    env: {
      ...process.env,
      MUSTER_ESCAPE_TARGET: outside,
      MUSTER_NETWORK_URL: `http://127.0.0.1:${address.port}/sandbox-probe`,
    },
  });
  if (probe.code !== 0) {
    throw new Error(`release blocker: Codex sandbox probe exited ${probe.code ?? probe.signal ?? "unknown"}`);
  }
  if (await readFile(outside, "utf8") !== "unchanged\n") throw new Error("release blocker: Codex workspace sandbox allowed an escape write");
  if (await readFile(join(workspace, "inside.txt"), "utf8") !== "inside\n"
    || await readFile(join(workspace, "proof.txt"), "utf8") !== "proved\n") {
    throw new Error("release blocker: Codex workspace sandbox did not retain permitted workspace writes");
  }
  if (networkHits !== 0) throw new Error("release blocker: Codex network-disabled sandbox reached the local network fixture");
  const networkFile = join(workspace, "network.txt");
  if (await access(networkFile).then(() => true, () => false)) {
    if ((await readFile(networkFile)).length !== 0) throw new Error("release blocker: network probe returned bytes inside the sandbox");
  }
  process.stdout.write(`${JSON.stringify({
    status: "passed",
    codex: version.stdout.trim() || version.stderr.trim(),
    workspaceWrite: "allowed",
    workspaceEscape: "denied",
    network: "denied",
  })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
