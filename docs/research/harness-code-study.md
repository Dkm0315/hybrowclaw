# Four Agent Harnesses, Read from the Code

**Research date:** 2026-08-28  
**Primary targets:** `yc-software/qm`, `pingdotgg/t3code`, `BloopAI/vibe-kanban`, and public work by Matt Pocock / AI Hero

## Method and caveats

This report follows implementation paths rather than product copy. Repository documentation is used only to locate code or to identify an author’s stated position; mechanisms are tied to source files. GitHub `main` is a moving target, especially for T3 Code and Vibe Kanban. T3 Code has changed from the early “task board” product people may remember into a thread-oriented control surface. Vibe Kanban’s current model separates issues from execution workspaces. Where the current code does **not** implement a popularly described feature, this report says so instead of backfilling the story from screenshots or third-party writeups.

The closest public repository for Theo Browne’s T3 Code is the official [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) repository. The code and organization identity make this stronger than indirect product evidence.

---

## 1. QM: scopes, durable computers, grants, and backend adapters

QM’s central abstraction is not “one agent per task.” It is **one resolved operating context per social scope**. A direct message, group, Slack channel, team, and organization become stable scope identifiers. The scope determines the writable filesystem, inherited read-only layers, policy, credentials, memory, and which durable computer receives execution.

### 1.1 Scope resolution is deterministic and social

