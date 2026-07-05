# Muster — Governed Agent Harness for Production AI Agents

**Muster is an open-source governed agent harness for production AI agents.**

Agents that run for more than a demo need boundaries: they should not leak memory, waste tokens, or learn new behavior without tests.

Muster gives those agents scoped memory, a local token ledger, eval-gated learning, MCP/plugin controls, browser automation surfaces, and Frappe / ERPNext capability packs while keeping provider choice flexible across cloud, open-source, self-hosted, and private routes.

It is also the product surface around that harness: tools, skills, plugins, memory, channels, and an early personal-agent app layer for day-to-day work across terminal, web, and chat surfaces.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node >=24](https://img.shields.io/badge/node-%3E%3D24-5FA04E.svg)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6.svg)](tsconfig.base.json)
[![Package](https://img.shields.io/npm/v/@musterhq/cli?label=%40musterhq%2Fcli)](https://www.npmjs.com/package/@musterhq/cli)

**Quick links:** [Website](https://themuster.dev) · [Docs](https://themuster.dev/docs.html) · [Architecture](docs/ARCHITECTURE.md) · [Roadmap](docs/SDLC_KANBAN.md) · [Contributing](CONTRIBUTING.md) · [Issues](https://github.com/Dkm0315/muster/issues)

```bash
pnpm --package=@musterhq/cli dlx muster demo
```

The demo is deterministic and does not need a model key. For the real interactive chat:

```bash
pnpm --package=@musterhq/cli dlx muster
```

That opens the terminal chat surface. First run opens onboarding; after setup it opens a named chat with slash commands, `@agent` routing, provider/model pickers, memory controls, plugin/MCP setup, and the token ledger.

## Latest Terminal Launch Demo

![Muster terminal launch demo](docs/assets/muster-terminal-launch-demo.gif)

**Watch the latest slowed launch video:** [MP4](docs/assets/muster-terminal-launch-demo.mp4) · [GIF](docs/assets/muster-terminal-launch-demo.gif)

This is the latest terminal video from the current launch flow: onboarding/product context, governed chat, channel setup, MCP setup, live token ledger, and integrity checks. It uses the real Muster terminal colors and the same demo path a new user can run locally. The GIF is for inline GitHub preview; the MP4 is the higher-quality asset for Telegram, LinkedIn, GitHub release notes, and launch posts.

Launch assets for GitHub, Telegram, LinkedIn, and release posts:

| Asset | Use |
|---|---|
| [Slowed terminal GIF](docs/assets/muster-terminal-launch-demo.gif) | Inline GitHub/README preview |
| [Slowed launch MP4](docs/assets/muster-terminal-launch-demo.mp4) | Telegram, LinkedIn, GitHub release notes, and richer demos |
| [Recording script](docs/assets/muster-terminal-launch-demo.tape) | Reproducible terminal capture source |

Today you can run the same path locally:

```text
muster demo — provisioned an isolated workspace and a live stub model service.

> Where do we deploy?
  (recalled 1 scoped memory)
  Muster deploys to uat-erp.example.com (recalled from scoped memory).

run            model                        in       out      est  cost$    waste   session
----------------------------------------------------------------------------------------------
287bde9c-eb19- demo/demo-model              38       17       ~    -        -       -
653b434a-0924- demo/demo-model              7        18       ~    -        -       -

integrity check at 2026-06-12: OK
store      lines    corrupt
episodes   2        0
memory     3        0
tokens     2        0
```

## Proof: Token Waste Index

`muster benchmark` compares Muster against naive replay-everything context rendering. It is deterministic and makes no model calls.

| Scenario set | Turns | Naive tokens | Muster tokens | Reduction |
|---|---:|---:|---:|---:|
| Aggregate benchmark | 170 | 875.8k | 355.2k | 59.4% |

Full methodology: [benchmark/RESULTS.md](benchmark/RESULTS.md)

## Product Surface

Muster is not only a run loop. The harness is meant to become the controlled operating layer around the agent someone actually uses every day.

| Surface | What it means in Muster |
|---|---|
| **Tools** | Built-in and pack-provided actions for shell, files, git, browser work, web search, providers, Frappe/ERPNext, channels, and MCP. Tools should run with policy, receipts, caps, and clear failure states. |
| **Skills** | Reusable workflows and instructions that can be listed, inspected, curated, activated, and attributed in the token ledger. Skills should make repeat work easier without hiding what changed. |
| **Plugins** | Installable bundles that can bring tools, skills, MCP setup, auth guidance, tests, and policy defaults together. The catalog should tell users what is executable today, what needs credentials, and what is only a setup plan. |
| **Office artifacts** | DOCX, XLSX, PPTX, and PDF workflows through `artifact-studio`: contract planning, deterministic local drafts, structural verification, app-server handoff guidance, approval-gated publish, and sample artifact generation. |
| **Memory** | Scoped, indexed memory across tenant, workspace, user, role, session, tags, and time. Retrieval should be fast as memory grows, and leakage tests should catch unsafe cross-scope recall. |
| **Channels** | Telegram, Slack, Discord, WhatsApp, Google Chat, Teams, and web entry points through the gateway, with setup checks and live diagnostics instead of silent webhook failure. |
| **Personal agent app** | The direction for the user-facing product: `muster` opens a guided terminal agent today; named sessions, onboarding, channel setup, memory controls, and web/gateway surfaces move it toward a personal agent that can follow the user across work surfaces. |

## Why Muster Exists

Most agents fail after the demo.

Long-running agents start clean, then accumulate hidden state:

- context grows until every turn replays too much history
- memory becomes unsafe when user, tenant, workspace, and session boundaries blur
- token usage disappears into provider logs instead of a local ledger
- "learning" becomes risky when feedback promotes behavior without evals
- automation becomes brittle when tools, MCP servers, browser actions, and app writes have no shared policy envelope

Muster exists to keep those controls outside the model provider.

## What Muster Does

| Problem | Muster control |
|---|---|
| Memory can leak across users or projects | **Scoped memory** with tenant, workspace, user, role, and session lanes, backed by SQLite/FTS retrieval and leakage tests. |
| Token cost becomes invisible | **Token ledger** records every run, estimates or records usage, and flags replay waste. |
| Tools run without boundaries | **Governed execution** routes tools, flows, subagents, browser work, and channels through explicit config, policy, and evidence. |
| Agents "learn" from vibes | **Eval-gated learning** turns feedback into replayable fixtures before behavior is promoted. |
| Everyday work needs repeatable actions | **Tool catalogs** expose built-in and pack-provided actions with policy, receipts, and setup checks. |
| Repeated workflows become tribal knowledge | **Skills** package reusable instructions and runbooks so teams can inspect and reuse them. |
| Integrations sprawl | **Capability packs** bundle typed tools, declared secrets, permissions, and setup guidance. |
| MCP servers are useful but risky | **MCP/plugin support** adds stdio/http servers with include/exclude policy, result caps, circuit breakers, and OAuth/PKCE helpers. |
| Chat apps need a reliable backend | **Channel adapters** connect Telegram, Slack, Discord, WhatsApp, Google Chat, Teams, and webhooks to the same governed harness. |
| Browser and web apps need audit trails | **Browser and web-app automation** can be routed through the same harness and gateway surfaces. |
| ERP systems need domain context | **Frappe/ERPNext support** ships as a capability pack with permission-scoped tools and docs/live-context setup. |
| Users need a product, not only libraries | **Personal-agent surfaces** make setup, memory, providers, channels, plugins, and command workflows discoverable from the CLI/TUI first, with richer web/app surfaces planned. |
| Provider choice should stay flexible | **Multi-provider LLM support** covers cloud APIs, open-source/self-hosted servers, aggregators, OpenAI-compatible endpoints, Gemini, Groq, Cerebras, Mistral, DeepSeek, Kimi, Qwen, OpenRouter, Together, Fireworks, LM Studio, vLLM, SGLang, Pi, Codex CLI, and Claude Code CLI. |

## Quick Start

### Prerequisites

- Node.js 24 or newer
- `pnpm` 10.x for repository development
- Optional: a configured provider key or local agent CLI for live model calls

### Try without a model key

```bash
pnpm --package=@musterhq/cli dlx muster demo
pnpm --package=@musterhq/cli dlx muster benchmark
```

`muster demo` uses a stub model service and an isolated workspace. `muster benchmark` is deterministic and makes no model calls.

### Install from source

```bash
git clone https://github.com/Dkm0315/muster.git
cd muster
pnpm install
pnpm build
pnpm hc demo
```

### Start a workspace

```bash
muster                 # interactive TUI; first run opens onboarding
muster onboard         # rerun guided setup
muster doctor --fix    # repair/check local config
muster status          # one-screen status
```

### Add a provider

Use presets when possible:

```bash
muster provider presets
muster provider add openai
muster runtime use-provider native openai
```

Common environment variables:

```bash
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
GEMINI_API_KEY=...
GROQ_API_KEY=...
OPENROUTER_API_KEY=...
MISTRAL_API_KEY=...
DEEPSEEK_API_KEY=...
TOGETHER_API_KEY=...
```

For self-hosted or compatible endpoints:

```bash
muster provider add-openai-compatible private http://localhost:8000/v1 served-model
muster runtime use-provider native private
```

### Smallest working commands

```bash
muster run "Say hi in one sentence"
muster tokens
muster memory add --summary "uat deploy target is uat-erp.example.com" --scope user:me --provenance manual
muster memory search --scope user:me --query "deploy target"
muster verify
```

## Architecture

Muster is a TypeScript monorepo. The CLI is the main entry point; the core package owns governance, memory, providers, packs, flows, ledgers, and evals; the gateway and surface packages expose web/chat entry points.

```mermaid
flowchart TD
  User[Terminal TUI / Web / Chat Channels] --> SurfaceLayer[personal-agent surface]
  SurfaceLayer --> CLI[packages/cli]
  SurfaceLayer --> Gateway[packages/gateway]
  CLI --> Router[router + profile + provider resolver]
  Router --> Runtime[provider family: cloud APIs / open-source servers / aggregators / CLI-auth runtimes]
  Router --> Tools[tool registry + MCP client + capability packs]
  Router --> Skills[skills + plugin catalog]
  Tools --> Packs[capability-packs/*]
  Tools --> MCP[MCP stdio/http servers]
  Router --> Memory[scoped memory lanes]
  Memory --> FTS[SQLite / FTS index]
  Router --> Ledger[episode store + token ledger]
  Ledger --> Verify[muster verify]
  Ledger --> Evals[eval fixtures + evolve suites]
  Surface[packages/surface] --> Gateway
  Gateway --> Router
```

Key directories:

- `packages/cli` — terminal chat, setup, commands, TUI, QA harnesses
- `packages/core` — run loop, memory, providers, MCP, capability packs, flows, ledgers, evals
- `packages/gateway` — HTTP gateway and channel/webhook adapters
- `packages/surface` — zero-dependency web client surface
- `capability-packs` — bundled packs such as Frappe/ERPNext, browser, web search, providers, channels
- `docs` — architecture, flow engine, setup/migration, retrieval, parity notes
- `website` — static Vite site for [themuster.dev](https://themuster.dev)

Muster uses provider APIs, OpenAI-compatible servers, aggregators, self-hosted open-source inference, and native agent CLIs where useful, but keeps governance outside the provider: scoped memory, token accounting, evidence, eval gates, MCP policy, and integrity verification remain Muster-owned.

## Real-World Use Cases

- **Frappe / ERPNext operator workflows**: build scoped context from Frappe/ERPNext docs, installed apps, DocTypes, fields, workflows, and records before acting through permission-scoped tools.
- **Browser automation**: route browser-capable work through explicit setup, screenshots/evidence, and approval-aware tool boundaries.
- **Enterprise web-app automation**: use the gateway and web surface to connect app events to governed runs.
- **Governed long-running agents**: keep sessions, memory, token spend, and learning visible over days or weeks.
- **MCP-based capability extension**: attach MCP servers with per-server policy, result caps, OAuth setup, and failure isolation.
- **Personal agent surfaces**: expose the same governed backend through terminal chat, named sessions, channel webhooks, and web/app surfaces instead of forcing every user to think in SDK calls.

## Comparison

Muster is not trying to replace every agent framework. It is the governance layer for agents that need to run with memory, tools, and accountability.

| Category | What they optimize for | Where Muster fits |
|---|---|---|
| Generic agent frameworks such as AutoGen or CrewAI | agent roles, collaboration patterns, task decomposition | Muster focuses on run governance: memory scope, token ledger, eval gates, capability policy, and integrity checks. |
| Workflow graph tools such as LangGraph | explicit graph/state machines for agent workflows | Muster includes flows, but its wedge is the harness around runs: scoped memory, provider routing, MCP policy, token accounting, and eval-backed learning. |
| Coding agents such as Codex or Claude Code | high-quality coding interaction with native tools | Muster can route through these CLIs when you want subscription-auth coding workflows, while keeping local ledgers, sessions, provider policy, and capability boundaries. They are optional routes, not the whole harness. |
| OpenClaw/Hermes-inspired systems | broad agent surfaces, adapters, skills, and operational UX | Muster is inspired by their breadth and UX patterns, but is narrower and more explicit about governance. Not every inspired catalog entry is a fully wired runtime adapter. |
| Broad harnesses such as OpenHarness | tools, skills, plugins, channels, memory, and personal agent UX | Muster should match that everyday-product breadth while staying stricter about scoped memory, token ledgering, eval gates, policy, and receipts. |

OpenClaw and Hermes have broader mature ecosystems. Muster's current edge is auditability: scoped memory, token visibility, eval-gated learning, MCP policy, and an integration induction layer that marks setup plans differently from executable packs.

## Implementation Status

Muster is pre-1.0. Core governance paths are implemented and tested; public APIs and integration surfaces may still change.

| Area | Current state |
|---|---|
| CLI/TUI | Implemented. `muster` opens the chat UI after onboarding with slash-command completion, `@agent` completion, history, named sessions, provider/model/runtime pickers, token, plugin, skill, MCP, and memory commands. |
| Provider/runtime path | Implemented for direct APIs, OpenAI-compatible providers, aggregators, local/self-hosted servers, Pi, Codex CLI, and Claude Code CLI. Presets include OpenAI, Anthropic, Gemini, xAI, Kimi, DeepSeek, Mistral, Qwen, Zhipu, Perplexity, Groq, Cerebras, OpenRouter, Together, Fireworks, LM Studio, vLLM, and SGLang. |
| Tools | Implemented base registry and pack model. Core tools, MCP tools, channel tools, browser/search/provider tools, and Frappe tools are discoverable through CLI commands and pack manifests. |
| Skills | Implemented base system. Skills can be listed, inspected, curated, and attributed; more default skills and QA coverage are still being expanded. |
| Memory | Implemented. Scoped memory uses SQLite/FTS with receipt reporting, graph-linked expansion, latency probes, rebuild/doctor commands, and leakage tests. |
| Token/cost | Implemented. Per-run ledger, cost estimates where pricing is known, replay-waste detection, session mode/id tracking, and skill attribution. |
| Plugins | Implemented base system. In-repo capability packs are executable; broader catalog entries are marked by actionability and should not pretend setup-only packs are live runtime integrations. |
| Office artifacts | Implemented as the `artifact-studio` pack. `muster artifacts contract`, `plan`, `create`, and `verify` cover DOCX/XLSX/PPTX/PDF drafts, structural checks, app-server skill handoffs, and integration samples. Polished visual QA still requires a document/spreadsheet/presentation/PDF app-server skill or local renderer. |
| MCP | Implemented client, stdio/http registration, include/exclude policy, result caps, circuit breakers, OAuth/PKCE setup/import, and curated install catalog. |
| Frappe/ERPNext | Implemented as a capability pack with docs/live-context setup, module/doc resources, Frappe tools, generic graph-retrieval eval fixtures, and web-framework checks. |
| Gateway/channels | Framework and setup packs exist for Telegram, Slack, Discord, WhatsApp, Google Chat, Teams, and web. Production hardening depends on real provider credentials and webhook setup. |
| Personal agent app | Early. TUI/onboarding/named sessions/channel gateway/web surface pieces exist; a dedicated polished desktop/mobile app is not done. |
| Dashboard/web UI | Basic status/export/start surfaces exist. Full dashboard/desktop app is not done. |

## Roadmap

The detailed working board lives in [docs/SDLC_KANBAN.md](docs/SDLC_KANBAN.md). The public roadmap is:

### Now

- harden TUI and setup workflows with PTY tests
- expand real-provider latency tests
- tighten Telegram/channel setup and live diagnostics
- make tools, skills, plugins, memory, channels, and personal-agent workflows obvious from onboarding and `/` pickers
- improve README, website, examples, and demos

### Next

- deeper MCP auth failure tests and setup workflows
- Frappe/ERPNext hybrid graph retrieval for installed apps, modules, DocTypes, and docs
- more browser automation examples with evidence capture
- stronger provider/model picker workflows and latency hints
- more capability-pack eval suites
- dry-run previews for channel/plugin/MCP setup so users see what will happen before secrets or webhooks are touched

### Later

- richer dashboard/desktop surfaces
- community capability-pack registry
- more channel adapters and live round-trip QA
- hosted demo assets, videos, and example repos
- full personal-agent app experience across terminal, browser, and chat surfaces

## Contributing

Contributions are welcome. Start small and keep changes testable.

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm hc demo
```

Good contribution areas:

- documentation and examples
- demo GIF/video and screenshots
- Frappe/ERPNext packs, eval fixtures, and retrieval tests
- provider adapters and latency benchmarks
- MCP setup workflows and auth failure tests
- browser automation examples
- TUI interaction tests
- capability-pack manifests and safety checks
- channel adapters, live diagnostics, and setup guides
- personal-agent onboarding, memory, and session UX

Look for [`good first issue`](https://github.com/Dkm0315/muster/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) and [`help wanted`](https://github.com/Dkm0315/muster/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22). For larger work, open an issue first so the design can be reviewed before code.

## FAQ

### Is Muster another agent framework?

Not exactly. Muster is a governed harness around agents. It can route to agent CLIs, OpenAI-compatible providers, MCP servers, capability packs, and gateway surfaces while keeping memory, tokens, learning, and tool policy auditable.

### Is Muster only a governance backend?

No. Governance is the wedge, but the product surface matters just as much. Muster is being built around tools, skills, plugins, memory, channels, and a personal-agent app layer so non-framework users can still set up integrations, recall work, pick providers, and run workflows.

### How is it different from LangGraph, CrewAI, or AutoGen?

Those projects focus on building agent workflows and collaboration patterns. Muster focuses on what happens around long-running agents: scoped memory, token visibility, eval-gated learning, capability boundaries, and integrity checks.

### Why governed agents?

Because production agents accumulate state. Without governance, memory leaks, token waste, silent fallback, and untested learning become operational risks.

### Does it work with Frappe/ERPNext?

Yes. The Frappe/ERPNext capability pack exists in `capability-packs/frappe` and supports permission-scoped tools plus docs/live-context setup. Deeper hybrid graph retrieval is on the roadmap.

### Does it support MCP?

Yes. Muster supports stdio and HTTP MCP servers, include/exclude policy, result caps, circuit breakers, OAuth/PKCE setup, and a curated install catalog.

### Can I use different LLM providers?

Yes. Muster is provider-family agnostic. It supports direct cloud APIs, Gemini-compatible routes, OpenAI-compatible HTTP providers, aggregators, open-source/self-hosted inference servers, Pi, Codex CLI, and Claude Code CLI. Use `muster provider presets` to see built-ins and `muster provider add-openai-compatible` for any custom endpoint.

## License

MIT. Open source, community-driven.
