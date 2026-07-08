import "./roadmap.css";
import { initTheme } from "./theme";

initTheme();

type ReleaseState = "Discovery" | "Build" | "Evidence" | "Release" | "GA";
type Status = "Now" | "Next" | "Building" | "Evidence Review" | "Release Ready";
type ProofState = "strong" | "partial" | "missing";
type RiskLevel = "low" | "medium" | "high";
type WorkType = "Epic" | "Story" | "Task" | "Gate";

type Release = {
  id: string;
  label: string;
  theme: string;
  window: string;
  target: string;
  state: ReleaseState;
  confidence: number;
  evidence: number;
  velocity: number;
  blockers: number;
  description: string;
};

type Evidence = {
  kind: "test" | "live" | "artifact" | "benchmark" | "security" | "docs" | "release";
  label: string;
  status: "pass" | "warn" | "missing";
  source: string;
};

type WorkItem = {
  id: string;
  releaseId: string;
  type: WorkType;
  epic: string;
  title: string;
  story: string;
  owner: string;
  status: Status;
  proof: ProofState;
  risk: RiskLevel;
  readiness: number;
  target: string;
  dependencies: string[];
  acceptance: string[];
  qa: string[];
  evidence: Evidence[];
  speed?: string;
  changelog: string;
};

const releases: Release[] = [
  {
    id: "q3-2026",
    label: "Q3 2026",
    theme: "Trustworthy demo and public proof",
    window: "Jul-Sep 2026",
    target: "0.2.x train",
    state: "Build",
    confidence: 72,
    evidence: 58,
    velocity: 18,
    blockers: 4,
    description: "Turn the current harness into a CTO-demoable product surface: stable TUI, channels, artifacts, provider speed evidence, and roadmap proof."
  },
  {
    id: "q4-2026",
    label: "Q4 2026",
    theme: "Enterprise control plane alpha",
    window: "Oct-Dec 2026",
    target: "0.3.x train",
    state: "Discovery",
    confidence: 48,
    evidence: 26,
    velocity: 11,
    blockers: 7,
    description: "Identity, RBAC, token budgets, shared memory, audit logs, leakage reports, and signed enterprise feature gates."
  },
  {
    id: "q1-2027",
    label: "Q1 2027",
    theme: "Frappe / ERPNext wedge",
    window: "Jan-Mar 2027",
    target: "0.4.x train",
    state: "Discovery",
    confidence: 41,
    evidence: 20,
    velocity: 9,
    blockers: 6,
    description: "DocType-aware retrieval, role-safe answers, workflow approvals, report generation, and Frappe agency workflows."
  },
  {
    id: "q2-2027",
    label: "Q2 2027",
    theme: "Integration depth and marketplace",
    window: "Apr-Jun 2027",
    target: "0.5.x train",
    state: "Discovery",
    confidence: 34,
    evidence: 18,
    velocity: 7,
    blockers: 8,
    description: "Production-grade channel setup, OAuth flows, MCP/plugin registry, and default packs with readiness levels."
  },
  {
    id: "q3-2027",
    label: "Q3 2027",
    theme: "Enterprise GA",
    window: "Jul-Sep 2027",
    target: "1.0 readiness",
    state: "Discovery",
    confidence: 28,
    evidence: 12,
    velocity: 5,
    blockers: 10,
    description: "SSO, audit export, admin dashboard, policy packs, GPU/private LLM reporting, chargeback, and VPC/on-prem runbooks."
  }
];

