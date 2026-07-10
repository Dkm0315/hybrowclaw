import { createHash } from "node:crypto";

type JsonRecord = Record<string, unknown>;

const KNOWN_MCP: Record<string, {
  category: string;
  risk: "medium" | "high";
  auth: "none" | "local" | "api_key" | "oauth";
  command: string;
  setupUrls: string[];
  notes: string[];
}> = {
  filesystem: {
    category: "workspace",
    risk: "high",
    auth: "local",
    command: "muster mcp install filesystem",
    setupUrls: ["https://github.com/modelcontextprotocol/servers"],
    notes: ["Filesystem MCP should be scoped to the current workspace or a specific directory."],
  },
  git: {
    category: "developer",
    risk: "medium",
    auth: "local",
    command: "muster mcp install git",
    setupUrls: ["https://github.com/modelcontextprotocol/servers"],
    notes: ["Git MCP is a good default developer server and does not need cloud auth."],
  },
  github: {
    category: "developer",
    risk: "high",
    auth: "api_key",
    command: "muster mcp install github",
    setupUrls: ["https://github.com/settings/tokens"],
    notes: ["Requires GITHUB_PERSONAL_ACCESS_TOKEN or GITHUB_TOKEN."],
  },
  browser: {
    category: "web",
    risk: "high",
    auth: "local",
    command: "muster mcp install browser",
    setupUrls: ["https://github.com/microsoft/playwright-mcp"],
    notes: ["Browser MCP should stay explicit because it can inspect live pages and screenshots."],
  },
  postgres: {
    category: "data",
    risk: "high",
    auth: "api_key",
    command: "muster mcp install postgres",
    setupUrls: ["https://github.com/modelcontextprotocol/servers"],
    notes: ["Requires DATABASE_URL and should start read-only whenever possible."],
  },
  sqlite: {
    category: "data",
    risk: "medium",
    auth: "local",
    command: "muster mcp install sqlite",
    setupUrls: ["https://github.com/modelcontextprotocol/servers"],
    notes: ["Good local default for compact project data and memory inspection."],
  },
  "parallel-search": {
    category: "web",
    risk: "medium",
    auth: "none",
    command: "muster mcp install parallel-search",
    setupUrls: ["https://docs.parallel.ai/integrations/mcp/search-mcp"],
    notes: ["Hosted Streamable HTTP endpoint; useful for fast web retrieval."],
  },
  firecrawl: {
    category: "web",
    risk: "high",
    auth: "api_key",
    command: "muster mcp install firecrawl",
    setupUrls: ["https://www.firecrawl.dev/app/api-keys"],
    notes: ["Requires FIRECRAWL_API_KEY."],
  },
  linear: {
    category: "productivity",
    risk: "high",
    auth: "oauth",
    command: "muster mcp install linear && muster mcp oauth setup linear",
    setupUrls: ["https://linear.app/docs/mcp"],
    notes: ["OAuth setup should open/print the provider authorization URL."],
  },
  notion: {
    category: "productivity",
    risk: "high",
    auth: "oauth",
    command: "muster mcp install notion && muster mcp oauth setup notion",
    setupUrls: ["https://mcp.notion.com/mcp", "https://developers.notion.com/docs/mcp"],
    notes: ["Keep the /mcp path in the server URL for protected-resource validation."],
  },
  n8n: {
    category: "automation",
    risk: "high",
    auth: "api_key",
    command: "muster mcp install n8n",
    setupUrls: ["https://github.com/CyberSamuraiX/hermes-n8n-mcp"],
    notes: ["Requires N8N_BASE_URL and N8N_API_KEY; default tools should stay read-mostly."],
  },
};

