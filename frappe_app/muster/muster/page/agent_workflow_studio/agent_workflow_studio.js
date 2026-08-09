frappe.pages["agent-workflow-studio"].on_page_load = function (wrapper) {
  new MusterStudio(wrapper);
};

class MusterStudio {
  constructor(wrapper) {
    this.page = frappe.ui.make_app_page({
      parent: wrapper,
      title: __("Agent & Workflow Studio"),
      single_column: true,
    });
    this.state = {mode: "workflow", selected: null, agents: [], workflows: [], graph: null, context: null};
    this.page.set_primary_action(__("Save draft"), () => this.save(), "save");
    this.page.add_action_item(__("Validate"), () => this.validate());
    this.page.add_action_item(__("Publish version"), () => this.publish());
    this.page.add_menu_item(__("Standard Agent list"), () => frappe.set_route("List", "Muster Agent"));
    this.page.add_menu_item(__("Standard Workflow list"), () => frappe.set_route("List", "Muster Workflow"));
    this.mount();
    this.initialize();
  }

  mount() {
    this.root = document.createElement("div");
    this.root.className = "muster-studio";
    this.root.innerHTML = `
      <aside class="muster-studio-nav" aria-label="${__("Studio records")}">
        <div class="muster-studio-tabs" role="tablist">
          <button role="tab" data-mode="workflow" aria-selected="true">${__("Workflows")}</button>
          <button role="tab" data-mode="agent" aria-selected="false">${__("Agents")}</button>
        </div>
        <label class="sr-only" for="muster-studio-search">${__("Search records")}</label>
        <input id="muster-studio-search" class="form-control" type="search" placeholder="${__("Search")}" />
        <button class="btn btn-sm btn-default muster-studio-new">${__("New workflow")}</button>
        <div class="muster-studio-records" role="listbox"></div>
      </aside>
      <main class="muster-studio-main"><div class="muster-studio-welcome"><img src="/assets/muster/images/muster-mark.png" alt=""/><h2>${__("Build governed automation")}</h2><p>${__("Select a draft or create one. Standard DocType forms remain available from the menu.")}</p></div></main>
      <aside class="muster-studio-inspector" aria-label="${__("Selection inspector")}"><h3>${__("Inspector")}</h3><div class="muster-studio-inspector-body"><p class="text-muted">${__("Select a graph node to edit its controls.")}</p></div></aside>
      <div class="sr-only" aria-live="polite" data-studio-live></div>`;
    this.page.main.get(0).appendChild(this.root);
    this.main = this.root.querySelector(".muster-studio-main");
    this.inspector = this.root.querySelector(".muster-studio-inspector-body");
    this.live = this.root.querySelector("[data-studio-live]");
    this.root.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", () => this.switchMode(button.dataset.mode)));
    this.root.querySelector("#muster-studio-search").addEventListener("input", () => this.renderList());
    this.root.querySelector(".muster-studio-new").addEventListener("click", () => this.newRecord());
    this.root.querySelector(".muster-studio-records").addEventListener("click", (event) => {
      const item = event.target.closest("[data-name]");
      if (item) this.load(item.dataset.name);
    });
  }

  async initialize() {
    try {
      const [context, agents, workflows, policies, users] = await Promise.all([
        this.call("muster.api.studio.context"),
        frappe.db.get_list("Muster Agent", {fields: ["name", "agent_name", "agent_type", "status", "modified"], order_by: "modified desc", limit: 200}),
        frappe.db.get_list("Muster Workflow", {fields: ["name", "workflow_name", "status", "version", "modified"], order_by: "modified desc", limit: 200}),
        frappe.db.get_list("Muster Policy", {fields: ["name"], filters: {enabled: 1}, order_by: "name", limit: 200}),
        frappe.db.get_list("User", {fields: ["name", "full_name"], filters: {enabled: 1}, order_by: "full_name", limit: 200}),
      ]);
      this.state.context = context;
      this.state.agents = agents;
      this.state.workflows = workflows;
      this.state.policies = policies;
      this.state.users = users;
      this.renderList();
    } catch (error) {
      this.main.innerHTML = `<div class="muster-studio-error">${__("Studio could not be loaded. Check your Muster role and retry.")}</div>`;
      console.error("Muster Studio initialization failed", error);
    }
  }

