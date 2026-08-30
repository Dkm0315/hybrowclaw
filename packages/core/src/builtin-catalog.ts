import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stat } from "node:fs/promises";
import { loadConfig, saveConfig } from "./config.js";
import type { McpServerConfig } from "./mcp.js";
import { archiveSkill, writeBundledSkill } from "./skills.js";

export type BuiltinCatalogSource = "hermes" | "openclaw" | "muster";
export type BuiltinRisk = "low" | "medium" | "high";
export type BuiltinActionability =
  | "metadata"
  | "setup_plan"
  | "local_tool"
  | "runtime_adapter"
  | "mcp_installable"
  | "end_to_end_workflow";

export interface BuiltinSkillCatalogEntry {
  readonly id: string;
  readonly category: string;
  readonly source: BuiltinCatalogSource;
  readonly description: string;
  readonly risk: BuiltinRisk;
  readonly tags: readonly string[];
  readonly requires?: readonly string[];
}

export interface BuiltinPluginCatalogEntry {
  readonly id: string;
  readonly aliases?: readonly string[];
  readonly category: string;
  readonly source: BuiltinCatalogSource;
  readonly description: string;
  readonly risk: BuiltinRisk;
  readonly actionability: BuiltinActionability;
  readonly slot?: string;
  readonly packPath?: string;
  readonly setup?: BuiltinIntegrationSetup;
}

export interface BuiltinMcpCatalogEntry {
  readonly id: string;
  readonly category: string;
  readonly source: BuiltinCatalogSource;
  readonly description: string;
  readonly risk: BuiltinRisk;
  readonly commandHint: string;
  readonly auth?: "none" | "api_key" | "oauth" | "local";
  readonly requiresEnv?: readonly string[];
  readonly requiresAnyEnv?: readonly (readonly string[])[];
  readonly setupUrls?: readonly string[];
  readonly defaultTools?: readonly string[];
  readonly notes?: readonly string[];
  readonly install?: BuiltinMcpInstallSpec;
}

export interface BuiltinMcpInstallSpec {
  readonly transport:
    | { readonly kind: "http"; readonly url: string; readonly headers?: Record<string, string> }
    | { readonly kind: "stdio"; readonly command: string; readonly args?: readonly string[]; readonly env?: Readonly<Record<string, string>> };
  readonly auth?: "oauth";
  readonly oauth?: McpServerConfig["oauth"];
  readonly tools?: McpServerConfig["tools"];
  readonly limits?: McpServerConfig["limits"];
}

export interface BuiltinIntegrationSetup {
  readonly auth?: "none" | "api_key" | "oauth" | "local" | "env";
  readonly setupCommand?: string;
  readonly channels?: readonly string[];
  readonly mcpServers?: readonly string[];
  readonly defaultMcpServers?: readonly string[];
  readonly requiresEnv?: readonly string[];
  readonly requiresAnyEnv?: readonly (readonly string[])[];
  readonly setupUrls?: readonly string[];
  readonly notes?: readonly string[];
}

export type BuiltinCapabilityMentionKind = "skill" | "plugin" | "mcp";

export interface BuiltinCapabilityMention {
  readonly kind: BuiltinCapabilityMentionKind;
  readonly id: string;
  readonly category: string;
  readonly risk: BuiltinRisk;
  readonly source: BuiltinCatalogSource;
  readonly description: string;
  readonly matched: string;
  readonly confidence: "exact" | "alias" | "keyword";
  readonly actionability?: BuiltinActionability;
}

const HERMES_SKILLS: readonly BuiltinSkillCatalogEntry[] = [
  skill("plan", "software-development", "hermes", "Plan mode: inspect context, write an implementation plan, do not execute.", "low", ["planning"]),
  skill("systematic-debugging", "software-development", "hermes", "Debug in phases: reproduce, isolate, explain root cause, then patch.", "low", ["debugging", "quality"]),
  skill("test-driven-development", "software-development", "hermes", "Use red-green-refactor when risk warrants tests before implementation.", "low", ["testing"]),
  skill("requesting-code-review", "software-development", "hermes", "Pre-commit review of local changes for bugs, security, and missing tests.", "low", ["review", "security"]),
  skill("simplify-code", "software-development", "hermes", "Reduce recent code complexity while preserving behavior and tests.", "low", ["refactor"]),
  skill("spike", "software-development", "hermes", "Run a small throwaway experiment before committing to a design.", "low", ["prototype"]),
  skill("node-inspect-debugger", "software-development", "hermes", "Debug Node.js with inspector-oriented steps and reproducible evidence.", "medium", ["debugging", "node"], ["node"]),
  skill("python-debugpy", "software-development", "hermes", "Debug Python with pdb/debugpy style workflows and narrow repros.", "medium", ["debugging", "python"], ["python"]),
  skill("github-code-review", "github", "hermes", "Review pull requests or local diffs and prepare actionable findings.", "medium", ["github", "review"], ["git"]),
  skill("github-pr-workflow", "github", "hermes", "Create branches, commits, pull requests, and track CI in a disciplined workflow.", "medium", ["github", "git"], ["git"]),
  skill("github-issues", "github", "hermes", "Create, triage, label, and update GitHub issues from terminal context.", "medium", ["github", "issues"], ["gh"]),
  skill("github-auth", "github", "hermes", "Guide GitHub HTTPS token, SSH, and gh CLI authentication setup.", "medium", ["github", "auth"], ["git"]),
  skill("codebase-inspection", "github", "hermes", "Inspect repository size, languages, ownership, and hotspots before edits.", "low", ["inspection", "codebase"]),
  skill("github-repo-management", "github", "hermes", "Create, configure, archive, and maintain GitHub repositories with token and permission checks.", "medium", ["github", "repo-management"], ["gh"]),
  skill("claude-code", "autonomous-ai-agents", "hermes", "Delegate a bounded coding task to Claude Code when configured.", "medium", ["delegate", "claude"], ["claude"]),
  skill("codex", "autonomous-ai-agents", "hermes", "Delegate a bounded coding task to Codex when configured.", "medium", ["delegate", "codex"], ["codex"]),
  skill("hermes-agent", "autonomous-ai-agents", "hermes", "Inspect Hermes agent projects, sessions, skills, and toolsets when migrating or comparing behavior.", "medium", ["hermes", "migration"]),
  skill("codex-native-tools", "autonomous-ai-agents", "muster", "Use Codex-native shell, patch, image, approval, and project-doc workflows through Muster routing.", "medium", ["codex", "tools"], ["codex"]),
  skill("codex-fast-qa", "autonomous-ai-agents", "muster", "Route lightweight questions through low-latency Codex settings before escalating to long-running agent sessions.", "low", ["codex", "latency"], ["codex"]),
  skill("codex-full-context", "software-development", "muster", "Use Codex full-context or repository-wide edit modes only when the task warrants broad context.", "medium", ["codex", "codebase"], ["codex"]),
  skill("opencode", "autonomous-ai-agents", "hermes", "Delegate a bounded coding task to OpenCode when configured.", "medium", ["delegate"], ["opencode"]),
  skill("architecture-diagram", "creative", "hermes", "Design clear architecture diagrams with labeled components and flows.", "low", ["diagram"]),
  skill("ascii-art", "creative", "hermes", "Create terminal-friendly ASCII art and banners with explicit sizing.", "low", ["ascii", "creative"]),
  skill("ascii-video", "creative", "hermes", "Plan terminal-friendly ASCII video sequences with explicit frame sizing and render steps.", "medium", ["ascii", "video"]),
  skill("baoyu-infographic", "creative", "hermes", "Turn dense ideas into structured infographic layouts with sections, hierarchy, and export notes.", "low", ["infographic", "design"]),
  skill("claude-design", "creative", "hermes", "Use Claude-style design workflows for interface critique, mockups, and visual iteration.", "low", ["design", "critique"]),
  skill("design-md", "creative", "hermes", "Maintain DESIGN.md style product design notes for visual direction and implementation handoff.", "low", ["design", "docs"]),
  skill("excalidraw", "creative", "hermes", "Draft hand-drawn style diagram JSON for architecture and workflows.", "low", ["diagram"]),
  skill("humanizer", "creative", "hermes", "Rewrite text to remove AI stiffness and preserve a human voice.", "low", ["writing"]),
  skill("manim-video", "creative", "hermes", "Plan math or architecture explainer videos with Manim scenes and render verification.", "medium", ["video", "manim"], ["python"]),
  skill("p5js", "creative", "hermes", "Build interactive sketches and generative visuals with p5.js-style iteration.", "medium", ["creative-coding", "p5js"]),
  skill("popular-web-designs", "creative", "hermes", "Use real product design-system references for web UI direction.", "low", ["design", "frontend"]),
  skill("pretext", "creative", "hermes", "Prototype creative demos with clear prompts, assets, and evaluation notes.", "medium", ["creative", "prototype"]),
  skill("sketch", "creative", "hermes", "Create lightweight visual sketches and critique them before implementation.", "low", ["sketch", "design"]),
  skill("songwriting-and-ai-music", "creative", "hermes", "Plan lyrics, structure, prompts, and tool choices for AI-assisted music workflows.", "medium", ["music", "creative"]),
  skill("touchdesigner-mcp", "creative", "hermes", "Guide TouchDesigner MCP setup and visual patch workflows with explicit environment checks.", "high", ["touchdesigner", "mcp"]),
  skill("computer-use", "computer-use", "hermes", "Operate GUI applications through a visible, approval-aware computer-use workflow.", "high", ["computer-use", "desktop"]),
  skill("jupyter-live-kernel", "data-science", "hermes", "Use an iterative Jupyter-style workflow for data analysis.", "medium", ["data", "python"], ["python"]),
  skill("dogfood", "quality", "hermes", "Run systematic product dogfooding with reproducible web-app QA notes and follow-up issues.", "medium", ["qa", "dogfood"]),
  skill("himalaya", "email", "hermes", "Operate email through a local CLI with search, draft, and send guardrails.", "high", ["email"], ["himalaya"]),
  skill("youtube-content", "media", "hermes", "Turn YouTube transcripts into summaries, threads, and notes.", "medium", ["media", "summary"]),
  skill("gif-search", "media", "hermes", "Search and download GIFs with terminal tools.", "medium", ["media"]),
  skill("heartmula", "media", "hermes", "Plan open-source music generation workflows with model, prompt, and artifact checks.", "medium", ["music", "generation"]),
  skill("songsee", "media", "hermes", "Analyze or generate song-related metadata, summaries, and listening notes with source hygiene.", "medium", ["music", "metadata"]),
  skill("huggingface-hub", "mlops", "hermes", "Search, download, and upload Hugging Face models or datasets.", "medium", ["mlops", "huggingface"], ["hf"]),
  skill("llama-cpp", "mlops", "hermes", "Run and inspect local GGUF inference through llama.cpp.", "medium", ["local-models"], ["llama-cli"]),
  skill("lm-evaluation-harness", "mlops", "hermes", "Evaluate models with benchmark harness workflows and result hygiene.", "medium", ["evals"]),
  skill("audiocraft", "mlops", "hermes", "Set up and evaluate AudioCraft-style audio generation experiments with artifact tracking.", "medium", ["audio", "mlops"]),
  skill("segment-anything", "mlops", "hermes", "Use Segment Anything style image segmentation workflows with dataset and mask QA.", "medium", ["vision", "segmentation"]),
  skill("vllm", "mlops", "hermes", "Serve LLMs through vLLM and OpenAI-compatible endpoints.", "medium", ["serving"], ["vllm"]),
  skill("weights-and-biases", "mlops", "hermes", "Track ML experiments, sweeps, and model registry workflows.", "medium", ["mlops"], ["wandb"]),
  skill("obsidian", "note-taking", "hermes", "Read, search, create, and edit notes in an Obsidian vault.", "medium", ["notes"]),
  skill("airtable", "productivity", "hermes", "Work with Airtable records, filters, and upserts through API-safe steps.", "high", ["productivity", "database"]),
  skill("apple-notes", "productivity", "hermes", "Work with Apple Notes on macOS after checking local permissions and avoiding broad note dumps.", "high", ["apple", "notes"]),
  skill("apple-reminders", "productivity", "hermes", "Create, inspect, and update Apple Reminders with explicit confirmation for changes.", "high", ["apple", "reminders"]),
  skill("findmy", "productivity", "hermes", "Guide Find My style location checks with privacy-first confirmation and visible scope.", "high", ["apple", "location"]),
  skill("google-workspace", "productivity", "hermes", "Handle Gmail, Calendar, Drive, Docs, and Sheets workflows with auth checks.", "high", ["google", "productivity"]),
  skill("imessage", "productivity", "hermes", "Draft or inspect iMessage workflows on macOS with strong consent and no silent sends.", "high", ["apple", "messages"]),
  skill("maps", "productivity", "hermes", "Geocode, route, and inspect locations with open map services.", "medium", ["maps"]),
  skill("nano-pdf", "productivity", "hermes", "Perform compact PDF inspection, extraction, and transformation workflows with verification.", "medium", ["pdf", "documents"]),
  skill("notion", "productivity", "hermes", "Create and update Notion pages or databases with schema awareness.", "high", ["notion"]),
  skill("ocr-and-documents", "productivity", "hermes", "Extract text from PDFs and scanned documents with OCR workflows.", "medium", ["ocr", "documents"]),
  skill("petdex", "productivity", "hermes", "Organize pet-related records, care notes, reminders, and media with privacy-aware storage.", "medium", ["personal", "records"]),
  skill("powerpoint", "productivity", "hermes", "Create, read, and edit PowerPoint decks with templates and notes.", "medium", ["slides"]),
  skill("teams-meeting-pipeline", "productivity", "hermes", "Prepare, summarize, and follow up on Teams meetings with transcript and task hygiene.", "high", ["teams", "meetings"]),
  skill("arxiv", "research", "hermes", "Search arXiv papers and produce cited research notes.", "medium", ["research"]),
  skill("blogwatcher", "research", "hermes", "Monitor RSS/Atom feeds and summarize changes.", "medium", ["research", "monitoring"]),
  skill("llm-wiki", "research", "hermes", "Build and query a linked markdown knowledge base.", "low", ["knowledge-base"]),
  skill("polymarket", "research", "hermes", "Query prediction-market data with caveats and source links.", "medium", ["research", "markets"]),
  skill("research-paper-writing", "research", "hermes", "Plan and draft ML research papers from experiment to submission.", "low", ["writing", "research"]),
  skill("openhue", "smart-home", "hermes", "Guide OpenHue smart-light workflows with local-network and confirmation safeguards.", "high", ["smart-home", "iot"]),
  skill("xurl", "social-media", "hermes", "Use X/Twitter API style posting and lookup workflows with credential and publish safeguards.", "high", ["social-media", "x"]),
  skill("yuanbao", "autonomous-ai-agents", "hermes", "Guide Yuanbao group interaction workflows with explicit session and permission boundaries.", "high", ["yuanbao", "agents"]),
  skill("browser-control", "web", "openclaw", "Operate browser tasks with explicit user-visible steps and screenshots.", "high", ["browser", "automation"]),
  skill("database-query", "data", "openclaw", "Translate natural language to SQL only after schema inspection and approval.", "high", ["database", "sql"]),
  skill("screenshot-ocr", "productivity", "openclaw", "Capture screenshots and extract visible text for debugging/documentation.", "medium", ["ocr", "screenshot"]),
  skill("workflow-automation", "automation", "openclaw", "Design multi-step automations with triggers, approvals, and rollback notes.", "high", ["automation"]),
  skill("frontend-design", "creative", "openclaw", "Design production UI with accessible components and visual QA.", "low", ["frontend", "design"]),
  skill("deep-research", "research", "openclaw", "Run multi-source research with citations, disagreement tracking, and recency checks.", "medium", ["research"]),
  skill("api-contract-testing", "software-development", "muster", "Exercise HTTP APIs with fixtures, latency budgets, and schema expectations.", "medium", ["api", "testing"]),
  skill("docker-ops", "software-development", "muster", "Inspect containers, logs, networks, and compose stacks with bounded commands.", "medium", ["docker", "ops"], ["docker"]),
  skill("database-migrations", "data", "muster", "Review migration plans, rollback paths, and query impact before database writes.", "high", ["database", "migration"]),
  skill("secret-and-config-audit", "security", "muster", "Scan changed files and runtime config for accidental secrets or unsafe defaults.", "medium", ["security", "config"]),
  skill("release-notes", "productivity", "muster", "Turn commits, issues, and shipped behavior into concise release notes.", "low", ["release", "writing"]),
  skill("daily-brief", "productivity", "muster", "Summarize recent sessions, tasks, calendar-like notes, and open follow-ups.", "low", ["daily", "summary"]),
  skill("spreadsheet-analysis", "artifacts", "muster", "Read, validate, summarize, and transform spreadsheets with explicit assumptions.", "medium", ["spreadsheet", "analysis"]),
  skill("dashboard-reporting", "artifacts", "muster", "Create compact source-backed reports and dashboards from bounded datasets.", "medium", ["dashboard", "report"]),
  skill("presentation-builder", "artifacts", "muster", "Draft slide outlines, speaker notes, and editable presentation assets.", "medium", ["slides", "presentation"]),
  skill("pdf-workflows", "artifacts", "muster", "Read, extract, summarize, split, and create PDFs with verification steps.", "medium", ["pdf", "documents"]),
  skill("image-generation", "artifacts", "muster", "Generate or edit visual assets from clear prompts and visual QA.", "medium", ["image", "media"]),
];

