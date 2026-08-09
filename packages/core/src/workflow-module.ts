import {
  DEFAULT_AGENT_GRAPH_LIMITS,
  parseAgentGraph,
  type AgentGraphBudget,
  type AgentGraphDefinition,
  type AgentGraphEdge,
  type AgentGraphLimits,
  type AgentGraphNode,
} from "./agent-graph.js";

/**
 * Safe, data-only compatibility format for the phase()/agent()/parallel() style
 * used by Claude Code workflow artifacts. Muster never imports or evaluates an
 * untrusted JavaScript module. A trusted extractor must first produce this IR.
 */

export const DEFAULT_WORKFLOW_BUDGET: AgentGraphBudget = Object.freeze({
  runtimeMs: 15 * 60_000,
  toolCalls: 100,
  modelCalls: 32,
  tokens: 200_000,
  costMicros: 5_000_000,
  artifactBytes: 100_000_000,
});

export const DEFAULT_WORKFLOW_LIMITS = Object.freeze({
  ...DEFAULT_AGENT_GRAPH_LIMITS,
  maxDepth: 8,
  maxChildrenPerNode: 8,
  maxActiveNodes: 64,
  maxRetries: 3,
  maxParallelism: 8,
  maxPhases: 16,
  maxSteps: 64,
});

export const MAX_WORKFLOW_DESCRIPTOR_CHARS = 1_000_000;
export const MAX_WORKFLOW_STRING_CHARS = 250_000;
export const MAX_WORKFLOW_DATA_NODES = 100_000;

export type WorkflowJsonSchema = Readonly<Record<string, unknown>>;

export interface WorkflowMetaPhase {
  readonly title: string;
  readonly detail?: string;
}

export interface WorkflowMeta {
  readonly name: string;
  readonly description: string;
  readonly phases: readonly WorkflowMetaPhase[];
}

interface WorkflowStepBase {
  readonly label: string;
  readonly description?: string;
  readonly capabilities?: readonly string[];
  readonly retryLimit?: number;
  readonly resultSchema?: WorkflowJsonSchema;
  /** Label of an explicit compensation step in this workflow. */
  readonly compensation?: string;
}

export interface WorkflowAgentStep extends WorkflowStepBase {
  readonly kind: "agent";
  readonly prompt: string;
  readonly agentId?: string;
  readonly agentType?: string;
  /** Governed child agents run after the parent and count toward graph depth. */
  readonly subagents?: readonly WorkflowStep[];
}

export interface WorkflowSubworkflowStep extends WorkflowStepBase {
  readonly kind: "subworkflow";
  readonly workflowId: string;
  readonly goal: string;
  readonly steps?: readonly WorkflowStep[];
}

export interface WorkflowPhaseStep extends WorkflowStepBase {
  readonly kind: "phase";
  readonly detail?: string;
  readonly steps: readonly WorkflowStep[];
}

export interface WorkflowParallelStep extends WorkflowStepBase {
  readonly kind: "parallel";
  readonly maxConcurrency: number;
  readonly branches: readonly WorkflowStep[];
}

export interface WorkflowApprovalStep extends WorkflowStepBase {
  readonly kind: "approval";
  readonly prompt: string;
  readonly requiredRoles?: readonly string[];
}

export interface WorkflowVerificationStep extends WorkflowStepBase {
  readonly kind: "verification";
  readonly criteria: string;
}

export interface WorkflowCompensationStep extends WorkflowStepBase {
  readonly kind: "compensation";
  readonly action: string;
}

export interface WorkflowRepeatStep extends WorkflowStepBase {
  readonly kind: "repeat";
  readonly maxIterations: number;
  readonly progressPredicate: string;
  readonly cancellationCheckpoint: true;
  readonly budget: AgentGraphBudget;
  readonly steps: readonly WorkflowStep[];
}

export interface WorkflowExecutionStep extends WorkflowStepBase {
  readonly kind: "execution";
  /** Closed reviewed execution data; never mission-time authority or a tool selector. */
  readonly execution:
    | { readonly surface: "server_effect"; readonly plan: Readonly<Record<string, unknown>> }
    | { readonly surface: "browser"; readonly plan: Readonly<Record<string, unknown>> };
}

export type WorkflowStep =
  | WorkflowAgentStep
  | WorkflowSubworkflowStep
  | WorkflowPhaseStep
  | WorkflowParallelStep
  | WorkflowApprovalStep
  | WorkflowVerificationStep
  | WorkflowCompensationStep
  | WorkflowRepeatStep
  | WorkflowExecutionStep;

export interface WorkflowLimits extends AgentGraphLimits {
  readonly maxParallelism?: number;
  readonly maxPhases?: number;
  readonly maxSteps?: number;
}

export interface WorkflowModuleDefinition {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly meta: WorkflowMeta;
  readonly goal: string;
  readonly inputSchema?: WorkflowJsonSchema;
  readonly resultSchema: WorkflowJsonSchema;
  readonly budget: AgentGraphBudget;
  readonly limits: WorkflowLimits;
  readonly steps: readonly WorkflowStep[];
}

