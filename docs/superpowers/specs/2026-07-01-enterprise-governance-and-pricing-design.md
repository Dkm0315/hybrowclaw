# Muster Enterprise Governance and Pricing Design

Status: research/design draft for discussion. No implementation is implied by this document.

Date: 2026-07-01

## Executive Thesis

Muster's paid enterprise wedge should not be "more models" or "more chat".
Those are becoming commodities. The durable enterprise wedge is governed agent
operations:

> Who can use which model, on which data, through which tools, with how many
> tokens or GPU seconds, under which approval policy, with auditable evidence.

This makes Muster different from coding agents, generic graph frameworks, and
personal assistant tools. It lets Muster become the control plane between
people, agents, providers, MCP servers, channel surfaces, Frappe/ERPNext sites,
open-source model infrastructure, and enterprise systems.

The product should stay open-source at the core. Paid value should come from:

- hosted convenience,
- enterprise control,
- audited spend,
- Frappe/ERPNext depth,
- managed integration setup,
- GPU/open-source model optimization,
- support, compliance, and operational evidence.

## Research Snapshot

### Enterprise AI Governance

Recent enterprise gateway and governance products increasingly converge on the
same primitives: virtual keys, role-based access control, budgets, token/rate
limits, logging, guardrails, residency controls, and audit trails.

Useful market references:

- TrueFoundry AI Gateway: virtual keys, RBAC, budgets, rate limits, audit logs,
  residency, and guardrails as control-plane configuration.
  Source: https://www.truefoundry.com/blog/ai-governance-audit-enterprise-llm-gateway
- Braintrust AI gateway comparison: LiteLLM-style gateway primitives include
  provider routing, virtual keys, budgets, teams, load balancing, RPM/TPM
  limits, guardrails, and logging.
  Source: https://www.braintrust.dev/articles/ai-gateway-comparison-2026
- LiteLLM budgets: budget caps can be applied to virtual keys and reset by
  duration.
  Source: https://docs.litellm.ai/docs/proxy/users
- Solo agentgateway budget docs: per-route budgets, local rate limiting, and
  cost calculations are enterprise gateway patterns.
  Source: https://docs.solo.io/agentgateway/2.2.x/llm/budget-limits/
- Tyk MCP governance: MCP needs authentication, authorization, routing, logging,
  policy enforcement, rate limiting, validation, and masking.
  Source: https://tyk.io/learning-center/mcp-server-governance-best-practices/

Conclusion: Muster should not invent the governance category from scratch. It
should make these controls agent-native and workflow-native, rather than only
LLM-gateway-native.

### AI FinOps and Token Accountability

The market is moving from flat subscriptions to mixed subscription plus credits
or token billing. GitHub Copilot's agentic features now consume AI Credits, and
AI cost observability tools emphasize tracking LLM cost by team, customer, and
feature.

Useful market references:

- GitHub Copilot usage-based billing announcement.
  Source: https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/
- FinOps Foundation: AI FinOps requires cost-per-token, quotas, tags, GPU
  allocation, and real-time financial monitoring.
  Source: https://www.finops.org/wg/finops-for-ai-overview/
- Finout AI cost observability: track token spend and attribute LLM costs by
  team or customer.
  Source: https://www.finout.io/blog/best-ai-cost-observability-tools-in-2026

Conclusion: Muster's token ledger should become a first-class enterprise
entitlement and chargeback system, not only a developer-facing run receipt.

### GPU and Open-Source Model Optimization

Open-source models are attractive for India, regulated industries, and
cost-sensitive enterprises, but the hard part is not just running a model. The
hard part is keeping GPU utilization high, latency predictable, and spend
attributable.

Useful technical references:

- vLLM architecture: PagedAttention, continuous batching, prefix caching,
  speculative decoding, multi-GPU serving, scheduling, and benchmarking.
  Source: https://vllm.ai/blog