const SHELL_INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "fish", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe"]);
const IOC_SUBSTRINGS = ["AAAAC3NzaC1lZDI1NTE5AAAAICBoh1oDC4DnsO1m5mJ4yfEKrQebaFh", "hermes-0day", "60.165.167.", "118.182.244.156", "61.178.123.196"];
const EGRESS_PATTERN = /(?<![\w.-])(?:curl|wget|nc|ncat|socat)(?![\w.-])|\/dev\/tcp\/|\bInvoke-WebRequest\b|\bInvoke-RestMethod\b|\bSystem\.Net\.WebClient\b/i;
const EXFIL_HINT_PATTERN = /\.env\b|--data-binary|--data-raw|\b-X\s+POST\b|\bPOST\b|<\s*[^\s]+/i;
const PERSISTENCE_PATTERN = /authorized_keys|\.ssh\/|\/etc\/ssh\b|\/etc\/pam\.d\b|pam_[\w-]+\.so|\/etc\/sudoers|\/etc\/cron|crontab\b|\/etc\/rc\.local|\/etc\/systemd|\.bashrc\b|\.bash_profile\b|\.profile\b|\.zshrc\b/i;
const SECRET_KEY_PATTERN = /(?:^|_)(?:authorization|api_?key|access_?token|refresh_?token|password|passwd|secret|cookie|private_?key)(?:$|_)/i;
const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:sk|ghp|github_pat|xox[baprs])-[-A-Za-z0-9_]{8,}\b/gi,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
];
const DEFAULT_RESULT_CAP = 8_000;
const MAX_RESULT_CAP = 65_536;

type SanitizationState = {
  redactions: number;
  omitted: number;
  sourceChars: number;
  seen: WeakSet<object>;
};

type McpAuthMode = "none" | "local" | "api_key" | "oauth";
type McpAuthStatus = "ready" | "missing" | "expired" | "denied";

function stringArg(args: JsonRecord, key: string, fallback = ""): string {
  return typeof args[key] === "string" && String(args[key]).trim() ? String(args[key]).trim() : fallback;
}

function identifierArg(args: JsonRecord, key: string, fallback: string): string {
  const value = stringArg(args, key, fallback);
  return /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value) ? value : fallback;
}

function safeIdentifierList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(String).map((item) => item.trim()).filter((item) => /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(item)).slice(0, 256)
    : [];
}

function safeScope(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized)) return undefined;
  return normalized.length <= 160 ? normalized : `sha256:${sha256(normalized)}`;
}

function safeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim() || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function listArg(args: JsonRecord, key: string): string[] {
  const value = args[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function asRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function redactString(value: string, state: SanitizationState): string {
  state.sourceChars += value.length;
  let output = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    output = output.replace(pattern, () => {
      state.redactions += 1;
      return "[REDACTED]";
    });
  }
  if (output.length > 4_096) {
    state.omitted += output.length - 4_096;
    output = `${output.slice(0, 4_096)}...[value truncated]`;
  }
  return output;
}

function sanitizeValue(value: unknown, state: SanitizationState, depth = 0): unknown {
  if (depth > 6) {
    state.omitted += 1;
    return "[depth truncated]";
  }
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value ?? null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return redactString(value, state);
  if (typeof value !== "object") return String(value);
  if (state.seen.has(value)) {
    state.omitted += 1;
    return "[circular]";
  }
  state.seen.add(value);
  if (ArrayBuffer.isView(value)) {
    state.sourceChars += value.byteLength;
    state.omitted += value.byteLength;
    return `[binary view omitted: ${value.byteLength} bytes]`;
  }
  if (Array.isArray(value)) {
    const limited = value.slice(0, 100).map((item) => sanitizeValue(item, state, depth + 1));
    if (value.length > limited.length) {
      state.omitted += value.length - limited.length;
      limited.push(`[${value.length - limited.length} items omitted]`);
    }
    return limited;
  }
  let entries: Array<[string, PropertyDescriptor]>;
  try {
    entries = Object.entries(Object.getOwnPropertyDescriptors(value)).sort(([left], [right]) => left.localeCompare(right));
  } catch {
    state.omitted += 1;
    return "[uninspectable object]";
  }
  const output: JsonRecord = {};
  for (const [key, descriptor] of entries.slice(0, 100)) {
    state.sourceChars += key.length;
    if (SECRET_KEY_PATTERN.test(key)) {
      state.redactions += 1;
      output[key] = "[REDACTED]";
    } else if (!("value" in descriptor)) {
      state.omitted += 1;
      output[key] = "[accessor omitted]";
    } else {
      output[key] = sanitizeValue(descriptor.value, state, depth + 1);
    }
  }
  if (entries.length > 100) {
    state.omitted += entries.length - 100;
    output.__omittedKeys = entries.length - 100;
  }
  return output;
}

function sanitizedPayload(value: unknown): {
  text: string;
  sourceChars: number;
  redactions: number;
  omitted: number;
} {
  const state: SanitizationState = { redactions: 0, omitted: 0, sourceChars: 0, seen: new WeakSet() };
  const sanitized = sanitizeValue(value, state);
  return {
    text: typeof sanitized === "string" ? sanitized : JSON.stringify(sanitized),
    sourceChars: state.sourceChars,
    redactions: state.redactions,
    omitted: state.omitted,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function cappedPreview(payload: ReturnType<typeof sanitizedPayload>, cap: number): {
  preview: string;
  truncated: boolean;
} {
  if (payload.text.length <= cap) return { preview: payload.text, truncated: payload.omitted > 0 };
  const marker = `\n...[truncated; sanitized_sha256=${sha256(payload.text).slice(0, 16)}]`;
  return { preview: `${payload.text.slice(0, Math.max(0, cap - marker.length))}${marker}`, truncated: true };
}

function sanitizeUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = "[REDACTED]";
      url.password = "[REDACTED]";
    }
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_KEY_PATTERN.test(key)) url.searchParams.set(key, "[REDACTED]");
    }
    return url.toString();
  } catch {
    return "[invalid URL redacted]";
  }
}