export interface WorkflowModuleIssue {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

const ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.:-]*$/;
const CAPABILITY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.:-]*$/;
const SAFE_SCHEMA_KEYS = new Set([
  "type", "title", "description", "default", "enum", "const", "properties", "required",
  "additionalProperties", "items", "minItems", "maxItems", "minimum", "maximum", "minLength",
  "maxLength", "pattern", "format", "oneOf", "anyOf", "allOf",
]);
const SCHEMA_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateDataOnly(
  value: unknown,
  path: string,
  issues: WorkflowModuleIssue[],
  seen = new WeakSet<object>(),
  state = { nodes: 0, exceeded: false },
): void {
  if (state.exceeded) return;
  state.nodes += 1;
  if (state.nodes > MAX_WORKFLOW_DATA_NODES) {
    state.exceeded = true;
    issues.push({ code: "descriptor_size", message: `Workflow data exceeds ${MAX_WORKFLOW_DATA_NODES} values.`, path });
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (value.length > MAX_WORKFLOW_STRING_CHARS) issues.push({ code: "descriptor_size", message: `String exceeds ${MAX_WORKFLOW_STRING_CHARS} characters.`, path });
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) issues.push({ code: "unsafe_value", message: "Numbers must be finite.", path });
    return;
  }
  if (typeof value !== "object") {
    issues.push({ code: "unsafe_value", message: `Executable or non-JSON value (${typeof value}) is forbidden.`, path });
    return;
  }
  if (seen.has(value)) {
    issues.push({ code: "unsafe_value", message: "Circular data is forbidden.", path });
    return;
  }
  seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  if ((!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) || (Array.isArray(value) && prototype !== Array.prototype)) {
    issues.push({ code: "unsafe_value", message: "Only plain data objects are accepted.", path });
    return;
  }
  if (Object.getOwnPropertySymbols(value).length) issues.push({ code: "unsafe_value", message: "Symbol properties are forbidden.", path });
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (key === "length" && Array.isArray(value)) continue;
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      issues.push({ code: "unsafe_key", message: `Dangerous object key "${key}" is forbidden.`, path: `${path}.${key}` });
      continue;
    }
    if (descriptor.get || descriptor.set) {
      issues.push({ code: "unsafe_value", message: "Accessor properties are forbidden.", path: `${path}.${key}` });
    } else validateDataOnly(descriptor.value, `${path}.${key}`, issues, seen, state);
  }
  seen.delete(value);
}

function ownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, path: string, issues: WorkflowModuleIssue[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push({ code: "unknown_field", message: `Unknown field "${key}".`, path: `${path}.${key}` });
  }
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function validateBudget(value: unknown, path: string, issues: WorkflowModuleIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ code: "invalid_budget", message: "A finite budget object is required.", path });
    return;
  }
  const fields = ["runtimeMs", "toolCalls", "modelCalls", "tokens", "costMicros", "artifactBytes"] as const;
  ownKeys(value, new Set(fields), path, issues);
  for (const field of fields) {
    if (!finiteNonNegative(value[field])) issues.push({ code: "invalid_budget", message: `${field} must be finite and non-negative.`, path: `${path}.${field}` });
  }
}

function validateSchema(value: unknown, path: string, issues: WorkflowModuleIssue[], depth = 0): void {
  if (!isRecord(value) || depth > 12) {
    issues.push({ code: "invalid_schema", message: depth > 12 ? "Schema nesting exceeds 12." : "Schema must be an object.", path });
    return;
  }
  ownKeys(value, SAFE_SCHEMA_KEYS, path, issues);
  if (value.$ref !== undefined || value.$dynamicRef !== undefined) {
    issues.push({ code: "unsafe_schema_ref", message: "Schema references are not supported.", path });
  }
  if (value.type !== undefined && (typeof value.type !== "string" || !SCHEMA_TYPES.has(value.type))) {
    issues.push({ code: "invalid_schema", message: "Schema type is unsupported.", path: `${path}.type` });
  }
  if (value.required !== undefined && (!Array.isArray(value.required) || value.required.some((item) => typeof item !== "string"))) {
    issues.push({ code: "invalid_schema", message: "required must be a string array.", path: `${path}.required` });
  }
  if (value.additionalProperties !== undefined && typeof value.additionalProperties !== "boolean") {
    issues.push({ code: "invalid_schema", message: "additionalProperties must be boolean in the safe schema subset.", path: `${path}.additionalProperties` });
  }
  if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.length === 0 || value.enum.length > 100)) {
    issues.push({ code: "invalid_schema", message: "enum must contain 1-100 JSON values.", path: `${path}.enum` });
  }
  for (const keyword of ["minItems", "maxItems", "minLength", "maxLength"] as const) {
    if (value[keyword] !== undefined && (!Number.isInteger(value[keyword]) || (value[keyword] as number) < 0)) {
      issues.push({ code: "invalid_schema", message: `${keyword} must be a non-negative integer.`, path: `${path}.${keyword}` });
    }
  }
  for (const keyword of ["minimum", "maximum"] as const) {
    if (value[keyword] !== undefined && !finiteNonNegative(value[keyword]) && !(typeof value[keyword] === "number" && Number.isFinite(value[keyword]))) {
      issues.push({ code: "invalid_schema", message: `${keyword} must be finite.`, path: `${path}.${keyword}` });
    }
  }
  if (value.properties !== undefined) {
    if (!isRecord(value.properties)) issues.push({ code: "invalid_schema", message: "properties must be an object.", path: `${path}.properties` });
    else for (const [key, schema] of Object.entries(value.properties)) validateSchema(schema, `${path}.properties.${key}`, issues, depth + 1);
  }
  if (value.items !== undefined) validateSchema(value.items, `${path}.items`, issues, depth + 1);
  for (const union of ["oneOf", "anyOf", "allOf"] as const) {
    if (value[union] !== undefined) {
      if (!Array.isArray(value[union]) || value[union].length === 0 || value[union].length > 8) {
        issues.push({ code: "invalid_schema", message: `${union} must contain 1-8 schemas.`, path: `${path}.${union}` });
      } else value[union].forEach((schema, index) => validateSchema(schema, `${path}.${union}.${index}`, issues, depth + 1));
    }
  }
}

const BASE_FIELDS = ["kind", "label", "description", "capabilities", "retryLimit", "resultSchema", "compensation"];
const STEP_FIELDS: Record<WorkflowStep["kind"], ReadonlySet<string>> = {
  phase: new Set([...BASE_FIELDS, "detail", "steps"]),
  agent: new Set([...BASE_FIELDS, "prompt", "agentId", "agentType", "subagents"]),
  subworkflow: new Set([...BASE_FIELDS, "workflowId", "goal", "steps"]),
  parallel: new Set([...BASE_FIELDS, "maxConcurrency", "branches"]),
  approval: new Set([...BASE_FIELDS, "prompt", "requiredRoles"]),
  verification: new Set([...BASE_FIELDS, "criteria"]),
  compensation: new Set([...BASE_FIELDS, "action"]),
  repeat: new Set([...BASE_FIELDS, "maxIterations", "progressPredicate", "cancellationCheckpoint", "budget", "steps"]),
  execution: new Set([...BASE_FIELDS, "execution"]),
};