const items: WorkItem[] = [
  {
    id: "MR-101",
    releaseId: "q3-2026",
    type: "Epic",
    epic: "Core Reliability",
    title: "QA scorecard becomes the release gate",
    story: "Every release claim maps to evidence so screenshots cannot pass as proof.",
    owner: "QA Lead",
    status: "Building",
    proof: "partial",
    risk: "high",
    readiness: 64,
    target: "0.2.0",
    dependencies: ["MR-102", "MR-106"],
    acceptance: [
      "Strict release mode rejects missing suite manifests.",
      "Frappe-2 regression summary is attached before release.",
      "Changelog claims link to work items and evidence."
    ],
    qa: ["muster qa scorecard --strict-release", "PTY/TUI interaction tests", "Frappe-2 real prompt regression"],
    evidence: [
      { kind: "test", label: "CLI and core tests", status: "pass", source: "pnpm test" },
      { kind: "live", label: "Frappe-2 live prompt suite", status: "warn", source: "needs latest rerun" },
      { kind: "release", label: "Changelog evidence links", status: "missing", source: "release note draft" }
    ],
    speed: "Local command p95 under 500ms; provider overhead p50 under 250ms.",
    changelog: "Adds evidence-backed release gating and stricter QA scorecard checks."
  },
  {
    id: "MR-102",
    releaseId: "q3-2026",
    type: "Story",
    epic: "TUI / CLI UX",
    title: "Persistent command pickers and composer polish",
    story: "Slash and at-command pickers should feel stable like a real assistant CLI.",
    owner: "Terminal",
    status: "Evidence Review",
    proof: "partial",
    risk: "medium",
    readiness: 71,
    target: "0.2.0",
    dependencies: [],
    acceptance: [
      "Slash and at-command overlays persist until selection or escape.",
      "Arrow keys navigate list or prompt history correctly.",
      "Bottom rails fully surround the composer at 80, 120, and 200 columns."
    ],
    qa: ["qa-pty-tui.ts", "manual terminal screen capture", "visual regression notes"],
    evidence: [
      { kind: "test", label: "PTY TUI tests", status: "warn", source: "packages/cli/src/qa-pty-tui.ts" },
      { kind: "artifact", label: "Latest terminal launch GIF", status: "pass", source: "docs/assets/muster-terminal-launch-demo.gif" }
    ],
    speed: "Slash picker open under 100ms; TUI redraw no visible duplicate panes.",
    changelog: "Improves the interactive terminal composer, command pickers, and prompt history behavior."
  },
  {
    id: "MR-103",
    releaseId: "q3-2026",
    type: "Epic",
    epic: "Channels",
    title: "Slack and Telegram become operator-grade",
    story: "Channel setup, pairing, typing state, artifacts, and long-running status should work without terminal babysitting.",
    owner: "Gateway",
    status: "Building",
    proof: "partial",
    risk: "high",
    readiness: 57,
    target: "0.2.1",
    dependencies: ["MR-105", "MR-109"],
    acceptance: [
      "Slack setup uses minimal required credentials and verifies scopes.",
      "Telegram setup works with bot name and token where possible.",
      "Both channels show progress heartbeat during long runs.",
      "Artifacts are returned as files or hosted links with clear fallback."
    ],
    qa: ["channel setup tests", "Slack live message regression", "Telegram live message regression"],
    evidence: [
      { kind: "live", label: "Slack pairing and response", status: "pass", source: "Frappe-2 Slack channel run" },
      { kind: "live", label: "Telegram random message isolation", status: "warn", source: "needs regression after pairing fix" },
      { kind: "artifact", label: "Provider-generated PDF delivery", status: "warn", source: "local path fallback only" }
    ],
    speed: "Channel acknowledgement under 1s; heartbeat every 4-6s while provider runs.",
    changelog: "Hardens Slack and Telegram setup, pairing, progress, and artifact delivery workflows."
  },
  {
    id: "MR-104",
    releaseId: "q3-2026",
    type: "Epic",
    epic: "Office Artifacts",
    title: "Document, PDF, PPT, and Excel workflows become a pillar",
    story: "Prompts from CLI or channels should produce real office artifacts through provider-capable workflows.",
    owner: "Artifacts",
    status: "Next",
    proof: "partial",
    risk: "medium",
    readiness: 46,
    target: "0.2.2",
    dependencies: ["MR-103"],
    acceptance: [
      "Provider receives the artifact request instead of Muster hardcoding content.",
      "Generated file path or URL is returned through CLI, Slack, and Telegram.",
      "Long documents over 10 pages are tested for PDF delivery.",
      "Excel/PPT outputs include readable styling and data provenance."
    ],
    qa: ["artifact-pack tests", "Slack file delivery", "Telegram file delivery", "office document open/inspect"],
    evidence: [
      { kind: "artifact", label: "13-page PDF local generation", status: "pass", source: "provider-office-live artifact dir" },
      { kind: "live", label: "Slack native upload scope", status: "warn", source: "files:write missing in app" },
      { kind: "test", label: "integration-packs artifact tests", status: "pass", source: "packages/core/test/integration-packs.test.ts" }
    ],
    speed: "Artifact delivery under 3s after file exists or URL is available.",
    changelog: "Adds deeper provider-led office artifact generation and channel delivery checks."
  },
  {
    id: "MR-105",
    releaseId: "q3-2026",
    type: "Story",
    epic: "Provider Runtime",
    title: "Provider latency truth table",
    story: "Every run separates provider time, transport time, memory time, and Muster overhead.",
    owner: "Runtime",
    status: "Now",
    proof: "partial",
    risk: "high",
    readiness: 52,
    target: "0.2.0",
    dependencies: [],
    acceptance: [
      "Each run records recall, prompt build, provider connect, first token, total, persist, and hooks.",
      "Simple prompts prove Muster overhead separately from provider latency.",
      "Frappe-2 and local comparisons use the same prompt set."
    ],
    qa: ["provider latency tests", "normal prompt retrieval speed suite", "Frappe-2 timing regression"],
    evidence: [
      { kind: "benchmark", label: "Timing ledger output", status: "warn", source: "qa-frappe2.ts" },
      { kind: "live", label: "Codex server update check", status: "missing", source: "Frappe-2" }
    ],
    speed: "Muster pre-provider overhead p50 under 250ms, p95 under 1s.",
    changelog: "Adds provider latency decomposition and live speed regression evidence."
  },
  {
    id: "MR-106",
    releaseId: "q3-2026",
    type: "Gate",
    epic: "Memory",
    title: "Indexed memory retrieval and leak probes",
    story: "Memory must be fast, scoped, and invoked only when useful.",
    owner: "Memory",
    status: "Release Ready",
    proof: "strong",
    risk: "low",
    readiness: 91,
    target: "0.2.0",
    dependencies: [],
    acceptance: [
      "SQLite/FTS search replaces JSONL substring scan for hot retrieval.",
      "Scope columns prevent cross-user and cross-tenant recall.",
      "Memory is not injected for prompts that do not need it."
    ],
    qa: ["memory retrieval speed tests", "leakage tests", "run-integrity tests"],
    evidence: [
      { kind: "test", label: "Scoped memory tests", status: "pass", source: "packages/core/test/run-integrity.test.ts" },
      { kind: "benchmark", label: "p95 retrieval target", status: "pass", source: "--max-p95-ms 75" }
    ],
    speed: "Memory retrieval p95 under 75ms in QA target.",
    changelog: "Keeps memory fast and scoped through indexed retrieval and leakage tests."
  },
  {
    id: "MR-107",
    releaseId: "q4-2026",
    type: "Epic",
    epic: "Enterprise Control Plane",
    title: "Identity, RBAC, and department assistants",
    story: "Assistants are configured by department, role, data access, response style, and budget.",
    owner: "Enterprise",
    status: "Next",
    proof: "missing",
    risk: "high",
    readiness: 18,
    target: "0.3.0",
    dependencies: ["MR-106", "MR-110"],
    acceptance: [
      "Department assistant templates are licensed enterprise features.",
      "Each assistant binds role, memory scopes, providers, tools, channels, and response style.",
      "Open-source personal mode has no license check in the hot path."
    ],
    qa: ["license verifier tests", "RBAC policy matrix", "personal-mode speed regression"],
    evidence: [
      { kind: "docs", label: "Enterprise governance design", status: "pass", source: "docs/superpowers/specs/2026-07-01-enterprise-governance-and-pricing-design.md" },
      { kind: "security", label: "Signed license verifier", status: "missing", source: "not implemented" }
    ],
    speed: "Enterprise policy preflight cached after license load; personal path unchanged.",
    changelog: "Introduces enterprise assistant templates, RBAC boundaries, and license-gated controls."
  },
  {
    id: "MR-108",
    releaseId: "q4-2026",
    type: "Story",
    epic: "Shared Memory",
    title: "Context handoff for reassigned work",
    story: "A bug or project reassignment should carry useful context without leaking private memory.",
    owner: "Memory",
    status: "Next",
    proof: "missing",
    risk: "medium",
    readiness: 24,
    target: "0.3.1",
    dependencies: ["MR-107"],
    acceptance: [
      "Memory scopes include private, session, project, team, role, and tenant lanes.",
      "A handoff packet summarizes prior attempts, files, commands, conclusions, and open questions.",
      "Recipient only sees context allowed by role and project policy."
    ],
    qa: ["handoff fixture tests", "cross-role memory denial tests", "audit receipt checks"],
    evidence: [
      { kind: "docs", label: "Product strategy note", status: "warn", source: "current thread discussion" }
    ],
    changelog: "Adds governed team memory and context handoff design for enterprise workflows."
  },
  {
    id: "MR-109",
    releaseId: "q4-2026",
    type: "Story",
    epic: "Token Control",
    title: "Budgets, chargeback, and alerts",
    story: "Token and model usage should be visible by user, team, channel, provider, and workflow.",
    owner: "FinOps",
    status: "Next",
    proof: "missing",
    risk: "medium",
    readiness: 22,
    target: "0.3.0",
    dependencies: ["MR-105", "MR-107"],
    acceptance: [
      "Budgets exist per org, team, user, channel, model, provider, and workflow.",
      "Soft thresholds notify; hard caps stop or require approval.",
      "Reports export monthly chargeback and leakage-risk summaries."
    ],
    qa: ["budget policy tests", "channel spam throttle tests", "monthly report fixture"],
    evidence: [
      { kind: "docs", label: "Enterprise governance pricing design", status: "pass", source: "docs/superpowers/specs/2026-07-01-enterprise-governance-and-pricing-design.md" }
    ],
    changelog: "Turns the token ledger into enterprise budgets, alerts, and chargeback reports."
  },
  {
    id: "MR-110",
    releaseId: "q1-2027",
    type: "Epic",
    epic: "Frappe / ERPNext",
    title: "DocType-aware hybrid retrieval",
    story: "Frappe answers need DocTypes, fields, roles, workflows, reports, scripts, installed apps, and site permissions.",
    owner: "Frappe",
    status: "Next",
    proof: "missing",
    risk: "high",
    readiness: 31,
    target: "0.4.0",
    dependencies: ["MR-106", "MR-107"],
    acceptance: [
      "Plugin connects to a site with URL, admin/API credentials, and permission probe.",
      "Context builder indexes DocTypes, fields, roles, workflows, installed apps, and docs.",
      "Hybrid graph retrieval separates module, DocType, field, permission, and workflow questions."
    ],
    qa: ["Frappe fixture site", "MariaDB schema probe", "DocType role-safe retrieval tests"],
    evidence: [
      { kind: "docs", label: "Frappe AI guide", status: "pass", source: "website/guide-frappe-ai.html" },
      { kind: "test", label: "Frappe pack readiness", status: "warn", source: "capability pack tests need deeper fixtures" }
    ],
    speed: "Frappe context retrieval p95 target under 150ms after indexing.",
    changelog: "Adds a Frappe/ERPNext context pack with DocType-aware retrieval and permission checks."
  },
  {
    id: "MR-111",
    releaseId: "q2-2027",
    type: "Epic",
    epic: "MCP / Plugin Registry",
    title: "Guided MCP, plugin, and skill induction",
    story: "Users choose a capability, understand impact, authenticate, verify, enable, and run a sample.",
    owner: "Integrations",
    status: "Next",
    proof: "partial",
    risk: "medium",
    readiness: 36,
    target: "0.5.0",
    dependencies: ["MR-103", "MR-107"],
    acceptance: [
      "Every pack has readiness level, auth path, tests, failure behavior, and sample run.",
      "User can add custom MCPs, plugins, and skills.",
      "Provider-authenticated capabilities can be reused when explicitly chosen."
    ],
    qa: ["MCP auth failure tests", "channel/plugin setup tests", "pack readiness scorecard"],
    evidence: [
      { kind: "test", label: "integration-packs test suite", status: "pass", source: "packages/core/test/integration-packs.test.ts" },
      { kind: "live", label: "OAuth setup videos", status: "missing", source: "not captured" }
    ],
    changelog: "Introduces guided capability induction for MCPs, plugins, skills, and provider-authenticated tools."
  },
  {
    id: "MR-112",
    releaseId: "q3-2027",
    type: "Epic",
    epic: "Enterprise GA",
    title: "Admin dashboard, SSO, audit export, and deployment runbooks",
    story: "Enterprise buyers need governance evidence, identity, export, and deployment options before production use.",
    owner: "Enterprise",
    status: "Next",
    proof: "missing",
    risk: "high",
    readiness: 12,
    target: "1.0",
    dependencies: ["MR-107", "MR-109", "MR-110", "MR-111"],
    acceptance: [
      "SSO/OIDC integration is documented and tested.",
      "Audit export includes identity, policy decision, tool calls, token usage, and evidence links.",
      "On-prem/VPC deployment runbooks include secrets, backups, logs, and incident controls."
    ],
    qa: ["SSO fixture", "audit export verifier", "deployment runbook dry run"],
    evidence: [
      { kind: "docs", label: "Enterprise design draft", status: "pass", source: "enterprise governance spec" },
      { kind: "security", label: "CISO-grade review", status: "missing", source: "not scheduled" }
    ],
    changelog: "Moves enterprise control plane toward GA with SSO, audit export, dashboards, and deployment runbooks."
  }
];

