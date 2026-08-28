# Chat On Steroids — code-level analysis

## Scope and method

Repository reviewed: `totec448-spec/chat-on-steroids`, branch `main`, as available on GitHub on 2026-08-28. I attempted the requested clone into this directory, but the environment could not resolve `github.com`; therefore the local checkout could not be created. I used the repository’s public source files read-only over GitHub instead. I did not install dependencies and did not run, build, test, import, or otherwise execute repository code.

The conclusions below are based on source and configuration, not only the README. The most relevant files are linked inline, especially [`src/main/index.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/index.ts), [`src/main/mcp/server.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/mcp/server.ts), [`src/main/bridge.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/bridge.ts), [`src/main/session/store.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/session/store.ts), [`src/main/session/continuation.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/session/continuation.ts), [`src/main/agents.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/agents.ts), and the extension files.

## Executive assessment

This is a local Electron capability broker plus a Chrome UI-observation/automation companion. ChatGPT remains the model and browser UI; Electron owns local capabilities and durable state; the extension translates browser-visible ChatGPT activity into local observations and executes carefully tracked browser-side commands such as typing a worker bootstrap or a Compact & Resume handoff.

The implementation is unusually explicit about state machines, durable acceptance barriers, request correlation, loopback authentication, and failure recovery. The central security fact is nevertheless uncomfortable: this is not a sandbox. If `exec_command` is enabled, ChatGPT can cause arbitrary programs to run with the logged-in user’s normal privileges. Approved-folder checks meaningfully constrain file tools, but do not constrain commands, and they are not a kernel/VM boundary.

My verdict is “careless/powerful beta, not demonstrably malicious.” I found no clear exfiltration beacon, credential stealer, obfuscated payload, or covert telemetry mechanism in the reviewed source. I did find intentionally broad capabilities, risky defaults, browser-private-API dependence, unencrypted session history, public tunnel URLs treated as bearer secrets, and an unattended goal loop that can spend API credit and send messages without per-turn confirmation.

## 1. Real architecture

### Process split

The application is a conventional Electron three-part design:

* The Electron main process is the authority. [`src/main/index.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/index.ts) creates the tray/window, initializes config, secrets, session and durable stores, registers IPC, starts the MCP and browser bridges, restores worker/continuation state, and owns shutdown ordering.
* The renderer is a local UI only: [`src/renderer/index.html`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/renderer/index.html), [`src/renderer/main.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/renderer/main.ts), [`src/renderer/chat.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/renderer/chat.ts), and [`src/renderer/dom.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/renderer/dom.ts). It does not directly get Node or filesystem access.
* [`src/preload/index.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/preload/index.ts) exposes the narrow renderer-to-main API. The window is created with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, no webviews, web security enabled, navigation/window-open blocked, and a restrictive CSP in [`src/main/index.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/index.ts).

The renderer is therefore a control panel, not the security boundary. IPC handlers in [`src/main/ipc.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/ipc.ts) and the live main-process config are the actual boundary.

### MCP path to ChatGPT

Mechanically, the route is:

```text
ChatGPT custom MCP app
        │ HTTPS tunnel (OpenAI Secure MCP Tunnel, Cloudflare, or user tunnel)
        ▼
127.0.0.1:<ephemeral-port>/<random-secret>
        │
        ▼
Electron MCP server → live config/tool surface → local filesystem/process/desktop code
```

[`src/main/mcp/server.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/mcp/server.ts) binds to `127.0.0.1` on an ephemeral port. Before handing a request to the MCP handler it checks the tokenized path, loopback `Host`, browser `Origin` rules, and a body-size cap. The MCP handler is rebuilt from live configuration, so permission changes affect subsequent calls without restarting.