const EFFECT_CAPABILITIES = new Set([
  "frappe.record.create", "frappe.record.update", "frappe.record.delete",
  "frappe.metadata.custom_field.create", "frappe.metadata.property_setter.create",
  "frappe.metadata.page.create",
  "frappe.metadata.report.create", "frappe.metadata.print_format.create",
  "frappe.metadata.web_page.create",
]);

function validateEffectIntent(value: unknown, path: string, issues: WorkflowModuleIssue[]): void {
  if (!isRecord(value)) { issues.push({ code: "invalid_effect_intent", message: "Effect intent must be a data object.", path }); return; }
  ownKeys(value, new Set(["schemaVersion", "capability", "operation", "postconditions", "approvalClass"]), path, issues);
  if (value.schemaVersion !== 1 || typeof value.capability !== "string" || !EFFECT_CAPABILITIES.has(value.capability)) {
    issues.push({ code: "invalid_effect_intent", message: "Effect capability is not supported.", path: `${path}.capability` });
  }
  if (value.approvalClass !== "single" && value.approvalClass !== "dual_control") {
    issues.push({ code: "invalid_effect_intent", message: "Effect approvalClass is invalid.", path: `${path}.approvalClass` });
  }
  const operation = value.operation;
  if (!isRecord(operation)) { issues.push({ code: "invalid_effect_intent", message: "Effect operation must be an object.", path: `${path}.operation` }); return; }
  if (operation.kind === "record") {
    ownKeys(operation, new Set(["kind", "action", "doctype", "docname", "values"]), `${path}.operation`, issues);
    if (!(["create", "update", "delete"] as unknown[]).includes(operation.action) || typeof operation.doctype !== "string" || !operation.doctype.trim()) {
      issues.push({ code: "invalid_effect_intent", message: "Only closed record create/update/delete intents are supported.", path: `${path}.operation` });
    }
    if ((operation.action === "update" || operation.action === "delete") && (typeof operation.docname !== "string" || !operation.docname.trim())) {
      issues.push({ code: "invalid_effect_intent", message: "Record update/delete requires an exact document name.", path: `${path}.operation.docname` });
    }
    if (operation.action === "delete") {
      if (operation.values !== undefined) issues.push({ code: "invalid_effect_intent", message: "Record delete cannot contain values.", path: `${path}.operation.values` });
      if (value.approvalClass !== "dual_control") issues.push({ code: "invalid_effect_intent", message: "Record delete requires dual control.", path: `${path}.approvalClass` });
    } else if (!isRecord(operation.values)) issues.push({ code: "invalid_effect_intent", message: "Record values must be a data object.", path: `${path}.operation.values` });
  } else if (operation.kind === "native_artifact") {
    ownKeys(operation, new Set(["kind", "artifactType", "intent"]), `${path}.operation`, issues);
    if (!["custom_field", "property_setter", "page", "report", "print_format", "web_page"].includes(String(operation.artifactType)) || !isRecord(operation.intent)) {
      issues.push({ code: "invalid_effect_intent", message: "Native artifact intent is unsupported or unresolved.", path: `${path}.operation` });
    } else {
      const intent = operation.intent;
      ownKeys(intent, new Set(["schema_version", "artifacts"]), `${path}.operation.intent`, issues);
      const artifacts = intent.artifacts;
      const expectedKind = operation.artifactType === "report" ? "query_report" : operation.artifactType;
      if (!Array.isArray(artifacts) || artifacts.length < 1 || artifacts.length > 50
        || artifacts.some((artifact) => !isRecord(artifact) || artifact.kind !== expectedKind)) {
        issues.push({ code: "invalid_effect_intent", message: "Native artifact kinds must exactly match the registered capability.", path: `${path}.operation.intent.artifacts` });
      }
      if (expectedKind === "print_format" && Array.isArray(artifacts) && artifacts.some((artifact) => {
        const values = isRecord(artifact) && isRecord(artifact.values) ? artifact.values : undefined;
        return Boolean(values?.trusted_template_key);
      })) issues.push({ code: "invalid_effect_intent", message: "Trusted executable templates require a separate privileged path.", path: `${path}.operation.intent.artifacts` });
      if (["report", "print_format", "web_page"].includes(String(operation.artifactType)) && value.approvalClass !== "dual_control") {
        issues.push({ code: "invalid_effect_intent", message: "Executable metadata requires dual control.", path: `${path}.approvalClass` });
      }
    }
  } else issues.push({ code: "invalid_effect_intent", message: "Effect operation kind is unsupported.", path: `${path}.operation.kind` });
  if (!Array.isArray(value.postconditions) || value.postconditions.length < 1 || value.postconditions.length > 32) {
    issues.push({ code: "invalid_effect_intent", message: "Effect intent requires bounded postconditions.", path: `${path}.postconditions` });
  } else for (const [index, rule] of value.postconditions.entries()) {
    if (!isRecord(rule)) { issues.push({ code: "invalid_effect_intent", message: "Postcondition must be an object.", path: `${path}.postconditions.${index}` }); continue; }
    const allowed = new Set(["path", "operator", ...(rule.operator === "equals" ? ["expected"] : [])]);
    ownKeys(rule, allowed, `${path}.postconditions.${index}`, issues);
    if (typeof rule.path !== "string" || !/^\$?(?:\.[A-Za-z0-9_-]+)+$/.test(rule.path)
      || !["equals", "exists", "absent"].includes(String(rule.operator))) {
      issues.push({ code: "invalid_effect_intent", message: "Postcondition is invalid.", path: `${path}.postconditions.${index}` });
    }
  }
  if (operation.kind === "native_artifact" && Array.isArray(value.postconditions)) {
    const postconditions = value.postconditions as unknown[];
    const contains = (pathValue: string, expected: unknown) => postconditions.some((rule) =>
      isRecord(rule) && rule.path === pathValue && rule.operator === "equals" && rule.expected === expected);
    if (!contains("$.status", "Verified") || !contains("$.verified", true)) {
      issues.push({ code: "invalid_effect_intent", message: "Native effects require status and independent reread postconditions.", path: `${path}.postconditions` });
    }
  }
}