function authMode(value: unknown): McpAuthMode {
  return value === "local" || value === "api_key" || value === "oauth" ? value : "none";
}

function authStatus(value: unknown, mode: McpAuthMode): McpAuthStatus {
  if (value === "ready" || value === "missing" || value === "expired" || value === "denied") return value;
  return mode === "none" || mode === "local" ? "ready" : "missing";
}

function mcpCustomerPackDependencies(): JsonRecord {
  return {
    required: [
      { id: "identity-scope", contract: "tenantId, runId, actorId, and customer-pack id" },
      { id: "policy-engine", contract: "tool allowlist, mutation approval, call budget, and data classification" },
      { id: "secret-store", contract: "opaque auth handles; never raw provider credentials in pack config or receipts" },
      { id: "audit-ledger", contract: "append MCP receipt and token-ledger linkage" },
    ],
    optional: [
      { id: "provider-host", contract: "explicit discovery receipt for reusable MCP/skill handles" },
      { id: "artifact-store", contract: "persist oversized/full MCP results outside model context" },
    ],
    rule: "Customer packs depend on generic interfaces and explicit scopes, never customer or provider names.",
  };
}

export async function mcp_bridge_provider_reuse(args: JsonRecord): Promise<JsonRecord> {
  const host = asRecord(args.providerHost ?? args.host);
  const validId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value.trim());
  const discovered = asArray(host.capabilities).map(asRecord).filter((item) => validId(item.id));
  const approved = new Set(Array.isArray(host.approved) ? host.approved.filter(validId).map((item) => item.trim()) : []);
  const discoveryConfirmed = host.discoveryConfirmed === true;
  return {
    providerId: validId(host.providerId) ? host.providerId.trim() : undefined,
    discoveryId: validId(host.discoveryId) ? host.discoveryId.trim() : undefined,
    discoveryConfirmed,
    capabilities: discovered.map((item) => {
      const id = String(item.id).trim();
      const kind = item.kind === "skill" ? "skill" : "mcp";
      return {
        id,
        kind,
        auth: authMode(item.auth),
        reusable: discoveryConfirmed && approved.has(id),
        reason: !discoveryConfirmed
          ? "provider discovery was not explicitly confirmed"
          : approved.has(id)
            ? "explicitly discovered and approved for host-routed reuse"
            : "capability was discovered but not approved",
      };
    }),
    rules: [
      "No provider name is inferred or special-cased.",
      "Only explicitly discovered and approved capability ids are reusable.",
      "Reuse routes through an opaque host handle; it never copies credentials into Muster.",
      "Users can still configure an independent Muster-native MCP explicitly.",
    ],
  };
}

