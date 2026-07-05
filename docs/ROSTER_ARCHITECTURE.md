# Roster Architecture

Roster is Muster's capability induction layer. It is not a second plugin
runtime, not a static integration brag sheet, and not a place to hardcode what
another host might have installed. Its job is to take a capability from a
source, prove what it is, lock it, and project it into the right existing
Muster surface.

## Reference Findings

This design is based on direct inspection of the public codebases for Codex,
OpenClaw, and Hermes Agent.

### Codex

Relevant code inspected:

- `codex-rs/ext/mcp/src/executor_plugin.rs`
- `codex-rs/ext/mcp/src/executor_plugin/provider.rs`
- `codex-rs/ext/mcp/tests/executor_plugin_mcp.rs`
- `codex-rs/ext/mcp/tests/hosted_apps_mcp.rs`

Codex treats plugins as selected capability roots. A selected plugin can
contribute MCP servers and connector ids, but those declarations are projected
into a step only after the selected root is resolved and the environment is
available. Plugin-scoped MCP server requirements can disable or constrain
servers without editing the plugin package.

Implication for Muster: Roster should produce a projection plan for a selected
capability and current host, not globally activate every discovered capability.
Host auth state and environment availability are runtime evidence, not catalog
facts.

### OpenClaw

Relevant code inspected:

- `src/channels/plugins/types.plugin.ts`
- `src/channels/plugins/types.adapters.ts`
- `src/channels/plugins/registry.ts`
- `src/channels/plugins/module-loader.ts`
- `src/channels/plugins/registry-loader.ts`
- `src/mcp/plugin-tools-serve.ts`
- `src/mcp/plugin-tools-handlers.ts`
- `src/mcp/channel-bridge.ts`

OpenClaw has deep, typed plugin surfaces. Channel plugins are not just webhook
handlers; they can own config, setup, pairing, security, auth, outbound, status,
gateway lifecycle, directory lookup, message actions, threading, and agent
tools. OpenClaw also exposes its own plugin tools and channel conversations as
MCP servers without making MCP the only runtime model.

Implication for Muster: Telegram and Slack depth should be preserved in the
gateway/channel layer. Roster should register their install, readiness, policy,
and diagnostics depth, not replace them with generic catalog rows.

### Hermes Agent

Relevant code inspected:

- `hermes_cli/plugins.py`
- `tools/registry.py`
- `tools/mcp_tool.py`
- `gateway/platform_registry.py`
- `plugins/platforms/discord/plugin.yaml`
- `AGENTS.md`

Hermes separates tool registry, MCP discovery, gateway platform adapters, memory
providers, model-provider plugins, and dashboard/plugin surfaces. General plugin
discovery is idempotent and opt-in. Gateway platform adapters are lazy-loaded so
normal chat does not pay the cost of every integration. Hermes also explicitly
pushes new third-party product integrations into standalone plugin repositories
instead of absorbing all vendor code in core.

Implication for Muster: Roster should be lazy and source-aware. It should keep
core induction and policy in the Muster repo while allowing third-party or
suite-level integrations to live in separate repos once the contract is stable.

## Concept

Roster answers four questions:

1. What capability exists?
2. Can Muster prove it is safe and compatible enough to install?
3. Which Muster surface should own runtime execution?
4. What exact config/policy change would activate it here?

It does not answer those questions with one universal adapter. It chooses a
projection target.

## Projection Targets

Roster entries should project to one of these targets:

| Target | Runtime owner | Use when |
| --- | --- | --- |
| `capability_pack` | `packages/core/src/capability.ts` | The capability ships executable Muster tools, evals, readiness metadata, and a manifest. |
| `mcp_server` | `packages/core/src/mcp.ts` | The capability is best represented as an external MCP server with stdio/http transport, auth, limits, and tool policy. |
| `channel_adapter` | `packages/gateway` | The capability is a chat/channel surface such as Telegram, Slack, Discord, WhatsApp, Google Chat, or Teams. |
| `host_connector` | External host such as Codex, Claude, OpenClaw, or Hermes | The host already exposes an authenticated app or MCP connector and Muster should reuse or reference it without copying opaque secrets. |
| `skill` | `packages/core/src/skills.ts` | The capability is workflow guidance, not an executable integration. |
| `setup_plan` | CLI/docs/onboarding | The capability is known but not executable until the user configures credentials or installs a backing adapter. |

This table is deliberately boring. The power comes from routing to the correct
existing owner instead of creating a new runtime path.

## Projection Gates