function validateBrowserPlan(value: unknown, path: string, issues: WorkflowModuleIssue[]): void {
  if (!isRecord(value)) { issues.push({ code: "invalid_browser_plan", message: "Browser plan must be a data object.", path }); return; }
  ownKeys(value, new Set(["schemaVersion", "actionBudget", "actions"]), path, issues);
  if (value.schemaVersion !== 1 || !Number.isInteger(value.actionBudget) || (value.actionBudget as number) < 1 || (value.actionBudget as number) > 100
    || !Array.isArray(value.actions) || value.actions.length < 1 || value.actions.length > (value.actionBudget as number)) {
    issues.push({ code: "invalid_browser_plan", message: "Browser plan budget is invalid.", path }); return;
  }
  const kinds = new Set(["navigate", "click", "fill", "select", "upload", "screenshot", "read_visible"]);
  for (const [index, action] of value.actions.entries()) {
    const itemPath = `${path}.actions.${index}`;
    if (!isRecord(action) || !kinds.has(String(action.kind))) { issues.push({ code: "invalid_browser_plan", message: "Browser action is invalid.", path: itemPath }); continue; }
    const route = action.route;
    if (typeof route !== "string" || !route.startsWith("/desk") || /[?#\\\0]/.test(route)) {
      issues.push({ code: "invalid_browser_plan", message: "Browser route must remain in Frappe Desk.", path: `${itemPath}.route` });
    }
    const base = ["kind", "route", ...(action.doctype !== undefined ? ["doctype"] : []), ...(action.recordName !== undefined ? ["recordName"] : [])];
    const fields: Record<string, string[]> = {
      navigate: base, click: [...base, "target", "postcondition"],
      fill: [...base, "target", "field", "value", "postcondition"],
      select: [...base, "target", "field", "option", "postcondition"],
      upload: [...base, "target", "field", "artifactId", "postcondition"],
      screenshot: [...base, "scope", "redactFields"],
      read_visible: [...base, "maxChars", ...(action.target !== undefined ? ["target"] : [])],
    };
    ownKeys(action, new Set(fields[String(action.kind)]!), itemPath, issues);
    if (["click", "fill", "select", "upload"].includes(String(action.kind)) && (typeof action.doctype !== "string" || !action.doctype.trim())) {
      issues.push({ code: "invalid_browser_plan", message: "Mutating browser actions require a DocType.", path: itemPath });
    }
    if (["fill", "select", "upload"].includes(String(action.kind))
      && (typeof action.field !== "string" || !action.field.trim() || /password|passwd|secret|api.?key|token|authorization|cookie|private.?key/i.test(action.field))) {
      issues.push({ code: "invalid_browser_plan", message: "Browser field is invalid or sensitive.", path: `${itemPath}.field` });
    }
    if (action.target !== undefined) validateBrowserTarget(action.target, `${itemPath}.target`, issues);
    if (action.postcondition !== undefined) validateBrowserPostcondition(action.postcondition, `${itemPath}.postcondition`, issues);
    if (action.kind === "screenshot" && (action.scope !== "viewport_redacted" || !Array.isArray(action.redactFields) || action.redactFields.length < 1 || action.redactFields.length > 50)) {
      issues.push({ code: "invalid_browser_plan", message: "Screenshot redaction scope is invalid.", path: itemPath });
    }
  }
}

function validateBrowserTarget(value: unknown, path: string, issues: WorkflowModuleIssue[]): void {
  if (!isRecord(value)) { issues.push({ code: "invalid_browser_plan", message: "Browser target is invalid.", path }); return; }
  if (value.kind === "role") ownKeys(value, new Set(["kind", "role", "name"]), path, issues);
  else if (value.kind === "label" || value.kind === "test_id") ownKeys(value, new Set(["kind", "name"]), path, issues);
  else { issues.push({ code: "invalid_browser_plan", message: "Only semantic browser targets are supported.", path }); return; }
  if (typeof value.name !== "string" || !value.name.trim()) issues.push({ code: "invalid_browser_plan", message: "Browser target name is invalid.", path });
}

function validateBrowserPostcondition(value: unknown, path: string, issues: WorkflowModuleIssue[]): void {
  if (!isRecord(value)) { issues.push({ code: "invalid_browser_plan", message: "Browser postcondition is invalid.", path }); return; }
  if (value.kind === "route") {
    ownKeys(value, new Set(["kind", "route"]), path, issues);
    if (typeof value.route !== "string" || !value.route.startsWith("/desk") || /[?#\\\0]/.test(value.route)) issues.push({ code: "invalid_browser_plan", message: "Browser postcondition route is invalid.", path });
  } else if (value.kind === "target") {
    ownKeys(value, new Set(["kind", "target", "state"]), path, issues);
    validateBrowserTarget(value.target, `${path}.target`, issues);
    if (value.state !== "visible" && value.state !== "hidden") issues.push({ code: "invalid_browser_plan", message: "Browser postcondition state is invalid.", path });
  } else issues.push({ code: "invalid_browser_plan", message: "Browser postcondition kind is invalid.", path });
}

function validateString(value: unknown, code: string, path: string, issues: WorkflowModuleIssue[]): void {
  if (typeof value !== "string" || !value.trim()) issues.push({ code, message: "A non-empty string is required.", path });
}

function validateStringArray(value: unknown, code: string, path: string, issues: WorkflowModuleIssue[], pattern?: RegExp): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim() || (pattern && !pattern.test(item)))) {
    issues.push({ code, message: "A valid string array is required.", path });
  }
}

