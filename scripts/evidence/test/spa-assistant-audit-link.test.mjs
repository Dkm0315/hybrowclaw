import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

const source = readFileSync("frappe_app/muster/public/js/spa_assistant.js", "utf8");

test("a successful attended save keeps one existing audit link", () => {
  assert.match(source, /box\.replaceChildren\(confirmation, proposalLink\(proposal\)\)/);
  assert.match(source, /confirmation\.remove\(\)/);
  assert.doesNotMatch(source, /confirmation\.replaceWith\(proposalLink\(proposal\)\)/);
});