`RosterProjectionPlan` is also a preflight artifact. Each plan includes gates so
operators can see whether a target is executable, credential-bound,
host-evidence-only, or blocked before any config changes.

Required gates:

| Gate | Purpose |
| --- | --- |
| `target` | Proves at least one projection target exists, or explains why planning is blocked. |
| `ownership` | Shows which runtime owner remains responsible for each target. |
| `credentials` | Separates ready targets from env, OAuth, API-key, or host-auth setup work. |
| `host_evidence` | Records whether reusable host connectors came from an explicit scan. |
| `diagnostics` | Points to the next doctor/check command before enabling a pack or channel. |
| `mutation_boundary` | States what a later apply/activate command is allowed to mutate. |

Gate status values are `passed`, `needs_action`, and `blocked`. A
`needs_action` gate is not a failure; it is Roster being honest that the next
step requires credentials, host setup, or a diagnostic command.

## Depth Contract

Each `RosterProjectionPlan` also carries a compact depth contract. This is the
part that keeps Roster from becoming a shallow list of logos.

The depth contract records:

- `level`: `verified_runtime`, `partial_runtime`, `credentials_required`,
  `host_evidence_only`, `setup_only`, or `blocked`.
- `capabilities`: stable tags such as `owned_runtime:channel_adapter`,
  `owned_runtime:mcp_server`, `host_reuse`, `setup_plan`, `channel:slack`, or
  `mcp:figma`.
- `auth`: the credential modes involved, such as `env`, `api_key`, `oauth`,
  `host_oauth`, or `local`.
- `evidence`: why Roster believes the plan is real, such as `builtin_catalog`,
  `pack_path`, `mcp_install_spec`, `capability_readiness`, `verified_digest`,
  `eval_fixtures`, `diagnostics`, or `explicit_host_scan`.
- `speed`: whether planning used pure in-memory metadata, explicit host-scan
  evidence, activation-only lockfile evidence, and what cache posture applies.
- `gaps`: the remaining gates or targets that prevent deeper activation.

This mirrors the useful Hermes pattern: tool/platform metadata is cheap and
lazy, while availability checks and host evidence are explicit and cacheable.
It also avoids the OpenClaw trap of treating every integration as a runtime
plugin that must be loaded before ordinary chat can answer.

OAuth-backed MCP servers are credential-gated even when their install spec is
known. Roster should point the operator at both `muster mcp install <id>` and
`muster mcp oauth setup <id>` instead of calling the integration merely
setup-only. Host evidence can prove that a provider already has an authenticated
connector, but that remains `host_evidence_only` until Muster owns a configured
MCP server or another explicit runtime target.

`muster roster catalog` is the cheap comparison surface. Its JSON/report
envelope includes `matrix.summary`, with total entries plus counts by kind,
support mode, risk, source, and auth mode. It also exposes first-class counts
for owned packs, channel adapters, installable MCPs, host reuse, and
setup-plan-only entries. Release checks can use this to track integration depth
over time without running live tools or host scans. The `channel_plugin_setup`
QA suite records this matrix in its `catalog.json` artifact and includes a
`roster_support_depth` case that fails if owned packs, channel adapters,
installable MCPs, or skill guidance disappear, or if host reuse appears without
an explicit host scan.

## Source Model

Roster sources are not all equal.

| Source kind | Example | Trust posture |
| --- | --- | --- |
| `builtin` | in-repo capability packs | Can be enabled through existing high-risk policy and pack verification. |
| `local` | a checked-out pack path | Verify manifest, digest, evals, readiness, and compatibility before lock. |
| `git` | pinned repo/ref/subpath | Materialize only pinned refs, verify after clone, record resolved path in lock. |
| `host_scan` | Codex/Hermes/OpenClaw/Claude local plugin cache | Evidence only. It can prove host reuse exists but must not become a static catalog claim. |
| `registry` | future `musterhq/roster` index | Treat as metadata until each entry verifies locally. |

Host scans must be configurable. No Roster config should assume a fixed home
directory layout as a contract. Defaults may look at common host homes, but env
or config overrides must be supported, and missing hosts must be normal.

Host scan output is evidence, not authority. Every explicit scan records a
bounded evidence summary in CLI JSON/report output:

- provider, source root, and layout
- cache status (`miss`, `hit`, `refresh`, or `disabled`)
- source fingerprint and `scannedAt`
- connector, app, MCP, and source counts