The model-facing tool construction is in [`src/main/mcp/tools.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/mcp/tools.ts), [`src/main/mcp/tools-core.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/mcp/tools-core.ts), [`src/main/mcp/tools-desktop.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/mcp/tools-desktop.ts), and [`src/main/mcp/session-tool.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/mcp/session-tool.ts). The design deliberately compresses many procedures into a small primitive set: usually five Core tools and at most seven, with a separate Desktop surface on Windows. [`src/main/mcp/surfaces.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/mcp/surfaces.ts) explains why separate MCP servers are used as discovery boundaries: tool-list size is paid at connector discovery, and a query cannot reliably bound the worst case.

The Core surface combines:

* virtual-root-bounded reading/search/image viewing;
* preflighted text patching;
* native command execution and interactive process I/O;
* session lookup; and
* worker/agent control.

The Desktop surface is separate and Windows-only: screen observation, window/control inspection, mouse/keyboard actions, and clipboard operations. The platform gating is in [`src/main/platform.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/platform.ts) and the tool mapping in [`src/main/mcp/tools-desktop.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/mcp/tools-desktop.ts).

### Chrome extension bridge

The extension is not the MCP server and does not expose filesystem or command routes. It has its own loopback HTTP bridge:

* [`extension/background.js`](https://github.com/totec448-spec/chat-on-steroids/blob/main/extension/background.js) is the MV3 service worker. It discovers the app by probing fixed loopback ports for `/hello`, pairs through `/pair`, stores the bearer token in extension storage, queues observations/acks, and drains them to the app.
* [`extension/content.js`](https://github.com/totec448-spec/chat-on-steroids/blob/main/extension/content.js) runs on ChatGPT pages. It observes visible messages, turn state, tool rows and errors; relabels tool rows using evidence from the app; renders the overlay; and drives the composer for resumptions, worker bootstraps, and goal-loop messages.
* [`extension/chatgpt-dom.js`](https://github.com/totec448-spec/chat-on-steroids/blob/main/extension/chatgpt-dom.js) isolates selectors and DOM actions from the recorder/control logic.
* [`extension/fiber.js`](https://github.com/totec448-spec/chat-on-steroids/blob/main/extension/fiber.js) runs in the page’s MAIN world and inspects React Fiber props to recover conversation identity and exact assistant message/turn evidence, including the `end_turn` signal.
* [`extension/popup.js`](https://github.com/totec448-spec/chat-on-steroids/blob/main/extension/popup.js) and [`extension/popup.html`](https://github.com/totec448-spec/chat-on-steroids/blob/main/extension/popup.html) expose pairing/status/settings controls.

The manifest grants `storage`, `scripting`, and `alarms`; host permissions cover only `chatgpt.com`, `chat.openai.com`, and fixed loopback ports ([`extension/manifest.json`](https://github.com/totec448-spec/chat-on-steroids/blob/main/extension/manifest.json)). The bridge requires a token for authenticated routes, compares it with `timingSafeEqual`, rate-limits and caps bodies, and rejects normal `http(s)` origins. A missing Origin is allowed because extension fetches do not always carry one; the token is the meaningful authentication boundary. Pairing is local-origin based, so a malicious local process is still part of the threat model.

The extension can observe and reproduce browser UI state, but it cannot by itself call the app’s filesystem/command/settings APIs. A compromised content script could ask the service worker to submit observations or browser commands that the worker already supports, but the token is deliberately kept out of page/content-script scope.

## 2. Session history and Compact & Resume

### Recording model

[`src/main/session/store.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/session/store.ts) uses a per-user-data-directory filesystem store rather than a database:

```text
sessions/<session-id>/events.jsonl       append-only tool/turn/error/activity events
sessions/<session-id>/messages/*.json    replaceable logical message shards
sessions/<session-id>/messages.json      legacy map, lazily overlaid/migrated
sessions/<session-id>/meta.json          atomically rewritten summary/metadata
sessions/<session-id>/assets/<id>        screenshots/binary assets
sessions/<session-id>/handoffs/<id>.json handoff briefs
```

The important implementation choice is separating append-only activity from mutable streamed messages. Streaming a message does not create a new transcript row per snapshot; one logical website/Fiber identity owns one replaceable shard. The recorder in [`src/main/session/recorder.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/session/recorder.ts) accepts page observations and MCP call evidence, while [`src/main/session/correlation.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/session/correlation.ts) preserves request ownership/correlation across restarts.