  async call(method, args = {}, type = "GET") {
    const response = await frappe.call({method, args, type});
    return response.message;
  }

  switchMode(mode) {
    this.state.mode = mode;
    this.state.selected = null;
    this.state.graph = null;
    this.root.querySelectorAll("[data-mode]").forEach((button) => button.setAttribute("aria-selected", String(button.dataset.mode === mode)));
    this.root.querySelector(".muster-studio-new").textContent = mode === "agent" ? __("New agent") : __("New workflow");
    this.renderList();
    this.newRecord();
  }

  renderList() {
    const safe = frappe.utils.escape_html;
    const query = this.root.querySelector("#muster-studio-search").value.trim().toLowerCase();
    const rows = this.state.mode === "agent" ? this.state.agents : this.state.workflows;
    const filtered = rows.filter((row) => row.name.toLowerCase().includes(query));
    this.root.querySelector(".muster-studio-records").innerHTML = filtered.map((row) => `
      <button role="option" data-name="${safe(row.name)}" aria-selected="${row.name === this.state.selected}">
        <strong>${safe(row.name)}</strong><small>${safe(row.status || row.agent_type || "Draft")}</small>
      </button>`).join("") || `<p class="text-muted">${__("No matching records")}</p>`;
  }

  async load(name) {
    this.state.selected = name;
    this.renderList();
    const method = this.state.mode === "agent" ? "muster.api.studio.get_agent" : "muster.api.studio.get_workflow";
    const data = await this.call(method, {name});
    if (this.state.mode === "agent") this.renderAgent(data);
    else this.renderWorkflow(data);
  }

  newRecord() {
    this.state.selected = null;
    if (this.state.mode === "agent") this.renderAgent({
      status: "Draft", agent_type: "Specialist", max_depth: 3, max_fan_out: 8,
      max_tool_calls: 50, capabilities: [], delegations: [],
    });
    else this.renderWorkflow({
      status: "Draft", version: 1, nodes: [], edges: [], max_duration_minutes: 60,
      max_tool_calls: 100, max_model_calls: 50, max_tokens: 500000,
      max_artifact_bytes: 104857600,
    });
    this.renderList();
  }

  options(items, selected, label = (item) => item.name) {
    const safe = frappe.utils.escape_html;
    return `<option value=""></option>${(items || []).map((item) => `<option value="${safe(item.name)}" ${item.name === selected ? "selected" : ""}>${safe(label(item))}</option>`).join("")}`;
  }

  field(label, name, value = "", type = "text", extra = "") {
    const safe = frappe.utils.escape_html;
    return `<label class="muster-studio-field"><span>${label}</span><input class="form-control" name="${name}" type="${type}" value="${safe(String(value ?? ""))}" ${extra}/></label>`;
  }