The fingerprint is derived from bounded manifest metadata and mtimes, not from
secrets or live tool calls. Cached evidence can make planning fast, but it does
not prove that a host OAuth token should be copied or that live MCP tools are
available. Activation must still go through the owning surface: gateway,
MCP config, capability-pack policy, skill activation, or host reuse.
`muster plugins reuse <provider> --json` and `--report path` provide the
structured host-reuse contract for that last case: provider source root/layout,
app and MCP next commands, requested adoptions, adoption results, safety policy
(`secrets=not_read`, `tokens=not_copied`), and mutation boundary. Discover-only
reuse mutates nothing; MCP adoption is limited to `tools.mcp.servers`.
Host MCP manifests that contain bearer-token/API-key fields remain classified
as host-owned token integrations. They can be reported as reusable evidence, but
they are not silently adopted as Muster OAuth servers and their token material
is never copied into Muster config.
The structured reuse report distinguishes requested adoption from actual
mutation: skipped or missing adoptions keep `mutation.boundary=none`, while only
successfully configured MCPs report the `tools.mcp.servers` mutation boundary.
Unsupported providers and empty provider caches still emit the same `policy`,
`requestedAdoptions`, `adoptions`, `mutationBoundary`, and `mutation` fields so
CI and setup UIs do not need one-off parsers for failure states.

Local registries are generated with `muster roster index --out
roster.index.json [pack-path ...]`. The command verifies each capability pack
before writing an index entry, preserving the same manifest, digest, readiness,
eval, and diagnostic gates used by `roster inspect` and `roster install`.
`--builtin-packs` can seed an index from in-repo packs, while explicit pack
paths keep third-party development workflows reviewable.

Newly generated index entries carry manifest-derived integration metadata:
readiness level/status, owner, surfaces, setup/auth storage, diagnostic commands
and latency budget, safety posture, evidence, eval fixtures, and implemented
tools. This keeps catalog and planning views deep without forcing clients to
reopen every pack on the response path. Older index entries without metadata
remain valid; verification still reopens the pack before install or activation.

Index metadata must stay static and secret-free. It may name required
environment variables and diagnostic commands, but it must not include host
OAuth tokens, live MCP tool lists, provider account data, or results from
recursive host scans. Host evidence remains a separate explicit scan/cache
input.

Verification treats index metadata as a cache of manifest claims, not as a
second source of truth. If metadata is present, `muster roster verify`,
`inspect`, `install`, and lock creation compare it with metadata derived from
the current pack manifest and block stale or tampered entries. Legacy index
entries without metadata remain valid because manifest verification is still
authoritative.

When maintainers run `muster roster index --skip-blocked`, skipped packs should
not be a dead end. The CLI prints repair hints for common verifier failures:

- missing or mismatched digest -> `muster capability digest <path> --write`
  followed by `muster capability inspect <path>`
- missing readiness diagnostics -> add readiness metadata with doctor and smoke
  commands, then inspect
- missing eval fixtures -> fix declared eval paths, then inspect

The command still refuses to index blocked packs; repair hints are developer
tooling, not a bypass.

`muster roster publish --dry-run <path>` builds the candidate registry entry
from the pack and keeps the default output as raw entry JSON for review and
copy/paste workflows. `--json` and `--report <path>` emit a publish envelope
with the candidate entry plus the verifier gates that justified it, so registry
automation can archive evidence without re-parsing human output.

For CI and registry publication, `muster roster index --json` and
`--report <path>` emit a structured envelope with the generated `index`,
an index `summary`, `skipped` packs, and per-pack repair commands. The summary
is computed from already-loaded index metadata and includes readiness,
actionability, risk, surfaces, credential storage, live-credential diagnostics,
eval fixture coverage, and implemented tool names. The default dry-run output
stays the raw index JSON for local review, while JSON/report mode gives
automation a stable contract without parsing stderr.

`muster roster verify --json` includes both `indexSummary` and a verification
`summary` on top of the full per-entry report. `indexSummary` describes the
claimed registry depth from the loaded index, while the verification summary
counts passed/blocked gates, lists blocked `id@version` entries, groups blocker
messages by gate, and emits structured repair actions. This lets CI fail a
registry publish on exact gates such as digest drift, compatibility drift,
missing evals, or stale metadata while preserving the full report for review.
Repair actions are local developer guidance only; they do not copy host
credentials or bypass verification.

Registry CI should run `muster roster verify --registry-profile verified`
before publication, and release channels should use `--registry-profile
release` once live evidence is required. These profiles are only presets over
existing gates: `verified` means `--require-metadata --min-readiness verified`,
while `release` means `--require-metadata --min-readiness release_ready`.
Production install flows can pass the same profile to `inspect`, `install`, or
`materialize`. The default verifier remains compatible with legacy local
indexes that do not yet carry metadata, but registry profiles block entries
without manifest-derived index metadata so the registry cannot silently regress
to a surface-only catalog.

