frappe.pages["muster-control"].on_page_load = function (wrapper) {
  const page = frappe.ui.make_app_page({
    parent: wrapper,
    title: __("Muster Mission Control"),
    single_column: true,
  });

  page.set_primary_action(__("New Mission"), () => openNewMissionDialog(), "play");
  page.add_menu_item(__("Agents"), () => frappe.set_route("List", "Muster Agent"));
  page.add_menu_item(__("Workflows"), () => frappe.set_route("List", "Muster Workflow"));
  page.add_menu_item(__("Agent & Workflow Studio"), () => frappe.set_route("agent-workflow-studio"));
  page.add_menu_item(__("Evidence Registry"), () => frappe.set_route("muster-evidence"));
  page.add_menu_item(__("Settings"), () => frappe.set_route("Form", "Muster Settings"));

  const shell = document.createElement("div");
  shell.className = "muster-control";
  shell.innerHTML = `
    <section class="muster-hero" aria-labelledby="muster-heading">
      <div><p class="muster-eyebrow">${__("AI automation, governed by Frappe")}</p>
      <h2 id="muster-heading">${__("What outcome should your team achieve?")}</h2>
      <p>${__("Plan, approve, observe and verify work while you continue elsewhere in Desk.")}</p></div>
      <img src="/assets/muster/images/muster-mark.png" alt="Muster" />
    </section>
    <section class="muster-composer" aria-labelledby="muster-composer-heading">
      <div class="muster-composer-heading">
        <div><p class="muster-eyebrow">${__("Ask Muster")}</p><h3 id="muster-composer-heading">${__("Describe the result you need")}</h3><span class="muster-runtime-state" data-connected="${Boolean(frappe.boot.muster.execution_enabled)}">${frappe.boot.muster.execution_enabled ? __("AI runtime connected") : __("AI runtime setup required")}</span></div>
        <button class="btn btn-sm btn-default muster-advanced" type="button">${__("Workflow & options")}</button>
      </div>
      <label class="sr-only" for="muster-objective">${__("Prompt or business outcome")}</label>
      <textarea id="muster-objective" class="form-control muster-objective" rows="3" placeholder="${__("For example: review overdue invoices, group them by risk, draft customer follow-ups, and ask me before sending anything.")}"></textarea>
      <div class="muster-composer-footer">
        <div class="muster-prompt-examples" aria-label="${__("Example prompts")}">
          <button type="button" data-prompt="${__("Prepare today's HR and attendance exceptions for review")}">${__("HR exceptions")}</button>
          <button type="button" data-prompt="${__("Find overdue invoices, prioritize collection risk, and draft follow-ups")}">${__("Invoice follow-up")}</button>
          <button type="button" data-prompt="${__("Review open support cases and propose owners and next actions")}">${__("Support triage")}</button>
        </div>
        <button class="btn btn-primary muster-submit" type="button"><span>${__("Plan mission")}</span><span aria-hidden="true">→</span></button>
      </div>
      <p class="muster-composer-help">${__("Muster will show its plan, agents, approvals, changes and evidence here. Press Ctrl/⌘ + Enter to start.")}</p>
    </section>
    <section class="muster-stats" aria-label="${__("Mission summary")}"></section>
    <div class="muster-grid">
      <section class="muster-panel"><header><h3>${__("Active Missions")}</h3><button class="btn btn-xs btn-default muster-refresh">${__("Refresh")}</button></header><div class="muster-missions" aria-live="polite"></div></section>
      <section class="muster-panel muster-focus"><header><h3>${__("Work in focus")}</h3></header><div class="muster-empty">${__("Select a mission to inspect its agent tree, changes, approvals and evidence.")}</div></section>
    </div>`;
  page.main.get(0).appendChild(shell);

  let selectedMission = null;

  shell.querySelector(".muster-refresh").addEventListener("click", refreshAll);
  const objectiveInput = shell.querySelector(".muster-objective");
  const submitButton = shell.querySelector(".muster-submit");
  shell.querySelector(".muster-advanced").addEventListener("click", openNewMissionDialog);
  shell.querySelectorAll("[data-prompt]").forEach((button) => button.addEventListener("click", () => {
    objectiveInput.value = button.dataset.prompt;
    objectiveInput.focus();
  }));
  objectiveInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submitInlineMission();
    }
  });
  submitButton.addEventListener("click", submitInlineMission);
  shell.addEventListener("click", (event) => {
    const row = event.target.closest("[data-mission]");
    if (row) showMission(row.dataset.mission);
  });

  async function loadMissions() {
    const container = shell.querySelector(".muster-missions");
    container.innerHTML = `<div class="muster-loading">${__("Loading missions…")}</div>`;
    try {
      const rows = await frappe.db.get_list("Muster Mission", {
        fields: ["name", "objective", "status", "progress", "requested_by", "modified"],
        order_by: "modified desc", limit: 30,
      });
      const active = rows.filter((row) => !["Completed", "Failed", "Cancelled"].includes(row.status));
      shell.querySelector(".muster-stats").innerHTML = [
        [active.length, __("Active")],
        [rows.filter((row) => row.status === "Waiting for Approval").length, __("Awaiting approval")],
        [rows.filter((row) => row.status === "Needs Intervention").length, __("Needs intervention")],
      ].map(([value, label]) => `<div><strong>${frappe.utils.escape_html(String(value))}</strong><span>${label}</span></div>`).join("");
      container.innerHTML = rows.length ? rows.map(missionRow).join("") : `<div class="muster-empty">${__("No missions yet. Start with a business outcome.")}</div>`;
    } catch (error) {
      container.innerHTML = `<div class="muster-error">${__("Missions could not be loaded.")}</div>`;
      console.error("Muster mission load failed", error);
    }
  }

  function missionRow(row) {
    const safe = frappe.utils.escape_html;
    return `<button class="muster-mission" data-mission="${safe(row.name)}"><span class="muster-status" data-status="${safe(row.status)}"></span><span class="muster-mission-copy"><strong>${safe(row.objective)}</strong><small>${safe(row.name)} · ${safe(row.status)}</small><span class="muster-progress"><i style="width:${Math.max(0, Math.min(100, row.progress || 0))}%"></i></span></span><span>${Math.round(row.progress || 0)}%</span></button>`;
  }

  async function showMission(name) {
    selectedMission = name;
    const focus = shell.querySelector(".muster-focus");
    focus.innerHTML = `<header><h3>${__("Work in focus")}</h3></header><div class="muster-loading">${__("Loading activity…")}</div>`;
    const [mission, workUnits, activity] = await Promise.all([
      frappe.db.get_doc("Muster Mission", name),
      frappe.db.get_list("Muster Work Unit", {filters: {mission: name}, fields: ["name", "title", "status", "depth", "agent"], order_by: "tree_path asc", limit: 100}),
      frappe.call("muster.api.mission.activities", {mission: name, limit: 25}),
    ]);
    focus.innerHTML = `<header><div><p class="muster-eyebrow">${frappe.utils.escape_html(name)}</p><h3>${frappe.utils.escape_html(mission.objective)}</h3></div><div><button class="btn btn-xs btn-primary" type="button" data-watch-live="${frappe.utils.escape_html(name)}">${__("Watch live")}</button> <a class="btn btn-xs btn-default" href="/desk/muster-mission/${encodeURIComponent(name)}">${__("Open record")}</a></div></header><div class="muster-inspector"><div><h4>${__("Agent tree")}</h4>${workUnits.length ? workUnits.map((unit) => `<div class="muster-unit" style="--depth:${unit.depth || 0}"><span>${frappe.utils.escape_html(unit.title)}</span><small>${frappe.utils.escape_html(unit.status)}</small></div>`).join("") : `<p class="text-muted">${__("Planning has not created work units yet.")}</p>`}</div><div><h4>${__("Activity")}</h4>${activity.message.map((item) => `<div class="muster-event"><span></span><div><strong>${frappe.utils.escape_html(item.summary)}</strong><small>${frappe.datetime.prettyDate(item.creation)}</small></div></div>`).join("") || `<p class="text-muted">${__("No activity yet.")}</p>`}</div></div>`;
    focus.querySelector("[data-watch-live]")?.addEventListener("click", () => window.musterLiveSession?.open(name));
  }

  async function refreshAll() {
    await loadMissions();
    if (selectedMission) await showMission(selectedMission);
  }

  async function submitInlineMission() {
    const objective = objectiveInput.value.trim();
    if (!objective) {
      frappe.show_alert({message: __("Describe the outcome you want Muster to achieve."), indicator: "orange"});
      objectiveInput.focus();
      return;
    }
    if (!requireRuntime()) return;
    submitButton.disabled = true;
    submitButton.classList.add("disabled");
    try {
      const response = await startMission({objective});
      objectiveInput.value = "";
      await loadMissions();
      await showMission(response.message.mission);
    } finally {
      submitButton.disabled = false;
      submitButton.classList.remove("disabled");
    }
  }

  function startMission(values) {
    return frappe.call({
      method: "muster.api.mission.start",
      type: "POST",
      args: {...values, idempotency_key: frappe.utils.get_random(24)},
      freeze: false,
    });
  }

  function requireRuntime() {
    if (frappe.boot.muster.execution_enabled) return true;
    const action = frappe.boot.muster.can_administer
      ? `<a href="/desk/muster-settings/Muster%20Settings">${__("Open Muster Settings")}</a>`
      : __("Ask a Muster administrator to connect the AI runtime.");
    frappe.msgprint({title: __("AI runtime is not connected"), indicator: "orange", message: `${__("No AI work will be queued until a trusted Muster gateway is active.")}<br>${action}`});
    return false;
  }

  function openNewMissionDialog() {
    const dialog = new frappe.ui.Dialog({
      title: __("Start a governed mission"),
      fields: [
        {fieldname: "objective", fieldtype: "Small Text", label: __("Business outcome"), reqd: 1, description: __("Describe the result and constraints, not a sequence of API calls.")},
        {fieldname: "workflow", fieldtype: "Link", options: "Muster Workflow", label: __("Workflow")},
      ],
      primary_action_label: __("Plan mission"),
      primary_action: async (values) => {
        if (!requireRuntime()) return;
        dialog.get_primary_btn().prop("disabled", true);
        try {
          const response = await startMission(values);
          dialog.hide(); await loadMissions(); showMission(response.message.mission);
        } finally { dialog.get_primary_btn().prop("disabled", false); }
      },
    });
    dialog.show();
  }

  frappe.realtime.on("muster_mission_changed", (event) => {
    loadMissions();
    if (selectedMission && event.mission === selectedMission) showMission(selectedMission);
  });
  frappe.realtime.on("muster_activity", (event) => {
    if (selectedMission && event.mission === selectedMission) showMission(selectedMission);
  });
  const poll = window.setInterval(() => {
    if (document.visibilityState === "visible" && frappe.get_route_str() === "muster-control") {
      refreshAll().catch(() => {});
    }
  }, 10000);
  wrapper.muster_poll = poll;
  loadMissions();
};