  renderAgent(agent) {
    this.state.agent = structuredClone(agent);
    const safe = frappe.utils.escape_html;
    this.main.innerHTML = `<form class="muster-agent-editor">
      <header><div><p class="muster-eyebrow">${__("Agent definition")}</p><h2>${safe(agent.agent_name || __("New agent"))}</h2></div>${agent.name ? `<a class="btn btn-sm btn-default" href="/desk/muster-agent/${encodeURIComponent(agent.name)}">${__("Open standard form")}</a>` : ""}</header>
      <div class="muster-studio-form-grid">
        ${this.field(__("Agent name"), "agent_name", agent.agent_name, "text", agent.name ? "readonly" : "required")}
        <label class="muster-studio-field"><span>${__("Status")}</span><select class="form-control" name="status">${["Draft", "Active", "Suspended", "Retired"].map((value) => `<option ${value === agent.status ? "selected" : ""}>${value}</option>`).join("")}</select></label>
        <label class="muster-studio-field"><span>${__("Type")}</span><select class="form-control" name="agent_type">${["Business", "Module", "DocType", "Specialist", "Supervisor"].map((value) => `<option ${value === agent.agent_type ? "selected" : ""}>${value}</option>`).join("")}</select></label>
        <label class="muster-studio-field"><span>${__("Policy")}</span><select class="form-control" name="policy" required>${this.options(this.state.policies, agent.policy)}</select></label>
        <label class="muster-studio-field muster-span-2"><span>${__("Purpose")}</span><textarea class="form-control" name="description" required>${safe(agent.description || "")}</textarea></label>
        <label class="muster-studio-field"><span>${__("Service user")}</span><select class="form-control" name="run_as_user">${this.options(this.state.users, agent.run_as_user, (item) => item.full_name ? `${item.full_name} · ${item.name}` : item.name)}</select></label>
        ${this.field(__("Module scope"), "module_scope", agent.module_scope)}
        ${this.field(__("DocType scope"), "doctype_scope", agent.doctype_scope)}
        ${this.field(__("Model profile"), "model_profile", agent.model_profile)}
        ${this.field(__("Max depth"), "max_depth", agent.max_depth, "number", "min=\"0\"")}
        ${this.field(__("Max fan-out"), "max_fan_out", agent.max_fan_out, "number", "min=\"0\"")}
        ${this.field(__("Max tool calls"), "max_tool_calls", agent.max_tool_calls, "number", "min=\"0\"")}
        <label class="muster-studio-field muster-span-2"><span>${__("System instructions")}</span><textarea class="form-control muster-code" name="instructions" required>${safe(agent.instructions || "")}</textarea></label>
        <label class="muster-studio-field muster-span-2"><span>${__("Capabilities — capability | resource | risk | approval(0/1)")}</span><textarea class="form-control muster-code" name="capabilities_text">${safe((agent.capabilities || []).map((row) => [row.capability, row.resource_pattern, row.risk_class, row.requires_approval ? 1 : 0].join(" | ")).join("\n"))}</textarea></label>
        <label class="muster-studio-field muster-span-2"><span>${__("Delegation — agent | capabilities(comma) | depth | fan-out | approval(0/1)")}</span><textarea class="form-control muster-code" name="delegations_text">${safe((agent.delegations || []).map((row) => [row.delegate_agent, String(row.allowed_capabilities || "").replace(/\n/g, ","), row.max_depth, row.max_fan_out, row.requires_approval ? 1 : 0].join(" | ")).join("\n"))}</textarea></label>
      </div></form>`;
    this.inspector.innerHTML = `<p>${__("Agent permissions are an upper-bound request. Live Frappe permissions and policy are rechecked before every effect.")}</p>`;
  }

