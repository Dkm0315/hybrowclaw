import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyTask } from "../src/router.js";

test("business plans do not become architecture tasks", () => {
  assert.equal(classifyTask("Give me a concise plan to apply leave next Monday"), "simple_qa");
  assert.equal(classifyTask("Plan my travel reimbursement request"), "simple_qa");
});

test("technical architecture and implementation plans remain architecture tasks", () => {
  assert.equal(classifyTask("Design the system architecture for the gateway"), "architecture");
  assert.equal(classifyTask("Write an implementation plan for the control plane"), "architecture");
});

test("an explicit host task kind remains authoritative", () => {
  assert.equal(classifyTask("plan to apply leave", "workflow"), "workflow");
});
