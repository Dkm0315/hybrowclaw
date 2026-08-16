import { readFile } from "node:fs/promises";
import {
  digestFrappeLineageManifest,
  planFrappeLineageRemediation,
} from "../src/lineage-remediation.js";
import { validateFrappeLineage, type FrappeLineageDocument, type FrappeLineageManifest } from "../src/lineage.js";

const [profilePath, snapshotPath] = process.argv.slice(2);
if (!profilePath || !snapshotPath) {
  throw new Error("Usage: tsx plan-lineage-remediation-snapshot.ts <profile.json> <snapshot.json>");
}

const profile = JSON.parse(await readFile(profilePath, "utf8")) as { manifest: FrappeLineageManifest };
const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as { documents: FrappeLineageDocument[] };
const validation = validateFrappeLineage({ manifest: profile.manifest, documents: snapshot.documents });
const reviewedManifest = {
  manifest: profile.manifest,
  review: {
    status: "reviewed" as const,
    manifestDigest: digestFrappeLineageManifest(profile.manifest),
    reviewedBy: "repository-profile-review",
    reviewedAt: new Date().toISOString(),
  },
};
const plan = planFrappeLineageRemediation({ reviewedManifest, documents: snapshot.documents, validation });
process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