The normal diagnostics logger is a different channel: [`src/main/logger.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/logger.ts) is intended to stay capped, redacted, and memory-only. Durable session recording is detailed and contains user/assistant text, tool activity, file contents and command output. [`src/main/session/retention.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/session/retention.ts) periodically prunes by configured retention days.

### Compact & Resume transaction

Compact & Resume is implemented as a local identity-preserving rebind, not as “delete old chat and make a summary.” [`src/main/session/continuation.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/session/continuation.ts) describes the transaction:

1. `open`: pin the current prime binding and create a continuation record.
2. `summary`: the current ChatGPT chat is instructed to write a handoff as its final response; [`src/main/session/handoff.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/session/handoff.ts) mints a local UUID and stores the text.
3. `claim`: exactly one replacement chat may claim the continuation.
4. `commit`: the new chat proves it exists and accepts the handoff; the local session binding moves to it.
5. `abort`: any failure leaves the local session attached to the old chat.

The browser side arms a capture, sends the handoff instruction through the normal composer, then waits for the exact terminal assistant message/turn evidence. The relevant control path is in [`extension/content.js`](https://github.com/totec448-spec/chat-on-steroids/blob/main/extension/content.js), while DOM send/settle behavior is in [`extension/chatgpt-dom.js`](https://github.com/totec448-spec/chat-on-steroids/blob/main/extension/chatgpt-dom.js) and terminal evidence is read in [`extension/fiber.js`](https://github.com/totec448-spec/chat-on-steroids/blob/main/extension/fiber.js).

The app queues a browser command through [`src/main/bridge.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/bridge.ts), opens a fresh ChatGPT URL, and asks the extension to type a single bootstrap message formatted by `resumeBootstrapText()` in [`src/main/session/handoff.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/session/handoff.ts). The handoff brief is model context; the durable local session remains the source of truth for history, title, workspace, handoffs and worker ownership.

The design has several good failure controls: one-time claims, durable command leases, explicit commit/abort states, a transfer TTL before freeze, and startup restoration in [`src/main/index.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/index.ts). A worker session is deliberately not auto-compacted; its conversation remains intact and becomes non-revivable at the next stop after the token threshold. This avoids silently splitting worker identity while it is still doing work.

## 3. Worker chats and goal-loop orchestration

### Worker chats

The worker state machine is concentrated in [`src/main/agents.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/agents.ts), with browser delivery and command leasing in [`src/main/bridge.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/bridge.ts). A prime ChatGPT conversation calls `agents.spawn`; the app validates the complete request, proves the caller’s exact conversation identity, ensures it is not itself a worker, confirms no other prime owns the active swarm, and only then creates worker records. This is an all-or-nothing acceptance barrier, not a best-effort loop.

The app gives each worker a durable friendly ID scoped to its prime history. Workers cannot message each other directly; the prime brokers messages. A worker is a reusable ChatGPT conversation, not a disposable task process:

* spawn reserves a worker slot and queues a browser bootstrap;
* the extension opens a new ChatGPT tab, checks target/conversation identity, preserves the user’s draft, types the task, and ACKs the irreversible send;
* a completed worker normally sleeps and frees the active slot while retaining the conversation;
* messaging a sleeping worker claims a slot and wakes the same stored `/c/<conversation>`; if the tab is closed, it reopens the URL and sends an ordinary user message;
* a hard maximum is enforced from configuration, with fresh installs currently defaulting to two workers and a maximum of eight;
* old workers are retained durably and can be marked permanently non-revivable around the context threshold;
* disabling multi-agent mode pauses/parks execution but does not clear ownership; explicit clear is the destructive operation.

The code is careful about duplicate delivery. [`src/main/bridge.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/bridge.ts) persists command phases/leases and uses deadlines; [`extension/background.js`](https://github.com/totec448-spec/chat-on-steroids/blob/main/extension/background.js) journals observations and command acknowledgements; [`extension/content.js`](https://github.com/totec448-spec/chat-on-steroids/blob/main/extension/content.js) ACKs a proven revival immediately after the send to avoid a reload-induced duplicate.

Identity is fail-closed: agent-sensitive MCP operations require an extension observation proving which ChatGPT conversation issued the call. An ordinary Core call can work from an unobserved client, but it cannot spawn or control a swarm when the caller is unidentified. This is one of the strongest design decisions in the repository.

### Goal loop

The optional goal loop is implemented in [`src/main/goal.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/goal.ts), with browser lifecycle/settling logic in [`extension/content.js`](https://github.com/totec448-spec/chat-on-steroids/blob/main/extension/content.js). It is off by default as a feature, although the general multi-agent feature has more permissive fresh-install defaults.

On a genuinely finished ChatGPT turn, the app sends only the user messages and ChatGPT’s final answers to OpenRouter. Tool calls/results and intermediate commentary stay local. The request uses `/chat/completions`, strict JSON-schema response format, `provider.require_parameters`, and the `response-healing` plugin. The app parses and validates the response again, rejects malformed/empty/wrapped `NO_REPLY` and tokenizer/reasoning artifacts, and fails closed rather than typing questionable output.

The goal prompt is intentionally eager: continue when a concrete task/question/checklist item is not clearly complete; stop only when ChatGPT explicitly presents the full request as completed and answered. Goals are durable per chat, transfer through Compact & Resume, and are restored in the UI without automatically reviving stale work. A goal can also generate the opening message for a new chat.

The extension’s finish detector prefers exact Fiber `end_turn` evidence. If unavailable, it requires a conservative settle window: Stop must be gone, the answer/tool rail quiet, no connector call outstanding, and the completed-message action must belong to the exact terminal assistant section. A hand-stopped turn is intentionally left alone. This is a serious attempt to avoid sending “carry on” into a still-running turn, although it remains dependent on ChatGPT’s private UI/React structures.

The unavoidable risk is unattended authority: once enabled, the loop sends follow-up messages without asking on each turn and charges the OpenRouter key on every decision. The source explicitly surfaces that tradeoff.

## 4. Permission model and security findings

### What is actually gated

Configuration validation is in [`src/main/config.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/config.ts); capability names/types are in [`src/shared/capabilities.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/shared/capabilities.ts) and [`src/shared/types.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/shared/types.ts). Stored JSON is revalidated so hand-editing `config.json` cannot trivially introduce an unknown root or arbitrary capability shape.

File operations go through [`src/main/sandbox.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/sandbox.ts). Virtual paths select approved named roots, then the code resolves the deepest real path, checks containment, catches symlink/junction escapes, rejects Windows UNC paths, and handles missing-file policy. This is useful application-level containment.

Writes are separately represented by write capabilities and can be disabled by read-only mode. The read-only kill switch disables effective file writes, command execution, desktop control, and clipboard writes while leaving read-only tools available. Tool construction is live, so revoking a capability takes effect in the main process immediately even if ChatGPT’s connector UI still displays a stale cached schema.

The MCP server has multiple gates: loopback bind, tokenized path, loopback Host/Origin checks, body cap, and the MCP library’s request handling. The extension bridge has a separate token, origin restriction, protocol-version check, body cap, rate limiting, and constant-time bearer comparison ([`src/main/bridge.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/bridge.ts)).

Secrets are stored in an encrypted blob via Electron `safeStorage` in [`src/main/secrets.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/secrets.ts): DPAPI on Windows, Keychain on macOS, and a desktop Secret Service/keyring on Linux. The implementation probes Linux provider behavior and refuses Electron’s insecure `basic_text` fallback. Stored tunnel/API/OpenRouter secrets are not put in `config.json` or sent to the extension page.

### What is defaulted on

This is the most important mismatch between the word “permission” and the effective default posture:

* Fresh installs start the Core capability set fully enabled.
* Read-only mode starts off.
* Session recording starts on.
* Experimental multi-agent mode starts on with two workers, subject to the configured hard maximum.
* Windows starts Desktop capabilities enabled; macOS/Linux do not expose them at runtime.
* Existing installs preserve their explicit stored choices, and migration code is more conservative than new-install defaults.

These defaults are documented in comments and configuration logic in [`src/main/config.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/config.ts), and summarized in [`README.md`](https://github.com/totec448-spec/chat-on-steroids/blob/main/README.md). A fresh user who connects ChatGPT before reviewing Home has effectively granted a model the ability to read approved roots, modify them, execute commands, record detailed history, and—on Windows—control the desktop.

### Command injection and process execution

The good part is mechanical: [`src/main/exec.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/exec.ts) uses Node `spawn` with `shell: false`, passes an executable and argv separately, validates command arguments, uses process groups/tree termination, and does not parse model text as shell syntax. This substantially reduces classic quote/semicolon/command-substitution injection.

The bad part is scope: `shell: false` is not a capability restriction. The model can still choose any executable available to the user, pass arbitrary arguments, read environment-accessible material indirectly, reach outside approved folders, modify credentials/configuration, make network calls, and launch another shell explicitly. [`src/main/mcp/tools-core.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/mcp/tools-core.ts) intentionally exposes this as a terminal primitive. The command starts in an approved folder only; it is not folder-sandboxed.

There are also normal same-user TOCTOU limitations in file containment: path checks and later file use are not a kernel capability boundary. A hostile local process can race paths, symlinks, or files after validation. This is acknowledged in [`SECURITY.md`](https://github.com/totec448-spec/chat-on-steroids/blob/main/SECURITY.md).

### Credential and data handling

Credential storage is better than plaintext config, but session data is intentionally not encrypted. `events.jsonl`, message shards, metadata, handoffs, assets, file contents and command output are readable by anything with access to the user account/data directory. Session recording is on by default and is much more sensitive than the small in-memory Activity log.

The OpenRouter key is kept in `safeStorage` and used by the Electron main process in [`src/main/goal.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/goal.ts). It is sent as a Bearer token to OpenRouter. The goal request includes ChatGPT user messages and final answers, so enabling Goal is an explicit third-party data disclosure even though local tool output is omitted.

Tunnel secrets are bearer credentials. A Cloudflare quick-tunnel URL is described as a random path secret; anyone who obtains the full public URL can attempt the endpoint. OpenAI Secure MCP Tunnel is preferable, but the tunnel client and tunnel service themselves are outside this repository’s security scope.

### Network calls, telemetry, and obfuscation

Observed intentional network destinations/flows are:

* the configured tunnel path from ChatGPT to the local MCP server;
* OpenRouter `/chat/completions` and `/models` from [`src/main/goal.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/goal.ts), only for Goal settings/decisions;
* browser access to ChatGPT’s own sites through the extension; and
* user-selected tunnel tooling, including OpenAI Secure MCP Tunnel or optional Cloudflare/self-hosted tunnel support.

I found no obvious analytics endpoint, update beacon, hidden POST collector, or telemetry SDK in the reviewed application/extension source. The logger is described as local and memory-only for Activity; durable session recording is local. This is a static-source conclusion, not a guarantee about third-party binaries or dependencies.

I found no clear obfuscated JavaScript payload. `fiber.js` is unusual because it intentionally scans React’s private `__reactFiber$...` properties, but the code is readable and its purpose is explicit. The extension’s private-UI scraping and MAIN-world injection are security-sensitive engineering, not evidence of malware by themselves.

Other material risks are operational rather than covert: unsigned/unnotarized release binaries, browser automation against undocumented UI/private Fiber structures, broad fresh-install defaults, and the Linux AppImage’s documented possible `--no-sandbox` fallback. These are called out in [`README.md`](https://github.com/totec448-spec/chat-on-steroids/blob/main/README.md) and [`SECURITY.md`](https://github.com/totec448-spec/chat-on-steroids/blob/main/SECURITY.md).

## 5. Honest security verdict

### Is it malicious?

Not on the evidence reviewed. The source has coherent, internally consistent explanations for its local bridges, session recording, browser automation, OpenRouter calls, and worker orchestration. Security-sensitive operations are generally named, logged, bounded, versioned, and stateful rather than hidden. There is no obvious “phone home with files,” credential scraping, encrypted/encoded payload, or stealth persistence mechanism in the application/extension code inspected.

### Is it safe?

Not in the strong sense. It is a powerful local remote-control agent whose authority is granted to ChatGPT through the user’s connector configuration. The key risks are:

1. fresh installs enable most capabilities before the user reviews them;
2. command execution is arbitrary same-user execution, outside root containment;
3. Windows Desktop is desktop-wide, not project-scoped;
4. session history is detailed but not encrypted;
5. the goal loop can autonomously send messages and spend credits;
6. browser identity and completion detection depend on undocumented ChatGPT DOM/React internals; and
7. public tunnel URLs and unsigned binaries create meaningful deployment/endpoint risks.

The fair label is “careful implementation around an inherently high-risk authority model, with careless defaults and beta-grade operational risk.” Treat it as equivalent to giving a model a user-level terminal and, on Windows, a desktop robot. Use a disposable/least-privileged OS account, a narrowly scoped project root, read-only mode until needed, and inspect the complete connector/tunnel URL before use.

## 6. Five ideas worth stealing for a terminal-first harness

1. **Small primitive tool surface plus separate capability surfaces.** [`src/main/mcp/tools-core.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/mcp/tools-core.ts) turns dozens of special-case tools into a few composable primitives, while [`src/main/mcp/surfaces.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/mcp/surfaces.ts) uses separate servers as real discovery/security boundaries. A terminal-first harness should expose a compact read/search/patch/exec/session set and put high-risk capabilities behind separate connectors.

2. **Durable event history with replaceable streamed-message shards.** [`src/main/session/store.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/session/store.ts) avoids duplicate transcript rows while retaining append-only evidence. This is a strong model for terminal sessions: append immutable command/tool events, but update one logical assistant/user message record as streaming changes.

3. **Transaction semantics for context compaction and rebinding.** [`src/main/session/continuation.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/session/continuation.ts) has explicit open/summary/claim/commit/abort stages, one-time claims, durable fences, and a safe old-chat fallback. A terminal harness can use the same pattern for checkpoint/restore, agent handoff, workspace switching, or reconnecting a lost UI.

4. **Evidence-based completion and exact identity correlation.** [`extension/fiber.js`](https://github.com/totec448-spec/chat-on-steroids/blob/main/extension/fiber.js), [`src/main/session/correlation.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/session/correlation.ts), and [`src/main/bridge.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/bridge.ts) insist on exact conversation/request IDs and conservative terminal evidence instead of timing guesses. A terminal-first harness should similarly correlate every command, stream, process, and agent to an immutable run ID and only declare completion from process/tool evidence.

5. **Durable worker ownership with sleep/wake rather than disposable agents.** [`src/main/agents.ts`](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/agents.ts) treats workers as reusable conversations with scoped IDs, slot leases, restart recovery, parked state, and explicit non-revivable retirement. This is a useful orchestration model for terminal workers, especially when an agent may outlive a process or UI tab.

## What it does worse than a terminal-first harness

The repository is fundamentally browser-first. The browser extension is the control plane for identity, final-turn detection, compaction, worker creation, and message delivery. That makes it fragile against ChatGPT UI redesigns, React/Fiber changes, tab suspension, content virtualization, browser profile differences, extension reloads, and policy/terms changes. A terminal-first harness can use a stable local protocol and process lifecycle instead of typing into a web composer.

It also has a more complicated trust chain: ChatGPT custom app → public tunnel → loopback MCP endpoint, plus Chrome extension → second loopback bridge → page DOM/private Fiber state. A terminal-first design can keep the model protocol and local executor in one authenticated local channel, avoid browser bearer URLs, and make caller identity explicit.

The session model is excellent for preserving a browser conversation, but it duplicates state between ChatGPT’s server-side transcript, extension-observed DOM/Fiber state, local JSONL history, continuation records, and durable swarm state. A terminal-first harness can make its event log and task state canonical, with the model receiving selected projections.

Finally, the design’s permission boundary is honest but permissive: arbitrary same-user commands and optional desktop control are far more authority than most terminal-first harnesses need. The biggest improvement to steal is therefore not another orchestration feature; it is the discipline of keeping the powerful primitive explicit, separately surfaced, auditable, and disabled by default.