- vLLM vs SGLang vs TensorRT-LLM: vLLM for quickest production/model flexibility,
  TensorRT-LLM for maximum throughput on stable NVIDIA workloads, SGLang for
  shared-prefix/high-concurrency workloads.
  Source: https://www.spheron.network/blog/vllm-vs-tensorrt-llm-vs-sglang-benchmarks/
- GPU FinOps: hyperscaler cost tools can show instance bills but often cannot
  tell which team consumed which slice of a GPU workload.
  Source: https://www.spheron.network/blog/gpu-cloud-finops-ai-teams-cost-allocation-chargeback-budgeting/
- AI inference economics: inference is now a major long-running cost center, so
  cost-per-token and serving efficiency matter after deployment.
  Source: https://www.spheron.network/blog/ai-inference-cost-economics-2026/

Conclusion: Muster should not try to be a full GPU serving engine. It should
govern and observe engines such as vLLM, SGLang, TensorRT-LLM, TGI, llama.cpp,
and provider-hosted endpoints.

### Frappe / ERPNext Market

Frappe/ERPNext is attractive because the domain already has structured
concepts that map naturally to governed AI: DocTypes, permissions, workflows,
roles, modules, reports, server scripts, custom fields, and audit logs.

Useful market references:

- ERPNext cost drivers: self-hosted vs Frappe Cloud, implementation partner
  fees, custom apps/modules, migration, support.
  Source: https://www.erpresearch.com/pricing/erpnext
- ERPNext India cost guides commonly place implementation in the INR lakh range
  depending on modules, users, and customization.
  Source: https://psdigitise.com/blogs/erpnext-implementation-cost-india
- Frappe Cloud and ERPNext pricing guides emphasize that software licensing is
  not the only cost; hosting, implementation, customization, migration,
  training, and support dominate.
  Source: https://sanskartechnolab.com/erpnext-implementation-cost
- Frappe community guidance stresses backend validation and permissions, which
  is critical for AI write actions.
  Source: https://discuss.frappe.io/t/is-ai-integrated-in-the-erpnext-natively-and-if-there-are-any-plans-to-do-so/153609
- Existing ERPNext AI/MCP examples expose tools for document retrieval,
  metadata, roles, filters, and document operations.
  Sources:
  https://composio.dev/toolkits/erpnext
  https://definable.ai/apps/erpnext/

Conclusion: Muster can become the governed AI layer for Frappe/ERPNext if it
preserves Frappe permissions, explains actions before writes, and treats each
site/app/module as a scoped context graph.

## Target Buyers and Jobs

### 1. Indian Frappe / ERPNext Agency

Pain:

- Repeats discovery, support, report generation, and customization analysis.
- Needs to serve many client sites without leaking data between clients.
- Has thin margins and cannot manually babysit every AI run.

Buying job:

- "Help us deliver ERPNext implementations and support faster without breaking
  permissions, GST/payroll/business workflows, or client trust."

Paid value:

- site-based pricing,
- DocType-aware retrieval,
- generated implementation briefs,
- support-ticket triage,
- report/dashboard/artifact generation,
- cross-client isolation,
- token budgets per client.

### 2. Indian SMB Running ERPNext

Pain:

- Non-technical users do not understand DocTypes, workflows, permissions, or
  reports.
- Management wants answers from ERP without waiting for consultants.
- Cost sensitivity is high.

Buying job:

- "Give my team an AI assistant for ERPNext that cannot overspend, leak data,
  or make unsafe changes."

Paid value:

- simple onboarding,
- role-safe answers,
- approval-before-write,
- monthly token cap,
- WhatsApp/Telegram access,
- local language support later,
- low fixed price with controlled overage.

### 3. Enterprise CTO / CISO / CFO

Pain:

- Shadow AI is spreading across teams.
- Provider bills are hard to allocate.
- Agents can call tools, APIs, MCP servers, and enterprise systems with weak
  oversight.
- Open-source models need GPU governance.

Buying job:

- "Let teams use agents, but give us control, audit, budgets, and kill
  switches."

Paid value:

- SSO/SAML/OIDC,
- RBAC/ABAC,
- model/provider allowlists,
- data boundary policy,
- MCP registry,
- spend allocation,
- audit export,
- incident controls,
- on-prem/VPC deployment,
- GPU utilization and chargeback.

### 4. AI Platform / Developer Team

Pain:

- They already have LangGraph, CrewAI, provider SDKs, MCP, or internal tools.
- They need governance without rewriting every agent.

Buying job:

- "Put a governance layer around our existing agents and providers."

Paid value:

- gateway adapters,
- virtual keys,
- policy engine,
- token ledger API,
- run receipts,
- eval gates,
- model router,
- workflow replay,
- observability hooks.

## Product Architecture

Muster Enterprise should be a control plane over the existing harness, not a
separate product.

```text
Users / Channels / Apps
  CLI, TUI, web, Slack, Telegram, Google Chat, Teams, Frappe Desk
        |
        v
Muster Gateway
  identity, pairing, surface auth, request normalization
        |
        v
Enterprise Control Plane
  orgs, users, roles, groups, budgets, policies, approvals, audit
        |
        v
Trust Kernel
  scoped memory, token ledger, run receipts, provider route, tool/MCP policy
        |
        v
Execution Layer
  providers, open-source serving endpoints, MCP, browser, Frappe, artifacts
        |
        v
Evidence and FinOps
  usage attribution, cost, GPU utilization, evals, incidents, reports
```

## Core Modules

### 1. Identity and Entitlement

Purpose:

Map every request to an accountable identity.

Entities:

- organization
- tenant
- workspace
- user
- role
- group
- service account
- surface identity
- API key or virtual key
- pairing

Required capabilities:

- local users for OSS/dev mode,
- enterprise SSO/OIDC/SAML later,
- SCIM provisioning later,
- role/group sync,
- surface pairing for Telegram/Slack/GChat/Teams,
- service accounts for webhooks and scheduled flows,
- break-glass admin identity.

Enterprise edge cases:

- user leaves company but memory remains,
- manager changes team,
- channel user is not yet paired,
- same person uses CLI and Telegram,
- contractor has temporary access,
- service account triggers a run with no human present,
- user belongs to two companies/agencies,
- impersonation attempts from webhook channels.

Design rule:

No token, memory, tool, MCP, channel, Frappe, or provider action should be
accounted to an anonymous identity in enterprise mode.

### 2. Token Entitlement Ledger

Purpose:

Extend the token ledger into budget, quota, chargeback, and allocation.

Budget dimensions:

- organization,
- tenant/client,
- workspace/project,
- user,
- role,
- team,
- channel,
- session,
- plugin,
- MCP server,
- provider,
- model,
- workflow,
- Frappe site,
- artifact type,
- GPU pool.

Budget types:

- hard cap,
- soft cap,
- warning threshold,
- approval threshold,
- daily/weekly/monthly reset,
- one-time project budget,
- prepaid credit pool,
- overage pool.

Metrics:

- input tokens,
- cached input tokens,
- output tokens,
- retrieved context characters/tokens,
- tool calls,
- MCP calls,
- browser minutes,
- artifact render minutes,
- GPU seconds,
- cost estimate,
- exact provider cost where available,
- cost per successful business outcome.

UX:

- admin sees "who used what",
- user sees remaining allowance before expensive action,
- manager can approve temporary budget,
- CFO can export monthly chargeback,
- CTO can see waste by workflow,
- CISO can see high-risk tool calls.

Edge cases:

- provider does not return exact token counts,
- streaming fails after partial usage,
- model fallback changes price,
- cached tokens are cheaper but still real usage,
- open-source model has GPU cost instead of API token cost,
- retrieval inflates context silently,
- agent loops tool calls,
- one surface spams the gateway,
- run is resumed after budget reset,
- user submits prompt before budget check completes.

Design rule:

Every run should have a preflight estimate, live meter where possible, final
receipt, and budget decision.

### 3. Rate Limiting and Abuse Guard

Purpose:

Prevent runaway cost, abusive usage, provider throttling, and unsafe repeated
tool execution.