  renderWorkflow(workflow) {
    this.state.workflow = structuredClone(workflow);
    const publicationScope = `${workflow.name || "new"}|${workflow.modified || "draft"}`;
    if (this.state.publicationScope !== publicationScope) {
      this.state.publicationScope = publicationScope;
      this.state.publicationKey = frappe.utils.get_random(32);
    }
    this.state.graph = {nodes: structuredClone(workflow.nodes || []), edges: structuredClone(workflow.edges || [])};
    const safe = frappe.utils.escape_html;
    this.main.innerHTML = `<section class="muster-workflow-editor">
      <header><div><p class="muster-eyebrow">${__("Draft graph")}</p><h2>${safe(workflow.workflow_name || __("New workflow"))}</h2><small>${__("Draft revision")} ${workflow.version || 1} · ${safe(workflow.status || "Draft")}</small></div>${workflow.name ? `<a class="btn btn-sm btn-default" href="/desk/muster-workflow/${encodeURIComponent(workflow.name)}">${__("Open standard form")}</a>` : ""}</header>
      <form class="muster-workflow-fields"><div class="muster-studio-form-grid">
        ${this.field(__("Workflow name"), "workflow_name", workflow.workflow_name, "text", workflow.name ? "readonly" : "required")}
        <label class="muster-studio-field"><span>${__("Root agent")}</span><select class="form-control" name="root_agent" required>${this.options(this.state.agents, workflow.root_agent)}</select></label>
        <label class="muster-studio-field"><span>${__("Policy")}</span><select class="form-control" name="policy" required>${this.options(this.state.policies, workflow.policy)}</select></label>
        ${this.field(__("Runtime minutes"), "max_duration_minutes", workflow.max_duration_minutes, "number", "min=\"0\"")}
        ${this.field(__("Tool calls"), "max_tool_calls", workflow.max_tool_calls, "number", "min=\"0\"")}
        ${this.field(__("Model calls"), "max_model_calls", workflow.max_model_calls, "number", "min=\"0\"")}
        ${this.field(__("Tokens"), "max_tokens", workflow.max_tokens, "number", "min=\"0\"")}
        ${this.field(__("Maximum cost"), "max_cost", workflow.max_cost || 0, "number", "min=\"0\" step=\"0.01\"")}
        ${this.field(__("Artifact bytes"), "max_artifact_bytes", workflow.max_artifact_bytes, "number", "min=\"0\"")}
        <label class="muster-studio-field muster-span-2"><span>${__("Business outcome")}</span><textarea class="form-control" name="description" required>${safe(workflow.description || "")}</textarea></label>
      </div></form>
      <div class="muster-graph-toolbar"><button class="btn btn-sm btn-default" data-add-node>${__("Add node")}</button><button class="btn btn-sm btn-default" data-add-edge>${__("Connect nodes")}</button><span data-graph-summary></span></div>
      <div class="muster-graph-canvas" role="group" aria-label="${__("Workflow graph")}"><svg aria-hidden="true"></svg><div class="muster-graph-nodes"></div></div>
      <section class="muster-edge-list"><h3>${__("Connections")}</h3><div data-edge-list></div></section>
    </section>`;
    this.main.querySelector("[data-add-node]").addEventListener("click", () => this.addNode());
    this.main.querySelector("[data-add-edge]").addEventListener("click", () => this.addEdge());
    this.main.querySelector(".muster-graph-nodes").addEventListener("click", (event) => {
      const node = event.target.closest("[data-node-id]");
      if (node) this.selectNode(node.dataset.nodeId);
    });
    this.main.querySelector("[data-edge-list]").addEventListener("click", (event) => {
      const button = event.target.closest("[data-delete-edge]");
      if (button) { this.state.graph.edges.splice(Number(button.dataset.deleteEdge), 1); this.renderGraph(); }
    });
    this.renderGraph();
  }

  renderGraph() {
    const safe = frappe.utils.escape_html;
    const result = musterWorkflowGraph.validateGraph(this.state.graph, this.state.context?.limits);
    const order = result.analysis.topologicalOrder.length ? result.analysis.topologicalOrder : this.state.graph.nodes.map((node) => node.node_id);
    const byId = new Map(this.state.graph.nodes.map((node) => [node.node_id, node]));
    this.main.querySelector(".muster-graph-nodes").innerHTML = order.filter((id) => byId.has(id)).map((id) => {
      const node = byId.get(id);
      return `<button class="muster-graph-node" data-node-id="${safe(id)}" aria-label="${safe(`${node.label || id}, ${node.node_type}`)}"><span class="muster-node-kind">${safe(node.node_type)}</span><strong>${safe(node.label || id)}</strong><small>${safe(node.agent || node.approval_class || "")}</small></button>`;
    }).join("") || `<div class="muster-graph-empty">${__("Add a node to begin. Published graphs are immutable snapshots; this canvas edits only the draft.")}</div>`;
    this.main.querySelector("[data-edge-list]").innerHTML = this.state.graph.edges.map((edge, index) => `<div><code>${safe(edge.source_node)} → ${safe(edge.target_node)}</code><span>${safe(edge.condition_expression || __("always"))}</span><button class="btn btn-xs btn-default" data-delete-edge="${index}" aria-label="${__("Delete connection")}">×</button></div>`).join("") || `<p class="text-muted">${__("No connections")}</p>`;
    this.main.querySelector("[data-graph-summary]").textContent = result.valid ? `${result.analysis.nodeCount} ${__("nodes")} · ${result.analysis.edgeCount} ${__("edges")} · ${__("depth")} ${result.analysis.depth}` : `${result.issues.length} ${__("validation issues")}`;
    this.renderIssues(result);
    requestAnimationFrame(() => this.drawEdges());
  }