const HERMES_OPTIONAL_SKILLS: readonly BuiltinSkillCatalogEntry[] = [
  skill("subagent-driven-development", "software-development", "hermes", "Split independent implementation work across bounded subagents, then reconcile with one reviewer.", "medium", ["subagents", "orchestration"]),
  skill("rest-graphql-debug", "software-development", "hermes", "Debug REST and GraphQL APIs with schema, auth, fixture, and latency checks.", "medium", ["api", "debugging"]),
  skill("code-wiki", "software-development", "hermes", "Build a compact repository wiki from source structure, ownership, and hotspots.", "low", ["codebase", "docs"]),
  skill("adversarial-ux-test", "quality", "hermes", "Break CLI and web flows with nitpicky, user-like interaction tests.", "medium", ["qa", "ux"]),
  skill("docker-management", "devops", "hermes", "Inspect Docker containers, images, compose stacks, volumes, and logs with bounded risk.", "medium", ["docker", "ops"], ["docker"]),
  skill("pinggy-tunnel", "devops", "hermes", "Expose local services through Pinggy-style tunnels with explicit scope and teardown.", "high", ["tunnel", "devops"]),
  skill("watchers", "devops", "hermes", "Design file/process watchers with restart, log, and runaway-process guardrails.", "medium", ["watchers"]),
  skill("fastmcp", "mcp", "hermes", "Create and test FastMCP servers with schema hygiene and safe tool boundaries.", "medium", ["mcp", "tools"]),
  skill("mcporter", "mcp", "hermes", "Port existing scripts or APIs into MCP tools with auth and result-size checks.", "medium", ["mcp", "migration"]),
  skill("openclaw-migration", "migration", "hermes", "Inspect OpenClaw installations and map skills, tools, memory, and providers into Muster.", "medium", ["migration", "openclaw"]),
  skill("duckduckgo-search", "research", "hermes", "Use low-friction web search with citations and source disagreement notes.", "medium", ["search", "research"]),
  skill("searxng-search", "research", "hermes", "Use a configured SearXNG instance for privacy-oriented metasearch.", "medium", ["search", "searxng"]),
  skill("parallel-cli", "research", "hermes", "Use Parallel search workflows for fast cited research and extraction.", "medium", ["search", "parallel"]),
  skill("domain-intel", "research", "hermes", "Research domains, DNS, ownership, reputation, and public web footprint with caveats.", "medium", ["osint", "domains"]),
  skill("osint-investigation", "research", "hermes", "Run OSINT-style investigations with consent, provenance, and safety boundaries.", "high", ["osint", "research"]),
  skill("bioinformatics", "research", "hermes", "Plan bioinformatics searches, datasets, and analysis notebooks with provenance.", "medium", ["bioinformatics", "research"]),
  skill("cloudflare-temporary-deploy", "web-development", "hermes", "Create temporary Cloudflare deployments with expiry, secrets, and teardown notes.", "medium", ["deploy", "cloudflare"]),
  skill("page-agent", "web-development", "hermes", "Use a page-focused QA and editing workflow for web apps with browser evidence.", "medium", ["frontend", "browser"]),
  skill("blender-mcp", "creative", "hermes", "Guide Blender MCP setup and asset workflows without assuming the server is already installed.", "high", ["blender", "mcp"]),
  skill("creative-ideation", "creative", "hermes", "Generate and critique multiple creative directions before implementation.", "low", ["ideation"]),
  skill("meme-generation", "creative", "hermes", "Create meme concepts and image prompts with source/style constraints.", "medium", ["media", "creative"]),
  skill("pixel-art", "creative", "hermes", "Design pixel-art assets with palette, sprite sheet, and export constraints.", "low", ["pixel-art"]),
  skill("agentmail", "email", "hermes", "Use agent-owned email inboxes for signups, confirmations, and workflow messages.", "high", ["email", "agents"]),
  skill("telephony", "productivity", "hermes", "Plan voice/SMS telephony workflows with consent, audit logs, and credential checks.", "high", ["telephony"]),
  skill("shopify", "productivity", "hermes", "Inspect and operate Shopify store data through safe API setup and mutation review.", "high", ["commerce", "shopify"]),
  skill("1password", "security", "hermes", "Use 1Password CLI workflows without leaking secrets into prompts or logs.", "high", ["secrets", "security"]),
  skill("oss-forensics", "security", "hermes", "Inspect open-source packages for provenance, suspicious code, and supply-chain risk.", "high", ["security", "supply-chain"]),
  skill("web-pentest", "security", "hermes", "Run scoped web security checks only with explicit authorization and evidence.", "high", ["security", "web"]),
  skill("finance-modeling", "finance", "hermes", "Build finance models such as DCF, comps, LBO, and three-statement summaries.", "medium", ["finance", "spreadsheets"]),
  skill("stocks", "finance", "hermes", "Research public equities with source links, dates, and non-advice caveats.", "medium", ["finance", "markets"]),
];

