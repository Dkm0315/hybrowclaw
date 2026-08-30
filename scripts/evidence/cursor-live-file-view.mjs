/**
 * Real observer → built CLI accumulator → plain overlay frame evidence.
 * No provider is needed: two disk-write bursts exercise the same event seam.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceObserver } from "../../packages/core/dist/index.js";
import { LiveFileOverlay, LiveFileTurnAccumulator } from "../../packages/cli/dist/live-file-view.js";

const root = mkdtempSync(join(tmpdir(), "muster-cursor-evidence-"));
const target = join(root, "src", "auth.ts");
const original = [
  "import { verify } from './tokens.js';",
  "",
  "export async function login(req) {",
  "  const token = req.token;",
  "  return verify(token);",
  "}",
  "",
].join("\n");
const first = original.replace("req.token", "bearer(req)");
const second = first
  .replace("bearer(req)", "getBearerToken(req)")
  .replace("  return verify(token);", "  if (!token) throw new Error('missing');\n  return verify(token);");

try {
  execFileSync("mkdir", ["-p", join(root, "src")]);
  writeFileSync(target, original);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.email=evidence@muster.dev", "-c", "user.name=Muster Evidence", "commit", "-q", "-m", "baseline"], { cwd: root });

  const turn = new LiveFileTurnAccumulator();
  const events = [];
  const observer = createWorkspaceObserver({
    root,
    watch: false,
    pollMs: 0,
    onPatch(event) {
      events.push(event);
      turn.add(event, readFileSync(target, "utf8"));
    },
  });
  await observer.start();
  writeFileSync(target, first);
  await observer.flush();
  writeFileSync(target, second);
  await observer.flush();
  await observer.stop();

  const overlay = new LiveFileOverlay(turn, {
    terminalRows: () => 24,
    requestRender() {},
    close() {},
    color: false,
  });
  console.log(`observer_events=${events.length} shapes=${events.map((event) => `${event.source}:${event.path}:${event.changeKind}`).join(",")}`);
  console.log(overlay.render(88).map((line) => line.trimEnd()).join("\n"));
} finally {
  rmSync(root, { recursive: true, force: true });
}