Production registries can still override the profile minimum with explicit
`--min-readiness verified` or `--min-readiness release_ready` on `verify`,
`inspect`, `install`, and `materialize`. This keeps shallow `listed`,
`setup_plan`, or merely `installable` entries out of release channels without
changing the default local development path. When a pack misses the requested
readiness level, verification repair actions should point maintainers toward
release evidence, `pack_readiness` QA, and index regeneration rather than
generic metadata repair.

## Activation Flow

Roster activation has five phases:

1. **Discover**
   Read a local index, host scan, builtin catalog, or registry entry. Discovery
   may produce many candidates, but none are active.

2. **Verify**
   Check source existence, compatibility, manifest schema, digest, readiness,
   declared env/auth, eval presence, and diagnostic commands. Verification must
   distinguish `ready`, `needs_credentials`, `needs_host`, and `blocked`.

3. **Lock**
   Persist the exact entry, source, digest, risk, actionability, readiness, and
   resolved local path when applicable. Lockfiles make activation reproducible.
   Operators can preflight an existing lockfile with `muster roster lock
   --verify`; it reuses the activation-time verifier and reports the same gate
   summaries and repair actions without mutating config.
   `muster roster materialize --json` and `--report` expose the pinned source,
   resolved local path, verification result, and updated lock entry for CI.

4. **Plan**
   Produce a projection plan. The plan says whether activation means adding a
   plugin policy path, adding MCP config, enabling a gateway adapter, enabling a
   skill, or recording host reuse evidence. Plans are dry-run friendly.

5. **Apply**
   Apply only the specific projection. Applying a channel adapter must not touch
   unrelated MCP config. Applying an MCP server must not copy host OAuth tokens.
   Applying a capability pack must go through the existing plugin policy gates.
   `muster roster activate channel:<id>` is a gateway preflight/activation
   handoff: it reports readiness, missing gateway fields, route, ingress mode,
   doctor/simulate/start commands, and refuses to accept channel secrets itself.
	   `muster roster activate mcp:<id>` writes only the built-in MCP install spec
	   under `tools.mcp.servers`; OAuth-capable servers still require a visible
	   follow-up such as `muster mcp oauth setup <id>`.
	   Env-backed MCP activation validates that required env vars exist before
	   activation, but persists env references such as `${TOKEN}` or `TOKEN|ALT`
	   instead of the current secret value. Runtime credential ownership stays with
	   the process environment or the MCP OAuth store, not `config.json`.
	   `muster roster activate skill:<id>` delegates to the profile skill writer and
   mutates only the bundled skill file plus `skills.entries`; skills are
   workflow guidance, not executable integration adapters.
   Locked capability packs are re-verified from their local or materialized path
   immediately before mutation so a stale or tampered lock target cannot be
   enabled merely because it verified when the lock was first written. The
   activation check must compare the lock snapshot against the current manifest
   readiness, actionability, risk, and slot as well as source, digest, evals, and
   diagnostics. `muster roster activate --dry-run --json` and `--report` expose
   the activation plan, verifier gates where applicable, and exact mutation
   boundary for CI/operator review before config is written. JSON output is a
   format, not an implicit dry-run: without `--dry-run`, successful activation
   applies the bounded mutation and reports both `wouldWriteConfig` and
   `didWriteConfig`.

## Speed And Cache Contract

Speed is part of the integration contract. Roster must improve integration
depth without slowing normal chat, gateway handling, or startup paths.

Production rules:

- No remote registry fetch on the hot chat path.
- No recursive host/plugin scan on chat startup.
- Host scans run only for explicit commands such as `muster roster catalog
  --host codex`, `muster roster catalog --scan-hosts`, `muster plugins reuse
  <provider> [--json|--report path]`, onboarding setup, or a user-approved
  doctor pass.
- Projection planning is pure and uses already-loaded builtin metadata plus
  optional host-scan evidence.
- Slow scans write a bounded cache under `.muster/roster/host-scan-cache.json`
  by default, with a schema version, source root, bounded mtime fingerprint,
  CLI version, and TTL.
- Cache controls are explicit: `--no-host-cache` bypasses read/write,
  `--refresh-host-cache` forces a fresh scan and rewrites the entry,
  `--host-cache path` selects a cache file, and `--host-cache-ttl-ms n` or
  `MUSTER_ROSTER_HOST_SCAN_CACHE_TTL_MS` tunes freshness.