export async function mcp_bridge_result_receipt(args: JsonRecord): Promise<JsonRecord> {
  const server = identifierArg(args, "server", "unknown");
  const tool = identifierArg(args, "tool", "unknown");
  const include = safeIdentifierList(args.include);
  const exclude = safeIdentifierList(args.exclude);
  const allowlistRequired = args.requireAllowlist !== false;
  const allowed = (!allowlistRequired || include.includes(tool)) && !exclude.includes(tool);
  const auth = asRecord(args.auth);
  const mode = authMode(auth.mode);
  const authentication = authStatus(auth.status, mode);
  const readiness = asRecord(args.readiness);
  const readinessStatus = readiness.status === "ready" || readiness.status === "failed" || readiness.status === "degraded"
    ? readiness.status
    : "unverified";
  const readinessRequired = args.requireReady !== false;
  const maxResultChars = boundedInteger(asRecord(args.limits).maxResultChars, DEFAULT_RESULT_CAP, 256, MAX_RESULT_CAP);
  const timeoutMs = boundedInteger(asRecord(args.limits).toolTimeoutMs, 30_000, 100, 120_000);
  const input = sanitizedPayload(args.input ?? {});
  const output = sanitizedPayload(args.result ?? "");
  const preview = cappedPreview(output, maxResultChars);
  const explicitError = typeof args.error === "string" && args.error.trim() ? redactString(args.error, { redactions: 0, omitted: 0, sourceChars: 0, seen: new WeakSet() }) : undefined;
  let blockedReason: string | undefined;
  if (args.isolated === false) blockedReason = "MCP server execution is not isolated.";
  else if (allowlistRequired && include.length === 0) blockedReason = "An explicit tool include allowlist is required.";
  else if (!allowed) blockedReason = `Tool ${tool} is outside the configured allowlist.`;
  else if (authentication !== "ready") blockedReason = `Authentication is ${authentication}.`;
  else if (readinessStatus === "failed" || (readinessRequired && readinessStatus === "unverified")) {
    blockedReason = `MCP server readiness is ${readinessStatus}.`;
  }
  const status = blockedReason ? "blocked" : explicitError ? "failed" : "succeeded";
  const startedAt = safeTimestamp(args.startedAt) ?? new Date().toISOString();
  return {
    schemaVersion: 1,
    kind: "muster-mcp-receipt",
    receiptId: identifierArg(args, "receiptId", "") || `mcp_${sha256(`${safeScope(args.tenantId) ?? ""}\0${safeScope(args.runId) ?? ""}\0${server}\0${tool}\0${startedAt}`).slice(0, 24)}`,
    tenantId: safeScope(args.tenantId),
    runId: safeScope(args.runId),
    customerPackId: safeScope(args.customerPackId),
    server,
    tool,
    status,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: boundedInteger(args.durationMs, 0, 0, Number.MAX_SAFE_INTEGER),
    inputSha256: sha256(input.text),
    output: status === "succeeded" ? {
      preview: preview.preview,
      sourceChars: output.sourceChars,
      previewChars: preview.preview.length,
      truncated: preview.truncated,
      redactions: output.redactions,
      omitted: output.omitted,
      sanitizedSha256: sha256(output.text),
    } : {
      preview: "",
      sourceChars: 0,
      previewChars: 0,
      truncated: false,
      redactions: 0,
      omitted: 0,
      sanitizedSha256: sha256(""),
    },
    auth: { mode, status: authentication },
    readiness: { status: readinessStatus, checkedAt: safeTimestamp(readiness.checkedAt) },
    policy: {
      include,
      exclude,
      allowlistRequired,
      allowed,
      maxResultChars,
      timeoutMs,
      maxCallsPerTurn: boundedInteger(asRecord(args.limits).maxCallsPerTurn, 8, 1, 100),
    },
    isolation: {
      perServerSupervisor: args.isolated !== false,
      timeoutEnforced: true,
      resultCapEnforced: true,
      failureContained: true,
    },
    tokenLedgerId: safeScope(args.tokenLedgerId),
    artifactIds: safeIdentifierList(args.artifactIds),
    failureReason: blockedReason ?? explicitError,
  };
}