function validateSteps(
  value: unknown,
  path: string,
  issues: WorkflowModuleIssue[],
  state: { labels: Set<string>; count: number; phaseCount: number; maxDepth: number; maxFanout: number },
  depth: number,
): void {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({ code: "missing_steps", message: "At least one step is required.", path });
    return;
  }
  state.maxDepth = Math.max(state.maxDepth, depth);
  for (const [index, raw] of value.entries()) {
    const stepPath = `${path}.${index}`;
    state.count += 1;
    if (!isRecord(raw)) {
      issues.push({ code: "invalid_step", message: "Step must be an object.", path: stepPath });
      continue;
    }
    const kind = raw.kind;
    if (typeof kind !== "string" || !(kind in STEP_FIELDS)) {
      issues.push({ code: "invalid_step_kind", message: "Step kind is unsupported.", path: `${stepPath}.kind` });
      continue;
    }
    ownKeys(raw, STEP_FIELDS[kind as WorkflowStep["kind"]], stepPath, issues);
    validateString(raw.label, "invalid_label", `${stepPath}.label`, issues);
    if (typeof raw.label === "string" && raw.label.trim()) {
      if (state.labels.has(raw.label)) issues.push({ code: "duplicate_label", message: `Duplicate label "${raw.label}".`, path: `${stepPath}.label` });
      state.labels.add(raw.label);
    }
    if (raw.capabilities !== undefined) validateStringArray(raw.capabilities, "invalid_capabilities", `${stepPath}.capabilities`, issues, CAPABILITY_PATTERN);
    if (raw.description !== undefined) validateString(raw.description, "invalid_description", `${stepPath}.description`, issues);
    if (raw.retryLimit !== undefined && (!Number.isInteger(raw.retryLimit) || (raw.retryLimit as number) < 0)) {
      issues.push({ code: "invalid_retry", message: "retryLimit must be a non-negative integer.", path: `${stepPath}.retryLimit` });
    }
    if (raw.resultSchema !== undefined) validateSchema(raw.resultSchema, `${stepPath}.resultSchema`, issues);
    if (raw.compensation !== undefined) validateString(raw.compensation, "invalid_compensation", `${stepPath}.compensation`, issues);

    switch (kind) {
      case "phase":
        if (raw.detail !== undefined) validateString(raw.detail, "invalid_detail", `${stepPath}.detail`, issues);
        state.phaseCount += 1;
        validateSteps(raw.steps, `${stepPath}.steps`, issues, state, depth + 1);
        break;
      case "agent":
        validateString(raw.prompt, "invalid_prompt", `${stepPath}.prompt`, issues);
        if (raw.agentId !== undefined && (typeof raw.agentId !== "string" || !ID_PATTERN.test(raw.agentId))) issues.push({ code: "invalid_agent_id", message: "agentId is invalid.", path: `${stepPath}.agentId` });
        if (raw.agentType !== undefined) validateString(raw.agentType, "invalid_agent_type", `${stepPath}.agentType`, issues);
        if (raw.subagents !== undefined) validateSteps(raw.subagents, `${stepPath}.subagents`, issues, state, depth + 1);
        break;
      case "subworkflow":
        validateString(raw.workflowId, "invalid_workflow_id", `${stepPath}.workflowId`, issues);
        validateString(raw.goal, "invalid_goal", `${stepPath}.goal`, issues);
        if (raw.steps !== undefined) validateSteps(raw.steps, `${stepPath}.steps`, issues, state, depth + 1);
        break;
      case "parallel":
        if (!positiveInteger(raw.maxConcurrency)) issues.push({ code: "invalid_parallelism", message: "maxConcurrency must be a positive integer.", path: `${stepPath}.maxConcurrency` });
        if (Array.isArray(raw.branches)) state.maxFanout = Math.max(state.maxFanout, raw.branches.length);
        validateSteps(raw.branches, `${stepPath}.branches`, issues, state, depth + 1);
        break;
      case "approval":
        validateString(raw.prompt, "invalid_prompt", `${stepPath}.prompt`, issues);
        if (raw.requiredRoles !== undefined) validateStringArray(raw.requiredRoles, "invalid_roles", `${stepPath}.requiredRoles`, issues);
        break;
      case "verification": validateString(raw.criteria, "invalid_criteria", `${stepPath}.criteria`, issues); break;
      case "compensation": validateString(raw.action, "invalid_action", `${stepPath}.action`, issues); break;
      case "repeat":
        if (!positiveInteger(raw.maxIterations)) issues.push({ code: "unbounded_loop", message: "repeat requires a positive maxIterations.", path: `${stepPath}.maxIterations` });
        validateString(raw.progressPredicate, "unbounded_loop", `${stepPath}.progressPredicate`, issues);
        if (raw.cancellationCheckpoint !== true) issues.push({ code: "unbounded_loop", message: "repeat requires cancellationCheckpoint: true.", path: `${stepPath}.cancellationCheckpoint` });
        validateBudget(raw.budget, `${stepPath}.budget`, issues);
        validateSteps(raw.steps, `${stepPath}.steps`, issues, state, depth + 1);
        break;
      case "execution": {
        const execution = isRecord(raw.execution) ? raw.execution : undefined;
        if (!execution) issues.push({ code: "invalid_execution", message: "Execution must be a data object.", path: `${stepPath}.execution` });
        else {
          ownKeys(execution, new Set(["surface", "plan"]), `${stepPath}.execution`, issues);
          if (execution.surface === "server_effect") validateEffectIntent(execution.plan, `${stepPath}.execution.plan`, issues);
          else if (execution.surface === "browser") {
            validateBrowserPlan(execution.plan, `${stepPath}.execution.plan`, issues);
            const actions = isRecord(execution.plan) && Array.isArray(execution.plan.actions) ? execution.plan.actions : [];
            const capabilityByKind: Record<string, string> = {
              navigate: "frappe.browser.navigate", click: "frappe.browser.click", fill: "frappe.browser.fill",
              select: "frappe.browser.select", upload: "frappe.browser.upload",
              screenshot: "frappe.browser.screenshot", read_visible: "frappe.browser.read_visible",
            };
            const requested = new Set(Array.isArray(raw.capabilities) ? raw.capabilities : []);
            if (actions.some((action) => !isRecord(action) || !requested.has(capabilityByKind[String(action.kind)]))) {
              issues.push({ code: "invalid_browser_plan", message: "Browser plan exceeds its requested capabilities.", path: `${stepPath}.capabilities` });
            }
          } else issues.push({ code: "invalid_execution", message: "Execution surface is unsupported.", path: `${stepPath}.execution.surface` });
        }
        if (execution?.surface === "server_effect" && (!Array.isArray(raw.capabilities) || raw.capabilities.length !== 1
          || raw.capabilities[0] !== (execution.plan as Record<string, unknown> | undefined)?.capability)) {
          issues.push({ code: "invalid_effect_intent", message: "Effect capability must exactly match its sole requested capability.", path: `${stepPath}.capabilities` });
        }
        break;
      }
    }
    if (raw.compensation === raw.label) issues.push({ code: "invalid_compensation", message: "A step cannot compensate itself.", path: `${stepPath}.compensation` });
  }
}

