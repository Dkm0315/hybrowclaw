import { access, cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../../capability-packs/frappe/", import.meta.url));
const target = fileURLToPath(new URL("../dist/builtin-packs/frappe/", import.meta.url));
const entries = ["manifest.json", "FRAPPE_SURFACE_SPEC.md", "dist", "evals", "profiles"];

await access(new URL("../../../capability-packs/frappe/dist/index.js", import.meta.url));
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
for (const entry of entries) {
  await cp(new URL(entry, `${new URL("../../../capability-packs/frappe/", import.meta.url)}`), new URL(entry, `${new URL("../dist/builtin-packs/frappe/", import.meta.url)}`), { recursive: true });
}

console.log(`bundled_capability_pack=frappe source=${source} target=${target}`);