  drawEdges() {
    const canvas = this.main.querySelector(".muster-graph-canvas");
    const svg = canvas.querySelector("svg");
    const bounds = canvas.getBoundingClientRect();
    svg.setAttribute("viewBox", `0 0 ${bounds.width} ${bounds.height}`);
    svg.innerHTML = this.state.graph.edges.map((edge) => {
      const from = canvas.querySelector(`[data-node-id="${CSS.escape(edge.source_node)}"]`);
      const to = canvas.querySelector(`[data-node-id="${CSS.escape(edge.target_node)}"]`);
      if (!from || !to) return "";
      const a = from.getBoundingClientRect(); const b = to.getBoundingClientRect();
      const x1 = a.right - bounds.left; const y1 = a.top + a.height / 2 - bounds.top;
      const x2 = b.left - bounds.left; const y2 = b.top + b.height / 2 - bounds.top;
      const bend = Math.max(30, (x2 - x1) / 2);
      return `<path d="M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}"/>`;
    }).join("");
  }

  renderIssues(result) {
    const safe = frappe.utils.escape_html;
    this.inspector.innerHTML = `<h4>${result.valid ? __("Graph is valid") : __("Validation")}</h4>${result.valid ? `<dl class="muster-analysis"><div><dt>${__("Entry")}</dt><dd>${safe(result.analysis.root)}</dd></div><div><dt>${__("Agent depth")}</dt><dd>${result.analysis.depth}</dd></div><div><dt>${__("Fan-out")}</dt><dd>${result.analysis.maximumFanOut}</dd></div></dl>` : `<ul class="muster-issues">${result.issues.map((issue) => `<li><strong>${safe(issue.code)}</strong>${safe(issue.message)}<small>${safe(issue.path)}</small></li>`).join("")}</ul>`}`;
  }

  selectNode(nodeId) {
    const node = this.state.graph.nodes.find((item) => item.node_id === nodeId);
    if (!node) return;
    const config = this.parseConfiguration(node.configuration_json);
    const safe = frappe.utils.escape_html;
    this.inspector.innerHTML = `<form class="muster-node-inspector"><h4>${safe(nodeId)}</h4>
      ${this.field(__("Label"), "label", node.label)}
      <label class="muster-studio-field"><span>${__("Type")}</span><select class="form-control" name="node_type">${["Agent", "Tool", "Approval", "Condition", "Parallel", "Join", "Bounded Loop", "Artifact"].map((value) => `<option ${value === node.node_type ? "selected" : ""}>${value}</option>`).join("")}</select></label>
      <label class="muster-studio-field"><span>${__("Agent")}</span><select class="form-control" name="agent">${this.options(this.state.agents, node.agent)}</select></label>
      <label class="muster-studio-field"><span>${__("Approval")}</span><select class="form-control" name="approval_class">${["None", "Standard", "Sensitive", "Privileged Code", "Destructive"].map((value) => `<option ${value === node.approval_class ? "selected" : ""}>${value}</option>`).join("")}</select></label>
      ${this.field(__("Retry limit"), "retry_limit", node.retry_limit ?? 0, "number", `min="0" max="${this.state.context?.limits?.maxRetries || 3}"`)}
      ${this.field(__("Timeout seconds"), "timeout_seconds", node.timeout_seconds || 600, "number", "min=\"1\" max=\"86400\"")}
      <label class="muster-studio-field"><span>${__("Portable kind override")}</span><select class="form-control" name="core_kind">${["", "plan", "agent", "subworkflow", "command", "transform", "condition", "parallel_map", "approval", "wait", "artifact", "verification", "compensation", "loop"].map((value) => `<option value="${value}" ${value === (config.core_kind || "") ? "selected" : ""}>${value || __("Automatic")}</option>`).join("")}</select></label>
      <label class="muster-studio-field"><span>${__("Requested capabilities, one per line")}</span><textarea class="form-control" name="requested_capabilities">${safe((config.requested_capabilities || []).join("\n"))}</textarea></label>
      <div data-loop-fields ${node.node_type === "Bounded Loop" ? "" : "hidden"}>${this.field(__("Maximum iterations"), "max_iterations", config.max_iterations || 3, "number", "min=\"1\" max=\"100\"")}${this.field(__("Progress predicate"), "progress_predicate", config.progress_predicate || "progress > previous_progress")}</div>
      <div class="muster-inspector-actions"><button class="btn btn-sm btn-primary" type="submit">${__("Apply")}</button><button class="btn btn-sm btn-danger" type="button" data-delete-node>${__("Delete node")}</button></div>
    </form>`;
    const form = this.inspector.querySelector("form");
    form.node_type.addEventListener("change", () => form.querySelector("[data-loop-fields]").hidden = form.node_type.value !== "Bounded Loop");
    form.addEventListener("submit", (event) => {
      event.preventDefault(); const values = Object.fromEntries(new FormData(form));
      Object.assign(node, {label: values.label, node_type: values.node_type, agent: values.agent || null, approval_class: values.approval_class, retry_limit: Number(values.retry_limit), timeout_seconds: Number(values.timeout_seconds)});
      const nextConfig = {...config, requested_capabilities: values.requested_capabilities.split("\n").map((item) => item.trim()).filter(Boolean)};
      if (values.core_kind) nextConfig.core_kind = values.core_kind; else delete nextConfig.core_kind;
      if (values.node_type === "Bounded Loop") { nextConfig.max_iterations = Number(values.max_iterations); nextConfig.progress_predicate = values.progress_predicate; }
      else { delete nextConfig.max_iterations; delete nextConfig.progress_predicate; }
      node.configuration_json = JSON.stringify(nextConfig);
      this.renderGraph(); this.selectNode(nodeId); this.announce(__("Node updated"));
    });
    form.querySelector("[data-delete-node]").addEventListener("click", () => {
      this.state.graph.nodes = this.state.graph.nodes.filter((item) => item.node_id !== nodeId);
      this.state.graph.edges = this.state.graph.edges.filter((edge) => edge.source_node !== nodeId && edge.target_node !== nodeId);
      this.renderGraph(); this.announce(__("Node deleted"));
    });
  }

