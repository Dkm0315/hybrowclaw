# Learning Loops and Harness Control Planes: A Source-Code Study

**Repositories studied:** `NousResearch/hermes-agent`, `NousResearch/hermes-agent-self-evolution`, `openclaw/openclaw`, and `HKUDS/OpenHarness`  
**Code state:** upstream `main`, inspected 2026-08-28  
**Method:** source files and tests were read through GitHub's raw/code views. Repository documentation is used to locate code and explain public contracts, but conclusions below are based on implementation. Because `main` moves, links intentionally include paths rather than unstable line anchors.

## Executive summary

These projects solve different parts of the agent-harness problem.

Hermes has the most concrete **online learning loop**. Its production mechanism is not model training. It is a background agent that periodically rereads experience, then writes bounded declarative memory (`MEMORY.md`, `USER.md`) or procedural memory (`SKILL.md` plus support files). Future sessions inject the small memory snapshot and the skill index, while SQLite FTS5 retains the full searchable transcript. This creates compounding behavior with ordinary files, prompts, and tools.

The separate Hermes self-evolution repository is an **offline prompt optimizer prototype**. Its architecture says “trace → reflection → GEPA mutation → held-out fitness,” but current code does not deliver that loop end to end. The metric passed to GEPA ignores the trace and uses keyword overlap; the richer `LLMJudge` is not connected; and `SkillModule.skill_text` is a plain module attribute rather than an obviously optimizable DSPy instruction parameter. The repository contains a useful scaffold, not a production-grade evolutionary learner.

OpenClaw is the strongest **control plane**. The always-on Gateway multiplexes authenticated WebSocket RPC, HTTP compatibility APIs, channel connections, sessions, nodes, approvals, cron, and plugin routes on one port. Agent runtime events form a sequenced internal bus; the Gateway projects them into chat deltas/finals and operator events. Its plugin SDK is unusually broad, but the core design choice is sound: a typed registration contract and narrow import subpaths separate plugin ownership from core orchestration.

OpenHarness is the cleanest **reference harness loop**. A provider stream yields text deltas and a final structured assistant message; tool calls pass through validation, hooks, and permission checks; multiple calls run concurrently; every call gets a matching result; then the model is invoked again. Its context path layers cheap deterministic reduction before LLM summarization and preserves tool-use/result pairing.

The shared load-bearing pattern is small: durable event/session identity, a provider-neutral stream, a tool registry with a single execution gate, permission decisions before side effects, transcript invariants, bounded context reduction, and an asynchronous reviewer with explicit write scope. Much of the rest is product breadth.

---

## 1. Hermes Agent: learning by turning experience into durable context

### 1.1 The real skill lifecycle