const columns: Status[] = ["Now", "Next", "Building", "Evidence Review", "Release Ready"];
const state = {
  releaseId: "q3-2026",
  view: "board",
  selectedId: "MR-101",
  search: "",
  owner: "all",
  proof: "all"
};

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function makeButton(className: string, text = ""): HTMLButtonElement {
  const node = el("button", className, text);
  node.type = "button";
  return node;
}

function pct(value: number): string {
  return `${Math.round(value)}%`;
}

function currentRelease(): Release {
  return releases.find((release) => release.id === state.releaseId) ?? releases[0]!;
}

function filteredItems(): WorkItem[] {
  const term = state.search.trim().toLowerCase();
  return items.filter((item) => {
    const inRelease = item.releaseId === state.releaseId || state.view === "dependencies";
    const ownerOk = state.owner === "all" || item.owner === state.owner;
    const proofOk = state.proof === "all" || item.proof === state.proof;
    const haystack = [
      item.id,
      item.title,
      item.epic,
      item.story,
      item.owner,
      item.status,
      item.target,
      item.evidence.map((evidence) => `${evidence.label} ${evidence.source}`).join(" ")
    ].join(" ").toLowerCase();
    return inRelease && ownerOk && proofOk && (!term || haystack.includes(term));
  });
}

function selectedItem(): WorkItem {
  return items.find((item) => item.id === state.selectedId) ?? filteredItems()[0] ?? items[0]!;
}