Limit dimensions:

- requests per minute,
- tokens per minute,
- tokens per day/month,
- tool calls per minute,
- MCP calls per server,
- browser actions per run,
- Frappe write attempts per run,
- artifact renders per hour,
- GPU concurrent requests,
- maximum wall-clock runtime.

Policy actions:

- allow,
- warn,
- degrade model,
- require approval,
- queue,
- throttle,
- deny,
- kill run,
- quarantine user/surface,
- notify admin.

Edge cases:

- attacker replays webhook,
- model enters loop,
- user pastes huge file,
- channel receives bot storm,
- provider rate limit differs from Muster limit,
- GPU queue grows and latency spikes,
- low-priority work blocks executive request,
- scheduled jobs all wake at the same time.

Design rule:

Rate limits must combine cost protection and safety protection. They should not
be only API throttles.

### 4. Provider and Model Governance

Purpose:

Let enterprises use cloud, open-source, self-hosted, and provider-auth routes
without losing governance.

Controls:

- provider allowlist/denylist,
- model allowlist by role/workflow,
- price ceiling,
- context length ceiling,
- data residency tag,
- PII policy,
- fallback policy,
- quality tier,
- latency tier,
- route explanation.

Provider families:

- commercial APIs,
- OpenAI-compatible APIs,
- Anthropic-compatible APIs,
- Gemini-compatible APIs,
- local/open-source inference,
- enterprise gateways,
- provider-auth CLI runtimes,
- internal model endpoints.

Edge cases:

- provider is down,
- fallback is more expensive,
- fallback is in another region,
- provider logs data by default,
- user chooses premium model for trivial prompt,
- model lacks tool-calling reliability,
- provider returns no token usage,
- user asks to use a blocked provider.

Design rule:

Fallbacks must be visible and auditable. No silent provider bypass around the
Muster ledger.

### 5. GPU and Open-Source Model Operations

Purpose:

Make self-hosted/open-source models practical for cost-sensitive and regulated
users without turning Muster into a model-serving engine.

Supported serving backends:

- vLLM,
- SGLang,
- TensorRT-LLM,
- TGI,
- llama.cpp,
- Ollama for local/dev only,
- OpenAI-compatible internal gateways.

Muster responsibility:

- discover endpoint,
- classify model,
- benchmark latency/throughput,
- attach cost model,
- route by task,
- enforce budgets,
- track GPU seconds,
- expose utilization,
- recommend optimization profile,
- detect degradation.

Optimization controls:

- quantization profile,
- max context,
- max output,
- batch policy,
- prefix/prompt cache policy,
- KV cache pressure indicator,
- concurrency limit,
- warm pool,
- priority queue,
- speculative decoding support flag,
- fallback to cloud model.

Enterprise UX:

- "This workflow costs less on local 8B model."
- "This workflow needs premium cloud model."
- "GPU is saturated; queue or fallback?"
- "Finance team consumed 37% of GPU pool this month."
- "This model's p95 latency breached SLA."

Edge cases:

- GPU OOM,
- quantized model gives worse answer,
- backend reports tokens differently,
- high-priority user waits behind batch job,
- model update changes output quality,
- RAG context blows up VRAM,
- stale KV cache leaks between tenants,
- tenant-specific fine-tune must not serve another tenant.

Design rule:

Muster should govern open-source inference as an accountable resource pool, not
pretend that local models are free.

### 6. Security, Policy, and Compliance

Purpose:

Make agent actions safe enough for enterprise systems.

Core controls:

- RBAC/ABAC,
- scoped memory,
- secrets references instead of raw secrets,
- DLP/redaction policy,
- MCP registry,
- tool allow/deny,
- command blocklists,
- filesystem/network boundaries,
- approval gates,
- mutating action previews,
- audit logs,
- incident kill switch,
- data-retention policy,
- exportable compliance report.

Policy examples:

