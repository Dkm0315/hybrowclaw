# Safe workflow modules

Muster represents Claude Code-style workflows as inert, versioned data before execution. The authoring model retains named phases, sequential steps, `agent()`, bounded `parallel()` lanes, nested agents and subworkflows, result schemas, approvals, verification, and compensation. It does not evaluate or dynamically import an untrusted `.js` or `.mjs` file.

The trust boundary is:

1. A UI, AI planner, or trusted extractor produces a plain descriptor or strict JSON.
2. `normalizeWorkflowDescriptor()` (or its parse alias, `parseWorkflowModule()`) rejects executable values, accessors, custom prototypes, circular data, unknown fields, unsafe schema references, duplicate labels, unbounded repeats, and size/depth/fan-out/parallelism violations.
3. The normalized descriptor is cloned, defaulted to finite limits, and deeply frozen.
4. `compileWorkflowModule()` converts it to the existing `AgentGraphDefinition` and runs the graph validator again. Nothing is dispatchable unless both validations pass.
5. `exportWorkflowModule()` can produce a deterministic, human-readable `.mjs` review artifact using `phase()`, `agent()`, `parallel()`, and `subworkflow()`. This is an export format, not an import mechanism.

Every workflow declares an overall budget and bounded limits. Repetition additionally requires an iteration ceiling, progress predicate, cancellation checkpoint, and its own budget. Effects that require human control are explicit `approval` steps. An effect may name an explicit `compensation` step, and verification is represented as a first-class graph node.

Prompts and goals remain ordinary strings, so placeholders such as `{{ input.company }}` can be resolved later by a governed runtime. The compatibility layer does not interpolate them, invoke a provider, call tools, or grant capabilities. Those remain separate execution-time policy decisions.

Legacy JavaScript must be converted by a trusted static extractor into the descriptor shape. Passing raw source text such as `export default ...` to `parseWorkflowModule()` fails closed. Muster must never use `eval`, `new Function`, `vm`, or dynamic `import()` to ingest user workflow source.
