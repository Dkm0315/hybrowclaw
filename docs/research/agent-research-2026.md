# The Agent Harness After Prompts: 2025–2026 Research and Production Engineering Survey

**Research cutoff:** 28 August 2026  
**Scope:** Agentic context engineering, multi-agent pipelines, durable memory, trace-based self-improvement, and the production harness practices disclosed by Anthropic, OpenAI, and Google DeepMind.  
**Audience:** Builders of terminal coding agents and autonomous software-engineering harnesses.

## Executive synthesis

The center of gravity in agent engineering has moved away from finding one perfect system prompt. The strongest 2025–2026 systems expose an agent to a **versioned, inspectable environment that can learn without changing model weights**: repository maps, plans, runbooks, test results, traces, memories, tools, and executable constraints. Four conclusions recur across independent research and production reports:

1. **Context is becoming the learned artifact.** Dynamic Cheatsheet showed that a black-box model can accumulate validated strategies at test time; ACE made the artifact an itemized playbook updated by generation, reflection, and curation; Meta Context Engineering (MCE) now proposes evolving both the context and the *skill that constructs and retrieves it*. This is a progression from hand-written prompt to learned playbook to learned context compiler.
2. **Multiple agents are a conditional systems optimization, not a general intelligence multiplier.** They win when work is parallel, breadth-first, independently verifiable, or exceeds one context window. They lose on sequential, tightly coupled work after token budgets are normalized. Central orchestration, explicit contracts, and verification contain error better than free-form swarms.
3. **Useful memory is typed and temporal.** Retrieval alone is insufficient. Recent systems separately represent facts, experiences, summaries, beliefs, workflows, current state, and superseded state. The best reported gains are large, but newer benchmarks also reveal that recalling an old fact can be worse than forgetting it when the world has changed.
4. **Traces are training data for the harness.** GEPA turns execution trajectories and evaluator feedback into prompt changes with far fewer rollouts than policy-gradient RL. AlphaEvolve applies the same broad principle to code populations under objective evaluators. Production teams likewise convert recurring failures into tool descriptions, repository guidance, linters, tests, and review loops.

For a terminal coding harness, the emerging architecture is therefore: **one capable default agent; selectively spawned workers at clean parallel or permission boundaries; an append-only event log; typed and versioned memory; executable verification; and an offline promotion loop that turns repeated, evaluator-confirmed lessons into repository-local skills and constraints.**

## Method and evidence caveats

This report prioritizes conference proceedings, author project pages, papers, and official engineering posts. Results labeled “preprint” have not necessarily passed peer review. Vendor internal evaluations are useful production evidence but are not directly comparable with public benchmarks. Percentage improvements preserve the source’s own convention—absolute points or relative gain—and are identified where the source makes that clear.

The field is moving unusually quickly. Several August 2026 results are recent preprints; they are included because they directly test failure modes that earlier memory benchmarks missed, but they should be treated as promising rather than settled.

---

## 1. Agentic context engineering: evolve playbooks and context builders, not weights

### Finding 1.1 — Test-time strategy memory can produce large gains without labels or weight updates

**Finding.** Dynamic Cheatsheet (DC) stores reusable strategies, code snippets, and lessons from prior attempts in a self-curated inference-time memory. The key shift is from replaying entire trajectories to preserving compact, transferable procedures.