export function validateWorkflowModule(value: unknown): WorkflowModuleIssue[] {
  const issues: WorkflowModuleIssue[] = [];
  validateDataOnly(value, "$", issues);
  if (issues.length) return issues;
  if (!isRecord(value)) return [{ code: "invalid_workflow", message: "Workflow must be a data object.", path: "$" }];
  if (JSON.stringify(value).length > MAX_WORKFLOW_DESCRIPTOR_CHARS) {
    return [{ code: "descriptor_size", message: `Workflow descriptor exceeds ${MAX_WORKFLOW_DESCRIPTOR_CHARS} characters.`, path: "$" }];
  }
  ownKeys(value, new Set(["schemaVersion", "id", "version", "meta", "goal", "inputSchema", "resultSchema", "budget", "limits", "steps"]), "$", issues);
  if (value.schemaVersion !== 1) issues.push({ code: "unsupported_schema", message: "schemaVersion must be 1.", path: "$.schemaVersion" });
  if (typeof value.id !== "string" || !ID_PATTERN.test(value.id)) issues.push({ code: "invalid_id", message: "Workflow id is invalid.", path: "$.id" });
  validateString(value.version, "invalid_version", "$.version", issues);
  validateString(value.goal, "invalid_goal", "$.goal", issues);
  validateBudget(value.budget, "$.budget", issues);
  if (value.inputSchema !== undefined) validateSchema(value.inputSchema, "$.inputSchema", issues);
  validateSchema(value.resultSchema, "$.resultSchema", issues);

  if (!isRecord(value.meta)) issues.push({ code: "invalid_meta", message: "meta is required.", path: "$.meta" });
  else {
    ownKeys(value.meta, new Set(["name", "description", "phases"]), "$.meta", issues);
    validateString(value.meta.name, "invalid_meta", "$.meta.name", issues);
    validateString(value.meta.description, "invalid_meta", "$.meta.description", issues);
    if (!Array.isArray(value.meta.phases) || value.meta.phases.length === 0) issues.push({ code: "invalid_meta", message: "meta.phases must not be empty.", path: "$.meta.phases" });
    else for (const [index, phase] of value.meta.phases.entries()) {
      if (!isRecord(phase)) issues.push({ code: "invalid_meta", message: "Phase metadata must be an object.", path: `$.meta.phases.${index}` });
      else {
        ownKeys(phase, new Set(["title", "detail"]), `$.meta.phases.${index}`, issues);
        validateString(phase.title, "invalid_meta", `$.meta.phases.${index}.title`, issues);
        if (phase.detail !== undefined) validateString(phase.detail, "invalid_meta", `$.meta.phases.${index}.detail`, issues);
      }
    }
  }

  const limits = isRecord(value.limits) ? value.limits : {};
  if (!isRecord(value.limits)) issues.push({ code: "invalid_limits", message: "Bounded limits are required.", path: "$.limits" });
  else ownKeys(limits, new Set(["maxDepth", "maxChildrenPerNode", "maxActiveNodes", "maxRetries", "maxParallelism", "maxPhases", "maxSteps"]), "$.limits", issues);
  const effective = { ...DEFAULT_WORKFLOW_LIMITS, ...limits };
  for (const [key, limit] of Object.entries(effective)) if (!positiveInteger(limit)) issues.push({ code: "invalid_limits", message: `${key} must be a positive integer.`, path: `$.limits.${key}` });

  const state = { labels: new Set<string>(), count: 0, phaseCount: 0, maxDepth: 0, maxFanout: 0 };
  validateSteps(value.steps, "$.steps", issues, state, 1);
  if (state.count > effective.maxSteps) issues.push({ code: "step_limit", message: `Workflow has ${state.count} steps; limit is ${effective.maxSteps}.`, path: "$.steps" });
  if (state.maxDepth > effective.maxDepth) issues.push({ code: "depth_limit", message: `Workflow nesting is ${state.maxDepth}; limit is ${effective.maxDepth}.`, path: "$.steps" });
  if (state.maxFanout > effective.maxChildrenPerNode) issues.push({ code: "fanout_limit", message: `Workflow fan-out is ${state.maxFanout}; limit is ${effective.maxChildrenPerNode}.`, path: "$.steps" });
  if (state.phaseCount > effective.maxPhases) issues.push({ code: "phase_limit", message: `Workflow has ${state.phaseCount} executable phases; limit is ${effective.maxPhases}.`, path: "$.steps" });
  if (isRecord(value.meta) && Array.isArray(value.meta.phases) && value.meta.phases.length > effective.maxPhases) issues.push({ code: "phase_limit", message: `Workflow has too many phases.`, path: "$.meta.phases" });

  const compensationLabels = new Set<string>();
  const walk = (steps: unknown): void => {
    if (!Array.isArray(steps)) return;
    for (const raw of steps) if (isRecord(raw)) {
      if (raw.kind === "compensation" && typeof raw.label === "string") compensationLabels.add(raw.label);
      walk(raw.steps); walk(raw.subagents); walk(raw.branches);
      if (raw.kind === "parallel" && positiveInteger(raw.maxConcurrency) && raw.maxConcurrency > effective.maxParallelism) {
        issues.push({ code: "parallelism_limit", message: `maxConcurrency exceeds ${effective.maxParallelism}.`, path: "$.steps" });
      }
    }
  };
  walk(value.steps);
  const checkCompensation = (steps: unknown): void => {
    if (!Array.isArray(steps)) return;
    for (const raw of steps) if (isRecord(raw)) {
      if (typeof raw.compensation === "string" && !compensationLabels.has(raw.compensation)) issues.push({ code: "invalid_compensation", message: `Unknown compensation label "${raw.compensation}".`, path: "$.steps" });
      checkCompensation(raw.steps); checkCompensation(raw.subagents); checkCompensation(raw.branches);
    }
  };
  checkCompensation(value.steps);
  return issues;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** Accept a plain object or strict JSON. JavaScript source is deliberately rejected. */
export function parseWorkflowModule(value: unknown): WorkflowModuleDefinition {
  let candidate = value;
  if (typeof value === "string") {
    if (value.length > MAX_WORKFLOW_DESCRIPTOR_CHARS) throw new Error(`Invalid workflow module: descriptor exceeds ${MAX_WORKFLOW_DESCRIPTOR_CHARS} characters.`);
    try { candidate = JSON.parse(value); }
    catch { throw new Error("Unsafe workflow source rejected: import a JSON descriptor; Muster never evals or dynamically imports workflow JavaScript."); }
  }
  const issues = validateWorkflowModule(candidate);
  if (issues.length) throw new Error(`Invalid workflow module:\n${issues.map((issue) => `- [${issue.code}] ${issue.path}: ${issue.message}`).join("\n")}`);
  const parsed = clone(candidate as WorkflowModuleDefinition);
  return deepFreeze({ ...parsed, limits: { ...DEFAULT_WORKFLOW_LIMITS, ...parsed.limits } });
}

/** Explicit normalization entrypoint for descriptors emitted by a trusted static extractor or AI planner. */
export function normalizeWorkflowDescriptor(value: unknown): WorkflowModuleDefinition {
  return parseWorkflowModule(value);
}

export function defineWorkflow(value: WorkflowModuleDefinition): WorkflowModuleDefinition {
  return parseWorkflowModule(value);
}

export function phase(label: string, options: Omit<WorkflowPhaseStep, "kind" | "label">): WorkflowPhaseStep {
  return { kind: "phase", label, ...options };
}

export function agent(options: Omit<WorkflowAgentStep, "kind">): WorkflowAgentStep {
  return { kind: "agent", ...options };
}

export function parallel(label: string, options: Omit<WorkflowParallelStep, "kind" | "label">): WorkflowParallelStep {
  return { kind: "parallel", label, ...options };
}

export function subworkflow(options: Omit<WorkflowSubworkflowStep, "kind">): WorkflowSubworkflowStep {
  return { kind: "subworkflow", ...options };
}

/** Builder for approval, verification, compensation, and repeat descriptors. */
export function workflowStep<T extends Exclude<WorkflowStep, WorkflowPhaseStep | WorkflowAgentStep | WorkflowParallelStep | WorkflowSubworkflowStep>>(value: T): T {
  return value;
}

interface Fragment { entry: string; exits: string[] }

function nodeId(label: string, ordinal: number): string {
  const stem = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "step";
  return `n${ordinal}-${stem}`;
}

/** Compile validated workflow IR into the existing portable AgentGraphDefinition. */
export function compileWorkflowModule(value: unknown): AgentGraphDefinition {
  const workflow = parseWorkflowModule(value);
  const nodes: AgentGraphNode[] = [];
  const edges: AgentGraphEdge[] = [];
  const labels = new Map<string, string>();
  const pendingCompensations: Array<{ node: AgentGraphNode; label: string }> = [];

  const addNode = (step: WorkflowStep, kind: AgentGraphNode["kind"]): AgentGraphNode => {
    const graphRetryCeiling = workflow.limits.maxRetries ?? DEFAULT_AGENT_GRAPH_LIMITS.maxRetries;
    const node: AgentGraphNode = {
      id: nodeId(step.label, nodes.length + 1), kind,
      ...(step.kind === "agent" && step.agentId ? { agentId: step.agentId } : {}),
      ...(step.capabilities ? { requestedCapabilities: [...step.capabilities] } : {}),
      retryLimit: step.retryLimit ?? Math.min(DEFAULT_AGENT_GRAPH_LIMITS.maxRetries, graphRetryCeiling),
    };
    nodes.push(node); labels.set(step.label, node.id);
    if (step.compensation) pendingCompensations.push({ node, label: step.compensation });
    return node;
  };

  const sequence = (steps: readonly WorkflowStep[]): Fragment => {
    const fragments = steps.filter((step) => step.kind !== "compensation").map(build);
    if (fragments.length === 0) throw new Error("Invalid workflow module: a sequence must contain an executable non-compensation step.");
    for (let index = 0; index < fragments.length - 1; index++) {
      for (const exit of fragments[index].exits) edges.push({ from: exit, to: fragments[index + 1].entry });
    }
    return { entry: fragments[0].entry, exits: fragments.at(-1)!.exits };
  };

  const build = (step: WorkflowStep): Fragment => {
    const kinds = { phase: "plan", agent: "agent", subworkflow: "subworkflow", parallel: "parallel_map", approval: "approval", verification: "verification", compensation: "compensation", repeat: "loop", execution: "command" } as const;
    let node = addNode(step, kinds[step.kind]);
    if (step.kind === "execution") {
      node = { ...node, executionIntent: step.execution };
      nodes[nodes.length - 1] = node;
    }
    if (step.kind === "repeat") {
      node = { ...node, loop: { maxIterations: step.maxIterations, progressPredicate: step.progressPredicate, cancellationCheckpoint: true, budget: step.budget } };
      nodes[nodes.length - 1] = node;
    }
    const children = step.kind === "phase" || step.kind === "repeat" || step.kind === "subworkflow" ? step.steps
      : step.kind === "agent" ? step.subagents : undefined;
    if (children?.length) {
      const child = sequence(children);
      edges.push({ from: node.id, to: child.entry });
      return { entry: node.id, exits: child.exits };
    }
    if (step.kind === "parallel") {
      const branches = step.branches.map(build);
      const join: AgentGraphNode = {
        id: nodeId(`${step.label}-join`, nodes.length + 1),
        kind: "transform",
        retryLimit: Math.min(DEFAULT_AGENT_GRAPH_LIMITS.maxRetries, workflow.limits.maxRetries ?? DEFAULT_AGENT_GRAPH_LIMITS.maxRetries),
      };
      nodes.push(join);
      for (const branch of branches) {
        edges.push({ from: node.id, to: branch.entry });
        for (const exit of branch.exits) edges.push({ from: exit, to: join.id });
      }
      return { entry: node.id, exits: [join.id] };
    }
    return { entry: node.id, exits: [node.id] };
  };

  const root = sequence(workflow.steps);
  const addCompensationNodes = (steps: readonly WorkflowStep[]): void => {
    for (const step of steps) {
      if (step.kind === "compensation") addNode(step, "compensation");
      if (step.kind === "phase" || step.kind === "repeat" || step.kind === "subworkflow") {
        if (step.steps) addCompensationNodes(step.steps);
      } else if (step.kind === "agent" && step.subagents) addCompensationNodes(step.subagents);
      else if (step.kind === "parallel") addCompensationNodes(step.branches);
    }
  };
  addCompensationNodes(workflow.steps);
  for (const pending of pendingCompensations) {
    const compensationNodeId = labels.get(pending.label);
    if (!compensationNodeId) throw new Error(`Invalid workflow module: unresolved compensation "${pending.label}".`);
    const index = nodes.findIndex((node) => node.id === pending.node.id);
    nodes[index] = { ...nodes[index], compensationNodeId };
    edges.push({ from: pending.node.id, to: compensationNodeId, when: "compensation.requested" });
  }
  const graph: AgentGraphDefinition = {
    schemaVersion: 1, id: workflow.id, version: workflow.version, entryNodeId: root.entry,
    nodes, edges, budget: workflow.budget,
    limits: {
      maxDepth: workflow.limits.maxDepth,
      maxChildrenPerNode: workflow.limits.maxChildrenPerNode,
      maxActiveNodes: workflow.limits.maxActiveNodes,
      maxRetries: workflow.limits.maxRetries,
    },
  };
  return parseAgentGraph(graph);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function safeJson(value: unknown, indent = 0): string {
  return JSON.stringify(canonicalize(value), null, 2).replace(/[\u2028\u2029]/g, (char) => char === "\u2028" ? "\\u2028" : "\\u2029")
    .split("\n").map((line, index) => index === 0 ? line : `${" ".repeat(indent)}${line}`).join("\n");
}

function exportStep(step: WorkflowStep, indent: number): string {
  const pad = " ".repeat(indent);
  const nested = (steps: readonly WorkflowStep[]) => `[\n${steps.map((child) => `${" ".repeat(indent + 2)}${exportStep(child, indent + 2)}`).join(",\n")}\n${pad}]`;
  if (step.kind === "phase") {
    const options = { ...step, kind: undefined, label: undefined, steps: undefined } as Record<string, unknown>;
    const fields = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
    return `phase(${safeJson(step.label)}, { ...${safeJson(fields, indent)}, steps: ${nested(step.steps)} })`;
  }
  if (step.kind === "parallel") {
    const options = { ...step, kind: undefined, label: undefined, branches: undefined } as Record<string, unknown>;
    const fields = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
    return `parallel(${safeJson(step.label)}, { ...${safeJson(fields, indent)}, branches: ${nested(step.branches)} })`;
  }
  if (step.kind === "agent" || step.kind === "subworkflow") {
    const { kind: _kind, ...options } = step;
    return `${step.kind === "agent" ? "agent" : "subworkflow"}(${safeJson(options, indent)})`;
  }
  return `workflowStep(${safeJson(step, indent)})`;
}

/** Deterministic, reviewable authoring artifact. It is export-only; runtime uses the validated IR. */
export function exportWorkflowModule(value: unknown): string {
  const workflow = parseWorkflowModule(value);
  const header = {
    schemaVersion: workflow.schemaVersion, id: workflow.id, version: workflow.version, meta: workflow.meta,
    goal: workflow.goal, ...(workflow.inputSchema ? { inputSchema: workflow.inputSchema } : {}),
    resultSchema: workflow.resultSchema, budget: workflow.budget, limits: workflow.limits,
  };
  const source = `// Generated by Muster. Reviewable artifact; never dynamically import untrusted workflow files.\nimport { defineWorkflow, phase, agent, parallel, subworkflow, workflowStep } from "@musterhq/core";\n\nexport default defineWorkflow({\n  ...${safeJson(header, 2)},\n  steps: [\n${workflow.steps.map((step) => `    ${exportStep(step, 4)}`).join(",\n")}\n  ],\n});\n`;
  return source;
}