function owners(): string[] {
  return Array.from(new Set(items.map((item) => item.owner))).sort();
}

function proofClass(proof: ProofState): string {
  return `proof-${proof}`;
}

function riskClass(risk: RiskLevel): string {
  return `risk-${risk}`;
}

function metric(label: string, value: string, sub: string, kind = ""): HTMLElement {
  const card = el("article", `metric-card ${kind}`.trim());
  card.append(el("span", "mono metric-label", label));
  card.append(el("strong", undefined, value));
  card.append(el("p", undefined, sub));
  return card;
}

function renderReleaseRail(): void {
  $("release-count").textContent = String(releases.length);
  const list = $("release-list");
  list.replaceChildren();
  for (const release of releases) {
    const item = makeButton(`release-button ${release.id === state.releaseId ? "active" : ""}`);
    item.setAttribute("aria-pressed", String(release.id === state.releaseId));
    item.append(el("span", "release-label", release.label));
    item.append(el("strong", undefined, release.theme));
    item.append(el("span", "mono release-meta", `${release.target} - ${release.state}`));
    const bar = el("span", "release-bar");
    const fill = el("span");
    fill.style.width = pct(release.confidence);
    bar.append(fill);
    item.append(bar);
    item.addEventListener("click", () => {
      state.releaseId = release.id;
      const first = items.find((work) => work.releaseId === release.id);
      if (first) state.selectedId = first.id;
      render();
    });
    list.append(item);
  }
}