const HERMES_PLUGIN_CATALOG_EXPANSION: readonly BuiltinPluginCatalogEntry[] = [
  plugin("browserbase", "browser", "hermes", "Browserbase remote browser provider setup for authenticated, screenshot-backed web automation.", "high", "browser-provider", undefined, undefined, setup({ setupUrls: ["https://www.browserbase.com/", "https://docs.browserbase.com/integrations/mcp/introduction"], requiresEnv: ["BROWSERBASE_API_KEY"], notes: ["Hermes ships this as a browser provider plugin. Muster records the setup surface now; execution should route through browser/Playwright MCP once configured."] })),
  plugin("browser-use", "browser", "hermes", "Browser Use provider setup for higher-level web automation experiments.", "high", "browser-provider", undefined, ["browser_use"], setup({ setupUrls: ["https://github.com/browser-use/browser-use"], notes: ["Keep this opt-in: it expands browser autonomy and should be backed by screenshots or accessibility snapshots."] })),
  plugin("firecrawl-browser", "browser", "hermes", "Firecrawl-backed browser/extraction provider setup for crawl-heavy web tasks.", "high", "browser-provider", undefined, undefined, setup({ setupUrls: ["https://www.firecrawl.dev/app/api-keys"], requiresEnv: ["FIRECRAWL_API_KEY"], notes: ["Use the Firecrawl MCP or web-search pack for execution; this catalog entry keeps the Hermes provider discoverable."] })),
  plugin("exa-search", "web", "hermes", "Exa web search provider setup for semantic research and retrieval.", "medium", "search-provider", undefined, ["exa"], setup({ setupUrls: ["https://dashboard.exa.ai/api-keys"], requiresEnv: ["EXA_API_KEY"], notes: ["Catalog only until an Exa MCP/tool adapter is installed."] })),
  plugin("tavily-search", "web", "hermes", "Tavily search provider setup for answer-oriented web retrieval.", "medium", "search-provider", undefined, ["tavily"], setup({ setupUrls: ["https://app.tavily.com/"], requiresEnv: ["TAVILY_API_KEY"], notes: ["Catalog only until a Tavily MCP/tool adapter is installed."] })),
  plugin("searxng-search", "web", "hermes", "SearXNG provider setup for self-hosted metasearch.", "medium", "search-provider", undefined, ["searxng"], setup({ requiresEnv: ["SEARXNG_URL"], setupUrls: ["https://docs.searxng.org/"], notes: ["Prefer this for privacy-sensitive research when the user already runs SearXNG."] })),
  plugin("brave-search", "web", "hermes", "Brave Search provider setup for web result retrieval.", "medium", "search-provider", undefined, ["brave"], setup({ requiresEnv: ["BRAVE_API_KEY"], setupUrls: ["https://api-dashboard.search.brave.com/"], notes: ["Use as an optional provider behind the web-search surface."] })),
  plugin("memory-hindsight", "memory", "hermes", "Hindsight memory provider setup for external long-term memory experiments.", "high", "memory-provider", undefined, ["hindsight"], setup({ setupUrls: ["https://github.com/NousResearch/hermes-agent/tree/main/plugins/memory/hindsight"], notes: ["Muster's default stays SQLite/FTS; external memory providers are opt-in and must not bypass scope isolation."] })),
  plugin("memory-mem0", "memory", "hermes", "mem0 memory provider setup for external memory experiments.", "high", "memory-provider", undefined, ["mem0"], setup({ setupUrls: ["https://mem0.ai/"], requiresAnyEnv: [["MEM0_API_KEY"]], notes: ["External memory must be treated as a sync target, not a replacement for scoped local retrieval."] })),
  plugin("memory-supermemory", "memory", "hermes", "Supermemory provider setup for external personal memory experiments.", "high", "memory-provider", undefined, ["supermemory"], setup({ setupUrls: ["https://supermemory.ai/"], requiresAnyEnv: [["SUPERMEMORY_API_KEY"]], notes: ["Use explicit export/import and user-visible scope controls before syncing private memories."] })),
  plugin("memory-honcho", "memory", "hermes", "Honcho memory/persona provider setup.", "high", "memory-provider", undefined, ["honcho"], setup({ setupUrls: ["https://honcho.dev/"], requiresAnyEnv: [["HONCHO_API_KEY"]], notes: ["Keep personalization bounded to selected profiles and named sessions; treat Honcho as an external sync target while local scoped SQLite/FTS memory remains authoritative."] })),
  plugin("langfuse", "observability", "hermes", "Langfuse tracing setup for agent runs, tool calls, latency, and token usage.", "medium", "observability", undefined, undefined, setup({ setupUrls: ["https://langfuse.com/docs"], requiresAnyEnv: [["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"]], notes: ["Useful for finding Muster overhead: record timings without sending secrets or raw private prompts by default."] })),
  plugin("nemo-relay", "observability", "hermes", "NVIDIA NeMo relay/observability setup for model and agent telemetry experiments.", "medium", "observability", undefined, ["nemo_relay"], setup({ setupUrls: ["https://docs.nvidia.com/nemo/"], notes: ["Setup-plan only until a concrete relay adapter is configured."] })),
  plugin("fal-image", "image-generation", "hermes", "fal.ai image-generation provider setup.", "medium", "image-provider", undefined, ["fal"], setup({ setupUrls: ["https://fal.ai/dashboard/keys"], requiresEnv: ["FAL_KEY"], notes: ["Use through artifact/image workflows once credentials and provider policy are configured."] })),
  plugin("openai-image", "image-generation", "hermes", "OpenAI image-generation provider setup.", "medium", "image-provider", undefined, undefined, setup({ setupUrls: ["https://platform.openai.com/api-keys"], requiresEnv: ["OPENAI_API_KEY"], notes: ["Separate from the chat provider so users can pick cheaper or dedicated image models."] })),
  plugin("xai-image", "image-generation", "hermes", "xAI image-generation provider setup.", "medium", "image-provider", undefined, undefined, setup({ setupUrls: ["https://console.x.ai/"], requiresEnv: ["XAI_API_KEY"], notes: ["Catalog only until the provider adapter is explicitly configured."] })),
  plugin("krea-image", "image-generation", "hermes", "Krea image-generation provider setup.", "medium", "image-provider", undefined, undefined, setup({ setupUrls: ["https://www.krea.ai/"], notes: ["Setup-plan only; do not imply local execution."] })),
  plugin("fal-video", "video-generation", "hermes", "fal.ai video-generation provider setup.", "medium", "video-provider", undefined, undefined, setup({ setupUrls: ["https://fal.ai/dashboard/keys"], requiresEnv: ["FAL_KEY"], notes: ["Video jobs should be artifact-tracked with cost and duration shown before submission."] })),
  plugin("xai-video", "video-generation", "hermes", "xAI video-generation provider setup.", "medium", "video-provider", undefined, undefined, setup({ setupUrls: ["https://console.x.ai/"], requiresEnv: ["XAI_API_KEY"], notes: ["Setup-plan only until a concrete video provider adapter is wired."] })),
  plugin("google-meet", "productivity", "hermes", "Google Meet realtime/node plugin setup for meeting capture and follow-up workflows.", "high", "meeting", undefined, undefined, setup({ setupUrls: ["https://developers.google.com/workspace/meet"], requiresAnyEnv: [["GOOGLE_WORKSPACE_ACCESS_TOKEN", "GOOGLE_ACCESS_TOKEN"]], notes: ["Treat meeting audio/transcripts as high-risk private data; require explicit room/session scope."] })),
  plugin("spotify", "media", "hermes", "Spotify provider setup for playlist, library, and listening-context workflows.", "high", "media", undefined, undefined, setup({ setupUrls: ["https://developer.spotify.com/dashboard"], notes: ["OAuth-backed setup-plan only until a connector or MCP adapter is installed."] })),
  plugin("homeassistant", "smart-home", "hermes", "Home Assistant platform adapter setup for local smart-home workflows.", "high", "channel-homeassistant", undefined, undefined, setup({ channels: ["homeassistant"], setupUrls: ["https://developers.home-assistant.io/docs/api/rest/"], requiresAnyEnv: [["HOMEASSISTANT_URL", "HOME_ASSISTANT_URL"]], notes: ["Setup-plan only until a smart-home runtime adapter is implemented; actions are real-world mutations and must stay approval-gated."] }), "setup_plan"),
  plugin("matrix", "channel", "hermes", "Matrix channel adapter setup for rooms and encrypted chat workflows.", "high", "channel-matrix", undefined, undefined, setup({ channels: ["matrix"], setupUrls: ["https://matrix.org/docs/"], notes: ["Setup-plan only until a channel runtime adapter is implemented."] }), "setup_plan"),
  plugin("mattermost", "channel", "hermes", "Mattermost channel adapter setup for team chat workflows.", "high", "channel-mattermost", undefined, undefined, setup({ channels: ["mattermost"], setupUrls: ["https://developers.mattermost.com/"], notes: ["Setup-plan only until a channel runtime adapter is implemented."] }), "setup_plan"),
  plugin("line", "channel", "hermes", "LINE Messaging API channel setup.", "high", "channel-line", undefined, undefined, setup({ channels: ["line"], setupUrls: ["https://developers.line.biz/en/docs/messaging-api/"], notes: ["Setup-plan only until a channel runtime adapter is implemented."] }), "setup_plan"),
  plugin("ntfy", "channel", "hermes", "ntfy notification channel setup.", "medium", "channel-ntfy", undefined, undefined, setup({ channels: ["ntfy"], setupUrls: ["https://docs.ntfy.sh/"], notes: ["Setup-plan only until a notification runtime adapter is implemented; sending still needs visible policy."] }), "setup_plan"),
  plugin("sms", "channel", "hermes", "SMS channel setup for phone-number-backed assistant workflows.", "high", "channel-sms", undefined, undefined, setup({ channels: ["sms"], setupUrls: ["https://www.twilio.com/docs/sms"], notes: ["Setup-plan only until an SMS runtime adapter is implemented; require explicit consent, opt-out, and audit logging before any send path."] }), "setup_plan"),
  plugin("provider-gemini", "provider", "hermes", "Gemini model provider setup and picker entry.", "medium", "provider", undefined, ["gemini"], setup({ setupUrls: ["https://aistudio.google.com/apikey"], requiresAnyEnv: [["GEMINI_API_KEY", "GOOGLE_API_KEY"]], notes: ["Expose through the provider/model picker instead of requiring users to memorize model ids."] })),
  plugin("provider-openrouter", "provider", "hermes", "OpenRouter model provider setup and picker entry.", "medium", "provider", undefined, ["openrouter"], setup({ setupUrls: ["https://openrouter.ai/settings/keys"], requiresEnv: ["OPENROUTER_API_KEY"], notes: ["Useful for fast model switching and fallback chains."] })),
  plugin("provider-deepseek", "provider", "hermes", "DeepSeek model provider setup and picker entry.", "medium", "provider", undefined, ["deepseek"], setup({ setupUrls: ["https://platform.deepseek.com/api_keys"], requiresEnv: ["DEEPSEEK_API_KEY"], notes: ["Expose through provider/model picker with explicit latency/cost hints."] })),
  plugin("provider-groq", "provider", "muster", "Groq fast-inference provider setup and picker entry.", "medium", "provider", undefined, ["groq"], setup({ setupUrls: ["https://console.groq.com/keys"], requiresEnv: ["GROQ_API_KEY"], notes: ["Good candidate for fast lightweight prompts when Codex is unnecessary."] })),
  plugin("provider-bedrock", "provider", "hermes", "AWS Bedrock provider setup and picker entry.", "high", "provider", undefined, ["bedrock"], setup({ setupUrls: ["https://docs.aws.amazon.com/bedrock/latest/userguide/api-setup.html"], requiresAnyEnv: [["AWS_ACCESS_KEY_ID", "AWS_PROFILE"]], notes: ["Enterprise setup path; keep region, model access, and IAM scope visible."] })),
  plugin("provider-kimi", "provider", "hermes", "Kimi coding/model provider setup and picker entry.", "medium", "provider", undefined, ["kimi"], setup({ setupUrls: ["https://platform.moonshot.ai/console/api-keys"], requiresEnv: ["KIMI_API_KEY"], notes: ["Setup-plan only until provider adapter/preset is selected."] })),
  plugin("provider-qwen-oauth", "provider", "hermes", "Qwen OAuth provider setup and picker entry.", "medium", "provider", undefined, ["qwen-oauth"], setup({ setupUrls: ["https://chat.qwen.ai/"], notes: ["OAuth-oriented setup-plan; no API key should be guessed or persisted silently."] })),
];