- interns cannot call payroll tools,
- Telegram users cannot trigger production deploys,
- finance workflows require manager approval above INR threshold,
- PII cannot be sent to non-approved providers,
- MCP server result capped at 200 KB,
- browser automation cannot access non-allowlisted domains,
- Frappe writes require dry-run preview.

Edge cases:

- prompt injection asks agent to ignore policy,
- MCP server returns hostile tool output,
- model asks to reveal secrets,
- user attempts cross-tenant memory recall,
- OAuth token expires mid-flow,
- webhook signature missing,
- audit export contains secrets,
- approval is granted by wrong user,
- policy changes while flow is paused.

Design rule:

Policy decisions should be explicit records, not hidden if-statements.

### 7. Frappe / ERPNext Enterprise Pack

Purpose:

Create a vertical paid pack that solves real ERPNext/Frappe work.

Core context:

- site,
- bench,
- installed apps,
- modules,
- DocTypes,
- fields,
- permissions,
- roles,
- workflow states,
- server scripts,
- custom fields,
- reports,
- print formats,
- fixtures,
- hooks,
- logs,
- recent records where permitted.

Core workflows:

- answer questions using DocType-aware context,
- explain a field/workflow/permission error,
- create implementation discovery brief,
- analyze customization impact,
- generate report/dashboard spec,
- triage support ticket,
- draft safe patch plan,
- dry-run document create/update,
- generate artifacts from ERP data,
- compare staging vs production app context.

Safety:

- read through Frappe permissions,
- writes through Frappe ORM/API,
- mutating actions require preview,
- field-level permissions honored,
- never bypass backend validations,
- tenant/client separation enforced.

Edge cases:

- custom app shadows core DocType,
- custom field contains sensitive data,
- role permission changed after indexing,
- stale docs conflict with live site,
- workflow state prevents write,
- API user has more permissions than end user,
- multi-company data mixed in one site,
- background job fails after agent reports success.

Pricing implication:

Frappe pack can be priced per site/client because value maps to site
complexity, not only user count.

### 8. Channel and Personal-Agent Governance

Purpose:

Let users interact from chat apps without losing identity, budgets, security,
or context boundaries.

Channels:

- Telegram,
- Slack,
- Google Chat,
- Teams,
- WhatsApp,
- Discord,
- web widget,
- Frappe Desk,
- CLI/TUI.

Controls:

- pairing,
- channel-level budget,
- thread/session mapping,
- role lookup,
- command allowlist,
- attachment scanning,
- approval cards,
- rate limits,
- emergency disable.

Edge cases:

- forwarded messages,
- group chat mentions,
- unknown user in channel,
- bot added to wrong workspace,
- file upload too large,
- user deletes message after action,
- channel API retries webhook,
- Slack/GChat/Teams identity mismatch,
- Telegram username changes.

Design rule:

The same governed backend handles all surfaces. Channels should be thin
adapters, not separate security models.

### 9. Enterprise Admin UX

Purpose:

Make non-framework users feel in control.

Key screens:

- organization dashboard,
- budget ledger,
- users/roles/groups,
- provider/model policy,
- MCP/plugin registry,
- channel setup,
- Frappe sites,
- GPU pools,
- approvals,
- audit logs,
- incident center,
- monthly report.

Admin UX principles:

- show impact before setup,
- explain tradeoffs,
- default to safe policies,
- show setup status honestly,
- avoid forcing users to know model names,
- provide recommended presets,
- expose advanced controls only when needed.

Example copy:

- "Finance has 2.1M tokens left this month."
- "This workflow can write to Sales Invoice. Manager approval is required."
- "The local GPU route is cheaper but slower for this task."
- "This MCP server is installed but not verified."
- "This Frappe site was indexed 3 hours ago. Permissions changed 12 minutes ago;
  refresh before write actions."

## Data Model Sketch

```text
Organization
Tenant
Workspace
User
Role
Group
SurfaceIdentity
ProviderRoute
ModelPolicy
VirtualKey
Budget
BudgetWindow
UsageRecord
TokenRecord
GpuUsageRecord
Plugin
McpServer
ToolPolicy
FrappeSite
FrappeContextIndex
MemoryScope
Run
RunStep
EvidenceRecord
ApprovalRequest
AuditEvent
Incident
```