function renderFilters(): void {
  const owner = $("owner-filter") as HTMLSelectElement;
  if (!owner.options.length) {
    owner.append(new Option("all owners", "all"));
    for (const name of owners()) owner.append(new Option(name, name));
  }
  owner.value = state.owner;
  ($("proof-filter") as HTMLSelectElement).value = state.proof;
  ($("search-input") as HTMLInputElement).value = state.search;
}

function renderMetrics(): void {
  const release = currentRelease();
  const visible = filteredItems();
  const strong = visible.filter((item) => item.proof === "strong").length;
  const missing = visible.filter((item) => item.proof === "missing").length;
  const avgReady = visible.length
    ? visible.reduce((sum, item) => sum + item.readiness, 0) / visible.length
    : release.confidence;
  $("metric-strip").replaceChildren(
    metric("release confidence", pct(avgReady), `${release.target} - ${release.window}`, avgReady > 75 ? "good" : "warn"),
    metric("evidence coverage", pct(release.evidence), `${strong} strong - ${missing} missing`, release.evidence > 65 ? "good" : "warn"),
    metric("open blockers", String(release.blockers), "risks, auth gaps, or proof gaps", release.blockers > 5 ? "danger" : ""),
    metric("velocity", `${release.velocity}/wk`, "planned throughput", "cyan")
  );
}