const OPENCLAW_PLUGIN_CATALOG_EXPANSION: readonly BuiltinPluginCatalogEntry[] = [
  plugin("provider-perplexity", "provider", "openclaw", "Perplexity provider setup for search-grounded model workflows.", "medium", "provider", undefined, ["perplexity"], setup({ setupUrls: ["https://www.perplexity.ai/settings/api"], requiresEnv: ["PERPLEXITY_API_KEY"], notes: ["Use for answer/research routes only when citations and recency matter; keep model switching visible in the picker."] })),
  plugin("provider-mistral", "provider", "openclaw", "Mistral provider setup and picker entry.", "medium", "provider", undefined, ["mistral"], setup({ setupUrls: ["https://console.mistral.ai/api-keys"], requiresEnv: ["MISTRAL_API_KEY"], notes: ["Catalog entry only until a concrete provider preset is selected."] })),
  plugin("provider-cohere", "provider", "openclaw", "Cohere provider setup for chat, rerank, and embedding-oriented workflows.", "medium", "provider", undefined, ["cohere"], setup({ setupUrls: ["https://dashboard.cohere.com/api-keys"], requiresEnv: ["COHERE_API_KEY"], notes: ["Good future fit for retrieval rerank; do not bypass Muster's scoped memory ledger."] })),
  plugin("provider-together", "provider", "openclaw", "Together AI provider setup for hosted open-model inference.", "medium", "provider", undefined, ["together"], setup({ setupUrls: ["https://api.together.ai/settings/api-keys"], requiresEnv: ["TOGETHER_API_KEY"], notes: ["Expose latency and cost hints before switching lightweight prompts to this provider."] })),
  plugin("provider-nvidia", "provider", "openclaw", "NVIDIA NIM/provider setup for enterprise and accelerated inference.", "medium", "provider", undefined, ["nvidia"], setup({ setupUrls: ["https://build.nvidia.com/"], requiresAnyEnv: [["NVIDIA_API_KEY", "NIM_API_KEY"]], notes: ["Setup-plan only until endpoint/model policy is configured."] })),
  plugin("provider-huggingface", "provider", "hermes", "Hugging Face inference provider setup for hosted model endpoints.", "medium", "provider", undefined, ["huggingface-provider"], setup({ setupUrls: ["https://huggingface.co/settings/tokens"], requiresAnyEnv: [["HF_TOKEN", "HUGGINGFACE_TOKEN"]], notes: ["Separate from the Hugging Face Hub workflow pack; this is model-provider setup."] })),
  plugin("provider-xai", "provider", "hermes", "xAI provider setup and picker entry.", "medium", "provider", undefined, ["xai"], setup({ setupUrls: ["https://console.x.ai/"], requiresEnv: ["XAI_API_KEY"], notes: ["Keep image/video providers separate from chat-provider setup."] })),
  plugin("provider-nous", "provider", "hermes", "Nous Research provider setup and picker entry.", "medium", "provider", undefined, ["nous"], setup({ setupUrls: ["https://portal.nousresearch.com/"], notes: ["Hermes ships a Nous provider plugin; Muster records setup without assuming account state."] })),
  plugin("provider-azure-foundry", "provider", "hermes", "Azure AI Foundry provider setup for enterprise model routing.", "high", "provider", undefined, ["azure-foundry", "microsoft-foundry"], setup({ setupUrls: ["https://ai.azure.com/", "https://learn.microsoft.com/azure/ai-foundry/"], requiresAnyEnv: [["AZURE_OPENAI_API_KEY", "AZURE_AI_API_KEY"]], notes: ["Require endpoint, deployment name, region, and tenant scope before activation."] })),
  plugin("provider-copilot", "provider", "hermes", "GitHub Copilot provider/runtime setup for subscription-backed coding models.", "medium", "provider", undefined, ["copilot", "github-copilot"], setup({ setupUrls: ["https://docs.github.com/copilot"], notes: ["Subscription/OAuth setup path; do not infer availability from a GitHub token alone."] })),
  plugin("provider-arcee", "provider", "hermes", "Arcee provider setup and picker entry.", "medium", "provider", undefined, ["arcee"], setup({ setupUrls: ["https://www.arcee.ai/"], requiresEnv: ["ARCEE_API_KEY"], notes: ["Setup-plan only until provider preset is configured."] })),
  plugin("provider-novita", "provider", "hermes", "Novita AI provider setup and picker entry.", "medium", "provider", undefined, ["novita"], setup({ setupUrls: ["https://novita.ai/settings/key-management"], requiresEnv: ["NOVITA_API_KEY"], notes: ["Setup-plan only until provider preset is configured."] })),
  plugin("provider-minimax", "provider", "hermes", "MiniMax provider setup and picker entry.", "medium", "provider", undefined, ["minimax"], setup({ setupUrls: ["https://platform.minimaxi.com/"], requiresEnv: ["MINIMAX_API_KEY"], notes: ["Setup-plan only until provider preset is configured."] })),
  plugin("provider-zai", "provider", "hermes", "Z.ai provider setup and picker entry.", "medium", "provider", undefined, ["zai"], setup({ setupUrls: ["https://z.ai/"], requiresEnv: ["ZAI_API_KEY"], notes: ["Setup-plan only until provider preset is configured."] })),
  plugin("provider-alibaba", "provider", "hermes", "Alibaba/Qwen DashScope provider setup and picker entry.", "medium", "provider", undefined, ["alibaba", "qwen"], setup({ setupUrls: ["https://dashscope.console.aliyun.com/apiKey"], requiresAnyEnv: [["DASHSCOPE_API_KEY", "ALIBABA_API_KEY"]], notes: ["Use regional endpoint/account guidance during setup."] })),
  plugin("provider-stepfun", "provider", "hermes", "StepFun provider setup and picker entry.", "medium", "provider", undefined, ["stepfun"], setup({ setupUrls: ["https://platform.stepfun.com/"], requiresEnv: ["STEPFUN_API_KEY"], notes: ["Setup-plan only until provider preset is configured."] })),
  plugin("signal", "channel", "openclaw", "Signal channel adapter setup for privacy-sensitive messaging workflows.", "high", "channel-signal", undefined, undefined, setup({ channels: ["signal"], setupUrls: ["https://signal.org/docs/"], notes: ["Setup-plan only until a channel runtime adapter is implemented; require explicit account/device scope and no silent sends."] }), "setup_plan"),
  plugin("imessage-channel", "channel", "openclaw", "iMessage/BlueBubbles channel setup for macOS-backed messaging.", "high", "channel-imessage", undefined, ["imessage"], setup({ channels: ["imessage"], setupUrls: ["https://bluebubbles.app/"], notes: ["Setup-plan only until a channel runtime adapter is implemented; macOS/account-bound messaging is high-risk and requires visible consent."] }), "setup_plan"),
  plugin("nextcloud-talk", "channel", "openclaw", "Nextcloud Talk channel setup for self-hosted team chat.", "high", "channel-nextcloud-talk", undefined, undefined, setup({ channels: ["nextcloud-talk"], setupUrls: ["https://nextcloud-talk.readthedocs.io/"], notes: ["Setup-plan only until a gateway adapter exists."] }), "setup_plan"),
  plugin("twitch", "channel", "openclaw", "Twitch chat channel setup for livestream assistant workflows.", "high", "channel-twitch", undefined, undefined, setup({ channels: ["twitch"], setupUrls: ["https://dev.twitch.tv/docs/"], notes: ["Setup-plan only until a channel runtime adapter is implemented; moderation and posting actions need explicit channel policy."] }), "setup_plan"),
  plugin("irc", "channel", "hermes", "IRC channel setup for lightweight team/community chat.", "medium", "channel-irc", undefined, undefined, setup({ channels: ["irc"], setupUrls: ["https://modern.ircdocs.horse/"], notes: ["Setup-plan only until a channel runtime adapter is implemented; posting still needs configured room scope."] }), "setup_plan"),
  plugin("feishu", "channel", "hermes", "Feishu/Lark channel setup for enterprise chat workflows.", "high", "channel-feishu", undefined, undefined, setup({ channels: ["feishu"], setupUrls: ["https://open.feishu.cn/document/home/index"], notes: ["Setup-plan only until a channel adapter is implemented."] }), "setup_plan"),
  plugin("dingtalk", "channel", "hermes", "DingTalk channel setup for enterprise chat workflows.", "high", "channel-dingtalk", undefined, undefined, setup({ channels: ["dingtalk"], setupUrls: ["https://open.dingtalk.com/"], notes: ["Setup-plan only until a channel adapter is implemented."] }), "setup_plan"),
  plugin("wecom", "channel", "hermes", "WeCom channel setup for enterprise chat workflows.", "high", "channel-wecom", undefined, undefined, setup({ channels: ["wecom"], setupUrls: ["https://developer.work.weixin.qq.com/"], notes: ["Setup-plan only until a channel adapter is implemented."] }), "setup_plan"),
  plugin("qqbot", "channel", "openclaw", "QQ bot channel setup for chat workflows.", "high", "channel-qqbot", undefined, undefined, setup({ channels: ["qqbot"], setupUrls: ["https://bot.q.qq.com/wiki/"], notes: ["Setup-plan only until a channel adapter is implemented."] }), "setup_plan"),
  plugin("zalo", "channel", "openclaw", "Zalo channel setup for messaging workflows.", "high", "channel-zalo", undefined, undefined, setup({ channels: ["zalo"], setupUrls: ["https://developers.zalo.me/"], notes: ["Setup-plan only until a channel adapter is implemented."] }), "setup_plan"),
  plugin("nostr", "channel", "openclaw", "Nostr relay/channel setup for decentralized social messaging.", "high", "channel-nostr", undefined, undefined, setup({ channels: ["nostr"], setupUrls: ["https://github.com/nostr-protocol/nostr"], notes: ["Setup-plan only until a channel runtime adapter is implemented; key management is sensitive and private keys must never persist silently."] }), "setup_plan"),
  plugin("synology-chat", "channel", "openclaw", "Synology Chat channel setup for self-hosted team messaging.", "high", "channel-synology-chat", undefined, undefined, setup({ channels: ["synology-chat"], setupUrls: ["https://kb.synology.com/DSM/help/Chat/chat_integration"], notes: ["Setup-plan only until a channel adapter is implemented."] }), "setup_plan"),
  plugin("email-channel", "channel", "hermes", "Email channel setup for assistant inbox, triage, and reply-drafting workflows.", "high", "channel-email", undefined, ["email"], setup({ channels: ["email"], setupUrls: ["https://developers.google.com/gmail/api", "https://learn.microsoft.com/graph/outlook-mail-concept-overview"], notes: ["Setup-plan only until a channel runtime adapter is implemented; draft-first by default and sending needs explicit recipient, subject, and body confirmation."] }), "setup_plan"),
  plugin("document-extract", "documents", "openclaw", "Document extraction setup for PDFs, office files, OCR, and structured text capture.", "medium", "documents", undefined, undefined, setup({ setupUrls: ["https://github.com/openclaw/openclaw/tree/main/extensions/document-extract"], notes: ["Pair with artifact-studio or data-analytics; extraction output should be source-linked and size-capped."] })),
  plugin("file-transfer", "productivity", "openclaw", "File transfer setup for moving artifacts across local, remote, or channel surfaces.", "high", "file-transfer", undefined, undefined, setup({ setupUrls: ["https://github.com/openclaw/openclaw/tree/main/extensions/file-transfer"], notes: ["High-risk because it can exfiltrate files; require destination, file list, and size confirmation."] })),
  plugin("webhooks", "automation", "openclaw", "Webhook receiver/sender setup for lightweight app automations.", "high", "automation-webhooks", undefined, undefined, setup({ setupUrls: ["https://github.com/openclaw/openclaw/tree/main/docs/plugins/reference/webhooks.md"], notes: ["Require signing secrets, replay protection, and explicit event allowlists."] })),
  plugin("policy", "governance", "openclaw", "Policy plugin setup for per-run permissions, channel rules, and approval gates.", "high", "governance", undefined, undefined, setup({ setupUrls: ["https://github.com/openclaw/openclaw/tree/main/docs/plugins/reference/policy.md"], notes: ["Use to make permission decisions visible instead of burying them in prompts."] })),
  plugin("tokenjuice", "governance", "openclaw", "Token/cost accounting setup inspired by OpenClaw's tokenjuice extension.", "medium", "governance", undefined, undefined, setup({ setupUrls: ["https://github.com/openclaw/openclaw/tree/main/docs/plugins/reference/tokenjuice.md"], notes: ["Complements Muster's token ledger; do not double-count provider usage."] })),
  plugin("diagnostics-otel", "observability", "openclaw", "OpenTelemetry diagnostics setup for traces, spans, and runtime health.", "medium", "observability", undefined, undefined, setup({ setupUrls: ["https://opentelemetry.io/docs/"], requiresAnyEnv: [["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_SERVICE_NAME"]], notes: ["Export redacted timing/status metadata by default; raw prompts stay opt-in."] })),
  plugin("diagnostics-prometheus", "observability", "openclaw", "Prometheus diagnostics setup for local runtime metrics.", "medium", "observability", undefined, undefined, setup({ setupUrls: ["https://prometheus.io/docs/introduction/overview/"], notes: ["Expose counters/histograms for provider latency, memory retrieval, MCP health, and gateway delivery."] })),
  plugin("voice-call", "voice", "openclaw", "Voice-call adapter setup for phone or realtime audio assistant workflows.", "high", "voice", undefined, undefined, setup({ setupUrls: ["https://github.com/openclaw/openclaw/tree/main/docs/plugins/voice-call.md"], notes: ["Consent, call recording disclosure, and escalation controls are mandatory before activation."] })),
  plugin("deepgram", "voice", "openclaw", "Deepgram speech-to-text setup for meeting and voice workflows.", "high", "voice-stt", undefined, undefined, setup({ setupUrls: ["https://console.deepgram.com/"], requiresEnv: ["DEEPGRAM_API_KEY"], notes: ["Audio/transcripts are private data; attach retention and redaction policy."] })),
  plugin("elevenlabs", "voice", "openclaw", "ElevenLabs text-to-speech setup for voice responses.", "high", "voice-tts", undefined, undefined, setup({ setupUrls: ["https://elevenlabs.io/app/settings/api-keys"], requiresEnv: ["ELEVENLABS_API_KEY"], notes: ["Voice generation should expose cost, voice id, and consent boundaries."] })),
  plugin("azure-speech", "voice", "hermes", "Azure Speech setup for STT/TTS workflows.", "high", "voice", undefined, undefined, setup({ setupUrls: ["https://learn.microsoft.com/azure/ai-services/speech-service/"], requiresAnyEnv: [["AZURE_SPEECH_KEY", "SPEECH_KEY"]], notes: ["Require region and data-retention notes during setup."] })),
  plugin("tts-local-cli", "voice", "openclaw", "Local TTS CLI setup for offline voice output.", "medium", "voice-tts", undefined, undefined, setup({ setupUrls: ["https://github.com/openclaw/openclaw/tree/main/docs/plugins/reference/tts-local-cli.md"], notes: ["Local voice avoids API keys but still needs audible-output consent."] })),
  plugin("open-prose", "writing", "openclaw", "Open Prose writing/revision setup for long-form text workflows.", "medium", "writing", undefined, undefined, setup({ setupUrls: ["https://github.com/openclaw/openclaw/tree/main/extensions/open-prose"], notes: ["Useful as a writing workflow surface; preserve source attribution and user voice."] })),
  plugin("workboard", "productivity", "openclaw", "Workboard/task-board setup for tracking agent plans and follow-ups.", "medium", "productivity", undefined, undefined, setup({ setupUrls: ["https://github.com/openclaw/openclaw/tree/main/docs/plugins/reference/workboard.md"], notes: ["Complements Muster sessions and goal loops; keep user-owned tasks editable."] })),
  plugin("qa-lab", "quality", "openclaw", "QA lab setup for scenario-driven breaking tests and confidence profiles.", "medium", "quality", undefined, undefined, setup({ setupUrls: ["https://github.com/openclaw/openclaw/tree/main/extensions/qa-lab"], notes: ["Use for adversarial TUI/gateway/plugin tests before claiming release readiness."] })),
  plugin("qa-matrix", "quality", "openclaw", "QA matrix setup for cross-provider/channel/version test coverage.", "medium", "quality", undefined, undefined, setup({ setupUrls: ["https://github.com/openclaw/openclaw/tree/main/extensions/qa-matrix"], notes: ["Track which claims have live proof versus smoke-only proof."] })),
  plugin("codex-supervisor", "agent-runtime", "openclaw", "Codex supervisor setup for supervising delegated Codex work.", "medium", "agent-runtime", undefined, undefined, setup({ setupUrls: ["https://github.com/openclaw/openclaw/tree/main/extensions/codex-supervisor", "https://github.com/openai/codex"], notes: ["Muster should supervise Codex through session handles and ledgers, not hidden provider bypass."] })),
  plugin("migrate-claude", "migration", "openclaw", "Claude/Claude Code migration helper setup.", "medium", "migration", undefined, undefined, setup({ setupUrls: ["https://github.com/openclaw/openclaw/tree/main/docs/plugins/reference/migrate-claude.md"], notes: ["Surface import candidates for manual review; never auto-import arbitrary tools or secrets."] })),
  plugin("migrate-hermes", "migration", "openclaw", "Hermes migration helper setup for skills, plugins, providers, and memory.", "medium", "migration", undefined, undefined, setup({ setupUrls: ["https://github.com/openclaw/openclaw/tree/main/extensions/migrate-hermes", "https://github.com/NousResearch/hermes-agent"], notes: ["Use source manifests and config snapshots; quarantine executable capabilities until evaluated."] })),
  plugin("memory-lancedb", "memory", "openclaw", "LanceDB memory/vector setup for larger local retrieval stores.", "high", "memory-provider", undefined, ["lancedb"], setup({ setupUrls: ["https://lancedb.github.io/lancedb/"], notes: ["Optional local vector index; keep SQLite/FTS as the auditable default and store scope columns either way."] })),
  plugin("memory-wiki", "memory", "openclaw", "Memory wiki setup for human-readable long-term knowledge bases.", "high", "memory-provider", undefined, undefined, setup({ setupUrls: ["https://github.com/openclaw/openclaw/tree/main/docs/plugins/memory-wiki.md"], notes: ["Treat memory wiki as an external user-editable sync target; local scoped SQLite/FTS memory remains authoritative and exports must preserve scope columns."] })),
  plugin("active-memory", "memory", "openclaw", "Active memory setup for proactive recall and profile induction.", "high", "memory-provider", undefined, undefined, setup({ setupUrls: ["https://github.com/openclaw/openclaw/tree/main/extensions/active-memory"], notes: ["Must remain opt-in: proactive recall can leak context if scope and profile boundaries are weak; local scoped SQLite/FTS memory remains authoritative and external sync is approval-gated."] })),
];

