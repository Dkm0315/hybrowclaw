import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repo = path.resolve(import.meta.dirname, "../../..");
const source = fs.readFileSync(path.join(repo, "frappe_app/muster/public/js/surface_adapters.js"), "utf8");

test("custom SPA waits for permission-visible commit before cryptographic verification", () => {
  assert.match(source, /async function waitForSavedRecord\(doctype, recordName, timeout = 5_000\)/);
  assert.match(source, /method: "GET", credentials: "same-origin", cache: "no-store"/);
  assert.match(source, /if \(response\.status !== 404\) throw new MusterSurfaceUnavailableError\(\)/);
  assert.match(source, /window\.setTimeout\(resolve, 120\)/);
  assert.match(source, /await sleep\(750\);[\s\S]*await waitForSavedRecord/);
  assert.match(source, /decoded\.toLowerCase\(\) === "new"/);
  assert.match(source, /decoded\.toLowerCase\(\)\.startsWith\("new-"\)/);
  assert.ok(
    source.indexOf("await waitForSavedRecord(receipt.doctype, recordName)")
      < source.indexOf('governedMethod("muster.api.mission.verify_attended_save"'),
  );
  assert.match(source, /try \{ await waitForSavedRecord\(receipt\.doctype, recordName\); \} catch \(_barrierError\)/);
  assert.match(source, /Date\.now\(\) - verificationStarted < 5_000/);
  assert.match(source, /await sleep\(150\)/);
  assert.match(source, /candidate\?\.verified === true[\s\S]*candidate\?\.proof_hash/);
  assert.doesNotMatch(source, /document\.cookie|localStorage|sessionStorage/);
});