function card(item: WorkItem): HTMLElement {
  const node = makeButton(`work-card ${item.id === state.selectedId ? "selected" : ""}`);
  node.append(el("span", "mono work-id", `${item.id} - ${item.type}`));
  node.append(el("strong", undefined, item.title));
  node.append(el("p", undefined, item.story));
  const meta = el("div", "card-meta");
  meta.append(el("span", proofClass(item.proof), item.proof));
  meta.append(el("span", riskClass(item.risk), `${item.risk} risk`));
  meta.append(el("span", "mono", item.owner));
  node.append(meta);
  const bar = el("span", "ready-bar");
  const fill = el("span");
  fill.style.width = pct(item.readiness);
  bar.append(fill);
  node.append(bar);
  node.addEventListener("click", () => {
    state.selectedId = item.id;
    renderInspector();
    document.querySelectorAll(".work-card").forEach((entry) => {
      entry.classList.toggle("selected", entry === node);
    });
  });
  return node;
}

function renderBoard(surface: HTMLElement): void {
  const visible = filteredItems();
  const board = el("div", "kanban-board");
  for (const column of columns) {
    const lane = el("section", "kanban-column");
    const laneItems = visible.filter((item) => item.status === column);
    const header = el("header");
    header.append(el("span", "mono", column));
    header.append(el("strong", undefined, String(laneItems.length)));
    lane.append(header);
    const list = el("div", "column-items");
    for (const item of laneItems) list.append(card(item));
    if (!laneItems.length) list.append(el("p", "empty-lane", "No visible work here."));
    lane.append(list);
    board.append(lane);
  }
  surface.append(board);
}

function renderReleases(surface: HTMLElement): void {
  const map = el("div", "release-map");
  for (const release of releases) {
    const releaseItems = items.filter((item) => item.releaseId === release.id);
    const tile = el("article", `release-tile ${release.id === state.releaseId ? "active" : ""}`);
    tile.append(el("span", "mono", release.window));
    tile.append(el("h3", undefined, `${release.label}: ${release.theme}`));
    tile.append(el("p", undefined, release.description));
    const row = el("div", "tile-stats");
    row.append(el("span", undefined, `${releaseItems.length} work items`));
    row.append(el("span", undefined, `${pct(release.confidence)} confidence`));
    row.append(el("span", undefined, `${release.blockers} blockers`));
    tile.append(row);
    const lane = el("div", "timeline-lane");
    const fill = el("span");
    fill.style.width = pct(release.confidence);
    lane.append(fill);
    tile.append(lane);
    tile.addEventListener("click", () => {
      state.releaseId = release.id;
      render();
    });
    map.append(tile);
  }
  surface.append(map);
}

function renderEvidence(surface: HTMLElement): void {
  const rows = el("div", "evidence-ledger");
  for (const item of filteredItems()) {
    for (const evidence of item.evidence) {
      const row = makeButton(`evidence-row ${evidence.status}`);
      row.append(el("span", "mono", item.id));
      row.append(el("strong", undefined, evidence.label));
      row.append(el("span", "evidence-source", evidence.source));
      row.append(el("span", `evidence-pill ${evidence.status}`, `${evidence.kind} - ${evidence.status}`));
      row.addEventListener("click", () => {
        state.selectedId = item.id;
        render();
      });
      rows.append(row);
    }
  }
  surface.append(rows);
}