- Cache entries must be invalidated when the source root, manifest mtime, CLI
  version, or Roster schema changes.
- Cache misses must degrade gracefully to `setup_plan` or `needs_host`; they
  must not block unrelated channel/MCP/capability operations.
- Gateway adapters must not depend on Roster cache availability for incoming
  messages.
- MCP server tool discovery remains owned by the MCP layer; Roster can cache
  install metadata but not live tool lists unless a bounded doctor command
  explicitly records them.
- Accuracy wins over stale speed: cached host evidence is labeled with
  `scannedAt` and source fingerprint, and activation re-checks before applying
  any mutation.

Target latency budgets:

| Path | Budget | Notes |
| --- | ---: | --- |
| `planRosterBuiltinProjection()` | < 5 ms | Pure in-memory builtin metadata and optional provided scan evidence. |
| `muster roster catalog` without host scan | < 100 ms | No filesystem recursion beyond config/bootstrap. |
| Host scan with warm cache | < 150 ms | Load compact cache and validate fingerprint. |
| Host scan cold path | bounded by root count | Must print progress or stay command-only, never chat-startup. |
| Gateway message handling | no added Roster dependency | Telegram/Slack paths remain independent. |

## Non-Goals

Roster should not:

- replace `loadCapabilityPack`
- replace MCP client config
- replace gateway adapter config
- copy provider-host secrets silently
- treat Codex, Claude, OpenClaw, or Hermes installed connectors as static facts
- auto-load every discovered plugin at chat startup
- absorb every third-party integration into the Muster repo

## Same Repo vs Separate Repo

Keep this in the Muster repo:

- Roster schemas
- verifier and lockfile logic
- activation/projection planner
- builtin pack integration
- tests for Telegram/Slack/gateway/capability pack non-regression
- host-scan adapters that read local manifests without secrets

Move to a separate `musterhq/roster` or `musterhq/roster-integrations` repo
after the contract stabilizes:

- third-party vendor packs
- suite-level integrations that are not strategic to Muster core
- community registry indexes
- heavy examples and templates

Keep strategic first-party depth in-tree:

- Frappe/ERPNext if Muster intends to own that vertical
- Telegram and Slack channel packs because they protect existing gateway UX
- core MCP bridge and provider/runtime packs
- artifact/data/developer packs that define Muster's product wedge

## Current Gap

Muster already has several useful primitives:

- capability-pack manifests and loader
- MCP stdio/http client with OAuth helpers, result caps, and circuit breakers
- gateway adapters for Telegram, Slack, Discord, WhatsApp, Google Chat, Teams,
  and web
- builtin catalog actionability metadata
- onboarding/plugin/MCP/channel CLI setup paths

The missing layer is a typed projection contract connecting those primitives:

- `RosterEntry` should describe the source and verification requirements.
- `RosterLockEntry` should freeze what was verified.
- `RosterProjectionPlan` should describe exactly which owner will run it.
- `RosterHostScan` should provide optional evidence about reusable host
  connectors.
- CLI commands should expose `index`, `inspect`, `verify`, `install`,
  `materialize`, `plan`, and `activate` as separate phases.

## Design Guardrails

- Host detection is evidence, never a built-in catalog fact.
- Activation is opt-in and dry-run visible.
- Every projection target has a different runtime owner.
- Setup-only entries remain setup-only until a backing adapter verifies.
- Channel adapters preserve their channel-specific contracts.
- MCP servers keep per-server policy, timeouts, result caps, and auth state.
- Capability packs keep manifest, digest, eval, and plugin policy gates.
- Third-party product depth prefers standalone repos once the interface is
  stable.

## Near-Term Implementation Pass

1. Keep the Roster verifier, lockfile, materialization, and activation-plan
   primitives in `packages/core/src/roster.ts`.
2. Replace any static "host has X" claims with dynamic host-scan evidence.
3. Rename or treat the current support matrix as `roster catalog` diagnostics,
   not as the core Roster model.
4. Add a `RosterProjectionPlan` type that can represent:
   `capability_pack`, `mcp_server`, `channel_adapter`, `host_connector`,
   `skill`, and `setup_plan`.
5. Teach CLI `roster plan <id>` to show the projection target without mutating
   config. `roster inspect` remains focused on registry verification gates.
6. Add regression tests proving Telegram and Slack channel setup still use the
   gateway/channel config paths and are not replaced by Roster.
7. Keep external registry work local-file first; remote registry publishing can
   wait until projection semantics are stable.