  parseConfiguration(value) { try { return value ? (typeof value === "string" ? JSON.parse(value) : value) : {}; } catch { return {}; } }

  addNode() {
    const dialog = new frappe.ui.Dialog({title: __("Add workflow node"), fields: [
      {fieldname: "node_id", fieldtype: "Data", label: __("Node ID"), reqd: 1},
      {fieldname: "label", fieldtype: "Data", label: __("Label"), reqd: 1},
      {fieldname: "node_type", fieldtype: "Select", options: "Agent\nTool\nApproval\nCondition\nParallel\nJoin\nBounded Loop\nArtifact", default: "Agent", label: __("Type"), reqd: 1},
      {fieldname: "agent", fieldtype: "Link", options: "Muster Agent", label: __("Agent")},
    ], primary_action_label: __("Add"), primary_action: (values) => {
      this.state.graph.nodes.push({...values, approval_class: "Standard", retry_limit: 1, timeout_seconds: 600, configuration_json: values.node_type === "Bounded Loop" ? JSON.stringify({max_iterations: 3, progress_predicate: "progress > previous_progress"}) : "{}"});
      dialog.hide(); this.renderGraph(); this.selectNode(values.node_id);
    }}); dialog.show();
  }

  addEdge() {
    if (this.state.graph.nodes.length < 2) { frappe.msgprint(__("Add at least two nodes first.")); return; }
    const options = this.state.graph.nodes.map((node) => node.node_id).join("\n");
    const dialog = new frappe.ui.Dialog({title: __("Connect nodes"), fields: [
      {fieldname: "source_node", fieldtype: "Select", options, label: __("From"), reqd: 1},
      {fieldname: "target_node", fieldtype: "Select", options, label: __("To"), reqd: 1},
      {fieldname: "condition_expression", fieldtype: "Data", label: __("Condition (stored, never evaluated in Studio)")},
    ], primary_action_label: __("Connect"), primary_action: (values) => { this.state.graph.edges.push({...values, priority: (this.state.graph.edges.length + 1) * 10}); dialog.hide(); this.renderGraph(); }}); dialog.show();
  }

  workflowPayload() {
    const form = this.main.querySelector(".muster-workflow-fields");
    const values = Object.fromEntries(new FormData(form));
    ["max_duration_minutes", "max_tool_calls", "max_model_calls", "max_tokens", "max_cost", "max_artifact_bytes"].forEach((field) => values[field] = Number(values[field] || 0));
    return {...this.state.workflow, ...values, nodes: this.state.graph.nodes, edges: this.state.graph.edges, expected_modified: this.state.workflow.modified};
  }

