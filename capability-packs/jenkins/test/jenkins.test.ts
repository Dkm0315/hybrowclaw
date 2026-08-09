import assert from "node:assert/strict";
import test from "node:test";
import {
  jenkins_builds_list,
  jenkins_console_tail,
  jenkins_jobs_list,
  jenkins_pipeline_apply,
  jenkins_pipeline_plan,
} from "../src/index.js";

function context(fetcher: typeof fetch, overrides: Record<string, string> = {}) {
  return {
    fetch: fetcher,
    config: {
      JENKINS_URL: "https://jenkins.example.test",
      JENKINS_USER: "service-user",
      JENKINS_PASSWORD: "private-token",
      allowedRoots: "ossmgr-builds,ossmgr-e2e,ossmgr-reports",
      allowMutation: "true",
      ...overrides,
    },
  };
}

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), { status, headers });
}

test("job discovery cannot escape the configured OSS Manager roots", async () => {
  let called = false;
  const fetcher = (async () => {
    called = true;
    return json({});
  }) as typeof fetch;
  const result = await jenkins_jobs_list({ root: "chatnext-frontend-ci-cd" }, context(fetcher));
  assert.deepEqual(result, { error: "Requested Jenkins root is outside the configured OSS Manager allowlist." });
  assert.equal(called, false);
});

test("build history is explicitly newest first", async () => {
  const fetcher = (async () => json({ builds: [
    { number: 1, timestamp: 100, result: "SUCCESS" },
    { number: 3, timestamp: 300, result: "FAILURE" },
    { number: 2, timestamp: 200, result: "SUCCESS" },
  ] })) as typeof fetch;
  const result = await jenkins_builds_list({ job: "ossmgr-builds/Production Build" }, context(fetcher)) as unknown as { builds: Array<{ number: number }> };
  assert.deepEqual(result.builds.map((build) => build.number), [3, 2, 1]);
});

test("console evidence is bounded and redacts configured credentials", async () => {
  const fetcher = (async () => new Response("password=private-token service-user private-token\nfinished")) as typeof fetch;
  const result = await jenkins_console_tail({ job: "ossmgr-builds/Production Build", build: 1 }, context(fetcher)) as { tail: string };
  assert.equal(result.tail.includes("private-token"), false);
  assert.equal(result.tail.includes("service-user"), false);
  assert.match(result.tail, /\[redacted\]/);
});

test("pipeline apply is source-hash bound, explicitly confirmed, preserves job properties, and verifies", async () => {
  let xml = "<?xml version='1.1'?><flow-definition><properties><custom>keep-me</custom></properties><script>pipeline { agent any }</script></flow-definition>";
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/crumbIssuer/api/json")) return json({ crumbRequestField: "Jenkins-Crumb", crumb: "crumb" });
    if (url.endsWith("/config.xml") && (init?.method ?? "GET") === "GET") return new Response(xml);
    if (url.endsWith("/config.xml") && init?.method === "POST") {
      assert.equal(new Headers(init.headers).get("Jenkins-Crumb"), "crumb");
      xml = String(init.body);
      return new Response("", { status: 200 });
    }
    return json({ error: "unexpected" }, 500);
  }) as typeof fetch;
  const ctx = context(fetcher);
  const args = { job: "ossmgr-builds/Production Build", jenkinsfile: "pipeline { agent none; stages {} }" };
  const plan = await jenkins_pipeline_plan(args, ctx) as Record<string, unknown>;
  const denied = await jenkins_pipeline_apply({ ...args, ...plan, confirmation: "yes" }, ctx);
  assert.deepEqual(denied, { error: "Exact confirmation required: APPLY ossmgr-builds/Production Build" });
  const applied = await jenkins_pipeline_apply({ ...args, ...plan, confirmation: "APPLY ossmgr-builds/Production Build" }, ctx) as Record<string, unknown>;
  assert.equal(applied.ok, true);
  assert.equal(applied.operation, "updated");
  assert.match(xml, /<custom>keep-me<\/custom>/);
  assert.match(xml, /agent none/);
});

test("pipeline planning refuses non-inline pipeline jobs instead of replacing their configuration", async () => {
  const fetcher = (async () => new Response("<flow-definition><definition class=\"SCM\"/></flow-definition>")) as typeof fetch;
  const result = await jenkins_pipeline_plan({
    job: "ossmgr-builds/Production Build",
    jenkinsfile: "pipeline { agent any }",
  }, context(fetcher));
  assert.deepEqual(result, { error: "Existing Jenkins job is not an inline Pipeline script and cannot be modified by this connector." });
});

test("planning the current script is idempotent", async () => {
  const xml = "<flow-definition><properties><custom>keep</custom></properties><script>pipeline { environment { VALUE = &apos;x&apos; } }</script></flow-definition>";
  const fetcher = (async () => new Response(xml)) as typeof fetch;
  const result = await jenkins_pipeline_plan({
    job: "ossmgr-builds/Production Build",
    jenkinsfile: "pipeline { environment { VALUE = 'x' } }",
  }, context(fetcher)) as Record<string, unknown>;
  assert.equal(result.changed, false);
  assert.equal(result.expectedConfigDigest, result.proposedConfigDigest);
});

test("pipeline plan reports creation without allowing top-level jobs", async () => {
  const fetcher = (async () => new Response("missing", { status: 404 })) as typeof fetch;
  const plan = await jenkins_pipeline_plan({ job: "ossmgr-e2e/redis/new-proof", jenkinsfile: "pipeline { agent any }" }, context(fetcher)) as Record<string, unknown>;
  assert.equal(plan.operation, "create");
  assert.equal(plan.expectedConfigDigest, "missing");
});