**Evidence.** The 2025 paper reports that Claude 3.5 Sonnet more than doubled accuracy on AIME after retaining algebraic insights; GPT-4o rose from 10% to 99% on Game of 24 after discovering and reusing a Python method; it also reports gains of 9% on GPQA-Diamond and 8% on MMLU-Pro. See [Dynamic Cheatsheet: Test-Time Learning with Adaptive Memory](https://arxiv.org/abs/2504.07952) and its [official implementation](https://github.com/suzgunmirac/dynamic-cheatsheet).

**Implication for a terminal coding harness.** Maintain a repository-local “validated techniques” store populated only from executions with evidence. Entries should be operational: command, applicability predicate, expected output, failure signatures, and provenance. A lesson such as “use the project’s `./scripts/test-unit` wrapper because direct pytest misses generated fixtures” is more valuable than a generic summary of the session.

### Finding 1.2 — ACE prevents iterative context from collapsing into vague summaries

**Finding.** ACE treats context as a structured, evolving playbook. A Generator executes with the current playbook, a Reflector extracts lessons from the trajectory and feedback, and a Curator applies localized additions, updates, merges, and removals. Itemized incremental updates counter two observed defects in repeated prompt rewriting: **brevity bias**, which drops useful detail, and **context collapse**, which erodes information over successive rewrites.

**Evidence.** ACE reports an average **+10.6% on agent tasks** and **+8.6% on finance**, lower adaptation cost and latency, and AppWorld results competitive with a top production agent despite using a smaller open model. It can learn from natural execution feedback without labeled supervision. See the [ICLR 2026 paper](https://openreview.net/pdf?id=eC4ygDs02R), [paper page](https://ace-agent.github.io/), and [official code](https://github.com/ace-agent/ace).

**Implication for a terminal coding harness.** Do not periodically rewrite one monolithic `AGENTS.md`. Store playbook entries as addressable records with stable IDs, scopes, confidence, source traces, validation status, and timestamps. Apply deltas; retain history; retrieve only task-relevant entries. Require a successful replay or deterministic check before promoting a reflected lesson into default context.

### Finding 1.3 — The successor direction is to evolve the context-engineering skill itself

**Finding.** MCE argues that ACE still hard-codes a particular representation and update loop. It co-evolves (a) the context artifacts and (b) executable “skills” that decide how context is represented, learned, filtered, and assembled. Context can be files, code, templates, retrieval functions, or validation scripts rather than a fixed bullet list.

**Evidence.** The January 2026 preprint reports **5.6–53.8% relative improvement over prior agentic context-engineering methods (16.9% mean)** across five domains, **13.6× faster training**, and **4.8× fewer rollouts than ACE** to reach higher training accuracy. Its own limitations are material: benefits are strongest for domain knowledge and pattern matching, and long complex traces still make credit assignment difficult. See [Meta Context Engineering via Agentic Skill Evolution](https://arxiv.org/abs/2601.21557).

**Implication for a terminal coding harness.** Make context assembly programmable and testable. A harness should be able to evolve a skill directory containing retrieval code, schemas, lint rules, and instructions, then evaluate the candidate in a sandbox against held-out tasks. The “learning unit” becomes a versioned skill package rather than text pasted into a global prompt.

### Finding 1.4 — Context should be progressively disclosed and mechanically kept fresh

**Finding.** Production experience agrees with the research: small maps plus navigable, authoritative artifacts work better than giant manuals. Anthropic frames context engineering as choosing the highest-utility tokens on every inference; OpenAI reports that a large `AGENTS.md` crowded out task context, became stale, and was hard to verify.

**Evidence.** Anthropic recommends just-in-time retrieval, compaction, structured note-taking, and subagents with isolated contexts in [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents). OpenAI’s million-line internal project uses a roughly 100-line `AGENTS.md` as a table of contents, structured in-repo documentation, versioned execution plans, documentation linters, and a recurring doc-gardening agent in [Harness engineering](https://openai.com/index/harness-engineering/).

**Implication for a terminal coding harness.** Inject only a stable map by default. Let the agent discover deeper architecture, product, security, and operational context through explicit links and search. Track ownership, freshness, dependency hashes, and verification status for every context artifact; mark or retract entries when source code changes invalidate them.

---

## 2. Multi-agent pipelines: planner, executor, verifier—and the coordination tax

### Finding 2.1 — Multi-agent wins are strongest on parallel breadth, not sequential depth

**Finding.** The clearest production win is breadth-first research: independent workers search separate regions of a large information space and compress findings into a lead agent’s context. This adds context capacity and tool throughput.

**Evidence.** Anthropic reports that an Opus 4 lead with Sonnet 4 subagents outperformed single-agent Opus 4 by **90.2%** on an internal research evaluation. It also reports that token usage alone explained 80% of BrowseComp performance variance, multi-agent research consumed roughly 15× chat tokens, and tasks with shared context or many dependencies were poor fits. See [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system).

**Implication for a terminal coding harness.** Spawn workers for repository-wide search, independent test-shard diagnosis, alternative patch exploration, migration inventories, or security review. Keep the primary implementation path with one agent when edits are tightly coupled. Decide delegation from a dependency graph, expected parallel speedup, context isolation benefit, and verification boundary—not from human job titles.

### Finding 2.2 — Controlled studies find a sharp coordination regime change

**Finding.** Multi-agent performance depends on task structure, tool intensity, base-agent strength, and topology. Under standardized tools and token budgets, central coordination helps decomposable work, while every tested multi-agent topology damages sequential reasoning.

**Evidence.** The December 2025 preprint [Towards a Science of Scaling Agent Systems](https://arxiv.org/abs/2512.08296) evaluates 180 configurations across four benchmarks and three model families. It reports **+80.9%** for centralized coordination on parallelizable financial reasoning, but **39–70% degradation** for multi-agent variants on sequential tasks. Gains diminish or reverse after the single-agent baseline exceeds roughly 45%. Independent topology amplified errors 17.2×; centralized coordination contained amplification to 4.4×. A separate 2026 study finds that a single agent consistently matches or beats multi-agent variants on multi-hop reasoning when thinking-token budgets are equalized: [Single-Agent LLMs Outperform Multi-Agent Systems Under Equal Thinking Token Budgets](https://arxiv.org/abs/2604.02460).

**Implication for a terminal coding harness.** Always benchmark against a compute-matched single-agent, two-pass baseline. Use a centralized task ledger and artifact store rather than peer-to-peer conversational swarms. Add agents only if they introduce real parallelism, heterogeneous tools/models, permission isolation, retry isolation, or an independent verifier.

### Finding 2.3 — Planner/executor splits help only when the plan is a checkable contract

**Finding.** A planner can reduce premature coding and expose dependencies, but an over-detailed speculative plan can propagate incorrect assumptions. Verification-aware planning improves the split by attaching explicit passing criteria to every subtask.

**Evidence.** Anthropic’s 2026 long-running application harness uses planner, generator, and evaluator roles, but deliberately keeps the planner at product and high-level design because incorrect granular implementation details cascade downstream. The full harness produced far better output than a solo run, but cost about **$200 over six hours versus $9 over 20 minutes**, illustrating the verifier and autonomy tax; see [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps). The VeriMAP preprint generates planner-defined verification functions in Python and natural language and reports gains over single- and multi-agent baselines; see [Verification-Aware Planning for Multi-Agent Systems](https://arxiv.org/abs/2510.17109).

**Implication for a terminal coding harness.** Plans should specify observable deliverables, dependencies, permitted files/tools, and acceptance commands. Avoid prescribing low-level implementation before repository inspection. Every task node should end in a machine-readable outcome—pass, fail with evidence, blocked, or inconclusive—and the orchestrator should advance only on evidence.

### Finding 2.4 — Documented multi-agent failures cluster at contracts, handoffs, and termination

**Finding.** Failures are rarely fixed by adding another role. Common defects include vague or inconsistent specifications, duplicate work, missing work, agents ignoring one another, carrying forward false assumptions, poor task allocation, unverified outputs, and incorrect early termination.

**Evidence.** The NeurIPS 2025 MAST dataset contains **1,600+ annotated traces across seven frameworks** and organizes 14 failure modes into specification/system-design failures, inter-agent misalignment, and task-verification/termination failures. See [Why Do Multi-Agent LLM Systems Fail?](https://openreview.net/pdf?id=fAjbYBmonr) and the [MAST dataset/project](https://multi-agent-systems-failure-taxonomy.github.io/MAST/). Anthropic independently reports early production failures including 50 subagents for simple queries, endless searches for nonexistent sources, duplicate searches, and gaps caused by vague delegation briefs.

**Implication for a terminal coding harness.** Treat delegation as a typed API. A work order needs objective, inputs and immutable evidence references, owned files, exclusions, output schema, budget, and acceptance checks. Detect overlapping file ownership and duplicate search scopes before launch. Do not accept a worker’s prose claim of completion; consume its diff, commands, exit codes, logs, and test artifacts.

### Finding 2.5 — Parallel coding can scale far beyond one session, but only around a powerful verifier surface

**Finding.** Shared-codebase teams can make enormous progress when tasks can be partitioned by failing tests or files. Yet passing visible tests does not establish production quality, security, or maintainability.

**Evidence.** Anthropic’s 16-agent experiment produced a roughly **100,000-line Rust C compiler**, capable of building Linux 6.9 for x86, ARM, and RISC-V, over nearly 2,000 sessions and about $20,000. The harness assigned agents around test failures and used differential compilation, but the author explicitly warns against deploying software never personally verified. See [Building a C compiler with a team of parallel Claudes](https://www.anthropic.com/engineering/building-c-compiler).

**Implication for a terminal coding harness.** Parallelize on test ownership and isolated worktrees, not simultaneous edits to shared files. Use merge queues, deterministic reproduction, differential testing, fuzzing, static analysis, and adversarial held-out checks. Reserve human review for high-impact semantic and security boundaries rather than routine syntax or style.

---

## 3. Agent memory that measurably improves long-horizon recall

### Finding 3.1 — Workflow memory transfers reusable procedures, not just facts

**Finding.** Agent Workflow Memory induces reusable workflows from successful trajectories and retrieves them for new long-horizon tasks. Procedural memory can shorten paths as well as improve success.

**Evidence.** At ICML 2025, AWM reports **24.6% and 51.1% relative success-rate improvements** on Mind2Web and WebArena, fewer steps on successful WebArena tasks, and 8.9–14.0 absolute-point gains over baselines as cross-task/domain distribution gaps widen. See [Agent Workflow Memory](https://proceedings.mlr.press/v267/wang25bx.html).

**Implication for a terminal coding harness.** Store proven workflows separately from factual repository memory. Retrieve “how to perform this repo’s database migration safely” as an executable sequence with preconditions and checks, rather than retrieving semantically similar chat fragments.

### Finding 3.2 — Hierarchical working memory preserves task structure across long trajectories

**Finding.** HiAgent chunks working memory by subgoal and keeps hierarchical summaries aligned with the plan. This reduces the damage of flat rolling summaries, which often erase why a step exists.

**Evidence.** The ACL 2025 paper evaluates hierarchical subgoal memory on long-horizon agent tasks and reports improvements over full-history and summarization baselines. See [HiAgent: Hierarchical Working Memory Management](https://aclanthology.org/2025.acl-long.1575/).

**Implication for a terminal coding harness.** Persist a task tree with each node’s goal, evidence, decisions, changed files, tests, unresolved risks, and parent dependency. On context reset, load the active path and its boundary conditions, not a lossy summary of the entire transcript.

### Finding 3.3 — Separating evidence, experience, summaries, and beliefs yields a step-change in recall

**Finding.** Hindsight treats memory as a reasoning substrate with four logical networks: world facts, agent experiences, synthesized entity summaries, and evolving beliefs. Its retain/recall/reflect operations preserve provenance and distinguish observation from inference.

**Evidence.** Hindsight reports that the same open 20B backbone rises from **39.0% full-context accuracy to 83.6%** on long-horizon conversational memory; a larger backbone reaches **91.4% on LongMemEval** and up to **89.61% on LoCoMo**, versus 75.78% for the strongest prior open system. See [Hindsight is 20/20](https://arxiv.org/abs/2512.12818) and the [ACL 2026 system demonstration](https://aclanthology.org/2026.acl-demo.27/).

**Implication for a terminal coding harness.** Use typed stores: immutable observations (command outputs, source snapshots), episodic attempts, derived repository facts, current beliefs/hypotheses, decisions, and reusable procedures. Every derived item should link to evidence and expose uncertainty. This prevents an agent’s earlier guess from silently becoming “repository truth.”

### Finding 3.4 — Coding-agent memory should act like an experienced colleague’s runbook

**Finding.** LongMemEval-V2 moves evaluation from conversational trivia to environment experience: static state, changing state, workflows, gotchas, and premise awareness. Its best method lets a coding agent inspect stored trajectory files directly rather than relying only on vector retrieval.

**Evidence.** The May 2026 preprint contains 451 manually curated questions. AgentRunbook-C reaches **72.5% average accuracy**, compared with **48.5% for the strongest RAG baseline** and **69.3% for an off-the-shelf coding-agent baseline**. See [LongMemEval-V2](https://arxiv.org/abs/2605.12493).

**Implication for a terminal coding harness.** Keep raw traces as files in an evidence sandbox and let the agent query them with code, `rg`, joins, and timeline scripts. Maintain smaller curated indexes for routing, but do not force all experience through embedding similarity or pre-compressed summaries.

### Finding 3.5 — Current truth and supersession are the missing production primitive

**Finding.** A memory system may retrieve perfectly and still act on a superseded constraint. StateMem explicitly models supersession and relational dependencies, separating “what was once true” from “what is current.”

**Evidence.** The August 2026 preprint reports **1.8× current-state accuracy** over the strongest same-backbone baseline on DeepSeek-V4-Flash and **1.6× over the strongest memory system** on Qwen-3.5-9B. A lightweight wrapper improved six existing memory/retrieval backends by **32–67 points**, with cost-matched controls attributing 15–32 points to state structure. See [Can Agent Memory Systems Track Evolving State?](https://arxiv.org/abs/2608.19652). This is very recent and awaits broader replication.

**Implication for a terminal coding harness.** Every mutable memory needs `valid_from`, `supersedes`, source commit/hash, scope, and invalidation conditions. At retrieval time, filter on the current branch, commit, environment, and task. Show historical entries only as provenance. A changed config file or failed revalidation should automatically mark dependent memory stale.

---

## 4. Trace-based self-improvement: GEPA-class optimization and beyond

### Finding 4.1 — Natural-language diagnosis extracts more learning per rollout than scalar reward alone

**Finding.** GEPA samples full trajectories—reasoning, tool calls, outputs, and evaluator feedback—then reflects on failures, proposes prompt changes, tests candidates, and recombines complementary lessons from a Pareto frontier. It optimizes compound systems while model weights remain frozen.

**Evidence.** The ICLR 2026 paper reports **+6 percentage points on average over GRPO**, up to **+19 points**, with up to **35× fewer rollouts**. It beats MIPROv2 by more than 10 points, including +12 on AIME-2025, and shows inference-time code-optimization results. See [GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning](https://proceedings.iclr.cc/paper_files/paper/2026/hash/0e9e708b6f48e14fd0ac29e167413f76-Abstract-Conference.html) and the [official repository](https://github.com/gepa-ai/gepa).

**Implication for a terminal coding harness.** Log normalized traces with task, context version, tool inputs/outputs, environment hash, diff, verifier results, cost, and latency. Periodically cluster failures and let an optimizer propose changes to prompts, tool descriptions, skills, or orchestration policy. Promote only candidates that beat the incumbent on held-out repositories and retain rollback data.

### Finding 4.2 — Optimizing the graph and configuration can outperform prompt-only evolution

**Finding.** Maestro extends reflective textual feedback from prompts to agent graph and configuration changes. This matters because a bad topology, retry rule, or context routing policy cannot always be repaired with better wording.

**Evidence.** The 2025 preprint reports average gains of **4.9% over GEPA** and 4.86% over GEPA+Merge on IFBench and HotpotQA, while its prompt-only restriction still leads those baselines. See [Maestro: Joint Graph & Config Optimization for Reliable AI Agents](https://arxiv.org/abs/2509.04642).

**Implication for a terminal coding harness.** Make the orchestration graph declarative: spawn policy, model choice, budget, tool exposure, compaction threshold, verifier set, and retry/termination rules. These become candidate parameters in trace-based optimization, subject to safety invariants that the optimizer cannot edit.

### Finding 4.3 — Objective evaluators turn code evolution into a production-capable loop

**Finding.** AlphaEvolve combines a population of generated programs with automated evaluation and evolutionary selection. Fast models broaden the search; stronger models deepen promising candidates. The approach works when quality can be objectively and repeatedly scored.

**Evidence.** Google DeepMind reports deployed discoveries in data-center scheduling, chip design, and AI training; one scheduling heuristic has recovered an average **0.7% of Google’s worldwide compute resources**. See [AlphaEvolve](https://deepmind.google/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/).

**Implication for a terminal coding harness.** For optimizable code—query plans, parsers, kernels, build logic, migration strategies—maintain a diverse candidate pool instead of iterating one patch in place. Score candidates in isolated sandboxes on correctness first, then performance, simplicity, security, and robustness. Preserve diversity to avoid converging on reward-hacked shortcuts.

### Finding 4.4 — Reflection itself needs interpretability and held-out validation

**Finding.** Newer work identifies a black-box failure mode in reflective prompt optimization: an optimizer can make unlabeled, hard-to-explain changes that overfit or deteriorate from a defective seed. VISTA separates hypothesis generation from rewriting and verifies labeled hypotheses across minibatches.

**Evidence.** The March 2026 preprint reports recovery to **87.57%** from a defective seed on its evaluated setting and improvements over reflective baselines on GSM8K and AIME-2025. See [Reflection in the Dark](https://arxiv.org/abs/2603.18388).

**Implication for a terminal coding harness.** Require each self-improvement patch to declare a falsifiable hypothesis: failure cluster, causal mechanism, proposed change, expected affected tasks, and non-regression set. Evaluate the hypothesis before merging the artifact. Store rejected experiments as negative memory so the system does not repeat them.

---

## 5. What production harness builders disclose

### Anthropic: manage context across sessions; use agents where evaluator feedback is real

**Finding.** For long tasks, compaction alone is insufficient. Anthropic’s 2025 harness uses an initializer to create a comprehensive feature list and environment, then coding sessions make incremental progress and leave explicit handoff artifacts. The 2026 iteration adds planner/generator/evaluator roles, but later removes scaffolding one piece at a time as stronger models make old assumptions obsolete.

**Evidence.** [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) describes initializer and coding-agent shifts, initially failing feature lists, progress files, and clean state handoff. [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps) distinguishes context resets from in-place compaction and argues for systematic harness ablation. [Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents) separates session (append-only log), harness (model/tool loop), and sandbox (execution environment).

**Concrete terminal-harness design.** Externalize run state from the model and sandbox. Checkpoint an append-only session log, working tree snapshot, active task tree, decisions, and verification artifacts. Rehydrate into a fresh sandbox without pretending a prose summary is complete memory. Maintain a model-version-specific harness profile and rerun ablations on every major model upgrade.

### OpenAI: repository legibility and enforceable feedback loops compound

**Finding.** OpenAI’s agent-first project reports that the limiting factor was an underspecified environment, not raw coding ability. It made documentation, plans, UI, logs, metrics, tests, and architecture directly inspectable; converted preferences into custom linters; and used agent-to-agent review loops.

**Evidence.** [Harness engineering](https://openai.com/index/harness-engineering/) reports roughly one million lines, 1,500 PRs, 3.5 PRs per engineer per day, and single runs lasting over six hours. The project uses isolated per-worktree applications and observability, a small context map, versioned plans, structural tests, and remediation-rich linter errors. [The next evolution of the Agents SDK](https://openai.com/index/the-next-evolution-of-the-agents-sdk/) describes controlled workspaces, separated harness and compute, credential isolation, durable externalized state, snapshot/rehydration, and isolated subagent sandboxes.

**Concrete terminal-harness design.** Treat the repository as the durable brain: short entry map, navigable sources of truth, local observability, deterministic boot commands, and error messages that tell an agent how to recover. Give every task its own worktree and sandbox. Keep credentials outside generated-code execution. Turn repeated review comments into checks or scoped skills.

### Google DeepMind: verification breadth is the harness

**Finding.** DeepMind’s disclosed agents lean on powerful, domain-specific evaluator stacks. AlphaEvolve uses objective scoring to drive search; CodeMender validates security patches with program analysis and a critique agent before surfacing them to humans.

**Evidence.** [CodeMender](https://deepmind.google/blog/introducing-codemender-an-ai-agent-for-code-security/) combines static and dynamic analysis, differential testing, fuzzing, SMT solvers, debugging, source browsing, and an LLM critique tool that compares original and modified code for regressions. [AlphaEvolve](https://deepmind.google/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/) stores evaluated programs in an evolutionary database that determines future prompts.

**Concrete terminal-harness design.** Build verification as a portfolio, not a final “review” prompt: unit and integration tests, type and lint checks, differential behavior, fuzzing, property tests, security analyzers, performance budgets, and an adversarial semantic reviewer. The LLM verifier should interpret evidence and find missing checks; it should not replace deterministic evidence.

---

## Recommended reference architecture for a terminal coding harness

| Layer | Concrete mechanism | Research/production rationale |
|---|---|---|
| Session | Append-only event log with tool I/O, context version, cost, and environment hash | Durable replay, GEPA-quality traces, auditability |
| Workspace | Isolated worktree/container per task or worker; snapshot and rehydrate | Fault isolation, safe parallelism, long-running recovery |
| Context router | Small stable repository map plus just-in-time skill/doc retrieval | Avoid context pollution and monolithic instruction rot |
| Task state | Typed dependency graph with acceptance functions | Planner output becomes an executable contract |
| Memory | Evidence, episodes, procedures, beliefs, decisions, and mutable state in separate stores | Hindsight/AWM gains; prevents inference becoming fact |
| Temporal validity | Commit/branch scope, `valid_from`, `supersedes`, dependency hashes | StateMem’s stale-truth failure mode |
| Orchestrator | Single agent by default; central worker allocation at parallel, retry, tool, or permission boundaries | Controlled multi-agent evidence and lower coordination tax |
| Verification | Deterministic checks first; independent semantic/adversarial verifier second | CodeMender, VeriMAP, evaluator-generator systems |
| Learning loop | Trace clustering → explicit hypothesis → candidate skill/context/graph change → held-out eval → staged promotion | GEPA, Maestro, ACE, MCE |
| Governance | Immutable security constraints, budgets, provenance, rollback, and human gates by risk | Optimizers and agents must not rewrite their own safety envelope |

## Three candidate “Eureka” directions

Public shipping harnesses expose pieces of the following ideas, but the reviewed public documentation does not show any shipping terminal coding harness integrating each capability end to end. These are therefore product hypotheses, not claims that no private prototype exists.

### Eureka 1 — A self-evolving, evidence-bound repository skill compiler

**Capability.** After each task, the harness converts traces into candidate repository skills: scoped instructions, retrieval logic, scripts, and checks. It evolves both the learned playbook and the algorithm that constructs context, as MCE proposes. Each candidate carries provenance and a falsifiable hypothesis, is replayed over historical failures, tested on held-out tasks, and canary-deployed. Successful natural-language rules are automatically “hardened” into executable linters or test generators when possible.

**Why it is now buildable.** ACE supplies stable delta-based playbook evolution; GEPA supplies sample-efficient trace reflection and candidate search; MCE expands the artifact to executable skills; OpenAI’s experience shows that repository-local knowledge and mechanically enforced invariants compound in production.

**What would be new.** Current harness memories generally save user/repository facts or hand-authored instruction files. This system would continually compile experience into **validated, versioned capability packages**, with promotion and rollback resembling a software release pipeline.

### Eureka 2 — A temporal “world model debugger” for codebases

**Capability.** Every remembered fact, decision, failed attempt, and runbook step is linked to source commits, files, symbols, tests, and causal evidence. Changes to the repository invalidate dependent memories. The agent can ask: “What do I believe about this subsystem, which observations support it, what has been superseded, and what changed since the last successful workflow?” A debugger view can time-travel through both code state and agent beliefs.

**Why it is now buildable.** Hindsight shows large gains from separating evidence, experience, summaries, and beliefs. StateMem demonstrates that explicit supersession materially improves current-state accuracy. LongMemEval-V2 shows that trajectory files queried by a coding agent can beat conventional RAG. Git already supplies the temporal substrate.

**What would be new.** Shipping harnesses persist chats, summaries, or memory snippets, but do not publicly expose a branch-aware, causal, automatically invalidated belief graph that can explain *why the agent currently thinks a fact is true*.

### Eureka 3 — An empirical orchestration governor that learns when **not** to spawn agents

**Capability.** Before and during a task, a governor estimates dependency density, context pressure, verifier strength, tool contention, permission boundaries, expected parallel speedup, and error-amplification risk. It chooses among single-agent, two-pass self-review, parallel workers, planner/executor/verifier, or evolutionary candidate search. It learns from local traces under matched time/token budgets, prunes workers whose marginal value turns negative, and can collapse a multi-agent run back into one owner when coupling rises.

**Why it is now buildable.** The scaling study provides measurable predictors and topology effects; equal-budget work supplies the required single-agent baseline; MAST provides failure labels; Anthropic supplies production allocation heuristics and cost evidence; declarative graph optimization from Maestro makes the policy tunable.

**What would be new.** Today’s harnesses mostly expose manual subagents or fixed orchestration graphs. A learned governor would treat orchestration as an online systems decision, continuously justified by **marginal verified progress per unit of cost**, rather than equating more agents with more capability.

## Closing judgment

The near-term breakthrough is unlikely to come from a larger permanent prompt or a larger fixed agent team. The buildable opportunity is a terminal harness that behaves more like a disciplined software organization and a continual-learning system: it remembers with provenance, knows when knowledge is stale, exposes work to objective evaluators, and improves its own skills and orchestration from traces while leaving model weights untouched.

The safest implementation sequence is equally clear: first make the environment legible and verification executable; next externalize typed state and temporal memory; then add selective parallel workers; only after reliable traces and held-out evaluations exist should the harness be allowed to evolve its own context, skills, or graph. That order turns self-improvement from prompt drift into an auditable engineering process.