  agentPayload() {
    const form = this.main.querySelector(".muster-agent-editor"); const values = Object.fromEntries(new FormData(form));
    ["max_depth", "max_fan_out", "max_tool_calls"].forEach((field) => values[field] = Number(values[field] || 0));
    values.capabilities = values.capabilities_text.split("\n").map((line) => line.split("|").map((item) => item.trim())).filter((parts) => parts[0]).map(([capability, resource_pattern, risk_class, approval]) => ({capability, resource_pattern, risk_class: risk_class || "Moderate", requires_approval: Number(approval || 0)}));
    values.delegations = values.delegations_text.split("\n").map((line) => line.split("|").map((item) => item.trim())).filter((parts) => parts[0]).map(([delegate_agent, capabilities, depth, fanout, approval]) => ({delegate_agent, allowed_capabilities: capabilities.split(",").map((item) => item.trim()).filter(Boolean).join("\n"), max_depth: Number(depth || 0), max_fan_out: Number(fanout || 0), requires_approval: Number(approval || 0)}));
    delete values.capabilities_text; delete values.delegations_text;
    return {...this.state.agent, ...values, expected_modified: this.state.agent.modified};
  }

  async save() {
    try {
      if (this.state.mode === "workflow") {
        const client = musterWorkflowGraph.validateGraph(this.state.graph, this.state.context?.limits);
        if (!client.valid) { this.renderIssues(client); frappe.throw(__("Resolve graph validation issues before saving.")); }
        const saved = await this.call("muster.api.studio.save_workflow", {payload: JSON.stringify(this.workflowPayload())}, "POST");
        this.state.selected = saved.name; this.renderWorkflow(saved);
      } else {
        const saved = await this.call("muster.api.studio.save_agent", {payload: JSON.stringify(this.agentPayload())}, "POST");
        this.state.selected = saved.name; this.renderAgent(saved);
      }
      await this.refreshLists(); this.announce(__("Draft saved")); frappe.show_alert({message: __("Draft saved"), indicator: "green"});
    } catch (error) { console.error("Muster Studio save failed", error); }
  }

  async validate() {
    if (this.state.mode !== "workflow") { frappe.show_alert({message: __("Agent validation runs when saved"), indicator: "blue"}); return; }
    const result = await this.call("muster.api.studio.validate_workflow", {payload: JSON.stringify(this.workflowPayload())}, "POST");
    this.renderIssues(result.valid ? {valid: true, analysis: {root: result.analysis.root, depth: result.analysis.depth, maximumFanOut: result.analysis.maximum_fan_out}} : result);
    frappe.show_alert({message: result.valid ? __("Workflow is valid") : __("Workflow has validation issues"), indicator: result.valid ? "green" : "red"});
  }

  async publish() {
    if (this.state.mode !== "workflow" || !this.state.workflow.name) { frappe.msgprint(__("Save the workflow draft before publishing.")); return; }
    const confirmed = await new Promise((resolve) => frappe.confirm(__("Publish an immutable AgentGraphDefinition snapshot of this draft?"), () => resolve(true), () => resolve(false)));
    if (!confirmed) return;
    const result = await this.call("muster.api.studio.publish_workflow", {workflow: this.state.workflow.name, expected_modified: this.state.workflow.modified, idempotency_key: this.state.publicationKey}, "POST");
    frappe.msgprint({title: result.replayed ? __("Version already published") : __("Workflow published"), message: `${frappe.utils.escape_html(result.version)}<br><code>${frappe.utils.escape_html(result.snapshot_hash)}</code>`, indicator: "green"});
    await this.load(this.state.workflow.name);
  }

  async refreshLists() {
    [this.state.agents, this.state.workflows] = await Promise.all([
      frappe.db.get_list("Muster Agent", {fields: ["name", "agent_name", "agent_type", "status", "modified"], order_by: "modified desc", limit: 200}),
      frappe.db.get_list("Muster Workflow", {fields: ["name", "workflow_name", "status", "version", "modified"], order_by: "modified desc", limit: 200}),
    ]); this.renderList();
  }

  announce(message) { this.live.textContent = ""; requestAnimationFrame(() => this.live.textContent = message); }
}
