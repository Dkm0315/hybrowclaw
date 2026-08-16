import { readFile } from "node:fs/promises";
import { validateFrappeLineage, type FrappeLineageDocument, type FrappeLineageManifest } from "../src/lineage.js";

const [profilePath, snapshotPath] = process.argv.slice(2);
if (!profilePath || !snapshotPath) {
  throw new Error("Usage: tsx validate-lineage-snapshot.ts <profile.json> <snapshot.json>");
}

const profile = JSON.parse(await readFile(profilePath, "utf8")) as { manifest: FrappeLineageManifest };
const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as { documents: FrappeLineageDocument[] };
const result = validateFrappeLineage({ manifest: profile.manifest, documents: snapshot.documents });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