function renderRisks(surface: HTMLElement): void {
  const riskItems = filteredItems().filter((item) => item.risk !== "low" || item.proof !== "strong");
  const table = el("div", "risk-register");
  const head = el("div", "risk-head");
  ["ID", "Risk", "Why it matters", "Mitigation"].forEach((label) => head.append(el("span", "mono", label)));
  table.append(head);
  for (const item of riskItems) {
    const row = makeButton(`risk-row ${riskClass(item.risk)}`);
    row.append(el("span", "mono", item.id));
    row.append(el("strong", undefined, `${item.risk} - ${item.proof}`));
    row.append(el("span", undefined, item.title));
    row.append(el("span", undefined, item.qa[0] ?? "Add QA gate"));
    row.addEventListener("click", () => {
      state.selectedId = item.id;
      render();
    });
    table.append(row);
  }
  surface.append(table);
}

function renderSpeedMetrics(surface: HTMLElement): void {
  const targets = [
    ["CLI startup", "p95 < 700ms", "Warm local shell startup"],
    ["TUI action", "p95 < 100ms", "Composer, cursor, picker movement"],
    ["Slash picker", "open < 100ms", "No duplicate panes"],
    ["Memory retrieval", "p95 < 75ms", "SQLite/FTS scoped retrieval"],
    ["Channel ack", "p95 < 1s", "Slack/Telegram acknowledgement"],
    ["Provider overhead", "p50 < 250ms", "Before provider call"],
    ["Artifact delivery", "p95 < 3s", "After file or URL exists"]
  ];
  const wrap = el("div", "speed-grid");
  for (const [name, target, proof] of targets) {
    const row = el("article", "speed-card");
    row.append(el("span", "mono", name));
    row.append(el("strong", undefined, target));
    row.append(el("p", undefined, proof));
    wrap.append(row);
  }
  surface.append(wrap);
}

function renderDependencies(surface: HTMLElement): void {
  const wrap = el("div", "dependency-map");
  for (const item of items.filter((entry) => entry.dependencies.length)) {
    const row = makeButton("dependency-row");
    row.append(el("span", "mono", item.id));
    row.append(el("strong", undefined, item.title));
    row.append(el("span", "dependency-arrow", "depends on"));
    row.append(el("span", "mono", item.dependencies.join(", ")));
    row.addEventListener("click", () => {
      state.releaseId = item.releaseId;
      state.selectedId = item.id;
      render();
    });
    wrap.append(row);
  }
  surface.append(wrap);
}

function renderChangelog(surface: HTMLElement): void {
  const wrap = el("div", "changelog-draft");
  for (const item of filteredItems()) {
    const row = el("article", "changelog-row");
    row.append(el("span", "mono", `${item.target} - ${item.id}`));
    row.append(el("p", undefined, item.changelog));
    row.append(el("span", `proof-tag ${proofClass(item.proof)}`, `${item.proof} proof`));
    wrap.append(row);
  }
  surface.append(wrap);
}

function viewTitle(): string {
  return ({
    board: "Board",
    releases: "Quarter flight map",
    evidence: "Proof ledger",
    risks: "Risk register",
    metrics: "Speed and quality targets",
    dependencies: "Dependency map",
    changelog: "Release-note draft"
  } as Record<string, string>)[state.view] ?? "Board";
}

function renderView(): void {
  const surface = $("view-surface");
  surface.replaceChildren();
  $("current-view-title").textContent = viewTitle();
  if (filteredItems().length === 0 && !["metrics", "releases", "dependencies"].includes(state.view)) {
    surface.append(el("p", "empty-state", "No work items match these filters."));
    return;
  }
  if (state.view === "board") renderBoard(surface);
  if (state.view === "releases") renderReleases(surface);
  if (state.view === "evidence") renderEvidence(surface);
  if (state.view === "risks") renderRisks(surface);
  if (state.view === "metrics") renderSpeedMetrics(surface);
  if (state.view === "dependencies") renderDependencies(surface);
  if (state.view === "changelog") renderChangelog(surface);
}

function detailList(title: string, values: string[]): HTMLElement {
  const wrap = el("section", "inspect-section");
  wrap.append(el("h4", undefined, title));
  const ul = el("ul");
  for (const value of values) ul.append(el("li", undefined, value));
  wrap.append(ul);
  return wrap;
}

