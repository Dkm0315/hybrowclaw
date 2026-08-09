import { createHash } from "node:crypto";

export interface JenkinsContext {
  readonly fetch?: typeof globalThis.fetch;
  readonly config: Readonly<Record<string, string | undefined>>;
}

type Json = Record<string, unknown>;

const DEFAULT_ROOTS = ["ossmgr-builds", "ossmgr-e2e", "ossmgr-reports", "ossmgr-docker-capability-probe"];
const MAX_CONFIG_BYTES = 512_000;
const MAX_CONSOLE_CHARS = 24_000;

function textArg(args: Json, name: string): string {
  return typeof args[name] === "string" ? args[name].trim() : "";
}

function positiveInt(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), max)
    : fallback;
}

function record(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function configuredRoots(context: JenkinsContext): string[] {
  const configured = context.config.allowedRoots?.split(",").map((value) => value.trim()).filter(Boolean);
  return configured?.length ? configured : DEFAULT_ROOTS;
}

function normalizeJobPath(value: string): string {
  const path = value.trim().replace(/^\/+|\/+$/g, "");
  const segments = path.split("/").filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === "." || segment === ".." || /[\0\r\n?#]/.test(segment))) {
    throw new Error("A valid Jenkins job path is required.");
  }
  return segments.join("/");
}

function allowedJob(path: string, context: JenkinsContext): boolean {
  const normalized = normalizeJobPath(path);
  return configuredRoots(context).some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

function jobUrlPath(path: string): string {
  return normalizeJobPath(path).split("/").map((segment) => `job/${encodeURIComponent(segment)}`).join("/");
}

function connection(context: JenkinsContext): { base: string; authorization: string } | { error: string } {
  const baseValue = context.config.JENKINS_URL?.trim();
  const user = context.config.JENKINS_USER?.trim();
  const password = context.config.JENKINS_PASSWORD;
  if (!baseValue || !user || !password) return { error: "Jenkins connection is not configured." };
  let url: URL;
  try {
    url = new URL(baseValue);
  } catch {
    return { error: "JENKINS_URL is invalid." };
  }
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
    return { error: "Jenkins must use HTTPS unless it is bound to loopback." };
  }
  return {
    base: url.toString().replace(/\/$/, ""),
    authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`,
  };
}

function redact(value: string, context: JenkinsContext): string {
  let result = value;
  for (const secret of [context.config.JENKINS_USER, context.config.JENKINS_PASSWORD]) {
    if (secret && secret.length >= 3) result = result.replaceAll(secret, "[redacted]");
  }
  return result
    .replace(/(authorization|token|password|secret|api[_-]?key)\s*[:=]\s*[^\s]+/gi, "$1=[redacted]")
    .replace(/https?:\/\/[^\s:@/]+:[^\s@/]+@/g, "https://[redacted]@");
}

async function request(
  context: JenkinsContext,
  path: string,
  options: { readonly method?: string; readonly body?: string; readonly contentType?: string; readonly crumb?: boolean } = {},
): Promise<{ ok: true; status: number; text: string; headers: Headers } | { ok: false; status?: number; error: string }> {
  if (!context.fetch) return { ok: false, error: "The Jenkins pack has no network permission." };
  const target = connection(context);
  if ("error" in target) return { ok: false, error: target.error };
  const headers: Record<string, string> = { authorization: target.authorization, accept: "application/json" };
  if (options.contentType) headers["content-type"] = options.contentType;
  if (options.crumb) {
    const crumb = await request(context, "/crumbIssuer/api/json");
    if (!crumb.ok) return crumb;
    const parsed = record(JSON.parse(crumb.text));
    if (typeof parsed.crumbRequestField === "string" && typeof parsed.crumb === "string") {
      headers[parsed.crumbRequestField] = parsed.crumb;
    }
  }
  let response: Response;
  try {
    response = await context.fetch(`${target.base}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    return { ok: false, error: `Jenkins request failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const text = await response.text();
  if (!response.ok) return { ok: false, status: response.status, error: redact(text || `HTTP ${response.status}`, context).slice(0, 2000) };
  return { ok: true, status: response.status, text, headers: response.headers };
}

function parseJson(text: string): Json {
  try {
    return record(JSON.parse(text));
  } catch {
    throw new Error("Jenkins returned malformed JSON.");
  }
}

function jobSummary(value: unknown): Json {
  const item = record(value);
  const last = record(item.lastBuild);
  return {
    name: item.name,
    url: item.url,
    state: item.color,
    kind: item._class,
    lastBuild: Object.keys(last).length ? {
      number: last.number,
      result: last.result,
      building: last.building,
      timestamp: last.timestamp,
      url: last.url,
    } : null,
  };
}

function buildSummary(value: unknown): Json {
  const item = record(value);
  return {
    number: item.number,
    result: item.result,
    building: item.building,
    timestamp: item.timestamp,
    duration: item.duration,
    url: item.url,
    displayName: item.displayName,
  };
}

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function scriptFromConfig(xml: string): string | undefined {
  const match = xml.match(/<script>([\s\S]*?)<\/script>/);
  return match?.[1]
    ?.replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function workflowXml(script: string): string {
  return `<?xml version='1.1' encoding='UTF-8'?>\n<flow-definition plugin="workflow-job">\n  <actions/>\n  <description>Managed through Muster governed Jenkins integration.</description>\n  <keepDependencies>false</keepDependencies>\n  <properties/>\n  <definition class="org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition" plugin="workflow-cps">\n    <script>${escapeXml(script)}</script>\n    <sandbox>true</sandbox>\n  </definition>\n  <triggers/>\n  <disabled>false</disabled>\n</flow-definition>\n`;
}

function pipelineXml(current: { readonly exists: boolean; readonly xml: string }, script: string): string {
  if (!current.exists) return workflowXml(script);
  if (scriptFromConfig(current.xml) === script) return current.xml;
  if (!/<script>[\s\S]*?<\/script>/.test(current.xml)) {
    throw new Error("Existing Jenkins job is not an inline Pipeline script and cannot be modified by this connector.");
  }
  return current.xml.replace(/<script>[\s\S]*?<\/script>/, `<script>${escapeXml(script)}</script>`);
}

async function currentConfig(context: JenkinsContext, job: string): Promise<{ exists: boolean; xml: string; digest: string } | { error: string }> {
  const response = await request(context, `/${jobUrlPath(job)}/config.xml`);
  if (!response.ok && response.status === 404) return { exists: false, xml: "", digest: "missing" };
  if ("error" in response) return { error: response.error };
  if (response.text.length > MAX_CONFIG_BYTES) return { error: "Jenkins job configuration exceeds the inspection limit." };
  return { exists: true, xml: response.text, digest: hash(response.text) };
}

export async function jenkins_connection_check(_args: Json, context: JenkinsContext) {
  const response = await request(context, "/api/json?tree=mode,nodeDescription");
  if (!response.ok) return response;
  const data = parseJson(response.text);
  return { ok: true, mode: data.mode, nodeDescription: data.nodeDescription, allowedRoots: configuredRoots(context), mutationEnabled: context.config.allowMutation === "true" };
}

export async function jenkins_jobs_list(args: Json, context: JenkinsContext) {
  const requestedRoot = textArg(args, "root");
  const roots = requestedRoot ? [normalizeJobPath(requestedRoot)] : configuredRoots(context);
  if (roots.some((root) => !allowedJob(root, context))) return { error: "Requested Jenkins root is outside the configured OSS Manager allowlist." };
  const jobs: Json[] = [];
  for (const root of roots) {
    const response = await request(context, `/${jobUrlPath(root)}/api/json?tree=name,url,color,_class,jobs[name,url,color,_class,lastBuild[number,url,timestamp,result,building]]`);
    if (!response.ok) return response;
    const data = parseJson(response.text);
    const children = array(data.jobs);
    jobs.push(children.length ? { root, jobs: children.map(jobSummary) } : { root, jobs: [jobSummary(data)] });
  }
  return { roots: jobs };
}

export async function jenkins_builds_list(args: Json, context: JenkinsContext) {
  const job = normalizeJobPath(textArg(args, "job"));
  if (!allowedJob(job, context)) return { error: "Requested Jenkins job is outside the configured OSS Manager allowlist." };
  const limit = positiveInt(args.limit, 20, 100);
  const response = await request(context, `/${jobUrlPath(job)}/api/json?tree=name,url,builds[number,url,result,building,timestamp,duration,displayName]{0,${limit}}`);
  if (!response.ok) return response;
  const data = parseJson(response.text);
  const builds = array(data.builds).map(buildSummary).sort((left, right) => Number(right.timestamp ?? 0) - Number(left.timestamp ?? 0));
  return { job, order: "newest_first", builds };
}

export async function jenkins_build_inspect(args: Json, context: JenkinsContext) {
  const job = normalizeJobPath(textArg(args, "job"));
  if (!allowedJob(job, context)) return { error: "Requested Jenkins job is outside the configured OSS Manager allowlist." };
  const build = positiveInt(args.build, 0, Number.MAX_SAFE_INTEGER);
  if (!build) return { error: "A positive build number is required." };
  const response = await request(context, `/${jobUrlPath(job)}/${build}/api/json?tree=number,url,result,building,timestamp,duration,displayName,description,changeSets[items[commitId,msg,author[fullName],timestamp,affectedPaths]],artifacts[fileName,relativePath],actions[parameters[name,value]]`);
  if (!response.ok) return response;
  const data = parseJson(response.text);
  return { job, build: buildSummary(data), description: data.description, changeSets: data.changeSets, artifacts: data.artifacts, actions: data.actions };
}

export async function jenkins_console_tail(args: Json, context: JenkinsContext) {
  const job = normalizeJobPath(textArg(args, "job"));
  if (!allowedJob(job, context)) return { error: "Requested Jenkins job is outside the configured OSS Manager allowlist." };
  const build = positiveInt(args.build, 0, Number.MAX_SAFE_INTEGER);
  if (!build) return { error: "A positive build number is required." };
  const chars = positiveInt(args.chars, 8000, MAX_CONSOLE_CHARS);
  const response = await request(context, `/${jobUrlPath(job)}/${build}/consoleText`);
  if (!response.ok) return response;
  const clean = redact(response.text, context);
  return { job, build, truncated: clean.length > chars, tail: clean.slice(-chars) };
}

export async function jenkins_pipeline_read(args: Json, context: JenkinsContext) {
  const job = normalizeJobPath(textArg(args, "job"));
  if (!allowedJob(job, context)) return { error: "Requested Jenkins job is outside the configured OSS Manager allowlist." };
  const current = await currentConfig(context, job);
  if ("error" in current) return current;
  return { job, exists: current.exists, configDigest: current.digest, script: current.exists ? scriptFromConfig(current.xml) : undefined };
}

export async function jenkins_pipeline_plan(args: Json, context: JenkinsContext) {
  const job = normalizeJobPath(textArg(args, "job"));
  const script = textArg(args, "jenkinsfile");
  if (!allowedJob(job, context)) return { error: "Requested Jenkins job is outside the configured OSS Manager allowlist." };
  if (!script || script.length > 200_000) return { error: "jenkinsfile must contain 1 to 200000 characters." };
  const current = await currentConfig(context, job);
  if ("error" in current) return current;
  let xml: string;
  try {
    xml = pipelineXml(current, script);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const proposedDigest = hash(xml);
  return {
    job,
    operation: current.exists ? "update" : "create",
    expectedConfigDigest: current.digest,
    proposedConfigDigest: proposedDigest,
    planDigest: hash(`${job}\0${current.digest}\0${proposedDigest}`),
    confirmation: `APPLY ${job}`,
    mutationEnabled: context.config.allowMutation === "true",
    changed: current.digest !== proposedDigest,
  };
}

export async function jenkins_pipeline_apply(args: Json, context: JenkinsContext) {
  const job = normalizeJobPath(textArg(args, "job"));
  const script = textArg(args, "jenkinsfile");
  if (!allowedJob(job, context)) return { error: "Requested Jenkins job is outside the configured OSS Manager allowlist." };
  if (context.config.allowMutation !== "true") return { error: "Jenkins mutation is disabled for this deployment." };
  if (textArg(args, "confirmation") !== `APPLY ${job}`) return { error: `Exact confirmation required: APPLY ${job}` };
  const current = await currentConfig(context, job);
  if ("error" in current) return current;
  let xml: string;
  try {
    xml = pipelineXml(current, script);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const proposedDigest = hash(xml);
  const expected = textArg(args, "expectedConfigDigest");
  const planDigest = textArg(args, "planDigest");
  if (expected !== current.digest) return { error: "Jenkins configuration changed after planning; create a fresh plan." };
  if (planDigest !== hash(`${job}\0${current.digest}\0${proposedDigest}`)) return { error: "Pipeline plan digest does not match this exact job and Jenkinsfile." };
  let path: string;
  if (current.exists) {
    path = `/${jobUrlPath(job)}/config.xml`;
  } else {
    const segments = job.split("/");
    const name = segments.pop()!;
    if (!segments.length) return { error: "Creating a new top-level Jenkins job is not allowed." };
    path = `/${jobUrlPath(segments.join("/"))}/createItem?name=${encodeURIComponent(name)}`;
  }
  const response = await request(context, path, { method: "POST", body: xml, contentType: "application/xml", crumb: true });
  if (!response.ok) return response;
  const verified = await currentConfig(context, job);
  if ("error" in verified) return verified;
  if (!verified.exists || verified.digest !== proposedDigest) return { error: "Jenkins accepted the write but post-write configuration verification failed." };
  return { ok: true, job, operation: current.exists ? "updated" : "created", configDigest: verified.digest };
}

export async function jenkins_build_trigger(args: Json, context: JenkinsContext) {
  const job = normalizeJobPath(textArg(args, "job"));
  if (!allowedJob(job, context)) return { error: "Requested Jenkins job is outside the configured OSS Manager allowlist." };
  if (context.config.allowMutation !== "true") return { error: "Jenkins mutation is disabled for this deployment." };
  if (textArg(args, "confirmation") !== `RUN ${job}`) return { error: `Exact confirmation required: RUN ${job}` };
  const response = await request(context, `/${jobUrlPath(job)}/build`, { method: "POST", crumb: true });
  if (!response.ok) return response;
  return { ok: true, job, queued: true, queueUrl: response.headers.get("location") ?? undefined };
}

export const tools = {
  jenkins_connection_check,
  jenkins_jobs_list,
  jenkins_builds_list,
  jenkins_build_inspect,
  jenkins_console_tail,
  jenkins_pipeline_read,
  jenkins_pipeline_plan,
  jenkins_pipeline_apply,
  jenkins_build_trigger,
};