function commandBasename(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const first = text.split(/\s+/)[0] ?? text;
  return first.split(/[\\/]/).pop()?.toLowerCase() ?? first.toLowerCase();
}

function flattenEntry(entry: JsonRecord): string {
  const parts = [String(entry.command ?? "")];
  const args = entry.args;
  if (Array.isArray(args)) parts.push(args.map(String).join(" "));
  else if (args !== undefined) parts.push(String(args));
  const env = asRecord(entry.env);
  parts.push(...Object.values(env).map(String));
  return parts.join(" ");
}

function validateEntry(name: string, entry: JsonRecord): string[] {
  const issues: string[] = [];
  const flat = flattenEntry(entry);
  for (const ioc of IOC_SUBSTRINGS) {
    if (flat.includes(ioc)) {
      return [`MCP server '${name}' contains a known hermes-0day indicator-of-compromise ('${ioc}')`];
    }
  }
  const command = entry.command;
  const basename = commandBasename(command);
  if (!SHELL_INTERPRETERS.has(basename)) return issues;
  const script = Array.isArray(entry.args) ? entry.args.map(String).join(" ") : String(entry.args ?? "");
  if (!script) return issues;
  if (EGRESS_PATTERN.test(script)) {
    issues.push(`MCP server '${name}' uses shell interpreter '${String(command)}' with network egress in args${EXFIL_HINT_PATTERN.test(script) ? " and exfiltration-shaped arguments" : ""}`);
  }
  if (PERSISTENCE_PATTERN.test(script)) {
    issues.push(`MCP server '${name}' uses shell interpreter '${String(command)}' to write to an OS persistence surface; this matches the hermes-0day backdoor class, not a normal MCP server`);
  }
  return issues;
}

function normalizeServerConfig(server: JsonRecord): JsonRecord {
  const transport = asRecord(server.transport);
  if (transport.kind) return server;
  if (typeof server.command === "string") {
    return { ...server, transport: { kind: "stdio", command: server.command, args: Array.isArray(server.args) ? server.args : [] } };
  }
  if (typeof server.url === "string") {
    return { ...server, transport: { kind: "http", url: server.url, headers: asRecord(server.headers) } };
  }
  return server;
}

export async function mcp_bridge_setup_plan(args: JsonRecord): Promise<JsonRecord> {
  const requested = listArg(args, "servers");
  const ids = requested.length ? requested : ["git", "sqlite", "parallel-search", "github", "notion"];
  return {
    contractVersion: 1,
    principles: [
      "Prefer curated built-ins before arbitrary commands.",
      "Use stdio for local tools, HTTP/OAuth for remote services.",
      "Pass only explicit env vars to stdio servers; never inherit the whole shell env.",
      "Run mcp check before install, then mcp test after install.",
      "Use OAuth setup for auth-heavy remote MCPs instead of hand-writing bearer tokens.",
      "Emit a bounded, redacted receipt for every call and link it to the run/token ledger.",
      "Reuse provider-hosted MCPs or skills only through explicit provider discovery and approval.",
    ],
    execution: {
      authReadiness: ["none/local ready", "API key present through secret reference", "OAuth ready and unexpired"],
      toolPolicy: "include allowlist preferred; mutating tools require approval",
      timeoutMs: { default: 30_000, minimum: 100, maximum: 120_000 },
      resultChars: { default: DEFAULT_RESULT_CAP, maximum: MAX_RESULT_CAP },
      isolation: "one supervisor/circuit breaker per server; timeout or crash cannot take down other servers",
      receipt: "tenant/run/server/tool, input hash, bounded redacted preview, auth/readiness, policy, duration, ledger/artifact links",
    },
    providerReuse: await mcp_bridge_provider_reuse(args),
    customerPackDependencies: mcpCustomerPackDependencies(),
    servers: ids.map((id) => {
      const entry = KNOWN_MCP[id];
      return entry ? {
        id,
        category: entry.category,
        risk: entry.risk,
        auth: entry.auth,
        check: `muster mcp check ${id}`,
        install: entry.command,
        test: `muster mcp test ${id}`,
        setupUrls: entry.setupUrls,
        notes: entry.notes,
      } : {
        id,
        status: "unknown",
        addStdio: `muster mcp add-stdio ${id} <command> [args...]`,
        addHttp: `muster mcp add-http ${id} <url> [--oauth ...]`,
      };
    }),
  };
}