function renderInspector(): void {
  const item = selectedItem();
  const release = releases.find((entry) => entry.id === item.releaseId)!;
  const panel = $("inspector");
  panel.replaceChildren();
  const header = el("div", "inspect-head");
  header.append(el("span", "mono", `${item.id} - ${item.type}`));
  header.append(el("h3", undefined, item.title));
  header.append(el("p", undefined, item.story));
  panel.append(header);

  const meta = el("div", "inspect-meta");
  [
    ["Release", `${release.label} - ${item.target}`],
    ["Owner", item.owner],
    ["Status", item.status],
    ["Readiness", pct(item.readiness)],
    ["Risk", item.risk],
    ["Proof", item.proof]
  ].forEach(([label, value]) => {
    const cell = el("div");
    cell.append(el("span", "mono", label));
    cell.append(el("strong", undefined, value));
    meta.append(cell);
  });
  panel.append(meta);

  if (item.speed) panel.append(detailList("Speed target", [item.speed]));
  panel.append(detailList("Acceptance criteria", item.acceptance));
  panel.append(detailList("QA gates", item.qa));

  const evidence = el("section", "inspect-section");
  evidence.append(el("h4", undefined, "Evidence"));
  for (const proof of item.evidence) {
    const row = el("div", `inspect-evidence ${proof.status}`);
    row.append(el("span", "mono", `${proof.kind} - ${proof.status}`));
    row.append(el("strong", undefined, proof.label));
    row.append(el("p", undefined, proof.source));
    evidence.append(row);
  }
  panel.append(evidence);

  panel.append(detailList("Dependencies", item.dependencies.length ? item.dependencies : ["No blocking dependencies recorded."]));
  panel.append(detailList("Changelog claim", [item.changelog]));
}

function renderTabs(): void {
  document.querySelectorAll<HTMLButtonElement>(".view-tabs button").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset["view"] === state.view);
  });
}

function render(): void {
  const release = currentRelease();
  $("current-release-label").textContent = `${release.label} - ${release.target} - ${release.state}`;
  renderReleaseRail();
  renderFilters();
  renderMetrics();
  renderTabs();
  renderView();
  renderInspector();
}

document.querySelectorAll<HTMLButtonElement>(".view-tabs button").forEach((tab) => {
  tab.addEventListener("click", () => {
    state.view = tab.dataset["view"] ?? "board";
    render();
  });
});

($("search-input") as HTMLInputElement).addEventListener("input", (event) => {
  state.search = (event.currentTarget as HTMLInputElement).value;
  renderMetrics();
  renderView();
});

($("owner-filter") as HTMLSelectElement).addEventListener("change", (event) => {
  state.owner = (event.currentTarget as HTMLSelectElement).value;
  render();
});

($("proof-filter") as HTMLSelectElement).addEventListener("change", (event) => {
  state.proof = (event.currentTarget as HTMLSelectElement).value;
  render();
});

$("focus-release").addEventListener("click", () => {
  state.releaseId = "q3-2026";
  state.view = "board";
  state.selectedId = "MR-101";
  state.search = "";
  state.owner = "all";
  state.proof = "all";
  render();
});

$("copy-summary").addEventListener("click", async () => {
  const release = currentRelease();
  const summary = [
    `Muster Roadmap Control - ${release.label}`,
    `Theme: ${release.theme}`,
    `Target: ${release.target}`,
    `Confidence: ${pct(release.confidence)}`,
    `Evidence coverage: ${pct(release.evidence)}`,
    `Blockers: ${release.blockers}`,
    "",
    "Top work:",
    ...items.filter((item) => item.releaseId === release.id).slice(0, 5).map((item) => `- ${item.id}: ${item.title} (${item.status}, ${item.proof} proof)`)
  ].join("\n");
  try {
    await navigator.clipboard.writeText(summary);
    ($("copy-summary") as HTMLButtonElement).textContent = "Copied summary";
    setTimeout(() => (($("copy-summary") as HTMLButtonElement).textContent = "Copy executive summary"), 1400);
  } catch {
    window.prompt("Copy roadmap summary", summary);
  }
});

render();