Important relationships:

- Budget can attach to org, workspace, role, user, channel, plugin, provider,
  model, Frappe site, or workflow.
- UsageRecord links to Run, User, SurfaceIdentity, ProviderRoute, ModelPolicy,
  and BudgetWindow.
- MemoryScope intersects user/role/workspace/tenant/session/pairing.
- ApprovalRequest links to RunStep and required role.
- FrappeContextIndex links to site, app, DocType, permission snapshot, and
  refresh time.

## Pricing Design

Pricing should be hybrid: base platform + active users/sites + usage pools.

### Global SaaS Pricing

| Plan | Buyer | Suggested pricing | Included value |
|---|---|---:|---|
| Free OSS | Developers, evaluators | Free | Local CLI/TUI, local ledger, local packs, BYOK |
| Pro | Individual power users | $15-$25/user/month | hosted sync, personal integrations, artifact workflows |
| Team | small teams/agencies | $29-$49/user/month | shared workspaces, roles, budgets, channel setup, MCP registry |
| Frappe Pack | agencies/ERP teams | $299-$999/site/month | site indexing, DocType-aware retrieval, safe ERP workflows |
| Enterprise | CTO/CISO/CFO | $2k-$10k+/month | SSO, audit, policies, compliance exports, custom deployment |
| GPU Add-on | open-source model users | usage or reserved capacity | GPU routing, utilization, quota, chargeback |

### India Pricing

India needs lower entry points and site-based packaging for Frappe.

| Plan | Suggested India pricing | Notes |
|---|---:|---|
| Pro | INR 999-1,999/user/month | for founders/operators |
| Team | INR 1,999-3,999/user/month | for agencies/internal teams |
| Frappe Starter Site | INR 15k-25k/site/month | one site, limited token pool |
| Frappe Growth Site | INR 35k-75k/site/month | larger token pool, channels, reports |
| Frappe Enterprise | INR 1L-8L/month | multiple sites, SSO, audit, custom support |
| Implementation add-on | INR 75k-5L+ one-time | aligns with ERPNext implementation economics |

### Pricing Guardrails

- Do not charge for core open-source governance basics.
- Do not use unlimited language for agent usage.
- Show included token/credit/GPU pool.
- Support BYOK so users can avoid provider markup.
- Charge for hosted convenience, control, support, compliance, and vertical
  depth.
- For Frappe, price by site plus active AI users plus usage, not only seats.

## User Feasibility and Ease of Use

### Onboarding Flow

1. Pick use case:
   - personal assistant,
   - team automation,
   - Frappe/ERPNext,
   - open-source/local models,
   - enterprise governance.
2. Pick provider route:
   - cloud API,
   - existing provider login,
   - open-source endpoint,
   - BYOK,
   - skip for demo.
3. Pick controls:
   - default safe,
   - strict enterprise,
   - cost-saving,
   - experimentation.
4. Set initial budget:
   - user,
   - team,
   - channel,
   - provider/model.
5. Connect integrations:
   - one at a time,
   - show impact,
   - authenticate,
   - verify,
   - enable,
   - run sample.
6. Show first receipt:
   - tokens used,
   - model used,
   - memory recalled,
   - tools called,
   - policy decisions.

### Admin Defaults

For normal users:

- recommended model picker instead of raw model names,
- prebuilt Frappe policy presets,
- suggested monthly token budget,
- one-click "safe mode",
- human-readable audit summaries.

For advanced users:

- raw policy editor,
- virtual keys,
- custom providers,
- custom MCPs,
- budget hierarchy,
- GPU routing profiles.

## Enterprise Edge-Case Matrix