Hermes treats a skill as procedural memory. The write surface is `skill_manage`, implemented in [`tools/skill_manager_tool.py`](https://github.com/NousResearch/hermes-agent/blob/main/tools/skill_manager_tool.py). It supports:

- `create`: create a directory and `SKILL.md`;
- `edit`: replace the main skill document;
- `patch`: targeted replacement in the main document or a support file;
- `write_file` / `remove_file`: manage references, templates, scripts, and assets;
- `delete`: archive/remove the skill.

The package shape follows the Agent Skills convention:

```text
<skill-name>/
  SKILL.md
  references/
  templates/
  scripts/
  assets/
```

`SKILL.md` begins with YAML frontmatter containing at least `name` and `description`, followed by Markdown instructions. Discovery and parsing live in [`agent/skill_utils.py`](https://github.com/NousResearch/hermes-agent/blob/main/agent/skill_utils.py); the prompt builder reads the frontmatter description rather than loading every body. The generated system-prompt index in [`agent/prompt_builder.py`](https://github.com/NousResearch/hermes-agent/blob/main/agent/prompt_builder.py) instructs the model to call `skill_view(name)` when a skill is relevant. This is progressive disclosure: cheap descriptions are always present; the expensive procedure and support files enter context only on demand. That is the practical meaning of agentskills.io compatibility here.

Creation “from experience” is prompted rather than learned statistically. The main prompt says to save difficult or iterative workflows and to patch a loaded skill when use exposes missing steps, wrong commands, or absent pitfalls. The active post-use path is stronger: [`agent/background_review.py`](https://github.com/NousResearch/hermes-agent/blob/main/agent/background_review.py) forks a reviewer over a conversation snapshot. Its skill-review prompt explicitly ranks actions:

1. patch a currently loaded skill;
2. patch an existing class-level umbrella;
3. add a support file beneath that umbrella;
4. create a new class-level umbrella only when nothing fits.

That ordering matters. A naive “one solved task = one new skill” loop produces a junk drawer. Hermes now tells the reviewer to consolidate knowledge into broad skills and put session-specific detail in `references/`. The same prompt rejects unresolved failures, transient setup errors, one-off narratives, and claims that a temporarily broken tool “does not work.” These are policy defenses against self-poisoning.

The background path also enforces read-before-write for existing content. `skill_view` marks paths read during the review; write actions check those marks. Provenance rules keep the autonomous reviewer away from bundled, hub-installed, pinned, external, and user-owned skills; it may mutate curator-managed material. These protections are more load-bearing than the prose exhortations because they turn ownership and stale-read rules into code.

There are still sharp edges. Agent-created skill content scanning is configurable and historically defaulted off, and frontmatter/directory-name divergence has produced read-path inconsistencies. More broadly, production Hermes validates structure, provenance, and some safety properties, but it does not automatically execute a newly written skill against a task-specific test before it becomes discoverable. Its online loop is therefore **experience distillation with guarded file mutation**, not verified behavioral learning.

### 1.2 Improve-during-use is two mechanisms, not one

Hermes improves skills through:

1. **foreground repair:** the main agent notices a loaded skill is wrong and calls `skill_manage(action="patch")` before finishing;
2. **background reflection:** counters trigger an isolated review after the user-facing response.

The review isolation is implemented in [`agent/background_review.py`](https://github.com/NousResearch/hermes-agent/blob/main/agent/background_review.py). It creates another `AIAgent`, replays either the full warm-cache history or a digest when routed to a different model, and installs a thread-local tool whitelist. The fork can use memory and skill-management tools but not shell, web, messaging, delegation, or general code execution. Writes go directly to persistent stores without polluting the foreground conversation or changing its frozen prompt prefix.

This design corrected an earlier anti-pattern: appending “consider saving memory/a skill” instructions to the next user message. Such nudges contaminate history and make backward-looking maintenance compete with the user's new task. A detached reviewer avoids both problems. It also has cancellation and aggregate input-token budgets so a new foreground turn can preempt noncritical review work.

Trigger accounting is split by signal. User-turn counts drive memory review; tool-iteration counts drive skill review. The Codex runtime documents and mirrors the same counters in [`agent/codex_runtime.py`](https://github.com/NousResearch/hermes-agent/blob/main/agent/codex_runtime.py), projecting command/file/MCP activity into Hermes-shaped tool messages before review. The exact default intervals are configuration, not architecture. What matters is that review happens after a completed response and off the main path.

### 1.3 Cross-session memory: three tiers with different jobs

Hermes memory is best understood as three tiers.

#### Tier A: bounded always-on memory

[`tools/memory_tool.py`](https://github.com/NousResearch/hermes-agent/blob/main/tools/memory_tool.py) manages delimiter-separated entries in `MEMORY.md` and `USER.md`. Defaults are small (roughly 2,200 and 1,375 characters), and writes that exceed the cap fail instead of silently evicting data. Add/replace/remove and atomic batch operations let the agent consolidate at capacity. Entries are scanned for prompt-injection and exfiltration patterns when written and again when loaded.

The snapshot is injected at session start. Freezing it is intentional: the provider can cache the stable prompt prefix, and mid-session writes become knowledge for later sessions. `MEMORY.md` stores durable environment facts, decisions, and operating lessons; `USER.md` compounds preferences and a model of the user. The distinction is semantic policy over two simple files.

#### Tier B: full transcript and FTS5 recall

All sessions and messages are stored in SQLite. The schema in [`hermes_state_common.py`](https://github.com/NousResearch/hermes-agent/blob/main/hermes_state_common.py) separates session metadata, messages, system-prompt snapshots, usage, lineage, and compaction state. It creates standard FTS5 indexes and a trigram index for substring search across CJK and other scripts; tool rows remain in the normal index but are excluded from the expensive trigram view.

[`tools/session_search_tool.py`](https://github.com/NousResearch/hermes-agent/blob/main/tools/session_search_tool.py) provides discovery, scrolling, direct session reads, and recent-session browsing. Discovery returns actual messages around an FTS match plus beginning/end “bookends,” deduplicated by session lineage. Current `main` explicitly performs **no LLM summarization in session search**. Older code and stale descriptions referred to an LLM summary path, which explains the common “FTS5 + summarization” characterization, but it is not the present retrieval implementation. The current split is better: FTS5 retrieves exact evidence cheaply; the calling agent can summarize only what it needs.

#### Tier C: active-context compression

Conversation compression is separate from cross-session search. Summary prefixes and compression lineage appear in [`agent/context_compressor.py`](https://github.com/NousResearch/hermes-agent/blob/main/agent/context_compressor.py) and are recognized by the session schema/search code so generated handoff summaries do not masquerade as user-authored bookends. Compression makes one long session fit in a context window; FTS5 keeps the original persisted history searchable.

Together the tiers compound cleanly:

```text
full transcript in SQLite
        │
        ├── on-demand exact recall through FTS5
        ├── context summaries for a long active thread
        └── periodic reviewer distills durable facts/preferences
                     │
                     ├── MEMORY.md
                     ├── USER.md
                     └── SKILL.md + support files
                              │
                         future prompt/index
```

The load-bearing insight is not “summarize everything.” It is **store raw history, retrieve exact slices, and promote only high-value facts/procedures into a tiny always-on layer**.

---

## 2. Hermes self-evolution: advertised GEPA loop versus executable code

### 2.1 Intended trace-to-improvement loop

The companion repository models a skill as text that can be optimized offline:

1. locate and parse a Hermes `SKILL.md`;
2. generate or load train/validation/holdout examples;
3. wrap the skill in a DSPy module;
4. run GEPA, which is intended to inspect failed execution traces and propose reflective mutations;
5. validate constraints;
6. compare baseline and candidate on holdout examples;
7. save both versions and metrics for human review.

[`evolution/core/dataset_builder.py`](https://github.com/NousResearch/hermes-agent-self-evolution/blob/main/evolution/core/dataset_builder.py) defines examples as `task_input`, `expected_behavior`, difficulty, category, and source. Sources may be synthetic, golden, or mined from external session histories. [`evolution/skills/skill_module.py`](https://github.com/NousResearch/hermes-agent-self-evolution/blob/main/evolution/skills/skill_module.py) wraps a task and skill text in a DSPy `ChainOfThought` signature. [`evolution/skills/evolve_skill.py`](https://github.com/NousResearch/hermes-agent-self-evolution/blob/main/evolution/skills/evolve_skill.py) orchestrates splits, optimizer compilation, holdout comparison, and artifact output.

In a correct GEPA integration, the fitness callback should return a numeric score **and actionable textual feedback derived from the trajectory**. GEPA can then select useful parents across examples and ask a reflection model to mutate the candidate based on why it failed, rather than blindly perturbing strings.

### 2.2 The implemented fitness function

[`evolution/core/fitness.py`](https://github.com/NousResearch/hermes-agent-self-evolution/blob/main/evolution/core/fitness.py) contains two different metrics:

**The richer but disconnected metric.** `LLMJudge` scores correctness, procedure following, and conciseness. `FitnessScore.composite` is:

```text
0.50 × correctness
+ 0.30 × procedure_following
+ 0.20 × conciseness
− length_penalty
```

The length penalty begins above 90% of the configured maximum and ramps to at most `0.3`. The judge also returns actionable feedback suitable for reflective mutation.

**The metric actually passed to GEPA.** `skill_fitness_metric` gives `0` for an empty output. Otherwise it starts at `0.5`, then—when expected text exists—uses:

```text
0.30 + 0.70 × |expected_words ∩ output_words| / |expected_words|
```

It ignores its `trace` argument, ignores `task_input` after reading it, does not call `LLMJudge`, and returns no textual feedback. [`evolution/skills/evolve_skill.py`](https://github.com/NousResearch/hermes-agent-self-evolution/blob/main/evolution/skills/evolve_skill.py) passes that heuristic to both `dspy.GEPA` and its `MIPROv2` fallback and uses it again for holdout scores.

This is the central audit result: **the code does not currently implement the advertised trace → diagnosis → targeted improvement loop.** It implements candidate generation/selection against a word-overlap proxy. A verbose response that repeats rubric vocabulary can outscore a correct answer stated differently.

There are further integrity gaps:

- `LLMJudge` and `FitnessScore` are imported into `evolve_skill.py` but unused.
- `SkillModule.skill_text` is a normal Python attribute passed as an input field. GEPA ordinarily optimizes predictor instructions/demos; the code assumes the optimized module will expose mutated `skill_text`, but does not establish that parameterization.
- The GEPA constructor uses an API shape that has changed across DSPy releases; any exception falls back to MIPROv2. [`pyproject.toml`](https://github.com/NousResearch/hermes-agent-self-evolution/blob/main/pyproject.toml) specifies only `dspy>=3.0.0`, making compatibility nonreproducible.
- The runner passes `skill["body"]` to the constraint validator, while `_check_skill_structure` requires that same string to begin with YAML frontmatter. A normally parsed skill therefore fails the structural check by construction; the baseline warning is ignored, but the evolved candidate takes the hard “not deploying” path.
- Baseline constraint failures merely warn and proceed.
- `run_tests` is put into config, but the orchestration shown does not call `ConstraintValidator.run_test_suite` before accepting a candidate.
- Improvement greater than zero is reported, but no statistical-significance gate or minimum effect size protects against evaluation noise.
- The output is saved beside a baseline; the code does not itself deploy the skill or create a reviewed PR.

[`evolution/core/constraints.py`](https://github.com/NousResearch/hermes-agent-self-evolution/blob/main/evolution/core/constraints.py) is still useful scaffolding: size, growth, nonempty, structural, and optional pytest checks are the right categories. But a constraint gate cannot rescue an invalid objective.

### 2.3 What is worth keeping from the companion

Keep the separation between data building, candidate execution, fitness, constraints, and deployment. Keep a frozen holdout and preserve baseline/candidate artifacts. Keep textual failure feedback as a first-class value. Discard the keyword proxy, broad exception fallback, unpinned optimizer dependency, and the assumption that any positive mean delta is improvement.

The production Hermes review loop and offline GEPA loop should also remain separate. Online use can propose or make tightly scoped Markdown changes. Offline evolution should require repeatable tasks, isolated candidate versions, enough evaluation power to detect regressions, and human promotion.

---

## 3. OpenClaw: the Gateway as control plane

### 3.1 Process and protocol boundary

OpenClaw's Gateway is one always-on process and one multiplexed port. The composition root is [`src/gateway/server.impl.ts`](https://github.com/openclaw/openclaw/blob/main/src/gateway/server.impl.ts). Startup performs database-schema preflight, loads a config snapshot, activates secrets, resolves authentication/bind/TLS, bootstraps plugins, creates HTTP and WebSocket runtime state, starts channels/cron/discovery, installs reload handling, and returns a coordinated close function.

The Gateway owns more than chat transport. [`src/gateway/server-methods-list.ts`](https://github.com/openclaw/openclaw/blob/main/src/gateway/server-methods-list.ts) enumerates RPCs for health, config, secrets, models, tools, agents, sessions, skills, approvals, pairing, nodes, cron, messaging, and chat. Events include connection challenges, agent/chat streams, session changes, presence, health, cron, node requests, and approval transitions.

[`src/gateway/server-methods.ts`](https://github.com/openclaw/openclaw/blob/main/src/gateway/server-methods.ts) builds a method registry from core handler families and plugin methods, then applies role policy, operator scopes, startup availability, session-mutation authorization, and rate limits for control-plane writes. The first WebSocket frame must establish a role/authenticated connection; operator and node are distinct roles. A node advertises machine-local capabilities and still enforces local policy; an operator controls Gateway state within scopes.

This is load-bearing because it centralizes identity, authorization, routing, and lifecycle. Session keys route work; they are not a hostile multi-tenant security boundary. OpenClaw's own deployment guidance accordingly recommends one Gateway per mutually untrusted tenant.

### 3.2 Streaming pipeline internals

The provider-facing runtime and Gateway-facing stream meet at the event bus in [`src/infra/agent-events.ts`](https://github.com/openclaw/openclaw/blob/main/src/infra/agent-events.ts). An `AgentEventPayload` contains:

```ts
{
  runId,
  seq,
  stream,   // lifecycle, assistant, tool, usage, error, item,
            // plan, approval, command_output, patch, compaction, thinking…
  ts,
  data,
  sessionKey?, sessionId?, agentId?
}
```

`emitAgentEvent` assigns per-run sequence numbers and stamps ownership from run context; subscribers receive the enriched event. Immutable run/session/agent ownership and monotonically sequenced events are essential. Bugs that lose the selected `agentId` can silently drop or misroute terminal events in explicit multi-agent configurations.

For the built-in runtime, [`src/agents/embedded-agent-runner/run.ts`](https://github.com/openclaw/openclaw/blob/main/src/agents/embedded-agent-runner/run.ts) is the orchestration center: session lanes, model/auth selection, skills and system prompt, tool surface, harness selection, timeouts, compaction, fallback, usage, and persistence. Runtime subscribers such as [`src/agents/pi-embedded-subscribe.ts`](https://github.com/openclaw/openclaw/blob/main/src/agents/pi-embedded-subscribe.ts) convert model/runtime events into assistant deltas, tool start/update/result events, reasoning, compaction, and lifecycle transitions. Tool results are sanitized before emission; final reply shaping removes silent tokens and duplicate confirmations from messaging tools.

[`src/gateway/server-chat.ts`](https://github.com/openclaw/openclaw/blob/main/src/gateway/server-chat.ts) subscribes to agent events for WebChat runs. Assistant snapshots/deltas are buffered and projected into bounded chat `delta` events; lifecycle termination flushes pending text and emits `final`, `error`, or `aborted`. Tool and lifecycle events also remain available on the richer `agent` stream for operator UIs. Persistence is separate from live delivery: a reconnect can reload history even if it missed a transient final event.

The pipeline is therefore:

```text
provider/harness stream
  → embedded runtime normalization
  → sequenced AgentEvent bus
       ├── Gateway `agent` event (rich operator stream)
       ├── Gateway `chat` delta/final projection
       ├── channel reply/block streaming
       ├── HTTP Responses/SSE projection
       └── diagnostics/audit projection
```

The event bus, ownership stamps, sequence cleanup, and terminal-state handling are load-bearing. Channel-specific chunk formatting is replaceable.

### 3.3 Plugin SDK seam

OpenClaw plugins run in-process and are trusted code, not a sandbox. The seam is an ownership and compatibility boundary.

[`src/plugins/plugin-api.types.ts`](https://github.com/openclaw/openclaw/blob/main/src/plugins/plugin-api.types.ts) defines `OpenClawPluginApi`. A plugin receives identity, config, scoped plugin config, logger, and runtime helpers, then registers capabilities: tools, hooks, HTTP routes, channels, Gateway methods, CLI commands, services, providers, model catalogs, embeddings, media providers, context engines, compaction providers, agent harnesses, event subscriptions, session extensions/actions, and lifecycle cleanup.

[`src/plugins/registry.ts`](https://github.com/openclaw/openclaw/blob/main/src/plugins/registry.ts) composes registry state, validation registrars, runtime resolution, and the API factory. Registration records are snapshotted; a failed plugin registration can roll back contributions, Gateway handlers, runtime artifacts, and scheduled jobs. Exclusive slots such as a context engine or memory capability differ from additive contributions such as tools or prompt supplements.

The public SDK is exported through narrow subpaths under [`src/plugin-sdk/`](https://github.com/openclaw/openclaw/tree/main/src/plugin-sdk), with `core`, channel, provider, runtime, and capability-specific modules. This avoids a monolithic import graph, makes dependency direction visible, and gives core a place to enforce stable contracts. Plugin manifests declare ownership contracts; registrars reject undeclared or duplicate capabilities. The Gateway merges plugin RPC descriptors and tool catalogs with core surfaces rather than letting extensions patch random internals.

This seam is load-bearing. The enormous number of registration methods is not. A smaller harness needs four: tools, lifecycle hooks, provider/harness adapters, and optional RPC/HTTP routes. OpenClaw's long tail exists because it is an assistant platform with many channels and media/provider capabilities.

---

## 4. OpenHarness: a compact streaming tool loop

### 4.1 Turn cycle and parallel calls

[`src/openharness/engine/query_engine.py`](https://github.com/HKUDS/OpenHarness/blob/main/src/openharness/engine/query_engine.py) owns conversation history and constructs a `QueryContext`. [`src/openharness/engine/query.py`](https://github.com/HKUDS/OpenHarness/blob/main/src/openharness/engine/query.py) implements the actual cycle:

1. compact if necessary;
2. call `api_client.stream_message` with messages, system prompt, tools, and token settings;
3. yield text deltas immediately;
4. retain the completed structured assistant message;
5. if it has no tool uses, stop;
6. otherwise validate and execute tools;
7. append all tool results as the next user-role message;
8. repeat until a final answer or `max_turns`.

A single tool call executes directly so start/completion events arrive immediately. Multiple calls first emit all start events, then run with `asyncio.gather(..., return_exceptions=True)`. Results are restored in original call order. Exceptions become error `ToolResultBlock`s instead of cancelling siblings. This preserves the provider invariant that every `tool_use` must have a matching `tool_result`; otherwise the next Anthropic-style request is invalid.

Before execution, `_execute_tool_call` runs pre-tool hooks, looks up the registry entry, validates input with Pydantic, normalizes path/command inputs, asks the permission checker, optionally waits for a user confirmation callback, executes the tool, offloads oversized output to an artifact file, records carry-over metadata, and runs post-tool hooks. This is an excellent minimal execution seam.

### 4.2 Multi-day context compression

The long-session path spans [`src/openharness/engine/query.py`](https://github.com/HKUDS/OpenHarness/blob/main/src/openharness/engine/query.py) and [`src/openharness/services/compact/__init__.py`](https://github.com/HKUDS/OpenHarness/blob/main/src/openharness/services/compact/__init__.py).

At the start of every model turn, the engine estimates context and runs a funnel:

1. **ingestion guard:** large tool output is stored under a tool-artifact directory and history retains size, path, and preview;
2. **microcompact:** old results from file/shell/search/web tools, MCP tools, or dynamically oversized results are replaced with a marker, preserving tool-call structure and the most recent results;
3. **deterministic context collapse:** oversized text and tool-result blocks in older messages retain bounded head/tail excerpts;
4. **session-memory condensation:** older message rounds may become a compact session-memory message while a larger recent window stays verbatim;
5. **full LLM compact:** older history is summarized with a no-tools prompt, recent messages remain verbatim, and a boundary marker plus typed attachments preserve working state.

Typed attachments are the strongest part of the design. Carry-over metadata records current goal, active artifacts, verified work, recently read files, plan mode, invoked skills, asynchronous agents, work log, attachment paths, and hook notes. This keeps important state from depending entirely on a lossy free-form summary. Splits move backward when necessary to avoid cutting an assistant tool-use from its following user tool-result message, then sanitize orphaned blocks.

Compaction includes provider-error recovery: prompt-too-long detection can force a reactive compact; the compaction request itself can drop old prompt rounds and retry; repeated auto-compact failures trip a circuit breaker. Images are estimated separately and replaced with path placeholders only in the summarizer request. These mechanics are why the loop can survive multi-day tool-heavy use. The phrase “multi-day” is an outcome of persistent sessions plus repeated bounded compaction, not a special temporal algorithm.

### 4.3 Permission dialogs

[`src/openharness/permissions/checker.py`](https://github.com/HKUDS/OpenHarness/blob/main/src/openharness/permissions/checker.py) returns a structured `PermissionDecision(allowed, requires_confirmation, reason)`. Policy checks built-in sensitive credential paths, explicit denied tools, configured paths and commands, explicit allow lists, mode, and read-only status. `PLAN` blocks mutations; `FULL_AUTO` allows them after hard denials; default mode marks mutations as requiring confirmation.

The query loop does not render UI. It invokes the injected `permission_prompt(tool_name, reason)` coroutine, so React TUI, Textual, CLI, or another host can display the dialog. Denial becomes an ordinary tool error and the agent can continue. This separation—pure decision engine plus UI callback—is the reusable part.

One caution from current code: the explicit `allowed_tools` short-circuit appears before configured path-deny and command-deny loops, so allow-listing a broad mutating tool can bypass those user rules, though built-in sensitive paths and `denied_tools` still win. Deny precedence should be fixed before treating this as a high-assurance sandbox. The permission layer is policy gating, not OS isolation.

---

## 5. What is load-bearing across all three, and what is cruft

### Load-bearing internals

| Internal | Why it matters | Best reference |
|---|---|---|
| Stable run/session/agent identity | Prevents misrouting, stale terminal events, and cross-session corruption | OpenClaw `infra/agent-events.ts` and Gateway session routing |
| Provider-neutral stream contract | Lets UIs, channels, persistence, and audits consume one event vocabulary | OpenClaw agent-event bus; OpenHarness `stream_events.py` |
| One tool execution choke point | Validation, permissions, hooks, output bounds, and observability must be impossible to bypass | OpenHarness `_execute_tool_call` |
| Tool-use/result pairing | Required for provider validity and recoverable history | OpenHarness gather/error conversion and compaction pair-preserving split |
| Deny-before-side-effect permission decision | Model intent is untrusted until policy allows it | OpenHarness checker/query callback; OpenClaw approval/control scopes |
| Durable raw transcript | Learning claims need inspectable evidence; summaries cannot be the source of truth | Hermes SQLite messages/FTS5 |
| Bounded always-on context | Prevents “memory” from consuming the prompt and forces curation | Hermes `MEMORY.md` / `USER.md` caps and progressive skill disclosure |
| Layered context reduction | Cheap deterministic cleanup should precede lossy LLM summarization | OpenHarness compact funnel |
| Structured carry-over state | Goals, files, verified work, permissions, and async work should survive compression explicitly | OpenHarness compact attachments |
| Isolated asynchronous reviewer | Maintenance must not delay or contaminate the user's next turn | Hermes background review fork |
| Provenance, ownership, and read-before-write | Stops autonomous “learning” from silently corrupting operator-owned knowledge | Hermes skill provenance/read marks |
| Candidate isolation + frozen holdout | Required before calling an offline mutation an improvement | Hermes self-evolution dataset/constraint scaffold |
| Typed plugin boundary | Prevents core/extensions from depending on private implementation layout | OpenClaw `OpenClawPluginApi` and registries |

### Replaceable or product-specific cruft

“Cruft” here means nonessential for a minimal harness, not necessarily bad code.

- **Hermes:** dozens of skill categories, curator consolidation heuristics, external memory providers, Skills Hub federation, multiple review-model routing modes, notification summaries, and numerous platform integrations. Keep only the file format, index/load path, scoped writer, and reviewer trigger initially.
- **Hermes self-evolution:** synthetic dataset convenience, rich CLI presentation, Darwinian-evolver roadmap, broad multi-phase promises, and automatic fallback to a different optimizer. The current word-overlap metric is worse than cruft because it creates false confidence.
- **OpenClaw:** the giant RPC catalog, every channel/media/provider capability, Bonjour/Tailscale helpers, node fleet, voice/canvas, and most plugin registration families. A small harness does not need an always-on Gateway unless it has multiple clients/channels or remote nodes.
- **OpenHarness:** personalization, auto-dream/durable-memory extras, coordinator metadata, image-to-text preprocessing, detailed carry-over categories, and duplicated model/provider heuristics. The five-stage compactor can begin as two stages: artifact offload/microcompact, then summary.
- **Across all:** marketing labels such as “self-evolving” are not internals. Without an objective metric, held-out evidence, regression gate, and reversible promotion, a mutation loop is only automated editing.

---

## 6. Minimal viable Hermes learning loop for another harness

Build this before GEPA, vector memory, a Gateway, or a skill marketplace.

### Data and tools

1. **Persist every completed turn** in SQLite with `session_id`, ordered message IDs, roles, tool calls/results, timestamps, and status. Add FTS5 over user/assistant text.
2. **Maintain two bounded Markdown files**, `MEMORY.md` and `USER.md`, injected as a frozen session-start snapshot. Expose atomic `add`, `replace`, `remove`, and batch operations. Scan on write and load.
3. **Adopt the Agent Skills directory shape**: YAML-frontmatter `SKILL.md`, plus optional `references/`, `templates/`, and `scripts/`. Put only name/description in the prompt; load bodies on demand.
4. **Expose a scoped skill writer** with create and targeted patch. Require a fresh read token/hash before patching. Track `owner = user | bundled | reviewer`; the background reviewer may write only reviewer-owned skills.

### Trigger and reviewer

5. After a successful user turn, update two cheap counters: user turns since memory review and tool calls since skill review. Also trigger immediately on explicit corrections such as “remember this” or when a loaded skill produced a verified failure.
6. When a threshold fires, enqueue a background review job. Snapshot the just-finished transcript; do not append maintenance instructions to the next user message.
7. Give the reviewer only `memory_write`, `skill_read`, and `skill_write`. Ask it to return one of: no-op, memory patch, user-profile patch, existing-skill patch, or new-skill proposal. Prefer patching an existing broad skill.
8. Validate mechanically: size/frontmatter, ownership, fresh-read hash, threat scan, and atomic write. For new skills or substantive patches, default to a proposal awaiting user approval until the harness has evaluation coverage.

### Feedback and promotion

9. Record which skill version was loaded for each turn and whether the turn succeeded, required correction, or was abandoned. This is the seed evaluation dataset.
10. Periodically evaluate changed skills on a small frozen set of real tasks. Use task-specific deterministic checks where possible; otherwise use a judge that returns both scalar dimensions and textual failure feedback. Promote only when constraints pass and a meaningful held-out improvement exists; retain rollback history.

Pseudocode:

```python
async def finish_turn(turn):
    transcript.append_atomic(turn)
    counters.observe(turn)

    if counters.memory_due() or counters.skill_due() or turn.has_durable_correction:
        review_queue.put(ReviewJob(snapshot=transcript.snapshot(),
                                   loaded_skills=turn.loaded_skill_versions,
                                   verified_outcome=turn.outcome))

async def review(job):
    proposal = await reviewer.run(job, tools=SCOPED_LEARNING_TOOLS)
    validated = validate(proposal, ownership=True, fresh_read=True,
                         size=True, structure=True, threats=True)
    if validated.is_small_reviewer_owned_patch:
        knowledge_store.apply_atomic(validated)
    else:
        approval_queue.put(validated)
```

Only after this loop produces a clean archive of tasks, traces, outcomes, and reviewed skill versions should GEPA be added. At that point the optimizer must receive the real trace and actionable feedback, run candidate skills in isolation, score correctness rather than lexical imitation, and compare against an untouched holdout. That is the minimum line between a harness that edits its notes and one that can credibly claim to improve.
