import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const app = path.join(root, "fixtures/frappe_apps/field_ops_demo");
const read = (relative) => fs.readFileSync(path.join(app, relative), "utf8");

test("reference app is an independent pinned Vue Frappe v16 app", () => {
  const project = read("pyproject.toml");
  const packageJson = JSON.parse(read("package.json"));
  assert.match(project, /name = "field_ops_demo"/);
  assert.match(project, /frappe = ">=16\.0\.0,<17\.0\.0"/);
  assert.equal(packageJson.dependencies.vue, "3.5.22");
  assert.equal(packageJson.dependencies.vite, "7.1.7");
  assert.ok(fs.existsSync(path.join(app, "pnpm-lock.yaml")));
  assert.ok(fs.statSync(path.join(app, "field_ops_demo/public/frontend/field-ops.js")).size > 10_000);
  assert.ok(fs.statSync(path.join(app, "field_ops_demo/public/frontend/field-ops.css")).size > 500);
});

test("reference app owns native CRUD controls and contains no integration code", () => {
  const vue = read("frontend/App.vue");
  const hooks = read("field_ops_demo/hooks.py");
  const page = read("field_ops_demo/www/operations.html");
  const source = [vue, hooks, page, read("frontend/main.js"), read("frontend/style.css")].join("\n");
  assert.match(vue, /\/api\/resource\/Service Visit/);
  assert.match(vue, /recordName \? 'Save' : 'Create'/);
  assert.match(vue, /method: "DELETE"/);
  assert.match(vue, /role="dialog"/);
  assert.match(vue, /window\.history\.pushState/);
  assert.match(hooks, /\/operations\/<path:app_path>/);
  assert.match(page, /id="app"/);
  assert.doesNotMatch(source, /muster/i);
  assert.doesNotMatch(source, /surface_adapters|spa_assistant|data-muster/);
});

test("Muster-owned manifest is semantic, revision-gated and selector-free", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "frappe_app/muster/demo/fixtures/field_ops_spa_manifest.json"), "utf8"));
  assert.equal(manifest.length, 1);
  const descriptor = manifest[0];
  assert.equal(descriptor.app, "field_ops_demo");
  assert.equal(descriptor.supported_major, 1);
  assert.deepEqual(descriptor.path_prefixes, ["/operations/"]);
  assert.deepEqual(descriptor.root_markers, ["[data-v-app]"]);
  assert.deepEqual(descriptor.operations, ["create", "update", "delete"]);
  assert.equal(descriptor.routes["Service Visit"].list, "/visits");
  assert.deepEqual(descriptor.routes["Service Visit"].create_buttons, []);
  assert.deepEqual(descriptor.routes["Service Visit"].commit_buttons, {create: ["Create"], update: ["Save"], delete: ["Delete"]});
  assert.doesNotMatch(JSON.stringify(descriptor), /selector|javascript|callback|expression/i);
});