| Area | Edge case | Required behavior |
|---|---|---|
| Identity | user unpaired in Telegram | ask pairing, no privileged action |
| Budget | run exceeds hard cap mid-stream | stop cleanly, record partial usage |
| Provider | provider returns no token usage | estimate, mark estimated, allow admin override |
| GPU | backend OOM | fail with route recommendation, no retry storm |
| Frappe | user lacks DocType permission | answer with permission boundary, no hidden bypass |
| MCP | server returns huge payload | cap result, summarize safely, record truncation |
| Memory | cross-tenant similar query | retrieve only intersecting scopes |
| Approval | approver loses role before approval | re-check role at approval time |
| Channel | webhook replay | idempotency key, reject duplicate mutation |
| Security | secret appears in tool output | redact before logs/receipts/export |
| Rate limit | scheduled jobs wake together | queue by priority and budget |
| Billing | prepaid pool exhausted | degrade/deny/ask for approval based on policy |
| Audit | export requested by CISO | include policy decisions, usage, evidence, redacted secrets |

## Phased Delivery

### Phase 0: Design and Scorecard

- finalize this design,
- map existing code to modules,
- define enterprise readiness scorecard,
- identify what is already implemented vs missing.

Evidence:

- design doc,
- gap matrix,
- no implementation claims.

### Phase 1: Local Enterprise Ledger

- budget hierarchy,
- per-user/per-role/per-surface token allocation,
- hard/soft caps,
- receipt improvements,
- admin CLI/TUI views,
- tests for cap enforcement and attribution.

Evidence:

- local tests,
- PTY demo,
- no hosted claims.

### Phase 2: Policy and Rate-Limit Engine

- policy records,
- rate-limit dimensions,
- model/provider allowlists,
- tool/MCP safety gates,
- mutating action approvals,
- incident kill switch.

Evidence:

- policy fixtures,
- failure-mode tests,
- redaction tests.

### Phase 3: Frappe Enterprise Pack

- Frappe site profile,
- DocType/field/workflow/role index,
- permission snapshot,
- safe read/write tool policy,
- module workflows,
- sample use cases on Frappe-2.

Evidence:

- Frappe-2 regression suite,
- no false-positive live transcripts,
- permission denial tests.

### Phase 4: Open-Source Model Ops

- vLLM/OpenAI-compatible endpoint profile,
- model benchmark command,
- latency and cost model,
- GPU pool metadata,
- routing policies,
- utilization/chargeback records.

Evidence:

- benchmark output,
- budget enforcement,
- degraded-route handling.

### Phase 5: Hosted / Paid Control Plane

- org/workspace admin dashboard,
- SSO/OIDC,
- hosted sync,
- team policies,
- billing integration,
- audit export,
- support workflows.

Evidence:

- security review,
- deployment docs,
- pricing page,
- enterprise demo script.

## What Not To Build First

- A full billing system before local entitlements work.
- A full GPU serving engine.
- A generic CRM/ERP assistant before Frappe depth.
- Dozens of shallow MCP integrations without readiness proof.
- A complex web dashboard before the CLI/TUI/admin workflows are correct.
- Unlimited-agent marketing language.

## Discussion Questions

1. Should the first paid wedge be Frappe/ERPNext agencies in India or global
   developer teams using multiple providers?
2. Should BYOK be the default for all paid plans, with hosted credits optional?
3. Should Frappe pricing be per site, per active AI user, or a hybrid?
4. Which security controls are mandatory for the first enterprise demo: SSO,
   RBAC, audit export, approval gates, or all four?
5. Should GPU governance start as OpenAI-compatible endpoint governance first,
   then add vLLM-specific telemetry later?

## Recommended Product Position

For paid enterprise:

> Muster Enterprise is the governed AI operations layer for teams that need
> agents to use memory, tools, providers, GPUs, channels, and Frappe/ERPNext
> safely with budgets, roles, approvals, and audit receipts.

For India/Frappe:

> Muster gives ERPNext and Frappe teams a governed AI layer that understands
> DocTypes, roles, workflows, installed apps, and token budgets before it acts.

For global developer teams:

> Muster wraps existing agents, providers, MCP servers, and open-source models
> with scoped memory, token ledgers, policy, and evidence.