[`src/resolution/resolution-service.ts`](https://github.com/yc-software/qm/blob/main/src/resolution/resolution-service.ts) contains the decisive mapping:

- A DM maps to `personal:<actor id>`.
- A group maps to `group:<conversation ref>`.
- A channel maps to `channel:<conversation ref>`.
- The organization is always available as `org:<org id>`.

Resolution then constructs a `WorkspaceLayer[]`: the organization scope is mounted read-only at `global`, while the conversation scope is mounted read-write at the workspace root. In a DM, each team the actor belongs to is mounted read-only below a `team-<id>` directory. This is a union filesystem at the harness contract level, not a prompt-only convention. The same function composes organization and narrower-scope command policies, resolves security posture and approval-grant modes durably, computes an audience-based egress floor, and asks ACL storage for handles visible to the conversation audience.

The key implication is that **identity, shared context, filesystem visibility, policy, and network reach are resolved together**. A channel is not merely a session label; it is an authorization and persistence boundary.

Scope IDs and the resolved types are defined in [`src/types.ts`](https://github.com/yc-software/qm/blob/main/src/types.ts). Audience entitlement and cross-scope filtering are enforced through [`src/resolution/context-filter.ts`](https://github.com/yc-software/qm/blob/main/src/resolution/context-filter.ts), [`src/resolution/scope-membership.ts`](https://github.com/yc-software/qm/blob/main/src/resolution/scope-membership.ts), and [`src/resolution/scope-reach.ts`](https://github.com/yc-software/qm/blob/main/src/resolution/scope-reach.ts). Egress is narrowed for the whole audience in [`src/resolution/audience-floor.ts`](https://github.com/yc-software/qm/blob/main/src/resolution/audience-floor.ts): a shared room cannot silently inherit the most permissive participant’s reach.

### 1.2 A durable computer is a backend-neutral machine contract

The core port is the `Sandbox` interface in [`src/sandbox/sandbox.ts`](https://github.com/yc-software/qm/blob/main/src/sandbox/sandbox.ts). The name undersells it. The interface covers:

- provisioning a machine from workspace layers;
- running commands and reading/writing files;
- starting, reading, listing, killing, and awaiting long-lived process sessions;
- backup and restore of workspace and home areas;
- status, teardown, and optional backend capabilities;
- a profile that declares persistence mode, process-session support, machine specification, and egress enforcement.

`AgentComputerProfile.writablePersistence` makes the durability model explicit: a backend either snapshots writable state back to the workspace or retains a resident disk. A `SandboxHandle` carries the chosen backend and scope so later calls return to the same substrate. This is why “durable computer” is more than keeping a container warm: the harness can preserve filesystem/home state, recover it, and route subsequent turns consistently even when concrete providers differ.

The local implementation is in [`src/sandbox/local-sandbox.ts`](https://github.com/yc-software/qm/blob/main/src/sandbox/local-sandbox.ts); Docker execution plumbing is in [`src/sandbox/docker-exec.ts`](https://github.com/yc-software/qm/blob/main/src/sandbox/docker-exec.ts); cloud adapters live in [`src/sandbox/aws-sandbox.ts`](https://github.com/yc-software/qm/blob/main/src/sandbox/aws-sandbox.ts), [`src/sandbox/sprites-sandbox.ts`](https://github.com/yc-software/qm/blob/main/src/sandbox/sprites-sandbox.ts), and [`src/sandbox/smolmachines-sandbox.ts`](https://github.com/yc-software/qm/blob/main/src/sandbox/smolmachines-sandbox.ts). AWS guest communication is separated into [`src/sandbox/aws-microvm-api.ts`](https://github.com/yc-software/qm/blob/main/src/sandbox/aws-microvm-api.ts). Process sessions are normalized in [`src/sandbox/exec-process-session.ts`](https://github.com/yc-software/qm/blob/main/src/sandbox/exec-process-session.ts) and [`src/sandbox/process-poll.ts`](https://github.com/yc-software/qm/blob/main/src/sandbox/process-poll.ts).

### 1.3 Backend routing is per scope, durable, cached, and capability-aware

[`src/sandbox/sandbox-routing.ts`](https://github.com/yc-software/qm/blob/main/src/sandbox/sandbox-routing.ts) is the adapter multiplexer. It defines four current backend names (`sprites`, `aws`, `local`, `smolmachines`) and persists a `SandboxRoute` per scope in a `DurableMap`. A route can record migration time/SHA, lost capabilities, pinning, and a reason.

On provisioning, the router extracts the writable scope from the workspace layers (or accepts `routeScopeId`), reads its durable route, chooses the corresponding adapter, provisions it, and stamps the handle with backend and scope. All later file/process calls dispatch through the backend recorded on the handle. Route lookups use a short TTL cache, but the source of truth remains durable. If a routed backend is unavailable, the router reports the error and falls back to the configured default. If an optional operation is absent, `requireCap` throws `CapabilityUnsupportedError` and reports the gap once instead of pretending every backend is equivalent.

Migration is consequently a first-class operation rather than “change an environment variable and hope.” [`src/sandbox/sandbox-migrate.ts`](https://github.com/yc-software/qm/blob/main/src/sandbox/sandbox-migrate.ts) and [`src/sandbox/sandbox-migration-runner.ts`](https://github.com/yc-software/qm/blob/main/src/sandbox/sandbox-migration-runner.ts) coordinate state movement and route changes; [`src/sandbox/ro-layers.ts`](https://github.com/yc-software/qm/blob/main/src/sandbox/ro-layers.ts) handles inherited read-only content.

This is the strongest adapter design in the set: one behavioral port, declared capabilities, durable routing, and explicit migration metadata.

### 1.4 Grants are resource capabilities, not broad scope membership

The grant record is a tuple of owner scope, resource reference/path, grantee scope, permission, and grantor. [`src/acl/acl-store.ts`](https://github.com/yc-software/qm/blob/main/src/acl/acl-store.ts) supplies the semantic layer: grants are evaluated against audience scope entitlement and converted into handles exposed to the resolved turn. [`src/acl/resource-ref.ts`](https://github.com/yc-software/qm/blob/main/src/acl/resource-ref.ts) normalizes resource references so matching is not left to arbitrary strings at call sites.

The durable implementation, [`src/acl/postgres-grant-store.ts`](https://github.com/yc-software/qm/blob/main/src/acl/postgres-grant-store.ts), creates an `acl_grants` table keyed by `(owner_scope_id, path, grantee_scope_id, permission)`. Writes use PostgreSQL advisory transaction locks scoped to owner and resource, so concurrent replacement/removal cannot interleave. A statement trigger increments a one-row grants version; readers cache the full ordered grant set against that version. `replaceForResourceIfCurrent` provides compare-and-swap behavior for ACL editing.

The important design choice is that a grant lets one scope expose a particular resource to another without merging their workspaces or identities. At resolution time, `handlesForAudience` intersects grants with every participant entitled to the current scope. In a shared room, the agent receives only handles appropriate for that audience.

QM also has short-lived/standing credential grants and approval grants in its credentials and policy layers; their enforcement paths live in [`src/credentials`](https://github.com/yc-software/qm/tree/main/src/credentials), [`src/policy`](https://github.com/yc-software/qm/tree/main/src/policy), and [`src/security`](https://github.com/yc-software/qm/tree/main/src/security). This is distinct from ACL resource grants, though both share the idea that the control plane, not the model or sandbox, decides what materializes.

### 1.5 What QM gets right, and its trade

QM treats a computer as a durable extension of a social/authorization scope. That makes it suitable for “the finance channel’s agent computer” or “my personal operations machine,” with continuity across turns and surfaces. The price is that task isolation is secondary. Concurrent tasks inside the same scope can share mutable state unless a higher layer creates separation. Compared with worktree-first systems, QM solves the harder enterprise identity and capability problem but does not automatically give every ticket a pristine checkout.

---

## 2. T3 Code: thread → environment → provider session, event-sourced board state, and review gates

### 2.1 The public implementation is thread-first, not card-first

The current T3 Code domain object is a **thread** bound to a project, model selection, runtime/interaction mode, branch, and `worktreePath`. Command validation and event creation occur in [`apps/server/src/orchestration/decider.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration/decider.ts). A `thread.create` command checks that the project exists and the thread does not, then emits `thread.created` with branch and worktree binding already resolved.

That event is reduced into the read model by [`apps/server/src/orchestration/projector.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration/projector.ts). The durable command/event pipeline is driven by [`apps/server/src/orchestration/Services/OrchestrationEngine.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration/Services/OrchestrationEngine.ts), while [`apps/server/src/orchestration/Services/ProjectionPipeline.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration/Services/ProjectionPipeline.ts) creates client projections. Provider effects are kept out of the pure decider: [`apps/server/src/orchestration/Services/ProviderCommandReactor.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration/Services/ProviderCommandReactor.ts) reacts to accepted commands/events, and [`apps/server/src/orchestration/Services/ProviderRuntimeIngestion.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration/Services/ProviderRuntimeIngestion.ts) turns provider output back into orchestration activities.

This separation matters operationally: user intent is first validated and recorded; spawning or resuming an unreliable CLI is a reaction. A crash cannot erase the fact that a start was requested.

### 2.2 Task → worktree → agent lifecycle

The lifecycle is:

1. A project supplies a workspace root and defaults. A new thread is assigned either the project checkout or a managed worktree path, plus a branch. Path derivation and filesystem boundaries are implemented in [`apps/server/src/workspace/WorkspacePaths.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/workspace/WorkspacePaths.ts) and [`apps/server/src/environment`](https://github.com/pingdotgg/t3code/tree/main/apps/server/src/environment).
2. Git operations create or attach the checkout. Low-level VCS behavior is behind [`apps/server/src/vcs/GitVcsDriver.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/vcs/GitVcsDriver.ts); higher-level status, branch, commit, push, and PR sequences live in [`apps/server/src/git/GitManager.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/git/GitManager.ts) and [`apps/server/src/git/GitWorkflowService.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/git/GitWorkflowService.ts).
3. The orchestration reactor starts the selected provider in the thread’s bound cwd. Provider adapters live under [`apps/server/src/provider`](https://github.com/pingdotgg/t3code/tree/main/apps/server/src/provider); process supervision is under [`apps/server/src/process`](https://github.com/pingdotgg/t3code/tree/main/apps/server/src/process), with terminal sessions separately managed in [`apps/server/src/terminal`](https://github.com/pingdotgg/t3code/tree/main/apps/server/src/terminal).
4. Runtime messages, tool calls, approvals, user-input requests, and completion receipts become activities in the same thread projection. `ThreadBackgroundLiveness.ts` prevents a provider process that is still alive from being presented as finished merely because foreground activity is quiet ([`apps/server/src/orchestration/ThreadBackgroundLiveness.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration/ThreadBackgroundLiveness.ts)).
5. Deletion is a workflow, not a row delete: [`apps/server/src/orchestration/Services/ThreadDeletionReactor.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration/Services/ThreadDeletionReactor.ts) owns cleanup effects after `thread.deleted` is accepted.

T3 Code’s git status layer is careful about PR identity. [`GitManager.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/git/GitManager.ts) distinguishes a feature branch whose upstream happens to be `origin/main` from a published PR head; otherwise a worktree created from a remote default branch could inherit an unrelated PR. Local status has a short cache, PR lookups a slower cache and per-branch exponential failure backoff, while explicit git actions bump an epoch to force refresh.

### 2.3 The “board” is a projection of work state

Current T3 Code does not store a single mutable kanban enum as the truth. It stores orchestration events and projects thread state. The visible grouping is derived from orthogonal fields:

- session state (`starting`, `running`, error/finished);
- queued turn adoption;
- unresolved approval or user-input activities;
- explicit settled/unsettled override and settlement time;
- snooze time;
- pinned time;
- archived/deleted state;
- PR state and background liveness.

[`apps/server/src/orchestration/decider.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration/decider.ts) shows the invariants. A thread cannot be settled while a session is starting/running, while a recent user message is waiting to be adopted as a turn, or while an approval/user-input request remains unresolved. Settling also emits companion events to clear pin and snooze state. Duplicate settle/unsettle commands re-emit idempotent state without churning timestamps. [`apps/server/src/orchestration/Services/ProjectionPipeline.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration/Services/ProjectionPipeline.ts) performs matching pending-request accounting for the UI.

That model is more truthful than `todo → doing → done`: “blocked on me,” “provider still alive,” “parked until tomorrow,” and “I consider this done” do not overwrite one another.

### 2.4 Diff review and approval are two separate mechanisms

There are two commonly conflated approval flows:

**Provider tool approval.** Provider adapters emit `approval.requested` activities. A response is sent back to the live provider; `approval.resolved` clears it. Failed responses clear only when the detail says the request is stale/unknown. The cross-provider activity contract is enforced in [`apps/server/src/orchestration/Services/ProviderRuntimeIngestion.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration/Services/ProviderRuntimeIngestion.ts) and settlement checks in [`apps/server/src/orchestration/decider.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration/decider.ts).

**Diff review and shipping.** [`apps/server/src/review/ReviewService.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/review/ReviewService.ts) first canonicalizes the requested cwd and refuses review outside the configured workspace/worktree roots. It detects the VCS driver and asks it for a diff preview; Git falls back to `GitVcsDriver.getReviewDiffPreview`. Commit/push/PR is a separate explicit stacked action in [`apps/server/src/git/GitManager.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/git/GitManager.ts): it can generate a commit message from repo conventions, commit, push, and create/open a PR, reporting each phase.

The current public code does **not** show a durable `diff_approved=true` gate that must be set before commit or PR creation. Human review is represented by exposing a bounded diff and requiring an explicit shipping action, while provider-side destructive tool calls have their own live approval protocol. Describing this as a formal “approve diff” state machine would overclaim the source.

### 2.5 What T3 Code gets right, and its trade

T3 Code’s best idea is an event-sourced control plane around fallible local CLIs. It makes “what did the user request?” and “what did the provider process actually do?” separate facts. Its work item is conversational and resumable, with branch/worktree binding as metadata. The trade is conceptual weight: projections, reactors, receipts, adoption windows, and liveness rules are a lot of machinery for a terminal harness. It also provides less authorization isolation than QM; the worktree isolates code, not user credentials or organizational reach.

---

## 3. Vibe Kanban: issue → workspace → session → execution process

### 3.1 The database deliberately separates planning from execution

Vibe Kanban’s current data chain is visible under [`crates/db/src/models`](https://github.com/BloopAI/vibe-kanban/tree/main/crates/db/src/models):

`Task` → `Workspace` → `Session` → `CodingAgentTurn` → `ExecutionProcess`.

The relevant implementations are [`task.rs`](https://github.com/BloopAI/vibe-kanban/blob/main/crates/db/src/models/task.rs), [`workspace.rs`](https://github.com/BloopAI/vibe-kanban/blob/main/crates/db/src/models/workspace.rs), [`workspace_repo.rs`](https://github.com/BloopAI/vibe-kanban/blob/main/crates/db/src/models/workspace_repo.rs), [`session.rs`](https://github.com/BloopAI/vibe-kanban/blob/main/crates/db/src/models/session.rs), [`coding_agent_turn.rs`](https://github.com/BloopAI/vibe-kanban/blob/main/crates/db/src/models/coding_agent_turn.rs), and [`execution_process.rs`](https://github.com/BloopAI/vibe-kanban/blob/main/crates/db/src/models/execution_process.rs).

A task is backlog intent. A workspace is an execution attempt with one or more repository worktrees and branches. A session groups conversation with a chosen executor. A coding-agent turn records the agent-level request/session IDs. An execution process records the actual OS child, status, run reason, and logs. This lets a task have retries or parallel attempts without rewriting its planning identity, and a session can resume without pretending it is the same OS process.

### 3.2 Workspace/worktree creation is serialized and repair-oriented

[`crates/worktree-manager/src/worktree_manager.rs`](https://github.com/BloopAI/vibe-kanban/blob/main/crates/worktree-manager/src/worktree_manager.rs) is unusually defensive. It uses per-path async locks so create and cleanup cannot race. When creating a branch, it resolves the repository’s real common Git directory, creates the branch at the chosen base, and then uses the Git CLI for mutable worktree operations. The comment explains why: CLI worktree creation inherits sparse-checkout behavior more reliably than libgit2.

If `git worktree add` fails, it removes stale `.git/worktrees/<name>` metadata and any partially created directory, then retries once. Success is not trusted until the target path exists. Cleanup removes Git registration, metadata, the physical directory, then prunes. A custom workspace base always gains an app-owned `.vibe-kanban-workspaces` child so orphan cleanup cannot traverse an arbitrary user directory.

Multi-repository binding is modeled explicitly by [`crates/db/src/models/workspace_repo.rs`](https://github.com/BloopAI/vibe-kanban/blob/main/crates/db/src/models/workspace_repo.rs), not hidden in a single `cwd` string.

### 3.3 The container is a logical supervisor, not a Docker container

The central lifecycle service is [`crates/services/src/services/container.rs`](https://github.com/BloopAI/vibe-kanban/blob/main/crates/services/src/services/container.rs). Its “container” is the workspace’s operational unit: worktree paths, sessions, executor actions, dev servers, setup/archive scripts, and supervised processes.

Starting work ensures the workspace/worktrees exist, creates or selects a session, builds an `ExecutorAction`, inserts execution state, and starts it in the workspace. Repository setup scripts can run before the coding agent or in parallel; executor environment includes stable workspace/attempt identifiers. Archiving marks the workspace archived, stops dev-server execution processes, and optionally runs archive actions. It refuses cleanup while non-dev-server processes are still running.

Executor-neutral process state and log persistence live in [`crates/services/src/services/execution_process.rs`](https://github.com/BloopAI/vibe-kanban/blob/main/crates/services/src/services/execution_process.rs). Live messages go through an in-memory `MsgStore`, while raw stdout/stderr are appended to per-execution JSONL files. Special log messages update the durable coding-agent session/message IDs, enabling a later turn to resume the provider rather than starting blind.

### 3.4 Agent adapters expose actions, not one universal prompt protocol

The common executor contract is in [`crates/executors/src/lib.rs`](https://github.com/BloopAI/vibe-kanban/blob/main/crates/executors/src/lib.rs), with command construction in [`crates/executors/src/command.rs`](https://github.com/BloopAI/vibe-kanban/blob/main/crates/executors/src/command.rs), environment composition in [`crates/executors/src/env.rs`](https://github.com/BloopAI/vibe-kanban/blob/main/crates/executors/src/env.rs), and executor discovery in [`crates/executors/src/executor_discovery.rs`](https://github.com/BloopAI/vibe-kanban/blob/main/crates/executors/src/executor_discovery.rs). Concrete adapters are separate: Claude and Codex, for example, live in [`crates/executors/src/executors/claude`](https://github.com/BloopAI/vibe-kanban/tree/main/crates/executors/src/executors/claude) and [`crates/executors/src/executors/codex`](https://github.com/BloopAI/vibe-kanban/tree/main/crates/executors/src/executors/codex).

Adapters translate the same high-level actions—start, follow up/resume, review, setup/dev-server commands—into provider-specific flags and output parsers. Approval normalization is handled in [`crates/executors/src/approvals.rs`](https://github.com/BloopAI/vibe-kanban/blob/main/crates/executors/src/approvals.rs) and the service layer under [`crates/services/src/services/approvals.rs`](https://github.com/BloopAI/vibe-kanban/blob/main/crates/services/src/services/approvals.rs). This mirrors T3 Code’s separation: provider permission prompts are execution control, not code review approval.

### 3.5 Review mechanics: live diff, inline feedback, follow-up, then merge/PR

Diff production is a stream rather than a one-time artifact. [`crates/services/src/services/diff_stream.rs`](https://github.com/BloopAI/vibe-kanban/blob/main/crates/services/src/services/diff_stream.rs) observes workspace repository changes and sends updated diff state to clients. Git operations are centralized under [`crates/git/src`](https://github.com/BloopAI/vibe-kanban/tree/main/crates/git/src), while PR state is durable in [`crates/db/src/models/pull_request.rs`](https://github.com/BloopAI/vibe-kanban/blob/main/crates/db/src/models/pull_request.rs) and merge attempts in [`crates/db/src/models/merge.rs`](https://github.com/BloopAI/vibe-kanban/blob/main/crates/db/src/models/merge.rs).

The review loop is stronger than a simple approve button:

1. The human reads the worktree diff while the workspace remains intact.
2. Inline/file feedback is gathered into a follow-up message.
3. That message starts another `CodingAgentTurn` in the same `Session`; stored provider session IDs let the adapter resume context.
4. The resulting `ExecutionProcess` is independently supervised and logged.
5. Once satisfied, the user invokes PR creation or merge routes; those effects are separate from merely moving an issue card.

Server routes for workspace and PR/merge effects live under [`crates/server/src/routes/workspaces`](https://github.com/BloopAI/vibe-kanban/tree/main/crates/server/src/routes/workspaces). The review UI is under [`packages/local-web`](https://github.com/BloopAI/vibe-kanban/tree/main/packages/local-web). The critical backend mechanism is the feedback-to-resumed-session path through `container.rs`, `session.rs`, and `coding_agent_turn.rs`; comments are not just annotations that die in a review database.

### 3.6 What Vibe Kanban gets right, and its trade

Its most reusable decision is the five-part lifecycle model. “Task,” “attempt workspace,” “conversation session,” “agent turn,” and “OS process” fail and retry at different rates, so they deserve different IDs and state. Its diff feedback loop also closes the human review cycle inside the agent’s resumable context.

The trade is cleanup complexity and local trust. Worktrees and child processes are practical isolation, not security sandboxes. Repair code that force-removes Git metadata is necessary but carries risk around concurrent Git clients. The product’s breadth—board, cloud sync, preview browser, dev servers, many agents—also makes the execution core harder to lift wholesale.

---

## 4. Matt Pocock / AI Hero: the loop is constrained iteration plus engineering feedback

Matt’s public work splits into two layers: **Sandcastle**, which runs AFK coding agents in isolated environments, and **skills/workflow guidance**, which shapes what humans and agents do before and after execution.

### 4.1 Sandcastle’s core loop

[`src/run.ts`](https://github.com/mattpocock/sandcastle/blob/main/src/run.ts) resolves a prompt, branch strategy, logging, environment, timeouts, and provider; [`src/WorktreeManager.ts`](https://github.com/mattpocock/sandcastle/blob/main/src/WorktreeManager.ts) owns host Git worktree/branch setup and merge-back; [`src/SandboxFactory.ts`](https://github.com/mattpocock/sandcastle/blob/main/src/SandboxFactory.ts) creates a provider-neutral sandbox; and [`src/Orchestrator.ts`](https://github.com/mattpocock/sandcastle/blob/main/src/Orchestrator.ts) runs iterations.

An iteration launches an `AgentProvider` in the sandbox, streams text/tool/raw events to logging, watches for a configurable completion signal, enforces an idle timeout, gives a completed-but-hanging process a shorter grace timeout, records the provider session ID, and collects commits. If the completion signal did not fire and `maxIterations` remains, another invocation continues. Recovery messages and session persistence live in [`src/RecoveryMessage.ts`](https://github.com/mattpocock/sandcastle/blob/main/src/RecoveryMessage.ts) and [`src/SessionStore.ts`](https://github.com/mattpocock/sandcastle/blob/main/src/SessionStore.ts).

Branch strategy is explicit. Work may happen on HEAD, a named branch, or an isolated branch that is merged back. Sandboxes are adapters through [`src/SandboxProvider.ts`](https://github.com/mattpocock/sandcastle/blob/main/src/SandboxProvider.ts); Docker/Podman bind mounts and isolated providers share the orchestration contract. [`src/createSandbox.ts`](https://github.com/mattpocock/sandcastle/blob/main/src/createSandbox.ts) supports a warm sandbox in which an implementer, direct test command, and reviewer can run sequentially on the same branch and dependency cache. Cleanup preserves a dirty worktree for recovery and deletes a clean one.

The pattern is deliberately boring: bounded attempts, an observable process, an explicit success signal, commits as the durable output, and tests/review as separate gates.

### 4.2 His workflow loop is plan → small executable slice → feedback → review

The public skills encode a human-controlled chain rather than one enormous autonomous prompt:

- stress-test ambiguous intent with grilling;
- write durable decisions/specification;
- split work into context-sized tickets or phases;
- use tracer bullets to validate architecture with the smallest end-to-end slice;
- implement test-first;
- run mechanical feedback continuously;
- review the diff against both repository standards and the originating spec;
- create a handoff when context must move to a fresh agent.

The source is organized under [`skills/engineering`](https://github.com/mattpocock/skills/tree/main/skills/engineering) and [`skills/productivity`](https://github.com/mattpocock/skills/tree/main/skills/productivity). Particularly relevant mechanisms are [`skills/engineering/implement`](https://github.com/mattpocock/skills/tree/main/skills/engineering/implement), [`skills/engineering/code-review`](https://github.com/mattpocock/skills/tree/main/skills/engineering/code-review), [`skills/engineering/prototype`](https://github.com/mattpocock/skills/tree/main/skills/engineering/prototype), [`skills/productivity/handoff`](https://github.com/mattpocock/skills/tree/main/skills/productivity/handoff), and the agent-writing rules in [`docs/productivity/writing-for-agents.md`](https://github.com/mattpocock/skills/blob/main/docs/productivity/writing-for-agents.md).

His code-review pattern uses two independent axes: one agent checks the diff against codebase standards, another against the issue/spec. That avoids the common failure where “clean code” review misses that the feature is wrong, or spec review accepts a locally destructive implementation.

### 4.3 What he argues the industry gets wrong

Matt’s position is unusually consistent across code and public writing:

1. **Cheap generation does not make bad code cheap.** AI Hero’s public thesis is that fast agents worsen a weak codebase, which then makes subsequent agent output worse—a compounding loop. His [feedback-loop workshop](https://www.aihero.dev/workshops/feedback-loops~htuha) therefore centers tests, formatting, pre-commit checks, and red-green-refactor rather than prompt cleverness.
2. **“Vibe coding” is a review stance, not a synonym for using AI.** His [definition](https://www.aihero.dev/ai-coding-dictionary/vibe-coding) is accepting an opaque diff and judging behavior only. It can be rational for disposable work, but it is reckless for long-lived or sensitive code.
3. **Large process frameworks steal control and hide bugs in the process.** The skills are small, composable, and inspectable. Humans choose the sequence and retain architecture decisions; agents execute well-shaped parts. The public [skills workflow](https://www.aihero.dev/skills-post) is explicitly positioned as engineering without surrendering standards.
4. **More context is not automatically better.** [`writing-for-agents.md`](https://github.com/mattpocock/skills/blob/main/docs/productivity/writing-for-agents.md) distinguishes always-paid context load from human cognitive load, pushes progressive disclosure, and deletes instructions that do not change behavior. Tool descriptions, `AGENTS.md`, and skills all spend a finite attention budget.
5. **Autonomy is downstream of shaping and verification.** His current curriculum puts research, grilling, prototypes, architecture, and kanban decisions in HITL work, then hands narrow issues to AFK Sandcastle runs. The [course outline](https://www.aihero.dev/cohorts/ai-coding-for-real-engineers-m0k0w) names quality, direction, and steering as distinct failure modes with different process fixes.

This is less a novel model loop than a refusal to confuse model inference with software engineering. The model loop can stay simple if the surrounding work definition, environment, feedback, and review are strong.

---

## 5. Cross-system comparison

| System | Durable unit | Isolation boundary | Truth model | Human gate | Adapter seam |
|---|---|---|---|---|---|
| QM | Social scope and its computer | Sandbox/microVM plus scoped layers, credentials, egress | Scope/config/grants/session stores | Tool approvals and control-plane grants | Full `Sandbox` behavioral port plus durable route |
| T3 Code | Thread | Git worktree/cwd and supervised provider session | Event log → thread projection | Provider approvals; explicit review and git shipping actions | Provider registry, VCS registry, orchestration reactors |
| Vibe Kanban | Workspace attempt under a task | Git worktree(s) and OS process group | Relational task/workspace/session/turn/process records | Inline diff feedback → resumed turn; PR/merge action | Executor actions and provider-specific command/parser adapters |
| Sandcastle | One run or reusable sandbox branch | Worktree plus Docker/Podman/microVM provider | Run/iteration/session logs and Git commits | External tests/reviewer/merge policy composed by caller | `AgentProvider` and `SandboxProvider` |

The systems solve different layers. QM is an identity/capability operating system. T3 Code is a resilient interactive control plane. Vibe Kanban is a work-attempt manager with a strong review loop. Sandcastle is a small orchestration library that makes safe AFK composition possible.

---

## The 5 most stealable ideas for a terminal-first agent harness

### 1. Give every run five identities, even if the UI shows one line

Steal Vibe Kanban’s separation: `task_id`, `workspace_attempt_id`, `session_id`, `turn_id`, `process_id`. Put them in SQLite and environment variables. A retry creates a new attempt or process without destroying the ticket or conversation. This one choice makes logs, resume, cancellation, and crash recovery tractable. Source paths: [`task.rs`](https://github.com/BloopAI/vibe-kanban/blob/main/crates/db/src/models/task.rs), [`workspace.rs`](https://github.com/BloopAI/vibe-kanban/blob/main/crates/db/src/models/workspace.rs), [`session.rs`](https://github.com/BloopAI/vibe-kanban/blob/main/crates/db/src/models/session.rs), [`coding_agent_turn.rs`](https://github.com/BloopAI/vibe-kanban/blob/main/crates/db/src/models/coding_agent_turn.rs), [`execution_process.rs`](https://github.com/BloopAI/vibe-kanban/blob/main/crates/db/src/models/execution_process.rs).

### 2. Record intent before side effects, and project status from facts

Steal T3 Code’s command → event → reactor split. Append `run.requested` before spawning; append `process.started`, `approval.requested`, `process.exited`, and `review.accepted` as they happen. Render the TUI from those facts. Never let an idle pane imply completion. Source paths: [`decider.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration/decider.ts), [`OrchestrationEngine.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration/Services/OrchestrationEngine.ts), [`ProviderCommandReactor.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration/Services/ProviderCommandReactor.ts), [`ThreadBackgroundLiveness.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration/ThreadBackgroundLiveness.ts).

### 3. Make execution backends capability-declaring ports with durable routing

Steal QM’s `Sandbox` shape and router, but keep the first version small: `provision`, `exec/start/read/kill`, `backup`, `restore`, `teardown`, plus a profile declaring persistence and process support. Persist which backend owns a workspace. Refuse unsupported features loudly. This lets `local`, `tmux`, `docker`, and remote microVM implementations coexist without scattering conditionals. Source paths: [`sandbox.ts`](https://github.com/yc-software/qm/blob/main/src/sandbox/sandbox.ts), [`sandbox-routing.ts`](https://github.com/yc-software/qm/blob/main/src/sandbox/sandbox-routing.ts).

### 4. Turn review comments into the next agent turn

Steal Vibe Kanban’s closed loop. In a terminal diff viewer, let the user attach comments to file/line selections, batch them, then send them as a follow-up to the same provider session in the same worktree. “Review” becomes corrective execution, not a dead annotation layer. Source paths: [`diff_stream.rs`](https://github.com/BloopAI/vibe-kanban/blob/main/crates/services/src/services/diff_stream.rs), [`container.rs`](https://github.com/BloopAI/vibe-kanban/blob/main/crates/services/src/services/container.rs), [`coding_agent_turn.rs`](https://github.com/BloopAI/vibe-kanban/blob/main/crates/db/src/models/coding_agent_turn.rs).

### 5. Use bounded AFK iterations with external verification gates

Steal Sandcastle’s small loop: worktree, sandbox, provider invocation, observable stream, idle timeout, explicit completion signal, commit collection, bounded retry. Then compose `implement → deterministic checks → independent review` in the same warm sandbox. Do not bury verification inside a heroic prompt. Source paths: [`Orchestrator.ts`](https://github.com/mattpocock/sandcastle/blob/main/src/Orchestrator.ts), [`createSandbox.ts`](https://github.com/mattpocock/sandcastle/blob/main/src/createSandbox.ts), [`WorktreeManager.ts`](https://github.com/mattpocock/sandcastle/blob/main/src/WorktreeManager.ts).

---

## The white space NONE of them cover

None of these systems provides a **terminal-native, cross-task correctness and resource scheduler** that knows what concurrent agents intend to touch, proves whether their results can compose, and preserves that proof as a replayable artifact.

The missing harness would combine:

- a declared task contract: expected files/modules, services, schemas, ports, secrets, and external systems;
- conflict-aware scheduling before execution, not discovery through merge conflicts afterward;
- lease management for non-Git resources such as test databases, ports, cloud sandboxes, devices, rate-limit budgets, and shared caches;
- deterministic acceptance predicates captured with the task, including exact commands and artifact hashes;
- an independent verifier identity whose verdict is stored separately from the worker’s self-report;
- causal replay from task specification through prompts, approvals, environment version, tool calls, diffs, tests, and merge decision;
- recovery after harness restart without trusting an agent transcript or terminal pane;
- a compact terminal UI that shows why a run is blocked, what evidence would unblock it, and which resource or invariant owns the block.

QM can authorize a scope and preserve its computer, but it does not schedule file/module conflicts among tasks. T3 Code records orchestration truth, but its work remains thread-local and review is not a machine-checkable acceptance contract. Vibe Kanban models attempts beautifully, but resource conflicts outside Git are left to setup scripts and convention. Sandcastle makes isolated loops composable in TypeScript, but the caller must invent the global scheduler and evidence model.

That white space is the opportunity: **a local daemon and TUI where agents are replaceable workers, while task contracts, resource leases, verification evidence, and recovery are the durable product.**