export async function mcp_bridge_config_lint(args: JsonRecord): Promise<JsonRecord> {
  const rawServers = asRecord(args.servers ?? args.config);
  const findings = Object.entries(rawServers).map(([name, value]) => {
    const server = normalizeServerConfig(asRecord(value));
    const transport = asRecord(server.transport);
    const limits = asRecord(server.limits);
    const toolPolicy = asRecord(server.tools);
    const headers = asRecord(transport.headers);
    const issues = validateEntry(name, {
      command: transport.command ?? server.command,
      args: transport.args ?? server.args,
      env: transport.env ?? server.env,
    });
    const shapeIssues: string[] = [];
    if (transport.kind !== "stdio" && transport.kind !== "http") shapeIssues.push("transport.kind must be stdio or http.");
    if (transport.kind === "stdio" && typeof transport.command !== "string") shapeIssues.push("stdio transport requires command.");
    if (transport.kind === "http" && typeof transport.url !== "string") shapeIssues.push("http transport requires url.");
    if (transport.kind === "stdio" && Object.keys(asRecord(transport.env)).length === 0) {
      shapeIssues.push("stdio transport has no explicit env; this is safest unless the server needs a named token.");
    }
    if (!Array.isArray(toolPolicy.include) && !Array.isArray(toolPolicy.exclude)) {
      shapeIssues.push("no explicit tool allowlist/exclude policy; use include for auth-heavy or mutating servers.");
    }
    if (limits.toolTimeoutMs !== undefined && boundedInteger(limits.toolTimeoutMs, -1, -1, 120_001) < 100) {
      shapeIssues.push("limits.toolTimeoutMs must be at least 100ms.");
    }
    if (limits.maxResultChars !== undefined) {
      const resultCap = Number(limits.maxResultChars);
      if (!Number.isFinite(resultCap) || resultCap < 256 || resultCap > MAX_RESULT_CAP) {
        shapeIssues.push(`limits.maxResultChars must be between 256 and ${MAX_RESULT_CAP}.`);
      }
    }
    if (Object.keys(headers).some((key) => key.toLowerCase() === "authorization")) {
      shapeIssues.push("static Authorization headers are not readiness-safe; use an OAuth or secret-reference auth handle.");
    }
    const configuredAuth = authMode(server.auth);
    return {
      name,
      transport: transport.kind ?? "unknown",
      command: transport.kind === "stdio" ? transport.command : undefined,
      url: transport.kind === "http" ? sanitizeUrl(transport.url) : undefined,
      auth: {
        mode: configuredAuth,
        readiness: configuredAuth === "none" || configuredAuth === "local" ? "ready" : "requires_runtime_check",
      },
      limits: {
        toolTimeoutMs: boundedInteger(limits.toolTimeoutMs, 30_000, 100, 120_000),
        maxResultChars: boundedInteger(limits.maxResultChars, DEFAULT_RESULT_CAP, 256, MAX_RESULT_CAP),
        maxCallsPerTurn: boundedInteger(limits.maxCallsPerTurn, 8, 1, 100),
      },
      issues: [...issues, ...shapeIssues],
      ok: issues.length === 0 && shapeIssues.filter((issue) => !issue.includes("no explicit env") && !issue.includes("no explicit tool allowlist")).length === 0,
    };
  });
  return {
    checked: findings.length,
    blocked: findings.filter((finding) => finding.issues.some((issue) =>
      issue.includes("indicator-of-compromise")
      || issue.includes("network egress")
      || issue.includes("persistence")
      || issue.includes("static Authorization")
      || issue.includes("limits.maxResultChars")
      || issue.includes("limits.toolTimeoutMs"),
    )).length,
    warnings: findings.reduce((count, finding) => count + finding.issues.length, 0),
    findings,
    customerPackDependencies: mcpCustomerPackDependencies(),
  };
}