const BUILTIN_PLUGINS: readonly BuiltinPluginCatalogEntry[] = [
  plugin("frappe-federated-bridge", "business-apps", "muster", "Frappe/ERPNext capability pack for identity, records, governed actions, and plugin-owned context induction.", "high", "business-app", "capability-packs/frappe", ["frappe"], setup({ auth: "oauth", setupCommand: "muster frappe setup", setupUrls: ["https://frappeframework.com/docs/user/en/api/rest", "https://docs.erpnext.com/", "https://frappeframework.com/docs"], notes: ["Keep the main Muster binary light: the Frappe plugin builds site/module context from Frappe and ERPNext docs, installed app docs, and live metadata.", "Use `muster frappe setup` for per-user OAuth. Frappe remains the identity and permission authority; legacy API-token environment variables are optional only for bounded context-build operations.", "Context induction should index installed apps, modules, DocTypes, DocFields, Custom Fields, workflows, role permissions, reports, scripts, and docs as scoped memory with graph links."] })),
  plugin("oss-manager-native-qa", "quality", "muster", "Customer-isolated, multi-agent infrastructure QA with source locks, semantic evidence, compensation-before-mutation, killed-run recovery, and restore-finally verdicts.", "high", "operations-qa", "capability-packs/oss-manager", ["oss-manager", "infrastructure-qa", "sentinel-qa"], setup({ setupUrls: ["https://github.com/hybrowlabs/OSS-Manager"], notes: ["The bundled pack is an executable beta compiler/evaluator with deterministic evidence contracts; deployment-specific inventory, remote executors, durable run orchestration, and live recovery credentials must be configured before live certification.", "No OpenClaw bridge is used. Mutating scenarios require explicit approvals, registered compensation, and an independently verified final restoration state."] }), "end_to_end_workflow"),
  plugin("browser", "web", "openclaw", "Browser automation setup, readiness, smoke-test, and risk-policy surface; execution stays permissioned through Playwright/browser MCP.", "high", "browser", "capability-packs/browser", undefined, setup({ mcpServers: ["browser"], defaultMcpServers: ["browser"], setupUrls: ["https://github.com/microsoft/playwright-mcp"], notes: ["The bundled pack follows Hermes's snapshot-first browser design and keeps raw CDP as an escape hatch, while Muster executes through Playwright/browser MCP.", "Browser automation is high-risk: screenshots or accessibility snapshots should back important UI claims, and authenticated or mutating actions require explicit user approval."] })),
  plugin("web-search", "web", "openclaw", "Search/fetch provider surface for cited research and retrieval.", "medium", "search", "capability-packs/web-search", undefined, setup({ mcpServers: ["parallel-search", "firecrawl"], setupUrls: ["https://docs.parallel.ai/integrations/mcp/search-mcp", "https://www.firecrawl.dev/app/api-keys"], notes: ["Keyless DuckDuckGo search works through the local capability pack; Parallel and Firecrawl are optional upgrades."] })),
  plugin("github", "developer", "hermes", "GitHub issue, PR, repository, and review workflows.", "medium", "developer", "capability-packs/github", undefined, setup({ mcpServers: ["github"], defaultMcpServers: ["github"], requiresEnv: ["GITHUB_PERSONAL_ACCESS_TOKEN"], setupUrls: ["https://github.com/settings/tokens", "https://cli.github.com/manual/gh_auth_login"], notes: ["The bundled capability pack is read-only. Install/configure the GitHub MCP when you want broader issue, PR, repo, or CI operations."] })),
  plugin("codex", "agent-runtime", "hermes", "Codex delegation runtime setup, readiness, sessions, and latency triage.", "medium", "agent-runtime", "capability-packs/codex", undefined, setup({ setupUrls: ["https://github.com/openai/codex"], notes: ["Hermes runs Codex as an autonomous coding CLI and notes that CLI OAuth can live in the host-managed Codex home, so missing OPENAI_API_KEY alone is not proof of missing Codex auth.", "Muster uses `codex exec --json`, captures thread_id for continuity, and injects memory/skills through experimental_instructions_file instead of the user prompt."] })),
  plugin("codex-native-tools", "agent-runtime", "muster", "Harness local Codex CLI capabilities: model/provider selection, images, project docs, approvals, and fast/continuity modes.", "medium", "agent-runtime", "capability-packs/codex-native-tools", undefined, setup({ setupUrls: ["https://github.com/openai/codex"], notes: ["This pack describes how Muster should route shell, patch, project-doc, image, approval, and fast-path work to native Codex capabilities without bloating prompts.", "OpenClaw-style per-run model/provider/tool policy is represented as explicit allowlists and approval gates."] })),
  plugin("codex-web-search", "research", "muster", "Use Codex-backed research/web-search workflows when the local Codex runtime exposes web tools.", "medium", "research", "capability-packs/codex-web-search", undefined, setup({ mcpServers: ["parallel-search", "firecrawl"], setupUrls: ["https://github.com/openai/codex", "https://docs.parallel.ai/integrations/mcp/search-mcp", "https://www.firecrawl.dev/app/api-keys"], notes: ["Use Codex native web search when available; otherwise fall back to the local web-search pack, Parallel Search MCP, or Firecrawl MCP.", "Current or unstable facts must produce cited source links and date-aware summaries."] })),
  plugin("claude-code", "agent-runtime", "hermes", "Claude Code delegation runtime setup, mode policy, sessions, and skill snapshot bridge.", "medium", "agent-runtime", "capability-packs/claude-code", undefined, setup({ setupUrls: ["https://docs.anthropic.com/en/docs/claude-code/setup", "https://code.claude.com/docs/en/cli-reference"], notes: ["Hermes prefers Claude Code print mode for one-shot automation and tmux/PTY for interactive multi-turn sessions.", "Muster uses `claude --print --output-format text`, pins session ids, and passes active skill snapshots as plugin dirs rather than dumping them into the user turn."] })),
  plugin("openai", "provider", "openclaw", "OpenAI provider preset, readiness checks, model routing, and latency triage.", "medium", "provider", "capability-packs/openai", undefined, setup({ requiresEnv: ["OPENAI_API_KEY"], setupUrls: ["https://platform.openai.com/api-keys", "https://platform.openai.com/docs/models"], notes: ["The bundled pack mirrors Hermes-style declarative provider profiles: auth env, base URL, model policy, and latency triage stay visible before runtime.", "Use `muster provider add openai --model <model>` and `muster runtime set --provider openai --model <model>` after the key is configured."] })),
  plugin("anthropic", "provider", "openclaw", "Anthropic/Claude provider preset, readiness checks, model routing, and latency triage.", "medium", "provider", "capability-packs/anthropic", ["claude"], setup({ requiresAnyEnv: [["ANTHROPIC_API_KEY", "ANTHROPIC_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]], setupUrls: ["https://console.anthropic.com/settings/keys", "https://docs.anthropic.com/en/api/models"], notes: ["Hermes aliases Anthropic as claude/claude-oauth/claude-code, but Muster keeps native API provider setup separate from the Claude Code runtime.", "Use ANTHROPIC_API_KEY for native API calls; use the claude-code runtime when local Claude Code subscription auth is the intended path."] })),
  plugin("telegram", "channel", "openclaw", "Telegram bot channel backend with webhook or long-poll delivery.", "high", "channel-telegram", "capability-packs/telegram", undefined, setup({ channels: ["telegram"], setupUrls: ["https://core.telegram.org/bots/tutorial", "https://core.telegram.org/bots/api#setwebhook"], notes: ["Telegram can be tested directly with `muster channels doctor telegram --live` when a bot token is configured; long-poll mode is available for local testing without a public webhook.", "The bundled channel pack provides setup, readiness, and update-debugging tools so agents can guide non-technical users without exposing bot tokens."] })),
  plugin("slack", "channel", "openclaw", "Slack channel adapter with Socket Mode, signature verification fallback, and thread-aware replies.", "high", "channel-slack", "capability-packs/slack", undefined, setup({ channels: ["slack"], setupUrls: ["https://api.slack.com/apps", "https://api.slack.com/apis/connections/socket", "https://api.slack.com/apis/connections/events-api"], notes: ["The bundled channel pack checks bot token/app-token readiness for Socket Mode and summarizes Slack events for debugging without printing secrets.", "Use HTTP Events API with a signing secret only when you intentionally have a public HTTPS gateway.", "If a runtime host exposes a Slack app connector, Roster should detect it from that host's local manifests and reuse it through the host rather than copying tokens."] })),
  plugin("google-chat", "channel", "openclaw", "Google Chat app adapter for Workspace spaces and app mentions.", "high", "channel-google-chat", "capability-packs/google-chat", ["gchat"], setup({ channels: ["gchat"], setupUrls: ["https://console.cloud.google.com/apis/library/chat.googleapis.com", "https://developers.google.com/workspace/chat/quickstart/webhooks"], notes: ["The bundled channel pack mirrors OpenClaw's setup/doctor pattern: plan the Google Cloud setup, verify gateway readiness, and summarize Chat events without needing Telegram for testing."] })),
  plugin("discord", "channel", "openclaw", "Discord Interactions adapter with Ed25519 verification, slash-command routing, and gateway replies.", "high", "channel-discord", "capability-packs/discord", undefined, setup({ channels: ["discord"], setupUrls: ["https://discord.com/developers/applications", "https://discord.com/developers/docs/interactions/overview"], notes: ["The bundled channel pack guides Discord app setup, bot-token/public-key readiness, interaction endpoint configuration, and safe payload debugging."] })),
  plugin("whatsapp", "channel", "openclaw", "WhatsApp personal linked-device adapter with DM pairing and group policy.", "high", "channel-whatsapp", undefined, undefined, setup({ channels: ["whatsapp"], setupUrls: ["https://docs.openclaw.ai/whatsapp", "https://github.com/WhiskeySockets/Baileys"], notes: ["Unofficial protocol; Meta ToS gray zone; the linked number can be banned — recommend a dedicated number.", "Group allowlists and sender authorization are checked before mention or reply activation."] })),
  plugin("whatsapp-cloud", "channel", "openclaw", "WhatsApp Cloud API business adapter with webhook verification and Graph replies.", "high", "channel-whatsapp-cloud", "capability-packs/whatsapp", undefined, setup({ channels: ["whatsapp-cloud"], setupUrls: ["https://developers.facebook.com/docs/whatsapp/cloud-api/get-started", "https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks"], notes: ["The bundled channel pack guides Meta app setup, access-token/verify-token/phone-number-id readiness, Cloud API webhook configuration, and safe webhook payload debugging."] })),
  plugin("teams", "channel", "openclaw", "Microsoft Teams channel adapter with setup/readiness diagnostics for gateway-backed Teams activities.", "high", "channel-teams", "capability-packs/teams", undefined, setup({ channels: ["teams"], setupUrls: ["https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-and-group-conversations", "https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade"], notes: ["The bundled channel pack guides Azure/Teams app registration, gateway endpoint setup, optional HMAC verification, and safe activity payload debugging."] })),
  plugin("google-workspace", "productivity", "hermes", "Google Workspace workflows requiring OAuth-backed tools.", "high", "productivity", "capability-packs/google-workspace", undefined, setup({ mcpServers: ["google-drive"], requiresAnyEnv: [["GOOGLE_WORKSPACE_ACCESS_TOKEN", "GOOGLE_ACCESS_TOKEN"]], setupUrls: ["https://console.cloud.google.com/apis/credentials", "https://console.cloud.google.com/apis/library", "https://developers.google.com/identity/protocols/oauth2"], notes: ["Create a Desktop OAuth client, enable only the APIs you need, then provide a user OAuth access token via GOOGLE_WORKSPACE_ACCESS_TOKEN or GOOGLE_ACCESS_TOKEN. The bundled pack is read-mostly; mutating mail/calendar/drive actions should go through explicit future workflows.", "For broader Drive/Docs/Sheets tool coverage, configure a Google Drive MCP or app connector after OAuth is complete."] })),
  plugin("google-calendar", "productivity", "muster", "Google Calendar scheduling, availability, daily brief, and meeting-prep workflows through a provider-authenticated connector.", "high", "productivity", undefined, undefined, setup({ setupUrls: ["https://console.cloud.google.com/apis/credentials", "https://developers.google.com/calendar/api/guides/overview"], requiresAnyEnv: [["GOOGLE_WORKSPACE_ACCESS_TOKEN", "GOOGLE_ACCESS_TOKEN"]], notes: ["Reuse a host-authenticated Google Calendar connector when Codex, Claude, or another provider exposes one; otherwise configure OAuth explicitly.", "Calendar writes mutate a user's schedule and should stay draft-first or confirmation-gated."] }), "setup_plan"),
  plugin("notion", "productivity", "hermes", "Notion pages, data-source, markdown, and workspace workflows with explicit API credentials.", "high", "productivity", "capability-packs/notion", undefined, setup({ mcpServers: ["notion"], requiresAnyEnv: [["NOTION_API_KEY", "NOTION_API_TOKEN"]], setupUrls: ["https://www.notion.so/my-integrations", "https://developers.notion.com/cli/get-started/overview", "https://mcp.notion.com/mcp"], notes: ["Create an internal integration, then share target pages/data sources with it in Notion. Otherwise the API returns 404 even for existing pages.", "For broader Notion MCP operations, run `muster mcp install notion`; the remote MCP uses OAuth at https://mcp.notion.com/mcp."] })),
  plugin("figma", "design", "muster", "Figma design file inspection, design-system context, and handoff workflows through OAuth-backed app or remote MCP access.", "high", "design", undefined, undefined, setup({ mcpServers: ["figma"], defaultMcpServers: ["figma"], setupUrls: ["https://mcp.figma.com/mcp", "https://www.figma.com/developers/api"], notes: ["Muster can reuse host-authenticated app surfaces when the runtime host exposes them, or install the Figma MCP directly after OAuth.", "Figma files can contain private customer/product assets; keep result caps and explicit file scope visible."] }), "mcp_installable"),
  plugin("supabase", "database", "muster", "Supabase project, SQL, schema, auth, edge-function, and log workflows through an authenticated app connector.", "high", "database", undefined, undefined, setup({ setupUrls: ["https://supabase.com/dashboard/account/tokens", "https://supabase.com/docs"], requiresAnyEnv: [["SUPABASE_ACCESS_TOKEN", "SUPABASE_TOKEN"]], notes: ["Reuse an authenticated Supabase connector when the provider host exposes it; otherwise configure a scoped access token.", "Database and auth changes are high-risk and should route through schema inspection, dry-run, and confirmation steps."] }), "setup_plan"),
  plugin("heygen", "media", "muster", "HeyGen avatar, presenter-video, and video-message workflows through an authenticated connector or API key.", "high", "media", undefined, undefined, setup({ setupUrls: ["https://app.heygen.com/settings?nav=API"], requiresAnyEnv: [["HEYGEN_API_KEY"]], notes: ["Reuse a host-authenticated HeyGen app when available; otherwise configure an API key explicitly.", "Generated videos can incur cost and use likeness assets, so jobs should be artifact-tracked and approval-gated."] }), "setup_plan"),
  plugin("product-design", "design", "muster", "Product-design critique, prototype, journey, and visual-audit workflows that can combine browser evidence, Figma context, and image tools.", "medium", "design", undefined, ["design-review", "ux-audit"], setup({ mcpServers: ["browser", "figma"], setupUrls: ["https://mcp.figma.com/mcp", "https://github.com/microsoft/playwright-mcp"], notes: ["Use this as a workflow pack around authenticated Figma/browser/image surfaces; it is not a magic design adapter by itself.", "Good for product QA and conversion work when visual evidence is captured before recommendations."] }), "setup_plan"),
  plugin("sales", "business-apps", "muster", "Sales workflow setup for CRM, enrichment, email, calendar, meeting notes, and docs connectors.", "high", "business-apps", undefined, undefined, setup({ setupUrls: ["https://developer.salesforce.com/docs/apis", "https://developers.hubspot.com/docs/api/overview", "https://developers.google.com/calendar/api/guides/overview"], notes: ["Codex exposes a broad sales connector bundle; Muster treats it as a host-authenticated app surface until each CRM/mail/calendar route is explicitly configured.", "Sales workflows mix customer data and outbound communication, so default to read/draft mode with clear source citations and no silent sends."] }), "setup_plan"),
  plugin("authenticated-app-reuse", "mcp", "muster", "Discover provider-authenticated plugins, apps, MCPs, and skills from provider hosts so users do not configure the same connector twice.", "high", "integration-reuse", undefined, ["app-reuse", "provider-plugins", "host-apps"], setup({ setupUrls: ["https://modelcontextprotocol.io/"], notes: ["Run `muster plugins reuse <provider>` to inspect local provider plugin manifests without printing secrets. Known presets include codex, claude, openclaw, and hermes; any provider can use MUSTER_<PROVIDER>_PLUGIN_CACHE.", "If the user wants the connector in Muster instead of a provider host, use `muster mcp add-http`, `muster mcp add-stdio`, `muster plugins inspect/load`, or `muster skills enable` explicitly.", "Reuse means Muster routes through a host-exposed connector or imports explicit env/token handles; it never copies opaque provider secrets silently."] }), "setup_plan"),
  plugin("airtable", "productivity", "hermes", "Airtable bases, tables, records, filters, and upserts with explicit PAT setup.", "high", "productivity", "capability-packs/airtable", undefined, setup({ requiresAnyEnv: [["AIRTABLE_API_KEY", "AIRTABLE_PAT"]], setupUrls: ["https://airtable.com/create/tokens", "https://airtable.com/developers/web/api/introduction"], notes: ["Create a Personal Access Token with schema.bases:read plus data.records:read/data.records:write scopes, then add each target base to the token Access list.", "The bundled pack excludes delete by default; inspect schema before mutations and use upsert/update deliberately."] })),
  plugin("jupyter", "data-science", "hermes", "Notebook/live-kernel setup, readiness, scratch notebook, and inspection workflow inspired by Hermes's hamelnb skill.", "medium", "data", "capability-packs/jupyter", undefined, setup({ setupUrls: ["https://github.com/hamelsmu/hamelnb", "https://github.com/NousResearch/hermes-agent/blob/main/skills/data-science/jupyter-live-kernel/SKILL.md", "https://jupyterlab.readthedocs.io/"], notes: ["Hermes delegates live kernel execution to hamelnb's jupyter_live_kernel.py helper. Muster ships setup/readiness plus safe notebook creation/inspection now; live websocket execution should be added as a future executor instead of pretending the helper is embedded.", "For token-protected local Jupyter, set JUPYTER_TOKEN before running readiness checks or pass the token inside the pack tool context."] })),
  plugin("huggingface", "mlops", "hermes", "Hugging Face Hub model, dataset, repo inspection, and download guidance workflows.", "medium", "mlops", "capability-packs/huggingface", undefined, setup({ setupUrls: ["https://huggingface.co/settings/tokens", "https://hf.co/cli"], notes: ["Public model and dataset discovery works without a token; set HF_TOKEN or HUGGINGFACE_TOKEN for private/gated repos.", "The bundled pack is read-only plus download guidance. Uploads, jobs, endpoints, webhooks, and repo mutations should go through explicit future workflows."] })),
  plugin("vllm", "mlops", "hermes", "vLLM serving setup, OpenAI-compatible endpoint checks, metrics summaries, and provider configuration guidance.", "medium", "mlops", "capability-packs/vllm", undefined, setup({ setupUrls: ["https://docs.vllm.ai", "https://github.com/vllm-project/vllm", "https://github.com/NousResearch/hermes-agent/blob/main/skills/mlops/inference/vllm/SKILL.md"], notes: ["Hermes's bundled vLLM skill focuses on high-throughput OpenAI-compatible serving with PagedAttention, continuous batching, quantization, tensor parallelism, and metrics.", "Muster keeps server launch explicit, but the bundled pack checks /v1/models, summarizes Prometheus metrics, and generates local OpenAI-compatible provider setup guidance."] })),
  plugin("obsidian", "knowledge", "hermes", "Local Obsidian vault listing, search, read, create, and append workflows.", "medium", "knowledge", "capability-packs/obsidian", undefined, setup({ setupUrls: ["https://help.obsidian.md/Files+and+folders/Manage+vaults"], notes: ["Set OBSIDIAN_VAULT_PATH or pass vaultPath to target a specific vault. If unset, Muster follows Hermes's fallback: ~/Documents/Obsidian Vault.", "All note paths are resolved inside the configured vault; traversal and non-markdown writes are refused."] })),
  plugin("developer-tools", "developer", "muster", "Bundled development workflows for shell, git, tests, code review, debugging, and API checks.", "medium", "developer", "capability-packs/developer-tools", undefined, setup({ mcpServers: ["git", "filesystem", "browser", "sqlite"], defaultMcpServers: ["git"], notes: ["The bundled pack mirrors Hermes-style development toolset planning and OpenClaw-style per-run allowlists without executing shell itself.", "Filesystem MCP is high-risk and stays opt-in; Git MCP is configured by default.", "Use browser MCP for screenshot-backed frontend QA and sqlite MCP for local app state inspection when needed."] })),
  plugin("web-frameworks", "developer", "muster", "Read-only framework detection plus local, production, and integration workflows for Frappe/ERPNext, React, Vue, and common web stacks.", "medium", "developer", "capability-packs/web-frameworks", undefined, setup({ setupUrls: ["https://frappeframework.com/docs", "https://react.dev/learn", "https://vuejs.org/guide/introduction.html"], notes: ["Detects local framework markers, suggests commands from actual repository scripts, and builds a stack-aware runbook before falling back to conventions.", "Production checks are read-only and look for build/start scripts, Frappe bench files, HTTPS URLs, lockfiles, CI, env templates, and deployment descriptors.", "Workflow guidance links frontend apps to web/browser MCP setup and Frappe/ERPNext apps to the permission-scoped Frappe bridge."] })),
  plugin("artifact-studio", "artifacts", "muster", "DOCX, XLSX, PPTX, PDF, report, CSV, dashboard, and gated Office artifact workflows.", "medium", "artifacts", "capability-packs/artifact-studio", ["documents", "document", "docx", "office", "excel", "xlsx", "spreadsheet", "powerpoint", "ppt", "pptx", "presentation", "pdf", "artifact", "artifacts"], setup({ notes: ["Local markdown, CSV, dashboard-manifest, DOCX, XLSX, PPTX, and simple PDF builders are enabled.", "Office workflows include intake, capability inspection, deterministic draft, structural verification, optional app-server polish, approval-gated publish, and eval-backed learning.", "For polished document, spreadsheet, presentation, or PDF output that needs render/visual QA, route through an active Codex or Claude app-server session only when that host exposes the relevant artifact skill."] })),
  plugin("daily-ops", "productivity", "muster", "Daily brief, task planning, notes, email/calendar style handoff, and lightweight personal ops.", "medium", "productivity", "capability-packs/daily-ops", undefined, setup({ mcpServers: ["google-drive", "notion"], notes: ["Local daily brief and task prioritization work without credentials; calendar/email/workspace connectors need auth-backed MCPs or apps."] })),
  plugin("data-analytics", "data", "muster", "Data inspection, charting, SQL review, dashboards, and metric diagnostics.", "high", "data", "capability-packs/data-analytics", undefined, setup({ mcpServers: ["postgres", "sqlite"], defaultMcpServers: ["sqlite"], requiresEnv: ["DATABASE_URL"], notes: ["Local row profiling works without credentials; Postgres MCP needs DATABASE_URL."] })),
  plugin("security-review", "security", "muster", "Secret scanning, dependency review, permission review, and release-risk checks.", "medium", "security", "capability-packs/security-review", undefined, setup({ notes: ["Rule-based local text scanning is enabled. Dependency/SBOM scanners can be attached later as MCPs or shell-governed tools."] })),
  plugin("research-lab", "research", "muster", "Web research, arXiv/paper review, citation notes, and source disagreement tracking.", "medium", "research", "capability-packs/research-lab", undefined, setup({ mcpServers: ["parallel-search", "firecrawl"], notes: ["Local arXiv and public web fetch tools are available without credentials."] })),
  plugin("mcp-bridge", "mcp", "openclaw", "Curated MCP server bridge for setup planning, config linting, tool policy, and install/test workflows.", "high", "mcp", "capability-packs/mcp-bridge", undefined, setup({ mcpServers: ["filesystem", "git", "browser", "postgres", "sqlite", "github", "google-drive", "notion", "figma", "linear", "n8n", "data-analytics-widgets", "openai-api-key-local-confirmation"], defaultMcpServers: ["git", "sqlite"], notes: ["The bundled pack follows Hermes MCP patterns: curated manifests, explicit env only, OAuth setup for remote services, tool allowlists, isolated server failures, and security linting for shell-based MCP entries.", "Provider-hosted helpers are discoverable with `muster plugins reuse <provider>`; explicit Muster-native setup stays available through add-http, add-stdio, inspect/load, and skills commands."] })),
  ...HERMES_PLUGIN_CATALOG_EXPANSION,
  ...OPENCLAW_PLUGIN_CATALOG_EXPANSION,
];

const BUILTIN_MCP_SERVERS: readonly BuiltinMcpCatalogEntry[] = [
  mcp("filesystem", "workspace", "openclaw", "Scoped local file access for read/edit workflows.", "high", "muster mcp add-stdio filesystem npx -y @modelcontextprotocol/server-filesystem <workspace>", { auth: "local", notes: ["Configured against the current working directory."], install: { transport: { kind: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "${CWD}"] } } }),
  mcp("git", "developer", "muster", "Repository status, diff, branch, and commit context.", "medium", "muster mcp add-stdio git npx -y @modelcontextprotocol/server-git <repo>", { auth: "local", notes: ["Configured against the current working directory."], install: { transport: { kind: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-git", "${CWD}"] } } }),
  mcp("github", "developer", "hermes", "GitHub issue, PR, repo, and CI operations through an authenticated bridge.", "high", "muster mcp add-stdio github npx -y @modelcontextprotocol/server-github", { auth: "api_key", requiresAnyEnv: [["GITHUB_PERSONAL_ACCESS_TOKEN", "GITHUB_TOKEN"]], setupUrls: ["https://github.com/settings/tokens"], install: { transport: { kind: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "GITHUB_PERSONAL_ACCESS_TOKEN|GITHUB_TOKEN" } } } }),
  mcp("browser", "web", "openclaw", "Browser automation and screenshot-backed web inspection.", "high", "muster mcp add-stdio browser npx -y @playwright/mcp", { auth: "local", setupUrls: ["https://github.com/microsoft/playwright-mcp"], install: { transport: { kind: "stdio", command: "npx", args: ["-y", "@playwright/mcp"] } } }),
  mcp("postgres", "data", "openclaw", "Postgres schema inspection and governed SQL workflows.", "high", "muster mcp add-stdio postgres npx -y @modelcontextprotocol/server-postgres <connection-url>", { auth: "api_key", requiresEnv: ["DATABASE_URL"], setupUrls: ["https://github.com/modelcontextprotocol/servers/tree/main/src/postgres"], install: { transport: { kind: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres", "${DATABASE_URL}"] } } }),
  mcp("sqlite", "data", "muster", "Local SQLite inspection for memory, logs, and compact project data.", "medium", "muster mcp add-stdio sqlite npx -y mcp-server-sqlite <database>", { auth: "local", install: { transport: { kind: "stdio", command: "npx", args: ["-y", "mcp-server-sqlite", ".muster/muster.db"] } } }),
  mcp("parallel-search", "web", "openclaw", "Parallel Search MCP, including a keyless hosted search transport for fast web retrieval.", "medium", "muster mcp install parallel-search", { auth: "none", setupUrls: ["https://docs.parallel.ai/integrations/mcp/search-mcp"], notes: ["Uses the hosted Streamable HTTP MCP endpoint."], install: { transport: { kind: "http", url: "https://search.parallel.ai/mcp" }, limits: { toolTimeoutMs: 30000, maxResultChars: 12000 } } }),
  mcp("firecrawl", "web", "openclaw", "Firecrawl search/scrape workflows for web and document extraction.", "high", "muster mcp install firecrawl", { auth: "api_key", requiresEnv: ["FIRECRAWL_API_KEY"], setupUrls: ["https://www.firecrawl.dev/app/api-keys"], install: { transport: { kind: "stdio", command: "npx", args: ["-y", "firecrawl-mcp"], env: { FIRECRAWL_API_KEY: "FIRECRAWL_API_KEY" } } } }),
  mcp("linear", "productivity", "hermes", "Linear's remote MCP server with native OAuth.", "high", "muster mcp install linear", { auth: "oauth", setupUrls: ["https://linear.app/docs/mcp"], notes: ["Browser OAuth starts on first server connection."], install: { transport: { kind: "http", url: "https://mcp.linear.app/mcp" }, auth: "oauth", oauth: { setupUrl: "https://linear.app/docs/mcp" }, limits: { toolTimeoutMs: 30000, maxResultChars: 12000 } } }),
  mcp("n8n", "automation", "hermes", "n8n workflow inspection bridge with a safe default read-mostly tool subset.", "high", "muster mcp install n8n", { auth: "api_key", requiresEnv: ["N8N_BASE_URL", "N8N_API_KEY"], setupUrls: ["https://github.com/CyberSamuraiX/hermes-n8n-mcp"], defaultTools: ["health", "list_workflows", "get_workflow", "find_workflows", "list_executions", "get_execution", "recent_failures", "export_workflow"], install: { transport: { kind: "stdio", command: "npx", args: ["-y", "n8n-mcp"], env: { N8N_BASE_URL: "N8N_BASE_URL", N8N_API_KEY: "N8N_API_KEY" } }, tools: { include: ["health", "list_workflows", "get_workflow", "find_workflows", "list_executions", "get_execution", "recent_failures", "export_workflow"] } } }),
  mcp("google-drive", "productivity", "hermes", "Docs, Sheets, Slides, and Drive workflows through OAuth-backed tools.", "high", "muster mcp add-stdio google-drive <configured-google-drive-mcp-command>", { auth: "oauth", setupUrls: ["https://console.cloud.google.com/apis/credentials", "https://developers.google.com/drive/api/guides/about-sdk"] }),
  mcp("notion", "productivity", "hermes", "Notion remote MCP for pages, data sources, comments, and workspace tools.", "high", "muster mcp install notion", { auth: "oauth", setupUrls: ["https://mcp.notion.com/mcp", "https://developers.notion.com/docs/mcp"], notes: ["Uses the path-scoped Notion MCP endpoint; keep /mcp in the server URL for OAuth protected-resource validation."], install: { transport: { kind: "http", url: "https://mcp.notion.com/mcp" }, auth: "oauth", oauth: { setupUrl: "https://mcp.notion.com/mcp", clientName: "Muster" }, limits: { toolTimeoutMs: 30000, maxResultChars: 12000 } } }),
  mcp("figma", "design", "muster", "Figma remote MCP for design file and component context through OAuth.", "high", "muster mcp install figma", { auth: "oauth", setupUrls: ["https://mcp.figma.com/mcp", "https://www.figma.com/developers/api"], notes: ["Keep file keys and design assets scoped to the current task."], install: { transport: { kind: "http", url: "https://mcp.figma.com/mcp" }, auth: "oauth", oauth: { setupUrl: "https://mcp.figma.com/mcp", clientName: "Muster" }, limits: { toolTimeoutMs: 30000, maxResultChars: 12000 } } }),
  mcp("data-analytics-widgets", "data", "muster", "Local provider Data Analytics MCP for rendering reviewed charts, tables, dashboards, and report artifacts.", "medium", "muster plugins reuse <provider>", { auth: "local", setupUrls: ["https://themuster.dev/"], notes: ["Discovered from provider plugin manifests when installed locally.", "Use `muster plugins reuse <provider>` to print the host-specific add-stdio command, or add it explicitly with `muster mcp add-stdio data-analytics-widgets <command> [args...]`."] }),
  mcp("openai-api-key-local-confirmation", "developer", "muster", "Local provider helper MCP for confirming API key destinations without exposing secrets.", "high", "muster plugins reuse <provider>", { auth: "local", setupUrls: ["https://platform.openai.com/api-keys"], notes: ["Discovered from provider plugin manifests when installed locally.", "This is a local trusted-flow helper: it should confirm destinations, not print or persist raw keys in logs. Add explicitly with `muster mcp add-stdio` if you want it owned by Muster instead of the provider host."] }),
];

export function listBuiltinSkills(): readonly BuiltinSkillCatalogEntry[] {
  return [...HERMES_SKILLS, ...HERMES_OPTIONAL_SKILLS];
}

export function listBuiltinPlugins(): readonly BuiltinPluginCatalogEntry[] {
  return BUILTIN_PLUGINS;
}

export function listBuiltinMcpServers(): readonly BuiltinMcpCatalogEntry[] {
  return BUILTIN_MCP_SERVERS;
}

export function resolveBuiltinCapabilityMentions(
  text: string,
  options: { readonly limit?: number } = {},
): readonly BuiltinCapabilityMention[] {
  const normalized = normalizeMentionText(text);
  if (!normalized) return [];
  const hits: Array<BuiltinCapabilityMention & { readonly score: number }> = [];
  const add = (mention: BuiltinCapabilityMention, score: number): void => {
    const existing = hits.find((hit) => hit.kind === mention.kind && hit.id === mention.id);
    if (existing && existing.score >= score) return;
    if (existing) hits.splice(hits.indexOf(existing), 1);
    hits.push({ ...mention, score });
  };

  for (const entry of listBuiltinPlugins()) {
    const match = matchEntry(normalized, [entry.id, ...(entry.aliases ?? [])], [entry.category, ...pluginKeywords(entry)]);
    if (!match) continue;
    add({
      kind: "plugin",
      id: entry.id,
      category: entry.category,
      risk: entry.risk,
      source: entry.source,
      description: entry.description,
      matched: match.value,
      confidence: match.confidence,
      actionability: entry.actionability,
    }, match.score + (normalized.includes("plugin") || normalized.includes("integration") ? 2 : 0));
  }

  for (const entry of listBuiltinSkills()) {
    const match = matchEntry(normalized, [entry.id], [entry.category, entry.description, ...entry.tags]);
    if (!match) continue;
    add({
      kind: "skill",
      id: entry.id,
      category: entry.category,
      risk: entry.risk,
      source: entry.source,
      description: entry.description,
      matched: match.value,
      confidence: match.confidence,
    }, match.score + (normalized.includes("skill") ? 2 : 0));
  }

  for (const entry of listBuiltinMcpServers()) {
    const match = matchEntry(normalized, [entry.id], [entry.category, entry.description, ...(entry.defaultTools ?? [])]);
    if (!match) continue;
    add({
      kind: "mcp",
      id: entry.id,
      category: entry.category,
      risk: entry.risk,
      source: entry.source,
      description: entry.description,
      matched: match.value,
      confidence: match.confidence,
    }, match.score + (normalized.includes("mcp") || normalized.includes("server") ? 2 : 0));
  }

  return hits
    .sort((left, right) => right.score - left.score || kindOrder(left.kind) - kindOrder(right.kind) || left.id.localeCompare(right.id))
    .slice(0, Math.max(1, options.limit ?? 6))
    .map(({ score: _score, ...mention }) => mention);
}

export async function enableBuiltinSkill(id: string, cwd = process.cwd()): Promise<BuiltinSkillCatalogEntry> {
  const entry = findBuiltinSkill(id);
  await writeBundledSkill({
    name: entry.id,
    description: entry.description,
    tags: [...entry.tags, `source:${entry.source}`, `category:${entry.category}`],
    frontmatter: { userInvocable: true },
    openclaw: {
      always: entry.risk === "low",
      requires: entry.requires?.length ? { anyBins: entry.requires } : undefined,
    },
    body: renderBuiltinSkillBody(entry),
  }, cwd);
  const config = await loadConfig(cwd);
  await saveConfig({
    ...config,
    skills: {
      ...config.skills,
      entries: {
        ...(config.skills?.entries ?? {}),
        [entry.id]: { ...(config.skills?.entries?.[entry.id] ?? {}), enabled: true },
      },
    },
  }, cwd);
  return entry;
}

export async function disableBuiltinSkill(id: string, cwd = process.cwd()): Promise<BuiltinSkillCatalogEntry> {
  const entry = findBuiltinSkill(id);
  await archiveSkill(entry.id, cwd).catch((error: unknown) => {
    if (error instanceof Error && error.message.includes("Skill not found")) return;
    throw error;
  });
  const config = await loadConfig(cwd);
  await saveConfig({
    ...config,
    skills: {
      ...config.skills,
      entries: {
        ...(config.skills?.entries ?? {}),
        [entry.id]: { ...(config.skills?.entries?.[entry.id] ?? {}), enabled: false },
      },
    },
  }, cwd);
  return entry;
}

export async function enableBuiltinPlugin(
  id: string,
  cwd = process.cwd(),
  options: { readonly allowHighRisk?: boolean } = {},
): Promise<BuiltinPluginCatalogEntry> {
  const entry = findBuiltinPlugin(id);
  if (entry.risk === "high" && !options.allowHighRisk) {
    throw new Error(`Built-in plugin "${entry.id}" is high risk and requires --allow-high-risk.`);
  }
  const config = await loadConfig(cwd);
  const packPath = await resolvePackPath(entry);
  if (entry.packPath && !packPath) {
    throw new Error(`Built-in plugin "${entry.id}" is unavailable because its capability pack was not included in this installation.`);
  }
  const loadPaths = new Set(config.plugins?.load?.paths ?? []);
  if (packPath) loadPaths.add(packPath);
  await saveConfig({
    ...config,
    plugins: {
      ...config.plugins,
      allow: [...new Set([...(config.plugins?.allow ?? []), entry.id])],
      slots: entry.slot ? { ...(config.plugins?.slots ?? {}), [entry.slot]: entry.id } : config.plugins?.slots,
      load: loadPaths.size ? { paths: [...loadPaths] } : config.plugins?.load,
      entries: {
        ...(config.plugins?.entries ?? {}),
        [entry.id]: { ...(config.plugins?.entries?.[entry.id] ?? {}), enabled: true },
      },
    },
  }, cwd);
  return entry;
}

export async function disableBuiltinPlugin(id: string, cwd = process.cwd()): Promise<BuiltinPluginCatalogEntry> {
  const entry = findBuiltinPlugin(id);
  const config = await loadConfig(cwd);
  const packPath = await resolvePackPath(entry);
  const allow = (config.plugins?.allow ?? []).filter((candidate) => candidate !== entry.id);
  const loadPaths = (config.plugins?.load?.paths ?? []).filter((candidate) => candidate !== packPath);
  const slots = Object.fromEntries(Object.entries(config.plugins?.slots ?? {}).filter(([, owner]) => owner !== entry.id));
  await saveConfig({
    ...config,
    plugins: {
      ...config.plugins,
      allow,
      slots,
      load: loadPaths.length ? { paths: loadPaths } : undefined,
      entries: {
        ...(config.plugins?.entries ?? {}),
        [entry.id]: { ...(config.plugins?.entries?.[entry.id] ?? {}), enabled: false },
      },
    },
  }, cwd);
  return entry;
}

function findBuiltinSkill(id: string): BuiltinSkillCatalogEntry {
  const entry = listBuiltinSkills().find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Unknown built-in skill "${id}". Run muster skills catalog.`);
  return entry;
}

function findBuiltinPlugin(id: string): BuiltinPluginCatalogEntry {
  const entry = BUILTIN_PLUGINS.find((candidate) => candidate.id === id || candidate.aliases?.includes(id));
  if (!entry) throw new Error(`Unknown built-in plugin "${id}". Run muster plugins catalog.`);
  return entry;
}

export async function resolveBuiltinPluginPackPath(id: string): Promise<string | undefined> {
  return resolvePackPath(findBuiltinPlugin(id));
}

function renderBuiltinSkillBody(entry: BuiltinSkillCatalogEntry): string {
  const requires = entry.requires?.length ? `\nPrerequisites: ${entry.requires.join(", ")}.\n` : "";
  return `Use this skill when the task matches: ${entry.description}

Source inspiration: ${entry.source}. This is a Muster-authored built-in profile, not a verbatim upstream copy.
Risk: ${entry.risk}. Ask for confirmation before using credentials, networked services, destructive writes, or broad filesystem access.
${requires}
Workflow:
1. Check whether required tools, credentials, files, or service access exist.
2. Keep the work scoped to the user's request and current workspace.
3. Prefer read/inspect steps before writes or external actions.
4. Report concrete results and any missing setup clearly.`;
}

function skill(
  id: string,
  category: string,
  source: BuiltinCatalogSource,
  description: string,
  risk: BuiltinRisk,
  tags: readonly string[],
  requires?: readonly string[],
): BuiltinSkillCatalogEntry {
  return { id, category, source, description, risk, tags, requires };
}

function plugin(
  id: string,
  category: string,
  source: BuiltinCatalogSource,
  description: string,
  risk: BuiltinRisk,
  slot?: string,
  packPath?: string,
  aliases?: readonly string[],
  setup?: BuiltinIntegrationSetup,
  actionability?: BuiltinActionability,
): BuiltinPluginCatalogEntry {
  return { id, aliases, category, source, description, risk, actionability: actionability ?? inferPluginActionability(category, packPath, setup), slot, packPath, setup };
}

function inferPluginActionability(category: string, packPath: string | undefined, setup: BuiltinIntegrationSetup | undefined): BuiltinActionability {
  if (category === "channel" || setup?.channels?.length) return "runtime_adapter";
  if (setup?.defaultMcpServers?.length || setup?.mcpServers?.length) return "mcp_installable";
  if (packPath) return "local_tool";
  if (setup) return "setup_plan";
  return "metadata";
}

function mcp(
  id: string,
  category: string,
  source: BuiltinCatalogSource,
  description: string,
  risk: BuiltinRisk,
  commandHint: string,
  options: Omit<BuiltinMcpCatalogEntry, "id" | "category" | "source" | "description" | "risk" | "commandHint"> = {},
): BuiltinMcpCatalogEntry {
  return { id, category, source, description, risk, commandHint, ...options };
}

function setup(value: BuiltinIntegrationSetup): BuiltinIntegrationSetup {
  return value;
}

function normalizeMentionText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_/]+/g, "-")
    .replace(/[^a-z0-9@.+#-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchEntry(
  normalizedText: string,
  directTerms: readonly string[],
  keywordTerms: readonly string[],
): { readonly value: string; readonly confidence: BuiltinCapabilityMention["confidence"]; readonly score: number } | undefined {
  for (const term of directTerms.map(normalizeMentionText).filter(Boolean)) {
    if (containsMentionTerm(normalizedText, term)) return { value: term, confidence: "exact", score: 10 + term.length / 100 };
    const loose = term.replace(/-/g, " ");
    if (loose !== term && containsMentionTerm(normalizedText, loose)) return { value: loose, confidence: "alias", score: 8 + loose.length / 100 };
  }
  for (const term of keywordTerms.flatMap(extractMentionKeywords)) {
    if (containsMentionTerm(normalizedText, term)) return { value: term, confidence: "keyword", score: 4 + term.length / 100 };
  }
  return undefined;
}

function containsMentionTerm(text: string, term: string): boolean {
  if (term.length < 3) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\ /g, "[ -]");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(text);
}

function extractMentionKeywords(value: string): string[] {
  const normalized = normalizeMentionText(value);
  const words = normalized.split(" ").filter((word) => word.length >= 4 && !COMMON_MENTION_WORDS.has(word));
  const phrases: string[] = [];
  for (let index = 0; index < words.length - 1; index += 1) {
    phrases.push(`${words[index]} ${words[index + 1]}`);
  }
  return [...new Set([...words.filter((word) => IMPORTANT_MENTION_WORDS.has(word)), ...phrases.filter((phrase) => phrase.length <= 32)])];
}

function pluginKeywords(entry: BuiltinPluginCatalogEntry): string[] {
  return [
    entry.description,
    ...(entry.setup?.channels ?? []),
    ...(entry.setup?.mcpServers ?? []),
    ...(entry.setup?.defaultMcpServers ?? []),
  ];
}

function kindOrder(kind: BuiltinCapabilityMentionKind): number {
  if (kind === "plugin") return 0;
  if (kind === "mcp") return 1;
  return 2;
}

const IMPORTANT_MENTION_WORDS = new Set([
  "airtable",
  "browser",
  "calendar",
  "discord",
  "docx",
  "document",
  "documents",
  "drive",
  "excel",
  "frappe",
  "github",
  "gmail",
  "google",
  "notion",
  "pdf",
  "ppt",
  "pptx",
  "presentation",
  "slack",
  "spreadsheet",
  "teams",
  "telegram",
  "whatsapp",
  "xlsx",
]);

const COMMON_MENTION_WORDS = new Set([
  "with",
  "from",
  "this",
  "that",
  "when",
  "then",
  "through",
  "using",
  "setup",
  "set",
  "agent",
  "agents",
  "workflow",
  "workflows",
  "support",
  "supports",
  "local",
  "safe",
  "risk",
  "high",
  "medium",
  "source",
  "muster",
  "hermes",
  "openclaw",
  "plugin",
  "plugins",
  "skill",
  "skills",
  "server",
  "servers",
  "tools",
  "tool",
]);

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

async function resolvePackPath(entry: BuiltinPluginCatalogEntry): Promise<string | undefined> {
  if (!entry.packPath) return undefined;
  for (const candidate of [
    join(dirname(fileURLToPath(import.meta.url)), "builtin-packs", basename(entry.packPath)),
    join(repoRoot(), entry.packPath),
    join(repoRoot(), "..", entry.packPath),
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", entry.packPath),
  ]) {
    if (await directoryExists(candidate)) return candidate;
  }
  return undefined;
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