export async function mcp_bridge_install_workflow(args: JsonRecord): Promise<JsonRecord> {
  const id = stringArg(args, "id");
  if (!id) return { error: 'mcp_bridge_install_workflow requires "id".' };
  const entry = KNOWN_MCP[id];
  if (!entry) {
    const unknown = {
      id,
      known: false,
      commands: [
        `muster mcp add-stdio ${id} <command> [args...]`,
        `muster mcp add-http ${id} <url> [--oauth --setup-url URL --client-id ID ...]`,
        `muster mcp test ${id}`,
      ],
      note: "Unknown MCPs should be treated as custom high-risk integrations until reviewed.",
    };
    return args.hardened === true ? {
      ...unknown,
      readiness: ["lint", "authenticate", "discover tools", "apply allowlist", "bounded live test", "enable"],
      execution: { timeoutMs: 30_000, maxResultChars: DEFAULT_RESULT_CAP, isolated: true, receiptRequired: true },
      customerPackDependencies: mcpCustomerPackDependencies(),
    } : unknown;
  }
  const known = {
    id,
    known: true,
    risk: entry.risk,
    auth: entry.auth,
    commands: [
      `muster mcp check ${id}`,
      entry.command,
      ...(entry.auth === "oauth" ? [`muster mcp oauth status ${id}`, `muster mcp oauth setup ${id}`] : []),
      `muster mcp test ${id}`,
      `muster plugins enable mcp-bridge --allow-high-risk`,
    ],
    setupUrls: entry.setupUrls,
    notes: entry.notes,
  };
  return args.hardened === true ? {
    ...known,
    readiness: ["config_lint", entry.auth === "oauth" ? "oauth_ready" : entry.auth === "api_key" ? "secret_reference_ready" : "local_ready", "tool_discovery", "allowlist_review", "bounded_live_test", "enable"],
    execution: { timeoutMs: 30_000, maxResultChars: DEFAULT_RESULT_CAP, maxCallsPerTurn: 8, isolated: true, receiptRequired: true },
    customerPackDependencies: mcpCustomerPackDependencies(),
  } : known;
}

export async function mcp_bridge_tool_policy(args: JsonRecord): Promise<JsonRecord> {
  const include = listArg(args, "include");
  const exclude = listArg(args, "exclude");
  const server = stringArg(args, "server", "<server>");
  const policy = {
    server,
    include,
    exclude,
    recommended: include.length
      ? { tools: { include } }
      : exclude.length
        ? { tools: { exclude } }
        : { tools: "all discovered tools enabled; use include for high-risk servers" },
    guidance: [
      "Prefer include allowlists for auth-heavy or mutating MCP servers.",
      "Keep read-only/list/get/export tools enabled first.",
      "Add write/delete/admin tools only after a successful mcp test and explicit user approval.",
    ],
  };
  if (!("result" in args) && args.receipt !== true) return policy;
  return {
    ...policy,
    execution: {
      toolTimeoutMs: boundedInteger(asRecord(args.limits).toolTimeoutMs, 30_000, 100, 120_000),
      maxResultChars: boundedInteger(asRecord(args.limits).maxResultChars, DEFAULT_RESULT_CAP, 256, MAX_RESULT_CAP),
      isolated: true,
    },
    receipt: await mcp_bridge_result_receipt({ ...args, server, include, exclude }),
    customerPackDependencies: mcpCustomerPackDependencies(),
  };
}

export const tools = {
  mcp_bridge_setup_plan,
  mcp_bridge_config_lint,
  mcp_bridge_install_workflow,
  mcp_bridge_tool_policy,
};
